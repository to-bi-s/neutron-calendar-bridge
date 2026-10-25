/**
 * Several Proton accounts (0.36, stage 12): one BridgeService per account — its own session, local
 * copy, outbox, saved login and CalDAV principal under the same local server — kept in
 * <userData>/accounts/<id>/, in the order the user chose (accounts.json). App-wide settings stay in
 * <userData>/config.json; an account's own settings live in its folder (see config-store.ts).
 *
 * A new account is signed in as a "pending" service (the sign-in page) and joins the list the
 * moment Proton accepted the login, before its first sync. Every account is alike: its CalDAV user
 * name is derived from its ID, its Calendar.app profile identity from the app's identifier and its ID.
 */
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { SecretStore } from './secret-store';
import { join } from 'node:path';

import { accountTag, inAccountContext } from './account-context';
import { BridgeService, CALENDAR_APP_PROFILE_IDENTIFIER } from './bridge-service';
import type { BridgeNotification, BridgeServiceOptions } from './bridge-service';
import { AccountConfigStore, ConfigStore, isAccountConfigKey } from './config-store';
import type { BridgeAppState, BridgeConfigPatch, SyncStatus } from '../shared/types';
import type { TrayAppState } from './tray-menu';

/** The Calendar.app profile identity of an account: this, followed by the account's ID. */
export const PROFILE_IDENTIFIER_BASE = CALENDAR_APP_PROFILE_IDENTIFIER;
const ACCOUNTS_FILE = 'accounts.json';
const ACCOUNTS_DIR = 'accounts';
/** The client library's state folder: one for all accounts. */
const CLIENT_STATE_DIR = 'proton-calendar-client';

export interface AccountEntry {
    id: string;
}

export interface Account {
    entry: AccountEntry;
    dir: string;
    service: BridgeService;
    /** initialize() done (a pending account prepares its folder in the background). */
    ready: Promise<void>;
}

export interface AccountManagerOptions {
    /** Builds a service (tests replace it with one that has a fake adapter). */
    createService?: (dir: string, options: BridgeServiceOptions) => BridgeService;
    onNotify?: (notification: BridgeNotification) => void;
    onStateChange?: () => void;
    appVersion?: string;
}

const newAccountId = () => randomBytes(4).toString('hex');

/**
 * The CalDAV user name of a new account (its principal path): from the account's ID, not its
 * address — the path is in every bridge.log line and in Calendar.app's account settings, and the
 * quiet log keeps addresses out.
 */
export const caldavUsernameFor = (id: string) => `neutron-${id}`;

export class AccountManager {
    /** The app's settings (theme, language, checks, notifications …), shared by every account. */
    readonly sharedConfig: ConfigStore;
    private accounts: Account[] = [];
    /** The account being signed in: the first one, or one being added while others exist. */
    private pending: Account | null = null;
    /** "Add Account" was chosen while accounts exist: the sign-in page shows, with a way back. */
    private adding = false;
    private initialized = false;

    constructor(
        private readonly userData: string,
        private readonly options: AccountManagerOptions = {}
    ) {
        this.sharedConfig = new ConfigStore(userData, 'shared');
    }

    private get accountsFile() {
        return join(this.userData, ACCOUNTS_FILE);
    }

    private accountDir(id: string) {
        return join(this.userData, ACCOUNTS_DIR, id);
    }

    /** 0.39: a copy of the last list that was written; its order is used when accounts.json is lost or unreadable. */
    private get backupFile() {
        return `${this.accountsFile}.bak`;
    }

    private readEntries(file: string = this.accountsFile): AccountEntry[] | null {
        if (!existsSync(file)) {
            return null;
        }
        try {
            const parsed = JSON.parse(readFileSync(file, 'utf8')) as { accounts?: unknown };
            return Array.isArray(parsed.accounts)
                ? parsed.accounts
                      .filter((entry): entry is AccountEntry => Boolean(entry) && typeof (entry as AccountEntry).id === 'string' && /^[a-f0-9]{8}$/.test((entry as AccountEntry).id))
                      .map((entry) => ({ id: entry.id }))
                : [];
        } catch {
            return null;
        }
    }

    /**
     * Written whole, then renamed into place: a crash leaves the old list, never a torn one. The same
     * list goes to accounts.json.bak (0.39), so a lost or damaged list can be rebuilt in its order.
     */
    private writeEntries() {
        const entries = this.accounts.map((account) => account.entry);
        const text = `${JSON.stringify({ accounts: entries }, null, 2)}\n`;
        for (const file of [this.accountsFile, this.backupFile]) {
            const temporary = `${file}.tmp`;
            writeFileSync(temporary, text, { mode: 0o600 });
            renameSync(temporary, file);
        }
    }

