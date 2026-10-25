/**
 * Video links (0.34.1): Calendar.app has no "add video call" button, so typing "Proton Meet" or
 * "Zoom" as an event's location asks the bridge for one. The client makes the room (Proton Meet the
 * way Proton Calendar does; Zoom through Proton, when connected) and the event is saved with the
 * link as its location, Proton's conference block in its description and Proton's conference
 * properties (`X-PM-CONFERENCE-ID`, `X-PM-CONFERENCE-URL`), which Proton's apps show as the
 * conference widget. Served events carry those properties too; when Calendar.app writes an event
 * back without them (it does not know them), the stored ones are put back, so a Proton-made link
 * survives an edit in Calendar.app. ICS text work on unfolded lines, per VEVENT.
 */

export interface VideoConferenceLike {
    provider: 1 | 2;
    id: string;
    url: string;
    password?: string;
    host?: string;
}

export const PROVIDER_NAMES: Record<1 | 2, string> = { 1: 'Zoom', 2: 'Proton Meet' };

const unfold = (ics: string) => ics.replace(/\r?\n[ \t]/g, '');

const escapeIcsText = (value: string) => value.replace(/\\/g, '\\\\').replace(/\r?\n/g, '\\n').replace(/,/g, '\\,').replace(/;/g, '\\;');

const unescapeIcsText = (value: string) => value.replace(/\\([nN,;\\])/g, (_match, char: string) => (char === 'n' || char === 'N' ? '\n' : char));

/** RFC 5545 folding: 75 octets, continuation lines with their leading space included (on characters, not octets, like the rest of the bridge). */
const foldIcsLine = (line: string) => {
    if (line.length <= 75) {
        return line;
    }
    const chunks = [line.slice(0, 75)];
    for (let index = 75; index < line.length; index += 74) {
        chunks.push(` ${line.slice(index, index + 74)}`);
    }
    return chunks.join('\r\n');
};

