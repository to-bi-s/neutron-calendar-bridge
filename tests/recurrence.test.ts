import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import * as nodeIcal from 'node-ical';
import type { ProtonVcalDateProperty, SyncedCalendarEvent } from 'proton-calendar-client';

import {
    buildSeriesIcs,
    formatRrule,
    groupIntoSeries,
    sameForProton,
    icsHasRecurrence,
    isRecurringSeries,
    readRecurrence
} from '../src/main/recurrence';
import { buildVtimezoneLines } from '../src/main/vtimezone';
import { fakeSafeStorage } from './support/fake-safe-storage';

// ─── Fixtures: an Outlook-style weekly meeting as Proton returns it ──────────

const TZ = 'Europe/Amsterdam';
const UID = '040000008200E00074C5B7101A82E00800000000C0FFEE@outlook.example';

const localDateTime = (year: number, month: number, day: number, hours: number, minutes = 0): ProtonVcalDateProperty => ({
    value: { year, month, day, hours, minutes, seconds: 0, isUTC: false },
    parameters: { tzid: TZ }
});
const allDay = (year: number, month: number, day: number): ProtonVcalDateProperty => ({
    value: { year, month, day },
    parameters: { type: 'date' }
});
/** Unix seconds for Amsterdam wall-clock time (CET +1 until 29 Mar 2026, CEST +2 after). */
const amsterdam = (month: number, day: number, hours: number, minutes = 0) => {
    const summer = month > 3 && month < 10 ? true : month === 3 ? day >= 29 : month === 10 ? day < 25 : false;
    return Date.UTC(2026, month - 1, day, hours - (summer ? 2 : 1), minutes) / 1000;
};

const protonEvent = (overrides: Partial<SyncedCalendarEvent> & { eventId: string }): SyncedCalendarEvent => ({
    calendarId: 'work',
    uid: UID,
    title: 'Team meeting',
    description: '',
    location: 'Room 4.12',
    startTimestamp: amsterdam(1, 5, 9),
    endTimestamp: amsterdam(1, 5, 10),
    timezone: TZ,
    isAllDay: false,
    modifiedTimestamp: 1_767_000_000,
    contentHash: 'x',
    ...overrides
});

const master = protonEvent({
    eventId: 'master-1',
    decrypted: {
        vevent: {
            dtstart: localDateTime(2026, 1, 5, 9),
            dtend: localDateTime(2026, 1, 5, 10),
            rrule: {
                value: {
                    freq: 'WEEKLY',
                    byday: ['MO'],
                    until: { year: 2026, month: 12, day: 28, hours: 22, minutes: 59, seconds: 59, isUTC: true }
                }
            },
            exdate: [localDateTime(2026, 2, 16, 9)],
            sequence: { value: 2 }
        }
    },
    raw: {
        StartTimezone: TZ,
        RRule: 'FREQ=WEEKLY;UNTIL=20261228T225959Z;BYDAY=MO',
        RecurrenceID: null,
        Exdates: [amsterdam(2, 16, 9)]
    }
});

const movedOccurrence = protonEvent({
    eventId: 'exception-moved',
    title: 'Team meeting (moved)',
    startTimestamp: amsterdam(3, 31, 14),
    endTimestamp: amsterdam(3, 31, 15),
    modifiedTimestamp: 1_767_100_000,
    decrypted: {
        vevent: {
            dtstart: localDateTime(2026, 3, 31, 14),
            dtend: localDateTime(2026, 3, 31, 15),
            'recurrence-id': localDateTime(2026, 3, 30, 9),
            sequence: { value: 3 }
        }
    },
    raw: { StartTimezone: TZ, RRule: null, RecurrenceID: amsterdam(3, 30, 9), Exdates: [] }
});

