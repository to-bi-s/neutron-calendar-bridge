/**
 * Additive vendoring: copy the Proton WebClients source files that the given seed files need
 * (their import closure) into vendor/, WITHOUT touching files that are already vendored.
 *
 * Same resolution rules as vendor-proton-workspace.mjs (which rebuilds vendor/ from scratch and
 * would undo the author's trimming). Use a WebClients checkout at the same commit the existing
 * vendor/ was taken from, so new files match the old ones.
 *
 *   WEBCLIENTS_ROOT=../../WebClients node scripts/vendor-add-proton-modules.mjs src/invitations.ts [--dry-run] [--keep-unused]
 *
 * After copying, files esbuild does not bundle (type-only or unused modules) are removed again,
 * like prune-vendor-by-build.mjs does (--keep-unused skips that).
 *
 * Prints what was added, which workspace files could not be found (e.g. a sparse checkout), and
 * which bare imports are left for npm (these must be dependencies in package.json).
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const clientRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const webClientsRoot = process.env.WEBCLIENTS_ROOT
    ? path.resolve(process.env.WEBCLIENTS_ROOT)
    : path.resolve(clientRoot, '../../WebClients');
const packagesRoot = path.join(webClientsRoot, 'packages');
const vendorRoot = path.join(clientRoot, 'vendor');
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const seeds = args.filter((arg) => !arg.startsWith('--')).map((seed) => path.resolve(clientRoot, seed));

if (!seeds.length) {
    throw new Error('Pass at least one seed file, e.g. src/invitations.ts');
}
if (!existsSync(packagesRoot)) {
    throw new Error(`No WebClients packages at ${packagesRoot}; set WEBCLIENTS_ROOT.`);
}

const packageRoots = new Map();
for (const entry of readdirSync(packagesRoot)) {
    const packageJsonPath = path.join(packagesRoot, entry, 'package.json');
    if (existsSync(packageJsonPath)) {
        const { name } = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
        if (name) packageRoots.set(name, path.dirname(packageJsonPath));
    }
}

const resolveFile = (basePath) => {
    for (const suffix of ['', '.ts', '.tsx', '.js', '.mjs', '.cjs']) {
        const candidate = `${basePath}${suffix}`;
        if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
    }
    for (const suffix of ['.ts', '.tsx', '.js', '.mjs', '.cjs']) {
        const candidate = path.join(basePath, `index${suffix}`);
        if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
    }
    return null;
};

/** Where a vendored copy of a workspace file lives (or null if it is not in a workspace package). */
const vendorPathFor = (file) => {
    for (const [packageName, packageRoot] of packageRoots) {
        if (file.startsWith(`${packageRoot}${path.sep}`)) {
            return { packageName, packageRoot, target: path.join(vendorRoot, ...packageName.split('/'), path.relative(packageRoot, file)) };
        }
    }
    return null;
};

/** Map a vendored file back to its WebClients source, so already-vendored files are traversed too. */
const sourcePathFor = (vendoredFile) => {
    for (const [packageName, packageRoot] of packageRoots) {
        const vendorPackageRoot = path.join(vendorRoot, ...packageName.split('/'));
        if (vendoredFile.startsWith(`${vendorPackageRoot}${path.sep}`)) {
            return path.join(packageRoot, path.relative(vendorPackageRoot, vendoredFile));
        }
    }
    return null;
};

const resolveImport = (specifier, fromFile) => {
    if (specifier.startsWith('.') || specifier.startsWith('/')) {
        // Relative imports inside vendor/ resolve against the WebClients source of that file.
        const fromSource = sourcePathFor(fromFile) ?? fromFile;
        return { kind: 'file', file: resolveFile(path.resolve(path.dirname(fromSource), specifier)), specifier };
    }
    for (const [packageName, packageRoot] of packageRoots) {
        if (specifier === packageName || specifier.startsWith(`${packageName}/`)) {
            const rest = specifier === packageName ? '' : specifier.slice(packageName.length + 1);
            const file = rest ? resolveFile(path.join(packageRoot, rest)) : resolveFile(path.join(packageRoot, 'lib/index.ts'));
            return { kind: 'file', file, specifier };
        }
    }
    return { kind: 'npm', specifier };
};

