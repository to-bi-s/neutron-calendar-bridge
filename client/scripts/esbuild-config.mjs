/**
 * The esbuild settings every script shares (the runtime build, pruning by build, the refresh
 * routine), so that what they bundle is the same thing: Node target, Proton's Sentry helper stubbed,
 * OpenPGP.js resolved to its Node build.
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Proton's Sentry helper reads `window.location` and crashes event decryption in Node
 * (the "legacy signature" fallback merely tries to log, and that throws). Whatever the
 * import looks like ('./sentry', '../helpers/sentry', '@proton/shared/lib/helpers/sentry'),
 * resolve it and swap the helper for a no-op stub. Also keeps the Sentry SDK out of the bundle.
 */
export const sentryStubPlugin = {
    name: 'stub-proton-sentry',
    setup(build) {
        const stub = resolve(rootDir, 'src/shims/sentry.ts');
        const sentryHelper = resolve(rootDir, 'vendor/@proton/shared/lib/helpers/sentry');
        // By path, not by resolving: the helper itself is not vendored (nothing but the stub is bundled).
        build.onResolve({ filter: /sentry$/ }, (args) => {
            if (!args.importer) {
                return null;
            }
            const target = args.path.startsWith('.')
                ? resolve(args.resolveDir, args.path)
                : args.path === '@proton/shared/lib/helpers/sentry'
                  ? sentryHelper
                  : null;
            return target === sentryHelper ? { path: stub } : null;
        });
    },
};

/**
 * Proton's crypto package imports OpenPGP.js as `openpgp/lightweight` (a browser-only export of
 * Proton's fork); for Node the full build is the right one (same API, no lazy loading).
 */
export const openpgpNodePlugin = {
    name: 'openpgp-node-build',
    setup(build) {
        build.onResolve({ filter: /^openpgp\/lightweight$/ }, (args) =>
            build.resolve('openpgp', { kind: args.kind, importer: args.importer, resolveDir: args.resolveDir })
        );
    },
};

export const plugins = [sentryStubPlugin, openpgpNodePlugin];

/** Vendored modules the build replaces with stubs (vendor-relative, without extension): never vendored. */
export const stubbedVendorModules = ['vendor/@proton/shared/lib/helpers/sentry'];

/** Everything but entryPoints, outdir and write. */
export const baseOptions = {
    absWorkingDir: rootDir,
    bundle: true,
    conditions: ['node', 'default'],
    format: 'esm',
    legalComments: 'none',
    mainFields: ['module', 'main'],
    platform: 'node',
    plugins,
    splitting: true,
    target: 'node20',
    tsconfig: resolve(rootDir, 'tsconfig.json'),
};

/** The library's entry points (what dist/ holds). */
export const runtimeEntryPoints = {
    index: 'src/index.ts',
    'proton-calendar-api': 'src/proton-calendar-api.ts',
    'proton-cli': 'src/proton-cli.ts',
    'proton-daemon': 'src/proton-daemon.ts',
};
