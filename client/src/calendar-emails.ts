/**
 * Emails about meetings, moved out of the Inbox once they are dealt with (to the Bin, the Archive or a
 * folder), like Outlook's "delete meeting requests and notifications from Inbox after responding" and
 * its processing of answers. Proton keeps them where they are.
 *
 * Which emails: in the Inbox, received in the last 30 days, with a calendar attachment (by file name,
 * like Proton Mail), not starred, not bounced, not failing DMARC or flagged as phishing / suspicious,
 * not PGP/MIME. The attachment is decrypted and parsed like in emailed-answers.ts (Proton's recovery
 * parser and the first checks of getSupportedEventInvitation). Dealt with means (mirroring Proton
 * Mail's updateEventInvitation, which decides what opening the email would still change):
 * - an answer (REPLY) to a meeting you organize: Proton has this guest's answer, or one recorded
 *   after the email arrived (strict identity checks of emailed-answers.ts); or the answer is for an
 *   older version, or the meeting is cancelled or was deleted (`goneMeetings`). Also Proton guests'
 *   replies (Proton records those directly). Counter-proposals and answers with a note stay: the
 *   proposed time or the note exists only in the email;
 * - an invitation or update (REQUEST) to you: outdated (an older SEQUENCE or DTSTAMP than the
 *   meeting in your calendar), or this version is in your calendar (nothing Proton would still
 *   change: getHasModifiedDtstamp + changed time, title, notes, place, repeat rule or guests) and you
 *   answered it; an occurrence that is no longer part of the series (getCanCreateSingleEdit); or you
 *   removed the meeting after the email arrived (`goneMeetings`). A new invitation to a meeting that
 *   is cancelled in your calendar is a re-invitation (getIsReinvite) and waits for you;
 * - a cancellation (CANCEL) to you: outdated, cancelled in your calendar, the occurrence no longer in
 *   the series, or the meeting was deleted (`goneMeetings`).
 * Nothing is dealt with only because a meeting cannot be found (it may be organized elsewhere, or not
 * added yet). Everything else stays: waiting (for your answer, or for Proton; checked again, sooner
 * when the caller passes the meeting's UID in `changedUids`), or left for you (the bridge cannot tell).
 *
 * How: core/v4/labels (Type 3, folders) to find or create the folder; mail/v4/messages/label with the
 * Trash, Archive or folder label (moving, like Proton Mail's "Move to"), ten messages per request like
 * Proton Mail, each one checked to be still in the Inbox and not starred right before. Nothing else is
 * written: no answers, no read flags, nothing sent. In a dry run the emails are only reported, and the
 * folder is not created.
 *
 * Sources (Proton WebClients, commit 464c1b060): applications/mail/src/app/helpers/calendar/inviteApi.ts
 * (updateEventInvitation), invite.ts (getIsInvitationOutdated, getIsReinvite, getCanCreateSingleEdit,
 * getIsNonSoughtEvent), helpers/chunk.ts (MAIL_ACTION_DEFAULT_CHUNK_SIZE), packages/shared/lib/api/labels.ts
 * and messages.ts (labelMessages), packages/shared/lib/calendar/helper.ts (getSupportedUID),
 * packages/shared/lib/colors.ts (ACCENT_COLORS).
 */
import './polyfill';
import { getMessage, labelMessages } from '@proton/shared/lib/api/messages';
import { getAttendeeEmail, toIcsPartstat } from '@proton/shared/lib/calendar/attendees';
import { ICAL_ATTENDEE_STATUS, ICAL_METHOD } from '@proton/shared/lib/calendar/constants';
import { getSupportedUID } from '@proton/shared/lib/calendar/helper';
import { getHasModifiedAttendees } from '@proton/shared/lib/calendar/mailIntegration/invite';
import { getOccurrencesBetween } from '@proton/shared/lib/calendar/recurrence/recurring';
import { getIsRruleEqual } from '@proton/shared/lib/calendar/recurrence/rruleEqual';
import { getIsPropertyAllDay, getIsVeventCancelled } from '@proton/shared/lib/calendar/vcalHelper';
import { getHasModifiedDateTimes, propertyToUTCDate } from '@proton/shared/lib/calendar/vcalConverter';
import { getIsEventCancelled, getIsRecurring } from '@proton/shared/lib/calendar/veventHelper';
import { getSupportedTimezone } from '@proton/shared/lib/date/timezone';
import type { CalendarEvent, VcalVeventComponent } from '@proton/shared/lib/interfaces/calendar';

