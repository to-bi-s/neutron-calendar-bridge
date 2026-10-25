import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';

import { safeStorage } from 'electron';

import { ProtonCredentials, SavedProtonSession } from '../shared/types';
import { restrictToOwner } from './config-store';

interface SecretFilePayload {
    protonCredentials?: ProtonCredentials | null;
    localCaldavPassword?: string | null;
    /** Proton's session, to resume at the next start without signing in again. */
    protonSession?: SavedProtonSession | null;
    /** The key of the encrypted local copy of the calendars (mirror.db), 64 hex digits. */
    mirrorKey?: string | null;
}

/**
 * The saved Proton login, Proton's session, the local CalDAV password and the key of the local copy
 * of the calendars (secrets.json, encrypted with Electron's safeStorage, i.e. a Keychain item
 * "neutron-calendar-bridge Safe Storage").
 *
 * When the file exists but cannot be read (e.g. macOS did not allow the updated app to use the
 * Keychain item: "Deny" in the prompt), nothing is written over it: a CalDAV password needed to run
 * is kept in memory only, so quitting and choosing "Always Allow" brings everything back. Only an
 * explicit sign-in replaces it, and only once the new one could be encrypted; the old file is then
 * kept aside (secrets.json.unreadable-<time>). On macOS nothing is ever saved in plain text: without
 * encryption (Keychain refused) the login is kept until the app quits.
 */
export class SecretStore {
    private readonly filePath: string;
    /** What the file holds (read once), plus what was saved since. */
    private loaded: SecretFilePayload | null = null;
    private unreadable = false;
    private wasEncrypted = false;
    /** A mirror key made this run that could not be saved (kept in memory only). */
    private unsavedMirrorKey = false;
    /** Plain text as a last resort (development on Linux); never on macOS, where the Keychain exists. */
    private readonly allowPlaintext: boolean;

    constructor(baseDir: string, options: { allowPlaintext?: boolean } = {}) {
        this.filePath = join(baseDir, 'secrets.json');
        this.allowPlaintext = options.allowPlaintext ?? process.platform !== 'darwin';
        mkdirSync(dirname(this.filePath), { recursive: true });
        restrictToOwner(this.filePath); // also one saved before 0.24, even if nothing is written now
    }

    /** The saved login exists but cannot be read (Keychain access denied?): the window says what to do. */
    isUnreadable() {
        this.load();
        return this.unreadable;
    }

    private load(): SecretFilePayload {
        this.loaded ??= this.readSecrets();
        return this.loaded;
    }

    private readSecrets(): SecretFilePayload {
        if (!existsSync(this.filePath)) {
            return {};
        }

        try {
            const raw = readFileSync(this.filePath, 'utf8').trim();

            // Plaintext JSON (legacy / safeStorage unavailable)
            if (raw.startsWith('{')) {
                return JSON.parse(raw) as SecretFilePayload;
            }

            // safeStorage-encrypted base64
            this.wasEncrypted = true;
            if (safeStorage.isEncryptionAvailable()) {
                const decrypted = safeStorage.decryptString(Buffer.from(raw, 'base64'));
                return JSON.parse(decrypted) as SecretFilePayload;
            }

            console.warn('[secret-store] Encrypted secrets file exists but safeStorage is unavailable.');
            this.unreadable = true;
            return {};
        } catch (error) {
            console.warn('[secret-store] Failed to read secrets file:', error instanceof Error ? error.message : error);
            this.unreadable = true;
            return {};
        }
    }

