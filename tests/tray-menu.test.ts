/** The menu-bar menu (layout like Proton Mail Bridge's), its three states, and (0.36) one block per account. */
import test from 'node:test';
import assert from 'node:assert/strict';

import { trayMenuItems, trayOverallStatus, trayStatusOf, webCalendarUrl, WEB_CALENDAR_URL } from '../src/main/tray-menu';
import type { TrayAccount, TrayAppState, TrayState } from '../src/main/tray-menu';

const state = (health: TrayState['health'], extra: Partial<TrayState> = {}): TrayState => ({
    health,
    message: '',
    signedIn: true,
    username: 'tobi.bridge',
    ...extra
});
const account = (id: string, health: TrayState['health'], extra: Partial<TrayState> = {}): TrayAccount => ({ id, ...state(health, { username: `${id}@proton.me`, ...extra }) });
const one = (health: TrayState['health'], extra: Partial<TrayState> = {}): TrayAppState => ({ accounts: [{ id: 'a1', ...state(health, extra) }], signingIn: null });
const none = (signingIn: TrayState | null = null): TrayAppState => ({ accounts: [], signingIn });

const shapeOf = (items: ReturnType<typeof trayMenuItems>) =>
    items.map((item) =>
        item.type === 'separator'
            ? '—'
            : [item.label, item.icon ?? '', item.accelerator ?? '', typeof item.action === 'string' ? item.action : 'open' in item.action ? `${item.action.open}${item.action.account ? `:${item.action.account}` : ''}` : 'web' in item.action ? `web:${item.action.web}` : `sync:${item.action.sync}`].join(' | ')
    );

test('0.46: the connection line shows the connection: blue while connecting, green once Proton answers, yellow when it asks to wait, red without', () => {
    assert.deepEqual(trayStatusOf(null), { status: 'connecting', label: 'Connecting…' }, 'still starting');
    assert.equal(trayStatusOf(state('connecting', { signedIn: false })).status, 'connecting');
    assert.equal(trayStatusOf(state('syncing', { phase: 'first-sync' })).status, 'connected', 'signed in and Proton answers: connected, even during the first pass');
    assert.deepEqual(trayStatusOf(state('healthy')), { status: 'connected', label: 'Connected' });
    assert.equal(trayStatusOf(state('error', { phase: 'error' })).status, 'connected', 'Proton answers but something failed: the account line says so, the connection is fine');
    assert.deepEqual(trayStatusOf(state('error', { phase: 'offline' })), { status: 'error', label: 'No Connection' });
    assert.deepEqual(trayStatusOf(state('error', { phase: 'limited' })), { status: 'warning', label: 'Connection Limited' });
    assert.deepEqual(trayStatusOf(state('error', { signedIn: false, phase: 'offline' })), { status: 'error', label: 'No Connection' }, 'offline at start');
    assert.deepEqual(trayStatusOf(state('connecting', { signedIn: false, phase: 'verification' })), { status: 'connecting', label: 'Connecting…' });
    assert.deepEqual(trayStatusOf(state('disconnected', { signedIn: false })), { status: 'error', label: 'Signed out' });
});

test('0.46: over all accounts green as soon as one reaches Proton, else blue while one connects, else yellow, else red', () => {
    assert.deepEqual(trayOverallStatus(null), { status: 'connecting', label: 'Connecting…' });
    assert.deepEqual(trayOverallStatus(none()), { status: 'error', label: 'Signed out' });
    assert.deepEqual(trayOverallStatus(none(state('connecting', { signedIn: false }))), { status: 'connecting', label: 'Connecting…' }, 'the first sign-in runs');
    const overall = (...phases: [TrayState['health'], Partial<TrayState>][]) => trayOverallStatus({ accounts: phases.map(([health, extra], index) => account(`a${index}`, health, extra)), signingIn: null }).status;
    assert.equal(overall(['healthy', {}], ['connecting', { signedIn: false, phase: 'connecting' }]), 'connected', 'one connected is enough');
    assert.equal(overall(['healthy', {}], ['error', { phase: 'error' }]), 'connected', 'an account with trouble does not turn the connection yellow or red');
    assert.equal(overall(['healthy', {}], ['disconnected', { signedIn: false, phase: 'signed-out' }]), 'connected');
    assert.equal(overall(['connecting', { signedIn: false, phase: 'connecting' }], ['connecting', { signedIn: false, phase: 'connecting' }]), 'connecting', 'after starting: blue');
    assert.equal(overall(['connecting', { signedIn: false, phase: 'connecting' }], ['error', { signedIn: false, phase: 'offline' }]), 'connecting', 'one still trying: no verdict yet');
    assert.equal(overall(['error', { phase: 'limited' }], ['error', { phase: 'offline' }]), 'warning');
    assert.equal(overall(['error', { phase: 'offline' }], ['error', { signedIn: false, phase: 'offline' }]), 'error');
});

