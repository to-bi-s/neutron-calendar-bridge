/**
 * Proton's code uses Uint8Array.fromBase64 / toBase64 (ES2026). Node 22 does not have them yet;
 * newer runtimes (and Electron's Chromium) do, and the polyfill is a no-op there. Imported first
 * by every public module, so it is in place whatever is loaded first.
 */
import 'core-js/proposals/array-buffer-base64';
