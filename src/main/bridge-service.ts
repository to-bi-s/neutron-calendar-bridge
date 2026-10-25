import { app as electronApp } from 'electron';
import { createHash, timingSafeEqual } from 'node:crypto';
import { join } from 'node:path';
import { clientDisplayName, currentAppName } from './caldav-client';

import type { AccountChanges, CalendarChanges, EmailedAnswer, EventData, FiledEmail, InvitationEmailRecord, InvitationOutcome, LeftEmail } from 'proton-calendar-client';

import { SENT_INVITATION_IDS_MAX, ConfigStore } from './config-store';
import type { ConfigStoreLike } from './config-store';
import type { TrayPhase, TrayState } from './tray-menu';
import { buildCalDAVProfile } from './caldav-profile';
import { APP_LANGUAGES, currentLanguage, isAppLanguage, t, tn } from './i18n';
import { MirrorDatabase, MirrorOpenResult, type OutboxItem } from './mirror-database';
import { ProtonAdapter, ProtonHumanVerificationRequiredError } from './proton-adapter';
import {
    RECURRING_READ_ONLY_MESSAGE,
    ReadOnlyEventError,
    INVITATION_MESSAGES,
    InvitationNotSupportedError,
    InvitationCancelledError,
    OwnAnswerChange,
    StaleEventError,
    answersNewOccurrence,
    seriesAnswerFromNewOccurrence,
    repeatsSeriesAnswer,
    staleOccurrenceKeys,
    clientSchedulingOf,
    describeIcsShape,
    EventSeries,
    buildSeriesRecord,
    groupIntoSeries,
    icsDateFromVcal,
    icsDateToUtcMs,
    icsHasParticipants,
    icsHasRecurrence,
    isRecurringSeries,
    ownAnswerChanges,
    sameExceptAnswers,
    sameForProton,
    seriesHasParticipants,
    occurrenceKey,
    occurrencesWithChangedAlarms,
    onlyNewOccurrenceAlarms,
    alarmKeysByOccurrence,
    veventBlocksWithoutAlarms,
} from './recurrence';
import { secret, setDetailedLogging, withoutAddresses } from './private-log';
import { PROVIDER_NAMES, conferenceOfIcsText, firstVeventOf, icsHasConferenceRemoval, masterVeventOf, restoreConferenceLines, placeKind, sameRoom, withConferenceDescribed, withConferenceRemoved, withLocation, withoutLocation, withServedDescriptions, withVideoLink } from './video-links';

/** 0.34.2: what a save did about video links, for the steps after the write. */
interface VideoLinkContext {
    /** The ICS as written (restored, linked or with the removal marker). */
    ics: string;
    created: boolean;
    removed: boolean;
    /** The conference came along from the same event in another calendar (a move). */
    carried: boolean;
    existingTitle: string | undefined;
    /** 0.41.2: the made room's key in madeRooms (forgotten once the save went through). */
    roomKey?: string;
    /** 0.41.6: "Proton Meet" typed on an event with a link: its link became the place again. */
    placeRestored?: boolean;
}
import { SecretStore } from './secret-store';
import {
    buildCollectionPath,
    buildEventHref,
    buildEventRecordShape,
    parseIcs,
    slugify
} from './sync-utils';
import {
    QUIET_AFTER_MS,
    SyncPassKind,
    TrayCalendarsStatus,
    calendarKindOf,
    calendarSlugOfPath,
    calendarStatusOf,
    includesHolidays,
    isWarningWorthy,
    localDayOf,
    msUntilLocalMidnight,
    nextSyncDelayMs,
    trayCalendarsStatusOf
} from './sync-schedule';
import {
    BridgeCalendarRecord,
    BridgeCalendarView,
    BridgeConfig,
    BridgeConfigPatch,
    BridgeEventRecord,
    CalDAVRequestError,
    BridgeHealth,
    BridgeState,
    CalendarAppStatus,
    CalDAVClient,
    CalDAVClientKind,
    OtherClientStatus,
    CalendarEmailsStatus,
    CalendarKind,
    HumanVerificationChallenge,
    HumanVerificationSubmission,
    InvitationEmailLogEntry,
    LocalCalDAVCredentials,
    ProtonCredentials,
    RequestStatsView,
    SavedProtonSession,
    SignInPrompt,
    SignInPromptAnswer,
    SyncPassSummary,
    SyncStats,
    SyncStatus
} from '../shared/types';

/**
 * The client refuses writes to Proton events that have an organizer or guests (they need
 * invitation emails). Surface that as the 403-worthy error, everything else as a plain failure.
 */
/** RFC 7232 If-Match against the mirror's ETag; no header means no precondition. */
const etagMatches = (ifMatch: string | undefined, etag: string) => {
    if (!ifMatch) {
        return true;
    }
    const bare = (value: string) => value.trim().replace(/^W\//, '').replace(/"/g, '');
    const wanted = ifMatch.split(',').map(bare).filter(Boolean);
    return wanted.includes('*') || wanted.includes(bare(etag));
};

/** How long the delete half of a refused meeting move is refused too. */
const MOVE_REFUSAL_MEMORY_MS = 5 * 60 * 1000;

/** How long a version replaced by a sync pass is remembered (Calendar.app may still hold its ETag). */
const REPLACED_VERSION_MEMORY_MS = 10 * 60 * 1000;
/** 0.33.1: how long the contact list for the guest search is kept, and how soon a failed read is tried again. */
/**
 * 0.33.2: a free/busy answer — the busy periods (unix ms, instants) within the window answered
 * (`end` may be earlier than asked: windows are capped), or "unknown" (RFC 6638: no scheduling
 * support for that user).
 */
export type FreeBusyAnswer = { known: true; periods: Array<{ start: number; end: number; allDay: boolean; tentative?: boolean }>; end: number } | { known: false };

/** 0.33.2: an all-day period (UTC midnights of its dates) placed on this Mac's local midnights. */
const allDayPeriodInLocalTime = <T extends { start: number; end: number; allDay: boolean }>(period: T): T => {
    if (!period.allDay) {
        return period;
    }
    const local = (ms: number) => {
        const date = new Date(ms);
        return new Date(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()).getTime();
    };
    return { ...period, start: local(period.start), end: local(period.end) };
};

/**
 * The series rule of an ICS text for the window pre-filter: the RRULE of the VEVENT without a
 * RECURRENCE-ID (the master) — never a VTIMEZONE's, whose historical observances carry UNTILs of
 * their own. Null for a single event.
 */
const rruleOf = (ics: string) => {
    const unfolded = ics.replace(/\r?\n[ \t]/g, '');
    const vevents = unfolded.match(/^BEGIN:VEVENT[ \t]*$[\s\S]*?^END:VEVENT[ \t]*$/gim) || [];
    const master = vevents.find((block) => !/^RECURRENCE-ID[;:]/im.test(block)) ?? vevents[0];
    return master?.match(/^RRULE:([^\r\n]+)/im)?.[1] ?? null;
};

const CONTACTS_TTL_MS = 10 * 60_000;
const CONTACTS_RETRY_MS = 60_000;
/** 0.33.2: how long a guest's busy times from Proton are kept, and how long "not shared" is remembered. */
const BUSY_TTL_MS = 2 * 60_000;
const BUSY_NOT_SHARED_TTL_MS = 10 * 60_000;
const BUSY_ERROR_TTL_MS = 60_000;
/** 0.33.2: how long the user's own busy times (from the mirror) are kept between lookups. */
const OWN_BUSY_TTL_MS = 30_000;
/** 0.34.1: how long a room made for a save is used again for the same event (retried saves). */
const MADE_ROOM_MEMORY_MS = 60 * 60_000;
/** 0.35: how soon the outbox is tried again while changes wait (a sync pass that works tries at once). */
const OUTBOX_RETRY_MS = 60_000;
/** 0.42: the outbox key of a calendar's waiting name/colour/description change (no event has it as UID). */
const CALENDAR_APPEARANCE_UID = '\u0000calendar-appearance';
/** 0.42.1: how long a calendar rename/recolour waits for Proton before it goes to the outbox (Calendar.app gives up on slow PROPPATCHes). */
const APPEARANCE_ANSWER_MS = 5_000;

/**
 * 0.35: no answer from Proton — no connection, DNS, a timeout, a dropped socket, or a server error
 * (5xx) — as the client reports it (its write methods return the message; its control layer throws
 * named errors for slow-downs and ended sessions, which are not this).
 */
export const isUnreachableFailure = (error: unknown) => {
    const name = errorName(error);
    if (name === 'RateLimitedError' || name === 'SessionExpiredError' || name === 'AppVersionError') {
        return false;
    }
    const status = Number((error as { status?: unknown } | null)?.status);
    if (status >= 500) {
        return true;
    }
    const code = String((error as { code?: unknown } | null)?.code ?? (error as { cause?: { code?: unknown } } | null)?.cause?.code ?? '');
    const text = `${code} ${errorText(error)}`;
    return /ECONNRESET|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|socket hang up|fetch failed|network error|no connection|Service unavailable|\((5\d\d)\)|request timed out/i.test(text) || /^\s*terminated$/i.test(text);
};
/** 0.33.2: the longest window a free/busy lookup is answered for (Calendar.app asks for days or weeks). */
const BUSY_WINDOW_MAX_MS = 92 * 86_400_000;

/** Guests' emailed answers: how far back the first run looks, and how much each run re-reads. */
const EMAILED_ANSWERS_FIRST_LOOKBACK_S = 30 * 24 * 3600;
const EMAILED_ANSWERS_OVERLAP_S = 10 * 60;
/** 0.41: how far, and how often, the mailbox is looked through again for replies moved out of Spam. */
const EMAILED_ANSWERS_LOOK_BACK_S = 7 * 24 * 3600;
const EMAILED_ANSWERS_LOOK_BACK_EVERY_MS = 6 * 3600 * 1000;

/** Meetings deleted from your calendars: emails about them count as dealt with for this long. */
const GONE_MEETING_MEMORY_MS = 30 * 24 * 3600 * 1000;
/** Proton's own folder names: the custom folder must be another one. */
const RESERVED_FOLDER_NAMES = new Set([
    'inbox', 'drafts', 'sent', 'starred', 'archive', 'spam', 'trash', 'bin', 'all mail', 'almost all mail',
    'all drafts', 'all sent', 'outbox', 'scheduled', 'snoozed'
]);
const CALENDAR_EMAILS_AFTER = ['leave', 'trash', 'archive', 'folder'];
const KIND_WORDS: Record<string, string> = { invitation: 'invitation', update: 'update', cancellation: 'cancellation', answer: 'answer' };
/** Proton's Trash, called Bin like on the Mac. */
const shownDestination = (name: string) => (name === 'Trash' ? 'Bin' : name);

/** A macOS notification the bridge asks for (main.ts shows it, groups bursts, opens `page` on click). */
export interface BridgeNotification {
    /** The same key within a minute is shown once. */
    key: string;
    title: string;
    subtitle?: string;
    body: string;
    page: 'overview' | 'calendars' | 'setup' | 'settings' | 'info';
    /** Removes the notification with this key (e.g. "connected again" removes "cannot be reached"). */
    replaces?: string;
    /** 0.36: the account it is about (a click opens the page for it); null for the one-account service. */
    accountId?: string | null;
}

/** Proton unreachable: after this long (awake), coming back syncs at once (not at the next regular sync). */
const OFFLINE_RESYNC_MS = 2 * 60 * 1000;
/** Proton unreachable for this long (awake), or refusing the calendar list for this long: a notification. */
const OFFLINE_NOTIFY_MS = 5 * 60 * 1000;
/** While Proton cannot be reached, how often its ping checks whether it is back. */
const CONNECTIVITY_PROBE_MS = 15 * 1000;
/** Calendar list refused (Proton answers its ping) this many passes in a row: a notification. */
const REFUSED_PASSES_NOTIFY = 5;
/** After waking up: how often Proton's ping is tried before syncing anyway (about a minute). */
const RESUME_PROBE_ATTEMPTS = 12;
/** A sign-in waits this long for an authenticator code or the mailbox password. */
const SIGN_IN_PROMPT_MS = 10 * 60 * 1000;
/** A change Proton failed to save (Calendar.app retries it): notified at most this often per event. */
const FAILED_CHANGE_NOTIFY_MS = 30 * 60 * 1000;

/** No answer at all (fetch failed: no network, DNS, refused, timed out), as opposed to an answer saying no. */
const isNoConnectionError = (error: unknown) => {
    const candidate = error as { name?: unknown; message?: unknown; cause?: { code?: unknown } } | null;
    return (
        candidate?.name === 'TypeError' &&
        (/^(fetch failed|terminated)$/.test(String(candidate.message)) || typeof candidate.cause?.code === 'string')
    );
};

const errorName = (error: unknown) => (error as { name?: unknown } | null)?.name;

/** A translated reason for Calendar.app that keeps what calendarAppWrite needs: the error's name (slow-down, ended session) and retry time. */
const withReason = (error: unknown, message: string) => {
    const reason = new Error(message);
    const name = errorName(error);
    if (typeof name === 'string' && name !== 'Error') {
        reason.name = name;
    }
    const retryAt = (error as { retryAt?: unknown } | null)?.retryAt;
    if (typeof retryAt === 'number') {
        Object.assign(reason, { retryAt });
    }
    return reason;
};
/** A sign-in that finished after you signed out (it was undone). */
const SIGNED_OUT_MEANWHILE = 'SignedOutMeanwhile';
/** Detailed logging "for 24 hours". */
const DETAILED_LOGGING_MS = 24 * 60 * 60 * 1000;

/** Compares two secrets in constant time (as SHA-256 digests, so of the same length). */
const sameSecret = (given: string, expected: string) =>
    timingSafeEqual(createHash('sha256').update(given, 'utf8').digest(), createHash('sha256').update(expected, 'utf8').digest());

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * The account as Calendar.app lists it, and the profile's identifier (stable: installing again
 * replaces, not duplicates). Not under Proton's reverse-DNS name (the app is not Proton's);
 * "local." is the conventional namespace for names nobody owns.
 */
const CALENDAR_APP_ACCOUNT_NAME = 'Proton';
const CALENDAR_APP_PROFILE_NAME = 'Neutron Calendar Bridge';
/** The Calendar.app profile identity: this for a service without an account, this plus the account's ID otherwise. */
export const CALENDAR_APP_PROFILE_IDENTIFIER = 'io.github.to-bi-s.neutron-calendar-bridge.calendar-app';
/** Proton answered with a server error (after the client's retries): temporary, tried again later. */
const isServerTrouble = (error: unknown) =>
    Number((error as { status?: unknown } | null)?.status) >= 500 || /\((5\d\d)\)/.test(errorText(error));

const slowDownMessage = (until: number) => {
    const date = new Date(until);
    const sameDay = date.toDateString() === new Date().toDateString();
    const when = sameDay
        ? date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        : date.toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
    return t('Proton asked to slow down. Syncing again at {when}.', { when });
};

/** A part of a CalDAV path, decoded (left as it is when it is not valid percent-encoding). */
const decodedPathPart = (part: string) => {
    try {
        return decodeURIComponent(part);
    } catch {
        return part;
    }
};

/** Proton reachable? Proton's unauthenticated ping (any answer below 500 counts). */
const pingProton = async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    try {
        const response = await fetch('https://mail-api.proton.me/core/v4/tests/ping', { signal: controller.signal });
        return response.status > 0 && response.status < 500;
    } catch {
        return false;
    } finally {
        clearTimeout(timer);
    }
};

const writeError = (message: string | undefined, fallback: string) =>
    message && /organizer or guests/i.test(message)
        ? new InvitationNotSupportedError(INVITATION_MESSAGES.changeOrganized)
        : new Error(message || fallback);

/**
 * Whether a Proton event (a single event, or a series' master with its rule) can have an occurrence
 * in the sync window, as Proton's own listing decides it: a series counts from its first occurrence
 * until its UNTIL (no end is open-ended; a COUNT too, unless its last end is passed — 0.40). Unix seconds.
 */
export const touchesWindow = (
    startTime: number,
    endTime: number,
    rrule: string | null | undefined,
    windowStart: number,
    windowEnd: number,
    /** 0.40: a COUNT-limited series' last end (unix ms, within a day), when the caller could work it out. */
    seriesLastEnd?: number | null
) => {
    if (startTime > windowEnd) {
        return false;
    }
    if (!rrule) {
        return endTime >= windowStart;
    }
    const until = /(?:^|;)UNTIL=(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2}))?/i.exec(rrule);
    if (!until) {
        // A COUNT series that ended before the window is outside it (0.40; before, it stayed until the
        // daily full pass). Open-ended series, and COUNT series whose end is not known, are kept.
        if (/(?:^|;)COUNT=\d+/i.test(rrule) && typeof seriesLastEnd === 'number' && Number.isFinite(seriesLastEnd)) {
            return seriesLastEnd / 1000 + 86_400 >= windowStart;
        }
        return true;
    }
    const [, year, month, day, hour = '23', minute = '59', second = '59'] = until;
    const untilTime = Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second)) / 1000;
    // A day's slack: UNTIL is in the event's time zone or UTC, and the last occurrence may run on.
    return untilTime + 86_400 >= windowStart;
};

/** 0.36: what makes a BridgeService one account among several (main.ts builds one per account). */
export interface BridgeServiceOptions {
    /** The settings: an account's view of the app's file and its own; the folder's own config.json otherwise. */
    configStore?: ConfigStoreLike;
    /** The client library's state folder: one for all accounts. */
    clientStateDir?: string;
    account?: {
        id: string;
        /** The Calendar.app profile's identity (the account migrated from before 0.36 keeps the old one). */
        profileIdentifier: string;
        /** The account's name in Calendar.app (known once signed in). */
        accountName: () => string;
        /** The address to show with notifications while several accounts exist; null with one. */
        labelForNotifications: () => string | null;
        /** Signed in (credentials accepted), before the first sync: a new account picks its CalDAV user name here. */
        onSignedIn?: (service: BridgeService) => void;
    };
}

/** 0.49.1: the apps' names in the log. */
const CLIENT_LABEL: Record<CalDAVClientKind, string> = { 'calendar-app': 'Calendar.app', thunderbird: 'Thunderbird', other: 'another CalDAV app' };


export class BridgeService {
    private readonly configStore: ConfigStoreLike;
    private readonly secretStore: SecretStore;
    private readonly mirrorDatabase: MirrorDatabase;
    private readonly protonAdapter: ProtonAdapter;
    private syncTimer: NodeJS.Timeout | null = null;
    /** A whole sync pass (calendar list, emailed answers, then the calendars through the queue). */
    private passInFlight: Promise<void> | null = null;
    /** Calendars waiting to be synced, in order; manual = queued by a click in the window. */
    /** `full`: list the calendar and compare (a click, a full pass); otherwise only what its feed reports. */
    private syncQueue: Array<{ calendarId: string; manual: boolean; clearsWarnings: boolean; full: boolean }> = [];
    private syncingCalendarId: string | null = null;
    private queueRunner: Promise<void> | null = null;
    /** One sync of a calendar's events at a time (queue and Calendar.app writes). */
    private calendarLocks = new Map<string, Promise<unknown>>();
    /** Public holidays: synced at sign-in and once a day from midnight on (local day of the last sync). */
    private holidaysSyncedOn: string | null = null;
    private midnightTimer: NodeJS.Timeout | null = null;
    /** Proton could not be reached in the last pass: every calendar's dot is red. */
    private connectionError: { message: string; at: number } | null = null;
    /** Refused or failed Calendar.app changes per calendar (yellow dot) until the calendar is synced by hand. */
    private calendarWarnings = new Map<string, { message: string; at: number }>();
    /** Calendars Proton listed in the last pass (the menu's dot only counts these). */
    private activeCalendarIds: Set<string> | null = null;
    /** The calendar job running now. */
    private syncingJob: { calendarId: string; manual: boolean; clearsWarnings: boolean; full: boolean } | null = null;
    /** Called (throttled) when something the window or the menu shows changed. */
    onStateChange: (() => void) | null = null;
    private stateChangeTimer: NodeJS.Timeout | null = null;
    private health: BridgeHealth = 'disconnected';
    /** The status text, kept as a function of the language so that a language change re-translates it (0.32). */
    private messageSource: () => string = () => t('Signed out');
    private get message() {
        return this.messageSource();
    }
    private lastSuccessfulSyncAt: number | null = null;
    private lastAttemptedSyncAt: number | null = null;
    private localCaldavPassword: string | null = null;
    private detailedLoggingTimer: ReturnType<typeof setTimeout> | null = null;
    /** Why the local copy is only in memory this run (shown on the Overview); null when it is on disk. */
    private localCopyNote: string | null = null;
    /** Wrong logins from Calendar.app since the last right one (see checkCalDAVLogin). */
    private caldavLoginTrouble: { since: number; lastAt: number; attempts: number; app?: string } | null = null;
    /** Calendar.app's last request with the right password this run (the config keeps the one before). */
    /** 0.49.1: when each kind of CalDAV app last signed in this run (Calendar.app, Thunderbird, another), and when that was written. */
    private clientSeenAt: Record<CalDAVClientKind, number | null> = { 'calendar-app': null, thunderbird: null, other: null };
    private clientSeenSavedAt: Record<CalDAVClientKind, number> = { 'calendar-app': 0, thunderbird: 0, other: 0 };
    private otherClientName: string | null = null;
    private pendingHumanVerification: HumanVerificationChallenge | null = null;
    /** Proton asks for a code or the mailbox password (0.27): shown on the Setup page until answered. */
    private signInPrompt: SignInPrompt | null = null;
    /** The sign-in waiting for the prompt's answer (0.27). */
    private signInPromptWaiter: { resolve: (answer: SignInPromptAnswer | null) => void; timer: NodeJS.Timeout; owner: object; timedOut?: boolean } | null = null;
    /** Why the last prompt ended without an answer (the sign-in's error message says so). */
    private signInPromptEnding: 'cancelled' | 'timed out' | null = null;
    private pendingCredentials: ProtonCredentials | null = null;
    private syncStats: SyncStats = { totalEvents: 0, syncedEvents: 0, failedEvents: 0, lastDirection: null };
    /** Last sync error per Proton calendar ID (red dot); cleared when the calendar syncs again. */
    private calendarErrors = new Map<string, { message: string; at: number }>();
    /** Calendar.app requests that failed (newest first), shown on the Overview page. */
    private recentCalDAVErrors: CalDAVRequestError[] = [];
    /** The account's own addresses (for calendar-user-address-set and "is this me?"), active first. */
    private accountAddresses: string[] = [];
    /** 0.37: the active ones among them (the only ones that can own a new calendar). */
    private activeAddresses: string[] = [];
    /** 0.33.1: the account's contacts for Calendar.app's guest search (read in the background, kept 10 min). */
    private contacts: { entries: Array<{ email: string; name: string }>; at: number } | null = null;
    private contactsRefresh: Promise<void> | null = null;
    /** 0.33.2: guests' busy times from Proton, by address (lower-case) — the window asked for, or "not shared". */
    private busyCache = new Map<string, { at: number; windowStart: number; windowEnd: number; result: FreeBusyAnswer }>();
    private busyLookups = new Map<string, Promise<FreeBusyAnswer>>();
    /** 0.33.2: the user's own busy times for the window last asked (Calendar.app asks per keystroke). */
    private ownBusy: { at: number; windowStart: number; windowEnd: number; periods: Array<{ start: number; end: number; allDay: boolean; tentative?: boolean }> } | null = null;
    /** Invitation emails sent / blocked / simulated (newest first), shown on the Overview page. */
    private recentInvitationEmails: InvitationEmailLogEntry[] = [];
    /** Writes from Calendar.app run one at a time per event, so a retry cannot overlap the original. */
    private eventLocks = new Map<string, Promise<unknown>>();
    /** Meetings (by UID) Calendar.app recently tried to copy into another calendar, i.e. move. */
    private refusedMoves = new Map<string, number>();
    /** Versions a sync pass replaced, by calendar + UID (newest last): see acceptsReplacedVersion. */
    private replacedVersions = new Map<string, Array<{ etag: string; serializedIcs: string; at: number }>>();
    /** A dry run's progress through the mailbox; never saved, so live mode later applies what it reported. */
    private emailedAnswersDryRunCursor: { account: string; cursor: number } | null = null;
    /** 0.41: when the mailbox was last looked through again for replies moved out of Spam (ms; 0 = not yet this run of the app). */
    private emailedAnswersLookedBackAt = 0;
    /** 0.41: the start of a look-back under way (kept until it is done), else null. */
    private emailedAnswersLookBackFrom: number | null = null;
    /** Meetings (Proton UIDs) changed since the last look at the Inbox: their emails are checked first. */
    private calendarEmailsChangedUids = new Set<string>();
    /** Meetings deleted from your calendars while the app ran (Proton UID → when), so emails about them are dealt with. */
    private calendarEmailsGone = new Map<string, number>();
    /** Proton UIDs by Proton event ID (the mirror keeps Calendar.app's UID for meetings created there). */
    private protonUidByEventId = new Map<string, string>();
    private calendarEmailsStatus: CalendarEmailsStatus | null = null;
    private calendarEmailsMoved = 0;
    private calendarEmailsLastProblem: string | undefined;
    /** Shows a macOS notification (set by main.ts; null in tests unless they listen). */
    onNotify: ((notification: BridgeNotification) => void) | null = null;
    /**
     * Proton cannot be reached (its ping failed after a failed pass): awake time without it (a gap
     * longer than two checks is sleep and does not count), whether that was announced.
     */
    private outage: { since: number; awakeMs: number; lastCheckAt: number; notified: boolean } | null = null;
    /** A failed pass is being told apart (ping): lost connection or Proton refusing. */
    private outageCheck: Promise<void> | null = null;
    /** Proton answers its ping but refuses the calendar list (too many requests, session no longer valid …). */
    private refusedPasses: { count: number; since: number; notified: boolean } | null = null;
    /** Calendar.app changes that failed on Proton's side, by path: when last notified. */
    private failedChangeNotifiedAt = new Map<string, number>();
    private connectivityTimer: NodeJS.Timeout | null = null;
    private resumeTimer: NodeJS.Timeout | null = null;
    /** The saved login could not be used at app start (Proton unreachable): tried again once Proton answers. */
    private pendingSignIn: ProtonCredentials | null = null;
    /** 0.48: the last unticked calendar's copy being cleared in the background (tests wait for it). */
    private calendarClearing: Promise<void> | null = null;
    /** 0.46: still restoring the saved login at app start (shown blue in the menu, not as signed out). */
    private starting = true;
    /** 0.46: a sync pass went through since this run's sign-in: until then the menu shows the account blue. */
    private verifiedThisRun = false;
    private signInRetryTimer: NodeJS.Timeout | null = null;
    private signInRetrying = false;
    /** Counts sign-outs: work started before one (a sync after waking up, say) must not carry on after it. */
    private session = 0;
    private signingOut = false;
    /** Successful calendar lists so far: a ping that answers after a later success is ignored. */
    private listingSuccesses = 0;
    /** Sync passes started so far, and how many when the Mac last woke up (a later one is the wake-up sync). */
    private passesStarted = 0;
    /** Proton asked to slow down for a while (RateLimitedError): no sync pass before this time. */
    private slowDownUntil = 0;
    /** Proton ended the session: signing in again with the saved login (one at a time). */
    private sessionRecovery: Promise<void> | null = null;
    /** The last complete sync pass, for Developer settings. */
    private lastPass: SyncPassSummary | null = null;
    /** The sync passes of the last hour, for Developer settings. */
    private passHistory: SyncPassSummary[] = [];
    /** Proton's account feed: the cursor to ask from (kept in the mirror too); null until a full pass fetched one. */
    private accountCursor: string | null = null;
    /** Local day of the last complete full pass: one a day is the safety net, the other passes follow the feeds. */
    private fullPassDay: string | null = null;
    private lastFullPassAt: number | null = null;
    /** When something last changed (Proton's feeds, Calendar.app, a sign-in, waking up): the cadence stays fast for a while after it. */
    private lastActivityAt = Date.now();
    /** The next automatic pass (ms) while the regular sync runs. */
    private nextSyncAt: number | null = null;
    private polling = false;
    /** The mailbox is looked at in the next pass (the account feed reported mail, or a full pass is due). */
    private mailboxDue = true;
    /** Mirror rows created, changed or deleted by the running pass. */
    private passChanges = 0;
    /** Proton rejected the app version: said once per run of the app. */
    private appVersionNotified = false;
    /** What the pause is about when it is not a slow-down (Proton refuses the app version). */
    private slowDownText: string | null = null;
    /** Events left in Proton without guests by a slow-down (a new meeting's first step): removed at the next pass. */
    private passesAtWake = 0;
    private syncingAfterWake = false;
    /** macOS's login item status, asked at most every few seconds (getBridgeState runs often). */
    private loginItemStatusCache: { at: number; status: string | null } | null = null;
    /** Checks whether Proton can be reached (replaceable in tests). */
    probeConnection: () => Promise<boolean> = pingProton;
    /** After waking up, the network needs a moment; then Proton's ping is tried every resumeRetryMs. */
    resumeSyncDelayMs = 5000;
    resumeRetryMs = 5000;

    /** Set by main.ts from package.json; tests leave it empty. */
    appVersion = '';

    constructor(
        private readonly baseDir: string,
        private readonly options: BridgeServiceOptions = {}
    ) {
        this.configStore = options.configStore ?? new ConfigStore(baseDir);
        this.secretStore = new SecretStore(baseDir);
        this.mirrorDatabase = new MirrorDatabase(baseDir);
        this.protonAdapter = new ProtonAdapter(options.clientStateDir ?? join(baseDir, 'proton-calendar-client'));
        this.applyInvitationPolicy();
        this.applyDetailedLogging();
    }

    /** 0.36: this account's ID among several (null for the one-account service of the tests). */
    get accountId() {
        return this.options.account?.id ?? null;
    }

    /** The user name the saved login is for (known before the session is restored). */
    private knownUsername: string | null = null;

    /**
     * 0.36: what to call the account: its primary address once known, else the user name signed in
     * or saved, else null (the window says "Proton Account").
     */
    principalDisplayName(): string | null {
        // 0.40.4: the name of this account's principal. Calendar.app shows it for this account wherever it
        // matches one of its addresses, e.g. as the invitee of a meeting made in the other account; the
        // CalDAV user name (neutron-<id>) meant nothing there. Proton's display name of the first address,
        // else the address.
        let addresses: Array<{ email: string; displayName?: string; order?: number }> = [];
        try {
            const listed: unknown = this.protonAdapter.listAddresses?.();
            addresses = Array.isArray(listed) ? listed : [];
        } catch {
            addresses = []; // not signed in (yet): the account label below
        }
        const [first] = addresses.slice().sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
        return first?.displayName?.trim() || first?.email || this.accountLabel();
    }

    accountLabel(): string | null {
        return this.accountAddresses[0] || this.protonAdapter.getSignedInUsername() || this.knownUsername || null;
    }

    /** 0.36: the settings store (the account manager reads an account's own keys through it). */
    getConfigStore() {
        return this.configStore;
    }

    /** 0.36: a login is saved (or saved and unreadable right now): this folder is an account's. */
    async hasSavedLogin() {
        if (this.secretStore.isUnreadable()) {
            return true;
        }
        return Boolean(await this.secretStore.getProtonCredentials().catch(() => null));
    }

    /**
     * Detailed logging (Developer settings) for the log sink: only while developer options are on;
     * "for 24 hours" switches itself off then (the sink checks the time of every line, so it is quiet
     * again on time even if the Mac slept through it).
     */
    private applyDetailedLogging() {
        if (this.detailedLoggingTimer) {
            clearTimeout(this.detailedLoggingTimer);
            this.detailedLoggingTimer = null;
        }
        const config = this.configStore.load();
        if (config.detailedLogging === '24h' && !(Number(config.detailedLoggingUntil) > Date.now())) {
            this.configStore.update({ detailedLogging: 'off', detailedLoggingUntil: null });
            setDetailedLogging(0);
            console.log('[settings] detailed logging: off (its 24 hours are up)');
            this.notifyStateChange();
            return;
        }
        const until = !config.developerMode || config.detailedLogging === 'off' ? 0 : config.detailedLogging === 'on' ? Infinity : Number(config.detailedLoggingUntil);
        setDetailedLogging(until);
        if (Number.isFinite(until) && until > 0) {
            this.detailedLoggingTimer = setTimeout(() => this.applyDetailedLogging(), Math.min(Math.max(until - Date.now(), 0) + 1000, 2 ** 31 - 1));
            this.detailedLoggingTimer.unref?.();
        }
    }

    async initialize() {
        try {
            await this.restoreAtStart();
        } finally {
            this.starting = false;
        }
    }

    private async restoreAtStart() {
        const legacyLocalPassword = this.configStore.consumeLegacyLocalPassword() || undefined;
        this.localCaldavPassword = await this.secretStore.ensureLocalCaldavPassword(legacyLocalPassword);
        await this.openMirror();

        const savedCredentials = await this.secretStore.getProtonCredentials();
        this.knownUsername = savedCredentials?.username || null;
        if (!savedCredentials) {
            if (this.secretStore.isUnreadable()) {
                this.setHealth('error', () =>
                    t('macOS did not let the app read your saved login (Keychain). Quit and reopen the app and choose "Always Allow" when macOS asks.')
                );
            }
            return;
        }

        // The session saved last time: no password sign-in while Proton still accepts it. 0.50: only one
        // opened under the bridge's own identity (an older one, opened as Proton's iOS Mail app, is not
        // resumed under another identity; you sign in again).
        const savedSession = await this.secretStore.getProtonSession();
        if (savedSession && savedSession.identity !== 'own') {
            console.log('[proton] the saved session was opened under a former identity; it is not resumed');
        }
        try {
            await this.signIn(savedCredentials, false, null, savedSession?.username === savedCredentials.username && savedSession.identity === 'own' ? savedSession : null);
        } catch (error) {
            if (errorName(error) === SIGNED_OUT_MEANWHILE) {
                return;
            }
            if (errorName(error) === 'AppVersionError') {
                this.noteAppVersionRejected(errorText(error));
            }
            // Proton asked to slow down: sign in once its time is up.
            if (errorName(error) === 'RateLimitedError' && !this.protonAdapter.isSignedIn()) {
                this.noteSlowDown(error);
                this.retrySignInWhenReachable(savedCredentials, slowDownMessage(this.slowDownUntil));
                return;
            }
            // Offline at start (login item before the network, VPN, captive portal), or Proton has server
            // trouble: sign in once Proton answers.
            if ((isServerTrouble(error) && !this.protonAdapter.isSignedIn()) || (await this.failedForLackOfConnection(error))) {
                this.retrySignInWhenReachable(savedCredentials);
                return;
            }
            // Verification asked for: signIn already says so ("Additional verification required …").
            if (!this.pendingHumanVerification) {
                this.setHealth('error', error instanceof Error ? error.message : () => t('Failed to restore session'));
            }
        }
    }

