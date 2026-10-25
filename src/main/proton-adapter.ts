import { release } from 'node:os';
import { resolve } from 'node:path';

import type {
    AccountAddress,
    AccountChanges,
    AnswerInvitationInput,
    SecondFactorAnswer,
    SecondFactorRequest,
    CalendarChanges,
    DecryptStats,
    ApplyEmailedAnswersInput,
    ApplyEmailedAnswersResult,
    FileCalendarEmailsInput,
    FileCalendarEmailsResult,
    CalendarInfo,
    CancelOrganizedEventInput,
    Credentials,
    EventData,
    InvitationEmailPolicy,
    InvitationEmailRecord,
    InvitationOutcome,
    ProtonCalendarAPI,
    RequestStats,
    SavedSession,
    ProtonVevent,
    RemoveInvitationInput,
    SaveOrganizedEventInput,
    SaveOrganizedSeriesInput,
    SyncedCalendarEvent,
    SyncSeriesInput,
    SyncSeriesResult
} from 'proton-calendar-client';

export interface InvitationOptions {
    policy: InvitationEmailPolicy;
    prodId: string;
    onEmail: (record: InvitationEmailRecord) => void;
}

import { HumanVerificationChallenge, ProtonCredentials, SavedProtonSession } from '../shared/types';

export class ProtonHumanVerificationRequiredError extends Error {
    challenge: HumanVerificationChallenge;

    constructor(challenge: HumanVerificationChallenge) {
        super(challenge.title || 'Human verification required');
        this.name = 'ProtonHumanVerificationRequiredError';
        this.challenge = challenge;
    }
}

/** A sign-in overtaken by a sign-out (or a newer sign-in) while it ran: it does not count. */
export const SIGNED_OUT_MEANWHILE = 'SignedOutMeanwhile';
const signedOutMeanwhile = () => Object.assign(new Error('Signed out meanwhile.'), { name: SIGNED_OUT_MEANWHILE });

/** Ends a client's session at Proton: best effort, and never holding anything up for long (offline). */
const endSession = async (api: ProtonCalendarAPI) => {
    const client = api as ProtonCalendarAPI & { signOut?: () => Promise<void> };
    if (typeof client.signOut === 'function') {
        await Promise.race([client.signOut().catch(() => undefined), new Promise((resolve) => setTimeout(resolve, 5000))]);
    }
};

/**
 * The app's own identity towards Proton (0.45 by default, 0.50 the only one). Proton has no product name
 * for a third-party calendar client (`external-calendar-…` is refused, 5002); "Other" is accepted for the
 * plain password sign-in, which then asks for a CAPTCHA. NEUTRON_APP_VERSION overrides it for experiments.
 */
export const ownAppIdentity = (appVersion: string) => ({
    appVersion: process.env.NEUTRON_APP_VERSION || 'Other',
    userAgent: `NeutronCalendarBridge/${appVersion} (macOS; Darwin ${release()}; +https://github.com/to-bi-s/neutron-calendar-bridge)`
});

export class ProtonAdapter {
    private api: ProtonCalendarAPI | null = null;
    private username: string | null = null;
    private invitationOptions: InvitationOptions | null = null;

    constructor(private readonly clientStateDir: string) {}

    /** Proton's session after signing in and after each renewal (saved to resume at the next start). */
    onSession: ((session: SavedSession & { identity: 'own' }) => void) | null = null;
    /** The app's version, for the own identity's User-Agent (set by the bridge). */
    appVersion = '0';

    /** Asked during a sign-in (0.27): the second factor, or the mailbox password; null gives up. */
    askSecondFactor: ((request: SecondFactorRequest) => Promise<SecondFactorAnswer | null>) | null = null;
    askMailboxPassword: ((request: { wrong: boolean }) => Promise<string | null>) | null = null;
    /** Counts sign-ins and sign-outs: only the current client object's sessions reach onSession. */
    private generation = 0;
    /** The current sign-in (see signIn): work started under an older one is not the current session's. */
    currentGeneration() {
        return this.generation;
    }

