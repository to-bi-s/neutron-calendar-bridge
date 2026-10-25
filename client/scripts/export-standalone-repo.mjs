import { cpSync, existsSync, mkdirSync, rmSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { execFileSync } from 'child_process';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(scriptDir, '..');
const targetArg = process.argv[2];

if (!targetArg) {
    console.error('Usage: node scripts/export-standalone-repo.mjs <target-directory>');
    process.exit(1);
}

const targetDir = resolve(process.cwd(), targetArg);
const entriesToCopy = [
    '.gitignore',
    'LICENSE',
    'NOTICE.md',
    'README.md',
    'package-lock.json',
    'package.json',
    'scripts',
    'src',
    'tsconfig.json',
    'vendor',
];

execFileSync('npm', ['run', 'build'], {
    cwd: rootDir,
    stdio: 'inherit',
});

mkdirSync(targetDir, { recursive: true });

for (const entry of [...entriesToCopy, 'dist']) {
    rmSync(resolve(targetDir, entry), { recursive: true, force: true });
}

for (const entry of entriesToCopy) {
    const sourcePath = resolve(rootDir, entry);
    if (!existsSync(sourcePath)) {
        continue;
    }
    cpSync(sourcePath, resolve(targetDir, entry), { recursive: true });
}

cpSync(resolve(rootDir, 'dist'), resolve(targetDir, 'dist'), { recursive: true });

console.log(`Exported proton-calendar-client to ${targetDir}`);