    /**
     * The local copy of the calendars, encrypted with a key kept with the saved login. When that
     * cannot be read (Keychain refused) the file is left as it is, so "Always Allow" brings it back,
     * and this run works on a copy in memory that the first sync fills.
     */
    private async openMirror() {
        const memory = async (why: string, notify: boolean) => {
            console.warn(`[mirror] ${why}: the local copy on disk is left as it is; this run keeps one in memory`);
            await this.mirrorDatabase.initialize({ memory: true });
            this.localCopyNote = t('The local copy of your calendars is kept in memory this run ({why}). Everything works, but the copy is rebuilt from Proton at every start until this is solved.', { why });
            if (notify) {
                this.notify({ key: 'mirror:memory', title: t('Local copy in memory only'), body: t('{why}. The bridge works, and tries again at the next start.', { why: `${why[0].toUpperCase()}${why.slice(1)}` }), page: 'overview' });
            }
        };
        if (this.secretStore.isUnreadable()) {
            // The window already says to allow the Keychain (saved login).
            return memory('the saved login (with the key of the local copy) cannot be read', false);
        }
        const { key, saved } = await this.secretStore.ensureMirrorKey();
        if (!saved) {
            return memory('the key of the local copy cannot be saved (Keychain refused)', true);
        }
        let opened: MirrorOpenResult;
        try {
            opened = await this.mirrorDatabase.initialize({ key });
        } catch (error) {
            // e.g. the disk is full while converting: the unencrypted file is still there, and the next start tries again.
            await this.mirrorDatabase.close().catch(() => undefined);
            return memory(`the local copy could not be opened (${errorText(error)})`, true);
        }
        if (opened.converted) {
            console.log('[mirror] the local copy of the calendars is encrypted now (converted in place)');
        }
        if (opened.discardedDamaged) {
            console.warn('[mirror] the unencrypted local copy from before was damaged: deleted, a new encrypted one is filled by the next sync');
        }
        if (opened.replacedBy) {
            console.warn(`[mirror] the local copy could not be opened with its key, or is damaged; set aside as ${opened.replacedBy}, a new one is filled by the next sync`);
        }
        await this.loadPendingUids();
        if (this.pendingChangeCount()) {
            console.log(`[outbox] ${this.pendingChangeCount()} change(s) from Calendar.app still wait for Proton`);
        }
    }

    async shutdown() {
        this.stopPolling();
        await this.mirrorDatabase.close();
    }

    async signIn(
        credentials: ProtonCredentials,
        persist: boolean = true,
        challengeOverride: HumanVerificationChallenge | null = null,
        savedSession: SavedProtonSession | null = null
    ): Promise<BridgeState> {
        // Signing out meanwhile (e.g. during a sign-in in the background) wins: see below.
        const sessionAtStart = this.session;
        // No password kept (0.45: the bridge's own sign-in; before 0.47 also "Sign In with Proton") and the
        // saved session is gone: nothing to sign in with until you sign in again.
        if (!credentials.password && !savedSession) {
            this.setHealth('error', () => t('Proton ended the session. Sign in again on the Setup page.'));
            throw Object.assign(new Error(t('Proton ended the session. Sign in again on the Setup page.')), { name: 'SessionExpiredError' });
        }
        if (persist) {
            // You sign in yourself (perhaps with a new password): the retry with the saved login stops.
            this.cancelPendingSignIn();
        }
        this.verifiedThisRun = false; // 0.46: a new connection: blue in the menu until its first pass went through
        this.setHealth('connecting', () => t('Connecting to Proton…'));
        const reusePendingChallenge =
            this.pendingHumanVerification &&
            this.pendingCredentials?.username === credentials.username &&
            this.pendingCredentials?.password === credentials.password;
        const humanVerification = challengeOverride ?? (reusePendingChallenge ? this.pendingHumanVerification : null);
        /** This sign-in's prompts (another sign-in ending does not answer them). */
        const owner = {};
        /** 0.45: a new password sign-in (under the bridge's own identity: its password is not kept). */
        let signedInWithPassword = false;

        try {
            // Proton's session (after signing in, after each renewal) is kept to resume at the next start.
            this.protonAdapter.onSession = (session) => {
                if (this.session !== sessionAtStart || this.signingOut) {
                    return; // signed out meanwhile: this session is nobody's
                }
                const username = credentials.username || this.protonAdapter.getSignedInUsername() || '';
                this.secretStore
                    .setProtonSession({ username, ...session })
                    .catch((error) => console.warn(`[proton] could not save the session: ${errorText(error)}`));
            };
            // Two-factor authentication and two-password mode (0.27): asked on the Setup page. The
            // prompts belong to this sign-in (`owner`): another one ending does not answer them.
            const background = !persist;
            this.protonAdapter.askSecondFactor = async (request) => {
                if (this.session !== sessionAtStart || this.signingOut) {
                    return null;
                }
                if (!request.totp) {
                    return null; // a security key only: the client explains what to do
                }
                const answer = await this.promptForSignIn(owner, { kind: 'second-factor', totp: request.totp, securityKey: request.securityKey, wrong: request.wrong, background });
                return answer && 'code' in answer ? { code: answer.code } : null;
            };
            this.protonAdapter.askMailboxPassword = async (request) => {
                if (this.session !== sessionAtStart || this.signingOut) {
                    return null;
                }
                const answer = await this.promptForSignIn(owner, { kind: 'mailbox-password', totp: false, securityKey: false, wrong: request.wrong, background });
                return answer && 'mailboxPassword' in answer ? answer.mailboxPassword : null;
            };
            // 0.45: a password sign-in is the bridge's own, under its own identity (0.50: the only one).
            signedInWithPassword = Boolean(credentials.password) && !savedSession;
            this.protonAdapter.appVersion = this.appVersion || '0';
            const generation = await this.protonAdapter.signIn(credentials, humanVerification, humanVerification ? null : savedSession);
            if (this.session !== sessionAtStart || this.signingOut) {
                // You signed out while this sign-in ran (in the background): it does not count. Only
                // this sign-in's client is ended, never one you signed in with since.
                await this.protonAdapter.signOut(true, typeof generation === 'number' ? generation : undefined);
                throw Object.assign(new Error('Signed out meanwhile.'), { name: SIGNED_OUT_MEANWHILE });
            }
            const stats = this.adapterRequestStats();
            if (stats) {
                console.log(`[proton] ${stats.resumedSession ? 'resumed the saved session (no password sign-in)' : 'signed in with the password'}`);
            }
            this.slowDownUntil = 0;
            this.slowDownText = null;
        } catch (error) {
            this.clearSignInPrompt(null, owner);
            if (error instanceof ProtonHumanVerificationRequiredError) {
                this.pendingHumanVerification = error.challenge;
                this.pendingCredentials = credentials;
                this.setHealth('connecting', () => t('Additional verification required to finish signing in.'));
                throw new Error(t('Proton requested additional verification for this sign-in attempt.'));
            }
            if (errorName(error) !== SIGNED_OUT_MEANWHILE) {
                // A prompt given up or not answered: say that, not the client's general wording.
                const ending = this.signInPromptEnding;
                this.signInPromptEnding = null;
                const message =
                    ending && (errorName(error) === 'TwoFactorRequiredError' || errorName(error) === 'MailboxPasswordRequiredError')
                        ? ending === 'timed out'
                            ? errorName(error) === 'TwoFactorRequiredError'
                                ? t('Signing in was not finished in time (Proton asked for your authenticator code).')
                                : t('Signing in was not finished in time (Proton asked for your mailbox password).')
                            : errorName(error) === 'TwoFactorRequiredError'
                              ? t('Signing in was cancelled (Proton asked for your authenticator code).')
                              : t('Signing in was cancelled (Proton asked for your mailbox password).')
                        : error instanceof Error
                          ? error.message
                          : t('Failed to sign in to Proton');
                this.setHealth('error', message);
                if (message !== (error instanceof Error ? error.message : '')) {
                    throw new Error(message);
                }
            }
            throw error;
        } finally {
            this.protonAdapter.askSecondFactor = null;
            this.protonAdapter.askMailboxPassword = null;
        }
        this.clearSignInPrompt(null, owner);

        this.pendingHumanVerification = null;
        this.pendingCredentials = null;
        this.cancelPendingSignIn();
        this.knownUsername = credentials.username || this.protonAdapter.getSignedInUsername() || this.knownUsername;
        if (persist) {
            // 0.45: under the bridge's own identity the password is not kept: Proton asks for a CAPTCHA at a
            // password sign-in anyway, so the bridge could not sign in again by itself; the session is kept.
            await this.secretStore.setProtonCredentials(signedInWithPassword ? { ...credentials, password: '' } : credentials);
        }
        // 0.36: a new account is adopted here (its CalDAV user name chosen before the mirror fills).
        this.options.account?.onSignedIn?.(this);

        this.refreshAccountAddresses();
        this.busyCache.clear(); // what Proton would not share with the previous session may be shared now
        const session = this.session;
        try {
            // Signing in (also at app start) syncs everything, public holidays included.
            await this.syncNow('login');
        } finally {
            // Also when that first pass fails: the regular sync (and the connection watch) carry on.
            // Not if you signed out meanwhile.
            if (this.session === session && !this.signingOut) {
                this.startPolling();
            }
        }
        // Keep the sync pass's own verdict (e.g. "sync failed for …") instead of overwriting it.
        if (this.health !== 'healthy' && this.health !== 'error') {
            this.setHealth('healthy', () => t('Bridge connected'));
        }
        return this.getBridgeState();
    }

    async signOut(): Promise<BridgeState> {
        if (this.pendingChangeCount()) {
            console.warn(`[outbox] signing out: ${this.pendingChangeCount()} change(s) that waited for Proton are dropped`);
            this.notify({ key: 'outbox-dropped', title: t('Changes not sent'), body: tn('{count} change made while Proton could not be reached was dropped at sign-out.', '{count} changes made while Proton could not be reached were dropped at sign-out.', this.pendingChangeCount()), page: 'overview' });
        }
        this.pendingUids = new Map();
        this.outboxWarned.clear();
        this.contacts = null;
        this.busyCache.clear();
        this.ownBusy = null;
        this.contactsRefresh = null; // a refresh still running finds the session changed and keeps nothing
        this.session += 1;
        this.signingOut = true;
        try {
            return await this.performSignOut();
        } finally {
            this.signingOut = false;
        }
    }

    private async performSignOut(): Promise<BridgeState> {
        this.stopPolling();
        // Nothing may write to the mirror after it is cleared: stop the queue and let running work end.
        this.syncQueue = [];
        if (this.outboxTimer) {
            clearTimeout(this.outboxTimer);
            this.outboxTimer = null;
        }
        await this.passInFlight?.catch(() => undefined);
        await this.queueRunner?.catch(() => undefined);
        await this.flushInFlight?.catch(() => undefined);
        await this.protonAdapter.signOut();
        await this.secretStore.setProtonCredentials(null);
        await this.mirrorDatabase.clearAll();
        this.lastSuccessfulSyncAt = null;
        this.lastAttemptedSyncAt = null;
        this.verifiedThisRun = false;
        this.pendingHumanVerification = null;
        this.pendingCredentials = null;
        this.clearSignInPrompt();
        this.calendarErrors.clear();
        this.calendarWarnings.clear();
        this.connectionError = null;
        this.calendarEmailsChangedUids.clear();
        this.calendarEmailsGone.clear();
        this.protonUidByEventId.clear();
        this.calendarEmailsStatus = null;
        this.calendarEmailsMoved = 0;
        this.calendarEmailsLastProblem = undefined;
        this.outage = null;
        this.refusedPasses = null;
        this.slowDownUntil = 0;
        this.slowDownText = null;
        // 0.42: leftovers stay saved for this account: removed after its next sign-in.
        this.lastPass = null;
        this.passHistory = [];
        this.accountCursor = null;
        this.fullPassDay = null;
        this.lastFullPassAt = null;
        this.mailboxDue = true;
        this.appVersionNotified = false;
        this.failedChangeNotifiedAt.clear();
        this.syncQueue = [];
        this.holidaysSyncedOn = null;
        this.activeCalendarIds = null;
        this.accountAddresses = [];
        this.activeAddresses = [];
        this.setHealth('disconnected', () => t('Signed out'));
        return this.getBridgeState();
    }

    async completeHumanVerification(submission?: HumanVerificationSubmission): Promise<BridgeState> {
        if (!this.pendingHumanVerification || !this.pendingCredentials) {
            throw new Error(t('There is no pending verification challenge to complete.'));
        }

        const challengeOverride = submission
            ? {
                  ...this.pendingHumanVerification,
                  token: submission.token,
                  tokenType: submission.tokenType
              }
            : this.pendingHumanVerification;

        try {
            return await this.signIn(this.pendingCredentials, true, challengeOverride);
        } catch (error) {
            if (errorName(error) === SIGNED_OUT_MEANWHILE) {
                return this.getBridgeState(); // signed out meanwhile: nothing to report
            }
            throw error;
        }
    }

    async cancelHumanVerification(): Promise<BridgeState> {
        this.pendingHumanVerification = null;
        this.pendingCredentials = null;
        if (!this.protonAdapter.isSignedIn()) {
            this.setHealth('disconnected', () => t('Signed out'));
        }
        return this.getBridgeState();
    }

    getPendingHumanVerification() {
        return this.pendingHumanVerification;
    }

    /**
     * Shows a sign-in prompt (an authenticator code, the mailbox password) on the Setup page and
     * waits for the answer; a sign-in in the background (app start, Proton ended the session) is
     * also announced with a notification. Null when it is cancelled, or nobody answers in time.
     */
    private promptForSignIn(owner: object, prompt: Omit<SignInPrompt, 'expiresAt'>): Promise<SignInPromptAnswer | null> {
        this.clearSignInPrompt();
        this.signInPromptEnding = null;
        return new Promise((resolve) => {
            const timer = setTimeout(() => {
                if (this.signInPromptWaiter?.resolve === resolve) {
                    console.log(`[proton] the sign-in prompt (${prompt.kind}) was not answered in time`);
                    this.signInPromptEnding = 'timed out';
                    this.clearSignInPrompt();
                }
            }, SIGN_IN_PROMPT_MS);
            timer.unref?.();
            this.signInPromptWaiter = { resolve, timer, owner };
            this.signInPrompt = { ...prompt, expiresAt: Date.now() + SIGN_IN_PROMPT_MS };
            this.setHealth('connecting', () => (prompt.kind === 'second-factor' ? t('Proton asks for your authenticator code.') : t('Proton asks for your mailbox password.')));
            if (prompt.background && !prompt.wrong) {
                this.notify({
                    key: `sign-in:${prompt.kind}`,
                    title: prompt.kind === 'second-factor' ? t('Proton asks for your authenticator code') : t('Proton asks for your mailbox password'),
                    body: t('Open the bridge to finish signing in. Syncing waits until then.'),
                    page: 'setup'
                });
            }
            this.notifyStateChange();
        });
    }

    /** Ends the prompt, answering the waiting sign-in with `answer` (null: given up); `owner`: only that sign-in's prompt. */
    private clearSignInPrompt(answer: SignInPromptAnswer | null = null, owner?: object) {
        const waiter = this.signInPromptWaiter;
        if (owner && waiter && waiter.owner !== owner) {
            return; // another sign-in's prompt
        }
        this.signInPromptWaiter = null;
        this.signInPrompt = null;
        if (waiter) {
            clearTimeout(waiter.timer);
            waiter.resolve(answer);
            this.notifyStateChange();
        }
    }

    /** The code or mailbox password typed on the Setup page. */
    async answerSignInPrompt(answer: SignInPromptAnswer): Promise<BridgeState> {
        if (!this.signInPrompt || !this.signInPromptWaiter) {
            throw new Error(t('Proton is not asking for anything right now.'));
        }
        if ('code' in answer) {
            // A 6-digit authenticator code, or one of Proton's 8-character recovery codes.
            const code = String(answer.code || '').replace(/\s+/g, '');
            if (!/^[A-Za-z0-9]{6,8}$/.test(code)) {
                throw new Error(t('Enter the 6-digit code from your authenticator app (or an 8-character recovery code).'));
            }
            this.clearSignInPrompt({ code });
        } else {
            if (!answer.mailboxPassword) {
                throw new Error(t('Enter your mailbox password.'));
            }
            this.clearSignInPrompt({ mailboxPassword: answer.mailboxPassword });
        }
        return this.getBridgeState();
    }

    /** "Cancel" on the prompt: the sign-in gives up (a background one says so in the status). */
    async cancelSignInPrompt(): Promise<BridgeState> {
        if (this.signInPromptWaiter) {
            this.signInPromptEnding = 'cancelled';
        }
        this.clearSignInPrompt(null);
        return this.getBridgeState();
    }

    /** The Refresh button: every ticked calendar except public holidays; clears yellow dots of what it synced. */
    async refreshNow() {
        this.noteActivity();
        await this.syncNow('refresh');
        return this.getSyncStatus();
    }

    /**
     * Syncs one calendar (from its button on the Calendars page), behind whatever is queued. A
     * second click while it waits takes it off the queue again (only if it was queued by a click).
     */
    async syncCalendar(protonCalendarId: string) {
        if (!this.protonAdapter.isSignedIn()) {
            throw new Error(t('Sign in to Proton first.'));
        }
        const queued = this.syncQueue.findIndex((job) => job.calendarId === protonCalendarId);
        if (queued >= 0) {
            if (this.syncQueue[queued].manual) {
                this.syncQueue.splice(queued, 1);
                this.notifyStateChange();
            }
            return this.getBridgeState();
        }
        if (this.syncingCalendarId !== protonCalendarId) {
            const calendar = (await this.mirrorDatabase.listCalendars(true)).find((entry) => entry.protonCalendarId === protonCalendarId);
            if (!calendar || calendar.removed || !this.isCalendarSyncEnabled(protonCalendarId)) {
                throw new Error(t('This calendar is not synced.'));
            }
            this.enqueue(protonCalendarId, { manual: true, clearsWarnings: true });
            this.drainInBackground();
        }
        return this.getBridgeState();
    }

    /** Syncs every ticked calendar of a group; public holidays are synced one calendar at a time. */
    async syncCategory(kind: CalendarKind) {
        if (!this.protonAdapter.isSignedIn()) {
            throw new Error(t('Sign in to Proton first.'));
        }
        if (kind === 'holidays') {
            throw new Error(t('Public holidays are synced one calendar at a time.'));
        }
        const calendars = await this.mirrorDatabase.listCalendars();
        for (const calendar of calendars) {
            if ((calendar.kind ?? 'own') === kind && this.isCalendarSyncEnabled(calendar.protonCalendarId)) {
                this.enqueue(calendar.protonCalendarId, { manual: true, clearsWarnings: true });
            }
        }
        this.drainInBackground();
        return this.getBridgeState();
    }

    async setOpenAtLogin(enabled: boolean) {
        this.configStore.update({ openAtLogin: enabled, loginItemAppPath: enabled ? process.execPath : null });
        electronApp.setLoginItemSettings({ openAtLogin: enabled });
        this.loginItemStatusCache = null;
        return this.getBridgeState();
    }

    /** macOS's own state of the login item (macOS 13+), or null where it cannot be asked. */
    private loginItemStatus(): string | null {
        if (process.platform !== 'darwin' || !electronApp.isPackaged) {
            return null;
        }
        const now = Date.now();
        if (this.loginItemStatusCache && now - this.loginItemStatusCache.at < 5000) {
            return this.loginItemStatusCache.status;
        }
        let status: string | null = null;
        try {
            status = (electronApp.getLoginItemSettings() as { status?: string }).status ?? null;
        } catch {
            status = null;
        }
        this.loginItemStatusCache = { at: now, status };
        return status;
    }

