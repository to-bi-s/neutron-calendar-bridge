#!/usr/bin/env node
/**
 * 1.0.7: the Linux launcher icon, drawn from the macOS 26 icon (`npm run icon:linux`).
 *
 * macOS 26 renders the app's icon from `resources/icons/Assets.car` (the Icon Composer design on its
 * glass plate). Linux has no such renderer, so this script asks macOS's own icon service for the icon
 * of a built app, at 1024 px, and scales it down into `resources/icons/linux/<size>x<size>.png` —
 * the folder `build.linux.icon` in package.json names. electron-builder puts the set into the .deb
 * (hicolor icons), the AppImage (.DirIcon) and the .desktop entry; the window shows the 256 px one.
 *
 *   npm run icon:linux                        # from release/mac-arm64/Neutron Calendar Bridge.app
 *   npm run icon:linux -- /path/to/Some.app   # from another built app
 *
 * Needs a Mac running macOS 26 (older versions draw the .icns on its own plate) and a built app
 * (`npm run package:mac:release` or `npm run package:mac:quick`). Commit the PNGs: Linux builds run
 * on Linux, where none of this exists.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const { build } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const app = process.argv[2] || join(root, build.directories?.output || 'release', 'mac-arm64', `${build.productName}.app`);
const target = join(root, 'resources', 'icons', 'linux');
const SIZES = [16, 24, 32, 48, 64, 96, 128, 256, 512, 1024];

const fail = (message) => {
    console.error(`\n✗ ${message}`);
    process.exit(1);
};

if (process.platform !== 'darwin') {
    fail('The macOS 26 icon is rendered by macOS itself: run this on a Mac.');
}
if (!existsSync(app)) {
    fail(`No built app at ${app} (npm run package:mac:quick builds one), or pass the path to a .app.`);
}

// The icon service draws the icon exactly as the Finder and the Dock show it, at the size asked for.
const render = `
ObjC.import('AppKit');
const args = $.NSProcessInfo.processInfo.arguments;
const appPath = ObjC.unwrap(args.objectAtIndex(4));
const outPath = ObjC.unwrap(args.objectAtIndex(5));
const icon = $.NSWorkspace.sharedWorkspace.iconForFile(appPath);
icon.setSize($.NSMakeSize(1024, 1024));
const rep = $.NSBitmapImageRep.alloc.initWithBitmapDataPlanesPixelsWidePixelsHighBitsPerSampleSamplesPerPixelHasAlphaIsPlanarColorSpaceNameBytesPerRowBitsPerPixel(null, 1024, 1024, 8, 4, true, false, $.NSCalibratedRGBColorSpace, 0, 0);
$.NSGraphicsContext.saveGraphicsState;
$.NSGraphicsContext.setCurrentContext($.NSGraphicsContext.graphicsContextWithBitmapImageRep(rep));
icon.drawInRectFromRectOperationFraction($.NSMakeRect(0, 0, 1024, 1024), $.NSZeroRect, $.NSCompositingOperationSourceOver, 1.0);
$.NSGraphicsContext.restoreGraphicsState;
const png = rep.representationUsingTypeProperties($.NSBitmapImageFileTypePNG, $.NSDictionary.dictionary);
png.writeToFileAtomically(outPath, true);
`;

const work = mkdtempSync(join(tmpdir(), 'neutron-linux-icon-'));
const script = join(work, 'render.js');
const master = join(work, '1024.png');
writeFileSync(script, render);
const result = spawnSync('osascript', ['-l', 'JavaScript', script, app, master], { encoding: 'utf8' });
if (result.status !== 0 || !existsSync(master)) {
    fail(`osascript could not render the icon (exit ${result.status}): ${result.stderr.trim()}`);
}

mkdirSync(target, { recursive: true });
for (const size of SIZES) {
    const file = join(target, `${size}x${size}.png`);
    const scaled = spawnSync('sips', ['-z', String(size), String(size), master, '--out', file], { encoding: 'utf8' });
    if (scaled.status !== 0) {
        fail(`sips could not make ${file}: ${scaled.stderr.trim()}`);
    }
}
rmSync(work, { recursive: true, force: true });
console.log(`${target}: ${SIZES.map((size) => `${size}x${size}.png`).join(', ')} written from ${app}. Commit them.`);
