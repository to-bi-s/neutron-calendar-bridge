/**
 * Offline test (stage 3, privacy at rest; 0.50): the client keeps no device profile any more — the
 * one the former app identity wrote (`.native-device-profile.json` in the state folder) is removed
 * when the client starts, and nothing else is written there.
 */
import { mkdirSync, mkdtempSync, existsSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let failures = 0;
const check = (condition: unknown, label: string) => {
    console.log(`${condition ? 'ok  ' : 'FAIL'} ${label}`);
    if (!condition) failures += 1;
};

const root = mkdtempSync(join(tmpdir(), 'pcc-state-'));
const stateDir = join(root, 'proton-calendar-client');
process.env.PROTON_CALENDAR_CLIENT_STATE_DIR = stateDir;
const profilePath = join(stateDir, '.native-device-profile.json');

try {
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(profilePath, '{"uuid":"old","deviceName":"iPhone","deviceModel":"x","osVersion":"y"}\n', { mode: 0o600 });
    const { ProtonCalendarAPI } = await import('../src/proton-calendar-api.ts');
    const api: any = new ProtonCalendarAPI({ username: 'u', password: 'p' });
    api.fetchImpl = async () => ({ status: 422, ok: false, headers: { get: () => null }, text: async () => JSON.stringify({ Code: 2001, Error: 'stop' }), arrayBuffer: async () => new ArrayBuffer(0) });
    const original = console.log;
    console.log = () => undefined;
    try {
        await api.initialize();
    } catch {
        // stopped at the sign-in: the state folder was handled before
    } finally {
        console.log = original;
    }
    check(!existsSync(profilePath), 'the former identity\'s device profile is removed at start');
    check(readdirSync(stateDir).length === 0, 'nothing else is written to the state folder');
} finally {
    rmSync(root, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
