import { isAppLanguage } from './i18n';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { BridgeConfig, CalendarEmailsAfter, DetailedLogging, EmailedAnswersCursor } from '../shared/types';

interface LegacyStoredConfig extends BridgeConfig {
    localCaldavPassword?: string;
}

const DEFAULT_CONFIG: BridgeConfig = {
    openAtLogin: false,
    pollIntervalMs: 60_000,
    eventLookbackDays: 365,
    eventLookaheadDays: 730,
    caldavPort: 31876,
    caldavUsername: 'neutron-calendar-bridge',
    excludedCalendarIds: [],
    transparentCalendarIds: [],
    theme: 'system',
    appLanguage: 'system',
    invitationEmailMode: 'live',
    invitationEmailLanguage: 'proton',
    invitationEmailAllowlist: [],
    developerMode: false,
    applyEmailedAnswers: false,
    emailedAnswersCursor: null,
    sentInvitationIds: [],
    leftoverEvents: [],
    calendarEmailsAfter: 'leave',
    calendarEmailsFolder: 'Calendar',
    newCalendarAddress: '',
    notifications: true,
    notificationTitles: true,
    detailedLogging: 'off',
    detailedLoggingUntil: null,
    loginItemAppPath: null,
    calendarAppLastSeenAt: null,
    thunderbirdLastSeenAt: null,
    otherClientLastSeen: null
};

const DETAILED_LOGGING: DetailedLogging[] = ['off', '24h', 'on'];

/** 0.41: how many sent invitation Message-IDs are kept (newest), and for how long. */
export const SENT_INVITATION_IDS_MAX = 500;
export const SENT_INVITATION_IDS_DAYS = 90;

/** 0.42: leftovers of slow-downs, kept until removed (at most 50, a month). */
const normalizeLeftovers = (value: unknown): Array<{ calendarID: string; eventID: string; account: string; at: number }> => {
    if (!Array.isArray(value)) {
        return [];
    }
    const oldest = Date.now() - 31 * 24 * 3600 * 1000;
    return value
        .filter((entry) => typeof entry?.calendarID === 'string' && typeof entry?.eventID === 'string' && entry.calendarID && entry.eventID && typeof entry?.account === 'string' && Number.isFinite(entry?.at) && entry.at >= oldest)
        .map(({ calendarID, eventID, account, at }) => ({ calendarID, eventID, account, at }))
        .slice(-50);
};

const normalizeSentIds = (value: unknown): Array<{ id: string; at: number }> => {
    if (!Array.isArray(value)) {
        return [];
    }
    const oldest = Date.now() - SENT_INVITATION_IDS_DAYS * 24 * 3600 * 1000;
    return value
        .filter((entry): entry is { id: string; at: number } => typeof entry?.id === 'string' && entry.id.length > 0 && entry.id.length < 1000 && Number.isFinite(entry?.at))
        .filter((entry) => entry.at >= oldest)
        .map(({ id, at }) => ({ id, at }))
        .slice(-SENT_INVITATION_IDS_MAX);
};
const normalizeDetailedLogging = (value: unknown): DetailedLogging =>
    DETAILED_LOGGING.includes(value as DetailedLogging) ? (value as DetailedLogging) : 'off';
/** 'proton' or a Proton locale code (xx_YY); anything else: 'proton'. */
const normalizeEmailLanguage = (value: unknown) => (value === 'proton' || (typeof value === 'string' && /^[a-z]{2,3}_[A-Z]{2}$/.test(value)) ? value : 'proton');
const normalizeTimestamp = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null);

/** 0.49.1: another CalDAV app's last sign-in: a timestamp and a short name (or none). */
const normalizeOtherClient = (value: unknown): { at: number; name: string | null } | null => {
    if (!value || typeof value !== 'object') return null;
    const at = normalizeTimestamp((value as { at?: unknown }).at);
    if (at === null) return null;
    const name = (value as { name?: unknown }).name;
    return { at, name: typeof name === 'string' && name.trim() ? name.trim().slice(0, 40) : null };
};

const CALENDAR_EMAILS_AFTER: CalendarEmailsAfter[] = ['leave', 'trash', 'archive', 'folder'];
const normalizeCalendarEmailsAfter = (value: unknown): CalendarEmailsAfter =>
    CALENDAR_EMAILS_AFTER.includes(value as CalendarEmailsAfter) ? (value as CalendarEmailsAfter) : 'leave';
