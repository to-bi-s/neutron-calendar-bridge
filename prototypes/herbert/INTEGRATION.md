# Taking Herbert into the app

What the app needs from this folder, where it goes, what the main process has to expose, and what
has to happen before `npm run check` passes. The prototype itself stays here; the app gets copies.

## 1. What moves, and where

| From `prototypes/herbert/` | To | What it is |
| --- | --- | --- |
| `lib/herbert.js` | `src/renderer/herbert/herbert.js` | the drawing, the behaviour, `createHerbert()` (global, plain script like `renderer.js`) |
| `lib/herbert.css` | `src/renderer/herbert/herbert.css` | all looks and motion; uses the app's tokens with fallbacks |
| `lib/herbert-texts.js` | `src/renderer/herbert/herbert-texts.js` | every English line (`window.HERBERT_TEXTS`) |
| `lib/herbert-bridge.js` | `src/renderer/herbert/herbert-bridge.js` | the adapter from bridge state to Herbert calls |
| `test/texts.test.mjs`, `test/bridge-adapter.test.mjs` | `tests/herbert-*.test.mjs` | offline checks (paths inside need updating) |
| `test/screenshots.js` | `tests/electron/herbert.harness.js` | pictures of every pose, like the window harness |
| `locales/herbert-keys.json` | (translation work list) | the 617 English lines the catalogs need |

Nothing else: `index.html`, `demo.css`, `demo.js` and `styles.html` are the demo and stay here.
`scripts/copy-renderer.mjs` must copy the new folder into `dist/renderer/` like the rest.

The four library files are about 130 KB unminified, no assets, no dependencies.

## 2. The window

In `src/renderer/index.html`, inside `<nav class="nav-sidebar">`, between the `nav-list` and the
`nav-footer`:

```html
<div class="herbert-home" id="herbert-home" hidden></div>
```

and the scripts after `i18n.js` (plain scripts, in this order):

```html
<link rel="stylesheet" href="herbert/herbert.css">
<script src="herbert/herbert-texts.js"></script>
<script src="herbert/herbert.js"></script>
<script src="herbert/herbert-bridge.js"></script>
```

The frame style from `demo.css` (`.herbert-home`: margin 8px 16px 10px, radius 16px, the faint
white tint and ring) goes into `styles.css` under the nav sidebar rules. The sidebar is a drag
region; Herbert already sets `-webkit-app-region: no-drag` on himself. Width: he is 219 px, the
panel is 251 px with 16 px margins. Height: 250 px plus the frame; in a short window the compact
size (`setSize('compact')`, 150 px) is the fallback, for example below 640 px window height.

The speech bubble follows `--page`, `--text` and `--line-strong`, so the Appearance setting already
applies; the panel stays purple in both themes, as it does now.

## 3. Creating him in `renderer.js`

Once translations are loaded (the catalog comes over IPC before the first render):

```js
let herbert = null, herbertBridge = null;
function mountHerbert(settings) {               // settings: the account-independent part of the config
    const home = document.getElementById('herbert-home');
    if (!settings.proUnlocked || !settings.herbert?.enabled) { herbert?.destroy(); herbert = null; home.hidden = true; return; }
    if (herbert) return;
    home.hidden = false;
    herbert = createHerbert(home, {
        texts: HERBERT_TEXTS,
        translate: t,                             // i18n.js's t(): the English line is the key
        userName: settings.herbert.userName || '',
        chattiness: settings.herbert.chattiness ?? 1,
        quietHours: settings.herbert.quietHours || null,
        encourageEvery: 20 * 60 * 1000,
        lifeEvery: 4 * 60 * 1000,
    });
    herbertBridge = createHerbertBridge(herbert);
}
```

and in the render path, right after `getBridgeState()` resolves (`requestRender`, around
`renderer.js:2071` where `onStateChanged` triggers it):

```js
mountHerbert(state.settings);
herbertBridge?.update(herbertBridge.factsFromBridgeState(state.accounts, state.herbertFacts));
```

`factsFromBridgeState` reads what the account objects already carry: `health`, `signedIn`,
`pendingHumanVerification`, `signInPrompt`, `pendingChanges`, `lastSuccessfulSyncAt`,
`syncStats.lastDirection`, `calendarApp.thisRun` and `.lastRequestAt`. The adapter then sets his
mood (asleep / worried / content / idle), the bag badge (`pendingChanges`) and the busy spinner
(`health === 'syncing'`), and plays at most one reaction per state change.

Two more calls from places the renderer already handles:

- the updater's status (`renderer.js` around line 1861, where `updateStatus` is set): when it turns
  to "available", `herbertBridge.updateAvailable()` (plays once per run);
- the Pro unlock succeeding: `herbertBridge.proUnlocked()`.

## 4. What the main process has to add

Everything the adapter cannot see today. Each is small; without them the matching reaction never
plays, nothing breaks.

