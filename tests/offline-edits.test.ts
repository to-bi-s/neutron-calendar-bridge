/**
 * Offline edits (0.35, stage 11): a change from Calendar.app that cannot reach Proton is taken into
 * the local copy and kept in the outbox; sync passes leave such rows alone; once Proton answers again
 * the changes are sent in order, a refused one is undone here and reported.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { SyncedCalendarEvent } from 'proton-calendar-client';

import { isUnreachableFailure } from '../src/main/bridge-service';
import { fakeSafeStorage } from './support/fake-safe-storage';

const stubElectron = () => {
    const resolved = require.resolve('electron');
    require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: { app: { setLoginItemSettings: () => undefined }, safeStorage: fakeSafeStorage } } as unknown as NodeJS.Module;
};

const TZ = 'Europe/Amsterdam';

test('what counts as "Proton could not be reached"', () => {
    assert.equal(isUnreachableFailure(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } })), true);
    assert.equal(isUnreachableFailure(new Error('Failed to create Proton event: fetch failed')), true);
    assert.equal(isUnreachableFailure(new Error('getaddrinfo ENOTFOUND calendar-api.proton.me')), true);
    assert.equal(isUnreachableFailure(new Error('Proton API POST calendar/v1/x/events/sync failed (503)')), true);
    assert.equal(isUnreachableFailure(Object.assign(new Error('Service unavailable'), { status: 502 })), true);
    assert.equal(isUnreachableFailure(new Error('Event does not exist')), false);
    assert.equal(isUnreachableFailure(new Error('Recurring events are read-only')), false);
    assert.equal(isUnreachableFailure(Object.assign(new Error('slow'), { name: 'RateLimitedError' })), false);
    assert.equal(isUnreachableFailure(Object.assign(new Error('ended'), { name: 'SessionExpiredError' })), false);
    assert.equal(isUnreachableFailure(Object.assign(new Error('nope'), { status: 403 })), false);
});

const setup = async () => {
    stubElectron();
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { BridgeService } = require('../src/main/bridge-service') as typeof import('../src/main/bridge-service');
    const baseDir = mkdtempSync(join(tmpdir(), 'neutron-calendar-bridge-offline-'));
    const service = new BridgeService(baseDir) as any;
    await service.mirrorDatabase.initialize();
    await service.loadPendingUids();
    service.localCaldavPassword = 'test';
    service.configStore.update({ notifications: true });
    const calendar = { protonCalendarId: 'private', slug: 'tobi-private', displayName: 'Tobi (Private)', color: '#123456', description: '', visible: true, removed: false, ctag: '1', lastPolledAt: null, lastSyncedAt: null };
    await service.mirrorDatabase.upsertCalendar(calendar);
    const client = await import('proton-calendar-client');
    const api = new client.ProtonCalendarAPI({ username: 'u', password: 'p' });
    const at = (day: number, hours: number) => ({ value: { year: 2026, month: 10, day, hours, minutes: 0, seconds: 0, isUTC: false }, parameters: { tzid: TZ } });
    const remote: SyncedCalendarEvent[] = [
        {
            calendarId: 'private',
            eventId: 'ev-dentist',
            uid: 'dentist@proton.me',
            title: 'Dentist',
            description: '',
            location: '',
            startTimestamp: Date.UTC(2026, 9, 5, 8) / 1000,
            endTimestamp: Date.UTC(2026, 9, 5, 9) / 1000,
            timezone: TZ,
            isAllDay: false,
            modifiedTimestamp: 1_790_000_000,
            contentHash: 'x',
            decrypted: { vevent: { dtstart: at(5, 10), dtend: at(5, 11) } } as any
        } as any
    ];
    const state = { online: true, refuse: null as string | null };
    const writes: Array<[string, ...unknown[]]> = [];
    const notifications: unknown[] = [];
    service.onNotify = (notification: unknown) => notifications.push(notification);
    const offline = () => ({ success: false, error: 'fetch failed' });
    service.protonAdapter = {
        isSignedIn: () => true,
        getSignedInUsername: () => 'tobi@proton.me',
        supportsSeriesSync: () => true,
        supportsInvitations: () => true,
        supportsOrganizing: () => true,
        supportsReminders: () => false,
        parseIcs: (text: string) => api.parseIcsToVevents(text),
        listAddresses: () => [{ email: 'tobi@proton.me', displayName: 'Tobi', active: true, order: 1 }],
        listEvents: async () => {
            if (!state.online) throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } });
            return remote;
        },
        createEvent: async (_calendarId: string, eventData: any) => {
            if (!state.online) return offline();
            writes.push(['create', eventData.title]);
            return state.refuse ? { success: false, error: state.refuse } : { success: true, id: `new-${writes.length}` };
        },
        updateEvent: async (_calendarId: string, eventId: string, eventData: any) => {
            if (!state.online) return offline();
            writes.push(['update', eventId, eventData.title]);
            return state.refuse ? { success: false, error: state.refuse } : { success: true };
        },
        deleteEvent: async (_calendarId: string, eventId: string) => {
            if (!state.online) return offline();
            writes.push(['delete', eventId]);
            return state.refuse ? { success: false, error: state.refuse } : { success: true };
        },
        syncSeries: async () => {
            if (!state.online) return { success: false, error: 'fetch failed', eventIds: [] };
            writes.push(['syncSeries']);
            return { success: true, eventIds: ['s-1'] };
        }
    };
    service.refreshAccountAddresses();
    await service.syncEventsForCalendar(calendar);
    const ics = (uid: string, title: string, extra: string[] = []) =>
        `${['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Apple Inc.//macOS 26.0//EN', 'BEGIN:VEVENT', `UID:${uid}`, 'DTSTAMP:20261001T000000Z', `DTSTART;TZID=${TZ}:20261006T100000`, `DTEND;TZID=${TZ}:20261006T110000`, `SUMMARY:${title}`, ...extra, 'END:VEVENT', 'END:VCALENDAR'].join('\r\n')}\r\n`;
    const put = (uid: string, text: string) => service.upsertLocalEvent('tobi-private', `${encodeURIComponent(uid)}.ics`, `/calendars/u/tobi-private/${encodeURIComponent(uid)}.ics`, text);
    const row = (uid: string) => service.mirrorDatabase.getEventByUid('private', uid);
    const outbox = () => service.mirrorDatabase.listOutbox();
    return {
        service,
        calendar,
        state,
        writes,
        notifications,
        ics,
        put,
        row,
        outbox,
        cleanup: async () => {
            await service.mirrorDatabase.close();
            rmSync(baseDir, { recursive: true, force: true });
        }
    };
};

test('offline: saves and deletions from Calendar.app are kept locally and in the outbox; sync passes leave them alone', async () => {
    const { service, calendar, state, writes, ics, put, row, outbox, cleanup } = await setup();
    try {
        state.online = false;
        // A new event: taken in with an ETag, nothing written to Proton.
        const made = await put('new@proton.me', ics('new@proton.me', 'Planning'));
        assert.match(made.etag, /^"[0-9a-f]+"$/);
        assert.equal(writes.length, 0);
        assert.equal((await row('new@proton.me')).title, 'Planning');
        assert.equal((await row('new@proton.me')).protonEventId, 'pending:new@proton.me');
        let items = await outbox();
        assert.equal(items.length, 1);
        assert.deepEqual([items[0].kind, items[0].uid, items[0].snapshot], ['put', 'new@proton.me', null]);
        assert.equal((await service.getBridgeState()).pendingChanges, 1);
        assert.match(service.calendarWarnings.get('private')?.message ?? '', /1 change waits for Proton/);
        // Served to Calendar.app like any other event.
        assert.ok((await service.listEventsForSlug('tobi-private')).some((event: any) => event.uid === 'new@proton.me'));

        // A second save of it: one waiting change, the newer ICS.
        await put('new@proton.me', ics('new@proton.me', 'Planning (renamed)'));
        items = await outbox();
        assert.equal(items.length, 1);
        assert.match(items[0].ics ?? '', /SUMMARY:Planning \(renamed\)/);
        assert.equal((await row('new@proton.me')).title, 'Planning (renamed)');

        // An existing event edited: the snapshot is the row Proton gave us.
        const before = await row('dentist@proton.me');
        await put('dentist@proton.me', ics('dentist@proton.me', 'Dentist (moved)'));
        items = await outbox();
        assert.equal(items.length, 2);
        assert.equal(items[1].snapshot?.title, 'Dentist');
        assert.equal(items[1].snapshot?.protonEventId, 'ev-dentist');
        assert.equal((await row('dentist@proton.me')).title, 'Dentist (moved)');
        assert.equal((await row('dentist@proton.me')).protonEventId, 'ev-dentist');
        assert.equal((await service.getBridgeState()).pendingChanges, 2);

        // A sync pass meanwhile (Proton reachable for reads, say): the waiting rows are neither overwritten nor "missing".
        state.online = true;
        await service.listCalendarInFull(calendar);
        assert.equal((await row('dentist@proton.me')).title, 'Dentist (moved)', 'not overwritten with Proton\'s older version');
        assert.equal((await row('new@proton.me')).deleted, false, 'not marked deleted although Proton does not have it');
        state.online = false;

        // Deleting the never-sent event: both gone, nothing for Proton.
        await service.deleteLocalEvent('tobi-private', 'new@proton.me');
        assert.equal(await row('new@proton.me'), null);
        items = await outbox();
        assert.equal(items.length, 1);
        // Deleting the edited existing event: a deletion waits, with the original snapshot.
        await service.deleteLocalEvent('tobi-private', 'dentist@proton.me');
        assert.equal((await row('dentist@proton.me')).deleted, true);
        items = await outbox();
        assert.deepEqual([items[0].kind, items[0].snapshot?.title], ['delete', 'Dentist']);
        assert.equal(before.title, 'Dentist');

        // Proton back: the deletion is sent, the outbox is empty, the dot is clear.
        state.online = true;
        await service.flushOutbox();
        assert.deepEqual(writes, [['delete', 'ev-dentist']]);
        assert.equal((await outbox()).length, 0);
        assert.equal((await service.getBridgeState()).pendingChanges, 0);
        assert.equal(service.calendarWarnings.has('private'), false);
        assert.equal((await row('dentist@proton.me')).deleted, true);
    } finally {
        await cleanup();
    }
});

test('back online: waiting changes are sent in order; one Proton refuses is undone here and reported; no answer keeps them waiting', async () => {
    const { service, state, writes, notifications, ics, put, row, outbox, cleanup } = await setup();
    try {
        state.online = false;
        await put('a@proton.me', ics('a@proton.me', 'First'));
        await put('dentist@proton.me', ics('dentist@proton.me', 'Dentist (moved)'));
        await put('b@proton.me', ics('b@proton.me', 'Third'));
        assert.equal((await outbox()).length, 3);

        // Still no Proton at the first try: everything stays, the local versions too.
        await service.flushOutbox();
        assert.equal((await outbox()).length, 3);
        assert.equal((await row('a@proton.me')).title, 'First');
        assert.equal((await row('dentist@proton.me')).title, 'Dentist (moved)');
        assert.equal((await outbox())[0].attempts, 1);

        // Proton back, but it refuses the dentist's change: that one is undone, the others go through, in order.
        state.online = true;
        service.protonAdapter.updateEvent = async (_c: string, eventId: string, eventData: any) => {
            writes.push(['update', eventId, eventData.title]);
            return { success: false, error: 'Event does not exist' };
        };
        await service.flushOutbox();
        assert.deepEqual(writes, [['create', 'First'], ['update', 'ev-dentist', 'Dentist (moved)'], ['create', 'Third']]);
        assert.equal((await outbox()).length, 0);
        assert.equal((await row('a@proton.me')).protonEventId, 'new-1', 'a real Proton ID now');
        assert.equal((await row('b@proton.me')).protonEventId, 'new-3');
        assert.equal((await row('dentist@proton.me')).title, 'Dentist', 'Proton\'s version is back');
        assert.equal((await service.getBridgeState()).pendingChanges, 0);
        const reported = (await service.getBridgeState()).recentCalDAVErrors[0];
        assert.equal(reported.status, 403);
        assert.match(reported.message, /refused now that it is back.*Event does not exist/);
        assert.ok(notifications.some((entry: any) => /Change not saved/.test(entry.title)), JSON.stringify(notifications));
        // Calendar.app re-reads: the calendar's ctag moved on.
        assert.notEqual((await service.mirrorDatabase.getCalendarBySlug('tobi-private')).ctag, '1');
    } finally {
        await cleanup();
    }
});

test('online again by itself: a save that works sends what waited; refusals are not queued, changes during a slow-down are (0.40)', async () => {
    const { service, state, writes, ics, put, outbox, cleanup } = await setup();
    try {
        state.online = false;
        await put('a@proton.me', ics('a@proton.me', 'First'));
        assert.equal((await outbox()).length, 1);
        state.online = true;
        await put('c@proton.me', ics('c@proton.me', 'Online again'));
        await new Promise((resolve) => setTimeout(resolve, 50)); // the flush runs in the background
        assert.deepEqual(writes.map((entry) => entry[1]), ['Online again', 'First']);
        assert.equal((await outbox()).length, 0);

        // A refusal while online is a refusal (403 to Calendar.app), not something to keep.
        state.refuse = 'Event does not exist';
        await assert.rejects(put('dentist@proton.me', ics('dentist@proton.me', 'x')), /Event does not exist/);
        assert.equal((await outbox()).length, 0);
        state.refuse = null;
        // 0.40: a change made during a slow-down waits in the outbox (nothing of it was sent) …
        service.slowDownUntil = Date.now() + 60_000;
        await put('dentist@proton.me', ics('dentist@proton.me', 'y'));
        assert.equal((await outbox()).length, 1, 'kept for after the pause');
        assert.ok(!writes.some((entry) => entry.includes('y')), 'not sent during the pause');
        // … unless it comes from an outdated copy: refused now (412) instead of overwriting a newer version later.
        const stale = service.upsertLocalEvent('tobi-private', 'dentist%40proton.me.ics', '/calendars/u/tobi-private/dentist%40proton.me.ics', ics('dentist@proton.me', 'stale'), { ifMatch: '"not-the-current-etag"' });
        await assert.rejects(stale, (error: any) => error.name === 'StaleEventError');
        assert.equal((await outbox()).length, 1, 'the outdated save was not kept');
        // The current copy (its ETag) is kept as usual.
        const current = await service.mirrorDatabase.getEventByUid('private', 'dentist@proton.me');
        await service.upsertLocalEvent('tobi-private', 'dentist%40proton.me.ics', '/calendars/u/tobi-private/dentist%40proton.me.ics', ics('dentist@proton.me', 'y'), { ifMatch: `"${current.etag}"` });
        assert.equal((await outbox()).length, 1, 'the same waiting change, replaced');
        // 0.41: a copy older only in what Proton does not store (the version a sync replaced without a real
        // change) is not outdated — the same leeway as a live save.
        const before = await service.mirrorDatabase.getEventByUid('private', 'dentist@proton.me');
        service.rememberReplacedVersion('private', before);
        await service.mirrorDatabase.upsertEvent({ ...before, etag: '"resynced"', contentHash: 'resynced' });
        await service.upsertLocalEvent('tobi-private', 'dentist%40proton.me.ics', '/calendars/u/tobi-private/dentist%40proton.me.ics', ics('dentist@proton.me', 'y2'), { ifMatch: before.etag });
        assert.equal((await outbox()).length, 1, 'kept (replacing the waiting change), not refused');
        // … but not while Proton refuses the app version (a pause with its own text: an update is needed first).
        service.slowDownText = 'Proton no longer accepts this version';
        await assert.rejects(put('e@proton.me', ics('e@proton.me', 'z')), (error: any) => error.name === 'RateLimitedError');
        // A slow-down reported meanwhile (a write that was under way) does not turn that refusal into a pause to queue behind.
        service.noteSlowDown(Object.assign(new Error('slow'), { name: 'RateLimitedError', retryAt: Date.now() + 90_000 }));
        assert.equal(service.slowDownText, 'Proton no longer accepts this version');
        await assert.rejects(put('e@proton.me', ics('e@proton.me', 'z')), (error: any) => error.name === 'RateLimitedError');
        assert.equal((await outbox()).length, 1);
        service.slowDownText = null;
        // After the pause, the next save that works sends what waited.
        service.slowDownUntil = 0;
        await put('f@proton.me', ics('f@proton.me', 'After the pause'));
        await new Promise((resolve) => setTimeout(resolve, 50));
        assert.ok(writes.some((entry) => entry.includes('y2')), 'sent after the pause (the latest waiting version)');
        assert.equal((await outbox()).length, 0);
    } finally {
        await cleanup();
    }
});

test('a live save while an earlier change still waits joins the outbox (the replay cannot overtake it); waits also for slow-downs during the replay', async () => {
    const { service, state, writes, ics, put, row, outbox, cleanup } = await setup();
    try {
        state.online = false;
        await put('a@proton.me', ics('a@proton.me', 'First'));
        await put('dentist@proton.me', ics('dentist@proton.me', 'Dentist (moved)'));
        state.online = true;
        // Proton is back, but before the flush ran Calendar.app saves both again: no live write, the outbox takes the newer versions.
        service.flushOutbox = async () => undefined; // hold the flush
        await put('a@proton.me', ics('a@proton.me', 'First, newer'));
        await put('dentist@proton.me', ics('dentist@proton.me', 'Dentist (moved again)'));
        assert.deepEqual(writes, [], 'no live write overtaken by a stale replay');
        const items = await outbox();
        assert.equal(items.length, 2);
        assert.match(items[0].ics ?? '', /First, newer/);
        assert.equal(items[1].snapshot?.title, 'Dentist', 'the first snapshot stays');
        // And a deletion of the never-sent one withdraws it altogether.
        await service.deleteLocalEvent('tobi-private', 'a@proton.me');
        assert.equal((await outbox()).length, 1);
        assert.equal(await row('a@proton.me'), null);
        delete service.flushOutbox;

        // The replay meets a slow-down: the change keeps waiting, the local version stays.
        service.protonAdapter.updateEvent = async () => {
            throw Object.assign(new Error('slow down'), { name: 'RateLimitedError', retryAt: Date.now() + 1000 });
        };
        await service.flushOutbox();
        assert.equal((await outbox()).length, 1);
        assert.equal((await row('dentist@proton.me')).title, 'Dentist (moved again)');
        assert.equal((await service.getBridgeState()).recentCalDAVErrors.length, 0, 'not reported as refused');
        service.slowDownUntil = 0;
        service.protonAdapter.updateEvent = async (_c: string, eventId: string, eventData: any) => {
            writes.push(['update', eventId, eventData.title]);
            return { success: true };
        };
        await service.flushOutbox();
        assert.deepEqual(writes, [['update', 'ev-dentist', 'Dentist (moved again)']]);
        assert.equal((await outbox()).length, 0);
    } finally {
        await cleanup();
    }
});

test('an invitation that was emailed but not saved is not queued (a replay would email again); the outbox dot gives way to a refusal and clears', async () => {
    const { service, state, ics, put, outbox, cleanup } = await setup();
    try {
        const { InvitationNotSupportedError } = await import('../src/main/recurrence');
        service.upsertLocalEventUnlocked = async () => {
            throw new InvitationNotSupportedError('Your guests were emailed, but Proton did not save the change (fetch failed). Save it again in a few minutes.');
        };
        await assert.rejects(put('m@proton.me', ics('m@proton.me', 'Meeting')), /guests were emailed/);
        assert.equal((await outbox()).length, 0);
        delete service.upsertLocalEventUnlocked;

        state.online = false;
        await put('a@proton.me', ics('a@proton.me', 'First'));
        assert.match(service.calendarWarnings.get('private').message, /1 change waits/);
        // A refusal's warning says more and is kept while others wait; once all are sent, the outbox's own dot goes.
        service.recordCalDAVError({ at: Date.now(), method: 'PUT', path: '/calendars/u/tobi-private/x.ics', status: 403, message: 'refused: x' });
        await new Promise((resolve) => setTimeout(resolve, 20));
        await put('b@proton.me', ics('b@proton.me', 'Second'));
        assert.match(service.calendarWarnings.get('private').message, /refused: x/);
        state.online = true;
        await service.flushOutbox();
        assert.equal((await outbox()).length, 0);
        assert.match(service.calendarWarnings.get('private').message, /refused: x/, 'the refusal stays until a manual sync clears warnings');
    } finally {
        await cleanup();
    }
});

test('0.42.1: while Proton is known to be out of reach, saves and deletions go straight to the outbox (no attempt that would only time out)', async () => {
    const { service, writes, ics, put, row, outbox, cleanup } = await setup();
    try {
        const tried: string[] = [];
        const adapter = service.protonAdapter;
        for (const name of ['createEvent', 'updateEvent', 'deleteEvent', 'syncSeries']) {
            const original = adapter[name];
            adapter[name] = async (...args: unknown[]) => {
                tried.push(name);
                return original(...args);
            };
        }
        service.outage = { since: Date.now(), awakeMs: 0, lastCheckAt: Date.now(), notified: false };
        await put('quick@proton.me', ics('quick@proton.me', 'Quick'));
        await put('dentist@proton.me', ics('dentist@proton.me', 'Dentist (moved)'));
        await service.deleteLocalEvent('tobi-private', 'dentist@proton.me');
        assert.deepEqual(tried, [], 'nothing sent while Proton is known to be away');
        assert.equal((await row('quick@proton.me')).title, 'Quick');
        assert.equal((await row('dentist@proton.me')).deleted, true);
        assert.deepEqual((await outbox()).map((item: any) => item.kind), ['put', 'delete']);
        // The outage over: sent as usual.
        service.outage = null;
        await service.flushOutbox();
        assert.equal((await outbox()).length, 0);
        assert.deepEqual(writes.map((entry) => entry[0]), ['create', 'delete']);
    } finally {
        await cleanup();
    }
});
