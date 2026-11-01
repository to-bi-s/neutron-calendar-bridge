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
const { copyFileSync, existsSync, renameSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { spawnSync } = require('node:child_process');

const ICON_NAME = 'AppIcon';

module.exports = async (context) => {
    if (context.electronPlatformName === 'linux') return linuxLauncher(context);
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

/**
 * 1.0.6 (Linux): the executable becomes a small launcher in front of the real one (`<name>.bin`). Inside
 * an AppImage on Ubuntu 24.04 and later, Chromium's sandbox cannot be set up (AppArmor keeps unprivileged
 * user namespaces from the app, and the SUID helper cannot be used from an AppImage mount): started by a
 * double-click the app died with a sandbox error before showing anything. The launcher adds --no-sandbox
 * there, as the AppImage's desktop entry already does when it is integrated. Installed from the .deb the
 * sandbox stays on. Child processes come from /proc/self/exe, so the .bin name changes nothing for them.
 */
const linuxLauncher = (context) => {
    const name = context.packager.executableName;
    const binary = join(context.appOutDir, name);
    const real = join(context.appOutDir, `${name}.bin`);
    if (!existsSync(binary) || existsSync(real)) return;
    renameSync(binary, real);
    writeFileSync(
        binary,
        `#!/bin/sh
# Neutron Calendar Bridge: in an AppImage the Chromium sandbox cannot be set up (Ubuntu 24.04 and later),
# so the app runs without it there. Installed from the .deb the sandbox stays on.
dir=$(dirname "$(readlink -f "$0")")
if [ -n "$APPIMAGE" ]; then
    case " $* " in
        *" --no-sandbox "*) ;;
        *) set -- --no-sandbox "$@" ;;
    esac
fi
exec "$dir/${name}.bin" "$@"
`,
        { mode: 0o755 }
    );
    console.log(`  • Linux launcher: ${name} → ${name}.bin (--no-sandbox inside an AppImage)`);
};