    /** The client library (replaceable in tests). */
    loadClient: () => Promise<Partial<Pick<typeof import('proton-calendar-client'), 'createProtonCalendarAPI' | 'INVITATION_LANGUAGES' | 'alarmBlocksOf' | 'normalizeAlarms' | 'busyPeriodsOf' | 'mergeBusyPeriods' | 'seriesLastEndOf' | 'descriptionWithConference' | 'descriptionWithoutConference' | 'videoProviderOfLocation'>>> = () =>
        import('proton-calendar-client');

    /** 0.33: True when the linked client reads and writes reminders. */
    supportsReminders() {
        const api = this.api as unknown as Record<string, unknown> | null;
        return typeof api?.setEventReminders === 'function';
    }

    /** 0.33: the VALARM blocks of an ICS text (empty with an older client, which has no reminders). */
    async alarmBlocksOf(ics: string): Promise<string[]> {
        const clientModule = await this.loadClient();
        return typeof clientModule.alarmBlocksOf === 'function' ? clientModule.alarmBlocksOf(ics) : [];
    }

    /** 0.33: a VEVENT's alarms as Proton would store them, for comparisons (none with an older client). */
    async alarmNormalizer(): Promise<(vevent: { dtstart?: unknown; components?: unknown[] }) => Array<{ action?: { value?: string }; trigger?: { value?: unknown } }>> {
        const clientModule = await this.loadClient();
        const normalize = clientModule.normalizeAlarms;
        return typeof normalize === 'function' ? (vevent) => normalize(vevent as unknown as ProtonVevent) : () => [];
    }

    /** 0.33.1: the account's contact addresses (guest autocomplete); empty with an older client. */
    async listContactEmails(): Promise<Array<{ email: string; name: string; contactId: string }>> {
        const api = this.api as unknown as { listContactEmails?: () => Promise<Array<{ email: string; name: string; contactId: string }>> } | null;
        if (!api || typeof api.listContactEmails !== 'function') {
            return [];
        }
        return api.listContactEmails();
    }

    /** 0.34.1: True when the linked client can make video links. */
    async supportsVideoLinks() {
        const api = this.api as unknown as Record<string, unknown> | null;
        const clientModule = await this.loadClient();
        return typeof api?.createVideoConference === 'function' && typeof clientModule.descriptionWithConference === 'function' && typeof clientModule.videoProviderOfLocation === 'function';
    }

    /** 0.34.1: the provider a location asks for (null with an older client or for a place). */
    async videoProviderOfLocation(location: string): Promise<1 | 2 | null> {
        const clientModule = await this.loadClient();
        return typeof clientModule.videoProviderOfLocation === 'function' ? clientModule.videoProviderOfLocation(location) : null;
    }

    /** 0.34.1: a new meeting room. */
    async createVideoConference(provider: 1 | 2, options: { title?: string; calendarId?: string }) {
        return this.requireApi().createVideoConference(provider, options);
    }

    /** 0.34.1: the client's function that puts Proton's conference block into a description (identity with an older client). */
    async conferenceDescriber(): Promise<(description: string, conference: { provider: 1 | 2; id: string; url: string; password?: string; host?: string }) => string> {
        const clientModule = await this.loadClient();
        const describe = clientModule.descriptionWithConference;
        return typeof describe === 'function' ? (description, conference) => describe(description, conference) : (description) => description;
    }

    /** 0.34.2: the client's function that takes Proton's conference block out of a description (identity with an older client). */
    async conferenceUndescriber(): Promise<(description: string) => string> {
        const clientModule = await this.loadClient();
        const undescribe = clientModule.descriptionWithoutConference;
        return typeof undescribe === 'function' ? (description) => undescribe(description) : (description) => description;
    }

    /** 0.34.2: renames a Proton Meet room of this account (false when the link is not one). */
    async renameProtonMeet(url: string, title: string): Promise<boolean> {
        const api = this.api as unknown as { renameProtonMeet?: ProtonCalendarAPI['renameProtonMeet'] } | null;
        return api && typeof api.renameProtonMeet === 'function' ? api.renameProtonMeet(url, title) : false;
    }

