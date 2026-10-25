/**
 * Stage 5 (0.26), efficient sync: Proton's change feeds instead of listing everything each pass,
 * the adaptive cadence and the numbers in Developer settings. The client is a fake with feeds.
 * Checks:
 * - a full pass (sign-in, Refresh, the first of a day, no cursor, Proton's Refresh flag) lists and
 *   compares; the cursors are taken before listing and kept;
 * - a changes pass asks the account feed and each calendar's feed only; a change re-reads just
 *   that series (by UID) and the row is created, changed or marked deleted; a deleted occurrence
 *   rebuilds its series; an event outside the window is left alone; a lost cursor lists again;
 * - the calendar list is read only when the account feed says so (a new calendar is listed in
 *   full), the mailbox only when mail arrived or a pass is full;
 * - a click on a calendar lists it in full; an older client is listed in full every pass;
 * - the cadence rule and the statistics (pass kind, requests, decryptions, feeds, cadence).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { QUIET_AFTER_MS, QUIET_INTERVAL_MS, localDayOf, nextSyncDelayMs } from '../src/main/sync-schedule';
import { touchesWindow } from '../src/main/bridge-service';
import { fakeSafeStorage } from './support/fake-safe-storage';

const stubElectron = () => {
    const resolved = require.resolve('electron');
    require.cache[resolved] = {
        id: resolved,
        filename: resolved,
        loaded: true,
        exports: { app: { setLoginItemSettings: () => undefined }, safeStorage: fakeSafeStorage }
    } as unknown as NodeJS.Module;
};

const DAY = 86_400;
const now = () => Math.floor(Date.now() / 1000);

/** A Proton event as the client lists it (no decrypted part needed for the mirror row). */
const remoteEvent = (calendarId: string, eventId: string, uid: string, extra: Record<string, unknown> = {}) => ({
    calendarId,
    eventId,
    uid,
    title: `Event ${eventId}`,
    description: '',
    location: '',
    startTimestamp: now() + 3 * DAY,
    endTimestamp: now() + 3 * DAY + 3600,
    timezone: 'UTC',
    isAllDay: false,
    modifiedTimestamp: 1_790_000_000,
    contentHash: `${eventId}-v1`,
    raw: { ID: eventId, UID: uid, RRule: null, RecurrenceID: null },
    ...extra
});

const stubOf = (event: any) => ({
    id: event.eventId,
    uid: event.uid,
    calendarId: event.calendarId,
    startTime: event.startTimestamp,
    endTime: event.endTimestamp,
    rrule: event.raw?.RRule ?? null,
    recurrenceId: event.raw?.RecurrenceID ?? null,
    modifyTime: event.modifiedTimestamp
});

