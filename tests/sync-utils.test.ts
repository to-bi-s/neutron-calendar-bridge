import test from 'node:test';
import assert from 'node:assert/strict';

import { buildEventRecordShape, parseIcs, slugify, toIcs } from '../src/main/sync-utils';

test('slugify creates stable collection slugs', () => {
    assert.equal(slugify('My Calendar'), 'my-calendar');
    assert.equal(slugify('***'), 'calendar');
});

test('ICS serialization round-trips through parsing', () => {
    const ics = toIcs({
        uid: 'sync-utils-test',
        title: 'Calendar sync test',
        description: 'Round trip',
        location: 'Local',
        startTimestamp: 1767225600,
        endTimestamp: 1767229200,
        timezone: 'UTC',
        isAllDay: false
    });

    const parsed = parseIcs(ics);
    assert.equal(parsed.uid, 'sync-utils-test');
    assert.equal(parsed.eventData.title, 'Calendar sync test');
    assert.equal(parsed.eventData.description, 'Round trip');
    assert.equal(parsed.eventData.location, 'Local');
});

test('ICS serialization preserves wall-clock time for non-local timezones', () => {
    const ics = toIcs({
        uid: 'berlin-test',
        title: 'Berlin Event',
        description: '',
        location: '',
        startTimestamp: 1773397800,
        endTimestamp: 1773403200,
        timezone: 'Europe/Berlin',
        isAllDay: false
    });

    assert.match(ics, /DTSTART;TZID=Europe\/Berlin:20260313T113000/);
    assert.match(ics, /DTEND;TZID=Europe\/Berlin:20260313T130000/);

    const parsed = parseIcs(ics);
    assert.equal(parsed.eventData.startTime, 1773397800);
    assert.equal(parsed.eventData.endTime, 1773403200);
    assert.equal(parsed.eventData.timezone, 'Europe/Berlin');
});

test('event records derive deterministic etags', () => {
    const recordA = buildEventRecordShape({
        protonEventId: 'event-1',
        protonCalendarId: 'calendar-1',
        uid: 'uid-1',
        href: '/calendars/user/calendar-1/uid-1.ics',
        title: 'Hash me',
        description: 'Stable',
        location: 'Desk',
        startTimestamp: 1,
        endTimestamp: 2,
        timezone: 'UTC',
        isAllDay: false,
        modifiedTimestamp: 3
    });

    const recordB = buildEventRecordShape({
        protonEventId: 'event-1',
        protonCalendarId: 'calendar-1',
        uid: 'uid-1',
        href: '/calendars/user/calendar-1/uid-1.ics',
        title: 'Hash me',
        description: 'Stable',
        location: 'Desk',
        startTimestamp: 1,
        endTimestamp: 2,
        timezone: 'UTC',
        isAllDay: false,
        modifiedTimestamp: 3
    });

    assert.equal(recordA.contentHash, recordB.contentHash);
    assert.equal(recordA.etag, recordB.etag);
});

// ─── All-day events ──────────────────────────────────────────────────────────

const ALL_DAY_FROM_CALENDAR_APP = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Apple Inc.//macOS 26.0//EN', 'CALSCALE:GREGORIAN',
    'BEGIN:VEVENT', 'CREATED:20261001T080000Z', 'UID:ALLDAY-1', 'DTEND;VALUE=DATE:20261007',
    'TRANSP:TRANSPARENT', 'SUMMARY:Conference', 'DTSTAMP:20261001T080000Z', 'DTSTART;VALUE=DATE:20261005',
    'BEGIN:VALARM', 'ACTION:DISPLAY', 'TRIGGER;VALUE=DATE-TIME:20261004T070000Z', 'END:VALARM',
    'SEQUENCE:0', 'END:VEVENT', 'END:VCALENDAR', ''
].join('\r\n');

const dateIn = (unixSeconds: number, timeZone: string) =>
    new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hour12: false })
        .format(new Date(unixSeconds * 1000));

test('an all-day event from Calendar.app keeps its dates, also east of UTC', () => {
    const previous = process.env.TZ;
    try {
        for (const zone of ['Europe/Amsterdam', 'America/Los_Angeles', 'Pacific/Auckland', 'UTC']) {
            process.env.TZ = zone;
            const { eventData } = parseIcs(ALL_DAY_FROM_CALENDAR_APP);
            assert.equal(eventData.isAllDay, true);
            // The client reads these back as dates in the system zone (local midnight).
            assert.equal(dateIn(eventData.startTime, zone), '2026-10-05, 00', `start in ${zone}`);
            assert.equal(dateIn(eventData.endTime, zone), '2026-10-07, 00', `end in ${zone}`);
        }
        process.env.TZ = 'Europe/Amsterdam';
        const noEnd = parseIcs(ALL_DAY_FROM_CALENDAR_APP.replace('DTEND;VALUE=DATE:20261007\r\n', ''));
        assert.equal(dateIn(noEnd.eventData.endTime, 'Europe/Amsterdam'), '2026-10-06, 00', 'no DTEND means one day');
    } finally {
        if (previous === undefined) delete process.env.TZ;
        else process.env.TZ = previous;
    }
});

