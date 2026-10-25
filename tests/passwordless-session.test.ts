/**
 * 0.47: when no password is kept (the bridge's own sign-in since 0.45; before 0.47 also "Sign In with
 * Proton") and Proton ends the session, there is nothing to sign in again with: the bridge says so and
 * does not try. The same for a session that is already dead at start. (Moved here from the page
 * sign-in's tests when that went out of the app.)
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

const named = (name: string, message: string) => Object.assign(new Error(message), { name });

const setup = async ({ start = false, deadSession = false } = {}) => {
    stubElectron();
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { BridgeService } = require('../src/main/bridge-service') as typeof import('../src/main/bridge-service');
    const baseDir = mkdtempSync(join(tmpdir(), 'neutron-calendar-bridge-passwordless-'));
    const service = new BridgeService(baseDir) as any;
    service.localCaldavPassword = 'test';
    if (!start) {
        await service.mirrorDatabase.initialize();
    }
    let signedIn = false;
    const signIns: any[] = [];
    const adapter: any = {
        onSession: null,
        isSignedIn: () => signedIn,
        getSignedInUsername: () => (signedIn ? 'tobi@proton.me' : null),
        supportsSeriesSync: () => true,
        listAddresses: () => [],
        signIn: async (credentials: any, _hv: any, session: any) => {
            signIns.push({ credentials, session });
            if (session?.keyPassword && !deadSession) {
                signedIn = true;
                adapter.onSession?.({ ...session });
                return 1;
            }
            if (!credentials.password) {
                throw named('SessionExpiredError', 'Proton ended the session (…): sign in again.');
            }
            signedIn = true;
            adapter.onSession?.({ UID: 'uid-o', AccessToken: 'access-o', RefreshToken: 'refresh-o', keyPassword: 'own-key-password', identity: 'own' });
            return 1;
        },
        signOut: async () => {
            signedIn = false;
        },
        listCalendars: async () => [{ id: 'private', name: 'Tobi (Private)', color: '#6d4aff', visible: true, writable: true }],
        listEvents: async () => [],
        getRequestStats: () => ({ requests: 0, lastHour: 0, answers: {}, retries: 0, rateLimited: 0, lastRateLimit: null, pausedUntil: null, signIns: 0, sessionRenewals: 0, resumedSession: false, since: Date.now() })
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
    return { service, notes, signIns, cleanup, signedIn: () => signedIn };
};

test('Proton ended a session with no password kept: told to sign in again, nothing retried; a dead session at start the same', async () => {
    const live = await setup();
    try {
        const { service, notes, signIns } = live;
        await service.signIn({ username: 'tobi@proton.me', password: 'secret' });
        assert.equal((await service.secretStore.getProtonCredentials())?.password, '', 'the bridge\'s own sign-in keeps no password (0.45)');
        notes.length = 0;
        signIns.length = 0;
        // A pass finds the session ended.
        service.recoverSession();
        await new Promise((resolve) => setTimeout(resolve, 50));
        assert.equal(service.health, 'error');
        assert.match(service.message, /Sign in again on the Setup page/);
        assert.deepEqual(notes.map((note: any) => [note.key, note.title, note.page]), [['session', 'Signed out by Proton', 'setup']]);
        assert.equal(signIns.length, 0, 'no sign-in attempted with an empty password');
        assert.equal(live.signedIn(), false);
    } finally {
        await live.cleanup();
    }

    const dead = await setup({ start: true, deadSession: true });
    try {
        const { service } = dead;
        await service.secretStore.setProtonCredentials({ username: 'tobi@proton.me', password: '' });
        await service.secretStore.setProtonSession({ username: 'tobi@proton.me', UID: 'uid-o', AccessToken: 'a', RefreshToken: 'r', keyPassword: 'k', identity: 'own' });
        await service.initialize();
        assert.equal(dead.signedIn(), false);
        assert.equal(service.health, 'error');
        assert.match(service.message, /Proton ended the session/);
    } finally {
        await dead.cleanup();
    }
});