const cancelledOccurrence = protonEvent({
    eventId: 'exception-cancelled',
    startTimestamp: amsterdam(4, 6, 9),
    endTimestamp: amsterdam(4, 6, 10),
    decrypted: {
        status: 'CANCELLED',
        vevent: {
            dtstart: localDateTime(2026, 4, 6, 9),
            dtend: localDateTime(2026, 4, 6, 10),
            'recurrence-id': localDateTime(2026, 4, 6, 9),
            status: { value: 'CANCELLED' }
        }
    },
    raw: { StartTimezone: TZ, RRule: null, RecurrenceID: amsterdam(4, 6, 9), Exdates: [] }
});

const singleEvent = protonEvent({
    eventId: 'single-1',
    uid: 'single@proton.me',
    title: 'Dentist',
    decrypted: { vevent: { dtstart: localDateTime(2026, 5, 4, 8), dtend: localDateTime(2026, 5, 4, 9) } }
});

const withoutVevent = (event: SyncedCalendarEvent): SyncedCalendarEvent => ({ ...event, decrypted: undefined });

const icsLines = (ics: string) => ics.replace(/\r\n[ \t]/g, '').split('\r\n');

/** Lines inside VEVENT components only (VTIMEZONE has RRULEs of its own). */
const veventLines = (ics: string) => {
    let inside = false;
    return icsLines(ics).filter((line) => {
        if (line === 'BEGIN:VEVENT') inside = true;
        const keep = inside;
        if (line === 'END:VEVENT') inside = false;
        return keep;
    });
};

// ─── Grouping ────────────────────────────────────────────────────────────────

test('a series and its modified occurrences become one group keyed by the master', () => {
    // Order as Proton returns it: sorted by start time, exceptions before and after the master.
    const series = groupIntoSeries([movedOccurrence, master, singleEvent, cancelledOccurrence]);

    assert.equal(series.length, 2);
    const recurring = series.find((entry) => entry.uid === UID)!;
    assert.equal(recurring.key, 'master-1');
    assert.equal(recurring.master?.event.eventId, 'master-1');
    assert.deepEqual(
        recurring.exceptions.map((member) => member.event.eventId),
        ['exception-moved', 'exception-cancelled']
    );
    assert.equal(isRecurringSeries(recurring), true);

    const single = series.find((entry) => entry.uid === 'single@proton.me')!;
    assert.equal(single.key, 'single-1');
    assert.equal(isRecurringSeries(single), false);
});

test('0.49.7: "Show as: Free" (TRANSP:TRANSPARENT) is served, and counts as a change', () => {
    const free = protonEvent({
        eventId: 'free-1',
        uid: 'free@x',
        decrypted: { vevent: { dtstart: localDateTime(2026, 1, 5, 9), dtend: localDateTime(2026, 1, 5, 10), transp: { value: 'TRANSPARENT' } } } as any
    });
    const busy = protonEvent({ eventId: 'busy-1', uid: 'busy@x', decrypted: { vevent: { dtstart: localDateTime(2026, 1, 5, 9), dtend: localDateTime(2026, 1, 5, 10) } } as any });
    const [freeSeries] = groupIntoSeries([free]);
    const [busySeries] = groupIntoSeries([busy]);
    assert.match(buildSeriesIcs(freeSeries, 2026), /TRANSP:TRANSPARENT/);
    assert.doesNotMatch(buildSeriesIcs(busySeries, 2026), /TRANSP/, 'busy is the default: nothing served');
    const vevent = (transp?: string) => ({ dtstart: localDateTime(2026, 1, 5, 9), dtend: localDateTime(2026, 1, 5, 10), summary: { value: 'Lunch' }, ...(transp ? { transp: { value: transp } } : {}) });
    assert.equal(sameForProton([vevent()], [vevent('OPAQUE')]), true, 'OPAQUE is the default');
    assert.equal(sameForProton([vevent()], [vevent('TRANSPARENT')]), false, 'free is a change Proton stores');
});

