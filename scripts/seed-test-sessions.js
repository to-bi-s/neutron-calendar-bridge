#!/usr/bin/env electron
/**
 * Seeds the Proton sessions the library's live tests resume (0.50).
 *
 *   npm run seed:sessions                 every account in the accounts file that has a password
 *   npm run seed:sessions -- organizer    only this role (organizer, protonGuest, twoFactor)
 *   npm run seed:sessions -- --force      sign in anew even where the saved session still works
 *
 * Since 0.50 the library speaks to Proton under its own identity only, and Proton answers a password
 * sign-in under it with a CAPTCHA that no script can solve. So this signs each test account in once,
 * by hand: the password sign-in is tried, Proton's CAPTCHA is shown in an Electron window (the same
 * page the bridge shows), the second factor comes from `totpSecret` in the file or is asked on the
 * terminal, and the session Proton opens (UID, tokens, key password) is written into the accounts
 * file as the account's `session`. The live tests resume it and write every renewal back; nothing
 * ends it. Run again when a run says the session is gone (Proton ends sessions that were not used
 * for long, or when you signed out of the account elsewhere).
 *
 * Accounts: NEUTRON_TEST_ACCOUNTS (default ~/Proton/.neutron-test-accounts.json). Test accounts only:
 * the usernames must contain "test". Passwords and tokens are never printed. The library's state goes
 * to NEUTRON_TEST_STATE (default ~/.cache/neutron-live-tests), where the live tests keep theirs.
 */
const { app, BrowserWindow, nativeTheme } = require('electron');
const { createHmac } = require('node:crypto');
const { existsSync, readFileSync, renameSync, statSync, writeFileSync } = require('node:fs');
const { homedir } = require('node:os');
const { join } = require('node:path');
const { pathToFileURL } = require('node:url');
const readline = require('node:readline');

const args = process.argv.slice(process.defaultApp ? 2 : 1).filter((arg) => arg !== '.');
const force = args.includes('--force');
const chosenRoles = args.filter((arg) => !arg.startsWith('--'));
const ROLES = ['organizer', 'protonGuest', 'twoFactor'];
const ACCOUNTS_PATH = process.env.NEUTRON_TEST_ACCOUNTS || join(homedir(), 'Proton', '.neutron-test-accounts.json');
const STATE_DIR = process.env.NEUTRON_TEST_STATE || join(homedir(), '.cache', 'neutron-live-tests');
process.env.PROTON_CALENDAR_CLIENT_STATE_DIR = STATE_DIR;
const LIBRARY = join(__dirname, '..', 'client', 'dist', 'index.mjs');

const fail = (message, code = 2) => {
    console.error(message);
    app.exit(code);
    process.exit(code);
};

for (const role of chosenRoles) {
    if (!ROLES.includes(role)) fail(`Unknown role "${role}" (known: ${ROLES.join(', ')})`);
}
if (!existsSync(LIBRARY)) fail(`${LIBRARY} is missing: build the library first (npm run build -w client)`);

let accounts;
try {
    accounts = JSON.parse(readFileSync(ACCOUNTS_PATH, 'utf8'));
} catch (error) {
    fail(`${ACCOUNTS_PATH}: cannot be read or is not valid JSON (${error.code || error.message})`);
}
if ((statSync(ACCOUNTS_PATH).mode & 0o077) !== 0) {
    console.warn(`warning: ${ACCOUNTS_PATH} is readable by others (chmod 600 it)`);
}

/** Never let a password or a token reach the output. */
const secrets = new Set();
const noteSecrets = (account) => {
    for (const value of [account?.password, account?.totpSecret, account?.session?.AccessToken, account?.session?.RefreshToken, account?.session?.keyPassword]) {
        if (value) secrets.add(String(value));
    }
};
const redact = (text) => [...secrets].reduce((value, secret) => value.split(secret).join('<secret>'), String(text));

const roles = (chosenRoles.length ? chosenRoles : ROLES).filter((role) => {
    const account = accounts[role];
    if (!account?.username) {
        if (chosenRoles.includes(role)) fail(`${ACCOUNTS_PATH}: "${role}" needs username and password`);
        return false;
    }
    if (!/test/i.test(account.username)) fail(`${ACCOUNTS_PATH}: "${role}" (${account.username}) does not look like a test account; refusing`);
    if (!account.password) {
        if (chosenRoles.includes(role)) fail(`${ACCOUNTS_PATH}: "${role}" has no password to sign in with`);
        return false;
    }
    noteSecrets(account);
    return true;
});
if (!roles.length) fail(`${ACCOUNTS_PATH}: no account with username and password`);

