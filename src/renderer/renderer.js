/**
 * 0.36: the window shows several accounts. `app` is what the bridge sends (every account in order,
 * and the one being signed in); `bridgeState` is the selected account's state (the Calendars tab
 * chosen, else the first) — app-wide settings are the same in every account's state, so it serves
 * for those too; `reauthAccountId` is an account whose sign-in page was opened from the Overview.
 */
const state = {
    app: null,
    bridgeState: null,
    selectedAccountId: null,
    reauthAccountId: null
};

/** The accounts in order (none while the first one signs in). */
const accountsOf = (app) => (app && app.accounts) || [];
const accountById = (app, id) => accountsOf(app).find((account) => account.accountId === id) || null;
/** The account the Calendars tab, the Setup page and the Emails card show. */
const selectedAccount = (app) => accountById(app, state.selectedAccountId) || accountsOf(app)[0] || null;
const accountName = (account) => (account && (account.accountLabel || account.username)) || t('Proton Account');

const elements = {
    authPage: document.getElementById('auth-page'),
    dashboardPage: document.getElementById('dashboard-page'),
    loginForm: document.getElementById('login-form'),
    username: document.getElementById('username'),
    password: document.getElementById('password'),
    refreshButton: document.getElementById('refresh-button'),
    addAccountButton: document.getElementById('add-account-button'),
    addAccountSettings: document.getElementById('add-account-settings'),
    settingsAccountList: document.getElementById('settings-account-list'),
    navCalendarTabs: document.getElementById('nav-calendar-tabs'),
    navAccountList: document.getElementById('nav-account-list'),
    overviewAccounts: document.getElementById('overview-accounts'),
    setupAccountSwitcher: document.getElementById('setup-account-switcher'),
    emailsAccountSwitcher: document.getElementById('emails-account-switcher'),
    calendarsAccount: document.getElementById('calendars-account'),
    newCalendarAddressCard: document.getElementById('new-calendar-address-card'),
    settingNewCalendarAddress: document.getElementById('setting-new-calendar-address'),
    cancelAddAccount: document.getElementById('cancel-add-account'),
    authBackRow: document.getElementById('auth-back-row'),
    accountKicker: document.getElementById('account-kicker'),
    statusPopover: document.getElementById('status-popover'),
    openAtLogin: document.getElementById('open-at-login'),
    openAtLoginNote: document.getElementById('open-at-login-note'),
    authError: document.getElementById('auth-error'),
    dashboardError: document.getElementById('dashboard-error'),
    // Auth sidebar status
    statusPill: document.getElementById('status-pill'),
    statusMessage: document.getElementById('status-message'),
    lastSync: document.getElementById('last-sync'),
    // Auth form
    accountTitle: document.getElementById('account-title'),
    accountSubtitle: document.getElementById('account-subtitle'),
    connectButton: document.getElementById('connect-button'),
    // Human verification
    challengePanel: document.getElementById('challenge-panel'),
    challengeTitle: document.getElementById('challenge-title'),
    challengeDescription: document.getElementById('challenge-description'),
    challengeMeta: document.getElementById('challenge-meta'),
    challengeActions: document.getElementById('challenge-actions'),
    captchaShell: document.getElementById('captcha-shell'),
    captchaStatus: document.getElementById('captcha-status'),
    openHumanVerification: document.getElementById('open-human-verification'),
    signInPrompt: document.getElementById('sign-in-prompt'),
    signInPromptKicker: document.getElementById('sign-in-prompt-kicker'),
    signInPromptTitle: document.getElementById('sign-in-prompt-title'),
    signInPromptDescription: document.getElementById('sign-in-prompt-description'),
    signInPromptForm: document.getElementById('sign-in-prompt-form'),
    signInPromptLabel: document.getElementById('sign-in-prompt-label'),
    signInPromptInput: document.getElementById('sign-in-prompt-input'),
    signInPromptError: document.getElementById('sign-in-prompt-error'),
    signInPromptContinue: document.getElementById('sign-in-prompt-continue'),
    signInPromptCancel: document.getElementById('sign-in-prompt-cancel'),
    completeHumanVerification: document.getElementById('complete-human-verification'),
    // Setup page
    caldavLoginAlert: document.getElementById('caldav-login-alert'),
    caldavLoginText: document.getElementById('caldav-login-text'),
    caldavLoginSteps: document.getElementById('caldav-login-steps'),
    caldavLoginKicker: document.getElementById('caldav-login-kicker'),
    caldavLoginStepCalendarApp: document.getElementById('caldav-login-step-calendar-app'),
    caldavLoginStepOther: document.getElementById('caldav-login-step-other'),
    copyCaldavPassword: document.getElementById('copy-caldav-password'),
    calendarAppPill: document.getElementById('calendar-app-pill'),
    calendarAppText: document.getElementById('calendar-app-text'),
    calendarAppError: document.getElementById('calendar-app-error'),
    calendarAppSteps: document.getElementById('calendar-app-steps'),
    calendarAppStepAccount: document.getElementById('calendar-app-step-account'),
    setUpCalendarApp: document.getElementById('set-up-calendar-app'),
    openProfilesSettings: document.getElementById('open-profiles-settings'),
    manualSetup: document.getElementById('manual-setup'),
    manualSetupBody: document.getElementById('manual-setup-body'),
    toggleManualSetup: document.getElementById('toggle-manual-setup'),
    thunderbirdPill: document.getElementById('thunderbird-pill'),
    thunderbirdStatus: document.getElementById('thunderbird-status'),
    otherAppsPill: document.getElementById('other-apps-pill'),
    otherAppsStatus: document.getElementById('other-apps-status'),
    otherAppsUrl: document.getElementById('other-apps-url'),
    otherAppsUsername: document.getElementById('other-apps-username'),
    otherAppsHost: document.getElementById('other-apps-host'),
    otherAppsPort: document.getElementById('other-apps-port'),
    otherAppsHome: document.getElementById('other-apps-home'),
    // Connection page
    detailHost: document.getElementById('detail-host'),
    thunderbirdUsername: document.getElementById('thunderbird-username'),
    thunderbirdLocation: document.getElementById('thunderbird-location'),
    detailPort: document.getElementById('detail-port'),
    detailUsername: document.getElementById('detail-username'),
    detailPassword: document.getElementById('detail-password'),
    detailServerPath: document.getElementById('detail-server-path'),
    detailSecurity: document.getElementById('detail-security'),
    // Calendars page
    calendarList: document.getElementById('calendar-list'),
    calendarsIntro: document.getElementById('calendars-intro'),
    // Settings page
    settingPollInterval: document.getElementById('setting-poll-interval'),
    settingLookback: document.getElementById('setting-lookback'),
    settingLookahead: document.getElementById('setting-lookahead'),
    settingTheme: document.getElementById('setting-theme'),
    // Invitations
    invitationSupportNote: document.getElementById('invitation-support-note'),
    settingLanguage: document.getElementById('setting-language'),
    settingSendEmails: document.getElementById('setting-send-emails'),
    settingInvitationLanguage: document.getElementById('setting-invitation-language'),
    invitationLanguageHint: document.getElementById('invitation-language-hint'),
    invitationModeHint: document.getElementById('invitation-mode-hint'),
    invitationModeWarning: document.getElementById('invitation-mode-warning'),
    settingDeveloperMode: document.getElementById('setting-developer-mode'),
    settingNotifications: document.getElementById('setting-notifications'),
    settingAutoUpdate: document.getElementById('setting-auto-update'),
    checkForUpdates: document.getElementById('check-for-updates'),
    installUpdate: document.getElementById('install-update'),
    updateStatus: document.getElementById('update-status'),
    settingNotificationTitles: document.getElementById('setting-notification-titles'),
    settingDetailedLogging: document.getElementById('setting-detailed-logging'),
    detailedLoggingHint: document.getElementById('detailed-logging-hint'),
    deleteLogs: document.getElementById('delete-logs'),
    openChangelog: document.getElementById('open-changelog'),
    closeChangelog: document.getElementById('close-changelog'),
    changelogDialog: document.getElementById('changelog-dialog'),
    changelogBody: document.getElementById('changelog-body'),
    settingCalendarEmails: document.getElementById('setting-calendar-emails'),
    settingCalendarEmailsFolder: document.getElementById('setting-calendar-emails-folder'),
    calendarEmailsFolderField: document.getElementById('calendar-emails-folder-field'),
    calendarEmailsSupportNote: document.getElementById('calendar-emails-support-note'),
    calendarEmailsStatus: document.getElementById('calendar-emails-status'),
    developerOptions: document.getElementById('developer-options'),
    developerStats: document.getElementById('developer-stats'),
    developerStatsList: document.getElementById('developer-stats-list'),
};

/** The window's texts (0.32): English keys, translated by the catalog the main process sends. */
const t = (text, params) => window.i18n.t(text, params);
const tn = (one, other, count, params) => window.i18n.tn(one, other, count, params);

const escapeHtml = (value) =>
    String(value)
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');

/** "Never", "Just now", "3m ago" or a date; mid-sentence ("Checked just now") with the lower-case forms. */
const formatRelativeTime = (timestamp, { midSentence = false } = {}) => {
    if (!timestamp) return midSentence ? t('never') : t('Never');
    const seconds = Math.floor((Date.now() - timestamp) / 1000);
    if (seconds < 5) return midSentence ? t('just now') : t('Just now');
    if (seconds < 60) return t('{seconds}s ago', { seconds });
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return t('{minutes}m ago', { minutes });
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return t('{hours}h ago', { hours });
    return new Date(timestamp).toLocaleDateString(window.i18n.locale);
};

const withLoading = async (button, action) => {
    button.classList.add('loading');
    button.disabled = true;
    try {
        await action();
    } finally {
        button.classList.remove('loading');
        button.disabled = false;
    }
};

let caldavPasswordVisible = false;

// ─── Theme ───────────────────────────────────────────────────────────────────

const systemDark = matchMedia('(prefers-color-scheme: dark)');
let themePreference = 'system';

const applyTheme = (preference) => {
    themePreference = preference === 'light' || preference === 'dark' ? preference : 'system';
    const dark = themePreference === 'dark' || (themePreference === 'system' && systemDark.matches);
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    try {
        // Read by the inline script in index.html before first paint (avoids a light flash).
        localStorage.setItem('theme', themePreference);
    } catch {
        // Storage unavailable; the setting still lives in config.json.
    }
};

systemDark.addEventListener('change', () => applyTheme(themePreference));

// ─── Navigation ──────────────────────────────────────────────────────────────

let currentPage = 'overview';
const PAGES = ['overview', 'calendars', 'setup', 'settings', 'info'];

/** Shows a page; the Calendars page of one account (0.36) also makes that account the selected one. */
const navigateTo = (page, accountId = null) => {
    if (!PAGES.includes(page)) return;
    // A pinned status popover belongs to the Calendars page.
    statusPopover.calendarId = null;
    statusPopover.pinned = false;
    statusPopover.hintElement = null;
    elements.statusPopover.hidden = true;
    currentPage = page;
    if (accountId && accountById(state.app, accountId)) {
        state.selectedAccountId = accountId;
    }
    markActiveNavItem();
    document.querySelectorAll('.nav-page').forEach((pageEl) => {
        pageEl.hidden = pageEl.id !== `page-${page}`;
    });
    if (accountId) {
        void requestRender(); // the pages that show one account follow the selection
    }
};

const markActiveNavItem = () => {
    const selected = selectedAccount(state.app);
    document.querySelectorAll('.nav-item').forEach((item) => {
        const forAccount = item.dataset.account;
        item.classList.toggle('active', item.dataset.page === currentPage && (!forAccount || !selected || forAccount === selected.accountId));
    });
};

const initNav = () => {
    // The tabs are built per account (0.36): one listener on the list.
    document.querySelector('.nav-list').addEventListener('click', (event) => {
        const item = event.target.closest('.nav-item');
        if (item) navigateTo(item.dataset.page, item.dataset.account || null);
    });
    // Menu-bar menu: the status line, an account line, Info / Setup / Settings open a given page.
    window.bridgeApi.onNavigate?.((page, accountId) => navigateTo(page, accountId || null));
};

// ─── Rendering ───────────────────────────────────────────────────────────────

const formatExpiry = (unixTimestamp) => {
    if (!unixTimestamp) return t('Expires soon');
    return t('Expires {time}', { time: new Date(unixTimestamp * 1000).toLocaleTimeString(window.i18n.locale) });
};

const supportsManagedCaptcha = (challenge) =>
    Array.isArray(challenge?.methods) && challenge.methods.includes('captcha');

