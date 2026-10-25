import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * HTTP Digest authentication (RFC 7616, MD5 and MD5-sess, qop "auth") for Calendar.app, which does
 * not send Basic credentials over plain HTTP: it answers a Digest challenge instead. The bridge
 * knows the generated password in clear, so the client's response can be computed and compared.
 * Nonces are random, remembered for a while and checked for replays (each nonce count once; 0.48.4:
 * in any order — Thunderbird sends several requests at once, and they may arrive out of order).
 */
export const DIGEST_REALM = 'Neutron Calendar Bridge';
/** A nonce is good for this long; a response with an older one gets a fresh challenge marked stale. */
const NONCE_MS = 10 * 60 * 1000;
const MAX_NONCES = 200;
/** Requests answered with one nonce before a fresh one is asked for (bounds what is remembered). */
const MAX_COUNTS_PER_NONCE = 10_000;

export interface DigestCredentials {
    username: string;
    realm?: string;
    nonce: string;
    uri: string;
    response: string;
    qop?: string;
    nc?: string;
    cnonce?: string;
    opaque?: string;
    algorithm?: string;
}

const md5 = (text: string) => createHash('md5').update(text, 'utf8').digest('hex');

/** `Digest key="value", key=value, …` → fields (null when it is not a Digest header). */
export const parseDigestAuthorization = (headerValue: string | undefined): DigestCredentials | null => {
    if (!headerValue || !/^Digest\s/i.test(headerValue)) {
        return null;
    }
    const fields: Record<string, string> = {};
    const pattern = /(\w+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^\s,]+))/g;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(headerValue.slice(7)))) {
        fields[match[1].toLowerCase()] = (match[2] ?? match[3] ?? '').replace(/\\(.)/g, '$1');
    }
    if (!fields.username || !fields.nonce || !fields.uri || !fields.response) {
        return null;
    }
    return fields as unknown as DigestCredentials;
};

export class DigestAuthenticator {
    /** Issued nonces: when, and the nonce counts used with each (a replay must not be accepted). */
    private readonly nonces = new Map<string, { issuedAt: number; used: Set<number> }>();
    private readonly opaque = randomBytes(8).toString('hex');

    constructor(private readonly now: () => number = Date.now) {}

    /** The WWW-Authenticate value for a 401. `stale`: the credentials were right but the nonce old. */
    challenge(stale = false) {
        const nonce = randomBytes(16).toString('hex');
        this.nonces.set(nonce, { issuedAt: this.now(), used: new Set() });
        this.forgetOldNonces();
        return `Digest realm="${DIGEST_REALM}", qop="auth", algorithm=MD5, nonce="${nonce}", opaque="${this.opaque}"${stale ? ', stale=true' : ''}`;
    }

    /**
     * Checks a Digest response against the password: 'ok', 'wrong' (the password or anything else
     * does not fit), or 'stale' (right, but the nonce expired or was never issued: challenge again).
     */
    verify(credentials: DigestCredentials, method: string, requestPath: string, password: string): 'ok' | 'wrong' | 'stale' {
        const algorithm = (credentials.algorithm || 'MD5').toUpperCase();
        if (algorithm !== 'MD5' && algorithm !== 'MD5-SESS') {
            return 'wrong';
        }
        if (credentials.realm !== undefined && credentials.realm !== DIGEST_REALM) {
            return 'wrong';
        }
        // The URI the client signed must be the one requested (path, with or without the host).
        const signedPath = credentials.uri.replace(/^https?:\/\/[^/]+/i, '').split('?')[0];
        if (signedPath !== requestPath && decodeURIComponentSafe(signedPath) !== decodeURIComponentSafe(requestPath)) {
            return 'wrong';
        }
        const qop = credentials.qop?.toLowerCase();
        if (qop && qop !== 'auth') {
            return 'wrong';
        }
        if (qop && (!credentials.nc || !credentials.cnonce)) {
            return 'wrong';
        }
        let ha1 = md5(`${credentials.username}:${DIGEST_REALM}:${password}`);
        if (algorithm === 'MD5-SESS') {
            ha1 = md5(`${ha1}:${credentials.nonce}:${credentials.cnonce || ''}`);
        }
        const ha2 = md5(`${method}:${credentials.uri}`);
        const expected = qop
            ? md5(`${ha1}:${credentials.nonce}:${credentials.nc}:${credentials.cnonce}:${qop}:${ha2}`)
            : md5(`${ha1}:${credentials.nonce}:${ha2}`);
        const given = Buffer.from(credentials.response.toLowerCase(), 'utf8');
        const wanted = Buffer.from(expected, 'utf8');
        if (given.length !== wanted.length || !timingSafeEqual(given, wanted)) {
            return 'wrong';
        }
        // The password is right: now the nonce. Unknown or expired → stale (a fresh challenge, no
        // password prompt in Calendar.app); a nonce count used before (a replay) → stale too: a fresh
        // challenge, no access, and not reported as a wrong password (the password was right).
        const issued = this.nonces.get(credentials.nonce);
        if (!issued || this.now() - issued.issuedAt > NONCE_MS) {
            this.nonces.delete(credentials.nonce);
            return 'stale';
        }
        if (qop) {
            const count = parseInt(credentials.nc!, 16);
            if (!Number.isFinite(count) || count < 1) {
                return 'wrong';
            }
            if (issued.used.has(count) || issued.used.size >= MAX_COUNTS_PER_NONCE) {
                return 'stale';
            }
            issued.used.add(count);
        }
        return 'ok';
    }

    private forgetOldNonces() {
        const now = this.now();
        for (const [nonce, entry] of this.nonces) {
            if (now - entry.issuedAt > NONCE_MS) this.nonces.delete(nonce);
        }
        while (this.nonces.size > MAX_NONCES) {
            this.nonces.delete(this.nonces.keys().next().value as string);
        }
    }
}

const decodeURIComponentSafe = (value: string) => {
    try {
        return decodeURIComponent(value);
    } catch {
        return value;
    }
};
