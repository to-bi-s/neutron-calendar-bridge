import { createHash } from 'node:crypto';

import * as nodeIcal from 'node-ical';

import { BridgeEventRecord } from '../shared/types';
import { conferenceLines, conferenceOfIcsText, servedDescription, withServedDescriptions, type VideoConferenceLike } from './video-links';

export interface ParsedLocalEvent {
    uid: string;
    eventData: {
        title: string;
        description: string;
        location: string;
        startTime: number;
        endTime: number;
        timezone: string;
        isAllDay: boolean;
        /** 0.34.1: the conference written in the ICS (absent: an existing event keeps its own; null: taken off). */
        conference?: VideoConferenceLike | null;
    };
}

export interface CalendarSyncFailure {
    protonCalendarId: string;
    displayName: string;
    message: string;
}

/**
 * Runs `syncOne` for every calendar, in order, and keeps going when one of them throws.
 * Returns the failures so the caller can report them per calendar instead of aborting the whole pass.
 */
export const syncEachCalendar = async <T extends { protonCalendarId: string; displayName: string }>(
    calendars: T[],
    syncOne: (calendar: T) => Promise<void>
): Promise<CalendarSyncFailure[]> => {
    const failures: CalendarSyncFailure[] = [];
    for (const calendar of calendars) {
        try {
            await syncOne(calendar);
        } catch (error) {
            failures.push({
                protonCalendarId: calendar.protonCalendarId,
                displayName: calendar.displayName,
                message: error instanceof Error ? error.message : String(error)
            });
        }
    }
    return failures;
};

export const slugify = (value: string) =>
    value
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '') || 'calendar';

export const createStrongEtag = (contentHash: string) => `"${contentHash}"`;

export const createContentHash = (value: Record<string, unknown>) =>
    createHash('sha256').update(JSON.stringify(value)).digest('hex');

export const buildCollectionPath = (username: string, slug: string) => `/calendars/${username}/${slug}/`;

export const buildEventHref = (username: string, slug: string, uid: string) =>
    `${buildCollectionPath(username, slug)}${encodeURIComponent(uid)}.ics`;

const normalizeTimezone = (timezone?: string) => timezone || 'UTC';

const getUtcOffsetMinutes = (unixTimestamp: number, timezone: string) => {
    const date = new Date(unixTimestamp * 1000);
    const utcParts = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'UTC',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false
    }).formatToParts(date);
    const localParts = new Intl.DateTimeFormat('en-CA', {
        timeZone: timezone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false
    }).formatToParts(date);

    const toMinutes = (parts: Intl.DateTimeFormatPart[]) => {
        const map = Object.fromEntries(parts.map((p) => [p.type, p.value]));
        const d = new Date(`${map.year}-${map.month}-${map.day}T${map.hour}:${map.minute}:00Z`);
        return d.getTime() / 60_000;
    };

    return toMinutes(localParts) - toMinutes(utcParts);
};

const formatUtcOffset = (totalMinutes: number) => {
    const sign = totalMinutes >= 0 ? '+' : '-';
    const abs = Math.abs(totalMinutes);
    const hours = Math.floor(abs / 60);
    const minutes = abs % 60;
    return `${sign}${String(hours).padStart(2, '0')}${String(minutes).padStart(2, '0')}`;
};

