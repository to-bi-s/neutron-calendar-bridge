/**
 * Offline test for how the library talks to Proton (roadmap stage 2): request-control.ts and the
 * session handling of ProtonCalendarAPI. A fake clock and a fake fetch; no network, no account.
 * Checks:
 * - the request budget (bursts, then an even pace);
 * - "slow down" (429, or 503 with Retry-After): a pause for every request, short ones waited out and
 *   sent again (also writes: Proton did not process them), long ones end with RateLimitedError;
 * - reads retried after no answer or 502/503/504 (backoff), writes never;
 * - error 5003: AppVersionError;
 * - statistics;
 * - 401: the access token renewed once with the refresh token (auth/v4/refresh), the request sent
 *   again with the new token, the new refresh token handed to onSession; several 401s at once, one
 *   renewal; a 401 for an already renewed token, no second renewal; a refused renewal:
 *   SessionExpiredError;
 * - starting with a saved session: no password sign-in while Proton accepts it; when it has ended,
 *   the password sign-in instead;
 * - signing out ends the session at Proton;
 * - a slow-down, an ended session or a refused app version reaches the caller of the write helpers
 *   (thrown, not { success: false }) and of invitation actions ("rate-limited" with Proton's time);
 * - a saved session is kept (not replaced by a password sign-in) when Proton has server trouble, and
 *   only resumed for the account asked for.
 */
import { ProtonCalendarAPI } from '../src/proton-calendar-api.ts';
import { AppVersionError, RateLimitedError, RequestControl, SessionExpiredError, retryAfterSeconds } from '../src/request-control.ts';
import { InvitationActionError, isSendRefused, rateLimitedAction } from '../src/invitations.ts';
import type { AttemptResult } from '../src/request-control.ts';

let failures = 0;
const check = (condition: unknown, label: string) => {
    console.log(`${condition ? 'ok  ' : 'FAIL'} ${label}`);
    if (!condition) failures += 1;
};

/** A virtual clock: sleep() moves time forward (and lets other waiting requests run in order). */
const fakeClock = () => {
    let now = 1_800_000_000_000;
    const sleepers: Array<{ until: number; resolve: () => void }> = [];
    const tick = () => {
        sleepers.sort((a, b) => a.until - b.until);
        const next = sleepers.shift();
        if (next) {
            now = Math.max(now, next.until);
            next.resolve();
        }
    };
    let ticking = false;
    const schedule = () => {
        if (ticking) return;
        ticking = true;
        setImmediate(() => {
            ticking = false;
            tick();
            if (sleepers.length) schedule();
        });
    };
    return {
        now: () => now,
        advance: (ms: number) => {
            now += ms;
        },
        sleep: (ms: number) =>
            new Promise<void>((resolve) => {
                sleepers.push({ until: now + ms, resolve });
                schedule();
            }),
        sleeps: () => sleepers.length
    };
};

const answer = (status: number, data: any = { Code: 1000 }, retryAfter: string | null = null): AttemptResult => ({ status, data, retryAfter });