/** The two ICS lines of a conference (the same shape the client writes; unfolded). */
export const conferenceLines = (conference: VideoConferenceLike | undefined): string[] =>
    conference
        ? [
              `X-PM-CONFERENCE-ID;X-PM-PROVIDER=${conference.provider}:${conference.id}`,
              `X-PM-CONFERENCE-URL${conference.password ? `;X-PM-PASSWORD="${conference.password.replace(/"/g, '')}"` : ''}${
                  conference.host ? `;X-PM-HOST="${conference.host.replace(/"/g, '')}"` : ''
              }:${conference.url}`
          ]
        : [];

/** A VEVENT block of an ICS text (unfolded), with the lines before and after it. */
interface VeventBlock {
    /** '' for the master, the RECURRENCE-ID value for an exception. */
    key: string;
    lines: string[];
}

const splitIcs = (ics: string): { head: string[]; blocks: VeventBlock[]; tail: string[] } => {
    const lines = unfold(ics).split(/\r?\n/);
    const head: string[] = [];
    const tail: string[] = [];
    const blocks: VeventBlock[] = [];
    let current: string[] | null = null;
    let seenVevent = false;
    for (const line of lines) {
        if (/^BEGIN:VEVENT\s*$/i.test(line)) {
            current = [line];
            seenVevent = true;
            continue;
        }
        if (current) {
            current.push(line);
            if (/^END:VEVENT\s*$/i.test(line)) {
                const own = ownLines(current);
                const recurrenceId = own.find((entry) => /^RECURRENCE-ID[;:]/i.test(entry));
                blocks.push({ key: recurrenceId ? recurrenceId.slice(recurrenceId.indexOf(':') + 1).trim() : '', lines: current });
                current = null;
            }
            continue;
        }
        (seenVevent ? tail : head).push(line);
    }
    return { head, blocks, tail };
};

/** A VEVENT's own lines: not those of the VALARMs inside it. */
const ownLines = (lines: string[]) => {
    const own: string[] = [];
    let depth = 0;
    for (const line of lines) {
        if (/^BEGIN:VALARM\s*$/i.test(line)) {
            depth += 1;
            continue;
        }
        if (/^END:VALARM\s*$/i.test(line)) {
            depth -= 1;
            continue;
        }
        if (depth === 0) {
            own.push(line);
        }
    }
    return own;
};

const joinIcs = (parts: { head: string[]; blocks: VeventBlock[]; tail: string[] }) =>
    `${[...parts.head, ...parts.blocks.flatMap((block) => block.lines), ...parts.tail].filter((line) => line !== '').map(foldIcsLine).join('\r\n')}\r\n`;

const CONFERENCE_LINE = /^X-PM-CONFERENCE-(ID|URL)[;:]/i;

/** A VEVENT's conference lines with a value — the empty removal marker does not count. */
const conferenceLinesIn = (lines: string[]) => ownLines(lines).filter((line) => CONFERENCE_LINE.test(line) && line.slice(line.indexOf(':') + 1).trim() !== '');

const propertyValueIn = (lines: string[], name: string) => {
    const line = ownLines(lines).find((entry) => new RegExp(`^${name}(?:;|:)`, 'i').test(entry));
    return line === undefined ? undefined : unescapeIcsText(line.slice(line.indexOf(':') + 1));
};

/** The first VEVENT's location and title (what a link request is read from). */
export const firstVeventOf = (ics: string) => describeBlock(splitIcs(ics).blocks[0]);

/** The master VEVENT (no RECURRENCE-ID; else the first): its title names a series' room. */
export const masterVeventOf = (ics: string) => {
    const blocks = splitIcs(ics).blocks;
    return describeBlock(blocks.find((block) => block.key === '') ?? blocks[0]);
};

const describeBlock = (block: VeventBlock | undefined) =>
    block
        ? {
              location: propertyValueIn(block.lines, 'LOCATION') ?? '',
              title: propertyValueIn(block.lines, 'SUMMARY') ?? '',
              hasConference: conferenceLinesIn(block.lines).length === 2
          }
        : null;

/**
 * The ICS with the conference the client made: in every VEVENT without one, LOCATION becomes the
 * link, DESCRIPTION gets Proton's block (`describe` is the client's descriptionWithConference) and
 * the conference lines are added.
 */
export const withVideoLink = (ics: string, conference: VideoConferenceLike, describe: (description: string) => string) => {
    const parts = splitIcs(ics);
    for (const block of parts.blocks) {
        if (conferenceLinesIn(block.lines).length) {
            continue;
        }
        const description = propertyValueIn(block.lines, 'DESCRIPTION') ?? '';
        const next: string[] = [];
        let locationDone = false;
        let descriptionDone = false;
        let depth = 0; // inside a VALARM, whose DESCRIPTION/LOCATION are its own
        for (const line of block.lines) {
            if (/^BEGIN:VALARM\s*$/i.test(line)) {
                depth += 1;
            } else if (/^END:VALARM\s*$/i.test(line)) {
                depth -= 1;
            }
            if (depth === 0 && CONFERENCE_LINE.test(line)) {
                continue; // the removal marker gives way to the new conference
            }
            if (depth === 0 && /^LOCATION[;:]/i.test(line)) {
                next.push(`LOCATION:${escapeIcsText(conference.url)}`);
                locationDone = true;
                continue;
            }
            if (depth === 0 && /^DESCRIPTION[;:]/i.test(line)) {
                next.push(`DESCRIPTION:${escapeIcsText(describe(description))}`);
                descriptionDone = true;
                continue;
            }
            if (/^END:VEVENT\s*$/i.test(line)) {
                if (!locationDone) {
                    next.push(`LOCATION:${escapeIcsText(conference.url)}`);
                }
                if (!descriptionDone) {
                    next.push(`DESCRIPTION:${escapeIcsText(describe(description))}`);
                }
                next.push(...conferenceLines(conference));
            }
            next.push(line);
        }
        block.lines = next;
    }
    return joinIcs(parts);
};

/**
 * The ICS with the conference lines the stored (served) version had, put back into every VEVENT
 * that lacks them: Calendar.app does not keep X-PM properties it does not know, and a link made in
 * Proton Calendar must not vanish because the event was edited on the Mac. An exception without
 * stored lines of its own takes the master's. Unchanged when nothing was stored or everything is there.
 */
export const restoreConferenceLines = (ics: string, storedIcs: string | undefined) => {
    if (!storedIcs || !CONFERENCE_LINE.test(unfold(storedIcs).split(/\r?\n/).find((line) => CONFERENCE_LINE.test(line)) ?? '')) {
        return ics;
    }
    const stored = splitIcs(storedIcs);
    const storedByKey = new Map(stored.blocks.map((block) => [block.key, conferenceLinesIn(block.lines)]));
    const master = storedByKey.get('') ?? [];
    const parts = splitIcs(ics);
    let changed = false;
    for (const block of parts.blocks) {
        if (conferenceLinesIn(block.lines).length) {
            continue;
        }
        // An occurrence the stored version knows keeps what it had there (nothing, if the link was
        // taken off that occurrence in Proton); a new occurrence takes the master's.
        const lines = storedByKey.has(block.key) ? storedByKey.get(block.key)! : master;
        if (lines.length !== 2) {
            continue;
        }
        const end = block.lines.findIndex((line) => /^END:VEVENT\s*$/i.test(line));
        block.lines = [...block.lines.slice(0, end), ...lines, ...block.lines.slice(end)];
        changed = true;
    }
    return changed ? joinIcs(parts) : ics;
};

/** A property parameter as written in an ICS line (quoted or bare). */
const parameterIn = (parameters: string, name: string) => {
    const match = parameters.match(new RegExp(`;${name}=(?:"([^"]*)"|([^;:]*))`, 'i'));
    return match ? (match[1] ?? match[2] ?? '') : undefined;
};