const buildVtimezone = (timezone: string, referenceTimestamp: number) => {
    if (timezone === 'UTC') {
        return '';
    }

    try {
        // Probe January and July to detect standard vs daylight offsets
        const year = new Date(referenceTimestamp * 1000).getFullYear();
        const janTimestamp = Math.floor(new Date(year, 0, 15).getTime() / 1000);
        const julTimestamp = Math.floor(new Date(year, 6, 15).getTime() / 1000);
        const janOffset = getUtcOffsetMinutes(janTimestamp, timezone);
        const julOffset = getUtcOffsetMinutes(julTimestamp, timezone);

        if (janOffset === julOffset) {
            // No DST — emit a single STANDARD component
            const offset = formatUtcOffset(janOffset);
            return [
                `BEGIN:VTIMEZONE`,
                `TZID:${timezone}`,
                `BEGIN:STANDARD`,
                `DTSTART:19700101T000000`,
                `TZOFFSETFROM:${offset}`,
                `TZOFFSETTO:${offset}`,
                `TZNAME:${timezone}`,
                `END:STANDARD`,
                `END:VTIMEZONE`
            ].join('\r\n');
        }

        // Has DST — standard is the lesser offset (further from UTC in winter for northern hemisphere)
        const standardOffset = Math.min(janOffset, julOffset);
        const daylightOffset = Math.max(janOffset, julOffset);
        const stdStr = formatUtcOffset(standardOffset);
        const dstStr = formatUtcOffset(daylightOffset);
        return [
            `BEGIN:VTIMEZONE`,
            `TZID:${timezone}`,
            `BEGIN:STANDARD`,
            `DTSTART:19701101T020000`,
            `TZOFFSETFROM:${dstStr}`,
            `TZOFFSETTO:${stdStr}`,
            `TZNAME:${timezone} (Standard)`,
            `END:STANDARD`,
            `BEGIN:DAYLIGHT`,
            `DTSTART:19700308T020000`,
            `TZOFFSETFROM:${stdStr}`,
            `TZOFFSETTO:${dstStr}`,
            `TZNAME:${timezone} (Daylight)`,
            `END:DAYLIGHT`,
            `END:VTIMEZONE`
        ].join('\r\n');
    } catch {
        return '';
    }
};

const pad = (value: number) => String(value).padStart(2, '0');

const escapeIcsText = (value: string) =>
    value
        .replace(/\\/g, '\\\\')
        .replace(/\r?\n/g, '\\n')
        .replace(/,/g, '\\,')
        .replace(/;/g, '\\;');

const foldIcsLine = (line: string) => {
    if (line.length <= 75) {
        return line;
    }

    const chunks: string[] = [];
    for (let index = 0; index < line.length; index += 75) {
        const segment = line.slice(index, index + 75);
        chunks.push(index === 0 ? segment : ` ${segment}`);
    }
    return chunks.join('\r\n');
};

const getDateTimePartsInTimezone = (unixTimestamp: number, timezone: string) => {
    const normalizedTimezone = normalizeTimezone(timezone);
    const date = new Date(unixTimestamp * 1000);

    try {
        const formatter = new Intl.DateTimeFormat('en-CA', {
            timeZone: normalizedTimezone,
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            hour12: false
        });

        const parts = formatter.formatToParts(date);
        const partMap = Object.fromEntries(parts.map((part) => [part.type, part.value]));

        return {
            year: Number(partMap.year),
            month: Number(partMap.month),
            day: Number(partMap.day),
            hours: Number(partMap.hour),
            minutes: Number(partMap.minute),
            seconds: Number(partMap.second)
        };
    } catch {
        return {
            year: date.getUTCFullYear(),
            month: date.getUTCMonth() + 1,
            day: date.getUTCDate(),
            hours: date.getUTCHours(),
            minutes: date.getUTCMinutes(),
            seconds: date.getUTCSeconds()
        };
    }
};

const formatDateParts = (parts: {
    year: number;
    month: number;
    day: number;
    hours?: number;
    minutes?: number;
    seconds?: number;
}) =>
    `${parts.year}${pad(parts.month)}${pad(parts.day)}${
        typeof parts.hours === 'number'
            ? `T${pad(parts.hours)}${pad(parts.minutes || 0)}${pad(parts.seconds || 0)}`
            : ''
    }`;

/** A calendar date (all-day events), month 1-12. */
export interface CalendarDate {
    year: number;
    month: number;
    day: number;
}

const formatCalendarDate = (date: CalendarDate) => `${date.year}${pad(date.month)}${pad(date.day)}`;

const addDays = (date: CalendarDate, days: number): CalendarDate => {
    const shifted = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
    return { year: shifted.getUTCFullYear(), month: shifted.getUTCMonth() + 1, day: shifted.getUTCDate() };
};

const utcDateOf = (unixSeconds: number): CalendarDate => {
    const date = new Date(unixSeconds * 1000);
    return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
};

const compareDates = (a: CalendarDate, b: CalendarDate) => formatCalendarDate(a).localeCompare(formatCalendarDate(b));

/**
 * Start and (exclusive) end date of an all-day event. Prefers the event's own DATE values; the
 * timestamps are Proton's (UTC midnight of the date) and only a fallback. A missing or
 * non-positive end means one day (Proton drops a redundant DTEND).
 */
