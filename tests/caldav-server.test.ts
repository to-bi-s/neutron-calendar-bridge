import test from 'node:test';
import assert from 'node:assert/strict';

import { createHash } from 'node:crypto';
import { request as httpRequest } from 'node:http';

import { CalDAVServer } from '../src/main/caldav-server';
import { basicAuth, loginFetch, withLogin } from './support/caldav-login';

const fetch = loginFetch('bridge-user', 'bridge-pass');

const basicAuthHeader = (username: string, password: string) =>
    `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;

test('caldav server serves collections and delegates event writes', async () => {
    const calls: string[] = [];
    const fakeBridgeService = {
        isSignedIn() {
            return true;
        },
        getCalDAVConfig() {
            return {
                host: '127.0.0.1',
                port: 32991,
                username: 'bridge-user',
                password: 'bridge-pass',
                security: 'HTTP' as const,
                baseUrl: 'http://127.0.0.1:32991',
                serverPath: '/principals/bridge-user/'
            };
        },
        async getBridgeState() {
            return {
                health: 'healthy',
                signedIn: true,
                username: 'fake-fixture-user',
                calendars: [],
                caldav: {
                    host: '127.0.0.1',
                    port: 32991,
                    username: 'bridge-user',
                    security: 'HTTP' as const,
                    baseUrl: 'http://127.0.0.1:32991',
                    serverPath: '/principals/bridge-user/'
                },
                openAtLogin: false,
                lastSuccessfulSyncAt: null,
                lastAttemptedSyncAt: null,
                message: 'ok',
                pendingHumanVerification: null
            };
        },
        async getCalendars() {
            return [
                {
                    protonCalendarId: 'calendar-1',
                    slug: 'calendar-1',
                    displayName: 'Calendar One',
                    color: '#123456',
                    description: '',
                    visible: true,
                    removed: false,
                    ctag: 'ctag-1',
                    lastPolledAt: null,
                    lastSyncedAt: null
                }
            ];
        },
        async getCalendarBySlug(slug: string) {
            if (slug !== 'calendar-1') {
                return null;
            }
            return {
                protonCalendarId: 'calendar-1',
                slug: 'calendar-1',
                displayName: 'Calendar One',
                color: '#123456',
                description: '',
                visible: true,
                removed: false,
                ctag: 'ctag-1',
                lastPolledAt: null,
                lastSyncedAt: null
            };
        },
        async listEventsForSlug() {
            return [
                {
                    protonEventId: 'event-1',
                    protonCalendarId: 'calendar-1',
                    uid: 'uid-1',
                    href: '/calendars/bridge-user/calendar-1/uid-1.ics',
                    etag: '"etag-1"',
                    contentHash: 'hash-1',
                    serializedIcs:
                        'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:uid-1\r\nSUMMARY:Event One\r\nDTSTART:20260312T180000Z\r\nDTEND:20260312T183000Z\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n',
                    title: 'Event One',
                    description: '',
                    location: '',
                    startTimestamp: 1,
                    endTimestamp: 2,
                    timezone: 'UTC',
                    isAllDay: false,
                    modifiedTimestamp: 3,
                    deleted: false,
                    lastSyncedAt: 4
                },
                {
                    protonEventId: 'event-2',
                    protonCalendarId: 'calendar-1',
                    uid: 'uid-deleted',
                    href: '/calendars/bridge-user/calendar-1/uid-deleted.ics',
                    etag: '"etag-deleted"',
                    contentHash: 'hash-deleted',
                    serializedIcs:
                        'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:uid-deleted\r\nSUMMARY:Deleted Event\r\nDTSTART:20260312T190000Z\r\nDTEND:20260312T193000Z\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n',
                    title: 'Deleted Event',
                    description: '',
                    location: '',
                    startTimestamp: 5,
                    endTimestamp: 6,
                    timezone: 'UTC',
                    isAllDay: false,
                    modifiedTimestamp: 7,
                    deleted: true,
                    lastSyncedAt: 10
                }
            ];
        },
        async upsertLocalEvent() {
            calls.push('put');
            return {
                etag: '"etag-2"'
            };
        },
        async deleteLocalEvent() {
            calls.push('delete');
        }
    };

    const server = new CalDAVServer(withLogin(fakeBridgeService) as any);
    await server.start();

    try {
        const wellKnownResponse = await fetch('http://127.0.0.1:32991/.well-known/caldav', {
            method: 'PROPFIND'
        });
        const wellKnownBody = await wellKnownResponse.text();
        assert.equal(wellKnownResponse.status, 207);
        assert.match(wellKnownBody, /current-user-principal/);

        const propfindResponse = await fetch('http://127.0.0.1:32991/calendars/bridge-user/', {
            method: 'PROPFIND',
            headers: {
                Authorization: basicAuthHeader('bridge-user', 'bridge-pass')
            }
        });
        const propfindBody = await propfindResponse.text();
        assert.equal(propfindResponse.status, 207);
        assert.match(propfindBody, /Calendar One/);
        assert.match(propfindBody, /supported-calendar-component-set/);
        assert.match(propfindBody, /calendarserver\.org\/ns/);

        const collectionDepthResponse = await fetch('http://127.0.0.1:32991/calendars/bridge-user/calendar-1/', {
            method: 'PROPFIND',
            headers: {
                Authorization: basicAuthHeader('bridge-user', 'bridge-pass'),
                Depth: '1'
            }
        });
        const collectionDepthBody = await collectionDepthResponse.text();
        assert.equal(collectionDepthResponse.status, 207);
        assert.match(collectionDepthBody, /uid-1\.ics/);
        assert.match(collectionDepthBody, /sync-token/);

        const reportResponse = await fetch('http://127.0.0.1:32991/calendars/bridge-user/calendar-1/', {
            method: 'REPORT',
            headers: {
                Authorization: basicAuthHeader('bridge-user', 'bridge-pass'),
                'Content-Type': 'application/xml; charset=utf-8'
            },
            body: `<?xml version="1.0" encoding="utf-8"?>