| Fact | Where it lives | How to expose it |
| --- | --- | --- |
| `phase` per account (`offline`, `limited`, `verification`, …) | `bridge-service.ts` `trayPhase()` (~line 1785), already in the tray status | add `phase: this.trayPhase()` to the window status object (~line 1860) |
| `incoming` (count of events changed by a pull) | the change-feed apply path | a running counter per account, in the status |
| `invitations` (new invitations received) | where the `received` notification is raised | counter |
| `cancellations` | the cancellation handling | counter |
| `answersSent` (REPLY emails sent) | the invitation email path (`recentInvitationEmails` already lists them) | counter, or the length of that list filtered to replies |
| `refusals` (edits refused with a reason) | the CalDAV PUT refusals (`recentCalDAVErrors`) | counter |
| `refreshing` (a full listing runs) | `refreshNow` / the daily listing | a boolean in the status |
| system resume | `main.ts:1146` (`powerMonitor.on('resume')`) | `mainWindow.webContents.send('bridge:system-resumed')`, preload `onSystemResumed`, renderer calls `herbertBridge.systemResumed()` |
| events today (busy day / free day) | the mirror database | a count per account over today's expanded occurrences, in the status or its own IPC; renderer calls `herbertBridge.setTodayCount(n)` |

Pass the counters in through `extras` (the second argument of `factsFromBridgeState`) until they
have a home in the status object; counters only ever go up, the adapter reacts to the difference.

## 5. Pro Version: the unlock and the settings

A configuration change, so Tobi decides the shape first (existing installs upgrade in place):

- `proUnlocked: boolean` in the app-wide config (`config-store.ts`), default `false`;
- `herbert: { enabled: true, chattiness: 1, quietHours: null, userName: '' }`, defaults applied
  when missing;
- the once-a-day memory: the prototype keeps it in `localStorage` under `herbert-once` (the renderer
  already uses `localStorage` for the theme); it can stay there or move into `herbert.lastSaid`.

The unlock: a card on the Setup page, "Pro Version", with one password field and a Unlock button.
The renderer sends the password to the main process (`bridge:unlock-pro`), which compares a hash
(constant-time) with the stored one and sets `proUnlocked`. The password itself is never stored and
never logged. The donor password is static and shared, so this is a gimmick, not security: say so
in the card ("a thank-you for donors"). On success: state change, `mountHerbert` creates him,
`proUnlocked()` plays his thank-you.

Settings, on the same card once unlocked: Show Herbert (on/off), How much he talks (silent / normal
/ chatty), Quiet hours (from–to), Your name (optional). `setEnabled`, `setChattiness`,
`setQuietHours`, `setUserName` apply them live.

## 6. Texts and the six languages

The English line is the key, as everywhere in the app (`t('…')`). Herbert calls `translate` on
every line before he fills `{name}` and `{n}`; `{name}` is the app's own placeholder syntax, so
`extract-strings.mjs` can check placeholders as usual.

`scripts/extract-strings.mjs` collects keys from `t()` calls, the `i18n` maps in `renderer.js`,
and `index.html`. It needs one more source: the string values in `herbert-texts.js` (walk the
object literal, or read `locales/herbert-keys.json`, which `scripts/herbert-keys.mjs` regenerates
from the texts). Then `npm run check` demands all 617 lines in `de`, `nl`, `fr`, `es`, `it`:
about 3,100 translations. Options: translate everything before the release; or ship the Pro
Version first in English with the catalogs filled over time (the check would need to tolerate
missing Herbert keys, which breaks the rule that every text has its five translations, so that is
Tobi's call); or shorten the lists (eleven lines per key is a prototype luxury; five would do).

Plain words, no jargon: the lines were written for the bubble, but the translations need the same
care, and some jokes ("in good hooves") need an equivalent, not a translation.

## 7. Checks and docs before the commit

- `node --test tests/herbert-*.test.mjs` (add to `scripts/check.mjs` or `npm test`'s glob).
- `npx electron tests/electron/herbert.harness.js <shots-dir>` and look at `sheet.png`; the window
  harness should also take one picture of the panel with Herbert in it.
- `docs/BEHAVIOUR.md`: a section "Herbert (Pro Version)": what he reacts to, what he never reads
  (no event titles, guests or places; only counts and states), what he stores (the once-a-day
  memory), and that he is off by default and gone entirely without the unlock.
- `README.md` (user-facing): the Pro Version paragraph. `CHANGELOG.md`: the section for the version,
  ending with the "Updating:" line. `package.json` and `package-lock.json`: the bump.
- Privacy, in one line for the docs: Herbert gets numbers and states, never content.

## 8. What stays open after that

- The event counters above (section 4) are the difference between "he reacts to sync health" and
  "he reacts to your calendar day"; they can land one by one.
- No sound, on purpose.
- The nightcap, the seasons and his birthday follow the system clock; nothing is fetched.
