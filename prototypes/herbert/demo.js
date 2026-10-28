/*
 * Demo page wiring: creates Herbert in the mock panel, hooks the buttons up to
 * his API and mirrors the app's Appearance setting (light / dark / follow system)
 * through <html data-theme>, exactly as the app's renderer does.
 */
(function () {
    'use strict';

    // ---- theme ----------------------------------------------------------------
    var media = window.matchMedia('(prefers-color-scheme: dark)');
    var themeChoice = 'system';
    function applyTheme() {
        var dark = themeChoice === 'dark' || (themeChoice === 'system' && media.matches);
        document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
        document.querySelectorAll('[data-theme-choice]').forEach(function (b) {
            b.classList.toggle('is-on', b.getAttribute('data-theme-choice') === themeChoice);
        });
    }
    media.addEventListener('change', applyTheme);
    document.querySelectorAll('[data-theme-choice]').forEach(function (b) {
        b.addEventListener('click', function () { themeChoice = b.getAttribute('data-theme-choice'); applyTheme(); });
    });
    applyTheme();

    // ---- Herbert --------------------------------------------------------------
    // Two minutes between encouragements here so they can be seen; the app will
    // use something far rarer (the API default is 20 minutes).
    var herbert = window.createHerbert(document.getElementById('herbert-home'), { encourageEvery: 2 * 60 * 1000 });
    window.herbert = herbert; // for the browser console

    // ---- log ------------------------------------------------------------------
    var log = document.getElementById('log');
    function note(text) {
        var li = document.createElement('li');
        var t = document.createElement('time');
        t.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        li.appendChild(t);
        li.appendChild(document.createTextNode(text));
        log.insertBefore(li, log.firstChild);
        while (log.children.length > 6) log.removeChild(log.lastChild);
    }
    herbert.on('state', function (d) { note('setState(\'' + d.state + '\')'); markState(d.state); });
    herbert.on('say', function (d) { note('say(“' + d.text + '”)'); });
    herbert.on('react', function (d) { note('react(\'' + d.reaction + '\')'); });

    function markState(state) {
        document.querySelectorAll('[data-state]').forEach(function (b) {
            b.classList.toggle('is-on', b.getAttribute('data-state') === state);
        });
    }
    markState('idle');

    // ---- buttons --------------------------------------------------------------
    document.querySelectorAll('[data-state]').forEach(function (b) {
        b.addEventListener('click', function () {
            var state = b.getAttribute('data-state');
            if (state === 'talking') herbert.setState('talking', { text: herbert.texts.talkingSample });
            else herbert.setState(state);
        });
    });
    document.querySelectorAll('[data-greet]').forEach(function (b) {
        b.addEventListener('click', function () {
            var when = b.getAttribute('data-greet');
            if (herbert.getState() === 'asleep') herbert.setState('idle', { quiet: true });
            herbert.greet(when === 'now' ? undefined : Number(when));
        });
    });
    document.querySelectorAll('[data-react]').forEach(function (b) {
        b.addEventListener('click', function () { herbert.react(b.getAttribute('data-react')); });
    });
    document.getElementById('encourage').addEventListener('click', function () {
        if (herbert.getState() === 'asleep') herbert.setState('idle', { quiet: true });
        herbert.encourage();
    });
    document.getElementById('hush').addEventListener('click', function () { herbert.hush(); });

    var form = document.getElementById('say-form');
    var input = document.getElementById('say-text');
    form.addEventListener('submit', function (e) {
        e.preventDefault();
        var text = input.value.trim();
        if (!text) return;
        if (herbert.getState() === 'asleep') herbert.setState('idle', { quiet: true });
        herbert.say(text);
        input.select();
    });

    // A short story, to see the states flow into one another.
    document.getElementById('story').addEventListener('click', function () {
        var steps = [
            [0, function () { herbert.setState('idle', { quiet: true }); herbert.greet(); }],
            [3500, function () { herbert.setState('content'); }],
            [8000, function () { herbert.setState('asleep'); }],
            [13000, function () { herbert.setState('worried'); }],
            [19500, function () { herbert.setState('content'); }],
            [24500, function () { herbert.setState('idle', { quiet: true }); herbert.encourage(); }],
        ];
        steps.forEach(function (s) { setTimeout(s[1], s[0]); });
    });
})();