test('duplicate masters with one UID keep the newest instead of failing the sync', () => {
    const older = protonEvent({ eventId: 'dup-old', uid: 'dup@x', modifiedTimestamp: 100 });
    const newer = protonEvent({ eventId: 'dup-new', uid: 'dup@x', modifiedTimestamp: 200 });
    const [series] = groupIntoSeries([older, newer]);

    assert.equal(series.key, 'dup-new');
    assert.deepEqual(series.droppedDuplicates.map((event) => event.eventId), ['dup-old']);
});

test('modified occurrences whose master is outside the window still form one resource', () => {
    const [series] = groupIntoSeries([cancelledOccurrence, movedOccurrence]);

    assert.equal(series.master, null);
    assert.equal(series.key, 'exception-cancelled'); // stable: smallest event ID
    const lines = veventLines(buildSeriesIcs(series, 2026));
    assert.equal(lines.filter((line) => line === 'BEGIN:VEVENT').length, 2);
    assert.equal(lines.filter((line) => line.startsWith('RECURRENCE-ID')).length, 2);
    assert.equal(lines.some((line) => line.startsWith('RRULE')), false);
});

// ─── Serialising ─────────────────────────────────────────────────────────────

test('series ICS carries RRULE, EXDATE and RECURRENCE-ID in the event time zone', () => {
    const [series] = groupIntoSeries([master, movedOccurrence, cancelledOccurrence]);
    const ics = buildSeriesIcs(series, 2026);
    const lines = icsLines(ics);

    assert.ok(!/\r(?!\n)|(?<!\r)\n/.test(ics), 'uses CRLF line endings only');
    assert.ok(ics.split('\r\n').every((line) => Buffer.byteLength(line, 'utf8') <= 75), 'lines folded at 75 octets');
    assert.equal(lines.filter((line) => line === 'BEGIN:VTIMEZONE').length, 1);
    assert.equal(lines.filter((line) => line === 'BEGIN:VEVENT').length, 3);
    assert.equal(lines.filter((line) => line.startsWith('UID:')).every((line) => line === `UID:${UID}`), true);

    assert.ok(lines.includes('DTSTART;TZID=Europe/Amsterdam:20260105T090000'));
    assert.ok(lines.includes('RRULE:FREQ=WEEKLY;UNTIL=20261228T225959Z;BYDAY=MO'));
    assert.ok(lines.includes('EXDATE;TZID=Europe/Amsterdam:20260216T090000'));
    assert.ok(lines.includes('RECURRENCE-ID;TZID=Europe/Amsterdam:20260330T090000'));
    assert.ok(lines.includes('DTSTART;TZID=Europe/Amsterdam:20260331T140000'));
    assert.ok(lines.includes('RECURRENCE-ID;TZID=Europe/Amsterdam:20260406T090000'));
    assert.ok(lines.includes('STATUS:CANCELLED'));
    assert.ok(!lines.some((line) => line.startsWith('METHOD')), 'no METHOD in a CalDAV resource (RFC 4791)');
    // RRULE/EXDATE belong to the master only.
    assert.equal(veventLines(ics).filter((line) => line.startsWith('RRULE')).length, 1);
    assert.equal(veventLines(ics).filter((line) => line.startsWith('EXDATE')).length, 1);

    // Stable output: same input, same bytes (no clock-based DTSTAMP), so no needless re-syncs.
    assert.equal(buildSeriesIcs(series, 2026), ics);
});

