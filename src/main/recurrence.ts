/**
 * Recurring events: Proton stores a series as one "master" event (with RRULE/EXDATE) plus one
 * separate event per modified occurrence (same UID, with RECURRENCE-ID). CalDAV requires all
 * components sharing a UID to live in ONE calendar object resource, so this module groups
 * Proton events by UID and serialises each group as a single VCALENDAR.
 */
import { createHash } from 'node:crypto';
import { t } from './i18n';
import { currentAppName, currentClient } from './caldav-client';

import type { ProtonParticipantProperty, ProtonVcalDateProperty, SyncedCalendarEvent } from 'proton-calendar-client';

import { BridgeEventRecord } from '../shared/types';
import { buildVtimezoneLines, getUtcOffsetMinutes, isKnownTimeZone } from './vtimezone';
import { alarmLines } from './sync-utils';
import { conferenceLines, servedDescription } from './video-links';

export class ReadOnlyEventError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'ReadOnlyEventError';
    }
}

/**
 * A change from Calendar.app to an event with an organizer or guests (or one that would add guests).
 * Those need invitation emails, which the bridge does not send yet; answered with 403 and the reason.
 */
export class InvitationNotSupportedError extends ReadOnlyEventError {
    /** True when the change was saved after all, only not for everyone (guests left out): notified as "Saved, with changes". */
    readonly partial: boolean;
    constructor(message: string, options: { partial?: boolean } = {}) {
        super(message);
        this.name = 'InvitationNotSupportedError';
        this.partial = options.partial === true;
    }
}

/**
 * Calendar.app wrote an invitation from an outdated copy (If-Match no longer matches): answering
 * from it could email the organizer an answer the user never gave. Answered with 412.
 */
export class StaleEventError extends Error {
    constructor(message: string = t('This invitation changed since {app} last read it; nothing was sent. {app} shows the current version after its next refresh.', { app: currentAppName() })) {
        super(message);
        this.name = 'StaleEventError';
    }
}

/**
 * 0.44.2: answering an invitation the organizer has cancelled in Proton since the last sync (Calendar.app
 * saves a "declined" copy before it deletes a cancelled invitation). Not an error for Calendar.app: the
 * save is taken as it is, like 0.40.3's cancelled invitation, so the delete that follows can come.
 */
export class InvitationCancelledError extends InvitationNotSupportedError {
    constructor(message: string) {
        super(message);
        // Elsewhere still a refusal (403) as before; the name stays InvitationNotSupportedError for the CalDAV reply.
    }
}

export const INVITATION_MESSAGES = {
    /** Only when the linked proton-calendar-client predates sending invitations (stage 3). */
    addGuests:
        'This build of proton-calendar-client cannot send invitations. Rebuild it with the invitations patch, ' +
        'or invite your guests in Proton Calendar; the event updates here after the next sync.',
    /** Only when the linked proton-calendar-client predates sending invitations (stage 3). */
    changeOrganized:
        'This event has guests, and this build of proton-calendar-client cannot send them updates. Rebuild it with ' +
        'the invitations patch, or change the event in Proton Calendar (Proton notifies your guests).',
    /** Only when the linked proton-calendar-client predates answering (stage 2). */
    answerInvitation:
        'This build of proton-calendar-client cannot answer invitations. Rebuild it with the invitations patch, ' +
        'or accept or decline in Proton Calendar; your answer shows here after the next sync.',
    /**
     * 0.40: a reminder for one occurrence that has no Proton event of its own. Proton Calendar offers
     * only "all events" there (getSaveEventActions: canOnlySaveAll when only the personal part can be
     * edited and the occurrence is not a single edit), so the bridge does not do more.
     */
    get occurrenceReminder() {
        return t('Proton keeps the reminders of this series for all its events: an occurrence that was not changed on its own has no reminders of its own. Set the reminder on all events instead.');
    },
    get answerOccurrence() {
        // 0.49.6: Thunderbird's guest dialog answers one occurrence; the series is answered from the context menu.
        return currentClient()?.kind === 'thunderbird'
            ? t('Proton takes one answer for the whole series (or for occurrences the organizer changed). In Thunderbird, right-click the event → Attendance → Complete Series; or answer this occurrence in Proton Calendar.')
            : t('Proton takes one answer for the whole series (or for occurrences the organizer changed). Answer the whole series, or answer this occurrence in Proton Calendar.');
    },
    get answerUnsupported() {
        return t('Only Accept, Maybe and Decline can be sent to the organizer. Answer in Proton Calendar instead.');
    },
    get changeInvitation() {
        return t('You were invited to this event, so only its organizer can change it.');
    },
    /** Only when the linked proton-calendar-client predates sending invitations (stage 3). */
    deleteOrganized:
        'This event has guests, and this build of proton-calendar-client cannot send them a cancellation. Rebuild it ' +
        'with the invitations patch, or cancel the event in Proton Calendar (Proton notifies your guests).',
    /** Only when the linked proton-calendar-client predates answering (stage 2). */
    deleteInvitation:
        'This build of proton-calendar-client cannot decline invitations. Rebuild it with the invitations patch, ' +
        'or decline or remove it in Proton Calendar, so the organizer is told.',
    /** Only when the linked proton-calendar-client predates recurring meetings (stage 3b). */
    organizeRecurring:
        'This meeting repeats, and this build of proton-calendar-client cannot send invitations for recurring ' +
        'meetings. Rebuild it with the invitations patch, or change the meeting in Proton Calendar (Proton notifies your guests).',
    get organizeForeign() {
        return t('Invitations can only be sent from your own addresses. This event names someone else as its organizer.');
    },
    get organizeDontNotify() {
        return t('{app} asked for this change to be saved without telling your guests (SCHEDULE-AGENT=NONE). Proton Calendar always tells guests about a change, so nothing was saved or sent. Make the change again, or change it in Proton Calendar.', { app: currentAppName() });
    },
    get organizeClientScheduling() {
        return t('{app} wants to send the invitations for this event itself, which the bridge does not support. Invite your guests from the event in {app} again, or in Proton Calendar.', { app: currentAppName() });
    },
    get moveMeeting() {
        return t('This meeting is already in another of your calendars. {app} moves events by copying and deleting them, which would send your guests a new invitation and then a cancellation. Move it in Proton Calendar instead.', { app: currentAppName() });
    },
    get moveMeetingDelete() {
        return t('{app} just tried to move this meeting to another calendar; that was refused, so the meeting stays here. Deleting it now would cancel it for all guests. Move it in Proton Calendar, or delete it again in a few minutes.', { app: currentAppName() });
    },
    get staleMeeting() {
        return t('This meeting changed since {app} last read it; nothing was sent. {app} shows the current version after its next refresh, then make your change again.', { app: currentAppName() });
    }
};