<D:sync-collection xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
  <D:sync-token>http://127.0.0.1:32991/sync/calendar-1/ctag-0</D:sync-token>
  <D:sync-level>1</D:sync-level>
  <D:prop>
    <D:getetag />
    <C:calendar-data />
  </D:prop>
</D:sync-collection>`
        });
        const reportBody = await reportResponse.text();
        assert.equal(reportResponse.status, 207);
        assert.match(reportBody, /calendar-data/);
        assert.match(reportBody, /sync-token/);
        assert.match(reportBody, /uid-deleted\.ics/);
        assert.match(reportBody, /404 Not Found/);

        const multiget404Response = await fetch('http://127.0.0.1:32991/calendars/bridge-user/calendar-1/', {
            method: 'REPORT',
            headers: {
                Authorization: basicAuthHeader('bridge-user', 'bridge-pass'),
                'Content-Type': 'application/xml; charset=utf-8'
            },
            body: `<?xml version="1.0" encoding="utf-8"?>
<C:calendar-multiget xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
  <D:prop>
    <D:getetag />
    <C:calendar-data />
  </D:prop>
  <D:href>/calendars/bridge-user/calendar-1/uid-1.ics</D:href>
  <D:href>/calendars/bridge-user/calendar-1/missing.ics</D:href>
