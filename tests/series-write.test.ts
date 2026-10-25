/**
 * Writing recurring events from Calendar.app to Proton. The payloads below are what
 * Calendar.app PUTs in the everyday cases; the Proton side is a fake that records the
 * sync requests, but ICS parsing goes through the real proton-calendar-client.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fakeSafeStorage } from './support/fake-safe-storage';

const UID = '7A1D2C3B-SERIES@apple';
const HREF = `/calendars/neutron-calendar-bridge/tobi-private/${UID}.ics`;

const vevent = (lines: string[]) => ['BEGIN:VEVENT', `UID:${UID}`, 'DTSTAMP:20260929T100000Z', ...lines, 'END:VEVENT'];
const calendarOf = (...vevents: string[][]) =>
    ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Apple Inc.//macOS 26.0//EN', ...vevents.flat(), 'END:VCALENDAR', ''].join('\r\n');

const master = (extra: string[] = []) =>
    vevent([
        'DTSTART;TZID=Europe/Amsterdam:20261005T090000',
        'DTEND;TZID=Europe/Amsterdam:20261005T100000',
        'RRULE:FREQ=WEEKLY;BYDAY=MO',
        'SUMMARY:Standup',
        'BEGIN:VALARM',
        'ACTION:DISPLAY',
        'TRIGGER:-PT10M',
        'END:VALARM',
        ...extra
    ]);
const movedOccurrence = vevent([
    'RECURRENCE-ID;TZID=Europe/Amsterdam:20261012T090000',
    'DTSTART;TZID=Europe/Amsterdam:20261013T140000',
    'DTEND;TZID=Europe/Amsterdam:20261013T150000',
    'SUMMARY:Standup (moved)'
]);

const stubElectron = () => {
    const resolved = require.resolve('electron');
    require.cache[resolved] = {
        id: resolved,
        filename: resolved,
        loaded: true,
        exports: { app: { setLoginItemSettings: () => undefined }, safeStorage: fakeSafeStorage }
    } as unknown as NodeJS.Module;
};

interface SyncCall {
    components: Array<{ key: string; protonEventId?: string; summary?: string; dtstart?: any; dtend?: any; duration?: any }>;
    deleteEventIds: string[];
}

/** Fake Proton adapter: parses with the real client, records syncSeries calls, hands out IDs. */
const createFakeAdapter = async () => {
    const client = await import('proton-calendar-client');
    const api = new client.ProtonCalendarAPI({ username: 'u', password: 'p' });
    const calls: SyncCall[] = [];
    let nextId = 1;
    const adapter = {
        isSignedIn: () => true,
        supportsSeriesSync: () => true,
        parseIcs: (ics: string) => api.parseIcsToVevents(ics),
        syncSeries: async (input: any) => {
            calls.push({
                components: input.components.map((component: any) => ({
                    key: component.vevent['recurrence-id']
                        ? JSON.stringify(component.vevent['recurrence-id'].value)
                        : '',
                    protonEventId: component.protonEventId,
                    summary: component.vevent.summary?.value,
                    dtstart: component.vevent.dtstart,
                    dtend: component.vevent.dtend,
                    duration: component.vevent.duration
                })),
                deleteEventIds: input.deleteEventIds || []
            });
            return {
                success: true,
                eventIds: input.components.map((component: any) => component.protonEventId || `proton-${nextId++}`)
            };
        },
        listEvents: async () => []
    };
    return { adapter, calls };
};

const setup = async () => {
    stubElectron();
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { BridgeService } = require('../src/main/bridge-service') as typeof import('../src/main/bridge-service');
    const baseDir = mkdtempSync(join(tmpdir(), 'neutron-calendar-bridge-series-write-'));
    const service = new BridgeService(baseDir) as any;
    await service.mirrorDatabase.initialize();
    service.localCaldavPassword = 'test';
    const calendar = {
        protonCalendarId: 'private',
        slug: 'tobi-private',
        displayName: 'Tobi (Private)',
        color: '#123456',
        description: '',
        visible: true,
        removed: false,
        ctag: '1',
        lastPolledAt: null,
        lastSyncedAt: null
    };
    await service.mirrorDatabase.upsertCalendar(calendar);
    const { adapter, calls } = await createFakeAdapter();
    service.protonAdapter = adapter;
    const cleanup = async () => {
        await service.mirrorDatabase.close();
        rmSync(baseDir, { recursive: true, force: true });
    };
    return { service, calls, cleanup };
};

