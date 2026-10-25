/**
 * Offline test for availability (0.33.2): the busy periods of events and series in a window —
 * transparent, cancelled and declined events left out, series expanded (DST-safe), exceptions
 * replacing their occurrences, excluded occurrences dropped, merging and clipping.
 */
import { busyPeriodsOf, mergeBusyPeriods, seriesLastEndOf } from '../src/busy.ts';
import { parse as parseVcal } from '@proton/shared/lib/calendar/vcal';

let failures = 0;
const check = (condition: unknown, label: string) => {
    console.log(`${condition ? 'ok  ' : 'FAIL'} ${label}`);
    if (!condition) failures += 1;
};
const ics = (...lines: string[]) => ['BEGIN:VCALENDAR', 'VERSION:2.0', ...lines, 'END:VCALENDAR'].join('\r\n');
const vevent = (...lines: string[]) => ['BEGIN:VEVENT', 'UID:u1', 'DTSTAMP:20260101T000000Z', ...lines, 'END:VEVENT'];
const iso = (ms: number) => new Date(ms).toISOString().replace(/\.000Z$/, 'Z');
const periods = (text: string, from: string, to: string, own: string[] = []) =>
    busyPeriodsOf(text, Date.parse(from), Date.parse(to), own).map((p) => `${iso(p.start)}/${iso(p.end)}${p.allDay ? ' all-day' : ''}`);

// A plain event in and out of the window.
const plain = ics(...vevent('DTSTART:20260310T090000Z', 'DTEND:20260310T100000Z'));
check(periods(plain, '2026-03-10T00:00:00Z', '2026-03-11T00:00:00Z').join() === '2026-03-10T09:00:00Z/2026-03-10T10:00:00Z', 'a plain event in the window is busy');
check(periods(plain, '2026-03-11T00:00:00Z', '2026-03-12T00:00:00Z').length === 0, 'outside the window: nothing');
check(periods(plain, '2026-03-10T09:30:00Z', '2026-03-10T09:45:00Z').length === 1, 'an event around the whole window counts');

// Transparent, cancelled, declined.
check(periods(ics(...vevent('DTSTART:20260310T090000Z', 'DTEND:20260310T100000Z', 'TRANSP:TRANSPARENT')), '2026-03-10T00:00:00Z', '2026-03-11T00:00:00Z').length === 0, 'TRANSP:TRANSPARENT is free');
check(periods(ics(...vevent('DTSTART:20260310T090000Z', 'DTEND:20260310T100000Z', 'STATUS:CANCELLED')), '2026-03-10T00:00:00Z', '2026-03-11T00:00:00Z').length === 0, 'a cancelled event is free');
const declined = ics(...vevent('DTSTART:20260310T090000Z', 'DTEND:20260310T100000Z', 'ORGANIZER:mailto:boss@example.org', 'ATTENDEE;PARTSTAT=DECLINED:mailto:Me@proton.me'));
check(periods(declined, '2026-03-10T00:00:00Z', '2026-03-11T00:00:00Z', ['me@proton.me']).length === 0, 'an invitation I declined is free');
check(periods(declined, '2026-03-10T00:00:00Z', '2026-03-11T00:00:00Z', ['other@proton.me']).length === 1, "someone else's decline does not free me");

// All-day events: whole days, flagged.
const allDay = ics(...vevent('DTSTART;VALUE=DATE:20260310', 'DTEND;VALUE=DATE:20260312'));
check(periods(allDay, '2026-03-01T00:00:00Z', '2026-04-01T00:00:00Z').join() === '2026-03-10T00:00:00Z/2026-03-12T00:00:00Z all-day', 'an all-day event spans its days');