export const RECURRING_READ_ONLY_MESSAGE =
    'This build of proton-calendar-client cannot write recurring events. Rebuild it with the series-sync patch, ' +
    'or change the event in Proton Calendar instead.';

export type IcsDateValue =
    | { kind: 'date'; year: number; month: number; day: number }
    | {
          kind: 'date-time';
          year: number;
          month: number;
          day: number;
          hours: number;
          minutes: number;
          seconds: number;
          /** IANA zone for local times; absent together with utc=false means floating time. */
          tzid?: string;
          utc: boolean;
      };

export interface ProtonEventRecurrence {
    start: IcsDateValue;
    end: IcsDateValue;
    /** RRULE value without the "RRULE:" prefix, e.g. "FREQ=WEEKLY;BYDAY=MO". */
    rrule?: string;
    exdates: IcsDateValue[];
    recurrenceId?: IcsDateValue;
    status?: string;
    sequence?: number;
    /** 0.49.7: Proton's "Show as: Free" (TRANSP:TRANSPARENT); absent or false: busy. */
    transparent?: boolean;
}

export interface EventParticipant {
    email: string;
    /** Display name (CN), only when it says more than the address. */
    name?: string;
    /** Attendees only: NEEDS-ACTION / ACCEPTED / TENTATIVE / DECLINED. */
    partstat?: string;
    /** Attendees only: REQ-PARTICIPANT / OPT-PARTICIPANT / … */
    role?: string;
    /** This entry is you. */
    isSelf?: boolean;
}

export interface EventParticipants {
    organizer?: EventParticipant;
    attendees: EventParticipant[];
    /** Your part in the event, as Proton determines it. */
    selfRole: 'organizer' | 'attendee' | 'none';
}

export interface SeriesMember {
    event: SyncedCalendarEvent;
    recurrence: ProtonEventRecurrence;
    /** Present when the event has an organizer and/or guests. */
    participants?: EventParticipants;
}

export interface EventSeries {
    uid: string;
    /** Proton event ID used as the mirror row key: the master's, or the first exception's. */
    key: string;
    master: SeriesMember | null;
    exceptions: SeriesMember[];
    /** Extra non-recurring events sharing the UID (e.g. a calendar imported twice); not served. */
    droppedDuplicates: SyncedCalendarEvent[];
}

// ─── Date values ─────────────────────────────────────────────────────────────

const pad = (value: number, width: number = 2) => String(value).padStart(width, '0');

const isUtcZone = (timeZone?: string) => !timeZone || timeZone === 'UTC' || timeZone === 'Etc/UTC' || timeZone === 'Z';

export const icsDateFromVcal = (property?: ProtonVcalDateProperty): IcsDateValue | undefined => {
    const value = property?.value;
    if (!value || typeof value.year !== 'number') {
        return undefined;
    }

    if (property.parameters?.type === 'date' || typeof value.hours !== 'number') {
        return { kind: 'date', year: value.year, month: value.month, day: value.day };
    }

    const tzid = property.parameters?.tzid;
    const utc = Boolean(value.isUTC) || (Boolean(tzid) && isUtcZone(tzid));
    return {
        kind: 'date-time',
        year: value.year,
        month: value.month,
        day: value.day,
        hours: value.hours,
        minutes: value.minutes ?? 0,
        seconds: value.seconds ?? 0,
        tzid: utc ? undefined : tzid,
        utc
    };
};

