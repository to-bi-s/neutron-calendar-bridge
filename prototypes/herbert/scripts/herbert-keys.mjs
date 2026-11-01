#!/usr/bin/env node
/**
 * Writes locales/herbert-keys.json: every English line Herbert can say, flat and sorted, the
 * way the app's scripts/extract-strings.mjs lists keys (the English text is the key; the
 * catalogs in src/locales/<code>.json map it to the translation). Run after editing
 * lib/herbert-texts.js. Prints how many lines there are.
 *   node prototypes/herbert/scripts/herbert-keys.mjs
 */
import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const texts = createRequire(import.meta.url)(join(here, '..', 'lib', 'herbert-texts.js'));

const keys = new Set();
const walk = (value) => {
    if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === 'object') Object.values(value).forEach(walk);
    else if (typeof value === 'string' && value.trim()) keys.add(value.replace(/\s+/g, ' ').trim());
};
walk(texts);
const list = [...keys].sort((a, b) => a.localeCompare(b, 'en'));
writeFileSync(join(here, '..', 'locales', 'herbert-keys.json'), JSON.stringify(list, null, 2) + '\n');
console.log(`${list.length} lines written to locales/herbert-keys.json`);
