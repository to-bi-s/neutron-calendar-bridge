# Herbert the unicorn — standalone prototype

Herbert is the companion of the planned "Pro Version" (a thank-you for donors): a happy, diligent,
super cute express-courier unicorn who delivers mail announcements across the rainbow bridge. He
will live in the left side panel of the Neutron Calendar Bridge window, where he greets you, follows
your clicks, sleeps when the connection is gone, worries when a sync fails, says when all is well and
now and then reminds you that you are amazing. His real job is to warm your heart on a bad office day.

This folder is the frame on its own, outside the app, so the look and the behaviour can be judged
before anything touches `src/`. Plain HTML, CSS and JS; no build step, no framework, no assets
(Herbert is inline SVG, animated with CSS; the whole thing is under 50 KB).

## Open it

Double-click `index.html`, or open it from a browser (`File → Open…`). Nothing needs to be served.

The page is a mock of the app window: the dark purple side panel on the left (251 px, dark in both
themes, as in the app) with Herbert in his frame above the footer, and on the right the controls:

- **State** buttons: idle, curious, talking, asleep (offline), worried (sync error), content (all well).
- **Words**: the greeting for now or for a given time of day, an encouragement, a custom line,
  "Hush", and "Play a short story" that runs through the states one after the other.
- **Appearance**: follow system / light / dark. The page and Herbert's speech bubble follow the
  theme through `<html data-theme>`, exactly as the app's renderer sets it; the panel stays purple.
- A small log of the API calls the buttons make. `herbert` is also on the browser console.

Click anywhere on the page: he glances there, then goes back to following the pointer. Left alone,
he breathes, blinks, looks around a little, and every two minutes (on this page; the API default is
twenty) says something kind, but only when he is idle or content and nothing else is being said.

## Files

| File | What |
| --- | --- |
| `herbert.js` | The drawing (inline SVG) and the behaviour; exposes `createHerbert(container, options)`. |
| `herbert.css` | Looks and all motion: breathing, blinking, gaze, every state's face, keyframes. Honors `prefers-reduced-motion`. |
| `herbert-texts.js` | Every line he says, in one table (`window.HERBERT_TEXTS`). English only for now. |
| `index.html`, `demo.css`, `demo.js` | The demo page and its mock of the app window. Not part of the later integration. |

Only the first three files move into the app. They use the app's own tokens where sensible
(`--font-sans`, `--page`, `--text`, `--line-strong` for the bubble) and fall back to plain values
when those are missing, so the frame also works on its own.

## The API the app will call

```js
const herbert = createHerbert(panelElement, {
    greet: true,            // say the time-of-day greeting shortly after creation (default true)
    greetDelay: 900,        // ms
    encourageEvery: 20 * 60 * 1000, // ms between encouragements (default 20 minutes)
    texts: HERBERT_TEXTS,   // the text table; the app passes translated strings here
});

herbert.setState('idle');            // 'idle' | 'curious' | 'talking' | 'asleep' | 'worried' | 'content'
herbert.setState('worried');         // also says the "something went wrong" line
herbert.setState('content');         // also says the "all is well" line
herbert.setState('worried', { quiet: true });    // the face only, no line
herbert.setState('content', { text: '…' });      // the face with a line of your own
herbert.getState();                  // the current state name

herbert.say('Delivered!');           // speech bubble; hides itself (about 60 ms per character, 3–10 s)
herbert.say('…', { duration: 5000 });
herbert.hush();                      // hide the bubble now

herbert.lookAt(x, y);                // page coordinates; he glances there for ~2 s, then back to the pointer
herbert.lookAt(x, y, 5000);          // hold longer
herbert.greet();                     // the greeting for the current hour
herbert.greet(14);                   // the greeting for a given hour (demo)
herbert.encourage();                 // one encouragement, with sparkles

herbert.on('state', ({ state, previous }) => …);
herbert.on('say', ({ text, duration }) => …);
herbert.off('state', fn);
herbert.destroy();                   // remove him and all timers and listeners

herbert.element                      // the .herbert <div>, 219 × 250 px
herbert.states                       // the list of state names
```

Rules he keeps on his own: while asleep he does not follow the pointer, does not blink and says
nothing (`say` is ignored, encouragements wait); a state change hides nothing that is being said but
restarts the small hop; encouragements never come while he is worried or asleep, while a bubble is
showing, or while the window is hidden.

How the app would use it, roughly: `setState('asleep')` when Proton is unreachable, `setState('worried')`
when a sync fails, `setState('content')` when a sync succeeds after trouble, `setState('idle')` otherwise;
`lookAt` from the renderer's click handler (or leave it: he already listens for clicks on the document).

## Deliberately not done yet

- **The Pro-Version unlock** by a static donor password: no password, no check, no settings UI. The
  prototype is always "unlocked".
- **Integration into the panel**: nothing in `src/` changes. The frame is sized for the panel
  (219 px wide inside the panel's 16 px margins) and uses the app's tokens, but it is not wired to
  the sync engine, the renderer or the window harness.
- **Translations**: the texts are English only and live in `herbert-texts.js`. When he moves into
  the app they go through the six catalogs in `src/locales/` and `i18n.js`, and `createHerbert`
  gets the translated table through `options.texts`.
- No sounds, no settings (an "I'd rather not" switch will be needed for people who find him
  distracting), no version bump, no CHANGELOG entry: this is a prototype outside the app.