</C:calendar-multiget>`
        });
        const multiget404Body = await multiget404Response.text();
        assert.equal(multiget404Response.status, 207);
        assert.match(multiget404Body, /uid-1\.ics/);
        assert.match(multiget404Body, /404 Not Found/);

        const collectionGetResponse = await fetch('http://127.0.0.1:32991/calendars/bridge-user/calendar-1/', {
            headers: {
                Authorization: basicAuthHeader('bridge-user', 'bridge-pass')
            }
        });
        const collectionGetBody = await collectionGetResponse.text();
        assert.equal(collectionGetResponse.status, 200);
        assert.match(collectionGetBody, /CalDAV collection for Calendar One/);

        const putResponse = await fetch('http://127.0.0.1:32991/calendars/bridge-user/calendar-1/uid-2.ics', {
            method: 'PUT',
            headers: {
                Authorization: basicAuthHeader('bridge-user', 'bridge-pass'),
                'Content-Type': 'text/calendar'
            },
            body: 'BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:uid-2\r\nSUMMARY:Write Through\r\nDTSTART:20260312T180000Z\r\nDTEND:20260312T183000Z\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n'
        });
        assert.equal(putResponse.status, 201);

        const deleteResponse = await fetch('http://127.0.0.1:32991/calendars/bridge-user/calendar-1/uid-2.ics', {
            method: 'DELETE',
            headers: {
                Authorization: basicAuthHeader('bridge-user', 'bridge-pass')
            }
        });
        assert.equal(deleteResponse.status, 204);
        assert.deepEqual(calls, ['put', 'delete']);
    } finally {
        await server.stop();
    }
});

test('caldav server returns 503 when the bridge is disconnected', async () => {
    const fakeBridgeService = {
        isSignedIn() {
            return false;
        },
        getCalDAVConfig() {
            return {
                host: '127.0.0.1',
                port: 32992,
                username: 'bridge-user',
                password: 'bridge-pass',
                security: 'HTTP' as const,
                baseUrl: 'http://127.0.0.1:32992',
                serverPath: '/principals/bridge-user/'
            };
        },
        async getBridgeState() {
            return {
                health: 'disconnected' as const,
                signedIn: false,
                username: null,
                calendars: [],
                caldav: {
                    host: '127.0.0.1',
                    port: 32992,
                    username: 'bridge-user',
                    security: 'HTTP' as const,
                    baseUrl: 'http://127.0.0.1:32992',
                    serverPath: '/principals/bridge-user/'
                },
                openAtLogin: false,
                lastSuccessfulSyncAt: null,
                lastAttemptedSyncAt: null,
                message: 'Signed out',
                pendingHumanVerification: null
            };
        }
    };

    const server = new CalDAVServer(withLogin(fakeBridgeService) as any);
    await server.start();

    try {
        const response = await fetch('http://127.0.0.1:32992/calendars/bridge-user/', {
            method: 'PROPFIND',
            headers: {
                Authorization: basicAuthHeader('bridge-user', 'bridge-pass')
            }
        });

        assert.equal(response.status, 503);
        assert.match(await response.text(), /Bridge disconnected/);
    } finally {
        await server.stop();
    }
});

test('caldav server answers 403 when Calendar.app tries to change a recurring series', async () => {
    const { ReadOnlyEventError } = await import('../src/main/recurrence');
    const fakeBridgeService = {
        isSignedIn() {
            return true;
        },
        getCalDAVConfig() {
            return {
                host: '127.0.0.1',
                port: 32993,
                username: 'bridge-user',
                password: 'bridge-pass',
                security: 'HTTP' as const,
                baseUrl: 'http://127.0.0.1:32993',
                serverPath: '/principals/bridge-user/'
            };
        },
        async listEventsForSlug() {
            return [];
        },
        async upsertLocalEvent() {
            throw new ReadOnlyEventError('Recurring events are read-only');
        },
        async deleteLocalEvent() {
            throw new ReadOnlyEventError('Recurring events are read-only');
        }
    };

    const server = new CalDAVServer(withLogin(fakeBridgeService) as any);
    await server.start();

    try {
        const putResponse = await fetch('http://127.0.0.1:32993/calendars/bridge-user/work/series.ics', {
            method: 'PUT',
            headers: { 'Content-Type': 'text/calendar; charset=utf-8' },
            body: 'BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:series\r\nRRULE:FREQ=WEEKLY\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n'
        });
        assert.equal(putResponse.status, 403);
        assert.match(await putResponse.text(), /read-only/);

        const deleteResponse = await fetch('http://127.0.0.1:32993/calendars/bridge-user/work/series.ics', {
            method: 'DELETE'
        });
        assert.equal(deleteResponse.status, 403);
    } finally {
        await server.stop();
    }
});

test('caldav server answers 500 with the reason (instead of hanging) and records the failure', async () => {
    const recorded: Array<{ method: string; path: string; status: number; message: string }> = [];
    const fakeBridgeService = {
        isSignedIn() {
            return true;
        },
        getCalDAVConfig() {
            return {
                host: '127.0.0.1',
                port: 32994,
                username: 'bridge-user',
                password: 'bridge-pass',
                security: 'HTTP' as const,
                baseUrl: 'http://127.0.0.1:32994',
                serverPath: '/principals/bridge-user/'
            };
        },
        async getCalendarBySlug() {
            throw new Error('SQLITE_BUSY: database is locked');
        },
        async upsertLocalEvent() {
            throw new Error('Failed to update Proton event');
        },
        recordCalDAVError(entry: { method: string; path: string; status: number; message: string }) {
            recorded.push(entry);
        }
    };

    const server = new CalDAVServer(withLogin(fakeBridgeService) as any);
    await server.start();

    try {
        const propfind = await fetch('http://127.0.0.1:32994/calendars/bridge-user/tobi-private/', {
            method: 'PROPFIND',
            headers: { Depth: '1' },
            signal: AbortSignal.timeout(3000)
        });
        assert.equal(propfind.status, 500);
        assert.match(await propfind.text(), /SQLITE_BUSY/);

        const put = await fetch('http://127.0.0.1:32994/calendars/bridge-user/tobi-private/x.ics', {
            method: 'PUT',
            body: 'BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n',
            signal: AbortSignal.timeout(3000)
        });
        assert.equal(put.status, 500);

        assert.deepEqual(
            recorded.map((entry) => [entry.method, entry.path, entry.status, entry.message]),
            [
                ['PROPFIND', '/calendars/bridge-user/tobi-private/', 500, 'SQLITE_BUSY: database is locked'],
                ['PUT', '/calendars/bridge-user/tobi-private/x.ics', 500, 'Failed to update Proton event']
            ]
        );
    } finally {
        await server.stop();
    }
});

test('caldav server: web pages are refused (Origin, DNS rebinding), no CORS headers', async () => {
    const fakeBridgeService = {
        isSignedIn: () => true,
        getCalDAVConfig: () => ({
            host: '127.0.0.1',
            port: 33021,
            username: 'bridge-user',
            password: 'bridge-pass',
            security: 'HTTP' as const,
            baseUrl: 'http://127.0.0.1:33021',
            serverPath: '/principals/bridge-user/'
        }),
        getCalendars: async () => [],
        recordCalDAVError: () => undefined
    };
    const send = (headers: Record<string, string>) =>
        new Promise<{ status: number; headers: Record<string, unknown>; body: string }>((resolve, reject) => {
            const request = httpRequest(
                {
                    host: '127.0.0.1',
                    port: 33021,
                    method: 'PROPFIND',
                    path: '/calendars/bridge-user/',
                    headers: { Depth: '1', Authorization: basicAuth('bridge-user', 'bridge-pass'), ...headers }
                },
                (response) => {
                    let body = '';
                    response.on('data', (chunk) => (body += chunk));
                    response.on('end', () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body }));
                }
            );
            request.on('error', reject);
            request.end();
        });
    const server = new CalDAVServer(withLogin(fakeBridgeService) as any);
    const warnings: string[] = [];
    const original = { log: console.log, warn: console.warn };
    console.log = () => undefined;
    console.warn = (...parts: unknown[]) => warnings.push(parts.join(' '));
    await server.start();
    try {
        // Calendar.app: its Host is this Mac's address, and it sends no Origin.
        for (const host of ['127.0.0.1:33021', 'localhost:33021', '[::1]:33021']) {
            const ok = await send({ Host: host });
            assert.equal(ok.status, 207, host);
            assert.equal(ok.headers['access-control-allow-origin'], undefined, 'no CORS headers');
        }

        // 0.48.3: Thunderbird sends Origin with the bridge's own address: allowed. Any other origin is not,
        // nor the own origin under another host (or port).
        assert.equal((await send({ Host: '127.0.0.1:33021', Origin: 'http://127.0.0.1:33021' })).status, 207, 'Thunderbird: same origin');
        assert.equal((await send({ Host: 'localhost:33021', Origin: 'http://localhost:33021' })).status, 207);
        assert.equal((await send({ Host: '127.0.0.1:33021', Origin: 'http://localhost:33021' })).status, 403, 'another origin');
        assert.equal((await send({ Host: '127.0.0.1:33021', Origin: 'http://127.0.0.1:8080' })).status, 403, 'another port');
        assert.equal((await send({ Host: '127.0.0.1:33021', Origin: 'null' })).status, 403);
        const fromPage = await send({ Host: '127.0.0.1:33021', Origin: 'https://evil.example' });
        assert.equal(fromPage.status, 403);
        assert.match(fromPage.body, /not web pages/);
        const rebound = await send({ Host: 'evil.example:33021' });
        assert.equal(rebound.status, 403, 'a domain name pointed at 127.0.0.1');
        assert.ok(warnings.some((line) => /refused: a web page \(Origin: https:\/\/evil\.example\)/.test(line)));
        assert.ok(warnings.some((line) => /refused: unexpected host name "evil\.example:33021"/.test(line)));
    } finally {
        console.log = original.log;
        console.warn = original.warn;
        await server.stop();
    }
});

test('caldav server: Proton asked to slow down → 503 with Retry-After', async () => {
    const fakeBridgeService = {
        isSignedIn: () => true,
        getCalDAVConfig: () => ({
            host: '127.0.0.1', port: 32996, username: 'bridge-user', password: 'bridge-pass', security: 'HTTP' as const,
            baseUrl: 'http://127.0.0.1:32996', serverPath: '/principals/bridge-user/'
        }),
        getCalendarBySlug: async () => ({ protonCalendarId: 'c', slug: 'calendar-1', displayName: 'C', color: '#123456', description: '', visible: true, removed: false, ctag: '1', lastPolledAt: null, lastSyncedAt: null }),
        listEventsForSlug: async () => [],
        upsertLocalEvent: async () => {
            throw Object.assign(new Error('Proton asked to slow down; requests wait until later'), { name: 'RateLimitedError', retryAt: Date.now() + 120_000 });
        },
        recordCalDAVError: () => undefined
    };
    const server = new CalDAVServer(withLogin(fakeBridgeService) as any);
    const original = { log: console.log, error: console.error };
    console.log = () => undefined;
    console.error = () => undefined;
    await server.start();
    try {
        const response = await fetch('http://127.0.0.1:32996/calendars/bridge-user/calendar-1/new.ics', {
            method: 'PUT',
            headers: { 'Content-Type': 'text/calendar' },
            body: 'BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n'
        });
        assert.equal(response.status, 503);
        const retryAfter = Number(response.headers.get('retry-after'));
        assert.ok(retryAfter >= 110 && retryAfter <= 120, `Retry-After ${retryAfter}`);
    } finally {
        console.log = original.log;
        console.error = original.error;
        await server.stop();
    }
});

test('caldav server: Calendar.app signs in (Basic auth); without the right password nothing is served', async () => {
    const logins: Array<string | null> = [];
    const fakeBridgeService = {
        isSignedIn: () => true,
        getCalDAVConfig: () => ({
            host: '127.0.0.1',
            port: 32998,
            username: 'bridge-user',
            password: 'bridge-pass',
            security: 'HTTP' as const,
            baseUrl: 'http://127.0.0.1:32998',
            serverPath: '/principals/bridge-user/'
        }),
        getCalendars: async () => [],
        getBridgeState: async () => ({ username: 'tobi@proton.me' }),
        recordCalDAVError: () => assert.fail('a refused login is not a failed Calendar.app request')
    };
    const fake = withLogin(fakeBridgeService);
    const check = fake.checkCalDAVLogin;
    fake.checkCalDAVLogin = (login) => {
        logins.push(login && `${login.username}:${login.password}`);
        return check(login);
    };
    const server = new CalDAVServer(fake as any);
    const original = console.log;
    console.log = () => undefined;
    await server.start();
    const base = 'http://127.0.0.1:32998';
    const bare = (path: string, init: RequestInit = {}) => globalThis.fetch(`${base}${path}`, init);
    try {
        // Open: OPTIONS and the redirect, which reveal nothing.
        assert.equal((await bare('/calendars/bridge-user/', { method: 'OPTIONS' })).status, 204);
        const redirect = await bare('/.well-known/caldav', { redirect: 'manual' });
        assert.equal(redirect.status, 302);
        assert.equal(redirect.headers.get('location'), '/principals/bridge-user/');
        assert.deepEqual(logins, [], 'no login asked for those');

        // Everything else asks for the login (Calendar.app then sends it).
        // Finding the account is open too: it only names the principal's address.
        for (const path of ['/', '/.well-known/caldav']) {
            const discovery = await bare(path, { method: 'PROPFIND' });
            assert.equal(discovery.status, 207, `PROPFIND ${path}`);
            assert.match(await discovery.text(), /<D:href>\/principals\/bridge-user\/<\/D:href>/);
        }
        assert.deepEqual(logins, [], 'no login asked for those');

        for (const [method, path] of [
            ['PROPFIND', '/principals/bridge-user/'],
            ['PROPFIND', '/calendars/bridge-user/'],
            ['GET', '/bridge/status'],
            ['PUT', '/calendars/bridge-user/calendar-1/new.ics']
        ]) {
            const response = await bare(path, { method });
            assert.equal(response.status, 401, `${method} ${path}`);
            assert.match(response.headers.get('www-authenticate')!, /Basic realm="Neutron Calendar Bridge", charset="UTF-8"/);
            assert.match(await response.text(), /Setup page/);
        }
        const wrong = await bare('/calendars/bridge-user/', { method: 'PROPFIND', headers: { Authorization: basicAuth('bridge-user', 'old-pass') } });
        assert.equal(wrong.status, 401);
        assert.equal((await bare('/bridge/status', { headers: { Authorization: basicAuth('bridge-user', '') } })).status, 401, 'an empty password');
        assert.equal((await bare('/bridge/status', { headers: { Authorization: basicAuth('bridge-user', 'old-pass') } })).status, 401);

        const right = await bare('/calendars/bridge-user/', { method: 'PROPFIND', headers: { Authorization: basicAuth('bridge-user', 'bridge-pass'), Depth: '1' } });
        assert.equal(right.status, 207);
        const status = await bare('/bridge/status', { headers: { Authorization: basicAuth('bridge-user', 'bridge-pass') } });
        assert.deepEqual(await status.json(), { username: 'tobi@proton.me' });
        assert.ok(logins.includes('bridge-user:old-pass') && logins.includes(null));
    } finally {
        console.log = original;
        await server.stop();
    }
});

/** A Digest client like macOS Calendar: answers the challenge with MD5, qop=auth and a growing nonce count. */
const digestClient = (username: string, password: string) => {
    const md5 = (text: string) => createHash('md5').update(text).digest('hex');
    let nc = 0;
    return {
        answer(challenge: string, method: string, uri: string, overrides: Record<string, string> = {}) {
            const field = (name: string) => challenge.match(new RegExp(`${name}="([^"]+)"`))?.[1] ?? challenge.match(new RegExp(`${name}=([^,\\s]+)`))?.[1];
            const realm = field('realm')!;
            const nonce = overrides.nonce ?? field('nonce')!;
            const cnonce = 'abc123';
            nc += 1;
            const count = overrides.nc ?? nc.toString(16).padStart(8, '0');
            const ha1 = md5(`${username}:${realm}:${password}`);
            const ha2 = md5(`${method}:${uri}`);
            const response = md5(`${ha1}:${nonce}:${count}:${cnonce}:auth:${ha2}`);
            return `Digest username="${username}", realm="${realm}", nonce="${nonce}", uri="${uri}", qop=auth, nc=${count}, cnonce="${cnonce}", response="${response}", opaque="${field('opaque')}", algorithm=MD5`;
        }
    };
};

