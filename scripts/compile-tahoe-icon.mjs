#!/usr/bin/env node
/**
 * 1.0.2: compiles the macOS 26 app icon (`resources/icons/AppIcon.icon`, made in Icon Composer from
 * the artwork in app-icon.png) into `resources/icons/Assets.car` with Xcode's actool. The build's
 * afterPack hook (scripts/after-pack.cjs) puts that file into the app for macOS 26; older macOS keeps
 * app-icon.icns. Needs Xcode 26 (`xcode-select -p` pointing at it, not only the command-line tools).
 *   npm run icon:tahoe
 * The .car is committed, so the CI build and other Macs need no Icon Composer.
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const icon = join(root, 'resources', 'icons', 'AppIcon.icon');
const target = join(root, 'resources', 'icons', 'Assets.car');

if (process.platform !== 'darwin') {
    console.error('actool exists on macOS only.');
    process.exit(1);
}
if (!existsSync(icon)) {
    console.error(`${icon} is missing: open Icon Composer (Xcode 26 → Open Developer Tool), drop resources/icons/app-icon.png in, export as AppIcon.icon into resources/icons/.`);
    process.exit(1);
}
const out = mkdtempSync(join(tmpdir(), 'neutron-icon-'));
const result = spawnSync(
    'xcrun',
    [
        'actool', icon,
        '--compile', out,
        '--app-icon', 'AppIcon',
        '--enable-on-demand-resources', 'NO',
        '--development-region', 'en',
        '--target-device', 'mac',
        '--platform', 'macosx',
        '--enable-icon-stack-fallback-generation=disabled',
        '--include-all-app-icons',
        '--minimum-deployment-target', '11.0',
        '--output-partial-info-plist', join(out, 'partial.plist')
    ],
    { stdio: 'inherit' }
);
const car = join(out, 'Assets.car');
if (result.status !== 0 || !existsSync(car)) {
    console.error(`actool did not produce Assets.car (exit ${result.status}); files in ${out}: ${readdirSync(out).join(', ') || 'none'}. Xcode 26 selected? (sudo xcode-select -s /Applications/Xcode.app; xcodebuild -runFirstLaunch)`);
    process.exit(1);
}
copyFileSync(car, target);
rmSync(out, { recursive: true, force: true });
console.log(`${target} written. Commit it; the next build carries the macOS 26 icon.`);