const HEALTH_LABELS = /* i18n */ { healthy: 'Healthy', syncing: 'Syncing', connecting: 'Connecting', error: 'Error', disconnected: 'Disconnected' };

const healthLabel = (health) => t(HEALTH_LABELS[health] || health);

/** 0.46: signed in, its first pass of this run not through yet, nothing wrong either: shown in blue. */
const startingUp = (account) =>
    Boolean(account?.signedIn) && account.verifiedThisRun === false && (account.health === 'syncing' || account.health === 'connecting');

/**
 * 0.45: an account not signed in yet that is connecting is signing in (perhaps waiting for a CAPTCHA or
 * a code): shown in light blue as "Signing In", not in the warning colour, until it is in or refused.
 */
const pillOf = (account) =>
    account && !account.signedIn && account.health === 'connecting'
        ? { kind: 'signing-in', label: t('Signing In') }
        : startingUp(account)
          ? { kind: 'signing-in', label: healthLabel(account.health) } // 0.46: the first pass after starting, in blue
          : { kind: account?.health, label: healthLabel(account?.health) };

/** The sign-in page's status card (the account being signed in). */
const setStatusPills = (account) => {
    const pill = pillOf(account);
    elements.statusPill.textContent = pill.label;
    elements.statusPill.className = `status-pill status-${pill.kind}`;
    elements.statusMessage.textContent = account.message;
};

// ─── Accounts (0.36) ─────────────────────────────────────────────────────────

/** An account's dot: red (no connection, a calendar failing), yellow (a refusal), the sync symbol, green; grey when signed out. */
const accountDotStatus = (account) => {
    if (!account.signedIn) return account.health === 'connecting' ? 'syncing-initial' : 'off'; // 0.46: signing in: blue
    const calendars = (account.calendars || []).filter((calendar) => calendar.syncEnabled !== false && !calendar.removed);
    if (account.health === 'error' || calendars.some((calendar) => calendar.status === 'error')) return 'error';
    const warning = calendars.some((calendar) => calendar.status === 'warning');
    if (account.health === 'syncing' || calendars.some((calendar) => calendar.syncState === 'syncing')) return warning ? 'syncing-warning' : startingUp(account) ? 'syncing-initial' : 'syncing';
    if (warning) return 'warning';
    return 'ok';
};

const ACCOUNT_DOT_LABELS = /* i18n */ { ok: 'In Sync', syncing: 'Syncing', 'syncing-warning': 'Syncing — Needs Attention', 'syncing-initial': 'Connecting', warning: 'Needs Attention', error: 'Problem', off: 'Signed Out' };

const accountDotHtml = (account) => {
    const status = accountDotStatus(account);
    const label = escapeHtml(t(ACCOUNT_DOT_LABELS[status]));
    if (status === 'syncing' || status === 'syncing-warning' || status === 'syncing-initial') {
        // 0.45.2: yellow while something needs attention (instead of the yellow ring until the sync ends);
        // 0.46: blue while signing in and during the first pass after starting.
        const tone = status === 'syncing-warning' ? ' is-warning' : status === 'syncing-initial' ? ' is-initial' : '';
        return `<span class="sync-control sync-spinning account-dot-sync${tone}" aria-label="${label}">${SYNC_ICON}</span>`;
    }
    return `<span class="status-dot status-${status} account-dot" role="img" aria-label="${label}">${status === 'error' ? '<span aria-hidden="true">!</span>' : ''}</span>`;
};

/** The side panel: one Calendars tab per account (the address under it while there are several). */
let navTabsKey = '';
const renderNavTabs = (app) => {
    const accounts = accountsOf(app);
    const key = JSON.stringify(accounts.map((account) => [account.accountId, accountName(account)]));
    if (key !== navTabsKey) {
        navTabsKey = key;
        elements.navCalendarTabs.innerHTML = (accounts.length ? accounts : [null])
            .map((account) =>
                account && accounts.length > 1
                    ? `<button class="nav-item nav-item-account" data-page="calendars" data-account="${escapeHtml(account.accountId)}"><span>${escapeHtml(t('Calendars'))}</span><span class="nav-item-sub">${escapeHtml(accountName(account))}</span></button>`
                    : `<button class="nav-item" data-page="calendars"${account ? ` data-account="${escapeHtml(account.accountId)}"` : ''}>${escapeHtml(t('Calendars'))}</button>`
            )
            .join('');
    }
    markActiveNavItem();
};

/** The side panel's footer: every account with its dot and its status line. */
let navAccountsHtml = '';
const renderNavAccounts = (app) => {
    const accounts = accountsOf(app);
    const html = accounts
        .map(
            (account) => `
            <li class="nav-account-row" data-account="${escapeHtml(account.accountId)}" title="${escapeHtml(account.message || '')}">
                <span class="nav-account-dot">${accountDotHtml(account)}</span>
                <span class="nav-account-text">
                    <span class="nav-username">${escapeHtml(accountName(account))}</span>
                    <span class="nav-meta">${escapeHtml(account.message || '')}</span>
                </span>
            </li>`
        )
        .join('');
    if (html !== navAccountsHtml) {
        navAccountsHtml = html;
        elements.navAccountList.innerHTML = html;
    }
};

/** Setup page and Emails card: which account they show, while there are several. */
const renderAccountSwitcher = (container, app) => {
    const accounts = accountsOf(app);
    container.hidden = accounts.length < 2;
    if (accounts.length < 2) {
        container.innerHTML = '';
        return;
    }
    const selected = selectedAccount(app);
    const html = accounts
        .map(
            (account) =>
                `<button type="button" class="account-chip${selected && account.accountId === selected.accountId ? ' is-active' : ''}" data-select-account="${escapeHtml(account.accountId)}">${accountDotHtml(account)}<span>${escapeHtml(accountName(account))}</span></button>`
        )
        .join('');
    if (container.innerHTML !== html) {
        container.innerHTML = html;
    }
};

/** Settings → Accounts: the order (▲ ▼), Sign Out per account. */
let settingsAccountsHtml = '';
const renderSettingsAccounts = (app) => {
    const accounts = accountsOf(app);
    const html = accounts
        .map(
            (account, index) => `
            <li class="account-row" data-account="${escapeHtml(account.accountId)}">
                <span class="account-row-dot">${accountDotHtml(account)}</span>
                <span class="account-row-text">
                    <span class="account-row-name">${escapeHtml(accountName(account))} <span class="account-tag" title="${escapeHtml(t('Tag of this account in bridge.log'))}">${escapeHtml(`a:${String(account.accountId || '').slice(0, 4)}`)}</span></span>
                    <span class="account-row-meta">${escapeHtml(account.message || '')}</span>
                </span>
                <span class="account-row-actions">
                    <button type="button" class="icon-button" data-move-account="up" ${index === 0 ? 'disabled' : ''} title="${escapeHtml(t('Move Up'))}" aria-label="${escapeHtml(t('Move Up'))}">▲</button>
                    <button type="button" class="icon-button" data-move-account="down" ${index === accounts.length - 1 ? 'disabled' : ''} title="${escapeHtml(t('Move Down'))}" aria-label="${escapeHtml(t('Move Down'))}">▼</button>
                    ${
                        account.signedIn || account.health === 'connecting'
                            ? `<button type="button" class="secondary-button" data-sign-out-account="${escapeHtml(account.accountId)}">${escapeHtml(t('Sign Out'))}</button>`
                            : `<button type="button" class="secondary-button" data-reauth-account="${escapeHtml(account.accountId)}">${escapeHtml(t('Sign In'))}</button>`
                    }
                    <button type="button" class="secondary-button danger-button" data-remove-account="${escapeHtml(account.accountId)}" title="${escapeHtml(t('Remove the account from the bridge (nothing changes in Proton)'))}">${escapeHtml(t('Remove'))}</button>
                </span>
            </li>`
        )
        .join('');
    if (html !== settingsAccountsHtml) {
        settingsAccountsHtml = html;
        elements.settingsAccountList.innerHTML = html;
    }
};

// ─── Overview (0.36: one card per account) ───────────────────────────────────

const syncDetailText = (account) => {
    const stats = account.syncStats;
    if (!stats || !(stats.totalEvents > 0)) return '';
    const direction = stats.lastDirection === 'push' ? t('Pushed to Proton') : t('Pulled from Proton');
    const parts = [direction, tn('{count} event synced', '{count} events synced', stats.syncedEvents)];
    if (stats.failedEvents > 0) {
        parts.push(t('{count} failed to decrypt', { count: stats.failedEvents }));
    }
    return parts.join(' · ');
};

const invitationLogHtml = (account) => {
    const mode = account.invitationEmailMode || 'live';
    const allowlist = account.invitationEmailAllowlist || [];
    const modeText = mode === 'test' ? tn('Test · {count} address allowed', 'Test · {count} addresses allowed', allowlist.length) : t(EMAIL_MODE_LABELS[mode] || mode);
    const entries = account.recentInvitationEmails || [];
    const items = entries.length
        ? entries
              .slice(0, 8)
              .map((entry) => {
                  const recipients = entry.to
                      .map((recipient) => (recipient.delivery ? `${recipient.email} (${t(DELIVERY_LABELS[recipient.delivery] || recipient.delivery)})` : recipient.email))
                      .join(', ');
                  let line;
                  if (entry.kind === 'received') {
                      // A guest's emailed answer to one of your meetings: from them, to you.
                      const answer = ANSWER_LABELS[entry.answer] ? t(ANSWER_LABELS[entry.answer]) : entry.answer || t('Answer');
                      line = t('{time} · {answer} by email “{title}” ← {from}', { time: formatLogTime(entry.at), answer, title: entry.eventTitle, from: entry.from });
                  } else {
                      const what = entry.kind && entry.kind !== 'answer' ? t(KIND_LABELS[entry.kind] || entry.kind) : t(ANSWER_LABELS[entry.answer] || entry.answer || entry.method);
                      line = `${formatLogTime(entry.at)} · ${what} “${entry.eventTitle}” → ${recipients}`;
                  }
                  const detail = entry.detail ? `<br>${escapeHtml(entry.detail)}` : '';
                  return `<li><span class="email-outcome outcome-${escapeHtml(entry.outcome)}">${escapeHtml(t(OUTCOME_LABELS[entry.outcome] || entry.outcome))}</span><span class="email-meta">${escapeHtml(line)}${detail}</span></li>`;
              })
              .join('')
        : `<li class="email-empty">${escapeHtml(t("No invitation emails from Calendar.app or guests' emailed answers since the app started."))}</li>`;
    return `
        <div class="account-section">
            <p class="ov-label">${escapeHtml(t('Invitation Emails'))} <span class="mode-badge mode-${escapeHtml(mode)}">${escapeHtml(modeText)}</span></p>
            <ul class="email-log">${items}</ul>
        </div>`;
};

/** 0.49.3: the app a request came from — Calendar.app, Thunderbird, another app's name — or a neutral word. */
const appNameOf = (entry) => (entry && entry.app) || t('A calendar app');

const caldavLoginOverviewText = (trouble) => {
    const time = (at) => new Date(at).toLocaleTimeString(window.i18n.locale, { hour: '2-digit', minute: '2-digit' });
    const tries = tn('once', '{count} times', trouble.attempts);
    const app = appNameOf(trouble);
    return trouble.savedPasswordUnreadable
        ? t('{app} sent a password the bridge does not know ({tries} since {since}). macOS did not let the app read its saved login (Keychain), which holds the password {app} was given. Quit and reopen the app and choose "Always Allow" when macOS asks; {app} then signs in again by itself.', { app, tries, since: time(trouble.since) })
        : t('{app} sent a wrong password for the bridge {tries} since {since}. The Setup page shows the password to enter.', { app, tries, since: time(trouble.since) });
};

const alertHtml = (label, text, extra = '') => `
        <div class="account-alert">
            <p class="ov-label">${escapeHtml(label)}</p>
            <p class="ov-message">${escapeHtml(text)}</p>
            ${extra}
        </div>`;

