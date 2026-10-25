/**
 * Renderer smoke run for several accounts (0.36): loads the built window with a fake bridge API
 * (a preload of its own) and walks through the states the window must show — no account (sign-in
 * page), one account, two accounts (tabs, panel, Overview cards, switchers, Accounts card), adding
 * an account (sign-in page with a way back), an account asking for a code — checking the DOM and
 * writing a screenshot of each to a folder. Exit code 1 on a failed check or a renderer error.
 *   npm run build && xvfb-run -a electron tests/electron/renderer-accounts.harness.js [screenshot-dir]
 */
const { app, BrowserWindow, ipcMain } = require('electron');
const { mkdirSync, mkdtempSync, writeFileSync, copyFileSync, readFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');

const root = join(__dirname, '..', '..');
const dist = join(root, 'dist', 'renderer');
const shotsArg = process.argv.slice(2).filter((arg) => !arg.startsWith('-') && !arg.endsWith('.harness.js')).pop();
const shots = shotsArg ? resolve(shotsArg) : null;

app.on('window-all-closed', () => undefined);

const account = (id, label, extra = {}) => ({
    accountId: id,
    accountLabel: label,
    health: 'healthy',
    signedIn: true,
    username: label,
    calendars: [
        { protonCalendarId: `${id}-c1`, slug: `${id}-personal`, displayName: `Personal (${label})`, color: '#6d4aff', kind: 'own', syncEnabled: true, status: 'ok', syncState: 'idle', lastPolledAt: Date.now() - 60_000, lastSyncedAt: Date.now() - 3_600_000 },
        { protonCalendarId: `${id}-c2`, slug: `${id}-work`, displayName: `Work (${label})`, color: '#10b981', kind: 'own', syncEnabled: true, status: 'warning', statusMessage: 'Refused once', syncState: 'idle', lastPolledAt: Date.now() - 60_000 }
    ],
    caldav: { host: '127.0.0.1', port: 31876, username: id === 'a1' ? 'neutron-calendar-bridge' : id, security: 'HTTP', baseUrl: 'http://127.0.0.1:31876', serverPath: `/principals/${id}/` },
    calendarApp: { lastRequestAt: Date.now() - 20_000, thisRun: true },
    // 0.49.1: a1 has Thunderbird connected and no other app; b2 saw BusyCal 5 h ago.
    thunderbird: { lastRequestAt: id === 'a1' ? Date.now() - 120_000 : null, thisRun: id === 'a1' },
    otherClient: id === 'a1' ? { lastRequestAt: null, thisRun: false, name: null } : { lastRequestAt: Date.now() - 5 * 3_600_000, thisRun: false, name: 'BusyCal' },
    calendarAppAccountName: label ? `Proton (${label})` : 'Proton',
    openAtLogin: false,
    openAtLoginNote: null,
    requestStats: null,
    pollIntervalMs: 60_000,
    eventLookbackDays: 365,
    eventLookaheadDays: 730,
    theme: 'system',
    appLanguage: 'en',
    language: 'en',
    appLanguages: [{ code: 'en', name: 'English' }, { code: 'de', name: 'Deutsch' }],
    lastSuccessfulSyncAt: Date.now() - 90_000,
    lastAttemptedSyncAt: Date.now() - 90_000,
    message: 'Bridge connected',
    pendingHumanVerification: null,
    pendingChanges: 0,
    signInPrompt: null,
    signInMethod: 'password',
    syncStats: { totalEvents: 12, syncedEvents: 12, failedEvents: 0, lastDirection: 'pull' },
    recentCalDAVErrors: [],
    localCopyNote: null,
    caldavLogin: null,
    appVersion: '0.36.0',
    invitationEmailMode: 'live',
    invitationEmailModeSetting: 'live',
    invitationEmailAllowlist: [],
    invitationEmailLanguage: 'proton',
    invitationEmailLanguages: [{ code: 'en_US', name: 'English' }, { code: 'de_DE', name: 'Deutsch' }],
    protonInviteLanguage: 'en_US',
    invitationsSupported: true,
    developerMode: false,
    applyEmailedAnswers: false,
    emailedAnswersSupported: true,
    recentInvitationEmails: [],
    calendarEmailsAfter: 'leave',
    calendarEmailsFolder: 'Calendar',
    calendarEmailsSupported: true,
    calendarEmailsStatus: null,
    notifications: true,
    notificationTitles: true,
    detailedLogging: 'off',
    detailedLoggingUntil: null,
    ...extra
});

const signingIn = (extra = {}) => account(null, null, { signedIn: false, health: 'disconnected', message: 'Signed out', calendars: [], lastSuccessfulSyncAt: null, calendarApp: { lastRequestAt: null, thisRun: false }, ...extra });

/** The states the window is walked through. */
const scenarios = {
    none: { accounts: [], signingIn: signingIn(), addingAccount: false },
    one: { accounts: [account('a1', 'tobi@proton.me')], signingIn: null, addingAccount: false },
    two: {
        // b2: Calendar.app was seen in this run, but 4 hours ago (its profile removed) → "Quiet", not "Connected" (0.37.9).
        accounts: [account('a1', 'tobi@proton.me'), account('b2', 'work@proton.me', { health: 'syncing', message: 'Syncing 2 calendars…', pendingChanges: 2, recentCalDAVErrors: [{ at: Date.now() - 5000, method: 'PUT', path: '/calendars/b2/b2-work/x.ics', status: 403, message: 'Nope' }], calendarApp: { lastRequestAt: Date.now() - 4 * 3_600_000, thisRun: true } })],
        signingIn: null,
        addingAccount: false
    },
    adding: { accounts: [account('a1', 'tobi@proton.me'), account('b2', 'work@proton.me')], signingIn: signingIn(), addingAccount: true },
    prompt: { accounts: [account('a1', 'tobi@proton.me'), account('b2', 'work@proton.me', { signedIn: false, health: 'connecting', message: 'Connecting to Proton…', signInPrompt: { kind: 'second-factor', wrong: false, expiresAt: Date.now() + 60_000, background: true } })], signingIn: null, addingAccount: false },
    signedOut: { accounts: [account('a1', 'tobi@proton.me'), account('b2', 'work@proton.me', { signedIn: false, health: 'error', message: 'Proton ended the session. Sign in again on the Setup page.' })], signingIn: null, addingAccount: false },
};

let current = scenarios.none;
const calls = [];

const main = async () => {
    const dir = mkdtempSync(join(tmpdir(), 'renderer-accounts-'));
    for (const file of ['index.html', 'renderer.js', 'i18n.js', 'styles.css']) copyFileSync(join(dist, file), join(dir, file));
    // A preload with the fake API: every call is recorded; the state is whatever the scenario says.
    writeFileSync(
        join(dir, 'preload.js'),
        `const { contextBridge, ipcRenderer } = require('electron');
const call = (name) => (...args) => ipcRenderer.invoke('fake', name, args);
const api = {};
for (const name of ['signIn','completeHumanVerification','cancelHumanVerification','answerSignInPrompt','cancelSignInPrompt','addAccount','cancelAddAccount','signOut','setAccountOrder','getBridgeState','getCalendars','getCalDAVConfig','refreshNow','setUpCalendarApp','openProfilesSettings','getTranslations','setOpenAtLogin','setCalendarSyncEnabled','getSyncStatus','openHumanVerification','openExternal','updateConfig','syncCalendar','syncCategory','getChangelog','deleteLogs','copyCalDAVPassword']) api[name] = call(name);
api.onNavigate = (callback) => ipcRenderer.on('navigate', (_e, page, accountId) => callback(page, accountId));
api.onStateChanged = (callback) => ipcRenderer.on('state-changed', () => callback());
contextBridge.exposeInMainWorld('bridgeApi', api);`
    );
    ipcMain.handle('fake', async (_event, name, args) => {
        calls.push([name, ...args]);
        switch (name) {
            case 'getBridgeState':
                return current;
            case 'getCalDAVConfig':
                return { host: '127.0.0.1', port: 31876, username: args[0] || 'new', password: 'secret', security: 'HTTP', baseUrl: 'http://127.0.0.1:31876', serverPath: `/principals/${args[0] || 'new'}/` };
            case 'getTranslations':
                return { language: 'en', catalog: {}, locale: 'en-GB' };
            case 'getChangelog':
                return '';
            case 'setUpCalendarApp':
                return { opened: true, error: null };
            default:
                return current;
        }
    });

    const window = new BrowserWindow({ show: true, width: 1060, height: 720, webPreferences: { contextIsolation: true, backgroundThrottling: false, preload: join(dir, 'preload.js') } });
    const errors = [];
    window.webContents.on('console-message', (event) => {
        if (event.level === 'error') errors.push(event.message);
    });
    await window.loadFile(join(dir, 'index.html'));
    const run = (script) => window.webContents.executeJavaScript(script, true);
    const settle = () => new Promise((resolve) => setTimeout(resolve, 250));
    const rerender = async () => {
        window.webContents.send('state-changed');
        await settle();
    };
    const navigate = async (page, accountId = null) => {
        window.webContents.send('navigate', page, accountId);
        await settle();
    };
    let failures = 0;
    const check = (name, condition, detail = '') => {
        if (!condition) {
            failures += 1;
            console.log(`FAIL ${name}${detail ? `: ${detail}` : ''}`);
        } else {
            console.log(`ok   ${name}`);
        }
    };
    const shot = async (name) => {
        if (!shots) return;
        mkdirSync(shots, { recursive: true });
        const image = await window.webContents.capturePage();
        writeFileSync(join(shots, `${name}.png`), image.toPNG());
    };
    const q = (selector) => run(`document.querySelectorAll(${JSON.stringify(selector)}).length`);
    const text = (selector) => run(`(document.querySelector(${JSON.stringify(selector)}) || {}).textContent || ''`);
    const hidden = (selector) => run(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); return !el || el.hidden || el.closest('[hidden]') !== null; })()`);

    // No account: the sign-in page, no way back.
    await settle();
    check('none: sign-in page', !(await hidden('#auth-page')));
    check('none: dashboard hidden', await hidden('#dashboard-page'));
    check('none: no back link', await hidden('#auth-back-row'));
    await shot('01-none');

    // One account: as before — one Calendars tab, no address under it, one Overview card, no switchers.
    current = scenarios.one;
    await rerender();
    check('one: dashboard', !(await hidden('#dashboard-page')));
    check('one: one Calendars tab', (await q('#nav-calendar-tabs .nav-item')) === 1);
    check('one: no address under the tab', (await q('.nav-item-sub')) === 0);
    check('one: one account in the panel', (await q('.nav-account-row')) === 1);
    check('one: a dot in the panel', (await q('.nav-account-row .status-dot, .nav-account-row .account-dot-sync')) === 1);
    check('one: one Overview card', (await q('.account-card')) === 1);
    check('one: card says Status', (await text('.account-card .ov-label')).trim() === 'Status');
    check('one: no switchers', (await hidden('#setup-account-switcher')) && (await hidden('#emails-account-switcher')));
    check('one: Calendars page shows no account line', await hidden('#calendars-account'));
    await shot('02-one-overview');
    await navigate('settings');
    check('one: Accounts card with one row', (await q('.account-row')) === 1);
    check('one: move buttons disabled', (await run(`[...document.querySelectorAll('[data-move-account]')].every((b) => b.disabled)`)) === true);
    await shot('03-one-settings');

    // Two accounts.
    current = scenarios.two;
    await navigate('overview');
    await rerender();
    check('two: two Calendars tabs', (await q('#nav-calendar-tabs .nav-item')) === 2);
    check('two: addresses under the tabs', (await q('.nav-item-sub')) === 2);
    check('two: two accounts in the panel', (await q('.nav-account-row')) === 2);
    check('two: the syncing account spins in the panel', (await q('.nav-account-row .account-dot-sync')) === 1);
    check('two: two Overview cards', (await q('.account-card')) === 2);
    check('two: cards say Account', (await text('.account-card .ov-label')).trim() === 'Account');
    check('two: pending changes on the second card', (await run(`document.querySelectorAll('.account-card')[1].textContent.includes('2 changes wait')`)) === true);
    check('two: failed request on the second card', (await run(`document.querySelectorAll('.account-card')[1].textContent.includes('Nope')`)) === true);
    await shot('04-two-overview');
    await navigate('calendars', 'b2');
    check('two: second tab active', (await run(`document.querySelector('.nav-item.active').dataset.account`)) === 'b2');
    check('two: Calendars page names the account', (await text('#calendars-account')).trim() === 'work@proton.me');
    check('two: its calendars listed', (await run(`document.querySelector('#calendar-list').textContent.includes('work@proton.me')`)) === true);
    await shot('05-two-calendars-b2');
    await navigate('setup');
    check('two: setup switcher shown', !(await hidden('#setup-account-switcher')));
    check('two: setup switcher has two chips, b2 active', (await q('#setup-account-switcher .account-chip')) === 2 && (await run(`document.querySelector('#setup-account-switcher .account-chip.is-active').dataset.selectAccount`)) === 'b2');
    check('two: manual details for b2', (await text('#detail-username')).trim() === 'b2');
    check('two: b2 seen 4 h ago in this run → Quiet', (await text('#calendar-app-pill')).trim() === 'Quiet', await text('#calendar-app-pill'));
    check('setup: b2 Thunderbird never seen → Not set up (0.49.1)', (await text('#thunderbird-pill')).trim() === 'Not set up' && (await hidden('#thunderbird-status')));
    check('setup: b2 BusyCal 5 h ago → Quiet, named', (await text('#other-apps-pill')).trim() === 'Quiet' && (await text('#other-apps-status')).startsWith('BusyCal last asked'), await text('#other-apps-status'));
    await run(`document.querySelector('#setup-account-switcher [data-select-account="a1"]').click()`);
    await settle();
    check('two: switching changes the details', (await text('#detail-username')).trim() === 'neutron-calendar-bridge');
    check('two: a1 seen 20 s ago → Connected', (await text('#calendar-app-pill')).trim() === 'Connected', await text('#calendar-app-pill'));
    check('setup: a1 Thunderbird 2 min ago → Connected (0.49.1)', (await text('#thunderbird-pill')).trim() === 'Connected' && (await text('#thunderbird-status')).startsWith('Thunderbird is connected'), await text('#thunderbird-status'));
    check('setup: a1 no other app → Untested', (await text('#other-apps-pill')).trim() === 'Untested' && (await hidden('#other-apps-status')));
    // 0.49.3: a wrong password from Thunderbird is reported as Thunderbird's, with the generic second step.
    current = { ...scenarios.two, accounts: [{ ...scenarios.two.accounts[0], caldavLogin: { since: Date.now() - 60_000, lastAt: Date.now() - 5_000, attempts: 3, savedPasswordUnreadable: false, app: 'Thunderbird' } }, scenarios.two.accounts[1]] };
    await rerender();
    check('setup: login alert names Thunderbird', !(await hidden('#caldav-login-alert')) && (await text('#caldav-login-kicker')).trim() === 'Thunderbird Cannot Sign In' && (await text('#caldav-login-text')).startsWith('Thunderbird sent a wrong password'), await text('#caldav-login-text'));
    check('setup: the Calendar.app step is hidden, the generic one shown', (await hidden('#caldav-login-step-calendar-app')) && !(await hidden('#caldav-login-step-other')));
    await navigate('overview');
    check('overview: the alert names Thunderbird', (await run(`document.body.textContent.includes('Thunderbird Cannot Sign In')`)) === true);
    current = scenarios.two;
    await rerender();
    await navigate('setup');
    await shot('06-two-setup');
    check('setup: the details are folded away by default (0.48.1)', (await run(`document.querySelector('#calendar-app-details').open`)) === false && (await q('#reminders-note')) === 1);
    await run(`document.querySelector('#calendar-app-steps').hidden = false; document.querySelector('#calendar-app-details').open = true`);
    await settle();
    await shot('06b-two-setup-steps-details');
    // 0.48.8: the Thunderbird card: this account's username and calendar home, password copied by the app.
    check('setup: Thunderbird location is the calendar home', /^http:\/\/127\.0\.0\.1:\d+\/calendars\/[^/]+\/$/.test((await text('#thunderbird-location')).trim()), await text('#thunderbird-location'));
    check('setup: Thunderbird username', (await text('#thunderbird-username')).trim() === (await text('#detail-username')).trim());
    await run(`document.querySelector('#thunderbird-card').scrollIntoView()`);
    await settle();
    await shot('06c-thunderbird');
    // 0.49: "Manual Setup" behind "Show Instructions"; the other-apps card with the principal URL and the calendar home.
    check('setup: manual instructions hidden by default (0.49)', (await hidden('#manual-setup-body')) && (await text('#toggle-manual-setup')).trim() === 'Show Instructions');
    await run(`document.querySelector('#toggle-manual-setup').click()`);
    await settle();
    check('setup: Show Instructions opens the manual values', !(await hidden('#manual-setup-body')) && (await text('#toggle-manual-setup')).trim() === 'Hide Instructions' && (await run(`document.querySelector('#detail-username').offsetParent !== null`)) === true);
    await run(`document.querySelector('#manual-setup').scrollIntoView()`);
    await settle();
    await shot('06d-manual-setup');
    check('setup: other apps URL is the principal', /^http:\/\/127\.0\.0\.1:\d+\/principals\/[^/]+\/$/.test((await text('#other-apps-url')).trim()), await text('#other-apps-url'));
    check('setup: other apps calendar home', (await text('#other-apps-home')).trim() === (await text('#thunderbird-location')).trim() && (await text('#other-apps-port')).trim() === (await text('#detail-port')).trim());
    await run(`document.querySelector('#other-apps-card').scrollIntoView()`);
    await settle();
    await shot('06e-other-apps');
    await run(`document.querySelector('#toggle-manual-setup').click()`);
    await run(`document.querySelector('#calendar-app-steps').hidden = true; document.querySelector('#calendar-app-details').open = false`);
    await navigate('settings');
    check('two: emails switcher shown', !(await hidden('#emails-account-switcher')));
    check('two: Accounts card with two rows', (await q('.account-row')) === 2);
    await run(`document.querySelector('.account-row [data-move-account="down"]').click()`);
    await settle();
    const order = calls.filter((entry) => entry[0] === 'setAccountOrder').pop();
    check('two: ▼ asks for the new order', JSON.stringify(order && order[1]) === JSON.stringify(['b2', 'a1']), JSON.stringify(order));
    await shot('07-two-settings');
    // 0.48.1: the developer options as sub-cards (shown by hand here: the scenarios keep them off).
    await run(`document.querySelector('#developer-options').hidden = false; const stats = document.querySelector('#developer-stats'); stats.hidden = false; document.querySelector('#developer-stats-list').innerHTML = '<dt>Last hour</dt><dd>12 request(s)</dd><dt>Answers</dt><dd>12 × 2xx</dd>'; document.querySelector('#developer-options').scrollIntoView()`);
    await settle();
    check('settings: developer options in three sub-cards (0.48.1)', (await q('#developer-options > .developer-section')) === 3 && (await run(`document.querySelector('#developer-card').classList.contains('developer-section')`)) === false);
    await shot('07b-developer-options');
    await run(`document.documentElement.dataset.theme = 'dark'`);
    await settle();
    await shot('07c-developer-options-dark');
    await run(`delete document.documentElement.dataset.theme`);
    await run(`document.querySelector('#developer-options').hidden = true; document.querySelector('#developer-stats').hidden = true`);

    // Adding: the sign-in page with a way back.
    current = scenarios.adding;
    await rerender();
    check('adding: sign-in page', !(await hidden('#auth-page')));
    check('adding: back link', !(await hidden('#auth-back-row')));
    check('adding: kicker says Add Account', (await text('#account-kicker')).trim() === 'Add Account');
    await shot('08-adding');
    await run(`document.querySelector('#cancel-add-account').click()`);
    await settle();
    check('adding: back asks the bridge', calls.some((entry) => entry[0] === 'cancelAddAccount'));

    // An account asks for a code in the background: its prompt shows, named after it.
    current = scenarios.prompt;
    await rerender();
    check('prompt: sign-in page', !(await hidden('#auth-page')));
    check('prompt: the prompt', !(await hidden('#sign-in-prompt')));
    check('prompt: named after the account', (await text('#account-kicker')).trim() === 'work@proton.me');
    await run(`document.querySelector('#sign-in-prompt-input').value = '123456'; document.querySelector('#sign-in-prompt-continue').click()`);
    await settle();
    const answered = calls.filter((entry) => entry[0] === 'answerSignInPrompt').pop();
    check('prompt: answered for that account', answered && answered[1] === 'b2' && answered[2].code === '123456', JSON.stringify(answered));
    await shot('09-prompt');

    // A signed-out account: its card offers Sign In Again; the page then addresses it.
    current = scenarios.signedOut;
    await rerender();
    check('signed out: dashboard', !(await hidden('#dashboard-page')));
    check('signed out: Sign In Again on its card', (await q('.account-card [data-reauth-account="b2"]')) === 1 && (await q('.account-row [data-reauth-account="b2"]')) === 1);
    check('signed out: grey dot in the panel', (await q('.nav-account-row .status-dot.status-off')) === 1);
    await shot('10-signed-out');
    // 0.49.9: its Calendars page says so and offers Sign In Again too.
    await navigate('calendars', 'b2');
    check('signed out: Calendars page says signed out, with Sign In Again', (await run(`document.querySelector('#calendar-list').textContent.includes('signed out')`)) === true && (await q('#calendar-list [data-reauth-account="b2"]')) === 1);
    await shot('10b-signed-out-calendars');
    await run(`document.querySelector('#calendar-list [data-reauth-account="b2"]').click()`);
    await settle();
    check('signed out: Calendars page button opens its sign-in', !(await hidden('#auth-page')) && (await text('#account-kicker')).trim() === 'work@proton.me');
    await navigate('overview');
    await run(`document.querySelector('.account-card [data-reauth-account="b2"]').click()`);
    await settle();
    check('signed out: sign-in page for it', !(await hidden('#auth-page')) && (await text('#account-kicker')).trim() === 'work@proton.me');
    check('signed out: the bridge\'s own sign-in, no Sign In with Proton (0.47: parked outside the app)', (await q('#show-password-form')) === 0 && !(await hidden('#login-form')) && (await q('#proton-page-sign-in, #sign-in-with-proton')) === 0);
    await run(`document.querySelector('#username').value = 'work@proton.me'; document.querySelector('#password').value = 'pw'; document.querySelector('#login-form').requestSubmit()`);
    await settle();
    const signedIn = calls.filter((entry) => entry[0] === 'signIn').pop();
    check('signed out: signIn addressed to it', signedIn && signedIn[2] === 'b2', JSON.stringify(signedIn));
    await shot('11-reauth');

    // The switches (0.36.3) and the Info page's feature list.
    current = scenarios.two;
    await rerender();
    await navigate('settings');
    await run(`document.querySelector('#open-at-login').scrollIntoView({ block: 'center' })`);
    await settle();
    check('switches: no native checkboxes left', (await run(`[...document.querySelectorAll('input[type="checkbox"]')].every((input) => getComputedStyle(input).appearance === 'none' && getComputedStyle(input).borderRadius !== '0px')`)) === true);
    await shot('12-switches');
    await navigate('calendars', 'a1');
    await shot('13-calendar-switches');
    await navigate('info');
    // 1.0.4: the Help card's links (the feature list became a sentence in the credits).
    check('info: help links to GitHub', (await q('.help-links .external-link')) === 4);
    await shot('14-info');
    // 0.37.1: the manual values always shown; the address card (two addresses) at the bottom of the Calendars page.
    await navigate('setup');
    check('setup: manual values filled (0.49: behind Show Instructions)', (await text('#detail-username')).trim() !== '-' && (await hidden('#manual-setup-body')));
    check('setup: the step names this account\'s Calendar.app account (0.39)', (await run(`document.querySelector('#calendar-app-step-account').textContent`)).includes('Proton (') && (await q('#calendar-app-step-account strong')) === 1);
    current = { ...scenarios.two, accounts: [{ ...scenarios.two.accounts[0], addresses: ['tobi@proton.me', 'alias@proton.me'], newCalendarAddress: '' }, scenarios.two.accounts[1]] };
    await rerender();
    await navigate('calendars', 'a1');
    check('calendars: address card shown with two addresses', !(await hidden('#new-calendar-address-card')) && (await q('#setting-new-calendar-address option')) === 3);
    check('calendars: address card after the list', (await run(`document.querySelector('#calendar-list').compareDocumentPosition(document.querySelector('#new-calendar-address-card')) & Node.DOCUMENT_POSITION_FOLLOWING`)) !== 0);
    await shot('15-calendars-address');
    await navigate('calendars', 'b2');
    check('calendars: no address card with one address', await hidden('#new-calendar-address-card'));

    check('no renderer errors', errors.length === 0, errors.join(' | '));
    console.log(failures ? `${failures} check(s) failed` : 'all checks passed');
    app.exit(failures ? 1 : 0);
};

app.whenReady().then(main).catch((error) => {
    console.error(error);
    app.exit(1);
});