    /**
     * Saves what is in memory. `replacesUnreadable`: an explicit sign-in or sign-out, which may
     * replace a file that cannot be read (kept aside first); anything else leaves such a file alone.
     * Encrypted first: if that is not possible, nothing on disk changes. Returns whether it is on disk.
     */
    private writeSecrets(payload: SecretFilePayload, replacesUnreadable: boolean): boolean {
        this.loaded = payload;
        const unreadableFile = this.unreadable && existsSync(this.filePath);
        if (unreadableFile && !replacesUnreadable) {
            console.warn('[secret-store] the saved login cannot be read (Keychain access?): it is left as it is; the new values are kept until the app quits');
            return false;
        }
        const sanitized: SecretFilePayload = {
            protonCredentials: payload.protonCredentials || undefined,
            localCaldavPassword: payload.localCaldavPassword || undefined,
            protonSession: payload.protonSession || undefined,
            mirrorKey: payload.mirrorKey || undefined
        };
        const empty = !sanitized.protonCredentials && !sanitized.localCaldavPassword && !sanitized.protonSession && !sanitized.mirrorKey;

        let contents: string | null = null;
        let plaintext = false;
        if (!empty) {
            const serialized = `${JSON.stringify(sanitized, null, 2)}\n`;
            try {
                if (safeStorage.isEncryptionAvailable()) {
                    contents = safeStorage.encryptString(serialized).toString('base64');
                }
            } catch (error) {
                console.warn('[secret-store] encryption failed:', error instanceof Error ? error.message : error);
            }
            if (contents === null) {
                if (this.wasEncrypted || unreadableFile || !this.allowPlaintext) {
                    console.warn('[secret-store] encryption is not available (Keychain access?): the login is not saved, only kept until the app quits');
                    return false;
                }
                // Last resort (development on Linux): plain text, readable by you only.
                contents = serialized;
                plaintext = true;
            }
        }

        if (unreadableFile) {
            const backup = `${this.filePath}.unreadable-${Date.now()}`;
            renameSync(this.filePath, backup);
            console.warn(`[secret-store] the saved login could not be read (Keychain access?); the file is kept as ${backup}`);
        }
        this.unreadable = false;
        if (contents === null) {
            rmSync(this.filePath, { force: true });
            return true;
        }
        writeFileSync(this.filePath, contents, { mode: 0o600 });
        chmodSync(this.filePath, 0o600); // also a file written before with other permissions
        this.wasEncrypted ||= !plaintext;
        return true;
    }

    async getProtonCredentials(): Promise<ProtonCredentials | null> {
        return this.load().protonCredentials ?? null;
    }

    /** Signing out (null) forgets the saved session too. */
    async setProtonCredentials(credentials: ProtonCredentials | null) {
        this.writeSecrets({ ...this.load(), protonCredentials: credentials, ...(credentials ? {} : { protonSession: null }) }, true);
    }

    async getProtonSession(): Promise<SavedProtonSession | null> {
        return this.load().protonSession ?? null;
    }

    /** After signing in and after each renewal (Proton's refresh tokens are single-use). */
    async setProtonSession(session: SavedProtonSession | null) {
        this.writeSecrets({ ...this.load(), protonSession: session }, false);
    }

    async getLocalCaldavPassword(): Promise<string | null> {
        return this.load().localCaldavPassword ?? null;
    }

    /**
     * The key of the encrypted local copy (mirror.db), made once. `saved`: on disk with the login;
     * false when it exists in memory only (the secrets file cannot be read or written), so it must
     * not encrypt a file meant to outlive this run.
     */
    async ensureMirrorKey(): Promise<{ key: string; saved: boolean }> {
        const existing = this.load().mirrorKey;
        if (existing && !this.unsavedMirrorKey) {
            return { key: existing, saved: !this.unreadable };
        }
        if (existing) {
            return { key: existing, saved: false };
        }
        const key = randomBytes(32).toString('hex');
        const saved = this.writeSecrets({ ...this.load(), mirrorKey: key }, false);
        this.unsavedMirrorKey = !saved;
        return { key, saved };
    }

    async ensureLocalCaldavPassword(seed?: string) {
        const existing = await this.getLocalCaldavPassword();
        if (existing) {
            return existing;
        }

        const password = seed || randomBytes(18).toString('base64url');
        this.writeSecrets({ ...this.load(), localCaldavPassword: password }, false);
        return password;
    }
}
