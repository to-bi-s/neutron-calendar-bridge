/**
 * A stand-in for Electron's safeStorage in tests: "encryption available", with a reversible
 * encoding instead of the Keychain. Without it the secret store refuses plain text on macOS
 * (never on disk there), so the mirror key could not be saved and every test would run with a copy
 * in memory — and differently from Linux, where plain text is allowed for development.
 */
export const fakeSafeStorage = {
    isEncryptionAvailable: () => true,
    encryptString: (text: string) => Buffer.from(`enc:${text}`),
    decryptString: (data: Buffer) => {
        const text = data.toString();
        if (!text.startsWith('enc:')) throw new Error('Error while decrypting the ciphertext provided to safeStorage.decryptString.');
        return text.slice(4);
    }
};