test('caldav server: Calendar.app signs in with Digest over plain HTTP (it never sends Basic there)', async () => {
    const fakeBridgeService = {
        isSignedIn: () => true,
        getCalDAVConfig: () => ({
            host: '127.0.0.1',
            port: 32999,
            username: 'bridge-user',
            password: 'bridge-pass',
            security: 'HTTP' as const,
            baseUrl: 'http://127.0.0.1:32999',
            serverPath: '/principals/bridge-user/'
        }),
        getCalendars: async () => [],
        getSignedInUsername: () => 'tobi@proton.me',
        listAddresses: () => [],
        recordCalDAVError: () => assert.fail('a refused login is not a failed Calendar.app request')
    };
    const server = new CalDAVServer(withLogin(fakeBridgeService) as any);
    const original = console.log;
    const requestLines: string[] = [];
    console.log = (...parts: unknown[]) => {
        const line = parts.join(' ');
        if (line.includes('[caldav] PROPFIND')) requestLines.push(line);
    };
    await server.start();
    const base = 'http://127.0.0.1:32999';
    const bare = (path: string, init: RequestInit = {}) => globalThis.fetch(`${base}${path}`, init);
    try {
        // The challenge offers Digest (first) and Basic.
        const first = await bare('/principals/bridge-user/', { method: 'PROPFIND' });
        assert.equal(first.status, 401);
        const challenges = first.headers.get('www-authenticate')!;
        assert.match(challenges, /Digest realm="Neutron Calendar Bridge", qop="auth", algorithm=MD5, nonce="[0-9a-f]{32}", opaque="[0-9a-f]{16}"/);
        assert.match(challenges, /Basic realm="Neutron Calendar Bridge"/);
        const digestChallenge = challenges.split(/,\s*(?=Basic )/)[0];

        // The right password, answered like macOS does: served.
        const client = digestClient('bridge-user', 'bridge-pass');
        const ok = await bare('/principals/bridge-user/', { method: 'PROPFIND', headers: { Authorization: client.answer(digestChallenge, 'PROPFIND', '/principals/bridge-user/'), Depth: '0' } });
        assert.equal(ok.status, 207, 'Digest with the right password');
        // The same nonce again with a higher count: fine (that is how clients keep going).
        const again = await bare('/calendars/bridge-user/', { method: 'PROPFIND', headers: { Authorization: client.answer(digestChallenge, 'PROPFIND', '/calendars/bridge-user/'), Depth: '1' } });
        assert.equal(again.status, 207);
        // 0.48.4: out of order is fine (Thunderbird's parallel requests): count 4 before count 3.
        const fourth = await bare('/calendars/bridge-user/', { method: 'PROPFIND', headers: { Authorization: client.answer(digestChallenge, 'PROPFIND', '/calendars/bridge-user/', { nc: '00000004' }), Depth: '1' } });
        assert.equal(fourth.status, 207, 'count 4 first');
        const third = await bare('/calendars/bridge-user/', { method: 'PROPFIND', headers: { Authorization: client.answer(digestChallenge, 'PROPFIND', '/calendars/bridge-user/', { nc: '00000003' }), Depth: '1' } });
        assert.equal(third.status, 207, 'then count 3: accepted, not taken for a replay');
        // A replay (a nonce count used before): no access; a fresh challenge marked stale, as the password was right.
        const replay = await bare('/calendars/bridge-user/', { method: 'PROPFIND', headers: { Authorization: client.answer(digestChallenge, 'PROPFIND', '/calendars/bridge-user/', { nc: '00000001' }), Depth: '1' } });
        assert.equal(replay.status, 401, 'a replayed nonce count');
        assert.match(replay.headers.get('www-authenticate')!, /stale=true/);
        // The URI signed must be the one requested.
        const otherUri = await bare('/calendars/bridge-user/', { method: 'PROPFIND', headers: { Authorization: client.answer(digestChallenge, 'PROPFIND', '/principals/bridge-user/') } });
        assert.equal(otherUri.status, 401);

        // The wrong password: 401, a fresh challenge, not marked stale.
        const wrong = digestClient('bridge-user', 'old-pass');
        const refused = await bare('/principals/bridge-user/', { method: 'PROPFIND', headers: { Authorization: wrong.answer(digestChallenge, 'PROPFIND', '/principals/bridge-user/') } });
        assert.equal(refused.status, 401);
        assert.doesNotMatch(refused.headers.get('www-authenticate')!, /stale=true/);

        // A nonce the server never issued, with the right password: stale (Calendar.app retries by itself, no prompt).
        const stale = await bare('/principals/bridge-user/', { method: 'PROPFIND', headers: { Authorization: client.answer(digestChallenge, 'PROPFIND', '/principals/bridge-user/', { nonce: 'f'.repeat(32) }) } });
        assert.equal(stale.status, 401);
        assert.match(stale.headers.get('www-authenticate')!, /stale=true/);

        // The user name is not checked (an account from before may hold any), the password is.
        const otherUser = digestClient('tobi@proton.me', 'bridge-pass');
        const fresh = await bare('/principals/bridge-user/', { method: 'PROPFIND' });
        const otherOk = await bare('/principals/bridge-user/', { method: 'PROPFIND', headers: { Authorization: otherUser.answer(fresh.headers.get('www-authenticate')!.split(/,\s*(?=Basic )/)[0], 'PROPFIND', '/principals/bridge-user/'), Depth: '0' } });
        assert.equal(otherOk.status, 207);

        // The request lines name the scheme, never the user name (0.37.2: Digest was logged as "none";
        // the address this client signed in with must not appear in the quiet log).
        assert.match(requestLines[0], / -> 401 auth=none /);
        assert.match(requestLines[1], / -> 207 auth=digest /);
        assert.ok(requestLines.every((line) => !line.includes('tobi@proton.me') && !line.includes('bridge-user" ')), requestLines.join('\n'));
    } finally {
        console.log = original;
        await server.stop();
    }
});

