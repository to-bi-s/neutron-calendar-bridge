#!/usr/bin/env node
/**
 * Stage 16: a signed, notarized build for the Mac (`npm run package:mac:release`), run on Tobi's Mac.
 *
 * Needs, once (see README → "Signed builds"):
 *   - a "Developer ID Application" certificate in the login Keychain (Xcode → Settings → Accounts →
 *     Manage Certificates → + → Developer ID Application);
 *   - notarization credentials stored in the Keychain under a profile name:
 *       xcrun notarytool store-credentials neutron-notary --apple-id <Apple ID> --team-id <Team ID>
 *     (asks for an app-specific password from account.apple.com; nothing is written to the repository).
 *
 * The profile name is NEUTRON_NOTARY_PROFILE (default "neutron-notary"). Steps: build, electron-builder
 * signs the app (hardened runtime, resources/entitlements.mac.plist) and has Apple notarize and staple
 * it; the DMG is then signed, notarized and stapled too; every result is checked the way Gatekeeper
 * checks a download. Nothing secret is printed.
 *
 * `--quick` (npm run package:mac:quick): for testing on this Mac — the app is signed, notarized and
 * stapled as always, the DMG only signed (one wait for Apple instead of two). Gatekeeper accepts the app
 * when it starts; only the DMG itself is not checked offline when it is opened. Not for builds given to others.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const profile = process.env.NEUTRON_NOTARY_PROFILE || 'neutron-notary';
const quick = process.argv.includes('--quick');
const { version, build } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

const fail = (message) => {
    console.error(`\n✗ ${message}`);
    process.exit(1);
};
const run = (command, args, options = {}) => {
    const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', ...options });
    if (result.status !== 0) {
        fail(`${command} ${args[0] ?? ''} failed (exit ${result.status})`);
    }
};
const output = (command, args) => {
    const result = spawnSync(command, args, { cwd: root, encoding: 'utf8' });
    return `${result.stdout ?? ''}${result.stderr ?? ''}`;
};

if (process.platform !== 'darwin') {
    fail('Signed builds are made on a Mac.');
}

// 1. The certificate.
const identities = output('security', ['find-identity', '-v', '-p', 'codesigning']);
const identity = identities.match(/"(Developer ID Application: [^"]+)"/)?.[1];
if (!identity) {
    fail('No "Developer ID Application" certificate in the Keychain. Create one in Xcode → Settings → Accounts → Manage Certificates.');
}
console.log(`Signing as: ${identity}`);

// 2. The notarization profile (only checked to exist; its password stays in the Keychain).
const history = spawnSync('xcrun', ['notarytool', 'history', '--keychain-profile', profile], { encoding: 'utf8' });
if (history.status !== 0) {
    fail(`No notarization profile "${profile}" in the Keychain (or Apple refused it). Store it with:\n  xcrun notarytool store-credentials ${profile} --apple-id <Apple ID> --team-id <Team ID>`);
}

// 3. Build, sign, notarize and staple the app.
run('npm', ['run', 'build']);
run('npx', ['electron-builder', '--mac', '--publish', 'never'], {
    env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: 'true', CSC_NAME: identity.replace(/^Developer ID Application: /, ''), APPLE_KEYCHAIN_PROFILE: profile }
});

const release = join(root, build.directories.output);
const appDir = readdirSync(release).find((name) => /^mac/.test(name) && existsSync(join(release, name, `${build.productName}.app`)));
const app = appDir && join(release, appDir, `${build.productName}.app`);
const dmg = readdirSync(release).map((name) => join(release, name)).find((path) => path.endsWith('.dmg') && path.includes(version));
if (!app || !dmg) {
    fail(`Built app or DMG for ${version} not found in ${release}`);
}

// 4. The DMG: signed, notarized, stapled (so it opens without a warning, also offline). --quick: signed only.
run('codesign', ['--sign', identity, '--timestamp', '--force', dmg]);
if (!quick) {
    run('xcrun', ['notarytool', 'submit', dmg, '--keychain-profile', profile, '--wait']);
    run('xcrun', ['stapler', 'staple', dmg]);
} else {
    console.log('\n--quick: the DMG is signed, not notarized (the app inside is notarized and stapled)');
}

// 5. Checks, as Gatekeeper does them.
console.log('\nChecks:');
const checks = [];
const check = (label, ok, detail = '') => {
    checks.push(ok);
    console.log(`${ok ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`);
};
const verify = spawnSync('codesign', ['--verify', '--deep', '--strict', app], { encoding: 'utf8' });
check('app signature valid (deep, strict)', verify.status === 0, verify.stderr.trim());
const details = output('codesign', ['-dv', '--verbose=2', app]);
check('signed with the Developer ID', details.includes(`Authority=${identity}`));
check('hardened runtime', /flags=0x[0-9a-f]+\([^)]*runtime[^)]*\)/.test(details));
const entitlements = output('codesign', ['-d', '--entitlements', '-', '--xml', app]);
check('library validation on (no disable-library-validation)', !entitlements.includes('disable-library-validation'));
const assessApp = output('spctl', ['--assess', '--type', 'execute', '-vv', app]);
check('Gatekeeper accepts the app', /accepted/.test(assessApp) && /Notarized Developer ID/.test(assessApp), assessApp.match(/source=.*$/m)?.[0]);
check('app ticket stapled', spawnSync('xcrun', ['stapler', 'validate', app]).status === 0);
if (quick) {
    const dmgSignature = spawnSync('codesign', ['--verify', '--strict', dmg], { encoding: 'utf8' });
    check('DMG signed (--quick: not notarized)', dmgSignature.status === 0, dmgSignature.stderr.trim());
} else {
    const assessDmg = output('spctl', ['--assess', '--type', 'open', '--context', 'context:primary-signature', '-vv', dmg]);
    check('Gatekeeper accepts the DMG', /accepted/.test(assessDmg), assessDmg.match(/source=.*$/m)?.[0]);
    check('DMG ticket stapled', spawnSync('xcrun', ['stapler', 'validate', dmg]).status === 0);
}

if (checks.some((ok) => !ok)) {
    fail('Some checks failed (above).');
}
console.log(quick ? `\nApp signed and notarized, DMG signed (--quick, for testing): ${dmg}` : `\nSigned and notarized: ${dmg}`);
