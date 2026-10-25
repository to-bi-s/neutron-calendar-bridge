/**
 * Several accounts (0.36): the one account from before moves into accounts/<id>/ and stays the
 * first; a new account is signed in on the sign-in page and joins the list with its own CalDAV user
 * name; app-wide settings are shared, an account's own are not; the order is kept; signing out
 * removes an account; the CalDAV server tells the principals apart.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { fakeSafeStorage } from './support/fake-safe-storage';
import { basicAuth } from './support/caldav-login';

const stubElectron = () => {
    const resolved = require.resolve('electron');
    require.cache[resolved] = {
        id: resolved,
        filename: resolved,
        loaded: true,
        exports: { app: { setLoginItemSettings: () => undefined, isPackaged: false }, safeStorage: fakeSafeStorage }
    } as unknown as NodeJS.Module;
};
stubElectron();

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { AccountManager, caldavUsernameFor, PROFILE_IDENTIFIER_BASE } = require('../src/main/accounts') as typeof import('../src/main/accounts');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { BridgeService } = require('../src/main/bridge-service') as typeof import('../src/main/bridge-service');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { CalDAVServer } = require('../src/main/caldav-server') as typeof import('../src/main/caldav-server');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { SecretStore } = require('../src/main/secret-store') as typeof import('../src/main/secret-store');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { ConfigStore } = require('../src/main/config-store') as typeof import('../src/main/config-store');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { accountTag, currentAccount, inAccountContext, logPrefix } = require('../src/main/account-context') as typeof import('../src/main/account-context');

const PORT = 33011;

/** A Proton that accepts every login and has no calendars. */
const fakeAdapter = () => {
    let username: string | null = null;
    return {
        signIn: async (credentials: { username: string }) => {
            username = credentials.username;
            return 1;
        },
        signOut: async () => {
            username = null;
        },
        isSignedIn: () => username !== null,
        getSignedInUsername: () => username,
        currentGeneration: () => 1,
        supportsSeriesSync: () => true,
        listAddresses: async () => (username ? [{ email: username, status: 1, order: 1 }] : []),
        listCalendars: async () => [],
        listEvents: async () => [],
        getAccountChanges: async () => ({ cursor: 'c1', more: false, calendars: false, mail: false })
    };
};

const quiet = () => {
    const original = { log: console.log, warn: console.warn, error: console.error };
    console.log = () => undefined;
    console.warn = () => undefined;
    console.error = () => undefined;
    return () => Object.assign(console, original);
};

/** Every manager made by a test, shut down at its end even when it failed (a running one keeps the process alive). */
const managers: Array<InstanceType<typeof AccountManager>> = [];
const makeManager = (userData: string, onNotify?: (note: unknown) => void) => {
    const manager = new AccountManager(userData, {
        createService: (dir, options) => {
            const service = new BridgeService(dir, options) as any;
            service.protonAdapter = fakeAdapter();
            service.probeConnection = async () => true;
            return service;
        },
        onNotify: onNotify as never,
        appVersion: '0.36.0'
    });
    // The test's own port: the real bridge may be running on the default one. (Written before
    // initialize(): an app-wide write must not drop the account keys a config from before 0.36 holds.)
    manager.sharedConfig.update({ caldavPort: PORT });
    managers.push(manager);
    return manager;
};
const shutdownAll = async () => {
    await Promise.allSettled(managers.splice(0).map((manager) => manager.shutdown()));
};

test('CalDAV user names for new accounts: from the ID, never the address (the path is in every log line)', () => {
    assert.equal(caldavUsernameFor('3f9a2c1d'), 'neutron-3f9a2c1d');
});

