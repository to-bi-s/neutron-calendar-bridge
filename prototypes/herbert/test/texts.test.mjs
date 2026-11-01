/**
 * Herbert's texts, checked offline: every reaction has lines (or is marked quiet), lines fit
 * the bubble, placeholders are only {name} and {n}, no list repeats a line, nothing looks
 * like an email address, and the key list on disk matches the texts.
 *   node --test prototypes/herbert/test/
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const texts = require(join(here, '..', 'lib', 'herbert-texts.js'));
const createHerbert = require(join(here, '..', 'lib', 'herbert.js'));

const lines = [];
const walk = (value, path) => {
    if (Array.isArray(value)) value.forEach((v, i) => walk(v, `${path}[${i}]`));
    else if (value && typeof value === 'object') Object.entries(value).forEach(([k, v]) => walk(v, `${path}.${k}`));
    else if (typeof value === 'string') lines.push({ path, text: value });
};
walk(texts, 'texts');

test('every reaction has lines unless it is quiet', () => {
    for (const [name, reaction] of Object.entries(createHerbert.REACTIONS)) {
        const value = texts.reactions[name];
        if (reaction.quiet) continue;
        assert.ok(value !== undefined, `no texts for reaction "${name}"`);
        if (Array.isArray(value)) assert.ok(value.length > 0, `empty list for "${name}"`);
    }
});

test('every text key under reactions is a known reaction', () => {
    for (const name of Object.keys(texts.reactions)) {
        if (name === 'season') continue;
        assert.ok(createHerbert.REACTIONS[name], `texts.reactions.${name} has no reaction`);
    }
});

test('lines fit the bubble and use only {name} and {n}', () => {
    for (const { path, text } of lines) {
        assert.ok(text.length <= 90, `${path} is ${text.length} characters: "${text}"`);
        for (const match of text.match(/\{[^}]*\}/g) || []) {
            assert.ok(match === '{name}' || match === '{n}', `${path} uses ${match}`);
        }
        assert.ok(!/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[a-z]{2,}/.test(text), `${path} looks like an address`);
        assert.equal(text, text.trim(), `${path} has stray spaces`);
    }
});

test('no list repeats a line', () => {
    const check = (value, path) => {
        if (Array.isArray(value)) assert.equal(new Set(value).size, value.length, `${path} repeats a line`);
        else if (value && typeof value === 'object') Object.entries(value).forEach(([k, v]) => check(v, `${path}.${k}`));
    };
    check(texts, 'texts');
});

test('the greetings have eleven lines each and the encouragements twenty-five', () => {
    for (const key of ['greetingMorning', 'greetingAfternoon', 'greetingEvening', 'greetingNight']) {
        assert.equal(texts[key].length, 11, key);
    }
    assert.equal(texts.encouragements.length, 25);
});

test('locales/herbert-keys.json matches the texts', () => {
    const onDisk = JSON.parse(readFileSync(join(here, '..', 'locales', 'herbert-keys.json'), 'utf8'));
    const expected = [...new Set(lines.map((l) => l.text.replace(/\s+/g, ' ').trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'en'));
    assert.deepEqual(onDisk, expected, 'run node prototypes/herbert/scripts/herbert-keys.mjs');
});
