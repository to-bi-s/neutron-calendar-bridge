#!/usr/bin/env node
/**
 * Invitation emails in Proton's languages (0.31): the strings the vendored email code uses
 * (`c('Email subject').t`…`` and friends in invite.ts, "(no title)" in helper.ts, the reply's "Re:" in
 * mail/messages.ts) are looked
 * up in Proton's own translation files — WebClients `applications/calendar/locales/<lang>.json`,
 * the same ttag JSON the calendar web app loads — at the commit the vendored code comes from
 * (vendor/manifest.json → upstream.commit), and written to src/invitation-locales.generated.ts:
 * one small table per language, the language names from config/locales.json, and the matching
 * date-fns locale for the dates in the emails. Run by the refresh routine; also by hand:
 *   node scripts/extract-invitation-locales.mjs [--webclients <dir>] [--check]
 * --check: fail when the generated file would change (the refresh routine's self-check).
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const clientRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const option = (name) => {
    const index = args.indexOf(name);
    return index === -1 ? null : args[index + 1];
};
const check = args.includes('--check');
const webClientsRoot = path.resolve(option('--webclients') || process.env.WEBCLIENTS_ROOT || path.join(clientRoot, '..', '..', 'WebClients'));
const manifest = JSON.parse(readFileSync(path.join(clientRoot, 'vendor', 'manifest.json'), 'utf8'));
const commit = manifest.upstream.commit;
const output = path.join(clientRoot, 'src', 'invitation-locales.generated.ts');

/** The vendored files whose ttag strings end up in an email. */
const SOURCE_FILES = [
    'vendor/@proton/shared/lib/calendar/mailIntegration/invite.ts',
    'vendor/@proton/shared/lib/calendar/helper.ts', // "(no title)"
    'vendor/@proton/shared/lib/mail/messages.ts' // the reply subject's "Re:" (German "AW:")
];
const LOCALES_DIR = 'applications/calendar/locales';

const gitShow = (filePath) => {
    const result = spawnSync('git', ['show', `${commit}:${filePath}`], { cwd: webClientsRoot, maxBuffer: 256 * 1024 * 1024 });
    if (result.status !== 0) {
        throw new Error(`git show ${commit}:${filePath} failed in ${webClientsRoot}: ${result.stderr.toString().trim()}`);
    }
    return result.stdout.toString('utf8');
};
const gitList = (dir) => {
    const result = spawnSync('git', ['ls-tree', '--name-only', commit, `${dir}/`], { cwd: webClientsRoot });
    if (result.status !== 0) {
        throw new Error(`git ls-tree failed: ${result.stderr.toString().trim()}`);
    }
    return result.stdout.toString('utf8').split('\n').filter(Boolean);
};

/** ttag writes `${ name }` (one space each side) for an expression in a msgid. */
const normalizeMsgid = (text) => text.replace(/\$\{\s*([^}]*?)\s*\}/g, '${ $1 }');

/** (context, msgid) pairs from `c('context').t\`…\`` and `.jt\`…\``; plural forms would need ngettext handling (none in these files). */
const collectStrings = () => {
    const wanted = new Map(); // context -> Set(msgid)
    for (const file of SOURCE_FILES) {
        const source = readFileSync(path.join(clientRoot, file), 'utf8');
        if (/\.ngettext\(/.test(source)) {
            throw new Error(`${file} uses ngettext: extend extract-invitation-locales.mjs for plural strings`);
        }
        for (const match of source.matchAll(/c\('((?:[^'\\]|\\.)*)'\)\s*\.\s*(?:t|jt)\s*`((?:[^`\\]|\\.)*)`/g)) {
            const context = match[1];
            const msgid = normalizeMsgid(match[2]);
            if (!wanted.has(context)) {
                wanted.set(context, new Set());
            }
            wanted.get(context).add(msgid);
        }
    }
    return wanted;
};

/** Proton's locale code → the date-fns locale (date-fns 2 folder name), or null when date-fns has none. */
const dateFnsLocaleFor = (code) => {
    const [language, region] = code.split('_');
    const candidates = [`${language}-${region}`, language];
    for (const candidate of candidates) {
        if (existsSync(path.join(clientRoot, 'node_modules', 'date-fns', 'locale', candidate, 'index.js'))) {
            return candidate;
        }
    }
    return null;
};

