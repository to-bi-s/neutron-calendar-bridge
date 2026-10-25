/**
 * Answering invitations — a port of what Proton Calendar's web app does when you press
 * Yes / Maybe / No on an invitation, or delete one.
 *
 * Sources (Proton WebClients, commit 464c1b060, the snapshot vendor/ was taken from):
 * - applications/calendar/.../eventActions/getChangePartstatActions.ts   (order of the steps)
 * - applications/calendar/.../eventActions/inviteActions.ts              (the REPLY email)
 * - applications/calendar/.../eventActions/getSaveRecurringEventActions.ts (answering a series)
 * - applications/calendar/.../eventActions/getDelete*EventActions.ts     (declining by deleting)
 * - applications/calendar/.../InteractiveCalendarView.tsx                (running the actions)
 * - packages/components/hooks/useSendIcs.ts, useGetEncryptionPreferences.ts,
 *   useGetAddressKeysByUsage.ts, useGetVtimezonesMap.ts                   (sending the email)
 *
 * The React hooks are replaced by plain functions over a small context; everything that
 * decides what is sent, and how it is encrypted, is Proton's own code from vendor/.
 *
 * Every email goes through an email policy first (test / dry-run / live). The policy is checked
 * before anything is changed in Proton, so a blocked answer leaves Proton untouched.
 */
import './polyfill';
import { dateParamsFor, inInvitationLanguage, prepareInvitationLanguage } from './invitation-language';
import type { InvitationDateFormat } from './invitation-language';
import type { InvitationLanguageChoice, PreparedInvitationLanguage } from './invitation-language';
import { serverTime } from '@protontech/crypto';
import getPublicKeysEmailHelper from '@proton/key-transparency/lib/keys/getPublicKeysEmailHelper';
import getPublicKeysVcardHelper from '@proton/shared/lib/api/helpers/getPublicKeysVcardHelper';
import { getMailSettings } from '@proton/shared/lib/api/mailSettings';
import { sendMessageDirect } from '@proton/shared/lib/api/messages';
import {
    getEvent,
    getPaginatedAttendeesInfo,
    getVtimezones,
    queryEvents,
    updateAttendeePartstat,
    updatePersonalEventPart,
} from '@proton/shared/lib/api/calendars';
import { getIsAutoAddedInvite } from '@proton/shared/lib/calendar/apiModels';
import { getAttendeeEmail, toApiPartstat, toIcsPartstat, withPartstat } from '@proton/shared/lib/calendar/attendees';
import { ICAL_ATTENDEE_STATUS, ICAL_METHOD } from '@proton/shared/lib/calendar/constants';
import { getCalendarEventDecryptionKeys } from '@proton/shared/lib/calendar/crypto/keys/helpers';
import { readCalendarEvent, readSessionKeys } from '@proton/shared/lib/calendar/deserialize';
import {
    createInviteIcs,
    generateEmailBody,
    generateEmailSubject,
    generateVtimezonesComponents,
    getIcsMessageWithPreferences,
} from '@proton/shared/lib/calendar/mailIntegration/invite';
import { reencryptCalendarSharedEvent } from '@proton/shared/lib/calendar/sync/reencrypt';
import { parse } from '@proton/shared/lib/calendar/vcal';
import { getAttendeeToken, getHasAttendees } from '@proton/shared/lib/calendar/vcalHelper';
import { getIsEventCancelled, withDtstamp } from '@proton/shared/lib/calendar/veventHelper';
import { APPS, MIME_TYPES, RECIPIENT_TYPES } from '@proton/shared/lib/constants';
import { getIsAddressActive, getSelfSendAddresses } from '@proton/shared/lib/helpers/address';
import { canonicalizeEmail, canonicalizeInternalEmail } from '@proton/shared/lib/helpers/email';
import { omit, pick } from '@proton/shared/lib/helpers/object';
import type { Address, Api, DecryptedAddressKey, DecryptedKey, KTUserContext } from '@proton/shared/lib/interfaces';
import { KT_VERIFICATION_STATUS, KeyTransparencyActivation } from '@proton/shared/lib/interfaces';
import type {
    CalendarEvent,
    DecryptedCalendarKey,
    VcalAttendeeProperty,
    VcalVeventComponent,
    VcalVtimezoneComponent,
} from '@proton/shared/lib/interfaces/calendar';
import {
    getActiveAddressKeys,
    getKeyHasFlagsToEncrypt,
    getPrimaryActiveAddressKeyForEncryption,
    getPrimaryAddressKeysForSigning,
    splitKeys,
} from '@proton/shared/lib/keys';
import { getContactPublicKeyModel, getKeyEncryptionCapableStatus } from '@proton/shared/lib/keys/publicKeys';
import { getSupportedPlusAlias } from '@proton/shared/lib/mail/addresses';
import { MESSAGE_FLAGS } from '@proton/shared/lib/mail/constants';
import extractEncryptionPreferences from '@proton/shared/lib/mail/encryptionPreferences';
import { AUTO_SAVE_CONTACTS } from '@proton/shared/lib/mail/mailSettings';
import { encryptAttachment } from '@proton/shared/lib/mail/send/attachments';
import generatePackages from '@proton/shared/lib/mail/send/generatePackages';
import getSendPreferences from '@proton/shared/lib/mail/send/getSendPreferences';

export type SendPreferences = ReturnType<typeof getSendPreferences>;

// ---------------------------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------------------------

export type InvitationAnswer = 'ACCEPTED' | 'TENTATIVE' | 'DECLINED';

/**
 * test:    emails only to addresses on the allowlist; an answer that would email anyone else is
 *          refused as a whole (nothing changes in Proton).
 * dry-run: nothing is sent and nothing changes; the email that would have been sent is reported.
 * live:    emails go out like from Proton's own apps.
 */
export type InvitationEmailMode = 'test' | 'dry-run' | 'live';

export interface InvitationEmailPolicy {
    mode: InvitationEmailMode;
    allowlist: string[];
    /**
     * The language of the emails (0.31): 'proton' = Proton Calendar's "Invitation language" setting
     * (then the account's language), or one of INVITATION_LANGUAGES' codes. Default 'proton'.
     */
    language?: InvitationLanguageChoice;
}

export const DEFAULT_INVITATION_EMAIL_POLICY: InvitationEmailPolicy = { mode: 'test', allowlist: [], language: 'proton' };

/** The language the emails of this action are written in (the policy's choice, resolved through Proton's setting when 'proton'). */
export const resolveInvitationLanguage = async (ctx: Pick<InvitationContext, 'policy' | 'getProtonInviteLocale' | 'getInvitationDateFormat'>): Promise<PreparedInvitationLanguage> => {
    const choice = ctx.policy.language || 'proton';
    const code = choice === 'proton' ? await ctx.getProtonInviteLocale().catch(() => null) : choice;
    const format = ctx.getInvitationDateFormat ? await ctx.getInvitationDateFormat().catch(() => undefined) : undefined;
    return prepareInvitationLanguage(code, format);
};

export type EmailDelivery = 'proton' | 'pgp' | 'plain';

/** REPLY: your answer to an invitation. REQUEST / CANCEL: meetings you organize. */
export type InvitationEmailMethod = 'REPLY' | 'REQUEST' | 'CANCEL';

/** answer (REPLY); invitation, update (REQUEST); cancellation (CANCEL). */
export type InvitationEmailKind = 'answer' | 'invitation' | 'update' | 'cancellation';