test('a standard iCalendar parser reads the series back correctly', () => {
    const [series] = groupIntoSeries([master, movedOccurrence, cancelledOccurrence]);
    const parsed = nodeIcal.sync.parseICS(buildSeriesIcs(series, 2026));
    const event = Object.values(parsed).find((entry: any) => entry?.type === 'VEVENT') as any;

    assert.ok(event, 'VEVENT parsed');
    assert.equal(event.uid, UID);
    assert.equal(event.summary, 'Team meeting');
    assert.equal(new Date(event.start).toISOString(), '2026-01-05T08:00:00.000Z');
    assert.ok(event.rrule, 'RRULE parsed');
    // node-ical 0.27 files each EXDATE under its date and its date-time: counted by moment.
    assert.equal(new Set(Object.values(event.exdate || {}).map((date: any) => new Date(date).getTime())).size, 1);

    const overrides = [...new Set(Object.values(event.recurrences || {}))] as any[]; // the same: one object under both keys
    assert.equal(overrides.length, 2);
    const moved = overrides.find((entry) => entry.summary === 'Team meeting (moved)');
    assert.ok(moved, 'moved occurrence parsed');
    assert.equal(new Date(moved.start).toISOString(), '2026-03-31T12:00:00.000Z'); // 14:00 CEST
    assert.equal(overrides.find((entry) => entry !== moved).status, 'CANCELLED');

    // Weekly on Mondays: four Mondays in February 2026 (the EXDATE is applied by clients on top).
    const february = event.rrule.between(new Date('2026-02-01T00:00:00Z'), new Date('2026-03-01T00:00:00Z'));
    assert.equal(february.length, 4);
});

test('without the patched client, Proton metadata yields the same recurrence lines', () => {
    const fromVevent = icsLines(buildSeriesIcs(groupIntoSeries([master, movedOccurrence, cancelledOccurrence])[0], 2026));
    const fromMetadata = icsLines(
        buildSeriesIcs(
            groupIntoSeries([withoutVevent(master), withoutVevent(movedOccurrence), withoutVevent(cancelledOccurrence)])[0],
            2026
        )
    );
    const recurrenceLines = (lines: string[]) =>
        lines.filter((line) => /^(DTSTART|DTEND|RRULE|EXDATE|RECURRENCE-ID)[;:]/.test(line));

    assert.deepEqual(recurrenceLines(fromMetadata), recurrenceLines(fromVevent));
});

test('all-day yearly series uses DATE values throughout', () => {
    const birthday = protonEvent({
        eventId: 'bday',
        uid: 'bday@proton.me',
        title: 'Birthday',
        isAllDay: true,
        startTimestamp: Date.UTC(2026, 6, 14) / 1000,
        endTimestamp: Date.UTC(2026, 6, 15) / 1000,
        decrypted: {
            vevent: {
                dtstart: allDay(2026, 7, 14),
                dtend: allDay(2026, 7, 15),
                rrule: { value: { freq: 'YEARLY', until: { year: 2030, month: 7, day: 14 } } },
                exdate: [allDay(2028, 7, 14)]
            }
        }
    });
    const lines = icsLines(buildSeriesIcs(groupIntoSeries([birthday])[0], 2026));

    assert.ok(lines.includes('DTSTART;VALUE=DATE:20260714'));
    assert.ok(lines.includes('DTEND;VALUE=DATE:20260715'));
    assert.ok(lines.includes('RRULE:FREQ=YEARLY;UNTIL=20300714'));
    assert.ok(lines.includes('EXDATE;VALUE=DATE:20280714'));
    assert.ok(!lines.includes('BEGIN:VTIMEZONE'), 'no time zone needed for dates');
});

test('formatRrule orders parts and joins lists', () => {
    assert.equal(
        formatRrule({ byday: ['MO', 'WE'], interval: 2, freq: 'weekly', wkst: 'mo', count: 10 }),
        'FREQ=WEEKLY;COUNT=10;INTERVAL=2;BYDAY=MO,WE;WKST=MO'
    );
    assert.equal(formatRrule({ freq: 'MONTHLY', byday: '-1FR', bysetpos: [-1] }), 'FREQ=MONTHLY;BYDAY=-1FR;BYSETPOS=-1');
    assert.equal(formatRrule({ interval: 2 }), undefined, 'no FREQ, no rule');
});

test('readRecurrence ignores a malformed metadata RRULE', () => {
    const odd = withoutVevent(protonEvent({ eventId: 'odd', raw: { RRule: '{"freq":"weekly"}' } }));
    assert.equal(readRecurrence(odd).rrule, undefined);
});

