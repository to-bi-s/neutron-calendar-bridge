// Proton Calendar API Library
// High-level interface for managing Proton Calendar events with full security handling

import { withDtendFromDuration } from './duration';
import { supportedTzid, withSupportedZones } from './zones';
import './polyfill';
import { CryptoProxy } from '@protontech/crypto';
import { createCalendar, createZoomMeeting, getBusySlots, getCalendarUserSettings, removeCalendar, setupCalendar, updateMember, updatePersonalEventPart } from '@proton/shared/lib/api/calendars';
import { srpGetVerify } from '@proton/shared/lib/srp';
import { deriveKey, encryptData } from '@protontech/crypto/subtle/aesGcm.ts';
import { utf8StringToUint8Array } from '@protontech/crypto/utils';
import { VIDEO_PROVIDER_PROTON_MEET, VIDEO_PROVIDER_ZOOM, conferenceOf, parseProtonMeetUrl, protonMeetUrl, randomString, withConference } from './video-links';
import type { VideoConference, VideoConferenceProvider } from './video-links';
import { generateCalendarKeyPayload } from '@proton/shared/lib/calendar/crypto/keys/calendarKeys';
import { ACCENT_COLORS } from '@proton/shared/lib/colors';
import { queryContactEmails } from '@proton/shared/lib/api/contacts';
import { matchInvitationLanguage } from './invitation-language';
import type { InvitationDateFormat } from './invitation-language';
import { decideReminders, notificationsOfEvent, parseAlarmBlocks, remindersOf, sameNotifications, withDecidedAlarms } from './reminders';
import type { EventReminders } from './reminders';
import { existsSync, readFileSync, unlinkSync } from 'fs';
import { createHash, randomUUID } from 'crypto';
import { homedir } from 'os';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { loadCryptoWorker } from '@proton/shared/lib/helpers/setupCryptoWorker';
import { computeKeyPassword, generateKeySalt, getSrp } from '@protontech/crypto/srp';
import fetch from 'node-fetch';

// Import the actual webapp functions
import { createCalendarEvent } from '@proton/shared/lib/calendar/serialize';
import { parse as parseVcal } from '@proton/shared/lib/calendar/vcal';
import { readCalendarEvent, readSessionKeys } from '@proton/shared/lib/calendar/deserialize';
import { getCalendarEventDecryptionKeys, getCreationKeys } from '@proton/shared/lib/calendar/crypto/keys/helpers';
import { getVeventParts } from '@proton/shared/lib/calendar/veventHelper';
import { getHasSharedKeyPacket, getHasSharedEventContent } from '@proton/shared/lib/calendar/apiModels';
import { getDecryptedAddressKeysHelper } from '@proton/shared/lib/keys/getDecryptedAddressKeys';
import { getDecryptedUserKeysHelper } from '@proton/shared/lib/keys/getDecryptedUserKeys';
import { getPrimaryKeyWithSalt } from '@proton/shared/lib/keys/keys';
import { getPrimaryKey } from '@proton/shared/lib/keys/getPrimaryKey';

// Import calendar key decryption functions
import { decryptPassphrase, decryptPassphraseSessionKey, getDecryptedCalendarKeys } from '@proton/shared/lib/calendar/crypto/keys/calendarKeys';
import { getAddressesMembersMap } from '@proton/shared/lib/calendar/crypto/keys/helpers';
import { splitKeys } from '@proton/shared/lib/keys';
import {
    DEFAULT_INVITATION_EMAIL_POLICY,
    InvitationActionError,
    rateLimitedUntil,
    answerInvitation as runAnswerInvitation,
    removeInvitation as runRemoveInvitation,
    sendDeferredEmails as runSendDeferredEmails,
    commitDeferredEmails,
} from './invitations';
import type { DeferredEmail } from './invitations';
import { cancelOrganizedEvent as runCancelOrganizedEvent, saveOrganizedEvent as runSaveOrganizedEvent } from './organizer';
import {
    applyAccountFeedPage,
    applyCalendarFeedPage,
    emptyAccountChanges,
    emptyCalendarChanges,
    MAX_FEED_PAGES,
    type AccountChanges,
    type CalendarChanges
} from './change-feed';
import type { CancelOrganizedEventInput, SaveOrganizedEventInput } from './organizer';
import { cancelOrganizedSeries, isPartOfSeries, saveOrganizedSeries as runSaveOrganizedSeries } from './organizer-series';
import { applyEmailedAnswers as runApplyEmailedAnswers } from './emailed-answers';
import { AppVersionError, RateLimitedError, RequestControl, SessionExpiredError, isNetworkError } from './request-control';
import type { AttemptResult, RequestStats } from './request-control';
import { fileCalendarEmails as runFileCalendarEmails } from './calendar-emails';
import type { CalendarEmailsState, FileCalendarEmailsInput, FileCalendarEmailsResult } from './calendar-emails';
import type { RefusedGuest } from './invitations';
import type { ApplyEmailedAnswersInput, ApplyEmailedAnswersResult, EmailedAnswersState } from './emailed-answers';
import type { SaveOrganizedSeriesInput } from './organizer-series';
import type {
    AnswerInvitationInput,
    InvitationAnswer,
    InvitationContext,
    InvitationEmailPolicy,
    InvitationEmailRecord,
    InvitationRefusalReason,
    RemoveInvitationInput,
} from './invitations';

export { AppVersionError, RateLimitedError, SessionExpiredError } from './request-control';

/**
 * The library's request control (slow-down, ended session, app version) is for the caller to handle:
 * thrown on by helpers that otherwise report failures as { success: false }.
 */
const rethrowControlError = (error: any) => {
    if (error?.name === 'RateLimitedError' || error?.name === 'SessionExpiredError' || error?.name === 'AppVersionError') {
        throw error;
    }
};

/** Proton answered with a server error (after the retries): temporary, not a reason to drop a saved session. */
const isServerTrouble = (error: any) => Number(error?.status) >= 500 || /\((5\d\d)\)/.test(String(error?.message ?? ''));
export type { RequestStats } from './request-control';

// Types and Interfaces
export interface Credentials {
    username: string;
    password: string;
    /**
     * A session saved earlier (UID, AccessToken, RefreshToken, and since 0.27 the key password):
     * used instead of signing in with the password when Proton still accepts it (renewed with the
     * refresh token if needed). With the key password saved, nothing else is needed; without it
     * (a session saved by an older version) the password unlocks the keys.
     */
    session?: AuthSession | null;
    humanVerification?: HumanVerificationChallenge | null;
    /**
     * Called with the current session after signing in and whenever it is renewed (Proton's
     * refresh tokens are single-use: keep the newest one to resume later). It carries the key
     * password: keep it as secret as the password.
     */
    onSession?: (session: SavedSession) => void;
    /**
     * Two-factor authentication (0.27): asked for the second factor after the password was accepted.
     * Return `{ code }` for an authenticator code (asked again with `wrong: true` after a wrong one),
     * or null to give up. Without it, `twoFactorCode` is used once; otherwise TwoFactorRequiredError.
     */
    askSecondFactor?: (request: SecondFactorRequest) => Promise<SecondFactorAnswer | null>;
    /**
     * The app's identity towards Proton (x-pm-appversion and User-Agent), as a third-party client
     * presents itself; without it, the library's own. 0.50: the only identity there is — the sign-in
     * is the plain SRP one (no anonymous session, no device fingerprint), and Proton may ask for a
     * CAPTCHA (HumanVerificationRequiredError) or a second factor.
     */
    appIdentity?: { appVersion: string; userAgent: string };
    /** An authenticator code to use once (command line, tests); `askSecondFactor` is preferred. */
    twoFactorCode?: string;
    /**
     * Two-password mode (0.27): asked for the mailbox (second) password, which unlocks the keys;
     * asked again with `wrong: true` after a wrong one; null gives up. Without it, `mailboxPassword`
     * is used; otherwise MailboxPasswordRequiredError.
     */
    askMailboxPassword?: (request: { wrong: boolean }) => Promise<string | null>;
    mailboxPassword?: string;
}

/** What Proton asks for after the password: an authenticator code and/or a security key. */
export interface SecondFactorRequest {
    /** An authenticator (TOTP) code is accepted. */
    totp: boolean;
    /** A security key (FIDO2) is registered; Proton's assertion options for it. */
    securityKey: boolean;
    securityKeyOptions: unknown | null;
    /** The code given before was refused. */
    wrong: boolean;
}

export type SecondFactorAnswer = { code: string } | { securityKey: SecurityKeyAssertion };

/** A FIDO2 assertion as Proton's `core/v4/auth/2fa` takes it (`FIDO2`); made by a security-key helper. */
export interface SecurityKeyAssertion {
    AuthenticationOptions: unknown;
    ClientData: string;
    AuthenticatorData: string;
    Signature: string;
    CredentialID: number[];
}

/** The account needs a second factor and none could be given (no `askSecondFactor`, or it gave up). */
export class TwoFactorRequiredError extends Error {
    constructor(public readonly request: Pick<SecondFactorRequest, 'totp' | 'securityKey'>, message?: string) {
        super(message || 'This account asks for a second factor when signing in (an authenticator code or a security key).');
        this.name = 'TwoFactorRequiredError';
    }
}

/** Two-password mode: the mailbox password is needed to unlock the keys and none could be given. */
export class MailboxPasswordRequiredError extends Error {
    constructor(message?: string) {
        super(message || 'This account has a separate mailbox password; it is needed to unlock the keys.');
        this.name = 'MailboxPasswordRequiredError';
    }
}

/** What is needed to resume a session later (keep it as secret as the password). */
export interface SavedSession {
    UID: string;
    AccessToken: string;
    RefreshToken: string;
    /**
     * The password the keys are unlocked with (derived from the login or mailbox password and the
     * key salt), as Proton's apps keep it: resuming then needs no password, code or salts (0.27).
     */
    keyPassword?: string;
    /** Proton's PasswordMode: 1 one password, 2 a separate mailbox password. */
    passwordMode?: number;
}

export interface AuthSession {
    AccessToken: string;
    RefreshToken: string;
    UID: string;
    srpSalt?: string;
    keyPassword?: string;
    passwordMode?: number;
}


export interface HumanVerificationChallenge {
    token: string;
    methods: string[];
    tokenType?: string;
    title?: string;
    description?: string;
    webUrl?: string;
    expiresAt?: number;
}

export class HumanVerificationRequiredError extends Error {
    challenge: HumanVerificationChallenge;

    constructor(challenge: HumanVerificationChallenge) {
        super(challenge.title || 'Human verification required');
        this.name = 'HumanVerificationRequiredError';
        this.challenge = challenge;
    }
}

export interface UserData {
    user: any;
    addresses: any[];
    addressKeys: any[];
    addressKeysByAddressID: Record<string, any[]>;
    userKeys: any[];
    keySalts: any[];
}

export interface CalendarData {
    calendarID: string;
    memberID: string;
    /** The address your member entry uses (the calendar's address; hosts its video conferences). */
    memberEmail?: string;
    calendarKeys: any[];
    calendarSettings: any;
    passphrase: string;
    passphraseID: string;
    rawBootstrap?: any;
}

/** An address in the account's contacts (0.33.1). */
export interface ContactAddress {
    email: string;
    /** The contact's name as Proton shows it (may be empty). */
    name: string;
    contactId: string;
}

/** 0.34: what a calendar looks like to its member — the fields Calendar.app can change. */
export interface CalendarAppearance {
    name?: string;
    /** #RRGGBB */
    color?: string;
    description?: string;
    /** 0.37: the address that owns a new calendar (one of the account's active addresses); the first active one otherwise. */
    address?: string;
}

/** A busy period of another Proton user (0.33.2, availability); unix seconds. */
export interface BusySlot {
    start: number;
    end: number;
    allDay: boolean;
}

export interface BusySchedule {
    /** Proton shares this user's busy times with the account (same organization, eligible plan). */
    accessible: boolean;
    slots: BusySlot[];
}

export interface EventData {
    title: string;
    description: string;
    location: string;
    startTime: number;
    endTime: number;
    timezone: string;
    isAllDay: boolean;
    /**
     * The event's alarms as VALARM ICS blocks (0.33, reminders): stored as Proton notifications
     * after Proton's own import rules; equal to the calendar's defaults → stored as "defaults"; a new
     * event without any → the defaults; an existing one without any → none. Undefined: as before
     * 0.33, the calendar's defaults.
     */
    alarms?: string[];
    /**
     * The event's video conference (0.34.1): set → stored as Proton's x-pm-conference properties;
     * null → removed; undefined → an existing event keeps the conference it has (Calendar.app does
     * not know these properties), a new one has none.
     */
    conference?: VideoConference | null;
}

export interface VcalVeventComponent {
    component: 'vevent';
    uid: { value: string };
    dtstamp: { value: { year: number; month: number; day: number; hours: number; minutes: number; seconds: number; isUTC: boolean } };
    dtstart: { value: { year: number; month: number; day: number; hours: number; minutes: number; seconds: number; isUTC: boolean }; parameters?: { tzid?: string } };
    dtend?: { value: { year: number; month: number; day: number; hours: number; minutes: number; seconds: number; isUTC: boolean }; parameters?: { tzid?: string } };
    summary?: { value: string };
    description?: { value: string };
    location?: { value: string };
    sequence?: { value: number };
    status?: { value: string };
}

export interface DecryptedEventContent {
    title?: string;
    summary?: string;
    description?: string;
    location?: string;
    status?: string;
    sequence?: number;
    startTime?: string;
    endTime?: string;
    startTimestamp?: number;
    endTimestamp?: number;
    timezone?: string;
    isAllDay: boolean;
    uid: string;
    id: string;
    /**
     * Date and recurrence properties exactly as decrypted from the event's signed part
     * (Proton's VcalModel shapes). Lets callers rebuild RRULE / EXDATE / RECURRENCE-ID.
     */
    vevent?: DecryptedVeventTimeProperties;
    /**
     * Your role in the event, as Proton's own apps determine it (getSelfAddressData).
     * Absent for plain events without organizer/guests.
     */
    participation?: EventParticipation;
    /** The event's reminders (0.33): Proton's notifications, or the calendar's defaults, as VALARM text. */
    reminders?: EventReminders;
    /** The event's video conference (0.34.1: Zoom or Proton Meet), if it has one. */
    conference?: VideoConference;
}

type VcalDateOrDateTimeProperty = {
    value: { year: number; month: number; day: number; hours?: number; minutes?: number; seconds?: number; isUTC?: boolean };
    parameters?: { tzid?: string; type?: string };
};

/** ORGANIZER / ATTENDEE as Proton stores them; value is a "mailto:" URI. */
export interface VcalParticipantProperty {
    value: string;
    parameters?: {
        cn?: string;
        role?: string;
        partstat?: string;
        rsvp?: string;
        'x-pm-token'?: string;
        [key: string]: unknown;
    };
}

export interface DecryptedVeventTimeProperties {
    dtstart?: VcalDateOrDateTimeProperty;
    dtend?: VcalDateOrDateTimeProperty;
    rrule?: { value: Record<string, unknown> };
    exdate?: VcalDateOrDateTimeProperty[];
    'recurrence-id'?: VcalDateOrDateTimeProperty;
    status?: { value: string };
    /** 0.49.7: "Show as: Free" (TRANSP:TRANSPARENT), a calendar-signed field; absent: busy. */
    transp?: { value: string };
    sequence?: { value: number };
    organizer?: VcalParticipantProperty;
    /** Guests, each with PARTSTAT merged in from Proton's cleartext answer list. */
    attendee?: VcalParticipantProperty[];
    /** Proton's conference properties (0.34.1), as decrypted. */
    'x-pm-conference-id'?: { value: string; parameters?: Record<string, string> };
    'x-pm-conference-url'?: { value: string; parameters?: Record<string, string> };
}

export interface EventParticipation {
    isOrganizer: boolean;
    isAttendee: boolean;
    /** Your address in this event (organizer address, or the address you were invited at). */
    selfEmail?: string;
    /** Index of your entry in `vevent.attendee` when you are a guest. */
    selfAttendeeIndex?: number;
}

/** One of the account's own addresses (for CalDAV's calendar-user-address-set). */
export interface AccountAddress {
    email: string;
    displayName: string;
    active: boolean;
    order: number;
}

export interface CalendarEvent {
    ID: string;
    UID: string;
    StartTime: number;
    EndTime: number;
    StartTimezone?: string;
    EndTimezone?: string;
    FullDay: boolean;
    IsOrganizer: boolean;
    SharedEvents: any[];
    CalendarEvents: any[];
    AttendeesEvents: any[];
    AttendeesInfo: any;
    Notifications: any;
    CalendarID: string;
    Color: string;
    ModifyTime?: number;
    CreateTime?: number;
}

/** One VEVENT of a series as handed to syncSeries: the master (no recurrence-id) or a modified occurrence. */
export interface SeriesComponentInput {
    /** Proton event ID when this component already exists in Proton; omit to create it. */
    protonEventId?: string;
    /** The VEVENT in Proton's VcalVeventComponent shape (e.g. from parseIcsToVevents). */
    vevent: VcalVeventComponent;
}

export interface SyncSeriesInput {
    calendarId: string;
    /** Components to create or update. */
    components: SeriesComponentInput[];
    /** Proton event IDs of the series that are no longer in the client's version and must go. */
    deleteEventIds?: string[];
}

export interface SyncSeriesResult {
    success: boolean;
    error?: string;
    /** For every input component (same order): the Proton event ID it now has. */
    eventIds: string[];
}

export interface BatchEventOperation {
    create?: EventData[];
    update?: { id: string; event: EventData }[];
    delete?: string[];
}

export interface BatchOperationResult {
    created: { id: string; event: EventData; success: boolean; error?: string }[];
    updated: { id: string; event: EventData; success: boolean; error?: string }[];
    deleted: { id: string; success: boolean; error?: string }[];
}

