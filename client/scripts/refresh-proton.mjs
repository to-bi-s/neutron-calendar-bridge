#!/usr/bin/env node
/**
 * Refresh the vendored Proton code (vendor/@proton) from a newer WebClients commit — the routine
 * of roadmap stage 4 (WP11), to run monthly or when Proton changes something the client relies on.
 *
 *   node scripts/refresh-proton.mjs                      report only: what a refresh would change
 *   node scripts/refresh-proton.mjs --apply              do it (merge, add, prune, manifest, check)
 *   node scripts/refresh-proton.mjs --to <ref>           a WebClients commit, branch or tag (default: origin/main)
 *   node scripts/refresh-proton.mjs --webclients <dir>   a WebClients checkout to use (default: ../../WebClients, beside the repository,
 *                                                        cloned with --filter=blob:none if missing)
 *   node scripts/refresh-proton.mjs --apply --no-check   skip `npm run check` at the end
 *   node scripts/refresh-proton.mjs --apply --no-prune   keep vendored files the build does not use
 *
 * What it does (every step is in the report, vendor/REFRESH.md, and on the terminal):
 *   1. Pins: the commit the vendored files come from is `upstream.commit` in vendor/manifest.json;
 *      files that differ from it are local trims (`trims`), kept across refreshes by a three-way
 *      merge (git merge-file: ours = vendored, base = upstream then, theirs = upstream now).
 *      Conflicts are left marked (<<<<<<< ours … >>>>>>> upstream) and listed: resolve them by hand.
 *   2. Files upstream moved are followed (git rename detection); files upstream deleted are
 *      removed when untrimmed, and listed with the sources that import them.
 *   3. The import closure of src/*.ts is walked again against the new checkout: files now needed
 *      are added, bare imports that are not in package.json are listed, unresolved imports too.
 *   4. A build with the metafile prunes vendored files nothing bundles (only after a clean build).
 *   5. Versions: the dependencies WebClients resolves (pnpm-lock.yaml) against package.json and
 *      vendor-external. (The library presents its own identity since 0.50; the app versions it used
 *      to borrow went with the parked sign-in code, outside this repository.)
 *   6. API routes the client uses (src/**): the upstream diff hunks of @proton/shared/lib/api that
 *      mention them, so a changed endpoint is seen.
 *   7. manifest.json: upstream commit and date, files, trims; the invitation email translations
 *      extracted from the same commit (scripts/extract-invitation-locales.mjs); then `npm run check`.
 *
 * Nothing is fetched from anywhere but github.com (WebClients);
 * the test accounts are not used (run `npm run test:live` after a refresh). A report-only run leaves
 * vendor/ alone but does check out the target commit in the WebClients working tree (sparse) and
 * writes .refresh-report.md; vendor/REFRESH.md is the report of the last applied refresh.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const clientRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const vendorRoot = path.join(clientRoot, 'vendor');
const manifestPath = path.join(vendorRoot, 'manifest.json');
const reportPath = path.join(vendorRoot, 'REFRESH.md');
const UPSTREAM_REPOSITORY = 'https://github.com/ProtonMail/WebClients';

// ---------------------------------------------------------------------------------------------
// Arguments

const args = process.argv.slice(2);
const option = (name) => {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] : undefined;
};
const apply = args.includes('--apply');
const runCheck = !args.includes('--no-check');
const prune = !args.includes('--no-prune');
const targetRef = option('--to') || 'origin/main';
const webClientsRoot = path.resolve(option('--webclients') || process.env.WEBCLIENTS_ROOT || path.join(clientRoot, '..', '..', 'WebClients'));
for (const arg of args) {
    if (arg.startsWith('--') && !['--apply', '--no-check', '--no-prune', '--to', '--webclients'].includes(arg)) {
        console.error(`Unknown option ${arg}`);
        process.exit(2);
    }
}

// ---------------------------------------------------------------------------------------------
// Helpers

const git = (gitArgs, options = {}) =>
    execFileSync('git', gitArgs, { cwd: webClientsRoot, encoding: 'utf8', maxBuffer: 512 * 1024 * 1024, stdio: ['ignore', 'pipe', options.quiet ? 'ignore' : 'inherit'], ...options });
const gitTry = (gitArgs) => {
    const result = spawnSync('git', gitArgs, { cwd: webClientsRoot, encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 });
    return result.status === 0 ? result.stdout : null;
};
/** A file's content at a commit (Buffer), null when it does not exist there; any other git failure aborts (a blob-less clone fetches on demand). */
const gitShow = (commit, filePath) => {
    const result = spawnSync('git', ['show', `${commit}:${filePath}`], { cwd: webClientsRoot, maxBuffer: 512 * 1024 * 1024 });
    if (result.status === 0) return result.stdout;
    const message = result.stderr?.toString() || '';
    if (/does not exist in|exists on disk, but not in|invalid object name|is in the index, but not at stage|not a tree/.test(message)) return null;
    throw new Error(`git show ${commit}:${filePath} failed: ${message.trim() || `status ${result.status}`}`);
};
const relative = (file) => path.relative(clientRoot, file);
const walk = function* (dir) {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) yield* walk(full);
        else yield full;
    }
};
const dropEmptyDirectories = (dir) => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) dropEmptyDirectories(path.join(dir, entry.name));
    }
    if (dir !== vendorRoot && readdirSync(dir).length === 0) rmSync(dir, { recursive: true });
};
const lines = [];
const say = (text = '') => {
    console.log(text);
    lines.push(text);
};
const section = (title) => say(`\n## ${title}\n`);