    /** 0.34.2: removes a Proton Meet room of this account (false when the link is not one). */
    async deleteProtonMeet(url: string): Promise<boolean> {
        const api = this.api as unknown as { deleteProtonMeet?: ProtonCalendarAPI['deleteProtonMeet'] } | null;
        return api && typeof api.deleteProtonMeet === 'function' ? api.deleteProtonMeet(url) : false;
    }

    /** 0.34: True when the linked client can rename, recolour and create calendars. */
    supportsCalendarManagement() {
        const api = this.api as unknown as Record<string, unknown> | null;
        return typeof api?.updateCalendarAppearance === 'function' && typeof api?.createCalendar === 'function';
    }

    /** 0.34: renames/recolours a calendar in Proton. */
    async updateCalendarAppearance(calendarId: string, changes: { name?: string; color?: string; description?: string }) {
        return this.requireApi().updateCalendarAppearance(calendarId, changes);
    }

    /** 0.34: creates a personal calendar in Proton, with its key. */
    async createCalendar(appearance: { name?: string; color?: string; description?: string; address?: string }) {
        return this.requireApi().createCalendar(appearance);
    }

    /** 0.33.2: True when the linked client can turn ICS text into busy periods (free/busy answers). */
    async supportsAvailability() {
        const clientModule = await this.loadClient();
        return typeof clientModule.busyPeriodsOf === 'function' && typeof clientModule.mergeBusyPeriods === 'function';
    }

    /** 0.33.2: the busy periods of an ICS text in a window, merged (empty with an older client). */
    async busyPeriodsOf(ics: string, windowStart: number, windowEnd: number, ownEmails: string[]): Promise<Array<{ start: number; end: number; allDay: boolean; tentative?: boolean }>> {
        const clientModule = await this.loadClient();
        return typeof clientModule.busyPeriodsOf === 'function' ? clientModule.busyPeriodsOf(ics, windowStart, windowEnd, ownEmails) : [];
    }

    /** 0.33.2: merged and clipped busy periods (as given with an older client). */
    /** 0.40: the end of a COUNT-limited series' last occurrence (null when unknown or open-ended, or with an older client). */
    async seriesLastEndOf(vevent: unknown): Promise<number | null> {
        const clientModule = await this.loadClient();
        try {
            return typeof (clientModule as any).seriesLastEndOf === 'function' && vevent ? (clientModule as any).seriesLastEndOf(vevent) : null;
        } catch {
            return null;
        }
    }

    async mergeBusyPeriods(periods: Array<{ start: number; end: number; allDay: boolean; tentative?: boolean }>, windowStart: number, windowEnd: number) {
        const clientModule = await this.loadClient();
        return typeof clientModule.mergeBusyPeriods === 'function' ? clientModule.mergeBusyPeriods(periods, windowStart, windowEnd) : periods;
    }

    /** 0.33.2: another user's busy times from Proton (not accessible with an older client). */
    async getBusySchedule(email: string, start: number, end: number, timeZone: string): Promise<{ accessible: boolean; slots: Array<{ start: number; end: number; allDay: boolean }> }> {
        const api = this.api as unknown as { getBusySchedule?: ProtonCalendarAPI['getBusySchedule'] } | null;
        if (!api || typeof api.getBusySchedule !== 'function') {
            return { accessible: false, slots: [] };
        }
        return api.getBusySchedule(email, start, end, timeZone);
    }

    /** 0.33: one event's reminders, through the personal-part endpoint. */
    async setEventReminders(calendarId: string, eventId: string, alarms: string[]) {
        return this.requireApi().setEventReminders(calendarId, eventId, alarms);
    }

    /** 0.31: the languages the client can write invitation emails in (empty with an older client). */
    async listInvitationLanguages(): Promise<Array<{ code: string; name: string }>> {
        const clientModule = await this.loadClient();
        return (clientModule.INVITATION_LANGUAGES || []).map(({ code, name }) => ({ code, name }));
    }

    /** 0.31: what "same as Proton Calendar" means for the signed-in account; null when not signed in or unknown. Asks Proton when stale. */
    async getProtonInviteLocale(): Promise<string | null> {
        const api = this.api as unknown as { getProtonInviteLocale?: () => Promise<string | null> } | null;
        if (!api || typeof api.getProtonInviteLocale !== 'function') {
            return null;
        }
        return api.getProtonInviteLocale().catch(() => null);
    }