import {
    ICAL_MIME_TYPE,
    PAGE_SIZE,
    allEventsByUID,
    baseOf,
    calendarFileOf,
    checkReply,
    emailSkipReason,
    isCalendarAttachment,
    isOutage,
    messagesWithAttachments,
    ownCalendars,
    readAttachment,
    sameOwnAddress,
    sequenceOf,
    withoutContent,
} from './emailed-answers';
import type { CalendarFile, Filing, OwnCalendar } from './emailed-answers';
import { completeAttendeesInfo, errorText, readInvitation } from './invitations';
import type { InvitationContext } from './invitations';

export type CalendarEmailDestination = 'trash' | 'archive' | 'folder';

/** A meeting deleted from your calendars (by you, or seen gone by the caller), and when (Unix seconds). */
export interface GoneMeeting {
    uid: string;
    at: number;
}

export interface FileCalendarEmailsInput {
    /** Where emails that are dealt with go. */
    moveTo: CalendarEmailDestination;
    /** The folder for `moveTo: 'folder'`: a top-level folder, created if missing (default "Calendar"). */
    folderName?: string;
    /** UIDs of meetings that changed since the last run (synced, answered, deleted): their emails are checked now. */
    changedUids?: string[];
    /**
     * Meetings deleted from your calendars: answers and cancellations about them are dealt with, and
     * invitations and updates that arrived before the deletion.
     */
    goneMeetings?: GoneMeeting[];
    /** How far back the Inbox is looked at, in days (default 30). */
    lookbackDays?: number;
    /** At most this many list requests of 100 emails per run (default 3). */
    maxPages?: number;
    /** At most this many emails opened (decrypted) per run (default 25); the rest next run. */
    maxOpened?: number;
    /** At most this many emails checked against your calendars per run (default 40); the rest next run. */
    maxChecks?: number;
    /** Stop opening and checking after this long (default 20 s; at least one of each per run). */
    budgetMs?: number;
}

export type CalendarEmailKind = 'invitation' | 'update' | 'cancellation' | 'answer';

/** An email moved out of the Inbox (or only reported, in a dry run), or a move that failed. */
export interface FiledEmail {
    messageId: string;
    /** When the email arrived (ISO). */
    receivedAt: string;
    from: string;
    to: string;
    subject: string;
    kind: CalendarEmailKind;
    eventTitle?: string;
    /** Why it counts as dealt with. */
    why: string;
    /** "Trash", "Archive" or the folder's name. */
    destination: string;
    outcome: 'moved' | 'dry-run' | 'failed';
    error?: string;
}

/** An email about a meeting that stays in the Inbox for you, and why (reported once per run of the app). */
export interface LeftEmail {
    messageId: string;
    from: string;
    subject: string;
    kind?: CalendarEmailKind;
    eventTitle?: string;
    why: string;
    /** 0.41.10 (bridge): a guest's note with an answer (the reason the email stays). */
    note?: string;
}

export interface FileCalendarEmailsResult {
    filed: FiledEmail[];
    /** Emails newly found to stay in the Inbox for you, with the reason. */
    left: LeftEmail[];
    /** In the Inbox now: emails about meetings waiting for your answer or for Proton (or not checked yet). */
    waiting: number;
    /** In the Inbox now: emails about meetings the bridge leaves for you. */
    leftCount: number;
    /** In the Inbox now, dry run only: emails that would be moved. */
    wouldMove: number;
    /** Emails opened (decrypted) in this run. */
    opened: number;
    /** Emails checked against your calendars in this run. */
    checked: number;
    /** A limit (pages, emails, checks, time) was reached: the next run continues. */
    more?: boolean;
    /** The folder was created in this run (its name). */
    folderCreated?: string;
    /** The folder could not be found or created (no emails moved; tried again later). */
    folderError?: string;
    /** The run stopped early (no connection, Proton busy); tried again next run. */
    error?: string;
}

/** Kept by the caller across runs (in memory: after a restart the Inbox is simply looked at again). */
export interface CalendarEmailsState {
    emails: Map<string, TrackedEmail>;
    /** The folder's label ID, for the folder name it was found or created for. */
    folder?: { name: string; id: string };
    /** Finding or creating the folder failed (e.g. folder limit of the plan): not tried again for a while. */
    folderFailure?: { name: string; at: number; error: string };
    /** The email policy's mode of the last run: switching between dry run and live checks everything again. */
    mode?: 'dry-run' | 'live';
}