// ---------------------------------------------------------------------------------------------
// 1. The checkout, the two commits

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const baseCommit = manifest.upstream?.commit;
if (!baseCommit) {
    console.error('vendor/manifest.json has no upstream.commit: the commit the vendored files come from must be known first.');
    process.exit(2);
}

if (!existsSync(path.join(webClientsRoot, '.git'))) {
    console.log(`Cloning ${UPSTREAM_REPOSITORY} into ${webClientsRoot} (history without file contents; contents are fetched as needed) …`);
    mkdirSync(path.dirname(webClientsRoot), { recursive: true });
    execFileSync('git', ['clone', '--filter=blob:none', '--no-checkout', UPSTREAM_REPOSITORY, webClientsRoot], { stdio: 'inherit' });
    git(['config', 'gc.auto', '0']); // a blob-less clone would otherwise start packing on every fetch
    git(['sparse-checkout', 'init', '--cone']);
}
if (targetRef.startsWith('origin/')) {
    console.log(`Fetching ${targetRef} …`);
    git(['fetch', '--quiet', 'origin', targetRef.slice('origin/'.length)]);
}
const targetCommit = (gitTry(['rev-parse', '--verify', `${targetRef}^{commit}`]) || gitTry(['rev-parse', '--verify', `origin/${targetRef}^{commit}`]) || '').trim();
if (!targetCommit) {
    console.error(`Cannot resolve ${targetRef} in ${webClientsRoot}`);
    process.exit(2);
}
if (gitTry(['cat-file', '-e', `${baseCommit}^{commit}`]) === null) {
    console.log(`Fetching the pinned commit ${baseCommit} …`);
    git(['fetch', '--quiet', 'origin', baseCommit]);
}
const commitDate = (commit) => git(['log', '-1', '--format=%cs', commit], { quiet: true }).trim();
const shortCommit = (commit) => commit.slice(0, 10);
const targetDate = commitDate(targetCommit);
const baseDate = commitDate(baseCommit);

say(`# Proton code refresh — ${new Date().toISOString().slice(0, 10)}`);
say('');
say(`From WebClients ${shortCommit(baseCommit)} (${baseDate}) to ${shortCommit(targetCommit)} (${targetDate}, ${targetRef}). ${apply ? 'Applied.' : 'Report only (run with --apply to do it).'}`);

/** package name → directory under packages/ at a commit (from each package.json), e.g. @proton/shared → packages/shared. */
const packageDirectories = (commit) => {
    const map = new Map();
    for (const entry of git(['ls-tree', '--name-only', commit, 'packages/'], { quiet: true }).trim().split('\n')) {
        const packageJson = gitShow(commit, `${entry}/package.json`);
        if (!packageJson) continue;
        try {
            const { name } = JSON.parse(packageJson.toString('utf8'));
            if (name) map.set(name, entry);
        } catch {
            // not a package
        }
    }
    return map;
};
const baseDirectories = packageDirectories(baseCommit);
const targetDirectories = packageDirectories(targetCommit);
const targetPackageByDirectory = new Map([...targetDirectories].map(([name, dir]) => [dir, name]));

/** The working tree at the target commit, with the packages needed checked out (sparse, cone). */
const checkedOut = new Set();
const ensureCheckedOut = (directories) => {
    const wanted = directories.filter((dir) => !checkedOut.has(dir));
    if (!wanted.length && (gitTry(['rev-parse', 'HEAD']) ?? '').trim() === targetCommit) return;
    wanted.forEach((dir) => checkedOut.add(dir));
    git(['sparse-checkout', 'set', ...checkedOut], { quiet: true });
    git(['checkout', '--quiet', '--detach', targetCommit], { quiet: true });
};
const vendoredPackageNames = [...new Set([...walk(path.join(vendorRoot, '@proton'))].map((file) => `@proton/${path.relative(path.join(vendorRoot, '@proton'), file).split(path.sep)[0]}`))];
ensureCheckedOut(vendoredPackageNames.map((name) => targetDirectories.get(name)).filter(Boolean));

// ---------------------------------------------------------------------------------------------
// 2. Upstream's changes to the vendored files: renames, deletions, three-way merge

/** Where a vendored file lives: vendor/@proton/<package dir name>/<rel> ↔ packages/<dir>/<rel>. */
const vendoredToUpstream = (vendoredFile, directories) => {
    const rel = path.relative(path.join(vendorRoot, '@proton'), vendoredFile).split(path.sep);
    const packageName = `@proton/${rel[0]}`;
    const dir = directories.get(packageName);
    return dir ? { packageName, upstreamPath: path.posix.join(dir, ...rel.slice(1)) } : null;
};
const upstreamToVendored = (upstreamPath) => {
    const dir = [...targetPackageByDirectory.keys()].find((candidate) => upstreamPath.startsWith(`${candidate}/`));
    if (!dir) return null;
    const packageName = targetPackageByDirectory.get(dir);
    return path.join(vendorRoot, ...packageName.split('/'), ...upstreamPath.slice(dir.length + 1).split('/'));
};

