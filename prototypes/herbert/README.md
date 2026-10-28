# Herbert the unicorn — standalone prototype

Herbert is the companion of the planned "Pro Version" (a thank-you for donors): a happy, diligent,
super cute express-courier unicorn who delivers mail announcements across the rainbow bridge. He
will live in the left side panel of the Neutron Calendar Bridge window, where he greets you, follows
your clicks, sleeps when the connection is gone, worries when a sync fails, says when all is well and
now and then reminds you that you are amazing. His real job is to warm your heart on a bad office day.

He is drawn in a plush style: front view, a horse's head (tall skull, muzzle at the bottom, eyes high and
wide apart, tall ears), a big horn, a mane to the shoulders, a small round body with the courier bag and a
rainbow behind him.

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
| `herbert.js` | The drawing (inline SVG), the behaviour and the reaction table; exposes `createHerbert(container, options)`. |
| `herbert.css` | Looks and all motion: breathing, blinking, gaze, every state's face, keyframes. Honors `prefers-reduced-motion`. |
| `herbert-texts.js` | Every line he says, in one table (`window.HERBERT_TEXTS`). English only for now. |
| `index.html`, `demo.css`, `demo.js` | The demo page and its mock of the app window. Not part of the later integration. |
| `styles.html` | The three style candidates Herbert was chosen from (A cartoon pony, B plush front view, C flat bust). B is the one in `herbert.js`; the page stays as a reference. |

Only the first three files move into the app. They use the app's own tokens where sensible
(`--font-sans`, `--page`, `--text`, `--line-strong` for the bubble) and fall back to plain values
when those are missing, so the frame also works on its own.

## The API the app will call

```js
const herbert = createHerbert(panelElement, {
    greet: true,            // say the time-of-day greeting shortly after creation (default true)
    greetDelay: 900,        // ms
    encourageEvery: 20 * 60 * 1000, // ms between encouragements (default 20 minutes)
    lifeEvery: 4 * 60 * 1000,       // how often his small life may do something (default 4 minutes)
    drowsyAfter: 10 * 60 * 1000,    // no activity for this long: he gets drowsy (not asleep)
    awayAfter: 15 * 60 * 1000,      // activity after this long away: "welcome back"
    userName: '',           // used in his lines as {name}; without it ", {name}" just disappears
    userBirthday: null,     // 'MM-DD'
    chattiness: 1,          // 0 silent (faces only), 1 normal, 2 chatty
    quietHours: null,       // e.g. [22, 7]: nothing spontaneous between 22:00 and 07:00
    season: 'auto',         // or 'none', 'christmas', 'newyear', 'halloween', 'valentine', 'birthday', 'winter', 'summer'
    typewriter: true,       // letters appear one by one
    texts: HERBERT_TEXTS,   // the text table; the app passes translated strings here
});

herbert.setState('idle');            // 'idle' | 'curious' | 'talking' | 'asleep' | 'worried' | 'content'
herbert.setState('worried');         // also says a "something went wrong" line
herbert.setState('content');         // also says an "all is well" line (a relief line after trouble)
herbert.setState('worried', { quiet: true });    // the face only, no line
herbert.setState('content', { text: '…' });      // the face with a line of your own
herbert.getState();                  // the current state name

herbert.say('Delivered!');           // speech bubble; queues (up to 3) behind what he is saying
herbert.say('…', { duration: 5000, now: true }); // now: replaces what he is saying
herbert.think('Hmm…');               // thought bubble
herbert.hush();                      // hide the bubble and empty the queue

herbert.react('delivered');          // a short reaction to something the bridge did (list below)
herbert.react('refused', { text: '…', duration: 4000 });
herbert.react('milestone', { vars: { n: 10 } });  // {n} in the line
herbert.touch('nose');               // what a click on a part of him does: nose, ear, horn, bag, tail, belly, face
herbert.reactions                    // the list of reaction names

herbert.lookAt(x, y);                // page coordinates; he glances there for ~2 s, then back to the pointer
herbert.greet();                     // the greeting for the current hour (+ the weekday, once a day)
herbert.greet(14);                   // the greeting for a given hour (demo)
herbert.encourage();                 // one encouragement, with sparkles
herbert.liveALittle();               // one thing from his small life, now (demo)

herbert.setPending(3);               // a badge on the bag; the bag shakes while something waits
herbert.setBusy(true);               // a small spinner on the bag, the rainbow pulses
herbert.setEnabled(false);           // the off switch: he leaves; a small horn button brings him back
herbert.setSize('compact');          // 'normal' | 'compact' (for small windows)
herbert.setChattiness(0 | 1 | 2);
herbert.setQuietHours([22, 7]);
herbert.setUserName('Tobi');
herbert.setSeason('christmas');      // try a season on; 'auto' follows the date

herbert.on('state', ({ state, previous }) => …);
herbert.on('say', ({ text, duration, thought }) => …);
herbert.on('react', ({ reaction, text, duration }) => …);
herbert.on('milestone', ({ deliveries }) => …);
herbert.on('enabled', ({ enabled }) => …);
herbert.off('state', fn);
herbert.stats                        // { deliveries, pokes, coffees, encouragements, reactions }
herbert.destroy();                   // remove him and all timers and listeners

herbert.element                      // the .herbert <div>, 219 × 250 px (focusable; Enter pokes him)
herbert.states                       // the list of state names
```