interface TrackedEmail {
    time: number;
    base: ReturnType<typeof baseOf>;
    /** The calendar file; null when the email is none of this feature's business or cannot be read. */
    file: CalendarFile | null;
    kind?: CalendarEmailKind;
    /** The meeting's UID as Proton stores it (getSupportedUID). */
    uid?: string;
    /** The last verdict; undefined until checked. */
    filing?: Filing;
    /** Unix seconds of the next check (sooner when its meeting changes). */
    nextCheck: number;
    /** Checks that found it still waiting. */
    tries: number;
    /** Could not be read: opened again from this time (Unix seconds). */
    reopenAt?: number;
    /** The deletion time of its meeting already checked against (a deletion makes it due once). */
    goneChecked?: number;
    /** Already reported as left for you / listed in a dry run. */
    reportedLeft?: boolean;
    listedDryRun?: boolean;
}

// MAILBOX_LABEL_IDS
const INBOX = '0';
const TRASH = '3';
const ARCHIVE = '6';
const STARRED = '10';
// LABEL_TYPE.MESSAGE_FOLDER
const MESSAGE_FOLDER = 3;
// ACCENT_COLORS_MAP.purple, the first of Proton's colours
const FOLDER_COLOR = '#8080FF';
// MAIL_ACTION_DEFAULT_CHUNK_SIZE
const MOVE_CHUNK_SIZE = 10;
export const DEFAULT_FOLDER_NAME = 'Calendar';
const HOUR = 3600;
/** Waiting emails are checked again after 1, 2, 5, 10, 30 minutes, then hourly (sooner when the meeting changes). */
const WAITING_BACKOFF_SECONDS = [60, 120, 300, 600, 1800, HOUR];
/** A folder that could not be found or created is tried again after this long. */
const FOLDER_RETRY_SECONDS = 1800;
const HANDLED_METHODS = [ICAL_METHOD.REPLY, ICAL_METHOD.COUNTER, ICAL_METHOD.REQUEST, ICAL_METHOD.CANCEL];
const ANSWER_LABELS: Record<string, string> = {
    [ICAL_ATTENDEE_STATUS.ACCEPTED]: 'yes',
    [ICAL_ATTENDEE_STATUS.TENTATIVE]: 'maybe',
    [ICAL_ATTENDEE_STATUS.DECLINED]: 'no',
};

export const folderNameOf = (name?: string) => String(name ?? '').trim() || DEFAULT_FOLDER_NAME;

const kindOf = ({ method, vevent }: CalendarFile): CalendarEmailKind => {
    if (method === ICAL_METHOD.CANCEL) {
        return 'cancellation';
    }
    if (method === ICAL_METHOD.REQUEST) {
        return sequenceOf(vevent) > 0 || vevent['recurrence-id'] ? 'update' : 'invitation';
    }
    return 'answer';
};

const unixOf = (property: any) => Math.floor(+propertyToUTCDate(property) / 1000);

/**
 * A date-time of the email with a time zone Proton knows (getSupportedTimezone maps e.g. Outlook's
 * "W. Europe Standard Time"); a floating time takes DTSTART's zone. Null when that is not possible.
 */
const supportedTime = (property: any, vevent: any) => {
    if (!property?.value) {
        return null;
    }
    if (getIsPropertyAllDay(property) || property.value.isUTC) {
        return property;
    }
    const tzid = property.parameters?.tzid || vevent?.dtstart?.parameters?.tzid;
    const supported = tzid ? getSupportedTimezone(tzid) : undefined;
    return supported ? { ...property, parameters: { ...property.parameters, tzid: supported } } : null;
};

/** The email's event with supported time zones (for Proton's comparisons); null if it has an unknown one. */
const withSupportedTimes = (vevent: any) => {
    const result: any = { ...vevent };
    for (const key of ['dtstart', 'dtend', 'recurrence-id']) {
        if (vevent[key]) {
            result[key] = supportedTime(vevent[key], vevent);
            if (!result[key]) {
                return null;
            }
        }
    }
    return result as VcalVeventComponent;
};

const dtstampOf = (vevent: any) => {
    try {
        return vevent?.dtstamp ? unixOf(vevent.dtstamp) : undefined;
    } catch {
        return undefined;
    }
};

/** The email's DTSTAMP like getSupportedDtstamp: its zone mapped; the email's arrival when missing or unknown. */
const emailDtstampOf = (vevent: any, arrival: number) => {
    const supported = vevent?.dtstamp ? supportedTime(vevent.dtstamp, vevent) : null;
    try {
        return supported ? unixOf(supported) : arrival;
    } catch {
        return arrival;
    }
};

/** invite.ts getCanCreateSingleEdit: the occurrence is (still) part of the series. */
const isOccurrenceOf = (recurrenceId: any, parent: VcalVeventComponent) => {
    if (!getIsRecurring(parent)) {
        return false;
    }
    const utcStart = +propertyToUTCDate(recurrenceId);
    return getOccurrencesBetween(parent, utcStart, utcStart).length === 1;
};