test('0.46: right after starting every account has its line, blue, with what it does; green once its first pass went through', () => {
    const starting = trayMenuItems({
        accounts: [account('a', 'disconnected', { signedIn: false, phase: 'connecting', calendars: 'error' }), account('b', 'syncing', { phase: 'first-sync', calendars: 'syncing' })],
        signingIn: null
    });
    assert.deepEqual(shapeOf(starting).slice(0, 10), [
        'Connected | status-connected | CommandOrControl+F1 | overview',
        '—',
        'a@proton.me | account-connecting |  | calendars:a',
        'Connecting to Proton… | blank |  | overview:a',
        'Refresh Now | blank |  | sync:a',
        'Web Calendar | blank |  | web:a',
        '—',
        'b@proton.me | account-syncing-initial |  | calendars:b',
        'Refreshing… | blank |  | sync:b',
        'Web Calendar | blank |  | web:b'
    ]);
    const icon = (extra: Partial<TrayState>, health: TrayState['health'] = 'healthy') => (trayMenuItems(one(health, extra))[2] as any).icon;
    assert.equal(icon({ phase: 'first-sync', calendars: 'ok' }), 'account-connecting', 'signed in, pass not started yet: the blue dot');
    assert.equal(icon({ phase: 'ready', calendars: 'syncing' }, 'syncing'), 'account-syncing', 'later passes: green');
    assert.equal(icon({ phase: 'first-sync', calendars: 'warning-syncing' }, 'syncing'), 'account-syncing-warning', 'something went wrong: yellow wins over blue');
    assert.equal(icon({ phase: 'first-sync', calendars: 'error' }, 'syncing'), 'account-error');
    assert.equal(icon({ phase: 'offline', calendars: 'error' }, 'error'), 'account-error');
    assert.equal(icon({ phase: 'limited', calendars: 'error' }, 'error'), 'account-error', 'a calendar failing stays red');
    assert.equal(icon({ phase: 'limited', calendars: 'ok' }, 'error'), 'account-warning');
    assert.equal(icon({ signedIn: false, phase: 'verification' }, 'connecting'), 'account-connecting');
    const note = (extra: Partial<TrayState>, health: TrayState['health'] = 'healthy') => {
        const item = trayMenuItems(one(health, extra))[3] as any;
        return 'sync' in item.action ? null : `${item.label} → ${item.action.open}`;
    };
    assert.equal(note({ phase: 'ready', calendars: 'ok' }), null, 'all well: no extra line');
    assert.equal(note({ phase: 'first-sync', calendars: 'syncing' }, 'syncing'), null, 'the first pass: "Refreshing…" says it');
    assert.equal(note({ signedIn: false, phase: 'verification' }, 'connecting'), 'Verification Needed — Open the Bridge → overview');
    assert.equal(note({ phase: 'offline', calendars: 'error' }, 'error'), 'No Connection — Trying Again → overview');
    assert.equal(note({ phase: 'limited' }, 'error'), 'Proton Asked to Slow Down → overview');
    assert.equal(note({ signedIn: false, phase: 'signed-out' }, 'error'), 'Signed Out — Sign In on the Setup Page → setup');
    assert.equal(note({ phase: 'error', calendars: 'error' }, 'error'), 'Not Working — See Overview → overview');
    assert.equal(note({ phase: 'ready', calendars: 'warning' }), 'Needs Attention — See Calendars → calendars');
    assert.equal(note({ phase: 'ready', calendars: 'error' }), 'A Calendar Fails — See Calendars → calendars');
});

test('one account: menu from top to bottom, with icons, shortcuts and pages — Web Calendar in the account\'s block (0.39)', () => {
    assert.deepEqual(shapeOf(trayMenuItems(one('healthy', { calendars: 'ok' }))), [
        'Connected | status-connected | CommandOrControl+F1 | overview',
        '—',
        'tobi.bridge | account-connected |  | calendars:a1',
        'Refresh Now | blank | CommandOrControl+R | sync:a1',
        'Web Calendar | blank | CommandOrControl+W | web:a1',
        '—',
        'Setup |  | CommandOrControl+U | setup',
        'Settings |  | CommandOrControl+, | settings',
        'Info |  | CommandOrControl+I | info',
        '—',
        'Quit Bridge |  | CommandOrControl+Q | quit'
    ]);
});

test('several accounts: one block each (address, Refresh Now, Web Calendar), in order, without shortcuts', () => {
    const items = trayMenuItems({ accounts: [account('b', 'healthy', { calendars: 'ok' }), account('a', 'syncing', { calendars: 'syncing' })], signingIn: null });
    assert.deepEqual(shapeOf(items), [
        'Connected | status-connected | CommandOrControl+F1 | overview',
        '—',
        'b@proton.me | account-connected |  | calendars:b',
        'Refresh Now | blank |  | sync:b',
        'Web Calendar | blank |  | web:b',
        '—',
        'a@proton.me | account-syncing |  | calendars:a',
        'Refreshing… | blank |  | sync:a',
        'Web Calendar | blank |  | web:a',
        '—',
        'Setup |  | CommandOrControl+U | setup',
        'Settings |  | CommandOrControl+, | settings',
        'Info |  | CommandOrControl+I | info',
        '—',
        'Quit Bridge |  | CommandOrControl+Q | quit'
    ]);
    assert.equal((items[7] as any).enabled, false, 'the syncing account cannot be refreshed again');
    assert.equal((items[3] as any).enabled, true);
});

