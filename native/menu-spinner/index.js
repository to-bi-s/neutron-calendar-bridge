/**
 * Loads the menu-spinner native module (build/Release/menu_spinner.node, built by
 * scripts/build-native.mjs). Without a build — another platform, or the build failed — a no-op
 * stands in, so the app runs and the symbol in the menu simply stays still.
 */
'use strict';
const { join } = require('node:path');

const noop = {
    supported: false,
    setFrames: () => 0,
    setSpinning: () => undefined,
    updateItem: () => undefined,
    setKeepOpen: () => undefined,
    isTracking: () => false,
    error: null
};

let loaded = noop;
try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    loaded = require(join(__dirname, 'build', 'Release', 'menu_spinner.node'));
} catch (error) {
    loaded = { ...noop, error: error instanceof Error ? error.message : String(error) };
}

module.exports = loaded;