export interface InvitationEmailRecord {
    at: string;
    method: InvitationEmailMethod;
    kind: InvitationEmailKind;
    /** REPLY only. */
    answer?: InvitationAnswer;
    from: string;
    to: { email: string; name: string; delivery?: EmailDelivery }[];
    subject: string;
    eventTitle: string;
    eventUid: string;
    recurrenceId?: string;
    outcome: 'sent' | 'blocked' | 'dry-run' | 'failed';
    /** Sent emails: the email's Message-ID (Proton's ExternalID), the same in the recipients' copies. */
    externalId?: string;
    /** 0.41 (bridge): a failed email that waits for Proton's slow-down to end and is sent then. */
    deferred?: boolean;
    /** 0.41 (bridge): with `deferred`, when Proton accepts requests again (Unix ms). */
    retryAt?: number;
    detail?: string;
    /** Only for dry runs: what would have been sent. */
    preview?: { body: string; ics: string };
}

/**
 * blocked: test-mode allowlist; dry-run: only simulated; unsupported: not possible here;
 * incomplete: the organizer or guests were emailed but Proton did not take the change (the same
 * action within a few minutes finishes it without emailing again); stale: the event changed in
 * Proton since the caller's copy (meetings you organize; nothing was sent); failed: an error
 * before anything was sent.
 */
/** 0.44.2: 'cancelled' — the organizer cancelled the meeting in Proton (there is nothing to answer). */
export type InvitationRefusalReason = 'blocked' | 'dry-run' | 'unsupported' | 'incomplete' | 'stale' | 'failed' | 'rate-limited' | 'cancelled';

export class InvitationActionError extends Error {
    /** Every email the refusal concerns (several for meetings you organize). */
    readonly emails: InvitationEmailRecord[];
    /** 'rate-limited': when Proton accepts requests again (Unix ms). */
    retryAt?: number;
    /**
     * 'rate-limited': an event left in Proton without guests (a new meeting's or occurrence's first
     * step), not removed during the slow-down: for the caller to remove once Proton's time is up.
     */
    leftover?: { calendarID: string; eventID: string };

    constructor(
        message: string,
        readonly reason: InvitationRefusalReason,
        readonly email?: InvitationEmailRecord,
        emails?: InvitationEmailRecord[],
        /** Organizer saves: the Proton event as far as it got (an 'incomplete' create already exists). */
        readonly event?: { eventID: string; uid: string }
    ) {
        super(message);
        this.name = 'InvitationActionError';
        this.emails = emails ?? (email ? [email] : []);
    }
}

/** A new guest who could not be invited: not on the test-mode allowlist, or Proton cannot email them. */
export interface RefusedGuest {
    email: string;
    reason: string;
}

/**
 * New guests of a meeting you organize that cannot be invited (nothing was changed). With
 * `withoutRefusedGuests`, the save is done again without them (Proton's "continue without").
 */
export class RefusedGuestsError extends InvitationActionError {
    constructor(
        message: string,
        reason: InvitationRefusalReason,
        readonly refusedGuests: RefusedGuest[],
        emails: InvitationEmailRecord[] = []
    ) {
        super(message, reason, emails[0], emails);
        this.name = 'RefusedGuestsError';
    }
}

export interface InvitationActionResult {
    /** Emails sent (or, for refusals, the one that was blocked / dry-run). */
    emails: InvitationEmailRecord[];
    /** Proton event IDs whose content or answers changed (for cache invalidation / re-reads). */
    changedEventIds: string[];
    /** Proton event IDs removed. */
    deletedEventIds: string[];
    /** Things that went wrong after Proton was already changed (the action itself stands). */
    warnings: string[];
}

/** What the invitation code needs from the signed-in client. */
export interface InvitationContext {
    api: Api;
    addresses: Address[];
    userKeys: DecryptedKey[];
    getAddressKeys: (addressID: string) => DecryptedAddressKey[];
    getCalendarKeys: (calendarID: string) => Promise<DecryptedCalendarKey[]>;
    getCalendarSettings: (calendarID: string) => Promise<any>;
    getMemberID: (calendarID: string) => Promise<string>;
    /** Read at every use, so a policy change takes effect even in the middle of an action. */
    readonly policy: InvitationEmailPolicy;
    /** Proton Calendar's "Invitation language" (InviteLocale, else the account's Locale); null: unknown. */
    getProtonInviteLocale: () => Promise<string | null>;
    /** 0.49.6: the region and hours for the dates in the emails (see InvitationDateFormat); absent: the language's own. */
    getInvitationDateFormat?: () => Promise<InvitationDateFormat>;
    prodId: string;
    onEmail?: (record: InvitationEmailRecord) => void;
    /**
     * Replies sent recently, per Proton event (kept by the caller across actions). A retried
     * answer that was already emailed only redoes what is missing in Proton, without emailing
     * the organizer again.
     */
    sentReplies: Map<string, { answer: InvitationAnswer; at: number }>;
    /**
     * Meetings you organize: emails that went out for an event whose Proton change then failed
     * ('incomplete'), per calendar and Proton UID (kept by the caller across actions). Retrying the
     * same change within a few minutes finishes it in Proton without emailing the guests again.
     */
    pendingOrganizerEmails: Map<string, { fingerprints: string[]; at: number; stamp: string }>;
    /**
     * 0.41 (bridge): emails to further guests that Proton refused during a slow-down after the first
     * one went out. During an action this collects that action's ones; the client keeps them only when
     * the action succeeds (commitDeferredEmails), and sends them once the pause is over
     * (sendDeferredEmails). Optional: without it such an email is reported as not sent, as before.
     */
    deferredEmails?: DeferredEmail[];
}

/** 0.41 (bridge): an email that waits for Proton's slow-down to end. */
export interface DeferredEmail {
    email: PreparedEmail;
    /** When Proton accepts requests again (Unix ms). */
    retryAt: number;
    /** When it was first refused (Unix ms). */
    since: number;
}

/** 0.41 (bridge): a waiting email older than this is given up (reported as not sent). */
export const DEFERRED_EMAIL_MAX_AGE_MS = 24 * 3600 * 1000;

/**
 * 0.41 (bridge): sends the waiting emails whose pause is over, in order. A new slow-down stops the
 * run (they wait on); another refusal, or one waiting longer than a day, is reported as not sent.
 */
export const sendDeferredEmails = async (ctx: InvitationContext, now = Date.now()) => {
    const queue = ctx.deferredEmails;
    const outcome = { sent: 0, waiting: 0, givenUp: 0 };
    if (!queue?.length) {
        return outcome;
    }
    const take = (entry: DeferredEmail) => {
        const index = queue.indexOf(entry);
        if (index >= 0) {
            queue.splice(index, 1);
        }
        return index >= 0;
    };
    const report = (entry: DeferredEmail, detail: string) =>
        ctx.onEmail?.({ ...entry.email.record, outcome: 'failed', deferred: false, at: new Date(now).toISOString(), detail });
    for (const entry of [...queue]) {
        if (entry.retryAt > now) {
            continue;
        }
        // Off the queue while it is sent: a newer change of the meeting cannot drop it halfway.
        if (!take(entry)) {
            continue;
        }
        if (now - entry.since > DEFERRED_EMAIL_MAX_AGE_MS) {
            report(entry, 'not sent: Proton kept asking to slow down for a day');
            outcome.givenUp += 1;
            continue;
        }
        try {
            await sendPrepared(ctx, entry.email);
            outcome.sent += 1;
        } catch (error: any) {
            const until = rateLimitedUntil(error);
            const name = error?.name;
            if (until || neverLeft(error) || name === 'SessionExpiredError' || name === 'AppVersionError') {
                // Certainly not sent (a pause again, no connection at all, the session or app version
                // refused before sending): it waits on, first in line, and so does the rest.
                queue.unshift(until ? { ...entry, retryAt: until } : entry);
                if (name === 'SessionExpiredError' || name === 'AppVersionError') {
                    throw error; // the caller signs in again / says so
                }
                break;
            }
            // A server error or a timeout may have sent it anyway (no second try: the guest could get it
            // twice); anything else is final.
            const status = Number(error?.status);
            const maybeSent = !(error instanceof InvitationActionError) && (status >= 500 || /fetch failed|timeout|timed out|terminated|socket hang up|ECONNRESET/i.test(`${errorText(error)} ${error?.cause?.code ?? ''}`));
            report(entry, maybeSent ? `${errorText(error)} (it may have been sent anyway)` : errorText(error));
            outcome.givenUp += 1;
        }
    }
    outcome.waiting = queue.length;
    return outcome;
};