/** The conference written in the first VEVENT of an ICS text, if any (the client's conferenceOfIcs, kept local). */
export const conferenceOfIcsText = (ics: string): VideoConferenceLike | undefined => {
    const block = splitIcs(ics).blocks[0];
    if (!block) {
        return undefined;
    }
    const own = ownLines(block.lines);
    const idLine = own.find((line) => /^X-PM-CONFERENCE-ID[;:]/i.test(line))?.match(/^X-PM-CONFERENCE-ID((?:;[^:]*)?):(.*)$/i);
    const urlLine = own.find((line) => /^X-PM-CONFERENCE-URL[;:]/i.test(line))?.match(/^X-PM-CONFERENCE-URL((?:;[^:]*)?):(.*)$/i);
    if (!idLine || !urlLine || !idLine[2].trim() || !urlLine[2].trim()) {
        return undefined;
    }
    const provider: 1 | 2 = Number(parameterIn(idLine[1], 'X-PM-PROVIDER')) === 1 ? 1 : 2;
    const password = parameterIn(urlLine[1], 'X-PM-PASSWORD');
    const host = parameterIn(urlLine[1], 'X-PM-HOST');
    return { provider, id: idLine[2].trim(), url: urlLine[2].trim(), ...(password ? { password } : {}), ...(host ? { host } : {}) };
};

/** The two empty lines that tell the client "the link was removed" (the same as the client's conferenceRemovalLines). */
const REMOVAL_LINES = ['X-PM-CONFERENCE-ID:', 'X-PM-CONFERENCE-URL:'];

/** Whether the ICS text carries the removal marker (empty conference properties) in its first VEVENT. */
export const icsHasConferenceRemoval = (ics: string) => {
    const block = splitIcs(ics).blocks[0];
    const lines = block ? ownLines(block.lines).filter((line) => CONFERENCE_LINE.test(line)) : [];
    return lines.length > 0 && lines.every((line) => !line.slice(line.indexOf(':') + 1).trim());
};

/**
 * The ICS with the link taken off: every VEVENT gets the removal marker (in place of any conference
 * lines) and its DESCRIPTION loses Proton's block (`undescribe` is the client's descriptionWithoutConference).
 */
