/**
 * Stage 3 (0.24): quiet logs, detailed logging and notifications without details.
 * - bridge.log leaves out event titles, subjects, calendar names, email text and calendar files
 *   (marked with secret()), shows email addresses as a tag that differs per run, and the home
 *   folder as ~; detailed logging (Developer settings) shows them, for 24 hours or until switched
 *   off, and never while developer options are off;
 * - "Show event titles in notifications" off: no event or calendar name, no addresses;
 * - config.json is readable by you only.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import { isDetailedLogging, logLine, secret, setDetailedLogging, withoutAddresses } from '../src/main/private-log';
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

test('a quiet log line: private parts, addresses and the home folder left out', () => {
    const line = `[invitations] sent: REQUEST invitation from tobi@proton.me to Anna.B@example.org for "${secret('Dentist with Dr. Hendriks')}" (${homedir()}/Library/Logs)`;
    const quiet = logLine(line, false);
    assert.doesNotMatch(quiet, /Dentist|tobi@|Anna|example\.org/);
    assert.match(quiet, /for "‹private›"/);
    assert.match(quiet, /from ‹address [0-9a-f]{4}› to ‹address [0-9a-f]{4}›/);
    assert.match(quiet, /\(~\/Library\/Logs\)/);
    assert.doesNotMatch(quiet, /[\u0001\u0002]/, 'no marks left');

    // The same address gets the same tag (lines can be told apart), whatever its case.
    const tag = (text: string) => logLine(text, false).match(/‹address [0-9a-f]{4}›/)?.[0];
    assert.equal(tag('to anna.b@example.org'), tag('from Anna.B@Example.org'));
    assert.notEqual(tag('to anna.b@example.org'), tag('to someone@example.org'));

    // Detailed: everything, only the marks removed.
    assert.equal(
        logLine(line, true),
        `[invitations] sent: REQUEST invitation from tobi@proton.me to Anna.B@example.org for "Dentist with Dr. Hendriks" (${homedir()}/Library/Logs)`
    );

    // Text over several lines (an email that would have been sent) is hidden as a whole.
    assert.equal(logLine(`dry run:${secret('\nSubject: Invitation\n\nBEGIN:VCALENDAR\nSUMMARY:Secret\nEND:VCALENDAR')}`, false), 'dry run:‹private›');
    // Marks inside a private part cannot end it early.
    assert.equal(logLine(`x ${secret('a\u0002 b@c.de \u0001c')} y`, false), 'x ‹private› y');
    assert.equal(withoutAddresses('anna@example.org: not sent'), '(address hidden): not sent');
});

test('detailed logging: on for 24 hours or until switched off, only with developer options, off again by itself', async () => {
    stubElectron();
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { BridgeService } = require('../src/main/bridge-service') as typeof import('../src/main/bridge-service');
    const baseDir = mkdtempSync(join(tmpdir(), 'neutron-calendar-bridge-logs-'));
    const lines: string[] = [];
    const original = console.log;
    console.log = (...parts: unknown[]) => lines.push(parts.join(' '));
    try {
        const service = new BridgeService(baseDir) as any;
        await service.initialize();
        assert.equal(isDetailedLogging(), false, 'off by default');
        assert.equal((await service.configStore.load()).detailedLogging, 'off');

        await service.updateConfig({ detailedLogging: 'on' });
        assert.equal(isDetailedLogging(), false, 'not while developer options are off');
        await service.updateConfig({ developerMode: true, detailedLogging: '24h' });
        assert.equal(isDetailedLogging(), true);
        const until = service.configStore.load().detailedLoggingUntil;
        assert.ok(Math.abs(until - (Date.now() + 24 * 3600_000)) < 5000, 'for 24 hours');
        assert.equal(isDetailedLogging(until + 1), false, 'quiet again after them, also without the timer (asleep)');
        assert.ok(lines.some((line) => /\[settings\] detailed logging: on until \d{4}-/.test(line)));

        await service.updateConfig({ detailedLogging: 'on' });
        assert.equal(service.configStore.load().detailedLoggingUntil, null);
        assert.equal(isDetailedLogging(Date.now() + 365 * 24 * 3600_000), true, 'until switched off');

        await service.updateConfig({ developerMode: false });
        assert.equal(service.configStore.load().detailedLogging, 'off', 'switching developer options off switches it off');
        assert.equal(isDetailedLogging(), false);
        await service.updateConfig({ developerMode: true });
        assert.equal(isDetailedLogging(), false, 'and it does not come back with them');

        await assert.rejects(service.updateConfig({ detailedLogging: 'loud' }), /Unknown choice for detailed logging/);

        // The 24 hours were up while the app was not running: off at the next start.
        await service.updateConfig({ detailedLogging: '24h' });
        service.configStore.update({ detailedLoggingUntil: Date.now() - 1000 });
        const restarted = new BridgeService(baseDir) as any;
        assert.equal(restarted.configStore.load().detailedLogging, 'off');
        assert.equal(isDetailedLogging(), false);
        assert.ok(lines.some((line) => /detailed logging: off \(its 24 hours are up\)/.test(line)));

        assert.equal(statSync(join(baseDir, 'config.json')).mode & 0o777, 0o600, 'config.json is yours only');
        await service.shutdown();
    } finally {
        console.log = original;
        setDetailedLogging(0);
        rmSync(baseDir, { recursive: true, force: true });
    }
});

test('an older config.json readable by others is restricted at start', async () => {
    stubElectron();
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { ConfigStore } = require('../src/main/config-store') as typeof import('../src/main/config-store');
    const baseDir = mkdtempSync(join(tmpdir(), 'neutron-calendar-bridge-config-'));
    try {
        writeFileSync(join(baseDir, 'config.json'), '{"invitationEmailAllowlist":["anna@example.org"]}\n', { mode: 0o644 });
        const store = new ConfigStore(baseDir);
        assert.equal(statSync(join(baseDir, 'config.json')).mode & 0o777, 0o600, 'before anything is saved');
        store.update({ theme: 'dark' });
        assert.equal(statSync(join(baseDir, 'config.json')).mode & 0o777, 0o600);
        assert.deepEqual(store.load().invitationEmailAllowlist, ['anna@example.org']);
        assert.equal(store.load().notificationTitles, true, 'titles in notifications: on by default');
    } finally {
        rmSync(baseDir, { recursive: true, force: true });
    }
});

test('notifications without titles: no event or calendar name, no addresses', async () => {
    stubElectron();
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { BridgeService } = require('../src/main/bridge-service') as typeof import('../src/main/bridge-service');
    const baseDir = mkdtempSync(join(tmpdir(), 'neutron-calendar-bridge-notes-'));
    const original = console.log;
    console.log = () => undefined;
    try {
        const service = new BridgeService(baseDir) as any;
        await service.initialize();
        const notes: any[] = [];
        service.onNotify = (note: any) => notes.push(note);
        const note = {
            key: 'unsent:x',
            title: 'Saved, but not every guest was emailed',
            subtitle: 'Dentist — Tobi (Private)',
            body: 'anna@example.org: refused by Proton',
            page: 'overview' as const
        };
        service.notify(note);
        assert.deepEqual(notes[0], note, 'shown in full by default');

        await service.updateConfig({ notificationTitles: false });
        service.notify(note);
        assert.deepEqual(notes[1], { ...note, subtitle: undefined, body: '(address hidden): refused by Proton' });
        await assert.rejects(service.updateConfig({ notificationTitles: 'no' }), /notificationTitles must be true or false/);
        await service.shutdown();
    } finally {
        console.log = original;
        rmSync(baseDir, { recursive: true, force: true });
    }
});

test("the bridge's own log lines: titles, subjects, email text and calendar names only with detailed logging", async () => {
    stubElectron();
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { BridgeService } = require('../src/main/bridge-service') as typeof import('../src/main/bridge-service');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { CalDAVServer } = require('../src/main/caldav-server') as typeof import('../src/main/caldav-server');
    const baseDir = mkdtempSync(join(tmpdir(), 'neutron-calendar-bridge-lines-'));
    const lines: string[] = [];
    const original = { log: console.log, warn: console.warn, error: console.error };
    console.log = (...parts: unknown[]) => lines.push(parts.join(' '));
    console.warn = console.log;
    console.error = console.log;
    try {
        const service = new BridgeService(baseDir) as any;
        await service.initialize();
        service.recordInvitationEmail({
            at: new Date().toISOString(),
            method: 'REQUEST',
            kind: 'invitation',
            from: 'tobi@proton.me',
            to: [{ email: 'anna@example.org', name: 'Anna', delivery: 'plain' }],
            subject: 'Invitation: Dentist with Dr. Hendriks',
            eventTitle: 'Dentist with Dr. Hendriks',
            outcome: 'dry-run',
            preview: { body: 'Hi Anna, see you at the dentist.', ics: 'BEGIN:VCALENDAR\r\nSUMMARY:Dentist with Dr. Hendriks\r\nEND:VCALENDAR' }
        });
        const quiet = lines.map((line) => logLine(line, false)).join('\n');
        assert.doesNotMatch(quiet, /Dentist|Hendriks|see you|anna@|tobi@|VCALENDAR/);
        assert.match(quiet, /dry-run: REQUEST invitation from ‹address [0-9a-f]{4}› to ‹address [0-9a-f]{4}› \(plain\) for "‹private›"/);
        assert.match(quiet, /the email that would have been sent \(shown with detailed logging\):‹private›/);
        const detailed = lines.map((line) => logLine(line, true)).join('\n');
        assert.match(detailed, /Subject: Invitation: Dentist with Dr\. Hendriks\n\nHi Anna, see you at the dentist\./);

        // Calendar.app's requests: the calendar and the event in the path are private.
        const server = new CalDAVServer(service);
        service.configStore.update({ caldavPort: 32999 });
        await server.start();
        try {
            const { username, password } = service.getCalDAVConfig();
            lines.length = 0;
            await fetch(`http://127.0.0.1:32999/calendars/${username}/tobi-private/dentist-uid.ics`, {
                headers: { Authorization: `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}` }
            });
            const requestLine = lines.find((line) => line.startsWith('[caldav] GET'))!;
            assert.equal(
                logLine(requestLine, false).replace(/ -> \d+.*/, ''),
                `[caldav] GET /calendars/${username}/‹private›/‹private›`,
                'the calendar and event are left out'
            );
            assert.match(logLine(requestLine, true), /\/tobi-private\/dentist-uid\.ics -> /);
        } finally {
            await server.stop();
        }
        await service.shutdown();
    } finally {
        Object.assign(console, original);
        rmSync(baseDir, { recursive: true, force: true });
    }
});
