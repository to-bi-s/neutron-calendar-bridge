/**
 * Answers that guests outside Proton send by email (invitations, stage 4).
 *
 * Proton applies such an answer to the organizer's event only when the reply email is opened in
 * Proton's own mail app (it renders the .ics and calls updateAttendeePartstat). Read in another
 * mail app (e.g. through Proton Mail Bridge), the answer never reaches the calendar. This module
 * does what Proton Mail does on opening, for the replies that arrived since the last run:
 *
 * - which emails: received mail with a calendar attachment (ExtraEvents.tsx: filterAttachmentsForEvents,
 *   by file name; text/calendar first), not bounced, decrypted with the receiving address's keys
 *   (attachmentLoader.ts getDecryptedAttachment), parsed with Proton's recovery parser and the basic
 *   checks of getSupportedEventInvitation (method, calendar scale, VEVENT, start time, UID);
 * - which answers: METHOD:REPLY, or COUNTER carrying yes/maybe/no (updateEventInvitation), sent to
 *   the meeting's organizer address (getIsOrganizerMode: ORGANIZER = X-Original-To), not a
 *   Proton-to-Proton reply (X-PM-PROTON-REPLY, getIsProtonInvite: Proton guests answer directly);
 *   the answer is read like Proton (getAttendeePartstat, including Yahoo's X-YAHOO-USER-STATUS);
 * - whose answer: the email's sender's (processEventInvitation). Proton Mail matches the sender
 *   loosely (findAttendee treats every address like a Proton one: dots, dashes and +tags ignored),
 *   which is fine with a person looking at the email. Applied unattended, it is stricter: the
 *   guest's stored answer is found by its token, sha1(UID + canonical address) with the sender's
 *   canonical address from Proton's server (what Proton Calendar used when adding the guest) or
 *   Proton's guess (getIsPartyCrasher), and that guest's address, and the reply's answering
 *   ATTENDEE, must be the sender's mailbox: equal ignoring case, or by canonicalizeEmailByGuess
 *   (dots / +tags only where the provider ignores them, e.g. Gmail). A sender that only matches
 *   loosely is reported, not applied;
 * - when not: the event is cancelled, in a disabled calendar or one that needs attention in Proton
 *   (calendarNeedsUserAction), the answer is for an older or newer version (SEQUENCE:
 *   getIsInvitationOutdated / getIsInvitationFromFuture), older than the answer Proton has (DTSTAMP
 *   vs the guest's UpdateTime), or for a single occurrence (RECURRENCE-ID: "Replies to single edits
 *   not supported");
 * - how: updateAttendeePartstat with Status and UpdateTime = the reply's DTSTAMP (getSupportedDtstamp,
 *   updateEventApi). DTSTAMP missing → the email's time; Yahoo (X-YAHOO-*) → the email's time
 *   (Proton's workaround). Not later than the email's arrival (a DTSTAMP in the future would make
 *   the guest's real later answers look older).
 *
 * Read-only on the mailbox: nothing is sent, marked, moved or deleted (GET only; reading a message
 * does not mark it as read, Proton's apps do that with a separate request). Moving emails that are
 * dealt with out of the Inbox is calendar-emails.ts's job, which reuses the checks below. Stricter than Proton
 * Mail: emails in spam or trash, failing DMARC or flagged as phishing or suspicious are not used;
 * PGP/MIME-encrypted emails (attachments inside the encrypted body) are skipped.
 *
 * Sources (Proton WebClients, commit 464c1b060): applications/mail/src/app/components/message/
 * extrasHeader/components/ExtraEvents.tsx; applications/mail/src/app/helpers/calendar/invite.ts and
 * inviteApi.ts; applications/mail/src/app/helpers/attachment/attachmentLoader.ts;
 * packages/shared/lib/calendar/mailIntegration/invite.ts (findAttendee); packages/shared/lib/
 * calendar/icsSurgery/vevent.ts (getSupportedDtstamp); packages/shared/lib/calendar/calendar.ts.
 */
import './polyfill';
import { CryptoProxy } from '@protontech/crypto';
import { getCanonicalAddresses } from '@proton/shared/lib/api/addresses';
import { getEventByUID, queryCalendars, updateAttendeePartstat } from '@proton/shared/lib/api/calendars';
import { getMessage, queryMessageMetadata } from '@proton/shared/lib/api/messages';
import { generateAttendeeToken, getAttendeeEmail, toApiPartstat } from '@proton/shared/lib/calendar/attendees';
import { getSupportedUID } from '@proton/shared/lib/calendar/helper';
import { ICAL_ATTENDEE_STATUS, ICAL_METHOD } from '@proton/shared/lib/calendar/constants';
import { getSupportedCalscale } from '@proton/shared/lib/calendar/icsSurgery/vcal';
import { findAttendee } from '@proton/shared/lib/calendar/mailIntegration/invite';
import { parseVcalendarWithRecoveryAndMaybeErrors } from '@proton/shared/lib/calendar/vcal';
import {
    getAttendeePartstat,
    getHasDtStart,
    getIcalMethod,
    getIsProtonReply,
    getVcalendarHasNoErrorComponents,
} from '@proton/shared/lib/calendar/vcalHelper';
import { propertyToUTCDate } from '@proton/shared/lib/calendar/vcalConverter';
import { getIsEventCancelled } from '@proton/shared/lib/calendar/veventHelper';
import { getSupportedTimezone } from '@proton/shared/lib/date/timezone';
import { canonicalizeEmailByGuess, canonicalizeInternalEmail } from '@proton/shared/lib/helpers/email';
import type { CalendarEvent, VcalVeventComponent } from '@proton/shared/lib/interfaces/calendar';
import { MESSAGE_FLAGS } from '@proton/shared/lib/mail/constants';
import { getSessionKey } from '@proton/shared/lib/mail/send/attachments';

