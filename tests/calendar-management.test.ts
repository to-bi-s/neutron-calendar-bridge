/**
 * Calendar management (0.34): a calendar renamed or recoloured in Calendar.app (PROPPATCH) goes to
 * Proton and into the mirror; a calendar created in Calendar.app (MKCALENDAR) becomes a Proton
 * calendar at the path Calendar.app chose; deleting stays refused. 0.35.1: the task list Reminders
 * asks every CalDAV account for (VTODO only, named with Apple's raw key) is refused, not created.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CalDAVServer, isTaskListRequest, parseCalendarProperties } from '../src/main/caldav-server';
import { fakeSafeStorage } from './support/fake-safe-storage';
import { loginFetch, withLogin } from './support/caldav-login';

const fetch = loginFetch('bridge-user', 'bridge-pass');
const PORT = 33003;
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

/** Calendar.app's PROPPATCH for a rename; its recolour comes as a separate request. */
const RENAME = `<?xml version="1.0" encoding="UTF-8"?>
<A:propertyupdate xmlns:A="DAV:">
  <A:set>
    <A:prop>
      <A:displayname>Family &amp; Friends</A:displayname>
    </A:prop>
  </A:set>
</A:propertyupdate>`;
const RECOLOUR = `<?xml version="1.0" encoding="UTF-8"?>
<A:propertyupdate xmlns:A="DAV:">
  <A:set>
    <A:prop>
      <B:calendar-color xmlns:B="http://apple.com/ns/ical/" symbolic-color="purple">#711A76FF</B:calendar-color>
      <B:calendar-order xmlns:B="http://apple.com/ns/ical/">3</B:calendar-order>
    </A:prop>
  </A:set>
</A:propertyupdate>`;
const MKCALENDAR = `<?xml version="1.0" encoding="UTF-8"?>
<B:mkcalendar xmlns:B="urn:ietf:params:xml:ns:caldav">
  <A:set xmlns:A="DAV:">
    <A:prop>
      <A:displayname>Garden</A:displayname>
      <C:calendar-color xmlns:C="http://apple.com/ns/ical/" symbolic-color="green">#1D9BF6FF</C:calendar-color>
      <B:calendar-description>Watering &amp; pruning</B:calendar-description>
      <B:supported-calendar-component-set><B:comp name="VEVENT"/></B:supported-calendar-component-set>
      <C:calendar-order>5</C:calendar-order>
      <B:calendar-timezone>BEGIN:VCALENDAR
BEGIN:VTIMEZONE
TZID:Europe/Amsterdam
END:VTIMEZONE
END:VCALENDAR
</B:calendar-timezone>
    </A:prop>
  </A:set>
</B:mkcalendar>`;
/** What Reminders (CalendarAgent) sends to every CalDAV account that has no task list yet, on every refresh. */
const REMINDERS_LIST = `<?xml version="1.0" encoding="UTF-8"?>
<B:mkcalendar xmlns:B="urn:ietf:params:xml:ns:caldav">
  <A:set xmlns:A="DAV:">
    <A:prop>
      <B:supported-calendar-component-set>
        <B:comp name="VTODO"/>
      </B:supported-calendar-component-set>
      <A:displayname>DEFAULT_TASK_CALENDAR_NAME</A:displayname>
      <C:calendar-order xmlns:C="http://apple.com/ns/ical/">1</C:calendar-order>
      <C:calendar-color xmlns:C="http://apple.com/ns/ical/" symbolic-color="blue">#1BADF8FF</C:calendar-color>
    </A:prop>
  </A:set>
</B:mkcalendar>`;