const importPattern = /(?:import|export)\s+(?:type\s+)?(?:[^'"`]*?from\s*)?['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)|require\(['"]([^'"]+)['"]\)/g;
const queue = [...seeds];
const visited = new Set();
const added = [];
const missing = new Set();
const npm = new Set();

while (queue.length) {
    const current = queue.pop();
    if (visited.has(current)) continue;
    visited.add(current);

    // Read the vendored copy when there is one (it may carry the author's local trims), else the source.
    const vendored = vendorPathFor(current)?.target;
    const readFrom = vendored && existsSync(vendored) ? vendored : current;
    const source = readFileSync(readFrom, 'utf8');

    let match;
    while ((match = importPattern.exec(source))) {
        const specifier = match[1] || match[2] || match[3];
        const resolved = resolveImport(specifier, readFrom);
        if (resolved.kind === 'npm') {
            npm.add(specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0]);
            continue;
        }
        if (!resolved.file) {
            missing.add(`${specifier}  (from ${path.relative(webClientsRoot, sourcePathFor(readFrom) ?? readFrom)})`);
            continue;
        }
        if (!visited.has(resolved.file)) queue.push(resolved.file);
    }

    const destination = vendorPathFor(current);
    if (destination && !existsSync(destination.target)) {
        added.push(path.relative(clientRoot, destination.target));
        if (!dryRun) {
            mkdirSync(path.dirname(destination.target), { recursive: true });
            copyFileSync(current, destination.target);
            const packageJson = path.join(vendorRoot, ...destination.packageName.split('/'), 'package.json');
            if (!existsSync(packageJson)) copyFileSync(path.join(destination.packageRoot, 'package.json'), packageJson);
        }
    }
}

/**
 * The import closure is static: it follows type-only imports and modules whose exports are
 * never used. Like prune-vendor-by-build.mjs, keep only what esbuild actually bundles — but
 * only among the files added now (already vendored files are never removed).
 */
const pruneUnusedAdditions = async () => {
    const { build } = await import('esbuild');
    const { baseOptions, runtimeEntryPoints } = await import('./esbuild-config.mjs');
    const entryPoints = { ...runtimeEntryPoints };
    seeds.forEach((seed, index) => {
        entryPoints[`seed-${index}`] = path.relative(clientRoot, seed);
    });
    const result = await build({
        ...baseOptions,
        entryPoints,
        logLevel: 'silent',
        metafile: true,
        outdir: path.join(clientRoot, '.vendor-add-tmp'),
        write: false,
    });
    const used = new Set(Object.keys(result.metafile.inputs).map((input) => path.normalize(input)));
    const kept = [];
    const removed = [];
    for (const file of added) {
        if (used.has(path.normalize(file))) {
            kept.push(file);
        } else {
            rmSync(path.join(clientRoot, file));
            removed.push(file);
        }
    }
    return { kept, removed };
};

let pruned = null;
if (!dryRun && added.length && !args.includes('--keep-unused')) {
    pruned = await pruneUnusedAdditions();
    added.splice(0, added.length, ...pruned.kept);
    // Drop directories the pruning emptied.
    const dropEmpty = (dir) => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
            if (entry.isDirectory()) dropEmpty(path.join(dir, entry.name));
        }
        if (dir !== vendorRoot && readdirSync(dir).length === 0) rmSync(dir, { recursive: true });
    };
    dropEmpty(vendorRoot);
}

const countFiles = (dir) =>
    readdirSync(dir, { withFileTypes: true }).reduce(
        (sum, entry) => sum + (entry.isDirectory() ? countFiles(path.join(dir, entry.name)) : 1),
        0
    );

if (!dryRun && added.length) {
    // Same shape as the manifest vendor-proton-workspace.mjs writes: per-package file counts
    // (package.json included), plus a log of what was added on top.
    const manifestPath = path.join(vendorRoot, 'manifest.json');
    const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')) : {};
    const packages = [];
    for (const packageName of packageRoots.keys()) {
        const vendorPackageRoot = path.join(vendorRoot, ...packageName.split('/'));
        if (existsSync(vendorPackageRoot)) {
            packages.push({ name: packageName, path: packageName, fileCount: countFiles(vendorPackageRoot) });
        }
    }
    packages.sort((a, b) => a.name.localeCompare(b.name));
    manifest.packageCount = packages.length;
    manifest.fileCount = packages.reduce((sum, entry) => sum + entry.fileCount, 0);
    manifest.packages = packages;
    manifest.additions = [
        ...(manifest.additions || []),
        { at: new Date().toISOString(), seeds: seeds.map((s) => path.relative(clientRoot, s)), files: added.sort() }
    ];
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

console.log(`${dryRun ? 'Would add' : 'Added'} ${added.length} file(s):`);
for (const file of added.sort()) console.log(`  + ${file}`);
if (pruned?.removed.length) {
    console.log(`\nNot used at runtime, so not kept (${pruned.removed.length}):`);
    for (const file of pruned.removed.sort()) console.log(`  - ${file}`);
}
if (missing.size) {
    console.log(`\nNot found in the WebClients checkout (${missing.size}):`);
    for (const entry of [...missing].sort()) console.log(`  ? ${entry}`);
}
console.log(`\nBare imports in the static closure (before pruning; runtime ones must be in package.json): ${[...npm].sort().join(', ')}`);
