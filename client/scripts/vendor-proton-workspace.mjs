import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const clientRoot = path.resolve(__dirname, '..');
const webClientsRoot = process.env.WEBCLIENTS_ROOT
    ? path.resolve(process.env.WEBCLIENTS_ROOT)
    : path.resolve(clientRoot, '../../WebClients');
const packagesRoot = path.join(webClientsRoot, 'packages');
const vendorRoot = path.join(clientRoot, 'vendor');

if (!existsSync(packagesRoot)) {
    throw new Error(
        `Could not find Proton WebClients packages at ${packagesRoot}. Set WEBCLIENTS_ROOT to a local WebClients checkout.`
    );
}

const packageRoots = new Map();

for (const entry of readdirSync(packagesRoot)) {
    const packageJsonPath = path.join(packagesRoot, entry, 'package.json');
    if (!existsSync(packageJsonPath)) {
        continue;
    }

    const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
    if (packageJson.name) {
        packageRoots.set(packageJson.name, path.dirname(packageJsonPath));
    }
}

const fileCandidates = ['', '.ts', '.tsx', '.js', '.mjs', '.cjs'];

const resolveFile = (basePath) => {
    for (const suffix of fileCandidates) {
        const candidate = `${basePath}${suffix}`;
        if (existsSync(candidate) && statSync(candidate).isFile()) {
            return candidate;
        }
    }

    for (const suffix of ['.ts', '.tsx', '.js', '.mjs', '.cjs']) {
        const candidate = path.join(basePath, `index${suffix}`);
        if (existsSync(candidate) && statSync(candidate).isFile()) {
            return candidate;
        }
    }

    return null;
};

const resolveImport = (specifier, fromFile) => {
    if (specifier.startsWith('.') || specifier.startsWith('/')) {
        return { file: resolveFile(path.resolve(path.dirname(fromFile), specifier)), packageName: null, packageRoot: null };
    }

    for (const [packageName, packageRoot] of packageRoots) {
        if (specifier === packageName) {
            const packageJson = JSON.parse(readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
            const entryFile =
                resolveFile(path.join(packageRoot, packageJson.module || packageJson.main || 'index.ts')) ||
                resolveFile(path.join(packageRoot, 'lib/index.ts'));

            return { file: entryFile, packageName, packageRoot };
        }

        if (specifier.startsWith(`${packageName}/`)) {
            return {
                file: resolveFile(path.join(packageRoot, specifier.slice(packageName.length + 1))),
                packageName,
                packageRoot
            };
        }
    }

    return { file: null, packageName: null, packageRoot: null };
};

const importPattern = /(?:import|export)\s+(?:[^'"`]*?from\s*)?['"]([^'"]+)['"]|require\(['"]([^'"]+)['"]\)/g;
const seedFile = path.join(clientRoot, 'src', 'proton-calendar-api.ts');
const queue = [seedFile];
const visitedFiles = new Set();
const copiedFiles = [];
const touchedPackages = new Map();

rmSync(vendorRoot, { recursive: true, force: true });

while (queue.length) {
    const currentFile = queue.pop();
    if (!currentFile || visitedFiles.has(currentFile)) {
        continue;
    }

    visitedFiles.add(currentFile);
    const source = readFileSync(currentFile, 'utf8');

    let match;
    while ((match = importPattern.exec(source))) {
        const specifier = match[1] || match[2];
        const resolved = resolveImport(specifier, currentFile);

        if (!resolved.file) {
            continue;
        }

        if (!visitedFiles.has(resolved.file)) {
            queue.push(resolved.file);
        }

        if (!resolved.packageName || !resolved.packageRoot) {
            continue;
        }

        touchedPackages.set(resolved.packageName, resolved.packageRoot);
    }
}

for (const [packageName, packageRoot] of touchedPackages) {
    const vendorPackageRoot = path.join(vendorRoot, ...packageName.split('/'));
    mkdirSync(vendorPackageRoot, { recursive: true });
    copyFileSync(path.join(packageRoot, 'package.json'), path.join(vendorPackageRoot, 'package.json'));
}

for (const filePath of visitedFiles) {
    if (!filePath.startsWith(packagesRoot)) {
        continue;
    }

    const packageName = [...touchedPackages.entries()].find(([, packageRoot]) => filePath.startsWith(packageRoot))?.[0];
    const packageRoot = packageName ? touchedPackages.get(packageName) : null;
    if (!packageName || !packageRoot) {
        continue;
    }

    const destination = path.join(vendorRoot, ...packageName.split('/'), path.relative(packageRoot, filePath));
    mkdirSync(path.dirname(destination), { recursive: true });
    copyFileSync(filePath, destination);
    copiedFiles.push(path.relative(clientRoot, destination));
}

writeFileSync(
    path.join(vendorRoot, 'manifest.json'),
    `${JSON.stringify(
        {
            copiedAt: new Date().toISOString(),
            packageCount: touchedPackages.size,
            fileCount: copiedFiles.length,
            packages: [...touchedPackages.keys()].sort(),
            files: copiedFiles.sort()
        },
        null,
        2
    )}\n`
);

console.log(`Vendored ${copiedFiles.length} files from ${touchedPackages.size} Proton workspace packages.`);