const setup = async ({ feed = true } = {}) => {
    stubElectron();
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { BridgeService } = require('../src/main/bridge-service') as typeof import('../src/main/bridge-service');
    const baseDir = mkdtempSync(join(tmpdir(), 'neutron-calendar-bridge-feed-'));
    const service = new BridgeService(baseDir) as any;
    await service.mirrorDatabase.initialize();
    service.localCaldavPassword = 'test';
    service.configStore.update({ calendarEmailsAfter: 'trash', developerMode: true, eventLookbackDays: 30, eventLookaheadDays: 60 });

    const calls: string[] = [];
    let calendars = [
        { id: 'priv', name: 'Tobi (Private)', color: '#6d4aff', visible: true, writable: true, type: 0, owned: true },
        { id: 'work', name: 'Tobi (Work)', color: '#10b981', visible: true, writable: true, type: 0, owned: true }
    ];
    /** What Proton holds, by calendar: the events, and the feed pages queued for the next ask. */
    const proton: Record<string, { events: any[]; cursor: number; pending: any[] }> = {
        priv: { events: [], cursor: 0, pending: [] },
        work: { events: [], cursor: 0, pending: [] }
    };
    let accountCursor = 0;
    let accountPending: any[] = [];
    let requests = 0;
    let decrypted = 0;
    const mailResults: any[] = [];
    const fake: any = {
        isSignedIn: () => true,
        getSignedInUsername: () => 'tobi',
        supportsSeriesSync: () => true,
        supportsCalendarEmails: () => true,
        listAddresses: () => [],
        getRequestStats: () => ({ since: 0, requests, lastHour: requests, answers: {}, retries: 0, rateLimited: 0, lastRateLimit: null, pausedUntil: null, signIns: 1, sessionRenewals: 0, resumedSession: false }),
        getDecryptStats: () => ({ decrypted, reused: 0, cached: 0 }),
        listCalendars: async () => {
            calls.push('listCalendars');
            requests += 1;
            return calendars;
        },
        listEvents: async (calendarId: string) => {
            calls.push(`listEvents:${calendarId}`);
            requests += 1;
            decrypted += proton[calendarId].events.length;
            return proton[calendarId].events;
        },
        listEventsByUid: async (calendarId: string, uid: string) => {
            calls.push(`listEventsByUid:${calendarId}:${uid}`);
            requests += 1;
            const events = proton[calendarId].events.filter((event) => event.uid === uid);
            decrypted += events.length;
            return events;
        },
        fileCalendarEmails: async () => {
            calls.push('fileCalendarEmails');
            requests += 1;
            const next = mailResults.shift();
            if (next instanceof Error) throw next;
            return { filed: [], left: [], waiting: 0, leftCount: 0, wouldMove: 0, opened: 0, checked: 0, ...(next ?? {}) };
        },
        signOut: async () => undefined
    };
    if (feed) {
        fake.supportsChangeFeed = () => true;
        fake.getCalendarChanges = async (calendarId: string, cursor: string | null) => {
            calls.push(`getCalendarChanges:${calendarId}:${cursor ?? 'latest'}`);
            requests += 1;
            const state = proton[calendarId];
            const result = { calendarId, cursor: `${calendarId}-${state.cursor}`, started: Boolean(cursor), refresh: false, changed: [] as any[], deleted: [] as string[], keysChanged: false, requests: 1 };
            if (cursor === null) {
                state.pending = []; // the cursor is "now": nothing before it is reported
                return result;
            }
            if (cursor === 'lost') {
                return { ...result, refresh: true };
            }
            for (const page of state.pending.splice(0)) {
                Object.assign(result, page, { changed: [...result.changed, ...(page.changed ?? [])], deleted: [...result.deleted, ...(page.deleted ?? [])] });
            }
            return result;
        };
        fake.getAccountChanges = async (cursor: string | null) => {
            calls.push(`getAccountChanges:${cursor ?? 'latest'}`);
            requests += 1;
            const result = { cursor: `acc-${accountCursor}`, started: Boolean(cursor), refresh: false, calendars: false, addresses: false, mail: false, settings: false, requests: 1 };
            if (cursor === null) {
                accountPending = [];
                return result;
            }
            for (const page of accountPending.splice(0)) {
                Object.assign(result, page);
            }
            return result;
        };
    }
    service.protonAdapter = fake;
    const original = { log: console.log, warn: console.warn, error: console.error };
    const logs: string[] = [];
    console.log = (...parts: unknown[]) => logs.push(parts.join(' '));
    console.warn = console.log;
    console.error = console.log;
    const cleanup = async () => {
        Object.assign(console, original);
        service.stopPolling?.();
        await service.mirrorDatabase.close();
        rmSync(baseDir, { recursive: true, force: true });
    };
    const rows = async (calendarId: string) => service.mirrorDatabase.listEventsForCalendar(calendarId, true);
    const calendarRecord = async (calendarId: string) => (await service.mirrorDatabase.listCalendars(true)).find((entry: any) => entry.protonCalendarId === calendarId);
    /** Proton: an event created/changed/deleted, and its feed page. */
    const protonCreates = (calendarId: string, event: any) => {
        proton[calendarId].events.push(event);
        proton[calendarId].cursor += 1;
        proton[calendarId].pending.push({ changed: [stubOf(event)] });
    };
    const protonChanges = (calendarId: string, event: any) => {
        const state = proton[calendarId];
        state.events = state.events.map((entry) => (entry.eventId === event.eventId ? event : entry));
        state.cursor += 1;
        state.pending.push({ changed: [stubOf(event)] });
    };
    const protonDeletes = (calendarId: string, eventId: string) => {
        const state = proton[calendarId];
        state.events = state.events.filter((entry) => entry.eventId !== eventId);
        state.cursor += 1;
        state.pending.push({ deleted: [eventId] });
    };
    const accountEvent = (page: any) => {
        accountCursor += 1;
        accountPending.push(page);
    };
    return { service, calls, logs, proton, rows, calendarRecord, protonCreates, protonChanges, protonDeletes, accountEvent, mailResults, setCalendars: (next: any[]) => (calendars = next), cleanup };
};