/** A top-level folder name (no "/", at most 100 characters); "Calendar" otherwise. */
export const normalizeCalendarEmailsFolder = (value: unknown) => {
    const name = typeof value === 'string' ? value.trim() : '';
    return name && name.length <= 100 && !name.includes('/') ? name : 'Calendar';
};

const normalizeAppLanguage = (value: unknown) => (value === 'system' || isAppLanguage(value) ? value : 'system');
const normalizeTheme = (value: unknown): BridgeConfig['theme'] =>
    value === 'light' || value === 'dark' ? value : 'system';

/** Since 0.32.3 the default is live (test and dry run are developer options); an explicit setting is kept. */
const normalizeEmailMode = (value: unknown): BridgeConfig['invitationEmailMode'] =>
    value === 'dry-run' || value === 'test' ? value : 'live';

const normalizeCursor = (value: unknown): EmailedAnswersCursor | null => {
    const entry = value as Partial<EmailedAnswersCursor> | null;
    return entry && typeof entry.account === 'string' && Number.isFinite(entry.cursor) && Number(entry.cursor) > 0
        ? { account: entry.account, cursor: Math.floor(Number(entry.cursor)) }
        : null;
};

const EMAIL_PATTERN = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/;

/** 0.37: an address, trimmed; '' (the first active address) for anything else. */
const normalizeAddress = (value: unknown) => (typeof value === 'string' && EMAIL_PATTERN.test(value.trim()) ? value.trim() : '');

/** Trimmed, plausible addresses, each once (case-insensitive), in the order given. */
export const normalizeEmailList = (value: unknown): string[] => {
    const entries = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/[\s,;]+/) : [];
    const seen = new Set<string>();
    const result: string[] = [];
    for (const entry of entries) {
        const email = typeof entry === 'string' ? entry.trim().replace(/^mailto:/i, '') : '';
        if (!email || !EMAIL_PATTERN.test(email) || seen.has(email.toLowerCase())) {
            continue;
        }
        seen.add(email.toLowerCase());
        result.push(email);
    }
    return result;
};

const normalizeIdList = (value: unknown): string[] =>
    Array.isArray(value)
        ? [...new Set(value.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0))]
        : [];

/** Readable by you only (0600); best effort. */
export const restrictToOwner = (filePath: string) => {
    try {
        if (existsSync(filePath)) {
            chmodSync(filePath, 0o600);
        }
    } catch {
        // not ours to change: it still works
    }
};

/**
 * 0.36: settings that belong to one account (several accounts: each has its own file under
 * accounts/<id>/); everything else is the app's and shared.
 */
export const ACCOUNT_CONFIG_KEYS = ['caldavUsername', 'excludedCalendarIds', 'transparentCalendarIds', 'invitationEmailLanguage', 'emailedAnswersCursor', 'sentInvitationIds', 'leftoverEvents', 'calendarEmailsAfter', 'calendarEmailsFolder', 'newCalendarAddress', 'calendarAppLastSeenAt', 'thunderbirdLastSeenAt', 'otherClientLastSeen'] as const;
export type AccountConfigKey = (typeof ACCOUNT_CONFIG_KEYS)[number];
export const isAccountConfigKey = (key: string): key is AccountConfigKey => (ACCOUNT_CONFIG_KEYS as readonly string[]).includes(key);

/** Which keys a store's file holds: all (one account, as before 0.36), the app's, or an account's. */
export type ConfigScope = 'all' | 'shared' | 'account';

const inScope = (scope: ConfigScope, key: string) => scope === 'all' || (scope === 'account') === isAccountConfigKey(key);

/** What a store with these methods offers (ConfigStore, or an account's view of two files). */
export interface ConfigStoreLike {
    load(): BridgeConfig;
    save(config: BridgeConfig): void;
    update(patch: Partial<BridgeConfig>): BridgeConfig;
    consumeLegacyLocalPassword(): string | null;
}

export class ConfigStore implements ConfigStoreLike {
    private readonly filePath: string;

    constructor(baseDir: string, private readonly scope: ConfigScope = 'all') {
        this.filePath = join(baseDir, 'config.json');
        mkdirSync(dirname(this.filePath), { recursive: true });
        restrictToOwner(this.filePath); // also one saved before 0.24, before anything changes
    }

