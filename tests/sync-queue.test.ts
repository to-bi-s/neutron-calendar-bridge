/**
 * The sync queue and the status dots (0.18): calendar groups, one calendar or a group synced on
 * request (and taken off the queue again), public holidays only at sign-in and once a day (never by
 * Refresh), red dots for sync and connection trouble, yellow dots for refused Calendar.app changes
 * (kept until synced by hand; in a dry run until the next healthy automatic sync), and the menu's dot.
 * Proton is a fake; calendars have no events, so only the order and the state are looked at.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fakeSafeStorage } from './support/fake-safe-storage';

import {
    calendarKindOf,
    calendarSlugOfPath,
    calendarStatusOf,
    includesHolidays,
    isWarningWorthy,
    localDayOf,
    msUntilLocalMidnight,
    trayCalendarsStatusOf
} from '../src/main/sync-schedule';

const stubElectron = () => {
    const resolved = require.resolve('electron');
    require.cache[resolved] = {
        id: resolved,
        filename: resolved,
        loaded: true,
        exports: { app: { setLoginItemSettings: () => undefined }, safeStorage: fakeSafeStorage }
    } as unknown as NodeJS.Module;
};

test('groups, holiday schedule and dot rules', () => {
    assert.equal(calendarKindOf({ type: 0, owned: true }), 'own');
    assert.equal(calendarKindOf({ type: 0, owned: false }), 'shared');
    assert.equal(calendarKindOf({ type: 0, permissions: 112 }), 'shared', 'older client: no full permissions = shared with you');
    assert.equal(calendarKindOf({ type: 0, permissions: 127 }), 'own');
    assert.equal(calendarKindOf({}), 'own');
    assert.equal(calendarKindOf({ type: 1, owned: true }), 'subscribed');
    assert.equal(calendarKindOf({ type: 2 }), 'holidays');

    assert.equal(includesHolidays('login', '2026-10-03', '2026-10-03'), true, 'signing in syncs public holidays');
    assert.equal(includesHolidays('auto', '2026-10-03', '2026-10-03'), false, 'not again the same day');
    assert.equal(includesHolidays('auto', '2026-10-02', '2026-10-03'), true, 'once a day from midnight on');
    assert.equal(includesHolidays('refresh', '2026-10-02', '2026-10-03'), false, 'never by the Refresh button');
    assert.equal(localDayOf(new Date(2026, 9, 3, 23, 59)), '2026-10-03');
    assert.equal(msUntilLocalMidnight(new Date(2026, 9, 3, 23, 59, 0)), 60_000);

    const base = { removed: false, syncEnabled: true, connectionError: null, error: null, warning: null };
    assert.equal(calendarStatusOf(base).status, 'ok');
    assert.equal(calendarStatusOf({ ...base, warning: { message: 'Test mode: …', at: 1 } }).status, 'warning');
    assert.equal(calendarStatusOf({ ...base, error: { message: 'ETIMEDOUT', at: 1 }, warning: { message: 'x', at: 1 } }).message, 'Sync failed: ETIMEDOUT', 'red wins over yellow');
    assert.match(calendarStatusOf({ ...base, connectionError: { message: 'fetch failed', at: 1 } }).message!, /^No connection to Proton/);
    assert.equal(calendarStatusOf({ ...base, syncEnabled: false, error: { message: 'x', at: 1 } }).status, 'off');
    assert.equal(trayCalendarsStatusOf(['ok', 'warning'], true), 'warning-syncing', '0.45.2: yellow and syncing: the yellow turning symbol');
    assert.equal(trayCalendarsStatusOf(['ok', 'warning'], false), 'warning', 'yellow stays yellow once the sync ends');
    assert.equal(trayCalendarsStatusOf(['warning', 'error'], true), 'error', 'red wins, syncing or not');
    assert.equal(trayCalendarsStatusOf(['ok', 'off'], true), 'syncing');
    assert.equal(trayCalendarsStatusOf(['ok'], false), 'ok');
    assert.equal(trayCalendarsStatusOf(['warning', 'error'], false), 'error');
    assert.equal(calendarSlugOfPath('/calendars/neutron-calendar-bridge/tobi-work/abc.ics'), 'tobi-work');
    assert.equal(calendarSlugOfPath('/principals/neutron-calendar-bridge/'), null);
    assert.equal(isWarningWorthy('PUT', 403), true);
    assert.equal(isWarningWorthy('DELETE', 500), true);
    assert.equal(isWarningWorthy('PUT', 412), false, 'an outdated copy is reloaded silently');
    assert.equal(isWarningWorthy('REPORT', 500), false);
});

const remoteCalendars = [
    { id: 'priv', name: 'Tobi (Private)', color: '#6d4aff', visible: true, writable: true, type: 0, owned: true },
    { id: 'work', name: 'Tobi (Work)', color: '#10b981', visible: true, writable: true, type: 0, owned: true },
    { id: 'rug', name: 'Work RUG', color: '#dc3f63', visible: true, writable: false, readOnlyReason: 'subscribed calendar', type: 1, owned: true },
    { id: 'nl', name: 'Wettelijke feestdagen in Nederland', color: '#f59e0b', visible: true, writable: false, readOnlyReason: 'holidays calendar', type: 2 },
    { id: 'anna', name: "Anna's calendar", color: '#3b82f6', visible: true, writable: true, type: 0, owned: false }
];

const setup = async () => {
    stubElectron();
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { BridgeService } = require('../src/main/bridge-service') as typeof import('../src/main/bridge-service');
    const baseDir = mkdtempSync(join(tmpdir(), 'neutron-calendar-bridge-queue-'));
    const service = new BridgeService(baseDir) as any;
    await service.mirrorDatabase.initialize();
    service.localCaldavPassword = 'test';
    const synced: string[] = [];
    const gates = new Map<string, { promise: Promise<void>; release: () => void }>();
    const failing = new Map<string, Error>();
    let listCalendarsError: Error | null = null;
    const gate = (id: string) => {
        let release!: () => void;
        const promise = new Promise<void>((resolve) => (release = resolve));
        gates.set(id, { promise, release });
        return () => {
            gates.delete(id);
            release();
        };
    };
    service.protonAdapter = {
        isSignedIn: () => true,
        getSignedInUsername: () => 'tobi',
        supportsSeriesSync: () => true,
        listAddresses: () => [],
        listCalendars: async () => {
            if (listCalendarsError) throw listCalendarsError;
            return remoteCalendars;
        },
        listEvents: async (calendarId: string) => {
            synced.push(calendarId);
            await gates.get(calendarId)?.promise;
            const error = failing.get(calendarId);
            if (error) throw error;
            return [];
        }
    };
    let changes = 0;
    service.onStateChange = () => {
        changes += 1;
    };
    const views = async () => Object.fromEntries((await service.getBridgeState()).calendars.map((calendar: any) => [calendar.protonCalendarId, calendar]));
    const until = async (condition: () => boolean | Promise<boolean>) => {
        for (let i = 0; i < 200; i += 1) {
            if (await condition()) return;
            await new Promise((resolve) => setTimeout(resolve, 5));
        }
        throw new Error('timed out waiting');
    };
    const cleanup = async () => {
        service.stopPolling?.();
        await service.mirrorDatabase.close();
        rmSync(baseDir, { recursive: true, force: true });
    };
    return {
        service,
        synced,
        gate,
        failing,
        setListCalendarsError: (error: Error | null) => (listCalendarsError = error),
        views,
        until,
        changes: () => changes,
        cleanup
    };
};

test('passes: groups stored, public holidays only at sign-in and once a day, never by Refresh', async () => {
    const { service, synced, views, cleanup } = await setup();
    try {
        await service.syncNow('login');
        assert.deepEqual(synced.sort(), ['anna', 'nl', 'priv', 'rug', 'work'], 'signing in syncs everything');
        const calendars = await views();
        assert.equal(calendars.priv.kind, 'own');
        assert.equal(calendars.anna.kind, 'shared');
        assert.equal(calendars.rug.kind, 'subscribed');
        assert.equal(calendars.nl.kind, 'holidays');
        assert.ok(Object.values(calendars).every((calendar: any) => calendar.status === 'ok' && calendar.syncState === 'idle'));

        synced.length = 0;
        await service.syncNow('auto');
        assert.ok(!synced.includes('nl') && synced.includes('priv'), 'the regular sync leaves public holidays alone the same day');
        synced.length = 0;
        await service.syncNow('refresh');
        assert.ok(!synced.includes('nl') && synced.includes('rug'), 'Refresh leaves public holidays out');

        service.holidaysSyncedOn = '2000-01-01'; // a day has passed
        synced.length = 0;
        await service.syncNow('auto');
        assert.ok(synced.includes('nl'), 'the first regular sync of a new day includes them');
        synced.length = 0;
        await service.syncNow('auto');
        assert.ok(!synced.includes('nl'), 'and then not again that day');
        assert.equal(service.health, 'healthy');
    } finally {
        await cleanup();
    }
});

test('one calendar or a group on request, behind a running sync; a second click takes it off the queue', async () => {
    const { service, synced, gate, views, until, changes, cleanup } = await setup();
    try {
        await service.syncNow('login');
        synced.length = 0;
        const releasePriv = gate('priv');
        await service.syncCalendar('priv');
        await until(() => service.syncingCalendarId === 'priv');
        let calendars = await views();
        assert.equal(calendars.priv.syncState, 'syncing');

        await service.syncCalendar('work');
        await service.syncCalendar('rug');
        calendars = await views();
        assert.equal(calendars.work.syncState, 'queued');
        assert.equal(calendars.work.queuedManually, true);
        assert.equal(calendars.rug.syncState, 'queued');

        await service.syncCalendar('work'); // second click: off the queue
        assert.equal((await views()).work.syncState, 'idle');
        await service.syncCalendar('nl'); // a public holidays calendar, by hand: allowed
        assert.deepEqual(service.syncQueue.map((job: any) => job.calendarId), ['rug', 'nl'], 'added at the end of the queue');

        releasePriv();
        await until(() => !service.queueRunner);
        assert.deepEqual(synced, ['priv', 'rug', 'nl'], 'in order, without the calendar taken off the queue');
        await until(() => changes() > 0); // the window is told (throttled to every 150 ms)

        synced.length = 0;
        await service.syncCategory('own');
        await until(() => !service.queueRunner);
        assert.deepEqual(synced.sort(), ['priv', 'work'], 'a group: every ticked calendar in it');
        await assert.rejects(service.syncCategory('holidays'), /one calendar at a time/);

        // Calendars queued by the regular sync cannot be taken off the queue by a click.
        const releaseWork = gate('priv');
        const pass = service.syncNow('auto');
        await until(() => service.syncingCalendarId === 'priv');
        const queuedByPass = (await views()).work;
        assert.equal(queuedByPass.syncState, 'queued');
        assert.equal(queuedByPass.queuedManually, false);
        await service.syncCalendar('work');
        assert.equal((await views()).work.syncState, 'queued', 'still queued');
        releaseWork();
        await pass;

        // Unticking a queued calendar takes it off the queue.
        const releaseAgain = gate('priv');
        await service.syncCalendar('priv');
        await until(() => service.syncingCalendarId === 'priv');
        await service.syncCalendar('anna');
        await service.setCalendarSyncEnabled('anna', false);
        assert.ok(!service.syncQueue.some((job: any) => job.calendarId === 'anna'));
        assert.equal((await views()).anna.status, 'off');
        releaseAgain();
        await until(() => !service.queueRunner);
    } finally {
        await cleanup();
    }
});

test('red dots: a failing calendar (others go on) and no connection; they clear by themselves', async () => {
    const { service, failing, setListCalendarsError, views, cleanup } = await setup();
    try {
        failing.set('work', new Error('read ECONNRESET'));
        await service.syncNow('login');
        let calendars = await views();
        assert.equal(calendars.work.status, 'error');
        assert.match(calendars.work.statusMessage, /Sync failed: read ECONNRESET/);
        assert.ok(calendars.work.statusAt > 0);
        assert.equal(calendars.priv.status, 'ok', 'the other calendars still sync');
        assert.equal(service.getTrayState().calendars, 'error');
        assert.match(service.message, /sync failed for Tobi \(Work\)/);

        failing.delete('work');
        await service.syncNow('auto');
        assert.equal((await views()).work.status, 'ok', 'solved at the next sync');
        assert.equal(service.getTrayState().calendars, 'ok');

        setListCalendarsError(new Error('connect ETIMEDOUT 185.70.42.41:443'));
        await assert.rejects(service.syncNow('auto'));
        calendars = await views();
        assert.ok(Object.values(calendars).filter((calendar: any) => calendar.syncEnabled).every((calendar: any) => calendar.status === 'error'));
        assert.match(calendars.priv.statusMessage, /No connection to Proton: connect ETIMEDOUT/);
        assert.equal(service.getTrayState().calendars, 'error');
        setListCalendarsError(null);
        await service.syncNow('auto');
        assert.equal((await views()).priv.status, 'ok');
    } finally {
        await cleanup();
    }
});

test('yellow dots: a refused change stays until the calendar is synced by hand (dry run: next healthy sync)', async () => {
    const { service, views, until, cleanup } = await setup();
    try {
        await service.syncNow('login');
        const slug = (await views()).work.slug;
        service.recordCalDAVError({ at: 1_790_000_000_000, method: 'PUT', path: `/calendars/neutron-calendar-bridge/${slug}/x.ics`, status: 403, message: 'Test mode: t.j.jansen@uni.invalid is not on the allowlist.' });
        service.recordCalDAVError({ at: 1_790_000_000_000, method: 'PUT', path: `/calendars/neutron-calendar-bridge/${(await views()).priv.slug}/y.ics`, status: 412, message: 'outdated' });
        await until(async () => (await views()).work.status === 'warning');
        const calendars = await views();
        assert.match(calendars.work.statusMessage, /uni\.invalid is not on the allowlist/);
        assert.equal(calendars.priv.status, 'ok', 'an outdated copy (412) is no problem');
        assert.equal(service.getTrayState().calendars, 'warning');

        await service.syncNow('auto');
        assert.equal((await views()).work.status, 'warning', 'the regular sync does not clear it');
        await service.syncCalendar('priv');
        await until(() => !service.queueRunner);
        assert.equal((await views()).work.status, 'warning', 'syncing another calendar does not either');
        await service.syncCalendar('work');
        await until(() => !service.queueRunner);
        assert.equal((await views()).work.status, 'ok', 'syncing it by hand does');
        assert.equal(service.getTrayState().calendars, 'ok');

        service.recordCalDAVError({ at: 1, method: 'DELETE', path: `/calendars/neutron-calendar-bridge/${slug}/x.ics`, status: 403, message: 'refused' });
        await until(async () => (await views()).work.status === 'warning');
        await service.syncNow('refresh');
        assert.equal((await views()).work.status, 'ok', 'the Refresh button clears it too');

        await service.updateConfig({ developerMode: true, invitationEmailMode: 'dry-run' }); // 0.32.3: a developer option
        service.recordCalDAVError({ at: 1, method: 'PUT', path: `/calendars/neutron-calendar-bridge/${slug}/x.ics`, status: 403, message: 'Dry run: …' });
        await until(async () => (await views()).work.status === 'warning');
        await service.syncNow('auto');
        assert.equal((await views()).work.status, 'ok', 'in a dry run the next healthy automatic sync clears it');
    } finally {
        await cleanup();
    }
});

test('review fixes: nothing left stranded on the queue, one pass at a time, holidays retried, stale dots dropped, ctag kept', async () => {
    const { service, synced, gate, failing, views, until, cleanup } = await setup();
    try {
        await service.syncNow('login');

        // A calendar queued while the runner is finishing is still synced.
        const original = service.updateHealthAfterSync.bind(service);
        let injected = false;
        service.updateHealthAfterSync = async (...args: any[]) => {
            if (!injected) {
                injected = true;
                service.enqueue('work', { manual: true, clearsWarnings: true });
                void service.drainQueue();
            }
            return original(...args);
        };
        synced.length = 0;
        await service.syncCalendar('priv');
        await until(() => !service.queueRunner && !service.syncQueue.length);
        assert.deepEqual(synced, ['priv', 'work'], 'queued while finishing: synced too');
        service.updateHealthAfterSync = original;

        // Two passes never run at once.
        let running = 0;
        let most = 0;
        const list = service.protonAdapter.listCalendars;
        service.protonAdapter.listCalendars = async () => {
            running += 1;
            most = Math.max(most, running);
            await new Promise((resolve) => setTimeout(resolve, 20));
            running -= 1;
            return list();
        };
        await Promise.all([service.syncNow('auto'), service.syncNow('refresh'), service.syncNow('login')]);
        assert.equal(most, 1, 'one pass at a time');
        service.protonAdapter.listCalendars = list;

        // A public holidays sync that fails is tried again by the next regular sync, not only tomorrow.
        service.holidaysSyncedOn = '2000-01-01';
        failing.set('nl', new Error('getaddrinfo ENOTFOUND'));
        await service.syncNow('auto');
        assert.equal((await views()).nl.status, 'error');
        failing.delete('nl');
        synced.length = 0;
        await service.syncNow('auto');
        assert.ok(synced.includes('nl'), 'retried');
        assert.equal((await views()).nl.status, 'ok');

        // A refusal while the calendar syncs by hand stays yellow (it is newer than that sync).
        const slug = (await views()).work.slug;
        const release = gate('work');
        await service.syncCalendar('work');
        await until(() => service.syncingCalendarId === 'work');
        await new Promise((resolve) => setTimeout(resolve, 2));
        service.recordCalDAVError({ at: Date.now(), method: 'PUT', path: `/calendars/neutron-calendar-bridge/${slug}/z.ics`, status: 403, message: 'refused meanwhile' });
        await until(async () => (await views()).work.status === 'warning');
        release();
        await until(() => !service.queueRunner);
        assert.equal((await views()).work.status, 'warning', 'not cleared by the sync that was already running');

        // A calendar removed in Proton no longer counts for the menu's dot.
        failing.set('anna', new Error('boom'));
        await service.syncNow('auto');
        assert.equal(service.getTrayState().calendars, 'error');
        const without = remoteCalendars.filter((calendar) => calendar.id !== 'anna');
        service.protonAdapter.listCalendars = async () => without;
        await service.syncCalendar('work'); // clears work's yellow
        await until(() => !service.queueRunner);
        await service.syncNow('auto');
        assert.equal(service.getTrayState().calendars, 'ok', 'its red dot is gone with it');
        service.protonAdapter.listCalendars = list;

        // The pass's calendar details do not undo a sync's new ctag.
        const before = (await service.mirrorDatabase.getCalendarBySlug(slug)).ctag;
        await service.mirrorDatabase.recordCalendarPoll('work', true);
        const bumped = (await service.mirrorDatabase.getCalendarBySlug(slug)).ctag;
        assert.notEqual(bumped, before);
        await service.reconcileCalendars(remoteCalendars);
        assert.equal((await service.mirrorDatabase.getCalendarBySlug(slug)).ctag, bumped, 'kept');
    } finally {
        await cleanup();
    }
});

test('0.46: the menu phase: blue until the first pass of this run went through, then ready; why it is not connected', async () => {
    const { service, gate, cleanup } = await setup();
    try {
        assert.equal(service.getTrayState().phase, 'first-sync', 'signed in, nothing synced yet this run');
        assert.equal((await service.getBridgeState()).verifiedThisRun, false);
        const release = gate('work');
        const pass = service.syncNow('login');
        assert.equal(service.getTrayState().phase, 'first-sync');
        release();
        await pass;
        assert.equal(service.getTrayState().phase, 'ready');
        assert.equal((await service.getBridgeState()).verifiedThisRun, true);

        service.outage = { since: Date.now(), awakeMs: 0, lastCheckAt: Date.now(), notified: false };
        assert.equal(service.getTrayState().phase, 'offline');
        service.outage = null;
        service.slowDownUntil = Date.now() + 60_000;
        assert.equal(service.getTrayState().phase, 'limited');
        service.slowDownUntil = 0;

        service.protonAdapter.isSignedIn = () => false;
        service.health = 'disconnected';
        assert.equal(service.getTrayState().phase, 'connecting', 'still restoring the login at start');
        service.starting = false;
        assert.equal(service.getTrayState().phase, 'signed-out');
        service.pendingSignIn = { username: 'tobi', password: '' };
        assert.equal(service.getTrayState().phase, 'offline', 'offline at start: signing in once Proton answers');
        service.pendingSignIn = null;
        service.pendingHumanVerification = { token: 'x', methods: ['captcha'] };
        assert.equal(service.getTrayState().phase, 'verification');
    } finally {
        service.pendingHumanVerification = null;
        await cleanup();
    }
});

test('0.48: ticking and unticking calendars does not wait for a running sync', async () => {
    const { service, gate, views, until, cleanup } = await setup();
    try {
        await service.syncNow('login');
        const release = gate('priv');
        await service.syncCalendar('priv');
        await until(() => service.syncingCalendarId === 'priv');
        const quick = async (promise: Promise<unknown>) => Promise.race([promise.then(() => 'answered'), new Promise((resolve) => setTimeout(() => resolve('waited'), 300))]);

        await service.setCalendarSyncEnabled('anna', false);
        assert.equal(await quick(service.setCalendarSyncEnabled('anna', true)), 'answered', 'ticking answers at once (its sync is queued)');
        assert.ok(service.syncQueue.some((job: any) => job.calendarId === 'anna'), 'and queued behind the running one');
        assert.equal(await quick(service.setCalendarSyncEnabled('priv', false)), 'answered', 'unticking the very calendar that syncs answers at once too');
        assert.equal((await views()).priv.status, 'off');
        assert.equal(service.syncingCalendarId, 'priv', 'its sync still runs; its copy is cleared once it ends');

        release();
        await service.calendarClearing;
        await until(() => !service.queueRunner);
    } finally {
        await cleanup();
    }
});
