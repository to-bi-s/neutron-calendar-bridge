/**
 * Availability (0.33.2): Calendar.app's free/busy lookup (a VFREEBUSY POST to the outbox) answered
 * per guest — the user's own addresses from the mirror (series expanded, transparent/cancelled/
 * declined events free), other Proton users from Proton's busy times when shared, everyone else
 * "no scheduling support" — and the caching of Proton's answers.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CalDAVServer } from '../src/main/caldav-server';
import { emailOfCalendarAddress, freeBusyReplyIcs, icsUtc, parseFreeBusyRequest } from '../src/main/free-busy';
import { fakeSafeStorage } from './support/fake-safe-storage';
import { loginFetch, withLogin } from './support/caldav-login';

const fetch = loginFetch('bridge-user', 'bridge-pass');
const PORT = 33002;
const BASE = `http://127.0.0.1:${PORT}`;

const stubElectron = () => {
    const resolved = require.resolve('electron');
    require.cache[resolved] = {
        id: resolved,
        filename: resolved,
        loaded: true,
        exports: { app: { setLoginItemSettings: () => undefined }, safeStorage: fakeSafeStorage }
    } as unknown as NodeJS.Module;
};

/** What Calendar.app posts to the outbox while a meeting with guests is being planned. */
const freeBusyPost = (attendees: string[], start = '20261005T000000Z', end = '20261006T000000Z') =>
    [
        'BEGIN:VCALENDAR',
        'VERSION:2.0',
        'PRODID:-//Apple Inc.//macOS 15.0//EN',
        'METHOD:REQUEST',
        'BEGIN:VFREEBUSY',
        'UID:4A6B-FREEBUSY',
        'DTSTAMP:20261001T120000Z',
        `DTSTART:${start}`,
        `DTEND:${end}`,
        'ORGANIZER;CN="Tobi":mailto:tobi@proton.me',
        ...attendees,
        'END:VFREEBUSY',
        'END:VCALENDAR',
        ''
    ].join('\r\n');

test('free-busy: the request is read (folded lines, parameters with quoted commas), the reply is a VFREEBUSY', () => {
    const request = parseFreeBusyRequest(
        freeBusyPost(['ATTENDEE;CN="Bob, B.";CUTYPE=INDIVIDUAL;PARTSTAT=NEEDS-ACTION:mailto:bob@example.org', 'ATTENDEE:mailto:anna@uni.nl', 'ATTENDEE;CN="Long\r\n  name":mailto:folded@example.org'])
    )!;
    assert.ok(request);
    assert.equal(request.uid, '4A6B-FREEBUSY');
    assert.equal(request.organizer, 'mailto:tobi@proton.me');
    assert.deepEqual(request.attendees, ['mailto:bob@example.org', 'mailto:anna@uni.nl', 'mailto:folded@example.org']);
    assert.equal(request.start, Date.UTC(2026, 9, 5));
    assert.equal(request.end, Date.UTC(2026, 9, 6));
    assert.equal(parseFreeBusyRequest('BEGIN:VCALENDAR\r\nMETHOD:REQUEST\r\nBEGIN:VEVENT\r\nUID:x\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n'), null);
    assert.equal(emailOfCalendarAddress('mailto:Anna@Uni.NL'), 'anna@uni.nl');

    // 0.40: a tentatively busy period is answered as BUSY-TENTATIVE.
    const tentativeReply = freeBusyReplyIcs(request, 'mailto:bob@example.org', [{ start: Date.UTC(2026, 9, 5, 9), end: Date.UTC(2026, 9, 5, 10), tentative: true }], Date.UTC(2026, 9, 1, 12));
    assert.match(tentativeReply, /\r\nFREEBUSY;FBTYPE=BUSY-TENTATIVE:20261005T090000Z\/20261005T100000Z\r\n/);
    const reply = freeBusyReplyIcs(request, 'mailto:bob@example.org', [{ start: Date.UTC(2026, 9, 5, 9), end: Date.UTC(2026, 9, 5, 10) }], Date.UTC(2026, 9, 1, 12));
    assert.equal(
        reply,
        [
            'BEGIN:VCALENDAR',
            'VERSION:2.0',
            'PRODID:-//Neutron Calendar Bridge//EN',
            'METHOD:REPLY',
            'BEGIN:VFREEBUSY',
            'UID:4A6B-FREEBUSY',
            'DTSTAMP:20261001T120000Z',
            'DTSTART:20261005T000000Z',
            'DTEND:20261006T000000Z',
            'ORGANIZER:mailto:tobi@proton.me',
            'ATTENDEE:mailto:bob@example.org',
            'FREEBUSY;FBTYPE=BUSY:20261005T090000Z/20261005T100000Z',
            'END:VFREEBUSY',
            'END:VCALENDAR',
            ''
        ].join('\r\n')
    );
    assert.equal(icsUtc(Date.UTC(2026, 0, 2, 3, 4, 5)), '20260102T030405Z');
});