/** 0.41 (bridge): the request never reached Proton (no network, name not resolved, connection refused). */
const neverLeft = (error: any) => {
    const code = String(error?.code ?? error?.cause?.code ?? '');
    return ['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ENETUNREACH', 'EHOSTUNREACH', 'ENETDOWN'].includes(code);
};

/**
 * 0.41 (bridge): after an action succeeded, its waiting emails join the client's queue. A waiting email
 * of the same meeting (and occurrence) whose guests all got an email from this action is dropped: they
 * have the newer version. Others stay (e.g. a guest the newer change did not email).
 */
export const commitDeferredEmails = (queue: DeferredEmail[], staged: DeferredEmail[], result: { emails: InvitationEmailRecord[] }, onEmail?: (record: InvitationEmailRecord) => void) => {
    const reached = new Map<string, Set<string>>();
    for (const record of result.emails) {
        if (record.outcome !== 'sent') continue;
        const key = `${record.eventUid}\u0000${record.recurrenceId || ''}`;
        const set = reached.get(key) ?? new Set<string>();
        record.to.forEach(({ email }) => set.add(email.toLowerCase()));
        reached.set(key, set);
    }
    for (const entry of [...queue]) {
        const got = reached.get(`${entry.email.record.eventUid}\u0000${entry.email.record.recurrenceId || ''}`);
        if (got && entry.email.to.every(({ Address }) => got.has(Address.toLowerCase()))) {
            queue.splice(queue.indexOf(entry), 1);
            onEmail?.({ ...entry.email.record, outcome: 'failed', deferred: false, at: new Date().toISOString(), detail: 'not sent: a newer change of the meeting was emailed instead' });
        }
    }
    queue.push(...staged);
};

/** How long a sent reply counts as "already emailed" for a retry of the same answer. */
export const SENT_REPLY_MEMORY_MS = 15 * 60 * 1000;

const sentReplyKey = (event: CalendarEvent) => `${event.CalendarID}/${event.ID}`;

const wasJustEmailed = (ctx: InvitationContext, event: CalendarEvent, answer: ICAL_ATTENDEE_STATUS) => {
    const sent = ctx.sentReplies.get(sentReplyKey(event));
    return !!sent && sent.answer === answer && Date.now() - sent.at < SENT_REPLY_MEMORY_MS;
};

const rememberEmailed = (ctx: InvitationContext, event: CalendarEvent, answer: ICAL_ATTENDEE_STATUS) => {
    ctx.sentReplies.set(sentReplyKey(event), { answer: answer as InvitationAnswer, at: Date.now() });
    for (const [key, sent] of ctx.sentReplies) {
        if (Date.now() - sent.at >= SENT_REPLY_MEMORY_MS) {
            ctx.sentReplies.delete(key);
        }
    }
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A few attempts for a write that must follow an email already sent. */
export const withRetries = async <T>(action: () => Promise<T>, attempts = 3, delayMs = 1000): Promise<T> => {
    let lastError: unknown;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
        try {
            return await action();
        } catch (error) {
            lastError = error;
            if (attempt < attempts) {
                await sleep(delayMs * attempt);
            }
        }
    }
    throw lastError;
};

export const errorText = (error: any) => error?.data?.Error || error?.message || String(error);

/**
 * Proton refused the email, so nothing went out: our own refusals, Proton's 4xx with a code, a
 * slow-down (429: not processed) or an app version Proton rejects. Anything else (no answer, a
 * timeout, a server error) may have been sent.
 */
/** Proton asked to slow down (RateLimitedError): when it accepts requests again (Unix ms), else undefined. */
export const rateLimitedUntil = (error: any): number | undefined =>
    error?.name === 'RateLimitedError' || (error instanceof InvitationActionError && error.reason === 'rate-limited')
        ? Number(error.retryAt) || Date.now() + 60_000
        : undefined;

/** The refusal of an email Proton asked to wait with: nothing was sent or changed; try again at retryAt. */
export const rateLimitedAction = (message: string, error: any, email?: InvitationEmailRecord) => {
    const refusal = new InvitationActionError(message, 'rate-limited', email);
    refusal.retryAt = rateLimitedUntil(error);
    return refusal;
};

/**
 * A slow-down after the event without guests was created (a new meeting's first step): removing it
 * now would be refused too, so it is reported as a leftover for the caller to remove later.
 */
export const leftBehindBySlowDown = (error: any, leftover: { calendarID: string; eventID: string }) => {
    const refusal =
        error instanceof InvitationActionError ? error : rateLimitedAction('Proton asked to slow down: no email was sent and nothing was changed yet.', error);
    refusal.leftover = leftover;
    return refusal;
};

export const isSendRefused = (error: any) =>
    error instanceof InvitationActionError ||
    error?.name === 'RateLimitedError' ||
    error?.name === 'AppVersionError' ||
    (typeof error?.status === 'number' && error.status >= 400 && error.status < 500 && error?.data?.Code !== undefined);

// ---------------------------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------------------------

const { ACCEPTED, TENTATIVE, DECLINED, NEEDS_ACTION } = ICAL_ATTENDEE_STATUS;
const MORE_ATTENDEES_YES = 1;

const toIcsAnswer = (answer: InvitationAnswer): ICAL_ATTENDEE_STATUS => {
    switch (answer) {
        case 'ACCEPTED':
            return ACCEPTED;
        case 'TENTATIVE':
            return TENTATIVE;
        case 'DECLINED':
            return DECLINED;
        default:
            throw new InvitationActionError(`Unknown answer ${answer}`, 'unsupported');
    }
};

const normalizeForPolicy = (email: string) => canonicalizeEmail(email.trim());

export const isAllowedByPolicy = (policy: InvitationEmailPolicy, email: string) => {
    if (policy.mode === 'live') {
        return true;
    }
    const wanted = normalizeForPolicy(email);
    return policy.allowlist.some((entry) => entry.trim() && normalizeForPolicy(entry) === wanted);
};

export const eventTitleOf = (vevent: VcalVeventComponent) => vevent.summary?.value || '(no title)';

export const recurrenceIdOf = (vevent: VcalVeventComponent) => {
    const value: any = vevent['recurrence-id']?.value;
    if (!value) {
        return undefined;
    }
    const pad = (n: number) => String(n).padStart(2, '0');
    const date = `${value.year}${pad(value.month)}${pad(value.day)}`;
    return value.hours === undefined ? date : `${date}T${pad(value.hours)}${pad(value.minutes)}${pad(value.seconds)}${value.isUTC ? 'Z' : ''}`;
};

/** Paged guest answers, like Proton's fetchPaginatedAttendeesInfo. Mutates the event. */
export const completeAttendeesInfo = async (api: Api, event: CalendarEvent) => {
    const info: any = event.AttendeesInfo;
    if (!info || info.MoreAttendees !== MORE_ATTENDEES_YES) {
        return event;
    }
    const attendees = [...(info.Attendees || [])];
    let more = info.MoreAttendees;
    for (let page = 1; more === MORE_ATTENDEES_YES && page <= 50; page += 1) {
        const response: any = await api(getPaginatedAttendeesInfo(event.CalendarID, event.ID, page));
        attendees.push(...(response.Attendees || []));
        more = response.MoreAttendees;
    }
    event.AttendeesInfo = { ...info, Attendees: attendees, MoreAttendees: more };
    return event;
};