## Reactions

`react(name)` is for the moments the bridge already knows about. Each one borrows a face for a few
seconds, adds a small prop, moves a little and says its line, then he goes back to his state. While he
is asleep only `online` and `wake` get him up; everything else is a small stir in his sleep. A click on
Herbert himself is a poke.

| Name | When the app would call it | What he does |
| --- | --- | --- |
| `delivered` | a change from your calendar app reached Proton | happy, an envelope flies off, a hop |
| `incoming` | new or changed events arrived from Proton | curious, an "!", looks at his bag |
| `invitation` | an invitation arrived | happy, an "!", bouncing |
| `answered` | your answer was emailed to the organizer | happy, waves, an envelope flies off |
| `cancelled` | a meeting was cancelled | soft face, head tilt |
| `refused` | Proton could not do that edit | soft face, sweat drop, head tilt |
| `slowdown` | Proton asked to slow down | watches a little clock, sways |
| `online` | the connection is back (wakes him) | happy, a stretch |
| `wake` | the Mac woke from sleep (wakes him) | a yawn and a stretch |
| `signedIn` | an account signed in | happy, confetti, a hop |
| `signInNeeded` | Proton wants a new sign-in | soft face, a "?" |
| `appConnected` | a calendar app made its first request | happy, waves |
| `appMissing` | no calendar app has asked in a long while | curious, a "?", looks around |
| `updateAvailable` | a new version is available | curious, sparkles, bouncing |
| `refresh` | a full listing of every calendar | wiggles, looks at his bag |
| `quiet` | nothing changed for hours | hums to himself, notes, sways |
| `busyDay` | many events today | curious, an envelope, a little shiver |
| `freeDay` | nothing on today | happy, a heart, sways |
| `poke` | you clicked Herbert | giggles, wiggles |
| `thanks` | the Pro Version was unlocked | happy, a heart, a hop |

Every key in the text table may hold a list of lines; he says each line once, in random order, before
any repeats (there are 11 per greeting and per reaction, 25 encouragements). `{name}` is the person's
name when the app knows it.

### His small life and his touches

