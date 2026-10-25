import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MirrorDatabase } from '../src/main/mirror-database';

test('mirror database stores calendars and events', async () => {
    const baseDir = mkdtempSync(join(tmpdir(), 'neutron-calendar-bridge-db-'));
    const database = new MirrorDatabase(baseDir);

    try {
        await database.initialize();
        await database.upsertCalendar({
            protonCalendarId: 'calendar-1',
            slug: 'calendar-1',
            displayName: 'Calendar One',
            color: '#123456',
            description: '',
            visible: true,
            removed: false,
            ctag: '1',
            lastPolledAt: null,
            lastSyncedAt: null
        });

        await database.upsertEvent({
            protonEventId: 'event-1',
            protonCalendarId: 'calendar-1',
            uid: 'uid-1',
            href: '/calendars/user/calendar-1/uid-1.ics',
            etag: '"etag"',
            contentHash: 'hash',
            serializedIcs: 'BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n',
            title: 'Event One',
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

        const calendars = await database.listCalendars();
        const events = await database.listEventsForCalendar('calendar-1');

        assert.equal(calendars.length, 1);
        assert.equal(events.length, 1);
        assert.equal(events[0].uid, 'uid-1');

        await database.markMissingEventsDeleted('calendar-1', []);
        const deletedEvents = await database.listEventsForCalendar('calendar-1', true);
        assert.equal(deletedEvents[0].deleted, true);
    } finally {
        await database.close();
        rmSync(baseDir, { recursive: true, force: true });
    }
});
