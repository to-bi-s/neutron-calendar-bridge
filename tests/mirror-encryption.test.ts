/**
 * Stage 3 (0.24): the local copy of the calendars (mirror.db) is encrypted with SQLCipher, with a
 * random key kept with the saved login. A copy from before is converted in place (everything kept,
 * no unencrypted file left behind, also when the conversion was cut short); a copy the key does not
 * open is set aside for a new one; when the key cannot be had, the file is left as it is and the run
 * works in memory.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MirrorDatabase } from '../src/main/mirror-database';

const TITLE = 'Dentist appointment with Dr. Hendriks';

const newKey = () => randomBytes(32).toString('hex');

const withDir = async (run: (baseDir: string) => Promise<void>) => {
    const baseDir = mkdtempSync(join(tmpdir(), 'neutron-calendar-bridge-mirror-'));
    try {
        await run(baseDir);
    } finally {
        rmSync(baseDir, { recursive: true, force: true });
    }
};

/** A copy with one calendar and one event, as 0.23 left it (no key) or keyed. */
const fill = async (baseDir: string, options: { key?: string } = {}) => {
    const database = new MirrorDatabase(baseDir);
    await database.initialize(options);
    await database.upsertCalendar({
        protonCalendarId: 'calendar-1',
        slug: 'calendar-1',
        displayName: 'Tobi (Private)',
        color: '#6d4aff',
        description: '',
        visible: true,
        removed: false,
        ctag: '7',
        lastPolledAt: null,
        lastSyncedAt: 5
    });
    await database.upsertEvent({
        protonEventId: 'event-1',
        protonCalendarId: 'calendar-1',
        uid: 'made-on-the-mac-uid',
        href: '/calendars/user/calendar-1/made-on-the-mac-uid.ics',
        etag: '"etag-1"',
        contentHash: 'hash',
        serializedIcs: `BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nSUMMARY:${TITLE}\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n`,
        title: TITLE,
        description: '',
        location: 'Utrecht',
        startTimestamp: 1,
        endTimestamp: 2,
        timezone: 'Europe/Amsterdam',
        isAllDay: false,
        modifiedTimestamp: 3,
        deleted: false,
        lastSyncedAt: 4
    });
    await database.close();
};

const read = async (baseDir: string, options: { key?: string; memory?: boolean }) => {
    const database = new MirrorDatabase(baseDir);
    try {
        const opened = await database.initialize(options);
        const calendars = await database.listCalendars();
        const events = await database.listEventsForCalendar('calendar-1');
        return { opened, calendars, events };
    } finally {
        await database.close();
    }
};

const plainOnDisk = (baseDir: string) => {
    const bytes = readFileSync(join(baseDir, 'mirror.db'));
    return bytes.subarray(0, 16).toString('latin1') === 'SQLite format 3\u0000' || bytes.includes(TITLE);
};

test('a copy from before 0.24 is encrypted in place, with everything kept', async () => {
    await withDir(async (baseDir) => {
        await fill(baseDir);
        assert.equal(plainOnDisk(baseDir), true, 'before: readable by anyone with the file');

        const key = newKey();
        const first = await read(baseDir, { key });
        assert.deepEqual(first.opened, { converted: true, inMemory: false });
        assert.equal(first.calendars.length, 1);
        assert.equal(first.calendars[0].ctag, '7');
        assert.deepEqual(
            first.events.map((event) => [event.uid, event.href, event.etag, event.title, event.location]),
            [['made-on-the-mac-uid', '/calendars/user/calendar-1/made-on-the-mac-uid.ics', '"etag-1"', TITLE, 'Utrecht']],
            "Calendar.app's UIDs, addresses and etags are kept"
        );

        assert.equal(plainOnDisk(baseDir), false, 'after: neither the SQLite header nor the title on disk');
        assert.deepEqual(readdirSync(baseDir).filter((name) => name !== 'mirror.db'), [], 'no unencrypted or half-written file left');
        assert.equal(statSync(join(baseDir, 'mirror.db')).mode & 0o777, 0o600, 'yours only');

        const again = await read(baseDir, { key });
        assert.equal(again.opened.converted, false, 'converted once');
        assert.equal(again.events[0].title, TITLE);

        // Without the key the file is of no use.
        const keyless = new MirrorDatabase(baseDir);
        await assert.rejects(keyless.initialize(), /not a database/);
        await keyless.close();
    });
});