/** Fallback when only Proton's cleartext metadata (unix timestamps) is available. */
export const icsDateFromTimestamp = (unixSeconds: number, timeZone: string | undefined, isAllDay: boolean): IcsDateValue => {
    const date = new Date(unixSeconds * 1000);
    if (isAllDay) {
        // Proton stores all-day dates as UTC midnight.
        return { kind: 'date', year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
    }

    if (!isUtcZone(timeZone)) {
        try {
            const parts = Object.fromEntries(
                new Intl.DateTimeFormat('en-US', {
                    timeZone,
                    hourCycle: 'h23',
                    year: 'numeric',
                    month: '2-digit',
                    day: '2-digit',
                    hour: '2-digit',
                    minute: '2-digit',
                    second: '2-digit'
                })
                    .formatToParts(date)
                    .map((part) => [part.type, part.value])
            );
            return {
                kind: 'date-time',
                year: Number(parts.year),
                month: Number(parts.month),
                day: Number(parts.day),
                hours: Number(parts.hour) % 24,
                minutes: Number(parts.minute),
                seconds: Number(parts.second),
                tzid: timeZone,
                utc: false
            };
        } catch {
            // Unknown zone: fall through to UTC.
        }
    }

    return {
        kind: 'date-time',
        year: date.getUTCFullYear(),
        month: date.getUTCMonth() + 1,
        day: date.getUTCDate(),
        hours: date.getUTCHours(),
        minutes: date.getUTCMinutes(),
        seconds: date.getUTCSeconds(),
        utc: true
    };
};

/** The instant (UTC ms) an ICS date value denotes; dates and floating times are taken as UTC. */
export const icsDateToUtcMs = (value: IcsDateValue) => {
    if (value.kind === 'date') {
        return Date.UTC(value.year, value.month - 1, value.day);
    }
    const wallClock = Date.UTC(value.year, value.month - 1, value.day, value.hours, value.minutes, value.seconds);
    if (value.utc || !value.tzid || !isKnownTimeZone(value.tzid)) {
        return wallClock;
    }
    // Two passes handle the offset change around DST transitions.
    let guess = wallClock - getUtcOffsetMinutes(value.tzid, wallClock) * 60_000;
    guess = wallClock - getUtcOffsetMinutes(value.tzid, guess) * 60_000;
    return guess;
};

export const formatIcsDateValue = (value: IcsDateValue) => {
    const date = `${pad(value.year, 4)}${pad(value.month)}${pad(value.day)}`;
    if (value.kind === 'date') {
        return date;
    }
    return `${date}T${pad(value.hours)}${pad(value.minutes)}${pad(value.seconds)}${value.utc ? 'Z' : ''}`;
};

export const formatIcsDateProperty = (name: string, value: IcsDateValue) => {
    if (value.kind === 'date') {
        return `${name};VALUE=DATE:${formatIcsDateValue(value)}`;
    }
    if (value.tzid && !value.utc) {
        return `${name};TZID=${value.tzid}:${formatIcsDateValue(value)}`;
    }
    return `${name}:${formatIcsDateValue(value)}`;
};

// ─── RRULE ───────────────────────────────────────────────────────────────────

const RRULE_PART_ORDER = [
    'freq',
    'until',
    'count',
    'interval',
    'bysecond',
    'byminute',
    'byhour',
    'byday',
    'bymonthday',
    'byyearday',
    'byweekno',
    'bymonth',
    'bysetpos',
    'wkst'
];

/** Serialises Proton's VcalRrulePropertyValue ({ freq: 'WEEKLY', byday: ['MO'], until: {...} }). */
export const formatRrule = (value: Record<string, unknown>) => {
    const keys = [
        ...RRULE_PART_ORDER.filter((key) => key in value),
        ...Object.keys(value).filter((key) => !RRULE_PART_ORDER.includes(key))
    ];
    const parts: string[] = [];

    for (const key of keys) {
        const part = value[key];
        if (part === undefined || part === null || (Array.isArray(part) && part.length === 0)) {
            continue;
        }

        let formatted: string;
        if (key === 'until' && typeof part === 'object' && !Array.isArray(part)) {
            const until = part as { year: number; month: number; day: number; hours?: number; minutes?: number; seconds?: number; isUTC?: boolean };
            formatted =
                typeof until.hours === 'number'
                    ? formatIcsDateValue({
                          kind: 'date-time',
                          year: until.year,
                          month: until.month,
                          day: until.day,
                          hours: until.hours,
                          minutes: until.minutes ?? 0,
                          seconds: until.seconds ?? 0,
                          utc: until.isUTC !== false
                      })
                    : formatIcsDateValue({ kind: 'date', year: until.year, month: until.month, day: until.day });
        } else if (Array.isArray(part)) {
            formatted = part.map((entry) => String(entry)).join(',');
        } else if (typeof part === 'object') {
            continue; // Unknown structured part; skip rather than emit "[object Object]".
        } else {
            formatted = String(part);
        }

        parts.push(`${key.toUpperCase()}=${key === 'freq' || key === 'wkst' ? formatted.toUpperCase() : formatted}`);
    }

    return parts.some((part) => part.startsWith('FREQ=')) ? parts.join(';') : undefined;
};

const normalizeRawRrule = (value: unknown) => {
    if (typeof value !== 'string') {
        return undefined;
    }
    const trimmed = value.trim().replace(/^RRULE:/i, '');
    return /(^|;)FREQ=/i.test(trimmed) ? trimmed : undefined;
};

// ─── Reading Proton events ───────────────────────────────────────────────────

/**
 * Recurrence data for one Proton event. Prefers the decrypted, signed VEVENT properties
 * (needs the patched proton-calendar-client); falls back to Proton's cleartext metadata.
 */
export const readRecurrence = (event: SyncedCalendarEvent): ProtonEventRecurrence => {
    const vevent = event.decrypted?.vevent;
    const raw = event.raw;
    const timeZone = event.timezone || raw?.StartTimezone;

    const start = icsDateFromVcal(vevent?.dtstart) ?? icsDateFromTimestamp(event.startTimestamp, timeZone, event.isAllDay);
    const end =
        icsDateFromVcal(vevent?.dtend) ??
        icsDateFromTimestamp(event.endTimestamp, raw?.EndTimezone || timeZone, event.isAllDay);

    if (vevent) {
        return {
            start,
            end,
            rrule: vevent.rrule?.value ? formatRrule(vevent.rrule.value) : undefined,
            exdates: (vevent.exdate ?? [])
                .map((property) => icsDateFromVcal(property))
                .filter((value): value is IcsDateValue => Boolean(value)),
            recurrenceId: icsDateFromVcal(vevent['recurrence-id']),
            status: vevent.status?.value ?? event.decrypted?.status,
            sequence: vevent.sequence?.value ?? event.decrypted?.sequence,
            transparent: String((vevent as { transp?: { value?: string } }).transp?.value ?? '').toUpperCase() === 'TRANSPARENT'
        };
    }

    return {
        start,
        end,
        rrule: normalizeRawRrule(raw?.RRule),
        exdates: (Array.isArray(raw?.Exdates) ? raw!.Exdates : [])
            .filter((timestamp): timestamp is number => typeof timestamp === 'number')
            .map((timestamp) => icsDateFromTimestamp(timestamp, timeZone, event.isAllDay)),
        recurrenceId:
            typeof raw?.RecurrenceID === 'number'
                ? icsDateFromTimestamp(raw.RecurrenceID, timeZone, event.isAllDay)
                : undefined,
        status: event.decrypted?.status,
        sequence: event.decrypted?.sequence
    };
};

const emailFromUri = (value: unknown) =>
    typeof value === 'string' ? value.trim().replace(/^mailto:/i, '').trim() : '';

const PARTSTATS = new Set(['NEEDS-ACTION', 'ACCEPTED', 'TENTATIVE', 'DECLINED', 'DELEGATED']);

const toParticipant = (property: ProtonParticipantProperty | undefined, withAnswer: boolean): EventParticipant | undefined => {
    const email = emailFromUri(property?.value);
    if (!email) {
        return undefined;
    }
    const cn = typeof property?.parameters?.cn === 'string' ? property.parameters.cn.trim() : '';
    const participant: EventParticipant = { email };
    if (cn && cn.toLowerCase() !== email.toLowerCase()) {
        participant.name = cn;
    }
    if (withAnswer) {
        const partstat = String(property?.parameters?.partstat || 'NEEDS-ACTION').toUpperCase();
        participant.partstat = PARTSTATS.has(partstat) ? partstat : 'NEEDS-ACTION';
        participant.role = String(property?.parameters?.role || 'REQ-PARTICIPANT').toUpperCase();
    }
    return participant;
};

/**
 * Organizer and guests of one Proton event (needs the patched client's decrypted guest data).
 * Your own entry uses the address Proton matched you by, so Calendar.app recognises it against
 * calendar-user-address-set even when Proton stored a differently written variant.
 */
export const readParticipants = (event: SyncedCalendarEvent): EventParticipants | undefined => {
    const vevent = event.decrypted?.vevent;
    const participation = event.decrypted?.participation;
    const organizer = toParticipant(vevent?.organizer, false);
    const attendees = (vevent?.attendee ?? [])
        .map((property, index) => {
            const participant = toParticipant(property, true);
            if (participant && participation?.isAttendee && participation.selfAttendeeIndex === index) {
                participant.isSelf = true;
                participant.email = participation.selfEmail || participant.email;
            }
            return participant;
        })
        .filter((participant): participant is EventParticipant => Boolean(participant));

    if (!organizer && !attendees.length) {
        return undefined;
    }
    if (organizer && participation?.isOrganizer) {
        organizer.isSelf = true;
        organizer.email = participation.selfEmail || organizer.email;
    }
    return {
        organizer,
        attendees,
        selfRole: participation?.isOrganizer ? 'organizer' : participation?.isAttendee ? 'attendee' : 'none'
    };
};

const byNewestFirst = (a: SeriesMember, b: SeriesMember) =>
    b.event.modifiedTimestamp - a.event.modifiedTimestamp || a.event.eventId.localeCompare(b.event.eventId);

/** Groups Proton events by UID into series (a single non-recurring event is a series of one). */
export const groupIntoSeries = (events: SyncedCalendarEvent[]): EventSeries[] => {
    const byUid = new Map<string, SeriesMember[]>();
    for (const event of events) {
        const members = byUid.get(event.uid) ?? [];
        members.push({ event, recurrence: readRecurrence(event), participants: readParticipants(event) });
        byUid.set(event.uid, members);
    }

    return [...byUid.entries()].map(([uid, members]) => {
        const masters = members.filter((member) => !member.recurrence.recurrenceId).sort(byNewestFirst);

        // One exception per occurrence; if Proton ever returns two, keep the newest.
        const exceptionsById = new Map<string, SeriesMember>();
        for (const member of members.filter((entry) => entry.recurrence.recurrenceId).sort(byNewestFirst)) {
            const occurrence = formatIcsDateValue(member.recurrence.recurrenceId!);
            if (!exceptionsById.has(occurrence)) {
                exceptionsById.set(occurrence, member);
            }
        }
        const exceptions = [...exceptionsById.entries()]
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([, member]) => member);

        const master = masters[0] ?? null;
        const key =
            master?.event.eventId ?? [...exceptions.map((member) => member.event.eventId)].sort()[0];

        return {
            uid,
            key,
            master,
            exceptions,
            droppedDuplicates: masters.slice(1).map((member) => member.event)
        };
    });
};