import { InvitationActionError, completeAttendeesInfo, errorText, readInvitation } from './invitations';
import type { InvitationContext } from './invitations';

export type EmailedAnswerValue = 'ACCEPTED' | 'TENTATIVE' | 'DECLINED' | 'NEEDS-ACTION';

/** One answer email that was looked at: applied, only reported (dry run), or skipped with a reason. */
export interface EmailedAnswer {
    messageId: string;
    /** When the email arrived (ISO). */
    receivedAt: string;
    /** The guest (the email's sender). */
    from: string;
    /** Your address it was sent to. */
    to: string;
    subject: string;
    outcome: 'applied' | 'dry-run' | 'skipped';
    reason?: string;
    answer?: EmailedAnswerValue;
    eventUid?: string;
    eventTitle?: string;
    calendarID?: string;
    eventID?: string;
    /** 0.41 (bridge): the guest's note with the answer (COMMENT, or Google's X-RESPONSE-COMMENT), if any. */
    comment?: string;
}

export interface ApplyEmailedAnswersInput {
    /** Emails that arrived at or after this time (Unix seconds) are looked at. */
    since: number;
    /** At most this many list requests of 100 emails per run (default 5); the cursor continues next time. */
    maxPages?: number;
    /** At most this many emails opened per run (default 25), so a sync is not held up. */
    maxOpened?: number;
    /** Stop opening emails after this long (default 20 s; at least one per run); the rest is read next run. */
    budgetMs?: number;
    /**
     * 0.41 (bridge): Message-IDs of invitation emails this account sent. A reply in Spam is used only
     * when it answers one of them (In-Reply-To / References), with every other check as usual.
     */
    repliesTo?: string[];
    /**
     * 0.41 (bridge): also look again at emails from this time (Unix seconds) up to `since` — a reply moved
     * out of Spam keeps its arrival time, which is behind the cursor. The cursor does not move for them.
     */
    lookBackFrom?: number;
}

/** An email with a calendar file that is none of this feature's business, and why (for logs only). */
export interface IgnoredEmail {
    messageId: string;
    from: string;
    subject: string;
    why: string;
}

export interface ApplyEmailedAnswersResult {
    answers: EmailedAnswer[];
    /** Opened emails that held no answer to apply or report (an invitation, Proton already has it, ...). */
    ignored: IgnoredEmail[];
    /** Arrival time (Unix seconds) up to which every email was handled: pass it as `since` next time. */
    cursor: number;
    /** Emails with a calendar attachment that were opened in this run. */
    opened: number;
    /** The run stopped at a limit (pages, emails, time) with more to read: the next run continues. */
    more?: boolean;
    /** Set when the run stopped early (network, Proton); the cursor stops before that email. */
    error?: string;
}

// MAILBOX_LABEL_IDS.ALMOST_ALL_MAIL: all mail except spam and trash.
const ALMOST_ALL_MAIL = '15';
const TRASH = '3';
const SPAM = '4';
export const PAGE_SIZE = 100;
// calendar/constants.ts ICAL_EXTENSIONS / ICAL_MIME_TYPE
const ICAL_EXTENSIONS = ['ics', 'ical', 'ifb', 'icalendar'];
export const ICAL_MIME_TYPE = 'text/calendar';
// calendar/constants.ts CALENDAR_TYPE.PERSONAL and CALENDAR_FLAGS
const CALENDAR_TYPE_PERSONAL = 0;
const CALENDAR_FLAG_UPDATE_PASSPHRASE = 2;
const CALENDAR_FLAG_RESET_NEEDED = 4;
const CALENDAR_FLAG_SELF_DISABLED = 32;
const CALENDAR_FLAG_SUPER_OWNER_DISABLED = 64;
const COUNTER_ANSWERS = new Set<string>([ICAL_ATTENDEE_STATUS.ACCEPTED, ICAL_ATTENDEE_STATUS.TENTATIVE, ICAL_ATTENDEE_STATUS.DECLINED]);
const ANSWERS = new Set<string>([...COUNTER_ANSWERS, ICAL_ATTENDEE_STATUS.NEEDS_ACTION]);

/** How long a handled email is remembered within a run of the app (the cursor covers restarts). */
const PROCESSED_MEMORY_SECONDS = 7 * 24 * 3600;
/** An email that failed this many runs (e.g. Proton refuses the update) is skipped, so it cannot block the rest. */
const MAX_FAILED_RUNS = 3;
/** Outages (no connection, Proton busy) stop the run without blaming the email, but not forever. */
const MAX_OUTAGE_RUNS = 20;
const MAX_OUTAGE_SECONDS = 12 * 3600;

/** Kept by the caller across runs. */
export interface EmailedAnswersState {
    /** Emails handled, by message ID, with their arrival time. */
    processed: Map<string, number>;
    /** Failed runs per message ID. */
    failures: Map<string, number>;
    /** Runs stopped by an outage at this email: how many, and since when (Unix seconds). */
    outages?: Map<string, { runs: number; since: number }>;
    /** The email policy's mode of the last run: switching between dry run and live starts over. */
    mode?: 'dry-run' | 'live';
    /**
     * 0.41 (bridge): Spam emails opened and found to answer none of this account's invitations, by message
     * ID (not `processed`: moved out of Spam later, the look-back still reads them).
     */
    spamChecked?: Map<string, number>;
    /** 0.41 (bridge): how far a look-back got (it continues there while `from` stays the same). */
    lookBack?: { from: number; reached: number };
    /** 0.41 (bridge): the same for the Spam pass. */
    spamPass?: { from: number; reached: number };
}

export interface OwnCalendar {
    disabled: boolean;
    needsAttention: boolean;
}

const hasIcalExtension = (name = '') => ICAL_EXTENSIONS.some((extension) => name.toLowerCase().endsWith(`.${extension}`));
/** By file name only, like Proton Mail (filterAttachmentsForEvents). */
export const isCalendarAttachment = ({ Name }: { Name?: string }) => hasIcalExtension(Name);

