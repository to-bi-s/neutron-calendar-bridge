/**
 * Subscribed and holidays calendars (and view-only shared or disabled ones) are read-only in
 * Proton. The bridge serves them read-only, so Calendar.app does not offer to edit them, and
 * refuses writes with 403 instead of failing in Proton with a 500 that Calendar.app retries.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CalDAVServer } from '../src/main/caldav-server';
import { MirrorDatabase } from '../src/main/mirror-database';
import { loginFetch, withLogin } from './support/caldav-login';
import { fakeSafeStorage } from './support/fake-safe-storage';

const fetch = loginFetch('neutron-calendar-bridge', 'p');

const stubElectron = () => {
    const resolved = require.resolve('electron');
    require.cache[resolved] = {
        id: resolved,
        filename: resolved,
        loaded: true,
        exports: { app: { setLoginItemSettings: () => undefined }, safeStorage: fakeSafeStorage }
    } as unknown as NodeJS.Module;
};

const remoteCalendars = [
    { id: 'personal', name: 'Tobi (Private)', color: '#6d4aff', visible: true, writable: true },
    { id: 'holidays', name: 'Holidays in Germany', color: '#10b981', visible: true, writable: false, readOnlyReason: 'holidays calendar' },
    { id: 'feed', name: 'Bundesliga', color: '#dc3f63', visible: true, writable: false, readOnlyReason: 'subscribed calendar' }
];

const PLAIN_ICS = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Apple Inc.//macOS 26.0//EN',
    'BEGIN:VEVENT', 'UID:EV-1', 'DTSTAMP:20261001T080000Z',
    'DTSTART;TZID=Europe/Amsterdam:20261005T100000', 'DTEND;TZID=Europe/Amsterdam:20261005T110000',
    'SUMMARY:Edited by mistake', 'END:VEVENT', 'END:VCALENDAR', ''
].join('\r\n');

test('read-only calendars: remembered from Proton, writes refused with the reason, nothing sent', async () => {
    stubElectron();
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { BridgeService } = require('../src/main/bridge-service') as typeof import('../src/main/bridge-service');
    const baseDir = mkdtempSync(join(tmpdir(), 'neutron-calendar-bridge-readonly-'));
    const service = new BridgeService(baseDir) as any;
    await service.mirrorDatabase.initialize();
    service.localCaldavPassword = 'test';
    const writes: string[] = [];
    service.protonAdapter = {
        isSignedIn: () => true,
        supportsSeriesSync: () => true,
        listCalendars: async () => remoteCalendars,
        listEvents: async () => [],
        createEvent: async () => (writes.push('create'), { success: true, id: 'x' }),
        updateEvent: async () => (writes.push('update'), { success: true }),
        deleteEvent: async () => (writes.push('delete'), { success: true }),
        syncSeries: async () => (writes.push('series'), { success: true, eventIds: ['x'] })
    };
    try {
        const calendars = await service.reconcileCalendars(remoteCalendars);
        const bySlug = Object.fromEntries(calendars.map((calendar: any) => [calendar.protonCalendarId, calendar]));
        assert.equal(bySlug.personal.readOnly, false);
        assert.equal(bySlug.holidays.readOnly, true);
        assert.equal(bySlug.holidays.readOnlyReason, 'holidays calendar');
        assert.equal(bySlug.feed.readOnlyReason, 'subscribed calendar');

        await assert.rejects(
            service.upsertLocalEvent(bySlug.feed.slug, 'EV-1.ics', `/calendars/neutron-calendar-bridge/${bySlug.feed.slug}/EV-1.ics`, PLAIN_ICS),
            { name: 'ReadOnlyEventError', message: /^This calendar is a subscribed calendar in Proton/ }
        );
        await assert.rejects(service.deleteLocalEvent(bySlug.holidays.slug, 'EV-1'), { name: 'ReadOnlyEventError' });
        assert.deepEqual(writes, [], 'nothing reached Proton');

        // Writable calendars still work.
        await service.upsertLocalEvent(bySlug.personal.slug, 'EV-1.ics', `/calendars/neutron-calendar-bridge/${bySlug.personal.slug}/EV-1.ics`, PLAIN_ICS);
        assert.deepEqual(writes, ['create']);

        // A calendar that becomes writable (or a client without the information) is writable again.
        const again = await service.reconcileCalendars(remoteCalendars.map(({ writable, readOnlyReason, ...rest }) => rest));
        assert.ok(again.every((calendar: any) => calendar.readOnly === false));
        assert.notEqual(
            again.find((calendar: any) => calendar.protonCalendarId === 'feed').ctag,
            bySlug.feed.ctag,
            'a change in writability bumps the calendar, so Calendar.app re-reads its permissions'
        );
    } finally {
        await service.mirrorDatabase.close();
        rmSync(baseDir, { recursive: true, force: true });
    }
});

test('older mirror databases get the read-only columns', async () => {
    const baseDir = mkdtempSync(join(tmpdir(), 'neutron-calendar-bridge-readonly-db-'));
    try {
        const first = new MirrorDatabase(baseDir);
        await first.initialize();
        await (first as any).exec('ALTER TABLE calendars DROP COLUMN read_only');
        await (first as any).exec('ALTER TABLE calendars DROP COLUMN read_only_reason');
        await first.close();

        const second = new MirrorDatabase(baseDir);
        await second.initialize();
        await second.upsertCalendar({
            protonCalendarId: 'feed', slug: 'feed', displayName: 'Feed', color: '#123456', description: '', visible: true,
            removed: false, ctag: '1', lastPolledAt: null, lastSyncedAt: null, readOnly: true, readOnlyReason: 'subscribed calendar'
        });
        const [calendar] = await second.listCalendars();
        assert.equal(calendar.readOnly, true);
        assert.equal(calendar.readOnlyReason, 'subscribed calendar');
        await second.close();
    } finally {
        rmSync(baseDir, { recursive: true, force: true });
    }
});

test('CalDAV: read-only calendars only grant read', async () => {
    const config = {
        host: '127.0.0.1',
        port: 32997,
        username: 'neutron-calendar-bridge',
        password: 'p',
        security: 'HTTP' as const,
        baseUrl: 'http://127.0.0.1:32997',
        serverPath: '/principals/neutron-calendar-bridge/'
    };
    const calendar = (slug: string, readOnly: boolean) => ({
        protonCalendarId: slug, slug, displayName: slug, color: '#123456', description: '', visible: true, removed: false,
        ctag: '1', lastPolledAt: null, lastSyncedAt: null, readOnly, readOnlyReason: readOnly ? 'subscribed calendar' : null
    });
    const calendars = [calendar('private', false), calendar('feed', true)];
    const fake = {
        isSignedIn: () => true,
        getCalDAVConfig: () => config,
        getSignedInUsername: () => 'tobi',
        getAccountAddresses: () => ['tobi@proton.me'],
        getCalendars: async () => calendars,
        getCalendarBySlug: async (slug: string) => calendars.find((entry) => entry.slug === slug) ?? null,
        listEventsForSlug: async () => [],
        recordCalDAVError: () => undefined
    };
    const server = new CalDAVServer(withLogin(fake) as any);
    await server.start();
    try {
        const home = await (await fetch(`${config.baseUrl}/calendars/neutron-calendar-bridge/`, { method: 'PROPFIND', headers: { Depth: '1' } })).text();
        // The calendar's own block (its href comes first; since 0.37.7 the home's block names the calendars in its free-busy set too).
        const block = (slug: string) => home.split('<D:response>').find((part) => part.trim().startsWith(`<D:href>/calendars/neutron-calendar-bridge/${slug}/</D:href>`)) || '';
        assert.match(block('private'), /<D:write\/>/);
        const homeBlock = home.split('<D:response>').find((part) => part.trim().startsWith('<D:href>/calendars/neutron-calendar-bridge/</D:href>')) || '';
        assert.match(homeBlock, /<C:supported-calendar-component-sets>\s*<C:supported-calendar-component-set><C:comp name="VEVENT"\/><\/C:supported-calendar-component-set>\s*<\/C:supported-calendar-component-sets>/, '0.48: the home offers events only (no task lists for Reminders)');
        assert.doesNotMatch(block('feed'), /<D:write\/>|<D:bind\/>/);
        assert.match(block('feed'), /<D:unbind\/>/, '0.45.4: it can be deleted in Calendar.app (unticked here); its events stay read-only');
        assert.match(block('feed'), /<D:write-properties\/>/, '0.45.6: Calendar.app only sends the DELETE with it');
        assert.doesNotMatch(block('feed'), /<D:write-content\/>/);
        assert.match(block('feed'), /<D:read\/>/);

        const collection = await (await fetch(`${config.baseUrl}/calendars/neutron-calendar-bridge/feed/`, { method: 'PROPFIND', headers: { Depth: '0' } })).text();
        // 0.48.7: Thunderbird finds the user's principal from the calendar (current-user-principal) or the home (principal-collection-set).
        for (const xml of [collection, homeBlock, block('feed')]) {
            assert.match(xml, /<D:current-user-principal>\s*<D:href>\/principals\/neutron-calendar-bridge\/<\/D:href>/);
            assert.match(xml, /<D:principal-collection-set>\s*<D:href>\/principals\/<\/D:href>/);
        }
        assert.match(collection, /<D:owner>\s*<D:href>\/principals\/neutron-calendar-bridge\/<\/D:href>/);
        assert.match(collection, /<D:current-user-privilege-set>/);
        assert.doesNotMatch(collection, /<D:write\/>/);

        // 0.45.5 experiment switch: the extra privileges of read-only calendars come from the environment.
        process.env.NEUTRON_READ_ONLY_PRIVILEGES = 'write-properties, unbind, bogus';
        try {
            const tried = await (await fetch(`${config.baseUrl}/calendars/neutron-calendar-bridge/feed/`, { method: 'PROPFIND', headers: { Depth: '0' } })).text();
            assert.match(tried, /<D:write-properties\/>/);
            assert.match(tried, /<D:unbind\/>/);
            assert.doesNotMatch(tried, /bogus|<D:write\/>/);
        } finally {
            delete process.env.NEUTRON_READ_ONLY_PRIVILEGES;
        }
    } finally {
        await server.stop();
    }
});
