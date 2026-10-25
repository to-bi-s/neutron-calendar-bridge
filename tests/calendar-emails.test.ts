/**
 * Emails about meetings, moved out of the Inbox once dealt with (patch 20). Deciding and moving is
 * proton-calendar-client's job (tested in its own offline test); here the client is a fake that
 * records what the bridge asks for. Checks: the setting (default: leave them), its validation and
 * restart, the run at the end of each sync pass with the meetings changed in that pass, meetings that
 * left your calendars (by their Proton UID), changes kept when a run stops early, bridge.log, the status
 * on the Settings page, sign-out, an old client.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { logLine } from '../src/main/private-log';
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

const remoteEvent = (uid: string, title = 'Team meeting', eventId = `ev-${uid}`) => ({
    calendarId: 'private',
    eventId,
    uid,
    title,
    description: '',
    location: '',
    startTimestamp: Date.UTC(2026, 9, 7, 12) / 1000,
    endTimestamp: Date.UTC(2026, 9, 7, 13) / 1000,
    timezone: 'UTC',
    isAllDay: false,
    modifiedTimestamp: 1_790_000_000,
    contentHash: `${uid}-${title}`
});

const emptyResult = () => ({ filed: [], left: [], waiting: 0, leftCount: 0, wouldMove: 0, opened: 0, checked: 0 });

const setup = async ({ supported = true } = {}) => {
    stubElectron();
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { BridgeService } = require('../src/main/bridge-service') as typeof import('../src/main/bridge-service');
    const baseDir = mkdtempSync(join(tmpdir(), 'neutron-calendar-bridge-mail-'));
    const service = new BridgeService(baseDir) as any;
    await service.mirrorDatabase.initialize();
    service.localCaldavPassword = 'test';
    const calls: string[] = [];
    const runs: any[] = [];
    const results: any[] = [];
    let events = [remoteEvent('team@outlook.test')];
    const fake: any = {
        isSignedIn: () => true,
        getSignedInUsername: () => 'tobi',
        supportsSeriesSync: () => true,
        supportsInvitations: () => true,
        supportsOrganizing: () => true,
        supportsEmailedAnswers: () => true,
        listAddresses: () => [],
        listCalendars: async () => {
            calls.push('listCalendars');
            return [{ id: 'private', name: 'Tobi (Private)', color: '#6d4aff', visible: true, writable: true }];
        },
        listEvents: async () => {
            calls.push('listEvents');
            return events;
        },
        applyEmailedAnswers: async () => ({ answers: [], cursor: 0, opened: 0 }),
        signOut: async () => undefined
    };
    if (supported) {
        fake.supportsCalendarEmails = () => true;
        fake.fileCalendarEmails = async (input: any) => {
            calls.push('fileCalendarEmails');
            runs.push(input);
            const next = results.shift() ?? emptyResult();
            if (next instanceof Error) throw next;
            return next;
        };
    }
    service.protonAdapter = fake;
    const logs: string[] = [];
    const original = { log: console.log, warn: console.warn };
    // As written with detailed logging (quiet-logs.test.ts checks what is left out otherwise).
    console.log = (...parts: unknown[]) => logs.push(logLine(parts.join(' '), true));
    console.warn = (...parts: unknown[]) => logs.push(`WARN ${logLine(parts.join(' '), true)}`);
    const cleanup = async () => {
        console.log = original.log;
        console.warn = original.warn;
        await service.mirrorDatabase.close();
        rmSync(baseDir, { recursive: true, force: true });
    };
    return {
        service, calls, runs, results, logs, cleanup, baseDir,
        setEvents: (next: any[]) => {
            events = next;
        }
    };
};

test('emails about meetings: left alone by default; the setting is checked and survives a restart', async () => {
    stubElectron();
    const { ConfigStore } = await import('../src/main/config-store');
    const baseDir = mkdtempSync(join(tmpdir(), 'neutron-calendar-bridge-mail-config-'));
    try {
        const store = new ConfigStore(baseDir);
        assert.equal(store.load().calendarEmailsAfter, 'leave');
        assert.equal(store.load().calendarEmailsFolder, 'Calendar');
        store.update({ calendarEmailsAfter: 'folder', calendarEmailsFolder: 'Meetings' });
        const again = new ConfigStore(baseDir).load();
        assert.equal(again.calendarEmailsAfter, 'folder');
        assert.equal(again.calendarEmailsFolder, 'Meetings');
        // A broken config file: back to the defaults.
        writeFileSync(join(baseDir, 'config.json'), JSON.stringify({ calendarEmailsAfter: 'shred', calendarEmailsFolder: 'a/b' }));
        const broken = new ConfigStore(baseDir).load();
        assert.equal(broken.calendarEmailsAfter, 'leave');
        assert.equal(broken.calendarEmailsFolder, 'Calendar');
    } finally {
        rmSync(baseDir, { recursive: true, force: true });
    }

    const { service, calls, logs, cleanup } = await setup();
    try {
        await service.performSync();
        assert.ok(!calls.includes('fileCalendarEmails'), 'default: the Inbox is not touched');
        assert.equal((await service.getBridgeState()).calendarEmailsStatus, null);

        await assert.rejects(service.updateConfig({ calendarEmailsAfter: 'shred' }), /Unknown choice/);
        await assert.rejects(service.updateConfig({ calendarEmailsFolder: '   ' }), /needs a name/);
        await assert.rejects(service.updateConfig({ calendarEmailsFolder: 'Work/Calendar' }), /without "\/"/);
        await assert.rejects(service.updateConfig({ calendarEmailsFolder: 'inbox' }), /Proton's own folders/);
        await assert.rejects(service.updateConfig({ calendarEmailsFolder: 'x'.repeat(101) }), /100 characters/);
        const state = await service.updateConfig({ calendarEmailsAfter: 'folder', calendarEmailsFolder: '  Calendar 2026  ' });
        assert.equal(state.calendarEmailsAfter, 'folder');
        assert.equal(state.calendarEmailsFolder, 'Calendar 2026', 'trimmed');
        assert.equal(state.calendarEmailsSupported, true);
        assert.ok(logs.some((line) => line === '[mail] emails about meetings, once dealt with: moved to the folder "Calendar 2026"'));
        await service.updateConfig({ calendarEmailsAfter: 'trash' });
        assert.ok(logs.some((line) => line === '[mail] emails about meetings, once dealt with: moved to the Bin'));
    } finally {
        await cleanup();
    }
});

test('emails about meetings: looked at after the calendars, with the meetings that changed', async () => {
    const { service, calls, runs, results, logs, cleanup, setEvents } = await setup();
    try {
        await service.updateConfig({ calendarEmailsAfter: 'archive' });
        results.push({
            ...emptyResult(),
            filed: [
                { messageId: 'm1', receivedAt: '', from: 'boss@outlook.test', to: 'tobi@proton.me', subject: 'Invitation: Team meeting', kind: 'invitation', eventTitle: 'Team meeting', why: 'you answered (yes)', destination: 'Archive', outcome: 'moved' },
                { messageId: 'm2', receivedAt: '', from: 'carla@example.org', to: 'tobi@proton.me', subject: 'Accepted: Kickoff', kind: 'answer', eventTitle: 'Kickoff', why: 'Proton has this answer, or a newer one from this guest', destination: 'Archive', outcome: 'failed', error: 'Message cannot be moved' }
            ],
            left: [
                { messageId: 'm3', from: 'john.smith@corp.test', subject: 'Accepted: Kickoff', kind: 'answer', eventTitle: 'Kickoff', why: 'the sender only loosely matches the guest johnsmith@corp.test' },
                { messageId: 'm4', from: 'dan@gmail.test', subject: 'Accepted: Kickoff', kind: 'answer', eventTitle: 'Kickoff', why: 'the guest added a note, which Proton does not keep', note: 'Running late' }
            ],
            waiting: 2,
            leftCount: 1
        });
        await service.performSync();
        assert.ok(calls.indexOf('fileCalendarEmails') > calls.lastIndexOf('listEvents'), `after the calendars (${calls.join(', ')})`);
        assert.deepEqual(runs[0].changedUids, ['team@outlook.test'], 'the meeting new in this pass is checked right away');
        assert.equal(runs[0].moveTo, 'archive');
        assert.ok(logs.some((line) => line === '[mail] moved to Archive: invitation "Team meeting" from boss@outlook.test (you answered (yes))'));
        assert.ok(logs.some((line) => /^WARN \[mail\] could not move to Archive: answer "Kickoff" from carla@example\.org: Message cannot be moved$/.test(line)));
        assert.ok(logs.some((line) => /^\[mail\] left in the Inbox: answer "Kickoff" from john\.smith@corp\.test: the sender only loosely/.test(line)));
        assert.ok(logs.some((line) => line === '[mail] emails about meetings: 1 moved to Archive, 2 waiting, 1 left for you'));
        // 0.41.10: the guest's note on the Overview (without the developer option for emailed answers).
        const noteEntry = (await service.getBridgeState()).recentInvitationEmails.find((entry: any) => entry.outcome === 'note');
        assert.equal(noteEntry?.detail, 'Note from dan@gmail.test: Running late');
        assert.equal(noteEntry?.eventTitle, 'Kickoff');
        let status = (await service.getBridgeState()).calendarEmailsStatus;
        assert.deepEqual({ ...status, at: 0 }, { at: 0, moved: 1, wouldMove: 0, waiting: 2, left: 1, destination: 'Archive' });

        // Nothing changed in the next pass: no UIDs; a changed title: that UID.
        await service.performSync();
        assert.deepEqual(runs[1].changedUids, []);
        setEvents([remoteEvent('team@outlook.test', 'Team meeting (moved)')]);
        await service.performSync();
        assert.deepEqual(runs[2].changedUids, ['team@outlook.test']);
        // Gone from Proton: checked now, and passed as deleted (emails about it no longer matter).
        setEvents([]);
        await service.performSync();
        assert.deepEqual(runs[3].changedUids, ['team@outlook.test']);
        assert.deepEqual(runs[3].goneMeetings.map((entry: any) => entry.uid), ['team@outlook.test']);
        assert.ok(runs[3].goneMeetings[0].at <= Date.now() / 1000 && runs[3].goneMeetings[0].at > Date.now() / 1000 - 60, 'when it was last seen, in Unix seconds');

        // Kept for 30 days; meetings created in Calendar.app are passed by their Proton UID.
        service.calendarEmailsGone.set('old@outlook.test', Date.now() - 31 * 24 * 3600 * 1000);
        service.protonUidByEventId.set('ev-created', 'proton-generated-uid@proton.me');
        service.noteMeetingGone({ protonEventId: 'ev-created', uid: 'CALENDAR-APP-UID' });
        await service.performSync();
        assert.deepEqual(runs[4].goneMeetings.map((entry: any) => entry.uid).sort(), ['proton-generated-uid@proton.me', 'team@outlook.test']);
        assert.deepEqual(runs[4].changedUids, ['proton-generated-uid@proton.me']);

        // Proton gives the meeting another event ID (same UID): changed, not deleted.
        service.calendarEmailsGone.clear();
        setEvents([remoteEvent('rekeyed@uni.nl', 'Weekly', 'ev-b')]);
        await service.performSync();
        setEvents([remoteEvent('rekeyed@uni.nl', 'Weekly', 'ev-a')]);
        const before = runs.length;
        await service.performSync();
        assert.deepEqual(runs[before].changedUids, ['rekeyed@uni.nl']);
        assert.deepEqual(runs[before].goneMeetings, [], 'a new event ID for the same meeting is not a deletion');
        runs.splice(5); // keep the numbering of the cases below

        // A run that stops early keeps the changed meetings for the next one.
        setEvents([remoteEvent('team@outlook.test', 'Back again')]);
        results.push({ ...emptyResult(), error: 'Service unavailable' });
        await service.performSync();
        assert.deepEqual(runs[5].changedUids.sort(), ['rekeyed@uni.nl', 'team@outlook.test'], 'team is back, rekeyed is gone');
        await service.performSync();
        assert.deepEqual(runs[6].changedUids.sort(), ['rekeyed@uni.nl', 'team@outlook.test'], 'checked again in the next run');
        logs.length = 0;

        // Problems: logged once, shown on the Settings page; a folder created is logged.
        await service.updateConfig({ calendarEmailsAfter: 'folder' });
        logs.length = 0;
        results.push({ ...emptyResult(), folderCreated: 'Calendar', filed: [{ messageId: 'm4', receivedAt: '', from: 'boss@outlook.test', to: '', subject: 'Canceled: X', kind: 'cancellation', eventTitle: 'X', why: 'the meeting is cancelled in your calendar', destination: 'Calendar', outcome: 'moved' }] });
        results.push({ ...emptyResult(), error: 'Service unavailable' });
        results.push({ ...emptyResult(), error: 'Service unavailable' });
        await service.performSync();
        assert.ok(logs.some((line) => line === '[mail] created the folder "Calendar"'));
        assert.ok(logs.some((line) => line === '[mail] moved to Calendar: cancellation "X" from boss@outlook.test (the meeting is cancelled in your calendar)'));
        logs.length = 0;
        await service.performSync();
        await service.performSync();
        assert.equal(logs.filter((line) => /^WARN \[mail\] emails about meetings: stopped early/.test(line)).length, 1, 'the same problem is logged once');
        status = (await service.getBridgeState()).calendarEmailsStatus;
        assert.match(status.problem, /Service unavailable/);
        assert.equal(status.moved, 2, 'moved since the app started');
        assert.equal(status.destination, 'Calendar');

        // The client throws: the sync still succeeds.
        results.push(new Error('fetch failed'));
        await service.performSync();
        assert.equal(service.health, 'healthy');
        assert.match((await service.getBridgeState()).calendarEmailsStatus.problem, /could not look at the Inbox: fetch failed/);

        // Bin is called Bin.
        await service.updateConfig({ calendarEmailsAfter: 'trash' });
        results.push({ ...emptyResult(), filed: [{ messageId: 'm5', receivedAt: '', from: 'a@b.c', to: '', subject: 'S', kind: 'update', why: 'you answered (no)', destination: 'Trash', outcome: 'moved' }] });
        await service.performSync();
        assert.ok(logs.some((line) => line === '[mail] moved to Bin: update "S" from a@b.c (you answered (no))'));
        assert.equal((await service.getBridgeState()).calendarEmailsStatus.destination, 'Bin');

        // Sign-out forgets what it knew about this account's meetings and emails.
        await service.signOut();
        assert.equal(service.calendarEmailsGone.size, 0);
        assert.equal(service.calendarEmailsChangedUids.size, 0);
        assert.equal(service.protonUidByEventId.size, 0);
        assert.equal(service.calendarEmailsStatus, null);
        assert.equal(service.calendarEmailsMoved, 0);

        // Back to "leave": not looked at, no status.
        await service.updateConfig({ calendarEmailsAfter: 'leave' });
        const count = runs.length;
        await service.performSync();
        assert.equal(runs.length, count);
        assert.equal((await service.getBridgeState()).calendarEmailsStatus, null);
    } finally {
        await cleanup();
    }
});

test('emails about meetings: dry run reported, an old client is not asked', async () => {
    const { service, runs, results, logs, cleanup } = await setup();
    try {
        await service.updateConfig({ calendarEmailsAfter: 'archive', invitationEmailMode: 'dry-run' });
        results.push({ ...emptyResult(), wouldMove: 1, filed: [{ messageId: 'm1', receivedAt: '', from: 'boss@outlook.test', to: '', subject: 'S', kind: 'invitation', eventTitle: 'Team', why: 'you answered (yes)', destination: 'Archive', outcome: 'dry-run' }] });
        await service.performSync();
        assert.equal(runs.length, 1);
        assert.ok(logs.some((line) => line === '[mail] dry run, would move to Archive: invitation "Team" from boss@outlook.test (you answered (yes))'));
        const status = (await service.getBridgeState()).calendarEmailsStatus;
        assert.equal(status.wouldMove, 1);
        assert.equal(status.moved, 0);
    } finally {
        await cleanup();
    }

    const old = await setup({ supported: false });
    try {
        await old.service.updateConfig({ calendarEmailsAfter: 'archive' });
        await old.service.performSync();
        assert.ok(!old.calls.includes('fileCalendarEmails'));
        assert.equal((await old.service.getBridgeState()).calendarEmailsSupported, false);
    } finally {
        await old.cleanup();
    }
});
