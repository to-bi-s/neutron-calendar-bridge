/**
 * Offline test for Proton's change feeds and the decrypted-event cache (roadmap stage 5, WP4). A
 * fake fetch answers like Proton's API; no network, no account. Checks:
 * - a calendar feed without a cursor: only the current cursor is fetched (`started: false`);
 * - pages followed while More is set; create/update/delete folded (the last word on an event
 *   counts); Refresh and CalendarKeys noted (the calendar's bootstrap read again afterwards);
 * - a cursor Proton refuses (4xx): a fresh cursor, `refresh: true`;
 * - the account feed: calendars, members, addresses (read again, with their keys), mail, settings;
 * - the page limit (the rest is left for next time, with More still set the cursor moves on);
 * - the decrypted-event cache: an event is decrypted once per fingerprint; a change to its encrypted
 *   parts, its guest answers or its times is decrypted again; the statistics.
 */
import { ProtonCalendarAPI } from '../src/proton-calendar-api.ts';
import { RequestControl } from '../src/request-control.ts';
import { applyAccountFeedPage, applyCalendarFeedPage, emptyAccountChanges, emptyCalendarChanges } from '../src/change-feed.ts';

let failures = 0;
const check = (condition: unknown, label: string) => {
    console.log(`${condition ? 'ok  ' : 'FAIL'} ${label}`);
    if (!condition) failures += 1;
};

const jsonResponse = (status: number, data: any) => ({
    status,
    ok: status >= 200 && status < 300,
    headers: { get: () => null },
    text: async () => JSON.stringify(data),
    arrayBuffer: async () => new ArrayBuffer(0)
});

type Route = (url: URL, init: any) => any;

const makeApi = (route: Route) => {
    const api: any = new ProtonCalendarAPI({ username: 'tobi@proton.test', password: 'secret' });
    api.control = new RequestControl({ random: () => 0.5, sleep: async () => undefined });
    api.session = { UID: 'uid-1', AccessToken: 'access-1', RefreshToken: 'refresh-1' };
    const log: string[] = [];
    api.fetchImpl = async (url: string, init: any) => {
        const parsed = new URL(url);
        log.push(parsed.pathname.replace(/^\/api/, ''));
        const answer = route(parsed, init);
        return answer ?? jsonResponse(404, { Code: 2501, Error: 'Not found' });
    };
    return { api, log };
};

const event = (id: string, uid: string, extra: Record<string, unknown> = {}) => ({
    ID: id,
    UID: uid,
    CalendarID: 'cal-1',
    StartTime: 1_800_000_000,
    EndTime: 1_800_003_600,
    RRule: null,
    RecurrenceID: null,
    ModifyTime: 1_799_999_000,
    ...extra
});