export const allDayRange = (event: {
    startTimestamp: number;
    endTimestamp: number;
    allDay?: { start: CalendarDate; end?: CalendarDate };
}) => {
    const start = event.allDay?.start ?? utcDateOf(event.startTimestamp);
    const end = event.allDay?.end ?? (event.endTimestamp > event.startTimestamp ? utcDateOf(event.endTimestamp) : undefined);
    return { start, end: end && compareDates(end, start) > 0 ? end : addDays(start, 1) };
};

export const toIcs = (event: {
    uid: string;
    title: string;
    description: string;
    location: string;
    startTimestamp: number;
    endTimestamp: number;
    timezone: string;
    isAllDay: boolean;
    /** All-day events: the DATE values (from the decrypted event). */
    allDay?: { start: CalendarDate; end?: CalendarDate };
    /** Proton modify time (unix seconds or ms). Used for DTSTAMP so the ICS is stable between polls. */
    modifiedTimestamp?: number;
    /** The event's reminders as VALARM blocks (0.33), placed inside the VEVENT. */
    alarms?: string[];
    /** The event's video conference (0.34.1), as Proton's X-PM-CONFERENCE properties. */
    conference?: VideoConferenceLike;
}) => {
    const timezone = normalizeTimezone(event.timezone);
    const startParts = getDateTimePartsInTimezone(event.startTimestamp, timezone);
    const endParts = getDateTimePartsInTimezone(event.endTimestamp, timezone);
    const stampSeconds =
        typeof event.modifiedTimestamp === 'number' && event.modifiedTimestamp > 0
            ? Math.floor(event.modifiedTimestamp > 1e12 ? event.modifiedTimestamp / 1000 : event.modifiedTimestamp)
            : Math.floor(Date.now() / 1000);
    const dtStamp = formatDateParts(getDateTimePartsInTimezone(stampSeconds, 'UTC')) + 'Z';

    const vtimezone = event.isAllDay ? '' : buildVtimezone(timezone, event.startTimestamp);
    const lines = [
        'BEGIN:VCALENDAR',
        'VERSION:2.0',
        'PRODID:-//Neutron Calendar Bridge//EN',
        'CALSCALE:GREGORIAN',
        'METHOD:PUBLISH',
        ...(vtimezone ? [vtimezone] : []),
        'BEGIN:VEVENT',
        `UID:${escapeIcsText(event.uid)}`,
        `DTSTAMP:${dtStamp}`,
        // All-day: DATE values only. (A time part here made Calendar.app show 00:00-00:00 events.)
        event.isAllDay
            ? `DTSTART;VALUE=DATE:${formatCalendarDate(allDayRange(event).start)}`
            : `DTSTART;TZID=${timezone}:${formatDateParts(startParts)}`,
        event.isAllDay
            ? `DTEND;VALUE=DATE:${formatCalendarDate(allDayRange(event).end)}`
            : `DTEND;TZID=${timezone}:${formatDateParts(endParts)}`,
        `SUMMARY:${escapeIcsText(event.title)}`,
        `DESCRIPTION:${escapeIcsText(servedDescription(event.description))}`, // 0.41.1: without Proton's join block
        `LOCATION:${escapeIcsText(event.location)}`,
        ...conferenceLines(event.conference),
        ...alarmLines(event.alarms, event.uid),
        'END:VEVENT',
        'END:VCALENDAR'
    ].map(foldIcsLine);

    return `${lines.join('\r\n')}\r\n`;
};

/** VALARM blocks (already folded ICS text) as lines for the VEVENT; each block's lines are kept as they are. */
/**
 * The VALARM blocks as ICS lines. 0.41.8: with `owner` (the event's UID and occurrence), every alarm gets
 * a stable UID and X-WR-ALARMUID (from the owner, its place and its content), as Apple writes them:
 * Calendar.app matches alarms by these, and without them it kept its own copy of an invitation's alarm
 * next to the one served again — one more identical alarm after every save.
 */
