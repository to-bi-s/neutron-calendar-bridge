/**
 * 0.30: the Setup page's "Calendar.app connected" — a request with the right password is noted
 * (this run), written to the config at most once a minute, and known again at the next start.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fakeSafeStorage } from './support/fake-safe-storage';

const stubElectron = () => {
    const resolved = require.resolve('electron');
    require.cache[resolved] = {
        id: resolved,
        filename: resolved,
        loaded: true,
        exports: { app: { setLoginItemSettings: () => undefined, isPackaged: false }, safeStorage: fakeSafeStorage }
    } as unknown as NodeJS.Module;
};

test('Calendar.app seen: noted this run, kept in the config, known at the next start; the profile carries the values', async () => {
    stubElectron();
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { BridgeService } = require('../src/main/bridge-service') as typeof import('../src/main/bridge-service');
    const baseDir = mkdtempSync(join(tmpdir(), 'neutron-calendar-bridge-calapp-'));
    const original = { log: console.log, warn: console.warn };
    console.log = () => undefined;
    console.warn = () => undefined;
    try {
        const service = new BridgeService(baseDir) as any;
        service.localCaldavPassword = 'local-secret';
        service.protonAdapter = { isSignedIn: () => false, getSignedInUsername: () => null };
        let changes = 0;
        service.onStateChange = () => (changes += 1);
        assert.deepEqual(service.getCalendarAppStatus(), { lastRequestAt: null, thisRun: false }, 'never seen');

        assert.equal(service.checkCalDAVLogin({ username: 'neutron-calendar-bridge', password: 'wrong' }), 'wrong');
        assert.deepEqual(service.getCalendarAppStatus(), { lastRequestAt: null, thisRun: false }, 'a wrong password does not count');
        assert.equal(service.checkCalDAVLogin({ username: 'neutron-calendar-bridge', password: 'local-secret' }), 'ok');
        const seen = service.getCalendarAppStatus();
        assert.equal(seen.thisRun, true);
        assert.ok(Date.now() - seen.lastRequestAt < 5000);
        assert.equal(service.configStore.load().calendarAppLastSeenAt, seen.lastRequestAt, 'written to the config');
        assert.equal(service.checkCalDAVLogin({ username: 'neutron-calendar-bridge', verified: true }), 'ok');
        assert.equal(service.configStore.load().calendarAppLastSeenAt, seen.lastRequestAt, 'not written again within a minute');
        assert.ok(service.getCalendarAppStatus().lastRequestAt >= seen.lastRequestAt, 'but remembered in memory');

        const next = new BridgeService(baseDir) as any;
        next.localCaldavPassword = 'local-secret';
        assert.deepEqual(next.getCalendarAppStatus(), { lastRequestAt: seen.lastRequestAt, thisRun: false }, 'the next start knows it from the config');

        const profile = service.getCalDAVProfile();
        assert.match(profile, /<key>CalDAVPassword<\/key>\s*<string>local-secret<\/string>/);
        assert.match(profile, /<key>CalDAVPrincipalURL<\/key>\s*<string>http:\/\/127\.0\.0\.1:31876\/principals\/neutron-calendar-bridge\/<\/string>/);
        assert.match(profile, /<key>PayloadIdentifier<\/key>\s*<string>io\.github\.to-bi-s\.neutron-calendar-bridge\.calendar-app<\/string>/);
        assert.match(profile, /<key>CalDAVAccountDescription<\/key>\s*<string>Proton<\/string>/, 'the account is called Proton in Calendar.app');
    } finally {
        console.log = original.log;
        console.warn = original.warn;
        rmSync(baseDir, { recursive: true, force: true });
    }
});

test('0.49.1: Thunderbird and other apps are told apart by the User-Agent and noted on their own', async () => {
    stubElectron();
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { BridgeService } = require('../src/main/bridge-service') as typeof import('../src/main/bridge-service');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { caldavClientOf } = require('../src/main/caldav-client') as typeof import('../src/main/caldav-client');
    assert.deepEqual(caldavClientOf('Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:128.0) Gecko/20100101 Thunderbird/128.3.0'), { kind: 'thunderbird', name: null });
    assert.deepEqual(caldavClientOf('macOS/15.6 (24G84) CalendarAgent/1042.2.1'), { kind: 'calendar-app', name: null });
    assert.deepEqual(caldavClientOf('Mac OS X/10.15.7 (19H2) dataaccessd/1.0'), { kind: 'calendar-app', name: null });
    assert.deepEqual(caldavClientOf('accountsd/113 CFNetwork/1568.300.101 Darwin/24.2.0'), { kind: 'calendar-app', name: null });
    assert.deepEqual(caldavClientOf('BusyCal/2025.1.3 (Macintosh; Mac OS X 15.6)'), { kind: 'other', name: 'BusyCal' });
    assert.deepEqual(caldavClientOf('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Fantastical/4.0.2'), { kind: 'other', name: 'Fantastical' });
    assert.deepEqual(caldavClientOf(undefined), { kind: 'other', name: null });
    assert.deepEqual(caldavClientOf('curl/8.7.1'), { kind: 'other', name: 'curl' });

    const baseDir = mkdtempSync(join(tmpdir(), 'neutron-calendar-bridge-clients-'));
    const original = { log: console.log, warn: console.warn };
    console.log = () => undefined;
    console.warn = () => undefined;
    try {
        const service = new BridgeService(baseDir) as any;
        service.localCaldavPassword = 'local-secret';
        service.protonAdapter = { isSignedIn: () => false, getSignedInUsername: () => null };
        service.onStateChange = () => undefined;
        assert.equal(service.checkCalDAVLogin({ username: 'u', password: 'local-secret' }, { kind: 'thunderbird', name: null }), 'ok');
        assert.deepEqual(service.getCalendarAppStatus(), { lastRequestAt: null, thisRun: false }, 'Thunderbird does not count as Calendar.app');
        assert.equal(service.getClientStatus('thunderbird').thisRun, true);
        assert.equal(service.getClientStatus('other').lastRequestAt, null);
        assert.equal(service.checkCalDAVLogin({ username: 'u', password: 'wrong' }, { kind: 'other', name: 'BusyCal' }), 'wrong');
        assert.equal(service.getClientStatus('other').lastRequestAt, null, 'a wrong password does not count');
        assert.equal(service.checkCalDAVLogin({ username: 'u', verified: true }, { kind: 'other', name: 'BusyCal' }), 'ok');
        const other = service.getClientStatus('other');
        assert.equal(other.name, 'BusyCal');
        assert.equal(other.thisRun, true);
        assert.equal(service.configStore.load().otherClientLastSeen.name, 'BusyCal', 'written to the config');
        assert.equal(service.configStore.load().thunderbirdLastSeenAt, service.getClientStatus('thunderbird').lastRequestAt);

        const next = new BridgeService(baseDir) as any;
        next.localCaldavPassword = 'local-secret';
        assert.deepEqual(next.getClientStatus('other'), { lastRequestAt: other.lastRequestAt, thisRun: false, name: 'BusyCal' }, 'the next start knows it');
        assert.equal(next.getClientStatus('thunderbird').thisRun, false);
        assert.ok(next.getClientStatus('thunderbird').lastRequestAt > 0);
    } finally {
        console.log = original.log;
        console.warn = original.warn;
        rmSync(baseDir, { recursive: true, force: true });
    }
});

test('0.49.6: refusal texts name the app behind the request, or "your calendar app" outside one', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { runWithClient, currentAppName } = require('../src/main/caldav-client') as typeof import('../src/main/caldav-client');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { INVITATION_MESSAGES, StaleEventError } = require('../src/main/recurrence') as typeof import('../src/main/recurrence');
    assert.equal(currentAppName(), 'your calendar app');
    assert.match(new StaleEventError().message, /since your calendar app last read it/);
    assert.match(INVITATION_MESSAGES.answerOccurrence, /Answer the whole series/);
    runWithClient({ kind: 'thunderbird', name: null }, () => {
        assert.equal(currentAppName(), 'Thunderbird');
        assert.match(new StaleEventError().message, /Thunderbird shows the current version/);
        assert.match(INVITATION_MESSAGES.answerOccurrence, /In Thunderbird, right-click the event/);
        assert.match(INVITATION_MESSAGES.staleMeeting, /since Thunderbird last read it/);
    });
    runWithClient({ kind: 'other', name: 'BusyCal' }, () => {
        assert.match(INVITATION_MESSAGES.organizeDontNotify, /^BusyCal asked/);
        assert.match(INVITATION_MESSAGES.answerOccurrence, /Answer the whole series/);
    });
    runWithClient({ kind: 'calendar-app', name: null }, () => assert.match(INVITATION_MESSAGES.moveMeeting, /Calendar\.app moves events/));
});