test('all-day events are served with DATE values (no time part)', () => {
    const base = { uid: 'x', title: 'Holiday', description: '', location: '', timezone: 'America/New_York', isAllDay: true, modifiedTimestamp: 1790000000 };
    const fromDates = toIcs({ ...base, startTimestamp: 0, endTimestamp: 0, allDay: { start: { year: 2026, month: 12, day: 31 } } });
    assert.match(fromDates, /^DTSTART;VALUE=DATE:20261231\r$/m);
    assert.match(fromDates, /^DTEND;VALUE=DATE:20270101\r$/m, 'single day: end is the next day');
    // Without the dates: Proton's timestamps are UTC midnight of the date, whatever the zone.
    const fromTimestamps = toIcs({ ...base, startTimestamp: Date.UTC(2026, 9, 5) / 1000, endTimestamp: Date.UTC(2026, 9, 8) / 1000 });
    assert.match(fromTimestamps, /^DTSTART;VALUE=DATE:20261005\r$/m);
    assert.match(fromTimestamps, /^DTEND;VALUE=DATE:20261008\r$/m);
    assert.doesNotMatch(fromTimestamps, /VALUE=DATE:\d{8}T/);

    const record = (end?: { year: number; month: number; day: number }) =>
        buildEventRecordShape({
            ...base, protonEventId: 'e', protonCalendarId: 'c', href: '/h', startTimestamp: 0, endTimestamp: 0,
            allDay: { start: { year: 2026, month: 10, day: 5 }, end }
        });
    assert.notEqual(record({ year: 2026, month: 10, day: 6 }).etag, record({ year: 2026, month: 10, day: 7 }).etag, 'dates are part of the ETag');
    assert.equal(record().etag, record({ year: 2026, month: 10, day: 6 }).etag, 'a redundant end does not change it');
});

test('0.48.5: a time zone on a plain date (Thunderbird\'s all-day events) is dropped; date-times keep theirs', async () => {
    const { withoutTimeZoneOnDates, parseIcs } = await import('../src/main/sync-utils');
    // An all-day meeting as Thunderbird 128 saved it (Proton refused it: "Cannot contain both TZID and date value").
    const thunderbird = [
        'BEGIN:VCALENDAR', 'PRODID:-//Mozilla.org/NONSGML Mozilla Calendar V1.1//EN', 'VERSION:2.0',
        'BEGIN:VEVENT', 'CREATED:20261020T175422Z', 'DTSTAMP:20261020T175525Z', 'UID:f488994b-354e-4984-9137-d12c63a7dfa0', 'SUMMARY:Chilln',
        'DTSTART;TZID=Europe/Amsterdam;VALUE=DATE:20261021', 'DTEND;TZID=Europe/Amsterdam;VALUE=DATE:20261022', 'TRANSP:TRANSPARENT',
        'END:VEVENT', 'END:VCALENDAR', ''
    ].join('\r\n');
    const fixed = withoutTimeZoneOnDates(thunderbird);
    assert.match(fixed, /\r\nDTSTART;VALUE=DATE:20261021\r\nDTEND;VALUE=DATE:20261022\r\n/);
    assert.doesNotMatch(fixed, /TZID/);
    const parsed = parseIcs(fixed);
    assert.equal(parsed.eventData.isAllDay, true);
    // Left alone: a date-time with its zone, a date with TZID but no VALUE=DATE, text that only looks like it.
    for (const untouched of ['DTSTART;TZID=Europe/Amsterdam:20261021T090000\r\n', 'DTSTART;TZID=Europe/Amsterdam:20261021\r\n', 'SUMMARY:DTSTART;TZID=X;VALUE=DATE:20261021\r\n']) {
        assert.equal(withoutTimeZoneOnDates(untouched), untouched);
    }
    assert.equal(withoutTimeZoneOnDates('EXDATE;TZID="Europe/Amsterdam";VALUE=DATE:20261021,20261028\n'), 'EXDATE;VALUE=DATE:20261021,20261028\n');
    assert.equal(withoutTimeZoneOnDates('DTSTART;VALUE=DATE;TZID=Europe/Amster\r\n dam:20261021\r\n'), 'DTSTART;VALUE=DATE:20261021\r\n', 'folded');
});