// Flags go beyond 32 bits (FLAG_SUSPICIOUS is 2^33), so compare as BigInt like Proton's hasBitBigInt.
const hasFlag = (flags: number | undefined, flag: number | bigint) => {
    try {
        return (BigInt(flags || 0) & BigInt(flag)) !== BigInt(0);
    } catch {
        return false;
    }
};

/** messages.ts isBounced */
const isBounced = (message: { Sender?: { Address?: string }; Subject?: string }) => {
    const local = canonicalizeInternalEmail(message.Sender?.Address || '').split('@')[0];
    return local === 'mailerdaemon' && [/delivery/i, /undelivered/i, /returned/i, /failure/i].some((regex) => regex.test(message.Subject || ''));
};

/** messages.ts getOriginalTo: the address the email was delivered to. */
export const originalToOf = (message: any) => {
    const value = message?.ParsedHeaders?.['X-Original-To'];
    return String((Array.isArray(value) ? value[0] : value) || '').trim();
};

/** For your own addresses (Proton ones), where Proton's internal scheme is right. */
export const sameOwnAddress = (a: string, b: string) => !!a && !!b && canonicalizeInternalEmail(a) === canonicalizeInternalEmail(b);

/** invite.ts withOutsideUIDAndSequence: some providers put UID / SEQUENCE outside the VEVENT. */
const withOutsideUIDAndSequence = (vevent: any, vcal: any) => {
    const result = { ...vevent };
    if (!vevent.uid && vcal.uid) {
        result.uid = { ...vcal.uid };
    }
    if (!vevent.sequence && vcal.sequence) {
        result.sequence = { ...vcal.sequence };
    }
    return result as VcalVeventComponent;
};

export const sequenceOf = (vevent: VcalVeventComponent) => Math.max(0, Number(vevent.sequence?.value) || 0);

/**
 * The answer time in Unix seconds: getSupportedDtstamp (a DTSTAMP with a TZID is read in that zone
 * if Proton knows it, else the email's time), Proton's Yahoo workaround (the email's time), and
 * never later than the email's arrival.
 */
const answerTimeOf = (vevent: any, messageTime: number) => {
    const isYahoo = !!(vevent['x-yahoo-yid'] || vevent['x-yahoo-user-status']);
    let time = messageTime;
    const dtstamp = vevent.dtstamp;
    if (!isYahoo && dtstamp?.value) {
        try {
            const tzid = dtstamp.parameters?.tzid;
            const supportedTzid = tzid ? getSupportedTimezone(tzid) : undefined;
            if (!tzid || supportedTzid) {
                const value = dtstamp.value;
                const property = tzid
                    ? {
                          value: {
                              year: value.year,
                              month: value.month,
                              day: value.day,
                              hours: value.hours || 0,
                              minutes: value.minutes || 0,
                              seconds: value.seconds || 0,
                              isUTC: value.isUTC === true,
                          },
                          parameters: { tzid: supportedTzid },
                      }
                    : dtstamp;
                const parsed = Math.floor(+propertyToUTCDate(property) / 1000);
                if (Number.isFinite(parsed) && parsed > 0) {
                    time = parsed;
                }
            }
        } catch {
            // invalid DTSTAMP: the email's time, like Proton
        }
    }
    return messageTime > 0 ? Math.min(time, messageTime) : time;
};

/**
 * Every event with this UID in the personal calendars you can see, yours or shared with you
 * (inviteApi.ts getRelevantEventsByUID). Proton stores at most the last 191 characters of a UID
 * (getSupportedUID).
 */
export const allEventsByUID = async (ctx: InvitationContext, UID: string) => {
    const events: CalendarEvent[] = [];
    for (let Page = 0; Page < 20; Page += 1) {
        const { Events = [] } = await ctx.api<{ Events: CalendarEvent[] }>(
            getEventByUID({ UID: getSupportedUID(UID), Page, PageSize: 100, CalendarType: CALENDAR_TYPE_PERSONAL } as any) as any
        );
        events.push(...Events);
        if (Events.length < 100) {
            break;
        }
    }
    return events;
};

/** Every event with this UID in your own personal calendars. */
export const eventsByUID = async (ctx: InvitationContext, UID: string, calendarIDs: Set<string>) =>
    (await allEventsByUID(ctx, UID)).filter(({ CalendarID }) => calendarIDs.has(CalendarID));

/** A note the guest wrote into the answer (COMMENT, or Google's X-RESPONSE-COMMENT), which Proton does not keep. */
const noteOf = (vevent: any, attendee: any) => {
    const comments = ([] as any[]).concat(vevent?.comment || []).map((entry) => String(entry?.value ?? '').trim());
    const google = String(attendee?.parameters?.['x-response-comment'] ?? '').trim();
    return [...comments, google].some(Boolean);
};

/** Your own personal calendars (the mail app looks in ownedPersonalCalendars), with their state. */
export const ownCalendars = async (ctx: InvitationContext) => {
    const { Calendars = [] } = await ctx.api<{ Calendars: any[] }>(queryCalendars() as any);
    const own = new Map<string, OwnCalendar>();
    for (const calendar of Calendars) {
        const member = calendar.Members?.[0];
        const owned = calendar.Owner?.Email ? calendar.Owner.Email === member?.Email : (Number(member?.Permissions) & 127) === 127;
        if (calendar.Type === CALENDAR_TYPE_PERSONAL && owned) {
            const flags = Number(member?.Flags ?? calendar.Flags) || 0;
            own.set(calendar.ID, {
                // getIsCalendarDisabled
                disabled: (flags & (CALENDAR_FLAG_SELF_DISABLED | CALENDAR_FLAG_SUPER_OWNER_DISABLED)) !== 0,
                // getDoesCalendarNeedUserAction: reset needed, or keys to reactivate
                needsAttention: (flags & (CALENDAR_FLAG_RESET_NEEDED | CALENDAR_FLAG_UPDATE_PASSPHRASE)) !== 0,
            });
        }
    }
    return own;
};

