import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ConfigStore } from '../src/main/config-store';
import { MirrorDatabase } from '../src/main/mirror-database';
import { syncEachCalendar } from '../src/main/sync-utils';

test('syncEachCalendar keeps going after a calendar fails and reports it', async () => {
    const calendars = [
        { protonCalendarId: 'a', displayName: 'Alpha' },
        { protonCalendarId: 'b', displayName: 'Broken' },
        { protonCalendarId: 'c', displayName: 'Charlie' }
    ];
    const synced: string[] = [];

    const failures = await syncEachCalendar(calendars, async (calendar) => {
        if (calendar.protonCalendarId === 'b') {
            throw new Error('SQLITE_CONSTRAINT: UNIQUE constraint failed: events.href');
        }
        synced.push(calendar.protonCalendarId);
    });

    assert.deepEqual(synced, ['a', 'c']);
    assert.equal(failures.length, 1);
    assert.equal(failures[0].protonCalendarId, 'b');
    assert.equal(failures[0].displayName, 'Broken');
    assert.match(failures[0].message, /UNIQUE constraint/);
});

test('config store persists excluded calendar IDs and tolerates bad values', () => {
    const baseDir = mkdtempSync(join(tmpdir(), 'neutron-calendar-bridge-config-'));
    try {
        const store = new ConfigStore(baseDir);
        assert.deepEqual(store.load().excludedCalendarIds, []);

        store.update({ excludedCalendarIds: ['work', 'work', 'holidays'] });
        assert.deepEqual(new ConfigStore(baseDir).load().excludedCalendarIds, ['work', 'holidays']);

        // Other settings survive the round trip.
        store.update({ pollIntervalMs: 120_000 });
        const reloaded = new ConfigStore(baseDir).load();
        assert.equal(reloaded.pollIntervalMs, 120_000);
        assert.deepEqual(reloaded.excludedCalendarIds, ['work', 'holidays']);

        // A hand-edited or older config file must not break loading.
        const filePath = join(baseDir, 'config.json');
        const raw = JSON.parse(readFileSync(filePath, 'utf8'));
        writeFileSync(filePath, JSON.stringify({ ...raw, excludedCalendarIds: ['ok', 42, null, ''] }));
        assert.deepEqual(new ConfigStore(baseDir).load().excludedCalendarIds, ['ok']);

        writeFileSync(filePath, JSON.stringify({ ...raw, excludedCalendarIds: 'not-an-array' }));
        assert.deepEqual(new ConfigStore(baseDir).load().excludedCalendarIds, []);
    } finally {
        rmSync(baseDir, { recursive: true, force: true });
    }
});

test('mirror database drops only the events of an excluded calendar', async () => {
    const baseDir = mkdtempSync(join(tmpdir(), 'neutron-calendar-bridge-db-'));
    const database = new MirrorDatabase(baseDir);

    const calendar = (id: string) => ({
        protonCalendarId: id,
        slug: id,
        displayName: id,
        color: '#123456',
        description: '',
        visible: true,
        removed: false,
        ctag: '1',
        lastPolledAt: null,
        lastSyncedAt: null
    });
    const event = (id: string, calendarId: string) => ({
        protonEventId: id,
        protonCalendarId: calendarId,
        uid: `uid-${id}`,
        href: `/calendars/user/${calendarId}/uid-${id}.ics`,
        etag: '"etag"',
        contentHash: 'hash',
        serializedIcs: 'BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n',
        title: id,
        description: '',
        location: '',
        startTimestamp: 1,
        endTimestamp: 2,
        timezone: 'UTC',
        isAllDay: false,
        modifiedTimestamp: 3,
        deleted: false,
        lastSyncedAt: 4
    });

    try {
        await database.initialize();
        await database.upsertCalendar(calendar('keep'));
        await database.upsertCalendar(calendar('drop'));
        await database.upsertEvent(event('e1', 'keep'));
        await database.upsertEvent(event('e2', 'drop'));
        await database.upsertEvent(event('e3', 'drop'));

        const removed = await database.deleteEventsForCalendar('drop');

        assert.equal(removed, 2);
        assert.equal((await database.listEventsForCalendar('keep', true)).length, 1);
        assert.equal((await database.listEventsForCalendar('drop', true)).length, 0);
        // The calendar row itself stays, so it can still be listed (unticked) in the UI.
        assert.equal((await database.listCalendars()).length, 2);
    } finally {
        await database.close();
        rmSync(baseDir, { recursive: true, force: true });
    }
});
