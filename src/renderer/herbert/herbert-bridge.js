/*
 * The bridge adapter: turns what the app knows into calls on Herbert's API.
 *
 * The renderer already re-reads the bridge state on every 'bridge:state-changed'
 * (window.bridgeApi.getBridgeState()). Feed each state to adapter.update(facts) and
 * the adapter works out what changed since last time: it sets his mood (asleep when
 * the connection is gone, worried on an error, content when it is fine again) and
 * plays at most one reaction per update, the most important first.
 *
 *   var adapter = createHerbertBridge(herbert);
 *   adapter.update(adapter.factsFromBridgeState(state));   // on every state change
 *   adapter.updateAvailable();                              // from the updater
 *   adapter.setTodayCount(n);                               // events today, once the app knows
 *
 * `facts` is a small flat object so the app can fill it from wherever it keeps each
 * thing (see factsFromBridgeState for what the current state object already has, and
 * what it does not). Counters only ever go up; the adapter reacts to the difference.
 */
(function (global) {
    'use strict';

    var DAY = 24 * 60 * 60 * 1000;

    function createHerbertBridge(herbert, options) {
        options = options || {};
        var previous = null;
        var mood = 'idle';
        var todayCount = null;
        var saidToday = {};
        var updateSeen = false;
        var now = options.now || function () { return Date.now(); };

        function dayKey() { var d = new Date(now()); return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate(); }
        function oncePerDay(key) {
            var k = dayKey() + ':' + key;
            if (saidToday[k]) return false;
            saidToday = {};
            saidToday[k] = true;
            return true;
        }
        function count(v) { return typeof v === 'number' && isFinite(v) ? v : 0; }

        // The mood follows the facts; only a change calls setState (which also makes him speak).
        function applyMood(facts) {
            var want = facts.offline ? 'asleep' : facts.health === 'error' ? 'worried' : 'idle';
            if (want === mood) return;
            if (want === 'idle' && mood === 'worried') { mood = 'content'; herbert.setState('content'); return; }
            if (want === 'idle' && mood === 'asleep') { mood = 'idle'; herbert.setState('idle', { quiet: true }); herbert.react('online'); return; }
            if (want === 'idle') { mood = 'idle'; herbert.setState('idle', { quiet: true }); return; }
            mood = want;
            herbert.setState(want);
        }

        // Reactions on what changed since the last facts, the most important first, one per update.
        function reactionFor(f, p) {
            if (f.signedIn && !p.signedIn) return 'signedIn';
            if ((f.verificationNeeded || f.signInPromptNeeded) && !(p.verificationNeeded || p.signInPromptNeeded)) return 'signInNeeded';
            if (f.limited && !p.limited) return 'slowdown';
            if (f.refusals > p.refusals) return 'refused';
            if (f.invitations > p.invitations) return 'invitation';
            if (f.cancellations > p.cancellations) return 'cancelled';
            if (f.answersSent > p.answersSent) return 'answered';
            if (f.appConnected && !p.appConnected) return 'appConnected';
            if (f.refreshing && !p.refreshing) return 'refresh';
            if (f.pendingChanges < p.pendingChanges && f.lastDirection === 'push') return 'delivered';
            if (f.incoming > p.incoming) return 'incoming';
            if (f.lastSuccessfulSyncAt > p.lastSuccessfulSyncAt) return 'synced'; // 1.0.6: a sync finished
            if (f.appWasConnected && f.appLastRequestAt && now() - f.appLastRequestAt > DAY && oncePerDay('appMissing')) return 'appMissing';
            if (f.lastSuccessfulSyncAt && now() - f.lastSuccessfulSyncAt > 6 * 60 * 60 * 1000 && oncePerDay('quiet') && !f.offline) return 'quiet';
            return null;
        }

        function update(facts) {
            facts = normalize(facts);
            herbert.setPending(facts.pendingChanges);
            herbert.setBusy(facts.health === 'syncing');
            var moodBefore = mood;
            applyMood(facts);
            if (previous && mood === moodBefore) { // a mood change already made him speak; otherwise one reaction
                var name = reactionFor(facts, previous);
                if (name && (!facts.offline || name === 'signedIn' || name === 'signInNeeded')) herbert.react(name);
            }
            previous = facts;
            dayTalk();
            return facts;
        }

        function normalize(f) {
            f = f || {};
            return {
                offline: !!f.offline,
                limited: !!f.limited,
                signedIn: !!f.signedIn,
                verificationNeeded: !!f.verificationNeeded,
                signInPromptNeeded: !!f.signInPromptNeeded,
                health: f.health || 'healthy',
                refreshing: !!f.refreshing,
                pendingChanges: count(f.pendingChanges),
                lastSuccessfulSyncAt: count(f.lastSuccessfulSyncAt),
                lastDirection: f.lastDirection || null,
                appConnected: !!f.appConnected,
                appWasConnected: !!(f.appWasConnected || f.appConnected || (previous && previous.appWasConnected)),
                appLastRequestAt: count(f.appLastRequestAt),
                incoming: count(f.incoming),
                invitations: count(f.invitations),
                cancellations: count(f.cancellations),
                answersSent: count(f.answersSent),
                refusals: count(f.refusals),
            };
        }

        // Busy day / free day, once a day, once the app told us how many events today holds.
        function setTodayCount(n) { todayCount = count(n); dayTalk(); return adapter; }
        function dayTalk() {
            if (todayCount === null || !previous || previous.offline) return;
            var h = new Date(now()).getHours();
            if (h < 7) return;
            if (todayCount >= 6 && oncePerDay('busyDay')) herbert.react('busyDay');
            else if (todayCount === 0 && oncePerDay('freeDay')) herbert.react('freeDay');
        }

        function updateAvailable() { if (!updateSeen) { updateSeen = true; herbert.react('updateAvailable'); } return adapter; }
        function systemResumed() { herbert.react('wake'); return adapter; }
        function proUnlocked() { herbert.react('thanks'); return adapter; }

        /*
         * From the bridge state the renderer already gets (an array of account objects, or
         * { accounts: [...] }). What the account objects have today: health, signedIn,
         * pendingHumanVerification, signInPrompt, pendingChanges, lastSuccessfulSyncAt,
         * syncStats.lastDirection, calendarApp.thisRun / lastRequestAt. What they do NOT
         * have yet, so the adapter cannot see it from here: offline / limited (the tray's
         * phase: 'offline' | 'limited'), the counts of incoming changes, invitations,
         * cancellations, answers sent and refused edits, and whether a full refresh runs.
         * Pass those in `extras` once the main process exposes them; until then those
         * reactions simply never play.
         */
        function factsFromBridgeState(state, extras) {
            var accounts = Array.isArray(state) ? state : (state && state.accounts) || [];
            extras = extras || {};
            var f = {
                offline: accounts.length > 0 && accounts.every(function (a) { return a.phase === 'offline'; }),
                limited: accounts.some(function (a) { return a.phase === 'limited'; }),
                signedIn: accounts.some(function (a) { return a.signedIn; }),
                verificationNeeded: accounts.some(function (a) { return !!a.pendingHumanVerification; }),
                signInPromptNeeded: accounts.some(function (a) { return !!a.signInPrompt; }),
                health: accounts.some(function (a) { return a.health === 'error'; }) ? 'error'
                    : accounts.some(function (a) { return a.health === 'syncing'; }) ? 'syncing' : 'healthy',
                pendingChanges: accounts.reduce(function (s, a) { return s + count(a.pendingChanges); }, 0),
                lastSuccessfulSyncAt: accounts.reduce(function (m, a) { return Math.max(m, count(a.lastSuccessfulSyncAt)); }, 0),
                lastDirection: (accounts.map(function (a) { return a.syncStats && a.syncStats.lastDirection; }).filter(Boolean)[0]) || null,
                appConnected: accounts.some(function (a) { return a.calendarApp && a.calendarApp.thisRun; }),
                appLastRequestAt: accounts.reduce(function (m, a) { return Math.max(m, count(a.calendarApp && a.calendarApp.lastRequestAt)); }, 0),
            };
            Object.keys(extras).forEach(function (k) { f[k] = extras[k]; });
            return f;
        }

        var adapter = {
            update: update,
            factsFromBridgeState: factsFromBridgeState,
            setTodayCount: setTodayCount,
            updateAvailable: updateAvailable,
            systemResumed: systemResumed,
            proUnlocked: proUnlocked,
            get mood() { return mood; },
        };
        return adapter;
    }

    global.createHerbertBridge = createHerbertBridge;
    if (typeof module !== 'undefined' && module.exports) module.exports = createHerbertBridge;
})(typeof window !== 'undefined' ? window : globalThis);