export const withConferenceRemoved = (ics: string, undescribe: (description: string) => string) => {
    const parts = splitIcs(ics);
    for (const block of parts.blocks) {
        const next: string[] = [];
        let depth = 0;
        for (const line of block.lines) {
            if (/^BEGIN:VALARM\s*$/i.test(line)) {
                depth += 1;
            } else if (/^END:VALARM\s*$/i.test(line)) {
                depth -= 1;
            }
            if (depth === 0 && CONFERENCE_LINE.test(line)) {
                continue;
            }
            if (depth === 0 && /^DESCRIPTION[;:]/i.test(line)) {
                const description = undescribe(unescapeIcsText(line.slice(line.indexOf(':') + 1)));
                if (description.trim()) {
                    next.push(`DESCRIPTION:${escapeIcsText(description)}`);
                }
                continue;
            }
            if (/^END:VEVENT\s*$/i.test(line)) {
                next.push(...REMOVAL_LINES);
            }
            next.push(line);
        }
        block.lines = next;
    }
    return joinIcs(parts);
};

/** Whether the ICS text carries a conference anywhere. */
export const icsHasConference = (ics: string) => splitIcs(ics).blocks.some((block) => conferenceLinesIn(block.lines).length === 2);

/**
 * 0.41: the ICS without LOCATION lines (of the VEVENTs, not of alarms) whose value is exactly `url` —
 * a video link taken off in Proton Calendar that Calendar.app's older copy still shows as the place.
 */
export const withoutLocation = (ics: string, url: string) => {
    const parts = splitIcs(ics);
    for (const block of parts.blocks) {
        let depth = 0;
        block.lines = block.lines.filter((line) => {
            if (/^BEGIN:VALARM\s*$/i.test(line)) {
                depth += 1;
            } else if (/^END:VALARM\s*$/i.test(line)) {
                depth -= 1;
            }
            return !(depth === 0 && /^LOCATION[;:]/i.test(line) && unescapeIcsText(line.slice(line.indexOf(':') + 1)).trim() === url.trim());
        });
    }
    return joinIcs(parts);
};

/** Proton's separator around the join text in an event's description (videoConfHelpers, SEPARATOR_PROTON_EVENTS). */
export const SEPARATOR_PROTON_EVENTS = '~-~-~-~-~-~-~%~!~%~!~%~!~%~!~%~!~%~!~%~!~%~!~%~!~%~!~%~!~%~!~%~!~-~-~-~-~-~-~';
const escapedSeparator = SEPARATOR_PROTON_EVENTS.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const CONFERENCE_BLOCK = new RegExp(`\\r?\\n?${escapedSeparator}[\\s\\S]*?${escapedSeparator}`, 'g');

/**
 * 0.41.1: the description as Calendar.app is shown it — without Proton's join block, the way Proton
 * Calendar shows it (its conference widget has the link; in Calendar.app the location is the link).
 * The block is put back on every write while the event has a conference (withConferenceDescribed).
 */
export const servedDescription = (description: string | undefined | null) => {
    const text = String(description ?? '');
    const without = text.replace(CONFERENCE_BLOCK, '');
    return without === text ? text : without.replace(/\s+$/, '');
};

/**
 * 0.41.1: every VEVENT's description with Proton's join block for `conference` (what guests see in
 * Proton's emails), whatever Calendar.app's copy holds: a description without it gets it, an older
 * block is replaced (describe = the client's descriptionWithConference for this conference).
 */
export const withConferenceDescribed = (ics: string, describe: (description: string) => string) => {
    const parts = splitIcs(ics);
    for (const block of parts.blocks) {
        const description = propertyValueIn(block.lines, 'DESCRIPTION') ?? '';
        const next: string[] = [];
        let done = false;
        let depth = 0;
        for (const line of block.lines) {
            if (/^BEGIN:VALARM\s*$/i.test(line)) {
                depth += 1;
            } else if (/^END:VALARM\s*$/i.test(line)) {
                depth -= 1;
            }
            if (depth === 0 && /^DESCRIPTION[;:]/i.test(line)) {
                if (!done) {
                    next.push(`DESCRIPTION:${escapeIcsText(describe(description))}`);
                    done = true;
                }
                continue;
            }
            if (/^END:VEVENT\s*$/i.test(line) && !done) {
                next.push(`DESCRIPTION:${escapeIcsText(describe(description))}`);
                done = true;
            }
            next.push(line);
        }
        block.lines = next;
    }
    return joinIcs(parts);
};