// ─── Time zones ──────────────────────────────────────────────────────────────

test('VTIMEZONE uses real DST rules (EU last Sunday, US second/first Sunday)', () => {
    const amsterdam = buildVtimezoneLines('Europe/Amsterdam', 2026)!;
    assert.deepEqual(amsterdam, [
        'BEGIN:VTIMEZONE',
        'TZID:Europe/Amsterdam',
        'BEGIN:STANDARD',
        'DTSTART:19701025T030000',
        'RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU',
        'TZOFFSETFROM:+0200',
        'TZOFFSETTO:+0100',
        'END:STANDARD',
        'BEGIN:DAYLIGHT',
        'DTSTART:19700329T020000',
        'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU',
        'TZOFFSETFROM:+0100',
        'TZOFFSETTO:+0200',
        'END:DAYLIGHT',
        'END:VTIMEZONE'
    ]);

    const newYork = buildVtimezoneLines('America/New_York', 2026)!;
    assert.ok(newYork.includes('DTSTART:19700308T020000'));
    assert.ok(newYork.includes('RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU'));
    assert.ok(newYork.includes('DTSTART:19701101T020000'));
    assert.ok(newYork.includes('RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU'));
    assert.ok(newYork.includes('TZOFFSETTO:-0400'));

    const sydney = buildVtimezoneLines('Australia/Sydney', 2026)!;
    assert.ok(sydney.includes('RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=1SU'));
    assert.ok(sydney.includes('RRULE:FREQ=YEARLY;BYMONTH=4;BYDAY=1SU'));

    const tokyo = buildVtimezoneLines('Asia/Tokyo', 2026)!;
    assert.ok(tokyo.includes('TZOFFSETFROM:+0900') && tokyo.includes('TZOFFSETTO:+0900'));
    assert.ok(!tokyo.some((line) => line.startsWith('RRULE')));

    assert.equal(buildVtimezoneLines('UTC', 2026), null);
    assert.equal(buildVtimezoneLines('Not/AZone', 2026), null);
});

// ─── Guarding writes ─────────────────────────────────────────────────────────

test('icsHasRecurrence spots series, single occurrences and multi-VEVENT payloads', () => {
    const plain = 'BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:a\r\nDTSTART:20260101T090000Z\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n';
    assert.equal(icsHasRecurrence(plain), false);
    assert.equal(icsHasRecurrence(plain.replace('END:VEVENT', 'RRULE:FREQ=DAILY\r\nEND:VEVENT')), true);
    assert.equal(
        icsHasRecurrence(plain.replace('END:VEVENT', 'RECURRENCE-ID;TZID=Europe/Amsterdam:20260105T090000\r\nEND:VEVENT')),
        true
    );
    assert.equal(icsHasRecurrence(plain.replace('END:VEVENT', 'EXDATE:20260105T090000Z\r\nEND:VEVENT')), true);
    // Folded property name continuation is still detected.
    assert.equal(icsHasRecurrence(plain.replace('END:VEVENT', 'RRU\r\n LE:FREQ=DAILY\r\nEND:VEVENT')), true);
    assert.equal(icsHasRecurrence(plain.replace('END:VCALENDAR', 'BEGIN:VEVENT\r\nUID:a\r\nEND:VEVENT\r\nEND:VCALENDAR')), true);
    // A description mentioning RRULE is not a recurrence.
    assert.equal(icsHasRecurrence(plain.replace('END:VEVENT', 'DESCRIPTION:see RRULE:FREQ=DAILY\r\nEND:VEVENT')), false);
});