/** True when the series needs the multi-component representation (RRULE and/or exceptions). */
export const isRecurringSeries = (series: EventSeries) =>
    Boolean(series.master?.recurrence.rrule) || series.exceptions.length > 0;

/** True when any component of the series has an organizer or guests. */
export const seriesHasParticipants = (series: EventSeries) =>
    [series.master, ...series.exceptions].some((member) => Boolean(member?.participants));

// ─── Serialising ─────────────────────────────────────────────────────────────

const escapeIcsText = (value: string) =>
    value.replace(/\\/g, '\\\\').replace(/\r?\n/g, '\\n').replace(/,/g, '\\,').replace(/;/g, '\\;');

/** Folds at 75 octets (RFC 5545 §3.1) without splitting UTF-8 characters. */
const foldLine = (line: string) => {
    if (Buffer.byteLength(line, 'utf8') <= 75) {
        return line;
    }
    const chunks: string[] = [];
    let current = '';
    let currentBytes = 0;
    for (const character of line) {
        const size = Buffer.byteLength(character, 'utf8');
        const limit = chunks.length === 0 ? 75 : 74; // continuation lines start with a space
        if (currentBytes + size > limit) {
            chunks.push(current);
            current = '';
            currentBytes = 0;
        }
        current += character;
        currentBytes += size;
    }
    chunks.push(current);
    return chunks.join('\r\n ');
};

const toUtcStamp = (timestamp: number) => {
    const milliseconds = timestamp > 1e12 ? timestamp : timestamp * 1000;
    const date = new Date(milliseconds);
    return formatIcsDateValue({
        kind: 'date-time',
        year: date.getUTCFullYear(),
        month: date.getUTCMonth() + 1,
        day: date.getUTCDate(),
        hours: date.getUTCHours(),
        minutes: date.getUTCMinutes(),
        seconds: date.getUTCSeconds(),
        utc: true
    });
};

const ALLOWED_STATUS = new Set(['TENTATIVE', 'CONFIRMED', 'CANCELLED']);

