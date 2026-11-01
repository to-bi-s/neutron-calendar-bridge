/**
 * The bridge adapter, checked offline with a fake Herbert: which calls a sequence of
 * bridge states produces.
 *   node --test prototypes/herbert/test/
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const createHerbertBridge = createRequire(import.meta.url)(join(here, '..', 'lib', 'herbert-bridge.js'));

const fake = () => {
    const calls = [];
    return {
        calls,
        setState: (s, o) => calls.push(['setState', s, o && o.quiet ? 'quiet' : undefined].filter((x) => x !== undefined).join(':')),
        react: (r) => calls.push('react:' + r),
        setPending: (n) => calls.push('pending:' + n),
        setBusy: (b) => calls.push('busy:' + b),
        reactions: () => calls.filter((c) => c.startsWith('react:')),
        states: () => calls.filter((c) => c.startsWith('setState')),
    };
};
const noon = () => new Date(2026, 10, 1, 12, 0).getTime();
const account = (patch) => ({
    health: 'healthy', signedIn: true, pendingChanges: 0, lastSuccessfulSyncAt: noon() - 60000,
    syncStats: { lastDirection: 'pull' }, calendarApp: { thisRun: true, lastRequestAt: noon() - 60000 }, ...patch,
});

test('a delivered change: pending drops after a push', () => {
    const h = fake(); const a = createHerbertBridge(h, { now: noon });
    a.update(a.factsFromBridgeState([account({ pendingChanges: 2, syncStats: { lastDirection: 'push' } })]));
    a.update(a.factsFromBridgeState([account({ pendingChanges: 0, syncStats: { lastDirection: 'push' } })]));
    assert.deepEqual(h.reactions(), ['react:delivered']);
    assert.ok(h.calls.includes('pending:2') && h.calls.includes('pending:0'));
});

test('an error makes him worried, the recovery content', () => {
    const h = fake(); const a = createHerbertBridge(h, { now: noon });
    a.update(a.factsFromBridgeState([account()]));
    a.update(a.factsFromBridgeState([account({ health: 'error' })]));
    a.update(a.factsFromBridgeState([account({ health: 'healthy' })]));
    assert.deepEqual(h.states(), ['setState:worried', 'setState:content']);
});

test('offline puts him to sleep, the connection back wakes him', () => {
    const h = fake(); const a = createHerbertBridge(h, { now: noon });
    a.update(a.factsFromBridgeState([account({ phase: 'offline' })]));
    assert.deepEqual(h.states(), ['setState:asleep']);
    a.update(a.factsFromBridgeState([account({ phase: 'healthy' })]));
    assert.deepEqual(h.states().slice(1), ['setState:idle:quiet']);
    assert.deepEqual(h.reactions(), ['react:online']);
});

test('nothing plays while offline, except sign-in news', () => {
    const h = fake(); const a = createHerbertBridge(h, { now: noon });
    a.update(a.factsFromBridgeState([account({ phase: 'offline', pendingChanges: 3, syncStats: { lastDirection: 'push' } })]));
    a.update(a.factsFromBridgeState([account({ phase: 'offline', pendingChanges: 0, syncStats: { lastDirection: 'push' } })]));
    assert.deepEqual(h.reactions(), []);
});

test('sign-in, verification, slow-down, app connected, each once on the change', () => {
    const h = fake(); const a = createHerbertBridge(h, { now: noon });
    a.update(a.factsFromBridgeState([account({ signedIn: false, calendarApp: { thisRun: false } })]));
    a.update(a.factsFromBridgeState([account({ calendarApp: { thisRun: false } })]));
    a.update(a.factsFromBridgeState([account({ pendingHumanVerification: { x: 1 }, calendarApp: { thisRun: false } })]));
    a.update(a.factsFromBridgeState([account({ pendingHumanVerification: { x: 1 }, calendarApp: { thisRun: false } })]));
    a.update(a.factsFromBridgeState([account({ phase: 'limited', calendarApp: { thisRun: false } })]));
    a.update(a.factsFromBridgeState([account()]));
    assert.deepEqual(h.reactions(), ['react:signedIn', 'react:signInNeeded', 'react:slowdown', 'react:appConnected']);
});

test('busy syncing shows the spinner', () => {
    const h = fake(); const a = createHerbertBridge(h, { now: noon });
    a.update(a.factsFromBridgeState([account({ health: 'syncing' })]));
    assert.ok(h.calls.includes('busy:true'));
    assert.deepEqual(h.states(), []); // syncing is not a mood
});

test('extras the main process will expose later: invitations, cancellations, answers, refusals, incoming', () => {
    const h = fake(); const a = createHerbertBridge(h, { now: noon });
    const base = { invitations: 0, cancellations: 0, answersSent: 0, refusals: 0, incoming: 0 };
    a.update(a.factsFromBridgeState([account()], base));
    a.update(a.factsFromBridgeState([account()], { ...base, invitations: 1 }));
    a.update(a.factsFromBridgeState([account()], { ...base, invitations: 1, cancellations: 1 }));
    a.update(a.factsFromBridgeState([account()], { ...base, invitations: 1, cancellations: 1, answersSent: 1 }));
    a.update(a.factsFromBridgeState([account()], { ...base, invitations: 1, cancellations: 1, answersSent: 1, refusals: 1 }));
    a.update(a.factsFromBridgeState([account()], { ...base, invitations: 1, cancellations: 1, answersSent: 1, refusals: 1, incoming: 4 }));
    assert.deepEqual(h.reactions(), ['react:invitation', 'react:cancelled', 'react:answered', 'react:refused', 'react:incoming']);
});

test('busy day and free day, once a day, after seven', () => {
    const h = fake(); const a = createHerbertBridge(h, { now: noon });
    a.update(a.factsFromBridgeState([account()]));
    a.setTodayCount(8); a.setTodayCount(8);
    assert.deepEqual(h.reactions(), ['react:busyDay']);
    const h2 = fake(); const a2 = createHerbertBridge(h2, { now: noon });
    a2.update(a2.factsFromBridgeState([account()]));
    a2.setTodayCount(0);
    assert.deepEqual(h2.reactions(), ['react:freeDay']);
});

test('update available plays once; resume and the pro unlock are direct', () => {
    const h = fake(); const a = createHerbertBridge(h, { now: noon });
    a.updateAvailable(); a.updateAvailable(); a.systemResumed(); a.proUnlocked();
    assert.deepEqual(h.reactions(), ['react:updateAvailable', 'react:wake', 'react:thanks']);
});

test('a calendar app that has not asked for a day, once a day; a quiet day, once', () => {
    const h = fake(); const a = createHerbertBridge(h, { now: noon });
    a.update(a.factsFromBridgeState([account()]));
    a.update(a.factsFromBridgeState([account({ calendarApp: { thisRun: false, lastRequestAt: noon() - 2 * 24 * 3600 * 1000 } })]));
    a.update(a.factsFromBridgeState([account({ calendarApp: { thisRun: false, lastRequestAt: noon() - 2 * 24 * 3600 * 1000 } })]));
    assert.deepEqual(h.reactions(), ['react:appMissing']);
    const h2 = fake(); const a2 = createHerbertBridge(h2, { now: noon });
    a2.update(a2.factsFromBridgeState([account({ lastSuccessfulSyncAt: noon() - 7 * 3600 * 1000 })]));
    a2.update(a2.factsFromBridgeState([account({ lastSuccessfulSyncAt: noon() - 7 * 3600 * 1000 })]));
    a2.update(a2.factsFromBridgeState([account({ lastSuccessfulSyncAt: noon() - 7 * 3600 * 1000 })]));
    assert.deepEqual(h2.reactions(), ['react:quiet']);
});