test('detailed logging: the property names of a PROPFIND, as Calendar.app writes them (per-element namespaces)', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { requestedPropertyNames } = require('../src/main/caldav-server') as typeof import('../src/main/caldav-server');
    const body = `<?xml version="1.0" encoding="UTF-8"?>
<A:propfind xmlns:A="DAV:"><A:prop><B:calendar-home-set xmlns:B="urn:ietf:params:xml:ns:caldav"/><A:current-user-principal/><C:email-address-set xmlns:C="http://calendarserver.org/ns/"/><B:schedule-outbox-URL xmlns:B="urn:ietf:params:xml:ns:caldav"/><A:supported-report-set/></A:prop></A:propfind>`;
    assert.deepEqual(requestedPropertyNames(body), ['C:calendar-home-set', 'D:current-user-principal', 'CS:email-address-set', 'C:schedule-outbox-URL', 'D:supported-report-set']);
    assert.deepEqual(requestedPropertyNames('<D:propfind xmlns:D="DAV:"><D:allprop/></D:propfind>'), []);
    assert.deepEqual(requestedPropertyNames(''), []);
});

test('0.40.4: the principal is named after the account (Proton display name), not the CalDAV user name', async () => {
    const config = {
        host: '127.0.0.1',
        port: 33031,
        username: 'neutron-5092cfbe',
        password: 'bridge-pass',
        security: 'HTTP' as const,
        baseUrl: 'http://127.0.0.1:33031',
        serverPath: '/principals/neutron-5092cfbe/'
    };
    let name: string | null = 'Tobi Test';
    const fake = withLogin({
        isSignedIn: () => true,
        getCalDAVConfig: () => config,
        getCalendars: async () => [],
        getAccountAddresses: () => ['test@proton.me'],
        principalDisplayName: () => name,
        getSignedInUsername: () => 'test@proton.me'
    });
    const server = new CalDAVServer(fake as any);
    const original = console.log;
    console.log = () => undefined;
    await server.start();
    try {
        const propfind = async (path: string) => {
            const response = await globalThis.fetch(`http://127.0.0.1:33031${path}`, {
                method: 'PROPFIND',
                headers: { Authorization: basicAuth('neutron-5092cfbe', 'bridge-pass'), Depth: '0' }
            });
            assert.equal(response.status, 207);
            return response.text();
        };
        const principal = await propfind('/principals/neutron-5092cfbe/');
        assert.match(principal, /<D:displayname>Tobi Test<\/D:displayname>/, 'what Calendar.app shows for an invitee with this address');
        assert.match(principal, /mailto:test@proton\.me/);
        assert.match(await propfind('/principals/'), /<D:displayname>Principals<\/D:displayname>/);
        name = null;
        assert.match(await propfind('/principals/neutron-5092cfbe/'), /<D:displayname>neutron-5092cfbe<\/D:displayname>/, 'signed out: the user name as before');
    } finally {
        console.log = original;
        await server.stop();
    }
});