const testRequestControl = async () => {
    // Budget
    {
        const clock = fakeClock();
        const control = new RequestControl({ now: clock.now, sleep: clock.sleep, random: () => 0.5, perSecond: 10, burst: 30 });
        const started = clock.now();
        const sentAt: number[] = [];
        await Promise.all(Array.from({ length: 40 }, () => control.execute(async () => (sentAt.push(clock.now() - started), answer(200)), { method: 'GET', path: 'x' })));
        check(sentAt.filter((at) => at === 0).length === 30, `a burst of 30 goes out at once (${sentAt.filter((at) => at === 0).length})`);
        check(Math.max(...sentAt) >= 900 && Math.max(...sentAt) <= 1100, `then 10 per second: the 40th after about 1 s (${Math.max(...sentAt)} ms)`);
        check(control.stats().requests === 40 && control.stats().lastHour === 40, 'counted (40 in the last hour)');
    }

    // A short slow-down: waited out, sent again; other requests wait too.
    {
        const clock = fakeClock();
        const control = new RequestControl({ now: clock.now, sleep: clock.sleep, random: () => 0.5 });
        const t0 = clock.now();
        let first = true;
        const writeTimes: number[] = [];
        const write = control.execute(async () => {
            writeTimes.push(clock.now() - t0);
            if (first) {
                first = false;
                return answer(429, { Code: 2028, Error: 'Too many recent API requests' }, '3');
            }
            return answer(200);
        }, { method: 'PUT', path: 'calendar/v1/x/events/sync' });
        const other: number[] = [];
        await new Promise((resolve) => setImmediate(resolve));
        const read = control.execute(async () => (other.push(clock.now() - t0), answer(200)), { method: 'GET', path: 'calendar/v1' });
        const [writeResult] = await Promise.all([write, read]);
        check(writeResult.status === 200 && writeTimes.length === 2 && writeTimes[1] >= 3000, `a write that got 429 (Retry-After 3) is sent again after 3 s (${writeTimes.join(', ')} ms)`);
        check(other[0] >= 3000, `another request waits for the same pause (${other[0]} ms)`);
        const stats = control.stats();
        check(stats.rateLimited === 1 && stats.retries === 1 && stats.answers['429'] === 1 && stats.lastRateLimit?.seconds === 3, 'counted: one slow-down, one retry');
    }

    // A long slow-down: RateLimitedError; the pause still holds for the next request.
    {
        const clock = fakeClock();
        const control = new RequestControl({ now: clock.now, sleep: clock.sleep, random: () => 0.5 });
        const t0 = clock.now();
        let error: any = null;
        try {
            await control.execute(async () => answer(429, { Code: 2028 }, '600'), { method: 'GET', path: 'calendar/v1' });
        } catch (caught) {
            error = caught;
        }
        check(error instanceof RateLimitedError && error.retryAt === t0 + 600_000, `Retry-After 600: RateLimitedError, requests may go out again in 10 min (${error?.message})`);
        check(control.stats().pausedUntil === t0 + 600_000, 'the statistics show the pause');
        let sent = false;
        const next = await control.execute(async () => ((sent = true), answer(200)), { method: 'PUT', path: 'calendar/v1/x' }).catch((caught) => caught);
        check(next instanceof RateLimitedError && next.retryAt === t0 + 600_000 && !sent, 'another request during that pause is not sent and does not wait 10 min: RateLimitedError at once');
        clock.advance(600_000);
        const later = await control.execute(async () => answer(200), { method: 'GET', path: 'calendar/v1' });
        check(later.status === 200, 'after the pause, requests go out again');
    }

    // At most a minute of pauses in all for one request.
    {
        const clock = fakeClock();
        const control = new RequestControl({ now: clock.now, sleep: clock.sleep, random: () => 0.5 });
        let calls = 0;
        const error = await control.execute(async () => (calls++, answer(429, { Code: 2028 }, '25')), { method: 'PUT', path: 'x' }).catch((caught) => caught);
        check(error instanceof RateLimitedError && calls === 3, `three slow-downs of 25 s: the third would pass a minute in all, RateLimitedError (${calls} tries)`);
    }

    // Sign-in requests are not sent again after a slow-down.
    {
        const clock = fakeClock();
        const control = new RequestControl({ now: clock.now, sleep: clock.sleep, random: () => 0.5 });
        let calls = 0;
        const error = await control.execute(async () => (calls++, answer(429, { Code: 2028 }, '2')), { method: 'POST', path: 'auth/v4', retrySlowDown: false }).catch((caught) => caught);
        check(error instanceof RateLimitedError && calls === 1, 'a sign-in request that got 429 is not sent again (like Proton\'s apps)');
    }

    // 503: with Retry-After like 429 (also writes); without it, reads are retried, writes not.
    {
        const clock = fakeClock();
        const control = new RequestControl({ now: clock.now, sleep: clock.sleep, random: () => 0.5 });
        let calls = 0;
        const result = await control.execute(async () => (++calls === 1 ? answer(503, { Code: 503 }, '2') : answer(200)), { method: 'POST', path: 'x' });
        check(result.status === 200 && calls === 2, '503 with Retry-After: a write is sent again');
        calls = 0;
        const write = await control.execute(async () => (calls++, answer(503, { Code: 503 })), { method: 'POST', path: 'x' });
        check(write.status === 503 && calls === 1, '503 without Retry-After: a write is not sent again (Proton may have applied it)');
        calls = 0;
        const t0 = clock.now();
        const read = await control.execute(async () => (calls++, answer(502, 'Bad gateway')), { method: 'GET', path: 'x' });
        check(read.status === 502 && calls === 3, `a read is tried three times in all (${calls})`);
        check(clock.now() - t0 >= 3000, `with backoff between them (${clock.now() - t0} ms)`);
    }

    // No answer at all.
    {
        const clock = fakeClock();
        const control = new RequestControl({ now: clock.now, sleep: clock.sleep, random: () => 0.5 });
        let calls = 0;
        const offline = async () => {
            calls += 1;
            throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } });
        };
        await control.execute(offline, { method: 'GET', path: 'x' }).catch(() => undefined);
        check(calls === 3, `a read without answer: three tries (${calls})`);
        calls = 0;
        const error = await control.execute(offline, { method: 'PUT', path: 'x' }).catch((caught) => caught);
        check(calls === 1 && error instanceof TypeError, 'a write without answer: one try, the error passed on');
        check(control.stats().answers.network === 4, 'counted as network errors');
        let tries = 0;
        let recovered = await control.execute(async () => (++tries < 2 ? offline() : answer(200)), { method: 'GET', path: 'x' });
        check(recovered.status === 200 && tries === 2, 'a read answered on the second try');
        recovered = await control.execute(async () => answer(200), { method: 'GET', path: 'x' });
        check(recovered.status === 200, 'a non-network error is never swallowed …');
        const thrown = await control.execute(async () => {
            throw new Error('a bug');
        }, { method: 'GET', path: 'x' }).catch((caught) => caught);
        check(thrown?.message === 'a bug', '… but passed on at once');
    }

    // Error 5003
    {
        const control = new RequestControl();
        const error = await control.execute(async () => answer(400, { Code: 5003, Error: 'This version of the app is no longer supported' }), { method: 'GET', path: 'x' }).catch((caught) => caught);
        check(error instanceof AppVersionError && /no longer accepts the app version/.test(error.message) && /no longer supported/.test(error.message), `5003: AppVersionError (${error?.message})`);
    }

    // Retry-After as a date
    check(retryAfterSeconds('Wed, 21 Oct 2026 07:28:00 GMT', Date.parse('Wed, 21 Oct 2026 07:27:30 GMT')) === 30, 'Retry-After as an HTTP date');
    check(retryAfterSeconds(null, 0) === null && retryAfterSeconds('5', 0) === 5, 'Retry-After in seconds, or none');
};