// A two-day all-day series keeps its last day; an event with DURATION instead of DTEND has a length.
const allDaySeries = ics(...vevent('DTSTART;VALUE=DATE:20260302', 'DTEND;VALUE=DATE:20260304', 'RRULE:FREQ=WEEKLY;COUNT=2'));
check(
    periods(allDaySeries, '2026-03-01T00:00:00Z', '2026-04-01T00:00:00Z').join() === '2026-03-02T00:00:00Z/2026-03-04T00:00:00Z all-day,2026-03-09T00:00:00Z/2026-03-11T00:00:00Z all-day',
    'a multi-day all-day series: every occurrence spans both days'
);
check(periods(ics(...vevent('DTSTART:20260310T090000Z', 'DURATION:PT2H')), '2026-03-10T00:00:00Z', '2026-03-11T00:00:00Z').join() === '2026-03-10T09:00:00Z/2026-03-10T11:00:00Z', 'DURATION gives the end');
// 0.40: DURATION across the night the clocks go back (Amsterdam, 25 October 2026): 01:30 CEST + 1 h ends at 02:30 CET, which occurs twice — still one hour.
check(
    periods(ics(...vevent('DTSTART;TZID=Europe/Amsterdam:20261025T013000', 'DURATION:PT1H')), '2026-10-24T00:00:00Z', '2026-10-26T00:00:00Z').join() === '2026-10-24T23:30:00Z/2026-10-25T00:30:00Z',
    'an end in the hour that occurs twice keeps the length'
);
// 0.40: a series with DURATION instead of DTEND (it used to expand to zero-length occurrences).
check(
    periods(ics(...vevent('DTSTART:20260310T090000Z', 'DURATION:PT90M', 'RRULE:FREQ=DAILY;COUNT=2')), '2026-03-01T00:00:00Z', '2026-04-01T00:00:00Z').join() ===
        '2026-03-10T09:00:00Z/2026-03-10T10:30:00Z,2026-03-11T09:00:00Z/2026-03-11T10:30:00Z',
    'a series with DURATION: every occurrence has its length'
);
check(
    periods(ics(...vevent('DTSTART;VALUE=DATE:20260310', 'DURATION:P2D', 'RRULE:FREQ=WEEKLY;COUNT=2')), '2026-03-01T00:00:00Z', '2026-04-01T00:00:00Z').join() ===
        '2026-03-10T00:00:00Z/2026-03-12T00:00:00Z all-day,2026-03-17T00:00:00Z/2026-03-19T00:00:00Z all-day',
    'an all-day series with DURATION:P2D spans two days each time'
);

// A weekly series across the DST change (Europe/Amsterdam, 29 March 2026), one occurrence excluded, one moved.
const series = ics(
    'BEGIN:VTIMEZONE', 'TZID:Europe/Amsterdam',
    'BEGIN:DAYLIGHT', 'TZOFFSETFROM:+0100', 'TZOFFSETTO:+0200', 'TZNAME:CEST', 'DTSTART:19700329T020000', 'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU', 'END:DAYLIGHT',
    'BEGIN:STANDARD', 'TZOFFSETFROM:+0200', 'TZOFFSETTO:+0100', 'TZNAME:CET', 'DTSTART:19701025T030000', 'RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU', 'END:STANDARD',
    'END:VTIMEZONE',
    ...vevent('DTSTART;TZID=Europe/Amsterdam:20260316T100000', 'DTEND;TZID=Europe/Amsterdam:20260316T110000', 'RRULE:FREQ=WEEKLY;COUNT=5', 'EXDATE;TZID=Europe/Amsterdam:20260323T100000'),
    'BEGIN:VEVENT', 'UID:u1', 'DTSTAMP:20260101T000000Z', 'RECURRENCE-ID;TZID=Europe/Amsterdam:20260406T100000', 'DTSTART;TZID=Europe/Amsterdam:20260407T140000', 'DTEND;TZID=Europe/Amsterdam:20260407T150000', 'END:VEVENT'
);
const got = periods(series, '2026-03-01T00:00:00Z', '2026-05-01T00:00:00Z').sort();
check(
    got.join('\n') ===
        [
            '2026-03-16T09:00:00Z/2026-03-16T10:00:00Z', // CET
            '2026-03-30T08:00:00Z/2026-03-30T09:00:00Z', // CEST: still 10:00 on the wall clock
            '2026-04-07T12:00:00Z/2026-04-07T13:00:00Z', // the moved occurrence (6 April → 7 April 14:00)
            '2026-04-13T08:00:00Z/2026-04-13T09:00:00Z'
        ].join('\n'),
    `a weekly series: DST kept on the wall clock, 23 March excluded, 6 April replaced by its exception (got ${got.join(', ')})`
);
check(periods(series, '2026-04-06T00:00:00Z', '2026-04-07T00:00:00Z').length === 0, 'the replaced occurrence itself is not busy any more');