test('a conversion cut short is finished at the next start, leaving nothing unencrypted', async () => {
    await withDir(async (baseDir) => {
        const key = newKey();
        const mirror = join(baseDir, 'mirror.db');

        // Quit while exporting: a half-written encrypted file next to the unencrypted copy.
        await fill(baseDir);
        writeFileSync(`${mirror}.encrypting`, randomBytes(4096));
        let opened = await read(baseDir, { key });
        assert.equal(opened.opened.converted, true);
        assert.equal(opened.events[0].uid, 'made-on-the-mac-uid');
        assert.deepEqual(readdirSync(baseDir), ['mirror.db']);

        // Quit between the two moves: the unencrypted copy aside, the encrypted one not yet in place.
        rmSync(mirror);
        await fill(baseDir);
        renameSync(mirror, `${mirror}.unencrypted`);
        writeFileSync(`${mirror}.encrypting`, randomBytes(4096));
        opened = await read(baseDir, { key });
        assert.equal(opened.opened.converted, true, 'the unencrypted copy is put back and converted');
        assert.equal(opened.events[0].uid, 'made-on-the-mac-uid', 'nothing lost');
        assert.deepEqual(readdirSync(baseDir), ['mirror.db']);
        assert.equal(plainOnDisk(baseDir), false);

        // Quit after the encrypted copy was in place: the unencrypted one left over is deleted.
        await fill(join(baseDir, 'old'));
        renameSync(join(baseDir, 'old', 'mirror.db'), `${mirror}.unencrypted`);
        rmSync(join(baseDir, 'old'), { recursive: true });
        opened = await read(baseDir, { key });
        assert.equal(opened.opened.converted, false);
        assert.deepEqual(readdirSync(baseDir), ['mirror.db']);
    });
});

test('a copy the key does not open is set aside, and a new one started', async () => {
    await withDir(async (baseDir) => {
        await fill(baseDir, { key: newKey() });

        // The key was lost with the saved login (e.g. the Keychain item was deleted).
        const other = newKey();
        const opened = await read(baseDir, { key: other });
        assert.match(opened.opened.replacedBy ?? '', /mirror\.db\.unreadable-\d+$/);
        assert.equal(existsSync(opened.opened.replacedBy!), true, 'the old file is kept aside');
        assert.deepEqual(opened.calendars, [], 'a new, empty copy (the next sync fills it)');

        await fill(baseDir, { key: other });
        const after = await read(baseDir, { key: other });
        assert.equal(after.opened.replacedBy, undefined, 'the new copy opens with the new key');
        assert.equal(after.events.length, 1);
        assert.equal(statSync(join(baseDir, 'mirror.db')).mode & 0o777, 0o600);

        // Set aside again: only the newest set-aside copy is kept.
        await new Promise((resolve) => setTimeout(resolve, 5));
        const third = await read(baseDir, { key: newKey() });
        const aside = readdirSync(baseDir).filter((name) => name.startsWith('mirror.db.unreadable-'));
        assert.deepEqual(aside, [third.opened.replacedBy!.split('/').at(-1)]);
    });
});

test('in memory (no key this run): the file on disk is left exactly as it is', async () => {
    await withDir(async (baseDir) => {
        await fill(baseDir, { key: newKey() });
        const before = readFileSync(join(baseDir, 'mirror.db'));
        copyFileSync(join(baseDir, 'mirror.db'), join(baseDir, 'copy'));

        const database = new MirrorDatabase(baseDir);
        const opened = await database.initialize({ memory: true });
        assert.deepEqual(opened, { converted: false, inMemory: true });
        assert.deepEqual(await database.listCalendars(), [], 'starts empty');
        await database.upsertCalendar({
            protonCalendarId: 'calendar-2',
            slug: 'calendar-2',
            displayName: 'Work',
            color: '#000000',
            description: '',
            visible: true,
            removed: false,
            ctag: '1',
            lastPolledAt: null,
            lastSyncedAt: null
        });
        assert.equal((await database.listCalendars()).length, 1, 'works for this run');
        await database.close();

        assert.deepEqual(readFileSync(join(baseDir, 'mirror.db')), before, 'untouched');
        assert.deepEqual(readdirSync(baseDir).sort(), ['copy', 'mirror.db']);
    });
});

test('an unencrypted copy is left alone in memory mode too (converted once the key is there)', async () => {
    await withDir(async (baseDir) => {
        await fill(baseDir);
        const before = readFileSync(join(baseDir, 'mirror.db'));
        await read(baseDir, { memory: true });
        assert.deepEqual(readFileSync(join(baseDir, 'mirror.db')), before);
        const opened = await read(baseDir, { key: newKey() });
        assert.equal(opened.opened.converted, true);
        assert.equal(opened.events[0].title, TITLE);
    });
});

test('a key that is not 256 bits is refused', async () => {
    await withDir(async (baseDir) => {
        const database = new MirrorDatabase(baseDir);
        await assert.rejects(database.initialize({ key: "abc'; DROP TABLE events; --" }), /256-bit key/);
        await assert.rejects(database.initialize({ key: 'ab'.repeat(16) }), /256-bit key/);
        await database.close();
    });
});