const renames = new Map();
const deleted = new Set();
for (const line of git(['diff', '-M', '--name-status', '--diff-filter=RD', baseCommit, targetCommit, '--', 'packages/'], { quiet: true }).trim().split('\n')) {
    if (!line) continue;
    const [status, from, to] = line.split('\t');
    if (status.startsWith('R')) renames.set(from, to);
    else if (status === 'D') deleted.add(from);
}

const vendoredFiles = [...walk(path.join(vendorRoot, '@proton'))].filter((file) => path.basename(file) !== 'package.json');
const merged = { unchanged: [], updated: [], moved: [], trimmedKept: [], conflicts: [], removed: [], removedButTrimmed: [], unknown: [], notAtBase: [] };
const newTrims = new Set();
const writes = []; // { target, content } applied with --apply
const removals = new Set();

for (const vendoredFile of vendoredFiles) {
    const mapping = vendoredToUpstream(vendoredFile, baseDirectories);
    if (!mapping) {
        merged.unknown.push(relative(vendoredFile));
        continue;
    }
    const ours = readFileSync(vendoredFile);
    const base = gitShow(baseCommit, mapping.upstreamPath);
    const upstreamNow = renames.get(mapping.upstreamPath) || (deleted.has(mapping.upstreamPath) ? null : mapping.upstreamPath);
    const theirs = upstreamNow ? gitShow(targetCommit, upstreamNow) : null;
    const trimmed = base ? !ours.equals(base) : true;
    const destination = upstreamNow ? upstreamToVendored(upstreamNow) : null;

    if (!theirs || !destination) {
        if (trimmed) {
            merged.removedButTrimmed.push(relative(vendoredFile));
            newTrims.add(relative(vendoredFile));
        } else {
            merged.removed.push(relative(vendoredFile));
            removals.add(vendoredFile);
        }
        continue;
    }
    const movedNote = destination !== vendoredFile ? ` → ${relative(destination)}` : '';
    if (destination !== vendoredFile) {
        removals.add(vendoredFile);
        merged.moved.push(`${relative(vendoredFile)}${movedNote}`);
    }
    if (!base) {
        // Not at the pinned commit (added by hand from elsewhere?): kept as it is, to be looked at.
        merged.notAtBase.push(`${relative(vendoredFile)}${movedNote}${theirs.equals(ours) ? ' (equal to upstream now)' : ''}`);
        newTrims.add(relative(destination));
        writes.push({ target: destination, content: ours });
        continue;
    }
    if (!trimmed) {
        if (!theirs.equals(ours)) merged.updated.push(`${relative(vendoredFile)}${movedNote}`);
        else if (destination === vendoredFile) merged.unchanged.push(relative(vendoredFile));
        writes.push({ target: destination, content: theirs });
        continue;
    }
    if (theirs.equals(base)) {
        // Upstream did not touch it: our trimmed copy stays as it is.
        merged.trimmedKept.push(`${relative(vendoredFile)}${movedNote}`);
        newTrims.add(relative(destination));
        writes.push({ target: destination, content: ours });
        continue;
    }
    // Both sides changed: three-way merge.
    const scratch = path.join(clientRoot, '.refresh-tmp');
    mkdirSync(scratch, { recursive: true });
    const [oursFile, baseFile, theirsFile] = ['ours', 'base', 'theirs'].map((name) => path.join(scratch, name));
    writeFileSync(oursFile, ours);
    writeFileSync(baseFile, base);
    writeFileSync(theirsFile, theirs);
    const result = spawnSync('git', ['merge-file', '-p', '-L', 'ours (vendored, trimmed)', '-L', `upstream ${shortCommit(baseCommit)}`, '-L', `upstream ${shortCommit(targetCommit)}`, oursFile, baseFile, theirsFile], { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 });
    rmSync(scratch, { recursive: true, force: true });
    newTrims.add(relative(destination));
    writes.push({ target: destination, content: result.stdout });
    if (result.status > 0) {
        merged.conflicts.push(`${relative(vendoredFile)}${movedNote} (${result.status} conflict${result.status === 1 ? '' : 's'})`);
    } else if (result.status === 0) {
        merged.updated.push(`${relative(vendoredFile)}${movedNote} (trimmed; merged)`);
    } else {
        merged.conflicts.push(`${relative(vendoredFile)}${movedNote} (merge failed: ${result.stderr?.toString() || 'unknown'})`);
    }
}

section('Vendored files');
say(`${vendoredFiles.length} files: ${merged.unchanged.length} unchanged upstream, ${merged.updated.length} updated, ${merged.moved.length} moved, ${merged.trimmedKept.length} trimmed and untouched upstream, ${merged.conflicts.length} with merge conflicts, ${merged.removed.length} removed upstream, ${merged.removedButTrimmed.length} removed upstream but trimmed here (kept).`);
const list = (title, entries) => {
    if (!entries.length) return;
    say(`\n${title}:`);
    entries.forEach((entry) => say(`- ${entry}`));
};
list('Merge conflicts (resolve by hand, markers are in the files)', merged.conflicts);
list('Removed upstream (deleted here; check the importers below)', merged.removed);
list('Removed upstream but trimmed here (kept; probably obsolete)', merged.removedButTrimmed);
list('Moved upstream', merged.moved);
list('Trimmed, unchanged upstream', merged.trimmedKept);
list('Updated (trimmed and merged ones marked)', merged.updated.filter((entry) => entry.includes('merged')));
list('Not under a known package (left alone)', merged.unknown);
list('Not at the pinned commit (kept as they are; added from elsewhere?)', merged.notAtBase);

