export type BridgeHealth = 'disconnected' | 'connecting' | 'syncing' | 'healthy' | 'error';

export interface ProtonCredentials {
    username: string;
    password: string;
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

export interface HumanVerificationSubmission {
    token: string;
    tokenType: string;
}

export interface LocalCalDAVCredentials {
    host: string;
    port: number;
    username: string;
    password: string;
    security: 'HTTP';
    baseUrl: string;
    serverPath: string;
}

export type ThemePreference = 'system' | 'light' | 'dark';

/**
 * How invitation emails (answers to organizers) are handled:
 * test = only to addresses on the allowlist (anything else is refused, nothing changes in Proton);
 * dry-run = nothing is sent or changed, the would-be email is logged; live = like Proton Calendar.
 */
export type InvitationEmailMode = 'test' | 'dry-run' | 'live';

/** One invitation email the bridge sent, blocked or simulated (kept in memory, newest first). */
export interface InvitationEmailLogEntry {
    at: number;
    method: string;
    /**
     * answer (REPLY), invitation / update (REQUEST), cancellation (CANCEL) sent from Calendar.app;
     * received: a guest outside Proton answered one of your meetings by email (applied, dry run, skipped).
     */
    kind: 'answer' | 'invitation' | 'update' | 'cancellation' | 'received';
    /** REPLY only (sent or received). */
    answer?: string;
    from: string;
    to: Array<{ email: string; name: string; delivery?: 'proton' | 'pgp' | 'plain' }>;
    subject: string;
    eventTitle: string;
    outcome: 'sent' | 'blocked' | 'dry-run' | 'failed' | 'applied' | 'skipped' | 'note';
    detail?: string;
}

/** What happens to emails about meetings in the Inbox once they are dealt with. */
export type CalendarEmailsAfter = 'leave' | 'trash' | 'archive' | 'folder';

/** The last run of moving emails about meetings, for the Settings page. */
export interface CalendarEmailsStatus {
    /** When the last run finished (ms). */
    at: number;
    /** Emails moved since the app started. */
    moved: number;
    /** Dry run: emails in the Inbox that would be moved. */
    wouldMove: number;
    /** In the Inbox now: waiting for your answer or for Proton. */
    waiting: number;
    /** In the Inbox now: left for you (the reasons are in bridge.log). */
    left: number;
    /** Where they go: "Bin", "Archive" or the folder's name. */
    destination: string;
    /** The last run's problem (no connection, folder refused), if any. */
    problem?: string;
}

/** Where reading guests' emailed answers got to, for one account (Unix seconds of the last email handled). */
export interface EmailedAnswersCursor {
    account: string;
    cursor: number;
}

/** Detailed logging: off (default), on for 24 hours, or on until switched off. */
export type DetailedLogging = 'off' | '24h' | 'on';

export interface BridgeConfig {
    openAtLogin: boolean;
    pollIntervalMs: number;
    eventLookbackDays: number;
    eventLookaheadDays: number;
    caldavPort: number;
    caldavUsername: string;
    /** Proton calendar IDs the user has unticked: not pulled from Proton and not served over CalDAV. */
    excludedCalendarIds: string[];
    /** 0.37.7: calendars whose events do not count towards availability (Calendar.app's "Events affect availability" off). */
    transparentCalendarIds: string[];
    theme: ThemePreference;
    /** The app's language (0.32): 'system' (macOS's, when it is one of ours) or a code (en, de, nl, fr, es, it). */
    appLanguage: string;
    invitationEmailMode: InvitationEmailMode;
    /** Test mode: the only addresses invitation emails may go to. */
    invitationEmailAllowlist: string[];
    /** The language of invitation emails (0.31): 'proton' = Proton Calendar's setting, or a code like de_DE. */
    invitationEmailLanguage: string;
    /** Developer settings: the options below only count while this is on (default off). */
    developerMode: boolean;
    /** Developer option: also apply answers that guests outside Proton email to your meetings (stage 4; default off). */
    applyEmailedAnswers: boolean;
    /** Live mode's progress through the mailbox; a dry run keeps its own in memory. */
    emailedAnswersCursor: EmailedAnswersCursor | null;
    /** 0.41: Message-IDs of invitation emails this account sent (newest last, bounded): replies to them in Spam are read. */
    sentInvitationIds: Array<{ id: string; at: number }>;
    /** 0.42: events a slow-down left in Proton without guests (a new meeting's first step), removed once Proton allows it. */
    leftoverEvents: Array<{ calendarID: string; eventID: string; account: string; at: number }>;
    /** Emails about meetings, once dealt with: left in the Inbox (default), or moved to the Bin, the Archive or a folder. */
    calendarEmailsAfter: CalendarEmailsAfter;
    /** The folder for calendarEmailsAfter 'folder' (top level, created if missing; default "Calendar"). */
    calendarEmailsFolder: string;
    /** 0.37: the address that owns calendars created from Calendar.app ('' = the account's first active address). */
    newCalendarAddress: string;
    /** macOS notifications for refused Calendar.app changes, lost connection and mailbox problems (default on). */
    notifications: boolean;
    /** Notifications name the event and calendar, and show addresses (default on); off: only what happened. */
    notificationTitles: boolean;
    /** Developer option: bridge.log with titles, addresses, subjects and email text (default off; see private-log.ts). */
    detailedLogging: DetailedLogging;
    /** detailedLogging '24h': switched off at this time. */
    detailedLoggingUntil: number | null;
    /** The app (executable) the login item was last registered for; registered again when it changes. */
    loginItemAppPath: string | null;
    /** When Calendar.app last signed in to the bridge (kept across restarts for the Setup page). */
    calendarAppLastSeenAt: number | null;
    /** 0.49.1: when Thunderbird last signed in (told apart by its User-Agent). */
    thunderbirdLastSeenAt: number | null;
    /** 0.49.1: the last sign-in of another CalDAV app, with the name from its User-Agent. */
    otherClientLastSeen: { at: number; name: string | null } | null;
}

/** Calendar.app's connection to the bridge, for the Setup page (0.30). */
export interface CalendarAppStatus {
    /** The last request that signed in with the right password; null: never. */
    lastRequestAt: number | null;
    /** Whether that happened since the app started (false: known from before). */
    thisRun: boolean;
}

/** 0.49.1: which app signed in to the bridge, from its User-Agent (Thunderbird first: its string names Mac OS X too). */
export type CalDAVClientKind = 'calendar-app' | 'thunderbird' | 'other';
export interface CalDAVClient {
    kind: CalDAVClientKind;
    /** For 'other': the product named in the User-Agent (BusyCal, Fantastical, …), if any. */
    name: string | null;
}

/** 0.49.1: another CalDAV app's connection, for the Setup page's "Other Calendar Apps" card. */
export interface OtherClientStatus extends CalendarAppStatus {
    name: string | null;
}

/** What "Set up Calendar.app" did (0.30). */
export interface CalendarAppSetupResult {
    /** macOS took the profile (System Settings shows it); false: it could not be opened. */
    opened: boolean;
    error: string | null;
}

/** Groups on the Calendars page: your own, shared with you, subscribed, public holidays. */
export type CalendarKind = 'own' | 'shared' | 'subscribed' | 'holidays';

export interface BridgeCalendarRecord {
    protonCalendarId: string;
    slug: string;
    displayName: string;
    color: string;
    description: string;
    visible: boolean;
    removed: boolean;
    ctag: string;
    lastPolledAt: number | null;
    lastSyncedAt: number | null;
    /** Events cannot be changed in Proton (subscribed, holidays, view-only shared, disabled). */
    readOnly: boolean;
    /** Why, e.g. "subscribed calendar". */
    readOnlyReason: string | null;
    /** Which group it belongs to (from Proton's calendar type and your membership); 'own' if unknown. */
    kind?: CalendarKind;
    /** Proton's change feed: the cursor to ask from next time; null until the calendar was listed in full once. */
    feedCursor?: string | null;
    /** When the calendar was last listed in full (ms); null if never. */
    fullSyncedAt?: number | null;
}

/**
 * What a calendar's dot shows. error (red): its last sync failed, or the bridge is not connected;
 * clears once a sync works again. warning (yellow): Calendar.app asked for something the bridge
 * refused or could not do; stays until the calendar is synced by hand (in dry-run mode: until the
 * next healthy automatic sync). off: not synced (unticked or removed in Proton).
 */
export type CalendarStatus = 'ok' | 'warning' | 'error' | 'off';

export type CalendarSyncState = 'idle' | 'queued' | 'syncing';

/** A mirrored calendar plus the bridge's per-calendar sync state, as shown in the UI. */
export interface BridgeCalendarView extends BridgeCalendarRecord {
    kind: CalendarKind;
    syncEnabled: boolean;
    lastError: string | null;
    status: CalendarStatus;
    /** Why the dot is red or yellow (the message from the log). */
    statusMessage: string | null;
    /** When that happened (ms). */
    statusAt: number | null;
    syncState: CalendarSyncState;
    /** Queued by a click in the window (can be taken off the queue again). */
    queuedManually: boolean;
}

export interface BridgeEventRecord {
    protonEventId: string;
    protonCalendarId: string;
    uid: string;
    href: string;
    etag: string;
    contentHash: string;
    serializedIcs: string;
    title: string;
    description: string;
    location: string;
    startTimestamp: number;
    endTimestamp: number;
    timezone: string;
    isAllDay: boolean;
    modifiedTimestamp: number;
    deleted: boolean;
    lastSyncedAt: number;
    /**
     * Every Proton event that makes up this resource, keyed by its RECURRENCE-ID
     * ('' for the master). A plain event has one entry: { '': protonEventId }.
     */
    protonEventIds: Record<string, string>;
}

export interface SyncStatus {
    health: BridgeHealth;
    message: string;
    lastSuccessfulSyncAt: number | null;
    lastAttemptedSyncAt: number | null;
    perCalendar: Array<{
        protonCalendarId: string;
        displayName: string;
        lastPolledAt: number | null;
        lastSyncedAt: number | null;
        removed: boolean;
        syncEnabled: boolean;
        lastError: string | null;
    }>;
}

export interface SyncStats {
    totalEvents: number;
    syncedEvents: number;
    failedEvents: number;
    lastDirection: 'pull' | 'push' | null;
}

/** A Calendar.app request the bridge could not serve (kept in memory, newest first). */
export interface CalDAVRequestError {
    at: number;
    method: string;
    path: string;
    status: number;
    message: string;
    /** The change was saved, only not for everyone (0.32: decided by the error, not by its wording). */
    partial?: boolean;
    /** 0.49.3: which app sent the request (Calendar.app, Thunderbird, another's name), when known. */
    app?: string;
}

/** A Proton session kept (encrypted, like the password) to resume at the next start without signing in again. */
export interface SavedProtonSession {
    username: string;
    UID: string;
    AccessToken: string;
    RefreshToken: string;
    /** The password the keys are unlocked with (0.27): resuming needs no password, code or salts. */
    keyPassword?: string;
    passwordMode?: number;
    /** 'own' — the session was opened under the app's own identity (0.50: the only one resumed; an older one without it is not). */
    identity?: 'own';
}

/**
 * Something Proton asks for during a sign-in (0.27): an authenticator code (or a security key), or
 * the mailbox password of a two-password account. Shown on the Setup page until answered.
 */
export interface SignInPrompt {
    kind: 'second-factor' | 'mailbox-password';
    /** second-factor: an authenticator code is accepted / a security key is registered. */
    totp: boolean;
    securityKey: boolean;
    /** The answer given before was refused. */
    wrong: boolean;
    /** The sign-in runs in the background (app start, Proton ended the session), not from the form. */
    background: boolean;
    /** When the sign-in gives up waiting (ms). */
    expiresAt: number;
}

export type SignInPromptAnswer = { code: string } | { mailboxPassword: string };

/** Developer settings: how the bridge talks to Proton. */
export interface RequestStatsView {
    since: number;
    requests: number;
    lastHour: number;
    answers: Record<string, number>;
    retries: number;
    rateLimited: number;
    lastRateLimit: { at: number; seconds: number; path: string } | null;
    pausedUntil: number | null;
    signIns: number;
    sessionRenewals: number;
    resumedSession: boolean;
    /** The last complete sync pass: when, how long, how many requests, what kind, what it changed. */
    lastPass: SyncPassSummary | null;
    /** The sync passes of the last hour, added up. */
    lastHourPasses: { passes: number; full: number; requests: number; decrypted: number; changes: number };
    /** Events decrypted since the app started, and how often a decrypted event could be reused (null with an older client). */
    decrypt: { decrypted: number; reused: number; cached: number } | null;
    /** How often the bridge asks Proton: your interval while things change, slower when quiet; fixed with an older client. */
    cadence: { mode: 'active' | 'quiet' | 'fixed'; intervalMs: number; nextAt: number | null };
    /** Proton's change feeds: in use, when everything was last listed in full, how many calendars follow their feed. */
    feed: { enabled: boolean; lastFullAt: number | null; calendars: number; following: number };
}

export interface SyncPassSummary {
    at: number;
    seconds: number;
    requests: number;
    /** 'full': every calendar listed and compared; 'changes': only what Proton's feeds reported. */
    kind: 'full' | 'changes';
    /** Mirror rows created, changed or deleted by the pass. */
    changes: number;
    /** Events decrypted during the pass (0 when nothing changed). */
    decrypted: number;
}

export interface CalDAVLoginTrouble {
    /** The first wrong login since the last right one (or the start). */
    since: number;
    lastAt: number;
    attempts: number;
    /** The saved login (with the password Calendar.app was given) cannot be read: the bridge runs with a temporary one. */
    savedPasswordUnreadable: boolean;
    /** 0.49.3: the app that sent the wrong password (Calendar.app, Thunderbird, another's name), when known. */
    app?: string;
}

export interface BridgeState {
    /** 0.36: which account this is (null for the one-account service of the tests). */
    accountId: string | null;
    /** 0.36: the account's primary address (or user name) as the window and the menu show it; null until known. */
    accountLabel: string | null;
    health: BridgeHealth;
    signedIn: boolean;
    username: string | null;
    calendars: BridgeCalendarView[];
    caldav: Omit<LocalCalDAVCredentials, 'password'>;
    calendarApp: CalendarAppStatus;
    /** 0.49.1: Thunderbird's and other apps' sign-ins, for their Setup cards. */
    thunderbird: CalendarAppStatus;
    otherClient: OtherClientStatus;
    /** 0.39: the name of this account's account in Calendar.app ("Proton", or "Proton (address)" with several). */
    calendarAppAccountName: string;
    openAtLogin: boolean;
    /** macOS disagrees with "Open on startup" (switched off in System Settings, not registered). */
    openAtLoginNote: string | null;
    /** Developer settings on: how the bridge talks to Proton; otherwise null. */
    requestStats: RequestStatsView | null;
    pollIntervalMs: number;
    eventLookbackDays: number;
    eventLookaheadDays: number;
    theme: ThemePreference;
    /** 0.32: the chosen language ('system' or a code), the one in use, the languages on offer. */
    appLanguage: string;
    language: string;
    appLanguages: Array<{ code: string; name: string }>;
    lastSuccessfulSyncAt: number | null;
    /** 0.46: a sync pass went through since this run's sign-in (until then the account shows blue). */
    verifiedThisRun?: boolean;
    lastAttemptedSyncAt: number | null;
    message: string;
    pendingHumanVerification: HumanVerificationChallenge | null;
    /** 0.35: changes from Calendar.app made while Proton could not be reached, waiting to be sent. */
    pendingChanges: number;
    /** 0.41: emails to guests that wait for Proton's slow-down to end (the change itself is saved). */
    waitingEmails: number;
    /** Proton asks for a code or the mailbox password to finish a sign-in (0.27). */
    signInPrompt: SignInPrompt | null;
    syncStats: SyncStats;
    recentCalDAVErrors: CalDAVRequestError[];
    /** Why the local copy of the calendars is only in memory this run; null when it is on disk (encrypted). */
    localCopyNote: string | null;
    /** Calendar.app sends a wrong password for the bridge (an old one?) since `since`; null while it signs in fine. */
    caldavLogin: CalDAVLoginTrouble | null;
    /** package.json version of the running app (0.x = patch number). */
    appVersion: string;
    /** The mode in force: test and dry run only while developer options are on, else live (0.32.3). */
    invitationEmailMode: InvitationEmailMode;
    /** The mode as set under Developer Options (what the select shows). */
    invitationEmailModeSetting: InvitationEmailMode;
    invitationEmailAllowlist: string[];
    /** 0.31: the chosen language ('proton' or a code), the languages on offer (empty: the client has none), and what 'proton' means right now. */
    invitationEmailLanguage: string;
    invitationEmailLanguages: Array<{ code: string; name: string }>;
    protonInviteLanguage: string | null;
    /** False with a proton-calendar-client that cannot answer invitations yet. */
    invitationsSupported: boolean;
    developerMode: boolean;
    applyEmailedAnswers: boolean;
    /** The linked client can apply guests' emailed answers (stage 4). */
    emailedAnswersSupported: boolean;
    recentInvitationEmails: InvitationEmailLogEntry[];
    calendarEmailsAfter: CalendarEmailsAfter;
    calendarEmailsFolder: string;
    /** 0.37: the account's addresses (active first) and the one new calendars from Calendar.app belong to ('' = the first active). */
    addresses: string[];
    newCalendarAddress: string;
    /** The linked client can move emails about meetings that are dealt with. */
    calendarEmailsSupported: boolean;
    calendarEmailsStatus: CalendarEmailsStatus | null;
    notifications: boolean;
    notificationTitles: boolean;
    detailedLogging: DetailedLogging;
    detailedLoggingUntil: number | null;
}

export type BridgeConfigPatch = Partial<
    Pick<
        BridgeConfig,
        | 'pollIntervalMs'
        | 'eventLookbackDays'
        | 'eventLookaheadDays'
        | 'theme'
        | 'appLanguage'
        | 'invitationEmailMode'
        | 'invitationEmailAllowlist'
        | 'invitationEmailLanguage'
        | 'applyEmailedAnswers'
        | 'developerMode'
        | 'calendarEmailsAfter'
        | 'calendarEmailsFolder'
        | 'newCalendarAddress'
        | 'notifications'
        | 'notificationTitles'
        | 'detailedLogging'
    >
>;

/**
 * 0.36: what the window shows — the accounts in their order, and the account being signed in (the
 * sign-in page: the first account, or one being added while others exist).
 */
export interface BridgeAppState {
    accounts: BridgeState[];
    signingIn: BridgeState | null;
    /** True while "Add Account" is open although accounts exist (the sign-in page offers a way back). */
    addingAccount: boolean;
}

/** 0.36: an account's sign-in flow is addressed by its ID (an account being added: null). */
export type AccountRef = string | null;

export interface RendererBridgeApi {
    /** The sign-in calls address the account being added (or restored: `accountId` for a background prompt). */
    signIn(credentials: ProtonCredentials, accountId?: AccountRef): Promise<BridgeAppState>;
    completeHumanVerification(submission?: HumanVerificationSubmission): Promise<BridgeAppState>;
    cancelHumanVerification(): Promise<BridgeAppState>;
    answerSignInPrompt(accountId: AccountRef, answer: SignInPromptAnswer): Promise<BridgeAppState>;
    cancelSignInPrompt(accountId: AccountRef): Promise<BridgeAppState>;
    /** 0.36: opens the sign-in page for another account; cancelling returns to the accounts. */
    addAccount(): Promise<BridgeAppState>;
    cancelAddAccount(): Promise<BridgeAppState>;
    /** Signs the account out (its session, local copy and saved login go; it stays listed, signed out). */
    signOut(accountId: string): Promise<BridgeAppState>;
    /** 0.36: signs the account out and removes it with its folder (settings, CalDAV password, profile identity). */
    removeAccount(accountId: string): Promise<BridgeAppState>;
    /** 0.36: the accounts' order (every ID, in the new order). */
    setAccountOrder(accountIds: string[]): Promise<BridgeAppState>;
    getBridgeState(): Promise<BridgeAppState>;
    getCalendars(accountId: string): Promise<BridgeCalendarRecord[]>;
    getCalDAVConfig(accountId: string): Promise<LocalCalDAVCredentials>;
    /** Every account (null) or one. */
    refreshNow(accountId: string | null): Promise<SyncStatus>;
    /** Writes the Calendar.app configuration profile and hands it to System Settings (0.30). */
    setUpCalendarApp(accountId: string): Promise<CalendarAppSetupResult>;
    /** Opens System Settings at the profiles (Device Management) pane. */
    openProfilesSettings(): Promise<void>;
    /** 0.32: the window's texts in the language in use (English: an empty catalog). */
    /** The language, its catalog, and the Mac's locale (app.getLocale(), for dates and times). */
    getTranslations(): Promise<{ language: string; catalog: Record<string, string>; locale: string }>;
    setOpenAtLogin(enabled: boolean): Promise<BridgeAppState>;
    setCalendarSyncEnabled(accountId: string, protonCalendarId: string, enabled: boolean): Promise<BridgeAppState>;
    getSyncStatus(accountId: string): Promise<SyncStatus>;
    openHumanVerification(): Promise<void>;
    openExternal(url: string): Promise<void>;
    /** App-wide settings go to every account; an account's own (ticked calendars, emails) to `accountId`. */
    updateConfig(patch: BridgeConfigPatch, accountId?: string | null): Promise<BridgeAppState>;
    /** Syncs one calendar now (queued behind a running sync); again while it waits takes it off the queue. */
    syncCalendar(accountId: string, protonCalendarId: string): Promise<BridgeAppState>;
    /** Syncs every calendar of a group (not public holidays: those are synced one by one). */
    syncCategory(accountId: string, kind: CalendarKind): Promise<BridgeAppState>;
    /** The menu-bar menu asks for a page (overview / calendars / setup / settings / info), 0.36: for an account. */
    onNavigate(callback: (page: string, accountId?: string | null) => void): void;
    /** Something the window shows changed (a calendar started or finished syncing, a dot changed). */
    onStateChanged(callback: () => void): void;
    /** The bundled CHANGELOG.md (Markdown), for the Info page. */
    getChangelog(): Promise<string>;
    /** Developer settings: bridge.log and bridge.log.1 deleted, a new bridge.log started. */
    deleteLogs(): Promise<void>;
    /** The CalDAV password to the clipboard (removed again after 90 s if still there). */
    copyCalDAVPassword(accountId: string): Promise<void>;
}