export interface CalendarInfo {
    id: string;
    name: string;
    color: string;
    description?: string;
    memberID: string;
    flags?: number;
    display?: number;
    visible?: boolean;
    sortOrder?: number;
    /** Proton calendar type: 0 personal, 1 subscribed, 2 holidays. */
    type?: number;
    /** Your member permissions (bit 16 = write). */
    permissions?: number;
    /** Your own calendar, not one someone shared with you (Proton's getIsOwnedCalendar). */
    owned?: boolean;
    /** Whether events can be changed (Proton's getIsCalendarWritable, and not disabled). */
    writable?: boolean;
    /** Why not, e.g. "subscribed calendar". */
    readOnlyReason?: string;
}

export interface SyncedCalendarEvent {
    calendarId: string;
    eventId: string;
    uid: string;
    title: string;
    description: string;
    location: string;
    startTimestamp: number;
    endTimestamp: number;
    timezone: string;
    isAllDay: boolean;
    modifiedTimestamp: number;
    contentHash: string;
    raw: CalendarEvent;
    decrypted: DecryptedEventContent;
}

// Mock verification function
/**
 * Result of an invitation action: answering or removing an invitation, or saving or deleting a
 * meeting you organize. Every email it involves went through the email policy.
 */
/** An email as findMailboxMessages lists it (no content). */
export interface MailboxMessage {
    id: string;
    /** The email's Message-ID (the same in the sender's and the recipients' copies). */
    externalId?: string;
    subject: string;
    /** When it arrived or was sent (Unix seconds). */
    time: number;
    from: string;
    to: string[];
    labelIds: string[];
}

export interface InvitationOutcome {
    success: boolean;
    /** Why the action did not happen (success false). */
    error?: string;
    /**
     * blocked: test-mode allowlist; dry-run: only simulated; unsupported: not possible here;
     * incomplete: the organizer or guests were emailed but Proton did not take the change
     * (retrying within a few minutes finishes it without a second email); stale: the meeting
     * changed in Proton since the caller's copy (nothing sent); failed: an error before anything
     * was sent; rate-limited: Proton asked to slow down before anything was sent (try again at
     * retryAt).
     */
    reason?: InvitationRefusalReason;
    /** rate-limited: when Proton accepts requests again (Unix ms). */
    retryAt?: number;
    /**
     * rate-limited: an event left in Proton without guests (a new meeting's or occurrence's first
     * step), not removed during the slow-down: remove it once Proton's time is up.
     */
    leftover?: { calendarID: string; eventID: string };
    emails: InvitationEmailRecord[];
    changedEventIds: string[];
    deletedEventIds: string[];
    /** Problems after Proton was already changed; the action itself stands. */
    warnings: string[];
    /**
     * Meetings you organize: the Proton event saved (also on an 'incomplete' create, where it
     * exists without its guests) and its Proton UID, which for a new event differs from the
     * UID the calendar app sent.
     */
    eventId?: string;
    protonUid?: string;
    /**
     * Meetings you organize saved with withoutRefusedGuests: new guests left out because they
     * could not be invited (test mode, or Proton cannot email them). The save itself stands.
     */
    droppedGuests?: RefusedGuest[];
}

export type {
    AnswerInvitationInput,
    RefusedGuest,
    InvitationAnswer,
    InvitationEmailMode,
    InvitationEmailPolicy,
    InvitationEmailRecord,
    InvitationRefusalReason,
    InvitationEmailKind,
    InvitationEmailMethod,
    RemoveInvitationInput,
} from './invitations';
export type { CancelOrganizedEventInput, SaveOrganizedEventInput } from './organizer';
export type { SaveOrganizedSeriesInput } from './organizer-series';
export type { ApplyEmailedAnswersInput, ApplyEmailedAnswersResult, EmailedAnswer, EmailedAnswerValue, IgnoredEmail } from './emailed-answers';
export type {
    CalendarEmailDestination,
    CalendarEmailKind,
    FileCalendarEmailsInput,
    FileCalendarEmailsResult,
    FiledEmail,
    GoneMeeting,
    LeftEmail,
} from './calendar-emails';

/**
 * Proton's rule for whether events in a calendar can be changed (getIsCalendarWritable: a
 * personal calendar with write permission), plus disabled calendars, which Proton's apps do not
 * let you edit either. Subscribed (Type 1) and holidays (Type 2) calendars are read-only.
 */
export const getCalendarWritability = (type: unknown, permissions: unknown, flags: unknown) => {
    const CALENDAR_TYPE_PERSONAL = 0;
    const CALENDAR_TYPE_SUBSCRIPTION = 1;
    const CALENDAR_TYPE_HOLIDAYS = 2;
    const PERMISSION_WRITE = 16;
    const FLAG_SELF_DISABLED = 32;
    const FLAG_SUPER_OWNER_DISABLED = 64;
    if (type === CALENDAR_TYPE_SUBSCRIPTION) {
        return { writable: false, readOnlyReason: 'subscribed calendar' };
    }
    if (type === CALENDAR_TYPE_HOLIDAYS) {
        return { writable: false, readOnlyReason: 'holidays calendar' };
    }
    if (typeof type === 'number' && type !== CALENDAR_TYPE_PERSONAL) {
        return { writable: false, readOnlyReason: 'calendar type the bridge does not know' };
    }
    if (typeof permissions === 'number' && (permissions & PERMISSION_WRITE) === 0) {
        return { writable: false, readOnlyReason: 'calendar shared with you to view only' };
    }
    if (typeof flags === 'number' && (flags & (FLAG_SELF_DISABLED | FLAG_SUPER_OWNER_DISABLED)) !== 0) {
        return { writable: false, readOnlyReason: 'disabled calendar' };
    }
    return { writable: true, readOnlyReason: undefined as string | undefined };
};

export const PARTICIPANTS_WRITE_REFUSED =
    'This event has an organizer or guests. Changing it needs invitation emails, which are not supported yet; ' +
    'change it in Proton Calendar instead.';

const mockGetVerificationPreferences = async (email: string) => {
    return {
        email,
        isInternal: true,
        isContact: false,
        isContactGroup: false,
        isWritable: true,
        isOwnAddress: false,
        verifyingKeys: [],
        apiKeys: [],
        pinnedKeys: []
    };
};

/**
 * 0.50: the library's own identity towards Proton when the app gives none — "Other" is the app
 * version Proton accepts from a third-party client without a product name of its own; the
 * User-Agent names the library. The library no longer presents itself as any Proton app.
 */