    /**
     * At start: the login item belongs to the app that registered it, so it is registered again when
     * macOS does not have it, and once whenever the app is a different one than at the last
     * registration (a build under another path, or a renamed app, had registered it). One switched
     * off in System Settings is left off (the setting says so).
     */
    refreshLoginItem(appPath: string = process.execPath) {
        const config = this.configStore.load();
        if (!config.openAtLogin) {
            return;
        }
        const status = this.loginItemStatus();
        if (status === null || status === 'requires-approval' || (status === 'enabled' && config.loginItemAppPath === appPath)) {
            return;
        }
        try {
            electronApp.setLoginItemSettings({ openAtLogin: true });
            this.configStore.update({ loginItemAppPath: appPath });
            this.loginItemStatusCache = null;
            console.log(`[app] login item registered again for this app (macOS had: ${status})`);
        } catch (error) {
            console.warn(`[app] could not register the login item: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    /** Shown under "Open on startup" when macOS disagrees with the setting. */
    private loginItemNote(enabled: boolean) {
        if (!enabled) {
            return null;
        }
        switch (this.loginItemStatus()) {
            case 'requires-approval':
                return 'macOS has this switched off: System Settings › General › Login Items.';
            case 'not-registered':
            case 'not-found':
                return 'macOS does not have this app as a login item: untick and tick again.';
            default:
                return null;
        }
    }

    /**
     * Ticks or unticks a calendar. Unticked calendars are skipped when pulling from Proton,
     * are no longer served over CalDAV (Calendar.app drops them on its next refresh), and
     * their mirrored events are discarded. Ticking one again pulls it fresh from Proton.
     */
    async setCalendarSyncEnabled(protonCalendarId: string, enabled: boolean) {
        if (typeof protonCalendarId !== 'string' || !protonCalendarId) {
            throw new Error('Missing calendar ID');
        }

        const excluded = new Set(this.configStore.load().excludedCalendarIds);
        if (enabled) {
            excluded.delete(protonCalendarId);
        } else {
            excluded.add(protonCalendarId);
        }
        this.configStore.update({ excludedCalendarIds: [...excluded] });

        if (!enabled) {
            this.syncQueue = this.syncQueue.filter((job) => job.calendarId !== protonCalendarId);
            // Let a running sync of it finish first so it can't write events back after we clear them.
            // 0.48: in the background — the tick is saved (and Calendar.app no longer gets the calendar)
            // at once, so other calendars can be ticked or unticked while an account syncs.
            const cleared = this.withCalendarLock(protonCalendarId, async () => {
                if (!new Set(this.configStore.load().excludedCalendarIds).has(protonCalendarId)) {
                    return; // ticked again meanwhile: its sync (queued behind this) fills it again anyway
                }
                this.calendarErrors.delete(protonCalendarId);
                this.calendarWarnings.delete(protonCalendarId);
                await this.mirrorDatabase.deleteEventsForCalendar(protonCalendarId);
            });
            this.calendarClearing = cleared
                .catch((error) => console.error(`[calendars] clearing an unticked calendar's copy failed: ${errorText(error)}`))
                .finally(() => this.notifyStateChange());
        } else if (this.protonAdapter.isSignedIn()) {
            // Ticking a calendar pulls it from Proton right away (behind whatever is queued). 0.48: without
            // waiting for that sync (and for the rest of the queue), so the window stays free meanwhile.
            this.enqueue(protonCalendarId, { manual: true, clearsWarnings: true });
            this.drainInBackground();
        }
        this.notifyStateChange();

        return this.getBridgeState();
    }

    /**
     * 0.37: Calendar.app deleted the calendar: it is unticked here (gone from Calendar.app, kept in
     * Proton; the Calendars page ticks it again), and a notification says so.
     */
    async untickFromCalendarApp(slug: string) {
        const calendar = await this.mirrorDatabase.getCalendarBySlug(slug);
        if (!calendar) {
            throw Object.assign(new Error(t('Calendar not found')), { name: 'CalendarNotFoundError' });
        }
        const waiting = this.pendingUids.get(calendar.protonCalendarId)?.size ?? 0;
        const app = currentAppName(); // 0.49.13: the app that deleted it (Calendar.app, Thunderbird, …)
        console.log(`[calendars] "${secret(calendar.displayName)}" deleted in ${app}: unticked here, kept in Proton${waiting ? `; ${waiting} change(s) that waited for Proton are dropped` : ''}`);
        await this.setCalendarSyncEnabled(calendar.protonCalendarId, false);
        this.notify({
            key: `calendar-unticked:${calendar.protonCalendarId}`,
            title: t('Calendar removed from {app} only', { app }),
            subtitle: calendar.displayName,
            body: waiting
                ? tn('The calendar stays in Proton Calendar; {count} change made while Proton could not be reached is dropped. To see the calendar in {app} again, tick it on the Calendars page.', 'The calendar stays in Proton Calendar; {count} changes made while Proton could not be reached are dropped. To see the calendar in {app} again, tick it on the Calendars page.', waiting, { app })
                : t('The calendar stays in Proton Calendar. To see it in {app} again, tick it on the Calendars page.', { app }),
            page: 'calendars'
        });
    }

    /** Saved Appearance setting; safe to call before initialize(). */
    /** 0.32: the language setting ('system' or a code). */
    getAppLanguagePreference(): string {
        return this.configStore.load().appLanguage || 'system';
    }

    getThemePreference() {
        return this.configStore.load().theme;
    }

    isCalendarSyncEnabled(protonCalendarId: string) {
        return !this.configStore.load().excludedCalendarIds.includes(protonCalendarId);
    }

    /**
     * 0.37.7: whether a calendar's events count towards availability (RFC 6638 schedule-calendar-transp,
     * Calendar.app's "Events affect availability"): own and shared calendars do unless switched off in
     * Calendar.app; holiday and subscribed calendars never (as in Proton Calendar).
     */
    isCalendarOpaque(calendar: Pick<BridgeCalendarRecord, 'protonCalendarId' | 'kind'>) {
        const kind = calendar.kind ?? 'own';
        return (kind === 'own' || kind === 'shared') && !this.configStore.load().transparentCalendarIds.includes(calendar.protonCalendarId);
    }

    /** Calendar.app switched "Events affect availability" for a calendar (PROPPATCH schedule-calendar-transp). */
    async setCalendarAvailability(slug: string, opaque: boolean) {
        const calendar = await this.mirrorDatabase.getCalendarBySlug(slug);
        if (!calendar) {
            return;
        }
        const transparent = new Set(this.configStore.load().transparentCalendarIds);
        if (opaque ? !transparent.delete(calendar.protonCalendarId) : transparent.has(calendar.protonCalendarId)) {
            return; // as it was
        }
        if (!opaque) {
            transparent.add(calendar.protonCalendarId);
        }
        this.configStore.update({ transparentCalendarIds: [...transparent] });
        this.ownBusy = null;
        console.log(`[availability] "${secret(calendar.displayName)}" ${opaque ? 'counts' : 'no longer counts'} towards your availability (Calendar.app)`);
    }

    async updateConfig(requested: BridgeConfigPatch) {
        // Only the settings the window may change (not e.g. the mailbox cursor).
        const allowed: Array<keyof BridgeConfigPatch> = [
            'pollIntervalMs',
            'eventLookbackDays',
            'eventLookaheadDays',
            'theme',
            'appLanguage',
            'invitationEmailMode',
            'invitationEmailAllowlist',
            'invitationEmailLanguage',
            'applyEmailedAnswers',
            'developerMode',
            'calendarEmailsAfter',
            'calendarEmailsFolder',
            'newCalendarAddress',
            'notifications',
            'notificationTitles',
            'autoUpdate',
            'detailedLogging'
        ];
        const patch = Object.fromEntries(
            Object.entries(requested || {}).filter(([key]) => allowed.includes(key as keyof BridgeConfigPatch))
        ) as BridgeConfigPatch;
        if (patch.invitationEmailMode !== undefined && !['test', 'dry-run', 'live'].includes(patch.invitationEmailMode)) {
            throw new Error(`Unknown invitation email mode: ${patch.invitationEmailMode}`);
        }
        if (patch.appLanguage !== undefined && patch.appLanguage !== 'system' && !isAppLanguage(patch.appLanguage)) {
            throw new Error(`Unknown app language: ${String(patch.appLanguage)}`);
        }
        if (patch.invitationEmailLanguage !== undefined) {
            const language = patch.invitationEmailLanguage;
            const offered = await this.listInvitationLanguages();
            if (language !== 'proton' && !offered.some((entry) => entry.code === language)) {
                throw new Error(`Unknown invitation email language: ${String(language)}`);
            }
        }
        if (patch.detailedLogging !== undefined && !['off', '24h', 'on'].includes(patch.detailedLogging)) {
            throw new Error(`Unknown choice for detailed logging: ${patch.detailedLogging}`);
        }
        for (const key of ['applyEmailedAnswers', 'developerMode', 'notifications', 'notificationTitles', 'autoUpdate'] as const) {
            if (patch[key] !== undefined && typeof patch[key] !== 'boolean') {
                throw new Error(`${key} must be true or false`);
            }
        }
        if (patch.calendarEmailsAfter !== undefined && !CALENDAR_EMAILS_AFTER.includes(patch.calendarEmailsAfter)) {
            throw new Error(`Unknown choice for emails about meetings: ${patch.calendarEmailsAfter}`);
        }
        if (patch.calendarEmailsFolder !== undefined) {
            const name = typeof patch.calendarEmailsFolder === 'string' ? patch.calendarEmailsFolder.trim() : '';
            if (!name) {
                throw new Error(t('The folder needs a name'));
            }
            if (name.length > 100) {
                throw new Error(t('A folder name can have at most 100 characters'));
            }
            if (name.includes('/')) {
                throw new Error(t('Use a folder name without "/" (only folders at the top level)'));
            }
            if (RESERVED_FOLDER_NAMES.has(name.toLowerCase())) {
                throw new Error(t('"{name}" is one of Proton\'s own folders: choose Bin or Archive instead, or another name', { name }));
            }
            patch.calendarEmailsFolder = name;
        }
        if (patch.newCalendarAddress !== undefined) {
            // '' = the first active address; otherwise one of the account's addresses (as listed, case-insensitive).
            const wanted = String(patch.newCalendarAddress || '').trim();
            const known = this.activeAddresses.find((address) => address.toLowerCase() === wanted.toLowerCase());
            if (wanted && !known) {
                throw new Error(t('"{address}" is not one of this account\'s addresses', { address: wanted }));
            }
            patch.newCalendarAddress = known ?? '';
        }
        const stored: Partial<BridgeConfig> = { ...patch };
        if (patch.detailedLogging !== undefined) {
            stored.detailedLoggingUntil = patch.detailedLogging === '24h' ? Date.now() + DETAILED_LOGGING_MS : null;
        }
        if (patch.developerMode === false) {
            // Switched off with developer options, so it never comes back on unnoticed.
            stored.detailedLogging = 'off';
            stored.detailedLoggingUntil = null;
        }
        const before = this.configStore.load();
        this.configStore.update(stored);
        if (stored.detailedLogging !== undefined || patch.developerMode !== undefined) {
            this.applyDetailedLogging();
            const after = this.configStore.load();
            if (after.detailedLogging !== before.detailedLogging || after.detailedLoggingUntil !== before.detailedLoggingUntil) {
                console.log(
                    `[settings] detailed logging: ${
                        after.detailedLogging === 'off'
                            ? 'off'
                            : after.detailedLogging === 'on'
                              ? 'on until switched off (titles, addresses, subjects and email text in bridge.log)'
                              : `on until ${new Date(after.detailedLoggingUntil!).toISOString()} (titles, addresses, subjects and email text in bridge.log)`
                    }`
                );
            }
        }
        if (patch.notificationTitles !== undefined) {
            console.log(`[settings] event titles in notifications: ${patch.notificationTitles ? 'shown' : 'left out'}`);
        }
        if (patch.invitationEmailLanguage !== undefined) {
            console.log(`[settings] invitation emails in: ${patch.invitationEmailLanguage === 'proton' ? "Proton Calendar's language" : patch.invitationEmailLanguage}`);
        }
        if (patch.pollIntervalMs && this.polling) {
            this.scheduleNextSync();
        }
        if (patch.eventLookbackDays !== undefined || patch.eventLookaheadDays !== undefined) {
            this.fullPassDay = null; // the next automatic pass lists the new window in full
        }
        if (patch.invitationEmailMode !== undefined || patch.invitationEmailAllowlist !== undefined || patch.invitationEmailLanguage !== undefined || patch.developerMode !== undefined) {
            this.applyInvitationPolicy();
            const config = this.configStore.load();
            console.log(
                `[invitations] email mode: ${this.effectiveEmailMode(config)}${config.developerMode ? '' : ` (developer options off; setting: ${config.invitationEmailMode})`}; allowlist: ${config.invitationEmailAllowlist.join(', ') || '(empty)'}`
            );
        }
        if (patch.developerMode !== undefined) {
            console.log(`[settings] developer options: ${patch.developerMode ? 'on' : 'off'}`);
        }
        if (patch.autoUpdate !== undefined) {
            console.log(`[settings] automatic update checks: ${patch.autoUpdate ? 'on' : 'off'}`);
        }
        if (patch.notifications !== undefined) {
            console.log(`[settings] notifications: ${patch.notifications ? 'on' : 'off'}`);
        }
        if (patch.applyEmailedAnswers !== undefined || patch.developerMode !== undefined) {
            const config = this.configStore.load();
            console.log(
                `[invitations] answers emailed by guests outside Proton: ${config.developerMode && config.applyEmailedAnswers ? 'applied by the bridge too' : 'left to Proton'}`
            );
        }
        if (patch.calendarEmailsAfter !== undefined || patch.calendarEmailsFolder !== undefined) {
            const config = this.configStore.load();
            const where: Record<string, string> = {
                leave: 'left in the Inbox',
                trash: 'moved to the Bin',
                archive: 'moved to the Archive',
                folder: `moved to the folder "${config.calendarEmailsFolder}"`
            };
            console.log(`[mail] emails about meetings, once dealt with: ${where[config.calendarEmailsAfter]}`);
            this.calendarEmailsLastProblem = undefined;
            if (this.calendarEmailsStatus) {
                this.calendarEmailsStatus = { ...this.calendarEmailsStatus, problem: undefined };
            }
        }
        return this.getBridgeState();
    }

    private supportsEmailedAnswers() {
        const adapter = this.protonAdapter as Partial<ProtonAdapter>;
        return typeof adapter.supportsEmailedAnswers === 'function' && adapter.supportsEmailedAnswers();
    }

    private supportsCalendarEmails() {
        const adapter = this.protonAdapter as Partial<ProtonAdapter>;
        return typeof adapter.supportsCalendarEmails === 'function' && adapter.supportsCalendarEmails();
    }

    /**
     * Emails about meetings that are dealt with (answered invitations, applied updates and
     * cancellations, answers Proton has) go from the Inbox to the Bin, the Archive or a folder, if
     * chosen in Settings. Runs at the end of each sync pass, so meetings changed in this pass are
     * checked right away. Never fails the sync. False when the run stopped early (budget, error):
     * the next pass looks at the Inbox again.
     */
    private async fileCalendarEmails(): Promise<boolean> {
        const changedUids = [...this.calendarEmailsChangedUids];
        this.calendarEmailsChangedUids.clear();
        const config = this.configStore.load();
        if (config.calendarEmailsAfter === 'leave' || !this.supportsCalendarEmails()) {
            return true;
        }
        const now = Date.now();
        for (const [uid, at] of this.calendarEmailsGone) {
            if (now - at > GONE_MEETING_MEMORY_MS) {
                this.calendarEmailsGone.delete(uid);
            }
        }
        // Meetings the run did not get to are checked first again next time.
        const keepChanged = () => changedUids.forEach((uid) => this.calendarEmailsChangedUids.add(uid));
        const destination =
            config.calendarEmailsAfter === 'trash' ? 'Bin' : config.calendarEmailsAfter === 'archive' ? 'Archive' : config.calendarEmailsFolder;
        const describe = (entry: FiledEmail | LeftEmail) =>
            `${KIND_WORDS[entry.kind || ''] || 'email'} "${secret(entry.eventTitle || entry.subject)}" from ${entry.from}`;
        let problem: string | undefined;
        let waiting = this.calendarEmailsStatus?.waiting ?? 0;
        let left = this.calendarEmailsStatus?.left ?? 0;
        let wouldMove = 0;
        let finished = true;
        try {
            const result = await this.protonAdapter.fileCalendarEmails({
                moveTo: config.calendarEmailsAfter,
                folderName: config.calendarEmailsFolder,
                changedUids,
                goneMeetings: [...this.calendarEmailsGone].map(([uid, at]) => ({ uid, at: Math.floor(at / 1000) }))
            });
            if (result.error) {
                keepChanged();
            }
            if (result.error || result.more) {
                finished = false; // the rest is checked in the next pass
            }
            if (result.folderCreated) {
                console.log(`[mail] created the folder "${result.folderCreated}"`);
            }
            for (const entry of result.filed) {
                const where = shownDestination(entry.destination);
                if (entry.outcome === 'moved') {
                    this.calendarEmailsMoved += 1;
                    console.log(`[mail] moved to ${where}: ${describe(entry)} (${entry.why})`);
                } else if (entry.outcome === 'dry-run') {
                    console.log(`[mail] dry run, would move to ${where}: ${describe(entry)} (${entry.why})`);
                } else {
                    console.warn(`[mail] could not move to ${where}: ${describe(entry)}: ${entry.error || 'refused'}`);
                }
            }
            for (const entry of result.left) {
                console.log(`[mail] left in the Inbox: ${describe(entry)}: ${entry.why}${entry.note ? ` — ${secret(entry.note)}` : ''}`);
                if (entry.note) {
                    // 0.41.10: a guest's note is shown on the Overview whether or not the bridge applies emailed answers.
                    const noted: InvitationEmailLogEntry = {
                        at: Date.now(),
                        method: 'REPLY',
                        kind: 'received',
                        from: entry.from,
                        to: [],
                        subject: entry.subject,
                        eventTitle: entry.eventTitle || entry.subject,
                        outcome: 'note',
                        detail: t('Note from {guest}: {note}', { guest: entry.from, note: entry.note })
                    };
                    this.recentInvitationEmails = [noted, ...this.recentInvitationEmails].slice(0, 20);
                }
            }
            const moved = result.filed.filter((entry) => entry.outcome === 'moved').length;
            if (moved || result.left.length) {
                console.log(
                    `[mail] emails about meetings: ${moved} moved to ${destination}, ${result.waiting} waiting, ${result.leftCount} left for you` +
                        (result.more ? '; more next sync' : '')
                );
            }
            problem = result.folderError || (result.error ? `stopped early (tried again next sync): ${result.error}` : undefined);
            waiting = result.waiting;
            left = result.leftCount;
            wouldMove = result.wouldMove;
        } catch (error) {
            keepChanged();
            finished = false;
            problem = `could not look at the Inbox: ${error instanceof Error ? error.message : String(error)}`;
        }
        if (problem && problem !== this.calendarEmailsLastProblem) {
            console.warn(`[mail] emails about meetings: ${problem}`);
            if (/could not be found or created/.test(problem)) {
                this.notify({ key: `mail:${problem}`, title: t('Emails About Meetings'), body: problem, page: 'settings' });
            }
        }
        this.calendarEmailsLastProblem = problem;
        this.calendarEmailsStatus = { at: Date.now(), moved: this.calendarEmailsMoved, wouldMove, waiting, left, destination, ...(problem ? { problem } : {}) };
        this.notifyStateChange();
        return finished;
    }

    /**
     * Answers that guests outside Proton emailed to meetings you organize, applied like Proton Mail
     * does when the reply is opened there (the client reads the mailbox, sends nothing). Runs at the
     * start of each sync pass, so the answers reach Calendar.app in the same pass. Never fails the sync.
     * False when the run stopped early (budget, error): the next pass looks again.
     */
    private async applyEmailedAnswers(): Promise<boolean> {
        const config = this.configStore.load();
        // A developer option: only with developer options on and the option ticked.
        if (!config.developerMode || !config.applyEmailedAnswers || !this.supportsEmailedAnswers()) {
            return true;
        }
        const account = this.protonAdapter.getSignedInUsername() || '';
        const dryRun = this.effectiveEmailMode(config) === 'dry-run';
        const saved = config.emailedAnswersCursor?.account === account ? config.emailedAnswersCursor.cursor : null;
        const dryRunCursor = this.emailedAnswersDryRunCursor?.account === account ? this.emailedAnswersDryRunCursor.cursor : null;
        const start = (dryRun ? dryRunCursor : null) ?? saved;
        // Never further back than the first run would look (e.g. after the option was off for months).
        const earliest = Math.floor(Date.now() / 1000) - EMAILED_ANSWERS_FIRST_LOOKBACK_S;
        const since = start === null ? earliest : Math.max(earliest, start - EMAILED_ANSWERS_OVERLAP_S);
        try {
            // 0.41: replies in Spam to invitations this account sent; every few hours also the last week
            // again, for replies moved out of Spam (their arrival time is behind the cursor).
            const now = Date.now();
            const lookBack = start !== null && (this.emailedAnswersLookBackFrom !== null || now - this.emailedAnswersLookedBackAt >= EMAILED_ANSWERS_LOOK_BACK_EVERY_MS);
            if (lookBack && this.emailedAnswersLookBackFrom === null) {
                // The same start until it is done, so a look-back cut short continues where it got to.
                this.emailedAnswersLookBackFrom = Math.max(earliest, Math.floor(now / 1000) - EMAILED_ANSWERS_LOOK_BACK_S);
            }
            const repliesTo = config.sentInvitationIds.map(({ id }) => id);
            const result = await this.protonAdapter.applyEmailedAnswers({
                since,
                ...(repliesTo.length ? { repliesTo } : {}),
                ...(lookBack && this.emailedAnswersLookBackFrom !== null ? { lookBackFrom: this.emailedAnswersLookBackFrom } : {})
            });
            if (lookBack && !result.error && !result.more) {
                this.emailedAnswersLookedBackAt = now;
                this.emailedAnswersLookBackFrom = null;
            }
            result.answers.forEach((answer) => this.recordEmailedAnswer(answer));
            for (const ignored of result.ignored || []) {
                console.log(`[invitations] email ignored: "${secret(ignored.subject)}" from ${ignored.from}: ${ignored.why}`);
            }
            if (result.opened > 0) {
                const count = (outcome: EmailedAnswer['outcome']) => result.answers.filter((answer) => answer.outcome === outcome).length;
                console.log(
                    `[invitations] emailed answers: ${result.opened} email(s) with a calendar file read; ` +
                        `${count('applied')} applied, ${count('dry-run')} dry run, ${count('skipped')} skipped, ${(result.ignored || []).length} ignored` +
                        (result.more ? '; more next sync' : '')
                );
            }
            if (result.error) {
                console.warn(`[invitations] reading emailed answers stopped early (tried again next sync): ${result.error}`);
            }
            const cursor = { account, cursor: Math.max(start ?? since, result.cursor) };
            if (dryRun) {
                this.emailedAnswersDryRunCursor = cursor;
            } else {
                this.emailedAnswersDryRunCursor = null;
                if (cursor.cursor !== saved) {
                    this.configStore.update({ emailedAnswersCursor: cursor });
                }
            }
            return !result.more && !result.error;
        } catch (error) {
            console.warn(`[invitations] could not read emailed answers: ${error instanceof Error ? error.message : String(error)}`);
            return false;
        }
    }

    /** A guest's emailed answer (applied, dry run or skipped) goes to bridge.log and the Overview page. */
    recordEmailedAnswer(answer: EmailedAnswer) {
        const entry: InvitationEmailLogEntry = {
            at: Date.now(),
            method: 'REPLY',
            kind: 'received',
            answer: answer.answer,
            from: answer.from,
            to: answer.to ? [{ email: answer.to, name: '' }] : [],
            subject: answer.subject,
            eventTitle: answer.eventTitle || answer.subject,
            outcome: answer.outcome,
            detail:
                [answer.outcome === 'skipped' ? `Not applied: ${answer.reason}` : answer.outcome === 'dry-run' ? 'Dry run: not applied in Proton' : '', answer.comment ? t('Note from {guest}: {note}', { guest: answer.from, note: answer.comment }) : '']
                    .filter(Boolean)
                    .join(' — ') || undefined
        };
        this.recentInvitationEmails = [entry, ...this.recentInvitationEmails].slice(0, 20);
        const what = answer.answer || 'answer';
        const meeting = answer.eventTitle ? ` for "${secret(answer.eventTitle)}"` : answer.eventUid ? ` for ${answer.eventUid}` : '';
        const note = answer.comment ? `, with a note ${secret(answer.comment)}` : '';
        const where = `from ${answer.from} to ${answer.to || '?'}${meeting} (email of ${answer.receivedAt}, "${secret(answer.subject)}")${note}`;
        if (answer.outcome === 'applied') {
            console.log(`[invitations] received: ${what} ${where}, applied in Proton`);
        } else if (answer.outcome === 'dry-run') {
            console.log(`[invitations] dry run: received ${what} ${where}, would be applied`);
        } else {
            console.log(`[invitations] received: ${what} ${where}, not applied: ${answer.reason}`);
        }
    }

    /**
     * 0.31: what "same as Proton Calendar" means right now — the last value the client read, never
     * a request from here (the state is read on every change); when it is unknown or stale the
     * client is asked in the background (it keeps its own 10-minute cache and a pause after a failure).
     */
    private protonInviteLanguage(): string | null {
        const adapter = this.protonAdapter as Partial<ProtonAdapter>;
        if (!this.protonAdapter.isSignedIn() || typeof adapter.peekProtonInviteLocale !== 'function') {
            return null;
        }
        if (typeof adapter.getProtonInviteLocale === 'function') {
            const known = adapter.peekProtonInviteLocale();
            void adapter.getProtonInviteLocale().then((fresh) => {
                if (fresh !== known) {
                    this.notifyStateChange();
                }
            });
        }
        return adapter.peekProtonInviteLocale();
    }

    /** 0.31: the languages on offer (from the client; empty with an older client). */
    private async listInvitationLanguages(): Promise<Array<{ code: string; name: string }>> {
        const adapter = this.protonAdapter as Partial<ProtonAdapter>;
        if (typeof adapter.listInvitationLanguages !== 'function') {
            return [];
        }
        return adapter.listInvitationLanguages().catch(() => []);
    }

    /**
     * The email mode in force (0.32.3): test and dry run are developer options, so they count only while
     * developer options are on; otherwise emails go out like from Proton Calendar.
     */
    private effectiveEmailMode(config: BridgeConfig): BridgeConfig['invitationEmailMode'] {
        return config.developerMode ? config.invitationEmailMode : 'live';
    }

    /** Hands the saved email policy to the client (now, and again after every sign-in). */
    private applyInvitationPolicy() {
        const adapter = this.protonAdapter as Partial<ProtonAdapter>;
        if (typeof adapter.setInvitationOptions !== 'function') {
            return;
        }
        const config = this.configStore.load();
        adapter.setInvitationOptions({
            policy: { mode: this.effectiveEmailMode(config), allowlist: config.invitationEmailAllowlist, language: config.invitationEmailLanguage || 'proton' },
            prodId: '-//Neutron Calendar Bridge//EN',
            onEmail: (record) => this.recordInvitationEmail(record)
        });
    }

    /** Every invitation email (sent, blocked, dry run, failed) goes to bridge.log and the Overview page. */
    recordInvitationEmail(record: InvitationEmailRecord) {
        const kind = record.kind ?? 'answer';
        const entry: InvitationEmailLogEntry = {
            at: Date.parse(record.at) || Date.now(),
            method: record.method,
            kind,
            answer: record.answer,
            from: record.from,
            to: record.to,
            subject: record.subject,
            eventTitle: record.eventTitle,
            outcome: record.outcome,
            detail: record.detail
        };
        this.recentInvitationEmails = [entry, ...this.recentInvitationEmails].slice(0, 20);
        if (record.outcome === 'sent' && record.method === 'REQUEST' && record.externalId) {
            // 0.41: guests answer this email; a reply to it that lands in Spam is still read.
            const kept = this.configStore.load().sentInvitationIds;
            this.configStore.update({ sentInvitationIds: [...kept.filter(({ id }) => id !== record.externalId), { id: record.externalId, at: Date.now() }].slice(-SENT_INVITATION_IDS_MAX) });
        }
        const recipients = record.to
            .map((recipient) => `${recipient.email}${recipient.delivery ? ` (${recipient.delivery})` : ''}`)
            .join(', ');
        const occurrence = record.recurrenceId ? ` (occurrence ${record.recurrenceId})` : '';
        console.log(
            `[invitations] ${record.outcome}: ${record.method} ${kind === 'answer' ? record.answer : kind} from ${record.from} to ${recipients} ` +
                `for "${secret(record.eventTitle)}"${occurrence}${record.detail ? ` - ${record.detail}` : ''}`
        );
        if (record.preview) {
            // The email text and its calendar file: only with detailed logging (Developer settings).
            console.log(
                `[invitations] dry run, the email that would have been sent (shown with detailed logging):${secret(`\nSubject: ${record.subject}\n\n${record.preview.body}\n\n${record.preview.ics}`)}`
            );
        }
    }

    /** What the menu-bar menu shows; cheap (no database), safe to call before initialize(). */
    getTrayState(): TrayState {
        return {
            health: this.health,
            message: this.message,
            signedIn: this.protonAdapter.isSignedIn(),
            username: this.accountLabel(),
            calendars: this.trayCalendarsStatus(),
            phase: this.trayPhase()
        };
    }

    /**
     * 0.46: what the account is doing, for the menu: connecting (blue: nothing verified yet, nothing
     * wrong either), its first pass of this run (blue), ready (verified), or why it is not connected.
     */
    private trayPhase(): TrayPhase {
        const signedIn = this.protonAdapter.isSignedIn();
        const slowedDown = this.slowDownUntil > Date.now();
        if (slowedDown && this.slowDownText !== null) {
            return 'error'; // Proton no longer accepts this app version: not a pause, red (0.40)
        }
        if (this.pendingHumanVerification) {
            return 'verification';
        }
        if (!signedIn) {
            if (this.pendingSignIn) {
                return slowedDown ? 'limited' : 'offline'; // signing in as soon as Proton answers (again)
            }
            if (slowedDown) {
                return 'limited';
            }
            if (this.health === 'connecting' || (this.starting && this.health === 'disconnected')) {
                return 'connecting';
            }
            return this.health === 'error' ? 'error' : 'signed-out';
        }
        if (this.outage) {
            return 'offline';
        }
        if (slowedDown) {
            return 'limited';
        }
        if (this.refusedPasses || this.health === 'error') {
            return 'error';
        }
        return this.verifiedThisRun ? 'ready' : 'first-sync';
    }

    /** The menu's account dot: red (no connection, a calendar failing), yellow (a refusal), syncing, green. */
    private trayCalendarsStatus(): TrayCalendarsStatus {
        if (!this.protonAdapter.isSignedIn()) {
            return 'error';
        }
        const excluded = new Set(this.configStore.load().excludedCalendarIds);
        const counts = (id: string) => !excluded.has(id) && (!this.activeCalendarIds || this.activeCalendarIds.has(id));
        const statuses = [
            ...(this.connectionError ? (['error'] as const) : []),
            ...[...this.calendarErrors.keys()].filter(counts).map(() => 'error' as const),
            ...[...this.calendarWarnings.keys()].filter(counts).map(() => 'warning' as const)
        ];
        return trayCalendarsStatusOf(statuses, Boolean(this.queueRunner || this.passInFlight));
    }

    async getBridgeState(): Promise<BridgeState> {
        const calendarRecords = await this.mirrorDatabase.listCalendars();
        const calendars = this.toCalendarViews(calendarRecords);
        const caldav = this.getCalDAVConfig();
        const config = this.configStore.load();

        return {
            accountId: this.accountId,
            accountLabel: this.accountLabel(),
            health: this.health,
            signedIn: this.protonAdapter.isSignedIn(),
            username: this.protonAdapter.getSignedInUsername(),
            calendars,
            calendarApp: this.getCalendarAppStatus(),
            thunderbird: this.getClientStatus('thunderbird'),
            otherClient: this.getClientStatus('other'),
            calendarAppAccountName: this.options.account?.accountName() ?? CALENDAR_APP_ACCOUNT_NAME,
            caldav: {
                host: caldav.host,
                port: caldav.port,
                username: caldav.username,
                security: caldav.security,
                baseUrl: caldav.baseUrl,
                serverPath: caldav.serverPath
            },
            openAtLogin: config.openAtLogin,
            openAtLoginNote: this.loginItemNote(config.openAtLogin),
            pollIntervalMs: config.pollIntervalMs,
            eventLookbackDays: config.eventLookbackDays,
            eventLookaheadDays: config.eventLookaheadDays,
            theme: config.theme,
            appLanguage: config.appLanguage || 'system',
            language: currentLanguage(),
            appLanguages: APP_LANGUAGES,
            lastSuccessfulSyncAt: this.lastSuccessfulSyncAt,
            verifiedThisRun: this.verifiedThisRun,
            lastAttemptedSyncAt: this.lastAttemptedSyncAt,
            message: this.message,
            pendingHumanVerification: this.pendingHumanVerification,
            pendingChanges: this.pendingChangeCount(),
            waitingEmails: this.waitingEmailCount(),
            signInPrompt: this.signInPrompt,
            syncStats: this.syncStats,
            recentCalDAVErrors: this.recentCalDAVErrors,
            localCopyNote: this.localCopyNote,
            caldavLogin: this.caldavLoginTrouble && { ...this.caldavLoginTrouble, savedPasswordUnreadable: this.secretStore.isUnreadable() },
            appVersion: this.appVersion,
            invitationEmailMode: this.effectiveEmailMode(config),
            invitationEmailModeSetting: config.invitationEmailMode,
            invitationEmailAllowlist: config.invitationEmailAllowlist,
            invitationEmailLanguage: config.invitationEmailLanguage || 'proton',
            invitationEmailLanguages: await this.listInvitationLanguages(),
            protonInviteLanguage: this.protonInviteLanguage(),
            invitationsSupported: this.supportsInvitations(),
            developerMode: config.developerMode,
            applyEmailedAnswers: config.applyEmailedAnswers,
            emailedAnswersSupported: this.supportsEmailedAnswers(),
            recentInvitationEmails: this.recentInvitationEmails,
            calendarEmailsAfter: config.calendarEmailsAfter,
            calendarEmailsFolder: config.calendarEmailsFolder,
            addresses: [...this.activeAddresses],
            newCalendarAddress: config.newCalendarAddress || '',
            calendarEmailsSupported: this.supportsCalendarEmails(),
            calendarEmailsStatus: config.calendarEmailsAfter === 'leave' ? null : this.calendarEmailsStatus,
            notifications: config.notifications,
            autoUpdate: config.autoUpdate,
            notificationTitles: config.notificationTitles,
            detailedLogging: config.detailedLogging,
            detailedLoggingUntil: config.detailedLogging === '24h' ? config.detailedLoggingUntil : null,
            requestStats: config.developerMode ? this.requestStatsView(calendarRecords.filter((calendar) => this.isCalendarSyncEnabled(calendar.protonCalendarId))) : null
        };
    }

    /**
     * Calendar.app signed in (0.30): remembered for the Setup page ("connected"), and written to the
     * config at most once a minute so the next start still knows Calendar.app was set up. 0.49.1: per
     * app — Thunderbird and other CalDAV apps (told apart by the User-Agent) have their own cards.
     */
    private noteClientRequest(now: number, client: CalDAVClient = { kind: 'calendar-app', name: null }) {
        const kind = client.kind;
        const first = this.clientSeenAt[kind] === null;
        this.clientSeenAt[kind] = now;
        if (kind === 'other' && client.name) {
            this.otherClientName = client.name;
        }
        if (first || now - this.clientSeenSavedAt[kind] > 60_000) {
            this.clientSeenSavedAt[kind] = now;
            try {
                if (kind === 'calendar-app') {
                    this.configStore.update({ calendarAppLastSeenAt: now });
                } else if (kind === 'thunderbird') {
                    this.configStore.update({ thunderbirdLastSeenAt: now });
                } else {
                    this.configStore.update({ otherClientLastSeen: { at: now, name: this.otherClientName ?? this.configStore.load().otherClientLastSeen?.name ?? null } });
                }
            } catch (error) {
                console.warn(`[caldav] could not note ${CLIENT_LABEL[kind]}'s request: ${errorText(error)}`);
            }
            if (first) {
                console.log(`[caldav] ${kind === 'other' ? client.name ?? 'another CalDAV app' : CLIENT_LABEL[kind]} signed in to the bridge`);
                this.notifyStateChange();
            }
        }
    }

    getCalendarAppStatus(): CalendarAppStatus {
        return this.getClientStatus('calendar-app');
    }

    /** 0.49.1: when an app last signed in — this run, or known from the config. */
    getClientStatus(kind: 'calendar-app' | 'thunderbird'): CalendarAppStatus;
    getClientStatus(kind: 'other'): OtherClientStatus;
    getClientStatus(kind: CalDAVClientKind): CalendarAppStatus | OtherClientStatus {
        const seenAt = this.clientSeenAt[kind];
        if (kind === 'other') {
            const saved = this.configStore.load().otherClientLastSeen;
            return seenAt !== null
                ? { lastRequestAt: seenAt, thisRun: true, name: this.otherClientName ?? saved?.name ?? null }
                : { lastRequestAt: saved?.at ?? null, thisRun: false, name: saved?.name ?? null };
        }
        if (seenAt !== null) {
            return { lastRequestAt: seenAt, thisRun: true };
        }
        const config = this.configStore.load();
        return { lastRequestAt: kind === 'thunderbird' ? config.thunderbirdLastSeenAt : config.calendarAppLastSeenAt, thisRun: false };
    }

    /** The configuration profile that adds the bridge's account to Calendar.app (0.30; 0.36: one per account). */
    getCalDAVProfile(): string {
        const caldav = this.getCalDAVConfig();
        const accountName = this.options.account?.accountName() ?? CALENDAR_APP_ACCOUNT_NAME;
        return buildCalDAVProfile({
            accountName,
            profileName: CALENDAR_APP_PROFILE_NAME,
            identifier: this.options.account?.profileIdentifier ?? CALENDAR_APP_PROFILE_IDENTIFIER,
            organization: CALENDAR_APP_PROFILE_NAME,
            description: t('Adds the "{account}" account (your Proton calendars, served on this Mac by {app}) to Calendar.app. Made by the bridge on this Mac; remove it to remove the account.', { account: accountName, app: CALENDAR_APP_PROFILE_NAME }),
            host: caldav.host,
            port: caldav.port,
            username: caldav.username,
            password: caldav.password,
            principalPath: caldav.serverPath
        });
    }

    /**
     * Calendar.app's login to the bridge (Basic auth): the password is compared in constant time. The
     * user name is not checked (it is shown on the Setup page and is no secret; before 0.24 nothing
     * was checked, so an existing Calendar.app account may have any). Wrong passwords are counted
     * until the next right one (Calendar.app keeps an old password, e.g. after the saved login was
     * lost): the Setup page shows the password to enter, and one notification says so.
     * `missing`: no login sent (Calendar.app sends it once asked: 401).
     */
    checkCalDAVLogin(login: { username: string; password: string } | { username: string; verified: boolean } | null, client?: CalDAVClient): 'ok' | 'missing' | 'wrong' {
        if (!login) {
            return 'missing';
        }
        const now = Date.now();
        // `verified`: a Digest response the server already checked against the password.
        const right = 'verified' in login ? login.verified : sameSecret(login.password, this.getCalDAVConfig().password);
        if (right) {
            this.noteClientRequest(now, client);
            if (this.caldavLoginTrouble) {
                const name = clientDisplayName(client) ?? this.caldavLoginTrouble.app ?? t('A calendar app');
                this.caldavLoginTrouble = null;
                console.log(`[caldav] ${name} signs in to the bridge with the right password again`);
                this.notify({ key: 'caldav:login-ok', replaces: 'caldav:login', title: t('{app} connects again', { app: name }), body: t('{app} signs in to the bridge with the right password.', { app: name }), page: 'setup' });
                this.notifyStateChange();
            }
            return 'ok';
        }
        const first = !this.caldavLoginTrouble;
        // 0.49.3: named after the app that sent it (Thunderbird's wrong password was reported as Calendar.app's).
        const app = clientDisplayName(client);
        this.caldavLoginTrouble = {
            since: this.caldavLoginTrouble?.since ?? now,
            lastAt: now,
            attempts: (this.caldavLoginTrouble?.attempts ?? 0) + 1,
            app: app ?? this.caldavLoginTrouble?.app
        };
        if (first) {
            const unreadable = this.secretStore.isUnreadable();
            const name = app ?? t('A calendar app');
            console.warn(
                `[caldav] ${app ?? 'a calendar app'} sent a wrong password for the bridge${unreadable ? ' (the saved login cannot be read: the bridge runs with a temporary password)' : ' (an old one?)'}`
            );
            this.notify(
                unreadable
                    ? {
                          key: 'caldav:login',
                          title: t('{app} cannot sign in to the bridge', { app: name }),
                          body: t('macOS did not let the app read its saved login (Keychain), which holds the password {app} knows. Quit and reopen the app and choose "Always Allow".', { app: name }),
                          page: 'setup'
                      }
                    : {
                          key: 'caldav:login',
                          title: t('{app} uses an old password', { app: name }),
                          body: t('{app} cannot sign in to the bridge. The Setup page shows the password to enter in {app}.', { app: name }),
                          page: 'setup'
                      }
            );
            this.notifyStateChange();
        }
        return 'wrong';
    }

    recordCalDAVError(entry: CalDAVRequestError) {
        this.recentCalDAVErrors = [entry, ...this.recentCalDAVErrors].slice(0, 10);
        if (!isWarningWorthy(entry.method, entry.status)) {
            return;
        }
        const slug = calendarSlugOfPath(entry.path);
        const notifies = entry.status < 500 || this.notifiesFailedChange(entry.path);
        void (async () => {
            const calendar = slug ? await this.mirrorDatabase.getCalendarBySlug(slug).catch(() => null) : null;
            if (calendar) {
                this.calendarWarnings.set(calendar.protonCalendarId, { message: entry.message, at: entry.at });
                this.outboxWarned.delete(calendar.protonCalendarId);
                this.notifyStateChange();
            }
            if (!notifies) {
                return;
            }
            // Calendar.app only says "not permitted": the notification says why.
            const resource = entry.path.split('/').pop() || '';
            const uid = resource.endsWith('.ics') ? decodedPathPart(resource.slice(0, -4)) : '';
            const event = calendar && uid ? await this.mirrorDatabase.getEventByUid(calendar.protonCalendarId, uid).catch(() => null) : null;
            const partly = entry.partial === true;
            this.notify({
                key: `caldav:${entry.method}:${entry.path}:${entry.message}`,
                title: partly ? t('Saved, with changes') : entry.status === 403 ? t('Change not saved') : t('Change failed'),
                subtitle: [event?.title, calendar?.displayName].filter(Boolean).join(' — ') || undefined,
                body: entry.message,
                page: 'calendars'
            });
        })().catch((error) => console.warn(`[notify] ${error instanceof Error ? error.message : String(error)}`));
    }

    /**
     * A change that failed on Proton's side (5xx): Calendar.app retries it, so it is notified once per
     * half hour, and not at all while Proton cannot be reached (that has its own notification).
     */
    private notifiesFailedChange(path: string) {
        if (this.outage || this.outageCheck || this.connectionError || Date.now() < this.slowDownUntil) {
            return false;
        }
        const now = Date.now();
        for (const [key, at] of this.failedChangeNotifiedAt) {
            if (now - at >= FAILED_CHANGE_NOTIFY_MS) {
                this.failedChangeNotifiedAt.delete(key);
            }
        }
        if (this.failedChangeNotifiedAt.has(path)) {
            return false;
        }
        this.failedChangeNotifiedAt.set(path, now);
        return true;
    }

    /** A notification, if switched on in Settings. */
    private notify(notification: BridgeNotification) {
        const config = this.configStore.load();
        if (!config.notifications || !this.onNotify) {
            return;
        }
        try {
            // "Show event titles in notifications" off: only what happened (no event or calendar name, no addresses).
            const shown = config.notificationTitles ? notification : { ...notification, subtitle: undefined, body: withoutAddresses(notification.body) };
            // 0.36: several accounts — keys kept apart per account, the address named (it is no event detail).
            const account = this.options.account;
            const label = account?.labelForNotifications() ?? null;
            this.onNotify({
                ...shown,
                key: account ? `${account.id}:${shown.key}` : shown.key,
                ...(shown.replaces && account ? { replaces: `${account.id}:${shown.replaces}` } : {}),
                ...(label ? { subtitle: shown.subtitle ? `${label} — ${shown.subtitle}` : label } : {}),
                ...(account ? { accountId: account.id } : {})
            });
        } catch (error) {
            console.warn(`[notify] ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    /**
     * The Mac woke up: sync now instead of at the next regular time. The network needs a moment, so
     * Proton's ping is tried first (for about a minute); time asleep does not count as an outage.
     */
    handleSystemResume() {
        this.passesAtWake = this.passesStarted;
        if (this.outage) {
            this.outage.lastCheckAt = Date.now();
        }
        if (!this.protonAdapter.isSignedIn()) {
            return;
        }
        console.log('[sync] the Mac woke up: syncing in a moment');
        this.noteActivity();
        if (this.resumeTimer) {
            clearTimeout(this.resumeTimer);
        }
        this.resumeTimer = setTimeout(() => void this.syncAfterWake(1), this.resumeSyncDelayMs);
    }

    private async syncAfterWake(attempt: number) {
        this.resumeTimer = null;
        const session = this.session;
        this.syncingAfterWake = true;
        try {
            const reachable = await this.isProtonReachable();
            if (!this.protonAdapter.isSignedIn() || this.resumeTimer || this.signingOut || this.session !== session) {
                return; // signed out, or woke up again meanwhile
            }
            if (!reachable && attempt < RESUME_PROBE_ATTEMPTS) {
                this.resumeTimer = setTimeout(() => void this.syncAfterWake(attempt + 1), this.resumeRetryMs);
                return;
            }
            if (this.passesStarted > this.passesAtWake) {
                return; // a pass started since waking up (e.g. the connection came back)
            }
            // Its own pass, even if one from before the sleep is still running. If Proton is still not
            // there, the pass fails and the connection watch takes over.
            await this.syncNow('auto', true).catch(() => undefined);
        } finally {
            this.syncingAfterWake = false;
        }
    }

    private async isProtonReachable() {
        try {
            return await this.probeConnection();
        } catch {
            return false;
        }
    }

    /**
     * Listing Proton's calendars failed. Proton's ping tells the two cases apart: no connection
     * (watched every 15 s; notification after 5 minutes awake) or Proton refusing (too many
     * requests, session no longer valid …; the regular sync tries again, notification after 5
     * passes and 5 minutes). Either way nothing extra is sent to Proton's API.
     */
    private noteListingFailed(message: string) {
        if (this.outage || this.outageCheck) {
            return;
        }
        const successes = this.listingSuccesses;
        const session = this.session;
        this.outageCheck = (async () => {
            const reachable = await this.isProtonReachable();
            if (!this.protonAdapter.isSignedIn() || this.outage || this.signingOut || this.session !== session || this.listingSuccesses !== successes) {
                return; // signed out, or a later pass got through meanwhile
            }
            if (!reachable) {
                const now = Date.now();
                this.outage = { since: now, awakeMs: 0, lastCheckAt: now, notified: false };
                console.log('[sync] Proton cannot be reached: checking every 15 s until it answers');
                this.connectivityTimer ??= setInterval(() => void this.checkConnectivity(), CONNECTIVITY_PROBE_MS);
                return;
            }
            const refused = (this.refusedPasses ??= { count: 0, since: Date.now(), notified: false });
            refused.count += 1;
            if (!refused.notified && refused.count >= REFUSED_PASSES_NOTIFY && Date.now() - refused.since >= OFFLINE_NOTIFY_MS) {
                refused.notified = true;
                this.notify({
                    key: 'sync:failing',
                    title: t('Syncing keeps failing'),
                    body: t('Proton answers, but refused the calendar list: {message}. The bridge keeps trying with every sync.', { message }),
                    page: 'overview'
                });
            }
        })().finally(() => {
            this.outageCheck = null;
        });
    }

    /** The calendar list came through: any outage or refusal is over; say so where it was announced. */
    private noteListingWorked() {
        this.listingSuccesses += 1;
        const refused = this.refusedPasses;
        this.refusedPasses = null;
        if (refused?.notified) {
            this.notify({ key: 'sync:works', replaces: 'sync:failing', title: t('Syncing works again'), body: t('Proton sent the calendar list again.'), page: 'overview' });
        }
        this.endOutage(false);
    }

    /** Proton answers again. `resync`: sync at once if it was gone for more than 2 minutes. */
    private endOutage(resync: boolean) {
        const outage = this.outage;
        if (!outage) {
            return;
        }
        this.outage = null;
        this.stopConnectivityWatch();
        if (outage.notified) {
            this.notify({
                key: 'connection:back',
                replaces: 'connection:lost',
                title: t('Connected to Proton again'),
                body: resync ? t('Syncing now.') : t('Syncing has resumed.'),
                page: 'overview'
            });
        }
        // Not twice: after waking up, the wake-up sync is on its way.
        if (resync && outage.awakeMs >= OFFLINE_RESYNC_MS && !this.resumeTimer && !this.syncingAfterWake && !this.signingOut) {
            console.log(`[sync] connection back after ${Math.round(outage.awakeMs / 60000)} min: syncing now`);
            this.noteActivity();
            void this.syncNow('auto', true).catch(() => undefined);
        }
    }

    private stopConnectivityWatch() {
        if (this.connectivityTimer) {
            clearInterval(this.connectivityTimer);
            this.connectivityTimer = null;
        }
    }

    /** Every 15 s while Proton cannot be reached: its ping; notification after 5 minutes awake. */
    async checkConnectivity() {
        if (!this.outage || !this.protonAdapter.isSignedIn()) {
            this.outage = null;
            this.stopConnectivityWatch();
            return;
        }
        const reachable = await this.isProtonReachable();
        const outage = this.outage;
        if (!outage) {
            return; // a sync got through meanwhile
        }
        const now = Date.now();
        outage.awakeMs += Math.min(Math.max(0, now - outage.lastCheckAt), 2 * CONNECTIVITY_PROBE_MS);
        outage.lastCheckAt = now;
        if (reachable) {
            this.endOutage(true);
            return;
        }
        if (outage.awakeMs >= OFFLINE_NOTIFY_MS && !outage.notified) {
            outage.notified = true;
            this.notify({
                key: 'connection:lost',
                title: t('Proton cannot be reached'),
                body: t('No answer for {minutes} minutes ({reason}). Syncing waits until it is back.', { minutes: Math.round(outage.awakeMs / 60000), reason: this.connectionError?.message || t('no connection') }),
                page: 'overview'
            });
        }
    }

    /**
     * Signing in failed because there was no connection: the error says so (no answer at all), or
     * Proton's ping fails too. Not when signed in after all, or when Proton asks for verification.
     */
    private async failedForLackOfConnection(error: unknown) {
        if (this.protonAdapter.isSignedIn() || this.pendingHumanVerification || this.signingOut) {
            return false;
        }
        return isNoConnectionError(error) || !(await this.isProtonReachable());
    }

    /** Offline at app start: the saved login is tried again whenever Proton's ping answers (every 15 s). */
    private retrySignInWhenReachable(credentials: ProtonCredentials, message: string | (() => string) = () => t('No connection to Proton. Signing in as soon as it can be reached.')) {
        this.pendingSignIn = credentials;
        this.setHealth('error', message);
        console.log('[proton] Proton cannot be reached at start: signing in once it answers');
        this.signInRetryTimer ??= setInterval(() => void this.retryPendingSignIn(), CONNECTIVITY_PROBE_MS);
    }

    private cancelPendingSignIn() {
        this.pendingSignIn = null;
        if (this.signInRetryTimer) {
            clearInterval(this.signInRetryTimer);
            this.signInRetryTimer = null;
        }
    }

    async retryPendingSignIn() {
        const credentials = this.pendingSignIn;
        if (!credentials || this.signInRetrying) {
            return;
        }
        if (this.protonAdapter.isSignedIn()) {
            this.cancelPendingSignIn();
            return;
        }
        if (Date.now() < this.slowDownUntil) {
            return; // Proton asked to slow down: not before its time
        }
        this.signInRetrying = true;
        try {
            if (!(await this.isProtonReachable()) || this.pendingSignIn !== credentials) {
                return;
            }
            this.cancelPendingSignIn();
            console.log('[proton] Proton answers again: signing in');
            // The session saved last time is still worth trying (launched before the network was up).
            const saved = await this.secretStore.getProtonSession().catch(() => null);
            try {
                await this.signIn(credentials, false, null, saved?.username === credentials.username ? saved : null);
            } catch (error) {
                if (errorName(error) === SIGNED_OUT_MEANWHILE) {
                    return;
                }
                // Gone again, or asked to slow down: keep waiting. Anything else (wrong password,
                // verification) is shown as usual.
                if (errorName(error) === 'RateLimitedError' && !this.protonAdapter.isSignedIn()) {
                    this.noteSlowDown(error);
                    this.retrySignInWhenReachable(credentials, slowDownMessage(this.slowDownUntil));
                } else if ((isServerTrouble(error) && !this.protonAdapter.isSignedIn()) || (await this.failedForLackOfConnection(error))) {
                    this.retrySignInWhenReachable(credentials);
                }
            }
        } finally {
            this.signInRetrying = false;
        }
    }

    /** Calendars served over CalDAV: mirrored, not removed in Proton, and ticked for sync. */
    async getCalendars() {
        const excluded = new Set(this.configStore.load().excludedCalendarIds);
        const calendars = await this.mirrorDatabase.listCalendars();
        return calendars.filter((calendar) => !excluded.has(calendar.protonCalendarId));
    }

    private toCalendarViews(calendars: BridgeCalendarRecord[]): BridgeCalendarView[] {
        const excluded = new Set(this.configStore.load().excludedCalendarIds);
        return calendars.map((calendar) => {
            const id = calendar.protonCalendarId;
            const syncEnabled = !excluded.has(id);
            const error = this.calendarErrors.get(id) ?? null;
            const { status, message, at } = calendarStatusOf({
                removed: calendar.removed,
                syncEnabled,
                connectionError: this.connectionError,
                error,
                warning: this.calendarWarnings.get(id) ?? null
            });
            const queued = this.syncQueue.find((job) => job.calendarId === id);
            return {
                ...calendar,
                kind: calendar.kind ?? 'own',
                syncEnabled,
                lastError: error?.message ?? null,
                status,
                statusMessage: message,
                statusAt: at,
                syncState: this.syncingCalendarId === id ? 'syncing' : queued ? 'queued' : 'idle',
                queuedManually: Boolean(queued?.manual)
            };
        });
    }

    getCalDAVConfig(): LocalCalDAVCredentials {
        const config = this.configStore.load();
        if (!this.localCaldavPassword) {
            throw new Error('Local CalDAV password is not initialized');
        }

        return {
            host: '127.0.0.1',
            port: config.caldavPort,
            username: config.caldavUsername,
            password: this.localCaldavPassword,
            security: 'HTTP',
            baseUrl: `http://127.0.0.1:${config.caldavPort}`,
            serverPath: `/principals/${config.caldavUsername}/`
        };
    }

    async getSyncStatus(): Promise<SyncStatus> {
        const calendars = this.toCalendarViews(await this.mirrorDatabase.listCalendars(true));

        return {
            health: this.health,
            message: this.message,
            lastSuccessfulSyncAt: this.lastSuccessfulSyncAt,
            lastAttemptedSyncAt: this.lastAttemptedSyncAt,
            perCalendar: calendars.map((calendar) => ({
                protonCalendarId: calendar.protonCalendarId,
                displayName: calendar.displayName,
                lastPolledAt: calendar.lastPolledAt,
                lastSyncedAt: calendar.lastSyncedAt,
                removed: calendar.removed,
                syncEnabled: calendar.syncEnabled,
                lastError: calendar.lastError
            }))
        };
    }

    async listEventsForSlug(slug: string, includeDeleted: boolean = false) {
        const calendar = await this.requireCalendar(slug);
        return this.mirrorDatabase.listEventsForCalendar(calendar.protonCalendarId, includeDeleted);
    }

    async getCalendarBySlug(slug: string) {
        const calendar = await this.mirrorDatabase.getCalendarBySlug(slug);
        return calendar && this.isCalendarSyncEnabled(calendar.protonCalendarId) ? calendar : null;
    }

    /** `ifMatch`: the If-Match header of Calendar.app's PUT (checked before answering invitations). */
    /**
     * A change from Calendar.app. While Proton asked to slow down it is refused at once (503 with
     * Retry-After: Calendar.app keeps its copy and tries again then); the client's own problems are
     * handled: a slow-down pauses syncing, an ended session signs in again, a refused app version is said.
     */
    async upsertLocalEvent(
        slug: string,
        resourceName: string,
        resourceHref: string,
        serializedIcs: string,
        options: { ifMatch?: string; client?: CalDAVClientKind } = {}
    ) {
        const fallbackUid = decodeURIComponent(resourceName.replace(/\.ics$/i, ''));
        this.ownBusy = null; // and again after the write (a lookup during it would keep the old times)
        const uidForLock = this.peekUid(serializedIcs) || fallbackUid;
        const lockKey = `${slug}\u0000${uidForLock}`;
        // 0.35: while an earlier change to this event still waits for Proton, this one joins it (a live
        // write would be overtaken by the replay of the older one); what waits is then tried at once.
        const pendingCalendar = this.pendingChangeCount() ? await this.mirrorDatabase.getCalendarBySlug(slug).catch(() => null) : null;
        if (pendingCalendar && this.isPending(pendingCalendar.protonCalendarId, uidForLock)) {
            await this.refuseOutdatedBeforeQueue(slug, uidForLock, options.ifMatch);
            const record = await this.withEventLock(lockKey, () => this.queuePut(slug, resourceName, resourceHref, serializedIcs, 'an earlier change still waits'));
            void this.flushOutbox();
            return record;
        }
        if (this.protonKnownUnreachable()) {
            await this.refuseOutdatedBeforeQueue(slug, uidForLock, options.ifMatch);
            return await this.withEventLock(lockKey, () => this.queuePut(slug, resourceName, resourceHref, serializedIcs, 'Proton cannot be reached'));
        }
        try {
            const record = await this.calendarAppWrite(() =>
                this.withEventLock(lockKey, () => this.upsertLocalEventUnlocked(slug, resourceName, resourceHref, serializedIcs, options))
            );
            if (this.pendingChangeCount()) {
                void this.flushOutbox(); // Proton answers again: what waited can go now
            }
            return record;
        } catch (error) {
            // 0.35: Proton out of reach — the change is kept here and sent later.
            if (!this.offlineQueueApplies(error)) {
                throw error;
            }
            await this.refuseOutdatedBeforeQueue(slug, uidForLock, options.ifMatch);
            return await this.withEventLock(lockKey, () => this.queuePut(slug, resourceName, resourceHref, serializedIcs, errorText(error)));
        } finally {
            this.ownBusy = null;
        }
    }

    private waitingEmailCount() {
        const adapter = this.protonAdapter as Partial<ProtonAdapter>;
        try {
            return typeof adapter.deferredEmailCount === 'function' ? adapter.deferredEmailCount() : 0;
        } catch {
            return 0;
        }
    }

    /**
     * 0.41: emails to guests that Proton refused during a slow-down after the change itself was saved
     * go out at the next pass after the pause (each one is logged and listed on the Overview as it goes).
     * One that waited longer than a day is given up: a notification says so.
     */
    private async sendWaitingEmails() {
        const adapter = this.protonAdapter as Partial<ProtonAdapter>;
        if (typeof adapter.sendDeferredEmails !== 'function' || !this.waitingEmailCount()) {
            return;
        }
        try {
            const result = await adapter.sendDeferredEmails();
            if (result.sent || result.givenUp) {
                console.log(`[invitations] emails that waited for the slow-down: ${result.sent} sent, ${result.givenUp} given up, ${result.waiting} still waiting`);
            }
            if (result.givenUp) {
                this.notify({
                    key: 'emails-given-up',
                    title: t('Not every guest was emailed'),
                    body: tn('{count} email waited too long for Proton and was not sent. The Overview lists it.', '{count} emails waited too long for Proton and were not sent. The Overview lists them.', result.givenUp),
                    page: 'overview'
                });
            }
        } catch (error) {
            if (errorName(error) === 'SessionExpiredError') {
                this.recoverSession(); // they wait on and go out once signed in again
                return;
            }
            if (errorName(error) === 'AppVersionError') {
                this.noteAppVersionRejected(errorText(error));
                return;
            }
            console.warn(`[invitations] could not send the emails that waited for the slow-down: ${errorText(error)}`);
        }
    }

    /**
     * 0.41: a series write sends the whole series, video link included, and the link is taken from the
     * mirror (Calendar.app drops what it does not know). A link removed in Proton Calendar since the last
     * poll would come back with it. So a stored series with a link is read again from Proton first (one
     * request, only then); a failed read leaves the stored copy, as before.
     */
    private async withFreshConference(
        calendar: BridgeCalendarRecord,
        existing: BridgeEventRecord | null
    ): Promise<{ record: BridgeEventRecord | null; takenOff?: { url: string } }> {
        const before = existing && !existing.deleted ? conferenceOfIcsText(existing.serializedIcs) : undefined;
        if (!existing || !before) {
            return { record: existing };
        }
        const isSeries = Object.keys(existing.protonEventIds ?? {}).length > 1 || icsHasRecurrence(existing.serializedIcs);
        if (!isSeries) {
            return { record: existing }; // a single event's write keeps what Proton has (only a new room travels with it)
        }
        try {
            const reread = await this.withCalendarLock(calendar.protonCalendarId, async () => {
                const result = await this.refreshSeries(calendar, existing, this.protonUidOf(existing));
                if (result === 'unconfirmed' && this.isPending(calendar.protonCalendarId, existing.uid)) {
                    // A change from the outbox: a sync pass leaves its row alone, so it cannot tell whether the
                    // series was deleted in Proton meanwhile. Refused as outdated rather than written anew
                    // (for a meeting that would invite everyone again); the replay reports it.
                    throw new StaleEventError();
                }
                if (result === 'unconfirmed') {
                    // 0.44.1: not found by UID: the calendar's changes say whether it was deleted meanwhile.
                    const current = (await this.mirrorDatabase.getCalendarBySlug(calendar.slug)) ?? calendar;
                    await this.syncEventsForCalendar(current, false);
                    return true;
                }
                return result;
            });
            if (!reread) {
                return { record: existing };
            }
        } catch (error) {
            if (error instanceof StaleEventError || ['RateLimitedError', 'SessionExpiredError', 'AppVersionError'].includes(String(errorName(error)))) {
                throw error; // refused as outdated, or the client's own conditions: handled like any write (outbox, sign-in, notice)
            }
            console.warn(`[video] could not re-read "${existing.title ? secret(existing.title) : existing.uid}" before the change: ${errorText(error)}`);
            return { record: existing };
        }
        const fresh = await this.mirrorDatabase.getEventByUid(calendar.protonCalendarId, existing.uid);
        if (!fresh || fresh.deleted) {
            // Deleted in Proton meanwhile: the change is refused (412) rather than creating the series anew
            // (for a meeting: inviting everyone again); Calendar.app re-reads and sees it gone.
            throw new StaleEventError();
        }
        if (fresh.etag !== existing.etag) {
            // Like a sync pass: Calendar.app's copy (the old version) still counts where only answers or
            // details Proton does not store changed (acceptsReplacedVersion / matchesUnchangedReplacedVersion).
            this.rememberReplacedVersion(calendar.protonCalendarId, existing);
        }
        if (!conferenceOfIcsText(fresh.serializedIcs)) {
            console.log(`[video] the link of "${existing.title ? secret(existing.title) : existing.uid}" was taken off in Proton; the change does not bring it back`);
            return { record: fresh, takenOff: { url: before.url } };
        }
        return { record: fresh };
    }

    /**
     * 0.34.1, video links. First the stored conference lines are put back where Calendar.app left
     * them out. Then, if the first VEVENT has no conference and its location reads "Proton Meet" or
     * "Zoom", the client makes a room and the ICS gets the link as location, Proton's block in the
     * description and the conference properties — in every VEVENT of the ICS. A room that cannot be
     * made refuses the save with the reason (Calendar.app shows it and keeps the event as typed).
     */
    private async withVideoLinks(
        calendar: BridgeCalendarRecord,
        ics: string,
        existing: BridgeEventRecord | null,
        takenOff?: { url: string }
    ): Promise<{ ics: string; created: boolean; removed: boolean; carried: boolean; existingTitle: string | undefined; roomKey?: string; placeRestored?: boolean }> {
        // (Test fakes without the 0.34.1 methods behave like an older client.)
        const supported = typeof this.protonAdapter.supportsVideoLinks === 'function' && (await this.protonAdapter.supportsVideoLinks());
        if (supported && takenOff) {
            // 0.41: the link was taken off in Proton Calendar after Calendar.app last fetched the event: its
            // copy still has the link as the location and Proton's block in the notes. Those go too, so the
            // change does not write the link back as text (the empty conference lines say "no link").
            const undescribe = await this.protonAdapter.conferenceUndescriber();
            ics = withConferenceRemoved(withoutLocation(ics, takenOff.url), undescribe);
        }
        // The stored version: this calendar's record, or — Calendar.app moves an event as a PUT into the new
        // calendar and a DELETE from the old — the live record of the same UID in another calendar.
        const uid = this.peekUid(ics);
        const moved = !existing && uid ? (await this.mirrorDatabase.findLiveEventsByUid(uid).catch(() => []))[0] : undefined;
        const storedIcs = existing && !existing.deleted ? existing.serializedIcs : moved?.serializedIcs;
        const incoming = firstVeventOf(ics);
        // 0.34.2: the link is the location — a location that was the link and no longer is means "take the
        // link off" (an event whose location never was the link, e.g. a room added in Proton's apps, has no
        // such gesture from Calendar.app: its link stays).
        const stored = storedIcs ? conferenceOfIcsText(storedIcs) : undefined;
        const storedLocation = storedIcs ? (firstVeventOf(storedIcs)?.location ?? '').trim() : '';
        const existingTitle = storedIcs ? masterVeventOf(storedIcs)?.title : undefined;
        const asksAgain = supported && incoming ? await this.protonAdapter.videoProviderOfLocation(incoming.location) : null;
        let removed = false;
        // 0.41.5: "the place is the link" by the room it names (its ID), not by exact text: Calendar.app may
        // write the link with other escaping or spacing than Proton's.
        const isLink = (text: string | undefined, conference: { id: string; url: string }) => sameRoom(text, conference);
        const copyFields = incoming ? conferenceOfIcsText(ics) : undefined;
        if (supported && stored && incoming) {
            // What the decision below is based on (kinds only, nothing of the event's content).
            console.log(
                `[video] save of an event with a link: place now ${placeKind(incoming.location, stored, Boolean(asksAgain))}; stored place: ${placeKind(storedLocation, stored, false)}; ` +
                    `conference fields in the copy: ${!copyFields ? 'none' : copyFields.url === stored.url ? 'the same' : 'another'}${icsHasConferenceRemoval(ics) ? ', removal marker' : ''}`
            );
        }
        if (
            supported &&
            stored &&
            incoming &&
            (icsHasConferenceRemoval(ics) ||
                // 0.41.4: the location was the link and no longer is. Calendar.app may keep Proton's conference
                // fields in its copy (it did for meetings): they count only if they name another conference.
                ((!copyFields || copyFields.url === stored.url || copyFields.id === stored.id) && isLink(storedLocation, stored) && !isLink(incoming.location, stored)))
        ) {
            const undescribe = await this.protonAdapter.conferenceUndescriber();
            ics = withConferenceRemoved(ics, undescribe);
            removed = true;
            this.forgetMadeRooms(calendar.protonCalendarId, uid); // 0.41.2: a new request makes a new room
            console.log(`[video] the ${PROVIDER_NAMES[stored.provider]} link was taken off an event in "${secret(calendar.displayName)}"${asksAgain ? ' (a new one is asked for)' : ''}`);
        }
        if (supported && !removed && storedIcs && !stored && firstVeventOf(ics)?.hasConference) {
            // 0.41.4: the saved event has no link (taken off here or in Proton Calendar), but Calendar.app's copy
            // still carries the old conference fields (it keeps them): they would bring the deleted room back.
            const undescribe = await this.protonAdapter.conferenceUndescriber();
            ics = withConferenceRemoved(ics, undescribe);
        }
        let restored = removed ? ics : restoreConferenceLines(ics, storedIcs);
        // 0.41.1: Calendar.app is served the notes without Proton's join block; while the event keeps its
        // link the block goes back in on the way to Proton (guests' emails show it), so nothing changes there.
        const linked = removed || !supported ? undefined : conferenceOfIcsText(restored);
        if (linked) {
            const describe = await this.protonAdapter.conferenceDescriber();
            restored = withConferenceDescribed(restored, (description) => describe(description, linked));
        }
        // A moved event is created anew in its calendar: its room has to travel with that write.
        const carried = Boolean(moved && !removed && conferenceOfIcsText(restored));
        const first = firstVeventOf(restored);
        if (first?.hasConference && supported && asksAgain) {
            // 0.41.6: "Proton Meet" typed on an event that has a link: that link is the answer — it becomes the
            // place again (no second room), instead of the words "Proton Meet" with the link hidden behind them.
            const existing = conferenceOfIcsText(restored);
            if (existing) {
                return { ics: withLocation(restored, existing.url), created: false, removed, carried, existingTitle, placeRestored: true };
            }
        }
        if (!first || first.hasConference || !supported) {
            return { ics: restored, created: false, removed, carried, existingTitle };
        }
        const provider = asksAgain;
        if (!provider) {
            return { ics: restored, created: false, removed, carried, existingTitle };
        }
        // A save refused further down (a read-only series, an invitation, Proton) comes back from
        // Calendar.app unchanged at its next sync: the room made the first time is used again, not a new one per try.
        const roomKey = `${calendar.protonCalendarId}\u0000${this.peekUid(restored) || first.title}\u0000${provider}`;
        const kept = this.madeRooms.get(roomKey);
        let conference = kept && Date.now() - kept.at < MADE_ROOM_MEMORY_MS ? kept.conference : null;
        if (!conference) {
            conference = await this.calendarAppWrite(async () => {
                try {
                    return await this.protonAdapter.createVideoConference(provider, { title: first.title, calendarId: calendar.protonCalendarId });
                } catch (error) {
                    const refusal = this.videoLinkRefusal(provider, error);
                    // 0.37.14: a refusal by plan or connection is a 403 for Calendar.app (like the bridge's other
                    // refusals), not a 500 — only a failure to reach Proton stays a server error.
                    throw refusal.plan ? new ReadOnlyEventError(refusal.message) : withReason(error, refusal.message);
                }
            });
            this.madeRooms.set(roomKey, { at: Date.now(), conference });
            if (this.madeRooms.size > 100) {
                this.madeRooms.delete(this.madeRooms.keys().next().value as string);
            }
            console.log(`[video] a ${PROVIDER_NAMES[provider]} link was made for an event in "${secret(calendar.displayName)}"`);
        }
        const describe = await this.protonAdapter.conferenceDescriber();
        const made = conference;
        return { ics: withVideoLink(restored, made, (description) => describe(description, made)), created: true, removed, carried, existingTitle, roomKey };
    }

    /** 0.34.2: after a save, a Proton Meet room of this account is renamed when the event's title changed. */
    private async followVideoLinkTitle(video: VideoLinkContext) {
        if (video.created || video.removed || typeof this.protonAdapter.renameProtonMeet !== 'function') {
            return;
        }
        const conference = conferenceOfIcsText(video.ics);
        const title = masterVeventOf(video.ics)?.title ?? '';
        if (!conference || conference.provider !== 2 || !this.isOwnAddress(conference.host ?? null) || !title || title === video.existingTitle) {
            return;
        }
        try {
            if (await this.protonAdapter.renameProtonMeet(conference.url, title)) {
                console.log('[video] a Proton Meet room was renamed after its event');
            }
        } catch (error) {
            console.warn(`[video] the Proton Meet room could not be renamed: ${error instanceof Error ? error.message : error}`);
        }
    }

    /** 0.34.2: when an event is deleted from Calendar.app, a Proton Meet room of this account goes with it (Proton leaves it). */
    private async dropVideoRoom(record: BridgeEventRecord) {
        if (typeof this.protonAdapter.deleteProtonMeet !== 'function') {
            return;
        }
        const conference = conferenceOfIcsText(record.serializedIcs);
        if (!conference || conference.provider !== 2 || !this.isOwnAddress(conference.host ?? null)) {
            return;
        }
        // Moved to another calendar (Calendar.app: PUT there, DELETE here): the event lives on with its room.
        const elsewhere = (await this.mirrorDatabase.findLiveEventsByUid(record.uid).catch(() => [])).some(
            (entry) => entry.protonCalendarId !== record.protonCalendarId && !entry.deleted
        );
        if (elsewhere) {
            return;
        }
        try {
            if (await this.protonAdapter.deleteProtonMeet(conference.url)) {
                console.log('[video] the Proton Meet room was removed with its event');
            }
        } catch (error) {
            console.warn(`[video] the Proton Meet room could not be removed: ${error instanceof Error ? error.message : error}`);
        }
    }

    private forgetMadeRooms(protonCalendarId: string, uid: string | null | undefined) {
        for (const key of [...this.madeRooms.keys()]) {
            if (key.startsWith(`${protonCalendarId}\u0000${uid ?? ''}\u0000`)) {
                this.madeRooms.delete(key);
            }
        }
    }

    /** 0.34.1: rooms made for saves Calendar.app may send again, by calendar, UID and provider. */
    private madeRooms = new Map<string, { at: number; conference: { provider: 1 | 2; id: string; url: string; password?: string; host?: string } }>();

    /** Why a room could not be made, for Calendar.app (Proton's error codes: 2904 Zoom not connected; 2032/9100 not in the plan). */
    private videoLinkRefusal(provider: 1 | 2, error: unknown): { message: string; plan: boolean } {
        const message = error instanceof Error ? error.message : String(error);
        const code = Number((error as { data?: { Code?: unknown } } | null)?.data?.Code);
        const status = Number((error as { status?: unknown } | null)?.status);
        if (provider === 1 && code === 2904) {
            return { message: t('Zoom is not connected to your Proton account, so no Zoom link could be made. Connect it in Proton Calendar\'s settings, or type "Proton Meet" as the location.'), plan: true };
        }
        if (provider === 1 && (code === 2032 || code === 9100 || status === 403)) {
            return { message: t('Zoom links are not included in your Proton plan, so no Zoom link could be made. Type "Proton Meet" as the location instead.'), plan: true };
        }
        return { message: t('No {provider} link could be made: {error}', { provider: PROVIDER_NAMES[provider], error: message }), plan: false };
    }

    // ----- 0.35: offline edits — the outbox -----

    /** Calendars → UIDs with a change waiting for Proton (mirrors the outbox table). */
    private pendingUids = new Map<string, Set<string>>();
    /** 0.42.1: a calendar change still on its way to Proton after it went to the outbox (no answer in time). */
    private lateAppearanceSends = new Map<string, Promise<unknown>>();
    private appearanceAnswerMs = APPEARANCE_ANSWER_MS;

    /**
     * 0.42.1: Proton is known to be out of reach (the connection watch runs): a change from Calendar.app
     * goes straight to the outbox instead of waiting for the connection to time out (Calendar.app gives up first).
     */
    private protonKnownUnreachable() {
        return Boolean(this.outage) && this.protonAdapter.isSignedIn() && !this.signingOut;
    }
    /** UIDs whose waiting change is being sent right now: a re-read of Proton's version may land meanwhile. */
    private replayingUids = new Set<string>();
    private flushInFlight: Promise<void> | null = null;
    private outboxTimer: NodeJS.Timeout | null = null;
    /** Calendars whose yellow dot is the outbox's ("n changes wait"), so only that is cleared when they are sent. */
    private outboxWarned = new Set<string>();

    private async loadPendingUids() {
        this.pendingUids = new Map();
        for (const item of await this.mirrorDatabase.listOutbox().catch(() => [])) {
            this.notePending(item.protonCalendarId, item.uid, true);
        }
        for (const calendar of await this.mirrorDatabase.listCalendars(true).catch(() => [] as BridgeCalendarRecord[])) {
            this.notePendingWarning(calendar);
        }
    }

    private notePending(protonCalendarId: string, uid: string, pending: boolean) {
        const set = this.pendingUids.get(protonCalendarId) ?? new Set<string>();
        if (pending) {
            set.add(uid);
            this.pendingUids.set(protonCalendarId, set);
        } else {
            set.delete(uid);
            if (!set.size) {
                this.pendingUids.delete(protonCalendarId);
            }
        }
    }

    /** True while a change from Calendar.app to this event waits for Proton (a sync pass leaves its row alone). */
    private isPending(protonCalendarId: string, uid: string | undefined) {
        return Boolean(uid && this.pendingUids.get(protonCalendarId)?.has(uid));
    }

    /** How many changes wait for Proton (all calendars, or one). */
    pendingChangeCount(protonCalendarId?: string) {
        if (protonCalendarId) {
            return this.pendingUids.get(protonCalendarId)?.size ?? 0;
        }
        let count = 0;
        for (const set of this.pendingUids.values()) {
            count += set.size;
        }
        return count;
    }

    /**
     * 0.40: a waiting change is replayed without an If-Match of its own, so a save from an outdated
     * copy (Calendar.app's If-Match is not the local version's ETag) is refused before it joins the
     * outbox — Calendar.app re-reads — instead of overwriting a newer version when Proton is back.
     */
    private async refuseOutdatedBeforeQueue(slug: string, uid: string, ifMatch: string | undefined) {
        if (!ifMatch) {
            return;
        }
        const calendar = await this.mirrorDatabase.getCalendarBySlug(slug).catch(() => null);
        const current = calendar ? await this.mirrorDatabase.getEventByUid(calendar.protonCalendarId, uid) : null;
        if (!calendar || !current || current.deleted || etagMatches(ifMatch, current.etag)) {
            return;
        }
        // 0.41: the same leeway as a live save — a copy older only in what Proton does not store (e.g. the
        // PRODID of a served file) is not outdated; for a meeting you organize, one older only in guests'
        // answers is not either (answers always come from Proton). Meetings get the meeting's wording.
        if (this.matchesUnchangedReplacedVersion(calendar, current, ifMatch)) {
            return;
        }
        const organized = icsHasParticipants(current.serializedIcs) && this.isOwnAddress(this.organizerOf(current.serializedIcs));
        if (organized && this.acceptsReplacedVersion(calendar, current, ifMatch)) {
            return;
        }
        throw organized ? new StaleEventError(INVITATION_MESSAGES.staleMeeting) : new StaleEventError();
    }

    /**
     * Whether a failed change from Calendar.app is one to keep for later: Proton could not be reached
     * (no connection, a timeout, a server error) while signed in, or (0.40) Proton's slow-down pause
     * was on before the change, so nothing of it was sent. A refusal, a slow-down that hit a write
     * under way (Calendar.app is told to wait, as before), a refused app version or an ended session is not.
     */
    private offlineQueueApplies(error: unknown) {
        // The write path's own verdicts are not "no answer": a refusal, a stale copy, an invitation that
        // was emailed but not saved (its text may quote the connection error; a replay would email again).
        if (error instanceof ReadOnlyEventError || error instanceof StaleEventError || error instanceof ProtonHumanVerificationRequiredError || errorName(error) === SIGNED_OUT_MEANWHILE) {
            return false;
        }
        const pausedBeforeWrite = errorName(error) === 'RateLimitedError' && (error as { beforeWrite?: boolean }).beforeWrite === true;
        return (isUnreachableFailure(error) || pausedBeforeWrite) && this.protonAdapter.isSignedIn() && !this.signingOut;
    }

    /** During a replay the write itself may be told to wait (a slow-down, an ended session): the change keeps waiting too. */
    private replayMustWait(error: unknown) {
        const name = errorName(error);
        return isUnreachableFailure(error) || name === 'RateLimitedError' || name === 'SessionExpiredError' || name === 'AppVersionError' || name === SIGNED_OUT_MEANWHILE;
    }

    /**
     * A save from Calendar.app that could not reach Proton: taken into the local copy as if it had
     * been saved (Calendar.app sees it like any other event) and put into the outbox with the row as
     * it was before, to be sent when Proton is back. A later save of the same event replaces the
     * waiting one; the snapshot stays the first one.
     */
    private async queuePut(slug: string, resourceName: string, resourceHref: string, serializedIcs: string, reason: string) {
        const calendar = await this.requireWritableCalendar(slug);
        const fallbackUid = decodeURIComponent(resourceName.replace(/\.ics$/i, ''));
        const uid = this.peekUid(serializedIcs) || fallbackUid;
        const existing = await this.mirrorDatabase.getEventByUid(calendar.protonCalendarId, uid);
        const queued = await this.mirrorDatabase.getOutboxItem(calendar.protonCalendarId, uid);
        const snapshot = queued ? queued.snapshot : existing && !existing.deleted ? existing : null;
        const { eventData } = parseIcs(serializedIcs, uid);
        const record = buildEventRecordShape(
            {
                protonEventId: existing?.protonEventId ?? `pending:${uid}`,
                protonCalendarId: calendar.protonCalendarId,
                uid,
                href: existing?.href ?? resourceHref,
                title: eventData.title,
                description: eventData.description,
                location: eventData.location,
                startTimestamp: eventData.startTime,
                endTimestamp: eventData.endTime,
                timezone: eventData.timezone,
                isAllDay: eventData.isAllDay,
                modifiedTimestamp: Date.now(),
                protonEventIds: existing?.protonEventIds,
                conference: eventData.conference ?? undefined
            },
            serializedIcs
        );
        await this.mirrorDatabase.upsertEvent(record);
        await this.mirrorDatabase.putOutboxItem({
            createdAt: queued?.createdAt ?? Date.now(),
            protonCalendarId: calendar.protonCalendarId,
            slug,
            uid,
            kind: 'put',
            resourceName,
            href: record.href,
            ics: serializedIcs,
            notifyOrganizer: true,
            snapshot
        });
        this.notePending(calendar.protonCalendarId, uid, true);
        await this.bumpCalendar(calendar);
        console.log(`[outbox] a change to an event in "${secret(calendar.displayName)}" waits for Proton (${reason})`);
        this.notePendingWarning(calendar);
        this.scheduleOutboxRetry();
        this.notifyStateChange();
        return record;
    }

    /** A deletion from Calendar.app that could not reach Proton: gone from the local copy, sent later. */
    private async queueDelete(slug: string, uid: string, notifyOrganizer: boolean, reason: string) {
        const calendar = await this.requireWritableCalendar(slug);
        const existing = await this.mirrorDatabase.getEventByUid(calendar.protonCalendarId, uid);
        if (!existing || existing.deleted) {
            return;
        }
        const queued = await this.mirrorDatabase.getOutboxItem(calendar.protonCalendarId, uid);
        if (queued?.kind === 'put' && !queued.snapshot) {
            // Created and deleted while Proton was away: Proton never needs to hear of it.
            await this.mirrorDatabase.removeOutboxItem(queued.id);
            await this.mirrorDatabase.removeEventByUid(calendar.protonCalendarId, uid);
            this.notePending(calendar.protonCalendarId, uid, false);
            await this.bumpCalendar(calendar);
            this.notePendingWarning(calendar);
            this.notifyStateChange();
            return;
        }
        await this.mirrorDatabase.markEventDeleted(existing.protonEventId);
        await this.mirrorDatabase.putOutboxItem({
            createdAt: queued?.createdAt ?? Date.now(),
            protonCalendarId: calendar.protonCalendarId,
            slug,
            uid,
            kind: 'delete',
            resourceName: `${encodeURIComponent(uid)}.ics`,
            href: existing.href,
            ics: null,
            notifyOrganizer,
            snapshot: queued ? queued.snapshot : existing
        });
        this.notePending(calendar.protonCalendarId, uid, true);
        await this.bumpCalendar(calendar);
        console.log(`[outbox] a deletion in "${secret(calendar.displayName)}" waits for Proton (${reason})`);
        this.notePendingWarning(calendar);
        this.scheduleOutboxRetry();
        this.notifyStateChange();
    }

    /** The calendar's yellow dot says how many changes wait (cleared when none do). */
    private notePendingWarning(calendar: BridgeCalendarRecord) {
        const count = this.pendingChangeCount(calendar.protonCalendarId);
        const id = calendar.protonCalendarId;
        if (count > 0) {
            // A refusal's own warning (set by recordCalDAVError) is left in place: it says more.
            if (!this.calendarWarnings.has(id) || this.outboxWarned.has(id)) {
                this.calendarWarnings.set(id, { message: tn('{count} change waits for Proton', '{count} changes wait for Proton', count), at: Date.now() });
                this.outboxWarned.add(id);
            }
        } else if (this.outboxWarned.has(id)) {
            this.calendarWarnings.delete(id);
            this.outboxWarned.delete(id);
        }
    }

    /** Tries the outbox again in a minute while something waits (a sync pass that works tries at once). */
    private scheduleOutboxRetry() {
        if (this.outboxTimer || !this.pendingChangeCount()) {
            return;
        }
        this.outboxTimer = setTimeout(() => {
            this.outboxTimer = null;
            void this.flushOutbox();
        }, OUTBOX_RETRY_MS);
        this.outboxTimer.unref?.();
    }

    /**
     * Sends what waits, oldest first, each as the save it was: the row goes back to what Proton last
     * had (the snapshot), the normal write path runs with the kept ICS — invitations and answers are
     * emailed now, under the email mode in force — and the row is rewritten from the result. No answer
     * from Proton: the local change stays as it is and the rest waits. Refused: the snapshot stays
     * (Calendar.app re-reads the version Proton has), the Overview and a notification say why.
     */
    async flushOutbox() {
        if (this.flushInFlight) {
            // One run at a time; a call during a run means "try again now", so one more run follows it.
            await this.flushInFlight.catch(() => undefined);
        }
        if (this.flushInFlight || !this.protonAdapter.isSignedIn() || this.signingOut || Date.now() < this.slowDownUntil || !this.pendingChangeCount()) {
            this.scheduleOutboxRetry();
            return;
        }
        this.flushInFlight = this.runOutbox().finally(() => {
            this.flushInFlight = null;
        });
        await this.flushInFlight;
    }

    private async runOutbox() {
        let changed = false;
        try {
            for (const listed of await this.mirrorDatabase.listOutbox()) {
                if (this.signingOut || Date.now() < this.slowDownUntil) {
                    break;
                }
                const calendar = (await this.mirrorDatabase.listCalendars(true)).find((entry) => entry.protonCalendarId === listed.protonCalendarId);
                // Gone from Proton, or unticked meanwhile (0.37: also by a deletion in Calendar.app): nothing to send it to.
                if (!calendar || calendar.removed || !this.isCalendarSyncEnabled(listed.protonCalendarId)) {
                    await this.mirrorDatabase.removeOutboxItem(listed.id);
                    this.notePending(listed.protonCalendarId, listed.uid, false);
                    continue;
                }
                const outcome = await this.withEventLock(`${listed.slug}\u0000${listed.uid}`, async () => {
                    // Under the lock: the change may have been replaced or withdrawn since the list was read.
                    const item = await this.mirrorDatabase.getOutboxItem(listed.protonCalendarId, listed.uid);
                    return item ? this.replayOutboxItem(item, calendar) : 'gone';
                });
                changed = true;
                if (outcome === 'unreachable') {
                    break;
                }
            }
        } catch (error) {
            console.warn(`[outbox] stopped: ${errorText(error)}`);
        } finally {
            if (changed) {
                for (const calendar of await this.mirrorDatabase.listCalendars(true).catch(() => [] as BridgeCalendarRecord[])) {
                    this.notePendingWarning(calendar);
                }
                this.notifyStateChange();
            }
            this.scheduleOutboxRetry();
        }
    }

    private async replayOutboxItem(item: OutboxItem, calendar: BridgeCalendarRecord): Promise<'sent' | 'unreachable' | 'refused'> {
        if (item.kind === 'appearance') {
            return this.replayAppearance(item, calendar);
        }
        const optimistic = await this.mirrorDatabase.getEventByUid(calendar.protonCalendarId, item.uid);
        // Back to what Proton last had, so the write path compares against that (and emails, if due).
        if (item.snapshot) {
            await this.mirrorDatabase.upsertEvent(item.snapshot);
        } else if (optimistic) {
            await this.mirrorDatabase.removeEventByUid(calendar.protonCalendarId, item.uid);
        }
        // The UID stays pending (a pass meanwhile must not take the row for missing); the write's own
        // re-read of Proton's version may land, though.
        const replayKey = `${calendar.protonCalendarId}\u0000${item.uid}`;
        this.replayingUids.add(replayKey);
        try {
            await this.calendarAppWrite(async () => {
                if (item.kind === 'put') {
                    await this.upsertLocalEventUnlocked(item.slug, item.resourceName, item.href, item.ics ?? '', {});
                } else {
                    await this.deleteLocalEventUnlocked(item.slug, item.uid, { notifyOrganizer: item.notifyOrganizer });
                }
            });
            await this.mirrorDatabase.removeOutboxItem(item.id);
            this.notePending(calendar.protonCalendarId, item.uid, false);
            console.log(`[outbox] a ${item.kind === 'put' ? 'change' : 'deletion'} in "${secret(calendar.displayName)}" reached Proton (waited since ${new Date(item.createdAt).toISOString()})`);
            return 'sent';
        } catch (error) {
            const message = errorText(error);
            if (this.replayMustWait(error)) {
                // Still no Proton (or it asks to wait): the local change stays in force.
                if (optimistic) {
                    await this.mirrorDatabase.upsertEvent(optimistic);
                } else {
                    await this.mirrorDatabase.removeEventByUid(calendar.protonCalendarId, item.uid);
                }
                await this.mirrorDatabase.noteOutboxAttempt(item.id, message);
                return 'unreachable';
            }
            // Refused for good: the snapshot stays — Calendar.app gets Proton's version back at its next refresh.
            await this.mirrorDatabase.removeOutboxItem(item.id);
            this.notePending(calendar.protonCalendarId, item.uid, false);
            await this.bumpCalendar(calendar);
            const method = item.kind === 'put' ? 'PUT' : 'DELETE';
            console.warn(`[outbox] a ${item.kind === 'put' ? 'change' : 'deletion'} in "${secret(calendar.displayName)}" was refused once Proton was back; the local copy shows Proton's version again: ${message}`);
            this.recordCalDAVError({
                at: Date.now(),
                method,
                path: item.href,
                status: 403,
                message: t('Made while Proton could not be reached, refused now that it is back — the calendar shows Proton\'s version again: {error}', { error: message })
            });
            return 'refused';
        } finally {
            this.replayingUids.delete(replayKey);
        }
    }

    /** 0.42: a waiting calendar name/colour/description change, sent now. */
    private async replayAppearance(item: OutboxItem, calendar: BridgeCalendarRecord): Promise<'sent' | 'unreachable' | 'refused'> {
        const late = this.lateAppearanceSends.get(calendar.protonCalendarId);
        if (late) {
            await late;
            this.lateAppearanceSends.delete(calendar.protonCalendarId);
        }
        let wanted: { name?: string; color?: string; description?: string } = {};
        try {
            wanted = item.ics ? JSON.parse(item.ics) : {};
        } catch {
            wanted = {};
        }
        try {
            await this.calendarAppWrite(() => this.protonAdapter.updateCalendarAppearance(calendar.protonCalendarId, wanted));
        } catch (error) {
            const message = errorText(error);
            if (this.replayMustWait(error)) {
                await this.mirrorDatabase.noteOutboxAttempt(item.id, message);
                return 'unreachable';
            }
            await this.mirrorDatabase.removeOutboxItem(item.id);
            this.notePending(calendar.protonCalendarId, CALENDAR_APPEARANCE_UID, false);
            const before = item.snapshot as unknown as BridgeCalendarRecord | null;
            if (before?.protonCalendarId === calendar.protonCalendarId) {
                await this.mirrorDatabase.updateCalendarMetadata({ ...calendar, displayName: before.displayName, color: before.color, description: before.description }, true);
            }
            console.warn(`[outbox] a change of the calendar "${secret(calendar.displayName)}" was refused once Proton was back; it shows Proton's version again: ${message}`);
            this.recordCalDAVError({
                at: Date.now(),
                method: 'PROPPATCH',
                path: item.href,
                status: 403,
                message: t('Made while Proton could not be reached, refused now that it is back — the calendar shows Proton\'s version again: {error}', { error: message })
            });
            return 'refused';
        }
        await this.mirrorDatabase.removeOutboxItem(item.id);
        this.notePending(calendar.protonCalendarId, CALENDAR_APPEARANCE_UID, false);
        const remote = (await this.protonAdapter.listCalendars().catch(() => []))?.find((entry) => entry.id === calendar.protonCalendarId);
        if (remote) {
            await this.mirrorDatabase.updateCalendarMetadata({ ...calendar, displayName: remote.name, color: remote.color, description: remote.description || '' }, true);
        }
        console.log(`[outbox] a change of the calendar "${secret(remote?.name ?? calendar.displayName)}" reached Proton (waited since ${new Date(item.createdAt).toISOString()})`);
        return 'sent';
    }

    private async calendarAppWrite<T>(write: () => Promise<T>): Promise<T> {
        if (Date.now() < this.slowDownUntil) {
            // 0.40: refused before anything was sent — during a slow-down (not a refused app version)
            // the change can wait in the outbox like an offline one (offlineQueueApplies).
            throw Object.assign(new Error(this.slowDownText ?? slowDownMessage(this.slowDownUntil)), {
                name: 'RateLimitedError',
                retryAt: this.slowDownUntil,
                beforeWrite: this.slowDownText === null
            });
        }
        const generation = this.adapterGeneration();
        try {
            return await write();
        } catch (error) {
            switch (errorName(error)) {
                case 'RateLimitedError':
                    this.noteSlowDown(error);
                    break;
                case 'SessionExpiredError':
                    // Only the current session's: a write still running on an ended one must not
                    // throw away a session signed in since.
                    if (generation === this.adapterGeneration()) {
                        this.recoverSession();
                    }
                    break;
                case 'AppVersionError':
                    this.noteAppVersionRejected(errorText(error));
                    break;
            }
            throw error;
        }
    }

    private async withEventLock<T>(key: string, action: () => Promise<T>): Promise<T> {
        const previous = this.eventLocks.get(key) ?? Promise.resolve();
        const run = previous.catch(() => undefined).then(action);
        const tail = run.catch(() => undefined);
        this.eventLocks.set(key, tail);
        try {
            return await run;
        } finally {
            if (this.eventLocks.get(key) === tail) {
                this.eventLocks.delete(key);
            }
        }
    }

    private async upsertLocalEventUnlocked(
        slug: string,
        resourceName: string,
        resourceHref: string,
        serializedIcs: string,
        options: { ifMatch?: string; client?: CalDAVClientKind }
    ) {
        const video: VideoLinkContext = { ics: serializedIcs, created: false, removed: false, carried: false, existingTitle: undefined };
        const result = await this.upsertLocalEventSteps(slug, resourceName, resourceHref, serializedIcs, options, video);
        if (video.created && video.roomKey) {
            // 0.41.2: the room is on the event in Proton now. The memory is only for a save Calendar.app sends
            // again after a refusal; once the link is taken off (here or in Proton Calendar, which deletes the
            // room), typing "Proton Meet" again must make a new room, not bring back the deleted one.
            this.madeRooms.delete(video.roomKey);
        }
        // 0.34.2: a Proton Meet room of this account follows its event's title (best effort, after the save).
        await this.followVideoLinkTitle(video);
        if ((video.created || video.removed || video.placeRestored) && result?.etag) {
            // 0.41.3: the saved event is not what Calendar.app sent (the link is the location now, or the link
            // was taken off): no ETag in the reply, so Calendar.app fetches it at once instead of keeping its
            // copy ("Proton Meet") until a later sync changes the ETag.
            return { ...result, etag: '' };
        }
        return result;
    }

    private async upsertLocalEventSteps(
        slug: string,
        resourceName: string,
        resourceHref: string,
        serializedIcs: string,
        options: { ifMatch?: string; client?: CalDAVClientKind },
        video: VideoLinkContext
    ) {
        this.syncStats.lastDirection = 'push';
        const calendar = await this.requireWritableCalendar(slug);
        const fallbackUid = decodeURIComponent(resourceName.replace(/\.ics$/i, ''));
        // 0.48.4: a save "if it is still the version I read" (If-Match) of an event that is gone (deleted in
        // Calendar.app, Proton Calendar or another app meanwhile) is refused, not taken as a new event:
        // Thunderbird re-saved a meeting deleted minutes before (it had dismissed its alert), and the bridge
        // created it again and re-sent the invitation. Without If-Match (a new event) nothing changes.
        if (options.ifMatch && options.ifMatch.trim() !== '*') {
            const clientUid = this.peekUid(serializedIcs) || fallbackUid;
            const live = (await this.listEventsForSlug(slug)).some((event) => event.href === resourceHref || event.uid === clientUid);
            if (!live) {
                console.log(`[caldav] save of an event that no longer exists refused (If-Match without a current copy): ${secret(clientUid)}`);
                throw new StaleEventError(t('This event was deleted meanwhile; nothing was saved. It disappears after the next refresh.'));
            }
        }

        // Recurring series (or an event that used to be one) go through the series writer, which
        // sends the master and every modified occurrence to Proton in one request.
        const { record: existingForSeries, takenOff } = await this.withFreshConference(
            calendar,
            await this.mirrorDatabase.getEventByUid(calendar.protonCalendarId, this.peekUid(serializedIcs) || fallbackUid)
        );
        // 0.34.1: a conference the stored event has comes back into the ICS (Calendar.app drops what it
        // does not know), and "Proton Meet" / "Zoom" as the location asks for a new one.
        const videoLinked = await this.withVideoLinks(calendar, serializedIcs, existingForSeries, takenOff);
        serializedIcs = videoLinked.ics;
        Object.assign(video, videoLinked);
        const guarded = await this.handleParticipants(calendar, existingForSeries, serializedIcs, options.ifMatch, resourceHref, options.client);
        if (guarded) {
            return guarded;
        }
        const wasSeries = Boolean(
            existingForSeries && !existingForSeries.deleted && Object.keys(existingForSeries.protonEventIds).length > 1
        );
        if (icsHasRecurrence(serializedIcs) || wasSeries || (existingForSeries && icsHasRecurrence(existingForSeries.serializedIcs))) {
            if (!this.canWriteSeries()) {
                throw new ReadOnlyEventError(RECURRING_READ_ONLY_MESSAGE);
            }
            return this.upsertLocalSeries(calendar, resourceHref, serializedIcs, existingForSeries);
        }

        const { uid, eventData } = parseIcs(serializedIcs, fallbackUid);
        // 0.33: the event's alarms travel with it (the client decides between "the calendar's
        // defaults", a list, or none); an older client leaves them out, as before.
        const alarms = this.remindersSupported() ? await this.protonAdapter.alarmBlocksOf(serializedIcs) : undefined;
        if (alarms) {
            (eventData as EventData).alarms = alarms;
        }
        // 0.34.1: only a conference made for this very save travels with the write; otherwise the client
        // keeps what Proton has (the mirror's copy may be older than a removal in Proton Calendar).
        const conference = eventData.conference ?? undefined;
        if (videoLinked.removed) {
            eventData.conference = null; // the link was taken off in Calendar.app: Proton removes it (and the Meet room)
        } else if (!videoLinked.created && !videoLinked.carried) {
            delete eventData.conference;
        }
        const existingRecord = await this.mirrorDatabase.getEventByUid(calendar.protonCalendarId, uid);

        if (existingRecord && !existingRecord.deleted) {
            // A save that changes nothing Proton stores (Calendar.app re-saving after an alert was
            // dismissed, a PRODID change) is not a rewrite: no ETag back, Calendar.app re-reads.
            if (await this.unchangedForProton(existingRecord.serializedIcs, serializedIcs, uid)) {
                return { ...existingRecord, etag: '' };
            }
            const startedUpdate = Date.now();
            const updateResult = await this.protonAdapter.updateEvent(
                calendar.protonCalendarId,
                existingRecord.protonEventId,
                eventData as EventData
            );
            if (!updateResult.success) {
                throw writeError(updateResult.error, 'Failed to update Proton event');
            }
            console.log(`[sync] ${uid}: written to Proton (updated, ${Date.now() - startedUpdate} ms)`); // 1.0.0: every write named

            const updatedRecord = buildEventRecordShape(
                {
                    protonEventId: existingRecord.protonEventId,
                    protonCalendarId: calendar.protonCalendarId,
                    uid,
                    href: existingRecord.href,
                    title: eventData.title,
                    description: eventData.description,
                    location: eventData.location,
                    startTimestamp: eventData.startTime,
                    endTimestamp: eventData.endTime,
                    timezone: eventData.timezone,
                    isAllDay: eventData.isAllDay,
                    modifiedTimestamp: Date.now(),
                    alarms,
                    conference
                },
                serializedIcs
            );

            await this.mirrorDatabase.upsertEvent(updatedRecord);
            await this.bumpCalendar(calendar);
            return updatedRecord;
        }

        if (existingRecord?.deleted) {
            await this.mirrorDatabase.removeEventByUid(calendar.protonCalendarId, uid);
        }

        const startedCreate = Date.now();
        const createResult = await this.protonAdapter.createEvent(calendar.protonCalendarId, eventData as EventData);
        if (!createResult.success || !createResult.id) {
            throw writeError(createResult.error, 'Failed to create Proton event');
        }
        console.log(`[sync] ${uid}: written to Proton (created, ${Date.now() - startedCreate} ms)`);

        const createdRecord = buildEventRecordShape(
                {
                    protonEventId: createResult.id,
                    protonCalendarId: calendar.protonCalendarId,
                    uid,
                    href: resourceHref,
                    title: eventData.title,
                    description: eventData.description,
                    location: eventData.location,
                    startTimestamp: eventData.startTime,
                endTimestamp: eventData.endTime,
                timezone: eventData.timezone,
                isAllDay: eventData.isAllDay,
                modifiedTimestamp: Date.now(),
                alarms,
                conference
            },
            serializedIcs
        );

        await this.mirrorDatabase.upsertEvent(createdRecord);
        await this.bumpCalendar(calendar);
        return createdRecord;
    }

    /**
     * Writes a recurring series from Calendar.app to Proton: every VEVENT in the payload is
     * matched to the Proton event it already has (master or exception by RECURRENCE-ID), updated
     * or created, and Proton events for occurrences no longer in the payload are deleted.
     * Proton applies the whole request or nothing, so the mirror only changes on success.
     */
    private async upsertLocalSeries(
        calendar: BridgeCalendarRecord,
        resourceHref: string,
        serializedIcs: string,
        existingRecord: BridgeEventRecord | null
    ) {
        const vevents = this.protonAdapter.parseIcs(serializedIcs);
        if (!vevents.length) {
            throw new Error('The submitted ICS payload does not contain a VEVENT');
        }
        const uid = vevents[0].uid?.value;
        if (!uid || vevents.some((vevent) => vevent.uid?.value !== uid)) {
            throw new Error('All VEVENTs of a calendar object must share one UID');
        }

        const knownIds = existingRecord && !existingRecord.deleted ? existingRecord.protonEventIds : {};
        const components = vevents.map((vevent) => {
            const key = occurrenceKey(icsDateFromVcal(vevent['recurrence-id']));
            return { key, vevent, protonEventId: knownIds[key] };
        });
        const keysInPayload = new Set(components.map((component) => component.key));
        const deleteEventIds = Object.entries(knownIds)
            .filter(([key]) => !keysInPayload.has(key))
            .map(([, eventId]) => eventId);

        const result = await this.protonAdapter.syncSeries({
            calendarId: calendar.protonCalendarId,
            components: components.map(({ vevent, protonEventId }) => ({ vevent, protonEventId })),
            deleteEventIds
        });
        if (!result.success) {
            throw writeError(result.error, 'Failed to write the series to Proton');
        }

        const protonEventIds: Record<string, string> = {};
        components.forEach((component, index) => {
            protonEventIds[component.key] = result.eventIds[index];
        });
        const master = components.find((component) => component.key === '') ?? components[0];
        const masterVevent = master.vevent;
        const start = icsDateFromVcal(masterVevent.dtstart);
        const end = icsDateFromVcal(masterVevent.dtend) ?? start;
        const toSeconds = (value: ReturnType<typeof icsDateFromVcal>) =>
            value ? Math.floor(icsDateToUtcMs(value) / 1000) : 0;

        if (existingRecord && existingRecord.protonEventId !== protonEventIds[master.key]) {
            await this.mirrorDatabase.removeEventByUid(calendar.protonCalendarId, existingRecord.uid);
        }
        // 0.41.7: kept as Calendar.app is to see it (no join block) until the next sync re-reads the series.
        const servedIcs = withServedDescriptions(serializedIcs);
        const contentHash = createHash('sha256').update(servedIcs).digest('hex');
        const record: BridgeEventRecord = {
            protonEventId: protonEventIds[master.key],
            protonCalendarId: calendar.protonCalendarId,
            uid,
            href: existingRecord?.href || resourceHref,
            etag: `"${contentHash}"`,
            contentHash,
            serializedIcs: servedIcs,
            title: masterVevent.summary?.value || '',
            description: masterVevent.description?.value || '',
            location: masterVevent.location?.value || '',
            startTimestamp: toSeconds(start),
            endTimestamp: toSeconds(end),
            timezone: (start?.kind === 'date-time' && start.tzid) || 'UTC',
            isAllDay: start?.kind === 'date',
            modifiedTimestamp: Date.now(),
            deleted: false,
            lastSyncedAt: Date.now(),
            protonEventIds
        };
        await this.mirrorDatabase.upsertEvent(record);
        await this.bumpCalendar(calendar);
        return record;
    }

    getAccountAddresses() {
        return [...this.accountAddresses];
    }

    private refreshAccountAddresses() {
        try {
            const addresses = this.protonAdapter.listAddresses();
            if (addresses.length) {
                this.accountAddresses = addresses.map((address) => address.email);
                // 0.37: only an active address can own a new calendar (a disabled one still counts as "me").
                this.activeAddresses = addresses.filter((address) => address.active !== false).map((address) => address.email);
            }
        } catch (error) {
            console.warn('[bridge] could not read account addresses:', error instanceof Error ? error.message : error);
        }
    }

    /**
     * 0.33.1: the contacts Calendar.app's guest search is answered from — the account's contact
     * addresses with their names (Proton keeps those in clear), the account's own addresses first.
     * Read on the first search and again after ten minutes, in the background: a search never
     * waits for Proton (the first one may come back short), and a failure keeps the last list.
     */
    async listContactsForSearch(): Promise<Array<{ email: string; name: string; self: boolean }>> {
        const own = this.accountAddresses.map((email) => ({ email, name: this.protonAdapter.getSignedInUsername() || '', self: true }));
        if (!this.protonAdapter.isSignedIn()) {
            return own;
        }
        const stale = !this.contacts || Date.now() - this.contacts.at > CONTACTS_TTL_MS;
        if (stale && !this.contactsRefresh) {
            const session = this.session;
            let refresh: Promise<void> | null = null;
            const run = (async () => {
                try {
                    const entries = await this.protonAdapter.listContactEmails();
                    if (this.session !== session) {
                        return; // signed out meanwhile: not this account's contacts any more
                    }
                    const seen = new Set<string>();
                    this.contacts = {
                        at: Date.now(),
                        entries: entries
                            .filter(({ email }) => {
                                const key = email.toLowerCase();
                                if (seen.has(key)) {
                                    return false;
                                }
                                seen.add(key);
                                return true;
                            })
                            .map(({ email, name }) => ({ email, name }))
                    };
                    console.log(`[contacts] ${this.contacts.entries.length} contact address(es) for the guest search`);
                } catch (error) {
                    if (this.session !== session) {
                        return;
                    }
                    console.warn(`[contacts] could not read the contacts: ${error instanceof Error ? error.message : error}`);
                    this.contacts = { at: Date.now() - CONTACTS_TTL_MS + CONTACTS_RETRY_MS, entries: this.contacts?.entries || [] };
                } finally {
                    if (this.contactsRefresh === refresh) {
                        this.contactsRefresh = null; // not a newer account's refresh
                    }
                }
            })();
            refresh = run;
            this.contactsRefresh = run;
        }
        if (!this.contacts && this.contactsRefresh) {
            await this.contactsRefresh; // the first searches wait for the list once; later ones get the cached list
        }
        const ownKeys = new Set(own.map(({ email }) => email.toLowerCase()));
        return [...own, ...(this.contacts?.entries || []).filter(({ email }) => !ownKeys.has(email.toLowerCase())).map((entry) => ({ ...entry, self: false }))];
    }

    /**
     * 0.33.2, availability: a calendar user's busy periods in a window (unix ms), for Calendar.app's
     * free/busy lookup. One of the account's own addresses is answered from the mirror (every ticked
     * own or shared calendar; series expanded; transparent, cancelled and declined events free).
     * Anyone else is asked from Proton's busy-schedule endpoint, which only shares inside an
     * organization on an eligible plan — otherwise, and for addresses outside Proton, the answer is
     * "unknown" (remembered for a while, so typing a guest does not ask Proton again and again).
     */
    async freeBusyOf(email: string, windowStart: number, windowEnd: number): Promise<FreeBusyAnswer> {
        if (!Number.isFinite(windowStart) || !Number.isFinite(windowEnd) || windowEnd <= windowStart) {
            return { known: false };
        }
        const end = Math.min(windowEnd, windowStart + BUSY_WINDOW_MAX_MS);
        if (this.isOwnAddress(email)) {
            return this.ownFreeBusy(windowStart, end);
        }
        if (!this.protonAdapter.isSignedIn()) {
            return { known: false };
        }
        const key = email.toLowerCase();
        const cached = this.busyCache.get(key);
        if (cached) {
            const ttl = cached.result.known ? BUSY_TTL_MS : cached.windowEnd === 0 ? BUSY_ERROR_TTL_MS : BUSY_NOT_SHARED_TTL_MS;
            if (Date.now() - cached.at < ttl && (!cached.result.known || (cached.windowStart <= windowStart && cached.windowEnd >= end))) {
                return cached.result.known
                    ? { known: true, periods: await this.protonAdapter.mergeBusyPeriods(cached.result.periods, windowStart, end), end }
                    : cached.result;
            }
        }
        // One lookup per guest at a time: Calendar.app may ask again before Proton has answered. The
        // answer serves this request too when its window is covered; otherwise this one asks afterwards.
        const running = this.busyLookups.get(key);
        if (running) {
            await running;
            return this.freeBusyOf(email, windowStart, windowEnd);
        }
        const lookup = (async (): Promise<FreeBusyAnswer> => {
            try {
                const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
                const schedule = await this.protonAdapter.getBusySchedule(email, Math.floor(windowStart / 1000), Math.ceil(end / 1000), timeZone);
                const result: FreeBusyAnswer = schedule.accessible
                    ? {
                          known: true,
                          periods: await this.protonAdapter.mergeBusyPeriods(
                              schedule.slots.map((slot) => ({ start: slot.start * 1000, end: slot.end * 1000, allDay: slot.allDay })),
                              windowStart,
                              end
                          ),
                          end
                      }
                    : { known: false };
                this.rememberBusy(key, { at: Date.now(), windowStart, windowEnd: end, result });
                return result;
            } catch (error) {
                console.warn(`[availability] Proton did not answer a busy-times lookup: ${error instanceof Error ? error.message : error}`);
                this.rememberBusy(key, { at: Date.now(), windowStart, windowEnd: 0, result: { known: false } }); // windowEnd 0: an error, kept briefly
                return { known: false };
            } finally {
                this.busyLookups.delete(key);
            }
        })();
        this.busyLookups.set(key, lookup);
        return lookup;
    }

    private rememberBusy(key: string, entry: { at: number; windowStart: number; windowEnd: number; result: FreeBusyAnswer }) {
        this.busyCache.set(key, entry);
        if (this.busyCache.size > 200) {
            this.busyCache.delete(this.busyCache.keys().next().value as string);
        }
    }

    /**
     * The user's own busy times from the mirror: every ticked own or shared calendar that counts towards
     * availability (0.37.7: not those switched off in Calendar.app), rows that can
     * touch the window (a series by its rule's UNTIL, like the sync window), series expanded by the
     * client, all-day events on this Mac's local days, overlaps merged. Kept for a short while, as
     * Calendar.app asks again at every keystroke in the guest field.
     */
    private async ownFreeBusy(windowStart: number, end: number): Promise<FreeBusyAnswer> {
        const kept = this.ownBusy;
        if (kept && Date.now() - kept.at < OWN_BUSY_TTL_MS && kept.windowStart <= windowStart && kept.windowEnd >= end) {
            return { known: true, periods: await this.protonAdapter.mergeBusyPeriods(kept.periods, windowStart, end), end };
        }
        if (!(await this.protonAdapter.supportsAvailability())) {
            return { known: false };
        }
        const periods: Array<{ start: number; end: number; allDay: boolean; tentative?: boolean }> = [];
        for (const calendar of await this.getCalendars()) {
            if (calendar.removed || !this.isCalendarOpaque(calendar)) {
                continue;
            }
            for (const record of await this.mirrorDatabase.listEventsForCalendar(calendar.protonCalendarId)) {
                // A day's slack on either side: the row's times are the first occurrence's, in UTC seconds.
                if (!touchesWindow(record.startTimestamp, record.endTimestamp, rruleOf(record.serializedIcs), windowStart / 1000 - 86_400, end / 1000 + 86_400)) {
                    continue;
                }
                try {
                    const found = await this.protonAdapter.busyPeriodsOf(record.serializedIcs, windowStart - 86_400_000, end + 86_400_000, this.accountAddresses);
                    periods.push(...found.map(allDayPeriodInLocalTime));
                } catch (error) {
                    // ical.js names the offending line in its message: only with detailed logging.
                    console.warn(`[availability] an event could not be read for free/busy: ${secret(error instanceof Error ? error.message : String(error))}`);
                }
            }
        }
        this.ownBusy = { at: Date.now(), windowStart, windowEnd: end, periods };
        return { known: true, periods: await this.protonAdapter.mergeBusyPeriods(periods, windowStart, end), end };
    }

    private isOwnAddress(email: string | null) {
        return Boolean(email) && this.accountAddresses.some((own) => own.toLowerCase() === email!.toLowerCase());
    }

    /** ORGANIZER address of the first VEVENT that has one (without a full parse). */
    private organizerOf(ics: string) {
        // Parameters may be quoted and contain ':' (CN="Doe, Jane: PI"), so skip quoted runs explicitly.
        // Alarms are left out: an email alarm's ATTENDEE/… lines are not the event's.
        const match = veventBlocksWithoutAlarms(ics)
            .join('\r\n')
            .match(/^ORGANIZER(?:"[^"]*"|[^:"\r\n])*:(?:mailto:)?([^\r\n]+)$/im);
        return match ? match[1].trim() : null;
    }