const accountCardHtml = (account, several) => {
    const id = escapeHtml(account.accountId);
    const errors = account.recentCalDAVErrors || [];
    const pending = Number(account.pendingChanges) || 0;
    const detail = syncDetailText(account);
    const sections = [];
    if (account.localCopyNote) {
        sections.push(alertHtml(t('Local Copy'), account.localCopyNote));
    }
    if (account.caldavLogin) {
        sections.push(alertHtml(t('{app} Cannot Sign In', { app: appNameOf(account.caldavLogin) }), caldavLoginOverviewText(account.caldavLogin), `<div class="button-row"><button type="button" class="secondary-button" data-go-to="setup" data-go-to-account="${id}">${escapeHtml(t('Open Setup'))}</button></div>`));
    }
    if (pending) {
        sections.push(alertHtml(t('Changes Waiting for Proton'), tn('{count} change waits to be sent to Proton.', '{count} changes wait to be sent to Proton.', pending), `<p class="ov-hint">${escapeHtml(t('Made in Calendar.app while Proton could not be reached. They are sent, in order, as soon as it answers again; a change Proton then refuses is undone here and reported.'))}</p>`));
    }
    const waitingEmails = Number(account.waitingEmails) || 0;
    if (waitingEmails) {
        sections.push(alertHtml(t('Emails Waiting for Proton'), tn('{count} email to your guests waits for Proton.', '{count} emails to your guests wait for Proton.', waitingEmails), `<p class="ov-hint">${escapeHtml(t('Proton asked to slow down while a change was being emailed. The change is saved; the email goes out as soon as the pause is over.'))}</p>`));
    }
    if (errors.length) {
        const earlier = errors.length > 1 ? ` (+${errors.length - 1} earlier)` : '';
        sections.push(alertHtml(t('Last Failed Request from {app}', { app: appNameOf(errors[0]) }), describeCalDAVError(errors[0], account.calendars || []) + earlier, `<p class="ov-hint">${escapeHtml(t('Full history: ~/Library/Logs/neutron-calendar-bridge/bridge.log'))}</p>`));
    }
    if (account.signedIn && account.invitationsSupported) {
        sections.push(invitationLogHtml(account));
    }
    const signInAgain = !account.signedIn && account.health !== 'connecting' ? `<div class="button-row"><button type="button" class="primary-button" data-reauth-account="${id}">${escapeHtml(t('Sign In Again'))}</button></div>` : '';
    return `
        <article class="ov-card ov-card-wide account-card${account.health === 'error' ? ' is-error' : ''}" data-account="${id}">
            <header class="account-card-header">
                <div class="account-card-title">
                    <p class="ov-label">${escapeHtml(several ? t('Account') : t('Status'))}</p>
                    <h3 class="account-card-name">${escapeHtml(accountName(account))}</h3>
                </div>
                <span class="status-pill status-${escapeHtml(pillOf(account).kind)}">${escapeHtml(pillOf(account).label)}</span>
            </header>
            <p class="ov-message">${escapeHtml(account.message || '')}</p>
            <dl class="account-card-meta">
                <dt>${escapeHtml(t('Last Sync'))}</dt><dd>${escapeHtml(formatRelativeTime(account.lastSuccessfulSyncAt))}</dd>
                ${detail ? `<dt>${escapeHtml(t('Last Sync Detail'))}</dt><dd>${escapeHtml(detail)}</dd>` : ''}
            </dl>
            ${signInAgain}
            ${sections.join('')}
        </article>`;
};

let overviewHtml = '';
const renderOverview = (app) => {
    const accounts = accountsOf(app);
    const html = accounts.map((account) => accountCardHtml(account, accounts.length > 1)).join('');
    if (html !== overviewHtml) {
        overviewHtml = html;
        elements.overviewAccounts.innerHTML = html;
    }
};

/** 0.48: calendars whose tick is being saved (only those wait; the others can be changed meanwhile). */
const calendarTogglesPending = new Set();

// Calendars page: groups, a status dot per calendar (hover or click for the reason) and sync
// buttons (one calendar, or a whole group). The bridge tells the window when anything changes.

const CALENDAR_GROUPS = /* i18n */ [
    { kind: 'own', title: 'My Calendars' },
    { kind: 'shared', title: 'Shared with Me' },
    { kind: 'subscribed', title: 'Subscribed Calendars' },
    {
        kind: 'holidays',
        title: 'Public Holidays',
        hint: 'Synced when the bridge signs in and every day at midnight; the arrows sync one now.',
        noGroupSync: true
    }
];

const SYNC_ICON =
    '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M13.2 6.4A5.4 5.4 0 0 0 3.4 4.6" /><path d="M2.8 9.6a5.4 5.4 0 0 0 9.8 1.8" />' +
    '<path class="arrowhead" d="M3.6 1.9v2.9h2.9" /><path class="arrowhead" d="M12.4 14.1v-2.9H9.5" /></svg>';
const QUEUED_ICON =
    '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="5.6" /><path d="M8 4.8V8l2.2 1.4" /></svg>';

const STATUS_LABELS = /* i18n */ { ok: 'In Sync', warning: 'Needs Attention', error: 'Problem', off: 'Not Synced' };

let lastCalendarListHtml = '';
/** The status popover: which calendar it belongs to, and whether a click pinned it; or the control whose hint it shows (0.32.7). */
const statusPopover = { calendarId: null, pinned: false, hintElement: null };

const calendarSyncControl = (calendar, signedIn) => {
    const id = escapeHtml(calendar.protonCalendarId);
    const name = escapeHtml(calendar.displayName);
    if (calendar.syncState === 'syncing') {
        const warning = calendar.status === 'warning' ? ' is-warning' : '';
        return `<span class="sync-control sync-spinning${warning}" data-hint="${escapeHtml(t('Syncing {name}…', { name: calendar.displayName }))}" aria-label="${escapeHtml(t('Syncing'))}">${SYNC_ICON}</span>`;
    }
    if (calendar.syncState === 'queued') {
        return calendar.queuedManually
            ? `<button type="button" class="sync-control sync-queued" data-sync-calendar="${id}" data-hint="${escapeHtml(t('Queued — click to take {name} off the queue', { name: calendar.displayName }))}" aria-label="${escapeHtml(t('Queued — click to take {name} off the queue', { name: calendar.displayName }))}">${QUEUED_ICON}</button>`
            : `<span class="sync-control sync-queued is-auto" data-hint="${escapeHtml(t('Queued by the regular sync'))}">${QUEUED_ICON}</span>`;
    }
    if (!signedIn || !calendar.syncEnabled || calendar.removed) {
        return '<span class="sync-control sync-placeholder" aria-hidden="true"></span>';
    }
    const hint = escapeHtml(t('Sync {name} now', { name: calendar.displayName }));
    return `<button type="button" class="sync-control" data-sync-calendar="${id}" data-hint="${hint}" aria-label="${hint}">${SYNC_ICON}</button>`;
};

const calendarRowHtml = (calendar, signedIn) => {
    const syncEnabled = calendar.syncEnabled !== false;
    // lastPolledAt moves on every sync; lastSyncedAt only when something in the calendar changed.
    const syncParts = syncEnabled
        ? [
              escapeHtml(t('Checked {when}', { when: formatRelativeTime(calendar.lastPolledAt, { midSentence: true }) })),
              ...(calendar.lastSyncedAt ? [escapeHtml(t('last change {when}', { when: formatRelativeTime(calendar.lastSyncedAt, { midSentence: true }) }))] : [])
          ]
        : [escapeHtml(t('Excluded from Sync'))];
    const state = calendar.removed
        ? t('Removed in Proton')
        : calendar.readOnly
          ? t('Read-only ({reason})', { reason: calendar.readOnlyReason || t('in Proton') })
          : t('Active');
    const meta = [escapeHtml(calendar.slug), escapeHtml(state), ...syncParts].join(' · ');
    const toggleDisabled = calendar.removed || calendarTogglesPending.has(calendar.protonCalendarId);
    const status = calendar.status || 'ok';
    const id = escapeHtml(calendar.protonCalendarId);
    return `
        <article class="calendar-row${syncEnabled ? '' : ' is-excluded'}">
            <input
                type="checkbox"
                class="calendar-sync-toggle"
                data-calendar-id="${id}"
                aria-label="${escapeHtml(t('Sync {name} to Calendar.app', { name: calendar.displayName }))}"
                title="${escapeHtml(syncEnabled ? t('Untick to stop syncing this calendar') : t('Tick to sync this calendar'))}"
                ${syncEnabled ? 'checked' : ''}
                ${toggleDisabled ? 'disabled' : ''}
            />
            <span class="calendar-swatch" style="background:${escapeHtml(calendar.color)};"></span>
            <div class="calendar-text">
                <div class="calendar-name">${escapeHtml(calendar.displayName)}</div>
                <div class="calendar-meta">${meta}</div>
            </div>
            <div class="calendar-actions">
                ${calendarSyncControl(calendar, signedIn)}
                <button type="button" class="status-dot status-${escapeHtml(status)}" data-status-calendar="${id}"
                    aria-label="${escapeHtml(t(STATUS_LABELS[status] || status))}${calendar.statusMessage ? `: ${escapeHtml(calendar.statusMessage)}` : ''}">${status === 'error' ? '<span aria-hidden="true">!</span>' : ''}</button>
            </div>
        </article>`;
};

const groupSyncControl = (group, calendars, signedIn) => {
    if (group.noGroupSync || !signedIn) {
        return '';
    }
    const synced = calendars.filter((calendar) => calendar.syncEnabled !== false && !calendar.removed);
    if (!synced.length) {
        return '';
    }
    if (synced.some((calendar) => calendar.syncState === 'syncing')) {
        const warning = synced.some((calendar) => calendar.status === 'warning') ? ' is-warning' : '';
        return `<span class="sync-control sync-spinning${warning}" data-hint="${escapeHtml(t('Syncing {name}…', { name: t(group.title) }))}">${SYNC_ICON}</span>`;
    }
    const hint = escapeHtml(t('Sync every ticked calendar in {group}', { group: t(group.title) }));
    return `<button type="button" class="sync-control" data-sync-group="${group.kind}" data-hint="${hint}" aria-label="${hint}">${SYNC_ICON}</button>`;
};

const renderCalendars = (calendars, signedIn, account = null) => {
    let html;
    // 0.49.9: a signed-out account says so here too, with the way back (the Overview card has the same button).
    const signedOut = account && !signedIn && account.health !== 'connecting'
        ? `<p style="color:var(--text-weak);margin:0 0 14px;">${escapeHtml(t('This account is signed out. Its calendars are listed again once you sign in.'))}</p>
            <div class="button-row" style="margin-bottom:${calendars.length ? '22px' : '0'};"><button type="button" class="primary-button" data-reauth-account="${escapeHtml(account.accountId)}">${escapeHtml(t('Sign In Again'))}</button></div>`
        : '';
    if (signedOut && !calendars.length) {
        html = signedOut;
    } else if (!calendars.length) {
        html = `<p style="color:var(--text-weak);margin:0;">${escapeHtml(t('No calendars mirrored yet.'))}</p>`;
    } else {
        html = CALENDAR_GROUPS.map((group) => {
            const members = calendars.filter((calendar) => (calendar.kind || 'own') === group.kind);
            if (!members.length) {
                return '';
            }
            return `
                <section class="calendar-group">
                    <header class="calendar-group-header">
                        <h3>${escapeHtml(t(group.title))}</h3>
                        ${groupSyncControl(group, members, signedIn)}
                    </header>
                    ${group.hint ? `<p class="calendar-group-hint">${escapeHtml(t(group.hint))}</p>` : ''}
                    <div class="calendar-group-list">${members.map((calendar) => calendarRowHtml(calendar, signedIn)).join('')}</div>
                </section>`;
        }).join('');
        html = signedOut + html;
    }
    // Only replace the list when it changed, so running spinners and hover states are not reset.
    if (html !== lastCalendarListHtml) {
        lastCalendarListHtml = html;
        // 0.37.16: a rebuilt list would drop the keyboard focus (a switch toggled with Space is gone with
        // its row); the focused control is found again by what it stands for.
        const focused = document.activeElement && elements.calendarList.contains(document.activeElement) ? document.activeElement : null;
        const focusKey = focused ? focused.dataset.calendarId || focused.dataset.group || null : null;
        const focusClass = focused ? focused.className : '';
        elements.calendarList.innerHTML = html;
        if (focusKey) {
            const again = [...elements.calendarList.querySelectorAll('[data-calendar-id], [data-group]')].find((element) => (element.dataset.calendarId || element.dataset.group) === focusKey && element.className === focusClass);
            again?.focus();
        }
    }
    updateStatusPopover();
};

const statusPopoverText = (calendar) => {
    const label = t(STATUS_LABELS[calendar.status] || calendar.status);
    const when = calendar.statusAt ? formatLogTime(calendar.statusAt) : '';
    if (calendar.status === 'ok') {
        return { title: label, body: t('Checked {when}.', { when: formatRelativeTime(calendar.lastPolledAt, { midSentence: true }) }), when: '' };
    }
    return { title: label, body: calendar.statusMessage || '', when };
};