const LIBRARY_VERSION = (() => {
    try {
        return String(JSON.parse(readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8')).version || '0');
    } catch {
        return '0';
    }
})();
const OWN_APP_VERSION = 'Other';
const OWN_USER_AGENT = `proton-calendar-client/${LIBRARY_VERSION} (+https://github.com/to-bi-s/neutron-calendar-bridge)`;
/** How long Proton's "Invitation language" setting is kept before it is read again. */
const PROTON_INVITE_LOCALE_TTL_MS = 10 * 60_000;
/** After a failed read (Proton unreachable), no new attempt for this long. */
const PROTON_INVITE_LOCALE_RETRY_MS = 60_000;
const MAIL_API_BASE_URL = 'https://mail-api.proton.me';
const CALENDAR_API_BASE_URL = 'https://calendar-api.proton.me';
/** Proton Meet's own API (0.34.2): rooms are read, renamed and removed here; the mail/calendar hosts only create them. */
const MEET_API_BASE_URL = 'https://meet-api.proton.me';
const CLIENT_STATE_DIR = process.env.PROTON_CALENDAR_CLIENT_STATE_DIR
    ? resolve(process.env.PROTON_CALENDAR_CLIENT_STATE_DIR)
    : resolve(homedir(), '.proton-calendar-client');
/** 0.50: the device profile of the iOS-app identity, no longer used; removed when found. */
const OLD_DEVICE_PROFILE_PATH = join(CLIENT_STATE_DIR, '.native-device-profile.json');

/** 0.50: the old identity's device profile is removed once; nothing of the client's state names a device any more. */
const removeOldDeviceProfile = () => {
    try {
        if (existsSync(OLD_DEVICE_PROFILE_PATH)) {
            unlinkSync(OLD_DEVICE_PROFILE_PATH);
            console.log('[session] removed the device profile of the former app identity');
        }
    } catch {
        // not ours to change
    }
};
const DEFAULT_EVENT_PAGE_SIZE = 100;
/** A request without an answer after this long is given up (and, if a read, tried again). */
const REQUEST_TIMEOUT_MS = 60_000;
const DEFAULT_EVENTS_LOOKBACK_YEARS = 5;
const DEFAULT_EVENTS_LOOKAHEAD_YEARS = 5;
const MAX_EVENT_QUERY_WINDOW_DAYS = 90;
const EVENT_QUERY_TYPES = [0, 1, 2, 3];
const EVENT_CACHE_TTL_MS = 30_000;
const MAX_EVENT_DECRYPTION_CONCURRENCY = 8;
/** Decrypted events kept for reuse (an unchanged event is not decrypted again). */
const MAX_DECRYPTED_EVENTS_KEPT = 10_000;

/** Answers to a feed request that mean "this cursor is unknown here": start from the current one. */
const isLostCursorStatus = (status: number) => status === 400 || status === 404 || status === 410 || status === 422;

export interface DecryptStats {
    /** Events decrypted (attempts, successful or not). */
    decrypted: number;
    /** Events served from the decrypted copy because nothing about them changed. */
    reused: number;
    /** Decrypted events kept right now. */
    cached: number;
}

interface TimedCacheEntry<T> {
    cachedAt: number;
    value: T;
}

const getLocaleParts = () => {
    const fallback = { locale: 'en-US', language: 'en', region: 'US' };
    const locale = Intl.DateTimeFormat().resolvedOptions().locale || fallback.locale;

    try {
        const parsed = new Intl.Locale(locale);
        return {
            locale,
            language: parsed.language || fallback.language,
            region: parsed.region || fallback.region
        };
    } catch {
        const [language = fallback.language, region = fallback.region] = locale.replace('_', '-').split('-');
        return { locale, language, region };
    }
};

/** x-pm-locale as Proton's clients send it (language_REGION of this computer). */
const localeHeader = () => {
    const { language, region } = getLocaleParts();
    return `${language || 'en'}_${region || 'US'}`;
};

/** A fingerprint of everything Proton sends about an event (its encrypted parts included). */
const eventFingerprint = (event: CalendarEvent) => createHash('sha256').update(JSON.stringify(event)).digest('base64');

const rollingHash = (value: string) => {
    let hash = 0;
    for (let index = 0; index < value.length; index += 1) {
        hash = ((hash << 5) - hash + value.charCodeAt(index)) | 0;
    }
    return hash;
};

/**
 * Proton Calendar API Client
 * High-level interface for managing Proton Calendar events
 */
/**
 * Proton only accepts its own accent colours for a calendar ("Color is not in allowed color
 * list"): #RGB, #RRGGBB or Calendar.app's #RRGGBBAA becomes the nearest of them (Proton's
 * `getClosestProtonColor` does the same, with a slip that ignores green; this one does not).
 * A colour that already is one of Proton's is kept as spelled by Proton.
 */
export const normalizeCalendarColor = (value: string, current?: string) => {
    const parse = (text: string) => {
        const match = text.trim().match(/^#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/);
        if (!match) {
            return null;
        }
        const hex = match[1].length === 3 ? match[1].split('').map((digit) => digit + digit).join('') : match[1].slice(0, 6);
        return [0, 2, 4].map((index) => parseInt(hex.slice(index, index + 2), 16));
    };
    const wanted = parse(value);
    if (!wanted) {
        throw new Error(`Not a colour: ${value}`);
    }
    const distance = (a: number[], b: number[]) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;
    const ranked = [...ACCENT_COLORS].sort((a, b) => distance(parse(a)!, wanted) - distance(parse(b)!, wanted));
    // 0.42.2: a new colour picked for a calendar always changes it. When Proton's colour closest to the
    // one picked is the calendar's colour already (Calendar.app's yellow on an orange calendar), the next
    // closest is taken — before, the change came back as the old colour. A colour (nearly) the same as the
    // calendar's own keeps it.
    const own = current ? parse(current) : null;
    if (own && distance(own, wanted) > 3 * 12 ** 2 && ranked.length > 1 && distance(parse(ranked[0])!, own) === 0) {
        return ranked[1];
    }
    return ranked[0];
};

export class ProtonCalendarAPI {
    private session: AuthSession | null = null;
    private userData: UserData | null = null;
    private calendarData: CalendarData | null = null;
    private calendarDataById = new Map<string, CalendarData>();
    private credentials: Credentials;
    private rawEventWindowCache = new Map<string, TimedCacheEntry<CalendarEvent[]>>();
    /** Decrypted events by calendar and event ID, with a fingerprint of the encrypted parts they came from. */
    private decryptedByEvent = new Map<string, { fingerprint: string; value: DecryptedEventContent }>();
    private decryptStats = { decrypted: 0, reused: 0 };
    /** The password the keys are unlocked with (memory, and handed to onSession with the session). */
    private keyPassword: string | null = null;
    /** Proton's PasswordMode (1 one password, 2 a separate mailbox password), once known. */
    private passwordMode: number | null = null;
    private decryptedEventWindowCache = new Map<string, TimedCacheEntry<DecryptedEventContent[]>>();
    private invitationPolicy: InvitationEmailPolicy = { ...DEFAULT_INVITATION_EMAIL_POLICY };
    private invitationProdId = '-//proton-calendar-client//EN';
    private invitationEmailListener?: (record: InvitationEmailRecord) => void;
    private sentInvitationReplies = new Map<string, { answer: InvitationAnswer; at: number }>();
    private pendingOrganizerEmails = new Map<string, { fingerprints: string[]; at: number; stamp: string }>();
    /** 0.41 (bridge): emails to guests that wait for Proton's slow-down to end (in memory). */
    private deferredEmails: DeferredEmail[] = [];
    /** Answer emails handled during this run of the app (stage 4); the caller keeps the cursor. */
    private emailedAnswersState: EmailedAnswersState = { processed: new Map(), failures: new Map() };
    private calendarEmailsState: CalendarEmailsState = { emails: new Map() };
    /** Every request goes through this: Proton's pauses, the budget, retries, statistics. */
    private control = new RequestControl();
    /** node-fetch (replaceable in tests). */
    private fetchImpl: (url: string, init: any) => Promise<any> = fetch as any;
    private protonInviteLocale: { code: string | null; timeFormat: 12 | 24 | null; at: number } | null = null;
    private protonInviteLocaleFailedAt = 0;
    private protonInviteLocaleRead: Promise<string | null> | null = null;
    /** Bumped when the access token is renewed (a 401 for an older token just retries). */
    private sessionGeneration = 0;
    private renewing: Promise<boolean> | null = null;

    constructor(credentials: Credentials) {
        this.credentials = credentials;
    }

    /** Requests, answers, pauses, sign-ins and session renewals so far. */
    getRequestStats(): RequestStats {
        return this.control.stats();
    }

    /**
     * Ends the session at Proton (like signing out in Proton's apps), so a saved copy of it is no
     * longer usable. Best effort: a failure (offline) is only logged.
     */
    async signOut(): Promise<void> {
        if (this.session?.AccessToken) {
            try {
                const result = await this.makeApiRequest('core/v4/auth', 'DELETE');
                if (result.status !== 200) {
                    console.warn(`[session] ending the session at Proton was refused (${result.status})`);
                }
            } catch (error) {
                console.warn(`[session] could not end the session at Proton: ${error instanceof Error ? error.message : String(error)}`);
            }
        }
        // userData stays: work still running on this object then fails on the missing session, not on keys.
        this.session = null;
    }

    getSession(): AuthSession | null {
        return this.session ? { ...this.session } : null;
    }

    /**
     * Initialize the API client with authentication and key setup
     */
    async initialize(): Promise<void> {
        console.log('🔐 Initializing Proton Calendar API...');
        
        // Step 1: Authenticate, or reuse a supplied session if present.
        let resumed = false;
        removeOldDeviceProfile();
        if (this.credentials.session?.UID && this.credentials.session?.AccessToken) {
            console.log('Using supplied session from credentials');
            this.session = { ...this.credentials.session };
            // Saved with the session (0.27): the keys are unlocked with it, no password or salts needed.
            this.keyPassword = this.credentials.session.keyPassword || null;
            this.passwordMode = this.credentials.session.passwordMode || null;
            resumed = true;
        } else {
            this.session = await this.authenticate();
        }

        // Calendar key decryption uses CryptoProxy even when we reuse a saved session.
        await loadCryptoWorker(); // OpenPGP.js 6 enforces the packet grammar by default
        
        // Step 2: Get user data and decrypt keys
        try {
            this.userData = await this.getUserData();
            if (resumed && !this.isAccountOf(this.userData, this.credentials.username)) {
                throw new Error('the saved session belongs to another account');
            }
        } catch (error) {
            // The saved session cannot be used (ended, another account, keys not unlocked with this
            // password): sign in with the password instead. Not for a lost connection or a slow-down.
            if (!resumed || isNetworkError(error) || error instanceof RateLimitedError || error instanceof AppVersionError || isServerTrouble(error)) {
                throw error;
            }
            if (!this.credentials.password) {
                // No password kept (the bridge since 0.45): the user signs in again.
                throw new SessionExpiredError(`Proton ended the session (${error instanceof Error ? error.message : String(error)}): sign in again.`);
            }
            console.log(`[session] the saved session cannot be used (${error instanceof Error ? error.message : String(error)}): signing in with the password`);
            resumed = false;
            this.keyPassword = null;
            this.session = await this.authenticate();
            this.userData = await this.getUserData();
        }
        if (resumed) {
            this.control.noteResumedSession();
        }
        this.emitSession();
        
        // Step 3: Get first available calendar
        const calendars = await this.getCalendars();
        if (calendars.length === 0) {
            throw new Error('No calendars found');
        }
        
        // Step 4: Setup calendar data
        this.calendarData = await this.getCalendarData(calendars[0].id);
        this.calendarDataById.set(this.calendarData.calendarID, this.calendarData);
        
        console.log('✅ Proton Calendar API initialized successfully');
    }

    /**
     * Get all available calendars
     */
    async getCalendars(): Promise<CalendarInfo[]> {
        if (!this.session) {
            throw new Error('API not initialized. Call initialize() first.');
        }

        const response = await this.makeCalendarRequest('calendar/v1', 'GET', undefined, {
            OrderBy: 1,
            ReturnFlags: 1
        });
        if (response.status !== 200) {
            throw new Error('Failed to retrieve calendars');
        }

        const calendars = response.data.Calendars || [];
        return calendars.map((cal: any) => {
            const member = cal.Members?.[0];
            // Like Proton's getVisualCalendar: permissions and (disabled) flags are the member's.
            const { writable, readOnlyReason } = getCalendarWritability(cal.Type, member?.Permissions, member?.Flags);
            return {
                id: cal.ID,
                name: member?.Name || 'Unnamed Calendar',
                color: member?.Color || '#5865F2',
                description: member?.Description || '',
                memberID: member?.ID,
                flags: cal.Flags,
                // Display (shown or hidden) is the member's setting, like the name and the colour.
                display: member?.Display ?? cal.Display,
                visible: (member?.Display ?? cal.Display) !== 0,
                sortOrder: cal.Order,
                type: cal.Type,
                permissions: member?.Permissions,
                // getIsOwnedCalendar: yours, not shared with you by someone else.
                owned: cal.Owner?.Email ? cal.Owner.Email === member?.Email : undefined,
                writable,
                readOnlyReason
            };
        });
    }

    /**
     * Get all available calendars with decrypted names
     * This method reuses getCalendarData() to decrypt calendar metadata
     */
    async getCalendarsWithDecryptedNames(): Promise<CalendarInfo[]> {
        if (!this.session || !this.userData) {
            throw new Error('API not initialized. Call initialize() first.');
        }

        // Try to get calendars from v2 endpoint first, which might have decrypted names
        let calendars;
        try {
            const v2Response = await this.makeCalendarRequest('calendar/v2');
            if (v2Response.status === 200 && v2Response.data.Calendars) {
                calendars = v2Response.data.Calendars;
                console.log('Using calendar/v2 endpoint');
            } else {
                // Fallback to v1 endpoint
                calendars = await this.getCalendars();
                console.log('Using calendar/v1 endpoint (fallback)');
            }
        } catch (error) {
            // Fallback to v1 endpoint
            calendars = await this.getCalendars();
            console.log('Using calendar/v1 endpoint (fallback)');
        }
        
        // For each calendar, get the decrypted data
        const decryptedCalendars = await Promise.all(
            calendars.map(async (cal) => {
                try {
                    // Reuse our existing method that gets bootstrap data and decrypts keys
                    const calendarData = await this.getCalendarData(cal.id);
                    
                    // Check if there's encrypted calendar metadata in the bootstrap
                    // The calendar name might be encrypted and stored in the bootstrap data
                    console.log(`Raw bootstrap response for calendar ${cal.id.substring(0, 8)}...`);
                    
                    return {
                        id: cal.id,
                        name: 'Calendar ' + cal.id.substring(0, 8), // Temporary name until we find where names are stored
                        color: '#5865F2', // Default color
                        description: '',
                        memberID: cal.memberID,
                        // Return the decrypted keys for the caller to use
                        decryptedKeys: calendarData.calendarKeys,
                        passphrase: calendarData.passphrase,
                        // Also return the full bootstrap data for debugging
                        bootstrap: calendarData
                    };
                } catch (error) {
                    console.warn(`Failed to decrypt calendar ${cal.id}:`, error);
                    return cal; // Return the encrypted version as fallback
                }
            })
        );

        return decryptedCalendars;
    }

    /**
     * Get all events in the current calendar
     */
    async getEvents(calendarId?: string): Promise<CalendarEvent[]> {
        if (!this.session) {
            throw new Error('API not initialized. Call initialize() first.');
        }

        const calendarData = await this.resolveCalendarData(calendarId);
        const { startTimestamp, endTimestamp } = this.getDefaultEventWindow();
        return this.getEventsForWindow(calendarData.calendarID, startTimestamp, endTimestamp);
    }

    /**
     * Get a specific event by ID
     */
    async getEvent(eventId: string, calendarId?: string): Promise<CalendarEvent | null> {
        if (!this.session) {
            throw new Error('API not initialized. Call initialize() first.');
        }

        const calendarData = await this.resolveCalendarData(calendarId);
        const response = await this.makeCalendarRequest(`calendar/v1/${calendarData.calendarID}/events/${eventId}`);
        if (response.status !== 200) {
            return null;
        }

        return response.data.Event;
    }

    /**
     * Create a single event
     */
    async createEvent(eventData: EventData, calendarId?: string): Promise<{ id: string; success: boolean; error?: string }> {
        eventData = { ...eventData, timezone: supportedTzid(eventData.timezone) }; // 0.40.1: a zone Proton accepts
        if (!this.session || !this.userData) {
            throw new Error('API not initialized. Call initialize() first.');
        }

        try {
            const calendarData = await this.resolveCalendarData(calendarId);
            const reminders = this.remindersFor(withConference(this.createVeventComponent(eventData), eventData.conference ?? null), eventData, calendarData, true);
            const veventComponent = reminders.vevent;
            const creationKeys = await getCreationKeys({
                newAddressKeys: this.userData.addressKeys,
                newCalendarKeys: calendarData.calendarKeys
            });

            const calendarEventData = await createCalendarEvent({
                eventComponent: veventComponent,
                isCreateEvent: true,
                isSwitchCalendar: false,
                hasDefaultNotifications: reminders.hasDefaultNotifications,
                ...creationKeys
            });

            const syncData = {
                MemberID: calendarData.memberID,
                Events: [{
                    Overwrite: 0,
                    Event: {
                        Permissions: 3,
                        IsOrganizer: 1,
                        IsPersonalSingleEdit: false,
                        StartTime: eventData.startTime,
                        StartTimezone: eventData.timezone,
                        EndTime: eventData.endTime,
                        EndTimezone: eventData.timezone,
                        FullDay: eventData.isAllDay ? 1 : 0,
                        UID: veventComponent.uid.value,
                        ...calendarEventData
                    }
                }]
            };

            const response = await this.makeCalendarRequest(`calendar/v1/${calendarData.calendarID}/events/sync`, 'PUT', syncData);
            
            if (response.status === 200 && response.data.Responses?.[0]?.Response?.Event) {
                this.invalidateEventCaches(calendarData.calendarID);
                return {
                    id: response.data.Responses[0].Response.Event.ID,
                    success: true
                };
            } else {
                return {
                    id: '',
                    success: false,
                    error: 'Failed to create event'
                };
            }
        } catch (error: any) {
            rethrowControlError(error);
            return {
                id: '',
                success: false,
                error: error.message
            };
        }
    }

    /**
     * Update a single event
     */
    async updateEvent(eventId: string, eventData: EventData, calendarId?: string): Promise<{ success: boolean; error?: string }> {
        eventData = { ...eventData, timezone: supportedTzid(eventData.timezone) }; // 0.40.1: a zone Proton accepts
        if (!this.session || !this.userData) {
            throw new Error('API not initialized. Call initialize() first.');
        }

        try {
            const calendarData = await this.resolveCalendarData(calendarId);
            const existingEvent = await this.getEvent(eventId, calendarData.calendarID);
            if (!existingEvent) {
                return {
                    success: false,
                    error: 'Event not found'
                };
            }
            if (this.rawEventHasParticipants(existingEvent)) {
                // This path rebuilds the event from title/time/location only and would wipe the guest list.
                return { success: false, error: PARTICIPANTS_WRITE_REFUSED };
            }

            const decryptedExisting = await this.decryptCalendarEvent(existingEvent, calendarData);
            // The conference stays unless the caller says otherwise (Calendar.app never sends it); when
            // the existing event cannot be read, it is left out as before 0.34.1 rather than guessed.
            const conference = eventData.conference === undefined ? (decryptedExisting ? conferenceOf(decryptedExisting.vevent as any) ?? null : null) : eventData.conference;
            const reminders = this.remindersFor(withConference(this.createVeventComponent(eventData, existingEvent.UID), conference), eventData, calendarData, false);
            const veventComponent = reminders.vevent;
            // Proton refuses time changes unless SEQUENCE grows ("Cannot update time data without
            // also incrementing Sequence"), so always send one more than it currently holds.
            const currentSequence = typeof decryptedExisting?.sequence === 'number' && Number.isFinite(decryptedExisting.sequence) ? decryptedExisting.sequence : undefined;
            veventComponent.sequence = { value: (currentSequence ?? 0) + 1 };
            const creationKeys = await getCreationKeys({
                calendarEvent: existingEvent,
                newAddressKeys: this.userData.addressKeys,
                newCalendarKeys: calendarData.calendarKeys
            });

            const calendarEventData = await createCalendarEvent({
                eventComponent: veventComponent,
                isCreateEvent: false,
                isSwitchCalendar: false,
                hasDefaultNotifications: reminders.hasDefaultNotifications,
                ...creationKeys
            });

            const syncData = {
                MemberID: calendarData.memberID,
                Events: [{
                    ID: eventId,
                    Event: {
                        Permissions: 3,
                        IsOrganizer: 1,
                        IsBreakingChange: 0,
                        IsPersonalSingleEdit: false,
                        ...calendarEventData
                    }
                }]
            };

            const response = await this.makeCalendarRequest(`calendar/v1/${calendarData.calendarID}/events/sync`, 'PUT', syncData);
            const updateResponse = response.data?.Responses?.[0]?.Response;
            const success = response.status === 200 && updateResponse?.Code === 1000;

            if (success) {
                this.invalidateEventCaches(calendarData.calendarID);
            }

            return {
                success,
                error: success ? undefined : updateResponse?.Error || 'Failed to update event'
            };
        } catch (error: any) {
            rethrowControlError(error);
            return {
                success: false,
                error: error.message
            };
        }
    }

    /**
     * Parses an iCalendar string into Proton-shaped VEVENT components (RRULE, EXDATE,
     * RECURRENCE-ID and alarms included). Pure helper: no network, no session needed.
     */
    parseIcsToVevents(ics: string): VcalVeventComponent[] {
        const parsed: any = parseVcal(ics);
        if (parsed?.component === 'vevent') {
            return [withSupportedZones(withDtendFromDuration(parsed as VcalVeventComponent))];
        }
        const components: any[] = Array.isArray(parsed?.components) ? parsed.components : [];
        // 0.40 (bridge): DURATION becomes DTEND (Proton stores only DTEND). 0.40.1: time zones by the
        // names Proton accepts (macOS writes e.g. Asia/Calcutta, Proton refuses all but Asia/Kolkata).
        return (components.filter((component) => component?.component === 'vevent') as VcalVeventComponent[]).map((vevent) =>
            withSupportedZones(withDtendFromDuration(vevent))
        );
    }

    /**
     * Writes a whole series (master + modified occurrences) to Proton in ONE sync request:
     * components with a protonEventId are updated, the others created, and deleteEventIds removed.
     * Also works for a single non-recurring event (one component, no recurrence properties).
     *
     * Proton derives StartTime/EndTime/RRule/Exdates/RecurrenceID from the signed VEVENT,
     * so the caller only has to get the VEVENT right. Alarms (VALARM) become the event's reminders
     * (0.33: Proton's import rules; equal to the calendar's defaults → "defaults"; a new component
     * without any → the defaults; an existing one without any → none). If the request partly fails,
     * Proton applies nothing.
     */
    async syncSeries(input: SyncSeriesInput): Promise<SyncSeriesResult> {
        if (!this.session || !this.userData) {
            throw new Error('API not initialized. Call initialize() first.');
        }

        const failure = (error: string): SyncSeriesResult => ({ success: false, error, eventIds: [] });
        if (!input.components.length && !input.deleteEventIds?.length) {
            return { success: true, eventIds: [] };
        }

        try {
            const calendarData = await this.resolveCalendarData(input.calendarId);
            const uid = input.components[0]?.vevent?.uid?.value;
            if (input.components.some((component) => component.vevent?.uid?.value !== uid)) {
                return failure('All components of a series must share one UID');
            }

            // Guests can't be sent invitations from here yet, so no write may add, keep-by-rewriting,
            // or delete an event that involves other people.
            if (input.components.some(({ vevent }) => (vevent as any)?.organizer || (vevent as any)?.attendee?.length)) {
                return failure(PARTICIPANTS_WRITE_REFUSED);
            }

            const events: any[] = [];
            for (const component of input.components) {
                const existing = component.protonEventId
                    ? await this.getEvent(component.protonEventId, calendarData.calendarID)
                    : null;
                if (component.protonEventId && !existing) {
                    return failure(`Proton event ${component.protonEventId} not found`);
                }
                if (this.rawEventHasParticipants(existing)) {
                    return failure(PARTICIPANTS_WRITE_REFUSED);
                }
                const prepared = this.prepareVeventForProton(
                    component.vevent,
                    existing ? await this.getCurrentSequence(existing, calendarData) : undefined
                );
                // A new exception Calendar.app sends carries the alarms it shows (copied from the master),
                // so none means none; only a brand-new event without alarms gets the defaults.
                const reminders = decideReminders(component.vevent as any, calendarData.calendarSettings, { isCreate: !existing && !(component.vevent as any)['recurrence-id'] });
                const vevent = withDecidedAlarms(prepared, reminders);

                const creationKeys = await getCreationKeys({
                    calendarEvent: (existing || undefined) as any,
                    newAddressKeys: this.userData.addressKeys,
                    newCalendarKeys: calendarData.calendarKeys
                });
                const calendarEventData = await createCalendarEvent({
                    eventComponent: vevent,
                    isCreateEvent: !existing,
                    isSwitchCalendar: false,
                    hasDefaultNotifications: reminders.hasDefaultNotifications,
                    ...creationKeys
                });

                events.push(
                    existing
                        ? {
                              ID: existing.ID,
                              Event: {
                                  Permissions: 3,
                                  IsOrganizer: 1,
                                  IsBreakingChange: 0,
                                  IsPersonalSingleEdit: false,
                                  ...calendarEventData
                              }
                          }
                        : {
                              Overwrite: 0,
                              Event: {
                                  Permissions: 3,
                                  IsOrganizer: 1,
                                  IsPersonalSingleEdit: false,
                                  ...calendarEventData
                              }
                          }
                );
            }
            for (const eventId of input.deleteEventIds || []) {
                const existing = await this.getEvent(eventId, calendarData.calendarID);
                if (this.rawEventHasParticipants(existing)) {
                    return failure(PARTICIPANTS_WRITE_REFUSED);
                }
                events.push({ ID: eventId, DeletionReason: 0 });
            }

            const response = await this.makeCalendarRequest(
                `calendar/v1/${calendarData.calendarID}/events/sync`,
                'PUT',
                { MemberID: calendarData.memberID, Events: events }
            );
            const responses: any[] = response.data?.Responses || [];
            const failed = responses.find((entry) => entry?.Response?.Code !== 1000);
            if (response.status !== 200 || failed) {
                const detail = failed?.Response?.Error || failed?.Response?.Code || response.data?.Error;
                return failure(`Proton rejected the series update${detail ? `: ${detail}` : ''}`);
            }

            this.invalidateEventCaches(calendarData.calendarID);
            const eventIds = input.components.map((component, index) => {
                const returned = responses[index]?.Response?.Event?.ID;
                return component.protonEventId || returned || '';
            });
            if (eventIds.some((id) => !id)) {
                return failure('Proton did not return an ID for a created event');
            }
            return { success: true, eventIds };
        } catch (error: any) {
            rethrowControlError(error);
            return failure(error?.message || String(error));
        }
    }

    /**
     * The reminders of an event written from EventData (0.33): the VALARM blocks the client sent,
     * decided against the calendar's defaults, attached to the VEVENT handed to Proton.
     */
    private remindersFor(vevent: VcalVeventComponent, eventData: EventData, calendarData: CalendarData, isCreate: boolean) {
        if (!eventData.alarms) {
            // As before 0.33: the calendar's defaults.
            return { vevent, hasDefaultNotifications: true };
        }
        const withAlarms = { ...vevent, components: parseAlarmBlocks(eventData.alarms) } as VcalVeventComponent;
        const decision = decideReminders(withAlarms as any, calendarData.calendarSettings, { isCreate });
        return { vevent: withDecidedAlarms(vevent, decision), hasDefaultNotifications: decision.hasDefaultNotifications };
    }

    /**
     * Sets an event's reminders alone (0.33), through Proton's personal-part endpoint — what
     * Proton Calendar does when only the notifications of an event change, so a meeting's guests
     * are not emailed and the event's SEQUENCE does not move. Works for events you organize and
     * invitations alike. `alarms`: the VALARM blocks from the client's ICS for this component.
     * Returns changed=false when Proton already stores the same reminders.
     */
    async setEventReminders(calendarId: string, eventId: string, alarms: string[]): Promise<{ success: boolean; changed: boolean; error?: string }> {
        if (!this.session || !this.userData) {
            throw new Error('API not initialized. Call initialize() first.');
        }
        try {
            const calendarData = await this.resolveCalendarData(calendarId);
            const existing = await this.getEvent(eventId, calendarData.calendarID);
            if (!existing) {
                return { success: false, changed: false, error: 'Event not found' };
            }
            const decrypted = await this.decryptCalendarEvent(existing, calendarData);
            if (!decrypted?.vevent?.dtstart) {
                return { success: false, changed: false, error: 'The event could not be read' };
            }
            const vevent = { component: 'vevent', dtstart: decrypted.vevent.dtstart, components: parseAlarmBlocks(alarms) } as unknown as VcalVeventComponent;
            const decision = decideReminders(vevent as any, calendarData.calendarSettings, { isCreate: false });
            const current = notificationsOfEvent(existing);
            const unchanged = decision.hasDefaultNotifications ? current === null : current !== null && sameNotifications(current, decision.notifications);
            if (unchanged) {
                return { success: true, changed: false };
            }
            await this.protonApi(
                updatePersonalEventPart(calendarData.calendarID, existing.ID, {
                    Notifications: decision.notifications as any,
                    Color: existing.Color ? existing.Color : null
                } as any)
            );
            this.invalidateEventCaches(calendarData.calendarID);
            return { success: true, changed: true };
        } catch (error: any) {
            rethrowControlError(error);
            return { success: false, changed: false, error: error?.message || String(error) };
        }
    }

    /**
     * SEQUENCE the event currently has in Proton, or undefined if it cannot be read.
     * Proton rejects an update that changes the event's time unless SEQUENCE increases.
     */
    private async getCurrentSequence(existing: CalendarEvent, calendarData: CalendarData): Promise<number | undefined> {
        const decrypted = await this.decryptCalendarEvent(existing, calendarData);
        const sequence = decrypted?.sequence;
        return typeof sequence === 'number' && Number.isFinite(sequence) ? sequence : undefined;
    }

    /**
     * Fills in what Proton requires and removes what the bridge does not round-trip.
     * For updates, pass the SEQUENCE Proton currently holds: the outgoing value is then
     * strictly greater than both that and whatever the client sent.
     */
    private prepareVeventForProton(input: VcalVeventComponent, currentSequence?: number): VcalVeventComponent {
        const now = new Date();
        // Alarms are decided separately (decideReminders / withDecidedAlarms).
        const { components: _alarms, ...vevent } = input as VcalVeventComponent & { components?: unknown };
        const prepared: any = {
            ...vevent,
            component: 'vevent',
            dtstamp: {
                value: {
                    year: now.getUTCFullYear(),
                    month: now.getUTCMonth() + 1,
                    day: now.getUTCDate(),
                    hours: now.getUTCHours(),
                    minutes: now.getUTCMinutes(),
                    seconds: now.getUTCSeconds(),
                    isUTC: true
                }
            }
        };
        if (!prepared.uid?.value) {
            prepared.uid = { value: `${randomUUID()}@proton.me` };
        }
        if (!prepared.dtend && !prepared.duration && prepared.dtstart) {
            // RFC 5545: no DTEND means one day (dates) or zero length (date-times); Proton wants an explicit end.
            prepared.dtend = JSON.parse(JSON.stringify(prepared.dtstart));
            if (prepared.dtend.parameters?.type === 'date') {
                const next = new Date(Date.UTC(prepared.dtend.value.year, prepared.dtend.value.month - 1, prepared.dtend.value.day + 1));
                prepared.dtend.value = { year: next.getUTCFullYear(), month: next.getUTCMonth() + 1, day: next.getUTCDate() };
            }
        }
        const incomingSequence = typeof prepared.sequence?.value === 'number' ? prepared.sequence.value : 0;
        prepared.sequence = {
            value:
                typeof currentSequence === 'number'
                    ? Math.max(currentSequence, incomingSequence) + 1
                    : Math.max(0, incomingSequence)
        };
        // 0.49.12: Proton's API knows CONFIRMED and CANCELLED only ("Unknown EventStatus: TENTATIVE", a 422 on
        // the Mac): a tentative event is stored as confirmed.
        if (!prepared.status?.value || String(prepared.status.value).toUpperCase() === 'TENTATIVE') {
            prepared.status = { value: 'CONFIRMED' };
        }
        // Properties Proton cannot store or that only make sense for the local client.
        for (const key of ['created', 'last-modified', 'x-apple-structured-location', 'x-apple-travel-advisory-behavior', 'url', 'class']) {
            delete prepared[key];
        }
        // 0.49.7: "Show time as free" (TRANSP:TRANSPARENT) is Proton's "Show as: Free" (a calendar-signed
        // field); busy is the default, so OPAQUE is not stored.
        if (String(prepared.transp?.value ?? '').toUpperCase() === 'TRANSPARENT') {
            prepared.transp = { value: 'TRANSPARENT' };
        } else {
            delete prepared.transp;
        }
        // 0.34.2: empty conference properties are the bridge's "link removed" marker; Proton stores none.
        for (const key of ['x-pm-conference-id', 'x-pm-conference-url']) {
            if (prepared[key] && !String(prepared[key].value ?? '').trim()) {
                delete prepared[key];
            }
        }
        return prepared as VcalVeventComponent;
    }

    /**
     * Delete a single event
     */
    async deleteEvent(eventId: string, calendarId?: string): Promise<{ success: boolean; error?: string }> {
        if (!this.session) {
            throw new Error('API not initialized. Call initialize() first.');
        }

        try {
            const calendarData = await this.resolveCalendarData(calendarId);
            // Deleting an event with guests silently would skip the cancellation (organizer) or the
            // decline (guest) that Proton sends; refuse until invitations are supported.
            if (this.rawEventHasParticipants(await this.getEvent(eventId, calendarData.calendarID))) {
                return { success: false, error: PARTICIPANTS_WRITE_REFUSED };
            }
            // Use the correct delete structure based on webapp patterns
            const syncData = {
                MemberID: calendarData.memberID,
                Events: [{
                    ID: eventId,
                    DeletionReason: 0 // DELETION_REASON.NORMAL
                }]
            };

            const response = await this.makeCalendarRequest(`calendar/v1/${calendarData.calendarID}/events/sync`, 'PUT', syncData);
            const success = response.status === 200;

            if (success) {
                this.invalidateEventCaches(calendarData.calendarID);
            }
            
            return {
                success
            };
        } catch (error: any) {
            rethrowControlError(error);
            return {
                success: false,
                error: error.message
            };
        }
    }

    /**
     * Decrypt and read event content
     */
    async decryptEvent(eventId: string, calendarId?: string): Promise<DecryptedEventContent | null> {
        if (!this.session || !this.userData) {
            throw new Error('API not initialized. Call initialize() first.');
        }

        try {
            const calendarData = await this.resolveCalendarData(calendarId);
            const event = await this.getEvent(eventId, calendarData.calendarID);
            if (!event) {
                return null;
            }

            return this.decryptCalendarEvent(event, calendarData);
        } catch (error: any) {
            console.error('Error decrypting event:', error.message);
            return null;
        }
    }

    /**
     * Batch operations for multiple events
     */
    async batchOperations(operations: BatchEventOperation): Promise<BatchOperationResult> {
        const result: BatchOperationResult = {
            created: [],
            updated: [],
            deleted: []
        };

        // Process creates
        if (operations.create) {
            for (const eventData of operations.create) {
                const createResult = await this.createEvent(eventData);
                result.created.push({
                    id: createResult.id,
                    event: eventData,
                    success: createResult.success,
                    error: createResult.error
                });
            }
        }

        // Process updates
        if (operations.update) {
            for (const { id, event } of operations.update) {
                const updateResult = await this.updateEvent(id, event);
                result.updated.push({
                    id,
                    event,
                    success: updateResult.success,
                    error: updateResult.error
                });
            }
        }

        // Process deletes
        if (operations.delete) {
            for (const eventId of operations.delete) {
                const deleteResult = await this.deleteEvent(eventId);
                result.deleted.push({
                    id: eventId,
                    success: deleteResult.success,
                    error: deleteResult.error
                });
            }
        }

        return result;
    }

    /**
     * Get all events with decrypted content
     */
    async getEventsWithContent(startDate?: Date, endDate?: Date, calendarId?: string): Promise<DecryptedEventContent[]> {
        const { startTimestamp, endTimestamp } =
            startDate && endDate
                ? {
                      startTimestamp: Math.floor(startDate.getTime() / 1000),
                      endTimestamp: Math.floor(endDate.getTime() / 1000)
                  }
                : this.getDefaultEventWindow();
        const resolvedCalendarId = await this.resolveCalendarId(calendarId);
        const cacheKey = this.getEventWindowCacheKey(resolvedCalendarId, startTimestamp, endTimestamp);
        const cachedEvents = this.getCachedValue(this.decryptedEventWindowCache, cacheKey);

        if (cachedEvents) {
            return cachedEvents;
        }

        const events = await this.getEventsForWindow(resolvedCalendarId, startTimestamp, endTimestamp);
        const eventsWithContent = await this.decryptEvents(resolvedCalendarId, events);

        this.setCachedValue(this.decryptedEventWindowCache, cacheKey, eventsWithContent);

        return eventsWithContent;
    }

    /**
     * Search events by title or description
     */
    async searchEvents(query: string, startDate?: Date, endDate?: Date, calendarId?: string): Promise<DecryptedEventContent[]> {
        const eventsWithContent = await this.getEventsWithContent(startDate, endDate, calendarId);
        const lowerQuery = query.toLowerCase();
        
        return eventsWithContent.filter(event => 
            (event.summary && event.summary.toLowerCase().includes(lowerQuery)) ||
            (event.description && event.description.toLowerCase().includes(lowerQuery)) ||
            (event.location && event.location.toLowerCase().includes(lowerQuery))
        );
    }

    /**
     * Get events within a date range
     */
    async getEventsInRange(startDate: Date, endDate: Date, calendarId?: string): Promise<DecryptedEventContent[]> {
        return this.getEventsWithContent(startDate, endDate, calendarId);
    }

    async listCalendars(): Promise<CalendarInfo[]> {
        return this.getCalendars();
    }

    async getEventsInCalendar(calendarId: string): Promise<CalendarEvent[]> {
        return this.getEvents(calendarId);
    }

    async getEventInCalendar(calendarId: string, eventId: string): Promise<CalendarEvent | null> {
        return this.getEvent(eventId, calendarId);
    }

    async createEventInCalendar(calendarId: string, eventData: EventData) {
        return this.createEvent(eventData, calendarId);
    }

    async updateEventInCalendar(calendarId: string, eventId: string, eventData: EventData) {
        return this.updateEvent(eventId, eventData, calendarId);
    }

    async deleteEventInCalendar(calendarId: string, eventId: string) {
        return this.deleteEvent(eventId, calendarId);
    }

    async getEventsWithContentInCalendar(calendarId: string, startDate?: Date, endDate?: Date) {
        return this.getEventsWithContent(startDate, endDate, calendarId);
    }

    async searchEventsInCalendar(calendarId: string, query: string, startDate?: Date, endDate?: Date) {
        return this.searchEvents(query, startDate, endDate, calendarId);
    }

    async listEvents(calendarId: string, startDate: Date, endDate: Date): Promise<SyncedCalendarEvent[]> {
        const events = await this.getEventsForWindow(
            calendarId,
            Math.floor(startDate.getTime() / 1000),
            Math.floor(endDate.getTime() / 1000)
        );
        await this.completeAttendeeAnswers(calendarId, events);
        return this.toSyncedEvents(calendarId, events);
    }

    /**
     * Every Proton event with this UID (a series master and its changed occurrences, or a single
     * event), in the same shape as listEvents. For re-reading one event right after a change.
     */
    async listEventsByUid(calendarId: string, uid: string): Promise<SyncedCalendarEvent[]> {
        if (!this.session) {
            throw new Error('API not initialized. Call initialize() first.');
        }
        const PageSize = 100;
        const events: CalendarEvent[] = [];
        for (let Page = 0; Page < 50; Page += 1) {
            const response = await this.makeCalendarRequest(`calendar/v1/${calendarId}/events`, 'GET', undefined, {
                UID: uid,
                Page,
                PageSize
            });
            if (response.status !== 200) {
                throw new Error(`Failed to load events with UID ${uid} (${response.status}): ${response.data?.Error || ''}`.trim());
            }
            const batch: CalendarEvent[] = response.data?.Events || [];
            events.push(...batch);
            if (batch.length < PageSize) {
                break;
            }
        }
        await this.completeAttendeeAnswers(calendarId, events);
        return this.toSyncedEvents(calendarId, events);
    }

    /**
     * What changed in a calendar since `cursor` (Proton's change feed, what Proton Calendar polls
     * instead of listing; see change-feed.ts). With `null`, only the current cursor is fetched
     * (`started: false`): list the calendar in full once and pass that cursor from then on. A cursor
     * Proton no longer knows comes back as `refresh: true` with a fresh cursor: list in full again.
     */
    async getCalendarChanges(calendarId: string, cursor: string | null): Promise<CalendarChanges> {
        if (!this.session) {
            throw new Error('API not initialized. Call initialize() first.');
        }
        if (!cursor) {
            const latest = await this.makeCalendarRequest(`calendar/v1/${calendarId}/modelevents/latest`);
            if (latest.status !== 200 || typeof latest.data?.CalendarModelEventID !== 'string' || !latest.data.CalendarModelEventID) {
                throw new Error(`Failed to read the change feed of calendar ${calendarId} (${latest.status}): ${latest.data?.Error || ''}`.trim());
            }
            return { ...emptyCalendarChanges(calendarId, latest.data.CalendarModelEventID), requests: 1 };
        }
        const changes = emptyCalendarChanges(calendarId, cursor);
        changes.started = true;
        let next = cursor;
        for (let page = 0; page < MAX_FEED_PAGES; page += 1) {
            const response = await this.makeCalendarRequest(`calendar/v1/${calendarId}/modelevents/${encodeURIComponent(next)}`);
            if (isLostCursorStatus(response.status)) {
                // Proton does not know the cursor (too old, or from before a change on its side): start over.
                console.warn(`[feed] calendar ${calendarId.slice(0, 8)}…: the cursor was refused (${response.status}${response.data?.Code ? `, code ${response.data.Code}` : ''}); reading everything again`);
                const fresh = await this.getCalendarChanges(calendarId, null);
                return { ...fresh, started: true, refresh: true, requests: changes.requests + 1 + fresh.requests };
            }
            if (response.status !== 200) {
                throw new Error(`Failed to read the change feed of calendar ${calendarId} (${response.status}): ${response.data?.Error || ''}`.trim());
            }
            const { more } = applyCalendarFeedPage(changes, response.data);
            if (!more || changes.cursor === next) {
                break;
            }
            next = changes.cursor;
        }
        if (changes.keysChanged) {
            // The calendar's keys, passphrase or settings changed (sharing, a reset, new default
            // reminders): its bootstrap is read again, and decrypted events that expanded the old
            // default reminders are decrypted again.
            this.calendarDataById.delete(calendarId);
            if (this.calendarData?.calendarID === calendarId) {
                this.calendarData = null;
            }
            for (const key of [...this.decryptedByEvent.keys()]) {
                if (key.startsWith(`${calendarId}:`)) {
                    this.decryptedByEvent.delete(key);
                }
            }
        }
        if (changes.changed.length || changes.deleted.length || changes.refresh) {
            this.invalidateEventCaches(calendarId);
        }
        return changes;
    }

    /**
     * What changed in the account since `cursor` (Proton's account feed: calendars, members,
     * addresses, settings, the mailbox). Same contract as getCalendarChanges. Address changes are
     * taken over right away (the addresses and their keys are read again).
     */
    async getAccountChanges(cursor: string | null): Promise<AccountChanges> {
        if (!this.session) {
            throw new Error('API not initialized. Call initialize() first.');
        }
        if (!cursor) {
            const latest = await this.makeApiRequest('core/v4/events/latest');
            if (latest.status !== 200 || typeof latest.data?.EventID !== 'string' || !latest.data.EventID) {
                throw new Error(`Failed to read the account feed (${latest.status}): ${latest.data?.Error || ''}`.trim());
            }
            return { ...emptyAccountChanges(latest.data.EventID), requests: 1 };
        }
        const changes = emptyAccountChanges(cursor);
        changes.started = true;
        let next = cursor;
        for (let page = 0; page < MAX_FEED_PAGES; page += 1) {
            const response = await this.makeApiRequest(`core/v5/events/${encodeURIComponent(next)}`);
            if (isLostCursorStatus(response.status)) {
                console.warn(`[feed] account: the cursor was refused (${response.status}${response.data?.Code ? `, code ${response.data.Code}` : ''}); reading everything again`);
                const fresh = await this.getAccountChanges(null);
                await this.refreshAddresses();
                return { ...fresh, started: true, refresh: true, calendars: true, addresses: true, mail: true, settings: true, requests: changes.requests + 1 + fresh.requests };
            }
            if (response.status !== 200) {
                throw new Error(`Failed to read the account feed (${response.status}): ${response.data?.Error || ''}`.trim());
            }
            const { more } = applyAccountFeedPage(changes, response.data);
            if (!more || changes.cursor === next) {
                break;
            }
            next = changes.cursor;
        }
        if (changes.addresses || changes.refresh) {
            await this.refreshAddresses();
        }
        return changes;
    }

    /**
     * Reads the account's addresses (and their keys) again, after the feed reported a change. The
     * known ones stay when it fails (logged): a new address is picked up at the next sign-in.
     */
    async refreshAddresses(): Promise<boolean> {
        if (!this.session || !this.userData || !this.keyPassword) {
            return false;
        }
        try {
            const addressesResponse = await this.makeApiRequest('core/v4/addresses');
            if (addressesResponse.status !== 200 || !Array.isArray(addressesResponse.data?.Addresses)) {
                throw new Error(`Failed to get addresses (${addressesResponse.status})`);
            }
            const addresses: any[] = addressesResponse.data.Addresses;
            const { user, userKeys } = this.userData;
            const keyPassword = this.keyPassword;
            const addressKeysResults = await Promise.all(
                addresses.map(async (address: any) => {
                    const keys = await getDecryptedAddressKeysHelper(address.Keys || [], user, userKeys, keyPassword);
                    return { address, keys };
                })
            );
            this.userData = {
                ...this.userData,
                addresses,
                addressKeys: addressKeysResults.flatMap((result) => result.keys),
                addressKeysByAddressID: Object.fromEntries(addressKeysResults.map(({ address, keys }) => [address.ID, keys]))
            };
            console.log(`[feed] addresses read again: ${addresses.length}`);
            return true;
        } catch (error) {
            console.warn(`[feed] the addresses could not be read again (${error instanceof Error ? error.message : String(error)}); keeping the known ones`);
            return false;
        }
    }

    /** Events decrypted so far, and how often a decrypted event could be reused unchanged. */
    getDecryptStats(): DecryptStats {
        return { ...this.decryptStats, cached: this.decryptedByEvent.size };
    }

    private async toSyncedEvents(calendarId: string, events: CalendarEvent[]): Promise<SyncedCalendarEvent[]> {
        const decryptedEvents = await this.decryptEvents(calendarId, events);
        const decryptedById = new Map(decryptedEvents.map((event) => [event.id, event]));

        return events
            .map((event) => {
                const decrypted = decryptedById.get(event.ID);
                if (!decrypted) {
                    return null;
                }

                const title = decrypted.summary || decrypted.title || '';
                const description = decrypted.description || '';
                const location = decrypted.location || '';
                const timezone = decrypted.timezone || event.StartTimezone || 'UTC';
                const modifiedTimestamp = event.ModifyTime || event.CreateTime || event.EndTime || event.StartTime;
                const contentHash = this.computeContentHash({
                    calendarId,
                    eventId: event.ID,
                    uid: event.UID,
                    title,
                    description,
                    location,
                    startTimestamp: event.StartTime,
                    endTimestamp: event.EndTime,
                    timezone,
                    isAllDay: decrypted.isAllDay,
                    modifiedTimestamp
                });

                return {
                    calendarId,
                    eventId: event.ID,
                    uid: event.UID,
                    title,
                    description,
                    location,
                    startTimestamp: event.StartTime,
                    endTimestamp: event.EndTime,
                    timezone,
                    isAllDay: decrypted.isAllDay,
                    modifiedTimestamp,
                    contentHash,
                    raw: event,
                    decrypted
                };
            })
            .filter((event): event is SyncedCalendarEvent => Boolean(event));
    }

    /**
     * The account's own addresses, active ones first (Proton's order within each group).
     * Proton-internal only: "external" addresses cannot receive calendar invitations.
     */
    /**
     * The addresses in the account's contacts (0.33.1, guest autocomplete): Proton keeps a contact's
     * email addresses and name in clear (`contacts/v4/contacts/emails`), so no vCard is decrypted.
     * One entry per address, the contact's name with it; addresses of hidden/merged contacts included
     * as Proton lists them. Pages of 1000 until a short page.
     */
    async listContactEmails(): Promise<ContactAddress[]> {
        if (!this.session) {
            throw new Error('API not initialized. Call initialize() first.');
        }
        const PAGE_SIZE = 1000;
        const result: ContactAddress[] = [];
        for (let page = 0; page < 50; page += 1) {
            const data: any = await this.protonApi(queryContactEmails({ Page: page, PageSize: PAGE_SIZE }));
            const entries: any[] = Array.isArray(data?.ContactEmails) ? data.ContactEmails : [];
            for (const entry of entries) {
                const email = typeof entry?.Email === 'string' ? entry.Email.trim() : '';
                if (email) {
                    result.push({ email, name: typeof entry?.Name === 'string' ? entry.Name.trim() : '', contactId: String(entry?.ContactID || '') });
                }
            }
            if (entries.length < PAGE_SIZE) {
                break;
            }
        }
        return result;
    }

    /**
     * 0.34, calendar management: renames or recolours a calendar the way Proton Calendar's own edit
     * form does (`updateMember` on your member entry — name, colour and description are per member,
     * so this works for calendars shared with you and for subscribed and holiday calendars too).
     * Unchanged fields keep their values.
     */
    async updateCalendarAppearance(calendarId: string, changes: CalendarAppearance): Promise<void> {
        if (!this.session) {
            throw new Error('API not initialized. Call initialize() first.');
        }
        const calendar = (await this.getCalendars()).find((entry) => entry.id === calendarId);
        if (!calendar?.memberID) {
            throw new Error('Calendar not found');
        }
        const name = (changes.name ?? calendar.name).trim();
        if (!name || name.length > 100) {
            throw new Error('A calendar name has 1 to 100 characters');
        }
        const color = changes.color !== undefined ? normalizeCalendarColor(changes.color, calendar.color) : normalizeCalendarColor(calendar.color);
        await this.protonApi(
            updateMember(calendarId, calendar.memberID, {
                Name: name,
                Color: color,
                Description: (changes.description ?? calendar.description ?? '').slice(0, 255),
                Display: calendar.display ?? 1 // unchanged: a calendar hidden in Proton Calendar stays hidden
            })
        );
    }

    /**
     * 0.34, calendar management: creates a personal calendar like Proton Calendar does — the
     * calendar, then its key: a fresh calendar key encrypted with a passphrase that is itself
     * encrypted to and signed by the primary key of the account's first active address
     * (`generateCalendarKeyPayload`, Proton's own code). Returns the new calendar's ID.
     */
    async createCalendar(appearance: CalendarAppearance): Promise<{ id: string }> {
        if (!this.session || !this.userData) {
            throw new Error('API not initialized. Call initialize() first.');
        }
        const name = (appearance.name ?? '').trim();
        if (!name || name.length > 100) {
            throw new Error('A calendar name has 1 to 100 characters');
        }
        const addresses = this.listAddresses();
        const wanted = (appearance.address ?? '').trim().toLowerCase();
        const chosen = wanted ? addresses.find((entry) => entry.email.toLowerCase() === wanted && entry.active) : undefined;
        if (wanted && !chosen) {
            throw new Error(`"${appearance.address}" is not an active address of this account`);
        }
        const address = chosen ?? addresses.find((entry) => entry.active) ?? addresses[0];
        if (!address) {
            throw new Error('No address to own the calendar');
        }
        const addressID = (this.userData.addresses as any[]).find((entry) => entry.Email === address.email)?.ID;
        const primary = getPrimaryKey(this.userData.addressKeysByAddressID[addressID] || []);
        if (!addressID || !primary?.privateKey || !primary?.publicKey) {
            throw new Error('Primary address key is not decrypted');
        }
        const { Calendar } = await this.protonApi(
            createCalendar({
                Name: name,
                Color: normalizeCalendarColor(appearance.color || '#5252CC'),
                Description: (appearance.description ?? '').slice(0, 255),
                Display: 1,
                AddressID: addressID
            })
        );
        const calendarId: string = Calendar.ID;
        try {
            const payload = await generateCalendarKeyPayload({ addressID, privateKey: primary.privateKey, publicKey: primary.publicKey });
            await this.protonApi(setupCalendar(calendarId, payload));
        } catch (error) {
            // Without its key the calendar is unusable: take it away again rather than leave a broken one.
            await this.protonApi(removeCalendar(calendarId)).catch(() => undefined);
            throw error;
        }
        return { id: calendarId };
    }

    /**
     * 0.34.1, video links: a new meeting room for an event — Proton Meet (Proton's own recipe, see
     * video-links.ts: the password only ever travels in the URL fragment) or Zoom (Proton's
     * videoconferences endpoint; needs Zoom connected in Proton's settings). `title` names the Meet
     * room; `calendarId` picks the hosting address (the calendar's). What comes back goes into the
     * event's `conference`.
     */
    async createVideoConference(provider: VideoConferenceProvider, options: { title?: string; calendarId?: string } = {}): Promise<VideoConference> {
        if (!this.session || !this.userData) {
            throw new Error('API not initialized. Call initialize() first.');
        }
        const calendar = options.calendarId ? await this.resolveCalendarData(options.calendarId) : null;
        const addresses: any[] = this.userData.addresses || [];
        const hostAddress =
            (calendar?.memberEmail && addresses.find((address) => address.Email === calendar.memberEmail)) ||
            addresses.find((address) => address.Status === 1 && address.Receive === 1 && address.Send === 1) ||
            addresses[0];
        const host: string | undefined = hostAddress?.Email;
        if (provider === VIDEO_PROVIDER_ZOOM) {
            const data: any = await this.protonApi(createZoomMeeting());
            const conference = data?.VideoConference;
            if (!conference?.URL || !conference?.ID) {
                throw new Error('Proton did not return a Zoom meeting');
            }
            return { provider: VIDEO_PROVIDER_ZOOM, id: String(conference.ID), url: String(conference.URL), ...(conference.Password ? { password: String(conference.Password) } : {}), ...(host ? { host } : {}) };
        }
        return this.createProtonMeet(options.title || 'Meeting', hostAddress?.ID ?? null, host);
    }

    /** Proton Meet, as Proton Calendar's event form creates it (prepareMeetingCryptoData + createMeetingCall). */
    private async createProtonMeet(title: string, addressID: string | null, host: string | undefined): Promise<VideoConference> {
        const password = randomString(12);
        const salt = generateKeySalt();
        const passwordHash = await computeKeyPassword(password, salt);
        const sessionKeyData = await CryptoProxy.generateSessionKeyForAlgorithm('aes256');
        const encryptedSessionKey = (await CryptoProxy.encryptSessionKey({ data: sessionKeyData, algorithm: 'aes256', passwords: [passwordHash], format: 'binary' })).toBase64();
        const nameKey = await deriveKey(sessionKeyData, new Uint8Array(32), utf8StringToUint8Array('aeskey.link.meet.proton'), { keyUsage: ['decrypt', 'encrypt'] });
        const encryptedName = (await encryptData(nameKey, utf8StringToUint8Array(title), utf8StringToUint8Array('metadata.meet.proton'))).toBase64();
        const userKey = this.userData!.userKeys?.[0]?.privateKey;
        const encryptedPassword = userKey
            ? (
                  await CryptoProxy.encryptMessage({
                      textData: password,
                      encryptionKeys: [userKey],
                      signingKeys: [userKey],
                      format: 'armored',
                      signatureContext: { value: 'pw.link.meet.proton', critical: true }
                  })
              ).message
            : null;
        const { Auth } = await srpGetVerify({ api: this.protonApi, credentials: { password } });
        const data: any = await this.protonApi({
            url: 'meet/v1/meetings',
            method: 'post',
            data: {
                Name: encryptedName,
                Password: encryptedPassword,
                Salt: salt,
                SessionKey: encryptedSessionKey,
                SRPModulusID: Auth.ModulusID,
                SRPSalt: Auth.Salt,
                SRPVerifier: Auth.Verifier,
                AddressID: addressID,
                StartTime: null,
                EndTime: null,
                RRule: null,
                Timezone: null,
                CustomPassword: 0,
                Type: 2, // MeetingType.SCHEDULED
                ProtonCalendar: 1 // ProtonCalendarState.FROM_PROTON_CALENDAR
            }
        });
        const linkName: string | undefined = data?.Meeting?.MeetingLinkName;
        if (!linkName) {
            throw new Error('Proton did not return a Meet link');
        }
        return { provider: VIDEO_PROVIDER_PROTON_MEET, id: linkName, url: protonMeetUrl(linkName, password), ...(host ? { host } : {}) };
    }

    /**
     * 0.34.2: the Meet room behind a join link, with its session key unlocked by the password in the
     * link (as Proton's `decryptSessionKey`) — null when the link is not a Meet link, the room is
     * unknown or the password does not open it (someone else's room pasted as the location).
     */
    private async openProtonMeet(url: string) {
        const link = parseProtonMeetUrl(url);
        if (!link) {
            return null;
        }
        let meeting: any;
        try {
            meeting = (await this.protonApi({ url: `meet/v1/meetings/by-link/${link.linkName}`, method: 'get', host: 'meet' }))?.Meeting;
        } catch (error: any) {
            const status = Number(error?.status);
            if (status >= 400 && status < 500 && status !== 401 && status !== 429) {
                return null; // no such room (Proton: "Meeting does not exist"), or not this account's
            }
            throw error;
        }
        if (!meeting?.ID || !meeting?.SessionKey || !meeting?.Salt) {
            return null;
        }
        try {
            const passwordHash = await computeKeyPassword(link.password, meeting.Salt);
            const sessionKey = await CryptoProxy.decryptSessionKey({ binaryMessage: Uint8Array.fromBase64(meeting.SessionKey), passwords: [passwordHash] });
            return sessionKey ? { id: meeting.ID as string, sessionKey, meeting } : null;
        } catch {
            return null;
        }
    }

    /**
     * 0.34.2: renames a Proton Meet room to follow the event's title (Proton's Meet app does the same
     * through `PUT meet/v1/meetings/{id}/name`). False when the link is not a room of this account.
     */
    async renameProtonMeet(url: string, title: string): Promise<boolean> {
        if (!this.session) {
            throw new Error('API not initialized. Call initialize() first.');
        }
        const room = await this.openProtonMeet(url);
        if (!room) {
            return false;
        }
        const nameKey = await deriveKey(room.sessionKey.data, new Uint8Array(32), utf8StringToUint8Array('aeskey.link.meet.proton'), { keyUsage: ['decrypt', 'encrypt'] });
        const encryptedName = (await encryptData(nameKey, utf8StringToUint8Array(title || 'Meeting'), utf8StringToUint8Array('metadata.meet.proton'))).toBase64();
        await this.protonApi({ url: `meet/v1/meetings/${room.id}/name`, method: 'put', data: { Name: encryptedName }, host: 'meet' });
        return true;
    }

    /** 0.34.2: removes a Proton Meet room (`DELETE meet/v1/meetings/{id}`). False when the link is not a room of this account. */
    async deleteProtonMeet(url: string): Promise<boolean> {
        if (!this.session) {
            throw new Error('API not initialized. Call initialize() first.');
        }
        const room = await this.openProtonMeet(url);
        if (!room) {
            return false;
        }
        await this.protonApi({ url: `meet/v1/meetings/${room.id}`, method: 'delete', host: 'meet' });
        return true;
    }

    /** 0.34: removes a calendar (used by the live tests' cleanup; the bridge never offers this). */
    async deleteCalendar(calendarId: string): Promise<void> {
        if (!this.session) {
            throw new Error('API not initialized. Call initialize() first.');
        }
        await this.protonApi(removeCalendar(calendarId));
        this.calendarDataById.delete(calendarId);
    }

    /**
     * Another user's busy times (0.33.2, availability): Proton's busy-schedule endpoint, as Proton
     * Calendar's event form asks it (four kinds — part-day and full-day events starting in or before
     * the window — merged). Proton only shares them inside an organization on an eligible plan
     * (`IsDataAccessible`); for anyone else, and for the plans' answer "not allowed", the result is
     * `accessible: false` with no slots. Times are unix seconds; `timeZone` is the asker's zone (it
     * decides which full-day events fall into the window).
     */
    async getBusySchedule(email: string, start: number, end: number, timeZone: string): Promise<BusySchedule> {
        if (!this.session) {
            throw new Error('API not initialized. Call initialize() first.');
        }
        const PAGE_SIZE = 100;
        const slots: BusySlot[] = [];
        let accessible: boolean | null = null;
        for (const type of [0, 1, 2, 3]) {
            const allDay = type >= 2;
            for (let page = 0; page < 20; page += 1) {
                let data: any;
                try {
                    data = await this.protonApi(
                        getBusySlots(email, { Type: type, Start: start, End: end, Timezone: timeZone, Page: page, PageSize: PAGE_SIZE })
                    );
                } catch (error: any) {
                    const status = Number(error?.status);
                    if (status >= 400 && status < 500 && status !== 429) {
                        return { accessible: false, slots: [] }; // not shared with this account (or not on this plan)
                    }
                    throw error;
                }
                const schedule = data?.BusySchedule;
                if (accessible === null) {
                    accessible = Boolean(schedule?.IsDataAccessible);
                }
                for (const slot of Array.isArray(schedule?.BusyTimeSlots) ? schedule.BusyTimeSlots : []) {
                    if (Number.isFinite(slot?.Start) && Number.isFinite(slot?.End) && slot.End > slot.Start) {
                        slots.push({ start: Number(slot.Start), end: Number(slot.End), allDay });
                    }
                }
                if (!schedule?.More) {
                    break;
                }
            }
        }
        return { accessible: Boolean(accessible), slots: slots.sort((a, b) => a.start - b.start) };
    }

    listAddresses(): AccountAddress[] {
        const addresses: any[] = this.userData?.addresses || [];
        return addresses
            .filter((address) => typeof address?.Email === 'string' && address.Type !== 5 /* ADDRESS_TYPE.TYPE_EXTERNAL */)
            .map((address) => ({
                email: address.Email as string,
                displayName: typeof address.DisplayName === 'string' ? address.DisplayName : '',
                // Same rule as Proton's getIsAddressActive.
                active: address.Status === 1 && address.Receive === 1 && address.Send === 1,
                order: typeof address.Order === 'number' ? address.Order : Number.MAX_SAFE_INTEGER
            }))
            .sort((a, b) => Number(b.active) - Number(a.active) || a.order - b.order);
    }

    /**
     * Email policy for invitation answers. Defaults to test mode with an empty allowlist, i.e.
     * nothing is emailed (and nothing is answered) until the caller opts in.
     */
    configureInvitations(options: {
        policy?: InvitationEmailPolicy;
        prodId?: string;
        onEmail?: (record: InvitationEmailRecord) => void;
    }) {
        if (options.policy) {
            const mode = options.policy.mode;
            if (mode !== 'test' && mode !== 'dry-run' && mode !== 'live') {
                throw new Error(`Unknown invitation email mode: ${mode}`);
            }
            const language = options.policy.language || 'proton';
            if (language !== 'proton' && !matchInvitationLanguage(language)) {
                throw new Error(`Unknown invitation email language: ${language}`);
            }
            this.invitationPolicy = {
                mode,
                allowlist: (options.policy.allowlist || []).map((entry) => String(entry).trim()).filter(Boolean),
                language,
            };
        }
        if (options.prodId) {
            this.invitationProdId = options.prodId;
        }
        if (options.onEmail) {
            this.invitationEmailListener = options.onEmail;
        }
    }

    getInvitationEmailPolicy(): InvitationEmailPolicy {
        return { mode: this.invitationPolicy.mode, allowlist: [...this.invitationPolicy.allowlist], language: this.invitationPolicy.language || 'proton' };
    }

    /**
     * Proton Calendar's "Invitation language" (0.31): CalendarUserSettings.InviteLocale, else the
     * account's language (UserSettings.Locale); null when neither is set or readable. Cached for
     * 10 minutes (a change in Proton's settings takes effect by then).
     */
    async getProtonInviteLocale(): Promise<string | null> {
        const now = Date.now();
        if (this.protonInviteLocale && now - this.protonInviteLocale.at < PROTON_INVITE_LOCALE_TTL_MS) {
            return this.protonInviteLocale.code;
        }
        if (now - this.protonInviteLocaleFailedAt < PROTON_INVITE_LOCALE_RETRY_MS) {
            return this.protonInviteLocale?.code ?? null; // Proton could not be asked a moment ago: not again yet
        }
        if (!this.protonInviteLocaleRead) {
            this.protonInviteLocaleRead = this.readProtonInviteLocale(now).finally(() => {
                this.protonInviteLocaleRead = null;
            });
        }
        return this.protonInviteLocaleRead;
    }

    /** The last known value without asking Proton (for a status page); null before the first read. */
    protonInviteLocaleCached(): string | null {
        return this.protonInviteLocale?.code ?? null;
    }

    private async readProtonInviteLocale(now: number): Promise<string | null> {
        let code: string | null = null;
        let timeFormat: 12 | 24 | null = null;
        try {
            const calendarSettings = await this.protonApi(getCalendarUserSettings());
            code = calendarSettings?.CalendarUserSettings?.InviteLocale || null;
            // 0.49.6: the account's "Time format" (UserSettings.TimeFormat: 1 = 12 hours, 2 = 24 hours, 0 = the
            // region's own) shapes the dates in the emails, as in Proton Calendar's web app.
            const userSettings = await this.protonApi({ url: 'core/v4/settings', method: 'get' });
            if (!code) {
                code = userSettings?.UserSettings?.Locale || null;
            }
            const setting = Number(userSettings?.UserSettings?.TimeFormat);
            timeFormat = setting === 1 ? 12 : setting === 2 ? 24 : null;
        } catch (error) {
            this.protonInviteLocaleFailedAt = Date.now();
            console.warn(`[proton-calendar-client] could not read Proton's invitation language: ${error instanceof Error ? error.message : String(error)}`);
            return this.protonInviteLocale?.code ?? null; // the last known one, however old
        }
        this.protonInviteLocale = { code, timeFormat, at: now };
        return code;
    }

    /**
     * 0.49.6: the date and time format of the emails, as Proton Calendar's web app would render them on
     * this Mac: the Mac's region (the browser's locale there) and the account's "Time format" setting.
     */
    async getInvitationDateFormat(): Promise<InvitationDateFormat> {
        await this.getProtonInviteLocale().catch(() => null);
        return { region: getLocaleParts().locale, timeFormat: this.protonInviteLocale?.timeFormat ?? null };
    }

    /**
     * Answer an invitation (yes / maybe / no) like Proton Calendar does: sets your answer in
     * Proton and emails a REPLY to the organizer (subject to the email policy).
     */
    async answerInvitation(input: AnswerInvitationInput): Promise<InvitationOutcome> {
        return this.runInvitationAction(input.calendarID, (context) => runAnswerInvitation(context, input));
    }

    /**
     * Remove an invitation from your calendar like Proton Calendar does: if you had said yes or
     * maybe, the organizer is told you decline (unless notifyOrganizer is false); a series is
     * removed with all its occurrences.
     */
    async removeInvitation(input: RemoveInvitationInput): Promise<InvitationOutcome> {
        return this.runInvitationAction(input.calendarID, (context) => runRemoveInvitation(context, input));
    }

    /** 0.41 (bridge): how many emails to guests wait for Proton's slow-down to end. */
    deferredEmailCount(): number {
        return this.deferredEmails.length;
    }

    /**
     * 0.41 (bridge): sends the emails that waited for a slow-down, once it is over (each is reported
     * through the email listener: sent, or not sent with the reason). Call it when Proton answers again.
     */
    async sendDeferredEmails(): Promise<{ sent: number; waiting: number; givenUp: number }> {
        if (!this.deferredEmails.length || !this.session || !this.userData) {
            return { sent: 0, waiting: this.deferredEmails.length, givenUp: 0 };
        }
        return runSendDeferredEmails({ ...this.getInvitationContext(), deferredEmails: this.deferredEmails });
    }

    /**
     * Save a meeting you organize like Proton Calendar does: create it, or change it (time,
     * title, location, notes, guests). Guests get an invitation, an update or a cancellation
     * email (subject to the email policy). Single events only; recurring ones are refused.
     */
    async saveOrganizedEvent(input: SaveOrganizedEventInput): Promise<InvitationOutcome> {
        return this.runInvitationAction(input.calendarID, (context) => runSaveOrganizedEvent(context, input));
    }

    /**
     * Save a meeting you organize from a calendar app's version of it (all its VEVENTs: a single
     * event, or a series' main event and changed occurrences) like Proton Calendar does: the change
     * is read from the difference with Proton's series (whole series, one occurrence changed, one
     * occurrence deleted) and the guests get Proton's emails for it.
     */
    async saveOrganizedSeries(input: SaveOrganizedSeriesInput): Promise<InvitationOutcome> {
        return this.runInvitationAction(input.calendarID, (context) => runSaveOrganizedSeries(context, input));
    }

    /**
     * Delete a meeting you organize like Proton Calendar does: the guests get a cancellation
     * (unless notifyAttendees is false), then the event is deleted. For a series (eventID: its
     * main event), every occurrence goes, and changed occurrences get their own cancellation.
     */
    async cancelOrganizedEvent(input: CancelOrganizedEventInput): Promise<InvitationOutcome> {
        return this.runInvitationAction(input.calendarID, async (context) =>
            (await isPartOfSeries(context, input.calendarID, input.eventID))
                ? cancelOrganizedSeries(context, input)
                : runCancelOrganizedEvent(context, input)
        );
    }

    /**
     * Answers that guests outside Proton sent by email to meetings you organize (stage 4), applied
     * like Proton Mail does when you open the reply (applyEmailedAnswers in emailed-answers.ts).
     * Read-only on the mailbox; nothing is emailed. Pass the returned cursor as `since` next time.
     */
    async applyEmailedAnswers(input: ApplyEmailedAnswersInput): Promise<ApplyEmailedAnswersResult> {
        if (!this.session || !this.userData) {
            throw new Error('API not initialized. Call initialize() first.');
        }
        const result = await runApplyEmailedAnswers(this.getInvitationContext(), this.emailedAnswersState, input);
        const changed = new Set(result.answers.filter(({ outcome }) => outcome === 'applied').map(({ calendarID }) => calendarID!));
        changed.forEach((calendarID) => this.invalidateEventCaches(calendarID));
        return result;
    }

    /**
     * Emails about meetings in the Inbox that are dealt with (answered invitations, applied updates and
     * cancellations, answers Proton has), moved to the Bin, the Archive or a folder
     * (fileCalendarEmails in calendar-emails.ts). Nothing else changes; a dry run only reports.
     */
    async fileCalendarEmails(input: FileCalendarEmailsInput): Promise<FileCalendarEmailsResult> {
        if (!this.session || !this.userData) {
            throw new Error('API not initialized. Call initialize() first.');
        }
        return runFileCalendarEmails(this.getInvitationContext(), this.calendarEmailsState, input);
    }

    /**
     * Emails in a mailbox folder (default: all mail except spam and trash), newest first, without
     * their content: to check that an email arrived (e.g. the live tests). Read-only.
     */
    async findMailboxMessages(input: { labelID?: string; externalId?: string; subject?: string; since?: number; limit?: number } = {}): Promise<MailboxMessage[]> {
        if (!this.session) {
            throw new Error('API not initialized. Call initialize() first.');
        }
        const response = await this.protonApi({
            url: 'mail/v4/messages',
            method: 'get',
            params: {
                LabelID: input.labelID ?? '15',
                Sort: 'Time',
                Desc: 1,
                PageSize: Math.min(Math.max(1, input.limit ?? 50), 150),
                ...(input.since ? { Begin: Math.floor(input.since) } : {}),
            },
        });
        const messages: any[] = response?.data?.Messages ?? response?.Messages ?? [];
        return messages
            .filter((message) => !input.externalId || message.ExternalID === input.externalId)
            .filter((message) => !input.subject || message.Subject === input.subject)
            .map((message) => ({
                id: message.ID,
                externalId: message.ExternalID ?? undefined,
                subject: message.Subject ?? '',
                time: Number(message.Time) || 0,
                from: message.Sender?.Address ?? '',
                to: (message.ToList ?? []).map((recipient: any) => recipient.Address),
                labelIds: message.LabelIDs ?? [],
            }));
    }

    private async runInvitationAction(
        calendarId: string,
        action: (context: InvitationContext) => Promise<{
            emails: InvitationEmailRecord[];
            changedEventIds: string[];
            deletedEventIds: string[];
            warnings: string[];
            eventId?: string;
            protonUid?: string;
        }>
    ): Promise<InvitationOutcome> {
        if (!this.session || !this.userData) {
            throw new Error('API not initialized. Call initialize() first.');
        }
        const context = this.getInvitationContext();
        try {
            const result = await action(context);
            commitDeferredEmails(this.deferredEmails, context.deferredEmails || [], result, context.onEmail);
            return { success: true, ...result };
        } catch (error: any) {
            // 0.41 (bridge): the change was not saved: the emails that were to wait for it are not sent either.
            for (const entry of context.deferredEmails || []) {
                context.onEmail?.({ ...entry.email.record, outcome: 'failed', deferred: false, at: new Date().toISOString(), detail: 'not sent: the change was not saved in Proton' });
            }
            // Proton ended the session or refuses the app version: the caller's own handling (sign in
            // again, say so), not a refusal of this action.
            if (error?.name === 'SessionExpiredError' || error?.name === 'AppVersionError') {
                throw error;
            }
            const isActionError = error instanceof InvitationActionError;
            const retryAt = isActionError ? error.retryAt : rateLimitedUntil(error);
            const reason: InvitationRefusalReason = isActionError ? error.reason : retryAt ? 'rate-limited' : 'failed';
            const message = isActionError ? error.message : error?.data?.Error || error?.message || String(error);
            return {
                success: false,
                error: message,
                reason,
                ...(retryAt ? { retryAt } : {}),
                ...(isActionError && error.leftover ? { leftover: error.leftover } : {}),
                emails: isActionError ? error.emails : [],
                changedEventIds: [],
                deletedEventIds: [],
                warnings: [],
                ...(isActionError && error.event ? { eventId: error.event.eventID, protonUid: error.event.uid } : {}),
            };
        } finally {
            this.invalidateEventCaches(calendarId);
        }
    }

    private getInvitationContext(): InvitationContext {
        const userData = this.userData!;
        const client = this;
        return {
            api: this.protonApi,
            addresses: userData.addresses,
            userKeys: userData.userKeys,
            getAddressKeys: (addressID: string) => userData.addressKeysByAddressID[addressID] || [],
            getCalendarKeys: async (calendarID: string) => (await this.resolveCalendarData(calendarID)).calendarKeys,
            getCalendarSettings: async (calendarID: string) => (await this.resolveCalendarData(calendarID)).calendarSettings,
            getMemberID: async (calendarID: string) => (await this.resolveCalendarData(calendarID)).memberID,
            get policy() {
                return client.getInvitationEmailPolicy();
            },
            getProtonInviteLocale: () => this.getProtonInviteLocale(),
            getInvitationDateFormat: () => this.getInvitationDateFormat(),
            prodId: this.invitationProdId,
            sentReplies: this.sentInvitationReplies,
            pendingOrganizerEmails: this.pendingOrganizerEmails,
            deferredEmails: [], // this action's own; kept by runInvitationAction when it succeeds
            onEmail: (record) => {
                try {
                    this.invitationEmailListener?.(record);
                } catch (error: any) {
                    console.warn(`[proton-calendar-client] invitation email listener failed: ${error?.message || error}`);
                }
            },
        };
    }

    /**
     * Proton's `api(config)` shape on top of this client's HTTP helpers, for vendored Proton
     * code: resolves to the JSON body, rejects with an error carrying `status` and `data` (the
     * API's Code/Error), like Proton's own api does.
     */
    private protonApi = (async (config: { url: string; method?: string; data?: any; params?: Record<string, any>; output?: string; host?: 'meet' }) => {
        const method = (config.method || 'get').toUpperCase();
        if (config.output === 'arrayBuffer') {
            // Binary downloads (mail attachments), like Proton's api with output: 'arrayBuffer'.
            return this.makeBinaryRequest(config.url, config.params);
        }
        const request = config.url.startsWith('calendar/')
            ? this.makeCalendarRequest(config.url, method, config.data, config.params)
            : config.host === 'meet'
              ? this.send(false, config.url, method, config.data, config.params, false, 'meet')
              : this.makeApiRequest(config.url, method, config.data, config.params);
        const { status, data } = await request;
        const code = data && typeof data === 'object' ? data.Code : undefined;
        if (status < 200 || status >= 300 || (code !== undefined && code !== 1000 && code !== 1001)) {
            const error: any = new Error(
                (data && typeof data === 'object' && data.Error) || `Proton API ${method} ${config.url} failed (${status})`
            );
            error.status = status;
            error.data = data && typeof data === 'object' ? data : {};
            throw error;
        }
        return data;
    }) as any;

    // Private helper methods

    /**
     * Event listings carry only the first page of guests' answers (AttendeesInfo.MoreAttendees
     * flags the rest). Fetch the remaining pages like Proton's app does (fetchPaginatedAttendeesInfo),
     * so every guest shows the right answer. Mutates the events, as Proton's helper does.
     */
    private async completeAttendeeAnswers(calendarId: string, events: CalendarEvent[]) {
        const MORE_ATTENDEES_YES = 1;
        for (const event of events) {
            const info = event.AttendeesInfo;
            if (!info || info.MoreAttendees !== MORE_ATTENDEES_YES) {
                continue;
            }
            const attendees: any[] = Array.isArray(info.Attendees) ? [...info.Attendees] : [];
            let more = info.MoreAttendees;
            for (let page = 1; more === MORE_ATTENDEES_YES && page <= 50; page += 1) {
                const response = await this.makeCalendarRequest(
                    `calendar/v1/${calendarId}/events/${event.ID}/attendees`,
                    'GET',
                    undefined,
                    { Page: page }
                );
                if (response.status !== 200) {
                    console.warn(`[proton-calendar-client] could not load all guests of event ${event.ID} (${response.status})`);
                    break;
                }
                attendees.push(...(response.data?.Attendees || []));
                more = response.data?.MoreAttendees;
            }
            event.AttendeesInfo = { ...info, Attendees: attendees, MoreAttendees: more };
        }
    }

    /**
     * True when the Proton event involves other people: you organise it with guests, or you
     * were invited to it (invitations always carry the guest list). Works on the raw API event,
     * so it also holds when decryption fails. Deliberately ignores IsOrganizer: imports don't set
     * it, and imported events (which Proton strips of organizer/guests) must stay editable.
     */
    private rawEventHasParticipants(event: CalendarEvent | null | undefined) {
        if (!event) {
            return false;
        }
        const hasGuestList = Array.isArray(event.AttendeesEvents) && event.AttendeesEvents.length > 0;
        const hasAnswers = Array.isArray(event.AttendeesInfo?.Attendees) && event.AttendeesInfo.Attendees.length > 0;
        return hasGuestList || hasAnswers;
    }

    private async decryptCalendarEvent(event: CalendarEvent, calendarData?: CalendarData): Promise<DecryptedEventContent | null> {
        try {
            const resolvedCalendarData = calendarData || (await this.resolveCalendarData(event.CalendarID || this.calendarData?.calendarID));
            const privateKeys = await getCalendarEventDecryptionKeys({
                calendarEvent: event,
                addressKeys: this.userData.addressKeys,
                calendarKeys: resolvedCalendarData.calendarKeys
            });

            if (!privateKeys) {
                return null;
            }

            const [sharedSessionKey, calendarSessionKey] = await readSessionKeys({
                calendarEvent: event,
                privateKeys
            });

            const { veventComponent, selfAddressData, hasDefaultNotifications } = await readCalendarEvent({
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
                    Color: event.Color
                },
                publicKeysMap: {},
                addresses: this.userData.addresses,
                sharedSessionKey,
                calendarSessionKey,
                calendarSettings: resolvedCalendarData.calendarSettings,
                encryptingAddressID: undefined,
                getAttendeeVerificationPreferences: mockGetVerificationPreferences
            });

            // Check if this is an all-day event. Use the VEVENT VALUE=DATE parameter
            // as the primary signal; fall back to Proton's FullDay flag in case the
            // parameter is missing or uses a different case after the round-trip.
            const isAllDay =
                veventComponent.dtstart?.parameters?.type === 'date' ||
                (veventComponent.dtstart?.parameters?.type as string)?.toUpperCase() === 'DATE' ||
                event.FullDay === 1;
            
            return {
                title: veventComponent.summary?.value,
                summary: veventComponent.summary?.value,
                description: veventComponent.description?.value,
                location: veventComponent.location?.value,
                status: veventComponent.status?.value,
                sequence: veventComponent.sequence?.value,
                startTime: veventComponent.dtstart
                    ? this.formatDateTime(veventComponent.dtstart.value, isAllDay, event.StartTime)
                    : undefined,
                endTime: veventComponent.dtend
                    ? this.formatDateTime(veventComponent.dtend.value, isAllDay, event.EndTime)
                    : undefined,
                startTimestamp: event.StartTime,
                endTimestamp: event.EndTime,
                timezone: veventComponent.dtstart?.parameters?.tzid || event.StartTimezone,
                isAllDay: isAllDay,
                uid: event.UID,
                id: event.ID,
                vevent: {
                    dtstart: veventComponent.dtstart as VcalDateOrDateTimeProperty | undefined,
                    dtend: veventComponent.dtend as VcalDateOrDateTimeProperty | undefined,
                    rrule: veventComponent.rrule as unknown as DecryptedVeventTimeProperties['rrule'],
                    exdate: veventComponent.exdate as VcalDateOrDateTimeProperty[] | undefined,
                    'recurrence-id': veventComponent['recurrence-id'] as VcalDateOrDateTimeProperty | undefined,
                    status: veventComponent.status as { value: string } | undefined,
                    transp: (veventComponent as any).transp as { value: string } | undefined,
                    sequence: veventComponent.sequence as { value: number } | undefined,
                    organizer: veventComponent.organizer as VcalParticipantProperty | undefined,
                    attendee: veventComponent.attendee as VcalParticipantProperty[] | undefined,
                    'x-pm-conference-id': (veventComponent as any)['x-pm-conference-id'],
                    'x-pm-conference-url': (veventComponent as any)['x-pm-conference-url']
                },
                conference: conferenceOf(veventComponent as any),
                participation:
                    veventComponent.organizer || veventComponent.attendee?.length
                        ? {
                              isOrganizer: Boolean(selfAddressData?.isOrganizer),
                              isAttendee: Boolean(selfAddressData?.isAttendee),
                              selfEmail: (selfAddressData as any)?.selfAddress?.Email,
                              selfAttendeeIndex: (selfAddressData as any)?.selfAttendeeIndex
                          }
                        : undefined,
                reminders: remindersOf(veventComponent as any, Boolean(hasDefaultNotifications), (selfAddressData as any)?.selfAddress?.Email || this.userData.addresses?.[0]?.Email)
            };
        } catch (error: any) {
            console.error('Error decrypting event:', error.message);
            return null;
        }
    }

    private async authenticate(): Promise<AuthSession> {
        try {
            return await this.authenticateDirect();
        } catch (directError) {
            // Errors the caller tells apart keep their kind: a verification or second factor to
            // give, a slow-down, a refused app version, a lost connection.
            if (
                directError instanceof HumanVerificationRequiredError ||
                directError instanceof TwoFactorRequiredError ||
                directError instanceof RateLimitedError ||
                directError instanceof AppVersionError ||
                isNetworkError(directError)
            ) {
                throw directError;
            }
            const message = directError instanceof Error ? directError.message : String(directError);
            throw new Error(`Proton sign-in failed: ${message}`);
        }
    }

    /** The identity requests are sent with: the app's own, else the library's. */
    private get identity() {
        return this.credentials.appIdentity ?? { appVersion: OWN_APP_VERSION, userAgent: OWN_USER_AGENT };
    }

    private getAuthHeaders(extra: Record<string, string> = {}) {
        return {
            'User-Agent': this.identity.userAgent,
            'Accept': 'application/vnd.protonmail.v1+json',
            'Content-Type': 'application/json',
            'x-pm-appversion': this.identity.appVersion,
            'x-pm-locale': localeHeader(),
            ...extra
        };
    }

    private getHumanVerificationHeaders(challenge?: HumanVerificationChallenge | null) {
        const tokenType = challenge?.tokenType || challenge?.methods?.[0];
        if (!challenge?.token || !tokenType) {
            return {};
        }

        return {
            'x-pm-human-verification-token': challenge.token,
            'x-pm-human-verification-token-type': tokenType
        };
    }

    private getHumanVerificationChallenge(responseData: any): HumanVerificationChallenge | null {
        const details = responseData?.Details;
        if (!details?.HumanVerificationToken) {
            return null;
        }

        const methods = Array.isArray(details.HumanVerificationMethods) ? details.HumanVerificationMethods : [];
        return {
            token: details.HumanVerificationToken,
            methods,
            tokenType: methods[0],
            title: details.Title,
            description: details.Description,
            webUrl: details.WebUrl,
            expiresAt: details.ExpiresAt
        };
    }

    private getSrpCredentials(infoResult: any) {
        const normalizedUsername =
            typeof infoResult?.Username === 'string' && infoResult.Username ? infoResult.Username : this.credentials.username;
        return {
            username: normalizedUsername,
            password: this.credentials.password
        };
    }

    /** One HTTP attempt: status, Retry-After, and the parsed JSON body (or the binary body). */
    private async attempt(url: string, init: () => any, binary = false): Promise<AttemptResult> {
        // A request that hangs (e.g. a dead connection after the Mac slept) counts as no answer.
        const response = await this.fetchImpl(url, { ...init(), signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
        const retryAfter = response.headers?.get?.('retry-after') ?? null;
        if (binary && response.ok) {
            return { status: response.status, retryAfter, data: await response.arrayBuffer() };
        }
        const text = await response.text();
        let data: any;
        try {
            data = JSON.parse(text);
        } catch {
            data = text;
        }
        return { status: response.status, retryAfter, data };
    }

    /**
     * A request of the sign-in (no session yet): through the pause and budget, never renewed, never
     * sent again after a slow-down (Proton's apps don't either). Its text for error messages has no tokens.
     */
    private async loginRequest(url: string, path: string, init: { method: string; headers: Record<string, string>; body?: string }) {
        const result = await this.control.execute(() => this.attempt(url, () => init), { method: init.method, path, retrySlowDown: false });
        const text = typeof result.data === 'string' ? result.data : JSON.stringify(result.data);
        return { ...result, text: text.replace(/"(AccessToken|RefreshToken|ServerProof|SRPSession|Modulus|ServerEphemeral|Payload)"\s*:\s*"[^"]*"/g, '"$1":"…"') };
    }

    /**
     * Every authenticated request: through the pause, the budget and the retry rules; a 401 renews
     * the access token once (refresh token) and sends the request again; if Proton refuses the
     * renewal, SessionExpiredError.
     */
    private async send(isCalendar: boolean, endpoint: string, method: string, body?: any, query?: Record<string, any>, binary = false, host: 'default' | 'meet' = 'default') {
        if (!this.session) {
            throw new Error('Not authenticated');
        }
        const url = this.buildRequestUrl(host === 'meet' ? this.getMeetApiBaseUrl() : this.getApiBaseUrl(isCalendar), endpoint, query);
        let renewed = false;
        for (;;) {
            const generation = this.sessionGeneration;
            const result = await this.control.execute(
                () =>
                    this.attempt(
                        url,
                        () => ({ method, headers: this.getRequestHeaders(isCalendar, Boolean(body)), body: body ? JSON.stringify(body) : undefined }),
                        binary
                    ),
                { method, path: endpoint }
            );
            if (result.status === 401 && !renewed && this.session?.RefreshToken && this.session.AccessToken) {
                renewed = true;
                if (generation !== this.sessionGeneration || (await this.renewSession())) {
                    this.control.noteRetry();
                    continue;
                }
                throw new SessionExpiredError('Proton ended the session (its renewal was refused): sign in again.');
            }
            return result;
        }
    }

    /**
     * Renews the access token with the refresh token (auth/v4/refresh, like Proton's apps), once at a
     * time. Proton's refresh tokens are single-use: the new one replaces it and is handed to
     * onSession. False when Proton refuses (the session has ended).
     */
    private async renewSession(): Promise<boolean> {
        const session = this.session;
        if (!session?.RefreshToken || !session.UID) {
            return false;
        }
        this.renewing ??= (async () => {
            const result = await this.control.execute(
                () =>
                    this.attempt(`${MAIL_API_BASE_URL}/auth/v4/refresh`, () => ({
                        method: 'POST',
                        headers: this.getAuthHeaders({ 'x-pm-uid': session.UID }),
                        body: JSON.stringify({
                            UID: session.UID,
                            RefreshToken: session.RefreshToken,
                            ResponseType: 'token',
                            GrantType: 'refresh_token',
                            RedirectURI: 'https://protonmail.ch',
                            State: randomUUID()
                        })
                    })),
                { method: 'POST', path: 'auth/v4/refresh' }
            );
            if (result.status !== 200 || !result.data?.AccessToken) {
                console.warn(`[session] renewal refused (${result.status}${result.data?.Code ? `, code ${result.data.Code}` : ''})`);
                return false;
            }
            if (this.session !== session) {
                return false; // signed out (or signed in anew) meanwhile: this renewal is nobody's
            }
            this.session = {
                ...session,
                AccessToken: result.data.AccessToken,
                RefreshToken: result.data.RefreshToken || session.RefreshToken,
                UID: result.data.UID || session.UID
            };
            this.sessionGeneration += 1;
            this.control.noteSessionRenewal();
            console.log('[session] access renewed');
            this.emitSession();
            return true;
        })().finally(() => {
            this.renewing = null;
        });
        return this.renewing;
    }

    /** The account signed in is the one asked for (its username or one of its addresses). */
    private isAccountOf(userData: UserData, username: string) {
        const wanted = username.trim().toLowerCase();
        const names = [userData.user?.Name, userData.user?.Email, ...((userData as any).addresses ?? []).map((address: any) => address?.Email)]
            .filter((value): value is string => typeof value === 'string' && value.length > 0)
            .map((value) => value.toLowerCase());
        return names.includes(wanted) || (!wanted.includes('@') && names.some((name) => name.split('@')[0] === wanted));
    }

    /** Hands the current session to the caller (to resume it later). */
    private emitSession() {
        if (!this.credentials.onSession || !this.session?.AccessToken || !this.session.RefreshToken) {
            return;
        }
        try {
            this.credentials.onSession({
                UID: this.session.UID,
                AccessToken: this.session.AccessToken,
                RefreshToken: this.session.RefreshToken,
                ...(this.keyPassword ? { keyPassword: this.keyPassword } : {}),
                ...(this.passwordMode ? { passwordMode: this.passwordMode } : {})
            });
        } catch (error) {
            console.warn(`[session] onSession: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    private async authenticateDirect(): Promise<AuthSession> {
        // 0.50: the plain SRP sign-in of a third-party client: auth/info, auth (with the CAPTCHA token
        // when Proton asked for one), then the second factor if the account has one.
        await loadCryptoWorker(); // OpenPGP.js 6 enforces the packet grammar by default

        const infoResult = await this.loginRequest(`${MAIL_API_BASE_URL}/core/v4/auth/info`, 'core/v4/auth/info', {
            method: 'POST',
            headers: this.getAuthHeaders({ 'X-Accept-ExtAcc': 'true' }),
            body: JSON.stringify({
                Username: this.credentials.username,
                Intent: 'Proton'
            })
        });

        if (infoResult.status !== 200 || !infoResult.data?.SRPSession) {
            throw new Error(`Failed to get Proton auth info (${infoResult.status}): ${infoResult.text}`);
        }

        const srpResult = await getSrp(infoResult.data, this.getSrpCredentials(infoResult.data), 4);
        const authResult = await this.loginRequest(`${MAIL_API_BASE_URL}/auth/v4`, 'auth/v4', {
            method: 'POST',
            headers: this.getAuthHeaders({
                'X-Accept-ExtAcc': 'true',
                ...this.getHumanVerificationHeaders(this.credentials.humanVerification)
            }),
            body: JSON.stringify({
                Username: this.credentials.username,
                ClientProof: srpResult.clientProof,
                ClientEphemeral: srpResult.clientEphemeral,
                SRPSession: infoResult.data.SRPSession
            })
        });

        if (authResult.status !== 200) {
            const challenge = this.getHumanVerificationChallenge(authResult.data);
            if (challenge) {
                throw new HumanVerificationRequiredError(challenge);
            }
            throw new Error(`Proton authentication failed (${authResult.status}): ${authResult.text}`);
        }

        if (authResult.data?.ServerProof !== srpResult.expectedServerProof) {
            throw new Error('Unexpected server proof from Proton auth');
        }
        this.control.noteSignIn();
        const session: AuthSession = {
            AccessToken: authResult.data.AccessToken || '',
            RefreshToken: authResult.data.RefreshToken || '',
            UID: authResult.data.UID || '',
            srpSalt: infoResult.data.Salt
        };
        this.passwordMode = Number(authResult.data.PasswordMode) || 1;

        // Two-factor authentication: the session is limited to the "twofactor" scope until the second
        // factor is given (core/v4/auth/2fa), as Proton's apps do after the password.
        const enabled = Number(authResult.data?.['2FA']?.Enabled) || 0;
        if (enabled) {
            await this.completeSecondFactor(session, {
                totp: (enabled & 1) === 1,
                securityKey: (enabled & 2) === 2,
                securityKeyOptions: authResult.data['2FA']?.FIDO2?.AuthenticationOptions ?? null
            });
        }
        return session;
    }

    /**
     * Asks for the second factor (askSecondFactor, or the one-shot twoFactorCode) and sends it to
     * Proton; a refused code is asked again until the caller gives up. Nothing of the code is logged.
     */
    private async completeSecondFactor(session: AuthSession, kinds: Omit<SecondFactorRequest, 'wrong'>) {
        let oneShot = this.credentials.twoFactorCode;
        let wrong = false;
        for (;;) {
            let answer: SecondFactorAnswer | null = null;
            if (oneShot) {
                answer = { code: oneShot };
                oneShot = undefined;
            } else if (this.credentials.askSecondFactor) {
                answer = await this.credentials.askSecondFactor({ ...kinds, wrong });
            }
            if (!answer) {
                throw new TwoFactorRequiredError(
                    kinds,
                    wrong
                        ? 'The second factor was not accepted.'
                        : !kinds.totp && kinds.securityKey
                          ? 'This account signs in with a security key only; the bridge cannot use one yet. Add an authenticator app in Proton (Settings → Account → Two-factor authentication) to sign in here.'
                          : undefined
                );
            }
            const body = 'code' in answer ? { TwoFactorCode: answer.code.replace(/\s+/g, '') } : { FIDO2: answer.securityKey };
            const result = await this.loginRequest(`${MAIL_API_BASE_URL}/core/v4/auth/2fa`, 'core/v4/auth/2fa', {
                method: 'POST',
                headers: this.getAuthHeaders({
                    'Authorization': `Bearer ${session.AccessToken}`,
                    'x-pm-uid': session.UID,
                    'X-Accept-ExtAcc': 'true'
                }),
                body: JSON.stringify(body)
            });
            if (result.status === 200) {
                return;
            }
            // 422 (code 8002 "Incorrect login credentials"): the code or assertion was refused.
            if (result.status === 422 || result.data?.Code === 8002) {
                console.warn('[session] the second factor was refused');
                wrong = true;
                continue;
            }
            throw new Error(`Proton two-factor authentication failed (${result.status}): ${result.text}`);
        }
    }

    private async getUserData(): Promise<UserData> {
        if (!this.session) {
            throw new Error('Not authenticated');
        }

        // Get user info
        const userResponse = await this.makeApiRequest('core/v4/users');
        if (userResponse.status !== 200) {
            throw new Error(`Failed to get user info (${userResponse.status}): ${JSON.stringify(userResponse.data)}`);
        }
        const user = userResponse.data.User;

        // Get addresses
        const addressesResponse = await this.makeApiRequest('core/v4/addresses');
        if (addressesResponse.status !== 200) {
            throw new Error(`Failed to get addresses (${addressesResponse.status}): ${JSON.stringify(addressesResponse.data)}`);
        }
        const addresses = addressesResponse.data.Addresses;

        // The password the keys are unlocked with: the one saved with the session (no salts needed,
        // and the session's access token need not have the "locked" scope the salts ask for), or
        // derived from the login password (or, in two-password mode, the mailbox password) and
        // the primary key's salt, as Proton's handleUnlockKey does.
        let keyPassword = this.keyPassword;
        let keySalts: any[] = [];
        let userKeys: Awaited<ReturnType<typeof getDecryptedUserKeysHelper>> = [];
        if (keyPassword) {
            userKeys = await getDecryptedUserKeysHelper(user, keyPassword);
            if (userKeys.length === 0) {
                throw new Error('the keys could not be unlocked with the saved key password (changed since?)');
            }
        } else {
            const keySaltsResponse = await this.makeApiRequest('core/v4/keys/salts');
            if (keySaltsResponse.status !== 200) {
                throw new Error(`Failed to get key salts (${keySaltsResponse.status}): ${JSON.stringify(keySaltsResponse.data)}`);
            }
            keySalts = keySaltsResponse.data.KeySalts;
            const { KeySalt } = getPrimaryKeyWithSalt(user.Keys || [], keySalts);
            const twoPasswords = this.passwordMode === 2;
            let rawPassword: string | null = twoPasswords ? this.credentials.mailboxPassword ?? null : this.credentials.password;
            let wrong = false;
            for (;;) {
                if (rawPassword === null && twoPasswords) {
                    rawPassword = this.credentials.askMailboxPassword ? await this.credentials.askMailboxPassword({ wrong }) : null;
                    if (rawPassword === null) {
                        throw new MailboxPasswordRequiredError(wrong ? 'The mailbox password was not accepted.' : undefined);
                    }
                }
                // Keys from before salts were introduced are locked with the password itself.
                keyPassword = KeySalt ? await computeKeyPassword(rawPassword!, KeySalt) : rawPassword!;
                userKeys = await getDecryptedUserKeysHelper(user, keyPassword);
                if (userKeys.length > 0 || !(user.Keys || []).length) {
                    break;
                }
                if (!twoPasswords) {
                    throw new Error('the keys could not be unlocked with the password');
                }
                // Two-password mode: a wrong mailbox password is asked again (the login was right).
                console.warn('[session] the mailbox password did not unlock the keys');
                rawPassword = null;
                wrong = true;
                if (!this.credentials.askMailboxPassword) {
                    throw new MailboxPasswordRequiredError('The mailbox password was not accepted.');
                }
            }
        }
        this.keyPassword = keyPassword;

        // Get address keys
        const addressKeysResults = await Promise.all(
            addresses.map(async (address: any) => {
                const keys = await getDecryptedAddressKeysHelper(address.Keys || [], user, userKeys, keyPassword);
                return { address, keys };
            })
        );
        const addressKeys = addressKeysResults.flatMap(result => result.keys);
        const addressKeysByAddressID = Object.fromEntries(
            addressKeysResults.map(({ address, keys }) => [address.ID, keys])
        );

        return {
            user,
            addresses,
            addressKeys,
            addressKeysByAddressID,
            userKeys,
            keySalts
        };
    }

    private async getCalendarData(calendarID: string): Promise<CalendarData> {
        if (!this.session || !this.userData) {
            throw new Error('Not authenticated or user data not available');
        }

        // Get calendar bootstrap
        const bootstrapResponse = await this.makeCalendarRequest(`calendar/v2/${calendarID}/bootstrap`);
        if (bootstrapResponse.status !== 200) {
            throw new Error('Failed to get calendar bootstrap');
        }
        
        const bootstrap = bootstrapResponse.data;
        const memberID = bootstrap.Members?.[0]?.ID;
        
        // Decrypt calendar keys
        const { ID: PassphraseID, MemberPassphrases } = bootstrap.Passphrase;
        const addressesMembersMap = getAddressesMembersMap(bootstrap.Members || [], this.userData.addresses);
        
        let decryptedPassphrase: string | undefined;
        const passphraseErrors: string[] = [];

        for (const { Passphrase, Signature, MemberID: memberPassphraseID } of MemberPassphrases || []) {
            const Address = addressesMembersMap[memberPassphraseID];
            if (!Address) {
                passphraseErrors.push(`MemberID ${memberPassphraseID}: no matching address found`);
                continue;
            }

            const addressKeys = this.userData.addressKeysByAddressID[Address.ID] || [];
            const { privateKeys, publicKeys } = splitKeys(addressKeys);

            try {
                const decryptedPassphraseResult = await decryptPassphrase({
                    armoredPassphrase: Passphrase,
                    armoredSignature: Signature,
                    privateKeys,
                    publicKeys,
                }).catch((decryptError: any) => {
                    passphraseErrors.push(`MemberID ${memberPassphraseID} (Address ${Address.ID}): ${decryptError?.message || decryptError}`);
                    return undefined;
                });

                if (decryptedPassphraseResult) {
                    decryptedPassphrase = decryptedPassphraseResult;
                    break;
                }
            } catch (error: any) {
                passphraseErrors.push(`MemberID ${memberPassphraseID} (Address ${Address.ID}): ${error?.message || error}`);
            }
        }

        if (!decryptedPassphrase) {
            const detail = passphraseErrors.length
                ? `\nAttempted ${passphraseErrors.length} passphrase(s):\n  - ${passphraseErrors.join('\n  - ')}`
                : ' No MemberPassphrases were available to try.';
            throw new Error(`Could not decrypt calendar passphrase for calendar ${calendarID}.${detail}`);
        }

        const decryptedCalendarKeys = await getDecryptedCalendarKeys(bootstrap.Keys || [], { [PassphraseID]: decryptedPassphrase });
        
        return {
            calendarID,
            memberID,
            memberEmail: typeof bootstrap.Members?.[0]?.Email === 'string' ? bootstrap.Members[0].Email : undefined,
            calendarKeys: decryptedCalendarKeys,
            calendarSettings: bootstrap.CalendarSettings || {},
            passphrase: decryptedPassphrase,
            passphraseID: PassphraseID,
            // Also return the raw bootstrap data for debugging
            rawBootstrap: bootstrap
        };
    }

    private createVeventComponent(eventData: EventData, uid?: string): VcalVeventComponent {
        const timezone = this.normalizeTimezone(eventData.timezone);
        const startDateParts = this.getDateTimePartsInTimezone(eventData.startTime, timezone);
        const endDateParts = this.getDateTimePartsInTimezone(eventData.endTime, timezone);
        const now = new Date();
        
        // Handle all-day events vs timed events differently
        let dtstart, dtend;
        
        if (eventData.isAllDay) {
            // For all-day events, use date-only properties
            dtstart = {
                value: {
                    year: startDateParts.year,
                    month: startDateParts.month,
                    day: startDateParts.day
                },
                parameters: { type: 'date' }
            };
            dtend = {
                value: {
                    year: endDateParts.year,
                    month: endDateParts.month,
                    day: endDateParts.day
                },
                parameters: { type: 'date' }
            };
        } else {
            // For timed events, use date-time properties with timezone
            dtstart = {
                value: {
                    year: startDateParts.year,
                    month: startDateParts.month,
                    day: startDateParts.day,
                    hours: startDateParts.hours,
                    minutes: startDateParts.minutes,
                    seconds: startDateParts.seconds,
                    isUTC: false
                },
                parameters: { tzid: timezone }
            };
            dtend = {
                value: {
                    year: endDateParts.year,
                    month: endDateParts.month,
                    day: endDateParts.day,
                    hours: endDateParts.hours,
                    minutes: endDateParts.minutes,
                    seconds: endDateParts.seconds,
                    isUTC: false
                },
                parameters: { tzid: timezone }
            };
        }
        
        return {
            component: 'vevent',
            uid: { value: uid || `${randomUUID()}@proton.me` },
            dtstamp: {
                value: {
                    year: now.getUTCFullYear(),
                    month: now.getUTCMonth() + 1,
                    day: now.getUTCDate(),
                    hours: now.getUTCHours(),
                    minutes: now.getUTCMinutes(),
                    seconds: now.getUTCSeconds(),
                    isUTC: true
                }
            },
            dtstart,
            dtend,
            summary: { value: eventData.title },
            description: { value: eventData.description },
            location: { value: eventData.location },
            sequence: { value: 0 },
            status: { value: 'CONFIRMED' }
        };
    }

    private formatDateTime(dateTime: any, isAllDay: boolean = false, unixTimestamp?: number): string {
        if (isAllDay) {
            // For all-day events, only format the date part
            return `${dateTime.year}-${String(dateTime.month).padStart(2, '0')}-${String(dateTime.day).padStart(2, '0')}`;
        }

        if (typeof unixTimestamp === 'number') {
            return new Date(unixTimestamp * 1000).toISOString();
        }

        // Fall back to UTC when we only have decomposed date-time values.
        return new Date(
            Date.UTC(
                dateTime.year,
                (dateTime.month || 1) - 1,
                dateTime.day || 1,
                dateTime.hours || 0,
                dateTime.minutes || 0,
                dateTime.seconds || 0
            )
        ).toISOString();
    }

    private getApiBaseUrl(isCalendar: boolean) {
        return isCalendar ? CALENDAR_API_BASE_URL : MAIL_API_BASE_URL;
    }

    private getMeetApiBaseUrl() {
        return MEET_API_BASE_URL;
    }

    private getRequestHeaders(_isCalendar: boolean, hasBody: boolean) {
        if (!this.session) {
            throw new Error('Not authenticated');
        }
        const headers: Record<string, string> = {
            'User-Agent': this.identity.userAgent,
            'Accept': 'application/vnd.protonmail.v1+json',
            'x-pm-appversion': this.identity.appVersion,
            'x-pm-locale': localeHeader(),
            'x-pm-uid': this.session.UID,
            'Authorization': `Bearer ${this.session.AccessToken}`
        };
        if (hasBody) {
            headers['Content-Type'] = 'application/json';
        }
        return headers;
    }

    private normalizeTimezone(timezone?: string) {
        return timezone || 'UTC';
    }

    private async resolveCalendarData(calendarId?: string) {
        if (calendarId) {
            const cachedCalendarData = this.calendarDataById.get(calendarId);
            if (cachedCalendarData) {
                return cachedCalendarData;
            }

            const loadedCalendarData = await this.getCalendarData(calendarId);
            this.calendarDataById.set(calendarId, loadedCalendarData);
            return loadedCalendarData;
        }

        if (this.calendarData) {
            return this.calendarData;
        }

        const calendars = await this.getCalendars();
        if (!calendars.length) {
            throw new Error('No calendars found');
        }

        this.calendarData = await this.getCalendarData(calendars[0].id);
        this.calendarDataById.set(this.calendarData.calendarID, this.calendarData);
        return this.calendarData;
    }

    private async resolveCalendarId(calendarId?: string) {
        const calendarData = await this.resolveCalendarData(calendarId);
        return calendarData.calendarID;
    }

    private computeContentHash(value: Record<string, unknown>) {
        return createHash('sha256').update(JSON.stringify(value)).digest('hex');
    }

    private getDateTimePartsInTimezone(unixTimestamp: number, timezone: string) {
        const normalizedTimezone = this.normalizeTimezone(timezone);
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
                hourCycle: 'h23'
            });

            const parts = Object.fromEntries(
                formatter
                    .formatToParts(date)
                    .filter((part) => part.type !== 'literal')
                    .map((part) => [part.type, part.value])
            );

            return {
                year: Number(parts.year),
                month: Number(parts.month),
                day: Number(parts.day),
                hours: Number(parts.hour),
                minutes: Number(parts.minute),
                seconds: Number(parts.second)
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
    }

    private getDefaultEventWindow() {
        const now = new Date();
        const start = new Date(Date.UTC(now.getUTCFullYear() - DEFAULT_EVENTS_LOOKBACK_YEARS, 0, 1, 0, 0, 0));
        const end = new Date(Date.UTC(now.getUTCFullYear() + DEFAULT_EVENTS_LOOKAHEAD_YEARS, 11, 31, 23, 59, 59));

        return {
            startTimestamp: Math.floor(start.getTime() / 1000),
            endTimestamp: Math.floor(end.getTime() / 1000)
        };
    }

    private async getEventsForWindow(calendarId: string, startTimestamp: number, endTimestamp: number): Promise<CalendarEvent[]> {
        const cacheKey = this.getEventWindowCacheKey(calendarId, startTimestamp, endTimestamp);
        const cachedEvents = this.getCachedValue(this.rawEventWindowCache, cacheKey);

        if (cachedEvents) {
            return cachedEvents;
        }

        const events = new Map<string, CalendarEvent>();
        const maxWindowSeconds = MAX_EVENT_QUERY_WINDOW_DAYS * 24 * 60 * 60;

        for (let chunkStart = startTimestamp; chunkStart <= endTimestamp; chunkStart += maxWindowSeconds) {
            const chunkEnd = Math.min(chunkStart + maxWindowSeconds - 1, endTimestamp);
            const chunkResponses = await Promise.all(
                EVENT_QUERY_TYPES.map((type) => this.getEventsForQueryType(calendarId, chunkStart, chunkEnd, type))
            );

            for (const queryEvents of chunkResponses) {
                for (const event of queryEvents) {
                    events.set(event.ID, event);
                }
            }
        }

        const sortedEvents = Array.from(events.values()).sort((a, b) => a.StartTime - b.StartTime);
        this.setCachedValue(this.rawEventWindowCache, cacheKey, sortedEvents);

        return sortedEvents;
    }

    private async getEventsForQueryType(calendarId: string, startTimestamp: number, endTimestamp: number, type: number): Promise<CalendarEvent[]> {
        const events: CalendarEvent[] = [];
        let page = 0;

        for (;;) {
            const response = await this.makeCalendarRequest(
                `calendar/v1/${calendarId}/events`,
                'GET',
                undefined,
                {
                    Start: startTimestamp,
                    End: endTimestamp,
                    Timezone: 'UTC',
                    Type: type,
                    Page: page,
                    PageSize: DEFAULT_EVENT_PAGE_SIZE
                }
            );

            if (response.status !== 200) {
                throw new Error(`Failed to retrieve events for query type ${type}`);
            }

            const pageEvents = response.data.Events || [];
            events.push(...pageEvents);

            if (!response.data.More || pageEvents.length === 0) {
                return events;
            }

            page += 1;
        }
    }

    private async decryptEvents(calendarId: string, events: CalendarEvent[]): Promise<DecryptedEventContent[]> {
        if (events.length === 0) {
            return [];
        }

        const results: Array<DecryptedEventContent | null> = new Array(events.length).fill(null);
        let nextIndex = 0;
        const workerCount = Math.min(MAX_EVENT_DECRYPTION_CONCURRENCY, events.length);
        const calendarData = await this.resolveCalendarData(calendarId);

        await Promise.all(
            Array.from({ length: workerCount }, async () => {
                for (;;) {
                    const currentIndex = nextIndex;
                    nextIndex += 1;

                    if (currentIndex >= events.length) {
                        return;
                    }

                    const event = events[currentIndex];
                    const cacheKey = `${calendarId}:${event.ID}`;
                    const fingerprint = eventFingerprint(event);
                    const kept = this.decryptedByEvent.get(cacheKey);
                    if (kept && kept.fingerprint === fingerprint) {
                        // Unchanged since it was last decrypted: the copy is reused (and kept as recent).
                        this.decryptedByEvent.delete(cacheKey);
                        this.decryptedByEvent.set(cacheKey, kept);
                        this.decryptStats.reused += 1;
                        results[currentIndex] = kept.value;
                        continue;
                    }
                    this.decryptStats.decrypted += 1;
                    const decrypted = await this.decryptCalendarEvent(event, calendarData);
                    results[currentIndex] = decrypted;
                    if (decrypted) {
                        this.decryptedByEvent.set(cacheKey, { fingerprint, value: decrypted });
                        while (this.decryptedByEvent.size > MAX_DECRYPTED_EVENTS_KEPT) {
                            this.decryptedByEvent.delete(this.decryptedByEvent.keys().next().value as string);
                        }
                    } else {
                        this.decryptedByEvent.delete(cacheKey);
                    }
                }
            })
        );

        const failedCount = results.filter((event) => event === null).length;
        if (failedCount > 0) {
            const failedIds = events
                .filter((_, index) => results[index] === null)
                .map((event) => event.ID)
                .slice(0, 10);
            console.warn(
                `[proton-calendar-client] ${failedCount}/${events.length} event(s) in calendar ${calendarId} failed to decrypt. ` +
                `Event IDs (first 10): ${failedIds.join(', ')}`
            );
        }

        return results.filter((event): event is DecryptedEventContent => Boolean(event));
    }

    private getEventWindowCacheKey(calendarId: string, startTimestamp: number, endTimestamp: number) {
        return `${calendarId}:${startTimestamp}:${endTimestamp}`;
    }

    private getCachedValue<T>(cache: Map<string, TimedCacheEntry<T>>, cacheKey: string): T | null {
        const cached = cache.get(cacheKey);
        if (!cached) {
            return null;
        }

        if (Date.now() - cached.cachedAt > EVENT_CACHE_TTL_MS) {
            cache.delete(cacheKey);
            return null;
        }

        return cached.value;
    }

    private setCachedValue<T>(cache: Map<string, TimedCacheEntry<T>>, cacheKey: string, value: T) {
        cache.set(cacheKey, {
            cachedAt: Date.now(),
            value
        });
    }

    private invalidateEventCaches(calendarId?: string) {
        if (!calendarId) {
            this.rawEventWindowCache.clear();
            this.decryptedEventWindowCache.clear();
            return;
        }

        for (const cacheKey of this.rawEventWindowCache.keys()) {
            if (cacheKey.startsWith(`${calendarId}:`)) {
                this.rawEventWindowCache.delete(cacheKey);
            }
        }

        for (const cacheKey of this.decryptedEventWindowCache.keys()) {
            if (cacheKey.startsWith(`${calendarId}:`)) {
                this.decryptedEventWindowCache.delete(cacheKey);
            }
        }
    }

    private buildRequestUrl(baseUrl: string, endpoint: string, query?: Record<string, any>) {
        const url = new URL(`${baseUrl}/${endpoint}`);

        if (query) {
            Object.entries(query).forEach(([key, value]) => {
                if (value === undefined || value === null) {
                    return;
                }
                url.searchParams.set(key, String(value));
            });
        }

        return url.toString();
    }

    private async makeApiRequest(endpoint: string, method: string = 'GET', body?: any, query?: Record<string, any>) {
        const { status, data } = await this.send(false, endpoint, method, body, query);
        return { status, data };
    }

    /** GET of a binary resource (mail attachments); errors carry `status` and the API's Code/Error. */
    private async makeBinaryRequest(endpoint: string, query?: Record<string, any>): Promise<ArrayBuffer> {
        const { status, data } = await this.send(false, endpoint, 'GET', undefined, query, true);
        if (status < 200 || status >= 300) {
            const error: any = new Error((data && typeof data === 'object' && data.Error) || `Proton API GET ${endpoint} failed (${status})`);
            error.status = status;
            error.data = data && typeof data === 'object' ? data : {};
            throw error;
        }
        return data as ArrayBuffer;
    }

    private async makeCalendarRequest(endpoint: string, method: string = 'GET', body?: any, query?: Record<string, any>) {
        const { status, data } = await this.send(true, endpoint, method, body, query);
        return { status, data };
    }
}

// Export convenience functions for easy usage
export async function createProtonCalendarAPI(credentials: Credentials): Promise<ProtonCalendarAPI> {
    const api = new ProtonCalendarAPI(credentials);
    await api.initialize();
    return api;
}