test('cadence rule: your interval while things change, every five minutes when quiet, fixed with an older client', () => {
    const base = { now: 1_000_000_000, intervalMs: 60_000, adaptive: true };
    assert.equal(nextSyncDelayMs({ ...base, lastActivityAt: base.now - 1000 }), 60_000);
    assert.equal(nextSyncDelayMs({ ...base, lastActivityAt: base.now - QUIET_AFTER_MS + 1 }), 60_000, 'still active just before the ten minutes');
    assert.equal(nextSyncDelayMs({ ...base, lastActivityAt: base.now - QUIET_AFTER_MS }), QUIET_INTERVAL_MS);
    assert.equal(nextSyncDelayMs({ ...base, lastActivityAt: 0, intervalMs: 15 * 60_000 }), 15 * 60_000, 'a longer interval of yours stays');
    assert.equal(nextSyncDelayMs({ ...base, lastActivityAt: 0, adaptive: false }), 60_000, 'an older client: as set');

    // What can have an occurrence in the window (Unix seconds; the window is 100–200).
    assert.equal(touchesWindow(150, 160, null, 100, 200), true);
    assert.equal(touchesWindow(50, 60, null, 100, 200), false, 'a single event before the window');
    assert.equal(touchesWindow(250, 260, null, 100, 200), false, 'after it');
    assert.equal(touchesWindow(50, 60, 'FREQ=WEEKLY', 100, 200), true, 'an open-ended series from before');
    assert.equal(touchesWindow(50, 60, 'FREQ=WEEKLY;COUNT=3', 100, 200), true, 'a COUNT whose end is not known: kept');
    assert.equal(touchesWindow(250, 260, 'FREQ=WEEKLY', 100, 200), false, 'a series starting after the window');
    const day = 86_400;
    const until = (unix: number) => new Date(unix * 1000).toISOString().replace(/[-:]|\.\d+/g, '').replace(/Z$/, 'Z');
    assert.equal(touchesWindow(0, 60, `FREQ=DAILY;UNTIL=${until(100 * day)}`, 200 * day, 300 * day), false, 'a series that ended long before the window');
    assert.equal(touchesWindow(0, 60, `FREQ=DAILY;UNTIL=${until(200 * day - 3600)}`, 200 * day, 300 * day), true, 'ended just before: kept (a day of slack)');
    assert.equal(touchesWindow(0, 60, 'FREQ=DAILY;UNTIL=19700301', 200 * day, 300 * day), false, 'a date-only UNTIL');
    // 0.40: with the series' end worked out, a COUNT series that ended before the window is outside it.
    assert.equal(touchesWindow(0, 60, 'FREQ=WEEKLY;COUNT=3', 200 * day, 300 * day, 100 * day * 1000), false, 'a COUNT series that ended long before');
    assert.equal(touchesWindow(0, 60, 'FREQ=WEEKLY;COUNT=3', 200 * day, 300 * day, (200 * day - 3600) * 1000), true, 'ended just before: kept (a day of slack)');
    assert.equal(touchesWindow(0, 60, 'FREQ=WEEKLY;COUNT=300', 200 * day, 300 * day, (250 * day) * 1000), true, 'still running in the window');
    assert.equal(touchesWindow(0, 60, 'FREQ=WEEKLY', 200 * day, 300 * day, 100 * day * 1000), true, 'no COUNT: the end is not used');
});