    /**
     * Saves to events with an organizer or guests. Returns the unchanged record when the save only
     * touches things Proton does not store (e.g. an alert added in Calendar.app); answers the
     * invitation when only your own answer changed (Accept / Maybe / Decline); saves meetings you
     * organize like Proton Calendar (guests get an invitation, update or cancellation); throws a
     * 403-worthy error for anything else. Returns null when neither version involves other people.
     */
    private async handleParticipants(
        calendar: BridgeCalendarRecord,
        existing: BridgeEventRecord | null,
        serializedIcs: string,
        ifMatch: string | undefined,
        resourceHref: string,
        client?: CalDAVClientKind
    ): Promise<BridgeEventRecord | null> {
        const live = existing && !existing.deleted ? existing : null;
        const existingHas = Boolean(live && icsHasParticipants(live.serializedIcs));
        const payloadHas = icsHasParticipants(serializedIcs);
        if (!existingHas && !payloadHas) {
            return null;
        }
        // 0.33: the reminders of a meeting or invitation are personal (Proton's personal part): they
        // are set on their own after the change, so guests are not emailed and nothing else moves.
        const normalize = this.remindersSupported() ? await this.protonAdapter.alarmNormalizer() : null;
        const parse = (ics: string) => {
            try {
                return this.protonAdapter.parseIcs(ics);
            } catch {
                return [];
            }
        };
        if (!existingHas) {
            // Guests added in Calendar.app: a new meeting, or an event of yours that becomes one.
            const saved = await this.saveMeetingFromCalendarApp(calendar, live, serializedIcs, ifMatch, resourceHref);
            // An event of yours that became a meeting: its alarm changes as usual. A brand-new meeting:
            // the occurrences with alarms (one created without any gets the calendar's defaults, like
            // a plain event).
            const newKeys = !normalize
                ? []
                : live
                  ? occurrencesWithChangedAlarms(parse(live.serializedIcs), parse(serializedIcs), normalize)
                  : [...alarmKeysByOccurrence(parse(serializedIcs), normalize)].filter(([key, value]) => value || key !== '').map(([key]) => key);
            return this.withReminderChanges(calendar, saved, serializedIcs, newKeys);
        }

        const organizedByMe = this.isOwnAddress(this.organizerOf(live!.serializedIcs));
        // Can't compare: refuse rather than risk it.
        const before = parse(live!.serializedIcs);
        const after = parse(serializedIcs);
        const changedAlarms = normalize && before.length && after.length ? occurrencesWithChangedAlarms(before, after, normalize) : [];
        if (before.length && after.length) {
            if (sameForProton(before, after)) {
                if (changedAlarms.length) {
                    // Only the reminders changed: the personal part, nothing else — and a failure is told.
                    return this.withReminderChanges(calendar, { ...live!, etag: '' }, serializedIcs, changedAlarms, { required: true });
                }
                // Nothing Proton stores changed. No ETag in the reply (see the CalDAV PUT handler),
                // so Calendar.app fetches Proton's version again.
                if (!organizedByMe) {
                    // 0.48.6: which answer of yours the save held (Thunderbird's answers went unnoticed).
                    const yours = after.flatMap((vevent) =>
                        (vevent.attendee ?? [])
                            .filter((attendee) => this.isOwnAddress(String(attendee.value || '').replace(/^mailto:/i, '')))
                            .map((attendee) => String(attendee.parameters?.partstat || 'NEEDS-ACTION').toUpperCase())
                    );
                    console.log(`[invitations] ${live!.uid}: save of an invitation that changes nothing in Proton (your answer in it: ${yours.join(', ') || 'none — no guest with one of your addresses'}) — ${describeIcsShape(serializedIcs)}`);
                }
                return { ...live!, etag: '' };
            }
            if (!organizedByMe && before.every((vevent) => String(vevent.status?.value || '').toUpperCase() === 'CANCELLED')) {
                // 0.40.3: the organizer cancelled this meeting. Proton Calendar offers only Delete for it,
                // and Calendar.app saves a changed copy (e.g. your answer) before it sends the delete:
                // refusing that save stopped the delete. Nothing is written; the delete that follows
                // removes it (without emailing the organizer, as for any cancelled invitation).
                console.log(`[invitations] ${live!.uid}: save of a cancelled invitation taken as it is (nothing written) — ${describeIcsShape(serializedIcs)}`);
                return { ...live!, etag: '' };
            }
            if (!organizedByMe) {
                const changes = ownAnswerChanges(before, after, this.accountAddresses);
                if (changes?.length) {
                    // An answer "changed" relative to an outdated copy may be one the user never gave
                    // (unless the newer copy differs in nothing Proton stores, e.g. only the PRODID).
                    if (!etagMatches(ifMatch, live!.etag) && !this.matchesUnchangedReplacedVersion(calendar, live!, ifMatch)) {
                        throw new StaleEventError();
                    }
                    let answered: BridgeEventRecord;
                    try {
                        answered = await this.answerFromCalendarApp(calendar, live!, changes);
                    } catch (error) {
                        if (error instanceof InvitationCancelledError) {
                            // 0.44.2: like 0.40.3, only the sync had not seen the cancellation yet.
                            console.log(`[invitations] ${live!.uid}: answer to an invitation the organizer cancelled meanwhile — taken as it is (nothing sent or written)`);
                            return { ...live!, etag: '' };
                        }
                        throw error;
                    }
                    return this.withReminderChanges(calendar, answered, serializedIcs, changedAlarms);
                }
                // 0.40: first, as the occurrence Calendar.app adds for an alert repeats your answer to the series.
                if (onlyNewOccurrenceAlarms(before, after)) {
                    throw new InvitationNotSupportedError(INVITATION_MESSAGES.occurrenceReminder);
                }
                if (repeatsSeriesAnswer(before, after, this.accountAddresses)) {
                    // 0.49.4: the client's copy is behind: its series is unanswered and the occurrences it adds carry
                    // the answer the series already has in Proton (Thunderbird replaying a cached change after
                    // 0.49.3 answered the series). Nothing to do; no ETag, so the client fetches Proton's version.
                    console.log(`[invitations] ${live!.uid}: the occurrences answered in this save repeat the answer the series already has — nothing to do (the app's copy is behind; it fetches the current one)`);
                    return { ...live!, etag: '' };
                }
                if (answersNewOccurrence(before, after, this.accountAddresses)) {
                    // 0.49.3: Thunderbird (and other apps) answer from the occurrence you opened — their guest
                    // dialog offers no "whole series". A series not answered yet takes that as its answer, as
                    // Proton Calendar does. Calendar.app keeps the refusal: there you chose "this occurrence".
                    const seriesAnswer = client && client !== 'calendar-app' ? seriesAnswerFromNewOccurrence(before, after, this.accountAddresses) : null;
                    if (seriesAnswer) {
                        if (!etagMatches(ifMatch, live!.etag) && !this.matchesUnchangedReplacedVersion(calendar, live!, ifMatch)) {
                            throw new StaleEventError();
                        }
                        console.log(`[invitations] ${live!.uid}: ${client === 'thunderbird' ? 'Thunderbird' : 'the app'} answered one occurrence of a series not answered yet (${seriesAnswer}) — taken as your answer for the whole series, as Proton Calendar does`);
                        try {
                            return await this.answerFromCalendarApp(calendar, live!, [{ key: '', answer: seriesAnswer }]);
                        } catch (error) {
                            if (error instanceof InvitationCancelledError) {
                                console.log(`[invitations] ${live!.uid}: answer to an invitation the organizer cancelled meanwhile — taken as it is (nothing sent or written)`);
                                return { ...live!, etag: '' };
                            }
                            throw error;
                        }
                    }
                    throw new InvitationNotSupportedError(INVITATION_MESSAGES.answerOccurrence);
                }
            }
        }
        if (organizedByMe) {
            // 0.40.2: an alert on one occurrence of a series you organize, nothing else changed: the
            // library makes no event of its own for that occurrence (nothing guests see changed), so
            // the alert would be dropped without a word. Refused with the same rule as for invitations.
            if (before.length && after.length && onlyNewOccurrenceAlarms(before, after)) {
                throw new InvitationNotSupportedError(INVITATION_MESSAGES.occurrenceReminder);
            }
            const saved = await this.saveMeetingFromCalendarApp(calendar, live, serializedIcs, ifMatch, resourceHref);
            return this.withReminderChanges(calendar, saved, serializedIcs, changedAlarms);
        }
        // What Calendar.app sent (no text, no notes), for the next case that should not be refused.
        console.log(`[invitations] ${live!.uid}: change of an invitation refused — before ${describeIcsShape(live!.serializedIcs)}; sent ${describeIcsShape(serializedIcs)}`);
        throw new InvitationNotSupportedError(INVITATION_MESSAGES.changeInvitation);
    }

