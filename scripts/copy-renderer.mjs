import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '..');
const rendererSource = resolve(repoRoot, 'src', 'renderer');
const rendererTarget = resolve(repoRoot, 'dist', 'renderer');

if (!existsSync(rendererTarget)) {
  mkdirSync(rendererTarget, { recursive: true });
}

cpSync(rendererSource, rendererTarget, { recursive: true });

// The app's translations (0.32): src/locales/<code>.json → dist/locales, read by the main process.
const localesSource = resolve(repoRoot, 'src', 'locales');
const localesTarget = resolve(repoRoot, 'dist', 'locales');
if (existsSync(localesSource)) {
  mkdirSync(localesTarget, { recursive: true });
  cpSync(localesSource, localesTarget, { recursive: true });
}
