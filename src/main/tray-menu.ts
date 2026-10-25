/**
 * The menu-bar menu, laid out like Proton Mail Bridge's: status (opens the Overview), then per
 * account its address with Refresh Now and Web Calendar under it (0.36: one block per account, in the
 * order chosen in Settings; 0.39: Web Calendar per account — Proton's account page picks the browser's
 * session of that address), then Setup / Settings / Info (0.32.1, 0.32.6) and Quit Bridge. Kept
 * free of Electron so it can be tested; main.ts turns the items into a native menu (icons from
 * resources/icons/menu, accelerators shown on the right).
 */
import type { BridgeHealth } from '../shared/types';
import { t } from './i18n';
import type { TrayCalendarsStatus } from './sync-schedule';

/**
 * The connection line's states. 0.46: it shows the connection to Proton, not how the accounts are
 * doing (their own lines show that): connected (green: at least one account is signed in and Proton
 * answers), connecting (blue: nothing verified yet, e.g. right after the app starts), warning (yellow:
 * Proton answers but asked to slow down), error (red: no connection, or no account signed in).
 */
export type TrayStatus = 'connecting' | 'connected' | 'warning' | 'error';

/**
 * 0.46: what an account is doing. connecting / verification / first-sync are blue (nothing verified
 * this run, nothing wrong either); ready means its first pass of this run went through.
 */
export type TrayPhase = 'connecting' | 'verification' | 'first-sync' | 'ready' | 'offline' | 'limited' | 'signed-out' | 'error';

/** What the menu needs from one account (BridgeService.getTrayState). */
export interface TrayState {
    health: BridgeHealth;
    message: string;
    signedIn: boolean;
    username: string | null;
    /** The calendars' dot: red, yellow, syncing (instead of green) or green. */
    calendars?: TrayCalendarsStatus;
    /** 0.46: see TrayPhase; without it, taken from the health. */
    phase?: TrayPhase;
}

/** 0.36: an account in the menu. */
export interface TrayAccount extends TrayState {
    id: string;
}

/** 0.36: every account, in order, and the one being signed in (none yet, or one being added). */
export interface TrayAppState {
    accounts: TrayAccount[];
    signingIn: TrayState | null;
}

export type TrayPage = 'overview' | 'calendars' | 'setup' | 'settings' | 'info';
export type TrayAction = { open: TrayPage; account?: string } | { sync: string | null } | { web: string | null } | 'web' | 'quit';

export type TrayMenuItem =
    | { type: 'separator' }
    | { type: 'item'; label: string; icon?: string; accelerator?: string; action: TrayAction; enabled?: boolean };

/** Proton Calendar on the web (what Help used to open). */
export const WEB_CALENDAR_URL = 'https://calendar.proton.me';

/**
 * 0.39: Proton Calendar on the web for one account. Proton's account page takes an `email` hint
 * (WebClients, persistedSessionHelper.ts → pickSessionByEmail): it opens the app in the browser's
 * session whose primary address matches, and shows Proton's account chooser or sign-in when the
 * browser has none. Without an address, the plain web calendar.
 */
export const webCalendarUrl = (address?: string | null) => {
    if (!address || !/^[^@\s]+@[^@\s]+$/.test(address)) {
        return WEB_CALENDAR_URL;
    }
    const url = new URL('https://account.proton.me/calendar');
    url.searchParams.set('email', address.toLowerCase());
    return url.toString();
};

/** 0.46: an account's phase (from its health when the service did not say). */
export const phaseOf = (state: TrayState | null): TrayPhase => {
    if (!state) {
        return 'connecting';
    }
    if (state.phase) {
        return state.phase;
    }
    switch (state.health) {
        case 'healthy':
        case 'syncing':
            return state.signedIn ? 'ready' : 'signed-out';
        case 'connecting':
            return 'connecting';
        case 'error':
            return 'error';
        default:
            return 'signed-out';
    }
};

/** 0.46: Proton has this account signed in and answers (whatever its calendars are doing). */
const reachesProton = (state: TrayState) => state.signedIn && !['offline', 'limited', 'connecting', 'verification', 'signed-out'].includes(phaseOf(state));

/**
 * The connection line for one account (also for the account being signed in when there is none).
 * `null` = the bridge is still starting.
 */
export const trayStatusOf = (state: TrayState | null): { status: TrayStatus; label: string } => {
    if (state && reachesProton(state)) {
        return { status: 'connected', label: t('Connected') };
    }
    switch (phaseOf(state)) {
        case 'connecting':
        case 'verification':
        case 'first-sync':
            return { status: 'connecting', label: t('Connecting…') };
        case 'limited':
            return { status: 'warning', label: t('Connection Limited') };
        case 'offline':
            return { status: 'error', label: t('No Connection') };
        case 'signed-out':
            return { status: 'error', label: t('Signed out') };
        default:
            return { status: 'error', label: t('Not Connected') };
    }
};

/**
 * 0.46: the connection line over all accounts: green as soon as one account reaches Proton (an account
 * with trouble shows it on its own line), else blue while one still connects, else yellow when Proton
 * asked to slow down, else red (no connection; signed out). Without accounts, the sign-in's state.
 */
export const trayOverallStatus = (state: TrayAppState | null): { status: TrayStatus; label: string } => {
    if (!state) {
        return trayStatusOf(null);
    }
    if (!state.accounts.length) {
        return trayStatusOf(state.signingIn ?? { health: 'disconnected', message: '', signedIn: false, username: null, phase: 'signed-out' });
    }
    const statuses = state.accounts.map((account) => trayStatusOf(account));
    const rank: TrayStatus[] = ['connected', 'connecting', 'warning', 'error'];
    return rank.map((status) => statuses.find((entry) => entry.status === status)).find(Boolean) ?? statuses[0];
};