    /**
     * 0.33: sets the reminders of the given occurrences ('' = the master) of a meeting or
     * invitation from the client's ICS, through Proton's personal part, and re-reads the event so
     * the mirror (and Calendar.app, which fetches again when no ETag comes back) shows them.
     * A failure here is logged, not thrown: the change itself went through.
     */
    private async withReminderChanges(
        calendar: BridgeCalendarRecord,
        record: BridgeEventRecord,
        serializedIcs: string,
        occurrenceKeys: string[],
        { required = false }: { required?: boolean } = {}
    ): Promise<BridgeEventRecord> {
        if (!occurrenceKeys.length || !this.remindersSupported()) {
            return record;
        }
        const current = (await this.mirrorDatabase.getEventByUid(calendar.protonCalendarId, record.uid)) ?? record;
        const ids = this.protonIdsOf(current);
        let changed = false;
        const failures: string[] = [];
        /** 0.40: occurrences without a Proton event of their own (Proton keeps their reminders with the series). */
        const withoutOwnEvent: string[] = [];
        for (const key of occurrenceKeys) {
            const eventId = ids[key] || (key === '' ? current.protonEventId : undefined);
            if (!eventId) {
                if (key !== '') {
                    withoutOwnEvent.push(key);
                }
                continue;
            }
            const alarms = await this.alarmBlocksOfOccurrence(serializedIcs, key);
            try {
                const result = await this.protonAdapter.setEventReminders(calendar.protonCalendarId, eventId, alarms);
                if (!result.success) {
                    failures.push(result.error || 'unknown error');
                } else if (result.changed) {
                    changed = true;
                }
            } catch (error) {
                failures.push(error instanceof Error ? error.message : String(error));
            }
        }
        for (const failure of failures) {
            console.warn(`[reminders] "${current.title ? secret(current.title) : current.uid}": reminders not saved: ${failure}`);
        }
        if (failures.length && required && !changed) {
            // Nothing else was written for this save: say so, instead of a success that reverts.
            throw new Error(t('The reminders could not be saved in Proton: {error}', { error: failures[0] }));
        }
        if (withoutOwnEvent.length) {
            if (required && !changed && !failures.length) {
                // 0.40: only reminders of such occurrences changed — refused with Proton's rule instead of a save that reverts.
                throw new InvitationNotSupportedError(INVITATION_MESSAGES.occurrenceReminder);
            }
            console.warn(
                `[reminders] "${current.title ? secret(current.title) : current.uid}": ${withoutOwnEvent.length} occurrence(s) without an event of their own keep the series' reminders` +
                    ` (${required ? 'reminders only' : 'saved with another change'}${changed ? ', other reminders set' : ''})`
            );
        }
        if (changed) {
            await this.refreshAfterInvitationWrite(calendar, current, this.protonUidOf(current));
        }
        return { ...record, etag: '' };
    }