// ---------------------------------------------------------------------------------------------
// Emails: a slow-down means Proton did not send it

const testSendRefused = () => {
    check(isSendRefused(new RateLimitedError('slow down', Date.now() + 60_000)), 'a send that got "slow down" went nowhere (refused, not "may have been sent")');
    check(isSendRefused(new AppVersionError('5003')), 'nor one Proton refused for the app version');
    check(!isSendRefused(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } })), 'one without an answer may have gone out');
    check(!isSendRefused(Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' })), 'nor one that timed out');
};

// ---------------------------------------------------------------------------------------------
// Slow-down, ended session, app version: for the caller to handle

const testControlErrorsReachCaller = async () => {
    const retryAt = 1_900_000_000_000;
    const failingWith = (error: unknown) => {
        const api: any = new ProtonCalendarAPI({ username: 'tobi@proton.test', password: 'secret' });
        api.session = { UID: 'uid-1', AccessToken: 'a', RefreshToken: 'r' };
        api.userData = { addresses: [], userKeys: [], addressKeysByAddressID: {} };
        api.resolveCalendarData = async () => {
            throw error;
        };
        return api;
    };
    const eventData = { title: 't', description: '', location: '', startTime: 1, endTime: 2, timezone: 'UTC', isAllDay: false };
    for (const [name, call] of [
        ['createEvent', (api: any) => api.createEvent(eventData, 'cal')],
        ['updateEvent', (api: any) => api.updateEvent('ev', eventData, 'cal')],
        ['deleteEvent', (api: any) => api.deleteEvent('ev', 'cal')],
        ['syncSeries', (api: any) => api.syncSeries({ calendarId: 'cal', components: [], deleteEventIds: ['ev'] })]
    ] as const) {
        const slowed = await call(failingWith(new RateLimitedError('slow down', retryAt))).catch((caught: any) => caught);
        const ended = await call(failingWith(new SessionExpiredError('ended'))).catch((caught: any) => caught);
        const other = await call(failingWith(new Error('Event not found'))).catch((caught: any) => caught);
        check(slowed instanceof RateLimitedError && slowed.retryAt === retryAt && ended instanceof SessionExpiredError && other?.success === false,
            `${name}: a slow-down or an ended session is thrown to the caller; other problems stay { success: false }`);
    }

    const api: any = failingWith(new Error('unused'));
    api.invalidateEventCaches = () => undefined;
    const slowed = await api.runInvitationAction('cal', async () => {
        throw new RateLimitedError('slow down', retryAt);
    });
    check(!slowed.success && slowed.reason === 'rate-limited' && slowed.retryAt === retryAt, `an invitation action Proton asked to wait with: "rate-limited" with its time (${slowed.reason})`);
    const refused = await api.runInvitationAction('cal', async () => {
        throw rateLimitedAction('Proton asked to slow down.', new RateLimitedError('slow down', retryAt));
    });
    check(refused.reason === 'rate-limited' && refused.retryAt === retryAt && refused.error === 'Proton asked to slow down.', 'also when the action says so itself');
    const other = await api.runInvitationAction('cal', async () => {
        throw new InvitationActionError('not possible', 'unsupported');
    });
    check(other.reason === 'unsupported' && other.retryAt === undefined, 'other refusals unchanged');
    const ended = await api.runInvitationAction('cal', async () => {
        throw new SessionExpiredError('ended');
    }).catch((caught: any) => caught);
    check(ended instanceof SessionExpiredError, 'an ended session is thrown to the caller (sign in again), not reported as a refusal');
    const version = await api.runInvitationAction('cal', async () => {
        throw new AppVersionError('5003');
    }).catch((caught: any) => caught);
    check(version instanceof AppVersionError, 'and so is a refused app version');
};

// ---------------------------------------------------------------------------------------------
// The API: session renewal, resuming, signing out

const jsonResponse = (status: number, data: any, headers: Record<string, string> = {}) => ({
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
    text: async () => JSON.stringify(data),
    arrayBuffer: async () => new ArrayBuffer(0)
});

const makeApi = (options: { session?: any; onSession?: (s: any) => void } = {}) => {
    const api: any = new ProtonCalendarAPI({ username: 'tobi@proton.test', password: 'secret', session: options.session, onSession: options.onSession });
    api.control = new RequestControl({ random: () => 0.5, sleep: async () => undefined });
    const log: Array<{ url: string; method: string; auth?: string; body?: any }> = [];
    let valid = 'access-1';
    let refreshToken = 'refresh-1';
    let refreshes = 0;
    let refuseRefresh = false;
    let refreshDelay: Promise<void> | null = null;
    api.fetchImpl = async (url: string, init: any) => {
        const entry = { url, method: init.method, auth: init.headers?.Authorization, body: init.body ? JSON.parse(init.body) : undefined };
        log.push(entry);
        if (url.endsWith('/auth/v4/refresh')) {
            refreshes += 1;
            if (refreshDelay) await refreshDelay;
            if (refuseRefresh || entry.body.RefreshToken !== refreshToken || init.headers['x-pm-uid'] !== 'uid-1') {
                return jsonResponse(400, { Code: 10013, Error: 'Invalid refresh token' });
            }
            valid = `access-${refreshes + 1}`;
            refreshToken = `refresh-${refreshes + 1}`;
            return jsonResponse(200, { Code: 1000, AccessToken: valid, RefreshToken: refreshToken, UID: 'uid-1', ExpiresIn: 86400 });
        }
        if (init.headers?.Authorization !== `Bearer ${valid}`) {
            return jsonResponse(401, { Code: 401, Error: 'Invalid access token' });
        }
        if (url.endsWith('/core/v4/auth') && init.method === 'DELETE') {
            valid = 'revoked';
            refuseRefresh = true;
            return jsonResponse(200, { Code: 1000 });
        }
        return jsonResponse(200, { Code: 1000, User: { ID: 'user' } });
    };
    api.session = { UID: 'uid-1', AccessToken: 'access-1', RefreshToken: 'refresh-1' };
    return {
        api,
        log,
        expireAccess: () => {
            valid = 'access-new';
        },
        refuse: () => {
            refuseRefresh = true;
        },
        holdRefresh: () => {
            let release!: () => void;
            refreshDelay = new Promise((resolve) => (release = resolve));
            return () => {
                refreshDelay = null;
                release();
            };
        },
        refreshes: () => refreshes
    };
};

const testSession = async () => {
    // Renewal
    {
        const sessions: any[] = [];
        const { api, log, expireAccess, refreshes } = makeApi({ onSession: (session) => sessions.push(session) });
        const before = await api.makeApiRequest('core/v4/users');
        check(before.status === 200 && refreshes() === 0, 'a valid access token: no renewal');
        expireAccess();
        // the server only accepts the token it hands out next
        const result = await api.makeApiRequest('core/v4/users');
        check(result.status === 200 && refreshes() === 1, `401: renewed once and sent again (${result.status})`);
        const renewal = log.find((entry) => entry.url.endsWith('/auth/v4/refresh'));
        check(renewal?.body?.GrantType === 'refresh_token' && renewal.body.ResponseType === 'token' && renewal.body.RefreshToken === 'refresh-1' && renewal.body.UID === 'uid-1', "renewal as Proton's apps send it (refresh token, UID)");
        check(log.at(-1)?.auth === 'Bearer access-2', 'the request sent again with the new access token');
        check(sessions.at(-1)?.RefreshToken === 'refresh-2' && sessions.at(-1)?.AccessToken === 'access-2', 'the new (single-use) refresh token handed to onSession');
        check(api.getRequestStats().sessionRenewals === 1 && api.getRequestStats().answers['401'] === 1, 'counted: one renewal, one 401');
    }

    // Several 401s at once: one renewal.
    {
        const { api, expireAccess, refreshes, holdRefresh } = makeApi();
        expireAccess();
        const release = holdRefresh();
        const all = Promise.all([1, 2, 3].map(() => api.makeCalendarRequest('calendar/v1')));
        await new Promise((resolve) => setTimeout(resolve, 20));
        release();
        const results = await all;
        check(results.every((result: any) => result.status === 200) && refreshes() === 1, `three requests get 401 at once: one renewal (${refreshes()})`);
    }

    // A refused renewal: SessionExpiredError.
    {
        const { api, expireAccess, refuse } = makeApi();
        expireAccess();
        refuse();
        const error = await api.makeApiRequest('core/v4/users').catch((caught: any) => caught);
        check(error instanceof SessionExpiredError, `renewal refused: SessionExpiredError (${error?.message})`);
    }

    // Starting with a saved session.
    const stubStart = (api: any, calls: string[]) => {
        api.authenticate = async () => {
            calls.push('password sign-in');
            api.control.noteSignIn();
            return { UID: 'uid-1', AccessToken: 'access-1', RefreshToken: 'refresh-1' };
        };
        api.getUserData = async () => {
            const response = await api.makeApiRequest('core/v4/users');
            if (response.status !== 200) throw new Error(`users ${response.status}`);
            calls.push('keys');
            const resumedOther = api.session.AccessToken === 'other-account';
            return { user: { Name: resumedOther ? 'someone' : 'tobi', Email: resumedOther ? 'someone@proton.test' : 'tobi@proton.test' }, addresses: [], addressKeys: [], userKeys: [], addressKeysByAddressID: {} };
        };
        api.getCalendars = async () => [{ id: 'cal' }];
        api.getCalendarData = async () => ({ calendarID: 'cal' });
    };
    {
        const calls: string[] = [];
        const sessions: any[] = [];
        const { api } = makeApi({ session: { UID: 'uid-1', AccessToken: 'access-1', RefreshToken: 'refresh-1' }, onSession: (session) => sessions.push(session) });
        api.session = null;
        stubStart(api, calls);
        await api.initialize();
        check(calls.join(',') === 'keys' && api.getRequestStats().resumedSession && api.getRequestStats().signIns === 0, `a saved session Proton accepts: no password sign-in (${calls.join(', ')})`);
        check(sessions.length === 1 && sessions[0].RefreshToken === 'refresh-1', 'the session handed to onSession');
    }
    {
        const calls: string[] = [];
        const { api, expireAccess, refuse } = makeApi({ session: { UID: 'uid-1', AccessToken: 'old', RefreshToken: 'old' } });
        api.session = null;
        stubStart(api, calls);
        expireAccess();
        refuse();
        // the fake accepts only access-new after the password sign-in returns access-1: let it be valid
        const fetchImpl = api.fetchImpl;
        api.fetchImpl = async (url: string, init: any) => {
            if (init.headers?.Authorization === 'Bearer access-1') return jsonResponse(200, { Code: 1000 });
            return fetchImpl(url, init);
        };
        await api.initialize();
        check(calls.join(',') === 'password sign-in,keys' && !api.getRequestStats().resumedSession && api.getRequestStats().signIns === 1, `a saved session that has ended: the password sign-in instead (${calls.join(', ')})`);
    }

    // Proton has server trouble while resuming: the saved session is kept (no password sign-in).
    {
        const calls: string[] = [];
        const { api } = makeApi({ session: { UID: 'uid-1', AccessToken: 'access-1', RefreshToken: 'refresh-1' } });
        api.session = null;
        stubStart(api, calls);
        api.getUserData = async () => {
            calls.push('keys');
            throw new Error('Failed to get user info (502): {"Code":502}');
        };
        const error = await api.initialize().catch((caught: any) => caught);
        check(error instanceof Error && /502/.test(error.message) && calls.join(',') === 'keys' && api.getRequestStats().signIns === 0,
            `server trouble while resuming: an error, not a password sign-in that would abandon the session (${calls.join(', ')})`);
    }

    // Which account a session belongs to.
    {
        const { api } = makeApi();
        const userData = { user: { Name: 'tobi', Email: 'tobi@proton.test' }, addresses: [{ Email: 'tobi@proton.test' }, { Email: 'tobi@pm.test' }] };
        check(api.isAccountOf(userData, 'tobi') && api.isAccountOf(userData, 'TOBI@proton.test') && api.isAccountOf(userData, 'tobi@pm.test'), 'the account: by username, address or alias');
        check(!api.isAccountOf(userData, 'tobi@custom.test'), 'not an account whose username only equals the local part of the login');
    }

    // A saved session of another account: not used.
    {
        const calls: string[] = [];
        const { api } = makeApi({ session: { UID: 'uid-1', AccessToken: 'other-account', RefreshToken: 'r' } });
        api.session = null;
        stubStart(api, calls);
        api.fetchImpl = async () => jsonResponse(200, { Code: 1000 });
        await api.initialize();
        check(calls.join(',') === 'keys,password sign-in,keys' && !api.getRequestStats().resumedSession, `a saved session of another account: the password sign-in instead (${calls.join(', ')})`);
    }

    // A renewal that finishes after signing out is nobody's.
    {
        const sessions: any[] = [];
        const { api, expireAccess, holdRefresh } = makeApi({ onSession: (session) => sessions.push(session) });
        expireAccess();
        const release = holdRefresh();
        const request = api.makeApiRequest('core/v4/users').catch((caught: any) => caught);
        await new Promise((resolve) => setTimeout(resolve, 20));
        api.makeApiRequest = async () => ({ status: 200, data: { Code: 1000 } }); // the sign-out's own request is not the point
        await api.signOut();
        release();
        await request;
        check(sessions.length === 0 && api.getSession() === null, 'a renewal finishing after signing out is not handed over or kept');
    }

    // Signing out ends the session at Proton.
    {
        const { api, log } = makeApi();
        await api.signOut();
        check(log.some((entry) => entry.url.endsWith('/core/v4/auth') && entry.method === 'DELETE'), 'signing out ends the session at Proton (DELETE core/v4/auth)');
        check(api.getSession() === null, 'and forgets it');
    }
};

await testRequestControl();
testSendRefused();
await testSession();
await testControlErrorsReachCaller();
console.log(failures ? `\n${failures} session check(s) FAILED` : '\nAll session checks passed.');
process.exit(failures ? 1 : 0);