    /**
     * The folders under accounts/ that the list does not name: one with a saved login is an account
     * (the list was lost, or the app died between moving the files and writing the list) and is
     * taken back; one without is a sign-in that never finished and is removed.
     */
    private async sweepUnlistedFolders(listed: Set<string>) {
        const dir = join(this.userData, ACCOUNTS_DIR);
        if (!existsSync(dir)) {
            return;
        }
        for (const name of readdirSync(dir)) {
            if (listed.has(name) || !/^[a-f0-9]{8}$/.test(name)) {
                continue;
            }
            const folder = join(dir, name);
            const secrets = new SecretStore(folder);
            const saved = secrets.isUnreadable() || Boolean(await secrets.getProtonCredentials().catch(() => null));
            if (saved) {
                this.accounts.push(this.buildAccount({ id: name }));
                console.warn(`[accounts] account ${name} was not in the list: taken back`);
            } else {
                rmSync(folder, { recursive: true, force: true });
                console.log(`[accounts] folder ${name} held no account (a sign-in that never finished): removed`);
            }
        }
    }

    private buildAccount(entry: AccountEntry): Account {
        const dir = this.accountDir(entry.id);
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        const own = new ConfigStore(dir, 'account');
        const serviceOptions: BridgeServiceOptions = {
            configStore: new AccountConfigStore(this.sharedConfig, own),
            clientStateDir: join(this.userData, CLIENT_STATE_DIR),
            account: {
                id: entry.id,
                profileIdentifier: `${PROFILE_IDENTIFIER_BASE}.${entry.id}`,
                accountName: () => {
                    const label = this.byId(entry.id)?.service.accountLabel() ?? null;
                    return label ? `Proton (${label})` : 'Proton';
                },
                labelForNotifications: () => (this.accounts.length > 1 ? this.byId(entry.id)?.service.accountLabel() ?? null : null),
                onSignedIn: (service) => this.adopt(service)
            }
        };
        const raw = this.options.createService ? this.options.createService(dir, serviceOptions) : new BridgeService(dir, serviceOptions);
        // 0.36.4: every call into the service runs in its account's context, so its log lines carry the account's tag.
        const service = inAccountContext(raw, { id: entry.id, tag: accountTag(entry.id), label: () => raw.accountLabel() });
        service.appVersion = this.options.appVersion ?? service.appVersion;
        if (this.options.onNotify) {
            service.onNotify = this.options.onNotify;
        }
        if (this.options.onStateChange) {
            service.onStateChange = this.options.onStateChange;
        }
        return { entry, dir, service, ready: Promise.resolve() };
    }

    /** Reads the account list and restores every account's session. */
    /** 0.46: the list of accounts is read (the menu shows each account's line from then on). */
    private loaded = false;

    isLoaded() {
        return this.loaded;
    }

    async initialize() {
        if (this.initialized) {
            return;
        }
        this.initialized = true;
        const listed = existsSync(this.accountsFile);
        let entries = this.readEntries();
        if (entries === null) {
            // No list yet, or one that cannot be read: the last list written (0.39) gives the order,
            // the folders say what there is (an account missing from the copy joins at the end).
            const backup = this.readEntries(this.backupFile);
            if (backup) {
                console.warn(`[accounts] accounts.json ${listed ? 'could not be read' : 'is missing'}: the order comes from accounts.json.bak`);
                entries = backup;
            } else {
                if (listed) {
                    console.warn('[accounts] accounts.json could not be read: the account folders are taken as they are');
                }
                entries = [];
            }
        }
        // A listed account whose folder is gone has nothing left to restore.
        const missing = entries.filter((entry) => !existsSync(this.accountDir(entry.id)));
        for (const entry of missing) {
            console.warn(`[accounts] account ${entry.id} is listed but its folder is gone: dropped from the list`);
        }
        entries = entries.filter((entry) => !missing.includes(entry));
        this.accounts = entries.map((entry) => this.buildAccount(entry));
        this.loaded = true;
        await this.sweepUnlistedFolders(new Set(entries.map((entry) => entry.id)));
        this.writeEntries();
        for (const account of this.accounts) {
            account.ready = account.service.initialize();
        }
        const results = await Promise.allSettled(this.accounts.map((account) => account.ready));
        results.forEach((result, index) => {
            if (result.status === 'rejected') {
                console.error(`[accounts] account ${this.accounts[index].entry.id} could not start: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`);
            }
        });
        // A listed account stays listed, signed in or not (signed out, it keeps its folder, CalDAV
        // password and settings for signing in again); only unlisted folders are swept above.
    }