    /**
     * 0.33: true when a client's new version of a plain event differs from the stored one in nothing
     * Proton stores — not in its reminders either (compared as Proton would store them). Only with
     * a client that reads reminders; otherwise every save is written, as before.
     */
    private async unchangedForProton(storedIcs: string, clientIcs: string, uid?: string): Promise<boolean> {
        if (!this.remindersSupported()) {
            return false;
        }
        try {
            const before = this.protonAdapter.parseIcs(storedIcs);
            const after = this.protonAdapter.parseIcs(clientIcs);
            if (!before.length || !after.length) {
                return false;
            }
            if (!sameForProton(before, after)) {
                // 0.49.13: which of the two comparisons made the save a write (a dismissed Thunderbird alert once
                // was): named in the log, without the event's content.
                console.log(`[sync] ${uid ?? 'event'}: the save changes what Proton stores — written`);
                return false;
            }
            const normalize = await this.protonAdapter.alarmNormalizer();
            const changed = occurrencesWithChangedAlarms(before, after, normalize);
            if (changed.length) {
                const was = alarmKeysByOccurrence(before, normalize);
                const now = alarmKeysByOccurrence(after, normalize);
                console.log(`[sync] ${uid ?? 'event'}: the save changes the reminders — written (${changed.map((key) => `${key || 'event'}: ${was.get(key) || 'none'} → ${now.get(key) || 'none'}`).join('; ')})`);
                return false;
            }
            return true;
        } catch {
            return false;
        }
    }

    /** 0.33: the linked client reads and writes reminders (the test fakes may not have the method). */
    private remindersSupported() {
        const adapter = this.protonAdapter as Partial<ProtonAdapter>;
        return typeof adapter.supportsReminders === 'function' && adapter.supportsReminders();
    }

    /** The VALARM blocks of one VEVENT (by occurrence key) in a client's ICS. */
    private async alarmBlocksOfOccurrence(serializedIcs: string, key: string): Promise<string[]> {
        const unfolded = serializedIcs.replace(/\r?\n[ \t]/g, '');
        for (const block of unfolded.match(/^BEGIN:VEVENT[ \t]*$[\s\S]*?^END:VEVENT[ \t]*$/gim) || []) {
            let blockKey = '';
            try {
                const [vevent] = this.protonAdapter.parseIcs(`BEGIN:VCALENDAR\r\nVERSION:2.0\r\n${block.replace(/\r?\n/g, '\r\n')}\r\nEND:VCALENDAR\r\n`);
                blockKey = occurrenceKey(icsDateFromVcal(vevent?.['recurrence-id']));
            } catch {
                continue;
            }
            if (blockKey === key) {
                return this.protonAdapter.alarmBlocksOf(block);
            }
        }
        return [];
    }

    /**
     * 0.49.5: a series save after a conflict ("Submit my changes anyway" in Thunderbird) carries the
     * client's whole item, its unchanged occurrences as they were before Proton's last change. Those
     * are not changes of the client's: left out, so the save goes through with what the client did
     * change, and the occurrences stay as Proton has them (the client sees that after its refresh).
     * Only versions replaced in the last minutes are known (REPLACED_VERSION_MEMORY_MS).
     */
    private withoutStaleOccurrences(calendar: BridgeCalendarRecord, existing: BridgeEventRecord, vevents: ReturnType<ProtonAdapter['parseIcs']>) {
        const now = Date.now();
        const earlier = (this.replacedVersions.get(`${calendar.protonCalendarId}\u0000${existing.uid}`) ?? []).filter(({ at }) => now - at < REPLACED_VERSION_MEMORY_MS);
        if (!earlier.length) {
            return vevents;
        }
        try {
            const stale = new Set(staleOccurrenceKeys(vevents, this.protonAdapter.parseIcs(existing.serializedIcs), earlier.map(({ serializedIcs }) => this.protonAdapter.parseIcs(serializedIcs))));
            if (!stale.size) {
                return vevents;
            }
            console.log(`[invitations] ${existing.uid}: the save's ${[...stale].join(', ')} match the version served before the last change, not Proton's — the app's copy is behind there, those occurrences are left as Proton has them`);
            return vevents.filter((vevent) => !stale.has(occurrenceKey(icsDateFromVcal(vevent['recurrence-id']))));
        } catch {
            return vevents;
        }
    }

    private rememberReplacedVersion(protonCalendarId: string, record: BridgeEventRecord) {
        const key = `${protonCalendarId}\u0000${record.uid}`;
        const now = Date.now();
        const versions = (this.replacedVersions.get(key) ?? []).filter(({ at }) => now - at < REPLACED_VERSION_MEMORY_MS);
        versions.push({ etag: record.etag, serializedIcs: record.serializedIcs, at: now });
        this.replacedVersions.set(key, versions.slice(-3));
        for (const [entry, list] of this.replacedVersions) {
            if (list.every(({ at }) => now - at >= REPLACED_VERSION_MEMORY_MS)) {
                this.replacedVersions.delete(entry);
            }
        }
    }

    /**
     * Calendar.app's copy is one a sync pass replaced in the last minutes (e.g. the bridge's own
     * create re-read from Proton, or a guest's answer), and that version and the current one differ
     * at most in answers: a meeting save based on it changes the same things, so it is not refused.
     * The client still checks the current version against Proton (basedOn).
     */
    /**
     * Calendar.app's copy predates the last sync, but that sync changed nothing Proton stores (e.g.
     * only the file's PRODID): as good as the current copy.
     */
    private matchesUnchangedReplacedVersion(calendar: BridgeCalendarRecord, existing: BridgeEventRecord, ifMatch: string | undefined) {
        const versions = this.replacedVersions.get(`${calendar.protonCalendarId}\u0000${existing.uid}`) ?? [];
        const base = versions.find(({ etag, at }) => Date.now() - at < REPLACED_VERSION_MEMORY_MS && etagMatches(ifMatch, etag));
        if (!base) {
            return false;
        }
        try {
            return sameForProton(this.protonAdapter.parseIcs(base.serializedIcs), this.protonAdapter.parseIcs(existing.serializedIcs));
        } catch {
            return false;
        }
    }

    private acceptsReplacedVersion(calendar: BridgeCalendarRecord, existing: BridgeEventRecord, ifMatch: string | undefined) {
        const versions = this.replacedVersions.get(`${calendar.protonCalendarId}\u0000${existing.uid}`) ?? [];
        const base = versions.find(({ etag, at }) => Date.now() - at < REPLACED_VERSION_MEMORY_MS && etagMatches(ifMatch, etag));
        if (!base) {
            return false;
        }
        try {
            if (sameExceptAnswers(this.protonAdapter.parseIcs(base.serializedIcs), this.protonAdapter.parseIcs(existing.serializedIcs))) {
                console.log(`[invitations] ${existing.uid}: Calendar.app's copy predates the last sync, but only answers differ; going ahead`);
                return true;
            }
        } catch {
            // Can't compare: stay on the safe side.
        }
        return false;
    }

    private supportsOrganizing() {
        const adapter = this.protonAdapter as Partial<ProtonAdapter>;
        return typeof adapter.supportsOrganizing === 'function' && adapter.supportsOrganizing();
    }

    private supportsOrganizingSeries() {
        const adapter = this.protonAdapter as Partial<ProtonAdapter>;
        return typeof adapter.supportsOrganizingSeries === 'function' && adapter.supportsOrganizingSeries();
    }

    /**
     * A meeting you organize, saved in Calendar.app (created with guests, guests added or removed,
     * time / title / place / notes changed): saved in Proton like Proton Calendar does, which emails
     * the guests (subject to the email policy). Recurring meetings (stage 3b): the whole series goes
     * to the client, which reads the change from it ("all occurrences", one occurrence changed or
     * deleted) and refuses what Proton Calendar cannot do.
     */
    private async saveMeetingFromCalendarApp(
        calendar: BridgeCalendarRecord,
        existing: BridgeEventRecord | null,
        serializedIcs: string,
        ifMatch: string | undefined,
        resourceHref: string
    ): Promise<BridgeEventRecord> {
        const hadGuests = Boolean(existing && icsHasParticipants(existing.serializedIcs));
        if (!this.supportsOrganizing()) {
            throw new InvitationNotSupportedError(hadGuests ? INVITATION_MESSAGES.changeOrganized : INVITATION_MESSAGES.addGuests);
        }
        const wasSeries = Boolean(existing && Object.keys(this.protonIdsOf(existing)).length > 1);
        const recurring = icsHasRecurrence(serializedIcs) || wasSeries || Boolean(existing && icsHasRecurrence(existing.serializedIcs));
        if (recurring && !this.supportsOrganizingSeries()) {
            throw new InvitationNotSupportedError(INVITATION_MESSAGES.organizeRecurring);
        }
        // RFC 6638: SCHEDULE-AGENT=CLIENT/NONE means the client sends (or nobody sends) the invitations.
        const clientScheduling = clientSchedulingOf(serializedIcs);
        if (clientScheduling.length) {
            // Which action of Calendar.app does this is not known yet: log what it sent (no text, no notes).
            console.warn(
                `[invitations] refused ${this.peekUid(serializedIcs) || '(no UID)'}: ${clientScheduling.map(({ description }) => description).join('; ')}` +
                    ` — ${describeIcsShape(serializedIcs)}`
            );
            throw new InvitationNotSupportedError(
                clientScheduling.every(({ agent }) => agent === 'NONE')
                    ? INVITATION_MESSAGES.organizeDontNotify
                    : INVITATION_MESSAGES.organizeClientScheduling
            );
        }
        const organizer = this.organizerOf(serializedIcs);
        if (organizer && !this.isOwnAddress(organizer)) {
            throw new InvitationNotSupportedError(hadGuests ? INVITATION_MESSAGES.changeInvitation : INVITATION_MESSAGES.organizeForeign);
        }
        // Changes from an outdated copy could remove guests someone added in the meantime.
        if (existing && !etagMatches(ifMatch, existing.etag) && !this.acceptsReplacedVersion(calendar, existing, ifMatch)) {
            throw new StaleEventError(INVITATION_MESSAGES.staleMeeting);
        }
        const vevents = recurring && existing ? this.withoutStaleOccurrences(calendar, existing, this.protonAdapter.parseIcs(serializedIcs)) : this.protonAdapter.parseIcs(serializedIcs);
        const [vevent] = vevents;
        if (!vevent) {
            throw new Error('The submitted ICS payload does not contain a VEVENT');
        }
        const uid = vevent.uid?.value || existing?.uid || '';
        if (vevents.some((candidate) => (candidate.uid?.value || uid) !== uid)) {
            throw new Error('All VEVENTs of a calendar object must share one UID');
        }
        if (!existing) {
            const elsewhere = (await this.mirrorDatabase.findLiveEventsByUid(uid)).filter(
                (record) => record.protonCalendarId !== calendar.protonCalendarId
            );
            if (elsewhere.length) {
                // Calendar.app follows the copy with a delete of the original: refuse that too.
                this.refusedMoves.set(uid, Date.now());
                throw new InvitationNotSupportedError(INVITATION_MESSAGES.moveMeeting);
            }
        }

        // A new meeting has no mirror row yet: it is created under the address Calendar.app used.
        const record: BridgeEventRecord = existing ?? {
            protonEventId: '',
            protonCalendarId: calendar.protonCalendarId,
            uid,
            href: resourceHref,
            etag: '',
            contentHash: '',
            serializedIcs,
            title: vevent.summary?.value || '',
            description: '',
            location: '',
            startTimestamp: 0,
            endTimestamp: 0,
            timezone: 'UTC',
            isAllDay: false,
            modifiedTimestamp: Date.now(),
            deleted: false,
            lastSyncedAt: Date.now(),
            protonEventIds: {}
        };
        const eventID = existing ? this.protonIdsOf(existing)[''] || existing.protonEventId : undefined;
        // What Calendar.app's copy was based on: if Proton has other guests or times by now, the
        // client refuses (412) instead of undoing that change.
        const basedOn = existing ? this.protonAdapter.parseIcs(existing.serializedIcs) : undefined;
        // New guests who cannot be invited (test mode, or Proton cannot email them) are left out
        // and the rest is saved, so the meeting is not lost; Calendar.app is told with a refusal.
        const withoutRefusedGuests = true;
        const { droppedGuests } = await this.runInvitationSteps(calendar, record, [
            () =>
                recurring
                    ? this.protonAdapter.saveOrganizedSeries({ calendarID: calendar.protonCalendarId, eventID, vevents, basedOn, withoutRefusedGuests })
                    : this.protonAdapter.saveOrganizedEvent({ calendarID: calendar.protonCalendarId, eventID, vevent, basedOn: basedOn?.[0], withoutRefusedGuests })
        ]);
        if (droppedGuests.length) {
            // Saved: Calendar.app shows the refusal and then reloads Proton's version (without them).
            const list = droppedGuests.map(({ email, reason }) => `${email} (${reason})`).join(', ');
            const message = t('Saved without {guests}; the other changes went through. Fix the address or the allowlist and add them again.', { guests: list });
            console.warn(`[invitations] "${vevent.summary?.value ? secret(vevent.summary.value) : uid}": ${message}`);
            throw new InvitationNotSupportedError(message, { partial: true });
        }
        // No ETag in the reply: Calendar.app fetches Proton's version (organizer, guests, answers).
        const refreshed = await this.mirrorDatabase.getEventByUid(calendar.protonCalendarId, uid);
        return { ...(refreshed ?? record), etag: '' };
    }

    /**
     * Deleting a meeting you organize in Calendar.app: like Proton Calendar, the guests get a
     * cancellation (not when Calendar.app asks not to notify them), then it is deleted. A series is
     * deleted with all its occurrences (a cancellation for the series and each changed occurrence).
     */
    private async cancelMeetingFromCalendarApp(calendar: BridgeCalendarRecord, existing: BridgeEventRecord, notifyAttendees: boolean) {
        if (!this.supportsOrganizing()) {
            throw new InvitationNotSupportedError(INVITATION_MESSAGES.deleteOrganized);
        }
        const ids = this.protonIdsOf(existing);
        const isSeries = Object.keys(ids).length > 1 || icsHasRecurrence(existing.serializedIcs);
        if (isSeries && !this.supportsOrganizingSeries()) {
            throw new InvitationNotSupportedError(INVITATION_MESSAGES.organizeRecurring);
        }
        const movedAt = this.refusedMoves.get(existing.uid);
        if (movedAt && Date.now() - movedAt < MOVE_REFUSAL_MEMORY_MS) {
            throw new InvitationNotSupportedError(INVITATION_MESSAGES.moveMeetingDelete);
        }
        await this.runInvitationSteps(calendar, existing, [
            () =>
                this.protonAdapter.cancelOrganizedEvent({
                    calendarID: calendar.protonCalendarId,
                    eventID: ids[''] || existing.protonEventId,
                    notifyAttendees
                })
        ]);
        await this.mirrorDatabase.markEventDeleted(existing.protonEventId);
        await this.bumpCalendar(calendar);
        // Guests' answers to it no longer matter.
        this.noteMeetingGone(existing);
    }

    /** The meeting's UID in Proton (the mirror keeps Calendar.app's UID for meetings created there). */
    private protonUidOf(record: BridgeEventRecord) {
        return this.protonUidByEventId.get(record.protonEventId) ?? record.uid;
    }

    /** A meeting left your calendars (at the latest at `at`, ms): emails about it are dealt with (see fileCalendarEmails). */
    private noteMeetingGone(record: BridgeEventRecord, at = Date.now()) {
        const uid = this.protonUidOf(record);
        this.calendarEmailsGone.set(uid, at);
        this.calendarEmailsChangedUids.add(uid);
    }

    private supportsInvitations() {
        const adapter = this.protonAdapter as Partial<ProtonAdapter>;
        return typeof adapter.supportsInvitations === 'function' && adapter.supportsInvitations();
    }

    /** Proton event IDs of a mirror row by occurrence ('' = series master or single event). */
    private protonIdsOf(record: BridgeEventRecord): Record<string, string> {
        return record.protonEventIds && Object.keys(record.protonEventIds).length
            ? record.protonEventIds
            : { '': record.protonEventId };
    }

    /**
     * Accept / Maybe / Decline pressed in Calendar.app: answer in Proton like Proton Calendar
     * does (the client emails the organizer, subject to the email policy). A series answer comes
     * first; occurrences answered the same way follow it silently, others get their own answer.
     */
    private async answerFromCalendarApp(
        calendar: BridgeCalendarRecord,
        existing: BridgeEventRecord,
        changes: OwnAnswerChange[]
    ): Promise<BridgeEventRecord> {
        if (!this.supportsInvitations()) {
            throw new InvitationNotSupportedError(INVITATION_MESSAGES.answerInvitation);
        }
        const sendable = new Set(['ACCEPTED', 'TENTATIVE', 'DECLINED']);
        if (changes.some((change) => !sendable.has(change.answer))) {
            throw new InvitationNotSupportedError(INVITATION_MESSAGES.answerUnsupported);
        }
        const ids = this.protonIdsOf(existing);
        if (changes.some((change) => !ids[change.key])) {
            throw new InvitationNotSupportedError(INVITATION_MESSAGES.answerOccurrence);
        }

        type Answer = 'ACCEPTED' | 'TENTATIVE' | 'DECLINED';
        const series = changes.find((change) => change.key === '');
        const steps: Array<() => Promise<InvitationOutcome>> = [];
        if (series) {
            const alignSingleEditIDs = changes
                .filter((change) => change.key !== '' && change.answer === series.answer)
                .map((change) => ids[change.key]);
            steps.push(() =>
                this.protonAdapter.answerInvitation({
                    calendarID: calendar.protonCalendarId,
                    eventID: ids[''],
                    answer: series.answer as Answer,
                    alignSingleEditIDs
                })
            );
        }
        for (const change of changes) {
            if (change.key === '' || (series && change.answer === series.answer)) {
                continue;
            }
            steps.push(() =>
                this.protonAdapter.answerInvitation({
                    calendarID: calendar.protonCalendarId,
                    eventID: ids[change.key],
                    answer: change.answer as Answer
                })
            );
        }
        await this.runInvitationSteps(calendar, existing, steps);
        this.calendarEmailsChangedUids.add(this.protonUidOf(existing));

        // No ETag in the reply: Calendar.app fetches Proton's version (with the new answer).
        const refreshed = await this.mirrorDatabase.getEventByUid(calendar.protonCalendarId, existing.uid);
        return { ...(refreshed ?? existing), etag: '' };
    }

    /**
     * Deleting an invitation in Calendar.app: like Proton Calendar, the organizer is told you
     * decline if you had said yes or maybe (not when Calendar.app asks not to notify), then the
     * invitation — the whole series — is removed.
     */
    private async removeInvitationFromCalendarApp(
        calendar: BridgeCalendarRecord,
        existing: BridgeEventRecord,
        notifyOrganizer: boolean
    ) {
        if (!this.supportsInvitations()) {
            throw new InvitationNotSupportedError(INVITATION_MESSAGES.deleteInvitation);
        }
        const ids = this.protonIdsOf(existing);
        // Without a master, Proton holds unrelated single occurrences: each is removed on its own.
        const targets = ids[''] ? [ids['']] : [...new Set(Object.values(ids))];
        await this.runInvitationSteps(
            calendar,
            existing,
            targets.map((eventID) => () =>
                this.protonAdapter.removeInvitation({ calendarID: calendar.protonCalendarId, eventID, notifyOrganizer })
            )
        );
        await this.mirrorDatabase.markEventDeleted(existing.protonEventId);
        await this.bumpCalendar(calendar);
        // Its invitation and update emails no longer need you.
        this.noteMeetingGone(existing);
    }

    /**
     * Runs invitation actions in order, stopping at the first that does not go through. Refusals
     * (test-mode allowlist, dry run, not possible) become 403s with the reason; errors 500s.
     * The calendar is re-read from Proton afterwards whenever something may have changed.
     */
    private async runInvitationSteps(
        calendar: BridgeCalendarRecord,
        record: BridgeEventRecord,
        steps: Array<() => Promise<InvitationOutcome>>
    ) {
        let mayHaveChanged = false;
        let target: { protonUid?: string; eventId?: string } = {};
        let deletedSome = false;
        const droppedGuests: Array<{ email: string; reason: string }> = [];
        try {
            for (const step of steps) {
                const outcome = await step();
                droppedGuests.push(...(outcome.droppedGuests || []));
                if (outcome.protonUid || outcome.eventId) {
                    target = { protonUid: outcome.protonUid, eventId: outcome.eventId };
                }
                // Only when the step removed this event itself (a series save may delete changed occurrences).
                const own = new Set([record.protonEventId, outcome.eventId, ...Object.values(this.protonIdsOf(record))].filter(Boolean));
                if (outcome.success && outcome.deletedEventIds?.some((id) => own.has(id))) {
                    deletedSome = true;
                }
                for (const warning of outcome.warnings || []) {
                    console.warn(`[invitations] ${warning}`);
                }
                if (!outcome.success) {
                    const message = outcome.error || 'The invitation could not be answered';
                    if (outcome.reason === 'incomplete') {
                        // The organizer was already emailed: a 5xx would make Calendar.app retry
                        // on its own. Refuse instead; the client finishes it without a second email
                        // when the user tries again.
                        mayHaveChanged = true;
                        throw new InvitationNotSupportedError(message);
                    }
                    if (!outcome.reason || outcome.reason === 'failed') {
                        mayHaveChanged = true;
                        throw new Error(message);
                    }
                    if (outcome.reason === 'cancelled') {
                        // Cancelled in Proton since the last sync: re-read (the row shows it cancelled), nothing to answer.
                        mayHaveChanged = true;
                        throw new InvitationCancelledError(message);
                    }
                    if (outcome.reason === 'stale') {
                        // Proton has a newer version than Calendar.app's copy: 412, Calendar.app re-reads.
                        mayHaveChanged = true;
                        throw new StaleEventError(message);
                    }
                    if (outcome.reason === 'rate-limited') {
                        // Nothing was sent or changed: 503 with Retry-After, Calendar.app keeps its copy
                        // and tries again then; syncing pauses until Proton's time too. An event Proton
                        // has without guests (a new meeting's first step) is removed at the next pass.
                        if (outcome.leftover) {
                            this.rememberLeftover(outcome.leftover);
                        }
                        throw Object.assign(new Error(message), { name: 'RateLimitedError', retryAt: outcome.retryAt || Date.now() + 60_000 });
                    }
                    throw new InvitationNotSupportedError(message);
                }
                mayHaveChanged = true;
                // 0.41: an email that waits for a slow-down to end is not "unsent" (it goes out after the pause);
                // the slow-down itself is noted like any other (writes and syncing pause until then).
                const waiting = (outcome.emails || []).find((email) => email.outcome === 'failed' && email.deferred);
                if (waiting) {
                    this.noteSlowDown(Object.assign(new Error('Proton asked to slow down'), { name: 'RateLimitedError', retryAt: waiting.retryAt || Date.now() + 60_000 }));
                }
                const unsent = (outcome.emails || []).filter((email) => email.outcome === 'failed' && !email.deferred);
                if (unsent.length) {
                    this.notify({
                        key: `unsent:${record.uid}`,
                        title: t('Saved, but not every guest was emailed'),
                        subtitle: unsent[0].eventTitle,
                        body: unsent.map((email) => `${email.to.map((to) => to.email).join(', ')}: ${email.detail || t('not sent')}`).join('; '),
                        page: 'overview'
                    });
                }
            }
        } finally {
            // 0.44.1: Proton's UID of a meeting made in Calendar.app, known now (before: only after the next pass).
            const eventId = target.eventId || record.protonEventId;
            if (target.protonUid && eventId) {
                this.protonUidByEventId.set(eventId, target.protonUid);
            }
            if (mayHaveChanged) {
                await this.refreshAfterInvitationWrite(calendar, target.eventId && !record.protonEventId ? { ...record, protonEventId: target.eventId } : record, target.protonUid, {
                    goneExpected: deletedSome
                });
            }
        }
        return { droppedGuests };
    }