/**
 * The account line's icon. Red: no connection, signed out, a calendar failing. Yellow: something was
 * refused, or Proton asked to slow down. 0.46: blue while nothing is verified yet this run (signing in,
 * the first pass after the app started: the sync symbol in blue); green once that went through.
 */
export const accountIconOf = (state: TrayState | null): string => {
    const phase = phaseOf(state);
    if (!state || phase === 'connecting' || phase === 'verification') {
        return 'account-connecting';
    }
    const syncing = state.health === 'syncing' || state.calendars === 'syncing' || state.calendars === 'warning-syncing';
    if (!state.signedIn || phase === 'offline' || phase === 'signed-out' || phase === 'error' || state.calendars === 'error') {
        return 'account-error';
    }
    if (phase === 'limited') {
        return 'account-warning';
    }
    if (state.calendars === 'warning' || state.calendars === 'warning-syncing') {
        // a yellow ring, not a dot: readable without colour; 0.45.2: the sync symbol in yellow while syncing
        return syncing ? 'account-syncing-warning' : 'account-warning';
    }
    if (phase === 'first-sync') {
        return syncing ? 'account-syncing-initial' : 'account-connecting';
    }
    return syncing ? 'account-syncing' : 'account-connected';
};

/** 0.46: a line under the account's address saying what is going on, when that is not plain sailing. */
const accountNoteOf = (account: TrayAccount): { label: string; page: TrayPage } | null => {
    switch (phaseOf(account)) {
        case 'connecting':
            return { label: t('Connecting to Proton…'), page: 'overview' };
        case 'verification':
            return { label: t('Verification Needed — Open the Bridge'), page: 'overview' };
        case 'offline':
            return { label: t('No Connection — Trying Again'), page: 'overview' };
        case 'limited':
            return { label: t('Proton Asked to Slow Down'), page: 'overview' };
        case 'signed-out':
            return { label: t('Signed Out — Sign In on the Setup Page'), page: 'setup' };
        case 'error':
            return { label: t('Not Working — See Overview'), page: 'overview' };
        default:
            return account.calendars === 'error'
                ? { label: t('A Calendar Fails — See Calendars'), page: 'calendars' }
                : account.calendars === 'warning' || account.calendars === 'warning-syncing'
                  ? { label: t('Needs Attention — See Calendars'), page: 'calendars' }
                  : null;
    }
};

/** One account's block: its address, Refresh Now and Web Calendar (the shortcuts only while it is the only account). */
const accountItems = (account: TrayAccount, shortcuts: boolean): TrayMenuItem[] => {
    const syncing = account.health === 'syncing' || account.calendars === 'syncing' || account.calendars === 'warning-syncing';
    const note = accountNoteOf(account);
    return [
        {
            type: 'item',
            label: account.username || t('Proton Account'),
            icon: accountIconOf(account),
            action: { open: 'calendars', account: account.id }
        },
        ...(note ? [{ type: 'item', label: note.label, icon: 'blank', action: { open: note.page, account: account.id } } as TrayMenuItem] : []),
        // Refresh now (0.29): the Refresh button's pass, straight from the menu; greyed while a pass
        // runs. A blank icon keeps its text aligned with the account's address above it.
        { type: 'item', label: syncing ? t('Refreshing…') : t('Refresh Now'), icon: 'blank', ...(shortcuts ? { accelerator: 'CommandOrControl+R' } : {}), action: { sync: account.id }, enabled: !syncing },
        { type: 'item', label: t('Web Calendar'), icon: 'blank', ...(shortcuts ? { accelerator: 'CommandOrControl+W' } : {}), action: { web: account.id } }
    ];
};

export const trayMenuItems = (state: TrayAppState | null): TrayMenuItem[] => {
    const { status, label } = trayOverallStatus(state);
    const accounts = state?.accounts ?? [];
    const items: TrayMenuItem[] = [{ type: 'item', label, icon: `status-${status}`, accelerator: 'CommandOrControl+F1', action: { open: 'overview' } }, { type: 'separator' }];
    if (!accounts.length) {
        // Signed out, the Calendars tab has nothing to show; the sign-in form is on Overview.
        items.push({ type: 'item', label: t('Not Signed In'), icon: `account-${status}`, action: { open: 'overview' } }, { type: 'separator' });
    }
    for (const account of accounts) {
        items.push(...accountItems(account, accounts.length === 1), { type: 'separator' });
    }
    items.push(
        { type: 'item', label: t('Setup'), accelerator: 'CommandOrControl+U', action: { open: 'setup' } },
        { type: 'item', label: t('Settings'), accelerator: 'CommandOrControl+,', action: { open: 'settings' } },
        { type: 'item', label: t('Info'), accelerator: 'CommandOrControl+I', action: { open: 'info' } },
        { type: 'separator' },
        // Without an account there is no block to put it in: the plain web calendar, in its own section.
        ...(accounts.length ? [] : ([{ type: 'item', label: t('Web Calendar'), accelerator: 'CommandOrControl+W', action: 'web' }, { type: 'separator' }] as TrayMenuItem[])),
        { type: 'item', label: t('Quit Bridge'), accelerator: 'CommandOrControl+Q', action: 'quit' }
    );
    return items;
};