/** RFC 5545 §3.2: parameter values containing : ; , are quoted; DQUOTE and line breaks are not allowed. */
const paramValue = (value: string) => {
    const cleaned = value.replace(/["\r\n]/g, '').trim();
    return /[:;,]/.test(cleaned) ? `"${cleaned}"` : cleaned;
};

const participantLines = (participants: EventParticipants | undefined) => {
    if (!participants) {
        return [];
    }
    const lines: string[] = [];
    const { organizer, attendees } = participants;
    if (organizer) {
        const params = organizer.name ? `;CN=${paramValue(organizer.name)}` : '';
        lines.push(`ORGANIZER${params}:mailto:${organizer.email}`);
    }
    for (const attendee of attendees) {
        const params = [
            ...(attendee.name ? [`CN=${paramValue(attendee.name)}`] : []),
            'CUTYPE=INDIVIDUAL',
            `ROLE=${attendee.role || 'REQ-PARTICIPANT'}`,
            `PARTSTAT=${attendee.partstat || 'NEEDS-ACTION'}`,
            'RSVP=TRUE'
        ];
        lines.push(`ATTENDEE;${params.join(';')}:mailto:${attendee.email}`);
    }
    return lines;
};

const buildVevent = (uid: string, member: SeriesMember, isMaster: boolean) => {
    const { event, recurrence } = member;
    const lines = ['BEGIN:VEVENT', `UID:${escapeIcsText(uid)}`, `DTSTAMP:${toUtcStamp(event.modifiedTimestamp)}`];

    if (recurrence.recurrenceId) {
        lines.push(formatIcsDateProperty('RECURRENCE-ID', recurrence.recurrenceId));
    }
    lines.push(formatIcsDateProperty('DTSTART', recurrence.start));
    lines.push(formatIcsDateProperty('DTEND', recurrence.end));

    if (isMaster && recurrence.rrule) {
        lines.push(`RRULE:${recurrence.rrule}`);
        for (const exdate of recurrence.exdates) {
            lines.push(formatIcsDateProperty('EXDATE', exdate));
        }
    }

    lines.push(`SUMMARY:${escapeIcsText(event.title || '')}`);
    const description = servedDescription(event.description); // 0.41.1: without Proton's join block
    if (description) {
        lines.push(`DESCRIPTION:${escapeIcsText(description)}`);
    }
    if (event.location) {
        lines.push(`LOCATION:${escapeIcsText(event.location)}`);
    }
    const status = recurrence.status?.toUpperCase();
    if (status && ALLOWED_STATUS.has(status)) {
        lines.push(`STATUS:${status}`);
    }
    if (typeof recurrence.sequence === 'number' && Number.isFinite(recurrence.sequence)) {
        lines.push(`SEQUENCE:${Math.max(0, Math.floor(recurrence.sequence))}`);
    }
    if (recurrence.transparent) {
        lines.push('TRANSP:TRANSPARENT');
    }
    lines.push(...participantLines(member.participants));
    lines.push(...conferenceLines(event.decrypted?.conference));
    lines.push(...alarmLines(event.decrypted?.reminders?.alarms, `${uid}\u0000${occurrenceKey(recurrence.recurrenceId)}`));
    lines.push('END:VEVENT');
    return lines;
};

/**
 * The alarms of each VEVENT (by occurrence) as a comparable key: action type (email or not) and
 * trigger, as Proton would store them — Calendar.app's extras (UID, ACKNOWLEDGED, descriptions)
 * and the order do not count. Location alarms and alarms Proton cannot keep are left out, so a
 * change in those alone is no change.
 */
export type NormalizeAlarms = (vevent: ComparableVevent) => Array<{ action?: { value?: string }; trigger?: { value?: unknown } }>;

export const alarmKeysByOccurrence = (vevents: ComparableVevent[], normalize: NormalizeAlarms): Map<string, string> =>
    new Map(
        vevents.map((vevent) => [
            occurrenceKey(icsDateFromVcal(vevent['recurrence-id'])),
            normalize(vevent)
                .map((alarm) => `${String(alarm.action?.value || '').toLowerCase() === 'email' ? 'email' : 'device'}:${JSON.stringify(alarm.trigger?.value)}`)
                .sort()
                .join('|')
        ])
    );

/**
 * The occurrences whose alarms differ between two versions (keys as in occurrenceKey; '' = master),
 * including occurrences new in `after` (a changed occurrence Calendar.app just split off carries
 * the alarms it shows, which Proton's new exception does not have yet).
 */
export const occurrencesWithChangedAlarms = (before: ComparableVevent[], after: ComparableVevent[], normalize: NormalizeAlarms): string[] => {
    const left = alarmKeysByOccurrence(before, normalize);
    const right = alarmKeysByOccurrence(after, normalize);
    return [...right].filter(([key, value]) => !left.has(key) || left.get(key) !== value).map(([key]) => key);
};

const collectZones = (members: SeriesMember[]) => {
    const zones = new Set<string>();
    for (const { recurrence } of members) {
        for (const value of [recurrence.start, recurrence.end, recurrence.recurrenceId, ...recurrence.exdates]) {
            if (value?.kind === 'date-time' && value.tzid && !value.utc) {
                zones.add(value.tzid);
            }
        }
    }
    return [...zones].sort();
};

/**
 * One VCALENDAR holding the master (RRULE/EXDATE) and every modified occurrence (RECURRENCE-ID).
 * `uid` overrides the Proton UID, for series Calendar.app knows under its own UID.
 */
export const buildSeriesIcs = (series: EventSeries, referenceYear?: number, uid: string = series.uid) => {
    const members = [...(series.master ? [series.master] : []), ...series.exceptions];
    const vtimezones = collectZones(members).flatMap((zone) => buildVtimezoneLines(zone, referenceYear) ?? []);

    const lines = [
        'BEGIN:VCALENDAR',
        'VERSION:2.0',
        'PRODID:-//Neutron Calendar Bridge//EN',
        'CALSCALE:GREGORIAN',
        ...vtimezones,
        ...(series.master ? buildVevent(uid, series.master, true) : []),
        ...series.exceptions.flatMap((member) => buildVevent(uid, member, false)),
        'END:VCALENDAR'
    ];

    return `${lines.map(foldLine).join('\r\n')}\r\n`;
};

/** Occurrence key used to match a Proton exception with the VEVENT Calendar.app sends: the RECURRENCE-ID as text. */
export const occurrenceKey = (recurrenceId?: IcsDateValue) => (recurrenceId ? formatIcsDateValue(recurrenceId) : '');

/** Proton event IDs of every member of the series, keyed by occurrence ('' = master). */
export const seriesEventIds = (series: EventSeries): Record<string, string> => {
    const ids: Record<string, string> = {};
    if (series.master) {
        ids[''] = series.master.event.eventId;
    }
    for (const member of series.exceptions) {
        ids[occurrenceKey(member.recurrence.recurrenceId)] = member.event.eventId;
    }
    return ids;
};

/** Mirror row for a recurring series; the ETag covers every component of the series. */
export const buildSeriesRecord = (
    series: EventSeries,
    protonCalendarId: string,
    href: string,
    uid: string = series.uid
): BridgeEventRecord => {
    const serializedIcs = buildSeriesIcs(series, undefined, uid);
    const contentHash = createHash('sha256').update(serializedIcs).digest('hex');
    const representative = (series.master ?? series.exceptions[0]).event;
    const modifiedTimestamp = Math.max(
        ...[series.master, ...series.exceptions]
            .filter((member): member is SeriesMember => Boolean(member))
            .map((member) => member.event.modifiedTimestamp)
    );

    return {
        protonEventId: series.key,
        protonCalendarId,
        uid,
        href,
        etag: `"${contentHash}"`,
        contentHash,
        serializedIcs,
        protonEventIds: seriesEventIds(series),
        title: representative.title,
        description: representative.description,
        location: representative.location,
        startTimestamp: representative.startTimestamp,
        endTimestamp: representative.endTimestamp,
        timezone: representative.timezone,
        isAllDay: representative.isAllDay,
        modifiedTimestamp,
        deleted: false,
        lastSyncedAt: Date.now()
    };
};

// ─── Guarding writes from Calendar.app ───────────────────────────────────────

/**
 * True if an ICS payload describes a recurring series or a single occurrence of one.
 * Only VEVENT components count: VTIMEZONE blocks carry their own RRULEs for DST switches,
 * and Calendar.app includes those in every ordinary timed event it saves.
 */
export const icsHasRecurrence = (ics: string) => {
    const unfolded = ics.replace(/\r?\n[ \t]/g, '');
    const vevents = unfolded.match(/^BEGIN:VEVENT[ \t]*$[\s\S]*?^END:VEVENT[ \t]*$/gim) || [];
    return vevents.length > 1 || vevents.some((block) => /^(RRULE|RDATE|EXDATE|RECURRENCE-ID)[;:]/im.test(block));
};

/**
 * The VEVENT blocks of an ICS text, unfolded, each without its VALARMs: an email alarm carries
 * ATTENDEE lines of its own (0.33), which are not the event's guests.
 */
export const veventBlocksWithoutAlarms = (ics: string) => {
    const unfolded = ics.replace(/\r?\n[ \t]/g, '');
    return (unfolded.match(/^BEGIN:VEVENT[ \t]*$[\s\S]*?^END:VEVENT[ \t]*$/gim) || []).map((block) =>
        block.replace(/^BEGIN:VALARM[ \t]*$[\s\S]*?^END:VALARM[ \t]*$/gim, '')
    );
};

/**
 * ORGANIZER / ATTENDEE properties with SCHEDULE-AGENT=CLIENT or NONE (RFC 6638: the client sends the
 * invitations itself, or nobody does), with which occurrence they are on.
 */
export const clientSchedulingOf = (ics: string) => {
    const blocks = veventBlocksWithoutAlarms(ics);
    const found: Array<{ agent: 'CLIENT' | 'NONE'; description: string }> = [];
    for (const block of blocks) {
        const recurrenceId = block.match(/^RECURRENCE-ID(?:;[^:\r\n]*)?:([^\r\n]+)$/im)?.[1]?.trim();
        const pattern = /^(ORGANIZER|ATTENDEE)((?:"[^"]*"|[^:"\r\n])*):([^\r\n]*)$/gim;
        let match: RegExpExecArray | null;
        while ((match = pattern.exec(block))) {
            const agent = match[2].match(/;SCHEDULE-AGENT=(CLIENT|NONE)\b/i)?.[1]?.toUpperCase() as 'CLIENT' | 'NONE' | undefined;
            if (agent) {
                const address = match[3].trim().replace(/^mailto:/i, '');
                found.push({ agent, description: `${match[1].toUpperCase()} ${address} SCHEDULE-AGENT=${agent}${recurrenceId ? ` (occurrence ${recurrenceId})` : ''}` });
            }
        }
    }
    return found;
};