test('creating a repeating event in Calendar.app creates one Proton master with the RRULE', async () => {
    const { service, calls, cleanup } = await setup();
    try {
        const record = await service.upsertLocalEvent('tobi-private', `${UID}.ics`, HREF, calendarOf(master()));

        assert.equal(calls.length, 1);
        assert.deepEqual(calls[0].components.map((component) => [component.key, component.protonEventId]), [['', undefined]]);
        assert.deepEqual(calls[0].deleteEventIds, []);
        assert.deepEqual(record.protonEventIds, { '': 'proton-1' });
        assert.equal(record.uid, UID);
        assert.equal(record.href, HREF);
        assert.equal(record.timezone, 'Europe/Amsterdam');
        assert.equal(new Date(record.startTimestamp * 1000).toISOString(), '2026-10-05T07:00:00.000Z'); // 09:00 CEST

        const rows = await service.mirrorDatabase.listEventsForCalendar('private');
        assert.equal(rows.length, 1);
        assert.deepEqual(rows[0].protonEventIds, { '': 'proton-1' });
    } finally {
        await cleanup();
    }
});

test('moving one occurrence updates the master and creates a Proton exception', async () => {
    const { service, calls, cleanup } = await setup();
    try {
        await service.upsertLocalEvent('tobi-private', `${UID}.ics`, HREF, calendarOf(master()));
        const record = await service.upsertLocalEvent(
            'tobi-private',
            `${UID}.ics`,
            HREF,
            calendarOf(master(), movedOccurrence)
        );

        const call = calls[1];
        assert.equal(call.components.length, 2);
        assert.equal(call.components[0].protonEventId, 'proton-1', 'master is updated, not recreated');
        assert.equal(call.components[1].protonEventId, undefined, 'exception is new');
        assert.equal(call.components[1].summary, 'Standup (moved)');
        assert.deepEqual(call.deleteEventIds, []);
        assert.deepEqual(Object.values(record.protonEventIds).sort(), ['proton-1', 'proton-2']);
        assert.equal(record.protonEventIds[''], 'proton-1');

        // Editing the moved occurrence again updates that same Proton event.
        await service.upsertLocalEvent(
            'tobi-private',
            `${UID}.ics`,
            HREF,
            calendarOf(master(), movedOccurrence.map((line) => line.replace('Standup (moved)', 'Standup (moved again)')))
        );
        assert.deepEqual(
            calls[2].components.map((component) => component.protonEventId),
            ['proton-1', 'proton-2']
        );
    } finally {
        await cleanup();
    }
});

test('deleting a moved occurrence (EXDATE on the master) deletes the Proton exception', async () => {
    const { service, calls, cleanup } = await setup();
    try {
        await service.upsertLocalEvent('tobi-private', `${UID}.ics`, HREF, calendarOf(master(), movedOccurrence));
        const record = await service.upsertLocalEvent(
            'tobi-private',
            `${UID}.ics`,
            HREF,
            calendarOf(master(['EXDATE;TZID=Europe/Amsterdam:20261012T090000']))
        );

        const call = calls[1];
        assert.deepEqual(call.components.map((component) => component.protonEventId), ['proton-1']);
        assert.deepEqual(call.deleteEventIds, ['proton-2'], 'the orphaned exception is removed in the same request');
        assert.deepEqual(record.protonEventIds, { '': 'proton-1' });
    } finally {
        await cleanup();
    }
});

test('deleting the whole series removes the master and every exception in one request', async () => {
    const { service, calls, cleanup } = await setup();
    try {
        await service.upsertLocalEvent('tobi-private', `${UID}.ics`, HREF, calendarOf(master(), movedOccurrence));
        await service.deleteLocalEvent('tobi-private', UID);

        const call = calls[1];
        assert.equal(call.components.length, 0);
        assert.deepEqual(call.deleteEventIds.sort(), ['proton-1', 'proton-2']);
        const rows = await service.mirrorDatabase.listEventsForCalendar('private', true);
        assert.equal(rows[0].deleted, true);
    } finally {
        await cleanup();
    }
});

