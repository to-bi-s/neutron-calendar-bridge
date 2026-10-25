/**
 * Stage 3 (0.24), privacy at rest, as the bridge does it: the local copy is opened with the key kept
 * with the saved login (a copy from before is converted at the first start); when the saved login
 * cannot be read (Keychain refused), or the copy cannot be opened, the file is left as it is and
 * the run works on a copy in memory.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MirrorDatabase } from '../src/main/mirror-database';
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

const setup = async () => {
    stubElectron();
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { BridgeService } = require('../src/main/bridge-service') as typeof import('../src/main/bridge-service');
    const baseDir = mkdtempSync(join(tmpdir(), 'neutron-calendar-bridge-privacy-'));
    const lines: string[] = [];
    const original = { log: console.log, warn: console.warn };
    console.log = (...parts: unknown[]) => lines.push(parts.join(' '));
    console.warn = (...parts: unknown[]) => lines.push(parts.join(' '));
    const make = () => new BridgeService(baseDir) as any;
    const services: any[] = [];
    const start = async (prepare?: (service: any) => void) => {
        const service = make();
        services.push(service);
        prepare?.(service);
        await service.initialize();
        return service;
    };
    const cleanup = async () => {
        for (const service of services) {
            service.stopPolling();
            await service.mirrorDatabase.close().catch(() => undefined);
        }
        console.log = original.log;
        console.warn = original.warn;
        rmSync(baseDir, { recursive: true, force: true });
    };
    return { baseDir, lines, start, cleanup };
};

/** A copy as 0.23 left it: unencrypted, one calendar. */
const oldCopy = async (baseDir: string) => {
    const database = new MirrorDatabase(baseDir);
    await database.initialize();
    await database.upsertCalendar({
        protonCalendarId: 'calendar-1',
        slug: 'calendar-1',
        displayName: 'Tobi (Private)',
        color: '#6d4aff',
        description: '',
        visible: true,
        removed: false,
        ctag: '1',
        lastPolledAt: null,
        lastSyncedAt: null
    });
    await database.close();
};

const isPlain = (file: string) => readFileSync(file).subarray(0, 16).toString('latin1') === 'SQLite format 3\u0000';

test('the first start of 0.24 encrypts the copy with a key kept with the saved login', async () => {
    const { baseDir, lines, start, cleanup } = await setup();
    try {
        await oldCopy(baseDir);
        const service = await start();
        assert.equal(isPlain(join(baseDir, 'mirror.db')), false);
        assert.equal((await service.mirrorDatabase.listCalendars()).length, 1, 'nothing lost');
        assert.ok(lines.some((line) => /\[mirror\] .*encrypted now/.test(line)));
        const key = (await service.secretStore.ensureMirrorKey()).key;
        await service.shutdown();

        const restarted = await start();
        assert.equal((await restarted.secretStore.ensureMirrorKey()).key, key, 'the same key at the next start');
        assert.equal((await restarted.mirrorDatabase.listCalendars()).length, 1);
    } finally {
        await cleanup();
    }
});

test('the saved login cannot be read: the copy on disk is left alone, the run works in memory', async () => {
    const { baseDir, lines, start, cleanup } = await setup();
    try {
        await oldCopy(baseDir);
        const before = readFileSync(join(baseDir, 'mirror.db'));
        // Encrypted by safeStorage, which cannot decrypt it now ("Deny" in the Keychain prompt).
        writeFileSync(join(baseDir, 'secrets.json'), Buffer.from('encrypted bytes').toString('base64'));
        const service = await start();
        assert.equal(service.secretStore.isUnreadable(), true);
        assert.deepEqual(await service.mirrorDatabase.listCalendars(), [], 'a copy in memory');
        assert.deepEqual(readFileSync(join(baseDir, 'mirror.db')), before, 'the file is untouched');
        assert.ok(lines.some((line) => /\[mirror\] the saved login .*cannot be read.*in memory/.test(line)));
        assert.match((await service.getBridgeState()).localCopyNote, /kept in memory this run/);
    } finally {
        await cleanup();
    }
});