    /**
     * Re-reads what an invitation action changed: just that event or series when the client can,
     * else the whole calendar. Kept short, so Calendar.app's request does not time out and retry.
     */
    private async refreshAfterInvitationWrite(calendar: BridgeCalendarRecord, record: BridgeEventRecord, protonUid?: string, options: { goneExpected?: boolean } = {}) {
        try {
            await this.withCalendarLock(calendar.protonCalendarId, async () => {
                const reread = await this.refreshSeries(calendar, record, protonUid ?? this.protonUidOf(record), options);
                if (reread === true) {
                    return;
                }
                const current = (await this.mirrorDatabase.getCalendarBySlug(calendar.slug)) ?? calendar;
                // 0.44.1: not found by UID: the calendar's changes (matched by Proton's event ID) decide;
                // a client that cannot read one series lists the calendar in full, as before.
                await this.syncEventsForCalendar(current, reread !== 'unconfirmed');
            });
        } catch (error) {
            console.warn(
                `[invitations] could not re-read "${record.title ? secret(record.title) : record.uid}" after the change: ${error instanceof Error ? error.message : error}`
            );
        }
    }

    /**
     * Rebuilds one mirror row from Proton; false when the client cannot read a single series.
     * `protonUid`: the event's UID in Proton when it differs from the one Calendar.app knows
     * (events created in Calendar.app get a Proton UID); the row keeps Calendar.app's.
     */
    private async refreshSeries(
        calendar: BridgeCalendarRecord,
        record: BridgeEventRecord,
        protonUid: string = record.uid,
        options: { goneExpected?: boolean } = {}
    ): Promise<boolean | 'unconfirmed'> {
        const adapter = this.protonAdapter as Partial<ProtonAdapter>;
        if (typeof adapter.listEventsByUid !== 'function') {
            return false;
        }
        const events = await adapter.listEventsByUid(calendar.protonCalendarId, protonUid);
        if (!events) {
            return false;
        }
        // Same window as a sync pass: changed occurrences outside it are not served.
        const [startDate, endDate] = this.getSyncWindow();
        const inWindow = events.filter(
            (event) =>
                !event.raw?.RecurrenceID ||
                (event.endTimestamp * 1000 >= startDate.getTime() && event.startTimestamp * 1000 <= endDate.getTime())
        );
        const series = groupIntoSeries(inWindow)[0];
        if (!series && options.goneExpected) {
            // The change itself removed it (a deletion, a cancellation): nothing under its UID is the expected answer.
            if (record.protonEventId) {
                await this.mirrorDatabase.markEventDeleted(record.protonEventId);
            }
            await this.bumpCalendar(calendar);
            return true;
        }
        if (!series) {
            // 0.44.1: nothing under this UID is not proof that the event is gone: a meeting made in
            // Calendar.app has another UID in Proton, and the lookup can miss a just-saved event. Marking
            // it deleted here made it vanish from Calendar.app until the next pass brought it back. The
            // caller reads the calendar's changes instead (matched by Proton's event ID), which also
            // notices a real deletion.
            const known = protonUid !== record.uid ? 'Proton UID' : this.protonUidByEventId.has(record.protonEventId) ? 'confirmed UID' : 'Calendar.app UID';
            console.log(
                `[sync] re-read of "${record.title ? secret(record.title) : '…'}" after a change: Proton listed ${events.length} event(s) by its ${known}` +
                    ` (${inWindow.length} in the sync window); the calendar's changes decide instead`
            );
            return 'unconfirmed';
        }
        const next = this.buildMirrorRecord(series, calendar.protonCalendarId, record.href, record.uid);
        // Replace the row this UID has (a deleted one, or one for another Proton event), so the
        // (calendar, uid) index stays unique.
        const current = await this.mirrorDatabase.getEventByUid(calendar.protonCalendarId, record.uid);
        if (current && (current.deleted || current.protonEventId !== next.protonEventId)) {
            await this.mirrorDatabase.removeEventByUid(calendar.protonCalendarId, record.uid);
        }
        await this.mirrorDatabase.upsertEvent(next);
        await this.bumpCalendar(calendar);
        return true;
    }

    private canWriteSeries() {
        return typeof this.protonAdapter.supportsSeriesSync === 'function' && this.protonAdapter.supportsSeriesSync();
    }

    /** UID of the first VEVENT without a full parse (used to find the mirror row before parsing). */
    private peekUid(serializedIcs: string) {
        const match = serializedIcs.replace(/\r?\n[ \t]/g, '').match(/^UID:(.+)$/m);
        return match ? match[1].trim() : null;
    }

    /**
     * `notifyOrganizer: false` comes from Calendar.app's "Schedule-Reply: F" (delete without
     * telling the organizer).
     */
    async deleteLocalEvent(slug: string, uid: string, options: { notifyOrganizer?: boolean } = {}) {
        this.ownBusy = null;
        const pendingCalendar = this.pendingChangeCount() ? await this.mirrorDatabase.getCalendarBySlug(slug).catch(() => null) : null;
        if (pendingCalendar && this.isPending(pendingCalendar.protonCalendarId, uid)) {
            await this.withEventLock(`${slug}\u0000${uid}`, () => this.queueDelete(slug, uid, options.notifyOrganizer !== false, 'an earlier change still waits'));
            void this.flushOutbox();
            return;
        }
        if (this.protonKnownUnreachable()) {
            await this.withEventLock(`${slug}\u0000${uid}`, () => this.queueDelete(slug, uid, options.notifyOrganizer !== false, 'Proton cannot be reached'));
            return;
        }
        try {
            const result = await this.calendarAppWrite(() => this.withEventLock(`${slug}\u0000${uid}`, () => this.deleteLocalEventUnlocked(slug, uid, options)));
            if (this.pendingChangeCount()) {
                void this.flushOutbox();
            }
            return result;
        } catch (error) {
            if (!this.offlineQueueApplies(error)) {
                throw error;
            }
            return await this.withEventLock(`${slug}\u0000${uid}`, () => this.queueDelete(slug, uid, options.notifyOrganizer !== false, errorText(error)));
        } finally {
            this.ownBusy = null;
        }
    }

    private async deleteLocalEventUnlocked(slug: string, uid: string, options: { notifyOrganizer?: boolean }) {
        this.syncStats.lastDirection = 'push';
        const calendar = await this.requireWritableCalendar(slug);
        const existingRecord = await this.mirrorDatabase.getEventByUid(calendar.protonCalendarId, uid);
        if (!existingRecord || existingRecord.deleted) {
            return;
        }
        if (icsHasParticipants(existingRecord.serializedIcs)) {
            if (this.isOwnAddress(this.organizerOf(existingRecord.serializedIcs))) {
                await this.cancelMeetingFromCalendarApp(calendar, existingRecord, options.notifyOrganizer !== false);
                await this.dropVideoRoom(existingRecord);
                return;
            }
            await this.removeInvitationFromCalendarApp(calendar, existingRecord, options.notifyOrganizer !== false);
            return;
        }

        const eventIds = [...new Set(Object.values(existingRecord.protonEventIds))];
        if (eventIds.length > 1 || icsHasRecurrence(existingRecord.serializedIcs)) {
            // A series: remove the master AND its modified occurrences, in one request.
            if (!this.canWriteSeries()) {
                throw new ReadOnlyEventError(RECURRING_READ_ONLY_MESSAGE);
            }
            const result = await this.protonAdapter.syncSeries({
                calendarId: calendar.protonCalendarId,
                components: [],
                deleteEventIds: eventIds
            });
            if (!result.success) {
                throw writeError(result.error, 'Failed to delete the series in Proton');
            }
        } else {
            const deleteResult = await this.protonAdapter.deleteEvent(calendar.protonCalendarId, existingRecord.protonEventId);
            if (!deleteResult.success) {
                throw writeError(deleteResult.error, 'Failed to delete Proton event');
            }
        }

        await this.mirrorDatabase.markEventDeleted(existingRecord.protonEventId);
        await this.bumpCalendar(calendar);
        await this.dropVideoRoom(existingRecord);
    }

    /**
     * 0.34, calendar management: a calendar renamed or recoloured in Calendar.app (PROPPATCH). The
     * change goes to Proton first (your member entry, like Proton Calendar's edit form: works for
     * shared, subscribed and holiday calendars too), then into the mirror so the next PROPFIND
     * already shows it. Colours become the nearest of Proton's accent colours.
     */
    /**
     * 0.42: a calendar's new name, colour or description, kept in the outbox while Proton cannot be
     * reached and shown in Calendar.app at once; merged with a change already waiting for the calendar.
     * Sent by replayOutboxItem; refused then, the calendar shows Proton's version again.
     */
    private async queueAppearance(calendar: BridgeCalendarRecord, wanted: { name?: string; color?: string; description?: string }, reason: string) {
        const queued = await this.mirrorDatabase.getOutboxItem(calendar.protonCalendarId, CALENDAR_APPEARANCE_UID);
        let earlier: { name?: string; color?: string; description?: string } = {};
        try {
            earlier = queued?.ics ? JSON.parse(queued.ics) : {};
        } catch {
            earlier = {};
        }
        const given = Object.fromEntries(Object.entries(wanted).filter(([, value]) => value !== undefined));
        const merged = { ...earlier, ...given };
        await this.mirrorDatabase.putOutboxItem({
            createdAt: queued?.createdAt ?? Date.now(),
            protonCalendarId: calendar.protonCalendarId,
            slug: calendar.slug,
            uid: CALENDAR_APPEARANCE_UID,
            kind: 'appearance',
            resourceName: '',
            href: `/calendars/${this.configStore.load().caldavUsername}/${calendar.slug}/`,
            ics: JSON.stringify(merged),
            notifyOrganizer: false,
            // What Proton last had, for a refusal (the first waiting change's; kept by putOutboxItem).
            snapshot: (queued?.snapshot ?? calendar) as unknown as BridgeEventRecord
        });
        this.notePending(calendar.protonCalendarId, CALENDAR_APPEARANCE_UID, true);
        const updated: BridgeCalendarRecord = {
            ...calendar,
            displayName: wanted.name ?? calendar.displayName,
            color: wanted.color ?? calendar.color,
            description: wanted.description ?? calendar.description
        };
        await this.mirrorDatabase.updateCalendarMetadata(updated, true);
        console.log(`[outbox] a change of the calendar "${secret(updated.displayName)}" waits for Proton (${reason})`);
        this.notePendingWarning(updated);
        this.scheduleOutboxRetry();
        this.notifyStateChange();
        return updated;
    }

    async updateCalendarAppearance(slug: string, changes: { name?: string; color?: string; description?: string }) {
        const calendar = await this.requireCalendar(slug);
        if (!this.protonAdapter.supportsCalendarManagement()) {
            throw new Error(t('Manage calendars in Proton. Creating, renaming and deleting calendars from {app} is not supported.', { app: currentAppName() }));
        }
        const name = changes.name?.trim();
        if (changes.name !== undefined && !name) {
            throw new Error(t('A calendar needs a name.'));
        }
        // 0.37.8: Calendar.app sends a calendar's properties back after every edit (and after creating
        // one), mostly unchanged — nothing to write to Proton then, and nothing to log.
        const sameColour = (a: string | undefined, b: string | undefined) => (a ?? '').replace(/^#([0-9a-f]{6})ff$/i, '#$1').toLowerCase() === (b ?? '').replace(/^#([0-9a-f]{6})ff$/i, '#$1').toLowerCase();
        const unchanged =
            (changes.name === undefined || name === calendar.displayName) &&
            (changes.color === undefined || sameColour(changes.color, calendar.color)) &&
            (changes.description === undefined || changes.description.trim() === (calendar.description || '').trim());
        if (unchanged) {
            return calendar;
        }
        const wanted = { name, color: changes.color, description: changes.description };
        // 0.42: one lock for the whole change (the pending check, the send, the queueing), so changes of a
        // calendar arriving close together keep their order, and none overtakes the outbox's replay.
        const queued = await this.withEventLock(`${calendar.slug}\u0000${CALENDAR_APPEARANCE_UID}`, async () => {
            if (this.isPending(calendar.protonCalendarId, CALENDAR_APPEARANCE_UID)) {
                return this.queueAppearance(calendar, wanted, 'an earlier change still waits');
            }
            // 0.42.1: while Proton is known to be out of reach, nothing is tried: the change waits at once.
            if (this.protonKnownUnreachable()) {
                return this.queueAppearance(calendar, wanted, 'Proton cannot be reached');
            }
            try {
                const send = this.calendarAppWrite(async () => {
                    try {
                        await this.protonAdapter.updateCalendarAppearance(calendar.protonCalendarId, wanted);
                    } catch (error) {
                        throw withReason(error, t('The calendar could not be changed in Proton: {error}', { error: error instanceof Error ? error.message : String(error) }));
                    }
                });
                // 0.42.1: Calendar.app gives up on a PROPPATCH that takes too long (a lost connection can take
                // half a minute to time out) and then refuses to refresh the account until it has sent the
                // change again. No answer within a few seconds: the change waits in the outbox and Calendar.app
                // gets its answer. If the request still reaches Proton, the replay sends the same values again.
                let timer: NodeJS.Timeout | undefined;
                const late = new Promise<'late'>((resolve) => {
                    timer = setTimeout(() => resolve('late'), this.appearanceAnswerMs);
                });
                const outcome = await Promise.race([send.then(() => 'sent' as const), late]).finally(() => clearTimeout(timer));
                if (outcome === 'late') {
                    // The replay waits for this request to end, so it cannot land after a newer change.
                    this.lateAppearanceSends.set(calendar.protonCalendarId, send.catch(() => undefined));
                    return this.queueAppearance(calendar, wanted, `Proton did not answer within ${this.appearanceAnswerMs / 1000} s`);
                }
            } catch (error) {
                // Proton out of reach (or a slow-down before anything was sent): kept and sent later, like event
                // changes (0.35) — before, Calendar.app was refused and kept the old name.
                if (!this.offlineQueueApplies(error)) {
                    throw error;
                }
                return this.queueAppearance(calendar, wanted, errorText(error));
            }
            return null;
        });
        if (queued) {
            return queued;
        }
        // What Proton stored (the colour may have been mapped): read it back once, fall back to the request.
        const remote = (await this.protonAdapter.listCalendars().catch(() => []))?.find((entry) => entry.id === calendar.protonCalendarId);
        const updated: BridgeCalendarRecord = {
            ...calendar,
            displayName: remote?.name ?? name ?? calendar.displayName,
            color: remote?.color ?? changes.color ?? calendar.color,
            description: remote?.description ?? changes.description ?? calendar.description
        };
        await this.mirrorDatabase.updateCalendarMetadata(updated, true);
        console.log(
            `[calendars] "${secret(calendar.displayName)}" changed from Calendar.app (${[changes.name !== undefined && 'name', changes.color !== undefined && 'colour', changes.description !== undefined && 'description'].filter(Boolean).join(', ')})`
        );
        this.notifyStateChange();
        return updated;
    }

    /**
     * 0.34, calendar management: a calendar created in Calendar.app (MKCALENDAR) becomes a personal
     * Proton calendar with its own key (the client does what Proton Calendar does). The collection
     * keeps the path Calendar.app chose, so Calendar.app finds it right away; it is ticked, listed
     * on the Calendars page and synced with the next pass.
     */
    async createCalendarFromCalendarApp(slug: string, appearance: { name?: string; color?: string; description?: string }): Promise<BridgeCalendarRecord | null> {
        if (!this.protonAdapter.isSignedIn()) {
            throw new Error(t('Sign in to Proton first.'));
        }
        if (!this.protonAdapter.supportsCalendarManagement()) {
            throw new Error(t('Manage calendars in Proton. Creating, renaming and deleting calendars from {app} is not supported.', { app: currentAppName() }));
        }
        const name = appearance.name?.trim();
        if (!name) {
            throw new Error(t('A calendar needs a name.'));
        }
        // Creating, listing and reconciling as one step, so a sync pass listing calendars at the same
        // time can neither give the new calendar another path nor take it for one removed in Proton.
        return this.withCalendarListing(async () => {
            if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/.test(slug) || (await this.mirrorDatabase.listCalendars(true)).some((entry) => entry.slug === slug)) {
                throw new Error(t('The calendar could not be created in Proton: {error}', { error: `the path "${slug}" cannot be used` }));
            }
            const created = await this.calendarAppWrite(async () => {
                try {
                    // 0.37: the owning address as set on the Calendars page ('' = the first active one); one that
                    // is no longer active (disabled or removed in Proton meanwhile) is let go of.
                    const chosen = this.configStore.load().newCalendarAddress;
                    const address = chosen && this.activeAddresses.some((entry) => entry.toLowerCase() === chosen.toLowerCase()) ? chosen : undefined;
                    if (chosen && !address) {
                        console.warn(`[calendars] the address set for new calendars (${secret(chosen)}) is no longer active: the first active one owns this calendar, the setting is cleared`);
                        this.configStore.update({ newCalendarAddress: '' });
                    }
                    return await this.protonAdapter.createCalendar({ name, color: appearance.color, description: appearance.description, ...(address ? { address } : {}) });
                } catch (error) {
                    throw withReason(error, t('The calendar could not be created in Proton: {error}', { error: error instanceof Error ? error.message : String(error) }));
                }
            });
            console.log(`[calendars] "${secret(name)}" created from Calendar.app`);
            // From here on the calendar exists in Proton: a failure to mirror it now is not a failure
            // to create it (Calendar.app would make a second one); the next sync pass lists it.
            let record: BridgeCalendarRecord | null = null;
            try {
                const records = await this.reconcileCalendars(await this.protonAdapter.listCalendars(), new Map([[created.id, slug]]));
                record = records.find((entry) => entry.protonCalendarId === created.id) ?? null;
            } catch (error) {
                console.warn(`[calendars] the new calendar could not be listed yet: ${error instanceof Error ? error.message : error}`);
            }
            this.notifyStateChange();
            if (record) {
                this.enqueue(created.id, { manual: false, clearsWarnings: false });
                this.drainInBackground();
            }
            return record;
        });
    }

    /** 0.34: one calendar listing + reconcile at a time (sync passes and calendars created from Calendar.app). */
    private calendarListing: Promise<unknown> = Promise.resolve();

    private withCalendarListing<T>(work: () => Promise<T>): Promise<T> {
        const run = this.calendarListing.then(work, work);
        this.calendarListing = run.catch(() => undefined);
        return run;
    }

    isSignedIn() {
        return this.protonAdapter.isSignedIn();
    }

    getSignedInUsername() {
        return this.protonAdapter.getSignedInUsername();
    }

    /**
     * A sync pass: Proton's calendar list, guests' emailed answers, then every ticked calendar
     * through the queue. auto: the regular timer (public holidays only once a day); refresh: the
     * Refresh button (no public holidays); login: after signing in (everything).
     */
    private async syncNow(kind: SyncPassKind = 'auto', ownPass = kind !== 'auto') {
        const session = this.session;
        // One pass at a time: a Refresh or sign-in waits for the running pass, then has its own.
        // ownPass (also after waking up or reconnecting): a pass that started earlier does not count.
        while (this.passInFlight) {
            await this.passInFlight.catch(() => undefined);
            if (!ownPass) {
                return; // the pass that just ran was as good as this one
            }
        }
        if (this.signingOut || this.session !== session) {
            return; // signed out meanwhile
        }
        const pass = this.performSync(kind).finally(() => {
            if (this.passInFlight === pass) {
                this.passInFlight = null;
            }
            // The next automatic pass is one interval after this one, whatever started it.
            this.scheduleNextSync();
            this.notifyStateChange();
        });
        this.passInFlight = pass;
        await pass;
    }

    private async performSync(kind: SyncPassKind = 'auto') {
        if (!this.protonAdapter.isSignedIn()) {
            return;
        }
        if (Date.now() < this.slowDownUntil) {
            // Proton asked to slow down (or refuses the app version): not a single request before its time.
            this.setHealth('error', this.slowDownText ?? slowDownMessage(this.slowDownUntil));
            return;
        }
        const startedAt = Date.now();
        const requestsBefore = this.adapterRequestStats()?.requests ?? null;
        const decryptedBefore = this.adapterDecryptStats()?.decrypted ?? null;

        this.lastAttemptedSyncAt = Date.now();
        this.passesStarted += 1;
        this.syncStats = { totalEvents: 0, syncedEvents: 0, failedEvents: 0, lastDirection: 'pull' };
        this.passChanges = 0;
        this.setHealth('syncing', () => t('Syncing calendars…'));
        this.notifyStateChange();

        const today = localDayOf(new Date());
        const feed = this.usesChangeFeed();
        // A full pass (every calendar listed and compared): signing in, the Refresh button, the first
        // pass of a day (the safety net), no cursor yet, an older client. Otherwise only what Proton's
        // feeds report since the last pass: one small request for the account, one per calendar.
        let mode: SyncPassSummary['kind'] = feed && kind === 'auto' && this.fullPassDay === today && this.accountCursor ? 'changes' : 'full';
        let account: AccountChanges | null = null;

        let localCalendars: BridgeCalendarRecord[];
        const generation = this.adapterGeneration();
        try {
            this.refreshAccountAddresses();
            const session = this.session;
            await this.removeLeftoverEvents();
            await this.sendWaitingEmails();
            if (mode === 'changes') {
                account = await this.protonAdapter.getAccountChanges(this.accountCursor);
                if (account.refresh) {
                    console.log('[sync] Proton asks for a full read of the account: listing everything again');
                    mode = 'full';
                }
            }
            if (mode === 'full' && feed) {
                // The cursor from before the listing: what happens during it is reported next time.
                account = await this.protonAdapter.getAccountChanges(null);
            }
            if (mode === 'full' || account?.calendars) {
                const reconciled = await this.withCalendarListing(async () => {
                    const remoteCalendars = await this.protonAdapter.listCalendars();
                    if (this.signingOut || this.session !== session) {
                        return null; // signed out meanwhile: nothing may be written to the mirror
                    }
                    return this.reconcileCalendars(remoteCalendars);
                });
                if (!reconciled) {
                    return;
                }
                localCalendars = reconciled;
            } else {
                localCalendars = await this.mirrorDatabase.listCalendars(true);
            }
            if (this.signingOut || this.session !== session) {
                return;
            }
            if (account) {
                this.accountCursor = account.cursor;
                if (account.mail) {
                    this.mailboxDue = true;
                }
            }
            if (mode === 'full') {
                this.mailboxDue = true;
            }
            this.connectionError = null;
            this.noteListingWorked();
        } catch (error) {
            const message = error instanceof Error ? error.message : t('Failed to list Proton calendars');
            this.connectionError = { message, at: Date.now() };
            this.setHealth('error', message);
            this.noteListingError(error, message, generation);
            throw error;
        }

        // Before the calendars, so answers applied now are in this pass's copy for Calendar.app. With
        // the feeds, the mailbox is only looked at when the account feed reported mail (or in a full pass).
        const mailboxDue = this.mailboxDue;
        let mailboxDone = true;
        if (mailboxDue) {
            mailboxDone = await this.applyEmailedAnswers();
        }

        const config = this.configStore.load();
        // In a dry run, refusals are expected: a healthy automatic sync clears the yellow dots again.
        const clearsWarnings = kind === 'refresh' || this.effectiveEmailMode(config) === 'dry-run';
        const withHolidays = includesHolidays(kind, this.holidaysSyncedOn, today);
        for (const calendar of localCalendars) {
            if (calendar.removed || !this.isCalendarSyncEnabled(calendar.protonCalendarId)) {
                continue;
            }
            if (calendar.kind === 'holidays' && !withHolidays) {
                if (kind === 'refresh') {
                    // Refresh leaves public holidays out but counts as having looked at them.
                    this.calendarWarnings.delete(calendar.protonCalendarId);
                }
                continue;
            }
            this.enqueue(calendar.protonCalendarId, { manual: false, clearsWarnings, full: mode === 'full' });
        }
        if (withHolidays) {
            this.holidaysSyncedOn = today;
            this.scheduleMidnightHolidays();
        }
        await this.drainQueue();

        // After the calendars, so meetings changed in this pass are checked right away (and only
        // then, or when mail arrived, with the feeds). Not on a session Proton ended during the
        // queue (its recovery is under way; the mailbox is looked at again once signed in).
        if ((mailboxDue || this.calendarEmailsChangedUids.size) && !this.sessionRecovery && this.protonAdapter.isSignedIn()) {
            if (!(await this.fileCalendarEmails())) {
                mailboxDone = false;
            }
        }
        // A run that stopped early (its budget, an error) is finished in the next pass.
        if (!mailboxDone) {
            this.mailboxDue = true;
        } else if (mailboxDue) {
            this.mailboxDue = false;
        }
        if (mode === 'full' && !this.connectionError) {
            this.fullPassDay = today;
            this.lastFullPassAt = startedAt;
        }
        const requestsAfter = this.adapterRequestStats()?.requests ?? null;
        const decryptedAfter = this.adapterDecryptStats()?.decrypted ?? null;
        this.lastPass = {
            at: startedAt,
            seconds: Math.round((Date.now() - startedAt) / 100) / 10,
            requests: requestsBefore !== null && requestsAfter !== null ? requestsAfter - requestsBefore : 0,
            kind: mode,
            changes: this.passChanges,
            decrypted: decryptedBefore !== null && decryptedAfter !== null ? decryptedAfter - decryptedBefore : 0
        };
        this.passHistory.push(this.lastPass);
        this.passHistory = this.passHistory.filter((pass) => pass.at >= Date.now() - 3600_000);
        if (this.passChanges) {
            this.noteActivity();
        }
        if (mode === 'changes' || this.passChanges) {
            console.log(
                `[sync] ${mode === 'full' ? 'full pass' : 'changes pass'}: ${this.passChanges} change(s), ${this.lastPass.requests} request(s), ${this.lastPass.decrypted} decrypted, ${this.lastPass.seconds} s`
            );
        }
    }

    /** True when the client follows Proton's change feeds (0.26); otherwise every pass lists in full. */
    private usesChangeFeed() {
        const adapter = this.protonAdapter as Partial<ProtonAdapter>;
        return typeof adapter.supportsChangeFeed === 'function' && adapter.supportsChangeFeed();
    }

    /** Something changed (Proton, Calendar.app, a sign-in, waking up): the regular sync stays at your interval for a while. */
    noteActivity() {
        this.lastActivityAt = Date.now();
    }

    /**
     * Listing Proton's calendars failed. Three cases have their own handling: Proton ended the
     * session (sign in again with the saved login), Proton asked to slow down (no pass until its
     * time), Proton no longer accepts the app version (say so). Anything else: connection or refusal.
     */
    private noteListingError(error: unknown, message: string, generation?: number) {
        switch (errorName(error)) {
            case 'SessionExpiredError':
                if (generation === undefined || generation === this.adapterGeneration()) {
                    this.recoverSession(); // not for a pass that ran on a session replaced meanwhile
                }
                return;
            case 'RateLimitedError':
                this.noteSlowDown(error);
                return;
            case 'AppVersionError':
                this.noteAppVersionRejected(message);
                return;
            default:
                this.noteListingFailed(message);
        }
    }

    /** Proton asked to slow down for a while: no sync pass, and no sign-in, before its time. */
    private noteSlowDown(error: unknown) {
        const retryAt = Number((error as { retryAt?: number }).retryAt) || Date.now() + 60_000;
        // 0.40: a refused app version in force keeps its text (and so stays a refusal, not a pause to queue behind).
        const appVersionPause = this.slowDownText !== null && Date.now() < this.slowDownUntil;
        this.slowDownUntil = Math.max(this.slowDownUntil, retryAt);
        if (!appVersionPause) {
            this.slowDownText = null;
        }
        this.syncQueue = []; // every request would be refused until then
        const text = slowDownMessage(this.slowDownUntil);
        this.connectionError = { message: text, at: Date.now() };
        this.setHealth('error', text);
        console.warn(`[sync] ${text}`);
        if (this.slowDownUntil - Date.now() >= OFFLINE_NOTIFY_MS) {
            this.notify({ key: 'slow-down', title: t('Proton asked to slow down'), body: `${text} ${t('Nothing is lost: changes wait until then.')}`, page: 'overview' });
        }
    }

    /** Proton no longer accepts the app version: said (once per run), and asked again only hourly. */
    private noteAppVersionRejected(message: string) {
        this.slowDownUntil = Math.max(this.slowDownUntil, Date.now() + 60 * 60_000);
        this.slowDownText = message;
        this.connectionError = { message, at: Date.now() };
        this.setHealth('error', message);
        if (!this.appVersionNotified) {
            this.appVersionNotified = true;
            this.notify({ key: 'app-version', title: t('Proton no longer accepts this version'), body: message, page: 'overview' });
        }
    }

    /**
     * Proton ended the session (its renewal was refused, e.g. signed out from another device or
     * after a password change): sign in again with the saved login, once. If that fails, the
     * reason is shown (and notified); without a connection it is tried again when Proton answers.
     */
    private recoverSession() {
        if (this.sessionRecovery || this.signingOut || this.pendingHumanVerification) {
            return;
        }
        const session = this.session;
        this.sessionRecovery = (async () => {
            const credentials = await this.secretStore.getProtonCredentials();
            if (this.session !== session || this.signingOut) {
                return;
            }
            if (!credentials) {
                this.setHealth('error', () => t('Proton ended the session. Sign in again.'));
                return;
            }
            // The old session is dead: dropped first, so nothing keeps using it (and a verification
            // Proton may ask for is not answered by another sign-in at every sync).
            await this.protonAdapter.signOut(false);
            if (!credentials.password) {
                // No password kept (the bridge's own sign-in, 0.45; or a session from "Sign In with Proton" before 0.47): you sign in again.
                console.log('[proton] Proton ended the session: sign in again on the Setup page');
                this.setHealth('error', () => t('Proton ended the session. Sign in again on the Setup page.'));
                this.notify({ key: 'session', title: t('Signed out by Proton'), body: t('Open the bridge and sign in again. Syncing waits until then.'), page: 'setup' });
                return;
            }
            console.log('[proton] Proton ended the session: signing in again with the saved login');
            try {
                await this.signIn(credentials, false);
            } catch (error) {
                if (this.protonAdapter.isSignedIn() || this.session !== session || this.signingOut || errorName(error) === SIGNED_OUT_MEANWHILE) {
                    return; // signed in again (also by you meanwhile), or signed out meanwhile
                }
                if (errorName(error) === 'RateLimitedError') {
                    this.noteSlowDown(error);
                    this.retrySignInWhenReachable(credentials, slowDownMessage(this.slowDownUntil));
                } else if (isServerTrouble(error) || (await this.failedForLackOfConnection(error))) {
                    this.retrySignInWhenReachable(credentials);
                } else if (this.pendingHumanVerification) {
                    this.notify({
                        key: 'verification',
                        title: t('Proton asks you to verify it is you'),
                        body: t('Open the bridge to finish signing in. Syncing waits until then.'),
                        page: 'overview'
                    });
                } else {
                    this.notify({ key: 'session', title: t('Signed out by Proton'), body: t('Signing in again failed: {error}', { error: errorText(error) }), page: 'overview' });
                }
            }
        })()
            .catch((error) => console.warn(`[proton] signing in again: ${errorText(error)}`))
            .finally(() => {
                this.sessionRecovery = null;
            });
    }

    /** The adapter's current sign-in (undefined with a fake in tests). */
    private adapterGeneration(): number | undefined {
        const adapter = this.protonAdapter as Partial<ProtonAdapter>;
        return typeof adapter.currentGeneration === 'function' ? adapter.currentGeneration() : undefined;
    }

    /**
     * Events a slow-down left in Proton without guests (a new meeting's first step, see
     * runInvitationSteps): removed before the calendars are read, so they never reach Calendar.app.
     * Another slow-down keeps them for the next pass.
     */
    /**
     * 0.42: an event a slow-down left in Proton without guests is saved with the account's settings (before,
     * it was kept in memory: quitting during the pause left it in Proton for good), and removed at the first
     * sync Proton allows — after a restart too, and only while the same account is signed in.
     */
    private rememberLeftover(leftover: { calendarID: string; eventID: string }) {
        const account = this.protonAdapter.getSignedInUsername() || this.knownUsername || '';
        const kept = this.configStore.load().leftoverEvents.filter((entry) => entry.eventID !== leftover.eventID);
        this.configStore.update({ leftoverEvents: [...kept, { ...leftover, account, at: Date.now() }] });
    }