const main = async () => {
    console.log('--- change-feed.ts: folding pages');
    {
        const changes = emptyCalendarChanges('cal-1', 'c0');
        let { more } = applyCalendarFeedPage(changes, {
            CalendarModelEventID: 'c1',
            More: 1,
            CalendarEvents: [
                { ID: 'e1', Action: 1, Event: event('e1', 'uid-1') },
                { ID: 'e2', Action: 2, Event: event('e2', 'uid-2') },
                { ID: 'e3', Action: 0 }
            ]
        });
        check(more && changes.cursor === 'c1', 'first page: cursor moved on, More noted');
        ({ more } = applyCalendarFeedPage(changes, {
            CalendarModelEventID: 'c2',
            More: 0,
            CalendarKeys: [{ ID: 'k', Key: {} }],
            CalendarEvents: [
                { ID: 'e1', Action: 0 },
                { ID: 'e3', Action: 1, Event: event('e3', 'uid-3', { RRule: 'FREQ=WEEKLY' }) },
                { ID: 'e2', Action: 2, Event: event('e2', 'uid-2', { ModifyTime: 1_800_000_500 }) }
            ]
        }));
        check(!more && changes.cursor === 'c2' && changes.requests === 2, 'second page: last cursor, two requests');
        check(changes.deleted.length === 1 && changes.deleted[0] === 'e1', 'created then deleted = deleted');
        check(changes.changed.map((stub) => stub.id).sort().join() === 'e2,e3', 'deleted then created again = changed; the update kept');
        check(changes.changed.find((stub) => stub.id === 'e2')?.modifyTime === 1_800_000_500, "the later page's word counts");
        check(changes.changed.find((stub) => stub.id === 'e3')?.rrule === 'FREQ=WEEKLY', 'the series rule comes along');
        check(changes.keysChanged && !changes.refresh, 'keys changed noted, no refresh asked');
        applyCalendarFeedPage(changes, { CalendarModelEventID: 'c3', Refresh: 1, More: 0, CalendarEvents: [{ ID: 'e9', Action: 1 }] });
        check(changes.refresh, 'Refresh (or an item without metadata) asks for a full read');

        const account = emptyAccountChanges('a0');
        applyAccountFeedPage(account, { EventID: 'a1', More: 0, CalendarMembers: [{ ID: 'm', Action: 2, Member: {} }], Messages: [{ ID: 'msg', Action: 1 }] });
        check(account.calendars && account.mail && !account.addresses && !account.settings && account.cursor === 'a1', 'account page: members count as calendars, messages as mail');
        applyAccountFeedPage(account, { EventID: 'a2', Addresses: [{ ID: 'ad', Action: 2 }], MailSettings: { Sign: 1 } });
        check(account.addresses && account.settings, 'addresses and settings noted');
        let threw = false;
        try {
            applyCalendarFeedPage(changes, null);
        } catch {
            threw = true;
        }
        check(threw, 'a page without a body is an error, not an empty answer');
    }

    console.log('--- getCalendarChanges');
    {
        const pages: Record<string, any> = {
            c0: { CalendarModelEventID: 'c1', More: 1, CalendarEvents: [{ ID: 'e1', Action: 1, Event: event('e1', 'uid-1') }] },
            c1: { CalendarModelEventID: 'c2', More: 0, CalendarEvents: [{ ID: 'e2', Action: 0 }] },
            c2: { CalendarModelEventID: 'c2', More: 0 },
            stuck: { CalendarModelEventID: 'stuck', More: 1, CalendarEvents: [] }
        };
        const { api, log } = makeApi((url) => {
            const match = url.pathname.match(/\/calendar\/v1\/cal-1\/modelevents\/(.+)$/);
            if (!match) return null;
            if (match[1] === 'latest') return jsonResponse(200, { Code: 1000, CalendarModelEventID: 'c2' });
            const page = pages[match[1]];
            return page ? jsonResponse(200, { Code: 1000, ...page }) : jsonResponse(422, { Code: 2001, Error: 'Invalid event ID' });
        });
        api.calendarDataById.set('cal-1', { calendarID: 'cal-1' });
        const start = await api.getCalendarChanges('cal-1', null);
        check(!start.started && start.cursor === 'c2' && start.requests === 1 && log.length === 1 && log[0].endsWith('/modelevents/latest'), 'no cursor: the current one, nothing listed');
        const changes = await api.getCalendarChanges('cal-1', 'c0');
        check(changes.started && changes.cursor === 'c2' && changes.requests === 2, 'pages followed to the last cursor');
        check(changes.changed.length === 1 && changes.deleted.length === 1, 'one created, one deleted');
        check(api.calendarDataById.has('cal-1'), 'bootstrap kept while the keys did not change');
        const quiet = await api.getCalendarChanges('cal-1', 'c2');
        check(quiet.started && quiet.cursor === 'c2' && !quiet.changed.length && !quiet.deleted.length && quiet.requests === 1, 'nothing new: one request, the same cursor');
        const lost = await api.getCalendarChanges('cal-1', 'gone');
        check(lost.started && lost.refresh && lost.cursor === 'c2' && lost.requests === 2, 'a refused cursor: a fresh one and a full read asked');
        const stuck = await api.getCalendarChanges('cal-1', 'stuck');
        check(stuck.requests === 1 && stuck.cursor === 'stuck', 'More set but the cursor not moving: stopped after one page');

        pages.c1 = { ...pages.c1, CalendarKeys: [{ ID: 'k', Key: {} }] };
        await api.getCalendarChanges('cal-1', 'c0');
        check(!api.calendarDataById.has('cal-1'), 'keys changed: the bootstrap is forgotten (read again on the next use)');
        let threw: any = null;
        const broken = makeApi(() => jsonResponse(500, { Code: 500, Error: 'Server error' }));
        try {
            await broken.api.getCalendarChanges('cal-1', 'c0');
        } catch (error) {
            threw = error;
        }
        check(threw instanceof Error && /\(500\)/.test(threw.message), 'a server error is thrown, the cursor kept by the caller');
    }

    console.log('--- getAccountChanges');
    {
        let addressReads = 0;
        const { api, log } = makeApi((url) => {
            if (url.pathname.endsWith('/core/v4/events/latest')) return jsonResponse(200, { Code: 1000, EventID: 'a3' });
            const match = url.pathname.match(/\/core\/v5\/events\/(.+)$/);
            if (match) {
                const pages: Record<string, any> = {
                    a0: { EventID: 'a1', More: 1, Calendars: [{ ID: 'cal-2', Action: 1, Calendar: {} }] },
                    a1: { EventID: 'a2', More: 1, Addresses: [{ ID: 'ad-1', Action: 2, Address: {} }] },
                    a2: { EventID: 'a3', More: 0, Messages: [{ ID: 'msg', Action: 1, Message: {} }] },
                    a3: { EventID: 'a3', More: 0 }
                };
                const page = pages[match[1]];
                return page ? jsonResponse(200, { Code: 1000, ...page }) : jsonResponse(400, { Code: 2000, Error: 'Invalid' });
            }
            if (url.pathname.endsWith('/core/v4/addresses')) {
                addressReads += 1;
                return jsonResponse(200, { Code: 1000, Addresses: [{ ID: 'ad-1', Email: 'tobi@proton.test', Keys: [], Status: 1, Receive: 1, Send: 1, Order: 1 }, { ID: 'ad-2', Email: 'new@proton.test', Keys: [], Status: 1, Receive: 1, Send: 1, Order: 2 }] });
            }
            return null;
        });
        api.userData = { user: { ID: 'user' }, userKeys: [], addresses: [{ ID: 'ad-1', Email: 'tobi@proton.test', Status: 1, Receive: 1, Send: 1 }], addressKeys: [], addressKeysByAddressID: {}, keySalts: [] };
        api.keyPassword = 'derived';
        const start = await api.getAccountChanges(null);
        check(!start.started && start.cursor === 'a3' && start.requests === 1, 'no cursor: the current one');
        const changes = await api.getAccountChanges('a0');
        check(changes.started && changes.cursor === 'a3' && changes.requests === 3, 'three pages followed');
        check(changes.calendars && changes.addresses && changes.mail && !changes.settings && !changes.refresh, 'calendars, addresses and mail noted');
        check(addressReads === 1 && api.listAddresses().length === 2 && api.listAddresses()[1].email === 'new@proton.test', 'addresses read again right away');
        const quiet = await api.getAccountChanges('a3');
        check(!quiet.calendars && !quiet.mail && quiet.requests === 1 && addressReads === 1, 'nothing new: nothing read again');
        const lost = await api.getAccountChanges('old');
        check(lost.refresh && lost.calendars && lost.mail && lost.cursor === 'a3' && addressReads === 2, 'a refused cursor: everything marked changed, a fresh cursor');
        check(log.filter((path) => path.includes('/core/v5/events/')).length === 5, 'five feed pages read in all');
    }

    console.log('--- decrypted events reused');
    {
        const { api } = makeApi(() => null);
        api.calendarDataById.set('cal-1', { calendarID: 'cal-1', calendarKeys: [] });
        api.calendarDataById.set('cal-2', { calendarID: 'cal-2', calendarKeys: [] });
        let decryptions = 0;
        api.decryptCalendarEvent = async (raw: any) => {
            decryptions += 1;
            return raw.ID === 'broken' ? null : { id: raw.ID, summary: `title of ${raw.ID} v${raw.ModifyTime}`, isAllDay: false };
        };
        const e1 = event('e1', 'uid-1', { SharedEvents: [{ Type: 3, Data: 'enc-1' }], AttendeesInfo: { Attendees: [{ Token: 't', Status: 0, UpdateTime: null }], MoreAttendees: 0 } });
        const e2 = event('e2', 'uid-2', { SharedEvents: [{ Type: 3, Data: 'enc-2' }] });
        const first = await api.decryptEvents('cal-1', [e1, e2, { ...event('broken', 'uid-b') }]);
        check(first.length === 2 && decryptions === 3, 'first time: everything decrypted (the broken one too)');
        const second = await api.decryptEvents('cal-1', [e1, e2]);
        check(decryptions === 3 && second[0] === first[0] && second[1] === first[1], 'unchanged: nothing decrypted again, the same objects');
        await api.decryptEvents('cal-1', [{ ...e1, SharedEvents: [{ Type: 3, Data: 'enc-1b' }], ModifyTime: 1_800_000_001 }]);
        check(decryptions === 4, 'a changed encrypted part: decrypted again');
        await api.decryptEvents('cal-1', [{ ...e2, AttendeesInfo: { Attendees: [{ Token: 't', Status: 1, UpdateTime: 1_800_000_002 }], MoreAttendees: 0 } }]);
        check(decryptions === 5, "a guest's answer: decrypted again (the answers are read into the event)");
        await api.decryptEvents('cal-1', [{ ...e2, StartTime: 1_800_000_100 }]);
        check(decryptions === 6, 'moved: decrypted again');
        await api.decryptEvents('cal-2', [e1]);
        check(decryptions === 7, 'the same event ID in another calendar is another event');
        await api.decryptEvents('cal-1', [{ ...event('broken', 'uid-b') }]);
        check(decryptions === 8, 'a failed decryption is tried again');
        const stats = api.getDecryptStats();
        check(stats.decrypted === 8 && stats.reused === 2 && stats.cached === 3, `statistics: ${JSON.stringify(stats)}`);
    }

    console.log(failures ? `\n${failures} check(s) failed` : '\nAll change-feed checks passed');
    process.exit(failures ? 1 : 0);
};

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