export const fetchEvent = async (api: Api, calendarID: string, eventID: string): Promise<CalendarEvent> => {
    const { Event } = await api<{ Event: CalendarEvent }>(getEvent(calendarID, eventID));
    return completeAttendeesInfo(api, Event);
};

/** Every Proton event of a series (master and single edits), like Proton's getAllEventsByUID. */
export const fetchEventsByUID = async (api: Api, calendarID: string, UID: string): Promise<CalendarEvent[]> => {
    const PageSize = 100;
    const events: CalendarEvent[] = [];
    for (let Page = 0; Page < 50; Page += 1) {
        const { Events = [] } = await api<{ Events: CalendarEvent[] }>(
            queryEvents(calendarID, { UID, Page, PageSize } as any)
        );
        for (const event of Events) {
            events.push(await completeAttendeesInfo(api, event));
        }
        if (Events.length < PageSize) {
            break;
        }
    }
    return events;
};

export interface ReadInvitation {
    event: CalendarEvent;
    vevent: VcalVeventComponent;
    selfAddress?: Address;
    selfAttendeeIndex?: number;
    isAttendee: boolean;
    isOrganizer: boolean;
    hasDefaultNotifications: boolean;
}

export const readInvitation = async (ctx: InvitationContext, event: CalendarEvent): Promise<ReadInvitation> => {
    const calendarKeys = await ctx.getCalendarKeys(event.CalendarID);
    const addressKeys = getIsAutoAddedInvite(event) ? ctx.getAddressKeys(event.AddressID) : undefined;
    const privateKeys = await getCalendarEventDecryptionKeys({ calendarEvent: event, addressKeys, calendarKeys });
    if (!privateKeys) {
        throw new InvitationActionError('Could not find the keys to read this invitation', 'failed');
    }
    const [sharedSessionKey, calendarSessionKey] = await readSessionKeys({ calendarEvent: event, privateKeys });
    const result: any = await readCalendarEvent({
        event: {
            SharedEvents: event.SharedEvents || [],
            CalendarEvents: event.CalendarEvents || [],
            AttendeesEvents: event.AttendeesEvents || [],
            AttendeesInfo: event.AttendeesInfo,
            Notifications: event.Notifications,
            FullDay: event.FullDay,
            CalendarID: event.CalendarID,
            ID: event.ID,
            UID: event.UID,
            Color: event.Color,
        } as any,
        publicKeysMap: {},
        addresses: ctx.addresses,
        sharedSessionKey,
        calendarSessionKey,
        calendarSettings: await ctx.getCalendarSettings(event.CalendarID),
        encryptingAddressID: undefined,
        // Signature verification of the organizer's part is not needed to answer.
        getAttendeeVerificationPreferences: async () => ({}) as any,
    } as any);
    const { veventComponent, selfAddressData, hasDefaultNotifications } = result;
    return {
        event,
        vevent: veventComponent,
        selfAddress: selfAddressData?.selfAddress,
        selfAttendeeIndex: selfAddressData?.selfAttendeeIndex,
        isAttendee: Boolean(selfAddressData?.isAttendee),
        isOrganizer: Boolean(selfAddressData?.isOrganizer),
        hasDefaultNotifications: Boolean(hasDefaultNotifications),
    };
};

const selfAnswerOf = (event: CalendarEvent, token?: string) => {
    if (!token) {
        return undefined;
    }
    return (event.AttendeesInfo?.Attendees || []).find(({ Token }) => Token === token);
};

// ---------------------------------------------------------------------------------------------
// Keys and encryption preferences (useGetAddressKeysByUsage / useGetEncryptionPreferences)
// ---------------------------------------------------------------------------------------------

/**
 * Like Proton's getAddressKeysByUsageThunk as useSendIcs calls it: encryption may use the v6 (PQC)
 * primary key, signing only v4 keys (v6 signatures break some third-party OpenPGP parsers), and
 * decryption all active keys (for the attachment's session key).
 */
export const getAddressKeysByUsage = async (ctx: InvitationContext, addressID: string) => {
    const decryptedKeys = ctx.getAddressKeys(addressID);
    const activeKeysByVersion = await getActiveAddressKeys(null, decryptedKeys);
    const signingKeys = getPrimaryAddressKeysForSigning(activeKeysByVersion, false);
    const encryptionKey = getPrimaryActiveAddressKeyForEncryption(activeKeysByVersion, true).privateKey;
    const decryptionKeys = [...activeKeysByVersion.v6, ...activeKeysByVersion.v4].map((activeKey) => activeKey.privateKey);
    return { encryptionKey, signingKeys, decryptionKeys };
};

/**
 * Key transparency is not verified (as with Proton's KeyTransparencyActivation.DISABLED): the
 * recipient's keys come from Proton's key server (and pinned contact keys) without the extra
 * audit-log check Proton's apps can do on top.
 */
const getKtUserContext = (ctx: InvitationContext): KTUserContext => ({
    ktActivation: KeyTransparencyActivation.DISABLED,
    appName: APPS.PROTONCALENDAR,
    getUser: async () => {
        throw new Error('Key transparency is not used by proton-calendar-client');
    },
    getUserKeys: async () => ctx.userKeys,
});

/**
 * Proton's getEncryptionPreferencesThunk. `intendedForEmail` (the default): the keys to email the
 * address with (v6/PQC keys preferred). False: the address's internal keys, also when its account has
 * E2EE for mail switched off — what auto-adding an event to a Proton guest's calendar needs.
 */
export const getEncryptionPreferences = async (ctx: InvitationContext, email: string, mailSettings: any, { intendedForEmail = true } = {}) => {
    const preferV6Keys = intendedForEmail;
    const canonicalEmail = canonicalizeInternalEmail(email);
    const selfAddress = getSelfSendAddresses(ctx.addresses).find(
        ({ Email }) => canonicalizeInternalEmail(Email) === canonicalEmail
    );
    let selfSend: any;
    let apiKeysConfig: any;
    let pinnedKeysConfig: any;
    if (selfAddress) {
        const activeAddressKeys = await getActiveAddressKeys(selfAddress.SignedKeyList, ctx.getAddressKeys(selfAddress.ID));
        const primaryAddressKey = getPrimaryActiveAddressKeyForEncryption(activeAddressKeys, preferV6Keys);
        const selfPublicKey = primaryAddressKey.publicKey;
        const canEncrypt = await getKeyEncryptionCapableStatus(selfPublicKey);
        const canSend = canEncrypt && getKeyHasFlagsToEncrypt(primaryAddressKey.flags);
        selfSend = { address: selfAddress, publicKey: selfPublicKey, canSend };
        apiKeysConfig = {
            publicKeys: [],
            RecipientType: RECIPIENT_TYPES.TYPE_INTERNAL,
            ktVerificationResult: { status: KT_VERIFICATION_STATUS.VERIFIED_KEYS },
        };
        pinnedKeysConfig = { pinnedKeys: [], isContact: false };
    } else {
        const { publicKeys: contactVerificationKeys } = splitKeys(ctx.userKeys);
        apiKeysConfig = await getPublicKeysEmailHelper({
            email,
            internalKeysOnly: intendedForEmail === false,
            includeInternalKeysWithE2EEDisabledForMail: intendedForEmail === false,
            api: ctx.api,
            ktUserContext: getKtUserContext(ctx),
            silence: true,
            noCache: true,
        });
        const isInternal = apiKeysConfig.RecipientType === RECIPIENT_TYPES.TYPE_INTERNAL;
        pinnedKeysConfig = await getPublicKeysVcardHelper(ctx.api, email, contactVerificationKeys, isInternal);
    }
    const publicKeyModel = await getContactPublicKeyModel({
        emailAddress: email,
        apiKeysConfig,
        pinnedKeysConfig,
        preferV6Keys,
    });
    return extractEncryptionPreferences(publicKeyModel, mailSettings, selfSend);
};