test('turning a series into a single event ("Repeat: None") goes through the series writer', async () => {
    const { service, calls, cleanup } = await setup();
    try {
        await service.upsertLocalEvent('tobi-private', `${UID}.ics`, HREF, calendarOf(master(), movedOccurrence));
        const plain = vevent([
            'DTSTART;TZID=Europe/Amsterdam:20261005T090000',
            'DTEND;TZID=Europe/Amsterdam:20261005T100000',
            'SUMMARY:Standup'
        ]);
        const record = await service.upsertLocalEvent('tobi-private', `${UID}.ics`, HREF, calendarOf(plain));

        const call = calls[1];
        assert.deepEqual(call.components.map((component) => component.protonEventId), ['proton-1'], 'master updated without RRULE');
        assert.deepEqual(call.deleteEventIds, ['proton-2'], 'exception no longer exists');
        assert.deepEqual(record.protonEventIds, { '': 'proton-1' });
    } finally {
        await cleanup();
    }
});

test('a Proton rejection leaves the mirror untouched and surfaces the reason', async () => {
    const { service, calls, cleanup } = await setup();
    try {
        await service.upsertLocalEvent('tobi-private', `${UID}.ics`, HREF, calendarOf(master()));
        service.protonAdapter.syncSeries = async () => ({ success: false, error: 'Proton rejected the series update: 2001', eventIds: [] });

        await assert.rejects(
            service.upsertLocalEvent('tobi-private', `${UID}.ics`, HREF, calendarOf(master(), movedOccurrence)),
            /Proton rejected the series update: 2001/
        );
        const rows = await service.mirrorDatabase.listEventsForCalendar('private');
        assert.deepEqual(rows[0].protonEventIds, { '': 'proton-1' });
        assert.doesNotMatch(rows[0].serializedIcs, /RECURRENCE-ID/);
        assert.equal(calls.length, 1);
    } finally {
        await cleanup();
    }
});

test('a series pulled from Proton can then be edited from Calendar.app (IDs carried over)', async () => {
    const { service, calls, cleanup } = await setup();
    try {
        // What the sync loop stores for a series that already exists in Proton.
        await service.mirrorDatabase.upsertEvent({
            protonEventId: 'master-from-proton',
            protonCalendarId: 'private',
            uid: UID,
            href: HREF,
            etag: '"x"',
            contentHash: 'x',
            serializedIcs: calendarOf(master(), movedOccurrence),
            title: 'Standup',
            description: '',
            location: '',
            startTimestamp: 1,
            endTimestamp: 2,
            timezone: 'Europe/Amsterdam',
            isAllDay: false,
            modifiedTimestamp: 1,
            deleted: false,
            lastSyncedAt: 1,
            protonEventIds: { '': 'master-from-proton', '20261012T090000': 'exception-from-proton' }
        });

        // Rename the whole series in Calendar.app.
        await service.upsertLocalEvent(
            'tobi-private',
            `${UID}.ics`,
            HREF,
            calendarOf(master().map((line) => line.replace('SUMMARY:Standup', 'SUMMARY:Daily standup')), movedOccurrence)
        );

        assert.deepEqual(
            calls[0].components.map((component) => component.protonEventId),
            ['master-from-proton', 'exception-from-proton']
        );
        assert.deepEqual(calls[0].deleteEventIds, []);
    } finally {
        await cleanup();
    }
});