test('calendar properties are read from PROPPATCH and MKCALENDAR bodies', () => {
    assert.deepEqual(parseCalendarProperties(RENAME), { displayName: 'Family & Friends', others: [], removed: [] });
    assert.deepEqual(parseCalendarProperties(RECOLOUR), { color: '#711A76FF', order: '3', others: [], removed: [] });
    const made = parseCalendarProperties(MKCALENDAR);
    assert.equal(made.displayName, 'Garden');
    assert.equal(made.color, '#1D9BF6FF');
    assert.equal(made.description, 'Watering & pruning');
    assert.equal(made.order, '5');
    assert.deepEqual(made.others, ['supported-calendar-component-set', 'calendar-timezone']);
    assert.deepEqual(made.components, ['VEVENT']);
    assert.equal(isTaskListRequest(made), false);
    assert.deepEqual(parseCalendarProperties(''), { others: [], removed: [] });
    assert.equal(isTaskListRequest(parseCalendarProperties('')), false);
    // Reminders' task list: VTODO only, Apple's untranslated name. Either sign is enough.
    const list = parseCalendarProperties(REMINDERS_LIST);
    assert.deepEqual(list.components, ['VTODO']);
    assert.equal(list.displayName, 'DEFAULT_TASK_CALENDAR_NAME');
    assert.equal(isTaskListRequest(list), true);
    assert.equal(isTaskListRequest(parseCalendarProperties(REMINDERS_LIST.replace('DEFAULT_TASK_CALENDAR_NAME', 'Chores'))), true);
    assert.equal(isTaskListRequest(parseCalendarProperties(REMINDERS_LIST.replace('name="VTODO"', 'name="VEVENT"'))), true);
    assert.equal(isTaskListRequest(parseCalendarProperties(REMINDERS_LIST.replace('name="VTODO"', 'name="VEVENT"').replace('DEFAULT_TASK_CALENDAR_NAME', 'Chores'))), false);
    assert.equal(isTaskListRequest(parseCalendarProperties(REMINDERS_LIST.replace('<B:comp name="VTODO"/>', "<B:comp name='vevent' /><B:comp name=\"VTODO\"/>").replace('DEFAULT_TASK_CALENDAR_NAME', 'Chores'))), false);
    // An empty component set says nothing.
    assert.equal(isTaskListRequest(parseCalendarProperties(REMINDERS_LIST.replace('<B:comp name="VTODO"/>', '').replace('DEFAULT_TASK_CALENDAR_NAME', 'Chores'))), false);
    // A removal is not a change the bridge makes; it is reported as refused.
    assert.deepEqual(parseCalendarProperties('<D:propertyupdate xmlns:D="DAV:"><D:remove><D:prop><D:displayname/></D:prop></D:remove></D:propertyupdate>'), { others: [], removed: ['displayname'] });
    // CDATA, hex entities, attributes with ">" inside.
    const tricky = parseCalendarProperties(
        '<D:propertyupdate xmlns:D="DAV:"><D:set><D:prop><D:displayname title="a>b"><![CDATA[Rock & <Roll>]]> &#x2014; &#233;t&#xE9;</D:displayname></D:prop></D:set></D:propertyupdate>'
    );
    assert.equal(tricky.displayName, 'Rock & <Roll> — été');
});