test("log lines carry the account's tag: a wrapped service's methods, their awaits, timers and callbacks run in its context", async () => {
    class Thing {
        private secret = 'kept';
        seen: string[] = [];
        sync() {
            this.seen.push(logPrefix());
            return this.secret;
        }
        async later() {
            await new Promise((resolve) => setTimeout(resolve, 5));
            this.seen.push(logPrefix());
            setTimeout(() => this.seen.push(`timer ${logPrefix()}`), 5);
            await new Promise((resolve) => setTimeout(resolve, 15));
        }
    }
    const raw = new Thing();
    const wrapped = inAccountContext(raw, { id: '3f9a2c1d', tag: accountTag('3f9a2c1d'), label: () => 'tobi@proton.me' });
    assert.equal(accountTag('3f9a2c1d'), 'a:3f9a');
    assert.equal(logPrefix(), '', 'outside an account: no prefix');
    assert.equal(wrapped.sync(), 'kept', 'private fields work: `this` is the real object');
    await wrapped.later();
    assert.deepEqual(raw.seen, ['[a:3f9a] ', '[a:3f9a] ', 'timer [a:3f9a] '], 'the quiet log shows the tag, not the address');
    assert.equal(currentAccount(), null);
    wrapped.seen = [];
    assert.deepEqual(raw.seen, [], 'writes go through');
});