test('a full pass at sign-in takes the cursors first; the next passes only ask the feeds', async () => {
    const { service, calls, rows, calendarRecord, protonCreates, protonChanges, protonDeletes, cleanup } = await setup();
    try {
        protonCreates('priv', remoteEvent('priv', 'p1', 'uid-p1'));
        await service.syncNow('login');
        assert.deepEqual(
            calls.splice(0),
            ['getAccountChanges:latest', 'listCalendars', 'getCalendarChanges:priv:latest', 'listEvents:priv', 'getCalendarChanges:work:latest', 'listEvents:work', 'fileCalendarEmails'],
            'cursors before listing, the mailbox looked at'
        );
        assert.equal((await rows('priv')).length, 1);
        const priv = await calendarRecord('priv');
        assert.equal(priv.feedCursor, 'priv-1', 'the cursor kept with the calendar');
        assert.ok(priv.fullSyncedAt && Date.now() - priv.fullSyncedAt < 5000);
        assert.equal(service.lastPass.kind, 'full');
        assert.equal(service.lastPass.changes, 1);
        assert.equal(service.lastPass.decrypted, 1);

        // Nothing new: one request for the account, one per calendar, nothing listed or decrypted.
        await service.syncNow('auto');
        assert.deepEqual(calls.splice(0), ['getAccountChanges:acc-0', 'getCalendarChanges:priv:priv-1', 'getCalendarChanges:work:work-0']);
        assert.deepEqual([service.lastPass.kind, service.lastPass.changes, service.lastPass.decrypted, service.lastPass.requests], ['changes', 0, 0, 3]);
        assert.equal(service.health, 'healthy');

        // Created in Proton: only that series is read, the row appears, Calendar.app's ctag moves.
        const ctagBefore = (await calendarRecord('work')).ctag;
        protonCreates('work', remoteEvent('work', 'w1', 'uid-w1'));
        await service.syncNow('auto');
        assert.deepEqual(
            calls.splice(0),
            ['getAccountChanges:acc-0', 'getCalendarChanges:priv:priv-1', 'getCalendarChanges:work:work-0', 'listEventsByUid:work:uid-w1', 'fileCalendarEmails'],
            'only that series read; its emails checked as in every pass that changes a meeting'
        );
        const created = (await rows('work')).find((row: any) => row.uid === 'uid-w1');
        assert.ok(created && !created.deleted, 'the row is there');
        assert.notEqual((await calendarRecord('work')).ctag, ctagBefore, 'Calendar.app is told');
        assert.equal((await calendarRecord('work')).feedCursor, 'work-1');
        assert.deepEqual([service.lastPass.kind, service.lastPass.changes, service.lastPass.decrypted], ['changes', 1, 1]);

        // Changed: the row follows (and the old version is remembered for Calendar.app's If-Match).
        protonChanges('work', remoteEvent('work', 'w1', 'uid-w1', { title: 'Event w1, renamed', contentHash: 'w1-v2' }));
        await service.syncNow('auto');
        assert.ok(calls.includes('listEventsByUid:work:uid-w1') && !calls.some((call) => call.startsWith('listEvents:')));
        calls.length = 0;
        assert.equal((await rows('work')).find((row: any) => row.uid === 'uid-w1').title, 'Event w1, renamed');

        // Deleted: the feed carries only the ID; the row is marked deleted.
        protonDeletes('work', 'w1');
        await service.syncNow('auto');
        assert.ok(calls.includes('listEventsByUid:work:uid-w1'), 'the series is read again (nothing left)');
        calls.length = 0;
        assert.equal((await rows('work')).find((row: any) => row.uid === 'uid-w1').deleted, true);
        assert.equal(service.lastPass.changes, 1);

        // A deletion of an event never mirrored: nothing to read.
        protonDeletes('work', 'never-seen');
        await service.syncNow('auto');
        assert.ok(!calls.some((call) => call.startsWith('listEventsByUid')));
        calls.length = 0;
    } finally {
        await cleanup();
    }
});

