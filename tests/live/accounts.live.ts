/**
 * Live run for several accounts (0.36): two test accounts signed in side by side through the real
 * AccountManager, BridgeServices and CalDAV server (no Electron window; safeStorage faked, the
 * temporary app folder removed at the end). Checks that each account syncs its own calendars into
 * its own local copy, that the CalDAV server tells the two principals apart (each password opens
 * its own account only), that an app-wide setting reaches both, and that signing out keeps the
 * account while removing deletes it.
 *   NEUTRON_TEST_ACCOUNTS=~/Proton/.neutron-test-accounts.json npx tsx tests/live/accounts.live.ts
 * Credentials never leave the process; nothing of them is printed.
 *
 * 0.50: the accounts are signed in by resuming the sessions seeded with `npm run seed:sessions`
 * (a password sign-in under the bridge's own identity would need Proton's CAPTCHA). Signing out
 * and removing here keep the sessions alive at Proton (the adapter's sign-out is told not to end
 * them), and the newest tokens are written back to the accounts file, so the next run resumes them.
 */
import { mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { fakeSafeStorage } from '../support/fake-safe-storage';
import { basicAuth } from '../support/caldav-login';

const stubElectron = () => {
    const resolved = require.resolve('electron');
    require.cache[resolved] = {
        id: resolved,
        filename: resolved,
        loaded: true,
        exports: { app: { setLoginItemSettings: () => undefined, isPackaged: false, getLocale: () => 'en-GB' }, safeStorage: fakeSafeStorage }
    } as unknown as NodeJS.Module;
};
stubElectron();

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { AccountManager } = require('../../src/main/accounts') as typeof import('../../src/main/accounts');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { CalDAVServer } = require('../../src/main/caldav-server') as typeof import('../../src/main/caldav-server');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { logPrefix } = require('../../src/main/account-context') as typeof import('../../src/main/account-context');

// The log sink as main.ts has it (0.36.4): lines from an account's service carry its tag.
const taggedLines: string[] = [];
for (const level of ['log', 'warn', 'error'] as const) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
        const line = `${logPrefix()}${args.map(String).join(' ')}`;
        taggedLines.push(line);
        original(line);
    };
}

const PORT = 33190;
const file = process.env.NEUTRON_TEST_ACCOUNTS;
if (!file) {
    console.error('NEUTRON_TEST_ACCOUNTS must point at the credentials file');
    process.exit(2);
}
type SeededSession = { UID: string; AccessToken: string; RefreshToken: string; keyPassword?: string; passwordMode?: number; savedAt?: string };
type Account = { username: string; password?: string; session?: SeededSession };
const credentials = JSON.parse(readFileSync(file, 'utf8')) as Record<string, Account>;
const organizer = credentials.organizer;
const guest = credentials.protonGuest;
const seeded = (account?: Account) => Boolean(account?.username && account.session?.UID && account.session.AccessToken && account.session.RefreshToken);
if (!seeded(organizer) || !seeded(guest)) {
    console.error('the credentials file needs organizer and protonGuest with seeded sessions (npm run seed:sessions)');
    process.exit(2);
}
if (![organizer, guest].every((account) => /test/i.test(account.username))) {
    console.error('the accounts do not look like test accounts; refusing to run');
    process.exit(2);
}
/** The newest session of an account, back into the accounts file (refresh tokens are single-use). */
const writeBack = (role: 'organizer' | 'protonGuest', session: SeededSession | null | undefined) => {
    if (!session?.RefreshToken) return;
    const { UID, AccessToken, RefreshToken, keyPassword, passwordMode } = session;
    credentials[role].session = { UID, AccessToken, RefreshToken, ...(keyPassword ? { keyPassword } : {}), ...(passwordMode ? { passwordMode } : {}), savedAt: new Date().toISOString() };
    writeFileSync(`${file}.tmp`, `${JSON.stringify(credentials, null, 2)}\n`, { mode: 0o600 });
    renameSync(`${file}.tmp`, file);
};

