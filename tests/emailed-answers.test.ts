/**
 * Answers that guests outside Proton email to meetings you organize (invitations, stage 4). Reading
 * the mailbox and applying the answers is proton-calendar-client's job (tested in its own offline
 * test); here the client is a fake that records what the bridge asks for. Checks: run at the start
 * of every sync pass, where the bridge starts reading (30 days back the first time, then from the
 * saved cursor with some overlap), the cursor per account, dry run not saving its progress, errors
 * never failing the sync, the setting (a developer option since 0.19: off by default, and only active
 * while developer options are on), bridge.log and the Overview list.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

const DAY = 24 * 3600;

const answer = (outcome: 'applied' | 'dry-run' | 'skipped', extra: Record<string, unknown> = {}) => ({
    messageId: `msg-${outcome}`,
    receivedAt: '2026-10-01T09:00:00.000Z',
    from: 'carla@example.org',
    to: 'tobi@proton.me',
    subject: 'Accepted: Project kickoff',
    outcome,
    answer: 'ACCEPTED',
    eventUid: 'kickoff@proton.me',
    eventTitle: 'Project kickoff',
    calendarID: 'private',
    eventID: 'ev-1',
    ...extra
});

const setup = async ({ supported = true, username = 'tobi', developer = true } = {}) => {
    stubElectron();
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { BridgeService } = require('../src/main/bridge-service') as typeof import('../src/main/bridge-service');
    const baseDir = mkdtempSync(join(tmpdir(), 'neutron-calendar-bridge-emailed-'));
    const service = new BridgeService(baseDir) as any;
    await service.mirrorDatabase.initialize();
    service.localCaldavPassword = 'test';
    if (developer) {
        service.configStore.update({ developerMode: true, applyEmailedAnswers: true });
    }
    const calls: string[] = [];
    const runs: Array<{ since: number }> = [];
    const results: any[] = [];
    const fake = {
        username,
        isSignedIn: () => true,
        getSignedInUsername: () => fake.username,
        supportsSeriesSync: () => true,
        supportsInvitations: () => true,
        supportsOrganizing: () => true,
        supportsEmailedAnswers: () => supported,
        listAddresses: () => [],
        listCalendars: async () => {
            calls.push('listCalendars');
            return [{ id: 'private', name: 'Tobi (Private)', color: '#6d4aff', visible: true, writable: true }];
        },
        listEvents: async () => {
            calls.push('listEvents');
            return [];
        },
        applyEmailedAnswers: async (input: { since: number }) => {
            calls.push('applyEmailedAnswers');
            runs.push(input);
            const next = results.shift() ?? { answers: [], cursor: input.since, opened: 0 };
            if (next instanceof Error) throw next;
            return next;
        }
    };
    service.protonAdapter = fake;
    const logs: string[] = [];
    const original = { log: console.log, warn: console.warn };
    // As written with detailed logging (quiet-logs.test.ts checks what is left out otherwise).
    console.log = (...parts: unknown[]) => logs.push(logLine(parts.join(' '), true));
    console.warn = (...parts: unknown[]) => logs.push(`WARN ${logLine(parts.join(' '), true)}`);
    const config = () => JSON.parse(readFileSync(join(baseDir, 'config.json'), 'utf8'));
    const cleanup = async () => {
        console.log = original.log;
        console.warn = original.warn;
        await service.mirrorDatabase.close();
        rmSync(baseDir, { recursive: true, force: true });
    };
    return { service, fake, calls, runs, results, logs, config, cleanup };
};

test('emailed answers: run before the calendars in each sync pass, cursor saved per account', async () => {
    const { service, fake, calls, runs, results, logs, config, cleanup } = await setup();
    try {
        const now = Math.floor(Date.now() / 1000);
        results.push({ answers: [answer('applied'), answer('skipped', { messageId: 'msg-2', reason: 'the sender is not a guest of this meeting', answer: 'DECLINED' })], cursor: now - 3600, opened: 2 });
        await service.performSync();
        assert.ok(calls.indexOf('applyEmailedAnswers') >= 0 && calls.indexOf('applyEmailedAnswers') < calls.indexOf('listEvents'), `answers first, then the calendars (${calls.join(', ')})`);
        assert.ok(Math.abs(runs[0].since - (now - 30 * DAY)) < 5, 'the first run looks 30 days back');
        assert.deepEqual(config().emailedAnswersCursor, { account: 'tobi', cursor: now - 3600 }, 'cursor saved with the account');
        assert.equal(service.health, 'healthy');

        // Overview and bridge.log.
        const state = await service.getBridgeState();
        const [skipped, applied] = state.recentInvitationEmails;
        assert.equal(applied.kind, 'received');
        assert.equal(applied.outcome, 'applied');
        assert.equal(applied.answer, 'ACCEPTED');
        assert.equal(applied.from, 'carla@example.org');
        assert.deepEqual(applied.to, [{ email: 'tobi@proton.me', name: '' }]);
        assert.equal(applied.eventTitle, 'Project kickoff');
        assert.equal(skipped.outcome, 'skipped');
        assert.equal(skipped.detail, 'Not applied: the sender is not a guest of this meeting');
        assert.ok(logs.some((line) => /\[invitations\] received: ACCEPTED from carla@example\.org to tobi@proton\.me for "Project kickoff".*applied in Proton/.test(line)), 'applied answer logged');
        assert.ok(logs.some((line) => /not applied: the sender is not a guest of this meeting/.test(line)), 'skipped answer logged with the reason');
        assert.ok(logs.some((line) => /2 email\(s\) with a calendar file read; 1 applied, 0 dry run, 1 skipped/.test(line)), 'summary logged');
        assert.equal(state.developerMode, true);
        assert.equal(state.applyEmailedAnswers, true);
        assert.equal(state.emailedAnswersSupported, true);

        // Next pass: from the saved cursor, 10 minutes back. Nothing new: the cursor is not walked back.
        await service.performSync();
        assert.equal(runs[1].since, now - 3600 - 600);
        assert.deepEqual(config().emailedAnswersCursor, { account: 'tobi', cursor: now - 3600 });

        // A run stopped early: progress kept, warning logged, the sync still succeeds.
        results.push({ answers: [], cursor: now - 1800, opened: 1, error: 'Service unavailable' });
        await service.performSync();
        assert.equal(config().emailedAnswersCursor.cursor, now - 1800);
        assert.ok(logs.some((line) => /^WARN \[invitations\] reading emailed answers stopped early.*Service unavailable/.test(line)));
        assert.equal(service.health, 'healthy');

        // The client throws: a warning, the calendars still sync.
        results.push(new Error('fetch failed'));
        calls.length = 0;
        await service.performSync();
        assert.ok(logs.some((line) => /^WARN \[invitations\] could not read emailed answers: fetch failed/.test(line)));
        assert.ok(calls.includes('listEvents'));
        assert.equal(service.health, 'healthy');

        // Another account on this Mac: its own start, 30 days back.
        fake.username = 'other';
        await service.performSync();
        assert.ok(Math.abs(runs[runs.length - 1].since - (now - 30 * DAY)) < 5, 'another account does not use this cursor');
    } finally {
        await cleanup();
    }
});

test('emailed answers: a dry run keeps its progress in memory, live mode starts from before it', async () => {
    const { service, runs, results, config, cleanup } = await setup();
    try {
        const now = Math.floor(Date.now() / 1000);
        results.push({ answers: [], cursor: now - 7200, opened: 0 });
        await service.performSync(); // live (test mode applies answers too: nothing is emailed)
        assert.equal(config().emailedAnswersCursor.cursor, now - 7200);

        await service.updateConfig({ invitationEmailMode: 'dry-run' });
        results.push({ answers: [answer('dry-run')], cursor: now - 600, opened: 1 });
        await service.performSync();
        assert.equal(runs[1].since, now - 7200 - 600, 'the dry run starts from the saved cursor');
        assert.equal(config().emailedAnswersCursor.cursor, now - 7200, 'a dry run does not save its progress');
        const [entry] = (await service.getBridgeState()).recentInvitationEmails;
        assert.equal(entry.outcome, 'dry-run');
        assert.equal(entry.detail, 'Dry run: not applied in Proton');

        await service.performSync();
        assert.equal(runs[2].since, now - 600 - 600, 'the next dry run continues where the last one stopped');

        await service.updateConfig({ invitationEmailMode: 'live' });
        results.push({ answers: [answer('applied')], cursor: now - 600, opened: 1 });
        await service.performSync();
        assert.equal(runs[3].since, now - 7200 - 600, 'live mode reads again what the dry run only reported');
        assert.equal(config().emailedAnswersCursor.cursor, now - 600);
    } finally {
        await cleanup();
    }
});

test('emailed answers: the setting, developer options, an old client, and settings the window may not change', async () => {
    const { service, runs, logs, config, cleanup } = await setup();
    try {
        await service.updateConfig({ applyEmailedAnswers: false });
        assert.equal(config().applyEmailedAnswers, false);
        assert.ok(logs.some((line) => /answers emailed by guests outside Proton: left to Proton/.test(line)));
        await service.performSync();
        assert.equal(runs.length, 0, 'switched off: the mailbox is not read');
        assert.equal((await service.getBridgeState()).applyEmailedAnswers, false);

        await service.updateConfig({ applyEmailedAnswers: true, emailedAnswersCursor: { account: 'tobi', cursor: 1 } } as any);
        assert.equal(config().applyEmailedAnswers, true);
        assert.equal(config().emailedAnswersCursor, null, 'the window cannot move the cursor');
        assert.ok(logs.some((line) => /answers emailed by guests outside Proton: applied by the bridge too/.test(line)));
        await assert.rejects(service.updateConfig({ applyEmailedAnswers: 'yes' } as any), /applyEmailedAnswers must be true or false/);
        await assert.rejects(service.updateConfig({ developerMode: 1 } as any), /developerMode must be true or false/);

        // Developer options off: the option keeps its tick but is not active.
        logs.length = 0;
        await service.updateConfig({ developerMode: false });
        assert.equal(config().developerMode, false);
        assert.equal(config().applyEmailedAnswers, true, 'the option keeps its value');
        assert.ok(logs.some((line) => /\[settings\] developer options: off/.test(line)));
        assert.ok(logs.some((line) => /answers emailed by guests outside Proton: left to Proton/.test(line)));
        await service.performSync();
        assert.equal(runs.length, 0, 'developer options off: the mailbox is not read');
        const state = await service.getBridgeState();
        assert.equal(state.developerMode, false);
        assert.equal(state.applyEmailedAnswers, true);

        // On again: the ticked option counts again.
        await service.updateConfig({ developerMode: true });
        assert.ok(logs.some((line) => /\[settings\] developer options: on/.test(line)));
        await service.performSync();
        assert.equal(runs.length, 1, 'developer options on again: read at the next sync');
    } finally {
        await cleanup();
    }

    const fresh = await setup({ developer: false });
    try {
        await fresh.service.performSync();
        assert.equal(fresh.runs.length, 0, 'a new install does not read the mailbox');
        const state = await fresh.service.getBridgeState();
        assert.equal(state.developerMode, false);
        assert.equal(state.applyEmailedAnswers, false);
    } finally {
        await fresh.cleanup();
    }

    const old = await setup({ supported: false });
    try {
        await old.service.performSync();
        assert.equal(old.runs.length, 0, 'a client without the feature is not asked');
        assert.equal((await old.service.getBridgeState()).emailedAnswersSupported, false);
    } finally {
        await old.cleanup();
    }
});

test('emailed answers: off by default (also coming from 0.18) and the settings survive a restart', async () => {
    stubElectron();
    const { ConfigStore } = await import('../src/main/config-store');
    const baseDir = mkdtempSync(join(tmpdir(), 'neutron-calendar-bridge-emailed-config-'));
    try {
        const store = new ConfigStore(baseDir);
        assert.equal(store.load().developerMode, false);
        assert.equal(store.load().applyEmailedAnswers, false);
        assert.equal(store.load().emailedAnswersCursor, null);

        // A config saved by 0.18 (the option on, no developerMode yet): off, the cursor kept.
        writeFileSync(join(baseDir, 'config.json'), JSON.stringify({ applyEmailedAnswers: true, emailedAnswersCursor: { account: 'tobi', cursor: 1_789_000_000 } }));
        const legacy = new ConfigStore(baseDir).load();
        assert.equal(legacy.developerMode, false);
        assert.equal(legacy.applyEmailedAnswers, false, 'the 0.18 default does not carry over');
        assert.deepEqual(legacy.emailedAnswersCursor, { account: 'tobi', cursor: 1_789_000_000 });

        store.update({ developerMode: true, applyEmailedAnswers: true, emailedAnswersCursor: { account: 'tobi', cursor: 1_790_000_000 } });
        const again = new ConfigStore(baseDir).load();
        assert.equal(again.developerMode, true);
        assert.equal(again.applyEmailedAnswers, true, 'ticked under developer options: kept after a restart');
        assert.deepEqual(again.emailedAnswersCursor, { account: 'tobi', cursor: 1_790_000_000 });
        store.update({ developerMode: false });
        const off = new ConfigStore(baseDir).load();
        assert.equal(off.developerMode, false);
        assert.equal(off.applyEmailedAnswers, true, 'switching developer options off keeps the option for later');
        store.update({ emailedAnswersCursor: { account: 'tobi', cursor: Number.NaN } as any });
        assert.equal(new ConfigStore(baseDir).load().emailedAnswersCursor, null, 'a broken cursor is dropped');
    } finally {
        rmSync(baseDir, { recursive: true, force: true });
    }
});

test('0.41: sent invitations are remembered (Message-ID) for replies in Spam; the last week is looked through again every few hours; a guest\'s note is shown', async () => {
    const { service, runs, results, logs, config, cleanup } = await setup();
    try {
        const sent = (externalId: string, method: 'REQUEST' | 'REPLY' | 'CANCEL' = 'REQUEST', outcome: 'sent' | 'blocked' = 'sent') =>
            service.recordInvitationEmail({ at: new Date().toISOString(), method, kind: method === 'REQUEST' ? 'invitation' : method === 'CANCEL' ? 'cancellation' : 'answer', answer: method === 'REPLY' ? 'ACCEPTED' : undefined, from: 'tobi@proton.me', to: [{ email: 'carla@example.org', name: 'Carla' }], subject: 'Invitation: Kickoff', eventTitle: 'Kickoff', eventUid: 'kickoff@proton.me', outcome, externalId });
        sent('<inv-1@proton.me>');
        sent('<answer@proton.me>', 'REPLY');
        sent('<cancel@proton.me>', 'CANCEL');
        sent('<blocked@proton.me>', 'REQUEST', 'blocked');
        sent('<inv-1@proton.me>'); // an update with the same Message-ID is kept once
        sent('<inv-2@proton.me>');
        assert.deepEqual(config().sentInvitationIds.map(({ id }: { id: string }) => id), ['<inv-1@proton.me>', '<inv-2@proton.me>'], 'only invitations and updates that were sent, each once');

        const now = Math.floor(Date.now() / 1000);
        await service.performSync();
        assert.deepEqual(runs[0].repliesTo, ['<inv-1@proton.me>', '<inv-2@proton.me>'], 'handed to the client for its Spam pass');
        assert.equal('lookBackFrom' in runs[0], false, 'the first run (30 days back) needs no look-back');
        await service.performSync();
        assert.ok(Math.abs(runs[1].lookBackFrom - (now - 7 * DAY)) < 5, 'the next run looks through the last week again once');
        await service.performSync();
        assert.equal('lookBackFrom' in runs[2], false, '… and not again for a few hours');
        service.emailedAnswersLookedBackAt = Date.now() - 7 * 3600 * 1000;
        results.push({ answers: [answer('applied', { comment: 'Running 10 minutes late.' })], cursor: now, opened: 1 });
        await service.performSync();
        assert.ok(Math.abs(runs[3].lookBackFrom - (now - 7 * DAY)) < 5, 'six hours later: again');

        const [entry] = (await service.getBridgeState()).recentInvitationEmails;
        assert.equal(entry.detail, 'Note from carla@example.org: Running 10 minutes late.', 'the note on the Overview list');
        assert.ok(logs.some((line) => /applied in Proton|with a note/.test(line) && /Running 10 minutes late/.test(line)), 'and in bridge.log (private, detailed logging)');
    } finally {
        await cleanup();
    }
});

test('0.41: emails that waited for a slow-down go out at the next pass after it; the Overview counts them; one given up is notified', async () => {
    const { service, fake, logs, cleanup } = await setup();
    try {
        const queue = [{ give: 'sent' }, { give: 'gave-up' }];
        const flushes: number[] = [];
        const notes: any[] = [];
        service.notify = (note: any) => notes.push(note);
        (fake as any).deferredEmailCount = () => queue.length;
        (fake as any).sendDeferredEmails = async () => {
            flushes.push(queue.length);
            const sent = queue.filter((entry) => entry.give === 'sent').length;
            const givenUp = queue.length - sent;
            queue.length = 0;
            return { sent, waiting: 0, givenUp };
        };
        assert.equal((await service.getBridgeState()).waitingEmails, 2, 'counted for the Overview');
        service.slowDownUntil = Date.now() + 60_000;
        await service.performSync();
        assert.deepEqual(flushes, [], 'not during the pause');
        service.slowDownUntil = 0;
        await service.performSync();
        assert.deepEqual(flushes, [2], 'sent at the first pass after it');
        assert.equal((await service.getBridgeState()).waitingEmails, 0);
        assert.ok(logs.some((line) => /emails that waited for the slow-down: 1 sent, 1 given up, 0 still waiting/.test(line)));
        assert.equal(notes.length, 1);
        assert.match(notes[0].body, /1 email waited too long for Proton and was not sent/);
        await service.performSync();
        assert.deepEqual(flushes, [2], 'nothing waits: no call');
    } finally {
        await cleanup();
    }
});
