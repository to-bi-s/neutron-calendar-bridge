/**
 * electron-builder afterPack hook (1.0.2): the macOS 26 app icon.
 *
 * `resources/icons/app-icon.icns` (the artwork on its plate, with margins) is the icon for every
 * macOS up to 15 and is what package.json names. macOS 26 shows such an icon on a grey plate of its
 * own; its real icon format is an Icon Composer `.icon` compiled into `Assets.car`. When
 * `resources/icons/Assets.car` exists (made by `npm run icon:tahoe` on a Mac with Xcode 26), it is
 * copied into the app and `CFBundleIconName` is set, so macOS 26 uses it and older versions keep
 * the .icns. Without the file nothing changes and the build says so.
 */
const { copyFileSync, existsSync } = require('node:fs');
const { join } = require('node:path');
const { spawnSync } = require('node:child_process');

const ICON_NAME = 'AppIcon';

module.exports = async (context) => {
    if (context.electronPlatformName !== 'darwin') return;
    const car = join(__dirname, '..', 'resources', 'icons', 'Assets.car');
    const app = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
    if (!existsSync(car)) {
        console.log(`  • no resources/icons/Assets.car: macOS 26 shows the .icns on its own plate (npm run icon:tahoe makes the file)`);
        return;
    }
    copyFileSync(car, join(app, 'Contents', 'Resources', 'Assets.car'));
    const plist = join(app, 'Contents', 'Info.plist');
    const result = spawnSync('/usr/libexec/PlistBuddy', ['-c', `Add :CFBundleIconName string ${ICON_NAME}`, plist], { encoding: 'utf8' });
    if (result.status !== 0) {
        // Already there (a rebuild in place): set it instead.
        spawnSync('/usr/libexec/PlistBuddy', ['-c', `Set :CFBundleIconName ${ICON_NAME}`, plist], { stdio: 'inherit' });
    }
    console.log(`  • macOS 26 icon: Assets.car added, CFBundleIconName=${ICON_NAME} (${context.arch === 1 ? 'x64' : 'arm64'})`);
};