let failures = 0;
const check = (name: string, condition: unknown, detail = '') => {
    console.log(`${condition ? 'ok  ' : 'FAIL'} ${name}${!condition && detail ? ` — ${detail}` : ''}`);
    if (!condition) failures += 1;
};
const until = async (what: string, condition: () => boolean | Promise<boolean>, ms = 120_000) => {
    const started = Date.now();
    while (Date.now() - started < ms) {
        if (await condition()) return true;
        await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    console.log(`     (timed out waiting for ${what})`);
    return false;
};

const main = async () => {
    const userData = mkdtempSync(join(tmpdir(), 'neutron-live-accounts-'));
    const notes: Array<{ key: string; subtitle?: string; body: string }> = [];
    const manager = new AccountManager(userData, { appVersion: '0.36.0', onNotify: (note) => notes.push(note) });
    manager.sharedConfig.update({ caldavPort: PORT });
    const server = new CalDAVServer({ list: () => manager.list(), byUsername: (name) => manager.byUsername(name), any: () => manager.serviceOf(null), listenOn: () => manager.listenOn() });
    /** Resumes an account's seeded session in a service (no password sign-in; the session stays Proton's). */
    const resume = async (service: any, role: 'organizer' | 'protonGuest') => {
        const account = credentials[role];
        // Signing out must not end the seeded session at Proton: the next run resumes it.
        const adapter = service.protonAdapter;
        const signOut = adapter.signOut.bind(adapter);
        adapter.signOut = (_end?: boolean, onlyGeneration?: number) => signOut(false, onlyGeneration);
        await service.signIn({ username: account.username, password: '' }, true, null, { username: account.username, ...account.session, identity: 'own' });
    };
    /** Before an account's session store goes (sign-out, removal): its newest tokens into the accounts file. */
    const keep = async (service: any, role: 'organizer' | 'protonGuest') => writeBack(role, await service.secretStore.getProtonSession());
    try {
        await manager.initialize();
        await server.start();
        check('no account at first', manager.count() === 0);

        // The first account: the organizer.
        console.log('signing the organizer in…');
        await resume(await manager.signingIn(), 'organizer');
        check('organizer adopted', manager.count() === 1);
        const first = manager.list()[0];
        check('organizer label is its address', (first.accountLabel() || '').includes('@'), first.accountLabel() ? 'has a label' : 'no label');
        await until('organizer calendars', async () => (await first.getBridgeState()).calendars.length > 0);
        const firstState = await first.getBridgeState();
        check('organizer has calendars in its local copy', firstState.calendars.length > 0, `${firstState.calendars.length}`);
        check('organizer healthy', firstState.health === 'healthy' || firstState.health === 'syncing', firstState.message);

        // The second: the Proton guest, through Add Account.
        manager.addAccount();
        check('sign-in page open while adding', Boolean((await manager.getAppState()).signingIn));
        console.log('signing the guest in…');
        await resume(await manager.signingIn(), 'protonGuest');
        check('guest adopted', manager.count() === 2);
        const second = manager.list()[1];
        check('two different principals', first.getCalDAVConfig().username !== second.getCalDAVConfig().username);
        check('two different CalDAV passwords', first.getCalDAVConfig().password !== second.getCalDAVConfig().password);
        await until('guest calendars', async () => (await second.getBridgeState()).calendars.length > 0);
        const secondState = await second.getBridgeState();
        check('guest has calendars in its local copy', secondState.calendars.length > 0, `${secondState.calendars.length}`);
        const firstIds = new Set(firstState.calendars.map((calendar) => calendar.protonCalendarId));
        check('the local copies hold different calendars', secondState.calendars.every((calendar) => !firstIds.has(calendar.protonCalendarId)));
        check('both state cards', (await manager.getAppState()).accounts.length === 2);

        // CalDAV: each password opens its own calendar home only; the homes list different calendars.
        const base = `http://127.0.0.1:${PORT}`;
        const home = async (service: typeof first, password: string) => {
            const name = service.getCalDAVConfig().username;
            const response = await fetch(`${base}/calendars/${name}/`, { method: 'PROPFIND', headers: { Authorization: basicAuth(name, password), Depth: '1' }, body: '<D:propfind xmlns:D="DAV:"><D:prop><D:displayname/><D:resourcetype/></D:prop></D:propfind>' });
            return { status: response.status, text: await response.text() };
        };
        const firstHome = await home(first, first.getCalDAVConfig().password);
        const secondHome = await home(second, second.getCalDAVConfig().password);
        check('organizer home served', firstHome.status === 207, String(firstHome.status));
        check('guest home served', secondHome.status === 207, String(secondHome.status));
        const hrefs = (text: string) => [...text.matchAll(/<D:href>([^<]+)<\/D:href>/g)].map((match) => match[1]).filter((href) => href.split('/').length > 4);
        const firstHrefs = hrefs(firstHome.text);
        const secondHrefs = hrefs(secondHome.text);
        check('organizer home lists its calendars', firstHrefs.length >= firstState.calendars.filter((calendar) => calendar.syncEnabled).length - 1 && firstHrefs.every((href) => href.includes(`/calendars/${first.getCalDAVConfig().username}/`)), firstHrefs.join(' '));
        check('guest home lists its calendars', secondHrefs.length > 0 && secondHrefs.every((href) => href.includes(`/calendars/${second.getCalDAVConfig().username}/`)), secondHrefs.join(' '));
        const crossed = await home(second, first.getCalDAVConfig().password);
        check("the organizer's password does not open the guest's home", crossed.status === 401, String(crossed.status));
        const events = await fetch(`${base}${secondHrefs[0]}`, { method: 'REPORT', headers: { Authorization: basicAuth(second.getCalDAVConfig().username, second.getCalDAVConfig().password), Depth: '1' }, body: '<C:calendar-query xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav"><D:prop><D:getetag/></D:prop><C:filter><C:comp-filter name="VCALENDAR"><C:comp-filter name="VEVENT"/></C:comp-filter></C:filter></C:calendar-query>' });
        check("a guest calendar answers a calendar-query", events.status === 207, String(events.status));

        // The log names the accounts.
        const tagged = taggedLines.filter((line) => /^\[a:[0-9a-f]{4}\] \[(proton|sync|calendars|mirror|outbox)\]/.test(line));
        check("the services' log lines carry their account's tag", tagged.length > 0 && new Set(tagged.map((line) => line.slice(0, 8))).size === 2, `${tagged.length} tagged, ${new Set(tagged.map((line) => line.slice(0, 8))).size} tag(s)`);
        check('CalDAV request lines name the account', taggedLines.some((line) => /\[caldav\] PROPFIND .* acct=a:[0-9a-f]{4}/.test(line)));

        // App-wide setting to both; a per-account one to one.
        await manager.updateConfig({ pollIntervalMs: 300_000 });
        check('app-wide setting on both', first.getConfigStore().load().pollIntervalMs === 300_000 && second.getConfigStore().load().pollIntervalMs === 300_000);
        await manager.updateConfig({ calendarEmailsFolder: 'LiveTest' }, second.accountId);
        check('per-account setting on one', second.getConfigStore().load().calendarEmailsFolder === 'LiveTest' && first.getConfigStore().load().calendarEmailsFolder === 'Calendar');

        // Notifications carry the address while there are two accounts.
        notes.length = 0;
        (second as any).notify({ key: 'live', title: 'Live', body: 'Test', page: 'overview' });
        check('notification names the account', notes.length === 1 && notes[0].subtitle === second.accountLabel() && notes[0].key.startsWith(`${second.accountId}:`));

        // Sign out keeps the account; sign in again; remove deletes it.
        await keep(second, 'protonGuest');
        await manager.signOutAccount(second.accountId!);
        check('signed out, still listed', manager.count() === 2 && !second.isSignedIn());
        check('its local copy is empty', (await second.getBridgeState()).calendars.length === 0);
        console.log('signing the guest in again…');
        await resume(await manager.signingIn(second.accountId), 'protonGuest');
        check('signed in again in place', second.isSignedIn() && manager.count() === 2);
        await keep(second, 'protonGuest');
        await manager.removeAccount(second.accountId!);
        check('removed', manager.count() === 1);
        const gone = await home(second, second.getCalDAVConfig().password).catch(() => ({ status: 0, text: '' }));
        check("the removed account's principal is gone", gone.status === 401 || gone.status === 503 || gone.status === 404, String(gone.status));

        // The remaining account still works.
        const stillThere = await home(first, first.getCalDAVConfig().password);
        check('the organizer still served', stillThere.status === 207);
        await keep(first, 'organizer');
        await manager.signOutAccount(first.accountId!);
        await manager.removeAccount(first.accountId!);
        check('all gone', manager.count() === 0);
    } finally {
        await server.stop().catch(() => undefined);
        await manager.shutdown().catch(() => undefined);
        rmSync(userData, { recursive: true, force: true });
    }
    console.log(failures ? `${failures} check(s) failed` : 'all checks passed');
    process.exit(failures ? 1 : 0);
};

main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
});