test('an ordinary timed event from Calendar.app (VTIMEZONE with DST RRULEs) stays editable', () => {
    const fromCalendarApp = [
        'BEGIN:VCALENDAR',
        'VERSION:2.0',
        'PRODID:-//Apple Inc.//macOS 26.0//EN',
        'CALSCALE:GREGORIAN',
        ...buildVtimezoneLines('Europe/Amsterdam', 2026)!,
        'BEGIN:VEVENT',
        'UID:3F2A-11AA@apple',
        'DTSTAMP:20260928T200000Z',
        'DTSTART;TZID=Europe/Amsterdam:20261001T090000',
        'DTEND;TZID=Europe/Amsterdam:20261001T100000',
        'SUMMARY:Coffee',
        'BEGIN:VALARM',
        'ACTION:DISPLAY',
        'TRIGGER:-PT15M',
        'END:VALARM',
        'END:VEVENT',
        'END:VCALENDAR',
        ''
    ].join('\r\n');

    assert.equal(icsHasRecurrence(fromCalendarApp), false);
    assert.equal(
        icsHasRecurrence(fromCalendarApp.replace('SUMMARY:Coffee', 'SUMMARY:Coffee\r\nRRULE:FREQ=WEEKLY')),
        true
    );
});

// ─── The sync loop against the real mirror database ──────────────────────────

const stubElectron = () => {
    const resolved = require.resolve('electron');
    require.cache[resolved] = {
        id: resolved,
        filename: resolved,
        loaded: true,
        exports: {
            app: { setLoginItemSettings: () => undefined },
            safeStorage: fakeSafeStorage
        }
    } as unknown as NodeJS.Module;
};

test('sync stores a recurring series as one resource and repairs rows from the old format', async () => {
    stubElectron();
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { BridgeService } = require('../src/main/bridge-service') as typeof import('../src/main/bridge-service');
    const baseDir = mkdtempSync(join(tmpdir(), 'neutron-calendar-bridge-recurrence-'));
    const service = new BridgeService(baseDir) as any;

    try {
        await service.mirrorDatabase.initialize();
        service.localCaldavPassword = 'test';
        const calendar = {
            protonCalendarId: 'work',
            slug: 'work',
            displayName: 'Work',
            color: '#123456',
            description: '',
            visible: true,
            removed: false,
            ctag: '1',
            lastPolledAt: null,
            lastSyncedAt: null
        };
        await service.mirrorDatabase.upsertCalendar(calendar);

        // What the old code left behind: only the moved occurrence got in before the UNIQUE error.
        await service.mirrorDatabase.upsertEvent({
            protonEventId: 'exception-moved',
            protonCalendarId: 'work',
            uid: UID,
            href: `/calendars/neutron-calendar-bridge/work/${encodeURIComponent(UID)}.ics`,
            etag: '"old"',
            contentHash: 'old',
            serializedIcs: 'BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n',
            title: 'Team meeting (moved)',
            description: '',
            location: '',
            startTimestamp: 1,
            endTimestamp: 2,
            timezone: TZ,
            isAllDay: false,
            modifiedTimestamp: 1,
            deleted: false,
            lastSyncedAt: 1
        });

        service.protonAdapter = {
            isSignedIn: () => true,
            listEvents: async () => [movedOccurrence, master, singleEvent, cancelledOccurrence]
        };

        await service.syncEventsForCalendar(calendar);

        const rows = await service.mirrorDatabase.listEventsForCalendar('work');
        assert.equal(rows.length, 2, 'one row per UID');
        const seriesRow = rows.find((row: any) => row.uid === UID);
        assert.equal(seriesRow.protonEventId, 'master-1');
        assert.equal(seriesRow.href, `/calendars/neutron-calendar-bridge/work/${encodeURIComponent(UID)}.ics`);
        assert.match(seriesRow.serializedIcs, /RRULE:FREQ=WEEKLY/);
        assert.equal((seriesRow.serializedIcs.match(/BEGIN:VEVENT/g) || []).length, 3);

        const singleRow = rows.find((row: any) => row.uid === 'single@proton.me');
        assert.doesNotMatch(singleRow.serializedIcs, /RRULE/);

        // A second pass with unchanged data must not rewrite anything (no ctag churn),
        // but it still counts as a check: lastPolledAt moves, lastSyncedAt (last change) does not.
        const before = await service.mirrorDatabase.getCalendarById('work');
        await new Promise((resolve) => setTimeout(resolve, 1100));
        await service.syncEventsForCalendar(before);
        const after = await service.mirrorDatabase.getCalendarById('work');
        assert.equal(after.ctag, before.ctag, 'unchanged series and single events do not bump the ctag');
        assert.equal(after.lastSyncedAt, before.lastSyncedAt, 'no change recorded');
        assert.ok(after.lastPolledAt > before.lastPolledAt, 'the check itself is recorded');

        // Without the patched client (no syncSeries), writes to a series are refused rather than flattened.
        await assert.rejects(
            service.upsertLocalEvent('work', `${encodeURIComponent(UID)}.ics`, seriesRow.href, seriesRow.serializedIcs),
            { name: 'ReadOnlyEventError' }
        );
        await assert.rejects(service.deleteLocalEvent('work', UID), { name: 'ReadOnlyEventError' });
    } finally {
        await service.mirrorDatabase.close();
        rmSync(baseDir, { recursive: true, force: true });
    }
});

