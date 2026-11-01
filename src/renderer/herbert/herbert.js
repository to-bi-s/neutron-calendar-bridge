/*
 * Herbert the unicorn — standalone frame (prototype, not yet in the app).
 *
 * createHerbert(container, options) draws him into `container` and returns the
 * API the app will call later (the README lists it all):
 *   herbert.setState(name, { quiet, text })     'idle' | 'curious' | 'talking' | 'asleep' | 'worried' | 'content'
 *   herbert.say(text, { duration, now })        speech bubble; stays up to options.bubbleHold; queues behind what he is saying
 *   herbert.think(text)                         thought bubble
 *   herbert.react(name, { text, duration })     a short reaction (REACTIONS below)
 *   herbert.lookAt(x, y, holdMs)                page coordinates
 *   herbert.greet()  .encourage()  .hush()
 *   herbert.setPending(n)  .setBusy(bool)  .setEnabled(bool)  .setSize('normal' | 'compact')
 *   herbert.setChattiness(0 | 1 | 2)  .setQuietHours([from, to])  .setUserName(name)
 *   herbert.on('state' | 'say' | 'react' | 'milestone', fn)   .stats   .destroy()
 *
 * Everything that moves is CSS (herbert.css); this file flips classes, sets a few
 * custom properties for the gaze, and runs the timers (blink, idle glances, his
 * small life, the greeting, the occasional encouragement). Texts: herbert-texts.js;
 * the app's state becomes calls on this API through herbert-bridge.js.
 */