/** Places the popover under its anchor (above when there is no room), right-aligned to it. */
const placeStatusPopover = (popover, anchor) => {
    const rect = anchor.getBoundingClientRect();
    const width = popover.offsetWidth;
    const left = Math.max(12, Math.min(window.innerWidth - width - 12, rect.right - width + 8));
    const below = rect.bottom + 8;
    const top = below + popover.offsetHeight > window.innerHeight - 12 ? rect.top - popover.offsetHeight - 8 : below;
    popover.style.left = `${left}px`;
    popover.style.top = `${Math.max(12, top)}px`;
};

const updateStatusPopover = () => {
    const popover = elements.statusPopover;
    // A sync control's hint (what the native tooltip used to say, shown at once in the same box as the dots' details).
    if (statusPopover.hintElement && !statusPopover.pinned) {
        const control = statusPopover.hintElement;
        if (control.isConnected && control.offsetParent !== null && control.matches(':hover') && control.dataset.hint) {
            popover.className = 'status-popover is-hint';
            popover.innerHTML = `<p class="status-popover-body">${escapeHtml(control.dataset.hint)}</p>`;
            popover.hidden = false;
            placeStatusPopover(popover, control);
            return;
        }
        statusPopover.hintElement = null;
    }
    const calendar = (state.bridgeState?.calendars || []).find((entry) => entry.protonCalendarId === statusPopover.calendarId);
    const anchor = statusPopover.calendarId
        ? elements.calendarList.querySelector(`[data-status-calendar="${CSS.escape(statusPopover.calendarId)}"]`)
        : null;
    // Gone, on a hidden page, or no longer under the mouse (the list was redrawn meanwhile): hide.
    const anchorVisible = anchor && anchor.offsetParent !== null;
    if (!calendar || !anchorVisible || (!statusPopover.pinned && !anchor.matches(':hover'))) {
        popover.hidden = true;
        statusPopover.calendarId = null;
        statusPopover.pinned = false;
        return;
    }
    const { title, body, when } = statusPopoverText(calendar);
    popover.className = `status-popover status-${calendar.status}${statusPopover.pinned ? ' is-pinned' : ''}`;
    popover.innerHTML =
        `<p class="status-popover-title">${escapeHtml(calendar.displayName)} · ${escapeHtml(title)}</p>` +
        (body ? `<p class="status-popover-body">${escapeHtml(body)}</p>` : '') +
        (when ? `<p class="status-popover-when">${escapeHtml(when)}</p>` : '');
    popover.hidden = false;
    placeStatusPopover(popover, anchor);
};

/** What a failed Calendar.app request was doing, as a whole phrase per method and target (so each language can inflect it). */
const CALDAV_PHRASES = /* i18n */ {
    'PUT:event': 'Saving an event',
    'PUT:calendar': 'Saving the calendar',
    'DELETE:event': 'Deleting an event',
    'DELETE:calendar': 'Deleting the calendar',
    'READ:event': 'Reading an event',
    'READ:calendar': 'Reading the calendar'
};
const READ_METHODS = ['PROPFIND', 'REPORT', 'GET'];

const describeCalDAVError = (entry, calendars) => {
    // Paths look like /calendars/<user>/<calendar-slug>/<event>.ics
    const [, root, , slug, resource] = entry.path.split('/');
    const calendar = root === 'calendars' && slug ? calendars.find((candidate) => candidate.slug === slug) : null;
    const target = resource ? 'event' : 'calendar';
    const method = READ_METHODS.includes(entry.method) ? 'READ' : entry.method;
    const phrase = CALDAV_PHRASES[`${method}:${target}`];
    const what = phrase ? t(phrase) : `${entry.method} ${resource ? t('an event') : t('the calendar')}`;
    const where = calendar ? ` ${t('in “{name}”', { name: calendar.displayName })}` : slug ? ` ${t('in “{name}”', { name: slug })}` : '';
    const when = new Date(entry.at);
    const isToday = when.toDateString() === new Date().toDateString();
    const time = isToday ? when.toLocaleTimeString(window.i18n.locale) : when.toLocaleString(window.i18n.locale);
    return t('{time} · {what}{where} failed ({status}): {message}', { time, what, where, status: entry.status, message: entry.message });
};

/**
 * Calendar.app sends a wrong password (an old one, e.g. after the saved login was lost): the Setup
 * page says so with the password to enter; the Overview points there.
 */
/** 0.49: the Apple Calendar card's "Manual Setup": its values and steps behind "Show Instructions". */
const showManualSetup = (shown) => {
    elements.manualSetupBody.hidden = !shown;
    elements.toggleManualSetup.textContent = shown ? t('Hide Instructions') : t('Show Instructions');
    elements.toggleManualSetup.setAttribute('aria-expanded', shown ? 'true' : 'false');
};

/** Set up Calendar.app (0.30): whether Calendar.app talks to the bridge, and the steps after the click. */
let calendarAppStepsShown = false;
const renderCalendarApp = (bridgeState) => {
    const status = bridgeState.calendarApp || { lastRequestAt: null, thisRun: false };
    // 0.39: the step names this account's Calendar.app account ("Proton (address)" with several).
    {
        const [before, after = ''] = t('Calendar.app then shows your calendars under {account} within a minute.', { account: '\u0000' }).split('\u0000');
        const name = document.createElement('strong');
        name.textContent = bridgeState.calendarAppAccountName || 'Proton';
        elements.calendarAppStepAccount.replaceChildren(before, name, after);
    }
    // Connected = a request in the last 3 hours (Calendar.app refreshes every few minutes while the
    // account exists). 0.37.9: "seen during this run" no longer counts on its own — it kept the card
    // green for the rest of the run after the account had been removed from Calendar.app.
    const recent = status.lastRequestAt && Date.now() - status.lastRequestAt < 3 * 60 * 60 * 1000;
    if (recent) {
        elements.calendarAppPill.textContent = t('Connected');
        elements.calendarAppPill.className = 'status-pill status-healthy';
        elements.calendarAppText.textContent = t('Calendar.app is connected (last request {when}). Nothing to do.', { when: formatRelativeTime(status.lastRequestAt, { midSentence: true }) });
        elements.setUpCalendarApp.textContent = t('Set Up Calendar.app Again');
    } else if (status.lastRequestAt) {
        elements.calendarAppPill.textContent = t('Quiet');
        elements.calendarAppPill.className = 'status-pill status-connecting';
        elements.calendarAppText.textContent = t('Calendar.app last asked {when}. If the account is gone from Calendar.app, set it up again.', { when: formatRelativeTime(status.lastRequestAt, { midSentence: true }) });
        elements.setUpCalendarApp.textContent = t('Set Up Calendar.app Again');
    } else {
        elements.calendarAppPill.textContent = t('Not set up');
        elements.calendarAppPill.className = 'status-pill status-disconnected';
        elements.calendarAppText.textContent = t('Click Set Up Calendar.app and follow the steps.');
        elements.setUpCalendarApp.textContent = t('Set Up Calendar.app');
    }
    if (!calendarAppStepsShown) {
        elements.calendarAppSteps.hidden = true;
    }
    // Signed in or not, the profile needs the bridge's local password, which exists from the first start on.
};

/**
 * 0.49.1: the Thunderbird and other-apps cards' pills — the bridge tells the apps apart by their
 * User-Agent. Connected: a request in the last 3 hours; Quiet: seen before; else Not set up / Untested.
 */
const renderClientStatus = (status, pill, line, { app, never }) => {
    const recent = status.lastRequestAt && Date.now() - status.lastRequestAt < 3 * 60 * 60 * 1000;
    if (recent) {
        pill.textContent = t('Connected');
        pill.className = 'status-pill status-healthy';
        line.textContent = t('{app} is connected (last request {when}).', { app, when: formatRelativeTime(status.lastRequestAt, { midSentence: true }) });
        line.hidden = false;
    } else if (status.lastRequestAt) {
        pill.textContent = t('Quiet');
        pill.className = 'status-pill status-connecting';
        line.textContent = t('{app} last asked {when}.', { app, when: formatRelativeTime(status.lastRequestAt, { midSentence: true }) });
        line.hidden = false;
    } else {
        pill.textContent = never;
        pill.className = never === t('Untested') ? 'status-pill status-connecting' : 'status-pill status-disconnected';
        line.hidden = true;
    }
};
const renderClients = (bridgeState) => {
    renderClientStatus(bridgeState.thunderbird || { lastRequestAt: null }, elements.thunderbirdPill, elements.thunderbirdStatus, { app: 'Thunderbird', never: t('Not set up') });
    const other = bridgeState.otherClient || { lastRequestAt: null, name: null };
    renderClientStatus(other, elements.otherAppsPill, elements.otherAppsStatus, { app: other.name || t('Another app'), never: t('Untested') });
};

/** 0.31: the language of invitation emails — Proton Calendar's setting, or one of Proton's languages. */
let invitationLanguagesKey = '';
const renderInvitationLanguage = (bridgeState) => {
    const languages = bridgeState.invitationEmailLanguages || [];
    const chosen = bridgeState.invitationEmailLanguage || 'proton';
    const proton = bridgeState.protonInviteLanguage;
    const protonName = proton ? (languages.find((entry) => entry.code === proton || entry.code.split('_')[0] === proton.split(/[_-]/)[0]) || {}).name || proton : null;
    const key = JSON.stringify([languages, protonName]);
    if (key !== invitationLanguagesKey) {
        invitationLanguagesKey = key;
        const select = elements.settingInvitationLanguage;
        select.innerHTML = '';
        const first = document.createElement('option');
        first.value = 'proton';
        first.textContent = protonName ? t('Same as Proton Calendar ({language})', { language: protonName }) : t('Same as Proton Calendar');
        select.appendChild(first);
        for (const language of languages) {
            const option = document.createElement('option');
            option.value = language.code;
            option.textContent = language.name;
            select.appendChild(option);
        }
    }
    if (document.activeElement !== elements.settingInvitationLanguage) {
        elements.settingInvitationLanguage.value = languages.some((entry) => entry.code === chosen) ? chosen : 'proton';
    }
    elements.settingInvitationLanguage.disabled = languages.length === 0;
    elements.invitationLanguageHint.textContent =
        languages.length === 0
            ? t('The linked proton-calendar-client has no translations yet (rebuild it with the languages patch); emails are in English.')
            : t('The emails use Proton\'s own texts. "Same as Proton Calendar" follows the invitation language set in Proton Calendar.');
};

/** 0.37: which of the account's addresses owns calendars made in Calendar.app (only with several addresses). */
let newCalendarAddressKey = '';
const renderNewCalendarAddress = (bridgeState) => {
    const addresses = bridgeState.addresses || [];
    const show = Boolean(bridgeState.signedIn) && addresses.length > 1;
    elements.newCalendarAddressCard.hidden = !show;
    if (!show) {
        return;
    }
    const key = JSON.stringify([addresses, bridgeState.accountId]);
    if (key !== newCalendarAddressKey) {
        newCalendarAddressKey = key;
        const select = elements.settingNewCalendarAddress;
        select.innerHTML = '';
        const first = document.createElement('option');
        first.value = '';
        first.textContent = t('First active address ({address})', { address: addresses[0] });
        select.appendChild(first);
        for (const address of addresses) {
            const option = document.createElement('option');
            option.value = address;
            option.textContent = address;
            select.appendChild(option);
        }
    }
    if (document.activeElement !== elements.settingNewCalendarAddress) {
        const chosen = bridgeState.newCalendarAddress || '';
        elements.settingNewCalendarAddress.value = addresses.includes(chosen) ? chosen : '';
    }
};

/** The Setup page's alert (the Overview card of the account says the same, see caldavLoginOverviewText). */
const renderCalDAVLogin = (bridgeState) => {
    const trouble = bridgeState.caldavLogin;
    elements.caldavLoginAlert.hidden = !trouble;
    if (!trouble) {
        return;
    }
    const time = (at) => new Date(at).toLocaleTimeString(window.i18n.locale, { hour: '2-digit', minute: '2-digit' });
    const tries = tn('once', '{count} times', trouble.attempts);
    const app = appNameOf(trouble);
    elements.caldavLoginKicker.textContent = t('{app} Cannot Sign In', { app });
    if (trouble.savedPasswordUnreadable) {
        elements.caldavLoginText.textContent = caldavLoginOverviewText(trouble);
        elements.caldavLoginSteps.hidden = true;
        return;
    }
    elements.caldavLoginText.textContent = t('{app} sent a wrong password for the bridge {tries} since {since} (last at {last}) — probably one from before. Give it the password shown below:', { app, tries, since: time(trouble.since), last: time(trouble.lastAt) });
    // 0.49.3: the second step names where the password goes — Calendar.app's own place, or the app's prompt.
    elements.caldavLoginStepCalendarApp.hidden = trouble.app !== 'Calendar.app';
    elements.caldavLoginStepOther.hidden = trouble.app === 'Calendar.app';
    elements.caldavLoginSteps.hidden = false;
};