export const deliveryOf = (sendPreferences: SendPreferences, isInternal: boolean): EmailDelivery => {
    if (!sendPreferences.encrypt) {
        return 'plain';
    }
    return isInternal ? 'proton' : 'pgp';
};

// ---------------------------------------------------------------------------------------------
// The REPLY email (getSendIcsAction's attendee branch + useSendIcs)
// ---------------------------------------------------------------------------------------------

export interface PreparedEmail {
    method: ICAL_METHOD;
    /** For messages: "your answer", "the invitation", ... */
    purpose: string;
    record: InvitationEmailRecord;
    addressID: string;
    ics: string;
    subject: string;
    body: string;
    from: { Address: string; Name: string };
    to: { Address: string; Name: string }[];
    sendPreferencesMap: Record<string, SendPreferences>;
    mailSettings: any;
    timestamp: number;
}

export const getVtimezonesMap = (ctx: InvitationContext) => async (tzids: string[]) => {
    const wanted = [...new Set(tzids.filter((tzid) => tzid.toLowerCase() !== 'utc'))];
    if (!wanted.length) {
        return {};
    }
    const { Timezones = {} } = await ctx.api<{ Timezones: Record<string, string> }>(
        getVtimezones(wanted.map((tzid) => encodeURIComponent(tzid)))
    );
    const map: Record<string, { vtimezone: VcalVtimezoneComponent; vtimezoneString: string }> = {};
    for (const tzid of wanted) {
        const vtimezoneString = Timezones[tzid];
        if (vtimezoneString) {
            map[tzid] = { vtimezoneString, vtimezone: parse(vtimezoneString) as VcalVtimezoneComponent };
        }
    }
    return map;
};

const prepareReply = async (
    ctx: InvitationContext,
    {
        vevent: rawVevent,
        selfAddress,
        selfAttendeeIndex,
        answer,
        isProtonProtonInvite,
    }: {
        vevent: VcalVeventComponent;
        selfAddress: Address;
        selfAttendeeIndex: number;
        answer: ICAL_ATTENDEE_STATUS;
        isProtonProtonInvite: boolean;
    }
): Promise<PreparedEmail> => {
    const { organizer } = rawVevent;
    if (!organizer || !rawVevent.attendee?.[selfAttendeeIndex]) {
        throw new InvitationActionError('The invitation has no organizer or does not list you', 'unsupported');
    }
    // Proton regenerates DTSTAMP at send time (handleSendIcs).
    const timestamp = +serverTime();
    const vevent = withDtstamp(omit(rawVevent, ['dtstamp']) as any, timestamp) as VcalVeventComponent;
    const vtimezones = await generateVtimezonesComponents(vevent, getVtimezonesMap(ctx) as any);
    const selfAttendee = vevent.attendee![selfAttendeeIndex] as VcalAttendeeProperty;
    const supportedPlusAliasEmail = getSupportedPlusAlias({
        selfAttendeeEmail: getAttendeeEmail(selfAttendee),
        selfAddressEmail: selfAddress.Email,
    });
    const organizerEmail = getAttendeeEmail(organizer as any);
    const selfAttendeeWithPartstat = withPartstat(selfAttendee, answer);
    const pmVevent: VcalVeventComponent = { ...vevent };
    if (isProtonProtonInvite) {
        pmVevent['x-pm-proton-reply'] = { value: 'true', parameters: { type: 'boolean' } } as any;
    }
    const ics = createInviteIcs({
        method: ICAL_METHOD.REPLY,
        prodId: ctx.prodId,
        vevent: pmVevent,
        vtimezones,
        attendeesTo: [selfAttendeeWithPartstat],
        keepDtstamp: true,
    });
    const language = await resolveInvitationLanguage(ctx);
    const params = {
        method: ICAL_METHOD.REPLY,
        vevent,
        partstat: answer,
        emailAddress: getAttendeeEmail(selfAttendee),
        ...dateParamsFor(language),
    };
    const { subject, body } = inInvitationLanguage(language, () => ({ subject: generateEmailSubject(params), body: generateEmailBody(params) }));
    const displayName = selfAddress.DisplayName || selfAddress.Email;
    const from = { Address: supportedPlusAliasEmail, Name: displayName };
    const to = [{ Address: organizerEmail, Name: (organizer as any).parameters?.cn || organizerEmail }];

    // handleSendPrefsErrors: encryption preferences for the organizer, with the ICS message prefs.
    const { MailSettings: mailSettings } = await ctx.api<{ MailSettings: any }>(getMailSettings());
    const encryptionPreferences = await getEncryptionPreferences(ctx, organizerEmail, mailSettings);
    const sendPreferences = getSendPreferences(
        encryptionPreferences,
        getIcsMessageWithPreferences(mailSettings?.Sign) as any
    );
    // useSendIcs: a REPLY to an organizer with a send-preferences error is not sent.
    if (sendPreferences.error) {
        throw new InvitationActionError(
            `Cannot send your answer to ${organizerEmail}: ${sendPreferences.error.message}`,
            'failed'
        );
    }

    const record: InvitationEmailRecord = {
        at: new Date(timestamp).toISOString(),
        method: 'REPLY',
        kind: 'answer',
        answer: answer as InvitationAnswer,
        from: supportedPlusAliasEmail,
        to: [
            {
                email: organizerEmail,
                name: to[0].Name,
                delivery: deliveryOf(sendPreferences, encryptionPreferences.isInternal),
            },
        ],
        subject,
        eventTitle: eventTitleOf(vevent),
        eventUid: vevent.uid.value,
        recurrenceId: recurrenceIdOf(vevent),
        outcome: 'sent',
    };

    return {
        method: ICAL_METHOD.REPLY,
        purpose: 'your answer',
        record,
        addressID: selfAddress.ID,
        ics,
        subject,
        body,
        from,
        to,
        sendPreferencesMap: { [organizerEmail]: sendPreferences },
        mailSettings,
        timestamp,
    };
};

const recipientsOf = (emails: PreparedEmail[]) => [...new Set(emails.flatMap(({ to }) => to.map(({ Address }) => Address)))];

/**
 * Checks the email policy before anything changes in Proton. Returns normally only in live mode
 * or when every recipient of every email is allowlisted in test mode. `doing` names the action
 * for the test-mode message ("answering", "this change", ...).
 */
export const enforcePolicy = async (ctx: InvitationContext, emailOrEmails: PreparedEmail | PreparedEmail[], doing = 'answering') => {
    const emails = Array.isArray(emailOrEmails) ? emailOrEmails : [emailOrEmails];
    if (!emails.length) {
        return;
    }
    const { policy } = ctx;
    if (policy.mode === 'dry-run') {
        // Build the encrypted packages anyway, so a dry run exercises everything except the send.
        const records: InvitationEmailRecord[] = [];
        for (const email of emails) {
            await buildDirectSend(ctx, email);
            const record: InvitationEmailRecord = {
                ...email.record,
                outcome: 'dry-run',
                detail: 'Dry run: nothing was sent and nothing changed in Proton.',
                // The event's session key stays out of logs.
                preview: {
                    body: email.body,
                    ics: email.ics.replace(/\r?\n[ \t]/g, '').replace(/^(X-PM-SESSION-KEY[^:\r\n]*:).*$/gim, '$1(not shown)'),
                },
            };
            ctx.onEmail?.(record);
            records.push(record);
        }
        const purposes = [...new Set(emails.map(({ purpose }) => purpose))].join(' and ');
        throw new InvitationActionError(
            `Dry run: would have emailed ${purposes} to ${recipientsOf(emails).join(', ')}; nothing was changed.`,
            'dry-run',
            records[0],
            records
        );
    }
    const blocked = recipientsOf(emails).filter((address) => !isAllowedByPolicy(policy, address));
    if (blocked.length) {
        const list = blocked.join(', ');
        const records = emails.map((email) => {
            const record: InvitationEmailRecord = {
                ...email.record,
                outcome: 'blocked',
                detail: `Test mode: ${list} ${blocked.length === 1 ? 'is' : 'are'} not on the allowlist.`,
            };
            ctx.onEmail?.(record);
            return record;
        });
        throw new InvitationActionError(
            `Test mode: ${doing} would email ${list}, which ${blocked.length === 1 ? 'is' : 'are'} not on the allowlist. Nothing was changed.`,
            'blocked',
            records[0],
            records
        );
    }
};