for (const mode of ['journal', 'wal'] as const) {
    test(`a copy 0.23 left after a crash (${mode === 'wal' ? 'committed rows still in the WAL' : 'a hot rollback journal'}) is converted with what was committed`, async () => {
        await withDir(async (baseDir) => {
            spawnSync(process.execPath, [join(__dirname, 'support', 'make-crashed-copy.cjs'), join(baseDir, 'mirror.db'), mode]);
            assert.ok(readdirSync(baseDir).some((name) => name === `mirror.db-${mode}`), `the ${mode} file is there`);
            const database = new MirrorDatabase(baseDir);
            try {
                const opened = await database.initialize({ key: newKey() });
                assert.equal(opened.converted, true);
                const ids = (await database.listCalendars(true)).map((calendar) => calendar.protonCalendarId).sort();
                assert.deepEqual(ids, mode === 'wal' ? ['committed', 'in-wal'] : ['committed'], 'committed rows kept, the unfinished transaction rolled back');
            } finally {
                await database.close();
            }
            assert.deepEqual(readdirSync(baseDir), ['mirror.db'], 'no side file left');
            assert.equal(plainOnDisk(baseDir), false);
        });
    });
}

test('a damaged unencrypted copy from before is deleted and a new, encrypted one started', async () => {
    await withDir(async (baseDir) => {
        writeFileSync(join(baseDir, 'mirror.db'), Buffer.concat([Buffer.from('SQLite format 3\u0000'), Buffer.from(TITLE), randomBytes(8192)]));
        const opened = await read(baseDir, { key: newKey() });
        assert.equal(opened.opened.discardedDamaged, true);
        assert.equal(opened.opened.converted, false);
        assert.deepEqual(opened.calendars, []);
        assert.equal(plainOnDisk(baseDir), false, 'nothing of the old file left');
        assert.deepEqual(readdirSync(baseDir), ['mirror.db']);
    });
});

test("SQLCipher 4's settings are pinned (a later SQLCipher with other defaults still opens the copy)", async () => {
    await withDir(async (baseDir) => {
        const key = newKey();
        await fill(baseDir);
        await read(baseDir, { key }); // converted
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const sqlite3 = require('@journeyapps/sqlcipher');
        const query = async (compatibility: number) => {
            const db = await new Promise<any>((resolve, reject) => {
                const opened = new sqlite3.Database(join(baseDir, 'mirror.db'), (error: Error | null) => (error ? reject(error) : resolve(opened)));
            });
            try {
                await new Promise<void>((resolve, reject) =>
                    db.exec(`PRAGMA key = "x'${key}'"; PRAGMA cipher_log_level = NONE; PRAGMA cipher_compatibility = ${compatibility};`, (error: Error | null) => (error ? reject(error) : resolve()))
                );
                return await new Promise<any[]>((resolve, reject) => db.all('SELECT count(*) AS n FROM events', [], (error: Error | null, rows: any[]) => (error ? reject(error) : resolve(rows))));
            } finally {
                await new Promise((resolve) => db.close(resolve));
            }
        };
        assert.deepEqual(await query(4), [{ n: 1 }], 'SQLCipher 4 settings open it');
        await assert.rejects(query(3), /not a database/, 'other settings do not');
    });
});

test('side files left without their main file by an interrupted conversion are removed', async () => {
    await withDir(async (baseDir) => {
        await fill(baseDir);
        writeFileSync(join(baseDir, 'mirror.db.unencrypted-journal'), 'plain pages');
        writeFileSync(join(baseDir, 'mirror.db.encrypting-journal'), 'half');
        const opened = await read(baseDir, { key: newKey() });
        assert.equal(opened.opened.converted, true);
        assert.deepEqual(readdirSync(baseDir), ['mirror.db']);
    });
});

for (const page of [1, 2, 3]) {
    test(`a damaged encrypted copy (page ${page}) is set aside and a new one started, not kept in memory at every start`, async () => {
        await withDir(async (baseDir) => {
            const key = newKey();
            await fill(baseDir, { key });
            const database = new MirrorDatabase(baseDir);
            await database.initialize({ key });
            // A few more pages, so that page 3 holds data.
            for (let index = 0; index < 40; index += 1) {
                await database.upsertCalendar({
                    protonCalendarId: `calendar-x${index}`,
                    slug: `calendar-x${index}`,
                    displayName: `Calendar ${'x'.repeat(300)} ${index}`,
                    color: '#000000',
                    description: '',
                    visible: true,
                    removed: false,
                    ctag: '1',
                    lastPolledAt: null,
                    lastSyncedAt: null
                });
            }
            await database.close();
            const file = join(baseDir, 'mirror.db');
            const bytes = readFileSync(file);
            randomBytes(512).copy(bytes, (page - 1) * 4096 + 1024);
            writeFileSync(file, bytes);

            const opened = await read(baseDir, { key });
            assert.match(opened.opened.replacedBy ?? '', /mirror\.db\.unreadable-\d+$/, 'set aside');
            assert.deepEqual(opened.calendars, [], 'a new copy, filled by the next sync');
            const again = await read(baseDir, { key });
            assert.equal(again.opened.replacedBy, undefined, 'the new copy opens fine');
        });
    });
}