test('a deleted occurrence rebuilds its series; an event outside the window is left alone; a lost cursor lists again', async () => {
    const { service, calls, rows, calendarRecord, proton, protonCreates, protonDeletes, cleanup } = await setup();
    try {
        const master = remoteEvent('priv', 'm1', 'uid-series', { raw: { ID: 'm1', UID: 'uid-series', RRule: 'FREQ=WEEKLY', RecurrenceID: null } });
        const exception = remoteEvent('priv', 'm1x', 'uid-series', {
            startTimestamp: now() + 10 * DAY,
            endTimestamp: now() + 10 * DAY + 3600,
            raw: { ID: 'm1x', UID: 'uid-series', RRule: null, RecurrenceID: now() + 10 * DAY }
        });
        proton.priv.events.push(master, exception);
        await service.syncNow('login');
        calls.length = 0;
        const before = (await rows('priv')).find((row: any) => row.uid === 'uid-series');
        assert.ok(before.serializedIcs.includes('RECURRENCE-ID'), 'the series row has the occurrence');
        assert.deepEqual(Object.values(before.protonEventIds).sort(), ['m1', 'm1x']);

        protonDeletes('priv', 'm1x');
        await service.syncNow('auto');
        assert.ok(calls.includes('listEventsByUid:priv:uid-series'), 'found by the occurrence ID, the series read again');
        const after = (await rows('priv')).find((row: any) => row.uid === 'uid-series');
        assert.ok(!after.deleted && !after.serializedIcs.includes('RECURRENCE-ID'), 'the row stays, without the occurrence');
        calls.length = 0;

        // Far outside the window (and unknown here): not even read.
        protonCreates('priv', remoteEvent('priv', 'far', 'uid-far', { startTimestamp: now() + 400 * DAY, endTimestamp: now() + 400 * DAY + 3600 }));
        await service.syncNow('auto');
        assert.ok(!calls.some((call) => call.startsWith('listEventsByUid')), 'nothing read');
        assert.ok(!(await rows('priv')).some((row: any) => row.uid === 'uid-far'));
        calls.length = 0;

        // Proton asks for a full read of one calendar (or the cursor is lost): listed again, the others not.
        await service.mirrorDatabase.setCalendarFeed('priv', { cursor: 'lost' });
        await service.syncNow('auto');
        // (The fake lists every event, the far one included: that new row is the pass's one change.)
        assert.deepEqual(calls.splice(0), ['getAccountChanges:acc-0', 'getCalendarChanges:priv:lost', 'listEvents:priv', 'getCalendarChanges:work:work-0', 'fileCalendarEmails']);
        assert.equal((await calendarRecord('priv')).feedCursor, 'priv-2', 'the fresh cursor kept');
        assert.equal(service.lastPass.kind, 'changes');
        assert.ok(service.lastPass.decrypted >= 2, 'the calendar was decrypted again');
    } finally {
        await cleanup();
    }
});

test('0.40: a COUNT series changed in Proton that ended before the window does not appear (nor stay)', async () => {
    const { service, rows, proton, protonCreates, cleanup } = await setup();
    try {
        await service.syncNow('login');
        // Weekly, three times, long before the window (a year back): its row would have stayed until the daily full pass.
        const ended = remoteEvent('priv', 'old', 'uid-ended', {
            startTimestamp: now() - 500 * DAY,
            endTimestamp: now() - 500 * DAY + 3600,
            raw: { ID: 'old', UID: 'uid-ended', RRule: 'FREQ=WEEKLY;COUNT=3', RecurrenceID: null }
        });
        const asked: unknown[] = [];
        service.protonAdapter.seriesLastEndOf = async (vevent: unknown) => {
            asked.push(vevent);
            return (now() - 486 * DAY + 3600) * 1000; // the third occurrence, two weeks later
        };
        protonCreates('priv', ended);
        await service.syncNow('auto');
        assert.equal(asked.length, 1, "the series' end was worked out");
        assert.ok(!(await rows('priv')).some((row: any) => row.uid === 'uid-ended' && !row.deleted), 'not served');

        // The same series running into the window is kept.
        service.protonAdapter.seriesLastEndOf = async () => (now() + 30 * DAY) * 1000;
        protonCreates('priv', remoteEvent('priv', 'running', 'uid-running', {
            startTimestamp: now() - 500 * DAY,
            endTimestamp: now() - 500 * DAY + 3600,
            raw: { ID: 'running', UID: 'uid-running', RRule: 'FREQ=WEEKLY;COUNT=80', RecurrenceID: null }
        }));
        await service.syncNow('auto');
        assert.ok((await rows('priv')).some((row: any) => row.uid === 'uid-running' && !row.deleted), 'a COUNT series still running is served');
        void proton;
    } finally {
        await cleanup();
    }
});