/** useSendIcs, up to (not including) the POST. */
export const buildDirectSend = async (ctx: InvitationContext, email: PreparedEmail) => {
    const { encryptionKey, signingKeys, decryptionKeys } = await getAddressKeysByUsage(ctx, email.addressID);
    const { Sign, AutoSaveContacts } = email.mailSettings || {};
    const { method } = email;
    const inviteAttachment = {
        name: 'invite.ics',
        type: `text/calendar; method=${method}`,
        size: new TextEncoder().encode(email.ics).length,
    } as unknown as File;
    const packets: any = await encryptAttachment(email.ics, inviteAttachment, false, encryptionKey, signingKeys);
    // Same as Proton: not a valid OpenPGP message, the API reads the packets separately.
    const attachmentContents = new Uint8Array(
        [packets.data, packets.keys, packets.signature]
            .filter(Boolean)
            .reduce((acc: number[], part: Uint8Array) => acc.concat(Array.from(part)), [])
    );
    const emails = email.to.map(({ Address }) => Address);
    const attachment = {
        Filename: packets.Filename,
        MIMEType: packets.MIMEType,
        Contents: (attachmentContents).toBase64(),
        KeyPackets: (packets.keys).toBase64(),
        Signature: packets.signature ? (packets.signature).toBase64() : undefined,
    };
    const directMessage: any = {
        ToList: email.to,
        CCList: [],
        BCCList: [],
        Subject: email.subject,
        Sender: email.from,
        Body: email.body,
        MIMEType: MIME_TYPES.PLAINTEXT,
        Attachments: [pick(attachment, ['Filename', 'MIMEType', 'Contents'])],
        Flags: Sign ? MESSAGE_FLAGS.FLAG_SIGN : undefined,
    };
    const packages = await generatePackages({
        message: directMessage,
        sendPreferencesMap: email.sendPreferencesMap,
        attachmentData: { attachment, data: email.ics } as any,
        attachments: [attachment] as any,
        emails,
        addressKeysByUsage: { decryptionKeys, encryptionKey, signingKeys },
    });
    return {
        Message: directMessage,
        AttachmentKeys: (packets.keys).toBase64(),
        // Proton: do not save the organizer as a contact on REPLY (it could be a group address);
        // invitations follow your mail setting.
        AutoSaveContacts: method === ICAL_METHOD.REPLY ? AUTO_SAVE_CONTACTS.DISABLED : AutoSaveContacts,
        Packages: Object.values(packages),
    };
};

export const sendPrepared = async (ctx: InvitationContext, email: PreparedEmail) => {
    // Defence in depth: the policy was checked before any change, check again right before sending.
    const allowed = email.to.every(({ Address }) => isAllowedByPolicy(ctx.policy, Address));
    if (ctx.policy.mode === 'dry-run' || !allowed) {
        throw new InvitationActionError('The email policy changed in the meantime; this email was not sent.', 'blocked');
    }
    const payload = await buildDirectSend(ctx, email);
    const response = await ctx.api<{ Sent?: { ExternalID?: string } }>({ ...sendMessageDirect(payload as any), silence: true } as any);
    const externalId = response?.Sent?.ExternalID;
    const record: InvitationEmailRecord = { ...email.record, outcome: 'sent', at: new Date().toISOString(), ...(externalId ? { externalId } : {}) };
    ctx.onEmail?.(record);
    return record;
};

// ---------------------------------------------------------------------------------------------
// Proton writes
// ---------------------------------------------------------------------------------------------

const putAnswer = async (
    ctx: InvitationContext,
    event: CalendarEvent,
    attendeeID: string,
    answer: ICAL_ATTENDEE_STATUS,
    timestamp: number
) => {
    await ctx.api({
        ...updateAttendeePartstat(event.CalendarID, event.ID, attendeeID, {
            Status: toApiPartstat(answer),
            UpdateTime: Math.floor(timestamp / 1000),
        } as any),
        silence: true,
    } as any);
};

/**
 * getAutoUpdatePersonalPartOperation: when an answer moves between "coming" (yes/maybe) and "not
 * coming" (no answer/no), Proton re-saves your personal part (notifications and colour).
 */
const needsPersonalPartUpdate = (oldAnswer: ICAL_ATTENDEE_STATUS | undefined, answer: ICAL_ATTENDEE_STATUS) => {
    if (oldAnswer === answer) {
        return false;
    }
    const coming = (value?: ICAL_ATTENDEE_STATUS) => value === ACCEPTED || value === TENTATIVE;
    return !(coming(oldAnswer) && coming(answer));
};

/**
 * Notifications after an answer, as Proton's modifyEventModelPartstat + getUpdatePersonalEventPayload
 * produce them: "no" (and a reset to "needs action") drops them; starting to attend an event
 * without any gives the calendar's defaults (null); otherwise they stay as they are.
 */
const notificationsAfterAnswer = (
    event: CalendarEvent,
    oldAnswer: ICAL_ATTENDEE_STATUS | undefined,
    answer: ICAL_ATTENDEE_STATUS
) => {
    if (answer === DECLINED || answer === NEEDS_ACTION) {
        return [];
    }
    const current = event.Notifications;
    const startsAttending = oldAnswer === undefined || oldAnswer === NEEDS_ACTION || oldAnswer === DECLINED;
    if (startsAttending && Array.isArray(current) && current.length === 0) {
        return null;
    }
    return current ? current : null;
};

const putPersonalPart = async (
    ctx: InvitationContext,
    event: CalendarEvent,
    Notifications: CalendarEvent['Notifications'] | []
) => {
    await ctx.api({
        ...updatePersonalEventPart(event.CalendarID, event.ID, {
            Notifications,
            Color: event.Color ? event.Color : null,
        } as any),
        silence: true,
    } as any);
};

/** handleReencryptSharedEvent: invitations Proton Mail added to your calendar get calendar keys. */
const upgradeAutoAddedInvite = async (ctx: InvitationContext, event: CalendarEvent) => {
    if (!getIsAutoAddedInvite(event)) {
        return event;
    }
    const privateKeys = splitKeys(ctx.getAddressKeys(event.AddressID)).privateKeys;
    const [sharedSessionKey] = await readSessionKeys({ calendarEvent: event, privateKeys });
    if (!sharedSessionKey) {
        throw new InvitationActionError('Failed to retrieve the shared session key of the invitation', 'failed');
    }
    const calendarKeys = await ctx.getCalendarKeys(event.CalendarID);
    return reencryptCalendarSharedEvent({ calendarEvent: event, sharedSessionKey, calendarKeys, api: ctx.api });
};

