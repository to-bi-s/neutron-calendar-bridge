/**
 * How the library talks to Proton (roadmap stage 2): one place for every request.
 *
 * - "Slow down" (429, or 503 with Retry-After): Proton's wait is honoured for all requests, not just
 *   the one that got it (a global pause). Short waits are waited out and the request is sent again
 *   (Proton did not process it); a request that would wait more than a minute in all (its own
 *   slow-down, or one another request got) ends with RateLimitedError, so the caller can pause its
 *   own work until then. Sign-in requests are never sent again after a slow-down (like Proton's apps).
 * - A request budget (a token bucket): at most `perSecond` requests per second on average, bursts
 *   up to `burst`, so a sync pass never fires a flood that earns a 429.
 * - Reads (GET) that fail without an answer (network) or with 502/503/504 are tried again twice,
 *   with exponential backoff and jitter. Writes are not: Proton may have applied them.
 * - Error 5003 (APP_VERSION_BAD): Proton no longer accepts the app version the library presents;
 *   AppVersionError says so instead of a generic failure.
 * - Statistics for the caller (requests per hour, answers by kind, retries, pauses, sign-ins,
 *   session renewals).
 *
 * Session renewal (401) is the API class's part (it owns the session); it calls `execute` too.
 */

/** Proton asked to slow down for longer than is worth waiting inline. */
export class RateLimitedError extends Error {
    readonly name = 'RateLimitedError';
    constructor(
        message: string,
        /** When requests may go out again (Unix ms). */
        readonly retryAt: number
    ) {
        super(message);
    }
}

/** Proton ended the session (its refresh token was refused): sign in again with the password. */
export class SessionExpiredError extends Error {
    readonly name = 'SessionExpiredError';
}

/** Proton no longer accepts the app version presented (error 5003): the library needs an update. */
export class AppVersionError extends Error {
    readonly name = 'AppVersionError';
}

export const APP_VERSION_BAD = 5003;

/** One HTTP attempt, normalised: status, the Retry-After header, the parsed body (or binary). */
export interface AttemptResult {
    status: number;
    retryAfter: string | null;
    data: any;
}

export interface RequestStats {
    /** Since this API object was created (Unix ms). */
    since: number;
    requests: number;
    /** Requests in the last 60 minutes. */
    lastHour: number;
    /** Answers by kind: "2xx", "401", "429", "4xx", "5xx", "network". */
    answers: Record<string, number>;
    /** Requests sent again (slow-down, network or server errors, after a session renewal). */
    retries: number;
    /** "Slow down" answers (429, or 503 with Retry-After). */
    rateLimited: number;
    lastRateLimit: { at: number; seconds: number; path: string } | null;
    /** Requests wait until this time (Unix ms), or null. */
    pausedUntil: number | null;
    /** Full sign-ins with the password (SRP). */
    signIns: number;
    /** Access tokens renewed with the refresh token. */
    sessionRenewals: number;
    /** A saved session was used at start instead of signing in with the password. */
    resumedSession: boolean;
}

export interface RequestControlOptions {
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
    random?: () => number;
    /** Average requests per second (default 10). */
    perSecond?: number;
    /** Requests that may go out at once before the average applies (default 30). */
    burst?: number;
    /** A slow-down longer than this ends the request with RateLimitedError (default 60 s). */
    maxInlineWaitMs?: number;
    /** Slow-down answers waited out per request before giving up (default 5). */
    maxRateLimitRetries?: number;
}

const RETRY_STATUSES = new Set([502, 503, 504]);
const NETWORK_RETRIES = 2;

/** No answer at all (DNS, refused, reset, timeout): node-fetch's FetchError / AbortError or undici's TypeError. */
export const isNetworkError = (error: any) =>
    error?.name === 'FetchError' ||
    error?.name === 'AbortError' ||
    error?.name === 'TimeoutError' ||
    error?.type === 'system' ||
    (error instanceof TypeError && (/^(fetch failed|terminated)$/.test(String(error.message)) || !!(error as any).cause?.code)) ||
    /ECONNRESET|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|socket hang up/i.test(String(error?.code || error?.message || ''));

/** Retry-After: seconds, or an HTTP date. */
export const retryAfterSeconds = (header: string | null, now: number): number | null => {
    if (!header) return null;
    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds;
    const date = Date.parse(header);
    return Number.isNaN(date) ? null : Math.max(0, Math.ceil((date - now) / 1000));
};

export class RequestControl {
    private readonly now: () => number;
    /** Waits (replaced in tests). */
    readonly sleep: (ms: number) => Promise<void>;
    private readonly random: () => number;
    private readonly perSecond: number;
    private readonly burst: number;
    private readonly maxInlineWaitMs: number;
    private readonly maxRateLimitRetries: number;
    private tokens: number;
    private lastRefill: number;
    private pauseUntil = 0;
    /** Requests per minute (minute number → count), the last 60 minutes. */
    private perMinute = new Map<number, number>();
    private readonly counters: Omit<RequestStats, 'lastHour' | 'pausedUntil'>;

    constructor(options: RequestControlOptions = {}) {
        this.now = options.now ?? Date.now;
        this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
        this.random = options.random ?? Math.random;
        this.perSecond = options.perSecond ?? 10;
        this.burst = options.burst ?? 30;
        this.maxInlineWaitMs = options.maxInlineWaitMs ?? 60_000;
        this.maxRateLimitRetries = options.maxRateLimitRetries ?? 5;
        this.tokens = this.burst;
        this.lastRefill = this.now();
        this.counters = {
            since: this.now(),
            requests: 0,
            answers: {},
            retries: 0,
            rateLimited: 0,
            lastRateLimit: null,
            signIns: 0,
            sessionRenewals: 0,
            resumedSession: false,
        };
    }