test('caldav server: PROPPATCH renames/recolours through the bridge, MKCALENDAR creates, DELETE is refused', async () => {
    const calls: Array<[string, ...unknown[]]> = [];
    const recorded: unknown[] = [];
    const calendar = {
        protonCalendarId: 'cal-1',
        slug: 'tobi-private',
        displayName: 'Tobi (Private)',
        color: '#5252cc',
        description: '',
        visible: true,
        removed: false,
        ctag: '1',
        lastPolledAt: null,
        lastSyncedAt: null
    };
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
        async getCalendarBySlug(slug: string) {
            return slug === 'tobi-private' ? calendar : null;
        },
        async listEventsForSlug() {
            return [];
        },
        async updateCalendarAppearance(slug: string, changes: unknown) {
            calls.push(['update', slug, changes]);
            if ((changes as { name?: string }).name === 'refused') {
                throw new Error('The calendar could not be changed in Proton: nope');
            }
            return { ...calendar, displayName: 'Family & Friends' };
        },
        async createCalendarFromCalendarApp(slug: string, appearance: unknown) {
            calls.push(['create', slug, appearance]);
            return { ...calendar, slug, protonCalendarId: 'cal-new' };
        },
        async untickFromCalendarApp(slug: string) {
            calls.push(['untick', slug]);
        },
        // 0.37.7: "Events affect availability"
        async getCalendars() {
            return [calendar];
        },
        isCalendarOpaque: (entry: { protonCalendarId: string }) => !transparent.has(entry.protonCalendarId),
        async setCalendarAvailability(slug: string, opaque: boolean) {
            calls.push(['availability', slug, opaque]);
            if (opaque) transparent.delete('cal-1');
            else transparent.add('cal-1');
        },
        getAccountAddresses: () => ['tobi@proton.me', 'tobi@pm.me'],
        getSignedInUsername: () => 'tobi@proton.me',
        recordCalDAVError: (entry: unknown) => recorded.push(entry)
    });
    const transparent = new Set<string>();
    const server = new CalDAVServer(fakeBridgeService as any);
    await server.start();
    try {
        // 0.37.7: what Calendar.app's Availability panel reads — the calendar's transparency (and the old
        // free-busy set on the home and the inbox), the principal's email addresses.
        const home = await (await fetch(`${BASE}/calendars/bridge-user/`, { method: 'PROPFIND', headers: { Depth: '1' } })).text();
        assert.match(home, /<C:schedule-calendar-transp><C:opaque\/><\/C:schedule-calendar-transp>/);
        assert.match(home, /<C:calendar-free-busy-set><D:href>\/calendars\/bridge-user\/tobi-private\/<\/D:href><\/C:calendar-free-busy-set>/);
        assert.match(await (await fetch(`${BASE}/calendars/bridge-user/tobi-private/`, { method: 'PROPFIND', headers: { Depth: '0' } })).text(), /<C:schedule-calendar-transp><C:opaque\/>/);
        assert.match(await (await fetch(`${BASE}/inbox/bridge-user/`, { method: 'PROPFIND', headers: { Depth: '0' } })).text(), /<C:calendar-free-busy-set><D:href>\/calendars\/bridge-user\/tobi-private\/<\/D:href>/);
        const principal = await (await fetch(`${BASE}/principals/bridge-user/`, { method: 'PROPFIND', headers: { Depth: '0' } })).text();
        assert.match(principal, /<CS:email-address-set>\s*<CS:email-address>tobi@proton.me<\/CS:email-address>\s*<CS:email-address>tobi@pm.me<\/CS:email-address>\s*<\/CS:email-address-set>/);
        // Switched off in Calendar.app: stored, served as transparent, out of the free-busy set; on again: back.
        const off = await fetch(`${BASE}/calendars/bridge-user/tobi-private/`, {
            method: 'PROPPATCH',
            body: '<D:propertyupdate xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav"><D:set><D:prop><C:schedule-calendar-transp><C:transparent/></C:schedule-calendar-transp></D:prop></D:set></D:propertyupdate>'
        });
        assert.equal(off.status, 207);
        assert.deepEqual(calls.pop(), ['availability', 'tobi-private', false]);
        const homeOff = await (await fetch(`${BASE}/calendars/bridge-user/`, { method: 'PROPFIND', headers: { Depth: '1' } })).text();
        assert.match(homeOff, /<C:schedule-calendar-transp><C:transparent\/>/);
        assert.match(homeOff, /<C:calendar-free-busy-set><\/C:calendar-free-busy-set>/);
        transparent.clear();

        const renamed = await fetch(`${BASE}/calendars/bridge-user/tobi-private/`, { method: 'PROPPATCH', body: RENAME });
        assert.equal(renamed.status, 207);
        const renamedXml = await renamed.text();
        assert.match(renamedXml, /<D:prop><D:displayname\/><\/D:prop>\s*<D:status>HTTP\/1.1 200 OK/);
        assert.doesNotMatch(renamedXml, /403/);
        assert.deepEqual(calls.pop(), ['update', 'tobi-private', { name: 'Family & Friends' }]);

        const recoloured = await fetch(`${BASE}/calendars/bridge-user/tobi-private/`, { method: 'PROPPATCH', body: RECOLOUR });
        assert.equal(recoloured.status, 207);
        const recolouredXml = await recoloured.text();
        assert.match(recolouredXml, /<D:prop><A:calendar-color\/><A:calendar-order\/><\/D:prop>\s*<D:status>HTTP\/1.1 200 OK/);
        assert.deepEqual(calls.pop(), ['update', 'tobi-private', { color: '#711A76FF' }]);

        // Calendar.app's own housekeeping properties are accepted (not stored); a removal and an unknown property are refused.
        const housekeeping = await fetch(`${BASE}/calendars/bridge-user/tobi-private/`, {
            method: 'PROPPATCH',
            body: '<D:propertyupdate xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav"><D:set><D:prop><C:schedule-calendar-transp><C:opaque/></C:schedule-calendar-transp><C:calendar-timezone>BEGIN:VCALENDAR\nEND:VCALENDAR</C:calendar-timezone></D:prop></D:set></D:propertyupdate>'
        });
        assert.equal(housekeeping.status, 207);
        assert.match(await housekeeping.text(), /<D:prop><C:schedule-calendar-transp\/><C:calendar-timezone\/><\/D:prop>\s*<D:status>HTTP\/1.1 200 OK/);
        const other = await fetch(`${BASE}/calendars/bridge-user/tobi-private/`, {
            method: 'PROPPATCH',
            body: '<D:propertyupdate xmlns:D="DAV:"><D:set><D:prop><D:getctag>x</D:getctag></D:prop></D:set><D:remove><D:prop><D:displayname/></D:prop></D:remove></D:propertyupdate>'
        });
        assert.equal(other.status, 207);
        assert.match(await other.text(), /<D:prop><D:getctag\/><D:displayname\/><\/D:prop>\s*<D:status>HTTP\/1.1 403 Forbidden/);
        assert.deepEqual(calls.splice(0), [['availability', 'tobi-private', true]], 'the transparency is the one housekeeping property that is stored');
        // A description travels too.
        const described = await fetch(`${BASE}/calendars/bridge-user/tobi-private/`, {
            method: 'PROPPATCH',
            body: '<D:propertyupdate xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav"><D:set><D:prop><C:calendar-description>Mine</C:calendar-description></D:prop></D:set></D:propertyupdate>'
        });
        assert.match(await described.text(), /<C:calendar-description\/><\/D:prop>\s*<D:status>HTTP\/1.1 200 OK/);
        assert.deepEqual(calls.pop(), ['update', 'tobi-private', { description: 'Mine' }]);

        // Proton refused: 403 with the reason, recorded for the Overview page.
        const refused = await fetch(`${BASE}/calendars/bridge-user/tobi-private/`, {
            method: 'PROPPATCH',
            body: RENAME.replace('Family &amp; Friends', 'refused')
        });
        assert.equal(refused.status, 403);
        assert.match(await refused.text(), /could not be changed in Proton: nope/);
        assert.equal(recorded.length, 1);
        calls.length = 0;

        // MKCALENDAR at a new path: created with the properties Calendar.app sent.
        const made = await fetch(`${BASE}/calendars/bridge-user/8F3C2A1B-1111-2222-3333-444455556666/`, { method: 'MKCALENDAR', body: MKCALENDAR });
        assert.equal(made.status, 201);
        assert.deepEqual(calls.pop(), ['create', '8F3C2A1B-1111-2222-3333-444455556666', { name: 'Garden', color: '#1D9BF6FF', description: 'Watering & pruning' }]);
        // Without a body: a calendar called "Calendar".
        const bare = await fetch(`${BASE}/calendars/bridge-user/new-one/`, { method: 'MKCALENDAR' });
        assert.equal(bare.status, 201);
        assert.deepEqual(calls.pop(), ['create', 'new-one', { name: 'Calendar', color: undefined, description: undefined }]);
        // At an existing path: 405 with Allow.
        const taken = await fetch(`${BASE}/calendars/bridge-user/tobi-private/`, { method: 'MKCALENDAR', body: MKCALENDAR });
        assert.equal(taken.status, 405);
        assert.match(taken.headers.get('allow') || '', /PROPPATCH/);
        assert.equal(calls.length, 0);
        // 0.35.1: Reminders' task list is refused (403), nothing is created in Proton, and the Overview page
        // is not told (the request repeats on every refresh).
        for (let attempt = 0; attempt < 2; attempt += 1) {
            const list = await fetch(`${BASE}/calendars/bridge-user/0D4B6C2E-5555-6666-7777-888899990000/`, { method: 'MKCALENDAR', body: REMINDERS_LIST });
            assert.equal(list.status, 403);
            assert.match(await list.text(), /Task lists \(Reminders\) are not created in Proton/);
        }
        assert.equal(calls.length, 0);
        assert.equal(recorded.length, 1);

        // Deleting a calendar (0.37): taken out of Calendar.app only — unticked here, kept in Proton; no failure recorded.
        const deleted = await fetch(`${BASE}/calendars/bridge-user/tobi-private/`, { method: 'DELETE' });
        assert.equal(deleted.status, 204);
        assert.deepEqual(calls.pop(), ['untick', 'tobi-private']);
        assert.equal(recorded.length, 1);

        const options = await fetch(`${BASE}/calendars/bridge-user/tobi-private/`, { method: 'OPTIONS' });
        assert.match(options.headers.get('allow') || '', /PROPPATCH.*MKCALENDAR/);
    } finally {
        await server.stop();
    }
});