const main = () => {
    const wanted = collectStrings();
    const total = [...wanted.values()].reduce((sum, set) => sum + set.size, 0);
    const names = JSON.parse(gitShow(`${LOCALES_DIR}/config/locales.json`));
    const files = gitList(LOCALES_DIR).filter((file) => file.endsWith('.json') && !file.includes('/config/'));
    const languages = [];
    const translations = {};
    const coverage = [];
    for (const file of files) {
        const code = path.basename(file, '.json');
        const data = JSON.parse(gitShow(file));
        const contexts = {};
        let found = 0;
        for (const [context, msgids] of wanted) {
            for (const msgid of msgids) {
                const entry = data.contexts?.[context]?.[msgid];
                const text = Array.isArray(entry) ? entry[0] : typeof entry === 'string' ? entry : '';
                if (text) {
                    (contexts[context] ||= {})[msgid] = [text];
                    found += 1;
                }
            }
        }
        if (!found) {
            continue; // nothing of ours translated: not offered
        }
        languages.push({ code, name: names[code] || code, dateFns: dateFnsLocaleFor(code), translated: found, of: total });
        translations[code] = { headers: { 'plural-forms': data.headers?.['plural-forms'] || 'nplurals=2; plural=(n != 1);', language: code }, contexts };
        coverage.push(`${code} ${found}/${total}`);
    }
    languages.sort((a, b) => a.name.localeCompare(b.name, 'en'));
    const english = { code: 'en_US', name: names.en_US || 'English', dateFns: 'en-US', translated: total, of: total };
    const all = [english, ...languages];

    const lines = [];
    lines.push('/**');
    lines.push(' * Generated by scripts/extract-invitation-locales.mjs — do not edit. Proton\'s own translations of the');
    lines.push(` * strings in the invitation emails, from WebClients ${commit.slice(0, 10)} (${manifest.upstream.date}),`);
    lines.push(` * ${LOCALES_DIR}/<code>.json (GPL-3.0, like the rest of the vendored code). ${total} strings;`);
    lines.push(` * coverage: ${coverage.join(', ')}.`);
    lines.push(' */');
    lines.push('');
    lines.push('export interface InvitationLanguage {');
    lines.push('    /** Proton\'s locale code (xx_YY). */');
    lines.push('    code: string;');
    lines.push('    /** The language\'s own name, as Proton lists it. */');
    lines.push('    name: string;');
    lines.push('    /** The date-fns locale for the dates in the emails; null: English dates. */');
    lines.push('    dateFns: string | null;');
    lines.push('    /** How many of the email strings Proton has translated (the rest stay English). */');
    lines.push('    translated: number;');
    lines.push('    of: number;');
    lines.push('}');
    lines.push('');
    lines.push(`export const INVITATION_LOCALE_SOURCE = { commit: ${JSON.stringify(commit)}, date: ${JSON.stringify(manifest.upstream.date)}, path: ${JSON.stringify(LOCALES_DIR)} };`);
    lines.push('');
    lines.push(`export const INVITATION_LANGUAGES: InvitationLanguage[] = ${JSON.stringify(all, null, 4)};`);
    lines.push('');
    lines.push('/** ttag locale data per code (English needs none). */');
    lines.push(`export const INVITATION_TRANSLATIONS: Record<string, { headers: Record<string, string>; contexts: Record<string, Record<string, string[]>> }> = ${JSON.stringify(translations, null, 4)};`);
    lines.push('');
    lines.push('/** The date-fns locales, loaded on demand (static paths, so the bundler keeps them). */');
    lines.push('export const DATE_FNS_LOCALE_LOADERS: Record<string, () => Promise<Locale>> = {');
    const dateFnsCodes = [...new Set(all.map((language) => language.dateFns).filter(Boolean))].sort();
    for (const dateFns of dateFnsCodes) {
        lines.push(`    ${JSON.stringify(dateFns)}: () => import('date-fns/locale/${dateFns}').then((module) => module.default),`);
    }
    lines.push('};');
    lines.push('');
    lines.push("import type { Locale } from 'date-fns';");
    lines.push('');
    const text = lines.join('\n');
    const previous = existsSync(output) ? readFileSync(output, 'utf8') : null;
    if (check) {
        if (previous !== text) {
            console.error(`${path.relative(clientRoot, output)} is out of date: run node scripts/extract-invitation-locales.mjs`);
            process.exit(1);
        }
        console.log(`invitation locales up to date (${all.length} languages, ${total} strings)`);
        return;
    }
    writeFileSync(output, text);
    console.log(`${path.relative(clientRoot, output)}: ${all.length} languages, ${total} strings from WebClients ${commit.slice(0, 10)}; ${coverage.join(', ')}`);
};

main();