    /** The keys this file holds (0.36: an account's file keeps only its own; the app's file the rest). */
    holds(key: string) {
        return inScope(this.scope, key);
    }

    private readRaw(): Partial<LegacyStoredConfig> {
        if (!existsSync(this.filePath)) {
            return {};
        }
        try {
            return JSON.parse(readFileSync(this.filePath, 'utf8')) as Partial<LegacyStoredConfig>;
        } catch {
            return {};
        }
    }

    load(): BridgeConfig {
        const parsed = this.readRaw();
        return {
            ...DEFAULT_CONFIG,
            openAtLogin: parsed.openAtLogin ?? DEFAULT_CONFIG.openAtLogin,
            pollIntervalMs: parsed.pollIntervalMs ?? DEFAULT_CONFIG.pollIntervalMs,
            eventLookbackDays: parsed.eventLookbackDays ?? DEFAULT_CONFIG.eventLookbackDays,
            eventLookaheadDays: parsed.eventLookaheadDays ?? DEFAULT_CONFIG.eventLookaheadDays,
            caldavPort: parsed.caldavPort ?? DEFAULT_CONFIG.caldavPort,
            caldavUsername: parsed.caldavUsername ?? DEFAULT_CONFIG.caldavUsername,
            excludedCalendarIds: normalizeIdList(parsed.excludedCalendarIds),
            transparentCalendarIds: normalizeIdList(parsed.transparentCalendarIds),
            theme: normalizeTheme(parsed.theme),
            appLanguage: normalizeAppLanguage(parsed.appLanguage),
            invitationEmailMode: normalizeEmailMode(parsed.invitationEmailMode),
            invitationEmailLanguage: normalizeEmailLanguage(parsed.invitationEmailLanguage),
            invitationEmailAllowlist: normalizeEmailList(parsed.invitationEmailAllowlist),
            developerMode: parsed.developerMode === true,
            // Before 0.19 this was on by default and saved as such: a config from then (no
            // developerMode yet) starts with it off, now that it is a developer option.
            applyEmailedAnswers: parsed.developerMode === undefined ? false : parsed.applyEmailedAnswers === true,
            emailedAnswersCursor: normalizeCursor(parsed.emailedAnswersCursor),
            sentInvitationIds: normalizeSentIds(parsed.sentInvitationIds),
            leftoverEvents: normalizeLeftovers(parsed.leftoverEvents),
            calendarEmailsAfter: normalizeCalendarEmailsAfter(parsed.calendarEmailsAfter),
            calendarEmailsFolder: normalizeCalendarEmailsFolder(parsed.calendarEmailsFolder),
            newCalendarAddress: normalizeAddress(parsed.newCalendarAddress),
            notifications: parsed.notifications !== false,
            notificationTitles: parsed.notificationTitles !== false,
            detailedLogging: normalizeDetailedLogging(parsed.detailedLogging),
            detailedLoggingUntil: normalizeTimestamp(parsed.detailedLoggingUntil),
            loginItemAppPath: typeof parsed.loginItemAppPath === 'string' && parsed.loginItemAppPath ? parsed.loginItemAppPath : null,
            calendarAppLastSeenAt: normalizeTimestamp(parsed.calendarAppLastSeenAt),
            thunderbirdLastSeenAt: normalizeTimestamp(parsed.thunderbirdLastSeenAt),
            otherClientLastSeen: normalizeOtherClient(parsed.otherClientLastSeen)
        };
    }