export const alarmLines = (alarms?: string[], owner?: string): string[] =>
    (alarms || []).flatMap((block, index) => {
        const lines = block.replace(/\r?\n[ \t]/g, '').split(/\r?\n/).filter((line) => line.length > 0);
        if (!owner || lines.some((line) => /^(UID|X-WR-ALARMUID)[;:]/i.test(line))) {
            return lines;
        }
        // 0.41.9: only what makes the alarm this alarm — its event, place, kind and time. Not its text: an email
        // alarm carries the event's title, and a new title must not make it a new alarm for Calendar.app.
        const kind = (lines.find((line) => /^ACTION[;:]/i.test(line)) ?? '').toUpperCase();
        const when = (lines.find((line) => /^TRIGGER[;:]/i.test(line)) ?? '').toUpperCase();
        const hash = createHash('sha256').update(`${owner}\u0000${index}\u0000${kind}\u0000${when}`).digest('hex').toUpperCase();
        const uid = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`;
        const at = lines.findIndex((line) => /^BEGIN:VALARM\s*$/i.test(line));
        return at < 0 ? lines : [...lines.slice(0, at + 1), `UID:${uid}`, `X-WR-ALARMUID:${uid}`, ...lines.slice(at + 1)];
    });

/** A DATE value (YYYYMMDD) of the first VEVENT's own property, ignoring alarms inside it. */
const dateValueOf = (ics: string, name: 'DTSTART' | 'DTEND'): CalendarDate | undefined => {
    const unfolded = ics.replace(/\r?\n[ \t]/g, '');
    const vevent = unfolded.match(/^BEGIN:VEVENT[ \t]*$[\s\S]*?^END:VEVENT[ \t]*$/im)?.[0] ?? '';
    const own = vevent.replace(/^BEGIN:VALARM[ \t]*$[\s\S]*?^END:VALARM[ \t]*$/gim, '');
    const match = own.match(new RegExp(`^${name}(?:;[^:\\r\\n]*)?:(\\d{4})(\\d{2})(\\d{2})[ \t]*$`, 'im'));
    return match ? { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) } : undefined;
};

/** 1.0.5: a text property with parameters (`SUMMARY;LANGUAGE=de:…`) comes from node-ical as { params, val }: its text. */
const textOf = (value: unknown): string => {
    if (value && typeof value === 'object' && 'val' in value) {
        return textOf((value as { val: unknown }).val);
    }
    return typeof value === 'string' ? value : '';
};

export const parseIcs = (serializedIcs: string, fallbackUid?: string): ParsedLocalEvent => {
    const parsed = nodeIcal.sync.parseICS(serializedIcs);
    const event = Object.values(parsed).find((entry: any) => entry?.type === 'VEVENT') as any;

    if (!event) {
        throw new Error('The submitted ICS payload does not contain a VEVENT');
    }

    const startDate = event.start instanceof Date ? event.start : new Date(event.start || Date.now());
    const endDate = event.end instanceof Date ? event.end : new Date(event.end || startDate.getTime() + 3_600_000);
    const uid = event.uid || fallbackUid;

    if (!uid) {
        throw new Error('The submitted ICS payload is missing a UID');
    }

    const isAllDay = Boolean(event.datetype === 'date');

    // For floating DATE values (no timezone), interpret in the system timezone so
    // that Proton places the event on the correct calendar day for the user.
    // node-ical returns midnight UTC for DATE-only events; we re-anchor that
    // calendar date to midnight in the local system timezone instead.
    let startTimestamp: number;
    let endTimestamp: number;
    let timezone: string;

    if (isAllDay) {
        // The calendar dates as written (node-ical turns DATE values into local midnight, so the
        // UTC date was a day early east of UTC). The client turns local midnight back into the date.
        const systemTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
        const localDateOf = (date: Date): CalendarDate => ({
            year: date.getFullYear(),
            month: date.getMonth() + 1,
            day: date.getDate()
        });
        const startDay = dateValueOf(serializedIcs, 'DTSTART') ?? localDateOf(startDate);
        const writtenEnd = dateValueOf(serializedIcs, 'DTEND') ?? (event.end ? localDateOf(endDate) : undefined);
        const endDay = writtenEnd && compareDates(writtenEnd, startDay) > 0 ? writtenEnd : addDays(startDay, 1);
        startTimestamp = Math.floor(new Date(startDay.year, startDay.month - 1, startDay.day).getTime() / 1000);
        endTimestamp = Math.floor(new Date(endDay.year, endDay.month - 1, endDay.day).getTime() / 1000);
        timezone = systemTz;
    } else {
        startTimestamp = Math.floor(startDate.getTime() / 1000);
        endTimestamp = Math.floor(endDate.getTime() / 1000);
        timezone = event.start?.tz || event.timezone || 'UTC';
    }

    const conference = conferenceOfIcsText(serializedIcs);
    return {
        uid,
        eventData: {
            title: textOf(event.summary) || 'Untitled Event',
            description: textOf(event.description),
            location: textOf(event.location),
            startTime: startTimestamp,
            endTime: endTimestamp,
            timezone,
            isAllDay,
            ...(conference ? { conference } : {})
        }
    };
};

export const buildEventRecordShape = (
    base: {
        protonEventId: string;
        protonCalendarId: string;
        uid: string;
        href: string;
        title: string;
        description: string;
        location: string;
        startTimestamp: number;
        endTimestamp: number;
        timezone: string;
        isAllDay: boolean;
        modifiedTimestamp: number;
        protonEventIds?: Record<string, string>;
        allDay?: { start: CalendarDate; end?: CalendarDate };
        /** The reminders as VALARM blocks (0.33): in the served ICS and in the content hash. */
        alarms?: string[];
        /** The video conference (0.34.1): in the served ICS and in the content hash. */
        conference?: VideoConferenceLike;
    },
    serializedIcs?: string
): BridgeEventRecord => {
    const ics = serializedIcs ? withServedDescriptions(serializedIcs) : toIcs(base); // 0.41.7: no join block for Calendar.app
    const alarmsKey = base.alarms?.length ? createHash('sha256').update(base.alarms.join('\n')).digest('hex').slice(0, 16) : undefined;
    const conferenceKey = base.conference ? `${base.conference.provider}:${base.conference.id}:${base.conference.url}` : undefined;
    // All-day events also hash their dates: their ICS changed (DATE values without a time), and a
    // new ETag makes Calendar.app fetch the corrected version.
    const allDayKey = base.isAllDay ? (({ start, end }) => `${formatCalendarDate(start)}/${formatCalendarDate(end)}`)(allDayRange(base)) : undefined;
    const contentHash = createContentHash({
        protonCalendarId: base.protonCalendarId,
        uid: base.uid,
        title: base.title,
        description: base.description,
        location: base.location,
        startTimestamp: base.startTimestamp,
        endTimestamp: base.endTimestamp,
        timezone: base.timezone,
        isAllDay: base.isAllDay,
        modifiedTimestamp: base.modifiedTimestamp,
        ...(allDayKey ? { allDayKey } : {}),
        ...(alarmsKey ? { alarmsKey } : {}),
        ...(conferenceKey ? { conferenceKey } : {})
    });

    return {
        protonEventId: base.protonEventId,
        protonCalendarId: base.protonCalendarId,
        uid: base.uid,
        href: base.href,
        etag: createStrongEtag(contentHash),
        contentHash,
        serializedIcs: ics,
        title: base.title,
        description: base.description,
        location: base.location,
        startTimestamp: base.startTimestamp,
        endTimestamp: base.endTimestamp,
        timezone: base.timezone,
        isAllDay: base.isAllDay,
        modifiedTimestamp: base.modifiedTimestamp,
        deleted: false,
        lastSyncedAt: Date.now(),
        protonEventIds: base.protonEventIds ?? { '': base.protonEventId }
    };
};

/**
 * 0.48.5: a time zone on a plain date (DTSTART;TZID=Europe/Amsterdam;VALUE=DATE:20261021) is dropped.
 * Thunderbird writes all-day events like that; RFC 5545 allows TZID only on date-times, and Proton
 * refuses the event ("Cannot contain both TZID and date value"). On a date it means nothing anyway.
 * Lines are unfolded only when there is something to change.
 */
const DATE_WITH_TZID = /^((?:DTSTART|DTEND|DUE|RECURRENCE-ID|EXDATE|RDATE)(?:;[^:\r\n]*)?);TZID=(?:"[^"]*"|[^;:\r\n]*)((?:;[^:\r\n]*)?:)(\d{8}(?:,\d{8})*)(?=\r?$)/gim;
const hasDateValue = (head: string, tail: string) => /;VALUE=DATE(?:[;:]|$)/i.test(`${head}${tail}`);
export const withoutTimeZoneOnDates = (ics: string): string => {
    const unfolded = ics.replace(/\r?\n[ \t]/g, '');
    let changed = false;
    const fixed = unfolded.replace(DATE_WITH_TZID, (line, head: string, tail: string, value: string) => {
        if (!hasDateValue(head, tail)) {
            return line; // a date-time written without its time is not ours to guess
        }
        changed = true;
        return `${head}${tail}${value}`;
    });
    return changed ? fixed : ics;
};