/**
 * Two addresses are the same mailbox: equal ignoring case, or by Proton's guess of the provider's
 * rules (canonicalizeEmailByGuess: dots and +tags only where the provider ignores them, e.g. Gmail).
 */
const sameMailboxForms = (email: string) => new Set([email.toLowerCase(), canonicalizeEmailByGuess(email)]);
export const sameMailbox = (a: string, b: string) => {
    const forms = sameMailboxForms(a);
    return !!a && !!b && [...sameMailboxForms(b)].some((form) => forms.has(form));
};

/** The canonical address Proton's server gives (what Proton Calendar used for the guest's answer token). */
const serverCanonical = async (ctx: InvitationContext, email: string) => {
    const { Responses = [] } = await ctx.api<{ Responses: any[] }>(getCanonicalAddresses([encodeURIComponent(email)]) as any);
    return Responses.find((entry) => entry?.Email === email)?.Response?.CanonicalEmail as string | undefined;
};

/** Downloads and decrypts one attachment with the receiving address's keys. */
export const readAttachment = async (ctx: InvitationContext, message: any, attachment: any) => {
    const privateKeys = ctx.getAddressKeys(message.AddressID).map(({ privateKey }) => privateKey);
    if (!privateKeys.length) {
        throw new InvitationActionError('No keys for the address this email was sent to', 'failed');
    }
    const sessionKey = await getSessionKey(attachment, privateKeys, message.Flags);
    const encrypted: ArrayBuffer = await ctx.api({
        url: `mail/v4/attachments/${attachment.ID}`,
        method: 'get',
        output: 'arrayBuffer',
    } as any);
    const { data } = await CryptoProxy.decryptMessage({
        binaryMessage: new Uint8Array(encrypted),
        sessionKeys: [sessionKey],
        format: 'binary',
    } as any);
    return new TextDecoder().decode(data as Uint8Array);
};

/** No answer from Proton at all (not a bug in this code, which also throws TypeErrors). */
const isNetworkError = (error: any) =>
    error instanceof TypeError && (/^(fetch failed|terminated)$/.test(String(error.message)) || !!(error as any).cause?.code);

/** Download problems (network, Proton) are retried next run; anything else about the file is final. */
export const isTransient = (error: any) => error?.status !== undefined || error instanceof TypeError;

/** No connection, Proton busy or down, the session not accepted: not the email's fault. */
export const isOutage = (error: any) => {
    const status = Number(error?.status);
    return isNetworkError(error) || status === 0 || status === 401 || status === 403 || status === 429 || status >= 500;
};

/** Parser messages quote the offending line; the file's content stays out of reports and logs. */
export const withoutContent = (text: string) => text.replace(/"[^"]*"/g, '"…"').slice(0, 160);

/** The event of a calendar attachment and its method (REPLY, REQUEST, ...). */
export interface CalendarFile {
    method: ICAL_METHOD;
    vevent: VcalVeventComponent;
}
type Reply = CalendarFile;

/**
 * The event in a calendar attachment with the checks Proton's getSupportedEventInvitation makes
 * before anything else: `none` (with the method) when its method is not one of `methods`, `refused`
 * with a reason when Proton would refuse the file. `what` names it in reasons ("the answer has no event").
 */
export const calendarFileOf = (
    ics: string,
    methods: ICAL_METHOD[],
    what = 'calendar file'
): CalendarFile | { refused: string } | { none: string } => {
    const vcal: any = parseVcalendarWithRecoveryAndMaybeErrors(ics);
    const method = getIcalMethod(vcal?.method);
    if (!method || !methods.includes(method)) {
        return { none: `METHOD:${String(vcal?.method?.value || 'none').toUpperCase()}` };
    }
    if (!getVcalendarHasNoErrorComponents(vcal)) {
        return { refused: 'the calendar file has parts that cannot be read' };
    }
    if (!getSupportedCalscale(vcal.calscale)) {
        return { refused: `the ${what} uses a calendar other than the Gregorian one` };
    }
    const first: any = (vcal.components || []).find((component: any) => component?.component === 'vevent');
    if (!first) {
        return { refused: `the ${what} has no event` };
    }
    if (!getHasDtStart(first)) {
        return { refused: `the ${what} has no start time` };
    }
    return { method, vevent: withOutsideUIDAndSequence(first, vcal) };
};

/**
 * The answer in a calendar attachment, if it is one (REPLY, or COUNTER), with the checks Proton's
 * getSupportedEventInvitation makes before anything else; a reason when it is a reply Proton would
 * refuse.
 */
const replyOf = (ics: string): Reply | { refused: string } | { ignored: string } => {
    const file = calendarFileOf(ics, [ICAL_METHOD.REPLY, ICAL_METHOD.COUNTER], 'answer');
    return 'none' in file ? { ignored: `not an answer (${file.none})` } : file;
};

/**
 * Whether an email about a meeting is dealt with (calendar-emails.ts moves those out of the Inbox):
 * `done` (its content is in Proton, or it no longer matters), `waiting` (for Proton or for you), or
 * `left` (the bridge cannot tell; stays in the Inbox for you to look at).
 */
export interface Filing {
    state: 'done' | 'waiting' | 'left';
    why: string;
    /** The meeting's title, when known. */
    title?: string;
    /** 0.41.10 (bridge): the guest's note with the answer, when that is what keeps the email. */
    note?: string;
}

export interface ReplyCheck {
    /** For applyEmailedAnswers: the answer (applied, dry run, skipped), or why the email is ignored. */
    result: EmailedAnswer | string;
    filing: Filing;
}

