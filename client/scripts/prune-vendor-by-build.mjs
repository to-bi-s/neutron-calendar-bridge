import { readdirSync, rmSync } from 'fs';
import { dirname, join, relative, resolve } from 'path';
import { fileURLToPath } from 'url';

import { build } from 'esbuild';

import { baseOptions, runtimeEntryPoints } from './esbuild-config.mjs';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(scriptDir, '..');
const vendorRoot = resolve(rootDir, 'vendor', '@proton');

const result = await build({
    ...baseOptions,
    entryPoints: { ...runtimeEntryPoints, 'smoke-test': 'scripts/smoke-test.ts' },
    logLevel: 'silent',
    metafile: true,
    outdir: resolve(rootDir, '.prune-vendor-tmp'),
    write: false,
});

const usedVendorFiles = new Set(
    Object.keys(result.metafile.inputs).filter((input) => input.startsWith('vendor/@proton/'))
);

const walkFiles = function* (dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const fullPath = join(dir, entry.name);
        if (entry.isDirectory()) {
            yield* walkFiles(fullPath);
        } else {
            yield fullPath;
        }
    }
};

const pruneEmptyDirectories = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isDirectory()) {
            continue;
        }
        const fullPath = join(dir, entry.name);
        pruneEmptyDirectories(fullPath);
    }

    if (dir === vendorRoot) {
        return;
    }

    if (readdirSync(dir).length === 0) {
        rmSync(dir, { recursive: true, force: true });
    }
};

let prunedFiles = 0;

for (const filePath of walkFiles(vendorRoot)) {
    const relativePath = relative(rootDir, filePath);
    if (relativePath.endsWith('package.json')) {
        continue;
    }
    if (usedVendorFiles.has(relativePath)) {
        continue;
    }
    rmSync(filePath, { force: true });
    prunedFiles++;
}

pruneEmptyDirectories(vendorRoot);

console.log(
    JSON.stringify(
        {
            usedVendorFiles: usedVendorFiles.size,
            prunedFiles,
        },
        null,
        2
    )
);
