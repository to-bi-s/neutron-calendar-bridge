#!/usr/bin/env node
/**
 * `npm run check`: everything that must pass before a patch, in one command.
 *
 * 1. the library in client/: its build and all offline tests (`npm run check`
 *    there). Skipped with --bridge-only, or when the folder is not there.
 * 2. Bridge type check (tsc --noEmit).
 * 3. Renderer syntax (node --check).
 * 4. Texts: every key the code uses is in each language catalog (extract-strings --check).
 * 5. Bridge tests (node:test via tsx).
 * 6. Bridge build (tsc + renderer copy), what `npm run package:mac` starts from.
 *
 * Stops at the first failure and prints a summary with the time each step took. No network, no
 * Proton account; the live tests against test accounts are separate (see the roadmap).
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const client = join(root, 'client');
const bridgeOnly = process.argv.includes('--bridge-only');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';

const steps = [
    ...(!bridgeOnly && existsSync(join(client, 'package.json'))
        ? [{ name: 'library: build + offline tests', cwd: client, command: npm, args: ['run', 'check'] }]
        : []),
    { name: 'bridge: type check', cwd: root, command: npx, args: ['tsc', '--noEmit', '-p', 'tsconfig.json'] },
    { name: 'bridge: renderer syntax', cwd: root, command: process.execPath, args: ['--check', 'src/renderer/renderer.js'] },
    { name: 'bridge: renderer i18n syntax', cwd: root, command: process.execPath, args: ['--check', 'src/renderer/i18n.js'] },
    { name: 'bridge: texts and catalogs', cwd: root, command: process.execPath, args: ['scripts/extract-strings.mjs', '--check'] },
    { name: 'bridge: tests', cwd: root, command: npm, args: ['test'] },
    { name: 'bridge: build', cwd: root, command: npm, args: ['run', 'build'] }
];

const results = [];
for (const step of steps) {
    const started = Date.now();
    console.log(`\n▶ ${step.name}`);
    const run = spawnSync(step.command, step.args, { cwd: step.cwd, stdio: 'inherit' });
    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    const ok = run.status === 0;
    // Could not start at all (e.g. npm not found) or killed: say why.
    const why = run.error ? run.error.message : run.signal ? `stopped by ${run.signal}` : '';
    results.push({ name: step.name, ok, seconds, why });
    if (!ok) {
        break;
    }
}

console.log('\nSummary');
for (const { name, ok, seconds, why } of results) {
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name} (${seconds} s)${why ? ` — ${why}` : ''}`);
}
const skipped = steps.length - results.length;
if (skipped) {
    console.log(`  … ${skipped} step(s) not run`);
}
if (bridgeOnly) {
    console.log('  (library skipped: --bridge-only)');
} else if (!existsSync(join(client, 'package.json'))) {
    console.log(`  (library skipped: ${client} not found)`);
}
const failed = results.some(({ ok }) => !ok);
console.log(failed ? '\nCheck FAILED.' : '\nAll checks passed.');
process.exitCode = failed ? 1 : 0;