/**
 * One reply: applied, reported (dry run), skipped with a reason, or a string when it is none of
 * applyEmailedAnswers' business; plus whether the email is dealt with. With `apply: false` nothing
 * is written: an answer Proton does not have yet is `waiting` (Proton records it by itself), and
 * Proton guests' replies are checked too (Proton records those directly).
 */
export const checkReply = async (
    ctx: InvitationContext,
    calendars: Map<string, OwnCalendar>,
    message: { Time?: number },
    { method, vevent }: Reply,
    base: Omit<EmailedAnswer, 'outcome'>,
    { apply, gone }: { apply: boolean; gone?: Map<string, number> }
): Promise<ReplyCheck> => {
    const sender = base.from;
    const originalTo = base.to;
    const skip = (reason: string, extra: Partial<EmailedAnswer> = {}): EmailedAnswer => ({ ...base, ...extra, outcome: 'skipped', reason });
    const whyOf = (result: EmailedAnswer | string) => (typeof result === 'string' ? result : result.reason || '');
    let note: string | undefined;
    const left = (result: EmailedAnswer | string, title?: string, why = whyOf(result)): ReplyCheck => ({ result, filing: { state: 'left', why, title, ...(note ? { note } : {}) } });
    // What only this email holds (a proposed time, a note) keeps it in the Inbox, even once the answer is in Proton.
    let onlyInEmail: string | undefined;
    const done = (result: EmailedAnswer | string, why: string, title?: string): ReplyCheck =>
        onlyInEmail ? left(result, title, onlyInEmail) : { result, filing: { state: 'done', why, title } };

    // getSupportedEventInvitation: without ORGANIZER, a reply's organizer is the address it was sent to.
    const organizer = vevent.organizer ? getAttendeeEmail(vevent.organizer as any) : originalTo;
    if (!sameOwnAddress(organizer, originalTo) || !ctx.addresses.some(({ Email }) => sameOwnAddress(Email, originalTo))) {
        // not a reply to a meeting organized from this address (getIsOrganizerMode)
        return left(`not addressed to the organizer of a meeting of yours (organizer ${organizer || '?'}, sent to ${originalTo})`);
    }
    const isProtonReply = getIsProtonReply(vevent);
    if (isProtonReply && apply) {
        return left('a Proton guest\'s answer (Proton records it directly)');
    }
    const uid = vevent.uid?.value;
    if (!uid) {
        return left(skip('the answer has no UID'));
    }

    // The sender's own answer in the reply (strict; see the header).
    const replyAttendees = vevent.attendee || [];
    const answerIcs = replyAttendees.find((attendee) => sameMailbox(getAttendeeEmail(attendee as any), sender));
    if (!answerIcs) {
        const loose = findAttendee(sender, replyAttendees).attendee;
        return left(
            skip(
                loose
                    ? `the sender only loosely matches the address that answers (${getAttendeeEmail(loose as any)}); open the reply in Proton Mail to apply it`
                    : 'it is not the sender\'s own answer',
                { eventUid: uid }
            )
        );
    }
    const partstat = getAttendeePartstat(answerIcs, (vevent as any)['x-yahoo-user-status']?.value);
    if (method === ICAL_METHOD.COUNTER) {
        onlyInEmail = 'it proposes another time, which Proton does not keep';
    } else if (noteOf(vevent, answerIcs)) {
        onlyInEmail = 'the guest added a note, which Proton does not keep';
        note = replyCommentOf({ ...vevent, attendee: [answerIcs] });
    }
    if (method === ICAL_METHOD.COUNTER && !COUNTER_ANSWERS.has(partstat)) {
        return left('a counter-proposal without an answer (only COUNTER with yes/maybe/no counts)');
    }
    if (!ANSWERS.has(partstat)) {
        return left(skip(`the answer is "${partstat}", which Proton does not support`, { eventUid: uid }));
    }
    const answer = partstat as EmailedAnswerValue;
    const found = (await eventsByUID(ctx, uid, new Set(calendars.keys()))).find(({ RecurrenceID }) => !RecurrenceID);
    if (!found) {
        // Deleted meanwhile (e.g. a guest's calendar declining a cancelled meeting), or not yours: nothing to do.
        // Dealt with only when the meeting is known to have been deleted (it may be organized elsewhere).
        const result = 'no meeting with this UID in your calendars (deleted, or not yours)';
        return gone?.has(getSupportedUID(uid)) && !(await allEventsByUID(ctx, uid)).length
            ? done(result, 'the meeting was deleted from your calendar')
            : left(result, undefined, 'the meeting is not in your calendars');
    }
    const event = await completeAttendeesInfo(ctx.api, found);
    const read = await readInvitation(ctx, event);
    const title = read.vevent.summary?.value || '';
    const about = {
        eventUid: uid,
        answer,
        eventTitle: title,
        calendarID: event.CalendarID,
        eventID: event.ID,
    };
    const eventOrganizer = read.vevent.organizer ? getAttendeeEmail(read.vevent.organizer as any) : '';
    if (!read.isOrganizer || !sameOwnAddress(eventOrganizer, originalTo)) {
        return left(skip('it is not for a meeting you organize from this address', about), title);
    }
    if (vevent['recurrence-id']) {
        return left(skip('answers to a single occurrence are not applied (Proton does not apply them either)', about), title);
    }
    const calendar = calendars.get(event.CalendarID);
    if (calendar?.disabled) {
        return left(skip('the meeting\'s calendar is disabled', about), title);
    }
    if (calendar?.needsAttention) {
        return left(skip('the meeting\'s calendar needs attention in Proton (reset or reactivate its keys); open the reply in Proton Mail once that is done', about), title);
    }
    if (getIsEventCancelled(event as any) || String(read.vevent.status?.value || '').toUpperCase() === 'CANCELLED') {
        return done(skip('the meeting is cancelled', about), 'the meeting is cancelled', title);
    }

    // The guest: the stored answer whose token is the sender's (Proton's identity for guests).
    const eventUid = read.vevent.uid?.value || event.UID;
    const senderForms = new Set([await serverCanonical(ctx, sender), ...sameMailboxForms(sender)].filter(Boolean) as string[]);
    const senderTokens = new Set(await Promise.all([...senderForms].map((form) => generateAttendeeToken(form, eventUid))));
    const matches = (event.AttendeesInfo?.Attendees || []).filter(({ Token }) => senderTokens.has(Token));
    if (matches.length > 1) {
        return left(skip('the sender matches more than one guest of this meeting', about), title);
    }
    const stored: any = matches[0];
    // The guest behind that answer must be the sender's own mailbox, whatever Proton's server
    // considers the same address.
    const guest = stored && (read.vevent.attendee || []).find((attendee) => attendee.parameters?.['x-pm-token'] === stored.Token);
    if (!stored || !guest || !sameMailbox(getAttendeeEmail(guest as any), sender)) {
        const loose = findAttendee(sender, read.vevent.attendee || []).attendee;
        return left(
            skip(
                loose
                    ? `the sender only loosely matches the guest ${getAttendeeEmail(loose as any)}; open the reply in Proton Mail to apply it`
                    : 'the sender is not a guest of this meeting',
                about
            ),
            title
        );
    }

    const sequenceDiff = sequenceOf(vevent) - sequenceOf(read.vevent);
    if (sequenceDiff < 0) {
        return done(skip('the answer is for an older version of the meeting', about), 'the answer is for an older version of the meeting', title);
    }
    if (sequenceDiff > 0) {
        return left(skip('the answer is for a newer version of the meeting than Proton has', about), title);
    }
    const updateTime = answerTimeOf(vevent, Number(message.Time) || 0);
    const storedTime = Number(stored.UpdateTime) || 0;
    if (storedTime && updateTime <= storedTime) {
        const result = 'Proton already has this answer or a newer one (e.g. the reply was opened in Proton Mail)';
        // The email is the only record of what it says: dealt with when Proton has the same answer,
        // or one recorded after the email arrived; not when the email's time merely looks older.
        return Number(stored.Status) === toApiPartstat(answer) || storedTime >= (Number(message.Time) || 0)
            ? done(result, 'Proton has this answer, or a newer one from this guest', title)
            : left(result, title, 'Proton has another answer from this guest with the same or a later time stamp; check this email');
    }
    const waiting: Filing = { state: 'waiting', why: 'waiting for Proton to record the answer', title };
    if (!apply) {
        return { result: 'not applied (only checked)', filing: waiting };
    }
    if (ctx.policy.mode === 'dry-run') {
        return { result: { ...base, ...about, outcome: 'dry-run', reason: 'dry run: not applied' }, filing: waiting };
    }
    await ctx.api({
        ...updateAttendeePartstat(event.CalendarID, event.ID, stored.ID, {
            Status: toApiPartstat(answer),
            UpdateTime: updateTime,
        } as any),
        silence: true,
    } as any);
    return done({ ...base, ...about, outcome: 'applied' }, 'the bridge applied this answer', title);
};