test('caldav server: the outbox answers each guest — busy periods, or no scheduling support', async () => {
    const asked: Array<[string, number, number]> = [];
    const fakeBridgeService = withLogin({
        isSignedIn: () => true,
        getCalDAVConfig: () => ({
            host: '127.0.0.1',
            port: PORT,
            username: 'bridge-user',
            password: 'bridge-pass',
            security: 'HTTP' as const,
            baseUrl: BASE,
            serverPath: '/principals/bridge-user/'
        }),
        async freeBusyOf(email: string, start: number, end: number) {
            asked.push([email, start, end]);
            if (email === 'tobi@proton.me') {
                return { known: true, periods: [{ start: Date.UTC(2026, 9, 5, 9), end: Date.UTC(2026, 9, 5, 10, 30), allDay: false }], end: Date.UTC(2026, 9, 5, 12) };
            }
            if (email === 'colleague@proton.me') {
                return { known: true, periods: [], end };
            }
            return { known: false };
        }
    });
    const server = new CalDAVServer(fakeBridgeService as any);
    await server.start();
    try {
        const response = await fetch(`${BASE}/outbox/bridge-user/`, {
            method: 'POST',
            headers: { 'Content-Type': 'text/calendar' },
            body: freeBusyPost(['ATTENDEE:mailto:Tobi@proton.me', 'ATTENDEE:mailto:colleague@proton.me', 'ATTENDEE;CN="Bob, B.":mailto:bob@example.org'])
        });
        assert.equal(response.status, 200);
        const xml = await response.text();
        assert.deepEqual(asked, [
            ['tobi@proton.me', Date.UTC(2026, 9, 5), Date.UTC(2026, 9, 6)],
            ['colleague@proton.me', Date.UTC(2026, 9, 5), Date.UTC(2026, 9, 6)],
            ['bob@example.org', Date.UTC(2026, 9, 5), Date.UTC(2026, 9, 6)]
        ]);
        assert.equal((xml.match(/<C:response>/g) || []).length, 3);
        assert.match(xml, /<D:href>mailto:Tobi@proton.me<\/D:href><\/C:recipient>\s*<C:request-status>2.0;Success<\/C:request-status>\s*<C:calendar-data>BEGIN:VCALENDAR/);
        assert.match(xml, /METHOD:REPLY/);
        assert.match(xml, /ATTENDEE:mailto:Tobi@proton.me&#13;&#10;|ATTENDEE:mailto:Tobi@proton.me\r\n/);
        assert.match(xml, /FREEBUSY;FBTYPE=BUSY:20261005T090000Z\/20261005T103000Z/);
        assert.match(xml, /DTEND:20261005T120000Z/, 'the reply states the window that was answered (it may be shorter than asked)');
        // A guest with nothing in the window: a success with no FREEBUSY line (free all day).
        const colleague = xml.slice(xml.indexOf('colleague@proton.me'), xml.indexOf('bob@example.org'));
        assert.match(colleague, /2.0;Success/);
        assert.doesNotMatch(colleague, /FREEBUSY;/);
        // An unknown address: no scheduling support, no calendar-data.
        const bob = xml.slice(xml.indexOf('bob@example.org'));
        assert.match(bob, /5\.3;No scheduling support for user/);
        assert.doesNotMatch(bob, /calendar-data/);
    } finally {
        await server.stop();
    }
});

test('bridge service: own addresses from the mirror, Proton users from Proton (cached), others unknown', async () => {
    stubElectron();
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { BridgeService } = require('../src/main/bridge-service') as typeof import('../src/main/bridge-service');
    const baseDir = mkdtempSync(join(tmpdir(), 'neutron-calendar-bridge-availability-'));
    const service = new BridgeService(baseDir) as any;
    try {
        await service.mirrorDatabase.initialize();
        service.localCaldavPassword = 'test';
        const client = await import('proton-calendar-client');
        const calendar = (id: string, kind: string) => ({ protonCalendarId: id, slug: id, displayName: id, color: '#123456', description: '', visible: true, removed: false, ctag: '1', lastPolledAt: null, lastSyncedAt: null, kind });
        await service.mirrorDatabase.upsertCalendar(calendar('private', 'own'));
        await service.mirrorDatabase.upsertCalendar(calendar('holidays', 'holidays'));
        await service.mirrorDatabase.upsertCalendar(calendar('unticked', 'own'));
        service.configStore.update({ excludedCalendarIds: ['unticked'] });
        const ics = (uid: string, ...lines: string[]) =>
            ['BEGIN:VCALENDAR', 'VERSION:2.0', 'BEGIN:VEVENT', `UID:${uid}`, 'DTSTAMP:20260101T000000Z', ...lines, 'END:VEVENT', 'END:VCALENDAR', ''].join('\r\n');
        const record = (calendarId: string, uid: string, start: number, end: number, text: string, extra: Record<string, unknown> = {}) => ({
            protonEventId: `${calendarId}-${uid}`,
            protonCalendarId: calendarId,
            uid,
            href: `/calendars/u/${calendarId}/${uid}.ics`,
            etag: '"1"',
            contentHash: uid,
            serializedIcs: text,
            title: uid,
            description: '',
            location: '',
            startTimestamp: start / 1000,
            endTimestamp: end / 1000,
            timezone: 'UTC',
            isAllDay: false,
            modifiedTimestamp: 1,
            deleted: false,
            lastSyncedAt: 1,
            protonEventIds: { '': `${calendarId}-${uid}` },
            ...extra
        });
        const day = Date.UTC(2026, 9, 5);
        const H = 3_600_000;
        await service.mirrorDatabase.upsertEvent(record('private', 'dentist', day + 9 * H, day + 10 * H, ics('dentist', 'DTSTART:20261005T090000Z', 'DTEND:20261005T100000Z')));
        await service.mirrorDatabase.upsertEvent(record('private', 'lunch', day + 9.5 * H, day + 11 * H, ics('lunch', 'DTSTART:20261005T093000Z', 'DTEND:20261005T110000Z')));
        await service.mirrorDatabase.upsertEvent(record('private', 'free-slot', day + 14 * H, day + 15 * H, ics('free-slot', 'DTSTART:20261005T140000Z', 'DTEND:20261005T150000Z', 'TRANSP:TRANSPARENT')));
        await service.mirrorDatabase.upsertEvent(
            record('private', 'declined', day + 16 * H, day + 17 * H, ics('declined', 'DTSTART:20261005T160000Z', 'DTEND:20261005T170000Z', 'ORGANIZER:mailto:boss@example.org', 'ATTENDEE;PARTSTAT=DECLINED:mailto:tobi@proton.me'))
        );
        // A weekly series that started long before the window (its row's own times are the first occurrence's).
        await service.mirrorDatabase.upsertEvent(
            record('private', 'standup', Date.UTC(2026, 0, 5, 7), Date.UTC(2026, 0, 5, 7, 15), ics('standup', 'DTSTART:20260105T070000Z', 'DTEND:20260105T071500Z', 'RRULE:FREQ=WEEKLY;BYDAY=MO'))
        );
        await service.mirrorDatabase.upsertEvent(record('private', 'gone', day + 12 * H, day + 13 * H, ics('gone', 'DTSTART:20261005T120000Z', 'DTEND:20261005T130000Z'), { deleted: true }));
        // A series Calendar.app wrote, with Apple's VTIMEZONE whose historical rule has an UNTIL of its own (must not hide the series).
        await service.mirrorDatabase.upsertEvent(
            record(
                'private',
                'ny-weekly',
                Date.UTC(2026, 8, 28, 22),
                Date.UTC(2026, 8, 28, 23),
                [
                    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Apple Inc.//macOS 15.0//EN',
                    'BEGIN:VTIMEZONE', 'TZID:America/New_York',
                    'BEGIN:DAYLIGHT', 'TZOFFSETFROM:-0500', 'TZOFFSETTO:-0400', 'DTSTART:19870405T020000', 'RRULE:FREQ=YEARLY;UNTIL=20060402T070000Z;BYMONTH=4;BYDAY=1SU', 'TZNAME:EDT', 'END:DAYLIGHT',
                    'BEGIN:DAYLIGHT', 'TZOFFSETFROM:-0500', 'TZOFFSETTO:-0400', 'DTSTART:20070311T020000', 'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU', 'TZNAME:EDT', 'END:DAYLIGHT',
                    'BEGIN:STANDARD', 'TZOFFSETFROM:-0400', 'TZOFFSETTO:-0500', 'DTSTART:20071104T020000', 'RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU', 'TZNAME:EST', 'END:STANDARD',
                    'END:VTIMEZONE',
                    'BEGIN:VEVENT', 'UID:ny-weekly', 'DTSTAMP:20260101T000000Z', 'DTSTART;TZID=America/New_York:20260928T180000', 'DTEND;TZID=America/New_York:20260928T190000', 'RRULE:FREQ=WEEKLY;BYDAY=MO', 'END:VEVENT',
                    'END:VCALENDAR', ''
                ].join('\r\n')
            )
        );
        await service.mirrorDatabase.upsertEvent(record('holidays', 'holiday', day, day + 24 * H, ics('holiday', 'DTSTART;VALUE=DATE:20261005', 'DTEND;VALUE=DATE:20261006')));
        await service.mirrorDatabase.upsertEvent(record('unticked', 'hidden', day + 20 * H, day + 21 * H, ics('hidden', 'DTSTART:20261005T200000Z', 'DTEND:20261005T210000Z')));

        const protonAsks: Array<[string, number, number, string]> = [];
        let shared = true;
        service.accountAddresses = ['tobi@proton.me', 'tobi@pm.me'];
        service.protonAdapter = {
            isSignedIn: () => true,
            supportsAvailability: async () => true,
            busyPeriodsOf: async (text: string, start: number, end: number, own: string[]) => client.busyPeriodsOf(text, start, end, own),
            mergeBusyPeriods: async (periods: any[], start: number, end: number) => client.mergeBusyPeriods(periods, start, end),
            getBusySchedule: async (email: string, start: number, end: number, timeZone: string) => {
                protonAsks.push([email, start, end, timeZone]);
                return shared && email === 'colleague@proton.me'
                    ? { accessible: true, slots: [{ start: day / 1000 + 8 * 3600, end: day / 1000 + 9 * 3600, allDay: false }] }
                    : { accessible: false, slots: [] };
            }
        };

        // Own address (any of them, any case): the mirror's ticked own calendars, merged.
        const own = await service.freeBusyOf('Tobi@PM.me'.toLowerCase(), day, day + 24 * H);
        assert.deepEqual(own, {
            known: true,
            periods: [
                { start: day + 7 * H, end: day + 7.25 * H, allDay: false }, // Monday 5 Oct 2026: the standup
                { start: day + 9 * H, end: day + 11 * H, allDay: false }, // dentist + lunch merged; transparent, declined, deleted, holiday, unticked left out
                { start: day + 22 * H, end: day + 23 * H, allDay: false } // the New York series, 18:00 EDT
            ],
            end: day + 24 * H
        });
        assert.equal(protonAsks.length, 0);
        // The own answer is kept briefly; a narrower window is clipped from it without reading the mirror again.
        const reads = service.mirrorDatabase.listEventsForCalendar.bind(service.mirrorDatabase);
        let mirrorReads = 0;
        service.mirrorDatabase.listEventsForCalendar = async (...args: unknown[]) => {
            mirrorReads += 1;
            return reads(...args);
        };
        assert.deepEqual((await service.freeBusyOf('tobi@proton.me', day + 9.5 * H, day + 10 * H)).periods, [{ start: day + 9.5 * H, end: day + 10 * H, allDay: false }]);
        assert.equal(mirrorReads, 0);
        service.ownBusy = null;
        // An all-day event of the user is busy on this Mac's local day, not on the UTC day.
        await service.mirrorDatabase.upsertEvent(record('private', 'offsite', day + 24 * H, day + 48 * H, ics('offsite', 'DTSTART;VALUE=DATE:20261006', 'DTEND;VALUE=DATE:20261007')));
        const localDay = new Date(2026, 9, 6).getTime();
        const offsite = await service.freeBusyOf('tobi@proton.me', localDay - 12 * H, localDay + 36 * H);
        // The whole local day is busy (in some zones merged with a neighbouring timed event, so no flag check).
        assert.ok(offsite.known && offsite.periods.some((period: any) => period.start <= localDay && period.end >= localDay + 24 * H), JSON.stringify(offsite));
        assert.equal(mirrorReads, 1, 'only the ticked own calendar is read (holidays and the unticked one are not)');

        // 0.37.7: "Events affect availability" off in Calendar.app (PROPPATCH schedule-calendar-transp) takes
        // the calendar out of the own busy times; holiday calendars never count; switching it back on counts again.
        assert.equal(service.isCalendarOpaque(calendar('private', 'own')), true);
        assert.equal(service.isCalendarOpaque(calendar('holidays', 'holidays')), false);
        await service.setCalendarAvailability('private', false);
        assert.deepEqual(service.configStore.load().transparentCalendarIds, ['private']);
        assert.equal(service.isCalendarOpaque(calendar('private', 'own')), false);
        assert.equal(service.ownBusy, null, 'the kept answer is dropped');
        assert.deepEqual(await service.freeBusyOf('tobi@proton.me', day, day + 24 * H), { known: true, periods: [], end: day + 24 * H });
        await service.setCalendarAvailability('private', true);
        assert.deepEqual(service.configStore.load().transparentCalendarIds, []);
        const back = await service.freeBusyOf('tobi@proton.me', day, day + 24 * H);
        assert.ok(back.periods.some((period: any) => period.start <= day + 9 * H && period.end >= day + 11 * H), 'the dentist counts again');
        await service.setCalendarAvailability('no-such-calendar', false);
        assert.deepEqual(service.configStore.load().transparentCalendarIds, []);

        // A Proton user whose busy times are shared: asked once per window, then cached.
        const colleague = await service.freeBusyOf('colleague@proton.me', day, day + 24 * H);
        assert.deepEqual(colleague, { known: true, periods: [{ start: day + 8 * H, end: day + 9 * H, allDay: false }], end: day + 24 * H });
        assert.equal(protonAsks.length, 1);
        assert.equal(protonAsks[0][0], 'colleague@proton.me');
        assert.equal(protonAsks[0][1], day / 1000);
        assert.equal(protonAsks[0][2], day / 1000 + 86_400);
        assert.ok(protonAsks[0][3].length > 0, 'the asker\'s time zone goes along');
        const narrower = await service.freeBusyOf('colleague@proton.me', day + 8.5 * H, day + 12 * H);
        assert.deepEqual(narrower, { known: true, periods: [{ start: day + 8.5 * H, end: day + 9 * H, allDay: false }], end: day + 12 * H });
        assert.equal(protonAsks.length, 1, 'a narrower window is served from the cache, clipped');
        await service.freeBusyOf('colleague@proton.me', day, day + 48 * H);
        assert.equal(protonAsks.length, 2, 'a wider window asks again');

        // Not shared (anyone outside the organization, or outside Proton): unknown, and not asked again for a while.
        assert.deepEqual(await service.freeBusyOf('bob@example.org', day, day + 24 * H), { known: false });
        assert.deepEqual(await service.freeBusyOf('bob@example.org', day, day + 48 * H), { known: false });
        assert.equal(protonAsks.length, 3);

        // A failing lookup: unknown, remembered briefly (not asked again at the next keystroke).
        const original = service.protonAdapter.getBusySchedule;
        let failures = 0;
        service.protonAdapter.getBusySchedule = async () => {
            failures += 1;
            throw new Error('offline');
        };
        assert.deepEqual(await service.freeBusyOf('new@proton.me', day, day + 24 * H), { known: false });
        assert.deepEqual(await service.freeBusyOf('new@proton.me', day, day + 24 * H), { known: false });
        assert.equal(failures, 1);
        service.busyCache.get('new@proton.me').at -= 2 * 60_000;
        assert.deepEqual(await service.freeBusyOf('new@proton.me', day, day + 24 * H), { known: false });
        assert.equal(failures, 2, 'asked again after the error memory lapsed');
        // Two lookups for the same guest at once share one Proton round.
        let slowAsks = 0;
        service.protonAdapter.getBusySchedule = async () => {
            slowAsks += 1;
            await new Promise((resolve) => setTimeout(resolve, 20));
            return { accessible: true, slots: [] };
        };
        const together = await Promise.all([service.freeBusyOf('slow@proton.me', day, day + 24 * H), service.freeBusyOf('slow@proton.me', day, day + 12 * H)]);
        assert.deepEqual(together, [{ known: true, periods: [], end: day + 24 * H }, { known: true, periods: [], end: day + 12 * H }]);
        assert.equal(slowAsks, 1);
        const wider = await Promise.all([service.freeBusyOf('slower@proton.me', day, day + 24 * H), service.freeBusyOf('slower@proton.me', day, day + 72 * H)]);
        assert.deepEqual(wider.map((answer: any) => answer.end), [day + 24 * H, day + 72 * H]);
        assert.equal(slowAsks, 3, 'a wider window asks on its own once the first lookup is through');

        // Sign-out clears what was learned about guests.
        service.protonAdapter.getBusySchedule = original;
        service.busyCache.clear();
        shared = false;
        assert.deepEqual(await service.freeBusyOf('colleague@proton.me', day, day + 24 * H), { known: false });

        // Nonsense windows are refused quietly; an older client cannot answer for own addresses.
        assert.deepEqual(await service.freeBusyOf('tobi@proton.me', day + H, day), { known: false });
        service.protonAdapter.supportsAvailability = async () => false;
        service.ownBusy = null;
        assert.deepEqual(await service.freeBusyOf('tobi@proton.me', day, day + 24 * H), { known: false });
    } finally {
        rmSync(baseDir, { recursive: true, force: true });
    }
});