test('0.48.3: a collection without its final slash is redirected to it, one with it is not (no "//")', async () => {
    const fakeBridgeService = {
        isSignedIn: () => true,
        getCalDAVConfig: () => ({
            host: '127.0.0.1', port: 33022, username: 'bridge-user', password: 'bridge-pass', security: 'HTTP' as const,
            baseUrl: 'http://127.0.0.1:33022', serverPath: '/principals/bridge-user/'
        }),
        getCalendars: async () => [],
        recordCalDAVError: () => undefined
    };
    const server = new CalDAVServer(withLogin(fakeBridgeService) as any);
    const original = { log: console.log, warn: console.warn };
    console.log = () => undefined;
    console.warn = () => undefined;
    await server.start();
    try {
        const get = (path: string) => fetch(`http://127.0.0.1:33022${path}`, { redirect: 'manual', headers: { Authorization: basicAuth('bridge-user', 'bridge-pass') } });
        const bare = await get('/calendars/bridge-user');
        assert.equal(bare.status, 301);
        assert.equal(bare.headers.get('location'), '/calendars/bridge-user/');
        for (const path of ['/calendars/bridge-user/', '/principals/bridge-user/']) {
            const slashed = await get(path);
            assert.notEqual(slashed.status, 301, path);
            assert.ok(!String(slashed.headers.get('location') || '').endsWith('//'), path);
        }
    } finally {
        console.log = original.log;
        console.warn = original.warn;
        await server.stop();
    }
});