/** The checks on the email itself; a reason to skip it, '' to stay silent, or undefined to go on. */
export const emailSkipReason = (message: any, { spamAllowed = false }: { spamAllowed?: boolean } = {}): string | undefined => {
    if (!hasFlag(message.Flags, MESSAGE_FLAGS.FLAG_RECEIVED) || isBounced(message)) {
        return '';
    }
    const labels: string[] = message.LabelIDs || [];
    if (labels.includes(TRASH) || (labels.includes(SPAM) && !spamAllowed)) {
        return '';
    }
    if (hasFlag(message.Flags, MESSAGE_FLAGS.FLAG_DMARC_FAIL)) {
        return 'the sender could not be verified (DMARC failed)';
    }
    if (hasFlag(message.Flags, MESSAGE_FLAGS.FLAG_PHISHING_AUTO) || hasFlag(message.Flags, MESSAGE_FLAGS.FLAG_SUSPICIOUS)) {
        return 'Proton marked the email as phishing or suspicious';
    }
    if (String(message.MIMEType || '').toLowerCase() === 'multipart/mixed') {
        return 'PGP/MIME-encrypted emails are not read';
    }
    return undefined;
};

export const baseOf = (message: any) => ({
    messageId: message.ID,
    receivedAt: new Date((Number(message.Time) || 0) * 1000).toISOString(),
    from: String(message.Sender?.Address || ''),
    to: originalToOf(message),
    subject: String(message.Subject || ''),
});

/** All answers in one email (one per calendar attachment that is one). */
const answersInEmail = async (
    ctx: InvitationContext,
    calendars: Map<string, OwnCalendar>,
    message: any,
    ignored: IgnoredEmail[],
    { spamAllowed = false }: { spamAllowed?: boolean } = {}
): Promise<EmailedAnswer[]> => {
    const base = baseOf(message);
    const ignore = (why: string) => ignored.push({ messageId: base.messageId, from: base.from, subject: base.subject, why });
    const reason = emailSkipReason(message, { spamAllowed });
    if (reason !== undefined) {
        return reason ? [{ ...base, outcome: 'skipped', reason }] : [];
    }
    if (!base.to) {
        return [{ ...base, outcome: 'skipped', reason: 'the email does not say which of your addresses it was sent to' }];
    }
    // ExtraEvents: text/calendar attachments first.
    const isTextCalendar = (attachment: any) => String(attachment.MIMEType || '').toLowerCase().startsWith(ICAL_MIME_TYPE);
    const attachments = (message.Attachments || [])
        .filter(isCalendarAttachment)
        .sort((a: any, b: any) => Number(isTextCalendar(b)) - Number(isTextCalendar(a)));
    const results: EmailedAnswer[] = [];
    const seenUids = new Set<string>();
    for (const attachment of attachments) {
        let reply: ReturnType<typeof replyOf>;
        try {
            reply = replyOf(await readAttachment(ctx, message, attachment));
        } catch (error: any) {
            if (isTransient(error)) {
                throw error;
            }
            results.push({ ...base, outcome: 'skipped', reason: `the calendar file could not be read (${withoutContent(errorText(error))})` });
            continue;
        }
        if ('ignored' in reply) {
            ignore(reply.ignored); // an invitation, a cancellation, ...
            continue;
        }
        if ('refused' in reply) {
            results.push({ ...base, outcome: 'skipped', reason: reply.refused });
            continue;
        }
        const answer: Reply = reply;
        const uid = answer.vevent.uid?.value;
        if (uid && seenUids.has(uid)) {
            continue; // the same answer again (e.g. invite.ics next to a text/calendar part)
        }
        if (uid) {
            seenUids.add(uid);
        }
        const { result } = await checkReply(ctx, calendars, message, answer, base, { apply: true });
        if (typeof result === 'string') {
            ignore(result);
        } else {
            const comment = replyCommentOf(answer.vevent);
            results.push(comment ? { ...result, comment } : result);
        }
    }
    return results;
};