if (apply) {
    for (const file of removals) rmSync(file, { force: true });
    for (const { target, content } of writes) {
        mkdirSync(path.dirname(target), { recursive: true });
        writeFileSync(target, content);
    }
    for (const packageName of vendoredPackageNames) {
        const dir = targetDirectories.get(packageName);
        const packageJson = dir ? gitShow(targetCommit, `${dir}/package.json`) : null;
        if (packageJson) writeFileSync(path.join(vendorRoot, ...packageName.split('/'), 'package.json'), packageJson);
    }
    dropEmptyDirectories(path.join(vendorRoot, '@proton'));
}

// ---------------------------------------------------------------------------------------------
// 3. The import closure of src/*.ts against the new checkout

const fileCandidates = ['', '.ts', '.tsx', '.js', '.mjs', '.cjs'];
const resolveFile = (basePath) => {
    for (const suffix of fileCandidates) {
        const candidate = `${basePath}${suffix}`;
        if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
    }
    for (const suffix of fileCandidates.slice(1)) {
        const candidate = path.join(basePath, `index${suffix}`);
        if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
    }
    return null;
};
/** Subpath of a workspace package per its package.json "exports" (e.g. @proton/utils/noop → src/noop.ts), else the path itself. */
const exportsCache = new Map();
const packageSubpath = (packageName, rest) => {
    if (!exportsCache.has(packageName)) {
        const dir = targetDirectories.get(packageName);
        const packageJsonPath = path.join(webClientsRoot, dir, 'package.json');
        if (!existsSync(packageJsonPath)) {
            return rest || null; // not checked out yet: looked at again once it is
        }
        let exportsMap = null;
        try {
            exportsMap = JSON.parse(readFileSync(packageJsonPath, 'utf8')).exports ?? null;
        } catch {
            exportsMap = null;
        }
        exportsCache.set(packageName, exportsMap);
    }
    const exportsMap = exportsCache.get(packageName);
    if (!exportsMap || typeof exportsMap !== 'object') return rest || null;
    const key = rest ? `./${rest}` : '.';
    const pick = (value) => (typeof value === 'string' ? value : value?.import || value?.default || value?.require || Object.values(value || {}).find((entry) => typeof entry === 'string'));
    if (exportsMap[key]) return pick(exportsMap[key])?.replace(/^\.\//, '') ?? rest;
    for (const [pattern, value] of Object.entries(exportsMap)) {
        if (!pattern.includes('*')) continue;
        const [head, tail] = pattern.split('*');
        if (key.startsWith(head) && key.endsWith(tail)) {
            const star = key.slice(head.length, key.length - tail.length);
            return pick(value)?.replace('*', star).replace(/^\.\//, '') ?? rest;
        }
    }
    return rest || null;
};
const upstreamSourceOfVendored = (vendoredFile) => {
    const mapping = vendoredToUpstream(vendoredFile, targetDirectories);
    return mapping ? path.join(webClientsRoot, mapping.upstreamPath) : null;
};
const vendoredOfUpstreamSource = (sourceFile) => upstreamToVendored(path.relative(webClientsRoot, sourceFile).split(path.sep).join('/'));

const resolveImport = (specifier, fromFile) => {
    if (specifier.startsWith('.') || specifier.startsWith('/')) {
        const fromSource = fromFile.startsWith(vendorRoot) ? upstreamSourceOfVendored(fromFile) ?? fromFile : fromFile;
        return { kind: 'file', file: resolveFile(path.resolve(path.dirname(fromSource), specifier)) };
    }
    for (const [packageName, dir] of targetDirectories) {
        if (specifier === packageName || specifier.startsWith(`${packageName}/`)) {
            const rest = specifier === packageName ? '' : specifier.slice(packageName.length + 1);
            const subpath = packageSubpath(packageName, rest);
            let file = subpath ? resolveFile(path.join(webClientsRoot, dir, subpath)) : null;
            if (!file && !rest) {
                let packageJson = {};
                try {
                    packageJson = JSON.parse(readFileSync(path.join(webClientsRoot, dir, 'package.json'), 'utf8'));
                } catch {
                    // keep the defaults
                }
                file = resolveFile(path.join(webClientsRoot, dir, packageJson.module || packageJson.main || 'lib/index.ts')) || resolveFile(path.join(webClientsRoot, dir, 'lib/index.ts')) || resolveFile(path.join(webClientsRoot, dir, 'src/index.ts'));
            }
            return { kind: 'file', file, packageName };
        }
    }
    return { kind: 'npm' };
};

/** Imports and re-exports; `import type` / `export type` (erased by the bundler) are matched too and skipped. */
const importPattern = /(?:import|export)\s+(type\s+)?(?:[^'"`]*?from\s*)?['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)|require\(['"]([^'"]+)['"]\)/g;
const { stubbedVendorModules } = await import('./esbuild-config.mjs');
const seeds = readdirSync(path.join(clientRoot, 'src')).filter((name) => name.endsWith('.ts')).map((name) => path.join(clientRoot, 'src', name));
/** The merged content a vendored file will have after --apply (in report mode the file on disk is still the old one). */
const pendingContent = new Map(writes.map((write) => [write.target, write.content]));
/** For an import that no longer resolves: where upstream moved the file, if it did. */
const movedHint = (specifier, fromFile) => {
    let basePath = null;
    if (specifier.startsWith('.')) {
        const mapping = fromFile.startsWith(vendorRoot) ? vendoredToUpstream(fromFile, baseDirectories) : null;
        if (mapping) basePath = path.posix.normalize(path.posix.join(path.posix.dirname(mapping.upstreamPath), specifier));
    } else {
        for (const [packageName, dir] of baseDirectories) {
            if (specifier.startsWith(`${packageName}/`)) basePath = path.posix.join(dir, specifier.slice(packageName.length + 1));
        }
    }
    if (!basePath) return '';
    const moved = [...renames].find(([from]) => from === basePath || from.replace(/\.[cm]?[jt]sx?$/, '') === basePath);
    if (moved) {
        const dir = [...targetPackageByDirectory.keys()].find((candidate) => moved[1].startsWith(`${candidate}/`));
        const asImport = dir ? `${targetPackageByDirectory.get(dir)}/${moved[1].slice(dir.length + 1).replace(/\.[cm]?[jt]sx?$/, '')}` : moved[1];
        return ` — moved upstream to ${asImport}`;
    }
    return deleted.has(basePath) || [...deleted].some((file) => file.replace(/\.[cm]?[jt]sx?$/, '') === basePath) ? ' — deleted upstream' : '';
};
const needed = new Map(); // vendored path → upstream source
const npmImports = new Map(); // package → importers
const unresolved = [];
const importersOf = new Map(); // relative upstream path → importers (for the "removed upstream" list)
const visited = new Set();
const queue = [...seeds];
while (queue.length) {
    const current = queue.pop();
    if (visited.has(current)) continue;
    visited.add(current);
    // After --apply the vendored copy is the merged one (with trims); before, read it too, so trims count.
    const vendored = current.startsWith(webClientsRoot) ? vendoredOfUpstreamSource(current) : null;
    const pending = vendored ? pendingContent.get(vendored) : null;
    const readFrom = vendored && (pending || existsSync(vendored)) ? vendored : current;
    let source;
    try {
        source = pending ? pending.toString('utf8') : readFileSync(readFrom, 'utf8');
    } catch {
        continue;
    }
    const importer = relative(readFrom);
    let match;
    while ((match = importPattern.exec(source))) {
        if (match[1]) continue; // type only
        const specifier = match[2] || match[3] || match[4];
        if (/^[a-z][a-z0-9+.-]*:/i.test(specifier) && !specifier.startsWith('node:')) continue; // a URL in a comment or string
        const resolved = resolveImport(specifier, readFrom);
        if (resolved.kind === 'npm') {
            const name = specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0];
            if (!npmImports.has(name)) npmImports.set(name, new Set());
            npmImports.get(name).add(importer);
            continue;
        }
        if (!resolved.file) {
            // A package not checked out yet? Check it out and try once more.
            if (resolved.packageName && !checkedOut.has(targetDirectories.get(resolved.packageName))) {
                ensureCheckedOut([targetDirectories.get(resolved.packageName)]);
                const retry = resolveImport(specifier, readFrom);
                if (retry.file) {
                    if (!visited.has(retry.file)) queue.push(retry.file);
                    continue;
                }
            }
            unresolved.push(`${specifier} (from ${importer})${movedHint(specifier, readFrom)}`);
            continue;
        }
        const asVendored = vendoredOfUpstreamSource(resolved.file);
        if (asVendored && stubbedVendorModules.some((stub) => relative(asVendored).replace(/\.[cm]?[jt]sx?$/, '') === stub)) continue; // the build stubs it
        if (!importersOf.has(resolved.file)) importersOf.set(resolved.file, new Set());
        importersOf.get(resolved.file).add(importer);
        if (!visited.has(resolved.file)) queue.push(resolved.file);
    }
    if (current.startsWith(webClientsRoot)) {
        const destination = vendoredOfUpstreamSource(current);
        if (destination) needed.set(destination, current);
    }
}

const vendoredAfter = new Set([...writes.map((write) => write.target), ...vendoredFiles.filter((file) => !removals.has(file))]);
const additions = [...needed.keys()].filter((file) => !vendoredAfter.has(file)).sort();
section('Import closure of src/*.ts');
say(`${needed.size} Proton files needed; ${additions.length} not vendored yet.`);
list('To add', additions.map(relative));
list('Unresolved imports (a file missing upstream, or a package not vendored)', [...new Set(unresolved)]);
const packageJson = JSON.parse(readFileSync(path.join(clientRoot, 'package.json'), 'utf8'));
const declared = new Set([...Object.keys(packageJson.dependencies || {}), ...Object.keys(packageJson.devDependencies || {})]);
const builtins = new Set(['fs', 'path', 'os', 'url', 'crypto', 'util', 'stream', 'events', 'buffer', 'child_process', 'module', 'readline', 'http', 'https', 'zlib', 'assert', 'worker_threads', 'perf_hooks', 'string_decoder', 'tty', 'net', 'dns', 'tls', 'process']);
const bareMissing = [...npmImports].filter(([name]) => !declared.has(name) && !builtins.has(name.replace(/^node:/, '')) && !name.startsWith('node:'));
list('Bare imports not in package.json (npm dependencies to add, or modules to vendor/stub)', bareMissing.map(([name, importers]) => `${name} — from ${[...importers].slice(0, 4).join(', ')}${importers.size > 4 ? ` and ${importers.size - 4} more` : ''}`));
const removedImporters = merged.removed
    .map((removedFile) => {
        const source = upstreamSourceOfVendored(path.join(clientRoot, removedFile));
        const baseSource = path.join(webClientsRoot, vendoredToUpstream(path.join(clientRoot, removedFile), baseDirectories)?.upstreamPath || '');
        const importers = importersOf.get(source) || importersOf.get(baseSource);
        return importers ? `${removedFile} — imported by ${[...importers].join(', ')}` : null;
    })
    .filter(Boolean);
list('Removed upstream and still imported (the code must change)', removedImporters);

if (apply) {
    for (const [destination, source] of needed) {
        if (vendoredAfter.has(destination)) continue;
        mkdirSync(path.dirname(destination), { recursive: true });
        copyFileSync(source, destination);
        const packageName = targetPackageByDirectory.get([...targetPackageByDirectory.keys()].find((dir) => path.relative(webClientsRoot, source).split(path.sep).join('/').startsWith(`${dir}/`)));
        const packageJsonTarget = path.join(vendorRoot, ...packageName.split('/'), 'package.json');
        if (!existsSync(packageJsonTarget)) copyFileSync(path.join(webClientsRoot, targetDirectories.get(packageName), 'package.json'), packageJsonTarget);
    }
}

// ---------------------------------------------------------------------------------------------
// 3b. tsconfig paths: a vendored package that maps its exports into a folder (e.g. @proton/utils/noop
//     → src/noop.ts) needs "<package>/*": ["vendor/<package>/<folder>/*"] before the generic "@proton/*".

const tsconfigPath = path.join(clientRoot, 'tsconfig.json');
const tsconfig = JSON.parse(readFileSync(tsconfigPath, 'utf8'));
const paths = tsconfig.compilerOptions.paths || {};
const pathsToAdd = [];
for (const packageName of new Set([...vendoredPackageNames, ...[...needed.keys()].map((file) => `@proton/${path.relative(path.join(vendorRoot, '@proton'), file).split(path.sep)[0]}`)])) {
    const dir = targetDirectories.get(packageName);
    if (!dir) continue;
    let exportsMap = null;
    try {
        exportsMap = JSON.parse((gitShow(targetCommit, `${dir}/package.json`) || '{}').toString('utf8')).exports;
    } catch {
        exportsMap = null;
    }
    if (!exportsMap || typeof exportsMap !== 'object') continue;
    const targets = Object.entries(exportsMap)
        .filter(([key]) => key !== '.')
        .map(([key, value]) => ({ key, target: typeof value === 'string' ? value : value?.import || value?.default }))
        .filter(({ target }) => typeof target === 'string');
    if (!targets.length) continue;
    // All subpaths map into one folder with the same name: a wildcard mapping covers them.
    const folders = new Set(targets.map(({ key, target }) => target.replace(/^\.\//, '').replace(new RegExp(`${key.replace(/^\.\//, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace('\\*', '.*')}(\\.[cm]?[jt]sx?)?$`), '')));
    if (folders.size !== 1) continue;
    const folder = [...folders][0].replace(/\/$/, '');
    if (!folder) continue;
    const key = `${packageName}/*`;
    const value = [`vendor/${packageName}/${folder}/*`];
    if (JSON.stringify(paths[key]) !== JSON.stringify(value)) {
        pathsToAdd.push([key, value]);
    }
}
if (pathsToAdd.length) {
    say('');
    say(`tsconfig.json paths ${apply ? 'added' : 'to add'} (packages whose exports map into a folder): ${pathsToAdd.map(([key]) => key).join(', ')}.`);
    if (apply) {
        const next = {};
        for (const [key, value] of pathsToAdd) next[key] = value;
        for (const [key, value] of Object.entries(paths)) if (!(key in next)) next[key] = value;
        tsconfig.compilerOptions.paths = next;
        writeFileSync(tsconfigPath, `${JSON.stringify(tsconfig, null, 2)}\n`);
    }
}

// ---------------------------------------------------------------------------------------------
// 4. Build and prune (only after --apply, and only when the build is clean)

let buildOk = null;
let prunedFiles = [];
if (apply) {
    section('Build');
    const { build } = await import('esbuild');
    const { baseOptions } = await import('./esbuild-config.mjs');
    const entryPoints = Object.fromEntries(seeds.map((seed) => [path.basename(seed, '.ts'), relative(seed)]));
    for (const script of readdirSync(path.join(clientRoot, 'scripts')).filter((name) => name.endsWith('-test.ts'))) {
        entryPoints[path.basename(script, '.ts')] = `scripts/${script}`;
    }
    try {
        const result = await build({
            ...baseOptions,
            entryPoints,
            logLevel: 'silent',
            metafile: true,
            outdir: path.join(clientRoot, '.refresh-build-tmp'),
            write: false
        });
        buildOk = true;
        const used = new Set(Object.keys(result.metafile.inputs).map((input) => path.normalize(input)));
        if (prune) {
            for (const file of walk(path.join(vendorRoot, '@proton'))) {
                if (path.basename(file) === 'package.json' || used.has(path.normalize(relative(file)))) continue;
                rmSync(file);
                prunedFiles.push(relative(file));
            }
            // A package left with nothing but its package.json is gone too.
            for (const entry of readdirSync(path.join(vendorRoot, '@proton'), { withFileTypes: true })) {
                const dir = path.join(vendorRoot, '@proton', entry.name);
                if (entry.isDirectory() && [...walk(dir)].every((file) => path.basename(file) === 'package.json')) {
                    rmSync(dir, { recursive: true, force: true });
                    prunedFiles.push(`${relative(dir)}/ (package without files)`);
                }
            }
            dropEmptyDirectories(path.join(vendorRoot, '@proton'));
        }
        say(`The bundle builds. ${prune ? `${prunedFiles.length} vendored file(s) nothing bundles were removed.` : 'Pruning skipped (--no-prune).'}`);
    } catch (error) {
        buildOk = false;
        say('The bundle does not build yet (nothing pruned; fix the errors, then `node scripts/prune-vendor-by-build.mjs`):');
        for (const message of error.errors?.slice(0, 30) || [{ text: String(error) }]) {
            say(`- ${message.text}${message.location ? ` (${message.location.file}:${message.location.line})` : ''}`);
        }
        if ((error.errors?.length || 0) > 30) say(`- … and ${error.errors.length - 30} more`);
    }
}

// ---------------------------------------------------------------------------------------------
// 5. Versions: dependencies

section('Versions');
const lock = gitShow(targetCommit, 'pnpm-lock.yaml')?.toString('utf8') || gitShow(targetCommit, 'yarn.lock')?.toString('utf8') || '';
const resolvedUpstream = (name) => {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const versions = [...lock.matchAll(new RegExp(`^  '?${escaped}@([^'(:\\n]+)'?[^\\n]*:`, 'gm'))].map((match) => match[1]);
    const npmAlias = [...lock.matchAll(new RegExp(`^  '?${escaped}@npm:([^'(:\\n]+)'?[^\\n]*:`, 'gm'))].map((match) => match[1]);
    return [...new Set([...npmAlias, ...versions])];
};
const externalVendored = existsSync(path.join(clientRoot, 'vendor-external'))
    ? readdirSync(path.join(clientRoot, 'vendor-external'))
          .map((dir) => {
              try {
                  const pkg = JSON.parse(readFileSync(path.join(clientRoot, 'vendor-external', dir, 'package.json'), 'utf8'));
                  return [pkg.name, `${pkg.version} (vendor-external/${dir})`];
              } catch {
                  return null;
              }
          })
          .filter(Boolean)
    : [];
/** `npm:<name>@<version>` specs count as the aliased package (openpgp → @protontech/openpgp). */
const ours = new Map(
    [...Object.entries(packageJson.dependencies || {}), ...Object.entries(packageJson.devDependencies || {}).filter(([name]) => !['esbuild', 'tsx', 'typescript'].includes(name)), ...externalVendored].map(([name, spec]) => {
        const alias = String(spec).match(/^npm:(@?[^@]+)@(.+)$/);
        return alias ? [alias[1], `${alias[2]} (installed as ${name})`] : [name, spec];
    })
);
const watched = new Set([...ours.keys(), '@protontech/crypto', '@protontech/pmcrypto', 'openpgp', '@openpgp/web-stream-tools', 'date-fns', 'ical.js', 'lodash', ...bareMissing.map(([name]) => name)]);
const versionLines = [];
for (const name of [...watched].sort()) {
    const upstream = resolvedUpstream(name);
    if (!upstream.length && !ours.has(name)) continue;
    const mine = ours.get(name);
    const differs = upstream.length && mine && !upstream.some((version) => String(mine).includes(version));
    versionLines.push(`- ${name}: ours ${mine ?? '—'}; WebClients ${upstream.join(', ') || '—'}${differs ? '  ← differs' : ''}`);
}
say('Dependencies (WebClients resolves per its lockfile):');
versionLines.forEach((line) => say(line));

// ---------------------------------------------------------------------------------------------
// 6. API routes the client uses: upstream changes that mention them

section('API helpers used by the client');
// The helpers src/ imports from @proton/shared/lib/api/* (by name), and every lib/api file the closure
// needs: upstream hunks in those files that change a URL, a method or one of those helpers.
const importedHelpers = new Set();
for (const seed of seeds) {
    for (const match of readFileSync(seed, 'utf8').matchAll(/import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+'@proton\/shared\/lib\/api\/[^']+'/g)) {
        match[1].split(',').map((part) => part.trim().split(/\s+as\s+/)[0].replace(/^type\s+/, '')).filter(Boolean).forEach((name) => importedHelpers.add(name));
    }
    for (const match of readFileSync(seed, 'utf8').matchAll(/import\s+(\w+)\s+from\s+'@proton\/shared\/lib\/api\/[^']+'/g)) importedHelpers.add(match[1]);
}
const sharedDir = targetDirectories.get('@proton/shared');
const apiFilesInUse = [...needed.keys()].map((file) => vendoredToUpstream(file, targetDirectories)?.upstreamPath).filter((upstream) => upstream && upstream.startsWith(`${sharedDir}/lib/api/`));
const apiHunks = [];
for (const file of apiFilesInUse.sort()) {
    const diff = gitTry(['diff', '-U2', baseCommit, targetCommit, '--', file]);
    if (!diff) continue;
    for (const hunk of diff.split(/^(?=@@)/m).slice(1)) {
        const changed = hunk.split('\n').filter((line) => /^[+-]/.test(line) && !/^(\+\+\+|---)/.test(line));
        if (!changed.length) continue;
        const relevant = changed.some((line) => /\b(url|method)\s*:/.test(line) || [...importedHelpers].some((name) => new RegExp(`\\b${name}\\b`).test(line)));
        if (relevant) apiHunks.push(`${file}\n${hunk.trim().split('\n').slice(0, 24).join('\n')}`);
    }
}
say(`${importedHelpers.size} helpers imported by src/ (${[...importedHelpers].sort().join(', ')}); ${apiFilesInUse.length} lib/api file(s) in the bundle.`);
if (apiHunks.length) {
    say('\nUpstream changes in those files touching a URL, a method or an imported helper:');
    apiHunks.slice(0, 40).forEach((hunk) => say(`\n\`\`\`diff\n${hunk}\n\`\`\``));
    if (apiHunks.length > 40) say(`… and ${apiHunks.length - 40} more hunks`);
} else {
    say('No upstream change to those files touches a URL, a method or an imported helper.');
}

// ---------------------------------------------------------------------------------------------
// 7. Manifest, report, check

if (apply) {
    const files = [...walk(path.join(vendorRoot, '@proton'))].map(relative).sort();
    const trims = [];
    for (const file of files) {
        if (path.basename(file) === 'package.json') continue;
        const mapping = vendoredToUpstream(path.join(clientRoot, file), targetDirectories);
        const upstream = mapping ? gitShow(targetCommit, mapping.upstreamPath) : null;
        if (!upstream || !upstream.equals(readFileSync(path.join(clientRoot, file)))) trims.push(file);
    }
    const packages = [...new Set(files.map((file) => file.split('/').slice(1, 3).join('/')))].map((name) => ({
        name,
        path: name,
        fileCount: files.filter((file) => file.startsWith(`vendor/${name}/`) && path.basename(file) !== 'package.json').length
    }));
    const nextManifest = {
        upstream: { repository: UPSTREAM_REPOSITORY, commit: targetCommit, date: targetDate, note: `Refreshed ${new Date().toISOString().slice(0, 10)} from ${shortCommit(baseCommit)} (${baseDate}) with scripts/refresh-proton.mjs.` },
        trims,
        packageCount: packages.length,
        fileCount: files.filter((file) => path.basename(file) !== 'package.json').length,
        packages,
        refreshes: [
            ...(manifest.refreshes || []),
            // A re-run at the same commit that changes nothing is not a refresh.
            ...(baseCommit !== targetCommit || additions.length || merged.removed.length || prunedFiles.length
                ? [{ at: new Date().toISOString(), from: shortCommit(baseCommit), to: shortCommit(targetCommit), conflicts: merged.conflicts.length, added: additions.length, removed: merged.removed.length, pruned: prunedFiles.length }]
                : [])
        ],
        additions: manifest.additions || []
    };
    writeFileSync(manifestPath, `${JSON.stringify(nextManifest, null, 2)}\n`);
    section('Manifest');
    say(`vendor/manifest.json: upstream ${shortCommit(targetCommit)} (${targetDate}), ${nextManifest.fileCount} files in ${packages.length} packages, ${trims.length} trimmed.`);
}

section('Next');
if (!apply) {
    say('Run again with --apply to merge, add, prune and update the manifest; then resolve conflicts, fix the build, and run `npm run check` and `npm run test:live`.');
} else {
    const todo = [];
    if (merged.conflicts.length) todo.push(`resolve ${merged.conflicts.length} merge conflict(s)`);
    if (buildOk === false) todo.push('fix the build, then `node scripts/prune-vendor-by-build.mjs`');
    if (bareMissing.length) todo.push(`add or stub ${bareMissing.length} bare import(s)`);
    if (removedImporters.length) todo.push(`replace ${removedImporters.length} module(s) removed upstream`);
    todo.push('`npm run check`', '`npm run test:live`', 'update NOTICE.md if vendored packages or licences changed');
    todo.forEach((item, index) => say(`${index + 1}. ${item}`));
}

// vendor/REFRESH.md is the report of the last real refresh; a report-only run or a re-run at the same
// commit writes .refresh-report.md (not committed) instead.
const reportTarget = apply && baseCommit !== targetCommit ? reportPath : path.join(clientRoot, '.refresh-report.md');
writeFileSync(reportTarget, `${lines.join('\n')}\n`);
console.log(`\nReport written to ${relative(reportTarget)}.`);

if (apply) {
    // The invitation emails' translations come from the same commit as the vendored code (0.31).
    console.log('\nExtracting the invitation email translations …');
    const extracted = spawnSync(process.execPath, [path.join(clientRoot, 'scripts', 'extract-invitation-locales.mjs'), '--webclients', webClientsRoot], { cwd: clientRoot, stdio: 'inherit' });
    if (extracted.status !== 0) {
        console.error('extract-invitation-locales.mjs failed; run it by hand after fixing the cause');
    }
}

if (apply && runCheck && buildOk) {
    console.log('\nRunning npm run check …');
    const check = spawnSync('npm', ['run', 'check'], { cwd: clientRoot, stdio: 'inherit' });
    process.exit(check.status ?? 1);
}
process.exit(apply && (merged.conflicts.length || buildOk === false) ? 1 : 0);