export const deleteEvents = async (ctx: InvitationContext, calendarID: string, eventIDs: string[]) => {
    if (!eventIDs.length) {
        return;
    }
    const MemberID = await ctx.getMemberID(calendarID);
    const response: any = await ctx.api({
        url: `calendar/v1/${calendarID}/events/sync`,
        method: 'put',
        data: {
            MemberID,
            Events: eventIDs.map((ID) => ({ ID, DeletionReason: 0 /* DELETION_REASON.NORMAL */ })),
        },
    } as any);
    const failures = (response?.Responses || []).filter((entry: any) => entry?.Response?.Code !== 1000);
    if (failures.length) {
        const message = failures.map((entry: any) => entry?.Response?.Error || `code ${entry?.Response?.Code}`).join('; ');
        throw new InvitationActionError(`Proton refused to delete the event: ${message}`, 'failed');
    }
};

// ---------------------------------------------------------------------------------------------
// Answering
// ---------------------------------------------------------------------------------------------

interface CheckedInvitation extends ReadInvitation {
    selfAddress: Address;
    selfAttendeeIndex: number;
    token: string;
    attendeeID: string;
    oldAnswer?: ICAL_ATTENDEE_STATUS;
}

const checkInvitation = (read: ReadInvitation, { forSending }: { forSending: boolean }): CheckedInvitation => {
    if (read.isOrganizer || !read.isAttendee || !read.vevent.organizer || !getHasAttendees(read.vevent)) {
        throw new InvitationActionError('This event is not an invitation you received', 'unsupported');
    }
    const { selfAddress, selfAttendeeIndex } = read;
    if (!selfAddress || selfAttendeeIndex === undefined) {
        throw new InvitationActionError('None of your addresses is invited to this event', 'unsupported');
    }
    if (forSending && !getIsAddressActive(selfAddress)) {
        throw new InvitationActionError(
            `Your address ${selfAddress.Email} cannot send emails, so the organizer cannot be told your answer. Answer in Proton Calendar instead.`,
            'unsupported'
        );
    }
    const token = getAttendeeToken(read.vevent.attendee![selfAttendeeIndex]);
    const selfAnswer = selfAnswerOf(read.event, token);
    if (!token || !selfAnswer) {
        throw new InvitationActionError('Proton has no answer slot for you on this invitation', 'unsupported');
    }
    return {
        ...read,
        selfAddress,
        selfAttendeeIndex,
        token,
        attendeeID: selfAnswer.ID,
        oldAnswer: toIcsPartstat(selfAnswer.Status),
    };
};

/**
 * Proton's getResetPartstatActions, extended by `alignTo`: single edits whose answer differs from
 * the new series answer are reset to "needs action" — unless the caller says the user answered
 * them the same way as the series (Calendar.app's "accept all"), then they take that answer.
 * Silent (no emails), like Proton.
 */
const getSingleEditUpdates = (
    singleEdits: CalendarEvent[],
    token: string,
    answer: ICAL_ATTENDEE_STATUS,
    alignTo: Set<string>
) =>
    singleEdits
        .map((event) => {
            if (getIsEventCancelled(event)) {
                return undefined;
            }
            const selfAnswer = selfAnswerOf(event, token);
            if (!selfAnswer) {
                return undefined;
            }
            const oldAnswer = toIcsPartstat(selfAnswer.Status);
            if (oldAnswer === answer) {
                return undefined;
            }
            if (alignTo.has(event.ID)) {
                return { event, attendeeID: selfAnswer.ID, oldAnswer, answer };
            }
            if (oldAnswer === NEEDS_ACTION) {
                return undefined;
            }
            return { event, attendeeID: selfAnswer.ID, oldAnswer, answer: NEEDS_ACTION };
        })
        .filter((update): update is NonNullable<typeof update> => !!update);

export interface AnswerInvitationInput {
    calendarID: string;
    /** The Proton event answered: a single event, a series master, or an existing single edit. */
    eventID: string;
    answer: InvitationAnswer;
    /**
     * Series master only: single edits (Proton event IDs) the user gave the same answer as the
     * series. Others follow Proton's rule (reset to "needs action" when they differ).
     */
    alignSingleEditIDs?: string[];
}

export const answerInvitation = async (
    ctx: InvitationContext,
    { calendarID, eventID, answer: requestedAnswer, alignSingleEditIDs = [] }: AnswerInvitationInput
): Promise<InvitationActionResult> => {
    const answer = toIcsAnswer(requestedAnswer);
    const event = await fetchEvent(ctx.api, calendarID, eventID);
    const invitation = checkInvitation(await readInvitation(ctx, event), { forSending: true });
    const result: InvitationActionResult = { emails: [], changedEventIds: [], deletedEventIds: [], warnings: [] };

    if (getIsEventCancelled(event)) {
        throw new InvitationActionError('The organizer cancelled this event; there is nothing to answer', 'cancelled');
    }

    // Single edits of a series (only when answering the master).
    const isMaster = !invitation.vevent['recurrence-id'] && !!invitation.vevent.rrule;
    const singleEdits = isMaster
        ? (await fetchEventsByUID(ctx.api, calendarID, event.UID)).filter(({ ID }) => ID !== event.ID)
        : [];
    const aligned = new Set(alignSingleEditIDs);

    if (invitation.oldAnswer === answer) {
        // Proton already has this answer (e.g. a retry): only occurrences the user answered the
        // same way may still need it. No email, like Proton when nothing changes.
        const pending = getSingleEditUpdates(singleEdits, invitation.token, answer, aligned).filter(({ event: edit }) =>
            aligned.has(edit.ID)
        );
        if (pending.length && ctx.policy.mode === 'dry-run') {
            throw new InvitationActionError('Dry run: would update the answers of changed occurrences; nothing was changed.', 'dry-run');
        }
        await applySingleEditUpdates(ctx, pending, result);
        return result;
    }
    const singleEditUpdates = getSingleEditUpdates(singleEdits, invitation.token, answer, aligned);

    // A retry of an answer that was already emailed: finish it in Proton without a second email.
    const alreadyEmailed = wasJustEmailed(ctx, event, answer);

    // 1. Build the email and check the policy — nothing has changed in Proton yet.
    const isProtonProtonInvite = !!event.IsProtonProtonInvite;
    let email: PreparedEmail | undefined;
    if (!alreadyEmailed) {
        email = await prepareReply(ctx, {
            vevent: invitation.vevent,
            selfAddress: invitation.selfAddress,
            selfAttendeeIndex: invitation.selfAttendeeIndex,
            answer,
            isProtonProtonInvite,
        });
        await enforcePolicy(ctx, email);
    } else if (ctx.policy.mode === 'dry-run') {
        throw new InvitationActionError('Dry run: would save the answer already emailed; nothing was changed.', 'dry-run');
    } else {
        result.warnings.push('This answer had already been emailed to the organizer; it was only saved in Proton now.');
    }

    // 2. Invitations Proton Mail added to the calendar first get calendar keys.
    const upgraded = await upgradeAutoAddedInvite(ctx, event);
    const current = { ...event, ...upgraded, AttendeesInfo: event.AttendeesInfo } as CalendarEvent;
    // The answer's time must not be later than the reply's DTSTAMP: Proton Mail shows a reply
    // older than the stored answer as "out of date" to the organizer.
    const answerTime = email ? email.timestamp : +serverTime();

    // 3. Proton-Proton: answer first, then email. Otherwise: email first, then answer.
    if (isProtonProtonInvite || !email) {
        await putAnswer(ctx, current, invitation.attendeeID, answer, answerTime);
        result.changedEventIds.push(event.ID);
        if (email) {
            try {
                result.emails.push(await sendPrepared(ctx, email));
                rememberEmailed(ctx, event, answer);
            } catch (error: any) {
                const failed = { ...email.record, outcome: 'failed' as const, detail: errorText(error) };
                ctx.onEmail?.(failed);
                result.emails.push(failed);
                result.warnings.push(
                    `Your answer was saved in Proton (the organizer sees it there), but the notification email failed: ${failed.detail}`
                );
            }
        }
    } else {
        try {
            result.emails.push(await sendPrepared(ctx, email));
        } catch (error: any) {
            const failed = { ...email.record, outcome: 'failed' as const, detail: errorText(error) };
            ctx.onEmail?.(failed);
            if (!isSendRefused(error)) {
                // No answer from Proton: it may have gone out. Remembered, so answering again finishes
                // it in Proton without a second email.
                rememberEmailed(ctx, event, answer);
                throw new InvitationActionError(
                    `Your answer may have been emailed (no answer from Proton: ${failed.detail}), but it is not saved yet. ` +
                        'Answer again in a few minutes to save it without a second email.',
                    'incomplete',
                    failed
                );
            }
            if (rateLimitedUntil(error)) {
                throw rateLimitedAction('Proton asked to slow down: your answer was not sent or saved yet.', error, failed);
            }
            throw new InvitationActionError(`Your answer could not be sent: ${failed.detail}`, 'failed', failed);
        }
        rememberEmailed(ctx, event, answer);
        try {
            await withRetries(() => putAnswer(ctx, current, invitation.attendeeID, answer, answerTime));
        } catch (error: any) {
            throw new InvitationActionError(
                `Your answer was emailed to the organizer, but Proton did not save it (${errorText(error)}). ` +
                    'Answer again in a few minutes to save it without a second email, or answer in Proton Calendar.',
                'incomplete',
                result.emails[0]
            );
        }
        result.changedEventIds.push(event.ID);
    }

    // 4. Personal part (notifications) when switching between coming / not coming. Errors are
    //    swallowed by Proton too.
    if (needsPersonalPartUpdate(invitation.oldAnswer, answer)) {
        try {
            await putPersonalPart(ctx, current, notificationsAfterAnswer(current, invitation.oldAnswer, answer));
        } catch (error: any) {
            result.warnings.push(`Could not update your notifications for this event: ${errorText(error)}`);
        }
    }

    // 5. Single edits of the series (silent).
    await applySingleEditUpdates(ctx, singleEditUpdates, result);
    return result;
};