/** A link as a comparable key: no escaping, no fragment (#pwd-…) or query, no trailing slash, lower case. */
const linkKey = (text: string) => {
    const raw = text.replace(/\\/g, '').trim();
    try {
        const url = new URL(raw);
        return `${url.host}${url.pathname.replace(/\/+$/, '')}`.toLowerCase();
    } catch {
        return raw.split(/[#?]/)[0].replace(/\/+$/, '').toLowerCase();
    }
};

const isWebAddress = (text: string) => /^https?:\/\/\S+$/i.test(text.replace(/\\/g, '').trim());

/**
 * 0.41.6: whether a place names the conference's room: the same link up to escaping, the #pwd-… part,
 * a query, a trailing slash or letter case; or a web address containing the room's ID or Meet link name.
 */
export const sameRoom = (text: string | undefined | null, conference: { id: string; url: string }) => {
    const place = String(text ?? '').trim();
    if (!place || !isWebAddress(place)) {
        return false;
    }
    if (linkKey(place) === linkKey(conference.url)) {
        return true;
    }
    const name = conference.url.match(/\/join\/id-([A-Za-z0-9]+)/)?.[1];
    return [conference.id, name].some((token) => Boolean(token) && token!.length >= 6 && place.includes(token!));
};

/** 0.41.6: a place described for bridge.log without its content. */
export const placeKind = (text: string | undefined | null, conference: { id: string; url: string }, request: boolean) => {
    const place = String(text ?? '').trim();
    if (!place) return 'empty';
    if (sameRoom(place, conference)) return place.replace(/\\/g, '') === conference.url.replace(/\\/g, '').trim() ? 'the link' : 'the link (other spelling)';
    if (request) return 'a request for a room';
    if (isWebAddress(place)) return 'another web address';
    return 'text';
};

/** 0.41.6: every VEVENT's LOCATION set to `place` (alarms untouched). */
export const withLocation = (ics: string, place: string) => {
    const parts = splitIcs(ics);
    for (const block of parts.blocks) {
        const next: string[] = [];
        let done = false;
        let depth = 0;
        for (const line of block.lines) {
            if (/^BEGIN:VALARM\s*$/i.test(line)) depth += 1;
            else if (/^END:VALARM\s*$/i.test(line)) depth -= 1;
            if (depth === 0 && /^LOCATION[;:]/i.test(line)) {
                if (!done) next.push(`LOCATION:${escapeIcsText(place)}`);
                done = true;
                continue;
            }
            if (/^END:VEVENT\s*$/i.test(line) && !done) {
                next.push(`LOCATION:${escapeIcsText(place)}`);
                done = true;
            }
            next.push(line);
        }
        block.lines = next;
    }
    return joinIcs(parts);
};

/**
 * 0.41.7: the ICS as Calendar.app is to be served it: every VEVENT's description without Proton's join
 * block (servedDescription). Used where the version just written to Proton (block included) is kept as
 * the served copy until the next sync replaces it.
 */
export const withServedDescriptions = (ics: string) => {
    const parts = splitIcs(ics);
    let changed = false;
    for (const block of parts.blocks) {
        let depth = 0;
        const next: string[] = [];
        for (const line of block.lines) {
            if (/^BEGIN:VALARM\s*$/i.test(line)) depth += 1;
            else if (/^END:VALARM\s*$/i.test(line)) depth -= 1;
            if (depth === 0 && /^DESCRIPTION[;:]/i.test(line)) {
                const value = unescapeIcsText(line.slice(line.indexOf(':') + 1));
                const served = servedDescription(value);
                if (served !== value) {
                    changed = true;
                    if (served) next.push(`DESCRIPTION:${escapeIcsText(served)}`);
                    continue;
                }
            }
            next.push(line);
        }
        block.lines = next;
    }
    return changed ? joinIcs(parts) : ics;
};