test('bridge service: a rename reaches Proton and the mirror; a new calendar keeps the path Calendar.app chose and is queued for a sync', async () => {
    stubElectron();
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { BridgeService } = require('../src/main/bridge-service') as typeof import('../src/main/bridge-service');
    const baseDir = mkdtempSync(join(tmpdir(), 'neutron-calendar-bridge-calendars-'));
    const service = new BridgeService(baseDir) as any;
    try {
        await service.mirrorDatabase.initialize();
        service.localCaldavPassword = 'test';
        const remote = [
            { id: 'cal-1', name: 'Tobi (Private)', color: '#5252CC', visible: true, writable: true, type: 0, owned: true },
            { id: 'cal-shared', name: "Anna's calendar", color: '#3CBB3A', visible: true, writable: false, readOnlyReason: 'view only', type: 0, owned: false }
        ];
        const protonCalls: Array<[string, ...unknown[]]> = [];
        service.protonAdapter = {
            isSignedIn: () => true,
            getSignedInUsername: () => 'tobi',
            supportsCalendarManagement: () => true,
            listCalendars: async () => remote.map((entry) => ({ ...entry })),
            listAddresses: () => [],
            async updateCalendarAppearance(id: string, changes: { name?: string; color?: string }) {
                protonCalls.push(['update', id, changes]);
                const entry = remote.find((calendar) => calendar.id === id)!;
                if (changes.name !== undefined) entry.name = changes.name;
                if (changes.color !== undefined) entry.color = '#F78400'; // Proton maps colours to its own
            },
            async createCalendar(appearance: { name?: string; color?: string; description?: string }) {
                protonCalls.push(['create', appearance]);
                const id = appearance.name === 'Garden' ? 'cal-new' : `cal-${appearance.name!.toLowerCase()}`;
                remote.push({ id, name: appearance.name!, color: '#1DA583', visible: true, writable: true, type: 0, owned: true });
                return { id };
            }
        };
        service.drainInBackground = () => undefined; // no sync pass in this test
        await service.reconcileCalendars(remote);
        const before = await service.mirrorDatabase.getCalendarBySlug('tobi-private');
        assert.ok(before);

        // Rename + recolour (two requests, as Calendar.app sends them).
        await service.updateCalendarAppearance('tobi-private', { name: 'Family & Friends' });
        await service.updateCalendarAppearance('tobi-private', { color: '#711A76FF' });
        assert.deepEqual(protonCalls, [
            ['update', 'cal-1', { name: 'Family & Friends', color: undefined, description: undefined }],
            ['update', 'cal-1', { name: undefined, color: '#711A76FF', description: undefined }]
        ]);
        const after = await service.mirrorDatabase.getCalendarBySlug('tobi-private');
        assert.equal(after.displayName, 'Family & Friends');
        assert.equal(after.color, '#F78400', "the colour Proton kept, not Calendar.app's");
        assert.notEqual(after.ctag, before.ctag);
        // A calendar shared with you can be renamed too (your member entry).
        await service.updateCalendarAppearance((await service.mirrorDatabase.listCalendars()).find((c: any) => c.protonCalendarId === 'cal-shared').slug, { name: 'Anna' });
        assert.equal(protonCalls.length, 3);
        await assert.rejects(service.updateCalendarAppearance('tobi-private', { name: '   ' }), /needs a name/);
        await assert.rejects(service.updateCalendarAppearance('nope', { name: 'x' }), /Unknown calendar/);
        // 0.37.8: Calendar.app sends the properties back after every edit — the same name, the colour as
        // served (with Calendar.app's FF alpha), an empty description: nothing goes to Proton.
        const unchangedCtag = (await service.mirrorDatabase.getCalendarBySlug('tobi-private')).ctag;
        await service.updateCalendarAppearance('tobi-private', { name: 'Family & Friends' });
        await service.updateCalendarAppearance('tobi-private', { color: '#f78400ff' });
        await service.updateCalendarAppearance('tobi-private', { description: '' });
        assert.equal(protonCalls.length, 3, 'nothing written for unchanged values');
        assert.equal((await service.mirrorDatabase.getCalendarBySlug('tobi-private')).ctag, unchangedCtag);
        await service.updateCalendarAppearance('tobi-private', { description: 'Ours' });
        assert.equal(protonCalls.length, 4, 'a real description change is written');

        // Create: the path Calendar.app chose is the slug; ticked by default; queued for a sync.
        protonCalls.length = 0;
        const created = await service.createCalendarFromCalendarApp('8F3C2A1B-1111', { name: 'Garden', color: '#1D9BF6FF', description: 'd' });
        assert.deepEqual(protonCalls, [['create', { name: 'Garden', color: '#1D9BF6FF', description: 'd' }]], 'no address set: the client takes the first active one');
        assert.equal(created.protonCalendarId, 'cal-new');
        assert.equal(created.slug, '8F3C2A1B-1111');
        assert.equal((await service.mirrorDatabase.getCalendarBySlug('8F3C2A1B-1111')).displayName, 'Garden');
        assert.ok(service.syncQueue.some((job: any) => job.calendarId === 'cal-new'), 'queued for its first sync');
        assert.equal(await service.getCalendarBySlug('8F3C2A1B-1111') !== null, true, 'ticked (served)');
        // A later reconcile keeps that path.
        await service.reconcileCalendars(remote);
        assert.equal((await service.mirrorDatabase.getCalendarBySlug('8F3C2A1B-1111')).protonCalendarId, 'cal-new');
        // A path that is taken or odd is refused before anything is created in Proton.
        protonCalls.length = 0;
        await assert.rejects(service.createCalendarFromCalendarApp('../etc', { name: 'Odd' }), /cannot be used/);
        await assert.rejects(service.createCalendarFromCalendarApp('tobi-private', { name: 'Odd' }), /cannot be used/);
        assert.equal(protonCalls.length, 0);
        await assert.rejects(service.createCalendarFromCalendarApp('x', { name: '' }), /needs a name/);
        // 0.37: the address for new calendars — one of the account's, kept as listed; '' = the first active one.
        service.protonAdapter.listAddresses = () => [
            { email: 'main@proton.me', active: true },
            { email: 'second@proton.me', active: true },
            { email: 'old@proton.me', active: false }
        ];
        service.refreshAccountAddresses();
        assert.deepEqual(service.getAccountAddresses(), ['main@proton.me', 'second@proton.me', 'old@proton.me'], 'a disabled address still counts as "me"');
        assert.deepEqual((await service.getBridgeState()).addresses, ['main@proton.me', 'second@proton.me'], 'but only active ones are offered');
        await assert.rejects(service.updateConfig({ newCalendarAddress: 'nobody@example.com' }), /not one of this account/);
        await assert.rejects(service.updateConfig({ newCalendarAddress: 'old@proton.me' }), /not one of this account/, 'a disabled address cannot own a new calendar');
        await service.updateConfig({ newCalendarAddress: 'SECOND@proton.me' });
        assert.equal(service.configStore.load().newCalendarAddress, 'second@proton.me');
        assert.equal((await service.getBridgeState()).newCalendarAddress, 'second@proton.me');
        protonCalls.length = 0;
        await service.createCalendarFromCalendarApp('with-address', { name: 'Work' });
        assert.deepEqual(protonCalls, [['create', { name: 'Work', color: undefined, description: undefined, address: 'second@proton.me' }]]);
        // The chosen address disabled in Proton meanwhile: the first active one owns the calendar, the setting is cleared.
        service.protonAdapter.listAddresses = () => [
            { email: 'main@proton.me', active: true },
            { email: 'second@proton.me', active: false }
        ];
        service.refreshAccountAddresses();
        protonCalls.length = 0;
        await service.createCalendarFromCalendarApp('fallback', { name: 'Later' });
        assert.deepEqual(protonCalls, [['create', { name: 'Later', color: undefined, description: undefined }]]);
        assert.equal(service.configStore.load().newCalendarAddress, '');
        // Deleted in Calendar.app: unticked here (not served, events dropped), kept in Proton, a notification says so.
        const notes: any[] = [];
        service.onNotify = (note: any) => notes.push(note);
        await service.untickFromCalendarApp('with-address');
        assert.equal(await service.getCalendarBySlug('with-address'), null, 'no longer served');
        assert.equal(service.isCalendarSyncEnabled('cal-work'), false);
        assert.ok(remote.some((entry) => entry.id === 'cal-work'), 'still in Proton');
        assert.equal(notes.length, 1);
        assert.match(notes[0].body, /stays in Proton Calendar/);
        await assert.rejects(service.untickFromCalendarApp('nope'), /not found/);
        // Changes that waited for Proton in a calendar deleted in Calendar.app are dropped quietly (nothing to send them to).
        await service.mirrorDatabase.putOutboxItem({ createdAt: Date.now(), protonCalendarId: 'cal-later', slug: 'fallback', uid: 'u-1', kind: 'put', resourceName: 'u-1.ics', href: '/calendars/x/fallback/u-1.ics', ics: 'BEGIN:VCALENDAR\nEND:VCALENDAR', notifyOrganizer: false, snapshot: null });
        service.notePending('cal-later', 'u-1', true);
        assert.equal(service.pendingChangeCount(), 1);
        notes.length = 0;
        await service.untickFromCalendarApp('fallback');
        assert.match(notes[0].body, /1 change made while Proton could not be reached is dropped/);
        await service.runOutbox();
        assert.equal((await service.mirrorDatabase.listOutbox()).length, 0, 'dropped, not "refused"');
        assert.equal(service.pendingChangeCount(), 0);
        assert.equal(service.recentCalDAVErrors.length, 0, 'no misleading failure recorded');
        // Created in Proton but not listed yet: still a success (null record), the next pass lists it.
        service.protonAdapter.createCalendar = async () => ({ id: 'cal-late' });
        const listCalendars = service.protonAdapter.listCalendars;
        service.protonAdapter.listCalendars = async () => {
            throw new Error('listing failed');
        };
        assert.equal(await service.createCalendarFromCalendarApp('late-one', { name: 'Late' }), null);
        service.protonAdapter.listCalendars = listCalendars;
        // Proton asking to slow down keeps its name and retry time through the translated reason.
        service.protonAdapter.createCalendar = async () => {
            throw Object.assign(new Error('slow'), { name: 'RateLimitedError', retryAt: Date.now() + 30_000 });
        };
        await assert.rejects(service.createCalendarFromCalendarApp('slow-one', { name: 'Slow' }), (error: any) => error.name === 'RateLimitedError' && typeof error.retryAt === 'number');
        service.slowDownUntil = 0;
        // An older client: refused with the old message.
        service.protonAdapter.supportsCalendarManagement = () => false;
        await assert.rejects(service.createCalendarFromCalendarApp('y', { name: 'Y' }), /Manage calendars in Proton/);
        await assert.rejects(service.updateCalendarAppearance('tobi-private', { name: 'Z' }), /Manage calendars in Proton/);
    } finally {
        rmSync(baseDir, { recursive: true, force: true });
    }
});