/** The structure of a payload for bridge.log: VEVENTs, repeat rule, exclusions, scheduling parameters (no text). */
export const describeIcsShape = (ics: string) => {
    const unfolded = ics.replace(/\r?\n[ \t]/g, '');
    const blocks = veventBlocksWithoutAlarms(ics);
    const alarms = (unfolded.match(/^BEGIN:VALARM/gim) || []).length;
    const value = (block: string, name: string) => block.match(new RegExp(`^${name}(?:;[^:\\r\\n]*)?:([^\\r\\n]+)$`, 'im'))?.[1]?.trim();
    const parts = blocks.map((block) => {
        const recurrenceId = value(block, 'RECURRENCE-ID');
        const exdates = (block.match(/^EXDATE[;:]/gim) || []).length;
        const scheduling = [...new Set(block.match(/;SCHEDULE-[A-Z-]+=[^;:\r\n]+/gi) || [])].map((entry) => entry.slice(1));
        return [
            recurrenceId ? `occurrence ${recurrenceId}` : 'series',
            `DTSTART ${value(block, 'DTSTART') || '?'}`,
            value(block, 'RRULE') ? `RRULE ${value(block, 'RRULE')}` : '',
            exdates ? `${exdates} EXDATE` : '',
            value(block, 'STATUS') ? `STATUS ${value(block, 'STATUS')}` : '',
            `SEQUENCE ${value(block, 'SEQUENCE') ?? '-'}`,
            `${(block.match(/^ATTENDEE[;:]/gim) || []).length} ATTENDEE`,
            scheduling.length ? scheduling.join(' ') : ''
        ]
            .filter(Boolean)
            .join(', ');
    });
    return `${blocks.length} VEVENT${alarms ? `, ${alarms} VALARM` : ''}: ${parts.join(' | ')}`;
};

/** True if any VEVENT of an ICS payload has an ORGANIZER or ATTENDEE (i.e. involves other people). */
export const icsHasParticipants = (ics: string) => veventBlocksWithoutAlarms(ics).some((block) => /^(ORGANIZER|ATTENDEE)[;:]/im.test(block));

// ─── Comparing what Proton stores ────────────────────────────────────────────

/** The parts of a VEVENT Proton stores (shape as parsed by proton-calendar-client). */
export interface ComparableVevent {
    uid?: { value: string };
    /** VALARMs (and other sub-components) as parseIcsToVevents keeps them. */
    components?: unknown[];
    dtstart?: ProtonVcalDateProperty;
    dtend?: ProtonVcalDateProperty;
    rrule?: { value: Record<string, unknown> };
    exdate?: ProtonVcalDateProperty[];
    'recurrence-id'?: ProtonVcalDateProperty;
    summary?: { value: string };
    description?: { value: string };
    location?: { value: string };
    status?: { value: string };
    transp?: { value: string };
    organizer?: ProtonParticipantProperty;
    attendee?: ProtonParticipantProperty[];
}

const normalizeText = (value?: string) => (value ?? '').replace(/\r\n?/g, '\n').trim();

const instantKey = (property?: ProtonVcalDateProperty) => {
    const value = icsDateFromVcal(property);
    return value ? `${value.kind}:${icsDateToUtcMs(value)}` : '';
};

/**
 * 0.40: the zone a local time is given in ('' for all-day, UTC and floating times). Proton stores the
 * TZID, so an event moved to another zone at the same instant is a change to write — Proton's own
 * rule (getHasModifiedDateTimes) still counts it as the same time, so guests' answers are kept.
 */
const zoneKey = (property?: ProtonVcalDateProperty) => {
    const value = icsDateFromVcal(property);
    return value?.kind === 'date-time' && !value.utc && value.tzid ? value.tzid : '';
};

/**
 * What Proton would store for one VEVENT, as a comparable string. Ignores what the bridge does not
 * write to Proton anyway (alarms, DTSTAMP, SEQUENCE, Apple's X- properties, parameter spelling).
 * Calendar.app sometimes lists the organizer among the guests; that entry is ignored too.
 */
const fingerprint = (vevent: ComparableVevent) => {
    const organizer = emailFromUri(vevent.organizer?.value).toLowerCase();
    const attendees = (vevent.attendee ?? [])
        .map((attendee) => ({
            email: emailFromUri(attendee.value).toLowerCase(),
            partstat: String(attendee.parameters?.partstat || 'NEEDS-ACTION').toUpperCase(),
            role: String(attendee.parameters?.role || 'REQ-PARTICIPANT').toUpperCase()
        }))
        .filter((attendee) => attendee.email && attendee.email !== organizer)
        .map(({ email, partstat, role }) => `${email}|${partstat}|${role}`)
        .sort();
    const status = String(vevent.status?.value || 'CONFIRMED').toUpperCase();
    return JSON.stringify({
        start: instantKey(vevent.dtstart),
        end: instantKey(vevent.dtend),
        zones: [zoneKey(vevent.dtstart), zoneKey(vevent.dtend)],
        rrule: vevent.rrule?.value ? formatRrule(vevent.rrule.value) ?? '' : '',
        exdates: (vevent.exdate ?? []).map(instantKey).sort(),
        summary: normalizeText(vevent.summary?.value),
        description: normalizeText(servedDescription(vevent.description?.value)), // 0.41.1: the join block is the bridge's to write
        location: normalizeText(vevent.location?.value),
        status: status === 'CANCELLED' ? status : 'CONFIRMED', // 0.49.12: Proton stores no TENTATIVE; a tentative copy is no change
        free: String(vevent.transp?.value || '').toUpperCase() === 'TRANSPARENT', // 0.49.7: "Show as: Free"
        organizer,
        attendees
    });
};