test("the account dot shows the calendars: green, syncing, yellow, red — independent of the connection's colour", () => {
    const icon = (extra: Partial<TrayState>, health: TrayState['health'] = 'healthy') => (trayMenuItems(one(health, extra))[2] as any).icon;
    assert.equal(icon({ calendars: 'ok' }), 'account-connected');
    assert.equal(icon({ calendars: 'syncing' }, 'syncing'), 'account-syncing', 'the green dot becomes the sync symbol while syncing');
    assert.equal(icon({ calendars: 'warning-syncing' }, 'syncing'), 'account-syncing-warning', '0.45.2: yellow while syncing: the yellow sync symbol');
    assert.equal(icon({ calendars: 'warning' }), 'account-warning', 'yellow ring: something was refused, the connection stays green');
    assert.equal((trayMenuItems(one('healthy', { calendars: 'warning' }))[0] as any).icon, 'status-connected');
    assert.equal(icon({ calendars: 'error' }), 'account-error');
    assert.equal(icon({ calendars: 'ok' }, 'error'), 'account-error', 'no connection: red');
});

test('no account: "Not Signed In" leads to the sign-in page; still starting shows connecting', () => {
    const connecting = trayMenuItems(null);
    assert.deepEqual(connecting[0], { type: 'item', label: 'Connecting…', icon: 'status-connecting', accelerator: 'CommandOrControl+F1', action: { open: 'overview' } });
    assert.deepEqual(connecting[2], { type: 'item', label: 'Not Signed In', icon: 'account-connecting', action: { open: 'overview' } }, '0.46: in blue');
    assert.equal(connecting.some((item) => item.type === 'item' && typeof item.action === 'object' && 'sync' in item.action), false, 'nothing to sync');
    const signedOut = trayMenuItems(none());
    assert.deepEqual(signedOut[0], { type: 'item', label: 'Signed out', icon: 'status-error', accelerator: 'CommandOrControl+F1', action: { open: 'overview' } });
    assert.deepEqual(signedOut[2], { type: 'item', label: 'Not Signed In', icon: 'account-error', action: { open: 'overview' } });
    const failed = trayMenuItems(one('error', { phase: 'offline' }));
    assert.equal((failed[0] as any).icon, 'status-error');
    assert.equal((failed[2] as any).icon, 'account-error');
    assert.equal((failed[2] as any).label, 'tobi.bridge');
});

test('Refresh now sits under the account, aligned with its text: greyed and renamed while a pass runs', () => {
    const syncItem = (items: ReturnType<typeof trayMenuItems>) => items.find((item) => item.type === 'item' && typeof item.action === 'object' && 'sync' in item.action) as any;
    assert.deepEqual(syncItem(trayMenuItems(one('healthy', { calendars: 'ok' }))), { type: 'item', label: 'Refresh Now', icon: 'blank', accelerator: 'CommandOrControl+R', action: { sync: 'a1' }, enabled: true });
    assert.deepEqual(syncItem(trayMenuItems(one('syncing', { calendars: 'syncing' }))), { type: 'item', label: 'Refreshing…', icon: 'blank', accelerator: 'CommandOrControl+R', action: { sync: 'a1' }, enabled: false });
    assert.equal(syncItem(trayMenuItems(one('healthy', { calendars: 'syncing' }))).enabled, false, 'a single calendar syncing counts too');
    assert.equal(syncItem(trayMenuItems(one('error', { calendars: 'error' }))).enabled, true, 'offline or failed: still offered (the pass reports what is wrong)');
    const items = trayMenuItems(one('healthy'));
    assert.equal(items[2].type === 'item' && items[2].label, 'tobi.bridge');
    assert.deepEqual(items[3].type === 'item' && items[3].action, { sync: 'a1' }, 'directly under the account line');
    assert.deepEqual(items[4].type === 'item' && items[4].action, { web: 'a1' }, 'then Web Calendar (0.39)');
    assert.equal(items[5].type, 'separator');
});

test('0.39: Web Calendar for an account asks Proton\'s account page for that address; without accounts the plain web calendar', () => {
    assert.equal(webCalendarUrl('Tobi.Test@Proton.me'), 'https://account.proton.me/calendar?email=tobi.test%40proton.me');
    assert.equal(webCalendarUrl('tobi.bridge'), WEB_CALENDAR_URL, 'a user name is no address');
    assert.equal(webCalendarUrl(null), WEB_CALENDAR_URL);
    assert.equal(webCalendarUrl('a b@c'), WEB_CALENDAR_URL);
    const signedOut = trayMenuItems(none());
    const web = signedOut.filter((item) => item.type === 'item' && item.label === 'Web Calendar') as any[];
    assert.equal(web.length, 1);
    assert.deepEqual(web[0], { type: 'item', label: 'Web Calendar', accelerator: 'CommandOrControl+W', action: 'web' });
});