const saveSession = (role, session) => {
    accounts[role].session = {
        UID: session.UID,
        AccessToken: session.AccessToken,
        RefreshToken: session.RefreshToken,
        ...(session.keyPassword ? { keyPassword: session.keyPassword } : {}),
        ...(session.passwordMode ? { passwordMode: session.passwordMode } : {}),
        savedAt: new Date().toISOString()
    };
    noteSecrets(accounts[role]);
    const temporary = `${ACCOUNTS_PATH}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(accounts, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, ACCOUNTS_PATH);
};

/** An authenticator code (RFC 6238, SHA-1, 6 digits, 30 s) from a base32 secret; never printed. */
const totpCode = (secret, at = Date.now()) => {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    const clean = secret.toUpperCase().replace(/[^A-Z2-7]/g, '');
    const bits = [...clean].map((char) => alphabet.indexOf(char).toString(2).padStart(5, '0')).join('');
    const key = Buffer.from(bits.slice(0, bits.length - (bits.length % 8)).match(/.{8}/g).map((byte) => parseInt(byte, 2)));
    const counter = Buffer.alloc(8);
    counter.writeBigUInt64BE(BigInt(Math.floor(at / 30_000)));
    const digest = createHmac('sha1', key).update(counter).digest();
    const offset = digest[digest.length - 1] & 0x0f;
    return ((digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).toString().padStart(6, '0');
};

const ask = (question) =>
    new Promise((resolve) => {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        rl.question(question, (answer) => {
            rl.close();
            resolve(answer.trim());
        });
    });

// ---------------------------------------------------------------------------------------------
// Proton's CAPTCHA in a window (the bridge's verification page, reduced)

const MESSAGE_PREFIX = '__seed_verification__:';

const captchaUrl = (token, dark) => {
    const url = new URL('/core/v4/captcha', 'https://mail-api.proton.me');
    url.searchParams.set('Token', token);
    url.searchParams.set('ForceWebMessaging', '1');
    if (dark) url.searchParams.set('Dark', 'true');
    return url.toString();
};

/** Shows Proton's CAPTCHA for the challenge; resolves with the token once it is solved, null when the window is closed. */
const solveCaptcha = (role, challenge) =>
    new Promise((resolve, reject) => {
        const dark = nativeTheme.shouldUseDarkColors;
        const window = new BrowserWindow({
            width: 860,
            height: 820,
            title: `Proton verification — ${role}`,
            backgroundColor: dark ? '#1c1b22' : '#f6f4ff',
            webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true }
        });
        let done = false;
        const finish = (value) => {
            if (done) return;
            done = true;
            if (!window.isDestroyed()) window.close();
            resolve(value);
        };
        window.on('closed', () => finish(null));
        window.webContents.on('console-message', (event) => {
            const text = event?.message;
            if (typeof text !== 'string' || !text.startsWith(MESSAGE_PREFIX)) return;
            try {
                const data = JSON.parse(text.slice(MESSAGE_PREFIX.length));
                if (data?.type === 'pm_height' && Number.isFinite(data.height)) {
                    const [width] = window.getSize();
                    window.setSize(width, Math.max(720, Math.min(1000, Math.ceil(Number(data.height)) + 300)));
                } else if (data?.type === 'pm_captcha' && typeof data.token === 'string') {
                    finish(data.token);
                }
            } catch {
                // not ours
            }
        });
        const page = `<!doctype html><html><head><meta charset="utf-8"><title>Proton verification</title><style>
            body{margin:0;min-height:100vh;display:grid;place-items:start center;padding:32px 16px;box-sizing:border-box;
            font-family:-apple-system,BlinkMacSystemFont,sans-serif;background:${dark ? '#1c1b22' : '#f6f4ff'};color:${dark ? '#e8e6f0' : '#262a33'}}
            .card{width:min(760px,100%);padding:28px;border-radius:22px;background:${dark ? '#26242f' : '#ffffff'};box-shadow:0 18px 50px rgba(20,16,40,.16)}
            .kicker{margin:0 0 6px;font-size:.78rem;letter-spacing:.14em;text-transform:uppercase;color:${dark ? '#a9a4c2' : '#6c6785'}}
            h1{margin:0 0 8px;font-size:1.5rem}p{margin:0;line-height:1.5}
            iframe{width:100%;height:520px;margin-top:20px;border:0;border-radius:18px;background:${dark ? '#26242f' : '#ffffff'}}
        </style></head><body><main class="card"><p class="kicker">Live tests · ${role}</p><h1>Finish sign-in</h1>
        <p>Complete Proton's verification step below. The session is then written to the accounts file.</p>
        <iframe id="captcha-frame" title="Proton verification" sandbox="allow-scripts allow-same-origin allow-popups" src="${captchaUrl(challenge.token, dark)}"></iframe>
        </main></body></html>`;
        const listener = `
            window.addEventListener('message', (event) => {
                let data = event.data;
                if (typeof data === 'string') { try { data = JSON.parse(data); } catch { return; } }
                if (!data || typeof data !== 'object' || !data.type) return;
                console.log(${JSON.stringify(MESSAGE_PREFIX)} + JSON.stringify(data));
            });`;
        (async () => {
            // Proton Mail's web app first, for the CAPTCHA's origin; then the page is replaced.
            await window.loadURL('https://mail.proton.me');
            if (done) return;
            await window.webContents.executeJavaScript(`document.open(); document.write(${JSON.stringify(page)}); document.close();`, true);
            await window.webContents.executeJavaScript(listener, true);
            window.focus();
        })().catch((error) => {
            if (!done) {
                done = true;
                if (!window.isDestroyed()) window.close();
                reject(error);
            }
        });
    });

// ---------------------------------------------------------------------------------------------

const seed = async (role, createProtonCalendarAPI) => {
    const account = accounts[role];
    let saved = null;
    const onSession = (session) => {
        saved = session;
        saveSession(role, session);
    };
    if (!force && account.session?.UID && account.session.AccessToken && account.session.RefreshToken) {
        try {
            const api = await createProtonCalendarAPI({ username: account.username, password: '', session: { ...account.session }, onSession });
            const calendars = await api.listCalendars();
            console.log(`${role}: the saved session still works (${calendars.length} calendar(s)); kept${saved ? ', renewed' : ''}. (--force signs in anew.)`);
            return;
        } catch (error) {
            console.log(`${role}: the saved session no longer works (${redact(error?.message || error)}); signing in`);
        }
    }
    const askSecondFactor = async (request) => {
        if (!request.totp) {
            console.error(`${role}: Proton asks for a security key, which this cannot answer`);
            return null;
        }
        if (account.totpSecret) {
            if (request.wrong) {
                console.error(`${role}: the code from totpSecret was refused`);
                return null;
            }
            return { code: totpCode(account.totpSecret) };
        }
        const code = await ask(`${role}: authenticator code${request.wrong ? ' (the last one was wrong)' : ''}: `);
        return code ? { code } : null;
    };
    let humanVerification = null;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
        try {
            const api = await createProtonCalendarAPI({ username: account.username, password: account.password, humanVerification, askSecondFactor, onSession });
            const calendars = await api.listCalendars();
            if (!saved?.RefreshToken) throw new Error('no session was handed over');
            console.log(`${role}: signed in as ${account.username} (${calendars.length} calendar(s)); the session is in ${ACCOUNTS_PATH}`);
            return;
        } catch (error) {
            if (error?.name === 'HumanVerificationRequiredError' && error.challenge?.token) {
                console.log(`${role}: Proton asks for a CAPTCHA — solve it in the window`);
                const token = await solveCaptcha(role, error.challenge);
                if (!token) throw new Error(`${role}: the verification window was closed`);
                humanVerification = { ...error.challenge, token, tokenType: 'captcha' };
                continue;
            }
            throw new Error(`${role}: sign-in failed: ${redact(error?.message || error)}`);
        }
    }
    throw new Error(`${role}: Proton kept asking for verification`);
};

app.on('window-all-closed', () => undefined);
app.whenReady()
    .then(async () => {
        const { createProtonCalendarAPI } = await import(pathToFileURL(LIBRARY).href);
        let failed = false;
        for (const role of roles) {
            try {
                await seed(role, createProtonCalendarAPI);
            } catch (error) {
                failed = true;
                console.error(redact(error?.message || error));
            }
            if (role !== roles[roles.length - 1]) await new Promise((resolve) => setTimeout(resolve, 3000)); // spread the sign-ins out
        }
        app.exit(failed ? 1 : 0);
    })
    .catch((error) => {
        console.error(redact(error?.stack || error?.message || error));
        app.exit(1);
    });