// ─── Invitations ─────────────────────────────────────────────────────────────

const EMAIL_MODE_LABELS = /* i18n */ { test: 'Test', 'dry-run': 'Dry run', live: 'Live' };
const EMAIL_MODE_HINTS = /* i18n */ {
    test: 'Test mode (set in the configuration file): only the listed addresses get emails; a change that would email anyone else is refused.',
    'dry-run': 'Off: nothing is sent and nothing changes in Proton; the emails that would have gone out are written to the log and listed on the Overview. For trying things out without emailing anyone.',
    live: 'On: invitations, updates, cancellations and answers are emailed just like from Proton Calendar.'
};
const ANSWER_LABELS = /* i18n */ { ACCEPTED: 'Accepted', TENTATIVE: 'Maybe', DECLINED: 'Declined', 'NEEDS-ACTION': 'No answer yet' };
const KIND_LABELS = /* i18n */ { invitation: 'Invitation', update: 'Update', cancellation: 'Cancellation', received: 'Answer by email' };
const DELIVERY_LABELS = /* i18n */ { proton: 'Proton, end-to-end', pgp: 'PGP', plain: 'normal email' };
const OUTCOME_LABELS = /* i18n */ {
    sent: 'Sent',
    blocked: 'Blocked',
    'dry-run': 'Dry run',
    failed: 'Failed',
    applied: 'Applied',
    skipped: 'Not applied',
    note: 'Note'
};

/** The hint as it stands in index.html (the English key), for when the renderer puts it back. */
const DETAILED_LOGGING_HINT = /* i18n */ 'The log normally leaves out private details such as event titles and addresses. Switch this on only while tracing a problem.';

const formatLogTime = (timestamp) => {
    const when = new Date(timestamp);
    return when.toDateString() === new Date().toDateString() ? when.toLocaleTimeString(window.i18n.locale) : when.toLocaleString(window.i18n.locale);
};

/** The main card's warning while a developer mode is in force (the mode itself is set under Developer Options). */
const EMAIL_MODE_WARNINGS = /* i18n */ {
    test: 'Test mode is on (Developer Options): emails go only to the allowed addresses.',
    'dry-run': 'Dry run is on (Developer Options): nothing is sent and nothing changes in Proton.'
};

/** The Emails card and the developer options (the selected account's; the invitation log is on its Overview card). */
const renderInvitations = (bridgeState) => {
    const supported = Boolean(bridgeState.invitationsSupported);
    // The mode in force (live unless developer options are on) and the setting the select shows.
    const mode = bridgeState.invitationEmailMode || 'live';
    const modeSetting = bridgeState.invitationEmailModeSetting || mode;

    // Settings card. 1.0.4: one switch — on = live, off = dry run (test mode stays reachable in the configuration file).
    elements.invitationSupportNote.hidden = supported || !bridgeState.signedIn;
    elements.settingSendEmails.checked = modeSetting !== 'dry-run';
    elements.invitationModeHint.textContent = EMAIL_MODE_HINTS[modeSetting] ? t(EMAIL_MODE_HINTS[modeSetting]) : '';
    const warning = supported && bridgeState.signedIn && EMAIL_MODE_WARNINGS[mode] ? t(EMAIL_MODE_WARNINGS[mode]) : '';
    elements.invitationModeWarning.textContent = warning;
    elements.invitationModeWarning.hidden = !warning;
    renderInvitationLanguage(bridgeState);
    elements.settingNotifications.checked = bridgeState.notifications !== false;
    elements.settingNotificationTitles.checked = bridgeState.notificationTitles !== false;
    elements.settingNotificationTitles.disabled = bridgeState.notifications === false;
    elements.settingAutoUpdate.checked = bridgeState.autoUpdate !== false;

    // Emails about meetings
    const calendarEmailsSupported = Boolean(bridgeState.calendarEmailsSupported);
    const after = bridgeState.calendarEmailsAfter || 'leave';
    elements.calendarEmailsSupportNote.hidden = calendarEmailsSupported || !bridgeState.signedIn;
    elements.settingCalendarEmails.disabled = !calendarEmailsSupported && bridgeState.signedIn;
    if (document.activeElement !== elements.settingCalendarEmails) {
        elements.settingCalendarEmails.value = after;
    }
    elements.calendarEmailsFolderField.hidden = after !== 'folder';
    elements.settingCalendarEmailsFolder.disabled = elements.settingCalendarEmails.disabled;
    if (document.activeElement !== elements.settingCalendarEmailsFolder) {
        elements.settingCalendarEmailsFolder.value = bridgeState.calendarEmailsFolder || 'Calendar';
    }
    const emailsStatus = bridgeState.calendarEmailsStatus;
    const statusText = calendarEmailsStatusText(emailsStatus, after, mode, bridgeState.signedIn);
    elements.calendarEmailsStatus.hidden = !statusText;
    elements.calendarEmailsStatus.textContent = statusText;
    elements.calendarEmailsStatus.classList.toggle('has-problem', Boolean(emailsStatus?.problem));
    // Developer options: shown, and in force, only while the switch is on.
    const developerMode = Boolean(bridgeState.developerMode);
    elements.settingDeveloperMode.checked = developerMode;
    elements.developerOptions.hidden = !developerMode;
    const detailed = bridgeState.detailedLogging || 'off';
    if (document.activeElement !== elements.settingDetailedLogging) {
        elements.settingDetailedLogging.value = detailed;
    }
    elements.settingDetailedLogging.disabled = !developerMode;
    elements.detailedLoggingHint.textContent =
        developerMode && detailed === '24h' && bridgeState.detailedLoggingUntil
            ? t('On until {until}: the log includes private details (titles, addresses, email text).', { until: new Date(bridgeState.detailedLoggingUntil).toLocaleString(window.i18n.locale, { weekday: 'short', hour: '2-digit', minute: '2-digit' }) })
            : developerMode && detailed === 'on'
              ? t('On: the log includes private details (titles, addresses, email text) until you switch it off.')
              : t(DETAILED_LOGGING_HINT);
    renderRequestStats(bridgeState.requestStats);
};

/** Developer settings: how the bridge talks to Proton (only while developer options are on). */
const renderRequestStats = (stats) => {
    elements.developerStats.hidden = !stats;
    if (!stats) {
        return;
    }
    const time = (at) => new Date(at).toLocaleTimeString(window.i18n.locale, { hour: '2-digit', minute: '2-digit' });
    const answers = stats.answers || {};
    const answerText = Object.entries(answers)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([kind, count]) => `${count} × ${kind}`)
        .join(', ');
    const passes = stats.lastHourPasses || { passes: 0, full: 0, requests: 0, decrypted: 0, changes: 0 };
    const minutes = (ms) => (ms >= 60_000 ? `${Math.round(ms / 60_000)} min` : `${Math.round(ms / 1000)} s`);
    const cadence = stats.cadence || { mode: 'fixed', intervalMs: 0, nextAt: null };
    const cadenceText =
        cadence.mode === 'fixed'
            ? `every ${minutes(cadence.intervalMs)} (the client lists everything each time)`
            : `${cadence.mode === 'quiet' ? 'quiet: ' : 'things are changing: '}every ${minutes(cadence.intervalMs)}${cadence.nextAt ? `, next at ${time(cadence.nextAt)}` : ''}`;
    const feed = stats.feed || { enabled: false, lastFullAt: null, calendars: 0, following: 0 };
    const feedText = feed.enabled
        ? `${feed.following} of ${feed.calendars} calendar(s) follow their feed; everything last listed in full ${feed.lastFullAt ? `at ${time(feed.lastFullAt)}` : 'not yet'} (again at the first check of the day)`
        : 'not available with this client: everything is listed each pass';
    const lastPass = stats.lastPass;
    const rows = [
        ['Last hour', `${stats.lastHour} request(s) (${stats.requests} since ${time(stats.since)}); ${passes.passes} sync pass(es), ${passes.full} of them full, with ${passes.requests} request(s), ${passes.decrypted} event(s) decrypted, ${passes.changes} change(s)`],
        [
            'Last sync pass',
            lastPass
                ? `${lastPass.kind === 'full' ? 'everything listed' : 'changes only'}: ${lastPass.changes} change(s), ${lastPass.requests} request(s) during it (also Calendar.app's changes), ${lastPass.decrypted} decrypted, ${lastPass.seconds} s, at ${time(lastPass.at)}`
                : 'none yet'
        ],
        ['Change feeds', feedText],
        ['Checks', cadenceText],
        ['Decrypted', stats.decrypt ? `${stats.decrypt.decrypted} event(s) since the app started; ${stats.decrypt.reused} time(s) an unchanged event was reused (${stats.decrypt.cached} kept)` : '—'],
        ['Answers', answerText || '—'],
        ['Sent again', String(stats.retries)],
        ['Session', `${stats.resumedSession ? 'resumed at start' : 'signed in with the password'}; ${stats.signIns} sign-in(s), ${stats.sessionRenewals} renewal(s)`],
        [
            'Slow-downs',
            stats.rateLimited
                ? `${stats.rateLimited} (last at ${time(stats.lastRateLimit.at)}, ${stats.lastRateLimit.seconds} s)${stats.pausedUntil ? `; waiting until ${time(stats.pausedUntil)}` : ''}`
                : 'none'
        ]
    ];
    elements.developerStatsList.innerHTML = rows.map(([label, value]) => `<dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd>`).join('');
};

/** The line under "Emails About Meetings": what happened since the app started, and what is waiting. */
const calendarEmailsStatusText = (status, after, mode, signedIn) => {
    if (after === 'leave' || !signedIn) {
        return '';
    }
    if (!status) {
        return t('Starts with the next sync.');
    }
    const parts = [
        mode === 'dry-run'
            ? tn('Dry run: {count} email would be moved to {destination}.', 'Dry run: {count} emails would be moved to {destination}.', status.wouldMove, { destination: status.destination })
            : tn('Since the app started: {count} email moved to {destination}.', 'Since the app started: {count} emails moved to {destination}.', status.moved, { destination: status.destination }),
        t('In your Inbox: {waiting} waiting for your answer or for Proton, {left} left for you (reasons in bridge.log).', { waiting: status.waiting, left: status.left })
    ];
    if (status.problem) {
        parts.push(t('Problem: {problem}', { problem: status.problem }));
    }
    return parts.join(' ');
};