(function (global) {
    'use strict';

    var STATES = ['idle', 'curious', 'talking', 'asleep', 'worried', 'content'];
    var FACES = ['soft', 'yawn', 'sleepy', 'dizzy', 'shy', 'scrunch'];

    // What happens while the bridge runs (and in Herbert's own small life), and how he
    // takes it. face: the look he borrows for a moment (a state's face or one of FACES);
    // prop: a small thing that appears; motion: how he moves; gaze: where he looks
    // (viewBox units); wakes: gets him out of 'asleep'; inSleep: plays without waking
    // him; quiet: no line unless one is passed; duration: ms when not set by the text.
    var REACTIONS = {
        // the bridge
        delivered:       { face: 'content', prop: 'envelope', motion: 'hop', gaze: [160, 110] },
        incoming:        { face: 'curious', prop: 'mark', gaze: [130, 140] },
        synced:          { face: 'content', prop: 'sparkles', motion: 'wiggle', gaze: [30, 90] }, // 1.0.6: every finished sync
        invitation:      { face: 'content', prop: 'mark', motion: 'bounce' },
        answered:        { face: 'content', prop: 'envelope', motion: 'wave' },
        cancelled:       { face: 'soft', motion: 'tilt' },
        refused:         { face: 'soft', prop: 'sweat', motion: 'tilt' },
        slowdown:        { face: 'idle', prop: 'clock', motion: 'sway', gaze: [162, 46] },
        online:          { face: 'content', motion: 'stretch', wakes: true },
        wake:            { face: 'yawn', motion: 'stretch', wakes: true },
        signedIn:        { face: 'content', prop: 'confetti', motion: 'hop' },
        signInNeeded:    { face: 'soft', prop: 'question', motion: 'tilt' },
        appConnected:    { face: 'content', motion: 'wave' },
        appMissing:      { face: 'curious', prop: 'question', motion: 'tilt', gaze: [20, 20] },
        updateAvailable: { face: 'curious', prop: 'sparkles', motion: 'bounce' },
        refresh:         { face: 'idle', motion: 'wiggle', gaze: [100, 140] },
        quiet:           { face: 'soft', prop: 'notes', motion: 'sway' },
        busyDay:         { face: 'curious', prop: 'envelope', motion: 'shiver' },
        freeDay:         { face: 'content', prop: 'heart', motion: 'sway' },
        poke:            { face: 'content', motion: 'wiggle' },
        thanks:          { face: 'content', prop: 'heart', motion: 'hop' },
        relief:          { face: 'content', prop: 'sweat', motion: 'stretch' },
        milestone:       { face: 'content', prop: 'confetti', motion: 'hop' },
        // his own small life
        coffee:          { face: 'content', prop: 'coffee', motion: 'sip', duration: 14000, gaze: [128, 118] },
        snack:           { face: 'content', prop: 'apple', motion: 'chew', duration: 8000, gaze: [72, 118] },
        stretch:         { face: 'yawn', motion: 'stretch', quiet: true, duration: 2200 },
        sneeze:          { face: 'yawn', motion: 'sneeze', duration: 2600 },
        daydream:        { face: 'soft', prop: 'thought', motion: 'sway', duration: 9000, gaze: [40, 10] },
        hum:             { face: 'idle', prop: 'notes', motion: 'sway', quiet: true, duration: 6000 },
        letter:          { face: 'curious', prop: 'letter', duration: 7000, gaze: [72, 124] },
        trivia:          { face: 'curious', prop: 'sparkles' },
        welcomeBack:     { face: 'content', motion: 'wave' },
        sleepyLove:      { face: 'sleepy', inSleep: true, prop: 'heart', duration: 5200 },
        wish:            { face: 'content', prop: 'shooting', gaze: [170, 6], duration: 5000 },
        // touch
        dance:           { face: 'content', prop: 'notes', motion: 'dance', duration: 5000 },
        pet:             { face: 'content', prop: 'heart', motion: 'sway', duration: 4000 },
        boop:            { face: 'scrunch', motion: 'scrunch', duration: 2400 },
        earTickle:       { face: 'content', motion: 'earflick', duration: 2400 },
        hornTap:         { face: 'soft', prop: 'sparkles', motion: 'shiver', duration: 2600 },
        bagPeek:         { face: 'curious', prop: 'envelope', gaze: [128, 142] },
        tailPull:        { face: 'curious', prop: 'mark', motion: 'tilt', gaze: [190, 150] },
        belly:           { face: 'content', motion: 'wiggle', duration: 2600 },
        dizzy:           { face: 'dizzy', motion: 'wobble', duration: 4200 },
        shy:             { face: 'shy', motion: 'tilt', gaze: [10, 120] },
        typing:          { face: 'content', motion: 'bounce' },
        party:           { face: 'content', prop: 'confetti', motion: 'dance', duration: 6500 },
        // the day
        lunch:           { face: 'content', prop: 'apple', motion: 'sway' },
        evening:         { face: 'soft', motion: 'sway' },
        weekend:         { face: 'content', motion: 'sway' },
        birthday:        { face: 'content', prop: 'confetti', motion: 'dance', duration: 7000 },
        userBirthday:    { face: 'content', prop: 'confetti', motion: 'dance', duration: 7000 },
    };

    // Things in his small life, with how likely each is when the moment comes.
    var LIFE = [
        ['stretch', 5], ['hum', 4], ['daydream', 3], ['letter', 3], ['trivia', 2],
        ['sneeze', 2], ['snack', 2], ['coffee', 3], ['earTwitch', 6], ['tailFlick', 6],
    ];

    // viewBox 0 0 200 170. Eyes sit at y≈68 — look() uses that for the gaze origin.
    // Plush style: front view, a horse's head — tall skull, muzzle at the bottom, eyes
    // high and wide apart, tall ears — a big horn, a mane to the shoulders, a small
    // round body with the courier bag. Props and hats are drawn hidden and shown by class.
    var SVG =
        '<svg viewBox="0 0 200 170" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false">' +
        '<defs>' +
        '<linearGradient id="hb-mane" x1="0" y1="0" x2="1" y2="1">' +
        '<stop offset="0" stop-color="#ff9ad5"/><stop offset=".55" stop-color="#b48cff"/><stop offset="1" stop-color="#8ad1ff"/>' +
        '</linearGradient>' +
        '<linearGradient id="hb-horn" x1="0" y1="0" x2="0" y2="1">' +
        '<stop offset="0" stop-color="#ffe9a3"/><stop offset="1" stop-color="#ffb347"/>' +
        '</linearGradient>' +
        '<linearGradient id="hb-body" x1="0" y1="0" x2="0" y2="1">' +
        '<stop offset="0" stop-color="#ffffff"/><stop offset="1" stop-color="#efe8fb"/>' +
        '</linearGradient>' +
        '<clipPath id="hb-eye"><circle r="8.5"/></clipPath>' +
        '</defs>' +

        // night sky: tiny stars and a shooting star, only at night
        '<g class="sky">' +
        '<circle class="star" cx="14" cy="18" r="1.2"/><circle class="star" cx="38" cy="8" r="0.9"/><circle class="star" cx="178" cy="14" r="1.1"/>' +
        '<circle class="star" cx="190" cy="40" r="0.8"/><circle class="star" cx="8" cy="60" r="0.9"/><circle class="star" cx="164" cy="4" r="0.8"/>' +
        '<g class="prop prop-shooting"><path class="shooting-tail" d="M186 4 L160 22"/><circle class="shooting-head" cx="160" cy="22" r="2"/></g>' +
        '</g>' +

        '<ellipse class="ground" cx="100" cy="163" rx="46" ry="5"/>' +
        '<g class="pumpkin"><ellipse cx="42" cy="156" rx="13" ry="10"/><path class="pumpkin-rib" d="M36 147 C33 152 33 160 36 165 M48 147 C51 152 51 160 48 165"/><path class="pumpkin-stem" d="M42 146 C42 142 44 141 46 140"/><path class="pumpkin-face" d="M36 153 l3 3 l-6 0 z M45 153 l3 3 l-6 0 z M35 160 q7 5 14 0"/></g>' +

        // 1.0.6: about half as big again and thicker inwards (bands 10 wide, radii 90–55.5 instead of 66–48 at 5;
        // the outer edge stays clear of the frame's corners, the inner one comes close to his shoulders),
        // a touch brighter, with a glow (herbert.css)
        '<g class="rainbow">' +
        '<path d="M10 150 A90 90 0 0 1 190 150" stroke="#ff9dba"/>' +
        '<path d="M21.5 150 A78.5 78.5 0 0 1 178.5 150" stroke="#ffd977"/>' +
        '<path d="M33 150 A67 67 0 0 1 167 150" stroke="#9adbff"/>' +
        '<path d="M44.5 150 A55.5 55.5 0 0 1 155.5 150" stroke="#d3b6ff"/>' +
        '</g>' +

        '<g class="pose"><g class="jitter">' +

        '<g class="tail-pivot"><path class="tail part" data-part="tail" d="M134 128 C156 118 166 138 152 148 C162 156 150 168 136 160 C146 152 142 140 130 138 Z"/></g>' +

        '<path class="body part" data-part="belly" d="M100 112 C128 112 138 130 136 146 C134 160 118 162 100 162 C82 162 66 160 64 146 C62 130 72 112 100 112 Z"/>' +
        '<path class="scarf" d="M72 114 C84 122 116 122 128 114 L130 122 C116 132 84 132 70 122 Z"/><path class="scarf scarf-end" d="M76 120 L70 142 L80 140 L82 122 Z"/>' +
        '<path class="strap" d="M78 122 Q100 140 124 150"/>' +

        '<g class="arm arm-left"><rect class="leg" x="80" y="138" width="13" height="22" rx="6"/><rect class="hoof" x="80" y="153" width="13" height="8" rx="4"/>' +
        '<g class="held held-apple" transform="translate(86 160)"><circle class="apple-body" r="6"/><path class="apple-leaf" d="M0 -6 C2 -9 5 -9 6 -7 C4 -6 2 -6 0 -6 Z"/><path class="apple-bite" d="M4 -3 a3 3 0 0 0 0 5"/></g>' +
        '<g class="held held-letter" transform="translate(84 160)"><rect x="-10" y="-8" width="20" height="14" rx="1.5"/><path class="env-fold" d="M-10 -8 l10 8 l10 -8"/><path class="letter-lines" d="M-6 1 h12 M-6 4 h8"/></g>' +
        '</g>' +
        '<g class="arm arm-right"><rect class="leg" x="107" y="138" width="13" height="22" rx="6"/><rect class="hoof" x="107" y="153" width="13" height="8" rx="4"/>' +
        '<g class="held held-cup" transform="translate(114 160)"><path class="cup-body" d="M-6 -7 h12 l-1.5 11 h-9 Z"/><path class="cup-handle" d="M6 -4 a3.5 3.5 0 0 1 0 7"/><path class="steam" d="M-3 -10 q2 -3 0 -6 M1 -10 q2 -3 0 -6"/></g>' +
        '</g>' +

        '<g class="bag part" data-part="bag">' +
        '<rect x="116" y="136" width="20" height="15" rx="4"/>' +
        '<rect class="bag-flap" x="116" y="136" width="20" height="6" rx="3"/>' +
        '<rect class="envelope" x="121" y="143" width="10" height="6.5" rx="1"/>' +
        '<path class="envelope-fold" d="M121 143 l5 4 l5 -4"/>' +
        '<g class="badge" transform="translate(136 136)"><circle r="6"/><text text-anchor="middle" dy="2.4"></text></g>' +
        '<g class="busy" transform="translate(116 136)"><circle r="5.5"/><path d="M-3 0 a3 3 0 1 1 3 3" class="busy-arc"/></g>' +
        '</g>' +

        '<g class="neck"><g class="head">' +
        '<path class="mane mane-back" d="M62 70 C56 34 92 18 118 24 C140 30 150 58 142 86 C136 70 128 60 118 56 L70 60 Z"/>' +
        '<path class="mane mane-neck" d="M130 60 C150 66 152 96 140 118 C138 100 132 86 124 78 Z"/>' +
        '<path class="mane mane-neck" d="M70 62 C50 70 48 100 60 118 C62 100 66 88 76 80 Z"/>' +

        '<g class="ear ear-left part" data-part="ear"><path class="ear-outer" d="M72 48 C62 32 64 14 72 12 C80 12 86 32 84 50 Z"/><path class="ear-inner" d="M74 44 C68 32 70 20 73 19 C77 20 81 34 80 46 Z"/></g>' +
        '<g class="ear ear-right part" data-part="ear"><path class="ear-outer" d="M128 48 C138 32 136 14 128 12 C120 12 114 32 116 50 Z"/><path class="ear-inner" d="M126 44 C132 32 130 20 127 19 C123 20 119 34 120 46 Z"/></g>' +

        '<g class="horn part" data-part="horn"><path class="horn-cone" d="M91 40 L109 40 L100 2 Z"/>' +
        '<path class="horn-stripe" d="M94 32 L107 29"/><path class="horn-stripe" d="M95.5 24 L105.5 21.5"/><path class="horn-stripe" d="M97.5 15 L103.5 13.5"/>' +
        '<g transform="translate(113 8)"><path class="horn-sparkle" d="M0 -5 L1.3 -1.3 L5 0 L1.3 1.3 L0 5 L-1.3 1.3 L-5 0 L-1.3 -1.3 Z"/></g></g>' +

        '<path class="face part" data-part="face" d="M68 64 C68 38 132 38 132 64 C132 86 124 110 100 114 C76 110 68 86 68 64 Z"/>' +

        '<path class="snout part" data-part="nose" d="M82 92 C82 82 118 82 118 92 C118 104 108 110 100 110 C92 110 82 104 82 92 Z"/>' +
        '<ellipse class="nostril" cx="92" cy="98" rx="2.4" ry="1.6" transform="rotate(-20 92 98)"/><ellipse class="nostril" cx="108" cy="98" rx="2.4" ry="1.6" transform="rotate(20 108 98)"/>' +
        '<ellipse class="cheek" cx="75" cy="84" rx="6.5" ry="4"/><ellipse class="cheek" cx="125" cy="84" rx="6.5" ry="4"/>' +

        '<path class="mane mane-front" d="M80 46 C84 30 104 26 116 36 C106 36 100 42 102 50 C96 46 90 46 86 48 C84 45 82 47 80 46 Z"/>' +

        // hats sit on the forelock
        '<g class="hats">' +
        '<g class="hat hat-santa"><path class="santa-body" d="M78 44 C84 22 112 16 130 30 L124 36 C110 28 92 32 86 46 Z"/><path class="santa-brim" d="M76 46 C90 36 112 34 126 40 L124 46 C110 42 92 44 80 52 Z"/><circle class="santa-pom" cx="131" cy="29" r="4.5"/></g>' +
        '<g class="hat hat-party" transform="rotate(-22 80 46)"><path class="party-cone" d="M70 48 L90 46 L80 10 Z"/><path class="party-stripe" d="M74 38 L87 36 M76 28 L85 26"/><circle class="party-pom" cx="80" cy="10" r="3.2"/></g>' +
        '<g class="hat hat-night"><path class="night-body" d="M76 46 C80 28 104 18 122 24 C134 28 140 44 136 58 L132 54 C130 44 120 34 108 34 C96 34 86 40 82 48 Z"/><path class="night-brim" d="M74 48 C90 38 112 36 128 42 L126 48 C112 44 92 46 78 54 Z"/><circle class="night-pom" cx="137" cy="59" r="4"/></g>' +
        '<g class="hat hat-hearts"><path class="crown-heart" transform="translate(84 40)" d="M0 3 C-5 -2 -2 -7 0 -4 C2 -7 5 -2 0 3 Z"/><path class="crown-heart" transform="translate(100 34)" d="M0 3.5 C-6 -2.5 -2.5 -8 0 -4.5 C2.5 -8 6 -2.5 0 3.5 Z"/><path class="crown-heart" transform="translate(116 40)" d="M0 3 C-5 -2 -2 -7 0 -4 C2 -7 5 -2 0 3 Z"/></g>' +
        '<g class="hat hat-sunglasses"><rect x="73" y="61" width="22" height="14" rx="6"/><rect x="105" y="61" width="22" height="14" rx="6"/><path class="glasses-bridge" d="M95 66 Q100 63 105 66"/><path class="glasses-shine" d="M78 66 l5 -3 M110 66 l5 -3"/></g>' +
        '</g>' +

        '<path class="brow brow-left" d="M77 57 Q84 52 91 56"/>' +
        '<path class="brow brow-right" d="M123 57 Q116 52 109 56"/>' +

        '<g class="eye eye-left" transform="translate(84 68)">' +
        '<circle class="eye-white" r="8.5"/>' +
        '<g class="pupil"><g class="pupil-core"><circle class="iris" r="5.6"/><circle class="glint" cx="-2.1" cy="-2.1" r="2.1"/><circle class="glint" cx="2.2" cy="2.6" r="0.9"/></g></g>' +
        '<path class="eye-dizzy" d="M0 0 m-1 0 a1 1 0 0 1 2 0 a2 2 0 0 1 -4 0 a3 3 0 0 1 6 0 a4 4 0 0 1 -8 0 a5 5 0 0 1 10 0"/>' +
        '<g clip-path="url(#hb-eye)"><circle class="lid" r="10"/></g>' +
        '<path class="eye-happy" d="M-8 1.5 Q0 -8.5 8 1.5"/>' +
        '<path class="eye-sleep" d="M-8 -1 Q0 7.5 8 -1"/>' +
        '</g>' +
        '<g class="eye eye-right" transform="translate(116 68)">' +
        '<circle class="eye-white" r="8.5"/>' +
        '<g class="pupil"><g class="pupil-core"><circle class="iris" r="5.6"/><circle class="glint" cx="-2.1" cy="-2.1" r="2.1"/><circle class="glint" cx="2.2" cy="2.6" r="0.9"/></g></g>' +
        '<path class="eye-dizzy" d="M0 0 m-1 0 a1 1 0 0 1 2 0 a2 2 0 0 1 -4 0 a3 3 0 0 1 6 0 a4 4 0 0 1 -8 0 a5 5 0 0 1 10 0"/>' +
        '<g clip-path="url(#hb-eye)"><circle class="lid" r="10"/></g>' +
        '<path class="eye-happy" d="M-8 1.5 Q0 -8.5 8 1.5"/>' +
        '<path class="eye-sleep" d="M-8 -1 Q0 7.5 8 -1"/>' +
        '</g>' +

        '<g class="mouth">' +
        '<path class="mouth-smile" d="M95 104 Q100 109 105 104"/>' +
        '<ellipse class="mouth-open" cx="100" cy="105.5" rx="3.6" ry="4.4"/>' +
        '<g class="mouth-big"><path d="M92 102.5 Q100 115 108 102.5 Z"/><ellipse class="tongue" cx="100" cy="109.5" rx="3.4" ry="2.2"/></g>' +
        '<path class="mouth-worried" d="M95 107 Q97.5 103.5 100 106.5 Q102.5 109.5 105 105.5"/>' +
        '<ellipse class="mouth-sleep" cx="100" cy="105.5" rx="1.8" ry="2.2"/>' +
        '</g>' +

        '<path class="sweat" d="M138 52 C133 59 132 64 138 66 C144 64 143 59 138 52 Z"/>' +
        '</g></g>' + // head, neck

        '</g></g>' + // jitter, pose

        '<g class="zzz"><text x="146" y="56">z</text><text x="156" y="42">z</text><text x="168" y="26">z</text></g>' +

        '<g class="props">' +
        '<g transform="translate(150 120)"><g class="prop prop-envelope"><rect x="-9" y="-6" width="18" height="12" rx="1.5"/><path class="env-fold" d="M-9 -6 l9 7 l9 -7"/><path class="env-wind" d="M-17 -1 h5 M-20 4 h7"/></g></g>' +
        '<text class="prop prop-mark" x="148" y="46">!</text>' +
        '<text class="prop prop-question" x="146" y="46">?</text>' +
        '<g transform="translate(152 36)"><path class="prop prop-heart" d="M0 7 C-12 -3 -5 -14 0 -8 C5 -14 12 -3 0 7 Z"/></g>' +
        '<g transform="translate(162 46)"><g class="prop prop-clock"><circle r="9"/><path class="clock-hands" d="M0 -5 V0 H4"/><path class="clock-tick" d="M0 -9 v2 M0 7 v2 M-9 0 h2 M7 0 h2"/></g></g>' +
        '<g class="prop prop-notes"><text x="140" y="48">♪</text><text x="154" y="34">♫</text><text x="36" y="56">♪</text></g>' +
        '<g class="prop prop-confetti">' +
        '<rect x="40" y="8" width="5" height="8" rx="1" fill="#ff8fab"/><rect x="70" y="2" width="5" height="8" rx="1" fill="#ffd166"/><rect x="128" y="4" width="5" height="8" rx="1" fill="#8ad1ff"/>' +
        '<rect x="156" y="10" width="5" height="8" rx="1" fill="#b48cff"/><rect x="24" y="30" width="5" height="8" rx="1" fill="#5ad8c2"/><rect x="176" y="34" width="5" height="8" rx="1" fill="#ff8fab"/>' +
        '<circle cx="56" cy="0" r="3" fill="#8ad1ff"/><circle cx="100" cy="-4" r="3" fill="#ffd166"/><circle cx="144" cy="-2" r="3" fill="#ff8fab"/>' +
        '</g>' +
        '<g class="prop prop-thought"><circle cx="134" cy="56" r="2"/><circle cx="142" cy="46" r="3"/><g class="thought-cloud"><ellipse cx="160" cy="28" rx="22" ry="15"/><path class="thought-rainbow" d="M148 34 A12 12 0 0 1 172 34" stroke="#ff8fab"/><path class="thought-rainbow" d="M152 34 A8 8 0 0 1 168 34" stroke="#ffd166"/><path class="thought-rainbow" d="M156 34 A4 4 0 0 1 164 34" stroke="#8ad1ff"/></g></g>' +
        '</g>' +

        '<g class="sparkles">' +
        '<g transform="translate(48 40)"><path class="sparkle" d="M0 -6 L1.6 -1.6 L6 0 L1.6 1.6 L0 6 L-1.6 1.6 L-6 0 L-1.6 -1.6 Z"/></g>' +
        '<g transform="translate(156 32)"><path class="sparkle" d="M0 -5 L1.3 -1.3 L5 0 L1.3 1.3 L0 5 L-1.3 1.3 L-5 0 L-1.3 -1.3 Z"/></g>' +
        '<g transform="translate(38 104)"><path class="sparkle" d="M0 -4 L1 -1 L4 0 L1 1 L0 4 L-1 1 L-4 0 L-1 -1 Z"/></g>' +
        '<g transform="translate(166 86)"><path class="sparkle heart" d="M0 3.5 C-7 -3 -2.5 -9 0 -4.5 C2.5 -9 7 -3 0 3.5 Z"/></g>' +
        '<g transform="translate(34 72)"><path class="sparkle heart" d="M0 2.6 C-5 -2.2 -1.8 -6.6 0 -3.3 C1.8 -6.6 5 -2.2 0 2.6 Z"/></g>' +
        '</g>' +
        '</svg>';

    function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
    function between(lo, hi) { return lo + Math.random() * (hi - lo); }
    function shuffle(list) { return list.slice().sort(function () { return Math.random() - 0.5; }); }
    function dayKey(d) { return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate(); }

    function createHerbert(container, options) {
        options = options || {};
        var texts = options.texts || global.HERBERT_TEXTS || {};
        var settings = {
            userName: options.userName || '',
            chattiness: typeof options.chattiness === 'number' ? options.chattiness : 1, // 0 silent, 1 normal, 2 chatty
            quietHours: options.quietHours || null,       // e.g. [22, 7]: no spontaneous lines between 22:00 and 07:00
            encourageEvery: options.encourageEvery || 20 * 60 * 1000,
            bubbleHold: options.bubbleHold || 0,          // ms a line stays after he has said it (0: it goes at once); a click elsewhere takes it away
            lifeEvery: options.lifeEvery || 4 * 60 * 1000,  // how often his small life may do something
            drowsyAfter: options.drowsyAfter || 10 * 60 * 1000,
            awayAfter: options.awayAfter || 15 * 60 * 1000,
            userBirthday: options.userBirthday || null,  // 'MM-DD'
            season: options.season || 'auto',           // or one of: none, christmas, newyear, halloween, valentine, birthday, winter, summer
            typewriter: options.typewriter !== false,
            translate: typeof options.translate === 'function' ? options.translate : function (x) { return x; }, // the app passes its t()
            birthday: '10-28',                           // Herbert's own
        };

        var root = document.createElement('div');
        root.className = 'herbert is-idle';
        root.setAttribute('role', 'img');
        root.setAttribute('tabindex', '0');
        root.innerHTML =
            '<div class="herbert-bubble" role="status" aria-live="polite"><span class="herbert-bubble-text"></span></div>' +
            '<div class="herbert-stage">' + SVG + '</div>' +
            '<button class="herbert-return" type="button" aria-label="Bring Herbert back" title="Bring Herbert back">' +
            '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M7 16 L10 4 L13 16 Z"/><path d="M8.5 11 L11.5 10 M9.2 8 L11 7.5"/></svg></button>';
        container.appendChild(root);

        var svg = root.querySelector('.herbert-stage svg');
        var bubble = root.querySelector('.herbert-bubble');
        var bubbleText = root.querySelector('.herbert-bubble-text');
        var head = svg.querySelector('.head');
        var pupils = svg.querySelectorAll('.pupil');
        var lids = svg.querySelectorAll('.lid');
        var badge = svg.querySelector('.badge text');
        var returnButton = root.querySelector('.herbert-return');

        var state = 'idle';
        var listeners = {};
        var gaze = null;      // { x, y, until } — a point he was told to look at
        var pointer = null;   // { x, y, at } — where the pointer last was
        var lastActivity = Date.now();
        var reaction = null;  // the reaction playing right now, if any
        var bags = {};        // per text key: the lines not yet said this round
        var lastLine = {};
        var mood = 0;         // below zero after trouble; relief when it is fine again
        var pending = 0;
        var enabled = true;
        var queue = [];       // lines waiting behind the one on screen
        var bubbleHeld = false;
        var bubbleShownAt = 0; // when the line on screen appeared
        var bubbleRead = false; // he has finished saying it; the bubble only lingers now
        var onceToday = {};   // lunch / evening / weekend / weekday / birthdays, per day
        var stats = { deliveries: 0, pokes: 0, coffees: 0, encouragements: 0, reactions: 0 };
        var timers = { bubble: null, blink: null, wander: null, gaze: null, encourage: null, reaction: null, life: null, hold: null, minute: null, typing: null, typeChars: null, pulse: {} };
        var destroyed = false;

        try { onceToday = JSON.parse(localStorage.getItem('herbert-once') || '{}'); } catch (e) { onceToday = {}; }

        // --- events --------------------------------------------------------------
        function on(name, fn) { (listeners[name] = listeners[name] || []).push(fn); return api; }
        function off(name, fn) {
            listeners[name] = (listeners[name] || []).filter(function (f) { return f !== fn; });
            return api;
        }
        function emit(name, detail) {
            (listeners[name] || []).forEach(function (fn) { try { fn(detail); } catch (e) { console.error(e); } });
        }

        // A short one-off class, e.g. a hop when the state changes, ears up on a click.
        function pulse(cls, ms) {
            clearTimeout(timers.pulse[cls]);
            root.classList.remove(cls);
            void root.offsetWidth; // restart the CSS animation
            root.classList.add(cls);
            timers.pulse[cls] = setTimeout(function () { root.classList.remove(cls); }, ms || 700);
        }

        // --- texts ---------------------------------------------------------------
        // One line for a key: from a list every line once, in random order, before any
        // repeats, never the same line twice in a row. {name} is the person's name.
        function line(key, vars) {
            var value = key.indexOf('.') > 0 ? (texts[key.split('.')[0]] || {})[key.split('.')[1]] : texts[key];
            if (value && !Array.isArray(value) && typeof value === 'object') value = value[vars && vars.sub];
            var text;
            if (Array.isArray(value)) {
                if (!value.length) return '';
                if (!bags[key] || !bags[key].length) {
                    bags[key] = shuffle(value);
                    if (bags[key].length > 1 && bags[key][bags[key].length - 1] === lastLine[key]) bags[key].unshift(bags[key].pop());
                }
                text = bags[key].pop();
            } else {
                text = value || '';
            }
            lastLine[key] = text;
            return fill(text, vars);
        }
        function fill(text, vars) {
            vars = vars || {};
            text = settings.translate(text) || text;
            if (settings.userName) text = text.replace(/\{name\}/g, settings.userName);
            else text = text.replace(/, \{name\}/g, '').replace(/\{name\}/g, 'you');
            Object.keys(vars).forEach(function (k) { text = text.replace(new RegExp('\\{' + k + '\\}', 'g'), vars[k]); });
            return text;
        }
        function inQuietHours() {
            var q = settings.quietHours;
            if (!q) return false;
            var h = new Date().getHours();
            return q[0] <= q[1] ? (h >= q[0] && h < q[1]) : (h >= q[0] || h < q[1]);
        }
        // May he say something nobody asked for right now?
        function maySpeakUp() {
            return settings.chattiness > 0 && !inQuietHours() && enabled && document.visibilityState === 'visible';
        }

        // --- gaze ----------------------------------------------------------------
        function eyeCenter() {
            var r = svg.getBoundingClientRect();
            return { x: r.left + r.width * 0.5, y: r.top + r.height * (68 / 170) };
        }

        // Point the pupils and tilt the head (and ears) toward a page coordinate, or straight ahead.
        function look(target) {
            var nx = 0, ny = 0;
            if (target) {
                var c = eyeCenter();
                nx = clamp((target.x - c.x) / 240, -1, 1);
                ny = clamp((target.y - c.y) / 180, -1, 1);
            }
            var eager = state === 'curious' || root.classList.contains('is-hovered') ? 1.2 : state === 'worried' ? 0.6 : 1;
            var px = (nx * 3.2 * eager).toFixed(2), py = (ny * 2.6 * eager).toFixed(2);
            for (var i = 0; i < pupils.length; i++) pupils[i].style.transform = 'translate(' + px + 'px,' + py + 'px)';
            head.style.setProperty('--hx', (nx * 2.6).toFixed(2) + 'px');
            head.style.setProperty('--hy', (ny * 1.6).toFixed(2) + 'px');
            head.style.setProperty('--hr', (nx * 4).toFixed(2) + 'deg');
            root.style.setProperty('--ear', (nx * 6).toFixed(2) + 'deg');
        }

        function refreshGaze() {
            if (destroyed) return;
            if (state === 'asleep') { look(null); return; }
            var now = Date.now();
            if (gaze && gaze.until > now) { look(gaze); return; }
            gaze = null;
            if (pointer && now - pointer.at < 4000) { look(pointer); return; }
            look(null);
        }

        function lookAt(x, y, holdMs) {
            if (state === 'asleep') return api;
            var hold = holdMs || 2200;
            gaze = { x: x, y: y, until: Date.now() + hold };
            clearTimeout(timers.gaze);
            timers.gaze = setTimeout(refreshGaze, hold + 30);
            refreshGaze();
            return api;
        }

        // The same, for a point in Herbert's own drawing (viewBox units).
        function lookAtSvg(x, y, holdMs) {
            var r = svg.getBoundingClientRect();
            return lookAt(r.left + (x / 200) * r.width, r.top + (y / 170) * r.height, holdMs);
        }

        // Every few seconds, when nothing else is going on, a small glance somewhere.
        function scheduleWander() {
            clearTimeout(timers.wander);
            timers.wander = setTimeout(function () {
                var idlePointer = !pointer || Date.now() - pointer.at > 4000;
                if (state !== 'asleep' && !gaze && idlePointer && !reaction) {
                    var c = eyeCenter();
                    lookAtSvg(100 + between(-110, 110), 68 + between(-60, 80), between(900, 1800));
                }
                scheduleWander();
            }, between(3500, 8000));
        }

        // --- blinking ------------------------------------------------------------
        function blink() {
            if (state === 'asleep' || state === 'content' || root.classList.contains('is-content')) return;
            for (var i = 0; i < lids.length; i++) {
                lids[i].classList.remove('blink');
                void lids[i].getBBox();
                lids[i].classList.add('blink');
            }
            setTimeout(function () { for (var i = 0; i < lids.length; i++) lids[i].classList.remove('blink'); }, 260);
        }
        function scheduleBlink() {
            clearTimeout(timers.blink);
            var curious = state === 'curious' || root.classList.contains('is-hovered');
            var sleepy = root.classList.contains('is-drowsy');
            timers.blink = setTimeout(function () {
                blink();
                if (Math.random() < 0.2) setTimeout(blink, 280); // a double blink now and then
                scheduleBlink();
            }, sleepy ? between(4000, 9000) : curious ? between(900, 2600) : between(1800, 5200));
        }

        // --- speech --------------------------------------------------------------
        function showBubble(text, thought) {
            bubble.classList.toggle('is-thought', !!thought);
            bubble.classList.add('is-visible');
            root.classList.toggle('is-speaking', !thought && state !== 'asleep');
            clearInterval(timers.typeChars);
            if (settings.typewriter && !matchMedia('(prefers-reduced-motion: reduce)').matches && text.length > 1) {
                var shown = 0;
                bubbleText.textContent = '';
                timers.typeChars = setInterval(function () {
                    shown = Math.min(text.length, shown + 1);
                    bubbleText.textContent = text.slice(0, shown);
                    if (shown >= text.length) clearInterval(timers.typeChars);
                }, 16);
            } else {
                bubbleText.textContent = text;
            }
            // he glances up at the bubble first
            if (state !== 'asleep' && !reaction) lookAtSvg(100, -20, 700);
        }
        function hideBubble() {
            clearTimeout(timers.bubble);
            clearInterval(timers.typeChars);
            bubble.classList.remove('is-visible');
            root.classList.remove('is-speaking', 'is-sparkling');
            bubbleRead = false;
            if (queue.length) {
                var next = queue.shift();
                timers.bubble = setTimeout(function () { say(next.text, { duration: next.duration, now: true, thought: next.thought }); }, 350);
            }
        }
        function hush() {
            queue = [];
            hideBubble();
            return api;
        }
        function bubbleDuration(text) { return clamp(2600 + text.length * 60, 3200, 10000); }
        // Is he saying something right now (the line's reading time has not passed)? A lingering line does not count.
        function talking() { return bubble.classList.contains('is-visible') && !bubbleRead; }
        // The reading time is over: he stops moving his mouth; the next queued line comes, or the line
        // lingers for bubbleHold (a click elsewhere in the window takes it away) and then goes.
        function afterRead() {
            bubbleRead = true;
            root.classList.remove('is-speaking', 'is-sparkling');
            if (queue.length) { hideBubble(); return; }
            var linger = settings.bubbleHold - (Date.now() - bubbleShownAt);
            if (linger > 0) { timers.bubble = setTimeout(finishBubble, linger); return; }
            finishBubble();
        }
        function finishBubble() {
            if (bubbleHeld) { timers.bubble = setTimeout(finishBubble, 1500); return; } // the pointer rests on it: not yet
            hideBubble();
        }
        // A click somewhere else in the window: the line goes, once it has been up long enough to be seen.
        function dismissBubble() {
            if (!bubble.classList.contains('is-visible')) return;
            queue = [];
            var shown = Date.now() - bubbleShownAt;
            if (shown >= 1500) { hideBubble(); return; }
            clearTimeout(timers.bubble);
            timers.bubble = setTimeout(hideBubble, 1500 - shown);
        }
        function say(text, opts) {
            opts = opts || {};
            if (!text) return hush();
            if (state === 'asleep' && !opts.inSleep) return api; // he sleeps; the app wakes him with setState first
            if (!enabled) return api;
            var duration = opts.duration || bubbleDuration(text);
            if (talking() && !opts.now) { // a lingering line is simply replaced
                if (queue.length < 3) queue.push({ text: text, duration: duration, thought: opts.thought });
                return api;
            }
            clearTimeout(timers.bubble);
            bubbleShownAt = Date.now();
            bubbleRead = false;
            showBubble(text, opts.thought);
            timers.bubble = setTimeout(afterRead, duration);
            emit('say', { text: text, duration: duration, thought: !!opts.thought });
            return api;
        }
        function think(text, opts) {
            opts = opts || {};
            opts.thought = true;
            return say(text, opts);
        }

        // --- states --------------------------------------------------------------
        function setStateClass(name) {
            for (var i = 0; i < STATES.length; i++) root.classList.toggle('is-' + STATES[i], STATES[i] === name);
            root.setAttribute('aria-label', 'Herbert the unicorn, ' + name);
        }
        function setState(name, opts) {
            opts = opts || {};
            if (STATES.indexOf(name) < 0) throw new Error('Herbert does not know the state "' + name + '"');
            clearReaction();
            var previous = state;
            state = name;
            setStateClass(name);
            root.classList.remove('is-sparkling', 'is-drowsy');
            if (name === 'asleep') { hush(); gaze = null; }
            else if (name !== previous) pulse('did-change', 600);
            if (name === 'worried') mood -= 1;
            if (!opts.quiet) {
                if (opts.text) say(opts.text, { now: true });
                else if (name === 'worried') say(line('worried'), { now: true });
                else if (name === 'content') {
                    if (mood < 0) { mood = 0; react('relief'); }
                    else say(line('content'), { now: true });
                }
            }
            refreshGaze();
            emit('state', { state: name, previous: previous });
            return api;
        }
        function getState() { return state; }

        function greetingKey(hour) {
            if (hour >= 5 && hour < 11) return 'greetingMorning';
            if (hour >= 11 && hour < 17) return 'greetingAfternoon';
            if (hour >= 17 && hour < 22) return 'greetingEvening';
            return 'greetingNight';
        }
        function greet(hour) {
            if (state === 'asleep' || !enabled) return api;
            var now = new Date();
            var h = typeof hour === 'number' ? hour : now.getHours();
            pulse('did-notice', 900);
            say(line(greetingKey(h)), { now: true });
            // the first greeting of the day adds the weekday
            if (typeof hour !== 'number' && once('weekday')) {
                var wd = (texts.weekday || {})[now.getDay()];
                if (wd) say(fill(wd));
            }
            return api;
        }

        function encourage(opts) {
            opts = opts || {};
            if (!enabled) return api;
            if (state === 'asleep' && !opts.inSleep) return api;
            var text = line('encouragements');
            if (!text) return api;
            stats.encouragements += 1;
            say(text, { now: true, inSleep: opts.inSleep });
            root.classList.add('is-sparkling');
            return api;
        }
        // Unobtrusive: only when he is idle, calm or content, nothing else is being said,
        // the window is visible and it is not his quiet hours. Otherwise a minute later.
        function scheduleEncouragement(ms) {
            clearTimeout(timers.encourage);
            timers.encourage = setTimeout(function () {
                var calm = state === 'idle' || state === 'content' || state === 'curious';
                var quiet = !talking() && !reaction;
                if (calm && quiet && maySpeakUp()) {
                    encourage();
                    scheduleEncouragement(settings.encourageEvery / (settings.chattiness === 2 ? 2 : 1));
                } else {
                    scheduleEncouragement(60000);
                }
            }, ms);
        }

        // --- reactions -----------------------------------------------------------
        function reactionClasses(name) {
            var r = REACTIONS[name];
            var list = ['is-reacting', 'react-' + name];
            var face = r.face || 'idle';
            list.push(FACES.indexOf(face) >= 0 ? 'face-' + face : 'is-' + face);
            if (r.prop) list.push('prop-' + r.prop);
            if (r.motion) list.push('motion-' + r.motion);
            return list;
        }
        function clearReaction() {
            clearTimeout(timers.reaction);
            if (!reaction) return;
            var cls = reactionClasses(reaction);
            reaction = null;
            for (var i = 0; i < cls.length; i++) root.classList.remove(cls[i]);
            setStateClass(state); // the borrowed face goes, his own state's face comes back
        }
        function react(name, opts) {
            opts = opts || {};
            var r = REACTIONS[name];
            if (!r) throw new Error('Herbert does not know the reaction "' + name + '"');
            if (!enabled) return api;
            if (state === 'asleep') {
                if (r.wakes) setState('idle', { quiet: true });
                else if (!r.inSleep) { pulse('did-notice', 900); return api; } // a stir in his sleep, nothing more
            }
            clearReaction();
            var vars = Object.assign({ n: name === 'bagPeek' ? pending : stats.deliveries }, opts.vars); // {n} in the line
            var text = opts.text !== undefined ? opts.text : (r.quiet && !opts.text ? '' : line('reactions.' + name, vars));
            if (settings.chattiness === 0) text = '';
            var duration = opts.duration || r.duration || (text ? bubbleDuration(text) : 3200);
            reaction = name;
            stats.reactions += 1;
            if (name === 'delivered') stats.deliveries += 1;
            if (name === 'poke') stats.pokes += 1;
            if (name === 'coffee') stats.coffees += 1;
            var cls = reactionClasses(name);
            if (state !== 'asleep') for (var i = 0; i < STATES.length; i++) root.classList.remove('is-' + STATES[i]); // asleep, he keeps sleeping underneath
            void root.offsetWidth; // restart the motion's animation
            for (var j = 0; j < cls.length; j++) root.classList.add(cls[j]);
            if (r.gaze) lookAtSvg(r.gaze[0], r.gaze[1], duration);
            if (text) say(text, { duration: duration, now: true, inSleep: r.inSleep }); else hideBubble();
            timers.reaction = setTimeout(clearReaction, duration);
            emit('react', { reaction: name, text: text, duration: duration });
            if (name === 'delivered' && [10, 25, 50, 100, 250].indexOf(stats.deliveries) >= 0) {
                var n = stats.deliveries;
                setTimeout(function () { react('milestone', { vars: { n: n } }); emit('milestone', { deliveries: n }); }, duration + 400);
            }
            return api;
        }

        // --- his small life ------------------------------------------------------
        function once(key) {
            var today = dayKey(new Date());
            var k = today + ':' + key;
            if (onceToday[k]) return false;
            Object.keys(onceToday).forEach(function (x) { if (x.indexOf(today + ':') !== 0) delete onceToday[x]; }); // yesterday's are done
            onceToday[k] = true;
            try { localStorage.setItem('herbert-once', JSON.stringify(onceToday)); } catch (e) { /* no storage, no matter */ }
            return true;
        }
        function calm() {
            return enabled && !reaction && !talking() && !root.classList.contains('is-hovered') &&
                (state === 'idle' || state === 'content' || state === 'curious');
        }
        function liveALittle() {
            if (!calm() || !maySpeakUp()) return;
            var total = LIFE.reduce(function (s, e) { return s + e[1]; }, 0);
            var pick = Math.random() * total, chosen = LIFE[0][0];
            for (var i = 0; i < LIFE.length; i++) { pick -= LIFE[i][1]; if (pick <= 0) { chosen = LIFE[i][0]; break; } }
            if (chosen === 'earTwitch') pulse('did-eartwitch', 500);
            else if (chosen === 'tailFlick') pulse('did-tailflick', 700);
            else react(chosen);
        }
        function scheduleLife() {
            clearTimeout(timers.life);
            var every = settings.lifeEvery / (settings.chattiness === 2 ? 2 : 1);
            timers.life = setTimeout(function () { liveALittle(); scheduleLife(); }, every * between(0.6, 1.4));
        }

        // Once a minute: the hour, meals, the evening, the weekend, the season, the night.
        function everyMinute() {
            var now = new Date();
            var h = now.getHours(), m = now.getMinutes(), wd = now.getDay();
            var night = h >= 21 || h < 6;
            root.classList.toggle('is-night', night);
            applySeason(now);
            if (!calm() || !maySpeakUp()) return;
            if (m === 0 && once('hour-' + h)) { react('stretch'); return; }
            if (h === 12 && m >= 15 && once('lunch')) { react('lunch'); return; }
            if (h === 18 && once('evening')) { react('evening'); return; }
            if ((wd === 0 || wd === 6) && h >= 9 && once('weekend')) { react('weekend'); return; }
            if (night && Math.random() < 0.08 && once('wish-' + h + '-' + Math.floor(m / 20))) { react('wish'); return; }
            if (now.getTime() - lastActivity > settings.drowsyAfter && !root.classList.contains('is-drowsy') && state === 'idle') {
                root.classList.add('is-drowsy');
            }
        }
        var SEASONS = ['christmas', 'newyear', 'halloween', 'valentine', 'birthday', 'userbirthday', 'winter', 'summer'];
        function seasonFor(now) {
            var mo = now.getMonth() + 1, d = now.getDate(), h = now.getHours();
            var md = (mo < 10 ? '0' : '') + mo + '-' + (d < 10 ? '0' : '') + d;
            var list = [];
            if (mo === 12 && d >= 6) list.push('christmas');
            if (mo === 1 && d === 1) list.push('newyear');
            if (mo === 10 && d >= 25) list.push('halloween');
            if (md === '02-14') list.push('valentine');
            if (md === settings.birthday) list.push('birthday');
            if (settings.userBirthday && md === settings.userBirthday) list.push('userbirthday');
            if (mo === 12 || mo === 1 || mo === 2) list.push('winter');
            if ((mo === 7 || mo === 8) && h >= 12 && h < 17) list.push('summer');
            return list;
        }
        function applySeason(now) {
            var list = settings.season === 'auto' ? seasonFor(now) : settings.season === 'none' ? [] : [settings.season];
            SEASONS.forEach(function (s) { root.classList.toggle('season-' + s, list.indexOf(s) >= 0); });
            if (settings.season !== 'auto' || !maySpeakUp()) return;
            if (list.indexOf('birthday') >= 0 && once('birthday')) react('birthday');
            else if (list.indexOf('userbirthday') >= 0 && once('userbirthday')) react('userBirthday');
            else {
                var s = ['christmas', 'newyear', 'halloween', 'valentine'].filter(function (x) { return list.indexOf(x) >= 0; })[0];
                if (s && once('season-' + s)) say(fill((texts.reactions.season || {})[s] || ''));
            }
        }

        // --- the bridge's numbers ------------------------------------------------
        function setPending(n) {
            pending = Math.max(0, n | 0);
            badge.textContent = pending > 99 ? '99' : String(pending);
            root.classList.toggle('has-pending', pending > 0);
            return api;
        }
        function setBusy(on) { root.classList.toggle('is-busy', !!on); return api; }
        function setEnabled(on) {
            enabled = !!on;
            root.classList.toggle('is-hidden', !enabled);
            if (!enabled) { hush(); clearReaction(); }
            else pulse('did-change', 600);
            emit('enabled', { enabled: enabled });
            return api;
        }
        function setSize(size) { root.classList.toggle('is-compact', size === 'compact'); return api; }
        function setChattiness(level) { settings.chattiness = clamp(level | 0, 0, 2); return api; }
        function setQuietHours(range) { settings.quietHours = range || null; return api; }
        function setUserName(name) { settings.userName = name || ''; return api; }
        function setSeason(season) { settings.season = season || 'auto'; applySeason(new Date()); return api; }

        // --- listeners -----------------------------------------------------------
        var raf = 0;
        var moves = [];       // recent pointer directions over him, for dizziness
        var hoverSince = 0;
        var typed = '';
        var typingBurst = 0;
        var lastTypingCheer = 0;
        var lastDizzy = 0;

        function activity() {
            var now = Date.now();
            if (now - lastActivity > settings.awayAfter && calm() && maySpeakUp()) react('welcomeBack');
            lastActivity = now;
            if (root.classList.contains('is-drowsy')) { root.classList.remove('is-drowsy'); pulse('did-notice', 900); }
        }
        function onPointerMove(e) {
            pointer = { x: e.clientX, y: e.clientY, at: Date.now() };
            activity();
            if (!raf) raf = requestAnimationFrame(function () { raf = 0; refreshGaze(); });
            if (root.contains(e.target) && !bubble.contains(e.target)) {
                // swirling the pointer over him makes him dizzy
                var now = Date.now();
                moves.push({ x: e.clientX, at: now });
                moves = moves.filter(function (m) { return now - m.at < 1500; });
                var turns = 0;
                for (var i = 2; i < moves.length; i++) {
                    if ((moves[i].x - moves[i - 1].x) * (moves[i - 1].x - moves[i - 2].x) < 0) turns += 1;
                }
                if (turns >= 10 && now - lastDizzy > 20000 && state !== 'asleep' && (!reaction || reaction === 'poke')) { lastDizzy = now; moves = []; react('dizzy'); }
            }
        }
        function onPointerLeave() { pointer = null; refreshGaze(); }
        function onPointerDown(e) {
            activity();
            if (bubble.contains(e.target)) { hush(); return; }
            if (root.contains(e.target)) {
                if (!enabled) return;
                // press and hold is petting; a short press is a touch on a part of him
                clearTimeout(timers.hold);
                var part = (e.target.closest && e.target.closest('.part')) ? e.target.closest('.part').getAttribute('data-part') : 'face';
                timers.hold = setTimeout(function () { timers.hold = null; if (state !== 'asleep') react('pet'); }, 500);
                root.setAttribute('data-press', part);
                return;
            }
            dismissBubble(); // clicking around in the window: what he said goes
            if (state === 'asleep') return;
            lookAt(e.clientX, e.clientY, 2600);
            pulse('did-notice', 900);
        }
        function onPointerUp(e) {
            if (!root.hasAttribute('data-press')) return;
            var part = root.getAttribute('data-press');
            root.removeAttribute('data-press');
            if (timers.hold) {
                clearTimeout(timers.hold);
                timers.hold = null;
                touch(part);
            } else if (reaction === 'pet') {
                clearReaction();
            }
        }
        // A short touch on a part of him.
        function touch(part) {
            if (state === 'asleep') {
                // The internet is gone, so he cannot tell you how amazing you are. Unless you poke him.
                if (Math.random() < 0.5) react('sleepyLove');
                else react('sleepyLove', { text: 'Mmh… ' + line('encouragements') + ' …zzz.' });
                return;
            }
            if (part === 'nose') react('boop');
            else if (part === 'ear') react('earTickle');
            else if (part === 'horn') react('hornTap');
            else if (part === 'bag') react('bagPeek', { vars: { n: pending } });
            else if (part === 'tail') react('tailPull');
            else if (part === 'belly') react('belly');
            else react('poke');
        }
        function onDoubleClick(e) {
            if (root.contains(e.target) && !bubble.contains(e.target) && state !== 'asleep' && enabled) react('dance');
        }
        function onPointerEnter() {
            if (!enabled) return;
            root.classList.add('is-hovered');
            hoverSince = Date.now();
            scheduleBlink();
            clearTimeout(timers.shy);
            timers.shy = setTimeout(function () {
                if (root.classList.contains('is-hovered') && calm() && state !== 'asleep') react('shy');
            }, 5000);
        }
        function onPointerOut(e) {
            if (e.relatedTarget && root.contains(e.relatedTarget)) return;
            root.classList.remove('is-hovered');
            clearTimeout(timers.shy);
            scheduleBlink();
        }
        function onBubbleEnter() { bubbleHeld = true; }
        function onBubbleLeave() { bubbleHeld = false; }
        function onKeyDown(e) {
            activity();
            if (e.target === root && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); touch('face'); return; }
            if (e.key.length !== 1) return;
            // he watches you type, and cheers a long burst
            if (state !== 'asleep' && !reaction) lookAtSvg(100, 230, 1200);
            typingBurst += 1;
            clearTimeout(timers.typing);
            timers.typing = setTimeout(function () { typingBurst = 0; }, 1500);
            if (typingBurst >= 40 && Date.now() - lastTypingCheer > 5 * 60 * 1000 && calm() && maySpeakUp()) {
                lastTypingCheer = Date.now();
                typingBurst = 0;
                react('typing');
            }
            // the secret word
            typed = (typed + e.key.toLowerCase()).slice(-7);
            if (typed === 'herbert' && enabled) { typed = ''; if (state === 'asleep') setState('idle', { quiet: true }); react('party'); }
        }
        function onVisibility() { if (document.visibilityState === 'visible') activity(); }

        document.addEventListener('pointermove', onPointerMove);
        document.addEventListener('pointerleave', onPointerLeave);
        document.addEventListener('pointerdown', onPointerDown, true);
        document.addEventListener('pointerup', onPointerUp, true);
        document.addEventListener('dblclick', onDoubleClick, true);
        document.addEventListener('keydown', onKeyDown);
        document.addEventListener('visibilitychange', onVisibility);
        root.addEventListener('pointerenter', onPointerEnter);
        root.addEventListener('pointerout', onPointerOut);
        bubble.addEventListener('pointerenter', onBubbleEnter);
        bubble.addEventListener('pointerleave', onBubbleLeave);
        returnButton.addEventListener('click', function (e) { e.stopPropagation(); setEnabled(true); });

        function destroy() {
            destroyed = true;
            document.removeEventListener('pointermove', onPointerMove);
            document.removeEventListener('pointerleave', onPointerLeave);
            document.removeEventListener('pointerdown', onPointerDown, true);
            document.removeEventListener('pointerup', onPointerUp, true);
            document.removeEventListener('dblclick', onDoubleClick, true);
            document.removeEventListener('keydown', onKeyDown);
            document.removeEventListener('visibilitychange', onVisibility);
            Object.keys(timers).forEach(function (k) {
                if (k === 'pulse') Object.keys(timers.pulse).forEach(function (c) { clearTimeout(timers.pulse[c]); });
                else { clearTimeout(timers[k]); clearInterval(timers[k]); }
            });
            if (root.parentNode) root.parentNode.removeChild(root);
        }

        // --- go ------------------------------------------------------------------
        scheduleBlink();
        scheduleWander();
        scheduleLife();
        scheduleEncouragement(settings.encourageEvery);
        timers.minute = setInterval(everyMinute, 60000);
        root.classList.toggle('is-night', new Date().getHours() >= 21 || new Date().getHours() < 6);
        applySeason(new Date());
        if (options.greet !== false) setTimeout(function () { if (!destroyed) greet(); }, options.greetDelay || 900);

        var api = {
            element: root,
            texts: texts,
            settings: settings,
            stats: stats,
            states: STATES.slice(),
            reactions: Object.keys(REACTIONS),
            seasons: ['auto', 'none'].concat(SEASONS),
            setState: setState,
            getState: getState,
            say: say,
            think: think,
            hush: hush,
            lookAt: lookAt,
            greet: greet,
            encourage: encourage,
            react: react,
            touch: touch,
            setPending: setPending,
            setBusy: setBusy,
            setEnabled: setEnabled,
            setSize: setSize,
            setChattiness: setChattiness,
            setQuietHours: setQuietHours,
            setUserName: setUserName,
            setSeason: setSeason,
            liveALittle: liveALittle,
            on: on,
            off: off,
            destroy: destroy,
        };
        return api;
    }

    createHerbert.REACTIONS = REACTIONS;
    createHerbert.STATES = STATES;
    global.createHerbert = createHerbert;
    if (typeof module !== 'undefined' && module.exports) module.exports = createHerbert; // for the offline tests
})(typeof window !== 'undefined' ? window : globalThis);