/** The email's calendar file (text/calendar attachments first), or why it is left alone. */
const calendarFileOfEmail = async (ctx: InvitationContext, message: any): Promise<{ file: CalendarFile } | { left: string } | null> => {
    const isTextCalendar = (attachment: any) => String(attachment.MIMEType || '').toLowerCase().startsWith(ICAL_MIME_TYPE);
    const attachments = (message.Attachments || [])
        .filter(isCalendarAttachment)
        .sort((a: any, b: any) => Number(isTextCalendar(b)) - Number(isTextCalendar(a)));
    for (const attachment of attachments) {
        const parsed = calendarFileOf(await readAttachment(ctx, message, attachment), HANDLED_METHODS);
        if ('refused' in parsed) {
            return { left: parsed.refused };
        }
        if ('method' in parsed) {
            return { file: parsed };
        }
        // Another method (PUBLISH, ADD, ...): look at the next file, if any.
    }
    return null;
};

type Lookup = (uid: string) => Promise<{ own: CalendarEvent[]; all: CalendarEvent[] }>;

/** An invitation, update or cancellation sent to you: would opening it in Proton Mail still change anything? */
const checkInvitation = async (
    ctx: InvitationContext,
    tracked: TrackedEmail,
    gone: Map<string, number>,
    lookup: Lookup
): Promise<Filing> => {
    const { method, vevent: raw } = tracked.file!;
    const done = (why: string, title?: string): Filing => ({ state: 'done', why, title });
    const waiting = (why: string, title?: string): Filing => ({ state: 'waiting', why, title });
    const left = (why: string, title?: string): Filing => ({ state: 'left', why, title });
    if (!raw.uid?.value) {
        return left('the calendar file has no UID');
    }
    const uid = getSupportedUID(raw.uid.value);
    const organizer = raw.organizer ? getAttendeeEmail(raw.organizer as any) : '';
    if (organizer && ctx.addresses.some(({ Email }) => sameOwnAddress(Email, organizer))) {
        return left('it is about a meeting you organize');
    }
    const vevent = withSupportedTimes(raw);
    if (!vevent) {
        return left('it uses a time zone Proton does not know');
    }
    const recurrenceId = vevent['recurrence-id'];
    const rid = recurrenceId ? unixOf(recurrenceId) : undefined;
    const sequence = sequenceOf(vevent);
    const emailStamp = emailDtstampOf(raw, tracked.time);
    const { own, all } = await lookup(uid);
    if (!own.length && all.length) {
        return left('the meeting is in a calendar that is not yours');
    }
    const goneAt = gone.get(uid);

    type Read = Awaited<ReturnType<typeof readInvitation>>;
    const read = async (event: CalendarEvent) => readInvitation(ctx, await completeAttendeesInfo(ctx.api, event));
    /** Of several copies (e.g. in two of your calendars), the one for the address the email went to. */
    const pick = async (events: CalendarEvent[]): Promise<Read | undefined> => {
        if (events.length <= 1) {
            return events[0] ? read(events[0]) : undefined;
        }
        const invitations = await Promise.all(events.map(read));
        return invitations.find(({ selfAddress }) => sameOwnAddress((selfAddress as any)?.Email || '', tracked.base.to)) || invitations[0];
    };
    const main = await pick(own.filter(({ RecurrenceID }) => !RecurrenceID));
    const edit = rid === undefined ? undefined : await pick(own.filter(({ RecurrenceID }) => Number(RecurrenceID) === rid));
    const cancelled = (invitation: Read) => getIsVeventCancelled(invitation.vevent) || !!getIsEventCancelled(invitation.event as any);
    const titleOf = (invitation: Read) => invitation.vevent.summary?.value || '';
    /** getIsInvitationOutdated (attendee mode): an older SEQUENCE or DTSTAMP than the stored one. */
    const outdated = (invitation: Read) => {
        const storedStamp = dtstampOf(invitation.vevent);
        return (
            sequence < sequenceOf(invitation.vevent) ||
            (emailStamp !== undefined && storedStamp !== undefined && emailStamp < storedStamp)
        );
    };

    if (method === ICAL_METHOD.CANCEL) {
        const target = rid === undefined ? main : edit || main;
        if (!target) {
            if (rid === undefined && own.length) {
                // Only single occurrences of it are in your calendar (e.g. invited to one of them).
                const invitations = await Promise.all(own.map(read));
                return invitations.every(cancelled)
                    ? done('the meeting is cancelled in your calendar', titleOf(invitations[0]))
                    : waiting('waiting for Proton to cancel it in your calendar', titleOf(invitations[0]));
            }
            return goneAt !== undefined && !all.length
                ? done('the meeting was deleted from your calendar')
                : left('the meeting is not in your calendars (nothing to cancel)');
        }
        const title = titleOf(target);
        if (rid !== undefined && !edit) {
            // One occurrence, and only the series is in your calendar.
            if (cancelled(target)) {
                return done('the meeting is cancelled in your calendar', title);
            }
            if (!isOccurrenceOf(recurrenceId, target.vevent)) {
                return done('the occurrence is no longer in your calendar', title);
            }
            return waiting('waiting for Proton to cancel the occurrence in your calendar', title);
        }
        if (outdated(target)) {
            return done('a newer version of the meeting is in your calendar', title);
        }
        if (cancelled(target)) {
            return done('the meeting is cancelled in your calendar', title);
        }
        return waiting('waiting for Proton to cancel it in your calendar', title);
    }

    // REQUEST: an invitation or an update.
    if (rid !== undefined && !edit && main) {
        // A changed occurrence, and only the series is in your calendar.
        const title = titleOf(main);
        const parentStamp = dtstampOf(main.vevent);
        if (cancelled(main)) {
            // Older than the cancellation: no longer matters; otherwise Proton Mail offers to answer it again.
            return emailStamp !== undefined && parentStamp !== undefined && emailStamp < parentStamp
                ? done('the meeting was cancelled after this email', title)
                : waiting('a cancelled meeting is offered again: waiting for your answer', title);
        }
        if (!isOccurrenceOf(recurrenceId, main.vevent)) {
            return done('this occurrence is no longer part of the meeting', title);
        }
        return waiting('waiting for Proton to add the change to your calendar', title);
    }
    const target = rid === undefined ? main : edit;
    if (!target) {
        if (goneAt !== undefined && tracked.time <= goneAt && !all.length) {
            return done('you removed the meeting from your calendar');
        }
        return waiting('not in your calendars (yet)');
    }
    const title = titleOf(target);
    if (outdated(target)) {
        return done('a newer version of the meeting is in your calendar', title);
    }
    if (cancelled(target)) {
        // getIsReinvite: Proton Mail asks for an answer again.
        return waiting('a cancelled meeting is offered again: waiting for your answer', title);
    }
    const self = target.isAttendee && target.selfAttendeeIndex !== undefined ? target.vevent.attendee?.[target.selfAttendeeIndex] : undefined;
    if (!self) {
        return left('you are not on its guest list (e.g. invited through a group address)', title);
    }
    if (sequence > sequenceOf(target.vevent)) {
        return waiting('waiting for Proton to add the update to your calendar', title);
    }
    const storedStamp = dtstampOf(target.vevent);
    if (emailStamp !== undefined && storedStamp !== undefined && emailStamp > storedStamp) {
        // updateEventInvitation: a newer DTSTAMP with a change Proton looks at is applied when opened.
        let changed = true;
        try {
            const selfEmail = getAttendeeEmail(self as any);
            const answering = (vevent.attendee || []).find((attendee) => sameOwnAddress(getAttendeeEmail(attendee as any), selfEmail));
            changed =
                getHasModifiedDateTimes(vevent, target.vevent) ||
                vevent.summary?.value !== target.vevent.summary?.value ||
                vevent.description?.value !== target.vevent.description?.value ||
                vevent.location?.value !== target.vevent.location?.value ||
                !getIsRruleEqual(vevent.rrule, target.vevent.rrule) ||
                getHasModifiedAttendees({
                    veventIcs: vevent,
                    veventApi: target.vevent,
                    attendeeIcs: { emailAddress: answering ? getAttendeeEmail(answering as any) : selfEmail } as any,
                    attendeeApi: { emailAddress: selfEmail } as any,
                });
        } catch {
            // cannot compare: treated as changed (stays)
        }
        if (changed) {
            return waiting('waiting for Proton to add the update to your calendar', title);
        }
    }
    const token = self.parameters?.['x-pm-token'];
    const answer = token ? (target.event.AttendeesInfo?.Attendees || []).find(({ Token }) => Token === token) : undefined;
    const partstat = answer ? toIcsPartstat(answer.Status as any) : self.parameters?.partstat;
    if (!partstat || !ANSWER_LABELS[partstat]) {
        return waiting('waiting for your answer', title);
    }
    return done(`you answered (${ANSWER_LABELS[partstat]})`, title);
};