/** The changelog's Markdown (headings, lists, paragraphs, **bold**, `code`) as HTML; everything else is escaped. */
const renderMarkdown = (text) => {
    // Code spans as they are; **bold** only outside them. Everything is escaped first.
    const inline = (value) =>
        String(value)
            .split(/(`[^`]+`)/)
            .map((part) =>
                /^`[^`]+`$/.test(part)
                    ? `<code>${escapeHtml(part.slice(1, -1))}</code>`
                    : escapeHtml(part).replace(/\*\*(.+?)\*\*/g, (_match, bold) => `<strong>${bold}</strong>`)
            )
            .join('');
    const html = [];
    let list = false;
    let paragraph = [];
    const flush = () => {
        if (paragraph.length) {
            html.push(`<p>${inline(paragraph.join(' '))}</p>`);
            paragraph = [];
        }
        if (list) {
            html.push('</ul>');
            list = false;
        }
    };
    for (const line of String(text || '').split(/\r?\n/)) {
        const heading = line.match(/^(#{1,3})\s+(.*)$/);
        const item = line.match(/^\s*-\s+(.*)$/);
        if (heading) {
            flush();
            const level = heading[1].length + 1; // # → h2 (the dialog has its own title)
            html.push(`<h${level}>${inline(heading[2])}</h${level}>`);
        } else if (item) {
            if (paragraph.length) {
                html.push(`<p>${inline(paragraph.join(' '))}</p>`);
                paragraph = [];
            }
            if (!list) {
                html.push('<ul>');
                list = true;
            }
            html.push(`<li>${inline(item[1])}</li>`);
        } else if (!line.trim()) {
            flush();
        } else if (list) {
            // a wrapped list item
            const last = html.length - 1;
            html[last] = `${html[last].slice(0, -'</li>'.length)} ${inline(line.trim())}</li>`;
        } else {
            paragraph.push(line.trim());
        }
    }
    flush();
    return html.join('\n');
};

/** 0.49.9: set by the sign-in form, so a verification Proton asks for right after opens by itself. */
let verificationAutoOpen = false;
let verificationAutoOpened = null;

const renderHumanVerification = (challenge) => {
    if (!challenge) {
        elements.challengePanel.hidden = true;
        elements.challengeMeta.textContent = '';
        elements.captchaShell.hidden = true;
        elements.challengeActions.hidden = false;
        elements.completeHumanVerification.hidden = false;
        elements.openHumanVerification.textContent = t('Open Verification');
        elements.captchaStatus.textContent = '';
        return;
    }

    elements.challengePanel.hidden = false;
    elements.challengeTitle.textContent = challenge.title || t('Verification Requested');
    elements.challengeDescription.textContent =
        challenge.description ||
        t('Proton requested an additional verification step for this sign-in attempt.');
    const methodText = t('Methods: {methods}', { methods: challenge.methods?.length ? challenge.methods.join(', ') : t('verification') });
    elements.challengeMeta.textContent = `${methodText} · ${formatExpiry(challenge.expiresAt)}`;

    if (supportsManagedCaptcha(challenge)) {
        elements.captchaShell.hidden = false;
        elements.challengeActions.hidden = false;
        elements.openHumanVerification.textContent = t('Open Verification Window');
        elements.completeHumanVerification.hidden = true;
        elements.captchaStatus.textContent = t('Open the secure verification window. The bridge will finish signing in automatically after verification succeeds.');
        // 0.49.9: after a sign-in you just started, the window opens by itself (once per challenge); the
        // button stays for opening it again.
        const key = `${challenge.expiresAt || ''}:${(challenge.methods || []).join(',')}`;
        if (verificationAutoOpen && verificationAutoOpened !== key) {
            verificationAutoOpened = key;
            verificationAutoOpen = false;
            elements.captchaStatus.textContent = t('The verification window is open. The bridge finishes signing in by itself once the verification succeeds.');
            void window.bridgeApi.openHumanVerification();
        }
        return;
    }

    elements.captchaShell.hidden = true;
    elements.challengeActions.hidden = false;
    elements.openHumanVerification.textContent = t('Open Verification');
    elements.completeHumanVerification.hidden = false;
};

/** Proton asks for a code or the mailbox password (0.27): the form makes way for the prompt. */
let shownPromptKey = null;
const renderSignInPrompt = (prompt) => {
    elements.signInPrompt.hidden = !prompt;
    elements.loginForm.hidden = Boolean(prompt);
    if (!prompt) {
        shownPromptKey = null;
        elements.signInPromptInput.value = '';
        elements.signInPromptError.hidden = true;
        return;
    }
    const code = prompt.kind === 'second-factor';
    elements.signInPromptKicker.textContent = code ? t('Two-Factor Authentication') : t('Two-Password Mode');
    elements.signInPromptTitle.textContent = code ? t('Enter Your Authenticator Code') : t('Enter Your Mailbox Password');
    const background = prompt.background ? ` ${t('The bridge is signing in again in the background; syncing waits until then.')}` : '';
    elements.signInPromptDescription.textContent = code
        ? `${prompt.securityKey ? t('Proton accepted the password and asks for the 6-digit code from your authenticator app (your security key cannot be used by the bridge yet).') : t('Proton accepted the password and asks for the 6-digit code from your authenticator app.')}${background}`
        : `${t("This account unlocks its keys with a separate mailbox password (Proton's two-password mode). The bridge keeps only the derived key, not the password itself.")}${background}`;
    elements.signInPromptLabel.textContent = code ? t('Code') : t('Mailbox password');
    elements.signInPromptInput.type = code ? 'text' : 'password';
    elements.signInPromptInput.inputMode = code ? 'numeric' : 'text';
    elements.signInPromptInput.autocomplete = code ? 'one-time-code' : 'current-password';
    elements.signInPromptError.hidden = !prompt.wrong;
    elements.signInPromptError.textContent = code ? t('The code was not accepted. Codes change every 30 seconds: enter the current one.') : t('The mailbox password was not accepted.');
    // A new prompt (or a refusal) gets an empty field and the focus; re-rendering while typing does not.
    const key = `${prompt.kind}:${prompt.wrong}:${prompt.expiresAt}`;
    if (shownPromptKey !== key) {
        shownPromptKey = key;
        elements.signInPromptInput.value = '';
        setTimeout(() => elements.signInPromptInput.focus(), 50);
    }
};

/**
 * 0.36: whose sign-in the sign-in page shows — the first account or one being added (`id` null:
 * the pending service), or an existing account that asks for something (a code, a verification) or
 * whose "Sign In Again" was clicked; null: the dashboard.
 */
const authTarget = (app) => {
    const accounts = accountsOf(app);
    if (!accounts.length || app.addingAccount) {
        return app.signingIn ? { id: null, state: app.signingIn, back: accounts.length > 0 } : null;
    }
    const asking = accounts.find((account) => account.signInPrompt || account.pendingHumanVerification);
    const reauth = accountById(app, state.reauthAccountId);
    // A signed-out account keeps its card on the Overview ("Sign In Again"), so Settings stays reachable.
    const target = asking || (reauth && !reauth.signedIn ? reauth : null);
    return target ? { id: target.accountId, state: target, back: true } : null;
};

const renderView = (bridgeState, target) => {
    const showDashboard = !target;
    elements.authPage.hidden = showDashboard;
    elements.dashboardPage.hidden = !showDashboard;

    if (!showDashboard) {
        elements.authBackRow.hidden = !target.back;
        elements.accountKicker.textContent = target.id ? accountName(target.state) : target.back ? t('Add Account') : t('Account');
        if (bridgeState.signInPrompt) {
            elements.accountTitle.textContent = t('Finish Sign-In');
            elements.accountSubtitle.textContent = t('Proton accepted the password and asks for one more thing.');
        } else if (bridgeState.pendingHumanVerification) {
            elements.accountTitle.textContent = t('Finish Sign-In');
            elements.accountSubtitle.textContent = supportsManagedCaptcha(
                bridgeState.pendingHumanVerification
            )
                ? t('Proton requested additional verification. Complete it in the secure window to finish signing in.')
                : t('Proton requested additional verification. Complete it, then return here to finish signing in.');
            elements.connectButton.textContent = t('Use Other Credentials');
        } else {
            elements.accountTitle.textContent = t('Sign In to Proton');
            elements.accountSubtitle.textContent = t("Sign in with your Proton address and password. Proton may ask you to solve a CAPTCHA once; the bridge then keeps a session, not your password.");
            elements.connectButton.textContent = t('Connect Bridge');
        }
    }
};

/** 0.32: the window's language follows the bridge's; the static markup is translated in place. */
let loadedLanguage = null;
const applyLanguage = async (bridgeState) => {
    const language = bridgeState.language || 'en';
    if (language === loadedLanguage) {
        return;
    }
    const translations = await window.bridgeApi.getTranslations();
    window.i18n.setCatalog(translations.language, translations.catalog, translations.locale, bridgeState.appLanguage === 'system');
    loadedLanguage = translations.language;
    window.i18n.applyToDom();
    lastCalendarListHtml = ''; // the calendar list is built again in the new language
    invitationLanguagesKey = '';
    appLanguagesKey = '';
    // Notes written earlier in the old language and not rebuilt by renderState.
    elements.calendarAppError.hidden = true;
};

let appLanguagesKey = '';
const renderAppLanguage = (bridgeState) => {
    const languages = bridgeState.appLanguages || [];
    const key = JSON.stringify([languages, bridgeState.language, bridgeState.appLanguage]);
    if (key !== appLanguagesKey) {
        appLanguagesKey = key;
        const select = elements.settingLanguage;
        select.innerHTML = '';
        const system = document.createElement('option');
        system.value = 'system';
        const systemName = (languages.find((entry) => entry.code === bridgeState.language) || {}).name;
        system.textContent = bridgeState.appLanguage === 'system' && systemName ? t('Same as macOS ({language})', { language: systemName }) : t('Same as macOS');
        select.appendChild(system);
        for (const language of languages) {
            const option = document.createElement('option');
            option.value = language.code;
            option.textContent = language.name;
            select.appendChild(option);
        }
    }
    if (document.activeElement !== elements.settingLanguage) {
        elements.settingLanguage.value = bridgeState.appLanguage || 'system';
    }
};

const renderState = async () => {
    const app = await window.bridgeApi.getBridgeState();
    state.app = app;
    const selected = selectedAccount(app);
    state.selectedAccountId = selected ? selected.accountId : null;
    if (state.reauthAccountId && (!accountById(app, state.reauthAccountId) || accountById(app, state.reauthAccountId).signedIn)) {
        state.reauthAccountId = null; // signed in again, or gone
    }
    const target = authTarget(app);
    // The selected account's state (app-wide settings are the same in every account's); the sign-in page's own.
    const bridgeState = selected || app.signingIn || target?.state;
    if (!bridgeState) {
        return;
    }
    state.bridgeState = bridgeState;
    const authState = target ? target.state : bridgeState;
    const caldavDetails = await window.bridgeApi.getCalDAVConfig(selected ? selected.accountId : null);
    await applyLanguage(bridgeState);
    renderAppLanguage(bridgeState);

    renderView(authState, target);
    // 0.50.2: the password typed into the form is only needed until its sign-in is through. Once the
    // account is signed in, or the sign-in page is not shown, the field is emptied — also when the
    // main process finished the sign-in (the verification window since 0.49.9), which never passed
    // through the submit handler's own clearing.
    if (!target || authState.signedIn) {
        elements.password.value = '';
    }
    renderHumanVerification(authState.pendingHumanVerification);
    renderSignInPrompt(authState.signInPrompt);
    setStatusPills(authState);
    elements.lastSync.textContent = formatRelativeTime(authState.lastSuccessfulSyncAt);

    renderNavTabs(app);
    renderNavAccounts(app);
    renderOverview(app);
    renderUpdate(app.update);
    renderSettingsAccounts(app);
    renderAccountSwitcher(elements.setupAccountSwitcher, app);
    renderAccountSwitcher(elements.emailsAccountSwitcher, app);
    const several = accountsOf(app).length > 1;
    elements.calendarsAccount.hidden = !several;
    elements.calendarsAccount.textContent = several && selected ? accountName(selected) : '';
    renderCalendars(bridgeState.calendars || [], Boolean(bridgeState.signedIn), selected);
    // 0.49.10: a signed-out account's page has nothing to select.
    elements.calendarsIntro.hidden = Boolean(selected && !bridgeState.signedIn && selected.health !== 'connecting');
    renderNewCalendarAddress(bridgeState);
    renderCalDAVLogin(bridgeState);
    renderCalendarApp(bridgeState);
    renderClients(bridgeState);
    renderInvitations(bridgeState);

    // Version (from package.json via the main process)
    document.querySelectorAll('[data-app-version]').forEach((node) => {
        node.textContent = bridgeState.appVersion ? `v${bridgeState.appVersion}` : '';
    });
    document.querySelectorAll('[data-app-version-plain]').forEach((node) => {
        node.textContent = bridgeState.appVersion || '';
    });

    // Connection details (the selected account's principal)
    elements.detailHost.textContent = bridgeState.caldav.host;
    elements.detailPort.textContent = String(bridgeState.caldav.port);
    elements.detailUsername.textContent = bridgeState.caldav.username;
    // 0.48.8: Thunderbird finds all of the account's calendars from its calendar home.
    elements.thunderbirdUsername.textContent = bridgeState.caldav.username;
    elements.thunderbirdLocation.textContent = `http://${bridgeState.caldav.host}:${bridgeState.caldav.port}/calendars/${bridgeState.caldav.username}/`;
    // 0.49: other CalDAV apps — the principal URL (where /.well-known/caldav points), host, port, calendar home.
    elements.otherAppsUrl.textContent = `http://${bridgeState.caldav.host}:${bridgeState.caldav.port}${caldavDetails.serverPath}`;
    elements.otherAppsUsername.textContent = bridgeState.caldav.username;
    elements.otherAppsHost.textContent = bridgeState.caldav.host;
    elements.otherAppsPort.textContent = String(bridgeState.caldav.port);
    elements.otherAppsHome.textContent = elements.thunderbirdLocation.textContent;

    const maskedPassword = caldavPasswordVisible ? caldavDetails.password : '\u2022'.repeat(12);
    elements.detailPassword.innerHTML =
        `<span class="password-value"><span id="password-text">${escapeHtml(maskedPassword)}</span>` +
        `<button type="button" class="password-toggle" id="toggle-password" title="${escapeHtml(caldavPasswordVisible ? t('Hide Password') : t('Show Password'))}">` +
        `${caldavPasswordVisible ? '\u25CF' : '\u25CB'}</button></span>`;

    elements.detailServerPath.textContent = caldavDetails.serverPath;
    elements.detailSecurity.textContent =
        bridgeState.caldav.security === 'HTTP'
            ? t('HTTP only on 127.0.0.1')
            : bridgeState.caldav.security;

    // Settings
    applyTheme(bridgeState.theme);
    elements.settingTheme.value = themePreference;
    elements.openAtLogin.checked = Boolean(bridgeState.openAtLogin);
    elements.openAtLoginNote.textContent = bridgeState.openAtLoginNote || '';
    elements.openAtLoginNote.hidden = !bridgeState.openAtLoginNote;
    elements.settingPollInterval.value = String(bridgeState.pollIntervalMs || 60000);
    elements.settingLookback.value = String(bridgeState.eventLookbackDays || 365);
    elements.settingLookahead.value = String(bridgeState.eventLookaheadDays || 730);

    if (!target) {
        elements.authError.hidden = true;
        elements.dashboardError.hidden = true;
    }
};

// ─── Error helpers ────────────────────────────────────────────────────────────

const setAuthError = (message) => {
    elements.authError.hidden = false;
    // 0.44.1: without Electron's wrapper ("Error invoking remote method 'bridge:sign-in': Error: …").
    elements.authError.textContent = String(message).replace(/^Error invoking remote method '[^']+': (?:\w*Error: )?/, '');
};

const setDashboardError = (message) => {
    elements.dashboardError.hidden = false;
    elements.dashboardError.textContent = message;
};

// ─── Event handlers ───────────────────────────────────────────────────────────

/** The account the sign-in page is about (null: the one being added). */
const authAccountId = () => authTarget(state.app)?.id ?? null;
const authState = () => authTarget(state.app)?.state ?? state.bridgeState;

elements.loginForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    elements.authError.hidden = true;

    await withLoading(elements.connectButton, async () => {
        try {
            if (authState()?.pendingHumanVerification) {
                await window.bridgeApi.cancelHumanVerification();
                await renderState();
                return;
            }
            verificationAutoOpen = true;
            await window.bridgeApi.signIn(
                {
                    username: elements.username.value.trim(),
                    password: elements.password.value
                },
                authAccountId()
            );
            elements.password.value = '';
            await renderState();
            verificationAutoOpen = false;
        } catch (error) {
            await renderState();
            verificationAutoOpen = false;
            // 0.44.1: Proton asking for verification is a step (its panel says what to do), not an error.
            if (authState()?.pendingHumanVerification) {
                elements.authError.hidden = true;
                return;
            }
            setAuthError(error instanceof Error ? error.message : String(error));
        }
    });
});

elements.signInPromptForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const prompt = authState()?.signInPrompt;
    if (!prompt) return;
    const value = elements.signInPromptInput.value;
    await withLoading(elements.signInPromptContinue, async () => {
        try {
            await window.bridgeApi.answerSignInPrompt(authAccountId(), prompt.kind === 'second-factor' ? { code: value } : { mailboxPassword: value });
            elements.signInPromptInput.value = '';
            await renderState();
        } catch (error) {
            elements.signInPromptError.hidden = false;
            elements.signInPromptError.textContent = error instanceof Error ? error.message : String(error);
        }
    });
});

