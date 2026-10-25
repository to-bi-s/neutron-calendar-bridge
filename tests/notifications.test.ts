/**
 * macOS notifications (stage 1, 0.21) and syncing after wake-up or a lost connection. The bridge
 * decides what to say (notification-center.ts groups bursts; main.ts shows them). Checks: the exact
 * reason when Calendar.app's change was refused or only partly saved, nothing for reads or outdated
 * copies (412), failed changes not repeated while Calendar.app retries them, the switch in Settings;
 * after waking up: Proton's ping first, then a pass of its own; a failed pass: Proton's ping tells a
 * lost connection (watched every 15 s, notified after 5 minutes awake, synced at once when back after
 * more than 2) from Proton refusing (no extra requests, notified after 5 passes); polling and the
 * saved login when the first try fails.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fakeSafeStorage } from './support/fake-safe-storage';

const electronApp: any = { setLoginItemSettings: () => undefined, isPackaged: false };
const stubElectron = () => {
    const resolved = require.resolve('electron');
    require.cache[resolved] = {
        id: resolved,
        filename: resolved,
        loaded: true,
        exports: { app: electronApp, safeStorage: fakeSafeStorage }
    } as unknown as NodeJS.Module;
};

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const until = async (condition: () => boolean, ms = 2000) => {
    const started = Date.now();
    while (!condition() && Date.now() - started < ms) await wait(5);
};

const setup = async () => {
    stubElectron();
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { BridgeService } = require('../src/main/bridge-service') as typeof import('../src/main/bridge-service');
    const baseDir = mkdtempSync(join(tmpdir(), 'neutron-calendar-bridge-notify-'));
    const service = new BridgeService(baseDir) as any;
    await service.mirrorDatabase.initialize();
    service.localCaldavPassword = 'test';
    let reachable = true;
    let listingError: string | null = null;
    const counts = { listCalendars: 0, probes: 0 };
    let probe = true;
    service.probeConnection = async () => {
        counts.probes += 1;
        return probe;
    };
    service.protonAdapter = {
        isSignedIn: () => true,
        getSignedInUsername: () => 'tobi',
        supportsSeriesSync: () => true,
        listAddresses: () => [],
        listCalendars: async () => {
            counts.listCalendars += 1;
            if (!reachable) throw new Error('fetch failed');
            if (listingError) throw new Error(listingError);
            return [{ id: 'private', name: 'Tobi (Private)', color: '#6d4aff', visible: true, writable: true }];
        },
        listEvents: async () => [{
            calendarId: 'private', eventId: 'ev-1', uid: 'team@uni.nl', title: 'Team meeting', description: '', location: '',
            startTimestamp: Date.UTC(2026, 9, 7, 12) / 1000, endTimestamp: Date.UTC(2026, 9, 7, 13) / 1000,
            timezone: 'UTC', isAllDay: false, modifiedTimestamp: 1_790_000_000, contentHash: 'h1'
        }],
        signOut: async () => undefined
    };
    const notes: any[] = [];
    service.onNotify = (note: any) => notes.push(note);
    const logs: string[] = [];
    const original = { log: console.log, warn: console.warn };
    console.log = (...parts: unknown[]) => logs.push(parts.join(' '));
    console.warn = (...parts: unknown[]) => logs.push(`WARN ${parts.join(' ')}`);
    const cleanup = async () => {
        service.stopPolling();
        console.log = original.log;
        console.warn = original.warn;
        await service.mirrorDatabase.close();
        rmSync(baseDir, { recursive: true, force: true });
    };
    return {
        service, notes, logs, cleanup, counts,
        setReachable: (value: boolean) => { reachable = value; },
        setProbe: (value: boolean) => { probe = value; },
        setListingError: (value: string | null) => { listingError = value; }
    };
};

test('refused Calendar.app changes: a notification with the exact reason', async () => {
    const { service, notes, cleanup } = await setup();
    try {
        await service.performSync();
        const [calendar] = await service.mirrorDatabase.listCalendars();
        const path = `/calendars/neutron-calendar-bridge/${calendar.slug}/${encodeURIComponent('team@uni.nl')}.ics`;
        const record = (method: string, status: number, message: string, target = path, partial?: boolean) =>
            service.recordCalDAVError({ at: Date.now(), method, path: target, status, message, ...(partial ? { partial } : {}) });

        record('PUT', 403, 'Test mode: carla@example.org is not on the allowed list; nothing was changed in Proton.');
        await until(() => notes.length === 1);
        assert.deepEqual(notes[0], {
            key: `caldav:PUT:${path}:Test mode: carla@example.org is not on the allowed list; nothing was changed in Proton.`,
            title: 'Change not saved',
            subtitle: 'Team meeting — Tobi (Private)',
            body: 'Test mode: carla@example.org is not on the allowed list; nothing was changed in Proton.',
            page: 'calendars'
        });

        // Saved after all, only without a guest: decided by the error's flag, not by the (translated) wording.
        record('PUT', 403, 'Ohne dan@uni.invalid (Proton cannot email this address) gespeichert; die anderen Änderungen wurden übernommen.', path, true);
        await until(() => notes.length === 2);
        assert.equal(notes[1].title, 'Saved, with changes');

        record('DELETE', 500, 'Proton did not answer');
        await until(() => notes.length === 3);
        assert.equal(notes[2].title, 'Change failed');

        // Not worth a notification: an outdated copy (Calendar.app re-reads by itself), reads, searches.
        record('PUT', 412, 'The event changed in Proton meanwhile');
        record('REPORT', 404, 'Not found', '/principals/');
        record('GET', 404, 'Not found');
        await wait(50);
        assert.equal(notes.length, 3);

        // A new event Calendar.app tried to create: no title known, the calendar still named.
        record('PUT', 403, 'Moving a meeting to another calendar is not supported', `/calendars/neutron-calendar-bridge/${calendar.slug}/NEW-EVENT.ics`);
        await until(() => notes.length === 4);
        assert.equal(notes[3].subtitle, 'Tobi (Private)');

        // Switched off in Settings.
        await service.updateConfig({ notifications: false });
        record('PUT', 403, 'Dry run: nothing was sent or changed');
        await wait(50);
        assert.equal(notes.length, 4);
        assert.equal((await service.getBridgeState()).notifications, false);
        await assert.rejects(service.updateConfig({ notifications: 'yes' }), /notifications must be true or false/);
    } finally {
        await cleanup();
    }
});

test('changes Proton failed to save: not repeated while Calendar.app retries them, nothing while Proton is gone', async () => {
    const { service, notes, cleanup, setReachable, setProbe } = await setup();
    try {
        await service.performSync();
        const [calendar] = await service.mirrorDatabase.listCalendars();
        const path = (name: string) => `/calendars/neutron-calendar-bridge/${calendar.slug}/${name}.ics`;
        const record = (target: string, status = 500, message = 'Proton did not answer') =>
            service.recordCalDAVError({ at: Date.now(), method: 'PUT', path: target, status, message });

        record(path('a'));
        record(path('a')); // Calendar.app retries it
        record(path('a'), 500, 'Another error');
        record(path('%E0%A4%A')); // not valid percent-encoding: still notified, nothing thrown
        await wait(50);
        assert.deepEqual(notes.map((note) => note.title), ['Change failed', 'Change failed']);

        // Proton cannot be reached: the connection has its own notification.
        setReachable(false);
        setProbe(false);
        await assert.rejects(service.performSync(), /fetch failed/);
        record(path('b'));
        await wait(50);
        assert.equal(notes.length, 2);
        // Refusals (403) still say why.
        record(path('c'), 403, 'Test mode: carla@example.org is not on the allowed list; nothing was changed in Proton.');
        await until(() => notes.length === 3);
        assert.equal(notes[2].title, 'Change not saved');
    } finally {
        await cleanup();
    }
});

test('after waking up: a ping to Proton first, then a pass of its own', async () => {
    const { service, logs, counts, cleanup, setProbe } = await setup();
    try {
        const syncs: Array<[string, boolean]> = [];
        service.syncNow = async (kind: string, ownPass: boolean) => { syncs.push([kind, ownPass]); };
        service.resumeSyncDelayMs = 10;
        service.resumeRetryMs = 10;
        setProbe(false); // the Wi-Fi needs a moment
        service.handleSystemResume();
        service.handleSystemResume(); // several wake events: one sync
        await until(() => counts.probes >= 3);
        assert.deepEqual(syncs, [], 'no sync while Proton cannot be reached yet');
        setProbe(true);
        await until(() => syncs.length > 0);
        await wait(30);
        assert.deepEqual(syncs, [['auto', true]], 'one pass, not swallowed by one that started before the sleep');
        assert.ok(logs.some((line) => line === '[sync] the Mac woke up: syncing in a moment'));

        // Proton still gone after about a minute of tries: synced anyway (the pass fails, the watch takes over).
        setProbe(false);
        syncs.length = 0;
        counts.probes = 0;
        service.handleSystemResume();
        await until(() => syncs.length > 0);
        assert.equal(counts.probes, 12);
        assert.deepEqual(syncs, [['auto', true]]);
    } finally {
        await cleanup();
    }
});

test('a pass of its own waits for the running one instead of being skipped', async () => {
    const { service, counts, cleanup } = await setup();
    try {
        let release!: () => void;
        service.passInFlight = new Promise<void>((resolve) => { release = resolve; });
        const skipped = service.syncNow('auto');
        const own = service.syncNow('auto', true);
        release();
        service.passInFlight = null;
        await Promise.all([skipped, own]);
        assert.equal(counts.listCalendars, 1, 'the regular sync was skipped, the wake-up sync ran');
    } finally {
        await cleanup();
    }
});

test('Proton unreachable: watched by its ping, notified after 5 minutes awake, synced at once when back after more than 2', async () => {
    const { service, notes, logs, counts, cleanup, setReachable, setProbe } = await setup();
    try {
        await service.performSync();
        setReachable(false);
        setProbe(false);
        await assert.rejects(service.performSync(), /fetch failed/);
        await service.outageCheck;
        assert.ok(service.outage, 'the ping failed too: Proton cannot be reached');
        assert.ok(service.connectivityTimer, 'watching for Proton to come back');

        const syncs: Array<[string, boolean]> = [];
        const realSyncNow = service.syncNow.bind(service);
        service.syncNow = async (kind: string, ownPass: boolean) => { syncs.push([kind, ownPass]); };

        // A short outage, back after a minute: the regular sync catches up, no extra sync.
        service.outage.awakeMs = 60 * 1000;
        setProbe(true);
        await service.checkConnectivity();
        assert.deepEqual(syncs, []);
        assert.equal(service.outage, null);
        assert.equal(service.connectivityTimer, null, 'stopped watching');
        assert.equal(notes.length, 0, 'no notification for a short outage');

        // A longer one.
        setProbe(false);
        await assert.rejects(realSyncNow('auto'), /fetch failed/);
        await service.outageCheck;
        // The Mac slept for three hours meanwhile: that is not time without Proton.
        service.outage.awakeMs = 4 * 60 * 1000;
        service.outage.lastCheckAt = Date.now() - 3 * 60 * 60 * 1000;
        await service.checkConnectivity();
        assert.equal(service.outage.awakeMs, 4.5 * 60 * 1000, 'a gap longer than two checks counts as 30 s');
        assert.equal(notes.length, 0, 'not yet 5 minutes awake');
        // Waking up starts the count from now as well.
        service.outage.lastCheckAt = Date.now() - 60 * 60 * 1000;
        service.handleSystemResume();
        assert.ok(Date.now() - service.outage.lastCheckAt < 1000);
        clearTimeout(service.resumeTimer);
        service.resumeTimer = null;

        // 5 minutes awake: notified once, after a failed ping.
        service.outage.awakeMs = 5 * 60 * 1000 - 1000;
        service.outage.lastCheckAt = Date.now() - 15 * 1000;
        await service.checkConnectivity();
        await service.checkConnectivity();
        assert.deepEqual(notes.map((note) => note.key), ['connection:lost']);
        assert.equal(notes[0].title, 'Proton cannot be reached');
        assert.match(notes[0].body, /^No answer for 5 minutes \(fetch failed\)\. Syncing waits until it is back\.$/);

        // Proton answers its ping: "connected again" (replacing the other one) and a sync at once.
        setProbe(true);
        await service.checkConnectivity();
        assert.deepEqual(syncs, [['auto', true]]);
        assert.ok(logs.some((line) => line === '[sync] connection back after 5 min: syncing now'));
        assert.deepEqual(notes[1], {
            key: 'connection:back',
            replaces: 'connection:lost',
            title: 'Connected to Proton again',
            body: 'Syncing now.',
            page: 'overview'
        });
        assert.equal(service.connectivityTimer, null);
        setReachable(true);
        await realSyncNow('auto');
        await realSyncNow('auto');
        assert.equal(notes.length, 2, '"connected again" once');
        assert.ok(counts.listCalendars >= 5);
    } finally {
        await cleanup();
    }
});

test('Proton answers but refuses the calendar list (e.g. 429): no extra requests, notified after 5 passes', async () => {
    const { service, notes, counts, cleanup, setListingError } = await setup();
    try {
        await service.performSync();
        setListingError('429 Too Many Requests');
        for (let pass = 1; pass <= 5; pass += 1) {
            await assert.rejects(service.performSync(), /429/);
            await service.outageCheck;
            assert.equal(service.outage, null, 'not an outage: Proton answers its ping');
            assert.equal(service.connectivityTimer, null, 'nothing polls Proton faster than the regular sync');
            if (pass === 1) {
                service.refusedPasses.since = Date.now() - 6 * 60 * 1000;
            }
        }
        assert.equal(counts.listCalendars, 6, 'one request per pass, nothing more');
        assert.deepEqual(notes.map((note) => note.title), ['Syncing keeps failing']);
        assert.match(notes[0].body, /refused the calendar list: 429 Too Many Requests\./);
        await assert.rejects(service.performSync(), /429/);
        await service.outageCheck;
        assert.equal(notes.length, 1, 'once');

        setListingError(null);
        await service.performSync();
        assert.deepEqual(notes.at(-1), {
            key: 'sync:works',
            replaces: 'sync:failing',
            title: 'Syncing works again',
            body: 'Proton sent the calendar list again.',
            page: 'overview'
        });
    } finally {
        await cleanup();
    }
});

test('the first sync after signing in fails: the regular sync runs anyway', async () => {
    const { service, cleanup, setListingError } = await setup();
    try {
        service.protonAdapter.signIn = async () => undefined;
        setListingError('Proton is busy');
        await assert.rejects(service.signIn({ username: 'tobi', password: 'secret' }, false), /Proton is busy/);
        assert.ok(service.syncTimer, 'polling started');
    } finally {
        await cleanup();
    }
});

test('offline at app start: the saved login is used once Proton answers; a wrong password is not retried', async () => {
    stubElectron();
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { BridgeService } = require('../src/main/bridge-service') as typeof import('../src/main/bridge-service');
    const baseDir = mkdtempSync(join(tmpdir(), 'neutron-calendar-bridge-start-'));
    const original = { log: console.log, warn: console.warn };
    console.log = () => undefined;
    console.warn = () => undefined;
    const services: any[] = [];
    try {
        const make = async (signInError: () => Error | null, reachable: boolean) => {
            const service = new BridgeService(baseDir) as any;
            services.push(service);
            await service.secretStore.setProtonCredentials({ username: 'tobi', password: 'secret' });
            let signedIn = false;
            const attempts: string[] = [];
            let probe = reachable;
            service.probeConnection = async () => probe;
            service.protonAdapter = {
                isSignedIn: () => signedIn,
                getSignedInUsername: () => (signedIn ? 'tobi' : null),
                supportsSeriesSync: () => true,
                listAddresses: () => [],
                signIn: async (credentials: any) => {
                    attempts.push(credentials.password);
                    const error = signInError();
                    if (error) throw error;
                    signedIn = true;
                },
                listCalendars: async () => [],
                listEvents: async () => [],
                signOut: async () => undefined
            };
            await service.initialize();
            return { service, attempts, setProbe: (value: boolean) => { probe = value; } };
        };

        let offline = true;
        const { service, attempts, setProbe } = await make(() => (offline ? new TypeError('fetch failed') : null), false);
        assert.deepEqual(attempts, ['secret']);
        assert.equal((await service.getBridgeState()).message, 'No connection to Proton. Signing in as soon as it can be reached.');
        assert.ok(service.signInRetryTimer, 'waiting for Proton');
        await service.retryPendingSignIn();
        assert.deepEqual(attempts, ['secret'], 'not while the ping fails');
        offline = false;
        setProbe(true);
        await service.retryPendingSignIn();
        assert.deepEqual(attempts, ['secret', 'secret']);
        assert.equal(service.protonAdapter.isSignedIn(), true);
        assert.equal(service.signInRetryTimer, null);
        assert.ok(service.syncTimer);
        service.stopPolling();
        await service.mirrorDatabase.close();

        // No answer at all although the ping (a moment later) works: the network just came up. Retried.
        let early = true;
        const racing = await make(() => (early ? Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } }) : null), true);
        assert.ok(racing.service.signInRetryTimer, 'a lack of connection, by the error itself');
        early = false;
        await racing.service.retryPendingSignIn();
        assert.equal(racing.service.protonAdapter.isSignedIn(), true);
        racing.service.stopPolling();
        await racing.service.mirrorDatabase.close();

        // Proton answers, the password is refused: shown, never tried again on its own.
        const refused = await make(() => new Error('Incorrect login credentials'), true);
        assert.equal(refused.service.signInRetryTimer, null);
        assert.equal(refused.service.pendingSignIn, null);
        assert.equal((await refused.service.getBridgeState()).message, 'Incorrect login credentials');
    } finally {
        console.log = original.log;
        console.warn = original.warn;
        for (const service of services) {
            service.stopPolling();
            await service.mirrorDatabase.close().catch(() => undefined);
        }
        rmSync(baseDir, { recursive: true, force: true });
    }
});

test('open on startup: registered again at start when macOS does not have it, and once when another build registered it', async () => {
    const { service, cleanup } = await setup();
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    const calls: unknown[] = [];
    let status = 'not-registered';
    Object.assign(electronApp, {
        isPackaged: true,
        getLoginItemSettings: () => ({ openAtLogin: status === 'enabled', status }),
        setLoginItemSettings: (settings: unknown) => calls.push(settings)
    });
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    try {
        service.refreshLoginItem();
        assert.deepEqual(calls, [], 'not wanted: left alone');

        service.configStore.update({ openAtLogin: true });
        assert.match((await service.getBridgeState()).openAtLoginNote, /does not have this app/);
        service.refreshLoginItem('/Users/me/neutron-calendar-bridge/release/mac-arm64/Neutron Calendar Bridge.app/Contents/MacOS/Neutron Calendar Bridge');
        assert.deepEqual(calls, [{ openAtLogin: true }]);

        status = 'enabled';
        service.loginItemStatusCache = null;
        service.refreshLoginItem('/Applications/Neutron Calendar Bridge.app/Contents/MacOS/Neutron Calendar Bridge');
        assert.equal(calls.length, 2, 'enabled, but registered by another build (the one in release/): registered once for this one');
        service.refreshLoginItem('/Applications/Neutron Calendar Bridge.app/Contents/MacOS/Neutron Calendar Bridge');
        assert.equal(calls.length, 2, 'registered for this app: nothing to do');
        assert.equal((await service.getBridgeState()).openAtLoginNote, null);

        status = 'requires-approval'; // switched off in System Settings: not forced back on
        service.loginItemStatusCache = null;
        service.refreshLoginItem('/somewhere/else');
        assert.equal(calls.length, 2);
        assert.match((await service.getBridgeState()).openAtLoginNote, /System Settings › General › Login Items/);
    } finally {
        Object.defineProperty(process, 'platform', platform);
        Object.assign(electronApp, { isPackaged: false, setLoginItemSettings: () => undefined });
        delete electronApp.getLoginItemSettings;
        await cleanup();
    }
});

test('signing out while a wake-up sync waits: nothing is synced after it', async () => {
    const { service, counts, cleanup } = await setup();
    try {
        await service.performSync();
        let releaseListing!: () => void;
        const adapter = service.protonAdapter;
        const listCalendars = adapter.listCalendars;
        adapter.listCalendars = async () => {
            await new Promise<void>((resolve) => { releaseListing = resolve; });
            return listCalendars();
        };
        let signedIn = true;
        adapter.isSignedIn = () => signedIn;
        adapter.signOut = async () => { signedIn = false; };

        const running = service.syncNow('auto').catch(() => undefined); // a regular pass, stuck on Proton
        await until(() => Boolean(releaseListing));
        const wakeUp = service.syncNow('auto', true); // the wake-up sync, waiting for it
        const signingOut = service.signOut();
        releaseListing();
        await Promise.all([running, wakeUp, signingOut]);
        assert.equal(counts.listCalendars, 2, 'only the pass that was already running');
        assert.deepEqual(await service.mirrorDatabase.listCalendars(true), [], 'nothing written after the sign-out');
        const state = await service.getBridgeState();
        assert.equal(state.health, 'disconnected');
        assert.equal(service.syncTimer, null);
    } finally {
        await cleanup();
    }
});

test('a ping that answers after a later pass got through does not start an outage', async () => {
    const { service, cleanup, setReachable } = await setup();
    try {
        await service.performSync();
        let answerPing!: (value: boolean) => void;
        service.probeConnection = () => new Promise<boolean>((resolve) => { answerPing = resolve; });
        setReachable(false);
        await assert.rejects(service.performSync(), /fetch failed/);
        setReachable(true);
        await service.performSync(); // the network came back before the ping answered
        answerPing(false);
        await service.outageCheck;
        assert.equal(service.outage, null);
        assert.equal(service.connectivityTimer, null);
    } finally {
        await cleanup();
    }
});

test('waking up after an outage: one sync, not one for waking and one for the connection', async () => {
    const { service, cleanup, setReachable, setProbe } = await setup();
    try {
        await service.performSync();
        setReachable(false);
        setProbe(false);
        await assert.rejects(service.performSync(), /fetch failed/);
        await service.outageCheck;
        const syncs: Array<[string, boolean]> = [];
        service.syncNow = async (kind: string, ownPass: boolean) => {
            syncs.push([kind, ownPass]);
            service.passesStarted += 1;
        };
        service.resumeSyncDelayMs = 20;
        service.outage.awakeMs = 3 * 60 * 1000;
        service.handleSystemResume();
        setProbe(true);
        await service.checkConnectivity(); // the connection is back before the wake-up sync runs
        assert.deepEqual(syncs, [], 'the wake-up sync is on its way');
        await until(() => syncs.length > 0);
        await wait(40);
        assert.deepEqual(syncs, [['auto', true]]);

        // The other order: the connection's sync ran first, the wake-up sync is then not needed.
        syncs.length = 0;
        service.handleSystemResume();
        service.passesStarted += 1;
        await wait(60);
        assert.deepEqual(syncs, []);
    } finally {
        await cleanup();
    }
});

test('0.32: the status text follows the language — the initial "Signed out" and texts set before a switch are re-translated', async () => {
    const { service, cleanup } = await setup();
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const i18n = require('../src/main/i18n') as typeof import('../src/main/i18n');
    i18n.setLocalesDir(join(__dirname, '..', 'src', 'locales'));
    try {
        // The service is constructed before the language is applied at startup: the initial text must not be frozen then.
        assert.equal((await service.getBridgeState()).message, 'Signed out');
        i18n.setLanguage('de');
        assert.equal((await service.getBridgeState()).message, 'Abgemeldet');
        assert.equal(service.getTrayState().message, 'Abgemeldet');
        service.setHealth('healthy', () => i18n.t('Bridge connected'));
        assert.equal((await service.getBridgeState()).message, 'Bridge verbunden');
        i18n.setLanguage('nl');
        assert.equal((await service.getBridgeState()).message, 'Bridge verbonden');
        // A text from Proton or the library stays as it came.
        service.setHealth('error', 'Proton said no');
        i18n.setLanguage('fr');
        assert.equal((await service.getBridgeState()).message, 'Proton said no');
    } finally {
        i18n.setLanguage('en');
        await cleanup();
    }
});