// Merging: overlapping and touching periods become one; clipping to the window.
const merged = mergeBusyPeriods(
    [
        { start: 100, end: 200, allDay: false },
        { start: 150, end: 250, allDay: false },
        { start: 250, end: 300, allDay: true },
        { start: 400, end: 500, allDay: true },
        { start: 50, end: 60, allDay: false }
    ],
    80,
    450
);
check(JSON.stringify(merged) === JSON.stringify([{ start: 100, end: 300, allDay: false }, { start: 400, end: 450, allDay: true }]), `merge + clip (${JSON.stringify(merged)})`);

// 0.40: tentatively busy — your answer Maybe, or a tentative event — merged apart, busy wins on overlap.
const maybe = ics(...vevent('DTSTART:20260310T090000Z', 'DTEND:20260310T110000Z', 'ORGANIZER:mailto:boss@example.org', 'ATTENDEE;PARTSTAT=TENTATIVE:mailto:me@proton.me'));
const maybePeriods = busyPeriodsOf(maybe, Date.parse('2026-03-10T00:00:00Z'), Date.parse('2026-03-11T00:00:00Z'), ['me@proton.me']);
check(maybePeriods.length === 1 && maybePeriods[0].tentative === true, 'an invitation I answered Maybe is tentatively busy');
check(busyPeriodsOf(maybe, Date.parse('2026-03-10T00:00:00Z'), Date.parse('2026-03-11T00:00:00Z'), ['other@proton.me'])[0].tentative === undefined, "someone else's Maybe does not make me tentative");
check(busyPeriodsOf(ics(...vevent('DTSTART:20260310T090000Z', 'DTEND:20260310T100000Z', 'STATUS:TENTATIVE')), Date.parse('2026-03-10T00:00:00Z'), Date.parse('2026-03-11T00:00:00Z'))[0].tentative === true, 'a tentative event is tentatively busy');
const maybeSeries = ics(...vevent('DTSTART:20260310T090000Z', 'DTEND:20260310T100000Z', 'RRULE:FREQ=DAILY;COUNT=2', 'ORGANIZER:mailto:boss@example.org', 'ATTENDEE;PARTSTAT=TENTATIVE:mailto:me@proton.me'));
check(busyPeriodsOf(maybeSeries, Date.parse('2026-03-01T00:00:00Z'), Date.parse('2026-04-01T00:00:00Z'), ['me@proton.me']).every((period) => period.tentative), 'every occurrence of a series answered Maybe');
const mixed = mergeBusyPeriods(
    [
        { start: 100, end: 300, allDay: false, tentative: true },
        { start: 150, end: 200, allDay: false },
        { start: 280, end: 320, allDay: false, tentative: true },
        { start: 400, end: 450, allDay: false }
    ],
    0,
    1000
);
check(
    JSON.stringify(mixed) ===
        JSON.stringify([
            { start: 100, end: 150, allDay: false, tentative: true },
            { start: 150, end: 200, allDay: false },
            { start: 200, end: 320, allDay: false, tentative: true },
            { start: 400, end: 450, allDay: false }
        ]),
    `tentative merged apart, busy cut out of it (${JSON.stringify(mixed)})`
);

// 0.40: where a COUNT-limited series ends (the sync window drops one that ended before it).
const masterOf = (text: string) => (parseVcal(text) as any).components.find((component: any) => component.component === 'vevent');
const counted = ics(...vevent('DTSTART:20250106T090000Z', 'DTEND:20250106T100000Z', 'RRULE:FREQ=WEEKLY;COUNT=3'));
check(iso(seriesLastEndOf(masterOf(counted))!) === '2025-01-20T10:00:00Z', `COUNT=3 weekly ends with its third occurrence (${iso(seriesLastEndOf(masterOf(counted))!)})`);
check(seriesLastEndOf(masterOf(ics(...vevent('DTSTART:20250106T090000Z', 'DTEND:20250106T100000Z', 'RRULE:FREQ=WEEKLY')))) === null, 'open-ended: no end');
check(seriesLastEndOf(masterOf(ics(...vevent('DTSTART:20250106T090000Z', 'DTEND:20250106T100000Z', 'RRULE:FREQ=WEEKLY;UNTIL=20250301T000000Z')))) === null, 'UNTIL is read by the caller');

if (failures) {
    console.error(`${failures} busy check(s) failed`);
    process.exit(1);
}
console.log('all busy checks passed');