| Name | When | What he does |
| --- | --- | --- |
| `coffee` | now and then while idle | raises a cup, sips, steam rises (14 s) |
| `snack` | now and then while idle | an apple, crunch, a bite mark |
| `stretch` | now and then, and at every full hour | a yawn and a stretch, no line |
| `sneeze` | now and then | head back, "Achoo!" |
| `daydream` | now and then | a thought bubble with a tiny rainbow |
| `hum` | now and then | notes, no line |
| `letter` | now and then | reads a letter from his bag |
| `trivia` | now and then | "Did you know?" |
| `wish` | at night, rarely | a shooting star; he makes a wish |
| `welcomeBack` | activity after a long absence | waves |
| `relief` | content after a worried spell | "Phew!" |
| `milestone` | the 10th, 25th, 50th, 100th, 250th delivery | confetti and the count |
| `lunch`, `evening`, `weekend` | once a day, at the right time | a gentle nudge |
| `birthday`, `userBirthday` | 28 October; the person's birthday | party hat, confetti, a dance |
| `sleepyLove` | poked while asleep | a mumbled encouragement, a heart, no waking |
| `dance` | double-click | hooves up, notes |
| `pet` | press and hold | hearts, "that's nice" |
| `boop`, `earTickle`, `hornTap`, `bagPeek`, `tailPull`, `belly` | a click on that part | each its own face and line |
| `dizzy` | swirling the pointer over him | spiral eyes, wobble |
| `shy` | being hovered for 5 s | blushes, looks away |
| `typing` | a long burst of typing | cheers you on (at most every 5 minutes) |
| `party` | typing the word "herbert" | confetti and a dance |

### Fifty small things that make him Herbert

1. Coffee breaks while idle, cup in hoof, steam rising.
2. Snacks: an apple, with a bite mark after the first crunch.
3. Stretches now and then, and at every full hour.
4. Sneezes.
5. Daydreams in a thought bubble with a tiny rainbow.
6. Hums to himself with little notes.
7. Ear twitches.
8. Tail flicks.
9. Reads a letter from his bag.
10. Unicorn trivia.
11. Gets drowsy after long inactivity (not asleep: that is for the connection) and wakes on activity.
12. Welcomes you back after a long absence.
13. Looks up at his own speech bubble before he speaks.
14. Lines appear letter by letter.
15. Lines queue up (three at most) instead of cutting each other off.
16. Thought bubbles, `think()`, dashed and italic.
17. Clicking the bubble dismisses it; hovering it keeps it on screen.
18. The ears follow the pointer a little.
19. Hovering him perks his ears, widens his eyes and makes him blink more often.
20. Staring at him for five seconds makes him shy.
21. A nose boop scrunches his face.
22. Ear tickles make the ear flick.
23. A tap on the horn: "Careful, that's sharp!"
24. A click on the bag peeks inside and tells you how many changes are waiting.
25. A tail pull.
26. A belly tickle.
27. Pressing and holding is petting: hearts, "that's nice".
28. Double-click: a dance.
29. Swirling the pointer over him makes him dizzy, spiral eyes and all.
30. He watches you type, and cheers a long burst.
31. Typing "herbert" anywhere throws a party.
32. Poked while asleep (the internet is gone), he mumbles an encouragement without waking.
33. Eleven greetings per time of day, and the weekday in the first greeting of the day.
34. Eleven lines per reaction, each said once before any repeats.
35. Twenty-five encouragements in a shuffled round.
36. Your name in his lines, `setUserName`.
37. A relief line when things are fine again after trouble.
38. Delivery milestones with confetti; `stats` counts deliveries, pokes, coffees.
39. A lunch nudge, once a day.
40. An evening wind-down, once a day.
41. A weekend remark, once.
42. Night: stars in the frame and a softly glowing horn.
43. Shooting stars at night; he makes a wish.
44. A nightcap when he sleeps at night.
45. Seasons: a Santa hat in December, a party hat on New Year's Day, a pumpkin at Halloween, a hearts crown on Valentine's Day, a scarf in winter, sunglasses on summer afternoons.
46. His birthday, 28 October, and yours.
47. A pending-changes badge on the bag; the bag shakes while something waits.
48. A busy spinner on the bag and a pulsing rainbow while a sync runs.
49. Chattiness (silent, normal, chatty), quiet hours, and an off switch that lets him leave with a small horn button to bring him back.
50. A compact size for small windows, keyboard focus (Enter pokes him), and reduced-motion respected throughout.



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
- No sounds, no version bump, no CHANGELOG entry: this is a prototype outside the app. The once-a-day
  lines remember the day in `localStorage` (key `herbert-once`); the app will keep that in its own settings.
