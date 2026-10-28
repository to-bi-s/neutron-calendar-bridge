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

    // viewBox 0 0 200 170. Eyes sit at y≈66 — look() uses that for the gaze origin.
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
        '<clipPath id="hb-eye"><circle r="8"/></clipPath>' +
        '</defs>' +

        '<ellipse class="ground" cx="100" cy="161" rx="46" ry="5"/>' +

        '<g class="rainbow">' +
        '<path d="M36 130 A64 64 0 0 1 164 130" stroke="#ff8fab"/>' +
        '<path d="M42 130 A58 58 0 0 1 158 130" stroke="#ffd166"/>' +
        '<path d="M48 130 A52 52 0 0 1 152 130" stroke="#8ad1ff"/>' +
        '<path d="M54 130 A46 46 0 0 1 146 130" stroke="#c9a8ff"/>' +
        '</g>' +

        '<g class="pose"><g class="jitter">' +

        '<path class="tail" d="M130 116 C154 102 166 124 152 134 C162 142 150 158 134 148 C146 140 140 128 128 128 Z"/>' +

        '<path class="body" d="M100 94 C132 94 140 118 138 140 C136 158 118 160 100 160 C82 160 64 158 62 140 C60 118 68 94 100 94 Z"/>' +
        '<path class="strap" d="M76 106 Q98 130 124 142"/>' +

        '<rect class="leg" x="82" y="126" width="13" height="30" rx="6"/>' +
        '<rect class="leg" x="105" y="126" width="13" height="30" rx="6"/>' +
        '<rect class="hoof" x="82" y="149" width="13" height="8" rx="4"/>' +
        '<rect class="hoof" x="105" y="149" width="13" height="8" rx="4"/>' +

        '<g class="bag">' +
        '<rect x="114" y="128" width="22" height="16" rx="4"/>' +
        '<rect class="bag-flap" x="114" y="128" width="22" height="6" rx="3"/>' +
        '<rect class="envelope" x="119" y="136" width="12" height="7.5" rx="1"/>' +
        '<path class="envelope-fold" d="M119 136 l6 4.5 l6 -4.5"/>' +
        '</g>' +

        '<g class="head">' +
        '<path class="mane mane-back" d="M66 62 C58 30 92 16 114 24 C134 31 142 58 130 72 Z"/>' +
        '<path class="mane mane-neck" d="M126 60 C142 66 144 90 134 104 C131 88 126 76 118 70 Z"/>' +

        '<g class="ear ear-left"><path class="ear-outer" d="M80 54 C68 38 74 24 84 28 C93 32 93 45 91 54 Z"/><path class="ear-inner" d="M82 50 C76 40 78 32 84 33 C88 35 88 44 87 50 Z"/></g>' +
        '<g class="ear ear-right"><path class="ear-outer" d="M120 54 C132 38 126 24 116 28 C107 32 107 45 109 54 Z"/><path class="ear-inner" d="M118 50 C124 40 122 32 116 33 C112 35 112 44 113 50 Z"/></g>' +

        '<g class="horn"><path class="horn-cone" d="M93 44 L107 44 L101 6 Z"/>' +
        '<path class="horn-stripe" d="M95 36 L106 33"/><path class="horn-stripe" d="M96.5 28 L104.5 26"/><path class="horn-stripe" d="M98.5 20 L103 18.5"/>' +
        '<g transform="translate(110 12)"><path class="horn-sparkle" d="M0 -5 L1.3 -1.3 L5 0 L1.3 1.3 L0 5 L-1.3 1.3 L-5 0 L-1.3 -1.3 Z"/></g></g>' +

        '<circle class="face" cx="100" cy="70" r="32"/>' +
        '<path class="mane mane-front" d="M84 44 C82 30 98 22 110 30 C102 32 97 40 101 50 C95 46 89 48 84 44 Z"/>' +

        '<ellipse class="snout" cx="100" cy="88" rx="16" ry="11"/>' +
        '<circle class="nostril" cx="94" cy="90" r="1.6"/><circle class="nostril" cx="106" cy="90" r="1.6"/>' +
        '<ellipse class="cheek" cx="74" cy="82" rx="6.5" ry="4"/><ellipse class="cheek" cx="126" cy="82" rx="6.5" ry="4"/>' +

        '<path class="brow brow-left" d="M79 54 Q86 49 93 53"/>' +
        '<path class="brow brow-right" d="M121 54 Q114 49 107 53"/>' +

        '<g class="eye eye-left" transform="translate(86 66)">' +
        '<circle class="eye-white" r="8"/>' +
        '<g class="pupil"><g class="pupil-core"><circle class="iris" r="5.4"/><circle class="glint" cx="-2" cy="-2" r="2"/><circle class="glint" cx="2" cy="2.4" r="0.9"/></g></g>' +
        '<g clip-path="url(#hb-eye)"><circle class="lid" r="9.5"/></g>' +
        '<path class="eye-happy" d="M-7.5 1.5 Q0 -8 7.5 1.5"/>' +
        '<path class="eye-sleep" d="M-7.5 -1 Q0 7 7.5 -1"/>' +
        '</g>' +
        '<g class="eye eye-right" transform="translate(114 66)">' +
        '<circle class="eye-white" r="8"/>' +
        '<g class="pupil"><g class="pupil-core"><circle class="iris" r="5.4"/><circle class="glint" cx="-2" cy="-2" r="2"/><circle class="glint" cx="2" cy="2.4" r="0.9"/></g></g>' +
        '<g clip-path="url(#hb-eye)"><circle class="lid" r="9.5"/></g>' +
        '<path class="eye-happy" d="M-7.5 1.5 Q0 -8 7.5 1.5"/>' +
        '<path class="eye-sleep" d="M-7.5 -1 Q0 7 7.5 -1"/>' +
        '</g>' +

        '<g class="mouth">' +
        '<path class="mouth-smile" d="M95 97.5 Q100 103 105 97.5"/>' +
        '<ellipse class="mouth-open" cx="100" cy="99.5" rx="3.6" ry="4.6"/>' +
        '<g class="mouth-big"><path d="M92 96.5 Q100 109 108 96.5 Z"/><ellipse class="tongue" cx="100" cy="103.5" rx="3.4" ry="2.2"/></g>' +
        '<path class="mouth-worried" d="M95 100.5 Q97.5 97 100 100 Q102.5 103 105 99"/>' +
        '<ellipse class="mouth-sleep" cx="100" cy="99" rx="1.8" ry="2.2"/>' +
        '</g>' +

        '<path class="sweat" d="M132 50 C127 57 126 62 132 64 C138 62 137 57 132 50 Z"/>' +
        '</g>' + // head

        '</g></g>' + // jitter, pose

        '<g class="zzz"><text x="140" y="56">z</text><text x="150" y="42">z</text><text x="162" y="26">z</text></g>' +

        '<g class="sparkles">' +
        '<g transform="translate(54 48)"><path class="sparkle" d="M0 -6 L1.6 -1.6 L6 0 L1.6 1.6 L0 6 L-1.6 1.6 L-6 0 L-1.6 -1.6 Z"/></g>' +
        '<g transform="translate(152 40)"><path class="sparkle" d="M0 -5 L1.3 -1.3 L5 0 L1.3 1.3 L0 5 L-1.3 1.3 L-5 0 L-1.3 -1.3 Z"/></g>' +
        '<g transform="translate(44 100)"><path class="sparkle" d="M0 -4 L1 -1 L4 0 L1 1 L0 4 L-1 1 L-4 0 L-1 -1 Z"/></g>' +
        '<g transform="translate(160 84)"><path class="sparkle heart" d="M0 3.5 C-7 -3 -2.5 -9 0 -4.5 C2.5 -9 7 -3 0 3.5 Z"/></g>' +
        '<g transform="translate(38 70)"><path class="sparkle heart" d="M0 2.6 C-5 -2.2 -1.8 -6.6 0 -3.3 C1.8 -6.6 5 -2.2 0 2.6 Z"/></g>' +
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
            return { x: r.left + r.width * 0.5, y: r.top + r.height * (66 / 170) };
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
