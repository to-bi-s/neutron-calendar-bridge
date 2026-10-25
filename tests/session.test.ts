/**
 * Stage 2 (0.23): Proton's session and Proton's "slow down". The saved session is resumed at start
 * (no password sign-in while Proton accepts it) and kept up to date (refresh tokens are single-use);
 * when Proton ends the session, the bridge signs in again with the saved login, once; when Proton
 * asks to slow down, no sync pass goes out before its time; an app version Proton no longer
 * accepts is said plainly; Developer settings show the request statistics.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fakeSafeStorage } from './support/fake-safe-storage';

const stubElectron = () => {
    const resolved = require.resolve('electron');
    require.cache[resolved] = {
        id: resolved,
        filename: resolved,
        loaded: true,
        exports: { app: { setLoginItemSettings: () => undefined, isPackaged: false }, safeStorage: fakeSafeStorage }
    } as unknown as NodeJS.Module;
};

const named = (name: string, message: string, extra: Record<string, unknown> = {}) => Object.assign(new Error(message), { name, ...extra });

const setup = async () => {
    stubElectron();
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { BridgeService } = require('../src/main/bridge-service') as typeof import('../src/main/bridge-service');
    const baseDir = mkdtempSync(join(tmpdir(), 'neutron-calendar-bridge-session-'));
    const service = new BridgeService(baseDir) as any;
    const signIns: Array<{ username: string; session: any }> = [];
    let listingError: Error | null = null;
    let listingErrorOnce: Error | null = null;
    let listings = 0;
    let signedIn = false;
    let stats = { requests: 0, lastHour: 0, answers: {}, retries: 0, rateLimited: 0, lastRateLimit: null, pausedUntil: null, signIns: 0, sessionRenewals: 0, resumedSession: false, since: Date.now() };
    const adapter: any = {
        onSession: null,
        isSignedIn: () => signedIn,
        getSignedInUsername: () => (signedIn ? 'tobi@proton.me' : null),
        supportsSeriesSync: () => true,
        listAddresses: () => [],
        signIn: async (credentials: any, _hv: any, session: any) => {
            signIns.push({ username: credentials.username, session });
            signedIn = true;
            stats = { ...stats, resumedSession: Boolean(session), signIns: stats.signIns + (session ? 0 : 1) };
            adapter.onSession?.({ UID: 'uid', AccessToken: `access-${signIns.length}`, RefreshToken: `refresh-${signIns.length}`, identity: 'own' });
        },
        signOut: async () => {
            adapter.endedSessions = (adapter.endedSessions ?? 0) + 1;
            signedIn = false;
        },
        listCalendars: async () => {
            listings += 1;
            stats = { ...stats, requests: stats.requests + 3 };
            if (listingErrorOnce) {
                const error = listingErrorOnce;
                listingErrorOnce = null;
                throw error;
            }
            if (listingError) throw listingError;
            return [{ id: 'private', name: 'Tobi (Private)', color: '#6d4aff', visible: true, writable: true }];
        },
        listEvents: async () => [],
        getRequestStats: () => stats
    };
    service.protonAdapter = adapter;
    const notes: any[] = [];
    service.onNotify = (note: any) => notes.push(note);
    service.probeConnection = async () => true;
    const original = { log: console.log, warn: console.warn };
    console.log = () => undefined;
    console.warn = () => undefined;
    const cleanup = async () => {
        service.stopPolling();
        console.log = original.log;
        console.warn = original.warn;
        await service.mirrorDatabase.close().catch(() => undefined);
        rmSync(baseDir, { recursive: true, force: true });
    };
    return {
        service, adapter, notes, signIns, cleanup,
        listings: () => listings,
        failListing: (error: Error | null) => { listingError = error; },
        failListingOnce: (error: Error) => { listingErrorOnce = error; }
    };
};

test('the saved session is resumed at start and kept up to date; signing out ends it', async () => {
    const { service, adapter, signIns, cleanup } = await setup();
    try {
        await service.secretStore.setProtonCredentials({ username: 'tobi@proton.me', password: 'secret' });
        await service.secretStore.setProtonSession({ username: 'tobi@proton.me', UID: 'uid', AccessToken: 'a0', RefreshToken: 'r0', identity: 'own' });
        await service.initialize();
        assert.deepEqual(signIns[0].session, { username: 'tobi@proton.me', UID: 'uid', AccessToken: 'a0', RefreshToken: 'r0', identity: 'own' }, 'the saved session is offered');
        assert.equal((await service.secretStore.getProtonSession()).RefreshToken, 'refresh-1', 'the newest session is saved (refresh tokens are single-use)');
        adapter.onSession({ UID: 'uid', AccessToken: 'a-renewed', RefreshToken: 'r-renewed' });
        await new Promise((resolve) => setTimeout(resolve, 10));
        assert.deepEqual(await service.secretStore.getProtonSession(), { username: 'tobi@proton.me', UID: 'uid', AccessToken: 'a-renewed', RefreshToken: 'r-renewed' }, 'renewals are saved too');

        await service.signOut();
        assert.equal(adapter.endedSessions, 1, 'signing out ends the session at Proton');
        assert.equal(await service.secretStore.getProtonSession(), null, 'and forgets it');
    } finally {
        await cleanup();
    }
});

test("another account's saved session is not offered", async () => {
    const { service, signIns, cleanup } = await setup();
    try {
        await service.secretStore.setProtonCredentials({ username: 'tobi@proton.me', password: 'secret' });
        await service.secretStore.setProtonSession({ username: 'someone@proton.me', UID: 'uid', AccessToken: 'a0', RefreshToken: 'r0', identity: 'own' });
        await service.initialize();
        assert.equal(signIns[0].session, null);
    } finally {
        await cleanup();
    }
});

test('Proton ended the session: signed in again with the saved login, once', async () => {
    const { service, signIns, notes, failListingOnce, cleanup } = await setup();
    try {
        await service.secretStore.setProtonCredentials({ username: 'tobi@proton.me', password: 'secret' });
        await service.initialize();
        assert.equal(signIns.length, 1);
        failListingOnce(named('SessionExpiredError', 'Proton ended the session (its renewal was refused): sign in again.'));
        await assert.rejects(service.performSync(), /ended the session/);
        service.recoverSession(); // another failure meanwhile: no second sign-in
        await service.sessionRecovery;
        assert.equal(signIns.length, 2, 'one more sign-in');
        assert.equal(signIns[1].session, null, 'with the password (the session has ended)');
        assert.equal((await service.getBridgeState()).signedIn, true);
        assert.equal(notes.length, 0, 'nothing to tell when it worked');

        // Signed in again, but the first sync after it fails: not reported as a failed sign-in.
        failListingOnce(named('SessionExpiredError', 'ended'));
        const signIn = service.protonAdapter.signIn;
        service.protonAdapter.signIn = async (...args: any[]) => {
            await signIn(...args);
            failListingOnce(new Error('Proton is busy'));
        };
        await assert.rejects(service.performSync(), /ended/);
        await service.sessionRecovery;
        assert.equal(notes.length, 0);

        // Signing in again fails (e.g. the password was changed elsewhere): said plainly. (Like the
        // real adapter, a failed sign-in leaves it signed out.)
        service.protonAdapter.signIn = async () => {
            await service.protonAdapter.signOut();
            throw new Error('Incorrect login credentials');
        };
        failListingOnce(named('SessionExpiredError', 'ended'));
        await assert.rejects(service.performSync(), /ended/);
        await service.sessionRecovery;
        assert.equal(notes.at(-1)?.key, 'session');
        assert.match(notes.at(-1)?.body, /Incorrect login credentials/);
    } finally {
        await cleanup();
    }
});

test('Proton ended the session during a calendar\'s sync: recovered at once, the rest of the queue dropped (0.37.3)', async () => {
    const { service, adapter, signIns, cleanup } = await setup();
    const errors: string[] = [];
    const originalError = console.error;
    console.error = (...parts: unknown[]) => errors.push(parts.join(' '));
    try {
        await service.secretStore.setProtonCredentials({ username: 'tobi@proton.me', password: 'secret' });
        await service.initialize();
        assert.equal(signIns.length, 1);
        // Two calendars; a quiet pass does not list them again (0.26), so the refusal surfaces in the first calendar's sync.
        adapter.listCalendars = async () => [
            { id: 'private', name: 'Tobi (Private)', color: '#6d4aff', visible: true, writable: true },
            { id: 'work', name: 'Work', color: '#6d4aff', visible: true, writable: true }
        ];
        await service.performSync();
        let deadSessionCalls = 0;
        adapter.listEvents = async () => {
            if (signIns.length > 1) return []; // the new session works
            deadSessionCalls += 1;
            throw named('SessionExpiredError', 'Proton ended the session (its renewal was refused): sign in again.');
        };
        await service.performSync().catch(() => undefined);
        assert.ok(service.sessionRecovery, 'the recovery started from the calendar sync, not a later pass');
        await service.sessionRecovery;
        assert.equal(signIns.length, 2, 'signed in again with the saved login');
        assert.equal(deadSessionCalls, 1, 'the second calendar was not tried on the dead session');
        assert.deepEqual(service.syncQueue, []);
        assert.equal(errors.filter((line) => line.includes('failed: Proton ended the session')).length, 1, `one line, not one per calendar:\n${errors.join('\n')}`);
    } finally {
        console.error = originalError;
        await cleanup();
    }
});

test('Proton asked to slow down: no sync pass before its time', async () => {
    const { service, notes, listings, failListing, cleanup } = await setup();
    try {
        await service.secretStore.setProtonCredentials({ username: 'tobi@proton.me', password: 'secret' });
        await service.initialize();
        const before = listings();
        const retryAt = Date.now() + 10 * 60_000;
        failListing(named('RateLimitedError', 'Proton asked to slow down (429)', { retryAt }));
        await assert.rejects(service.performSync(), /slow down/);
        failListing(null);
        assert.equal(service.slowDownUntil, retryAt);
        assert.match((await service.getBridgeState()).message, /^Proton asked to slow down\. Syncing again at /);
        assert.equal(notes.at(-1)?.key, 'slow-down', 'a long pause is notified');
        assert.equal(service.outage, null, 'not taken for a lost connection');
        assert.equal(service.refusedPasses, null, 'nor counted as a refusal');

        await service.performSync();
        assert.equal(listings(), before + 1, 'the next pass sends nothing');
        service.slowDownUntil = Date.now() - 1;
        await service.performSync();
        assert.equal(listings(), before + 2, 'after the time, syncing goes on');
    } finally {
        await cleanup();
    }
});

test('an app version Proton no longer accepts is said plainly', async () => {
    const { service, notes, failListing, cleanup } = await setup();
    try {
        await service.secretStore.setProtonCredentials({ username: 'tobi@proton.me', password: 'secret' });
        await service.initialize();
        failListing(named('AppVersionError', 'Proton no longer accepts the app version this library presents (error 5003). The library needs an update.'));
        await assert.rejects(service.performSync(), /app version/);
        assert.equal(notes.at(-1)?.key, 'app-version');
        assert.match((await service.getBridgeState()).message, /no longer accepts the app version/);
    } finally {
        await cleanup();
    }
});

test('Developer settings: request statistics with the last sync pass', async () => {
    const { service, cleanup } = await setup();
    try {
        await service.secretStore.setProtonCredentials({ username: 'tobi@proton.me', password: 'secret' });
        await service.initialize();
        assert.equal((await service.getBridgeState()).requestStats, null, 'only with developer options on');
        await service.updateConfig({ developerMode: true });
        await service.performSync();
        const stats = (await service.getBridgeState()).requestStats;
        assert.equal(stats.signIns, 1);
        assert.equal(stats.lastPass.requests, 3, 'requests of the last pass');
        assert.ok(stats.lastPass.seconds >= 0);
    } finally {
        await cleanup();
    }
});

test('a sign-in in the background that finishes after you signed out is undone', async () => {
    const { service, adapter, signIns, failListingOnce, cleanup } = await setup();
    try {
        await service.secretStore.setProtonCredentials({ username: 'tobi@proton.me', password: 'secret' });
        await service.initialize();
        // The session ends; signing in again is slow …
        let release!: () => void;
        const signIn = adapter.signIn;
        adapter.signIn = async (...args: any[]) => {
            await new Promise<void>((resolve) => (release = resolve));
            await signIn(...args);
        };
        failListingOnce(named('SessionExpiredError', 'ended'));
        await assert.rejects(service.performSync(), /ended/);
        await new Promise((resolve) => setTimeout(resolve, 20));
        // … and you sign out meanwhile.
        await service.signOut();
        release();
        await service.sessionRecovery;
        assert.equal(signIns.length, 2, 'the background sign-in did happen …');
        assert.equal(adapter.isSignedIn(), false, '… but was undone');
        assert.equal(await service.secretStore.getProtonSession(), null, 'its session was not saved');
        assert.equal(service.syncTimer, null, 'no polling');
        assert.equal((await service.getBridgeState()).health, 'disconnected');
    } finally {
        await cleanup();
    }
});

test('Proton asks for verification while signing in again: no new sign-in at every sync', async () => {
    const { service, adapter, signIns, notes, failListingOnce, cleanup } = await setup();
    try {
        await service.secretStore.setProtonCredentials({ username: 'tobi@proton.me', password: 'secret' });
        await service.initialize();
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { ProtonHumanVerificationRequiredError } = require('../src/main/proton-adapter') as typeof import('../src/main/proton-adapter');
        adapter.signIn = async (credentials: any) => {
            signIns.push({ username: credentials.username, session: null });
            throw new ProtonHumanVerificationRequiredError({ token: `challenge-${signIns.length}`, methods: ['captcha'] });
        };
        failListingOnce(named('SessionExpiredError', 'ended'));
        await assert.rejects(service.performSync(), /ended/);
        await service.sessionRecovery;
        assert.equal(service.getPendingHumanVerification()?.token, 'challenge-2');
        await service.performSync();
        await service.performSync();
        await service.sessionRecovery;
        assert.equal(signIns.length, 2, 'no further sign-ins while the verification waits');
        assert.equal(service.getPendingHumanVerification()?.token, 'challenge-2', 'the challenge you are solving stays');
        assert.equal(notes.filter((note: any) => note.key === 'verification').length, 1, 'and you are told to open the bridge');
    } finally {
        await cleanup();
    }
});

test('a slow-down hitting one calendar stops the queue; at start it delays the sign-in', async () => {
    const { service, adapter, cleanup } = await setup();
    try {
        await service.secretStore.setProtonCredentials({ username: 'tobi@proton.me', password: 'secret' });
        await service.initialize();
        const retryAt = Date.now() + 20 * 60_000;
        adapter.listEvents = async () => {
            throw named('RateLimitedError', 'Proton asked to slow down', { retryAt });
        };
        await service.performSync().catch(() => undefined);
        assert.equal(service.slowDownUntil, retryAt, 'the bridge waits for Proton’s time');
        assert.deepEqual(service.syncQueue, []);
    } finally {
        await cleanup();
    }

    const second = await setup();
    try {
        await second.service.secretStore.setProtonCredentials({ username: 'tobi@proton.me', password: 'secret' });
        const retryAt = Date.now() + 5 * 60_000;
        let refuse = true;
        const signIn = second.adapter.signIn;
        second.adapter.signIn = async (...args: any[]) => {
            if (refuse) throw named('RateLimitedError', 'Proton asked to slow down', { retryAt });
            return signIn(...args);
        };
        await second.service.initialize();
        assert.match((await second.service.getBridgeState()).message, /^Proton asked to slow down\. Syncing again at /);
        assert.ok(second.service.signInRetryTimer, 'signing in again later');
        refuse = false;
        await second.service.retryPendingSignIn();
        assert.equal(second.adapter.isSignedIn(), false, 'not before Proton’s time');
        second.service.slowDownUntil = Date.now() - 1;
        await second.service.retryPendingSignIn();
        assert.equal(second.adapter.isSignedIn(), true, 'then signed in');
    } finally {
        await second.cleanup();
    }
});

test('an app version Proton rejects: notified once, asked again only hourly', async () => {
    const { service, notes, failListing, listings, cleanup } = await setup();
    try {
        await service.secretStore.setProtonCredentials({ username: 'tobi@proton.me', password: 'secret' });
        await service.initialize();
        failListing(named('AppVersionError', 'Proton no longer accepts the app version'));
        await assert.rejects(service.performSync(), /app version/);
        const after = listings();
        await service.performSync();
        assert.equal(listings(), after, 'no request for the next hour');
        assert.match((await service.getBridgeState()).message, /app version/, 'and the status keeps saying why (not "slow down")');
        service.slowDownUntil = 0;
        await assert.rejects(service.performSync(), /app version/);
        assert.equal(notes.filter((note: any) => note.key === 'app-version').length, 1, 'notified once');
    } finally {
        await cleanup();
    }
});

test('a background sign-in overtaken by your own sign-out and sign-in leaves your new session alone', async () => {
    stubElectron();
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { ProtonAdapter, SIGNED_OUT_MEANWHILE } = require('../src/main/proton-adapter') as typeof import('../src/main/proton-adapter');
    const adapter = new ProtonAdapter(mkdtempSync(join(tmpdir(), 'neutron-calendar-bridge-adapter-'))) as any;
    const ended: string[] = [];
    const client = (name: string) => ({ name, signOut: async () => { ended.push(name); } });
    let releaseBackground!: (api: unknown) => void;
    adapter.loadClient = async () => ({
        createProtonCalendarAPI: async (credentials: any) =>
            credentials.password === 'background' ? new Promise((resolve) => (releaseBackground = resolve)) : client('yours')
    });
    const original = console.log;
    console.log = () => undefined;
    try {
        const background = adapter.signIn({ username: 'tobi@proton.me', password: 'background' });
        await new Promise((resolve) => setTimeout(resolve, 10));
        const staleGeneration = adapter.generation;
        await adapter.signOut();
        const yours = await adapter.signIn({ username: 'tobi@proton.me', password: 'yours' });
        releaseBackground(client('background'));
        await assert.rejects(background, (error: any) => error.name === SIGNED_OUT_MEANWHILE);
        assert.equal(adapter.api?.name, 'yours', 'your sign-in is the current one');
        assert.deepEqual(ended, ['background'], 'only the overtaken sign-in’s session was ended at Proton');
        await adapter.signOut(true, staleGeneration);
        assert.equal(adapter.isSignedIn(), true, 'signing out the overtaken sign-in does not sign you out');
        await adapter.signOut(true, yours);
        assert.equal(adapter.isSignedIn(), false);
        assert.deepEqual(ended, ['background', 'yours']);
    } finally {
        console.log = original;
    }
});

test('Calendar.app writes: refused at once during a slow-down; the client’s own problems handled', async () => {
    const { service, notes, cleanup } = await setup();
    try {
        await service.secretStore.setProtonCredentials({ username: 'tobi@proton.me', password: 'secret' });
        await service.initialize();
        let writes = 0;
        const write = async () => {
            writes += 1;
            return 'written';
        };
        assert.equal(await service.calendarAppWrite(write), 'written');

        // The client says "slow down": syncing pauses, and later writes are refused without a request.
        const retryAt = Date.now() + 10 * 60_000;
        await assert.rejects(service.calendarAppWrite(async () => { throw named('RateLimitedError', 'slow down', { retryAt }); }), { name: 'RateLimitedError' });
        assert.equal(service.slowDownUntil, retryAt);
        await assert.rejects(service.calendarAppWrite(write), (error: any) => error.name === 'RateLimitedError' && error.retryAt === retryAt);
        assert.equal(writes, 1, 'no request to Proton before its time');
        service.slowDownUntil = 0;

        // Proton ended the session: signed in again in the background.
        await assert.rejects(service.calendarAppWrite(async () => { throw named('SessionExpiredError', 'ended'); }), { name: 'SessionExpiredError' });
        assert.ok(service.sessionRecovery, 'signing in again');
        await service.sessionRecovery;

        // A refused app version: said, and writes wait with that reason.
        await assert.rejects(service.calendarAppWrite(async () => { throw named('AppVersionError', 'Proton no longer accepts the app version'); }), { name: 'AppVersionError' });
        assert.equal(notes.filter((note: any) => note.key === 'app-version').length, 1);
        await assert.rejects(service.calendarAppWrite(write), (error: any) => error.name === 'RateLimitedError' && /app version/.test(error.message));
    } finally {
        await cleanup();
    }
});

test('signing in again after an offline start tries the saved session first', async () => {
    const { service, signIns, cleanup } = await setup();
    try {
        await service.secretStore.setProtonCredentials({ username: 'tobi@proton.me', password: 'secret' });
        await service.secretStore.setProtonSession({ username: 'tobi@proton.me', UID: 'uid', AccessToken: 'a', RefreshToken: 'r', identity: 'own' });
        service.pendingSignIn = { username: 'tobi@proton.me', password: 'secret' };
        await service.retryPendingSignIn();
        assert.equal(signIns.at(-1)?.session?.RefreshToken, 'r', 'the saved session offered');
    } finally {
        await cleanup();
    }
});

test('a verification finished after you signed out: no error, just the signed-out state', async () => {
    const { service, adapter, cleanup } = await setup();
    try {
        await service.initialize(); // nothing saved: signed out
        service.pendingHumanVerification = { token: 'challenge', methods: ['captcha'] };
        service.pendingCredentials = { username: 'tobi@proton.me', password: 'secret' };
        adapter.signIn = async () => {
            throw named('SignedOutMeanwhile', 'Signed out meanwhile.');
        };
        const state = await service.completeHumanVerification({ token: 'solved', tokenType: 'captcha' });
        assert.equal(state.signedIn, false);
    } finally {
        await cleanup();
    }
});

test('a slow-down at a new meeting’s first invitation: its guest-less event is removed before the next pass reads the calendars', async () => {
    const { service, adapter, cleanup } = await setup();
    try {
        await service.secretStore.setProtonCredentials({ username: 'tobi@proton.me', password: 'secret' });
        await service.initialize();
        const order: string[] = [];
        adapter.deleteEvent = async (calendarId: string, eventId: string) => {
            order.push(`delete ${calendarId}/${eventId}`);
            return { success: true };
        };
        const listCalendars = adapter.listCalendars;
        adapter.listCalendars = async () => {
            order.push('list');
            return listCalendars();
        };
        const retryAt = Date.now() + 5 * 60_000;
        const calendar = { protonCalendarId: 'private', slug: 'tobi-private' };
        // As Calendar.app's PUT runs it (upsertLocalEvent → calendarAppWrite → … → runInvitationSteps).
        await assert.rejects(
            service.calendarAppWrite(() => service.runInvitationSteps(calendar, { uid: 'new-meeting@mac', protonEventId: null }, [
                async () => ({ success: false, reason: 'rate-limited', retryAt, leftover: { calendarID: 'private', eventID: 'ev-left' }, error: 'Proton asked to slow down', emails: [], changedEventIds: [], deletedEventIds: [], warnings: [] })
            ])),
            (error: any) => error.name === 'RateLimitedError' && error.retryAt === retryAt
        );
        // 0.42: saved on disk with the account (a quit during the pause no longer loses it).
        const { ConfigStore } = require('../src/main/config-store') as typeof import('../src/main/config-store');
        const saved = new ConfigStore(service.baseDir ?? service.configStore.filePath.replace(/\/config\.json$/, '')).load().leftoverEvents;
        assert.deepEqual(saved.map(({ calendarID, eventID, account }: any) => ({ calendarID, eventID, account })), [{ calendarID: 'private', eventID: 'ev-left', account: 'tobi@proton.me' }]);
        await service.performSync();
        assert.deepEqual(order, [], 'nothing during the slow-down');
        service.slowDownUntil = 0;
        // 0.42 (review): no network yet at the first pass — the leftover is kept, not forgotten.
        const deleteEvent = adapter.deleteEvent;
        adapter.deleteEvent = async () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } }); };
        await service.performSync().catch(() => undefined);
        assert.equal(service.configStore.load().leftoverEvents.length, 1, 'kept while Proton cannot be reached');
        adapter.deleteEvent = deleteEvent;
        order.length = 0;
        await service.performSync();
        assert.deepEqual(order.slice(0, 2), ['delete private/ev-left', 'list'], 'removed first, then the calendars are read');
        order.length = 0;
        await service.performSync();
        assert.ok(!order.some((entry) => entry.startsWith('delete')), 'once');
        assert.deepEqual(service.configStore.load().leftoverEvents, [], 'and forgotten on disk');
    } finally {
        await cleanup();
    }
});

test('a write or pass still running on an ended session does not throw away the session signed in since', async () => {
    const { service, adapter, notes, cleanup } = await setup();
    try {
        await service.secretStore.setProtonCredentials({ username: 'tobi@proton.me', password: 'secret' });
        await service.initialize();
        let generation = 1;
        adapter.currentGeneration = () => generation;
        await assert.rejects(
            service.calendarAppWrite(async () => {
                generation = 2; // signed in again while this write ran on the old session
                throw named('SessionExpiredError', 'ended');
            }),
            { name: 'SessionExpiredError' }
        );
        assert.equal(service.sessionRecovery, null, 'no second recovery for the old session');
        await assert.rejects(service.calendarAppWrite(async () => { throw named('SessionExpiredError', 'ended'); }), { name: 'SessionExpiredError' });
        assert.ok(service.sessionRecovery, 'the current session’s end still starts one');
        await service.sessionRecovery;

        // Recovery overtaken by your own sign-in: no "Signed out by Proton".
        adapter.signIn = async () => { throw named('SignedOutMeanwhile', 'Signed out meanwhile.'); };
        service.recoverSession();
        await service.sessionRecovery;
        assert.equal(notes.filter((note: any) => note.key === 'session').length, 0);
    } finally {
        await cleanup();
    }
});

test('signing in yourself stops the retry with the saved login; server trouble at start is retried', async () => {
    const { service, adapter, signIns, cleanup } = await setup();
    try {
        await service.secretStore.setProtonCredentials({ username: 'tobi@proton.me', password: 'old' });
        const signIn = adapter.signIn;
        let trouble = true;
        adapter.signIn = async (...args: any[]) => {
            if (trouble) throw new Error('Failed to get user info (502): {"Code":502}');
            return signIn(...args);
        };
        await service.initialize();
        assert.ok(service.signInRetryTimer, 'Proton’s server trouble at start: signing in again later');
        trouble = false;
        await service.signIn({ username: 'tobi@proton.me', password: 'new' }, true);
        assert.equal(service.signInRetryTimer, null, 'your own sign-in stopped the retry');
        assert.equal(service.pendingSignIn, null);
        assert.equal(signIns.at(-1)?.username, 'tobi@proton.me');
    } finally {
        await cleanup();
    }
});

test('a meeting saved, but an email not sent: you are told', async () => {
    const { service, notes, cleanup } = await setup();
    try {
        await service.secretStore.setProtonCredentials({ username: 'tobi@proton.me', password: 'secret' });
        await service.initialize();
        service.refreshAfterInvitationWrite = async () => undefined;
        await service.runInvitationSteps({ protonCalendarId: 'private', slug: 'tobi-private' }, { uid: 'm@mac', protonEventId: 'ev' }, [
            async () => ({
                success: true,
                emails: [{ kind: 'update', outcome: 'failed', eventTitle: 'Team meeting', to: [{ email: 'carla@example.org', name: 'Carla' }], detail: 'Proton asked to slow down' }],
                changedEventIds: ['ev'], deletedEventIds: [], warnings: []
            })
        ]);
        const note = notes.find((entry: any) => entry.title === 'Saved, but not every guest was emailed');
        assert.ok(note && /carla@example\.org: Proton asked to slow down/.test(note.body) && note.subtitle === 'Team meeting');
    } finally {
        await cleanup();
    }
});

test('stage 16 / 0.50: every sign-in is under the app\'s own identity and the saved session records it', async () => {
    stubElectron();
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { ProtonAdapter } = require('../src/main/proton-adapter') as typeof import('../src/main/proton-adapter');
    const adapter = new ProtonAdapter(mkdtempSync(join(tmpdir(), 'neutron-calendar-bridge-adapter-'))) as any;
    adapter.appVersion = '0.50.0';
    const given: any[] = [];
    adapter.loadClient = async () => ({
        createProtonCalendarAPI: async (credentials: any) => {
            given.push(credentials);
            credentials.onSession?.({ UID: 'u', AccessToken: 'a', RefreshToken: 'r' });
            return { signOut: async () => undefined };
        }
    });
    const saved: any[] = [];
    adapter.onSession = (session: any) => saved.push(session);
    const original = console.log;
    console.log = () => undefined;
    try {
        await adapter.signIn({ username: 'test@proton.me', password: 'x' });
        assert.equal(given[0].appIdentity?.appVersion, 'Other');
        assert.match(given[0].appIdentity?.userAgent, /^NeutronCalendarBridge\/0\.50\.0 \(macOS/);
        assert.equal(saved[0].identity, 'own', 'the saved session records the identity');
        // Resumed later: the same identity.
        await adapter.signIn({ username: 'test@proton.me', password: '' }, null, { username: 'test@proton.me', UID: 'u', AccessToken: 'a', RefreshToken: 'r', identity: 'own' });
        assert.equal(given[1].appIdentity?.appVersion, 'Other');
        assert.equal(given[1].session?.UID, 'u');
        assert.equal(saved[1].identity, 'own');
    } finally {
        console.log = original;
    }
});

test('0.45 / 0.50: a password sign-in\'s password is not kept; a saved session from a former identity is not resumed', async () => {
    const { service, adapter, cleanup } = await setup();
    try {
        const sessions: any[] = [];
        const signIn = adapter.signIn;
        adapter.signIn = async (credentials: any, hv: any, session: any) => {
            sessions.push(session);
            return signIn(credentials, hv, session);
        };
        await service.initialize();
        await service.signIn({ username: 'tobi@proton.me', password: 'secret' }, true);
        const saved = await service.secretStore.getProtonCredentials();
        assert.equal(saved?.username, 'tobi@proton.me');
        assert.equal(saved?.password, '', 'the password is not kept (Proton\'s CAPTCHA: the bridge cannot sign in again by itself)');

        // A session saved before 0.45 (opened as Proton's iOS Mail app) is not resumed under the own identity.
        await service.secretStore.setProtonSession({ username: 'tobi@proton.me', UID: 'old', AccessToken: 'a', RefreshToken: 'r' });
        await service.secretStore.setProtonCredentials({ username: 'tobi@proton.me', password: 'secret' });
        sessions.length = 0;
        await service.initialize();
        assert.equal(sessions.length, 1, 'signed in');
        assert.equal(sessions[0], null, 'without the old session');
        // One opened under the own identity is.
        await service.secretStore.setProtonSession({ username: 'tobi@proton.me', UID: 'own', AccessToken: 'a', RefreshToken: 'r', identity: 'own' });
        sessions.length = 0;
        await service.initialize();
        assert.equal(sessions[0]?.UID, 'own', 'resumed');
    } finally {
        await cleanup();
    }
});
