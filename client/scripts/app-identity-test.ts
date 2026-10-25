/**
 * Offline test (stage 16; 0.50): the client's identity towards Proton. Every request — sign-in,
 * renewal, API calls — carries the app's own x-pm-appversion and User-Agent (Credentials.appIdentity),
 * or the library's own when the app gives none; the password sign-in is the plain SRP one (no
 * anonymous session first, no device fingerprint); nothing names a Proton app anywhere.
 */
import { ProtonCalendarAPI } from '../src/proton-calendar-api.ts';
import { RequestControl } from '../src/request-control.ts';

let failures = 0;
const check = (condition: unknown, label: string) => {
    console.log(`${condition ? 'ok  ' : 'FAIL'} ${label}`);
    if (!condition) failures += 1;
};
const jsonResponse = (status: number, data: any) => ({
    status,
    ok: status >= 200 && status < 300,
    headers: { get: () => null },
    text: async () => JSON.stringify(data),
    arrayBuffer: async () => new ArrayBuffer(0)
});
const OWN = { appVersion: 'Other', userAgent: 'NeutronCalendarBridge/0.50.0 (macOS; +https://example.test)' };

const signInAttempt = async (credentials: any) => {
    const api: any = new ProtonCalendarAPI({ username: 'tobi@proton.test', password: 'secret', ...credentials });
    api.control = new RequestControl({ random: () => 0.5, sleep: async () => undefined });
    const log: Array<{ path: string; headers: Record<string, string>; body: any }> = [];
    api.fetchImpl = async (url: string, init: any) => {
        const path = new URL(url).pathname;
        log.push({ path, headers: init.headers ?? {}, body: init.body ? JSON.parse(init.body) : undefined });
        // Ends the sign-in after the info step (the SRP proof itself is Proton's code and needs a signed modulus).
        if (path.endsWith('/core/v4/auth/info')) return jsonResponse(422, { Code: 2001, Error: 'stop here' });
        return jsonResponse(404, { Code: 2501 });
    };
    const original = console.log;
    console.log = () => undefined;
    try {
        await api.initialize();
    } catch {
        // expected: stopped at the info step
    } finally {
        console.log = original;
    }
    return log;
};

const own = await signInAttempt({ appIdentity: OWN });
check(!own.some((entry) => entry.path.endsWith('/auth/v4/sessions')), 'no anonymous session first');
const info = own.find((entry) => entry.path.endsWith('/core/v4/auth/info'));
check(own[0] === info, 'the sign-in starts with the auth info');
check(info?.headers['x-pm-appversion'] === 'Other' && info?.headers['User-Agent'] === OWN.userAgent, "sent with the app's own name and User-Agent");
check(info && !info.headers.Authorization && !info.headers['x-pm-uid'], "without an anonymous session's token");
check(info?.body && !('Payload' in info.body), 'no device fingerprint in the body');
check(!own.some((entry) => /ios|iphone|protonmail\/|web-account/i.test(JSON.stringify(entry))), 'nothing of a Proton app in any request');

const library = await signInAttempt({});
const libraryInfo = library.find((entry) => entry.path.endsWith('/core/v4/auth/info'));
check(libraryInfo?.headers['x-pm-appversion'] === 'Other' && /^proton-calendar-client\/\d/.test(libraryInfo?.headers['User-Agent'] ?? ''), `without an app identity: the library's own (${libraryInfo?.headers['User-Agent']})`);
check(!library.some((entry) => /ios|iphone|protonmail\/|web-account/i.test(JSON.stringify(entry))), 'and nothing of a Proton app either');

// A session opened under the own identity: API calls and renewals keep it.
const api: any = new ProtonCalendarAPI({ username: 'tobi@proton.test', password: '', appIdentity: OWN });
api.control = new RequestControl({ random: () => 0.5, sleep: async () => undefined });
api.session = { UID: 'uid-1', AccessToken: 'access-1', RefreshToken: 'refresh-1' };
const headers = api.getRequestHeaders(true, false);
check(headers['x-pm-appversion'] === 'Other' && headers['User-Agent'] === OWN.userAgent && headers.Authorization === 'Bearer access-1', 'API calls: the own identity, the session token');
check(!('Origin' in headers) && !('Referer' in headers) && !('Cookie' in headers), 'no browser-like headers');
const renewals: any[] = [];
api.fetchImpl = async (url: string, init: any) => {
    renewals.push({ path: new URL(url).pathname, headers: init.headers });
    return jsonResponse(200, { Code: 1000, AccessToken: 'access-2', RefreshToken: 'refresh-2', UID: 'uid-1' });
};
const original = console.log;
console.log = () => undefined;
const renewed = await api.renewSession();
console.log = original;
check(renewed && renewals[0]?.path.endsWith('/auth/v4/refresh') && renewals[0].headers['x-pm-appversion'] === 'Other', 'renewal: the own identity');

if (failures) {
    console.error(`${failures} check(s) failed`);
    process.exit(1);
}
console.log('app identity: all checks passed');