test('the first account is signed in and gets its own principal and profile identity; a second one is added, ordered, shared settings split, removed', async () => {
    const restore = quiet();
    const userData = mkdtempSync(join(tmpdir(), 'neutron-calendar-bridge-accounts-'));
    const notes: any[] = [];
    try {
        const manager = makeManager(userData, (note) => notes.push(note));
        assert.equal(manager.isLoaded(), false, '0.46: the menu shows "Connecting…" until the list is read');
        const starting = manager.initialize();
        assert.equal(manager.isLoaded(), true, '0.46: read before the accounts sign in and sync: the menu lists them at once');
        await starting;
        assert.equal(manager.count(), 0, 'a fresh start');
        await (await manager.signingIn()).signIn({ username: 'first@proton.me', password: 'pw' });
        assert.equal(manager.count(), 1);
        const first = manager.list()[0];
        const firstName = `neutron-${first.accountId}`;
        assert.equal(first.isSignedIn(), true);
        assert.equal(first.accountLabel(), 'first@proton.me');
        assert.equal(first.getCalDAVConfig().username, firstName, 'its CalDAV user name comes from its ID');
        assert.match(first.getCalDAVProfile(), new RegExp(`<string>${PROFILE_IDENTIFIER_BASE.replace(/\\./g, '\\\\.')}\\.${first.accountId}</string>`), 'its Calendar.app profile identity');
        assert.match(first.getCalDAVProfile(), /<string>Proton \(first@proton\.me\)<\/string>/, 'named after the address in Calendar.app');
        const entries = JSON.parse(readFileSync(join(userData, 'accounts.json'), 'utf8')).accounts;
        assert.deepEqual(entries, [{ id: first.accountId }]);
        const firstDir = join(userData, 'accounts', entries[0].id);
        assert.ok(existsSync(join(firstDir, 'secrets.json')), 'the saved login lives in the account folder');
        assert.ok(!existsSync(join(userData, 'secrets.json')));
        assert.ok(existsSync(join(firstDir, 'mirror.db')), 'so does the local copy');
        // App-wide settings go to the app's config.json, an account's own to its folder.
        await manager.updateConfig({ theme: 'dark' });
        await manager.updateConfig({ calendarEmailsFolder: 'Meetings' }, first.accountId);
        const ownConfig = JSON.parse(readFileSync(join(firstDir, 'config.json'), 'utf8'));
        assert.equal(ownConfig.calendarEmailsFolder, 'Meetings', "the account's settings");
        assert.equal(ownConfig.theme, undefined, 'app-wide settings stay out of the account file');
        assert.equal(first.getConfigStore().load().theme, 'dark', 'the service sees both');
        assert.equal(first.getConfigStore().load().calendarEmailsFolder, 'Meetings');
        assert.equal(manager.getThemePreference(), 'dark');

        let state = await manager.getAppState();
        assert.equal(state.accounts.length, 1);
        assert.equal(state.signingIn, null, 'no sign-in page while an account exists');
        assert.equal(state.addingAccount, false);
        assert.equal(state.accounts[0].accountLabel, 'first@proton.me');
        assert.equal(state.accounts[0].accountId, entries[0].id);

        // Add Account: the sign-in page talks to a pending service; signing in adopts it.
        manager.addAccount();
        state = await manager.getAppState();
        assert.ok(state.signingIn, 'the sign-in page');
        assert.equal(state.addingAccount, true);
        assert.equal(state.signingIn!.signedIn, false);
        await (await manager.signingIn()).signIn({ username: 'second@proton.me', password: 'pw' });
        assert.equal(manager.count(), 2);
        state = await manager.getAppState();
        assert.equal(state.signingIn, null);
        assert.equal(state.addingAccount, false);
        const second = manager.list()[1];
        assert.equal(second.accountLabel(), 'second@proton.me');
        assert.equal(second.getCalDAVConfig().username, `neutron-${second.accountId}`, 'its own principal, anonymous');
        assert.notEqual(second.getCalDAVConfig().password, first.getCalDAVConfig().password, 'its own CalDAV password');
        assert.match(second.getCalDAVProfile(), new RegExp(`<string>${PROFILE_IDENTIFIER_BASE.replace(/\\./g, '\\\\.')}\\.${second.accountId}</string>`), 'its own profile identity');
        assert.match(second.getCalDAVProfile(), /<string>Proton \(second@proton\.me\)<\/string>/, 'named after the address in Calendar.app');
        assert.equal(manager.byUsername(`neutron-${second.accountId}`), second);
        assert.equal(manager.byUsername(firstName), first);
        assert.equal(manager.byUsername('nobody'), null);
        assert.equal(JSON.parse(readFileSync(join(userData, 'accounts.json'), 'utf8')).accounts.length, 2);

        // Settings: app-wide ones reach every account; an account's own stay with it.
        await manager.updateConfig({ theme: 'light' });
        assert.equal(first.getConfigStore().load().theme, 'light');
        assert.equal(second.getConfigStore().load().theme, 'light');
        await manager.updateConfig({ calendarEmailsFolder: 'Second' }, second.accountId);
        assert.equal(second.getConfigStore().load().calendarEmailsFolder, 'Second');
        assert.equal(first.getConfigStore().load().calendarEmailsFolder, 'Meetings', 'untouched');
        assert.deepEqual(readdirSync(join(userData, 'accounts')).length, 2);

        // Calls into an account's service run in its context (its log lines carry the tag).
        let prefixSeen = '';
        second.probeConnection = async () => {
            prefixSeen = logPrefix();
            return true;
        };
        await second.probeConnection();
        assert.equal(prefixSeen, `[${accountTag(second.accountId!)}] `);

        // Notifications name the account while there are several.
        notes.length = 0;
        (second as any).notify({ key: 'test', title: 'T', body: 'B', page: 'overview' });
        assert.equal(notes.length, 1);
        assert.equal(notes[0].subtitle, 'second@proton.me');
        assert.equal(notes[0].key, `${second.accountId}:test`);
        assert.equal(notes[0].accountId, second.accountId);

        // The order.
        manager.setOrder([second.accountId!, first.accountId!]);
        assert.deepEqual(manager.list(), [second, first]);
        assert.deepEqual(manager.getTrayState().accounts.map((account) => account.username), ['second@proton.me', 'first@proton.me']);
        assert.deepEqual(JSON.parse(readFileSync(join(userData, 'accounts.json'), 'utf8')).accounts.map((entry: any) => entry.id), [second.accountId, first.accountId]);
        assert.throws(() => manager.setOrder([first.accountId!]), /every account once/);
        assert.throws(() => manager.setOrder([first.accountId!, second.accountId!, 'deadbeef']), /every account once/);

        // The CalDAV server serves both principals, each with its own password.
        const server = new CalDAVServer({ list: () => manager.list(), byUsername: (name) => manager.byUsername(name), any: () => manager.serviceOf(null), listenOn: () => manager.listenOn() });
        const secondName = `neutron-${second.accountId}`;
        const config = first.getCalDAVConfig();
        assert.equal(config.port, PORT, "the test's port, not the bridge's");
        const base = `http://127.0.0.1:${config.port}`;
        const propfind = (path: string, username: string, password: string) =>
            fetch(`${base}${path}`, { method: 'PROPFIND', headers: { Authorization: basicAuth(username, password), Depth: '0' }, body: '<D:propfind xmlns:D="DAV:"><D:prop><D:current-user-principal/></D:prop></D:propfind>' });
        await server.start();
        try {
            const mine = await propfind(`/principals/${secondName}/`, secondName, second.getCalDAVConfig().password);
            assert.equal(mine.status, 207);
            assert.match(await mine.text(), new RegExp(`/principals/${secondName}/`));
            const theirs = await propfind(`/principals/${firstName}/`, firstName, first.getCalDAVConfig().password);
            assert.equal(theirs.status, 207);
            assert.match(await theirs.text(), new RegExp(`/principals/${firstName}/`));
            const wrong = await propfind(`/principals/${secondName}/`, secondName, first.getCalDAVConfig().password);
            assert.equal(wrong.status, 401, "the other account's password does not open this principal");
            const anyName = await propfind(`/principals/${firstName}/`, 'whatever', first.getCalDAVConfig().password);
            assert.equal(anyName.status, 207, 'the path says which account; the user name sent may be an old one');
            const byLogin = await fetch(`${base}/`, { method: 'PROPFIND', headers: { Authorization: basicAuth(secondName, second.getCalDAVConfig().password), Depth: '0' }, body: '<D:propfind xmlns:D="DAV:"><D:prop><D:current-user-principal/></D:prop></D:propfind>' });
            assert.equal(byLogin.status, 207);
            assert.match(await byLogin.text(), new RegExp(`/principals/${secondName}/`), 'no account in the path: the login says');
            const unknown = await fetch(`${base}/`, { method: 'PROPFIND', headers: { Authorization: basicAuth('nobody', 'x'), Depth: '0' } });
            assert.equal(unknown.status, 401, 'several accounts and none named: sign in and say');
            const options = await fetch(`${base}/`, { method: 'OPTIONS' });
            assert.equal(options.status, 204, 'OPTIONS needs no account');
        } finally {
            await server.stop();
        }

        // Signing out keeps the account (its folder, CalDAV password, settings), signed out.
        const firstPassword = first.getCalDAVConfig().password;
        await manager.signOutAccount(first.accountId!);
        assert.equal(manager.count(), 2);
        assert.equal(first.isSignedIn(), false);
        assert.equal(first.getCalDAVConfig().password, firstPassword, 'Calendar.app keeps working with its password once signed in again');
        assert.equal(first.getConfigStore().load().calendarEmailsFolder, 'Meetings', 'settings kept');
        assert.ok(existsSync(firstDir));
        state = await manager.getAppState();
        assert.equal(state.accounts[1].signedIn, false, 'listed, signed out (second in the order)');
        await (await manager.signingIn(first.accountId)).signIn({ username: 'first@proton.me', password: 'pw' });
        assert.equal(first.isSignedIn(), true, 'signed in again in place');
        assert.equal(first.getCalDAVConfig().username, firstName, 'still its principal');

        // A signed-out account survives a restart, listed and signed out, with its folder.
        await manager.signOutAccount(first.accountId!);
        await manager.shutdown();
        const restarted = makeManager(userData);
        await restarted.initialize();
        assert.equal(restarted.count(), 2, 'both listed');
        const firstAgain = restarted.list().find((service) => service.accountId === first.accountId)!;
        assert.equal(firstAgain.isSignedIn(), false);
        assert.equal(firstAgain.getCalDAVConfig().username, firstName);
        assert.equal(firstAgain.getCalDAVConfig().password, firstPassword);
        assert.ok(existsSync(firstDir));
        await (await restarted.signingIn(first.accountId)).signIn({ username: 'first@proton.me', password: 'pw' });
        assert.equal(firstAgain.isSignedIn(), true);
        await restarted.shutdown();
        // Back to the first manager's view for the rest (same folders).
        await manager.initialize(); // already initialized: no-op
        const resumed = makeManager(userData);
        await resumed.initialize();
        await resumed.setOrder([second.accountId!, first.accountId!]);
        await resumed.shutdown();

        // Removing takes the account out of the list, its folder included.
        await manager.removeAccount(first.accountId!);
        assert.equal(manager.count(), 1);
        assert.equal(manager.byUsername(firstName), null);
        assert.ok(!existsSync(firstDir), 'the folder is gone');
        assert.equal(JSON.parse(readFileSync(join(userData, 'accounts.json'), 'utf8')).accounts.length, 1);
        await manager.shutdown();

        // The next start reads the list.
        const again = makeManager(userData);
        await again.initialize();
        assert.equal(again.count(), 1);
        assert.equal(again.list()[0].accountLabel(), 'second@proton.me');
        assert.equal(again.list()[0].getCalDAVConfig().username, secondName);
        assert.equal(again.getThemePreference(), 'light');
        await again.shutdown();

        // The list lost or unreadable: the folders say what there is (a saved login = an account).
        writeFileSync(join(userData, 'accounts.json'), '{ not json');
        const healed = makeManager(userData);
        await healed.initialize();
        assert.equal(healed.count(), 1, 'the folder with a saved login is taken back');
        assert.equal(healed.list()[0].accountLabel(), 'second@proton.me');
        assert.equal(JSON.parse(readFileSync(join(userData, 'accounts.json'), 'utf8')).accounts.length, 1, 'and listed again');
        await healed.shutdown();
        rmSync(join(userData, 'accounts.json'));
        const noList = makeManager(userData);
        await noList.initialize();
        assert.equal(noList.count(), 1, 'no list at all: the same');
        await noList.shutdown();
    } finally {
        await shutdownAll();
        restore();
        rmSync(userData, { recursive: true, force: true });
    }
});