const byOccurrence = (vevents: ComparableVevent[]) =>
    new Map(vevents.map((vevent) => [occurrenceKey(icsDateFromVcal(vevent['recurrence-id'])), fingerprint(vevent)]));

/**
 * 0.49.5: the occurrences of a save that are the client's stale copies, not its changes — each is
 * the occurrence as the client was served it before the last change (one of `earlier`, the
 * versions replaced in the last minutes), not as Proton has it now. Thunderbird's "Submit my
 * changes anyway" after a conflict sends its whole item, those occurrences included.
 */
export const staleOccurrenceKeys = (saved: ComparableVevent[], current: ComparableVevent[], earlier: ComparableVevent[][]): string[] => {
    const now = byOccurrence(current);
    const olds = earlier.map(byOccurrence);
    return saved
        .filter((vevent) => vevent['recurrence-id'])
        .map((vevent) => [occurrenceKey(icsDateFromVcal(vevent['recurrence-id'])), fingerprint(vevent)] as const)
        .filter(([key, print]) => now.get(key) !== print && olds.some((old) => old.get(key) === print))
        .map(([key]) => key);
};

/**
 * True when two versions of a calendar object differ only in things Proton does not store
 * (e.g. Calendar.app added an alert), so saving it would not change anything in Proton.
 */
export const sameForProton = (a: ComparableVevent[], b: ComparableVevent[]) => {
    const left = byOccurrence(a);
    const right = byOccurrence(b);
    return left.size === right.size && [...left].every(([key, value]) => right.get(key) === value);
};

/**
 * 0.40: Calendar.app's way of giving one occurrence its own alert — a new VEVENT for that occurrence
 * (RECURRENCE-ID), at its usual time and otherwise like the series, with a VALARM — and nothing else
 * changed. Proton keeps an invitation's reminders for the whole series unless the occurrence is an
 * event of its own, so such a save is refused with that reason (not as "only the organizer can change it").
 */
export const onlyNewOccurrenceAlarms = (before: ComparableVevent[], after: ComparableVevent[]) => {
    const known = new Set(before.map((vevent) => occurrenceKey(icsDateFromVcal(vevent['recurrence-id']))));
    const added = after.filter((vevent) => !known.has(occurrenceKey(icsDateFromVcal(vevent['recurrence-id']))));
    const master = before.find((vevent) => !vevent['recurrence-id']);
    if (!added.length || !master?.rrule || !master.dtstart || !added.every((vevent) => vevent['recurrence-id'])) {
        return false;
    }
    if (!sameForProton(before, after.filter((vevent) => !added.includes(vevent)))) {
        return false; // something else changed too
    }
    const ms = (property?: ProtonVcalDateProperty) => {
        const value = icsDateFromVcal(property);
        return value ? icsDateToUtcMs(value) : NaN;
    };
    const length = ms(master.dtend) - ms(master.dtstart);
    return (
        added.some((vevent) => (vevent.components ?? []).length > 0) &&
        added.every((vevent) => {
            const start = ms(vevent.dtstart);
            const atItsTime = start === ms(vevent['recurrence-id']) && (!vevent.dtend || ms(vevent.dtend) - start === length || !Number.isFinite(length));
            const likeTheSeries = fingerprint({ ...vevent, 'recurrence-id': undefined, dtstart: master.dtstart, dtend: master.dtend, rrule: master.rrule, exdate: master.exdate }) === fingerprint(master);
            return atItsTime && likeTheSeries;
        })
    );
};

/**
 * True when two versions differ at most in guests' answers (and what Proton does not store): for a
 * meeting you organize, a save based on either version changes the same things in Proton (answers
 * always come from Proton, never from Calendar.app's copy).
 */
export const sameExceptAnswers = (a: ComparableVevent[], b: ComparableVevent[]) => {
    const withoutAnswers = (vevents: ComparableVevent[]) =>
        vevents.map((vevent) => ({
            ...vevent,
            attendee: (vevent.attendee ?? []).map((attendee) => ({
                ...attendee,
                parameters: { ...attendee.parameters, partstat: 'NEEDS-ACTION' }
            }))
        }));
    return sameForProton(withoutAnswers(a), withoutAnswers(b));
};

/**
 * True when the only difference is the answer (PARTSTAT) of one of your own addresses,
 * i.e. you pressed Accept / Maybe / Decline on an invitation in Calendar.app.
 */
export const onlyOwnAnswerChanged = (before: ComparableVevent[], after: ComparableVevent[], ownEmails: string[]) => {
    const own = new Set(ownEmails.map((email) => email.toLowerCase()));
    const withoutOwnAnswer = (vevents: ComparableVevent[]) =>
        vevents.map((vevent) => ({
            ...vevent,
            attendee: (vevent.attendee ?? []).map((attendee) =>
                own.has(emailFromUri(attendee.value).toLowerCase())
                    ? { ...attendee, parameters: { ...attendee.parameters, partstat: 'NEEDS-ACTION' } }
                    : attendee
            )
        }));
    return !sameForProton(before, after) && sameForProton(withoutOwnAnswer(before), withoutOwnAnswer(after));
};

export type InvitationAnswerValue = 'ACCEPTED' | 'TENTATIVE' | 'DECLINED';

/** One occurrence ('' = the series or a single event) whose own answer changed, and the new answer. */
export interface OwnAnswerChange {
    key: string;
    /** As Calendar.app wrote it (upper case); only ACCEPTED / TENTATIVE / DECLINED can be sent. */
    answer: string;
}

const ownAnswerOf = (vevent: ComparableVevent, own: Set<string>) => {
    const answers = (vevent.attendee ?? [])
        .filter((attendee) => own.has(emailFromUri(attendee.value).toLowerCase()))
        .map((attendee) => String(attendee.parameters?.partstat || 'NEEDS-ACTION').toUpperCase());
    return answers;
};

/**
 * The answers you changed in Calendar.app (Accept / Maybe / Decline), per occurrence; null when
 * anything else changed too. With several of your addresses invited, the entry that changed wins.
 */
