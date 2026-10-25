import { mkdirSync, rmSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

import { build } from 'esbuild';

import { baseOptions, runtimeEntryPoints } from './esbuild-config.mjs';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(scriptDir, '..');
const outdir = resolve(rootDir, 'dist');

rmSync(outdir, { recursive: true, force: true });
mkdirSync(outdir, { recursive: true });

/**
 * Some bundled CommonJS dependencies require Node built-ins (e.g. iconv-lite, used by the MIME
 * builder for signed emails, requires "stream"). esbuild's ESM output has no `require`, so give
 * every output file one.
 */
const requireBanner = "import { createRequire as __pccCreateRequire } from 'module'; const require = __pccCreateRequire(import.meta.url);";

await build({
    ...baseOptions,
    banner: { js: requireBanner },
    entryPoints: {
        ...runtimeEntryPoints,
        'smoke-test': 'scripts/smoke-test.ts',
        'series-roundtrip-test': 'scripts/series-roundtrip-test.ts',
        'participants-test': 'scripts/participants-test.ts',
        'invitations-test': 'scripts/invitations-test.ts',
        'organizer-test': 'scripts/organizer-test.ts',
        'organizer-series-test': 'scripts/organizer-series-test.ts',
        'emailed-answers-test': 'scripts/emailed-answers-test.ts',
        'calendar-emails-test': 'scripts/calendar-emails-test.ts',
        'session-test': 'scripts/session-test.ts',
        'state-files-test': 'scripts/state-files-test.ts',
        'change-feed-test': 'scripts/change-feed-test.ts',
        'sign-in-test': 'scripts/sign-in-test.ts',
        'invitation-language-test': 'scripts/invitation-language-test.ts',
        'reminders-test': 'scripts/reminders-test.ts',
        'busy-test': 'scripts/busy-test.ts',
        'video-links-test': 'scripts/video-links-test.ts',
        'zones-test': 'scripts/zones-test.ts',
        'calendar-colours-test': 'scripts/calendar-colours-test.ts',
        'app-identity-test': 'scripts/app-identity-test.ts',
    },
    logLevel: 'info',
    outExtension: { '.js': '.mjs' },
    outdir,
    sourcemap: false,
});