test('after a Mac-side edit, the next pull from Proton keeps the same resource and IDs', async () => {
    const { service, cleanup } = await setup();
    try {
        await service.upsertLocalEvent('tobi-private', `${UID}.ics`, HREF, calendarOf(master(), movedOccurrence));

        // Proton now returns the series under the IDs it handed out, with its own UID.
        const TZ = 'Europe/Amsterdam';
        const at = (y: number, m: number, d: number, h: number) => ({
            value: { year: y, month: m, day: d, hours: h, minutes: 0, seconds: 0, isUTC: false },
            parameters: { tzid: TZ }
        });
        const base = {
            calendarId: 'private',
            uid: 'proton-assigned@proton.me',
            description: '',
            location: '',
            timezone: TZ,
            isAllDay: false,
            contentHash: 'x',
            modifiedTimestamp: 5
        };
        service.protonAdapter.listEvents = async () => [
            {
                ...base,
                eventId: 'proton-1',
                title: 'Standup',
                startTimestamp: Date.UTC(2026, 9, 5, 7) / 1000,
                endTimestamp: Date.UTC(2026, 9, 5, 8) / 1000,
                decrypted: {
                    vevent: { dtstart: at(2026, 10, 5, 9), dtend: at(2026, 10, 5, 10), rrule: { value: { freq: 'WEEKLY', byday: ['MO'] } } }
                }
            },
            {
                ...base,
                eventId: 'proton-2',
                title: 'Standup (moved)',
                startTimestamp: Date.UTC(2026, 9, 13, 12) / 1000,
                endTimestamp: Date.UTC(2026, 9, 13, 13) / 1000,
                decrypted: {
                    vevent: { dtstart: at(2026, 10, 13, 14), dtend: at(2026, 10, 13, 15), 'recurrence-id': at(2026, 10, 12, 9) }
                }
            }
        ];
        const calendar = await service.mirrorDatabase.getCalendarById('private');
        await service.syncEventsForCalendar(calendar);

        const rows = await service.mirrorDatabase.listEventsForCalendar('private');
        assert.equal(rows.length, 1, 'still one resource');
        assert.equal(rows[0].uid, UID, 'Calendar.app keeps its UID');
        assert.equal(rows[0].href, HREF);
        assert.deepEqual(rows[0].protonEventIds, { '': 'proton-1', '20261012T090000': 'proton-2' });
        assert.match(rows[0].serializedIcs, /RRULE:FREQ=WEEKLY;BYDAY=MO/);
        assert.match(rows[0].serializedIcs, /RECURRENCE-ID;TZID=Europe\/Amsterdam:20261012T090000/);
    } finally {
        await cleanup();
    }
});

test('0.40: an event written with DURATION instead of DTEND reaches Proton with its end', async () => {
    const { service, calls, cleanup } = await setup();
    try {
        const withDuration = vevent(['DTSTART;TZID=Europe/Amsterdam:20261005T090000', 'DURATION:PT1H30M', 'RRULE:FREQ=WEEKLY;BYDAY=MO', 'SUMMARY:Standup']);
        const record = await service.upsertLocalEvent('tobi-private', `${UID}.ics`, HREF, calendarOf(withDuration));
        assert.equal(calls.length, 1);
        const written = calls[0].components[0];
        assert.equal(written.duration, undefined, 'no DURATION goes to Proton');
        assert.deepEqual(written.dtend, { value: { year: 2026, month: 10, day: 5, hours: 10, minutes: 30, seconds: 0, isUTC: false }, parameters: { tzid: 'Europe/Amsterdam' } });
        assert.equal(record.endTimestamp - record.startTimestamp, 90 * 60, 'the local copy has the length too');
    } finally {
        await cleanup();
    }
});

test('0.40: moving an event to another time zone at the same instant is written to Proton', async () => {
    const { service, calls, cleanup } = await setup();
    try {
        const amsterdam = vevent(['DTSTART;TZID=Europe/Amsterdam:20261005T090000', 'DTEND;TZID=Europe/Amsterdam:20261005T100000', 'RRULE:FREQ=WEEKLY;BYDAY=MO', 'SUMMARY:Call']);
        await service.upsertLocalEvent('tobi-private', `${UID}.ics`, HREF, calendarOf(amsterdam));
        // The same instant written in London time (08:00 BST = 09:00 CEST).
        const london = vevent(['DTSTART;TZID=Europe/London:20261005T080000', 'DTEND;TZID=Europe/London:20261005T090000', 'RRULE:FREQ=WEEKLY;BYDAY=MO', 'SUMMARY:Call']);
        const record = await service.upsertLocalEvent('tobi-private', `${UID}.ics`, HREF, calendarOf(london));
        assert.equal(calls.length, 2, 'the zone change is written, not taken as "unchanged"');
        assert.equal(calls[1].components[0].dtstart.parameters.tzid, 'Europe/London');
        assert.equal(record.timezone, 'Europe/London');
    } finally {
        await cleanup();
    }
});
