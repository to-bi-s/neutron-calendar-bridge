import { readdirSync, readFileSync, statSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const clientRoot = path.resolve(__dirname, '..');

const packageJson = JSON.parse(readFileSync(path.join(clientRoot, 'package.json'), 'utf8'));
// The packages the bundle is built from are devDependencies (dist/ is self-contained).
const declaredDependencies = new Set([...Object.keys(packageJson.dependencies || {}), ...Object.keys(packageJson.devDependencies || {})].filter((name) => !['esbuild', 'tsx', 'typescript'].includes(name)));
const runtimeRoots = ['src', 'vendor'].map((relativePath) => path.join(clientRoot, relativePath));
const protonWorkspacePackages = new Set([
    '@proton/sanitize',
    '@proton/account',
    '@proton/chargebee',
    '@proton/colors',
    '@proton/components',
    '@proton/cross-storage',
    '@proton/crypto',
    '@proton/hooks',
    '@proton/key-transparency',
    '@proton/metrics',
    '@proton/payments',
    '@proton/react-redux-store',
    '@proton/redux-shared-store-types',
    '@proton/redux-utilities',
    '@proton/shared',
    '@proton/sieve',
    '@proton/srp',
    '@proton/unleash',
    '@proton/utils'
]);
const builtinModules = new Set(['crypto', 'fs', 'os', 'path', 'readline', 'util', 'child_process', 'url']);
// openpgp: imported by @protontech/crypto as 'openpgp/lightweight' (the build maps it to the Node build).
const allowedTransitives = new Set(['@noble/hashes', 'asn1js', 'jsmimeparser', 'pvutils', 'openpgp']);
const runtimeExtensions = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs']);
const runtimeImports = new Set();

const baseSpecifier = (specifier) => {
    if (specifier.startsWith('node:') || specifier.startsWith('.') || specifier.startsWith('/')) {
        return null;
    }

    return specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0];
};

const staticImportPattern =
    /(?:^|\n)\s*(?!import\s+type\b)(?!export\s+type\b)(?:import|export)\s+(?:[^'"`]*?from\s*)?['"]([^'"]+)['"]/gm;
const requirePattern = /require\(\s*['"]([^'"]+)['"]\s*\)/gm;
const dynamicImportPattern = /import\(\s*(?:\/\*[\s\S]*?\*\/\s*)*['"]([^'"]+)['"]\s*\)/gm;

const scanFile = (filePath) => {
    const source = readFileSync(filePath, 'utf8');
    const patterns = [staticImportPattern, requirePattern, dynamicImportPattern];

    for (const pattern of patterns) {
        pattern.lastIndex = 0;
        let match;
        while ((match = pattern.exec(source))) {
            const specifier = match[1];
            const base = baseSpecifier(specifier);
            if (base) {
                runtimeImports.add(base);
            }
        }
    }
};

for (const root of runtimeRoots) {
    const stack = [root];

    while (stack.length) {
        const current = stack.pop();
        for (const entry of readdirSync(current)) {
            const fullPath = path.join(current, entry);
            const stats = statSync(fullPath);

            if (stats.isDirectory()) {
                stack.push(fullPath);
                continue;
            }

            if (runtimeExtensions.has(path.extname(fullPath))) {
                scanFile(fullPath);
            }
        }
    }
}

const usedDependencies = [...declaredDependencies].filter((dependency) => runtimeImports.has(dependency)).sort();
// openpgp is declared so that Proton's fork is the one installed; @protontech/crypto imports it (see allowedTransitives).
const unusedDependencies = [...declaredDependencies].filter((dependency) => !runtimeImports.has(dependency) && dependency !== 'openpgp').sort();
const missingDependencies = [...runtimeImports]
    .filter(
        (dependency) =>
            !declaredDependencies.has(dependency) &&
            !protonWorkspacePackages.has(dependency) &&
            !builtinModules.has(dependency) &&
            !allowedTransitives.has(dependency)
    )
    .sort();

console.log(JSON.stringify({ usedDependencies, unusedDependencies, missingDependencies }, null, 2));

if (unusedDependencies.length || missingDependencies.length) {
    process.exitCode = 1;
}
