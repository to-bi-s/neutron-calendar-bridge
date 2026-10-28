/*
 * Herbert the unicorn — standalone frame (prototype, not yet in the app).
 *
 * createHerbert(container, options) draws him into `container` and returns the
 * API the app will call later:
 *   herbert.setState('idle' | 'curious' | 'talking' | 'asleep' | 'worried' | 'content', { quiet, text })
 *   herbert.say(text, { duration })      speech bubble; hides itself
 *   herbert.lookAt(x, y, holdMs)         page coordinates; he glances there, then goes back to the pointer
 *   herbert.greet()                      time-of-day greeting
 *   herbert.encourage()                  one line from the encouragement list, with sparkles
 *   herbert.hush()                       hide the bubble
 *   herbert.on('state' | 'say', fn)      events for the demo log
 *   herbert.destroy()
 *
 * Everything that moves is CSS (herbert.css); this file only flips classes,
 * sets a few custom properties for the gaze, and runs the timers (blink, idle
 * glances, the greeting, the occasional encouragement).
 * Texts come from herbert-texts.js (window.HERBERT_TEXTS).
 */
(function (global) {
    'use strict';

    var STATES = ['idle', 'curious', 'talking', 'asleep', 'worried', 'content'];

    // viewBox 0 0 200 170. Eyes sit at y≈68 — look() uses that for the gaze origin.
    // Plush style (chosen from three candidates in styles.html): front view, a horse's
    // head — tall skull, muzzle at the bottom, eyes high and wide apart, tall ears —
    // a big horn, a mane to the shoulders, a small round body with the courier bag.
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

        '<ellipse class="ground" cx="100" cy="163" rx="46" ry="5"/>' +

        '<g class="rainbow">' +
        '<path d="M34 150 A66 66 0 0 1 166 150" stroke="#ff8fab"/>' +
        '<path d="M40 150 A60 60 0 0 1 160 150" stroke="#ffd166"/>' +
        '<path d="M46 150 A54 54 0 0 1 154 150" stroke="#8ad1ff"/>' +
        '<path d="M52 150 A48 48 0 0 1 148 150" stroke="#c9a8ff"/>' +
        '</g>' +

        '<g class="pose"><g class="jitter">' +

        '<path class="tail" d="M134 128 C156 118 166 138 152 148 C162 156 150 168 136 160 C146 152 142 140 130 138 Z"/>' +

        '<path class="body" d="M100 112 C128 112 138 130 136 146 C134 160 118 162 100 162 C82 162 66 160 64 146 C62 130 72 112 100 112 Z"/>' +
        '<path class="strap" d="M78 122 Q100 140 124 150"/>' +

        '<rect class="leg" x="80" y="138" width="13" height="22" rx="6"/>' +
        '<rect class="leg" x="107" y="138" width="13" height="22" rx="6"/>' +
        '<rect class="hoof" x="80" y="153" width="13" height="8" rx="4"/>' +
        '<rect class="hoof" x="107" y="153" width="13" height="8" rx="4"/>' +

        '<g class="bag">' +
        '<rect x="116" y="136" width="20" height="15" rx="4"/>' +
        '<rect class="bag-flap" x="116" y="136" width="20" height="6" rx="3"/>' +
        '<rect class="envelope" x="121" y="143" width="10" height="6.5" rx="1"/>' +
        '<path class="envelope-fold" d="M121 143 l5 4 l5 -4"/>' +
        '</g>' +

        '<g class="head">' +
        '<path class="mane mane-back" d="M62 70 C56 34 92 18 118 24 C140 30 150 58 142 86 C136 70 128 60 118 56 L70 60 Z"/>' +
        '<path class="mane mane-neck" d="M130 60 C150 66 152 96 140 118 C138 100 132 86 124 78 Z"/>' +
        '<path class="mane mane-neck" d="M70 62 C50 70 48 100 60 118 C62 100 66 88 76 80 Z"/>' +

        '<g class="ear ear-left"><path class="ear-outer" d="M72 48 C62 32 64 14 72 12 C80 12 86 32 84 50 Z"/><path class="ear-inner" d="M74 44 C68 32 70 20 73 19 C77 20 81 34 80 46 Z"/></g>' +
        '<g class="ear ear-right"><path class="ear-outer" d="M128 48 C138 32 136 14 128 12 C120 12 114 32 116 50 Z"/><path class="ear-inner" d="M126 44 C132 32 130 20 127 19 C123 20 119 34 120 46 Z"/></g>' +

        '<g class="horn"><path class="horn-cone" d="M91 40 L109 40 L100 2 Z"/>' +
        '<path class="horn-stripe" d="M94 32 L107 29"/><path class="horn-stripe" d="M95.5 24 L105.5 21.5"/><path class="horn-stripe" d="M97.5 15 L103.5 13.5"/>' +
        '<g transform="translate(113 8)"><path class="horn-sparkle" d="M0 -5 L1.3 -1.3 L5 0 L1.3 1.3 L0 5 L-1.3 1.3 L-5 0 L-1.3 -1.3 Z"/></g></g>' +

        '<path class="face" d="M68 64 C68 38 132 38 132 64 C132 86 124 110 100 114 C76 110 68 86 68 64 Z"/>' +

        '<path class="snout" d="M82 92 C82 82 118 82 118 92 C118 104 108 110 100 110 C92 110 82 104 82 92 Z"/>' +
        '<ellipse class="nostril" cx="92" cy="98" rx="2.4" ry="1.6" transform="rotate(-20 92 98)"/><ellipse class="nostril" cx="108" cy="98" rx="2.4" ry="1.6" transform="rotate(20 108 98)"/>' +
        '<ellipse class="cheek" cx="75" cy="84" rx="6.5" ry="4"/><ellipse class="cheek" cx="125" cy="84" rx="6.5" ry="4"/>' +

        '<path class="mane mane-front" d="M80 46 C84 30 104 26 116 36 C106 36 100 42 102 50 C96 46 90 46 86 48 C84 45 82 47 80 46 Z"/>' +

        '<path class="brow brow-left" d="M77 57 Q84 52 91 56"/>' +
        '<path class="brow brow-right" d="M123 57 Q116 52 109 56"/>' +

        '<g class="eye eye-left" transform="translate(84 68)">' +
        '<circle class="eye-white" r="8.5"/>' +
        '<g class="pupil"><g class="pupil-core"><circle class="iris" r="5.6"/><circle class="glint" cx="-2.1" cy="-2.1" r="2.1"/><circle class="glint" cx="2.2" cy="2.6" r="0.9"/></g></g>' +
        '<g clip-path="url(#hb-eye)"><circle class="lid" r="10"/></g>' +
        '<path class="eye-happy" d="M-8 1.5 Q0 -8.5 8 1.5"/>' +
        '<path class="eye-sleep" d="M-8 -1 Q0 7.5 8 -1"/>' +
        '</g>' +
        '<g class="eye eye-right" transform="translate(116 68)">' +
        '<circle class="eye-white" r="8.5"/>' +
        '<g class="pupil"><g class="pupil-core"><circle class="iris" r="5.6"/><circle class="glint" cx="-2.1" cy="-2.1" r="2.1"/><circle class="glint" cx="2.2" cy="2.6" r="0.9"/></g></g>' +
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
        '</g>' + // head

        '</g></g>' + // jitter, pose

        '<g class="zzz"><text x="146" y="56">z</text><text x="156" y="42">z</text><text x="168" y="26">z</text></g>' +

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

    function createHerbert(container, options) {
        options = options || {};
        var texts = options.texts || global.HERBERT_TEXTS || {};

        var root = document.createElement('div');
        root.className = 'herbert is-idle';
        root.innerHTML =
            '<div class="herbert-bubble" role="status" aria-live="polite"><span class="herbert-bubble-text"></span></div>' +
            '<div class="herbert-stage">' + SVG + '</div>';
        container.appendChild(root);

        var svg = root.querySelector('svg');
        var bubble = root.querySelector('.herbert-bubble');
        var bubbleText = root.querySelector('.herbert-bubble-text');
        var head = svg.querySelector('.head');
        var pupils = svg.querySelectorAll('.pupil');
        var lids = svg.querySelectorAll('.lid');

        var state = 'idle';
        var listeners = {};
        var gaze = null;      // { x, y, until } — a point he was told to look at
        var pointer = null;   // { x, y, at } — where the pointer last was
        var lastEncouragement = null;
        var timers = { bubble: null, blink: null, wander: null, gaze: null, encourage: null, pulse: {} };
        var destroyed = false;

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

        // --- gaze ----------------------------------------------------------------
        function eyeCenter() {
            var r = svg.getBoundingClientRect();
            return { x: r.left + r.width * 0.5, y: r.top + r.height * (68 / 170) };
        }

        // Point the pupils and tilt the head toward a page coordinate (or straight ahead).
        function look(target) {
            var nx = 0, ny = 0;
            if (target) {
                var c = eyeCenter();
                nx = clamp((target.x - c.x) / 240, -1, 1);
                ny = clamp((target.y - c.y) / 180, -1, 1);
            }
            var eager = state === 'curious' ? 1.2 : state === 'worried' ? 0.6 : 1;
            var px = (nx * 3.2 * eager).toFixed(2), py = (ny * 2.6 * eager).toFixed(2);
            for (var i = 0; i < pupils.length; i++) pupils[i].style.transform = 'translate(' + px + 'px,' + py + 'px)';
            head.style.setProperty('--hx', (nx * 2.6).toFixed(2) + 'px');
            head.style.setProperty('--hy', (ny * 1.6).toFixed(2) + 'px');
            head.style.setProperty('--hr', (nx * 4).toFixed(2) + 'deg');
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

        // Every few seconds, when nothing else is going on, a small glance somewhere.
        function scheduleWander() {
            clearTimeout(timers.wander);
            timers.wander = setTimeout(function () {
                var idlePointer = !pointer || Date.now() - pointer.at > 4000;
                if (state !== 'asleep' && !gaze && idlePointer) {
                    var c = eyeCenter();
                    lookAt(c.x + between(-220, 220), c.y + between(-120, 160), between(900, 1800));
                }
                scheduleWander();
            }, between(3500, 8000));
        }

        // --- blinking ------------------------------------------------------------
        function blink() {
            if (state === 'asleep' || state === 'content') return;
            for (var i = 0; i < lids.length; i++) {
                lids[i].classList.remove('blink');
                void lids[i].getBBox();
                lids[i].classList.add('blink');
            }
            setTimeout(function () { for (var i = 0; i < lids.length; i++) lids[i].classList.remove('blink'); }, 260);
        }
        function scheduleBlink() {
            clearTimeout(timers.blink);
            timers.blink = setTimeout(function () {
                blink();
                if (Math.random() < 0.2) setTimeout(blink, 280); // a double blink now and then
                scheduleBlink();
            }, between(1800, 5200));
        }

        // --- speech --------------------------------------------------------------
        function hush() {
            clearTimeout(timers.bubble);
            bubble.classList.remove('is-visible');
            root.classList.remove('is-speaking', 'is-sparkling');
            return api;
        }
        function say(text, opts) {
            opts = opts || {};
            if (!text) return hush();
            if (state === 'asleep') return api; // he sleeps; the app wakes him with setState first
            clearTimeout(timers.bubble);
            bubbleText.textContent = text;
            bubble.classList.add('is-visible');
            root.classList.add('is-speaking');
            var duration = opts.duration || clamp(2600 + text.length * 60, 3000, 10000);
            timers.bubble = setTimeout(hush, duration);
            emit('say', { text: text, duration: duration });
            return api;
        }

        // --- states --------------------------------------------------------------
        function setStateClass(name) {
            for (var i = 0; i < STATES.length; i++) root.classList.toggle('is-' + STATES[i], STATES[i] === name);
        }
        function setState(name, opts) {
            opts = opts || {};
            if (STATES.indexOf(name) < 0) throw new Error('Herbert does not know the state "' + name + '"');
            var previous = state;
            state = name;
            setStateClass(name);
            root.classList.remove('is-sparkling');
            if (name === 'asleep') { hush(); gaze = null; }
            else if (name !== previous) pulse('did-change', 600);
            if (!opts.quiet) {
                if (opts.text) say(opts.text);
                else if (name === 'worried') say(texts.worried);
                else if (name === 'content') say(texts.content);
            }
            refreshGaze();
            emit('state', { state: name, previous: previous });
            return api;
        }
        function getState() { return state; }

        function greetingFor(hour) {
            if (hour >= 5 && hour < 11) return texts.greetingMorning;
            if (hour >= 11 && hour < 17) return texts.greetingAfternoon;
            if (hour >= 17 && hour < 22) return texts.greetingEvening;
            return texts.greetingNight;
        }
        function greet(hour) {
            if (state === 'asleep') return api;
            var h = typeof hour === 'number' ? hour : new Date().getHours();
            pulse('did-notice', 900);
            return say(greetingFor(h));
        }

        function encourage() {
            var list = texts.encouragements || [];
            if (!list.length || state === 'asleep') return api;
            var choices = list.filter(function (t) { return t !== lastEncouragement; });
            var text = choices[Math.floor(Math.random() * choices.length)];
            lastEncouragement = text;
            say(text);
            root.classList.add('is-sparkling');
            return api;
        }
        // Unobtrusive: only when he is idle, calm or content, nothing else is being
        // said, and the window is visible. Otherwise try again a minute later.
        function scheduleEncouragement(ms) {
            clearTimeout(timers.encourage);
            timers.encourage = setTimeout(function () {
                var calm = state === 'idle' || state === 'content' || state === 'curious';
                var quiet = !bubble.classList.contains('is-visible');
                if (calm && quiet && document.visibilityState === 'visible') {
                    encourage();
                    scheduleEncouragement(options.encourageEvery);
                } else {
                    scheduleEncouragement(60000);
                }
            }, ms);
        }

        // --- listeners -----------------------------------------------------------
        var raf = 0;
        function onPointerMove(e) {
            pointer = { x: e.clientX, y: e.clientY, at: Date.now() };
            if (!raf) raf = requestAnimationFrame(function () { raf = 0; refreshGaze(); });
        }
        function onPointerLeave() { pointer = null; refreshGaze(); }
        function onPointerDown(e) {
            if (state === 'asleep') return;
            lookAt(e.clientX, e.clientY, 2600);
            pulse('did-notice', 900);
        }
        document.addEventListener('pointermove', onPointerMove);
        document.addEventListener('pointerleave', onPointerLeave);
        document.addEventListener('pointerdown', onPointerDown, true);

        function destroy() {
            destroyed = true;
            document.removeEventListener('pointermove', onPointerMove);
            document.removeEventListener('pointerleave', onPointerLeave);
            document.removeEventListener('pointerdown', onPointerDown, true);
            Object.keys(timers).forEach(function (k) {
                if (k === 'pulse') Object.keys(timers.pulse).forEach(function (c) { clearTimeout(timers.pulse[c]); });
                else clearTimeout(timers[k]);
            });
            if (root.parentNode) root.parentNode.removeChild(root);
        }

        // --- go ------------------------------------------------------------------
        options.encourageEvery = options.encourageEvery || 20 * 60 * 1000;
        scheduleBlink();
        scheduleWander();
        scheduleEncouragement(options.encourageEvery);
        if (options.greet !== false) setTimeout(function () { if (!destroyed) greet(); }, options.greetDelay || 900);

        var api = {
            element: root,
            texts: texts,
            states: STATES.slice(),
            setState: setState,
            getState: getState,
            say: say,
            hush: hush,
            lookAt: lookAt,
            greet: greet,
            encourage: encourage,
            on: on,
            off: off,
            destroy: destroy,
        };
        return api;
    }

    global.createHerbert = createHerbert;
})(window);