    /** The last known value without asking Proton (for the window's state); null before the first read. */
    peekProtonInviteLocale(): string | null {
        const api = this.api as unknown as { protonInviteLocaleCached?: () => string | null } | null;
        if (!api || typeof api.protonInviteLocaleCached !== 'function') {
            return null;
        }
        return api.protonInviteLocaleCached();
    }

    /**
     * `session`: one saved earlier, resumed instead of a password sign-in while Proton accepts it.
     * Returns this sign-in's generation (see signOut). A sign-in overtaken by a sign-out or by a newer
     * sign-in while it ran is nobody's: its session is ended and SignedOutMeanwhile thrown, and the
     * current client is left alone.
     */
    async signIn(
        credentials: ProtonCredentials,
        humanVerification?: HumanVerificationChallenge | null,
        session?: SavedProtonSession | null
    ): Promise<number> {
        process.env.PROTON_CALENDAR_CLIENT_STATE_DIR = resolve(this.clientStateDir);
        const clientModule = await this.loadClient();
        const generation = ++this.generation;
        // 0.50: always the app's own identity (the bridge resumes only sessions opened under it).
        const clientCredentials: Credentials = {
            appIdentity: ownAppIdentity(this.appVersion),
            username: credentials.username,
            password: credentials.password,
            humanVerification,
            session: session
                ? {
                      UID: session.UID,
                      AccessToken: session.AccessToken,
                      RefreshToken: session.RefreshToken,
                      ...(session.keyPassword ? { keyPassword: session.keyPassword } : {}),
                      ...(session.passwordMode ? { passwordMode: session.passwordMode } : {})
                  }
                : null,
            onSession: (value) => {
                if (generation === this.generation) this.onSession?.({ ...value, identity: 'own' });
            },
            askSecondFactor: async (request) => (generation === this.generation && this.askSecondFactor ? this.askSecondFactor(request) : null),
            askMailboxPassword: async (request) => (generation === this.generation && this.askMailboxPassword ? this.askMailboxPassword(request) : null)
        };
        let api: ProtonCalendarAPI;
        if (typeof clientModule.createProtonCalendarAPI !== 'function') {
            throw new Error('proton-calendar-client could not be loaded.');
        }
        try {
            api = await clientModule.createProtonCalendarAPI(clientCredentials);
        } catch (error: any) {
            if (generation !== this.generation) {
                throw signedOutMeanwhile(); // overtaken: its outcome (also a verification) is nobody's
            }
            if (error?.name === 'HumanVerificationRequiredError' && error?.challenge) {
                throw new ProtonHumanVerificationRequiredError(error.challenge as HumanVerificationChallenge);
            }
            this.api = null;
            this.username = null;
            throw error;
        }
        if (generation !== this.generation) {
            await endSession(api);
            throw signedOutMeanwhile();
        }
        this.api = api;
        this.username = credentials.username;
        this.applyInvitationOptions();
        console.log(`[proton] signed in under the app's own identity (${ownAppIdentity(this.appVersion).appVersion}); proton-calendar-client features: ${this.describeFeatures()}`);
        return generation;
    }

    /**
     * Signs out; `end`: also ends the session at Proton (a saved copy becomes useless).
     * `onlyGeneration`: only if that sign-in is still the current one (never a newer one's client).
     */
    async signOut(end = true, onlyGeneration?: number) {
        if (onlyGeneration !== undefined && onlyGeneration !== this.generation) {
            return;
        }
        const api = this.api;
        this.api = null;
        this.username = null;
        this.generation += 1; // a late renewal of the old client is nobody's
        if (end && api) {
            await endSession(api);
        }
    }

    /** How the client talked to Proton (null with an older client or signed out). */
    getRequestStats(): RequestStats | null {
        const api = this.api as (ProtonCalendarAPI & { getRequestStats?: () => RequestStats }) | null;
        return api && typeof api.getRequestStats === 'function' ? api.getRequestStats() : null;
    }

    getSignedInUsername() {
        return this.username;
    }

    isSignedIn() {
        return Boolean(this.api);
    }

    private requireApi() {
        if (!this.api) {
            throw new Error('Not signed in to Proton');
        }

        return this.api;
    }

