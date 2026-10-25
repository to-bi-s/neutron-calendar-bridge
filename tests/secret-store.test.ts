/**
 * The saved login and the local CalDAV password (secrets.json, encrypted with Electron's
 * safeStorage, i.e. a Keychain item). When it cannot be read — e.g. macOS did not allow the renamed
 * app to use the Keychain item — nothing is written over it: quitting and choosing "Always Allow"
 * brings everything back. Only an explicit sign-in replaces it, and the old file is kept aside. A
 * file that was encrypted is never replaced by a plain-text one.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let decryptFails = false;
let encryptionAvailable = true;
let encryptFails = false;
const stubElectron = () => {
    const resolved = require.resolve('electron');
    require.cache[resolved] = {
        id: resolved,
        filename: resolved,
        loaded: true,
        exports: {
            safeStorage: {
                isEncryptionAvailable: () => encryptionAvailable,
                encryptString: (text: string) => {
                    if (encryptFails) throw new Error('Keychain locked');
                    return Buffer.from(`enc:${text}`);
                },
                decryptString: (data: Buffer) => {
                    if (decryptFails) throw new Error('Error while decrypting the ciphertext provided to safeStorage.decryptString.');
                    return data.toString().replace(/^enc:/, '');
                }
            }
        }
    } as unknown as NodeJS.Module;
};

const backupsIn = (baseDir: string) => readdirSync(baseDir).filter((name) => name.startsWith('secrets.json.unreadable-'));

const withStore = async (run: (baseDir: string, warnings: string[], SecretStore: typeof import('../src/main/secret-store').SecretStore) => Promise<void>) => {
    stubElectron();
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { SecretStore } = require('../src/main/secret-store') as typeof import('../src/main/secret-store');
    const baseDir = mkdtempSync(join(tmpdir(), 'neutron-calendar-bridge-secrets-'));
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...parts: unknown[]) => warnings.push(parts.join(' '));
    try {
        await run(baseDir, warnings, SecretStore);
    } finally {
        console.warn = originalWarn;
        decryptFails = false;
        encryptionAvailable = true;
        encryptFails = false;
        rmSync(baseDir, { recursive: true, force: true });
    }
};

test('secrets that cannot be read are left alone until you sign in again', async () => {
    await withStore(async (baseDir, warnings, SecretStore) => {
        const first = new SecretStore(baseDir);
        const password = await first.ensureLocalCaldavPassword();
        await first.setProtonCredentials({ username: 'tobi', password: 'secret' });
        const saved = readFileSync(join(baseDir, 'secrets.json'), 'utf8');
        assert.equal(await new SecretStore(baseDir).getLocalCaldavPassword(), password, 'readable: the same password after a restart');

        // "Deny" in the Keychain prompt: nothing can be read, and nothing is written over it.
        decryptFails = true;
        const denied = new SecretStore(baseDir);
        assert.equal(await denied.getProtonCredentials(), null);
        assert.equal(denied.isUnreadable(), true, 'the window says what to do');
        const fresh = await denied.ensureLocalCaldavPassword();
        assert.notEqual(fresh, password, 'a password to run with for now …');
        assert.equal(await denied.getLocalCaldavPassword(), fresh, '… kept in memory');
        assert.equal(readFileSync(join(baseDir, 'secrets.json'), 'utf8'), saved, 'the file is untouched');
        assert.deepEqual(backupsIn(baseDir), []);
        assert.ok(warnings.some((line) => /cannot be read .*left as it is/.test(line)));

        // Quit, reopen, "Always Allow": everything is back.
        decryptFails = false;
        const allowed = new SecretStore(baseDir);
        assert.equal(allowed.isUnreadable(), false);
        assert.equal(await allowed.ensureLocalCaldavPassword(), password);
        assert.deepEqual(await allowed.getProtonCredentials(), { username: 'tobi', password: 'secret' });

        // Still denied, but you sign in again: the new login is saved and the old file kept aside.
        decryptFails = true;
        const again = new SecretStore(baseDir);
        const newPassword = await again.ensureLocalCaldavPassword();
        await again.setProtonCredentials({ username: 'tobi', password: 'new secret' });
        const backups = backupsIn(baseDir);
        assert.equal(backups.length, 1, 'the unreadable file is kept');
        assert.equal(readFileSync(join(baseDir, backups[0]), 'utf8'), saved, '… unchanged');
        assert.equal(again.isUnreadable(), false);
        decryptFails = false;
        const after = new SecretStore(baseDir);
        assert.deepEqual(await after.getProtonCredentials(), { username: 'tobi', password: 'new secret' });
        assert.equal(await after.getLocalCaldavPassword(), newPassword, 'the password Calendar.app was given this session');
    });
});

test('signing in again while macOS refuses the Keychain: kept until the app quits, the old file untouched', async () => {
    await withStore(async (baseDir, warnings, SecretStore) => {
        const first = new SecretStore(baseDir);
        const password = await first.ensureLocalCaldavPassword();
        await first.setProtonCredentials({ username: 'tobi', password: 'secret' });
        const saved = readFileSync(join(baseDir, 'secrets.json'), 'utf8');
        assert.ok(!saved.includes('secret'), 'encrypted');

        // "Deny": no encryption now. Signing in works for this session only …
        encryptionAvailable = false;
        const store = new SecretStore(baseDir, { allowPlaintext: true });
        assert.equal(store.isUnreadable(), true);
        await store.ensureLocalCaldavPassword();
        await store.setProtonCredentials({ username: 'tobi', password: 'typed again' });
        assert.deepEqual(await store.getProtonCredentials(), { username: 'tobi', password: 'typed again' });
        assert.ok(warnings.some((line) => /login is not saved/.test(line)));
        // … nothing on disk changed: no plain text, the old file not moved.
        assert.deepEqual(backupsIn(baseDir), []);
        assert.equal(readFileSync(join(baseDir, 'secrets.json'), 'utf8'), saved);
        // A later launch with "Always Allow" has everything back.
        encryptionAvailable = true;
        const allowed = new SecretStore(baseDir);
        assert.equal(await allowed.getLocalCaldavPassword(), password);
        assert.deepEqual(await allowed.getProtonCredentials(), { username: 'tobi', password: 'secret' });

        // Encryption that fails while saving: nothing on disk changes either.
        decryptFails = true;
        const failing = new SecretStore(baseDir);
        encryptFails = true;
        await failing.setProtonCredentials({ username: 'tobi', password: 'third' });
        assert.deepEqual(backupsIn(baseDir), []);
        assert.equal(readFileSync(join(baseDir, 'secrets.json'), 'utf8'), saved);
    });
});

test('on macOS never in plain text, even without any earlier file', async () => {
    await withStore(async (baseDir, warnings, SecretStore) => {
        encryptionAvailable = false;
        const store = new SecretStore(baseDir, { allowPlaintext: false });
        await store.ensureLocalCaldavPassword();
        await store.setProtonCredentials({ username: 'tobi', password: 'secret' });
        assert.deepEqual(await store.getProtonCredentials(), { username: 'tobi', password: 'secret' }, 'kept for this session');
        assert.deepEqual(readdirSync(baseDir), [], 'nothing written');
        assert.ok(warnings.some((line) => /login is not saved/.test(line)));
    });
});

test('without encryption on Linux (development): plain text, owner-only', async () => {
    await withStore(async (baseDir, _warnings, SecretStore) => {
        encryptionAvailable = false;
        const store = new SecretStore(baseDir, { allowPlaintext: true });
        await store.setProtonCredentials({ username: 'tobi', password: 'secret' });
        assert.match(readFileSync(join(baseDir, 'secrets.json'), 'utf8'), /"username": "tobi"/);
        assert.equal(statSync(join(baseDir, 'secrets.json')).mode & 0o777, 0o600);
        assert.deepEqual(await new SecretStore(baseDir, { allowPlaintext: true }).getProtonCredentials(), { username: 'tobi', password: 'secret' });
    });
});

test("Proton's session: kept with the login, renewed, forgotten when signing out", async () => {
    await withStore(async (baseDir, _warnings, SecretStore) => {
        const store = new SecretStore(baseDir);
        await store.setProtonCredentials({ username: 'tobi', password: 'secret' });
        await store.setProtonSession({ username: 'tobi', UID: 'uid', AccessToken: 'a1', RefreshToken: 'r1' });
        await store.setProtonSession({ username: 'tobi', UID: 'uid', AccessToken: 'a2', RefreshToken: 'r2' });
        const restarted = new SecretStore(baseDir);
        assert.deepEqual(await restarted.getProtonSession(), { username: 'tobi', UID: 'uid', AccessToken: 'a2', RefreshToken: 'r2' }, 'the newest one, encrypted with the login');
        assert.ok(!readFileSync(join(baseDir, 'secrets.json'), 'utf8').includes('r2'), 'not in plain text');
        await restarted.setProtonCredentials(null);
        assert.equal(await new SecretStore(baseDir).getProtonSession(), null, 'signing out forgets it');

        // A renewal while the file cannot be read: kept in memory, the file left alone.
        await new SecretStore(baseDir).setProtonCredentials({ username: 'tobi', password: 'secret' });
        const saved = readFileSync(join(baseDir, 'secrets.json'), 'utf8');
        decryptFails = true;
        const denied = new SecretStore(baseDir);
        await denied.setProtonSession({ username: 'tobi', UID: 'uid', AccessToken: 'a3', RefreshToken: 'r3' });
        assert.equal((await denied.getProtonSession())?.RefreshToken, 'r3');
        assert.equal(readFileSync(join(baseDir, 'secrets.json'), 'utf8'), saved);
    });
});

test('the key of the local copy: made once, kept encrypted with the login, never in plain text on macOS', async () => {
    await withStore(async (baseDir, _warnings, SecretStore) => {
        const store = new SecretStore(baseDir);
        const made = await store.ensureMirrorKey();
        assert.equal(made.saved, true);
        assert.match(made.key, /^[0-9a-f]{64}$/);
        assert.deepEqual(await store.ensureMirrorKey(), made, 'the same key within the run');
        assert.ok(!readFileSync(join(baseDir, 'secrets.json'), 'utf8').includes(made.key), 'not in plain text');
        assert.equal(statSync(join(baseDir, 'secrets.json')).mode & 0o777, 0o600);
        assert.deepEqual(await new SecretStore(baseDir).ensureMirrorKey(), made, 'and after a restart');

        // Signing out and in again keeps it (the copy is emptied on sign-out, not re-keyed).
        await store.setProtonCredentials({ username: 'tobi', password: 'secret' });
        await store.setProtonCredentials(null);
        assert.equal((await new SecretStore(baseDir).ensureMirrorKey()).key, made.key);

        // "Deny" in the Keychain prompt: a key for this run only, not saved; the file is untouched.
        const saved = readFileSync(join(baseDir, 'secrets.json'), 'utf8');
        decryptFails = true;
        const denied = new SecretStore(baseDir);
        const temporary = await denied.ensureMirrorKey();
        assert.equal(temporary.saved, false);
        assert.notEqual(temporary.key, made.key);
        assert.deepEqual(await denied.ensureMirrorKey(), temporary, 'still not saved when asked again');
        assert.equal(readFileSync(join(baseDir, 'secrets.json'), 'utf8'), saved);
        decryptFails = false;
        assert.equal((await new SecretStore(baseDir).ensureMirrorKey()).key, made.key, '"Always Allow" brings the key back');
    });
});

test('the key of the local copy without encryption on macOS: in memory only, nothing written', async () => {
    await withStore(async (baseDir, _warnings, SecretStore) => {
        encryptionAvailable = false;
        const store = new SecretStore(baseDir, { allowPlaintext: false });
        const key = await store.ensureMirrorKey();
        assert.equal(key.saved, false);
        assert.deepEqual(readdirSync(baseDir), []);
        // A later save of something else (that also fails) does not report the key as saved.
        await store.ensureLocalCaldavPassword();
        assert.deepEqual(await store.ensureMirrorKey(), key);
    });
});

test('a secrets file saved before 0.24 with other permissions is restricted at start', async () => {
    await withStore(async (baseDir, _warnings, SecretStore) => {
        writeFileSync(join(baseDir, 'secrets.json'), Buffer.from('enc:{}').toString('base64'), { mode: 0o644 });
        chmodSync(join(baseDir, 'secrets.json'), 0o644);
        new SecretStore(baseDir);
        assert.equal(statSync(join(baseDir, 'secrets.json')).mode & 0o777, 0o600);
    });
});