    save(config: BridgeConfig) {
        const sanitized = {
            openAtLogin: config.openAtLogin,
            pollIntervalMs: config.pollIntervalMs,
            eventLookbackDays: config.eventLookbackDays,
            eventLookaheadDays: config.eventLookaheadDays,
            caldavPort: config.caldavPort,
            caldavUsername: config.caldavUsername,
            excludedCalendarIds: normalizeIdList(config.excludedCalendarIds),
            transparentCalendarIds: normalizeIdList(config.transparentCalendarIds),
            theme: normalizeTheme(config.theme),
            appLanguage: normalizeAppLanguage(config.appLanguage),
            invitationEmailMode: normalizeEmailMode(config.invitationEmailMode),
            invitationEmailLanguage: normalizeEmailLanguage(config.invitationEmailLanguage),
            invitationEmailAllowlist: normalizeEmailList(config.invitationEmailAllowlist),
            developerMode: config.developerMode === true,
            applyEmailedAnswers: config.applyEmailedAnswers === true,
            emailedAnswersCursor: normalizeCursor(config.emailedAnswersCursor),
            sentInvitationIds: normalizeSentIds(config.sentInvitationIds),
            leftoverEvents: normalizeLeftovers(config.leftoverEvents),
            calendarEmailsAfter: normalizeCalendarEmailsAfter(config.calendarEmailsAfter),
            calendarEmailsFolder: normalizeCalendarEmailsFolder(config.calendarEmailsFolder),
            newCalendarAddress: normalizeAddress(config.newCalendarAddress),
            notifications: config.notifications !== false,
            notificationTitles: config.notificationTitles !== false,
            detailedLogging: normalizeDetailedLogging(config.detailedLogging),
            detailedLoggingUntil: normalizeTimestamp(config.detailedLoggingUntil),
            loginItemAppPath: typeof config.loginItemAppPath === 'string' && config.loginItemAppPath ? config.loginItemAppPath : null,
            calendarAppLastSeenAt: normalizeTimestamp(config.calendarAppLastSeenAt),
            thunderbirdLastSeenAt: normalizeTimestamp(config.thunderbirdLastSeenAt),
            otherClientLastSeen: normalizeOtherClient(config.otherClientLastSeen)
        };
        // Only this scope's keys are written; keys of the other scope already in the file stay as they
        // are (0.36: the app's file still holds the account keys from before until the migration moved them).
        const others = Object.fromEntries(Object.entries(this.readRaw()).filter(([key]) => key !== 'localCaldavPassword' && !this.holds(key)));
        const kept = { ...others, ...Object.fromEntries(Object.entries(sanitized).filter(([key]) => this.holds(key))) };
        // Yours only: it lists addresses (the test-mode list) and which account read the mailbox.
        writeFileSync(this.filePath, `${JSON.stringify(kept, null, 2)}\n`, { mode: 0o600 });
        chmodSync(this.filePath, 0o600);
    }

    update(patch: Partial<BridgeConfig>) {
        const nextConfig = {
            ...this.load(),
            ...patch
        };
        this.save(nextConfig);
        return nextConfig;
    }

    consumeLegacyLocalPassword() {
        const current = this.readRaw();
        if (!current.localCaldavPassword) {
            return null;
        }

        const { localCaldavPassword } = current;
        this.save({
            ...DEFAULT_CONFIG,
            ...this.load()
        });
        return localCaldavPassword;
    }
}

/**
 * 0.36: one account's settings as one object — the app's shared file for the app-wide keys, the
 * account's own file for its keys (ACCOUNT_CONFIG_KEYS). Reads merge; writes go to the file that
 * holds each key, so two accounts never overwrite each other's or the app's settings.
 */
export class AccountConfigStore implements ConfigStoreLike {
    constructor(
        private readonly shared: ConfigStore,
        private readonly own: ConfigStore
    ) {}

    load(): BridgeConfig {
        const shared = this.shared.load();
        const own = this.own.load();
        const result: Record<string, unknown> = { ...shared };
        for (const key of ACCOUNT_CONFIG_KEYS) {
            result[key] = own[key];
        }
        return result as unknown as BridgeConfig;
    }

    save(config: BridgeConfig) {
        this.shared.save(config); // keeps its keys only
        this.own.save(config);
    }

    update(patch: Partial<BridgeConfig>): BridgeConfig {
        const entries = Object.entries(patch);
        const sharedPatch = Object.fromEntries(entries.filter(([key]) => !isAccountConfigKey(key)));
        const ownPatch = Object.fromEntries(entries.filter(([key]) => isAccountConfigKey(key)));
        if (Object.keys(sharedPatch).length) {
            this.shared.update(sharedPatch);
        }
        if (Object.keys(ownPatch).length) {
            this.own.update(ownPatch);
        }
        return this.load();
    }

    /** The password a config from before 0.24 carried: it belonged to the one account, in the app's file. */
    consumeLegacyLocalPassword() {
        return this.shared.consumeLegacyLocalPassword() ?? this.own.consumeLegacyLocalPassword();
    }
}