/** The label to move to: Trash, Archive, or the folder (found, or created unless in a dry run). */
const destinationOf = async (
    ctx: InvitationContext,
    state: CalendarEmailsState,
    { moveTo, folderName }: FileCalendarEmailsInput,
    result: FileCalendarEmailsResult,
    now: number,
    dryRun: boolean
): Promise<{ id: string; name: string; folder?: boolean } | undefined> => {
    if (moveTo === 'trash') {
        return { id: TRASH, name: 'Trash' };
    }
    if (moveTo === 'archive') {
        return { id: ARCHIVE, name: 'Archive' };
    }
    const name = folderNameOf(folderName);
    if (state.folder?.name === name) {
        return { ...state.folder, folder: true };
    }
    if (state.folderFailure?.name === name && now - state.folderFailure.at < FOLDER_RETRY_SECONDS) {
        result.folderError = state.folderFailure.error;
        return undefined;
    }
    try {
        const { Labels = [] } = await ctx.api<{ Labels: any[] }>({ url: 'core/v4/labels', method: 'get', params: { Type: MESSAGE_FOLDER } } as any);
        const topLevel = Labels.filter((label) => !label.ParentID && typeof label.Name === 'string');
        const existing = topLevel.find((label) => label.Name === name) || topLevel.find((label) => label.Name.toLowerCase() === name.toLowerCase());
        if (existing) {
            state.folder = { name, id: existing.ID };
            return { ...state.folder, folder: true };
        }
        if (dryRun) {
            return { id: '', name, folder: true };
        }
        const { Label } = await ctx.api<{ Label: any }>({
            url: 'core/v4/labels',
            method: 'post',
            data: { Name: name, Color: FOLDER_COLOR, Type: MESSAGE_FOLDER, Notify: 0 },
        } as any);
        if (!Label?.ID) {
            throw new Error('Proton did not return the new folder');
        }
        state.folder = { name, id: Label.ID };
        result.folderCreated = name;
        return { ...state.folder, folder: true };
    } catch (error: any) {
        if (isOutage(error)) {
            throw error;
        }
        state.folderFailure = { name, at: now, error: `the folder "${name}" could not be found or created: ${errorText(error)}` };
        result.folderError = state.folderFailure.error;
        return undefined;
    }
};