    async listCalendars(): Promise<CalendarInfo[]> {
        return this.requireApi().listCalendars();
    }

    async listEvents(calendarId: string, startDate: Date, endDate: Date): Promise<SyncedCalendarEvent[]> {
        return this.requireApi().listEvents(calendarId, startDate, endDate);
    }

    /** Re-reads one event or series (client stage 2+); null when the client cannot. */
    async listEventsByUid(calendarId: string, uid: string): Promise<SyncedCalendarEvent[] | null> {
        const api = this.requireApi() as unknown as { listEventsByUid?: ProtonCalendarAPI['listEventsByUid'] };
        return typeof api.listEventsByUid === 'function' ? api.listEventsByUid(calendarId, uid) : null;
    }

    /** True when the client can follow Proton's change feeds (0.26); older clients are listed in full every pass. */
    supportsChangeFeed() {
        const api = this.api as unknown as Record<string, unknown> | null;
        return typeof api?.getCalendarChanges === 'function' && typeof api?.getAccountChanges === 'function' && typeof api?.listEventsByUid === 'function';
    }

    /** What changed in a calendar since `cursor` (null: only the cursor to start from). */
    async getCalendarChanges(calendarId: string, cursor: string | null): Promise<CalendarChanges> {
        return this.requireApi().getCalendarChanges(calendarId, cursor);
    }

    /** What changed in the account since `cursor` (calendars, addresses, mail, settings). */
    async getAccountChanges(cursor: string | null): Promise<AccountChanges> {
        return this.requireApi().getAccountChanges(cursor);
    }

    /** Events decrypted and reused so far (null with an older client or signed out). */
    getDecryptStats(): DecryptStats | null {
        const api = this.api as (ProtonCalendarAPI & { getDecryptStats?: () => DecryptStats }) | null;
        return api && typeof api.getDecryptStats === 'function' ? api.getDecryptStats() : null;
    }

    async createEvent(calendarId: string, eventData: EventData) {
        return this.requireApi().createEventInCalendar(calendarId, eventData);
    }

    async updateEvent(calendarId: string, eventId: string, eventData: EventData) {
        return this.requireApi().updateEventInCalendar(calendarId, eventId, eventData);
    }

    async deleteEvent(calendarId: string, eventId: string) {
        return this.requireApi().deleteEventInCalendar(calendarId, eventId);
    }

    /** True when the linked proton-calendar-client can write whole series (the patched version). */
    supportsSeriesSync() {
        const api = this.api as unknown as Record<string, unknown> | null;
        return typeof api?.syncSeries === 'function' && typeof api?.parseIcsToVevents === 'function';
    }

    /** Own addresses, active first; empty with a client that predates invitation support. */
    listAddresses(): AccountAddress[] {
        const api = this.api as unknown as { listAddresses?: () => AccountAddress[] } | null;
        return typeof api?.listAddresses === 'function' ? api.listAddresses() : [];
    }

    parseIcs(ics: string): ProtonVevent[] {
        return this.requireApi().parseIcsToVevents(ics);
    }

    async syncSeries(input: SyncSeriesInput): Promise<SyncSeriesResult> {
        return this.requireApi().syncSeries(input);
    }

    /** True when the linked proton-calendar-client can answer and decline invitations (stage 2+). */
    supportsInvitations() {
        const api = this.api as unknown as Record<string, unknown> | null;
        return (
            typeof api?.answerInvitation === 'function' &&
            typeof api?.removeInvitation === 'function' &&
            typeof api?.configureInvitations === 'function'
        );
    }

    /** Remembered across sign-ins; applied to the client now if one is signed in. */
    setInvitationOptions(options: InvitationOptions) {
        this.invitationOptions = options;
        this.applyInvitationOptions();
    }

    private applyInvitationOptions() {
        if (this.invitationOptions && this.supportsInvitations()) {
            this.requireApi().configureInvitations(this.invitationOptions);
        }
    }

    async answerInvitation(input: AnswerInvitationInput): Promise<InvitationOutcome> {
        return this.requireApi().answerInvitation(input);
    }