test('0.40: the full pass leaves out an ended COUNT series too; a series keeps its master while a changed occurrence is in the window', async () => {
    const { service, rows, proton, cleanup } = await setup();
    try {
        service.protonAdapter.seriesLastEndOf = async (vevent: any) => vevent?.lastEnd ?? null;
        proton.priv.events.push(
            remoteEvent('priv', 'gone', 'uid-gone', {
                startTimestamp: now() - 500 * DAY,
                endTimestamp: now() - 500 * DAY + 3600,
                raw: { ID: 'gone', UID: 'uid-gone', RRule: 'FREQ=WEEKLY;COUNT=3', RecurrenceID: null },
                decrypted: { vevent: { lastEnd: (now() - 486 * DAY) * 1000 } }
            }),
            // Ended long ago, but its last occurrence was moved by the organizer into the window.
            remoteEvent('priv', 'kept', 'uid-kept', {
                startTimestamp: now() - 500 * DAY,
                endTimestamp: now() - 500 * DAY + 3600,
                raw: { ID: 'kept', UID: 'uid-kept', RRule: 'FREQ=WEEKLY;COUNT=3', RecurrenceID: null },
                decrypted: { vevent: { lastEnd: (now() - 486 * DAY) * 1000 } }
            }),
            remoteEvent('priv', 'kept-x', 'uid-kept', {
                startTimestamp: now() + 2 * DAY,
                endTimestamp: now() + 2 * DAY + 3600,
                raw: { ID: 'kept-x', UID: 'uid-kept', RRule: null, RecurrenceID: now() - 486 * DAY }
            })
        );
        await service.syncNow('login');
        const served = (await rows('priv')).filter((row: any) => !row.deleted).map((row: any) => row.uid);
        assert.ok(!served.includes('uid-gone'), 'the ended series is not served by the full pass either');
        const kept = (await rows('priv')).find((row: any) => row.uid === 'uid-kept');
        assert.ok(kept && !kept.deleted, 'the series with an occurrence in the window is served');
        assert.deepEqual(Object.values(kept.protonEventIds).sort(), ['kept', 'kept-x'], 'with its master');
    } finally {
        await cleanup();
    }
});

