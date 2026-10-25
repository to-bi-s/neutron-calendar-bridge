/**
 * Calendar.app's login in tests that talk to the CalDAV server: fake bridges get the bridge's login
 * check (against their getCalDAVConfig()), and requests carry the user name and password.
 */
type Login = { username: string; password: string } | { username: string; verified: boolean } | null;

export const basicAuth = (username: string, password: string) => `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;

/** Adds BridgeService.checkCalDAVLogin to a fake bridge. */
export const withLogin = <T extends { getCalDAVConfig(): { username: string; password: string } }>(fake: T) =>
    Object.assign(fake, {
        checkCalDAVLogin(login: Login) {
            if (!login) return 'missing';
            if ('verified' in login) return login.verified ? 'ok' : 'wrong'; // a Digest response the server checked
            const config = fake.getCalDAVConfig();
            return login.password === config.password ? 'ok' : 'wrong'; // like the bridge: the password only
        }
    });

/** fetch with Calendar.app's login (unless the request brings its own Authorization). */
export const loginFetch =
    (username: string, password: string): typeof fetch =>
    (input, init = {}) => {
        const headers = new Headers(init.headers);
        if (!headers.has('authorization')) headers.set('Authorization', basicAuth(username, password));
        return fetch(input, { ...init, headers });
    };