    async shutdown() {
        await Promise.allSettled([...this.accounts, ...(this.pending ? [this.pending] : [])].map((account) => account.service.shutdown()));
    }

    // ── The accounts ───────────────────────────────────────────────────────────

    /** The accounts in their order (signed in or restoring). */
    list(): BridgeService[] {
        return this.accounts.map((account) => account.service);
    }

    count() {
        return this.accounts.length;
    }

    byId(id: string | null | undefined): Account | null {
        return (id && this.accounts.find((account) => account.entry.id === id)) || null;
    }

    /** The account that serves this CalDAV user name (the principal path). */
    byUsername(username: string): BridgeService | null {
        return this.accounts.find((account) => this.usernameOf(account) === username)?.service ?? null;
    }

    private usernameOf(account: Account) {
        try {
            return account.service.getCalDAVConfig().username;
        } catch {
            return null; // not started yet (its CalDAV password is read in initialize())
        }
    }

    /** Where the CalDAV server listens (the app's port; no account needed). */
    listenOn() {
        return { host: '127.0.0.1', port: this.sharedConfig.load().caldavPort };
    }

    /** The account being signed in, if any (never made here). */
    pendingService(): BridgeService | null {
        return this.pending?.service ?? null;
    }

    /** A service by ID — an account, or the one being signed in (null) — or an error for the window. */
    serviceOf(id: string | null | undefined): BridgeService {
        if (id === null || id === undefined) {
            return this.pending?.service ?? this.accounts[0]?.service ?? this.ensurePending().service;
        }
        const account = this.byId(id);
        if (!account) {
            throw new Error(`Unknown account: ${id}`);
        }
        return account.service;
    }

    /** The service the sign-in page talks to: the account being added (made on demand), or an account that asks something. */
    signingInService(accountId?: string | null): BridgeService {
        if (accountId) {
            return this.serviceOf(accountId);
        }
        return this.ensurePending().service;
    }

    /** The same, once its folder is prepared (a sign-in must not run before initialize() is done). */
    async signingIn(accountId?: string | null): Promise<BridgeService> {
        if (accountId) {
            return this.serviceOf(accountId);
        }
        const pending = this.ensurePending();
        await pending.ready;
        return pending.service;
    }

    // ── Adding and removing ────────────────────────────────────────────────────

    private ensurePending(): Account {
        if (!this.pending) {
            const account = this.buildAccount({ id: newAccountId() });
            this.pending = account;
            // No saved login: initialize() only prepares the folder (its CalDAV password, an empty local copy).
            account.ready = account.service.initialize().catch((error) => console.warn(`[accounts] could not prepare a new account: ${error instanceof Error ? error.message : String(error)}`));
        }
        return this.pending;
    }

    /** "Add Account" is open (accounts exist and the sign-in page shows for another one). */
    isAddingAccount() {
        return this.adding && this.accounts.length > 0;
    }

    /** "Add Account": the sign-in page for another account. */
    addAccount() {
        this.adding = true;
        this.ensurePending();
        this.options.onStateChange?.();
    }

    /** Back from the sign-in page: the account being added is dropped (nothing of it was saved). */
    async cancelAddAccount() {
        this.adding = false;
        const pending = this.pending;
        this.pending = null;
        if (pending) {
            await this.discard(pending);
        }
        this.options.onStateChange?.();
    }

    /**
     * Proton accepted the login of the account being added (BridgeService.signIn, before its first
     * sync): it gets its CalDAV user name and joins the list. An account restored at start is not
     * pending: nothing to do.
     */
    private adopt(service: BridgeService) {
        const pending = this.pending;
        if (!pending || pending.entry.id !== service.accountId) {
            return; // (the service calls with its real object, not the wrapped one: compare IDs)
        }
        service.getConfigStore().update({ caldavUsername: caldavUsernameFor(pending.entry.id) });
        this.pending = null;
        this.adding = false;
        this.accounts.push(pending);
        this.writeEntries();
        console.log(`[accounts] account ${pending.entry.id} added (${this.accounts.length} now)`);
        this.options.onStateChange?.();
    }

