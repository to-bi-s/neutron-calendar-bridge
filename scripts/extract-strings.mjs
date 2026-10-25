#!/usr/bin/env node
/**
 * The app's texts (0.32): collects every English key — t('…') / tn('…', '…', n) calls in src/main
 * and src/renderer, the values of the maps marked "i18n" in renderer.js, and index.html's
 * text-only elements, data-i18n-html blocks and title/placeholder/aria-label attributes — and
 * checks the catalogs in src/locales/<code>.json against them: missing keys (English shows), keys
 * no longer used, placeholders that differ. Writes src/locales/keys.json (the key list, for
 * translating). `--check` fails on a missing key or a placeholder mismatch (part of npm run check).
 *   node scripts/extract-strings.mjs [--check]
 */
import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const check = process.argv.includes('--check');
const LANGUAGES = ['de', 'nl', 'fr', 'es', 'it'];

const keys = new Map(); // key -> Set(where)
let warnings = 0;
const add = (key, where) => {
    const normalized = key.replace(/\s+/g, ' ').trim();
    if (!normalized || !/[A-Za-z]/.test(normalized)) return;
    if (!keys.has(normalized)) keys.set(normalized, new Set());
    keys.get(normalized).add(where);
};

/** A JS string literal's value ('…', "…" or a `…` without ${}). */
const unquote = (literal) => {
    const quote = literal[0];
    const body = literal.slice(1, -1);
    return body.replace(/\\(['"`\\nt])/g, (match, char) => (char === 'n' ? '\n' : char === 't' ? '\t' : char));
};
const STRING = String.raw`'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|` + '`(?:[^`\\\\$]|\\\\.)*`';

const listFiles = (dir, pattern) =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const path = join(dir, entry.name);
        return entry.isDirectory() ? listFiles(path, pattern) : pattern.test(entry.name) ? [path] : [];
    });

for (const file of [...listFiles(join(root, 'src', 'main'), /\.ts$/), ...listFiles(join(root, 'src', 'renderer'), /\.js$/)]) {
    // Comments out (a doc comment may quote a t() call); strings stay as they are.
    const source = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, (comment) => (comment === '/* i18n */' ? comment : '')).replace(/^\s*\/\/.*$/gm, '');
    const where = relative(root, file);
    for (const match of source.matchAll(new RegExp(String.raw`\bt\(\s*(${STRING})`, 'g'))) {
        add(unquote(match[1]), where);
    }
    // A template literal with ${} as the key would be a different key per value: say so.
    for (const match of source.matchAll(/\btn?\(\s*`[^`]*\$\{/g)) {
        console.warn(`${where}: t() with a template literal containing \${}: ${source.slice(match.index, match.index + 60).replace(/\s+/g, ' ')}…`);
        warnings += 1;
    }
    for (const match of source.matchAll(new RegExp(String.raw`\btn\(\s*(${STRING})\s*,\s*(${STRING})`, 'g'))) {
        add(`${unquote(match[1])}|${unquote(match[2])}`, where);
    }
    // A constant whose value is a key: `const HINT = /* i18n */ '…'`.
    for (const match of source.matchAll(new RegExp(String.raw`/\* i18n \*/\s*(${STRING})`, 'g'))) {
        add(unquote(match[1]), `${where} (constant)`);
    }
    // Maps whose values are keys: `const NAME = /* i18n */ { kind: 'Text', … }` or an array of objects.
    for (const match of source.matchAll(/\/\* i18n \*\/\s*([[{])/g)) {
        const open = match[1];
        const close = open === '{' ? '}' : ']';
        let depth = 0;
        let index = match.index + match[0].length - 1;
        for (; index < source.length; index += 1) {
            if (source[index] === open) depth += 1;
            if (source[index] === close) depth -= 1;
            if (depth === 0) break;
        }
        const block = source.slice(match.index, index + 1);
        for (const literal of block.matchAll(new RegExp(`(${STRING})`, 'g'))) {
            const after = block.slice(literal.index + literal[0].length).match(/^\s*(.)/);
            if (after && after[1] === ':') continue; // a quoted key ('dry-run': …), not a text
            const value = unquote(literal[1]);
            if (/[A-Za-z]{2,}/.test(value) && !/^[a-z-]+$/.test(value) && !value.startsWith('<')) add(value, `${where} (map)`);
        }
    }
}

// index.html: text-only elements, data-i18n-html blocks, attributes.
const html = readFileSync(join(root, 'src', 'renderer', 'index.html'), 'utf8').replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/g, '');
for (const match of html.matchAll(/<([a-z0-9]+)\b[^>]*\sdata-i18n-html[^>]*>([\s\S]*?)<\/\1>/g)) {
    add(match[2], 'index.html (html)');
}
// Text nodes and attributes reach the renderer decoded ("Checks & window"), so the keys are decoded too.
const decode = (text) => text.replace(/&(amp|lt|gt|quot|#39|nbsp|#(\d+));/g, (match, name, number) => (number ? String.fromCodePoint(Number(number)) : { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", nbsp: '\u00a0' }[name]));
const withoutBlocks = html.replace(/<([a-z0-9]+)\b[^>]*\sdata-i18n-html[^>]*>[\s\S]*?<\/\1>/g, '').replace(/<([a-z0-9]+)\b[^>]*\sdata-i18n-skip[^>]*>[\s\S]*?<\/\1>/g, '');
for (const match of withoutBlocks.matchAll(/>([^<>]+)</g)) {
    if (/[A-Za-z]{2,}/.test(match[1])) add(decode(match[1]), 'index.html');
}
for (const tag of withoutBlocks.matchAll(/<[a-z0-9]+\b[^>]*>/g)) {
    for (const match of tag[0].matchAll(/\s(?:title|placeholder|aria-label)="([^"]+)"/g)) {
        add(decode(match[1]), 'index.html (attribute)');
    }
}

const placeholders = (text) => (text.match(/\{\w+\}/g) || []).sort().join(' ');
const sorted = [...keys.keys()].sort((a, b) => a.localeCompare(b, 'en'));
const keysFile = join(root, 'src', 'locales', 'keys.json');
const keysJson = `${JSON.stringify(Object.fromEntries(sorted.map((key) => [key, [...keys.get(key)].sort()])), null, 2)}\n`;
if (!check) writeFileSync(keysFile, keysJson);
else if (existsSync(keysFile) && readFileSync(keysFile, 'utf8') !== keysJson) {
    console.error('src/locales/keys.json is out of date: run node scripts/extract-strings.mjs');
    process.exitCode = 1;
}

let problems = 0;
for (const code of LANGUAGES) {
    const file = join(root, 'src', 'locales', `${code}.json`);
    const catalog = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
    const missing = sorted.filter((key) => !catalog[key]);
    const unused = Object.keys(catalog).filter((key) => !keys.has(key));
    const mismatched = sorted.filter((key) => catalog[key] && placeholders(catalog[key]) !== placeholders(key));
    const pluralMismatch = sorted.filter((key) => catalog[key] && key.includes('|') !== catalog[key].includes('|'));
    console.log(`${code}: ${sorted.length - missing.length}/${sorted.length} translated${missing.length ? `, ${missing.length} missing` : ''}${unused.length ? `, ${unused.length} unused` : ''}${mismatched.length ? `, ${mismatched.length} with other placeholders` : ''}${pluralMismatch.length ? `, ${pluralMismatch.length} plural forms off` : ''}`);
    for (const key of missing.slice(0, check ? 50 : 10)) console.log(`   missing: ${key.slice(0, 100)}`);
    for (const key of mismatched) console.log(`   placeholders: ${key.slice(0, 80)} → ${catalog[key].slice(0, 80)}`);
    for (const key of pluralMismatch) console.log(`   plural: ${key.slice(0, 80)} → ${catalog[key].slice(0, 80)}`);
    for (const key of unused.slice(0, 10)) console.log(`   unused: ${key.slice(0, 100)}`);
    if (missing.length || mismatched.length || pluralMismatch.length) problems += 1;
}
console.log(`${sorted.length} keys`);
if (check && (problems || warnings)) process.exitCode = 1;