test('0.42: a rename/recolour while Proton cannot be reached waits in the outbox (shown at once, kept through sync passes), goes out when Proton is back; refused then, Proton\'s name comes back', async () => {
    stubElectron();
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { BridgeService } = require('../src/main/bridge-service') as typeof import('../src/main/bridge-service');
    const baseDir = mkdtempSync(join(tmpdir(), 'neutron-calendar-bridge-calendars-offline-'));
    const service = new BridgeService(baseDir) as any;
    try {
        await service.mirrorDatabase.initialize();
        service.localCaldavPassword = 'test';
        const remote = [{ id: 'cal-1', name: 'Tobi (Private)', color: '#5252CC', visible: true, writable: true, type: 0, owned: true }];
        const state = { online: false, refuse: false };
        const calls: unknown[] = [];
        service.protonAdapter = {
            isSignedIn: () => true,
            getSignedInUsername: () => 'tobi',
            supportsCalendarManagement: () => true,
            listCalendars: async () => remote.map((entry) => ({ ...entry })),
            listAddresses: () => [],
            async updateCalendarAppearance(id: string, changes: { name?: string; color?: string }) {
                if (!state.online) throw new TypeError('fetch failed');
                calls.push(changes);
                if (state.refuse) throw Object.assign(new Error('Calendar name too long'), { status: 422, data: { Code: 2001 } });
                const entry = remote.find((calendar) => calendar.id === id)!;
                if (changes.name !== undefined) entry.name = changes.name;
                if (changes.color !== undefined) entry.color = changes.color.slice(0, 7).toUpperCase();
            }
        };
        service.drainInBackground = () => undefined;
        service.scheduleOutboxRetry = () => undefined;
        await service.reconcileCalendars(remote);
        const before = await service.mirrorDatabase.getCalendarBySlug('tobi-private');

        const renamed = await service.updateCalendarAppearance('tobi-private', { name: 'Family' });
        assert.equal(renamed.displayName, 'Family', 'accepted for Calendar.app (no 403)');
        await service.updateCalendarAppearance('tobi-private', { color: '#711A76FF' });
        assert.equal((await service.mirrorDatabase.listOutbox()).length, 1, 'one waiting change for the calendar');
        assert.equal((await service.getBridgeState()).pendingChanges, 1);
        const shown = await service.mirrorDatabase.getCalendarBySlug('tobi-private');
        assert.equal(shown.displayName, 'Family');
        assert.notEqual(shown.ctag, before.ctag, 'Calendar.app sees it');
        // A sync pass with Proton's old name keeps the waiting one.
        await service.reconcileCalendars(remote);
        assert.equal((await service.mirrorDatabase.getCalendarBySlug('tobi-private')).displayName, 'Family');

        state.online = true;
        await service.flushOutbox();
        assert.deepEqual(calls, [{ name: 'Family', color: '#711A76FF' }], 'sent once, both changes together');
        assert.equal((await service.mirrorDatabase.listOutbox()).length, 0);
        assert.equal((await service.mirrorDatabase.getCalendarBySlug('tobi-private')).color, '#711A76', "Proton's colour read back");

        // Refused once back: Proton's name again, reported.
        state.online = false;
        await service.updateCalendarAppearance('tobi-private', { name: 'A name Proton will refuse' });
        state.online = true;
        state.refuse = true;
        await service.flushOutbox();
        assert.equal((await service.mirrorDatabase.getCalendarBySlug('tobi-private')).displayName, 'Family', "Proton's name back");
        assert.match((await service.getBridgeState()).recentCalDAVErrors[0].message, /refused now that it is back/);

        // 0.42.1: Proton not answering (a lost connection takes half a minute to time out): Calendar.app gets
        // its answer after a few seconds, the change waits; the replay waits for the late request to end first.
        state.refuse = false;
        service.appearanceAnswerMs = 50;
        let release: () => void = () => undefined;
        const hanging = new Promise<void>((resolve) => (release = resolve));
        const order: string[] = [];
        const answering = service.protonAdapter.updateCalendarAppearance;
        service.protonAdapter.updateCalendarAppearance = async (id: string, changes: any) => {
            if (changes.name === 'Slow') {
                await hanging;
                order.push('late request ended');
            }
            return answering(id, changes);
        };
        const started = Date.now();
        const slow = await service.updateCalendarAppearance('tobi-private', { name: 'Slow' });
        assert.ok(Date.now() - started < 1000, 'answered without waiting for Proton');
        assert.equal(slow.displayName, 'Slow');
        assert.equal((await service.mirrorDatabase.listOutbox()).length, 1, 'waits in the outbox');
        const flushing = service.flushOutbox().then(() => order.push('replayed'));
        await new Promise((resolve) => setTimeout(resolve, 30));
        assert.deepEqual(order, [], 'the replay waits for the late request');
        release();
        await flushing;
        assert.deepEqual(order, ['late request ended', 'late request ended', 'replayed']);
        assert.equal((await service.mirrorDatabase.listOutbox()).length, 0);
        assert.equal(remote[0].name, 'Slow');

        // A known outage: nothing is tried, the change waits at once.
        service.outage = { since: Date.now(), awakeMs: 0, lastCheckAt: Date.now(), notified: false };
        calls.length = 0;
        await service.updateCalendarAppearance('tobi-private', { name: 'Offline' });
        assert.deepEqual(calls, [], 'not sent while Proton is known to be away');
        assert.equal((await service.mirrorDatabase.listOutbox()).length, 1);
        service.outage = null;
    } finally {
        await service.mirrorDatabase.close();
        rmSync(baseDir, { recursive: true, force: true });
    }
});