    private async discard(account: Account) {
        await account.ready.catch(() => undefined);
        // A sign-in still running ends here (the session count moves on; a Proton session made is ended).
        await account.service.signOut().catch(() => undefined);
        await account.service.shutdown().catch(() => undefined);
        try {
            rmSync(account.dir, { recursive: true, force: true });
        } catch (error) {
            console.warn(`[accounts] could not remove the folder of account ${account.entry.id}: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    /**
     * Sign out: the account's session ends, its local copy and saved login go; the
     * account stays in the list, signed out, with its CalDAV password, settings and Calendar.app
     * profile — signing in again picks up where it was.
     */
    async signOutAccount(id: string) {
        await this.serviceOf(id).signOut();
        this.options.onStateChange?.();
    }

    /** Remove: signed out, and the account leaves the list with its folder (local copy, settings, CalDAV password). */
    async removeAccount(id: string) {
        const account = this.byId(id);
        if (!account) {
            throw new Error(`Unknown account: ${id}`);
        }
        this.accounts = this.accounts.filter((entry) => entry !== account);
        this.writeEntries();
        await this.discard(account);
        console.log(`[accounts] account ${id} removed (${this.accounts.length} left)`);
        this.options.onStateChange?.();
    }

    /** The order the window, the Overview and the menu show: every ID, in the new order. */
    setOrder(ids: string[]) {
        const wanted = ids.filter((id, index) => typeof id === 'string' && ids.indexOf(id) === index);
        const known = new Set(this.accounts.map((account) => account.entry.id));
        if (wanted.length !== known.size || wanted.some((id) => !known.has(id))) {
            throw new Error('The order must name every account once');
        }
        this.accounts = wanted.map((id) => this.byId(id)!);
        this.writeEntries();
        this.options.onStateChange?.();
    }

    // ── Across accounts ────────────────────────────────────────────────────────

    /**
     * Settings: an account's own keys go to that account (the one being added when none is named);
     * app-wide keys to every account, so each applies its side effects (timers, logging, policy) —
     * they share the file.
     */
    async updateConfig(patch: BridgeConfigPatch, accountId?: string | null) {
        const entries = Object.entries(patch || {});
        const ownPatch = Object.fromEntries(entries.filter(([key]) => isAccountConfigKey(key))) as BridgeConfigPatch;
        const sharedPatch = Object.fromEntries(entries.filter(([key]) => !isAccountConfigKey(key))) as BridgeConfigPatch;
        if (Object.keys(ownPatch).length) {
            await this.serviceOf(accountId).updateConfig(ownPatch);
        }
        if (Object.keys(sharedPatch).length) {
            const services = this.accounts.length ? this.list() : [this.ensurePending().service];
            // The first one validates (and throws) for all; the rest only follow.
            for (const service of services) {
                await service.updateConfig(sharedPatch);
            }
            if (this.accounts.length && this.pending) {
                await this.pending.service.updateConfig(sharedPatch).catch(() => undefined);
            }
        }
        return this.getAppState();
    }

    /** Refresh Now: one account, or every one (null). */
    async refreshNow(accountId: string | null): Promise<SyncStatus> {
        if (accountId) {
            return this.serviceOf(accountId).refreshNow();
        }
        const statuses = await Promise.all(this.list().map((service) => service.refreshNow()));
        return statuses[0] ?? this.serviceOf(null).getSyncStatus();
    }

    handleSystemResume() {
        for (const service of this.list()) {
            service.handleSystemResume();
        }
    }

    refreshLoginItem() {
        (this.accounts[0]?.service ?? this.pending?.service)?.refreshLoginItem();
    }

    getThemePreference() {
        return this.sharedConfig.load().theme;
    }

    getAppLanguagePreference() {
        return this.sharedConfig.load().appLanguage || 'system';
    }

    // ── What the window and the menu show ──────────────────────────────────────

    async getAppState(): Promise<BridgeAppState> {
        const signingIn = this.accounts.length === 0 || this.adding ? this.ensurePending() : this.pending;
        await signingIn?.ready;
        const [accounts, pendingState] = await Promise.all([
            Promise.all(this.accounts.map((account) => account.service.getBridgeState())),
            signingIn ? signingIn.service.getBridgeState() : Promise.resolve(null)
        ]);
        return { accounts, signingIn: pendingState, addingAccount: this.adding && this.accounts.length > 0 };
    }

    getTrayState(): TrayAppState {
        return {
            accounts: this.accounts.map((account) => ({ ...account.service.getTrayState(), id: account.entry.id })),
            signingIn: this.pending?.service.getTrayState() ?? null
        };
    }
}