const applySingleEditUpdates = async (
    ctx: InvitationContext,
    updates: ReturnType<typeof getSingleEditUpdates>,
    result: InvitationActionResult
) => {
    for (const update of updates) {
        try {
            await putAnswer(ctx, update.event, update.attendeeID, update.answer, +serverTime());
            if (needsPersonalPartUpdate(update.oldAnswer, update.answer)) {
                await putPersonalPart(ctx, update.event, notificationsAfterAnswer(update.event, update.oldAnswer, update.answer));
            }
            result.changedEventIds.push(update.event.ID);
        } catch (error: any) {
            result.warnings.push(`Could not update the answer of a changed occurrence: ${errorText(error)}`);
        }
    }
};

// ---------------------------------------------------------------------------------------------
// Declining by deleting
// ---------------------------------------------------------------------------------------------

export interface RemoveInvitationInput {
    calendarID: string;
    /** A single event or a series master; for a master, all its single edits are removed too. */
    eventID: string;
    /** false when the user chose not to notify the organizer (CalDAV Schedule-Reply: F). */
    notifyOrganizer: boolean;
}

export const removeInvitation = async (
    ctx: InvitationContext,
    { calendarID, eventID, notifyOrganizer }: RemoveInvitationInput
): Promise<InvitationActionResult> => {
    const event = await fetchEvent(ctx.api, calendarID, eventID);
    const invitation = checkInvitation(await readInvitation(ctx, event), { forSending: false });
    const result: InvitationActionResult = { emails: [], changedEventIds: [], deletedEventIds: [], warnings: [] };

    const isMaster = !invitation.vevent['recurrence-id'] && !!invitation.vevent.rrule;
    const seriesEvents = isMaster ? await fetchEventsByUID(ctx.api, calendarID, event.UID) : [event];
    const singleEdits = seriesEvents.filter(({ ID }) => ID !== event.ID);

    // EventPopover.handleDelete: the organizer is told only if you had said yes or maybe.
    const cancelled = !!getIsEventCancelled(event);
    const saidYes = invitation.oldAnswer === ACCEPTED || invitation.oldAnswer === TENTATIVE;
    const canSend = getIsAddressActive(invitation.selfAddress);
    const sendDecline = notifyOrganizer && !cancelled && saidYes && canSend;
    if (notifyOrganizer && !cancelled && saidYes && !canSend) {
        result.warnings.push(
            `The organizer was not told you declined: your address ${invitation.selfAddress.Email} cannot send emails.`
        );
    }

    // A retry of a decline that was already emailed does not email again.
    const alreadyEmailed = sendDecline && wasJustEmailed(ctx, event, DECLINED);
    let email: PreparedEmail | undefined;
    if (sendDecline && !alreadyEmailed) {
        email = await prepareReply(ctx, {
            vevent: invitation.vevent,
            selfAddress: invitation.selfAddress,
            selfAttendeeIndex: invitation.selfAttendeeIndex,
            answer: DECLINED,
            isProtonProtonInvite: !!event.IsProtonProtonInvite,
        });
        await enforcePolicy(ctx, email);
    } else if (ctx.policy.mode === 'dry-run') {
        // Dry run changes nothing, also when no email would be needed.
        throw new InvitationActionError(
            'Dry run: would remove the invitation without emailing the organizer; nothing was changed.',
            'dry-run'
        );
    }

    // Proton sends the decline, then (silently) sets the answer so a Proton organizer sees it.
    if (email) {
        try {
            result.emails.push(await sendPrepared(ctx, email));
        } catch (error: any) {
            const failed = { ...email.record, outcome: 'failed' as const, detail: errorText(error) };
            ctx.onEmail?.(failed);
            if (!isSendRefused(error)) {
                rememberEmailed(ctx, event, DECLINED);
                throw new InvitationActionError(
                    `Your decline may have been emailed (no answer from Proton: ${failed.detail}), but the invitation is still here. ` +
                        'Delete it again in a few minutes to finish without a second email.',
                    'incomplete',
                    failed
                );
            }
            if (rateLimitedUntil(error)) {
                throw rateLimitedAction('Proton asked to slow down: your decline was not sent, the invitation stays for now.', error, failed);
            }
            throw new InvitationActionError(`Your decline could not be sent: ${failed.detail}`, 'failed', failed);
        }
        rememberEmailed(ctx, event, DECLINED);
    }
    if (email || alreadyEmailed) {
        try {
            await putAnswer(ctx, event, invitation.attendeeID, DECLINED, email ? email.timestamp : +serverTime());
        } catch (error: any) {
            result.warnings.push(`Could not record the decline in Proton before deleting: ${errorText(error)}`);
        }
    }
    // getDeleteRecurringEventActions (ALL, attendee): reset differing single-edit answers.
    for (const update of getSingleEditUpdates(singleEdits, invitation.token, DECLINED, new Set())) {
        try {
            await putAnswer(ctx, update.event, update.attendeeID, update.answer, +serverTime());
        } catch (error: any) {
            result.warnings.push(`Could not reset the answer of a changed occurrence: ${errorText(error)}`);
        }
    }
    // The bridge shows a series as one event, so removing it removes every part of it
    // (Proton's deleteSingleEdits).
    const ids = [...new Set([event.ID, ...seriesEvents.map(({ ID }) => ID)])];
    try {
        await withRetries(() => deleteEvents(ctx, calendarID, ids), email || alreadyEmailed ? 3 : 1);
    } catch (error: any) {
        if (email || alreadyEmailed) {
            throw new InvitationActionError(
                `The organizer was told you decline, but Proton did not remove the invitation (${errorText(error)}). ` +
                    'Delete it again in a few minutes (no second email), or remove it in Proton Calendar.',
                'incomplete',
                result.emails[0]
            );
        }
        throw error;
    }
    result.deletedEventIds.push(...ids);
    return result;
};
