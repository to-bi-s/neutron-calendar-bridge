/**
 * 0.32: the app's texts in six languages — t()/tn() with the catalogs in src/locales, the fallback
 * to English, the language choice ('system' → macOS's language when it is one of ours), and the
 * catalogs themselves: every key translated, placeholders and inline tags kept, plural forms matched.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { APP_LANGUAGES, catalogFor, interpolate, languageForLocale, pluralForm, resolveLanguage, setLanguage, setLocalesDir, t, tn } from '../src/main/i18n';

const localesDir = join(__dirname, '..', 'src', 'locales');
const keys = JSON.parse(readFileSync(join(localesDir, 'keys.json'), 'utf8')) as Record<string, string[]>;

test('t and tn: English keys, translated when the catalog has them, placeholders filled, plurals by count', () => {
    setLocalesDir(localesDir);
    setLanguage('en');
    assert.equal(t('Bridge connected'), 'Bridge connected');
    assert.equal(t('Hide {app}', { app: 'X' }), 'Hide X');
    assert.equal(tn('{count} event synced', '{count} events synced', 1), '1 event synced');
    assert.equal(tn('{count} event synced', '{count} events synced', 3), '3 events synced');
    assert.equal(tn('once', '{count} times', 1), 'once');
    setLanguage('de');
    assert.equal(t('Bridge connected'), 'Bridge verbunden');
    assert.equal(t('Hide {app}', { app: 'X' }), 'X ausblenden');
    assert.equal(tn('{count} event synced', '{count} events synced', 1), '1 Termin synchronisiert');
    assert.equal(tn('{count} event synced', '{count} events synced', 2), '2 Termine synchronisiert');
    assert.equal(t('not a key'), 'not a key', 'a text without a translation stays English');
    assert.equal(interpolate('{a} and {b} and {c}', { a: 1, b: 'two' }), '1 and two and {c}', 'an unknown placeholder is left as it is');
    setLanguage('xx');
    assert.equal(t('Bridge connected'), 'Bridge connected', 'an unknown language is English');
    setLanguage('en');
});

test("the language choice: 'system' follows macOS when it is one of ours, else English; a code is itself", () => {
    assert.equal(languageForLocale('de-DE'), 'de');
    assert.equal(languageForLocale('nl'), 'nl');
    assert.equal(languageForLocale('en-US'), 'en');
    assert.equal(languageForLocale('pt-BR'), 'en');
    assert.equal(languageForLocale(null), 'en');
    assert.equal(resolveLanguage('system', 'fr-FR'), 'fr');
    assert.equal(resolveLanguage(null, 'it'), 'it');
    assert.equal(resolveLanguage('es', 'de-DE'), 'es');
    assert.equal(resolveLanguage('klingon', 'de-DE'), 'en');
    assert.equal(pluralForm('en', 1, 2), 0);
    assert.equal(pluralForm('en', 0, 2), 1);
    assert.equal(pluralForm('fr', 0, 2), 0, 'French: 0 is singular');
    assert.equal(pluralForm('de', 5, 2), 1);
});

test('the catalogs: complete, placeholders and tags kept, plural forms matched, no entities in plain texts', () => {
    const placeholders = (text: string) => (text.match(/\{\w+\}/g) || []).sort().join(' ');
    const tags = (text: string) => (text.match(/<\/?[a-z]+\b/g) || []).sort().join(' ');
    for (const language of APP_LANGUAGES) {
        if (language.code === 'en') {
            assert.deepEqual(catalogFor('en'), {}, 'English needs no catalog');
            continue;
        }
        const file = join(localesDir, `${language.code}.json`);
        assert.ok(existsSync(file), `${language.code}.json exists`);
        const catalog = catalogFor(language.code);
        const missing = Object.keys(keys).filter((key) => !catalog[key]);
        assert.deepEqual(missing, [], `${language.code}: every key translated`);
        for (const [key, value] of Object.entries(catalog)) {
            assert.equal(placeholders(value), placeholders(key), `${language.code}: placeholders of "${key.slice(0, 60)}"`);
            assert.equal(tags(value), tags(key), `${language.code}: inline tags of "${key.slice(0, 60)}"`);
            assert.equal(value.includes('|'), key.includes('|'), `${language.code}: plural forms of "${key.slice(0, 60)}"`);
            if (key.includes('|')) {
                assert.equal(value.split('|').length, 2, `${language.code}: two plural forms for "${key.slice(0, 60)}"`);
            }
            assert.ok(value.trim().length > 0, `${language.code}: no empty translation for "${key.slice(0, 60)}"`);
            // Text nodes and attributes are written as text (no entity decoding): "&amp;" would show as such.
            const asMarkup = (keys[key] || []).some((where) => where.endsWith('(html)'));
            if (!asMarkup) {
                assert.doesNotMatch(value, /&(amp|lt|gt|quot|#\d+);|<[a-z]/i, `${language.code}: no markup or entities in the text "${key.slice(0, 60)}"`);
            }
        }
    }
});