/**
 * Looks at the emails about meetings in your Inbox and moves those that are dealt with to the Bin,
 * the Archive or a folder. Respects the email policy's dry run (nothing moved, emails reported).
 */
export const fileCalendarEmails = async (
    ctx: InvitationContext,
    state: CalendarEmailsState,
    input: FileCalendarEmailsInput
): Promise<FileCalendarEmailsResult> => {
    const { lookbackDays = 30, maxPages = 3, maxOpened = 25, maxChecks = 40, budgetMs = 20_000 } = input;
    const result: FileCalendarEmailsResult = { filed: [], left: [], waiting: 0, leftCount: 0, wouldMove: 0, opened: 0, checked: 0 };
    const startedAt = Date.now();
    const now = Math.floor(startedAt / 1000);
    const dryRun = ctx.policy.mode === 'dry-run';
    const mode = dryRun ? 'dry-run' : 'live';
    if (state.mode !== mode) {
        for (const tracked of state.emails.values()) {
            tracked.nextCheck = now;
            tracked.listedDryRun = false;
        }
        state.mode = mode;
    }
    const changed = new Set((input.changedUids || []).map(getSupportedUID));
    const gone = new Map((input.goneMeetings || []).map(({ uid, at }) => [getSupportedUID(uid), at] as const));
    const outOfTime = (count: number) => count > 0 && Date.now() - startedAt > budgetMs;
    const failure = state.folderFailure;
    if (input.moveTo === 'folder' && failure?.name === folderNameOf(input.folderName) && now - failure.at < FOLDER_RETRY_SECONDS) {
        result.folderError = failure.error; // still the problem, also in runs that have nothing to move
    }

    // The Inbox: emails with attachments from the last days, newest first (each once).
    const listed = new Map<string, any>();
    let complete = true;
    try {
        for (let Page = 0; Page < maxPages; Page += 1) {
            const { Messages = [] } = await ctx.api<{ Messages: any[] }>(
                messagesWithAttachments({ LabelID: INBOX, Begin: now - lookbackDays * 24 * HOUR, Desc: 1, Page })
            );
            for (const message of Messages) {
                listed.set(message.ID, message);
            }
            if (Messages.length < PAGE_SIZE) {
                break;
            }
            if (Page === maxPages - 1) {
                result.more = true;
                complete = false;
            }
        }
    } catch (error: any) {
        result.error = errorText(error);
        return result;
    }
    // Emails no longer in the Inbox (moved, deleted) are forgotten; with an incomplete listing, those
    // within the listed range.
    const oldestListed = Math.min(...[...listed.values()].map((message) => Number(message.Time) || 0));
    for (const [id, tracked] of state.emails) {
        if (!listed.has(id) && (complete || tracked.time >= oldestListed)) {
            state.emails.delete(id);
        }
    }

    let calendars: Map<string, OwnCalendar> | undefined;
    const lookups = new Map<string, Promise<{ own: CalendarEvent[]; all: CalendarEvent[] }>>();
    const lookup: Lookup = async (uid) => {
        calendars ??= await ownCalendars(ctx);
        const calendarIDs = new Set(calendars.keys());
        if (!lookups.has(uid)) {
            lookups.set(
                uid,
                allEventsByUID(ctx, uid).then((all) => ({ all, own: all.filter(({ CalendarID }) => calendarIDs.has(CalendarID)) }))
            );
        }
        return lookups.get(uid)!;
    };
    const toMove: TrackedEmail[] = [];

    for (const metadata of listed.values()) {
        const labels: string[] = metadata.LabelIDs || [];
        if (!labels.includes(INBOX) || labels.includes(STARRED)) {
            state.emails.delete(metadata.ID); // starred: yours to deal with; looked at again if unstarred
            continue;
        }
        let tracked = state.emails.get(metadata.ID);
        const previous = tracked;
        if (tracked?.reopenAt !== undefined && tracked.reopenAt <= now) {
            tracked = undefined; // could not be read last time: try again
        }
        if (!tracked) {
            const fresh: TrackedEmail = { time: Number(metadata.Time) || 0, base: baseOf(metadata), file: null, nextCheck: now, tries: 0 };
            const candidates = metadata.AttachmentsMetadata;
            const mayHaveCalendar = Array.isArray(candidates) ? candidates.some(isCalendarAttachment) : Number(metadata.NumAttachments) > 0;
            const skip = mayHaveCalendar ? emailSkipReason(metadata) : '';
            if (skip !== undefined) {
                // No calendar file, not received, bounced (silent); or not used (DMARC, phishing, PGP/MIME).
                if (skip) {
                    fresh.filing = { state: 'left', why: skip };
                }
            } else {
                if (result.opened >= maxOpened || outOfTime(result.opened)) {
                    result.more = true; // opened next run
                    continue;
                }
                try {
                    const { Message } = await ctx.api<{ Message: any }>(getMessage(metadata.ID) as any);
                    result.opened += 1;
                    fresh.base = baseOf(Message);
                    const found = await calendarFileOfEmail(ctx, Message);
                    if (found && 'file' in found) {
                        fresh.file = found.file;
                        fresh.kind = kindOf(found.file);
                        fresh.uid = found.file.vevent.uid?.value ? getSupportedUID(found.file.vevent.uid.value) : undefined;
                    } else if (found && 'left' in found) {
                        fresh.filing = { state: 'left', why: found.left };
                    }
                } catch (error: any) {
                    if (isOutage(error)) {
                        result.error = errorText(error);
                        break;
                    }
                    fresh.filing = { state: 'left', why: `the email could not be read (${withoutContent(errorText(error))}); tried again in an hour` };
                    fresh.reopenAt = now + HOUR;
                }
            }
            if (fresh.filing?.state === 'left' && previous?.filing?.why === fresh.filing.why) {
                fresh.reportedLeft = previous.reportedLeft;
            }
            state.emails.set(metadata.ID, fresh);
            tracked = fresh;
        }

        let checkedNow = false;
        if (tracked.file) {
            const goneAt = tracked.uid ? gone.get(tracked.uid) : undefined;
            const due =
                tracked.nextCheck <= now ||
                (!!tracked.uid && changed.has(tracked.uid)) ||
                (goneAt !== undefined && tracked.goneChecked !== goneAt);
            if (due) {
                if (result.checked >= maxChecks || outOfTime(result.checked)) {
                    result.more = true;
                } else {
                    let filing: Filing;
                    try {
                        calendars ??= await ownCalendars(ctx);
                        filing =
                            tracked.file.method === ICAL_METHOD.REPLY || tracked.file.method === ICAL_METHOD.COUNTER
                                ? (await checkReply(ctx, calendars, { Time: tracked.time }, tracked.file, tracked.base, { apply: false, gone })).filing
                                : await checkInvitation(ctx, tracked, gone, lookup);
                        result.checked += 1;
                        checkedNow = true;
                        tracked.goneChecked = goneAt;
                    } catch (error: any) {
                        if (isOutage(error)) {
                            result.error = errorText(error);
                            break;
                        }
                        filing = { state: 'left', why: `could not be checked (${withoutContent(errorText(error))}); tried again in an hour` };
                    }
                    if (filing.state === 'waiting' || filing.state === 'done') {
                        // Done ones are moved now; one not moved (dry run, refused) is checked again later.
                        tracked.nextCheck = now + WAITING_BACKOFF_SECONDS[Math.min(tracked.tries, WAITING_BACKOFF_SECONDS.length - 1)];
                        tracked.tries += 1;
                    } else if (filing.state === 'left') {
                        // Things change (the meeting may be cancelled later): looked at again hourly.
                        tracked.nextCheck = now + HOUR;
                        if (tracked.filing?.state !== 'left' || tracked.filing.why !== filing.why) {
                            tracked.reportedLeft = false;
                        }
                    }
                    tracked.filing = filing;
                }
            }
        }

        const filing = tracked.filing;
        if (!filing) {
            if (tracked.file) {
                result.waiting += 1; // not checked yet
            }
            continue;
        }
        if (filing.state === 'done') {
            if (checkedNow) {
                toMove.push(tracked);
            } else if (dryRun) {
                result.wouldMove += 1;
            } else {
                result.waiting += 1; // checked again (and moved) at its next check
            }
        } else if (filing.state === 'waiting') {
            result.waiting += 1;
        } else {
            result.leftCount += 1;
            if (!tracked.reportedLeft) {
                tracked.reportedLeft = true;
                result.left.push({
                    messageId: tracked.base.messageId,
                    from: tracked.base.from,
                    subject: tracked.base.subject,
                    kind: tracked.kind,
                    eventTitle: filing.title || undefined,
                    why: filing.why,
                    ...(filing.note ? { note: filing.note } : {}),
                });
            }
        }
    }

    if (result.error) {
        // An outage stops the run before anything is moved; what was found dealt with is moved next run.
        toMove.forEach((tracked) => {
            tracked.nextCheck = now;
        });
        return result;
    }
    if (!toMove.length) {
        return result;
    }
    const filedOf = (tracked: TrackedEmail, destination: string, outcome: FiledEmail['outcome'], error?: string): FiledEmail => ({
        ...tracked.base,
        kind: tracked.kind || 'answer',
        eventTitle: tracked.filing?.title || undefined,
        why: tracked.filing?.why || '',
        destination,
        outcome,
        ...(error ? { error } : {}),
    });
    try {
        const destination = await destinationOf(ctx, state, input, result, now, dryRun);
        if (!destination) {
            result.waiting += toMove.length;
            return result;
        }
        if (dryRun) {
            result.wouldMove += toMove.length;
            for (const tracked of toMove) {
                if (!tracked.listedDryRun) {
                    tracked.listedDryRun = true;
                    result.filed.push(filedOf(tracked, destination.name, 'dry-run'));
                }
            }
            return result;
        }
        let failed = false;
        for (let index = 0; index < toMove.length; index += MOVE_CHUNK_SIZE) {
            // Right before moving: still in the Inbox and not starred (the user may have just acted).
            const chunk: TrackedEmail[] = [];
            for (const tracked of toMove.slice(index, index + MOVE_CHUNK_SIZE)) {
                let labels: string[] | undefined;
                try {
                    const { Message } = await ctx.api<{ Message: any }>(getMessage(tracked.base.messageId) as any);
                    labels = Message?.LabelIDs || [];
                } catch (error: any) {
                    if (isOutage(error)) {
                        throw error;
                    }
                }
                if (labels?.includes(INBOX) && !labels.includes(STARRED)) {
                    chunk.push(tracked);
                } else {
                    state.emails.delete(tracked.base.messageId); // gone, moved or starred meanwhile: left alone
                }
            }
            if (!chunk.length) {
                continue;
            }
            const response = await ctx.api<{ Responses?: any[] }>({
                ...labelMessages({ LabelID: destination.id, IDs: chunk.map(({ base }) => base.messageId) }),
                silence: true,
            } as any);
            for (const tracked of chunk) {
                const entry = (response?.Responses || []).find((item: any) => item?.ID === tracked.base.messageId);
                const code = Number(entry?.Response?.Code);
                if (code === 1000) {
                    state.emails.delete(tracked.base.messageId);
                    result.filed.push(filedOf(tracked, destination.name, 'moved'));
                } else {
                    failed = true;
                    const error = entry?.Response?.Error || (entry ? `Proton answered ${code}` : 'Proton did not confirm the move');
                    result.filed.push(filedOf(tracked, destination.name, 'failed', error));
                }
            }
        }
        if (failed && destination.folder) {
            state.folder = undefined; // maybe deleted or renamed meanwhile: looked up again next run
        }
    } catch (error: any) {
        if (Number(error?.data?.Code) === 2501) {
            state.folder = undefined; // the folder was deleted meanwhile: found or created again next run
        }
        result.error = errorText(error);
    }
    return result;
};
