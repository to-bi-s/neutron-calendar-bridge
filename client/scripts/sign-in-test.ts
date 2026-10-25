/**
 * Offline test for the sign-in steps added in 0.27 (roadmap stage 6): two-factor authentication,
 * two-password mode, and the key password kept with the session. A fake fetch; a real PGP key
 * locked with a real key password (so unlocking is not faked); no network, no account. Checks:
 * - the second factor: an authenticator code asked for (askSecondFactor), a refused code asked
 *   again with `wrong`, a one-shot code, giving up (TwoFactorRequiredError), the security-key-only
 *   message; the code never logged;
 * - one password: the key password derived from the login password and the primary key's salt;
 * - two passwords: the mailbox password asked for, a wrong one asked again, giving up
 *   (MailboxPasswordRequiredError), a given mailboxPassword used without asking;
 * - resuming: a session saved with the key password needs no salts and no password; a saved key
 *   password that no longer unlocks the keys falls back to a password sign-in;
 * - onSession carries the key password and the password mode.
 */
import { CryptoProxy } from '@protontech/crypto';
import { computeKeyPassword } from '@protontech/crypto/srp';
import { loadCryptoWorker } from '@proton/shared/lib/helpers/setupCryptoWorker';

import { MailboxPasswordRequiredError, ProtonCalendarAPI, TwoFactorRequiredError } from '../src/proton-calendar-api.ts';
import { RequestControl } from '../src/request-control.ts';

let failures = 0;
const check = (condition: unknown, label: string) => {
    console.log(`${condition ? 'ok  ' : 'FAIL'} ${label}`);
    if (!condition) failures += 1;
};

const jsonResponse = (status: number, data: any) => ({
    status,
    ok: status >= 200 && status < 300,
    headers: { get: () => null },
    text: async () => JSON.stringify(data),
    arrayBuffer: async () => new ArrayBuffer(0)
});

const KEY_SALT = 'c2FsdHNhbHRzYWx0c2FsdA=='; // 16 bytes, base64 (24 characters)
const LOGIN_PASSWORD = 'login-secret';
const MAILBOX_PASSWORD = 'mailbox-secret';

const makeAccount = async (rawPassword: string) => {
    const keyPassword = await computeKeyPassword(rawPassword, KEY_SALT);
    const key = await CryptoProxy.generateKey({ userIDs: [{ name: 'Tobi', email: 'tobi@proton.test' }] });
    const privateKey = await CryptoProxy.exportPrivateKey({ privateKey: key, passphrase: keyPassword });
    return {
        keyPassword,
        user: { ID: 'user-1', Name: 'tobi', Keys: [{ ID: 'key-1', PrivateKey: privateKey, Primary: 1, Active: 1, Version: 3 }] },
        keySalts: [{ ID: 'key-1', KeySalt: KEY_SALT }]
    };
};

const makeApi = (credentials: any, account: Awaited<ReturnType<typeof makeAccount>>, options: { twoFactorEnabled?: number; passwordMode?: number; wrongCodes?: number } = {}) => {
    const api: any = new ProtonCalendarAPI({ username: 'tobi@proton.test', password: LOGIN_PASSWORD, ...credentials });
    api.control = new RequestControl({ random: () => 0.5, sleep: async () => undefined });
    const log: Array<{ path: string; body?: any; auth?: string }> = [];
    let refusals = options.wrongCodes ?? 0;
    api.fetchImpl = async (url: string, init: any) => {
        const path = new URL(url).pathname.replace(/^\/api/, '');
        const body = init.body ? JSON.parse(init.body) : undefined;
        log.push({ path, body, auth: init.headers?.Authorization });
        if (path.endsWith('/core/v4/auth/2fa')) {
            if (init.headers?.Authorization !== 'Bearer access-2fa') return jsonResponse(401, { Code: 401 });
            if (body.TwoFactorCode === '123456' && refusals-- <= 0) return jsonResponse(200, { Code: 1000, Scope: 'full' });
            return jsonResponse(422, { Code: 8002, Error: 'Incorrect login credentials. Please try again.' });
        }
        if (path.endsWith('/core/v4/users')) return jsonResponse(200, { Code: 1000, User: account.user });
        if (path.endsWith('/core/v4/addresses')) return jsonResponse(200, { Code: 1000, Addresses: [{ ID: 'ad-1', Email: 'tobi@proton.test', Keys: [], Status: 1, Receive: 1, Send: 1 }] });
        if (path.endsWith('/core/v4/keys/salts')) return jsonResponse(200, { Code: 1000, KeySalts: account.keySalts });
        if (path.endsWith('/calendar/v1')) return jsonResponse(200, { Code: 1000, Calendars: [{ ID: 'cal-1', Members: [{ ID: 'm', Name: 'Cal', Email: 'tobi@proton.test', Permissions: 127 }], Type: 0, Display: 1 }] });
        if (path.endsWith('/calendar/v2/cal-1/bootstrap')) return jsonResponse(500, { Code: 500, Error: 'not in this test' });
        return jsonResponse(404, { Code: 2501, Error: `no fake for ${path}` });
    };
    // The password sign-in itself (SRP) is Proton's code; here it hands over a session like Proton's
    // answer, with the second factor and the password mode of this account.
    api.authenticateDirect = async () => {
        api.control.noteSignIn();
        const session = { AccessToken: 'access-2fa', RefreshToken: 'refresh-1', UID: 'uid-1' };
        api.passwordMode = options.passwordMode ?? 1;
        const enabled = options.twoFactorEnabled ?? 0;
        if (enabled) {
            await api.completeSecondFactor(session, { totp: (enabled & 1) === 1, securityKey: (enabled & 2) === 2, securityKeyOptions: null });
        }
        return session;
    };
    return { api, log };
};