const textValues = (property: any): string[] =>
    (Array.isArray(property) ? property : property ? [property] : []).map((entry: any) => String(entry?.value ?? '').trim()).filter(Boolean);

/**
 * 0.41 (bridge): the guest's note with an answer: the VEVENT's COMMENT (RFC 5546; Outlook, Apple) or
 * the answering ATTENDEE's X-RESPONSE-COMMENT parameter (Google). At most 500 characters.
 */
export const replyCommentOf = (vevent: any): string | undefined => {
    const fromAttendees = (Array.isArray(vevent?.attendee) ? vevent.attendee : vevent?.attendee ? [vevent.attendee] : [])
        .map((attendee: any) => {
            const parameters = attendee?.parameters || {};
            const key = Object.keys(parameters).find((name) => name.toLowerCase() === 'x-response-comment');
            return key ? String(parameters[key] ?? '').trim() : '';
        })
        .filter(Boolean);
    const text = [...textValues(vevent?.comment), ...fromAttendees].join('\n').trim();
    return text ? (text.length > 500 ? `${text.slice(0, 499)}…` : text) : undefined;
};

/** Message-IDs without angle brackets, lower case. */
const messageIdsIn = (value: unknown): string[] =>
    (Array.isArray(value) ? value : [value])
        .flatMap((entry) => String(entry ?? '').match(/<[^<>\s]+>|[^<>\s,]+@[^<>\s,]+/g) ?? [])
        .map((id) => id.replace(/^<|>$/g, '').toLowerCase());

/** 0.41 (bridge): whether an email answers one of the given Message-IDs (In-Reply-To or References). */
export const answersOneOf = (message: any, ids: Set<string>) => {
    const headers = message?.ParsedHeaders || {};
    return [...messageIdsIn(headers['In-Reply-To']), ...messageIdsIn(headers.References)].some((id) => ids.has(id));
};

/** A message list request (emails with attachments in one label from `Begin`). */
export const messagesWithAttachments = ({ LabelID, Begin, Desc, Page }: { LabelID: string; Begin: number; Desc: 0 | 1; Page: number }) => {
    const request: any = queryMessageMetadata({
        LabelID,
        Begin,
        Attachments: 1,
        Sort: 'Time',
        Desc,
        Page,
        PageSize: PAGE_SIZE,
    } as any);
    // Empty filters (e.g. NewsletterSubscriptionID: []) are left out, as Proton's own api does.
    request.params = Object.fromEntries(
        Object.entries(request.params).filter(([, value]) => value !== undefined && !(Array.isArray(value) && !value.length))
    );
    return request;
};

/** Received emails with attachments in a label (default: all but spam and trash) from `begin`, oldest first. */
const messagesFrom = (begin: number, Page: number, LabelID = ALMOST_ALL_MAIL) => messagesWithAttachments({ LabelID, Begin: begin, Desc: 0, Page });

class StopRun extends Error {}

/**
 * Looks at the emails with a calendar attachment that arrived since `since` and applies the answers
 * of guests outside Proton to meetings you organize, like Proton Mail does when you open them.
 * Respects the email policy's dry run (nothing changed, answers reported).
 */