    stats(): RequestStats {
        const minute = Math.floor(this.now() / 60_000);
        let lastHour = 0;
        for (const [key, count] of this.perMinute) {
            if (minute - key < 60) lastHour += count;
        }
        return {
            ...this.counters,
            answers: { ...this.counters.answers },
            lastRateLimit: this.counters.lastRateLimit ? { ...this.counters.lastRateLimit } : null,
            lastHour,
            pausedUntil: this.pauseUntil > this.now() ? this.pauseUntil : null,
        };
    }

    noteSignIn() {
        this.counters.signIns += 1;
    }

    noteSessionRenewal() {
        this.counters.sessionRenewals += 1;
    }

    noteResumedSession() {
        this.counters.resumedSession = true;
    }

    noteRetry() {
        this.counters.retries += 1;
    }

    /**
     * Waits for Proton's pause and for a token of the budget. A pause longer than `allowedMs` is not
     * waited out: RateLimitedError (requests may go out again at the end of the pause).
     */
    private async waitTurn(allowedMs: number) {
        for (;;) {
            const now = this.now();
            if (now < this.pauseUntil) {
                if (this.pauseUntil - now > allowedMs) {
                    throw new RateLimitedError(`Proton asked to slow down; requests wait until ${new Date(this.pauseUntil).toISOString()}`, this.pauseUntil);
                }
                await this.sleep(this.pauseUntil - now);
                allowedMs -= this.pauseUntil - now;
                continue;
            }
            this.tokens = Math.min(this.burst, this.tokens + ((now - this.lastRefill) * this.perSecond) / 1000);
            this.lastRefill = now;
            if (this.tokens >= 1) {
                this.tokens -= 1;
                return;
            }
            await this.sleep(Math.ceil(((1 - this.tokens) * 1000) / this.perSecond));
        }
    }

    private count(kind: string) {
        this.counters.answers[kind] = (this.counters.answers[kind] ?? 0) + 1;
    }

    private noteRequest() {
        this.counters.requests += 1;
        const minute = Math.floor(this.now() / 60_000);
        this.perMinute.set(minute, (this.perMinute.get(minute) ?? 0) + 1);
        for (const key of this.perMinute.keys()) {
            if (minute - key >= 60) this.perMinute.delete(key);
        }
    }

    private backoff(attempt: number) {
        // 1 s, 3 s (± 25 %)
        const base = attempt === 1 ? 1000 : 3000;
        return Math.round(base * (0.75 + this.random() * 0.5));
    }

    /**
     * Sends one request through the pause, the budget and the retry rules. `attempt` performs a
     * single HTTP request (and throws on no answer at all).
     */
    async execute(
        attempt: () => Promise<AttemptResult>,
        { method, path, retrySlowDown = true }: { method: string; path: string; retrySlowDown?: boolean }
    ): Promise<AttemptResult> {
        const isRead = method.toUpperCase() === 'GET';
        let failures = 0;
        let slowDowns = 0;
        const startedAt = this.now();
        for (;;) {
            // At most maxInlineWaitMs of pauses in all for one request.
            await this.waitTurn(Math.max(0, this.maxInlineWaitMs - (this.now() - startedAt)));
            this.noteRequest();
            let result: AttemptResult;
            try {
                result = await attempt();
            } catch (error) {
                if (!isNetworkError(error)) throw error;
                this.count('network');
                if (isRead && failures < NETWORK_RETRIES) {
                    failures += 1;
                    this.counters.retries += 1;
                    await this.sleep(this.backoff(failures));
                    continue;
                }
                throw error;
            }

            const { status } = result;
            this.count(status === 401 || status === 429 ? String(status) : `${Math.floor(status / 100)}xx`);
            if (result.data && typeof result.data === 'object' && result.data.Code === APP_VERSION_BAD) {
                throw new AppVersionError(
                    `Proton no longer accepts the app version this library presents (${result.data.Error || 'error 5003'}). The library needs an update.`
                );
            }
            const waitSeconds = retryAfterSeconds(result.retryAfter, this.now());
            if (status === 429 || (status === 503 && waitSeconds !== null)) {
                const seconds = waitSeconds ?? 10;
                const until = this.now() + seconds * 1000;
                this.pauseUntil = Math.max(this.pauseUntil, until);
                this.counters.rateLimited += 1;
                this.counters.lastRateLimit = { at: this.now(), seconds, path };
                const waitedMs = this.now() - startedAt;
                if (!retrySlowDown || waitedMs + seconds * 1000 > this.maxInlineWaitMs || slowDowns >= this.maxRateLimitRetries) {
                    throw new RateLimitedError(
                        `Proton asked to slow down (${status}); requests wait until ${new Date(this.pauseUntil).toISOString()}`,
                        this.pauseUntil
                    );
                }
                slowDowns += 1;
                this.counters.retries += 1;
                continue; // waitTurn waits for the pause
            }
            if (isRead && RETRY_STATUSES.has(status) && failures < NETWORK_RETRIES) {
                failures += 1;
                this.counters.retries += 1;
                await this.sleep(this.backoff(failures));
                continue;
            }
            return result;
        }
    }
}