    async removeInvitation(input: RemoveInvitationInput): Promise<InvitationOutcome> {
        return this.requireApi().removeInvitation(input);
    }

    /** True when the linked proton-calendar-client can send invitations for meetings you organize (stage 3+). */
    supportsOrganizing() {
        const api = this.api as unknown as Record<string, unknown> | null;
        return (
            this.supportsInvitations() &&
            typeof api?.saveOrganizedEvent === 'function' &&
            typeof api?.cancelOrganizedEvent === 'function'
        );
    }

    /** True when the client can also send invitations for recurring meetings you organize (stage 3b). */
    supportsOrganizingSeries() {
        const api = this.api as unknown as Record<string, unknown> | null;
        return this.supportsOrganizing() && typeof api?.saveOrganizedSeries === 'function';
    }

    async saveOrganizedSeries(input: SaveOrganizedSeriesInput): Promise<InvitationOutcome> {
        const api = this.requireApi();
        if (typeof api.saveOrganizedSeries !== 'function') {
            throw new Error('This build of proton-calendar-client cannot save recurring meetings');
        }
        return api.saveOrganizedSeries(input);
    }

    /** True when the client can apply answers that guests outside Proton send by email (stage 4). */
    supportsEmailedAnswers() {
        const api = this.api as unknown as Record<string, unknown> | null;
        return this.supportsOrganizing() && typeof api?.applyEmailedAnswers === 'function';
    }

    /** 0.41: emails to guests that wait for Proton's slow-down to end (0 with an older client). */
    deferredEmailCount(): number {
        const api = this.api as unknown as { deferredEmailCount?: () => number } | null;
        return typeof api?.deferredEmailCount === 'function' ? api.deferredEmailCount() : 0;
    }

    /** 0.41: sends those once Proton answers again (nothing with an older client). */
    async sendDeferredEmails(): Promise<{ sent: number; waiting: number; givenUp: number }> {
        const api = this.api as unknown as { sendDeferredEmails?: () => Promise<{ sent: number; waiting: number; givenUp: number }> } | null;
        return typeof api?.sendDeferredEmails === 'function' ? api.sendDeferredEmails() : { sent: 0, waiting: 0, givenUp: 0 };
    }

    async applyEmailedAnswers(input: ApplyEmailedAnswersInput): Promise<ApplyEmailedAnswersResult> {
        const api = this.requireApi();
        if (typeof api.applyEmailedAnswers !== 'function') {
            throw new Error('This build of proton-calendar-client cannot apply emailed answers');
        }
        return api.applyEmailedAnswers(input);
    }

    /** True when the client can move emails about meetings that are dealt with (patch 20). */
    supportsCalendarEmails() {
        const api = this.api as unknown as Record<string, unknown> | null;
        return this.supportsOrganizing() && typeof api?.fileCalendarEmails === 'function';
    }

    async fileCalendarEmails(input: FileCalendarEmailsInput): Promise<FileCalendarEmailsResult> {
        const api = this.requireApi();
        if (typeof api.fileCalendarEmails !== 'function') {
            throw new Error('This build of proton-calendar-client cannot move emails about meetings');
        }
        return api.fileCalendarEmails(input);
    }

    /** What the linked client can do, for bridge.log (an outdated client shows up here). */
    describeFeatures() {
        const features = [
            ['series', this.supportsSeriesSync()],
            ['answering invitations', this.supportsInvitations()],
            ['meetings you organize', this.supportsOrganizing()],
            ['recurring meetings you organize', this.supportsOrganizingSeries()],
            ['answers emailed by guests', this.supportsEmailedAnswers()],
            ['moving emails about meetings', this.supportsCalendarEmails()],
            ['session renewal', Boolean(this.getRequestStats())]
        ] as const;
        return features.map(([name, supported]) => `${name}: ${supported ? 'yes' : 'no'}`).join(', ');
    }

    async saveOrganizedEvent(input: SaveOrganizedEventInput): Promise<InvitationOutcome> {
        return this.requireApi().saveOrganizedEvent(input);
    }

    async cancelOrganizedEvent(input: CancelOrganizedEventInput): Promise<InvitationOutcome> {
        return this.requireApi().cancelOrganizedEvent(input);
    }
}