test('the copy cannot be opened (e.g. disk full while converting): the run works in memory, the next start tries again', async () => {
    const { baseDir, lines, start, cleanup } = await setup();
    try {
        await oldCopy(baseDir);
        const notes: any[] = [];
        const service = await start((fresh) => {
            fresh.onNotify = (note: any) => notes.push(note);
            const initialize = fresh.mirrorDatabase.initialize.bind(fresh.mirrorDatabase);
            fresh.mirrorDatabase.initialize = async (options: { key?: string; memory?: boolean }) => {
                if (options.key) throw new Error('SQLITE_FULL: database or disk is full');
                return initialize(options);
            };
        });
        assert.deepEqual(await service.mirrorDatabase.listCalendars(), []);
        assert.ok(lines.some((line) => /could not be opened \(SQLITE_FULL.*in memory/.test(line)));
        assert.equal(isPlain(join(baseDir, 'mirror.db')), true, 'still the old copy');
        assert.match((await service.getBridgeState()).localCopyNote, /kept in memory this run \(the local copy could not be opened \(SQLITE_FULL/, 'shown on the Overview');
        assert.deepEqual(notes.map((note) => [note.key, note.title]), [['mirror:memory', 'Local copy in memory only']]);
        await service.shutdown();

        const restarted = await start();
        assert.equal((await restarted.getBridgeState()).localCopyNote, null);
        assert.equal(isPlain(join(baseDir, 'mirror.db')), false, 'converted at the next start');
        assert.equal((await restarted.mirrorDatabase.listCalendars()).length, 1);
        assert.equal(existsSync(join(baseDir, 'mirror.db.unencrypted')), false);
    } finally {
        await cleanup();
    }
});

test('Calendar.app with an old password: counted, one notification, the Setup page told; the right one ends it', async () => {
    const { lines, start, cleanup } = await setup();
    try {
        const service = await start();
        const notes: any[] = [];
        service.onNotify = (note: any) => notes.push(note);
        const { username, password } = service.getCalDAVConfig();

        assert.equal(service.checkCalDAVLogin(null), 'missing', 'no login yet: asked for, not counted');
        assert.equal((await service.getBridgeState()).caldavLogin, null);
        assert.equal(service.checkCalDAVLogin({ username, password }), 'ok');
        assert.deepEqual(notes, [], 'nothing to say while it signs in fine');

        for (let attempt = 0; attempt < 5; attempt += 1) {
            assert.equal(service.checkCalDAVLogin({ username, password: 'from-before' }), 'wrong');
        }
        const trouble = (await service.getBridgeState()).caldavLogin;
        assert.equal(trouble.attempts, 5);
        assert.equal(trouble.savedPasswordUnreadable, false);
        assert.ok(trouble.since <= trouble.lastAt);
        assert.deepEqual(
            notes.map((note) => [note.key, note.title, note.page]),
            [['caldav:login', 'Calendar.app uses an old password', 'setup']],
            'one notification, opening the Setup page'
        );
        assert.equal(lines.filter((line) => /wrong password for the bridge/.test(line)).length, 1, 'logged once');
        assert.ok(!lines.some((line) => line.includes('from-before')), 'the password sent is not logged');
        assert.equal(service.checkCalDAVLogin({ username, password: '' }), 'wrong', 'an empty password too');

        // Before 0.24 the user name was not checked, so Calendar.app may have any: the password counts.
        assert.equal(service.checkCalDAVLogin({ username: 'tobi@proton.me', password }), 'ok');
        assert.equal((await service.getBridgeState()).caldavLogin, null, 'the right one ends it');
        assert.deepEqual(notes.at(-1), {
            key: 'caldav:login-ok',
            replaces: 'caldav:login',
            title: 'Calendar.app connects again',
            body: 'Calendar.app signs in to the bridge with the right password.',
            page: 'setup'
        });
        service.checkCalDAVLogin({ username, password: 'from-before' });
        assert.equal(notes.filter((note) => note.key === 'caldav:login').length, 2, 'a new streak is told again');
    } finally {
        await cleanup();
    }
});

test('Calendar.app cannot sign in because the saved login cannot be read: told to allow the Keychain', async () => {
    const { baseDir, start, cleanup } = await setup();
    try {
        writeFileSync(join(baseDir, 'secrets.json'), Buffer.from('encrypted bytes').toString('base64'));
        const service = await start();
        const notes: any[] = [];
        service.onNotify = (note: any) => notes.push(note);
        assert.equal(service.checkCalDAVLogin({ username: service.getCalDAVConfig().username, password: 'the saved one' }), 'wrong');
        assert.equal((await service.getBridgeState()).caldavLogin.savedPasswordUnreadable, true);
        assert.equal(notes[0].title, 'Calendar.app cannot sign in to the bridge');
        assert.match(notes[0].body, /Always Allow/);
    } finally {
        await cleanup();
    }
});