    private forgetLeftover(eventID: string) {
        this.configStore.update({ leftoverEvents: this.configStore.load().leftoverEvents.filter((entry) => entry.eventID !== eventID) });
    }

    private async removeLeftoverEvents() {
        const account = this.protonAdapter.getSignedInUsername() || this.knownUsername || '';
        const mine = this.configStore.load().leftoverEvents.filter((entry) => !entry.account || !account || entry.account.toLowerCase() === account.toLowerCase());
        for (const leftover of mine) {
            try {
                const result = await this.protonAdapter.deleteEvent(leftover.calendarID, leftover.eventID);
                if (result && result.success === false) {
                    const gone = /not exist|not found|404|2501/i.test(String(result.error ?? ''));
                    if (!gone && isUnreachableFailure(Object.assign(new Error(String(result.error ?? '')), { status: (result as { status?: number }).status }))) {
                        console.warn(`[invitations] the event a slow-down left without guests waits to be removed (${leftover.eventID}): ${result.error}`);
                        return; // 0.42: no answer from Proton — kept for the next pass
                    }
                    console.warn(`[invitations] could not remove the event a slow-down left without guests (${leftover.eventID}): ${result.error}`);
                } else {
                    console.log(`[invitations] removed the event a slow-down left without guests (${leftover.eventID})`);
                }
            } catch (error) {
                if (errorName(error) === 'RateLimitedError' || errorName(error) === 'SessionExpiredError') {
                    throw error; // handled like the listing's own (pause, sign in again); kept for later
                }
                if (isUnreachableFailure(error)) {
                    // 0.42: no network yet (a Mac just woken) or Proton down: kept, tried again next pass.
                    console.warn(`[invitations] the event a slow-down left without guests waits to be removed (${leftover.eventID}): ${errorText(error)}`);
                    return;
                }
                console.warn(`[invitations] could not remove the event a slow-down left without guests (${leftover.eventID}): ${errorText(error)}`);
            }
            this.forgetLeftover(leftover.eventID);
        }
    }

    /** The client's request statistics (null with an older client). */
    private adapterRequestStats() {
        const adapter = this.protonAdapter as Partial<ProtonAdapter>;
        return typeof adapter.getRequestStats === 'function' ? adapter.getRequestStats() : null;
    }

    /** The client's decryption statistics (null with an older client). */
    private adapterDecryptStats() {
        const adapter = this.protonAdapter as Partial<ProtonAdapter>;
        return typeof adapter.getDecryptStats === 'function' ? adapter.getDecryptStats() : null;
    }

    /** Developer settings: requests, answers, pauses, sign-ins, renewals, the passes, the feeds, the cadence. */
    private requestStatsView(calendars: BridgeCalendarRecord[]): RequestStatsView | null {
        const stats = this.adapterRequestStats();
        if (!stats) {
            return null;
        }
        const now = Date.now();
        const recent = this.passHistory.filter((pass) => pass.at >= now - 3600_000);
        const feed = this.usesChangeFeed();
        const intervalMs = this.configStore.load().pollIntervalMs;
        return {
            ...stats,
            lastPass: this.lastPass,
            lastHourPasses: {
                passes: recent.length,
                full: recent.filter((pass) => pass.kind === 'full').length,
                requests: recent.reduce((sum, pass) => sum + pass.requests, 0),
                decrypted: recent.reduce((sum, pass) => sum + pass.decrypted, 0),
                changes: recent.reduce((sum, pass) => sum + pass.changes, 0)
            },
            decrypt: this.adapterDecryptStats(),
            cadence: {
                mode: !feed ? 'fixed' : now - this.lastActivityAt < QUIET_AFTER_MS ? 'active' : 'quiet',
                intervalMs: nextSyncDelayMs({ now, lastActivityAt: this.lastActivityAt, intervalMs, adaptive: feed }),
                nextAt: this.nextSyncAt
            },
            feed: {
                enabled: feed,
                lastFullAt: this.lastFullPassAt,
                calendars: calendars.length,
                following: calendars.filter((calendar) => calendar.feedCursor).length
            }
        };
    }

    /** Puts a calendar at the end of the queue unless it is queued already or syncing right now. */
    private enqueue(calendarId: string, { manual, clearsWarnings, full = true }: { manual: boolean; clearsWarnings: boolean; full?: boolean }) {
        const queued = this.syncQueue.find((job) => job.calendarId === calendarId);
        if (queued) {
            queued.clearsWarnings = queued.clearsWarnings || clearsWarnings;
            queued.full = queued.full || full;
            if (!manual) {
                queued.manual = false; // the regular sync needs it now: no longer taken off by a click
            }
            return;
        }
        // Running already: enough, unless this request should also clear its yellow dot and that run
        // won't, or should list in full and that run only follows the feed.
        if (this.syncingJob?.calendarId === calendarId && (this.syncingJob.clearsWarnings || !clearsWarnings) && (this.syncingJob.full || !full)) {
            return;
        }
        this.syncQueue.push({ calendarId, manual, clearsWarnings, full });
        this.notifyStateChange();
    }

    /**
     * Works through the queue, one calendar at a time; one failing calendar does not stop the
     * others. Resolves once the queue is empty, including calendars queued while it was finishing.
     */
    private async drainQueue() {
        while (this.syncQueue.length || this.queueRunner) {
            if (!this.queueRunner) {
                this.queueRunner = this.runQueue().finally(() => {
                    this.queueRunner = null;
                    this.notifyStateChange();
                });
            }
            await this.queueRunner.catch(() => undefined);
            if (!this.protonAdapter.isSignedIn()) {
                this.syncQueue = [];
            }
        }
    }

    /** Starts the queue from a click without waiting; problems are logged. */
    private drainInBackground() {
        void this.drainQueue().catch((error) => console.error(`[sync] queue: ${error instanceof Error ? error.message : error}`));
    }

    private async runQueue() {
        if (!this.connectionError) {
            this.setHealth('syncing', () => t('Syncing calendars…'));
        }
        let succeeded = 0;
        try {
            while (this.syncQueue.length) {
                if (!this.protonAdapter.isSignedIn()) {
                    this.syncQueue = [];
                    break;
                }
                const job = this.syncQueue.shift()!;
                let calendar: BridgeCalendarRecord | undefined;
                try {
                    calendar = (await this.mirrorDatabase.listCalendars(true)).find((entry) => entry.protonCalendarId === job.calendarId);
                } catch (error) {
                    console.error(`[sync] queue: ${error instanceof Error ? error.message : error}`);
                    continue;
                }
                // Re-checked per calendar so an untick during a running pass takes effect immediately.
                if (!calendar || calendar.removed || !this.isCalendarSyncEnabled(calendar.protonCalendarId)) {
                    continue;
                }
                const startedAt = Date.now();
                const generation = this.adapterGeneration();
                this.syncingCalendarId = calendar.protonCalendarId;
                this.syncingJob = job;
                this.notifyStateChange();
                try {
                    await this.withCalendarLock(calendar.protonCalendarId, () => this.syncEventsForCalendar(calendar!, job.full));
                    succeeded += 1;
                    this.calendarErrors.delete(calendar.protonCalendarId);
                    // Proton answered: the connection works (a pass sets it again if the list fails).
                    this.connectionError = null;
                    const warning = this.calendarWarnings.get(calendar.protonCalendarId);
                    // Only what happened before this run: a refusal during it stays yellow.
                    if (job.clearsWarnings && warning && warning.at < startedAt) {
                        this.calendarWarnings.delete(calendar.protonCalendarId);
                    }
                } catch (error) {
                    const message = error instanceof Error ? error.message : String(error);
                    if (errorName(error) === 'RateLimitedError') {
                        this.noteSlowDown(error); // the rest of the queue waits for Proton's time
                    }
                    if (errorName(error) === 'SessionExpiredError' && generation === this.adapterGeneration()) {
                        // Proton ended the session during this calendar's sync (0.37.3; found live: since 0.26
                        // a quiet pass skips the listing, so this is where the refusal usually surfaces).
                        // Recover now and drop the rest of the queue: one line, not one error per calendar
                        // and a wait for the next pass.
                        console.error(`[sync] "${secret(calendar.displayName)}" failed: ${message}`);
                        this.syncQueue = [];
                        this.recoverSession();
                        break;
                    }
                    if (this.protonAdapter.isSignedIn()) {
                        this.calendarErrors.set(calendar.protonCalendarId, { message, at: Date.now() });
                        if (calendar.kind === 'holidays') {
                            this.holidaysSyncedOn = null; // tried again by the next regular sync
                        }
                    }
                    console.error(`[sync] "${secret(calendar.displayName)}" failed: ${message}`);
                } finally {
                    this.syncingCalendarId = null;
                    this.syncingJob = null;
                    this.notifyStateChange();
                }
            }
        } finally {
            this.ownBusy = null; // the mirror may have changed (0.33.2, availability)
            await this.updateHealthAfterSync(succeeded > 0).catch(() => undefined);
        }
    }

    /** The bridge's status once the queue is empty: an error only if no calendar could be synced. */
    private async updateHealthAfterSync(anySucceeded: boolean) {
        if (!this.protonAdapter.isSignedIn()) {
            return;
        }
        if (this.connectionError) {
            this.setHealth('error', this.connectionError.message);
            return;
        }
        const enabled = (await this.mirrorDatabase.listCalendars()).filter((calendar) => this.isCalendarSyncEnabled(calendar.protonCalendarId));
        const failed = enabled.filter((calendar) => this.calendarErrors.has(calendar.protonCalendarId));
        const failedEvents = this.syncStats.failedEvents;
        const failedNames = failed.map((calendar) => calendar.displayName).join(', ');
        const suffix = () => {
            const notes: string[] = [];
            if (failedEvents > 0) {
                notes.push(tn('{count} event could not be decrypted', '{count} events could not be decrypted', failedEvents));
            }
            if (failedNames) {
                notes.push(t('sync failed for {calendars}', { calendars: failedNames }));
            }
            return notes.length ? ` (${notes.join('; ')})` : '';
        };
        if (enabled.length > 0 && failed.length >= enabled.length) {
            this.setHealth('error', () => `${t('No calendar could be synced')}${suffix()}`);
            return;
        }
        if (anySucceeded) {
            this.lastSuccessfulSyncAt = Date.now();
            if (this.pendingChangeCount()) {
                void this.flushOutbox(); // Proton answers again: what waited while it did not can go now
            }
        }
        this.verifiedThisRun = true; // 0.46: the menu's account line turns from blue to green
        this.setHealth('healthy', () => `${t('Bridge connected')}${suffix()}`);
    }

    /** Runs `task` after any running sync or refresh of the same calendar. */
    private withCalendarLock<T>(calendarId: string, task: () => Promise<T>): Promise<T> {
        const previous = this.calendarLocks.get(calendarId) ?? Promise.resolve();
        const run = previous.catch(() => undefined).then(task);
        const settled = run.then(
            () => undefined,
            () => undefined
        );
        this.calendarLocks.set(calendarId, settled);
        void settled.then(() => {
            if (this.calendarLocks.get(calendarId) === settled) {
                this.calendarLocks.delete(calendarId);
            }
        });
        return run;
    }

    /** Public holidays are synced again at the next local midnight while the bridge runs. */
    private scheduleMidnightHolidays() {
        if (this.midnightTimer) {
            clearTimeout(this.midnightTimer);
        }
        this.midnightTimer = setTimeout(() => {
            this.midnightTimer = null;
            void this.syncHolidays().catch((error) => console.warn(`[sync] public holidays at midnight: ${error instanceof Error ? error.message : error}`));
        }, msUntilLocalMidnight(new Date()));
        this.midnightTimer.unref?.();
    }

    private async syncHolidays() {
        if (!this.protonAdapter.isSignedIn()) {
            return;
        }
        const today = localDayOf(new Date());
        if (this.holidaysSyncedOn === today) {
            this.scheduleMidnightHolidays();
            return;
        }
        const clearsWarnings = this.effectiveEmailMode(this.configStore.load()) === 'dry-run';
        for (const calendar of await this.mirrorDatabase.listCalendars()) {
            if (calendar.kind === 'holidays' && this.isCalendarSyncEnabled(calendar.protonCalendarId)) {
                this.enqueue(calendar.protonCalendarId, { manual: false, clearsWarnings });
            }
        }
        this.holidaysSyncedOn = today;
        this.scheduleMidnightHolidays();
        await this.drainQueue();
    }

    /** Tells the window and the menu (at most every 150 ms) that something they show changed. */
    private notifyStateChange() {
        if (this.stateChangeTimer || !this.onStateChange) {
            return;
        }
        this.stateChangeTimer = setTimeout(() => {
            this.stateChangeTimer = null;
            try {
                this.onStateChange?.();
            } catch (error) {
                console.warn(`[app] state listener failed: ${error instanceof Error ? error.message : error}`);
            }
        }, 150);
        this.stateChangeTimer.unref?.();
    }

    private async reconcileCalendars(
        remoteCalendars: Array<{
            id: string;
            name: string;
            color: string;
            description?: string;
            visible?: boolean;
            writable?: boolean;
            readOnlyReason?: string;
            type?: number;
            owned?: boolean;
            permissions?: number;
        }>,
        /** 0.34: the collection path a calendar created from Calendar.app asked for (free, checked by the caller). */
        preferredSlugs?: Map<string, string>
    ) {
        const existingCalendars = await this.mirrorDatabase.listCalendars(true);
        const existingById = new Map(existingCalendars.map((calendar) => [calendar.protonCalendarId, calendar]));
        const usedSlugs = new Set(existingCalendars.map((calendar) => calendar.slug));

        const activeRemoteIds: string[] = [];
        const nextCalendars: BridgeCalendarRecord[] = [];

        for (let remoteCalendar of remoteCalendars) {
            activeRemoteIds.push(remoteCalendar.id);
            const existingCalendar = existingById.get(remoteCalendar.id);
            const preferred = preferredSlugs?.get(remoteCalendar.id);
            const slug = existingCalendar?.slug || (preferred && !usedSlugs.has(preferred) ? preferred : this.allocateSlug(remoteCalendar.name, usedSlugs));
            usedSlugs.add(slug);
            // Older clients do not report writability: treat as writable, as before.
            const readOnly = remoteCalendar.writable === false;
            const readOnlyReason = readOnly ? remoteCalendar.readOnlyReason || 'read-only calendar' : null;
            if (existingCalendar && this.isPending(remoteCalendar.id, CALENDAR_APPEARANCE_UID)) {
                // 0.42: a name/colour change from Calendar.app waits for Proton: the calendar keeps it meanwhile.
                remoteCalendar = { ...remoteCalendar, name: existingCalendar.displayName, color: existingCalendar.color, description: existingCalendar.description };
            }
            const changed =
                !existingCalendar ||
                existingCalendar.displayName !== remoteCalendar.name ||
                existingCalendar.color !== remoteCalendar.color ||
                existingCalendar.description !== (remoteCalendar.description || '') ||
                existingCalendar.visible !== (remoteCalendar.visible !== false) ||
                existingCalendar.readOnly !== readOnly ||
                existingCalendar.removed;

            const nextCalendar: BridgeCalendarRecord = {
                protonCalendarId: remoteCalendar.id,
                slug,
                displayName: remoteCalendar.name,
                color: remoteCalendar.color,
                description: remoteCalendar.description || '',
                visible: remoteCalendar.visible !== false,
                removed: false,
                ctag: changed ? `${Date.now()}` : existingCalendar?.ctag || `${Date.now()}`,
                lastPolledAt: existingCalendar?.lastPolledAt || null,
                lastSyncedAt: existingCalendar?.lastSyncedAt || null,
                readOnly,
                readOnlyReason,
                kind: calendarKindOf(remoteCalendar)
            };

            if (existingCalendar) {
                // Details only: a sync of this calendar may be writing its ctag right now.
                await this.mirrorDatabase.updateCalendarMetadata(nextCalendar, changed);
            } else {
                await this.mirrorDatabase.upsertCalendar(nextCalendar);
            }
            nextCalendars.push(nextCalendar);
        }

        await this.mirrorDatabase.markMissingCalendarsRemoved(activeRemoteIds);
        // Calendars gone from Proton: their dots (and the menu's) no longer count.
        this.activeCalendarIds = new Set(activeRemoteIds);
        for (const id of [...this.calendarErrors.keys(), ...this.calendarWarnings.keys()]) {
            if (!this.activeCalendarIds.has(id)) {
                this.calendarErrors.delete(id);
                this.calendarWarnings.delete(id);
            }
        }
        return this.mirrorDatabase.listCalendars(true);
    }

    /**
     * Brings one calendar's mirror up to date. `full`: list the window and compare (as every pass did
     * before 0.26). Otherwise ask the calendar's feed what changed since its cursor and re-read only
     * those series; a calendar without a cursor, or one Proton asks to re-read, is listed in full.
     */
    private async syncEventsForCalendar(calendar: BridgeCalendarRecord, full = true) {
        const feed = this.usesChangeFeed();
        let cursor: string | null = null;
        if (feed && !full && calendar.feedCursor) {
            const changes = await this.protonAdapter.getCalendarChanges(calendar.protonCalendarId, calendar.feedCursor);
            if (!changes.refresh) {
                await this.applyCalendarChanges(calendar, changes);
                await this.mirrorDatabase.setCalendarFeed(calendar.protonCalendarId, { cursor: changes.cursor });
                return;
            }
            console.log(`[sync] "${secret(calendar.displayName)}": Proton asks for a full read: listing it again`);
            cursor = changes.cursor;
        } else if (feed) {
            // The cursor from before the listing: what happens during it is reported next time.
            cursor = (await this.protonAdapter.getCalendarChanges(calendar.protonCalendarId, null)).cursor;
        }
        await this.listCalendarInFull(calendar);
        if (cursor) {
            await this.mirrorDatabase.setCalendarFeed(calendar.protonCalendarId, { cursor, fullSyncedAt: Date.now() });
        }
    }

    /**
     * 0.40: a COUNT-limited series whose last occurrence ended before the sync window is left out —
     * by the full pass and the change feed alike (Proton's listing counts a COUNT as open-ended).
     * Its master stays while one of its changed occurrences is in the window; a series whose end
     * cannot be worked out (an older client, a rule the iterator cannot walk) is kept as before.
     */
    private async withoutEndedCountSeries<T extends { uid: string; startTimestamp: number; endTimestamp: number; raw?: any; decrypted?: any }>(
        events: T[],
        windowStart: number,
        windowEnd: number
    ): Promise<T[]> {
        if (typeof this.protonAdapter.seriesLastEndOf !== 'function') {
            return events;
        }
        const ended = new Set<T>();
        for (const event of events) {
            if (event.raw?.RecurrenceID || !/(?:^|;)COUNT=\d+/i.test(String(event.raw?.RRule ?? ''))) {
                continue;
            }
            const lastEnd = await this.protonAdapter.seriesLastEndOf(event.decrypted?.vevent);
            if (touchesWindow(event.startTimestamp, event.endTimestamp, event.raw.RRule, windowStart, windowEnd, lastEnd)) {
                continue;
            }
            const exceptionInWindow = events.some(
                (other) => other !== event && other.uid === event.uid && other.raw?.RecurrenceID && touchesWindow(other.startTimestamp, other.endTimestamp, null, windowStart, windowEnd)
            );
            if (!exceptionInWindow) {
                ended.add(event);
            }
        }
        return ended.size ? events.filter((event) => !ended.has(event)) : events;
    }

    /**
     * Only what the calendar's feed reported: each created or changed event's series (by UID) and
     * each deleted event's series is read again from Proton and its mirror row rebuilt (or marked
     * deleted when nothing is left). Events outside the sync window are left out as in a full pass.
     */
    private async applyCalendarChanges(calendar: BridgeCalendarRecord, changes: CalendarChanges) {
        const [startDate, endDate] = this.getSyncWindow();
        const windowStart = Math.floor(startDate.getTime() / 1000);
        const windowEnd = Math.floor(endDate.getTime() / 1000);
        const uids = new Set<string>();
        for (const stub of changes.changed) {
            const inWindow = touchesWindow(stub.startTime, stub.endTime, stub.rrule, windowStart, windowEnd);
            // Outside the window and unknown here: nothing to do (moved out of it: its row goes).
            if (inWindow || (await this.mirrorDatabase.findEventByProtonId(calendar.protonCalendarId, stub.id))) {
                uids.add(stub.uid);
            }
        }
        /** 0.44.1: UIDs whose events the feed reported deleted (the others it reported created or changed). */
        const deletedUids = new Set<string>();
        for (const protonEventId of changes.deleted) {
            const row = await this.mirrorDatabase.findEventByProtonId(calendar.protonCalendarId, protonEventId);
            if (row && !row.deleted) {
                uids.add(this.protonUidOf(row));
                deletedUids.add(this.protonUidOf(row));
            }
        }
        let changed = false;
        for (const uid of uids) {
            const events = (await this.protonAdapter.listEventsByUid(calendar.protonCalendarId, uid)) ?? [];
            this.syncStats.totalEvents += events.length;
            this.syncStats.syncedEvents += events.length;
            // The same window as a full pass: a single event outside it is not served, nor a series'
            // changed occurrences outside it (a recurring series' master always is).
            const inWindow = (await this.withoutEndedCountSeries(events, windowStart, windowEnd)).filter((event) =>
                touchesWindow(event.startTimestamp, event.endTimestamp, event.raw?.RecurrenceID ? null : event.raw?.RRule ?? null, windowStart, windowEnd)
            );
            const series = groupIntoSeries(inWindow)[0];
            const existing = (series && (await this.mirrorDatabase.findEventByProtonId(calendar.protonCalendarId, series.key))) || (await this.findRowForProtonUid(calendar, uid));
            if (!series && !events.length && !deletedUids.has(uid)) {
                // 0.44.1: the feed says this event was created or changed, but the lookup by UID found
                // nothing (it can miss a just-saved event): not a deletion — the next pass reads it again.
                if (existing && !existing.deleted) {
                    console.log(`[sync] "${existing.title ? secret(existing.title) : '…'}": Proton reported a change, but listed no event by its UID; kept as it is`);
                }
                continue;
            }
            if (!series) {
                if (existing && !existing.deleted && !this.isPending(calendar.protonCalendarId, existing.uid)) {
                    await this.mirrorDatabase.markEventDeleted(existing.protonEventId);
                    this.noteMeetingGone(existing);
                    this.passChanges += 1;
                    changed = true;
                }
                continue;
            }
            if (await this.applySeriesRow(calendar, series, existing ?? undefined)) {
                changed = true;
            }
        }
        await this.mirrorDatabase.recordCalendarPoll(calendar.protonCalendarId, changed);
    }

    /** The mirror row of a Proton UID: by UID, or (a meeting created in Calendar.app, which keeps its own UID) by the Proton event it is known by. */
    private async findRowForProtonUid(calendar: BridgeCalendarRecord, protonUid: string) {
        const byUid = await this.mirrorDatabase.getEventByUid(calendar.protonCalendarId, protonUid);
        if (byUid) {
            return byUid;
        }
        for (const [protonEventId, uid] of this.protonUidByEventId) {
            if (uid === protonUid) {
                const row = await this.mirrorDatabase.findEventByProtonId(calendar.protonCalendarId, protonEventId);
                if (row) {
                    return row;
                }
            }
        }
        return null;
    }

    /** Lists the calendar's whole sync window and brings every mirror row in line with it. */
    private async listCalendarInFull(calendar: BridgeCalendarRecord) {
        const [startDate, endDate] = this.getSyncWindow();
        const remoteEvents = await this.withoutEndedCountSeries(
            await this.protonAdapter.listEvents(calendar.protonCalendarId, startDate, endDate),
            Math.floor(startDate.getTime() / 1000),
            Math.floor(endDate.getTime() / 1000)
        );
        this.syncStats.totalEvents += remoteEvents.length;
        this.syncStats.syncedEvents += remoteEvents.length;
        const existingEvents = await this.mirrorDatabase.listEventsForCalendar(calendar.protonCalendarId, true);
        const existingById = new Map(existingEvents.map((event) => [event.protonEventId, event]));
        const existingByUid = new Map(existingEvents.map((event) => [event.uid, event]));
        const previousCalendarSyncAt = calendar.lastSyncedAt || 0;
        let changed = false;

        // All Proton events sharing a UID (a recurring series and its modified occurrences)
        // become ONE CalDAV resource; one mirror row per UID.
        const seriesList = groupIntoSeries(remoteEvents);
        const activeKeys = new Set<string>();

        for (const series of seriesList) {
            activeKeys.add(series.key);
            if (series.droppedDuplicates.length) {
                console.warn(
                    `[sync] "${secret(calendar.displayName)}": ${series.droppedDuplicates.length} duplicate event(s) with UID ${series.uid} skipped`
                );
            }
            // Match by Proton event ID first: events created in Calendar.app get a NEW UID in Proton,
            // so their mirror row keeps the UID and address Calendar.app knows them by.
            const existingRecord = existingById.get(series.key) ?? existingByUid.get(series.uid);
            if (await this.applySeriesRow(calendar, series, existingRecord)) {
                changed = true;
            }
        }
        // Deleted in Proton (or past the sync window); not when only its key changed (same UID still here).
        const activeUids = new Set(seriesList.map((series) => series.uid));
        for (const event of existingEvents) {
            if (!event.deleted && !activeKeys.has(event.protonEventId)) {
                const uid = this.protonUidOf(event);
                if (activeUids.has(uid) || activeUids.has(event.uid)) {
                    this.calendarEmailsChangedUids.add(uid);
                } else {
                    // When it was last seen: it may have been deleted while the app was not running.
                    this.noteMeetingGone(event, previousCalendarSyncAt || Date.now());
                }
            }
        }

        // 0.35: rows with a change waiting for Proton are not "missing in Proton".
        for (const uid of this.pendingUids.get(calendar.protonCalendarId) ?? []) {
            const row = existingByUid.get(uid);
            if (row) {
                activeKeys.add(row.protonEventId);
            }
        }
        const deletedCount = await this.mirrorDatabase.markMissingEventsDeleted(
            calendar.protonCalendarId,
            [...activeKeys]
        );
        if (deletedCount > 0) {
            changed = true;
            this.passChanges += deletedCount;
        }
        if (existingEvents.some((event) => event.deleted && event.lastSyncedAt > previousCalendarSyncAt)) {
            changed = true;
        }

        // Only the columns this sync owns: a pass may update the calendar's details meanwhile.
        await this.mirrorDatabase.recordCalendarPoll(calendar.protonCalendarId, changed);
    }

    /**
     * One Proton series (or single event) into its mirror row; true when the row was created or
     * changed. `existing`: the row it is known by (keyed by its Proton event, or with its UID).
     */
    private async applySeriesRow(calendar: BridgeCalendarRecord, series: EventSeries, existing: BridgeEventRecord | undefined) {
        this.protonUidByEventId.set(series.key, series.uid);
        // 0.35: a change from Calendar.app waits for Proton for this event: its row stays as Calendar.app saved it.
        if (
            (this.isPending(calendar.protonCalendarId, series.uid) && !this.replayingUids.has(`${calendar.protonCalendarId}\u0000${series.uid}`)) ||
            (this.isPending(calendar.protonCalendarId, existing?.uid) && !this.replayingUids.has(`${calendar.protonCalendarId}\u0000${existing?.uid}`))
        ) {
            return false;
        }
        let existingRecord = existing;
        // A row keyed by this Proton event keeps the UID Calendar.app knows it by.
        const uid = existingRecord?.protonEventId === series.key ? existingRecord.uid : series.uid;
        const href = existingRecord?.href || buildEventHref(this.getCalDAVConfig().username, calendar.slug, uid);
        const nextRecord = this.buildMirrorRecord(series, calendar.protonCalendarId, href, uid);

        // The row for this UID may be keyed by a different Proton event (older mirror format,
        // or the series master changed). Replace it so the (calendar, uid) index stays unique.
        if (existingRecord && existingRecord.protonEventId !== nextRecord.protonEventId) {
            await this.mirrorDatabase.removeEventByUid(calendar.protonCalendarId, existingRecord.uid);
            existingRecord = undefined;
        }

        const recordChanged =
            !existingRecord ||
            existingRecord.deleted ||
            existingRecord.contentHash !== nextRecord.contentHash ||
            existingRecord.serializedIcs !== nextRecord.serializedIcs ||
            existingRecord.href !== nextRecord.href;

        if (recordChanged) {
            if (existingRecord && !existingRecord.deleted && existingRecord.etag && existingRecord.etag !== nextRecord.etag) {
                this.rememberReplacedVersion(calendar.protonCalendarId, existingRecord);
            }
            await this.mirrorDatabase.upsertEvent(nextRecord);
            this.calendarEmailsChangedUids.add(series.uid);
            this.passChanges += 1;
        }
        return recordChanged;
    }

    /** The mirror row for one Proton series (or single event), as served to Calendar.app. */
    private buildMirrorRecord(series: EventSeries, protonCalendarId: string, href: string, uid: string): BridgeEventRecord {
        if (isRecurringSeries(series) || seriesHasParticipants(series)) {
            return buildSeriesRecord(series, protonCalendarId, href, uid);
        }
        const remoteEvent = (series.master ?? series.exceptions[0]).event;
        const dateOf = (property?: { value: { year: number; month: number; day: number } }) =>
            property?.value ? { year: property.value.year, month: property.value.month, day: property.value.day } : undefined;
        const vevent = remoteEvent.decrypted?.vevent;
        const allDayStart = remoteEvent.isAllDay ? dateOf(vevent?.dtstart) : undefined;
        return buildEventRecordShape({
            allDay: allDayStart ? { start: allDayStart, end: dateOf(vevent?.dtend) } : undefined,
            protonEventId: series.key,
            protonCalendarId,
            uid,
            href,
            title: remoteEvent.title,
            description: remoteEvent.description,
            location: remoteEvent.location,
            startTimestamp: remoteEvent.startTimestamp,
            endTimestamp: remoteEvent.endTimestamp,
            timezone: remoteEvent.timezone,
            isAllDay: remoteEvent.isAllDay,
            modifiedTimestamp: remoteEvent.modifiedTimestamp,
            alarms: remoteEvent.decrypted?.reminders?.alarms,
            conference: remoteEvent.decrypted?.conference
        });
    }

    private getSyncWindow() {
        const config = this.configStore.load();
        const now = new Date();
        const startDate = new Date(now);
        startDate.setUTCDate(startDate.getUTCDate() - config.eventLookbackDays);
        const endDate = new Date(now);
        endDate.setUTCDate(endDate.getUTCDate() + config.eventLookaheadDays);
        return [startDate, endDate] as const;
    }

    private allocateSlug(name: string, usedSlugs: Set<string>) {
        const baseSlug = slugify(name);
        let candidate = baseSlug;
        let counter = 2;
        while (usedSlugs.has(candidate)) {
            candidate = `${baseSlug}-${counter}`;
            counter += 1;
        }
        return candidate;
    }

    private async requireCalendar(slug: string) {
        const calendar = await this.mirrorDatabase.getCalendarBySlug(slug);
        if (!calendar) {
            throw new Error(`Unknown calendar collection: ${slug}`);
        }
        if (!this.isCalendarSyncEnabled(calendar.protonCalendarId)) {
            throw new Error(t('This calendar is not synced (unticked on the Calendars page).'));
        }
        return calendar;
    }

    /**
     * Writes to subscribed, holidays, view-only and disabled calendars are refused with 403
     * (Calendar.app then puts its copy back) instead of failing in Proton with a 500, which
     * Calendar.app would retry forever.
     */
    private async requireWritableCalendar(slug: string) {
        const calendar = await this.requireCalendar(slug);
        if (calendar.readOnly) {
            throw new ReadOnlyEventError(
                `This calendar is a ${calendar.readOnlyReason || 'read-only calendar'} in Proton, so its events cannot be changed here.`
            );
        }
        return calendar;
    }

    private async bumpCalendar(calendar: BridgeCalendarRecord) {
        this.noteActivity(); // a change from Calendar.app: Proton's answer (and others' changes) are wanted soon
        await this.mirrorDatabase.bumpCalendarCtag(calendar.protonCalendarId);
    }

    /** The regular sync (restarted when its interval changes; other timers are left alone). */
    private startPolling() {
        this.polling = true;
        this.scheduleNextSync();
    }

    /**
     * The next automatic pass, one interval after the last pass ended (0.26: your interval while
     * things change, every five minutes when quiet; see nextSyncDelayMs).
     */
    private scheduleNextSync() {
        if (!this.polling) {
            return;
        }
        if (this.syncTimer) {
            clearTimeout(this.syncTimer);
        }
        const delay = nextSyncDelayMs({
            now: Date.now(),
            lastActivityAt: this.lastActivityAt,
            intervalMs: this.configStore.load().pollIntervalMs,
            adaptive: this.usesChangeFeed()
        });
        this.nextSyncAt = Date.now() + delay;
        this.syncTimer = setTimeout(() => {
            this.syncTimer = null;
            void this.syncNow('auto').catch((error) => {
                this.setHealth('error', error instanceof Error ? error.message : () => t('Sync failed'));
            });
        }, delay);
    }

    private stopPolling() {
        this.polling = false;
        this.nextSyncAt = null;
        if (this.syncTimer) {
            clearTimeout(this.syncTimer);
            this.syncTimer = null;
        }
        if (this.midnightTimer) {
            clearTimeout(this.midnightTimer);
            this.midnightTimer = null;
        }
        if (this.resumeTimer) {
            clearTimeout(this.resumeTimer);
            this.resumeTimer = null;
        }
        this.stopConnectivityWatch();
        this.cancelPendingSignIn();
    }

    /** A text, or a function building it, so a later language change re-translates it. */
    private setHealth(health: BridgeHealth, message: string | (() => string)) {
        const source = typeof message === 'function' ? message : () => message;
        const changed = this.health !== health || this.message !== source();
        this.health = health;
        this.messageSource = source;
        if (changed) {
            this.notifyStateChange();
        }
    }
}