elements.signInPromptCancel.addEventListener('click', async () => {
    await window.bridgeApi.cancelSignInPrompt(authAccountId());
    await renderState();
});

// 0.36: accounts — adding one, going back, the order, signing one out, choosing the one a page shows.
const addAccount = async () => {
    try {
        await window.bridgeApi.addAccount();
        await renderState();
        elements.username.value = '';
        elements.password.value = '';
    } catch (error) {
        setDashboardError(error instanceof Error ? error.message : String(error));
    }
};
elements.addAccountButton.addEventListener('click', () => void addAccount());
elements.addAccountSettings.addEventListener('click', () => void addAccount());

elements.cancelAddAccount.addEventListener('click', async () => {
    elements.authError.hidden = true;
    const target = authTarget(state.app);
    try {
        if (target?.id) {
            // An existing account's page: back without changing anything (a prompt still open is cancelled).
            if (target.state.signInPrompt) {
                await window.bridgeApi.cancelSignInPrompt(target.id);
            }
            state.reauthAccountId = null;
        } else {
            await window.bridgeApi.cancelAddAccount();
        }
        await renderState();
    } catch (error) {
        setAuthError(error instanceof Error ? error.message : String(error));
    }
});

elements.settingsAccountList.addEventListener('click', async (event) => {
    const move = event.target.closest('[data-move-account]');
    const signOut = event.target.closest('[data-sign-out-account]');
    const remove = event.target.closest('[data-remove-account]');
    const reauth = event.target.closest('[data-reauth-account]');
    try {
        if (move) {
            const row = move.closest('[data-account]');
            const ids = accountsOf(state.app).map((account) => account.accountId);
            const index = ids.indexOf(row.dataset.account);
            const to = move.dataset.moveAccount === 'up' ? index - 1 : index + 1;
            if (index < 0 || to < 0 || to >= ids.length) return;
            ids.splice(to, 0, ids.splice(index, 1)[0]);
            await window.bridgeApi.setAccountOrder(ids);
            await renderState();
        } else if (signOut) {
            const account = accountById(state.app, signOut.dataset.signOutAccount);
            const several = accountsOf(state.app).length > 1;
            const confirmed = confirm(
                several
                    ? t('Sign {account} out? Its calendars stop syncing until you sign it in again.', { account: accountName(account) })
                    : t('Sign out of Proton? Calendar.app will stop syncing until you sign back in.')
            );
            if (!confirmed) return;
            await withLoading(signOut, async () => {
                await window.bridgeApi.signOut(signOut.dataset.signOutAccount);
                elements.dashboardError.hidden = true;
                await renderState();
            });
        } else if (remove) {
            const account = accountById(state.app, remove.dataset.removeAccount);
            if (!confirm(t('Remove {account} from the bridge? Its local copy, settings and Calendar.app password on this Mac are deleted; its calendars leave Calendar.app with the next refresh. Nothing changes in Proton.', { account: accountName(account) }))) return;
            await withLoading(remove, async () => {
                await window.bridgeApi.removeAccount(remove.dataset.removeAccount);
                elements.dashboardError.hidden = true;
                await renderState();
            });
        } else if (reauth) {
            state.reauthAccountId = reauth.dataset.reauthAccount;
            void requestRender();
        }
    } catch (error) {
        setDashboardError(error instanceof Error ? error.message : String(error));
    }
});

for (const switcher of [elements.setupAccountSwitcher, elements.emailsAccountSwitcher]) {
    switcher.addEventListener('click', (event) => {
        const chip = event.target.closest('[data-select-account]');
        if (!chip) return;
        state.selectedAccountId = chip.dataset.selectAccount;
        lastCalendarListHtml = '';
        void requestRender();
    });
}

elements.navAccountList.addEventListener('click', (event) => {
    const row = event.target.closest('[data-account]');
    if (row) navigateTo('calendars', row.dataset.account);
});

elements.overviewAccounts.addEventListener('click', (event) => {
    const reauth = event.target.closest('[data-reauth-account]');
    if (reauth) {
        state.reauthAccountId = reauth.dataset.reauthAccount;
        void requestRender();
    }
});

// 0.49.9: "Sign In Again" on the Calendars page of a signed-out account.
elements.calendarList.addEventListener('click', (event) => {
    const reauth = event.target.closest('[data-reauth-account]');
    if (reauth) {
        state.reauthAccountId = reauth.dataset.reauthAccount;
        void requestRender();
    }
});

elements.completeHumanVerification.addEventListener('click', async () => {
    elements.authError.hidden = true;
    try {
        await window.bridgeApi.completeHumanVerification();
        elements.password.value = '';
        await renderState();
    } catch (error) {
        await renderState();
        setAuthError(error instanceof Error ? error.message : String(error));
    }
});

elements.openHumanVerification.addEventListener('click', async () => {
    await window.bridgeApi.openHumanVerification();
});

elements.refreshButton.addEventListener('click', async () => {
    await withLoading(elements.refreshButton, async () => {
        try {
            await window.bridgeApi.refreshNow(null); // every account
            await renderState();
        } catch (error) {
            setDashboardError(error instanceof Error ? error.message : String(error));
        }
    });
});

// Sync one calendar / a group; a second click on a calendar queued by hand takes it off the queue.
elements.calendarList.addEventListener('click', async (event) => {
    const calendarButton = event.target.closest('[data-sync-calendar]');
    const groupButton = event.target.closest('[data-sync-group]');
    const dot = event.target.closest('[data-status-calendar]');
    try {
        if (calendarButton || groupButton) {
            const button = calendarButton || groupButton;
            button.disabled = true;
            try {
                if (calendarButton) {
                    await window.bridgeApi.syncCalendar(state.selectedAccountId, calendarButton.dataset.syncCalendar);
                } else {
                    await window.bridgeApi.syncCategory(state.selectedAccountId, groupButton.dataset.syncGroup);
                }
            } finally {
                button.disabled = false;
                lastCalendarListHtml = ''; // draw the list again even if nothing visible changed
                await renderState();
            }
        } else if (dot) {
            // A click pins the details until a click anywhere else.
            const id = dot.dataset.statusCalendar;
            const samePinned = statusPopover.pinned && statusPopover.calendarId === id;
            statusPopover.calendarId = samePinned ? null : id;
            statusPopover.pinned = !samePinned;
            updateStatusPopover();
        }
    } catch (error) {
        setDashboardError(error instanceof Error ? error.message : String(error));
    }
});

// Hovering a dot shows its details, hovering a sync control its hint; leaving hides them (unless pinned by a click).
elements.calendarList.addEventListener('mouseover', (event) => {
    const dot = event.target.closest('[data-status-calendar]');
    const control = event.target.closest('[data-hint]');
    if (dot && !statusPopover.pinned) {
        statusPopover.calendarId = dot.dataset.statusCalendar;
        updateStatusPopover();
    } else if (control && !statusPopover.pinned) {
        statusPopover.hintElement = control;
        updateStatusPopover();
    }
});
elements.calendarList.addEventListener('mouseout', (event) => {
    const dot = event.target.closest('[data-status-calendar]');
    const control = event.target.closest('[data-hint]');
    if (dot && !statusPopover.pinned && !dot.contains(event.relatedTarget)) {
        statusPopover.calendarId = null;
        updateStatusPopover();
    } else if (control && !control.contains(event.relatedTarget)) {
        statusPopover.hintElement = null;
        updateStatusPopover();
    }
});
document.addEventListener('click', (event) => {
    if (statusPopover.pinned && !event.target.closest('[data-status-calendar]') && !event.target.closest('#status-popover')) {
        statusPopover.calendarId = null;
        statusPopover.pinned = false;
        updateStatusPopover();
    }
});
window.addEventListener('resize', () => updateStatusPopover());
document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && (statusPopover.calendarId || statusPopover.hintElement)) {
        statusPopover.calendarId = null;
        statusPopover.hintElement = null;
        statusPopover.pinned = false;
        updateStatusPopover();
    }
});
document.querySelector('.nav-content')?.addEventListener('scroll', () => updateStatusPopover());

elements.calendarList.addEventListener('change', async (event) => {
    const checkbox = event.target.closest('.calendar-sync-toggle');
    const calendarId = checkbox?.dataset.calendarId;
    if (!checkbox || !calendarId || calendarTogglesPending.has(calendarId)) return;

    // 0.48: only this switch waits while the change is saved (the bridge no longer waits for the sync it
    // starts), so other calendars can be ticked or unticked while an account syncs.
    calendarTogglesPending.add(calendarId);
    checkbox.disabled = true;
    try {
        await window.bridgeApi.setCalendarSyncEnabled(state.selectedAccountId, calendarId, checkbox.checked);
        elements.dashboardError.hidden = true;
    } catch (error) {
        setDashboardError(error instanceof Error ? error.message : String(error));
    } finally {
        calendarTogglesPending.delete(calendarId);
        lastCalendarListHtml = null; // the row was disabled by hand above: rebuild it whatever the state says
        await renderState();
        // The switch was disabled while the change was saved (a disabled control loses the focus):
        // the keyboard stays on the one that was toggled (0.37.16).
        elements.calendarList.querySelector(`.calendar-sync-toggle[data-calendar-id="${CSS.escape(calendarId)}"]`)?.focus();
    }
});