test('0.48.8: Thunderbird finds every calendar of an account from the calendar home (home → principal → calendars)', async () => {
    const calendar = (slug: string, displayName: string, readOnly = false) => ({
        protonCalendarId: slug, slug, displayName, color: '#6d4aff', description: '', visible: true, removed: false, ctag: '1', lastPolledAt: null, lastSyncedAt: null, readOnly
    });
    const fakeBridgeService = {
        isSignedIn: () => true,
        getCalDAVConfig: () => ({
            host: '127.0.0.1', port: 33023, username: 'bridge-user', password: 'bridge-pass', security: 'HTTP' as const,
            baseUrl: 'http://127.0.0.1:33023', serverPath: '/principals/bridge-user/'
        }),
        getCalendars: async () => [calendar('private', 'Tobi (Private)'), calendar('work', 'Tobi (Work)'), calendar('holidays', 'Holidays', true)],
        getAccountAddresses: () => ['tobi@proton.me'],
        principalDisplayName: () => 'Tobi',
        getSignedInUsername: () => 'tobi@proton.me',
        recordCalDAVError: () => undefined
    };
    const server = new CalDAVServer(withLogin(fakeBridgeService) as any);
    const original = console.log;
    console.log = () => undefined;
    await server.start();
    const tb = loginFetch('bridge-user', 'bridge-pass');
    const propfind = (path: string, depth: string) =>
        tb(`http://127.0.0.1:33023${path}`, { method: 'PROPFIND', headers: { Depth: depth, Origin: 'http://127.0.0.1:33023', 'Content-Type': 'application/xml' }, body: '<D:propfind xmlns:D="DAV:"><D:prop><D:resourcetype/><D:current-user-principal/></D:prop></D:propfind>' });
    try {
        // 1. The address entered in Thunderbird: the calendar home, a plain collection that names the principal.
        const home = await propfind('/calendars/bridge-user/', '0');
        assert.equal(home.status, 207);
        const homeXml = await home.text();
        assert.match(homeXml, /<D:current-user-principal>\s*<D:href>\/principals\/bridge-user\/<\/D:href>/);
        // 2. The principal: the calendar home, the user's address, the scheduling outbox.
        const principalXml = await (await propfind('/principals/bridge-user/', '0')).text();
        assert.match(principalXml, /<C:calendar-home-set>\s*<D:href>\/calendars\/bridge-user\/<\/D:href>/);
        assert.match(principalXml, /mailto:tobi@proton\.me/);
        assert.match(principalXml, /<C:schedule-outbox-URL>/);
        // 3. The home's children: every calendar, as a calendar for events, read-only where it is.
        const listXml = await (await propfind('/calendars/bridge-user/', '1')).text();
        for (const slug of ['private', 'work', 'holidays']) {
            assert.match(listXml, new RegExp(`<D:href>/calendars/bridge-user/${slug}/</D:href>`), slug);
        }
        assert.equal((listXml.match(/<C:calendar\/>/g) || []).length, 3);
        assert.equal((listXml.match(/<C:comp name="VEVENT"\/>/g) || []).length >= 3, true);
        const holidays = listXml.split('<D:response>').find((part) => part.trim().startsWith('<D:href>/calendars/bridge-user/holidays/</D:href>')) || '';
        assert.ok(holidays, 'the holidays calendar\'s own block');
        assert.doesNotMatch(holidays, /<D:write\/>/, 'holidays read-only');
    } finally {
        console.log = original;
        await server.stop();
    }
});