test('the calendar list and the mailbox only when the account feed says so; a full pass once a day, on Refresh and when Proton asks', async () => {
    const { service, calls, rows, accountEvent, setCalendars, proton, mailResults, cleanup } = await setup();
    try {
        await service.syncNow('login');
        calls.length = 0;

        accountEvent({ mail: true });
        await service.syncNow('auto');
        assert.deepEqual(calls.splice(0), ['getAccountChanges:acc-0', 'getCalendarChanges:priv:priv-0', 'getCalendarChanges:work:work-0', 'fileCalendarEmails'], 'mail arrived: the Inbox is looked at');
        await service.syncNow('auto');
        assert.ok(!calls.includes('fileCalendarEmails') && !calls.includes('listCalendars'), 'quiet: neither');
        calls.length = 0;

        // A mailbox run that stops early (its budget, an error) is finished in the next pass, mail or no mail.
        accountEvent({ mail: true });
        mailResults.push({ more: true });
        await service.syncNow('auto');
        assert.ok(calls.includes('fileCalendarEmails'));
        calls.length = 0;
        mailResults.push(new Error('ETIMEDOUT'));
        await service.syncNow('auto');
        assert.ok(calls.includes('fileCalendarEmails'), 'looked at again after "more"');
        calls.length = 0;
        await service.syncNow('auto');
        assert.ok(calls.includes('fileCalendarEmails'), 'looked at again after an error');
        calls.length = 0;
        await service.syncNow('auto');
        assert.ok(!calls.includes('fileCalendarEmails'), 'done: quiet again');
        calls.length = 0;

        // A wider or narrower window: the next automatic pass lists everything in full.
        await service.updateConfig({ eventLookaheadDays: 90 });
        await service.syncNow('auto');
        assert.equal(service.lastPass.kind, 'full', 'the new window listed');
        await service.syncNow('auto');
        assert.equal(service.lastPass.kind, 'changes');
        calls.length = 0;

        // A calendar added in Proton: the list is read again, the new calendar listed in full (no cursor yet).
        setCalendars([
            { id: 'priv', name: 'Tobi (Private)', color: '#6d4aff', visible: true, writable: true, type: 0, owned: true },
            { id: 'work', name: 'Tobi (Work)', color: '#10b981', visible: true, writable: true, type: 0, owned: true },
            { id: 'new', name: 'Hobby', color: '#f59e0b', visible: true, writable: true, type: 0, owned: true }
        ]);
        proton.new = { events: [remoteEvent('new', 'n1', 'uid-n1')], cursor: 0, pending: [] };
        accountEvent({ calendars: true });
        await service.syncNow('auto');
        assert.deepEqual(calls.splice(0), ['getAccountChanges:acc-2', 'listCalendars', 'getCalendarChanges:new:latest', 'listEvents:new', 'getCalendarChanges:priv:priv-0', 'getCalendarChanges:work:work-0', 'fileCalendarEmails']);
        assert.equal((await rows('new')).length, 1);
        assert.equal(service.lastPass.kind, 'changes');

        // The Refresh button: everything in full.
        await service.syncNow('refresh');
        assert.ok(calls.includes('listCalendars') && calls.includes('listEvents:priv') && calls.includes('listEvents:work') && calls.includes('fileCalendarEmails'));
        assert.equal(service.lastPass.kind, 'full');
        calls.length = 0;

        // Proton asks for a full read of the account: a full pass.
        accountEvent({ refresh: true });
        await service.syncNow('auto');
        assert.ok(calls.includes('listCalendars') && calls.includes('listEvents:priv'), 'listed again');
        assert.equal(service.lastPass.kind, 'full');
        calls.length = 0;

        // The first pass of a new day is a full one (the safety net); the next is not.
        service.fullPassDay = '2000-01-01';
        await service.syncNow('auto');
        assert.equal(service.lastPass.kind, 'full');
        assert.equal(service.fullPassDay, localDayOf(new Date()));
        await service.syncNow('auto');
        assert.equal(service.lastPass.kind, 'changes');
        calls.length = 0;

        // A click on one calendar: that one in full, behind nothing else.
        await service.syncCalendar('work');
        await service.drainQueue();
        assert.deepEqual(calls.splice(0), ['getCalendarChanges:work:latest', 'listEvents:work'], 'a fresh cursor, then the listing');

        // Statistics for Developer settings.
        const stats = (await service.getBridgeState()).requestStats;
        assert.equal(stats.feed.enabled, true);
        assert.equal(stats.feed.calendars, 3);
        assert.equal(stats.feed.following, 3);
        assert.ok(stats.feed.lastFullAt && Date.now() - stats.feed.lastFullAt < 10_000);
        assert.ok(stats.lastHourPasses.passes >= 12 && stats.lastHourPasses.full >= 5);
        assert.equal(stats.lastHourPasses.requests, stats.requests - 2, 'every request but the click was in a pass');
        assert.deepEqual(stats.decrypt, { decrypted: stats.decrypt.decrypted, reused: 0, cached: 0 });
        assert.equal(stats.cadence.mode, 'active');
        assert.equal(stats.cadence.intervalMs, 60_000);
        assert.equal(stats.cadence.nextAt, null, 'not polling in this test');

        // Sign-out forgets the cursors and the day: the next sign-in starts with a full pass.
        await service.performSignOut();
        assert.equal(service.accountCursor, null);
        assert.equal(service.fullPassDay, null);
        assert.deepEqual(service.passHistory, []);
    } finally {
        await cleanup();
    }
});

test('polling: the next pass is one interval after the last, five minutes when quiet; an older client is listed in full at a fixed interval', async () => {
    const quiet = await setup();
    try {
        const { service } = quiet;
        service.configStore.update({ pollIntervalMs: 30_000 });
        await service.syncNow('login');
        service.startPolling();
        assert.ok(service.nextSyncAt - Date.now() > 29_000 && service.nextSyncAt - Date.now() <= 30_000, 'your interval while active');
        service.lastActivityAt = Date.now() - QUIET_AFTER_MS - 1;
        service.scheduleNextSync();
        assert.ok(service.nextSyncAt - Date.now() > QUIET_INTERVAL_MS - 1000, 'five minutes when quiet');
        assert.equal((await service.getBridgeState()).requestStats.cadence.mode, 'quiet');
        service.noteActivity();
        service.scheduleNextSync();
        assert.ok(service.nextSyncAt - Date.now() <= 30_000, 'fast again after a change');
        service.stopPolling();
        assert.equal(service.nextSyncAt, null);
    } finally {
        await quiet.cleanup();
    }

    const older = await setup({ feed: false });
    try {
        const { service, calls } = older;
        await service.syncNow('login');
        calls.length = 0;
        await service.syncNow('auto');
        assert.deepEqual(calls.splice(0), ['listCalendars', 'listEvents:priv', 'listEvents:work', 'fileCalendarEmails'], 'as before 0.26');
        assert.equal(service.lastPass.kind, 'full');
        const stats = (await service.getBridgeState()).requestStats;
        assert.equal(stats.feed.enabled, false);
        assert.equal(stats.cadence.mode, 'fixed');
        service.lastActivityAt = 0;
        assert.equal(nextSyncDelayMs({ now: Date.now(), lastActivityAt: 0, intervalMs: 60_000, adaptive: service.usesChangeFeed() }), 60_000);
    } finally {
        await older.cleanup();
    }
});