test('events created in Calendar.app keep the UID and address Calendar.app knows', async () => {
    stubElectron();
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { BridgeService } = require('../src/main/bridge-service') as typeof import('../src/main/bridge-service');
    const baseDir = mkdtempSync(join(tmpdir(), 'neutron-calendar-bridge-identity-'));
    const service = new BridgeService(baseDir) as any;
    const calls: string[] = [];

    try {
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

        const appleUid = 'A1B2C3D4-APPLE';
        const appleHref = `/calendars/neutron-calendar-bridge/tobi-private/${appleUid}.ics`;
        const appleIcs = (summary: string) =>
            [
                'BEGIN:VCALENDAR',
                'VERSION:2.0',
                'BEGIN:VEVENT',
                `UID:${appleUid}`,
                'DTSTAMP:20260929T100000Z',
                'DTSTART:20261001T080000Z',
                'DTEND:20261001T090000Z',
                `SUMMARY:${summary}`,
                'END:VEVENT',
                'END:VCALENDAR',
                ''
            ].join('\r\n');

        // Proton gives events created through the bridge a UID of its own.
        service.protonAdapter = {
            isSignedIn: () => true,
            createEvent: async () => {
                calls.push('create');
                return { success: true, id: 'proton-new-1' };
            },
            updateEvent: async (_calendarId: string, eventId: string) => {
                calls.push(`update:${eventId}`);
                return { success: true };
            },
            listEvents: async () => [
                protonEvent({
                    eventId: 'proton-new-1',
                    calendarId: 'private',
                    uid: 'random-4f1c@proton.me',
                    title: 'Coffee',
                    startTimestamp: Date.UTC(2026, 9, 1, 8) / 1000,
                    endTimestamp: Date.UTC(2026, 9, 1, 9) / 1000,
                    timezone: 'UTC'
                })
            ]
        };

        await service.upsertLocalEvent('tobi-private', `${appleUid}.ics`, appleHref, appleIcs('Coffee'));
        await service.syncEventsForCalendar(calendar);

        const rows = await service.mirrorDatabase.listEventsForCalendar('private');
        assert.equal(rows.length, 1);
        assert.equal(rows[0].uid, appleUid, 'UID Calendar.app knows is kept');
        assert.equal(rows[0].href, appleHref, 'address Calendar.app knows is kept');
        assert.match(rows[0].serializedIcs, new RegExp(`UID:${appleUid}`));

        // Editing it again in Calendar.app updates the same Proton event instead of creating a duplicate.
        await service.upsertLocalEvent('tobi-private', `${appleUid}.ics`, appleHref, appleIcs('Coffee with Anna'));
        assert.deepEqual(calls, ['create', 'update:proton-new-1']);
    } finally {
        await service.mirrorDatabase.close();
        rmSync(baseDir, { recursive: true, force: true });
    }
});
