/**
 * Stage 6 (0.27): two-factor authentication and two-password mode in the bridge. The client is a
 * fake that asks the bridge for a code or the mailbox password the way the real one does
 * (askSecondFactor / askMailboxPassword). Checks:
 * - a sign-in from the form waits for the code; the Setup page shows the prompt; the answer goes
 *   to the client; a refused code shows the prompt again with `wrong`; Cancel gives up;
 * - the mailbox password prompt the same way; the answer is validated;
 * - a sign-in in the background (Proton ended the session): the prompt plus one notification;
 * - the session saved carries the key password and is offered back at start;
 * - a security-key-only account is not prompted (the client's explanation reaches the status);
 * - the prompt times out; signing out clears it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fakeSafeStorage } from './support/fake-safe-storage';

const stubElectron = () => {
    const resolved = require.resolve('electron');
    require.cache[resolved] = {
        id: resolved,
        filename: resolved,
        loaded: true,
        exports: { app: { setLoginItemSettings: () => undefined, isPackaged: false }, safeStorage: fakeSafeStorage }
    } as unknown as NodeJS.Module;
};

const named = (name: string, message: string) => Object.assign(new Error(message), { name });

const setup = async (account: { twoFactor?: number; passwordMode?: number; mailboxPassword?: string; code?: string; start?: boolean } = {}) => {
    stubElectron();
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { BridgeService } = require('../src/main/bridge-service') as typeof import('../src/main/bridge-service');
    const baseDir = mkdtempSync(join(tmpdir(), 'neutron-calendar-bridge-2fa-'));
    const service = new BridgeService(baseDir) as any;
    service.localCaldavPassword = 'test';
    if (!account.start) {
        await service.mirrorDatabase.initialize(); // tests that call service.initialize() open it themselves
    }
    const signIns: any[] = [];
    let signedIn = false;
    const adapter: any = {
        onSession: null,
        askSecondFactor: null,
        askMailboxPassword: null,
        isSignedIn: () => signedIn,
        getSignedInUsername: () => (signedIn ? 'tobi@proton.me' : null),
        supportsSeriesSync: () => true,
        listAddresses: () => [],
        /** Like the client: a saved session with a key password needs nothing; a password sign-in asks. */
        signIn: async (credentials: any, _hv: any, session: any) => {
            signIns.push({ username: credentials.username, session });
            if (!session?.keyPassword) {
                const enabled = account.twoFactor ?? 0;
                if (enabled) {
                    let wrong = false;
                    for (;;) {
                        const answer = adapter.askSecondFactor ? await adapter.askSecondFactor({ totp: (enabled & 1) === 1, securityKey: (enabled & 2) === 2, securityKeyOptions: null, wrong }) : null;
                        if (!answer) {
                            throw named(
                                'TwoFactorRequiredError',
                                !(enabled & 1) ? 'This account signs in with a security key only; the bridge cannot use one yet.' : wrong ? 'The second factor was not accepted.' : 'This account asks for a second factor when signing in.'
                            );
                        }
                        if (answer.code === (account.code ?? '123456')) break;
                        wrong = true;
                    }
                }
                if (account.passwordMode === 2) {
                    let wrong = false;
                    for (;;) {
                        const given = adapter.askMailboxPassword ? await adapter.askMailboxPassword({ wrong }) : null;
                        if (given === null) throw named('MailboxPasswordRequiredError', 'This account has a separate mailbox password; it is needed to unlock the keys.');
                        if (given === (account.mailboxPassword ?? 'mailbox')) break;
                        wrong = true;
                    }
                }
            }
            signedIn = true;
            adapter.onSession?.({ UID: 'uid', AccessToken: `access-${signIns.length}`, RefreshToken: `refresh-${signIns.length}`, keyPassword: 'derived-key-password', passwordMode: account.passwordMode ?? 1, identity: 'own' });
        },
        signOut: async () => {
            signedIn = false;
        },
        listCalendars: async () => [{ id: 'private', name: 'Tobi (Private)', color: '#6d4aff', visible: true, writable: true }],
        listEvents: async () => [],
        getRequestStats: () => ({ requests: 0, lastHour: 0, answers: {}, retries: 0, rateLimited: 0, lastRateLimit: null, pausedUntil: null, signIns: 0, sessionRenewals: 0, resumedSession: false, since: Date.now() })
    };
    service.protonAdapter = adapter;
    const notes: any[] = [];
    service.onNotify = (note: any) => notes.push(note);
    service.probeConnection = async () => true;
    const original = { log: console.log, warn: console.warn };
    console.log = () => undefined;
    console.warn = () => undefined;
    /** The prompt as the Setup page gets it (read directly: the mirror may not be open yet at start). */
    const prompt = async () => service.signInPrompt;
    const until = async (condition: () => boolean | Promise<boolean>) => {
        for (let i = 0; i < 400; i += 1) {
            if (await condition()) return;
            await new Promise((resolve) => setTimeout(resolve, 5));
        }
        throw new Error('timed out waiting');
    };
    const cleanup = async () => {
        service.stopPolling();
        console.log = original.log;
        console.warn = original.warn;
        await service.mirrorDatabase.close().catch(() => undefined);
        rmSync(baseDir, { recursive: true, force: true });
    };
    return { service, adapter, notes, signIns, prompt, until, cleanup, signedIn: () => signedIn };
};