elements.openAtLogin.addEventListener('change', async () => {
    try {
        await window.bridgeApi.setOpenAtLogin(elements.openAtLogin.checked);
        await renderState();
    } catch (error) {
        setDashboardError(error instanceof Error ? error.message : String(error));
    }
});

elements.settingPollInterval.addEventListener('change', async () => {
    try {
        await window.bridgeApi.updateConfig({ pollIntervalMs: Number(elements.settingPollInterval.value) });
        await renderState();
    } catch (error) {
        setDashboardError(error instanceof Error ? error.message : String(error));
    }
});

elements.settingLookback.addEventListener('change', async () => {
    try {
        await window.bridgeApi.updateConfig({ eventLookbackDays: Number(elements.settingLookback.value) });
        await renderState();
    } catch (error) {
        setDashboardError(error instanceof Error ? error.message : String(error));
    }
});

elements.settingTheme.addEventListener('change', async () => {
    applyTheme(elements.settingTheme.value);
    try {
        await window.bridgeApi.updateConfig({ theme: elements.settingTheme.value });
    } catch (error) {
        setDashboardError(error instanceof Error ? error.message : String(error));
    }
});

elements.settingLookahead.addEventListener('change', async () => {
    try {
        await window.bridgeApi.updateConfig({ eventLookaheadDays: Number(elements.settingLookahead.value) });
        await renderState();
    } catch (error) {
        setDashboardError(error instanceof Error ? error.message : String(error));
    }
});

elements.settingLanguage.addEventListener('change', async () => {
    try {
        await window.bridgeApi.updateConfig({ appLanguage: elements.settingLanguage.value });
        await renderState();
    } catch (error) {
        setDashboardError(error instanceof Error ? error.message : String(error));
        elements.settingLanguage.value = state.bridgeState?.appLanguage || 'system';
    }
});

elements.settingInvitationLanguage.addEventListener('change', async () => {
    const language = elements.settingInvitationLanguage.value;
    try {
        await window.bridgeApi.updateConfig({ invitationEmailLanguage: language }, state.selectedAccountId);
        await renderState();
    } catch (error) {
        setDashboardError(error instanceof Error ? error.message : String(error));
        elements.settingInvitationLanguage.value = state.bridgeState?.invitationEmailLanguage || 'proton';
    }
});

elements.settingSendEmails.addEventListener('change', async () => {
    const mode = elements.settingSendEmails.checked ? 'live' : 'dry-run';
    if (mode === 'live' && !confirm(t('Live mode: answers from Calendar.app are emailed to the real organizers. Switch to live?'))) {
        elements.settingSendEmails.checked = false;
        return;
    }
    try {
        await window.bridgeApi.updateConfig({ invitationEmailMode: mode });
        await renderState();
    } catch (error) {
        setDashboardError(error instanceof Error ? error.message : String(error));
    }
});

elements.settingNewCalendarAddress.addEventListener('change', async () => {
    try {
        await window.bridgeApi.updateConfig({ newCalendarAddress: elements.settingNewCalendarAddress.value }, state.selectedAccountId);
        await renderState();
    } catch (error) {
        setDashboardError(error instanceof Error ? error.message : String(error));
    }
});

elements.settingCalendarEmails.addEventListener('change', async () => {
    try {
        await window.bridgeApi.updateConfig({ calendarEmailsAfter: elements.settingCalendarEmails.value }, state.selectedAccountId);
        await renderState();
    } catch (error) {
        setDashboardError(error instanceof Error ? error.message : String(error));
    }
});

elements.settingCalendarEmailsFolder.addEventListener('change', async () => {
    const name = elements.settingCalendarEmailsFolder.value.trim();
    try {
        await window.bridgeApi.updateConfig({ calendarEmailsFolder: name }, state.selectedAccountId);
        elements.settingCalendarEmailsFolder.setCustomValidity('');
        await renderState();
    } catch (error) {
        // e.g. "Inbox" or a name with "/": say why and keep the saved name.
        const message = error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(error);
        elements.settingCalendarEmailsFolder.setCustomValidity(message);
        elements.settingCalendarEmailsFolder.reportValidity();
        elements.settingCalendarEmailsFolder.value = state.bridgeState?.calendarEmailsFolder || 'Calendar';
    }
});

elements.settingCalendarEmailsFolder.addEventListener('input', () => {
    elements.settingCalendarEmailsFolder.setCustomValidity('');
});

elements.settingCalendarEmailsFolder.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
        elements.settingCalendarEmailsFolder.blur(); // saves (change event)
    }
});

// 1.0.2: the Info card's update line and buttons, from the updater's state (main.ts).
const renderUpdate = (update) => {
    const status = update?.status || 'unsupported';
    const version = update?.version || '';
    const texts = {
        unsupported: t('Updates are checked in the installed app only.'),
        idle: update?.automatic ? t('Checked automatically a minute after start and then daily; new versions come from GitHub Releases.') : t('Automatic checks are off (Settings → General); the button checks now.'),
        checking: t('Checking for updates…'),
        'up-to-date': t('You have the newest version.'),
        downloading: t('Downloading {version}… {percent}%', { version, percent: update?.percent ?? 0 }),
        downloaded: t('Version {version} is downloaded. Restart to Update installs it now; otherwise it is installed when the app quits.', { version }),
        error: t('The check failed: {error}', { error: update?.error || '' })
    };
    elements.updateStatus.textContent = texts[status] || texts.idle;
    elements.updateStatus.classList.toggle('setting-error', status === 'error');
    elements.checkForUpdates.disabled = status === 'unsupported' || status === 'checking' || status === 'downloading' || status === 'downloaded';
    elements.checkForUpdates.title = status === 'unsupported' ? t('Updates are checked in the installed app only.') : '';
    elements.installUpdate.hidden = status !== 'downloaded';
};

elements.checkForUpdates.addEventListener('click', async () => {
    elements.checkForUpdates.disabled = true;
    try {
        renderUpdate(await window.bridgeApi.checkForUpdates());
    } catch (error) {
        setDashboardError(error instanceof Error ? error.message : String(error));
    }
    await renderState();
});

elements.installUpdate.addEventListener('click', async () => {
    try {
        await window.bridgeApi.installUpdate();
    } catch (error) {
        setDashboardError(error instanceof Error ? error.message : String(error));
    }
});

elements.settingAutoUpdate.addEventListener('change', async () => {
    try {
        await window.bridgeApi.updateConfig({ autoUpdate: elements.settingAutoUpdate.checked });
        await renderState();
    } catch (error) {
        setDashboardError(error instanceof Error ? error.message : String(error));
    }
});

elements.settingNotifications.addEventListener('change', async () => {
    try {
        await window.bridgeApi.updateConfig({ notifications: elements.settingNotifications.checked });
        await renderState();
    } catch (error) {
        setDashboardError(error instanceof Error ? error.message : String(error));
    }
});

elements.settingNotificationTitles.addEventListener('change', async () => {
    try {
        await window.bridgeApi.updateConfig({ notificationTitles: elements.settingNotificationTitles.checked });
        await renderState();
    } catch (error) {
        setDashboardError(error instanceof Error ? error.message : String(error));
    }
});

elements.settingDetailedLogging.addEventListener('change', async () => {
    try {
        await window.bridgeApi.updateConfig({ detailedLogging: elements.settingDetailedLogging.value });
        elements.settingDetailedLogging.blur();
        await renderState();
    } catch (error) {
        setDashboardError(error instanceof Error ? error.message : String(error));
    }
});

elements.deleteLogs.addEventListener('click', async () => {
    try {
        await window.bridgeApi.deleteLogs();
        elements.deleteLogs.textContent = t('Deleted');
        setTimeout(() => (elements.deleteLogs.textContent = t('Delete the Logs')), 1500);
    } catch (error) {
        setDashboardError(error instanceof Error ? error.message : String(error));
    }
});

elements.openChangelog.addEventListener('click', async () => {
    try {
        // The dialog has its own title: the file's "# Changelog" heading is left out.
        const text = String((await window.bridgeApi.getChangelog()) || '').replace(/^#\s+Changelog\s*\n/, '');
        elements.changelogBody.innerHTML = text.trim() ? renderMarkdown(text) : '<p>The changelog is not part of this build.</p>';
    } catch (error) {
        elements.changelogBody.innerHTML = `<p>${escapeHtml(error instanceof Error ? error.message : String(error))}</p>`;
    }
    elements.changelogDialog.showModal();
    elements.changelogBody.scrollTop = 0;
});

elements.closeChangelog.addEventListener('click', () => elements.changelogDialog.close());

// A click on the dimmed backdrop (outside the dialog's box) closes it too; Escape does natively.
elements.changelogDialog.addEventListener('click', (event) => {
    if (event.target === elements.changelogDialog) {
        elements.changelogDialog.close();
    }
});

elements.settingDeveloperMode.addEventListener('change', async () => {
    try {
        await window.bridgeApi.updateConfig({ developerMode: elements.settingDeveloperMode.checked });
        await renderState();
    } catch (error) {
        setDashboardError(error instanceof Error ? error.message : String(error));
    }
});

// Links on the Info page open in the default browser, never inside the app window.
document.addEventListener('click', (event) => {
    const link = event.target.closest('.external-link');
    if (!link) return;
    event.preventDefault();
    void window.bridgeApi.openExternal(link.dataset.href);
});

// Copy-to-clipboard on detail cards
document.addEventListener('click', (event) => {
    if (event.target.closest('#toggle-password')) {
        caldavPasswordVisible = !caldavPasswordVisible;
        void renderState();
        return;
    }

    const goTo = event.target.closest('[data-go-to]');
    if (goTo) {
        if (goTo.dataset.goToAccount) {
            state.selectedAccountId = goTo.dataset.goToAccount;
        }
        navigateTo(goTo.dataset.goTo);
        void requestRender();
        return;
    }

    if (event.target.closest('#set-up-calendar-app')) {
        void withLoading(elements.setUpCalendarApp, async () => {
            elements.calendarAppError.hidden = true;
            const result = await window.bridgeApi.setUpCalendarApp(state.selectedAccountId);
            if (result.opened) {
                calendarAppStepsShown = true;
                elements.calendarAppSteps.hidden = false;
            } else {
                elements.calendarAppError.textContent = t('macOS did not take the profile{error}. Use "Manual Setup" below.', { error: result.error ? ` (${result.error})` : '' });
                elements.calendarAppError.hidden = false;
                showManualSetup(true);
                elements.manualSetup.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
            }
        });
        return;
    }
    if (event.target.closest('#toggle-manual-setup')) {
        showManualSetup(elements.manualSetupBody.hidden);
        return;
    }
    if (event.target.closest('#open-profiles-settings')) {
        void window.bridgeApi.openProfilesSettings();
        return;
    }

    if (event.target.closest('#copy-caldav-password')) {
        void window.bridgeApi.copyCalDAVPassword(state.selectedAccountId).then(() => {
            elements.copyCaldavPassword.textContent = t('Copied (for 90 s)');
            setTimeout(() => (elements.copyCaldavPassword.textContent = t('Copy Password')), 1500);
        });
        return;
    }

    const card = event.target.closest('.detail-card');
    // The password cards: copied by the app, and removed from the clipboard again after 90 s.
    if (card && (card === elements.detailPassword.closest('.detail-card') || card.hasAttribute('data-copy-password'))) {
        void window.bridgeApi.copyCalDAVPassword(state.selectedAccountId).then(() => {
            card.classList.add('copied');
            setTimeout(() => card.classList.remove('copied'), 1200);
        });
        return;
    }
    if (card) {
        const value = card.dataset.copyValue || card.querySelector('strong')?.textContent;
        if (value) {
            navigator.clipboard.writeText(value).then(() => {
                card.classList.add('copied');
                setTimeout(() => card.classList.remove('copied'), 1200);
            });
        }
    }
});

// ─── Bootstrap ────────────────────────────────────────────────────────────────

window.addEventListener('bridge:verification-complete', () => {
    void renderState();
});

/** Re-renders when the bridge reports a change (one render at a time, the last one wins). */
let renderPending = false;
let renderRunning = false;
const requestRender = async () => {
    if (renderRunning) {
        renderPending = true;
        return;
    }
    renderRunning = true;
    try {
        await renderState();
    } catch {
        // the next change or the timer tries again
    } finally {
        renderRunning = false;
        if (renderPending) {
            renderPending = false;
            void requestRender();
        }
    }
};

const bootstrap = async () => {
    initNav();
    window.bridgeApi.onStateChanged?.(() => void requestRender());
    await renderState();
    setInterval(() => void requestRender(), 15000);
};

void bootstrap();