export const ownAnswerChanges = (
    before: ComparableVevent[],
    after: ComparableVevent[],
    ownEmails: string[]
): OwnAnswerChange[] | null => {
    if (!onlyOwnAnswerChanged(before, after, ownEmails)) {
        return null;
    }
    const own = new Set(ownEmails.map((email) => email.toLowerCase()));
    const previous = new Map(
        before.map((vevent) => [occurrenceKey(icsDateFromVcal(vevent['recurrence-id'])), ownAnswerOf(vevent, own)])
    );
    const changes: OwnAnswerChange[] = [];
    for (const vevent of after) {
        const key = occurrenceKey(icsDateFromVcal(vevent['recurrence-id']));
        const was = previous.get(key) ?? [];
        const now = ownAnswerOf(vevent, own);
        const changed = now.find((answer, index) => answer !== was[index]);
        if (changed) {
            changes.push({ key, answer: changed });
        }
    }
    return changes;
};

/**
 * True when Calendar.app added occurrences of its own that list you (how it answers a single
 * occurrence of a series): Proton only takes answers for the series or for occurrences the
 * organizer changed.
 */
/**
 * 0.49.3: Thunderbird answers an invitation from the occurrence you opened (its guest dialog has no
 * "whole series"): the series stays at NEEDS-ACTION and one new occurrence carries the answer. When
 * the series has not been answered yet and nothing else changed, that is the answer for the series —
 * as Proton Calendar takes it. Returns the answer, or null when it is not that shape (answered series,
 * several answers, something else changed, no sendable answer).
 */
export const seriesAnswerFromNewOccurrence = (
    before: ComparableVevent[],
    after: ComparableVevent[],
    ownEmails: string[]
): InvitationAnswerValue | null => {
    if (!answersNewOccurrence(before, after, ownEmails)) {
        return null;
    }
    const own = new Set(ownEmails.map((email) => email.toLowerCase()));
    const keyOf = (vevent: ComparableVevent) => occurrenceKey(icsDateFromVcal(vevent['recurrence-id']));
    const known = new Set(before.map(keyOf));
    const existing = after.filter((vevent) => known.has(keyOf(vevent)));
    const master = existing.find((vevent) => keyOf(vevent) === '');
    if (!master || !sameForProton(before, existing)) {
        return null;
    }
    if (!ownAnswerOf(master, own).every((answer) => answer === 'NEEDS-ACTION')) {
        return null; // the series is answered: one more answer for one occurrence is not possible in Proton
    }
    const answers = new Set(after.filter((vevent) => !known.has(keyOf(vevent))).flatMap((vevent) => ownAnswerOf(vevent, own)));
    const sendable: InvitationAnswerValue[] = ['ACCEPTED', 'TENTATIVE', 'DECLINED'];
    const [only] = [...answers];
    return answers.size === 1 && (sendable as string[]).includes(only) ? (only as InvitationAnswerValue) : null;
};

/**
 * 0.49.4: the client's copy is behind — its series still says NEEDS-ACTION (or the old answer) while
 * Proton's is answered, and the occurrences it adds carry that very answer (Thunderbird replaying a
 * cached change after the series was answered). Nothing to do: true when every added occurrence
 * repeats the series' answer and nothing else differs apart from your own answers.
 */
export const repeatsSeriesAnswer = (before: ComparableVevent[], after: ComparableVevent[], ownEmails: string[]) => {
    const own = new Set(ownEmails.map((email) => email.toLowerCase()));
    const keyOf = (vevent: ComparableVevent) => occurrenceKey(icsDateFromVcal(vevent['recurrence-id']));
    const known = new Set(before.map(keyOf));
    const added = after.filter((vevent) => !known.has(keyOf(vevent)));
    const existing = after.filter((vevent) => known.has(keyOf(vevent)));
    const master = before.find((vevent) => keyOf(vevent) === '');
    if (!added.length || !master || existing.length !== before.length) {
        return false;
    }
    const seriesAnswer = [...new Set(ownAnswerOf(master, own))];
    if (seriesAnswer.length !== 1 || !['ACCEPTED', 'TENTATIVE', 'DECLINED'].includes(seriesAnswer[0])) {
        return false;
    }
    if (!(sameForProton(before, existing) || onlyOwnAnswerChanged(before, existing, ownEmails))) {
        return false;
    }
    // Each added occurrence is the series at its own time, with nothing but the answer (a moved one, or one
    // with an alarm of its own, is a change of its own and not taken here).
    const ms = (property?: ProtonVcalDateProperty) => {
        const value = icsDateFromVcal(property);
        return value ? icsDateToUtcMs(value) : NaN;
    };
    const unanswered = (vevent: ComparableVevent): ComparableVevent => ({
        ...vevent,
        attendee: (vevent.attendee ?? []).map((attendee) =>
            own.has(emailFromUri(attendee.value).toLowerCase()) ? { ...attendee, parameters: { ...attendee.parameters, partstat: 'NEEDS-ACTION' } } : attendee
        )
    });
    const length = ms(master.dtend) - ms(master.dtstart);
    const masterPrint = fingerprint(unanswered(master));
    return added.every((vevent) => {
        const answers = ownAnswerOf(vevent, own);
        if (!answers.length || !answers.every((answer) => answer === seriesAnswer[0]) || !vevent['recurrence-id']) {
            return false;
        }
        const start = ms(vevent.dtstart);
        const atItsTime = start === ms(vevent['recurrence-id']) && (!vevent.dtend || ms(vevent.dtend) - start === length || !Number.isFinite(length));
        const likeTheSeries = fingerprint(unanswered({ ...vevent, 'recurrence-id': undefined, dtstart: master.dtstart, dtend: master.dtend, rrule: master.rrule, exdate: master.exdate })) === masterPrint;
        return atItsTime && likeTheSeries;
    });
};

export const answersNewOccurrence = (before: ComparableVevent[], after: ComparableVevent[], ownEmails: string[]) => {
    const own = new Set(ownEmails.map((email) => email.toLowerCase()));
    const known = new Set(before.map((vevent) => occurrenceKey(icsDateFromVcal(vevent['recurrence-id']))));
    const added = after.filter((vevent) => !known.has(occurrenceKey(icsDateFromVcal(vevent['recurrence-id']))));
    if (!added.length || added.length === after.length) {
        return false;
    }
    const existing = after.filter((vevent) => known.has(occurrenceKey(icsDateFromVcal(vevent['recurrence-id']))));
    return added.every((vevent) => ownAnswerOf(vevent, own).length > 0) && (sameForProton(before, existing) || onlyOwnAnswerChanged(before, existing, ownEmails));
};