/** initialize() up to the keys (the calendar bootstrap is not part of this test). */
const signIn = async (api: any) => {
    try {
        await api.initialize();
    } catch (error: any) {
        if (!/Failed to get calendar bootstrap/.test(String(error?.message))) throw error;
    }
};

const main = async () => {
    await loadCryptoWorker();
    const onePassword = await makeAccount(LOGIN_PASSWORD);
    const twoPasswords = await makeAccount(MAILBOX_PASSWORD);

    console.log('--- one password, no second factor');
    {
        let saved: any = null;
        const { api, log } = makeApi({ onSession: (session: any) => (saved = session) }, onePassword);
        await signIn(api);
        check(api.userData?.userKeys?.length === 1, 'the keys are unlocked with the password-derived key password');
        check(api.keyPassword === onePassword.keyPassword, 'the key password is the one Proton derives (primary key salt)');
        check(saved?.keyPassword === onePassword.keyPassword && saved.passwordMode === 1 && saved.RefreshToken === 'refresh-1', 'onSession carries the key password and the password mode');
        check(log.some((entry) => entry.path.endsWith('/keys/salts')), 'the salts were read for the first sign-in');
        check(!log.some((entry) => entry.path.endsWith('/auth/2fa')), 'no second factor asked');
    }

    console.log('--- two-factor: authenticator code');
    {
        const asked: any[] = [];
        const codes = ['000000', '123456'];
        const { api, log } = makeApi({ askSecondFactor: async (request: any) => (asked.push(request), { code: codes.shift()! }) }, onePassword, { twoFactorEnabled: 1 });
        const lines: string[] = [];
        const warn = console.warn;
        console.warn = (...parts: unknown[]) => lines.push(parts.join(' '));
        try {
            await signIn(api);
        } finally {
            console.warn = warn;
        }
        check(asked.length === 2 && asked[0].totp && !asked[0].securityKey && !asked[0].wrong && asked[1].wrong, 'asked for a code; a refused one asked again with wrong: true');
        const sent = log.filter((entry) => entry.path.endsWith('/auth/2fa'));
        check(sent.length === 2 && sent[0].body.TwoFactorCode === '000000' && sent[1].body.TwoFactorCode === '123456' && sent.every((entry) => entry.auth === 'Bearer access-2fa'), 'both codes sent with the new session');
        check(api.userData?.userKeys?.length === 1, 'signed in after the right code');
        check(lines.some((line) => /second factor was refused/.test(line)) && !lines.some((line) => /000000|123456/.test(line)), 'the refusal is logged without the code');

        const oneShot = makeApi({ twoFactorCode: '123 456' }, onePassword, { twoFactorEnabled: 3 });
        await signIn(oneShot.api);
        check(oneShot.log.find((entry) => entry.path.endsWith('/auth/2fa'))?.body.TwoFactorCode === '123456', 'a one-shot code is used once, spaces removed');

        const giveUp = makeApi({ askSecondFactor: async () => null }, onePassword, { twoFactorEnabled: 1 });
        const error = await signIn(giveUp.api).catch((caught: any) => caught);
        check(error instanceof TwoFactorRequiredError && error.request.totp && !error.request.securityKey, `giving up: ${String(error?.message).slice(0, 80)}`);

        const none = makeApi({}, onePassword, { twoFactorEnabled: 2 });
        const keyOnly = await signIn(none.api).catch((caught: any) => caught);
        check(/security key only/.test(String(keyOnly?.message)), 'a security-key-only account is told what to do');
        check(!none.log.some((entry) => entry.path.endsWith('/auth/2fa')), 'nothing sent without an answer');

        const refusedForever = makeApi({ askSecondFactor: async (request: any) => (request.wrong ? null : { code: '999999' }) }, onePassword, { twoFactorEnabled: 1 });
        const refused = await signIn(refusedForever.api).catch((caught: any) => caught);
        check(/not accepted/.test(String(refused?.message)), 'giving up after a refused code says so');
    }

    console.log('--- two-password mode');
    {
        const asked: any[] = [];
        const answers = ['wrong-mailbox', MAILBOX_PASSWORD];
        const { api, log } = makeApi({ askMailboxPassword: async (request: any) => (asked.push(request), answers.shift()!) }, twoPasswords, { passwordMode: 2 });
        const warn = console.warn;
        console.warn = () => undefined;
        try {
            await signIn(api);
        } finally {
            console.warn = warn;
        }
        check(asked.length === 2 && !asked[0].wrong && asked[1].wrong, 'the mailbox password asked for; a wrong one asked again');
        check(api.userData?.userKeys?.length === 1 && api.keyPassword === twoPasswords.keyPassword, 'the keys unlocked with the mailbox password');
        check(log.filter((entry) => entry.path.endsWith('/keys/salts')).length === 1, 'the salts read once');

        const given = makeApi({ mailboxPassword: MAILBOX_PASSWORD, askMailboxPassword: async () => (check(false, 'not asked when given'), null) }, twoPasswords, { passwordMode: 2 });
        await signIn(given.api);
        check(given.api.userData?.userKeys?.length === 1, 'a given mailbox password is used without asking');

        const giveUp = makeApi({ askMailboxPassword: async () => null }, twoPasswords, { passwordMode: 2 });
        const error = await signIn(giveUp.api).catch((caught: any) => caught);
        check(error instanceof MailboxPasswordRequiredError || /mailbox password/i.test(String(error?.message)), `giving up: ${String(error?.message).slice(0, 80)}`);

        const loginOnly = makeApi({}, twoPasswords, { passwordMode: 2 });
        const missing = await signIn(loginOnly.api).catch((caught: any) => caught);
        check(/mailbox password/i.test(String(missing?.message)) && !loginOnly.log.some((entry) => entry.path.endsWith('/auth/2fa')), 'without the mailbox password: told, nothing tried with the login password');
    }

    console.log('--- resuming with the key password');
    {
        const session = { UID: 'uid-1', AccessToken: 'access-2fa', RefreshToken: 'refresh-1', keyPassword: onePassword.keyPassword, passwordMode: 1 };
        const { api, log } = makeApi({ session, askSecondFactor: async () => (check(false, 'no second factor when resuming'), null) }, onePassword, { twoFactorEnabled: 1 });
        await signIn(api);
        check(api.userData?.userKeys?.length === 1, 'the keys unlocked with the saved key password');
        check(!log.some((entry) => entry.path.endsWith('/keys/salts')), 'no salts read (the renewed token would lack the scope)');
        check(api.getRequestStats().signIns === 0 && api.getRequestStats().resumedSession, 'no password sign-in');

        // Saved by an older version: no key password with the session; the password unlocks the keys.
        const older = makeApi({ session: { UID: 'uid-1', AccessToken: 'access-2fa', RefreshToken: 'refresh-1' } }, onePassword);
        await signIn(older.api);
        check(older.api.userData?.userKeys?.length === 1 && older.log.some((entry) => entry.path.endsWith('/keys/salts')) && older.api.getRequestStats().signIns === 0, 'an older saved session: salts and the password, still no sign-in');

        // The key password no longer fits (the password was changed): a password sign-in, with its second factor.
        const asked: any[] = [];
        const changed = makeApi({ session: { ...session, keyPassword: 'stale' }, askSecondFactor: async (request: any) => (asked.push(request), { code: '123456' }) }, onePassword, { twoFactorEnabled: 1 });
        const lines: string[] = [];
        const logger = console.log;
        console.log = (...parts: unknown[]) => lines.push(parts.join(' '));
        try {
            await signIn(changed.api);
        } finally {
            console.log = logger;
        }
        check(changed.api.userData?.userKeys?.length === 1 && changed.api.getRequestStats().signIns === 1 && asked.length === 1, 'a stale key password: signed in with the password and the code');
        check(lines.some((line) => /saved session cannot be used \(the keys could not be unlocked with the saved key password/.test(line)), 'the reason is logged');
    }

    console.log(failures ? `\n${failures} check(s) failed` : '\nAll sign-in checks passed');
    process.exit(failures ? 1 : 0);
};

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