test('mirror: the Proton event of a series occurrence finds its row', async () => {
    stubElectron();
    const { MirrorDatabase } = await import('../src/main/mirror-database');
    const baseDir = mkdtempSync(join(tmpdir(), 'neutron-calendar-bridge-feed-db-'));
    const database = new MirrorDatabase(baseDir);
    try {
        await database.initialize();
        await database.upsertCalendar({ protonCalendarId: 'cal', slug: 'cal', displayName: 'Cal', color: '#000', description: '', visible: true, removed: false, ctag: '1', lastPolledAt: null, lastSyncedAt: null, readOnly: false, readOnlyReason: null });
        const base = { protonCalendarId: 'cal', etag: 'e', contentHash: 'h', serializedIcs: 'BEGIN:VCALENDAR', title: '', description: '', location: '', startTimestamp: 1, endTimestamp: 2, timezone: 'UTC', isAllDay: false, modifiedTimestamp: 1, deleted: false, lastSyncedAt: 1 };
        await database.upsertEvent({ ...base, protonEventId: 'a_b/c=', uid: 'u1', href: '/u1.ics', protonEventIds: { '': 'a_b/c=', '20261001T100000': 'x%y_z' } } as any);
        await database.upsertEvent({ ...base, protonEventId: 'other', uid: 'u2', href: '/u2.ics', protonEventIds: { '': 'other' } } as any);
        assert.equal((await database.findEventByProtonId('cal', 'a_b/c='))?.uid, 'u1', 'by its own ID');
        assert.equal((await database.findEventByProtonId('cal', 'x%y_z'))?.uid, 'u1', 'by an occurrence ID (LIKE characters escaped)');
        assert.equal(await database.findEventByProtonId('cal', 'x%y'), null, 'not a part of one');
        assert.equal(await database.findEventByProtonId('cal', 'oth'), null);
        await database.setCalendarFeed('cal', { cursor: 'c1' });
        assert.deepEqual([(await database.listCalendars())[0].feedCursor, (await database.listCalendars())[0].fullSyncedAt], ['c1', null]);
        await database.setCalendarFeed('cal', { fullSyncedAt: 5 });
        assert.deepEqual([(await database.listCalendars())[0].feedCursor, (await database.listCalendars())[0].fullSyncedAt], ['c1', 5]);
        await database.setCalendarFeed('cal', {});
    } finally {
        await database.close();
        rmSync(baseDir, { recursive: true, force: true });
    }
});

test('0.44.1: the feed reports a change but the lookup by UID misses the event — kept, read again later; a reported deletion still removes it', async () => {
    const { service, rows, proton, protonChanges, protonDeletes, logs, cleanup } = await setup();
    try {
        const event = remoteEvent('priv', 'e1', 'uid-e1');
        proton.priv.events.push(event);
        await service.syncNow('login');
        const fake = service.protonAdapter as any;
        const lookup = fake.listEventsByUid;
        fake.listEventsByUid = async () => [];
        protonChanges('priv', { ...event, title: 'Renamed', modifiedTimestamp: event.modifiedTimestamp + 60 });
        await service.syncNow('auto');
        const kept = (await rows('priv')).find((row: any) => row.uid === 'uid-e1');
        assert.ok(kept && !kept.deleted, 'not taken for a deletion');
        assert.ok(logs.some((line) => /reported a change, but listed no event by its UID; kept/.test(line)));
        fake.listEventsByUid = lookup;
        protonDeletes('priv', 'e1');
        await service.syncNow('auto');
        assert.equal((await rows('priv')).find((row: any) => row.uid === 'uid-e1')?.deleted, true, 'a reported deletion removes it');
    } finally {
        await cleanup();
    }
});
