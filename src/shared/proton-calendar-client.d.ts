declare module 'proton-calendar-client' {
    export interface HumanVerificationChallenge {
        token: string;
        methods: string[];
        tokenType?: string;
        title?: string;
        description?: string;
        webUrl?: string;
        expiresAt?: number;
    }

    export interface Credentials {
        username: string;
        password: string;
        /** A session saved earlier: resumed instead of a password sign-in while Proton accepts it (stage 2 client). */
        session?: SavedSession | null;
        humanVerification?: HumanVerificationChallenge | null;
        /** The identity presented to Proton (0.45; without it the library presents its own). */
        appIdentity?: { appVersion: string; userAgent: string };
        /** The current session after signing in and after each renewal (refresh tokens are single-use). */
        onSession?: (session: SavedSession) => void;
        /** Two-factor authentication: asked for the second factor; null gives up (0.27 client). */
        askSecondFactor?: (request: SecondFactorRequest) => Promise<SecondFactorAnswer | null>;
        twoFactorCode?: string;
        /** Two-password mode: asked for the mailbox password; null gives up (0.27 client). */
        askMailboxPassword?: (request: { wrong: boolean }) => Promise<string | null>;
        mailboxPassword?: string;
    }

    export interface SavedSession {
        UID: string;
        AccessToken: string;
        RefreshToken: string;
        /** The password the keys are unlocked with (0.27 client). */
        keyPassword?: string;
        passwordMode?: number;
    }

    /** What Proton asks for after the password (0.27 client). */
    export interface SecondFactorRequest {
        totp: boolean;
        securityKey: boolean;
        securityKeyOptions: unknown | null;
        wrong: boolean;
    }

    export type SecondFactorAnswer = { code: string } | { securityKey: unknown };

    /** How the client talked to Proton so far (stage 2 client). */
    export interface RequestStats {
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
        permissions?: number;
        /** Your own calendar, not one shared with you (patched client). */
        owned?: boolean;
        /** Whether events can be changed (patched client); absent with older clients. */
        writable?: boolean;
        readOnlyReason?: string;
    }

    export interface EventData {
        title: string;
        description: string;
        location: string;
        startTime: number;
        endTime: number;
        timezone: string;
        isAllDay: boolean;
        /** 0.33: the event's alarms as VALARM ICS blocks; undefined = the calendar's defaults (as before). */
        alarms?: string[];
        /** 0.34.1: set → stored; null → removed; undefined → an existing event keeps its conference. */
        conference?: VideoConference | null;
    }

    /** 0.33.1: an address in the account's contacts. */
    export interface ContactAddress {
        email: string;
        name: string;
        contactId: string;
    }

    /** 0.34.1: an event's video conference (Zoom 1, Proton Meet 2). */
    export type VideoConferenceProvider = 1 | 2;
    export interface VideoConference {
        provider: VideoConferenceProvider;
        id: string;
        url: string;
        password?: string;
        host?: string;
    }

    /** 0.34: what Calendar.app may change about a calendar. */
    export interface CalendarAppearance {
        name?: string;
        /** #RGB, #RRGGBB or #RRGGBBAA; stored as the nearest of Proton's accent colours. */
        color?: string;
        description?: string;
    }

    /** 0.33.2: another Proton user's busy times, when Proton shares them with the account. */
    export interface BusySchedule {
        accessible: boolean;
        slots: Array<{ start: number; end: number; allDay: boolean }>;
    }

    /** 0.33.2: a busy period in unix milliseconds. */
    export interface BusyPeriod {
        start: number;
        end: number;
        allDay: boolean;
        /** 0.40: tentatively busy (FBTYPE=BUSY-TENTATIVE). */
        tentative?: boolean;
    }

    /** 0.33: an event's reminders as the client read them. */
    export interface EventReminders {
        /** The event follows the calendar's default reminders (the alarms are those defaults). */
        hasDefaults: boolean;
        /** VALARM blocks ("BEGIN:VALARM … END:VALARM", CRLF) for the served ICS. */
        alarms: string[];
    }

    /** Proton's VcalDateProperty / VcalDateTimeProperty shape. */
    export interface ProtonVcalDateProperty {
        value: {
            year: number;
            month: number;
            day: number;
            hours?: number;
            minutes?: number;
            seconds?: number;
            isUTC?: boolean;
        };
        parameters?: { tzid?: string; type?: string };
    }

    /** ORGANIZER / ATTENDEE as Proton stores them; value is a "mailto:" URI. */
    export interface ProtonParticipantProperty {
        value: string;
        parameters?: {
            cn?: string;
            role?: string;
            partstat?: string;
            rsvp?: string;
            [key: string]: unknown;
        };
    }

    /** Decrypted date/recurrence/participant properties (present with the patched client). */
    export interface DecryptedVeventTimeProperties {
        dtstart?: ProtonVcalDateProperty;
        dtend?: ProtonVcalDateProperty;
        rrule?: { value: Record<string, unknown> };
        exdate?: ProtonVcalDateProperty[];
        'recurrence-id'?: ProtonVcalDateProperty;
        status?: { value: string };
        sequence?: { value: number };
        organizer?: ProtonParticipantProperty;
        /** Guests, each with PARTSTAT merged in from Proton's cleartext answer list. */
        attendee?: ProtonParticipantProperty[];
    }

    /** Your role in an event with organizer/guests, as Proton's own apps determine it. */
    export interface EventParticipation {
        isOrganizer: boolean;
        isAttendee: boolean;
        selfEmail?: string;
        selfAttendeeIndex?: number;
    }

    /** One of the account's own addresses. */
    export interface AccountAddress {
        email: string;
        displayName: string;
        active: boolean;
        order: number;
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
        /** Proton API event (cleartext metadata incl. RRule / RecurrenceID / Exdates). */
        raw?: {
            ID?: string;
            StartTimezone?: string;
            EndTimezone?: string;
            RRule?: string | null;
            RecurrenceID?: number | null;
            Exdates?: number[];
            [key: string]: unknown;
        };
        decrypted?: {
            status?: string;
            sequence?: number;
            vevent?: DecryptedVeventTimeProperties;
            participation?: EventParticipation;
            /** 0.33 */
            reminders?: EventReminders;
            /** 0.34.1: the event's video conference, if any. */
            conference?: VideoConference;
            [key: string]: unknown;
        };
    }

    export type InvitationAnswer = 'ACCEPTED' | 'TENTATIVE' | 'DECLINED';
    export type InvitationEmailMode = 'test' | 'dry-run' | 'live';

    export interface InvitationEmailPolicy {
        mode: InvitationEmailMode;
        allowlist: string[];
        /** 0.31: 'proton' (Proton Calendar's "Invitation language") or one of INVITATION_LANGUAGES' codes. */
        language?: string;
    }

    /** 0.31: a language the invitation emails can be written in (Proton's own translations). */
    export interface InvitationLanguage {
        code: string;
        name: string;
        dateFns: string | null;
        translated: number;
        of: number;
    }
    export const INVITATION_LANGUAGES: InvitationLanguage[];
    /** 0.33: the VALARM blocks in an ICS text. */
    export function alarmBlocksOf(ics: string): string[];
    /** 0.34.2: the description without Proton's conference block. */
    export function descriptionWithoutConference(description: string): string;
    /** 0.34.1: the description with Proton's conference block (an older block replaced; none → removed). */
    export function descriptionWithConference(description: string, conference: VideoConference | undefined): string;
    /** 0.34.1: the provider "Proton Meet" or "Zoom" typed as a location asks for; null for a place. */
    export function videoProviderOfLocation(location: string | undefined): VideoConferenceProvider | null;
    /** 0.33.2: the busy periods (unix ms) of the events in an ICS text within a window; series expanded. */
    export function busyPeriodsOf(ics: string, windowStart: number, windowEnd: number, ownEmails?: string[]): BusyPeriod[];
    /** 0.33.2: overlapping periods merged and clipped to the window. */
    export function mergeBusyPeriods(periods: BusyPeriod[], windowStart: number, windowEnd: number): BusyPeriod[];
    /** 0.40: the end of a COUNT-limited series' last occurrence (unix ms, within a day); null without COUNT. */
    export function seriesLastEndOf(vevent: unknown): number | null;
    /** 0.33: a VEVENT's alarms as Proton can store them (relative triggers, deduplicated, capped). */
    export function normalizeAlarms(vevent: ProtonVevent, timeZone?: string): Array<{ action: { value: string }; trigger: { value: unknown } }>;
    export function matchInvitationLanguage(code: string | null | undefined): InvitationLanguage | null;

    /** An invitation email sent, blocked by the policy, simulated (dry run) or failed. */
    export interface InvitationEmailRecord {
        at: string;
        /** REPLY: your answer; REQUEST / CANCEL: meetings you organize (stage 3+). */
        method: 'REPLY' | 'REQUEST' | 'CANCEL';
        /** Missing with a stage 2 client (then it is an answer). */
        kind?: 'answer' | 'invitation' | 'update' | 'cancellation';
        /** REPLY only. */
        answer?: InvitationAnswer;
        from: string;
        to: Array<{ email: string; name: string; delivery?: 'proton' | 'pgp' | 'plain' }>;
        subject: string;
        eventTitle: string;
        eventUid: string;
        recurrenceId?: string;
        outcome: 'sent' | 'blocked' | 'dry-run' | 'failed';
        /** Sent emails: the email's Message-ID (Proton's ExternalID). */
        externalId?: string;
        /** 0.41: a failed email that waits for Proton's slow-down to end and is sent then. */
        deferred?: boolean;
        /** 0.41: with `deferred`, when Proton accepts requests again (Unix ms). */
        retryAt?: number;
        detail?: string;
        preview?: { body: string; ics: string };
    }

    export interface InvitationOutcome {
        success: boolean;
        error?: string;
        /**
         * blocked: test-mode allowlist; dry-run: simulated only; unsupported: not possible;
         * incomplete: organizer / guests emailed but Proton did not take the change; stale: the
         * meeting changed in Proton since the copy it was based on (nothing sent); failed: error;
         * rate-limited: Proton asked to slow down before anything was sent (try again at retryAt).
         */
        reason?: 'blocked' | 'dry-run' | 'unsupported' | 'incomplete' | 'stale' | 'failed' | 'rate-limited' | 'cancelled';
        /** rate-limited: when Proton accepts requests again (Unix ms). */
        retryAt?: number;
        /** rate-limited: an event left in Proton without guests, to remove once Proton's time is up. */
        leftover?: { calendarID: string; eventID: string };
        emails: InvitationEmailRecord[];
        changedEventIds: string[];
        deletedEventIds: string[];
        /** Problems after Proton was already changed; the action itself stands. */
        warnings: string[];
        /** Meetings you organize (stage 3+): the Proton event and its Proton UID (new events get a Proton UID). */
        eventId?: string;
        protonUid?: string;
        /** Saved with withoutRefusedGuests: new guests left out (test mode, or Proton cannot email them). */
        droppedGuests?: Array<{ email: string; reason: string }>;
    }

    export interface SaveOrganizedEventInput {
        calendarID: string;
        /** Omit to create a new event. */
        eventID?: string;
        /** The event as Calendar.app sent it (parseIcsToVevents). */
        vevent: ProtonVevent;
        /** The version Calendar.app's copy was based on (as served); a meeting changed since is refused ('stale'). */
        basedOn?: ProtonVevent;
        /** Leave out new guests who cannot be invited and save without them (patched client, 0.18). */
        withoutRefusedGuests?: boolean;
    }

    /** A recurring meeting you organize, as Calendar.app sent it (stage 3b). */
    export interface SaveOrganizedSeriesInput {
        calendarID: string;
        /** The Proton event of the series' main event (or of a single event); omit to create. */
        eventID?: string;
        /** Every VEVENT of Calendar.app's version: the main event and its changed occurrences. */
        vevents: ProtonVevent[];
        /** The version Calendar.app's copy was based on (as served); a series changed since is refused ('stale'). */
        basedOn?: ProtonVevent[];
        /** Leave out new guests who cannot be invited and save without them (patched client, 0.18). */
        withoutRefusedGuests?: boolean;
    }

    export interface CancelOrganizedEventInput {
        calendarID: string;
        eventID: string;
        notifyAttendees: boolean;
    }

    export interface AnswerInvitationInput {
        calendarID: string;
        eventID: string;
        answer: InvitationAnswer;
        alignSingleEditIDs?: string[];
    }

    export type EmailedAnswerValue = 'ACCEPTED' | 'TENTATIVE' | 'DECLINED' | 'NEEDS-ACTION';

    /** One answer email from a guest outside Proton (stage 4): applied, only reported, or skipped. */
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
        /** 0.41: the guest's note with the answer, if any. */
        comment?: string;
    }

    export interface ApplyEmailedAnswersInput {
        /** Emails that arrived at or after this time (Unix seconds) are looked at. */
        since: number;
        /** At most this many list requests of 100 emails per run (default 5). */
        maxPages?: number;
        /** At most this many emails opened per run (default 25). */
        maxOpened?: number;
        /** Stop opening emails after this long (default 20 s). */
        budgetMs?: number;
        /** 0.41: Message-IDs of invitation emails this account sent: replies to them in Spam are used. */
        repliesTo?: string[];
        /** 0.41: also look again at emails from this time up to `since` (replies moved out of Spam). */
        lookBackFrom?: number;
    }

    /** An opened email with a calendar file that held nothing to apply, and why (bridge.log only). */
    export interface IgnoredEmail {
        messageId: string;
        from: string;
        subject: string;
        why: string;
    }

    export interface ApplyEmailedAnswersResult {
        answers: EmailedAnswer[];
        /** Opened emails without an answer to apply or report (patched client 0.18+). */
        ignored?: IgnoredEmail[];
        /** Arrival time (Unix seconds) up to which every email was handled: pass it as `since` next time. */
        cursor: number;
        /** Emails with a calendar attachment opened in this run. */
        opened: number;
        /** The run stopped at a limit with more to read; the next run continues. */
        more?: boolean;
        /** Set when the run stopped early (network, Proton). */
        error?: string;
    }

    export type CalendarEmailDestination = 'trash' | 'archive' | 'folder';
    export type CalendarEmailKind = 'invitation' | 'update' | 'cancellation' | 'answer';

    export interface FileCalendarEmailsInput {
        moveTo: CalendarEmailDestination;
        /** Top-level folder for moveTo 'folder', created if missing (default "Calendar"). */
        folderName?: string;
        /** UIDs of meetings that changed since the last run: their emails are checked now. */
        changedUids?: string[];
        /**
         * Meetings deleted from your calendars (Proton UID, Unix seconds): answers and cancellations
         * about them are dealt with, and invitations and updates that arrived before the deletion.
         */
        goneMeetings?: Array<{ uid: string; at: number }>;
        lookbackDays?: number;
        maxPages?: number;
        maxOpened?: number;
        maxChecks?: number;
        budgetMs?: number;
    }

    export interface FiledEmail {
        messageId: string;
        receivedAt: string;
        from: string;
        to: string;
        subject: string;
        kind: CalendarEmailKind;
        eventTitle?: string;
        why: string;
        /** "Trash", "Archive" or the folder's name. */
        destination: string;
        outcome: 'moved' | 'dry-run' | 'failed';
        error?: string;
    }

    export interface LeftEmail {
        messageId: string;
        from: string;
        subject: string;
        kind?: CalendarEmailKind;
        eventTitle?: string;
        why: string;
        /** 0.41.10: a guest's note with an answer. */
        note?: string;
    }

    export interface FileCalendarEmailsResult {
        filed: FiledEmail[];
        left: LeftEmail[];
        waiting: number;
        leftCount: number;
        wouldMove: number;
        opened: number;
        checked: number;
        more?: boolean;
        folderCreated?: string;
        folderError?: string;
        error?: string;
    }

    export interface RemoveInvitationInput {
        calendarID: string;
        eventID: string;
        notifyOrganizer: boolean;
    }

    /** What a calendar's change feed says about a created or changed event (metadata only). */
    export interface ChangedEventStub {
        id: string;
        uid: string;
        calendarId: string;
        startTime: number;
        endTime: number;
        rrule: string | null;
        recurrenceId: number | null;
        modifyTime: number;
    }

    /** What changed in a calendar since a cursor (Proton's change feed, 0.26 client). */
    export interface CalendarChanges {
        calendarId: string;
        cursor: string;
        started: boolean;
        refresh: boolean;
        changed: ChangedEventStub[];
        deleted: string[];
        keysChanged: boolean;
        requests: number;
    }

    /** What changed in the account since a cursor (0.26 client). */
    export interface AccountChanges {
        cursor: string;
        started: boolean;
        refresh: boolean;
        calendars: boolean;
        addresses: boolean;
        mail: boolean;
        settings: boolean;
        requests: number;
    }

    export interface DecryptStats {
        decrypted: number;
        reused: number;
        cached: number;
    }

    export class ProtonCalendarAPI {
        constructor(credentials: Credentials);
        initialize(): Promise<void>;
        /** Requests, answers, pauses, sign-ins, renewals (stage 2 client). */
        getRequestStats?(): RequestStats;
        /** Ends the session at Proton (stage 2 client). */
        signOut?(): Promise<void>;
        listCalendars(): Promise<CalendarInfo[]>;
        listEvents(calendarId: string, startDate: Date, endDate: Date): Promise<SyncedCalendarEvent[]>;
        /** Every Proton event with this UID, shaped like listEvents (stage 2+). */
        listEventsByUid(calendarId: string, uid: string): Promise<SyncedCalendarEvent[]>;
        /** Proton's change feed of a calendar since `cursor` (null: only the cursor to start from) (0.26 client). */
        getCalendarChanges(calendarId: string, cursor: string | null): Promise<CalendarChanges>;
        /** Proton's account feed since `cursor` (0.26 client). */
        getAccountChanges(cursor: string | null): Promise<AccountChanges>;
        /** Events decrypted and reused so far (0.26 client). */
        getDecryptStats?(): DecryptStats;
        createEventInCalendar(
            calendarId: string,
            eventData: EventData
        ): Promise<{ id: string; success: boolean; error?: string }>;
        updateEventInCalendar(
            calendarId: string,
            eventId: string,
            eventData: EventData
        ): Promise<{ success: boolean; error?: string }>;
        deleteEventInCalendar(calendarId: string, eventId: string): Promise<{ success: boolean; error?: string }>;
        /** Parses an iCalendar string into Proton-shaped VEVENTs (no network). */
        parseIcsToVevents(ics: string): ProtonVevent[];
        /** 0.33.1: the account's contact addresses with names (clear text in Proton; no vCard decrypted). */
        listContactEmails(): Promise<ContactAddress[]>;
        /** 0.34.2: renames a Proton Meet room of this account to follow its event; false for any other link. */
        renameProtonMeet(url: string, title: string): Promise<boolean>;
        /** 0.34.2: removes a Proton Meet room of this account; false for any other link. */
        deleteProtonMeet(url: string): Promise<boolean>;
        /** 0.34.1: a new meeting room (Proton Meet, or Zoom when connected in Proton) hosted by the calendar's address. */
        createVideoConference(provider: VideoConferenceProvider, options?: { title?: string; calendarId?: string }): Promise<VideoConference>;
        /** 0.34: renames/recolours a calendar through your member entry (works for shared, subscribed and holiday calendars too). */
        updateCalendarAppearance(calendarId: string, changes: CalendarAppearance): Promise<void>;
        /** 0.34: creates a personal calendar with its key, like Proton Calendar does. */
        createCalendar(appearance: CalendarAppearance & { address?: string }): Promise<{ id: string }>;
        /** 0.33.2: another user's busy times from Proton's busy-schedule endpoint (unix seconds; accessible only inside an organization). */
        getBusySchedule(email: string, start: number, end: number, timeZone: string): Promise<BusySchedule>;
        /** 0.33: sets one event's reminders through Proton's personal-part endpoint (no emails, no SEQUENCE change). */
        setEventReminders(calendarId: string, eventId: string, alarms: string[]): Promise<{ success: boolean; changed: boolean; error?: string }>;
        /** Creates/updates/deletes all events of one series in a single Proton request. */
        syncSeries(input: SyncSeriesInput): Promise<SyncSeriesResult>;
        /** The account's own addresses, active first (client with invitation support, stage 1+). */
        listAddresses(): AccountAddress[];
        /** Email policy for invitation answers (stage 2+); defaults to test mode with no addresses. */
        /** 0.31: Proton Calendar's "Invitation language", else the account's language; null when unknown. */
        getProtonInviteLocale(): Promise<string | null>;
        /** 0.31: the last known value without a request; null before the first read. */
        protonInviteLocaleCached(): string | null;
        configureInvitations(options: {
            policy?: InvitationEmailPolicy;
            prodId?: string;
            onEmail?: (record: InvitationEmailRecord) => void;
        }): void;
        getInvitationEmailPolicy(): InvitationEmailPolicy;
        /** Yes / maybe / no to an invitation: Proton answer + REPLY email to the organizer (stage 2+). */
        answerInvitation(input: AnswerInvitationInput): Promise<InvitationOutcome>;
        /** Removes an invitation, telling the organizer you decline if you had said yes/maybe (stage 2+). */
        removeInvitation(input: RemoveInvitationInput): Promise<InvitationOutcome>;
        /** Creates or changes a single meeting you organize; guests are emailed (stage 3+). */
        saveOrganizedEvent(input: SaveOrganizedEventInput): Promise<InvitationOutcome>;
        /**
         * Creates or changes a recurring meeting you organize: the change is read from Calendar.app's
         * version of the series and carried out like Proton Calendar's "all occurrences" / "this
         * occurrence" (stage 3b). A single event is saved like saveOrganizedEvent.
         */
        saveOrganizedSeries?(input: SaveOrganizedSeriesInput): Promise<InvitationOutcome>;
        /**
         * Deletes a meeting you organize; guests get a cancellation unless told not to (stage 3+).
         * With saveOrganizedSeries (stage 3b) also a whole series: a cancellation for the series and
         * each changed occurrence.
         */
        cancelOrganizedEvent(input: CancelOrganizedEventInput): Promise<InvitationOutcome>;
        /**
         * Applies the answers guests outside Proton emailed to meetings you organize, like Proton
         * Mail does when the reply is opened there (stage 4). Reads the mailbox only; sends nothing.
         */
        applyEmailedAnswers?(input: ApplyEmailedAnswersInput): Promise<ApplyEmailedAnswersResult>;
        /** 0.41: emails to guests waiting for a slow-down to end; sent by sendDeferredEmails once it is over. */
        deferredEmailCount?(): number;
        sendDeferredEmails?(): Promise<{ sent: number; waiting: number; givenUp: number }>;
        /**
         * Moves emails about meetings that are dealt with out of the Inbox (to the Bin, the Archive or
         * a folder). Nothing else changes; a dry run only reports (patch 20).
         */
        fileCalendarEmails?(input: FileCalendarEmailsInput): Promise<FileCalendarEmailsResult>;
    }

    /** Proton's VcalVeventComponent; only the properties the bridge reads are typed. */
    export interface ProtonVevent {
        component: 'vevent';
        uid: { value: string };
        dtstart?: ProtonVcalDateProperty;
        dtend?: ProtonVcalDateProperty;
        rrule?: { value: Record<string, unknown> };
        exdate?: ProtonVcalDateProperty[];
        'recurrence-id'?: ProtonVcalDateProperty;
        summary?: { value: string };
        description?: { value: string };
        location?: { value: string };
        status?: { value: string };
        organizer?: ProtonParticipantProperty;
        attendee?: ProtonParticipantProperty[];
        [key: string]: unknown;
    }

    export interface SeriesComponentInput {
        protonEventId?: string;
        vevent: ProtonVevent;
    }

    export interface SyncSeriesInput {
        calendarId: string;
        components: SeriesComponentInput[];
        deleteEventIds?: string[];
    }

    export interface SyncSeriesResult {
        success: boolean;
        error?: string;
        eventIds: string[];
    }

    export class HumanVerificationRequiredError extends Error {
        challenge: HumanVerificationChallenge;
        constructor(challenge: HumanVerificationChallenge);
    }

    export function createProtonCalendarAPI(credentials: Credentials): Promise<ProtonCalendarAPI>;
}