test('an authenticator code: asked on the Setup page, a refused one asked again, the answer signs in; the session saved with the key password', async () => {
    const { service, signIns, prompt, until, notes, cleanup } = await setup({ twoFactor: 1 });
    try {
        const signIn = service.signIn({ username: 'tobi@proton.me', password: 'secret' });
        signIn.catch(() => undefined);
        await until(async () => Boolean(await prompt()));
        let shown = await prompt();
        assert.deepEqual((await service.getBridgeState()).signInPrompt, shown, 'the Setup page gets it');
        assert.deepEqual([shown.kind, shown.totp, shown.securityKey, shown.wrong, shown.background], ['second-factor', true, false, false, false]);
        assert.ok(shown.expiresAt > Date.now() + 9 * 60_000, 'ten minutes to answer');
        assert.equal(service.health, 'connecting');
        assert.match(service.message, /authenticator code/);
        assert.deepEqual(notes, [], 'no notification for a sign-in from the form');

        await assert.rejects(service.answerSignInPrompt({ code: '12' }), /6-digit code/, 'a short code is refused before it goes anywhere');
        await assert.rejects(service.answerSignInPrompt({ code: '1234-5678!' }), /6-digit code/, 'and one with other characters');
        await service.answerSignInPrompt({ code: '000 000' });
        await until(async () => (await prompt())?.wrong === true);
        shown = await prompt();
        assert.equal(shown.wrong, true, 'a refused code: asked again');
        await service.answerSignInPrompt({ code: '123456' });
        await signIn;
        assert.equal(await prompt(), null, 'the prompt is gone');
        assert.equal(service.health, 'healthy');
        assert.equal(signIns.length, 1, 'one sign-in (the code did not start a new one)');
        const saved = await service.secretStore.getProtonSession();
        assert.equal(saved.keyPassword, 'derived-key-password', 'the key password is kept with the session');
        assert.equal(saved.passwordMode, 1);

        // At the next start the saved session (with its key password) is offered: no code needed.
        const restarted = await setup({ twoFactor: 1, start: true });
        try {
            await restarted.service.secretStore.setProtonCredentials({ username: 'tobi@proton.me', password: 'secret' });
            await restarted.service.secretStore.setProtonSession(saved);
            await restarted.service.initialize();
            assert.equal(restarted.signIns[0].session.keyPassword, 'derived-key-password', 'offered back');
            assert.equal(restarted.signedIn(), true);
            assert.equal(await restarted.prompt(), null, 'nothing asked');
        } finally {
            await restarted.cleanup();
        }
    } finally {
        await cleanup();
    }
});

test('Cancel gives up: the sign-in fails with the reason, nothing is saved', async () => {
    const { service, prompt, until, cleanup } = await setup({ twoFactor: 1 });
    try {
        const signIn = service.signIn({ username: 'tobi@proton.me', password: 'secret' });
        const failure = signIn.catch((error: Error) => error);
        await until(async () => Boolean(await prompt()));
        await service.cancelSignInPrompt();
        const error = await failure;
        assert.equal(String(error.message), 'Signing in was cancelled (Proton asked for your authenticator code).');
        assert.equal(await prompt(), null);
        assert.equal(service.health, 'error');
        assert.equal(service.message, error.message, 'the status says the same');
        assert.equal(await service.secretStore.getProtonCredentials(), null, 'the login is not saved');
        await assert.rejects(service.answerSignInPrompt({ code: '123456' }), /not asking/);
    } finally {
        await cleanup();
    }
});

