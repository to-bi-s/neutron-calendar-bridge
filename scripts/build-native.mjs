#!/usr/bin/env node
/**
 * Builds the native module(s) under native/ with node-gyp (0.32.4: menu-spinner, the spinning sync
 * symbol in the menu-bar menu). Node-API, so the build made against Node's headers runs in Electron
 * too; on anything but macOS a stub is built that does nothing. Part of `npm run build`; needs
 * Xcode's command-line tools on the Mac (clang), like @journeyapps/sqlcipher does.
 *   node scripts/build-native.mjs [--force]   (skips the build when the .node is newer than the sources and
 *   was made on this platform/arch; --force always builds, and a failure then fails the script — without
 *   --force a failed build is only reported, the app runs with the symbol standing still)
 * 1.0.1: on macOS the module is built for arm64 and x86_64 and joined with lipo into one fat .node, so the
 * same file serves the Apple-silicon and the Intel build of the app (electron-builder packs both from it).
 * If the second architecture cannot be built, the host's alone is used and said so.
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const force = process.argv.includes('--force');
const modules = ['menu-spinner'];

const newest = (dir) => Math.max(0, ...readdirSync(dir).map((name) => statSync(join(dir, name)).mtimeMs));
if (!existsSync(join(root, 'node_modules', 'node-addon-api', 'package.json'))) {
    console.error('node-addon-api is not installed (a devDependency since 0.32.4): run npm install first');
    process.exit(1);
}
const nodeGyp = join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'node-gyp.cmd' : 'node-gyp');
if (!existsSync(nodeGyp)) {
    console.error('node-gyp is not in node_modules/.bin (it comes with electron-builder): run npm install first');
    process.exit(1);
}

/** The architectures built: on macOS both (fat binary), elsewhere the host's. */
const archs = process.platform === 'darwin' ? ['arm64', 'x64'] : [process.arch];
const stampText = `${process.platform}-${archs.join('+')}-napi${process.versions.napi}`;
for (const name of modules) {
    const dir = join(root, 'native', name);
    const fileName = `${name.replace(/-/g, '_')}.node`;
    const built = join(dir, 'build', 'Release', fileName);
    const stamp = join(dir, 'build', '.stamp');
    const sources = Math.max(newest(join(dir, 'src')), statSync(join(dir, 'binding.gyp')).mtimeMs);
    const sameMachine = existsSync(stamp) && readFileSync(stamp, 'utf8') === stampText;
    if (!force && existsSync(built) && statSync(built).mtimeMs > sources && sameMachine) {
        console.log(`native/${name}: up to date`);
        continue;
    }
    const perArch = [];
    let failed = null;
    for (const arch of archs) {
        console.log(`native/${name}: building with node-gyp (${arch})…`);
        const result = spawnSync(nodeGyp, ['rebuild', `--arch=${arch}`], { cwd: dir, stdio: 'inherit', shell: process.platform === 'win32' });
        if (result.status !== 0) {
            failed = { arch, why: result.error ? ` (${result.error.message})` : '' };
            if (arch === process.arch) break; // the host's own build failed: nothing to fall back to
            console.warn(`native/${name}: the ${arch} build failed${failed.why}; the module is built for ${process.arch} only.`);
            failed = null;
            continue;
        }
        if (archs.length > 1) {
            mkdirSync(join(dir, 'build', 'arch'), { recursive: true });
            const copy = join(dir, 'build', 'arch', `${arch}-${fileName}`);
            copyFileSync(built, copy);
            perArch.push({ arch, copy });
        }
    }
    if (failed) {
        const hint = process.platform === 'darwin' ? " Install Xcode's command-line tools (xcode-select --install) and run npm run build:native." : '';
        if (force) {
            console.error(`native/${name}: the build failed${failed.why}.${hint}`);
            process.exit(1);
        }
        console.warn(`native/${name}: the build failed${failed.why}. The app still runs; the sync symbol in the menu stays still.${hint}`);
        continue;
    }
    if (perArch.length > 1) {
        // One fat binary from the per-architecture builds (the last node-gyp run left only its own in Release/).
        const lipo = spawnSync('lipo', ['-create', ...perArch.map((entry) => entry.copy), '-output', built], { stdio: 'inherit' });
        if (lipo.status !== 0) {
            console.warn(`native/${name}: lipo failed; the module is built for ${perArch.at(-1).arch} only.`);
            copyFileSync(perArch.at(-1).copy, built);
        } else {
            const info = spawnSync('lipo', ['-archs', built], { encoding: 'utf8' });
            console.log(`native/${name}: fat binary (${(info.stdout || '').trim()})`);
        }
    } else if (perArch.length === 1) {
        copyFileSync(perArch[0].copy, built);
    }
    writeFileSync(stamp, perArch.length === archs.length ? stampText : `${process.platform}-${process.arch}-napi${process.versions.napi}`);
}