test('0.39: a lost or damaged accounts.json is rebuilt in the order of the last list written (accounts.json.bak)', async () => {
    const restore = quiet();
    const userData = mkdtempSync(join(tmpdir(), 'neutron-calendar-bridge-accounts-'));
    try {
        const manager = makeManager(userData);
        await manager.initialize();
        for (const name of ['one@proton.me', 'two@proton.me', 'three@proton.me']) {
            if (manager.count()) manager.addAccount();
            await (await manager.signingIn()).signIn({ username: name, password: 'pw' });
        }
        const ids = manager.list().map((service) => service.accountId!);
        const chosen = [ids[2], ids[0], ids[1]];
        manager.setOrder(chosen);
        await manager.shutdown();
        const backup = JSON.parse(readFileSync(join(userData, 'accounts.json.bak'), 'utf8')).accounts.map((entry: any) => entry.id);
        assert.deepEqual(backup, chosen, 'the copy follows every write');

        const orderAfter = async (label: string) => {
            const again = makeManager(userData);
            await again.initialize();
            const order = again.list().map((service) => service.accountId);
            await again.shutdown();
            return order;
        };
        writeFileSync(join(userData, 'accounts.json'), '{ not json');
        assert.deepEqual(await orderAfter('damaged'), chosen, 'a damaged list: the order from the copy');
        assert.deepEqual(JSON.parse(readFileSync(join(userData, 'accounts.json'), 'utf8')).accounts.map((entry: any) => entry.id), chosen, 'and written again');
        rmSync(join(userData, 'accounts.json'));
        assert.deepEqual(await orderAfter('missing'), chosen, 'a missing list: the same');

        // The copy names fewer accounts than there are folders: the rest join at the end.
        writeFileSync(join(userData, 'accounts.json.bak'), JSON.stringify({ accounts: [{ id: chosen[1] }] }));
        rmSync(join(userData, 'accounts.json'));
        const partial = await orderAfter('partial');
        assert.equal(partial[0], chosen[1]);
        assert.deepEqual([...partial].sort(), [...chosen].sort(), 'no account lost');
    } finally {
        await shutdownAll();
        restore();
        rmSync(userData, { recursive: true, force: true });
    }
});