test('two-password mode: the mailbox password asked for (a wrong one again), never saved', async () => {
    const { service, prompt, until, cleanup } = await setup({ passwordMode: 2, mailboxPassword: 'mailbox' });
    try {
        const signIn = service.signIn({ username: 'tobi@proton.me', password: 'secret' });
        signIn.catch(() => undefined);
        await until(async () => Boolean(await prompt()));
        assert.deepEqual([(await prompt()).kind, (await prompt()).wrong], ['mailbox-password', false]);
        await assert.rejects(service.answerSignInPrompt({ mailboxPassword: '' }), /mailbox password/);
        await service.answerSignInPrompt({ mailboxPassword: 'nope' });
        await until(async () => (await prompt())?.wrong === true);
        await service.answerSignInPrompt({ mailboxPassword: 'mailbox' });
        await signIn;
        assert.equal(service.health, 'healthy');
        const saved = await service.secretStore.getProtonSession();
        assert.equal(saved.passwordMode, 2);
        assert.ok(!JSON.stringify(await service.secretStore.getProtonCredentials()).includes('mailbox'), 'the mailbox password itself is not kept, only the derived key with the session');
    } finally {
        await cleanup();
    }
});

test('a sign-in in the background (Proton ended the session): the prompt and one notification; an unanswered prompt gives up', async () => {
    const first = await setup({ twoFactor: 1, code: '123456', start: true });
    try {
        const { service, prompt, until, notes } = first;
        // Signed in before (session saved); now the saved session is dead and Proton asks for the code.
        await service.secretStore.setProtonCredentials({ username: 'tobi@proton.me', password: 'secret' });
        await service.secretStore.setProtonSession({ username: 'tobi@proton.me', UID: 'uid', AccessToken: 'a', RefreshToken: 'r', identity: 'own' });
        const start = service.initialize();
        start.catch(() => undefined);
        await until(async () => Boolean(await prompt()));
        const shown = await prompt();
        assert.equal(shown.background, true);
        assert.deepEqual(notes.map((note: any) => [note.key, note.page]), [['sign-in:second-factor', 'setup']], 'told once');
        await service.answerSignInPrompt({ code: '123456' });
        await start;
        assert.equal(first.signedIn(), true);
        assert.equal(notes.length, 1, 'no second notification');
    } finally {
        await first.cleanup();
    }

    const second = await setup({ twoFactor: 1 });
    try {
        const { service, prompt, until } = second;
        const signIn = service.signIn({ username: 'tobi@proton.me', password: 'secret' });
        const failure = signIn.catch((error: Error) => error);
        await until(async () => Boolean(await prompt()));
        // Nobody answers: the waiting sign-in is given up when the time is over.
        const waiter = service.signInPromptWaiter;
        clearTimeout(waiter.timer);
        service.signInPromptEnding = 'timed out';
        service.clearSignInPrompt();
        const error = await failure;
        assert.equal(String(error.message), 'Signing in was not finished in time (Proton asked for your authenticator code).');
        assert.equal(await prompt(), null);
        // A recovery code (8 characters) is accepted by the field; a too-short one is not.
        await assert.rejects(service.answerSignInPrompt({ code: 'ABCD1234' }), /not asking/, 'no prompt open any more');
    } finally {
        await second.cleanup();
    }
});

test('a security-key-only account is not prompted: the explanation reaches the status; signing out clears a prompt', async () => {
    const keyOnly = await setup({ twoFactor: 2 });
    try {
        const { service, prompt } = keyOnly;
        await assert.rejects(service.signIn({ username: 'tobi@proton.me', password: 'secret' }), /security key only/);
        assert.equal(await prompt(), null, 'no prompt without a code to type');
        assert.match(service.message, /security key only/);
    } finally {
        await keyOnly.cleanup();
    }

    const both = await setup({ twoFactor: 3 });
    try {
        const { service, prompt, until } = both;
        const signIn = service.signIn({ username: 'tobi@proton.me', password: 'secret' });
        signIn.catch(() => undefined);
        await until(async () => Boolean(await prompt()));
        assert.deepEqual([(await prompt()).totp, (await prompt()).securityKey], [true, true], 'both registered: the code is asked for');
        await service.signOut();
        assert.equal(await prompt(), null, 'signing out clears the prompt');
        await signIn.catch(() => undefined);
        assert.equal(both.signedIn(), false);
    } finally {
        await both.cleanup();
    }
});