export const applyEmailedAnswers = async (
    ctx: InvitationContext,
    state: EmailedAnswersState,
    input: ApplyEmailedAnswersInput
): Promise<ApplyEmailedAnswersResult> => {
    const { since, maxPages = 5, maxOpened = 25, budgetMs = 20_000 } = input;
    const { processed, failures } = state;
    const outages = (state.outages ??= new Map());
    const result: ApplyEmailedAnswersResult = { answers: [], ignored: [], cursor: since, opened: 0 };
    const startedAt = Date.now();
    const now = Math.floor(startedAt / 1000);
    // Answers only reported in a dry run are applied once it is switched off (the caller passes the
    // cursor from before the dry run again), so what a dry run handled is forgotten on the switch.
    const mode = ctx.policy.mode === 'dry-run' ? 'dry-run' : 'live';
    if (state.mode !== mode) {
        processed.clear();
        failures.clear();
        outages.clear();
        state.spamChecked?.clear();
        state.lookBack = undefined;
        state.spamPass = undefined;
        state.mode = mode;
    }
    for (const [id, time] of processed) {
        if (time < now - PROCESSED_MEMORY_SECONDS) {
            processed.delete(id);
            failures.delete(id);
            outages.delete(id);
        }
    }
    const done = (id: string, time: number) => {
        processed.set(id, time);
        failures.delete(id);
        outages.delete(id);
        result.cursor = Math.max(result.cursor, time);
    };
    const giveUp = (metadata: any, why: string, finish: (id: string, time: number) => void = done) => {
        result.answers.push({ ...baseOf(metadata), to: '', outcome: 'skipped', reason: why });
        finish(metadata.ID, Number(metadata.Time) || 0);
    };
    const spamChecked = (state.spamChecked ??= new Map());
    for (const [id, time] of spamChecked) {
        if (time < now - PROCESSED_MEMORY_SECONDS) {
            spamChecked.delete(id);
        }
    }

    let calendars: Map<string, OwnCalendar> | undefined;
    const repliesTo = new Set((input.repliesTo || []).map((id) => id.replace(/^<|>$/g, '').toLowerCase()).filter(Boolean));
    /**
     * One label from `from`: emails handled in order. `moveCursor`: the main pass (the cursor follows);
     * the look-back and Spam passes only add what they find. `until`: stop at emails from this time on.
     */
    const scan = async (
        label: string,
        from: number,
        { moveCursor, spam = false, until, reached }: { moveCursor: boolean; spam?: boolean; until?: number; reached?: (time: number) => void }
    ) => {
        const finish = (id: string, time: number) => {
            if (moveCursor) {
                done(id, time);
            } else {
                processed.set(id, time);
            }
            reached?.(time);
        };
        // Each pass has its own page budget, so a long look-back cannot keep the Spam pass from running.
        let requests = 0;
        // Keyset paging: each list request starts at the newest arrival time seen so far, so an email
        // deleted or moved between requests cannot shift one out of view; already handled emails at
        // that time are passed over. Only a full page of a single second needs the page offset.
        let begin = from;
        let page = 0;
        while (requests < maxPages) {
            requests += 1;
            const { Messages = [] } = await ctx.api<{ Messages: any[] }>(messagesFrom(begin, page, label));
            for (const metadata of Messages) {
                const time = Number(metadata.Time) || 0;
                if (until !== undefined && time >= until) {
                    return; // the main pass has these
                }
                if (processed.has(metadata.ID) || (spam && spamChecked.has(metadata.ID))) {
                    reached?.(time); // seen before: progress all the same
                    continue;
                }
                const candidates = metadata.AttachmentsMetadata;
                const mayHaveCalendar = Array.isArray(candidates) ? candidates.some(isCalendarAttachment) : Number(metadata.NumAttachments) > 0;
                const early = mayHaveCalendar ? emailSkipReason(metadata, { spamAllowed: spam }) : '';
                if (early !== undefined) {
                    // Nothing to read (no calendar file, sent, bounced, spam), or skipped without opening.
                    if (early) {
                        result.answers.push({ ...baseOf(metadata), to: '', outcome: 'skipped', reason: early });
                    }
                    finish(metadata.ID, time);
                    continue;
                }
                if (result.opened >= maxOpened || (result.opened > 0 && Date.now() - startedAt > budgetMs)) {
                    result.more = true;
                    throw new StopRun();
                }
                try {
                    const { Message } = await ctx.api<{ Message: any }>(getMessage(metadata.ID) as any);
                    result.opened += 1;
                    if (spam && !answersOneOf(Message, repliesTo)) {
                        spamChecked.set(metadata.ID, time); // no reply to an invitation of this account: not read further
                        reached?.(time);
                        continue;
                    }
                    result.answers.push(...(await answersInEmail(ctx, (calendars ??= await ownCalendars(ctx)), Message, result.ignored, { spamAllowed: spam })));
                } catch (error: any) {
                    if (isOutage(error)) {
                        const outage = outages.get(metadata.ID) || { runs: 0, since: now };
                        outage.runs += 1;
                        outages.set(metadata.ID, outage);
                        if (outage.runs < MAX_OUTAGE_RUNS || now - outage.since < MAX_OUTAGE_SECONDS) {
                            throw error; // stop here; tried again next run
                        }
                        giveUp(metadata, `could not be processed (${errorText(error)}), given up after ${outage.runs} tries over ${Math.round((now - outage.since) / 3600)} h`, finish);
                        continue;
                    }
                    const failed = (failures.get(metadata.ID) || 0) + 1;
                    failures.set(metadata.ID, failed);
                    if (failed < MAX_FAILED_RUNS) {
                        throw error; // stop here; this email is tried again next run
                    }
                    giveUp(metadata, `could not be processed (${withoutContent(errorText(error))}), given up after ${failed} tries`, finish);
                    continue;
                }
                finish(metadata.ID, time);
            }
            if (Messages.length < PAGE_SIZE) {
                return;
            }
            const newest = Number(Messages[Messages.length - 1]?.Time) || begin;
            if (newest > begin) {
                begin = newest;
                page = 0;
            } else {
                page += 1; // a whole page arrived in the same second
            }
        }
        result.more = true;
        throw new StopRun();
    };

    try {
        await scan(ALMOST_ALL_MAIL, since, { moveCursor: true });
        // 0.41 (bridge): replies still in Spam, then replies moved out of Spam since (behind the cursor).
        // A pass cut short (budget, outage) continues where it got to, while its start stays the same.
        const resumable = async (key: 'lookBack' | 'spamPass', label: string, from: number, options: { spam?: boolean; until?: number }) => {
            const resume = state[key]?.from === from ? state[key]!.reached : from;
            const progress = { from, reached: resume };
            state[key] = progress;
            await scan(label, resume, { moveCursor: false, ...options, reached: (time) => (progress.reached = Math.max(progress.reached, time)) });
            state[key] = undefined; // done
        };
        if (repliesTo.size) {
            await resumable('spamPass', SPAM, input.lookBackFrom !== undefined ? Math.min(input.lookBackFrom, since) : since, { spam: true });
        }
        if (input.lookBackFrom !== undefined && input.lookBackFrom < since) {
            await resumable('lookBack', ALMOST_ALL_MAIL, input.lookBackFrom, { until: since });
        }
    } catch (error: any) {
        if (!(error instanceof StopRun)) {
            result.error = errorText(error);
        }
    }
    return result;
};