test('a fresh start has no account: the server starts, the sign-in page signs the first one in; cancelling "Add Account" drops the pending one', async () => {
    const restore = quiet();
    const userData = mkdtempSync(join(tmpdir(), 'neutron-calendar-bridge-accounts-'));
    try {
        const manager = makeManager(userData);
        await manager.initialize();
        assert.equal(manager.count(), 0);
        // The CalDAV server starts before anyone signed in (main.ts order), on the app's port.
        const server = new CalDAVServer({ list: () => manager.list(), byUsername: (name) => manager.byUsername(name), any: () => manager.serviceOf(null), listenOn: () => manager.listenOn() });
        await server.start();
        try {
            const answer = await fetch(`http://127.0.0.1:${manager.listenOn().port}/principals/x/`, { method: 'PROPFIND', headers: { Authorization: basicAuth('x', 'x'), Depth: '0' } });
            assert.ok([401, 503].includes(answer.status), `nobody signed in: ${answer.status}`);
        } finally {
            await server.stop();
        }
        let state = await manager.getAppState();
        assert.ok(state.signingIn, 'the sign-in page');
        assert.equal(state.addingAccount, false, 'nothing to go back to');
        assert.equal(manager.getTrayState().accounts.length, 0);
        assert.ok(manager.getTrayState().signingIn);
        await (await manager.signingIn()).signIn({ username: 'first@proton.me', password: 'pw' });
        assert.equal(manager.count(), 1);
        const first = manager.list()[0];
        assert.equal(first.getCalDAVConfig().username, `neutron-${first.accountId}`, 'from its ID');
        assert.match(first.getCalDAVProfile(), /Proton \(first@proton\.me\)/);

        assert.equal(manager.isAddingAccount(), false);
        manager.addAccount();
        assert.equal(manager.isAddingAccount(), true, 'what the window asks when it is closed');
        state = await manager.getAppState();
        assert.ok(state.signingIn);
        assert.equal(state.addingAccount, true);
        assert.equal(readdirSync(join(userData, 'accounts')).length, 2, 'the pending account has a folder');
        // Cancelled while its sign-in still runs: the sign-in ends with nothing kept.
        const slow = manager.signingInService() as any;
        let release: () => void = () => undefined;
        slow.protonAdapter.signIn = () => new Promise<number>((resolve) => (release = () => resolve(1)));
        const signingIn = (await manager.signingIn()).signIn({ username: 'late@proton.me', password: 'pw' }).catch((error: Error) => error);
        await manager.cancelAddAccount();
        assert.equal(manager.isAddingAccount(), false);
        release();
        await signingIn;
        state = await manager.getAppState();
        assert.equal(state.signingIn, null);
        assert.equal(manager.count(), 1, 'not adopted');
        assert.equal(readdirSync(join(userData, 'accounts')).length, 1, 'dropped');
        await manager.shutdown();

        // A listed account without a folder is dropped; a folder without a login (a sign-in that never finished) is removed.
        writeFileSync(join(userData, 'accounts.json'), JSON.stringify({ accounts: [{ id: first.accountId }, { id: 'abcdef01' }] }));
        mkdirSync(join(userData, 'accounts', 'deadbeef'), { recursive: true });
        const again = makeManager(userData);
        await again.initialize();
        assert.equal(again.count(), 1);
        assert.equal(JSON.parse(readFileSync(join(userData, 'accounts.json'), 'utf8')).accounts.length, 1, 'the list is corrected');
        assert.deepEqual(readdirSync(join(userData, 'accounts')), [first.accountId], 'the stray folder is gone');
        await again.shutdown();
    } finally {
        await shutdownAll();
        restore();
        rmSync(userData, { recursive: true, force: true });
    }
});
