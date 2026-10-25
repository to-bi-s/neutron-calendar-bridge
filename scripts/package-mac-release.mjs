#!/usr/bin/env node
/**
 * Stage 16: signed, notarized builds for the Mac (`npm run package:mac:release`), run on Tobi's Mac;
 * 1.0.1: one DMG for Apple silicon and one for Intel from the same run.
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

// 3. Build, sign, notarize and staple the app(s). 1.0.1: Apple silicon and Intel (package.json: both
// architectures); --quick builds this Mac's architecture only.
run('npm', ['run', 'build']);
run('npx', ['electron-builder', '--mac', ...(quick ? [`--${process.arch}`] : []), '--publish', 'never'], {
    env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: 'true', CSC_NAME: identity.replace(/^Developer ID Application: /, ''), APPLE_KEYCHAIN_PROFILE: profile }
});

const release = join(root, build.directories.output);
/** Each built architecture: electron-builder puts the x64 app in mac/, the arm64 one in mac-arm64/. */
const builds = readdirSync(release)
    .filter((name) => /^mac(-arm64)?$/.test(name) && existsSync(join(release, name, `${build.productName}.app`)))
    .map((name) => {
        const arch = name === 'mac' ? 'x64' : 'arm64';
        const app = join(release, name, `${build.productName}.app`);
        const dmg = join(release, `${build.productName}-${version}-${arch}.dmg`);
        const zip = join(release, `${build.productName}-${version}-${arch}.zip`);
        return { arch, app, dmg, zip };
    })
    .filter(({ dmg }) => existsSync(dmg));
// 1.0.2: automatic updates install from the ZIPs; latest-mac.yml names them (and their blockmaps).
const updateFeed = join(release, 'latest-mac.yml');
if (!builds.length || (!quick && builds.length < 2)) {
    fail(`Built app(s) and DMG(s) for ${version} not found in ${release} (found: ${builds.map((entry) => entry.arch).join(', ') || 'none'})`);
}

// 4. The DMGs: signed, notarized, stapled (so they open without a warning, also offline). --quick: signed only.
for (const { arch, dmg } of builds) {
    console.log(`\nDMG (${arch}): ${dmg}`);
    run('codesign', ['--sign', identity, '--timestamp', '--force', dmg]);
    if (!quick) {
        run('xcrun', ['notarytool', 'submit', dmg, '--keychain-profile', profile, '--wait']);
        run('xcrun', ['stapler', 'staple', dmg]);
    }
}
if (quick) {
    console.log('\n--quick: the DMG is signed, not notarized (the app inside is notarized and stapled)');
}

// 5. Checks, as Gatekeeper does them, per architecture.
const checks = [];
const check = (label, ok, detail = '') => {
    checks.push(ok);
    console.log(`${ok ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`);
};
for (const { arch, app, dmg } of builds) {
    console.log(`\nChecks (${arch}):`);
    const archs = output('lipo', ['-archs', join(app, 'Contents', 'MacOS', build.productName)]).trim();
    check(`the app binary is ${arch === 'x64' ? 'x86_64' : 'arm64'}`, archs === (arch === 'x64' ? 'x86_64' : 'arm64'), archs);
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
}

for (const { arch, zip } of builds) {
    check(`update archive (${arch}) built`, existsSync(zip), zip);
    check(`its blockmap built`, existsSync(`${zip}.blockmap`));
}
check('latest-mac.yml (the update feed) built', existsSync(updateFeed), updateFeed);
if (checks.some((ok) => !ok)) {
    fail('Some checks failed (above).');
}
const list = builds.map(({ dmg }) => dmg).join('\n  ');
console.log(quick ? `\nApp signed and notarized, DMG signed (--quick, for testing):\n  ${list}` : `\nSigned and notarized:\n  ${list}`);
if (!quick) {
    const uploads = [...builds.flatMap(({ dmg, zip }) => [dmg, zip, `${zip}.blockmap`]), updateFeed];
    console.log(`\nAttach to the GitHub Release v${version} (all of them; the installed apps update from the .zip files through latest-mac.yml):\n  ${uploads.join('\n  ')}`);
}
