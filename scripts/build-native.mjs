#!/usr/bin/env node
/**
 * Builds the native module(s) under native/ with node-gyp (0.32.4: menu-spinner, the spinning sync
 * symbol in the menu-bar menu). Node-API, so the build made against Node's headers runs in Electron
 * too; on anything but macOS a stub is built that does nothing. Part of `npm run build`; needs
 * Xcode's command-line tools on the Mac (clang), like @journeyapps/sqlcipher does.
 *   node scripts/build-native.mjs [--force]   (skips the build when the .node is newer than the sources and
 *   was made on this platform/arch; --force always builds, and a failure then fails the script — without
 *   --force a failed build is only reported, the app runs with the symbol standing still)
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
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

const stampText = `${process.platform}-${process.arch}-napi${process.versions.napi}`;
for (const name of modules) {
    const dir = join(root, 'native', name);
    const built = join(dir, 'build', 'Release', `${name.replace(/-/g, '_')}.node`);
    const stamp = join(dir, 'build', '.stamp');
    const sources = Math.max(newest(join(dir, 'src')), statSync(join(dir, 'binding.gyp')).mtimeMs);
    const sameMachine = existsSync(stamp) && readFileSync(stamp, 'utf8') === stampText;
    if (!force && existsSync(built) && statSync(built).mtimeMs > sources && sameMachine) {
        console.log(`native/${name}: up to date`);
        continue;
    }
    console.log(`native/${name}: building with node-gyp…`);
    const result = spawnSync(nodeGyp, ['rebuild'], { cwd: dir, stdio: 'inherit', shell: process.platform === 'win32' });
    if (result.status !== 0) {
        const why = result.error ? ` (${result.error.message})` : '';
        const hint = process.platform === 'darwin' ? " Install Xcode's command-line tools (xcode-select --install) and run npm run build:native." : '';
        if (force) {
            console.error(`native/${name}: the build failed${why}.${hint}`);
            process.exit(result.status ?? 1);
        }
        console.warn(`native/${name}: the build failed${why}. The app still runs; the sync symbol in the menu stays still.${hint}`);
        continue;
    }
    writeFileSync(stamp, stampText);
}
