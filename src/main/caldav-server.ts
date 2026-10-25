import type { Server } from 'node:http';
import { t } from './i18n';

import express, { NextFunction, Request, Response } from 'express';

import { BridgeService } from './bridge-service';
import { caldavClientOf, clientDisplayName, runWithClient } from './caldav-client';
import { DIGEST_REALM, DigestAuthenticator, parseDigestAuthorization } from './digest-auth';
import { accountTag, runInAccount } from './account-context';
import { emailOfCalendarAddress, freeBusyReplyIcs, parseFreeBusyRequest } from './free-busy';
import { isDetailedLogging, secret } from './private-log';
import { InvitationNotSupportedError, ReadOnlyEventError, StaleEventError } from './recurrence';
import {
    describeContactPrincipal,
    emailOfContactPrincipalToken,
    multistatusXml,
    parsePrincipalSearch,
    principalResponseXml,
    searchContacts,
    searchPropertySetXml
} from './principal-search';
import { buildCollectionPath, withoutTimeZoneOnDates } from './sync-utils';

const XML_CONTENT_TYPE = 'application/xml; charset=utf-8';

/**
 * The property names inside a PROPFIND's <prop>, each with its namespace shortened (DAV:, caldav, caldav
 * server, Apple's) — for the detailed log only. Values never appear in a PROPFIND body.
 */
export const requestedPropertyNames = (body: string): string[] => {
    const prop = body.match(/<(?:[\w.-]+:)?prop\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?prop>/i);
    if (!prop) return [];
    const prefixes = new Map<string, string>();
    for (const match of body.matchAll(/xmlns(?::([\w.-]+))?="([^"]+)"/g)) {
        prefixes.set(match[1] ?? '', match[2]);
    }
    const short = (uri: string | undefined) => {
        switch (uri) {
            case 'DAV:': return 'D';
            case 'urn:ietf:params:xml:ns:caldav': return 'C';
            case 'http://calendarserver.org/ns/': return 'CS';
            case 'http://apple.com/ns/ical/': return 'A';
            case undefined: return '?';
            default: return uri;
        }
    };
    const names: string[] = [];
    for (const match of prop[1].matchAll(/<(?:([\w.-]+):)?([\w.-]+)\b[^>]*?\/?>/g)) {
        names.push(`${short(prefixes.get(match[1] ?? ''))}:${match[2]}`);
    }
    return [...new Set(names)];
};

const decodeBasicAuth = (headerValue: string | undefined) => {
    if (!headerValue?.startsWith('Basic ')) {
        return null;
    }

    const decoded = Buffer.from(headerValue.slice(6), 'base64').toString('utf8');
    const separatorIndex = decoded.indexOf(':');
    if (separatorIndex < 0) {
        return null;
    }

    return {
        username: decoded.slice(0, separatorIndex),
        password: decoded.slice(separatorIndex + 1)
    };
};

const escapeXml = (value: string) =>
    value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');

const APPLE_CALENDAR_NS = 'http://apple.com/ns/ical/';

/** A principal search is a few hundred bytes; the parser's regexes need not face the 5 MB body limit. */
const PRINCIPAL_SEARCH_BODY_LIMIT = 256 * 1024;

/**
 * Express 4 ignores rejected promises from async handlers, so the request would just hang
 * until Calendar.app times out. Route them to the error handler (logged + 500) instead.
 */
type RouteRequest = Request<Record<string, string>>;

const guard =
    (handler: (request: RouteRequest, response: Response) => Promise<unknown>) =>
    (request: RouteRequest, response: Response, next: NextFunction) => {
        handler(request, response).catch(next);
    };

/**
 * A request path for bridge.log: the calendar (its name) and the event in it are private, shown only
 * with detailed logging (private-log.ts): /calendars/<user>/‹private›/‹private›. So is a contact's
 * principal, /principals/contacts/‹private›/ (the token is the address).
 */
const loggedPath = (path: string) =>
    path
        .replace(/^(\/calendars\/[^/]+\/)([^/]+)(\/?)(.*)$/, (_match, head: string, slug: string, slash: string, rest: string) =>
            `${head}${secret(slug)}${slash}${rest ? secret(rest) : ''}`
        )
        .replace(/^(\/principals\/contacts\/)([^/]+)(.*)$/, (_match, head: string, token: string, rest: string) => `${head}${secret(token)}${rest}`);

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Proton asked to slow down: 503 with Retry-After, so Calendar.app tries again then (nothing was changed). */
const slowDownStatus = (error: unknown, response: Response) => {
    if ((error as { name?: unknown } | null)?.name !== 'RateLimitedError') {
        return null;
    }
    const retryAt = Number((error as { retryAt?: number }).retryAt) || Date.now() + 60_000;
    response.setHeader('Retry-After', String(Math.max(1, Math.ceil((retryAt - Date.now()) / 1000))));
    return 503;
};

const parseSyncTokenVersion = (body: string) => {
    const match = body.match(/<(?:[A-Za-z0-9_]+:)?sync-token>([^<]+)<\/(?:[A-Za-z0-9_]+:)?sync-token>/i);
    if (!match) {
        return null;
    }

    const token = match[1].trim();
    const lastSegment = token.split('/').pop() || '';
    const numericValue = Number(decodeURIComponent(lastSegment));
    return Number.isFinite(numericValue) ? numericValue : null;
};

/**
 * 0.34: the calendar properties of a PROPPATCH or MKCALENDAR body (the <set><prop> part):
 * displayname, Apple's calendar-color (#RRGGBB or #RRGGBBAA), calendar-description, calendar-order,
 * and the local names of whatever else Calendar.app asked to set. Removals (<remove>) are not
 * honoured: a calendar keeps its name and colour.
 */
export const parseCalendarProperties = (body: string) => {
    const result: { displayName?: string; color?: string; description?: string; order?: string; components?: string[]; transparency?: 'opaque' | 'transparent'; others: string[]; removed: string[] } = { others: [], removed: [] };
    const codePoint = (code: number) => (Number.isInteger(code) && code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : '');
    const decode = (value: string) =>
        value
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/&quot;/g, '"')
            .replace(/&apos;/g, "'")
            .replace(/&#x([0-9a-fA-F]+);/g, (_match, code: string) => codePoint(parseInt(code, 16)))
            .replace(/&#(\d+);/g, (_match, code: string) => codePoint(Number(code)))
            .replace(/&amp;/g, '&')
            .trim();
    /** The text of an element: CDATA kept as it is, child elements dropped, entities decoded. */
    const textOf = (inner: string) => {
        const parts: string[] = [];
        const rest = inner.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (_match, data: string) => {
            parts.push(data);
            return `\u0000${parts.length - 1}\u0000`;
        });
        return decode(rest.replace(/<[^>]*>/g, '')).replace(/\u0000(\d+)\u0000/g, (_match, index: string) => parts[Number(index)]);
    };
    const elementsOf = (block: string) => {
        const propBlock = block.match(/<(?:[A-Za-z0-9_.-]+:)?prop(?:\s[^>]*)?>([\s\S]*?)<\/(?:[A-Za-z0-9_.-]+:)?prop\s*>/)?.[1] ?? '';
        return [...propBlock.matchAll(/<(?:[A-Za-z0-9_.-]+:)?([A-Za-z][A-Za-z0-9_.-]*)((?:\s(?:"[^"]*"|'[^']*'|[^>"'])*)?)(?:\/>|>([\s\S]*?)<\/(?:[A-Za-z0-9_.-]+:)?\1\s*>)/g)];
    };
    for (const removal of body.matchAll(/<(?:[A-Za-z0-9_.-]+:)?remove(?:\s[^>]*)?>([\s\S]*?)<\/(?:[A-Za-z0-9_.-]+:)?remove\s*>/g)) {
        for (const element of elementsOf(removal[1])) {
            result.removed.push(element[1]);
        }
    }
    const setBlocks = [...body.matchAll(/<(?:[A-Za-z0-9_.-]+:)?set(?:\s[^>]*)?>([\s\S]*?)<\/(?:[A-Za-z0-9_.-]+:)?set\s*>/g)].map((match) => match[1]);
    for (const block of setBlocks) {
        for (const element of elementsOf(block)) {
            const [, name, , inner = ''] = element;
            const value = textOf(inner);
            switch (name) {
                case 'displayname':
                    result.displayName = value;
                    break;
                case 'calendar-color':
                    result.color = value;
                    break;
                case 'calendar-description':
                    result.description = value;
                    break;
                case 'calendar-order':
                    result.order = value;
                    break;
                case 'schedule-calendar-transp':
                    // 0.37.7: Calendar.app's "Events affect availability" (RFC 6638 §9.1): <opaque/> or <transparent/>.
                    result.transparency = /<(?:[A-Za-z0-9_.-]+:)?transparent\s*\/?>/.test(inner) ? 'transparent' : /<(?:[A-Za-z0-9_.-]+:)?opaque\s*\/?>/.test(inner) ? 'opaque' : undefined;
                    result.others.push(name);
                    break;
                case 'supported-calendar-component-set':
                    // 0.35.1: the component names (<comp name="VEVENT"/>), to tell a task list apart from a calendar.
                    result.components = [...inner.matchAll(/<(?:[A-Za-z0-9_.-]+:)?comp(?=[\s/>])[^>]{0,512}?\bname\s*=\s*(?:"([^"]*)"|'([^']*)')/g)].map((match) => (match[1] ?? match[2] ?? '').trim().toUpperCase());
                    result.others.push(name);
                    break;
                default:
                    result.others.push(name);
            }
        }
    }
    return result;
};

/**
 * 0.37.7: RFC 6638 §9.1 — whether a calendar's events count towards availability. Calendar.app's
 * Availability panel considers a calendar only when the property is there ("This calendar does not
 * support availability" otherwise) and shows it as "Events affect availability" in the calendar's info.
 */
const buildTransparencyXml = (opaque: boolean) => `        <C:schedule-calendar-transp>${opaque ? '<C:opaque/>' : '<C:transparent/>'}</C:schedule-calendar-transp>`;

/** The old (pre-RFC) form of the same thing, which Calendar.app still asks for: the calendars that count. */
const buildFreeBusySetXml = (hrefs: string[]) => `        <C:calendar-free-busy-set>${hrefs.map((href) => `<D:href>${escapeXml(href)}</D:href>`).join('')}</C:calendar-free-busy-set>`;

/** Apple's raw name for the task list Reminders creates in every CalDAV account (shown as "Reminders"). */
const APPLE_DEFAULT_TASK_LIST = 'DEFAULT_TASK_CALENDAR_NAME';

/**
 * 0.35.1: whether a MKCALENDAR asks for a task list rather than a calendar. Reminders (CalendarAgent)
 * asks every CalDAV account for its default task list on each refresh — a collection for VTODO only,
 * named with Apple's untranslated key — and asks again whenever the account has none. The bridge
 * serves events only, so such a request must not become a Proton calendar (before 0.35.1 it did,
 * once per refresh).
 */
export const isTaskListRequest = (wanted: ReturnType<typeof parseCalendarProperties>) =>
    (wanted.components !== undefined && wanted.components.length > 0 && !wanted.components.includes('VEVENT')) || wanted.displayName === APPLE_DEFAULT_TASK_LIST;

export const TASK_LIST_REFUSAL =
    'Task lists (Reminders) are not created in Proton: the bridge serves events only. Turn off Reminders for this account in System Settings → Internet Accounts to stop this request.';

/**
 * 0.48: the calendar home's answer to Calendar.app's `supported-calendar-component-sets` (Apple's CalDAV
 * extension: which kinds of collection can be created here): events only, no task lists (VTODO). Before,
 * the property was missing, so macOS assumed Reminders could keep its lists here, turned Reminders on for
 * every new account and asked for its task list on every refresh (refused, 0.35.1).
 */
const HOME_COMPONENT_SETS_XML = `        <C:supported-calendar-component-sets>
          <C:supported-calendar-component-set><C:comp name="VEVENT"/></C:supported-calendar-component-set>
        </C:supported-calendar-component-sets>`;

/** Properties Calendar.app sets on its own that the bridge accepts without storing them (CalDAV namespace). */
const ACCEPTED_CALENDAR_PROPERTIES = new Set(['calendar-timezone', 'schedule-calendar-transp', 'calendar-free-busy-set', 'supported-calendar-component-set']);

const normalizeRequestedHref = (value: string) => {
    const trimmed = value.trim().replace(/&amp;/g, '&');

    if (!trimmed) {
        return '';
    }

    try {
        if (/^https?:\/\//i.test(trimmed)) {
            return new URL(trimmed).pathname;
        }
    } catch {
        // Ignore malformed absolute hrefs and fall back to the raw value.
    }

    return trimmed;
};

/**
 * Read-only calendars (subscribed, holidays, view-only shared, disabled) only grant read:
 * Calendar.app then shows them locked and does not offer to edit their events.
 */
/**
 * 0.45.5: NEUTRON_READ_ONLY_PRIVILEGES="unbind,write-properties" replaces the extra privileges of
 * read-only calendars (for trying out what Calendar.app does with them). read is always granted; unknown
 * names are ignored.
 */
// 0.45.6: Calendar.app only sends the DELETE of a calendar it may change the properties of (found with the
// 0.45.5 switch, tested on the Mac); unbind alone was not enough. write-properties also lets Calendar.app
// rename and recolour such a calendar, which Proton keeps per member (allowed for subscribed, holiday and
// shared calendars too). Their events stay read-only: no write, write-content or bind.
const READ_ONLY_EXTRA_DEFAULT = ['unbind', 'write-properties'];
const KNOWN_PRIVILEGES = new Set(['write', 'write-properties', 'write-content', 'bind', 'unbind', 'all']);
let loggedReadOnlyPrivileges = false;
const readOnlyExtraPrivileges = () => {
    const wanted = process.env.NEUTRON_READ_ONLY_PRIVILEGES;
    if (wanted === undefined) {
        return READ_ONLY_EXTRA_DEFAULT;
    }
    const names = wanted
        .split(',')
        .map((name) => name.trim())
        .filter((name) => KNOWN_PRIVILEGES.has(name));
    if (!loggedReadOnlyPrivileges) {
        loggedReadOnlyPrivileges = true;
        console.log(`[caldav] read-only calendars grant read${names.map((name) => `, ${name}`).join('')} (NEUTRON_READ_ONLY_PRIVILEGES)`);
    }
    return names;
};

const buildPrivilegeSetXml = (readOnly: boolean = false) =>
    readOnly
        ? // 0.45.4: unbind too — deleting a calendar in Calendar.app unticks it here (nothing is removed in
          // Proton, 0.37). Their events stay read-only (no write).
          `
        <D:current-user-privilege-set>
          <D:privilege><D:read/></D:privilege>
          <D:privilege><D:read-current-user-privilege-set/></D:privilege>${readOnlyExtraPrivileges()
              .map((name) => `
          <D:privilege><D:${name}/></D:privilege>`)
              .join('')}
        </D:current-user-privilege-set>`
        : `
        <D:current-user-privilege-set>
          <D:privilege><D:read/></D:privilege>
          <D:privilege><D:write/></D:privilege>
          <D:privilege><D:write-properties/></D:privilege>
          <D:privilege><D:bind/></D:privilege>
          <D:privilege><D:unbind/></D:privilege>
        </D:current-user-privilege-set>`;

/**
 * 0.48.7: who the calendars belong to, on the calendar home and on every calendar. Thunderbird finds the
 * user's principal (addresses, scheduling inbox and outbox) this way — first current-user-principal on
 * the calendar, then principal-collection-set on the home — and without it never learns which guest is
 * you: it showed answer buttons but saved no answer, so no reply went out.
 */
const buildPrincipalLinksXml = (username: string, owner = false) => `${
    owner
        ? `
        <D:owner>
          <D:href>/principals/${escapeXml(username)}/</D:href>
        </D:owner>`
        : ''
}
        <D:current-user-principal>
          <D:href>/principals/${escapeXml(username)}/</D:href>
        </D:current-user-principal>
        <D:principal-collection-set>
          <D:href>/principals/</D:href>
        </D:principal-collection-set>`;

const buildSupportedReportSetXml = () => `
        <D:supported-report-set>
          <D:supported-report><D:report><C:calendar-query/></D:report></D:supported-report>
          <D:supported-report><D:report><C:calendar-multiget/></D:report></D:supported-report>
          <D:supported-report><D:report><D:sync-collection/></D:report></D:supported-report>
        </D:supported-report-set>`;

/** Host names that reach the bridge on this Mac (it listens on 127.0.0.1 only). */
const LOOPBACK_HOST_NAMES = new Set(['127.0.0.1', 'localhost', '[::1]']);

/**
 * 0.36: the accounts the server serves, each under its own principal (/principals/<user name>/).
 * A single BridgeService (the tests) is wrapped as one account.
 */
export interface CalDAVAccounts {
    list(): BridgeService[];
    byUsername(username: string): BridgeService | null;
    /** Any service: an account, or the one being signed in. */
    any(): BridgeService;
    /** Where to listen (the app's port); without it, any()'s config says. */
    listenOn?(): { host: string; port: number };
}

const accountsOf = (source: BridgeService | CalDAVAccounts): CalDAVAccounts => {
    if (typeof (source as CalDAVAccounts).byUsername === 'function' && typeof (source as CalDAVAccounts).list === 'function') {
        return source as CalDAVAccounts;
    }
    const service = source as BridgeService;
    return {
        list: () => [service],
        byUsername: (username) => (service.getCalDAVConfig().username === username ? service : null),
        any: () => service
    };
};

const safeDecode = (value: string) => {
    try {
        return decodeURIComponent(value);
    } catch {
        return value;
    }
};

export class CalDAVServer {
    private readonly app = express();
    private server: Server | null = null;
    /** 0.35.1: Reminders' task-list request is logged once per run (it repeats on every refresh). */
    private taskListRefusalLogged = false;
    private readonly digest = new DigestAuthenticator();
    private readonly accounts: CalDAVAccounts;

    constructor(source: BridgeService | CalDAVAccounts) {
        this.accounts = accountsOf(source);
        this.app.use(express.text({ type: () => true, limit: '5mb' }));
        this.app.use((request, response, next) => {
            // calendar-auto-schedule (RFC 6638): Calendar.app leaves invitations to the server instead of
            // trying to deliver them itself. The bridge refuses guest changes until it can send them.
            // calendar-schedule (Apple's earlier draft, which defined the free/busy POST to the outbox) is
            // what Calendar.app's Availability panel looks for (0.37.5: without it the panel says "This
            // calendar does not support availability" and never asks); iCloud and Google advertise both.
            response.setHeader('DAV', '1, 2, calendar-access, calendar-schedule, calendar-auto-schedule');
            response.setHeader('MS-Author-Via', 'DAV');
            // The request line names the scheme, not the user name (an older Calendar.app account may sign
            // in with an address, which does not belong in the quiet log; the account is in acct= anyway).
            const authHeader = request.header('authorization') ?? '';
            const auth = /^Digest /i.test(authHeader) ? 'digest' : /^Basic /i.test(authHeader) ? 'basic' : 'none';
            const depth = request.header('depth') || '-';
            const reportType =
                request.method === 'REPORT' && typeof request.body === 'string'
                    ? request.body.includes('calendar-multiget')
                        ? 'calendar-multiget'
                        : request.body.includes('calendar-query')
                          ? 'calendar-query'
                          : request.body.includes('sync-collection')
                            ? 'sync-collection'
                            : request.body.includes('principal-property-search')
                              ? 'principal-property-search'
                              : request.body.includes('calendarserver-principal-search')
                                ? 'calendarserver-principal-search'
                                : request.body.includes('principal-search-property-set')
                                  ? 'principal-search-property-set'
                                  : 'unknown-report'
                    : '-';
            response.on('finish', () => {
                const accountId = (response.locals.bridge as BridgeService | undefined)?.accountId;
                console.log(
                    `[caldav] ${request.method} ${loggedPath(request.path)} -> ${response.statusCode} auth=${auth} depth=${depth} report=${reportType}${accountId ? ` acct=${accountTag(accountId)}` : ''}`
                );
                // Detailed logging (0.37.6): which properties a PROPFIND asked for — names only, no values —
                // so a client's feature detection can be read from the log (Calendar.app's Availability panel).
                if (request.method === 'PROPFIND' && isDetailedLogging()) {
                    const names = requestedPropertyNames(typeof request.body === 'string' ? request.body : '');
                    console.log(`[caldav]   props: ${names.length ? names.join(' ') : '(allprop or none)'}`);
                }
            });
            next();
        });
        this.app.use((request, response, next) => this.refuseWebPages(request, response, next));
        this.app.use((request, response, next) => this.resolveAccount(request, response, next));
        this.app.use((request, response, next) => this.authenticate(request, response, next));
        this.app.use((request, response, next) => this.ensureBridgeAvailability(request, response, next));
        this.registerRoutes();
        // Must be registered last and keep four parameters: that is how Express recognises it.
        this.app.use((error: unknown, request: Request, response: Response, _next: NextFunction) => {
            const message = errorMessage(error);
            this.reportFailure(request, 500, message);
            if (!response.headersSent) {
                response.status(500).type('text/plain').send(message);
            }
        });
    }

    /**
     * 0.36: which account a request is for — the user name in its path (/principals/<name>/,
     * /calendars/<name>/…), else the one it signs in as, else the only account there is (an older
     * Calendar.app account may sign in with any user name). None: 401, so the client signs in and
     * says. OPTIONS needs no account.
     */
    private resolveAccount(request: Request, response: Response, next: () => void) {
        const accounts = this.accounts.list();
        const pathUser = request.path.match(/^\/(?:principals|calendars|inbox|outbox|dropbox)\/([^/]+)/)?.[1];
        const header = request.header('authorization');
        const authUser = parseDigestAuthorization(header)?.username ?? decodeBasicAuth(header)?.username;
        const account =
            (pathUser && pathUser !== 'contacts' ? this.accounts.byUsername(safeDecode(pathUser)) : null) ??
            (authUser ? this.accounts.byUsername(authUser) : null) ??
            (accounts.length === 1 ? accounts[0] : null) ??
            (accounts.length === 0 ? this.accounts.any() : null);
        if (request.method === 'OPTIONS') {
            response.locals.bridge = account;
            next();
            return;
        }
        if (account) {
            try {
                account.getCalDAVConfig();
            } catch {
                // 0.36: an account still starting (its CalDAV password is read in initialize()).
                response.status(503).type('text/plain').send(t('Bridge disconnected. Sign in to Proton to serve CalDAV.'));
                return;
            }
            response.locals.bridge = account;
            // 0.36.4: the handlers' log lines carry the account's tag.
            if (account.accountId) {
                runInAccount({ id: account.accountId, tag: accountTag(account.accountId), label: () => account.accountLabel() }, () =>
                    // 0.49.6: the app behind the request, for the texts of refusals (see caldav-client.ts).
                    runWithClient(caldavClientOf(request.header('user-agent')), () => next())
                );
            } else {
                next();
            }
            return;
        }
        response.setHeader('WWW-Authenticate', [this.digest.challenge(false), `Basic realm="${DIGEST_REALM}", charset="UTF-8"`]);
        response.status(401).type('text/plain').send(t('Sign in with the user name and password shown on the Setup page of Neutron Calendar Bridge.'));
    }

    /** The account a request was resolved to (resolveAccount). */
    private bridgeOf(request: Request): BridgeService {
        const bridge = request.res?.locals.bridge as BridgeService | undefined;
        if (!bridge) {
            throw new Error('No account for this request');
        }
        return bridge;
    }

    /** Logs a failed Calendar.app request and keeps it for the app's Overview page. */
    private reportFailure(request: Request, status: number, message: string, error?: unknown) {
        console.error(`[caldav] ${request.method} ${loggedPath(request.path)} failed with ${status}: ${message}`);
        const app = clientDisplayName(caldavClientOf(request.header('user-agent')));
        this.bridgeOf(request).recordCalDAVError?.({
            at: Date.now(),
            method: request.method,
            path: request.path,
            status,
            message,
            ...(error instanceof InvitationNotSupportedError && error.partial ? { partial: true } : {}),
            ...(app ? { app } : {})
        });
    }

    async start() {
        if (this.server) {
            return;
        }

        const config = this.accounts.listenOn?.() ?? this.accounts.any().getCalDAVConfig();
        await new Promise<void>((resolve, reject) => {
            this.server = this.app.listen(config.port, config.host, () => resolve());
            this.server.on('error', reject);
        });
    }

    async stop() {
        if (!this.server) {
            return;
        }

        await new Promise<void>((resolve, reject) => {
            this.server?.close((error) => {
                if (error) {
                    reject(error);
                    return;
                }
                resolve();
            });
        });
        this.server = null;
    }

    /**
     * Only programs on this Mac (Calendar.app) may use the bridge, never a web page: no CORS headers,
     * requests a browser marks with Origin are refused, and so is any Host but this Mac's own address
     * (a web page reaching 127.0.0.1 through a domain name of its own, "DNS rebinding").
     */
    private refuseWebPages(request: Request, response: Response, next: () => void) {
        const origin = request.header('origin');
        const host = (request.header('host') || '').toLowerCase();
        const hostname = host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.split(':')[0];
        // 0.48.3: Thunderbird marks its requests with Origin too — the bridge's own address (same origin).
        // A web page never has that origin: the bridge serves no pages, and a page reaching 127.0.0.1
        // through a domain name of its own carries that name (and its Host is refused anyway).
        const sameOrigin = origin !== undefined && LOOPBACK_HOST_NAMES.has(hostname) && origin.toLowerCase() === `http://${host}`;
        if ((origin === undefined || sameOrigin) && LOOPBACK_HOST_NAMES.has(hostname)) {
            next();
            return;
        }
        console.warn(
            `[caldav] refused: ${origin !== undefined ? `a web page (Origin: ${origin.slice(0, 100)})` : `unexpected host name "${host.slice(0, 100)}"`}`
        );
        response.status(403).type('text/plain').send('The bridge only answers programs on this Mac, not web pages.');
    }

    /**
     * Calendar.app signs in with the password shown on the Setup page: Digest over plain HTTP (macOS
     * never sends Basic credentials without TLS; it answers a Digest challenge), Basic for other
     * programs. The bridge only listens on 127.0.0.1, so other programs on this Mac are what the
     * password keeps out. Open without: OPTIONS, and finding the account (the /.well-known/caldav
     * redirect, PROPFIND on / and on /.well-known/caldav), which only names the principal's address;
     * the account itself (principal, calendars, events) asks for the password.
     */
    private authenticate(request: Request, response: Response, next: () => void) {
        if (
            request.method === 'OPTIONS' ||
            ((request.method === 'GET' || request.method === 'HEAD') && request.path === '/.well-known/caldav') ||
            (request.method === 'PROPFIND' && (request.path === '/' || request.path === '/.well-known/caldav'))
        ) {
            next();
            return;
        }
        const header = request.header('authorization');
        const digest = parseDigestAuthorization(header);
        let stale = false;
        let password: string;
        try {
            password = this.bridgeOf(request).getCalDAVConfig().password;
        } catch {
            // 0.36: an account still starting (its CalDAV password is read in initialize()).
            response.status(503).type('text/plain').send(t('Bridge disconnected. Sign in to Proton to serve CalDAV.'));
            return;
        }
        if (digest) {
            const verdict = this.digest.verify(digest, request.method, request.path, password);
            stale = verdict === 'stale';
            // Stale: the password was right (not counted as wrong); Calendar.app answers the new challenge by itself.
            if (this.bridgeOf(request).checkCalDAVLogin(stale ? null : { username: digest.username, verified: verdict === 'ok' }, caldavClientOf(request.header('user-agent'))) === 'ok') {
                next();
                return;
            }
        } else if (this.bridgeOf(request).checkCalDAVLogin(decodeBasicAuth(header), caldavClientOf(request.header('user-agent'))) === 'ok') {
            next();
            return;
        }
        response.setHeader('WWW-Authenticate', [this.digest.challenge(stale), `Basic realm="${DIGEST_REALM}", charset="UTF-8"`]);
        response.status(401).type('text/plain').send(t('Sign in with the user name and password shown on the Setup page of Neutron Calendar Bridge.'));
    }

    private ensureBridgeAvailability(request: Request, response: Response, next: () => void) {
        if (request.path === '/bridge/status' || request.method === 'OPTIONS') {
            next();
            return;
        }

        if (this.bridgeOf(request).isSignedIn()) {
            next();
            return;
        }

        response.status(503).send(t('Bridge disconnected. Sign in to Proton to serve CalDAV.'));
    }

    private buildRootDiscoveryXml(request: Request) {
        const config = this.bridgeOf(request).getCalDAVConfig();
        return `<?xml version="1.0" encoding="utf-8"?>
<D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav" xmlns:CS="http://calendarserver.org/ns/" xmlns:A="${APPLE_CALENDAR_NS}">
  <D:response>
    <D:href>/</D:href>
    <D:propstat>
      <D:prop>
        <D:resourcetype>
          <D:collection/>
        </D:resourcetype>
        <D:displayname>Neutron Calendar Bridge</D:displayname>
        <D:current-user-principal>
          <D:href>/principals/${escapeXml(config.username)}/</D:href>
        </D:current-user-principal>
        <D:principal-collection-set>
          <D:href>/principals/</D:href>
        </D:principal-collection-set>
      </D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>
</D:multistatus>`;
    }

    private registerRoutes() {
        this.app.get('/bridge/status', guard(async (request, response) => {
            response.json(await this.bridgeOf(request).getBridgeState());
        }));

        this.app.get('/.well-known/caldav', (request, response) => {
            const config = this.bridgeOf(request).getCalDAVConfig();
            response.redirect(302, `/principals/${config.username}/`);
        });

        this.app.head('/.well-known/caldav', (request, response) => {
            const config = this.bridgeOf(request).getCalDAVConfig();
            response.redirect(302, `/principals/${config.username}/`);
        });

        this.app.all('/.well-known/caldav', (request, response, next) => {
            if (request.method !== 'PROPFIND') {
                next();
                return;
            }

            this.sendXml(response, 207, this.buildRootDiscoveryXml(request));
        });

        this.app.options('*', (_request, response) => {
            response.setHeader('Allow', 'OPTIONS, PROPFIND, PROPPATCH, REPORT, GET, HEAD, PUT, DELETE, MKCALENDAR');
            response.status(204).send();
        });

        // The collections without their final slash are sent to it. 0.48.3: only then — Express matches
        // these routes with the slash too, and the redirect to "…//" made Thunderbird's sign-in fail.
        const addSlash = (request: Request, response: Response, next: () => void) => {
            if (request.path.endsWith('/')) {
                next();
                return;
            }
            response.redirect(301, `${request.path}/`);
        };

        this.app.all('/', guard(async (request, response) => {
            if (request.method !== 'PROPFIND') {
                response.status(405).send('Method not allowed');
                return;
            }

            this.sendXml(response, 207, this.buildRootDiscoveryXml(request));
        }));

        this.app.get('/principals/:username', (request, response, next) => {
            addSlash(request, response, next);
        });

        this.app.get('/calendars/:username', (request, response, next) => {
            addSlash(request, response, next);
        });

        this.app.get('/inbox/:username', (request, response, next) => {
            addSlash(request, response, next);
        });

        this.app.get('/outbox/:username', (request, response, next) => {
            addSlash(request, response, next);
        });

        this.app.get('/dropbox/:username', (request, response, next) => {
            addSlash(request, response, next);
        });

        // The principal collection (0.33.1): Calendar.app searches it for guests (REPORT) while a guest is
        // being typed, after reading what it can search (PROPFIND, principal-search-property-set).
        this.app.all('/principals/', guard(async (request, response) => {
            if (request.method === 'GET' || request.method === 'HEAD') {
                response.status(200).type('text/plain').send(request.method === 'HEAD' ? '' : 'Neutron Calendar Bridge principals');
                return;
            }
            if (request.method === 'REPORT') {
                await this.answerPrincipalSearch(request, response);
                return;
            }
            if (request.method !== 'PROPFIND') {
                response.status(405).send('Method not allowed');
                return;
            }
            const config = this.bridgeOf(request).getCalDAVConfig();
            const principalHref = `/principals/${escapeXml(config.username)}/`;
            const principalName = this.bridgeOf(request).principalDisplayName?.() || config.username;
            const depth = request.header('depth');
            this.sendXml(
                response,
                207,
                `<?xml version="1.0" encoding="utf-8"?>
<D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav" xmlns:CS="http://calendarserver.org/ns/">
  <D:response>
    <D:href>/principals/</D:href>
    <D:propstat>
      <D:prop>
        <D:displayname>Principals</D:displayname>
        <D:resourcetype>
          <D:collection/>
        </D:resourcetype>
        <D:current-user-principal>
          <D:href>${principalHref}</D:href>
        </D:current-user-principal>
        <D:principal-collection-set>
          <D:href>/principals/</D:href>
        </D:principal-collection-set>
        <D:supported-report-set>
          <D:supported-report><D:report><D:principal-property-search/></D:report></D:supported-report>
          <D:supported-report><D:report><D:principal-search-property-set/></D:report></D:supported-report>
          <D:supported-report><D:report><CS:calendarserver-principal-search/></D:report></D:supported-report>
        </D:supported-report-set>
      </D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>${
      depth && depth !== '0'
          ? `
  <D:response>
    <D:href>${principalHref}</D:href>
    <D:propstat>
      <D:prop>
        <D:displayname>${escapeXml(principalName)}</D:displayname>
        <D:resourcetype>
          <D:collection/>
          <D:principal/>
        </D:resourcetype>
        <D:principal-URL>
          <D:href>${principalHref}</D:href>
        </D:principal-URL>
      </D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>`
          : ''
  }
</D:multistatus>`
            );
        }));

        // A contact's principal (0.33.1): what Calendar.app found in the guest search; it may read it again.
        this.app.all('/principals/contacts/:token/', guard(async (request, response) => {
            const email = emailOfContactPrincipalToken(request.params.token);
            if (!email) {
                response.status(404).type('text/plain').send('No such principal');
                return;
            }
            if (request.method === 'GET' || request.method === 'HEAD') {
                response.status(200).type('text/plain').send(request.method === 'HEAD' ? '' : 'Neutron Calendar Bridge contact principal');
                return;
            }
            if (request.method === 'REPORT') {
                await this.answerPrincipalSearch(request, response);
                return;
            }
            if (request.method !== 'PROPFIND') {
                response.status(405).send('Method not allowed');
                return;
            }
            const contacts = await this.bridgeOf(request).listContactsForSearch();
            const contact = contacts.find((entry) => entry.email.toLowerCase() === email.toLowerCase()) || { email, name: '', self: false };
            const config = this.bridgeOf(request).getCalDAVConfig();
            const principal = describeContactPrincipal(
                { ...contact, self: false },
                `/principals/${config.username}/`,
                `/calendars/${config.username}/`,
                []
            );
            this.sendXml(response, 207, multistatusXml([principalResponseXml(principal, this.requestedPropertyNames(request))]));
        }));

        this.app.all('/principals/:username/', guard(async (request, response) => {
            if (request.params.username === 'contacts') {
                response.status(404).type('text/plain').send('No such principal'); // the contacts are searched, not listed
                return;
            }

            if (request.method === 'GET' || request.method === 'HEAD') {
                response.status(200).type('text/plain').send(request.method === 'HEAD' ? '' : 'Neutron Calendar Bridge principal');
                return;
            }

            if (request.method === 'REPORT') {
                await this.answerPrincipalSearch(request, response);
                return;
            }

            if (request.method !== 'PROPFIND') {
                response.status(405).send('Method not allowed');
                return;
            }

            const config = this.bridgeOf(request).getCalDAVConfig();
            const principalHref = `/principals/${escapeXml(config.username)}/`;
            const principalName = this.bridgeOf(request).principalDisplayName?.() || config.username;
            const calendarHomeHref = `/calendars/${escapeXml(config.username)}/`;
            const ownAddresses = this.bridgeOf(request).getAccountAddresses?.() ?? [];
            const signedIn = this.bridgeOf(request).getSignedInUsername();
            const userAddressHrefs = ownAddresses.length
                ? ownAddresses.map((email) => `mailto:${escapeXml(email)}`)
                : [signedIn?.includes('@') ? `mailto:${escapeXml(signedIn)}` : `mailto:${escapeXml(config.username)}@localhost`];
            this.sendXml(
                response,
                207,
                `<?xml version="1.0" encoding="utf-8"?>
<D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav" xmlns:CS="http://calendarserver.org/ns/" xmlns:A="${APPLE_CALENDAR_NS}">
  <D:response>
    <D:href>${principalHref}</D:href>
    <D:propstat>
      <D:prop>
        <D:displayname>${escapeXml(principalName)}</D:displayname>
        <D:resourcetype>
          <D:collection/>
          <D:principal/>
        </D:resourcetype>
        <D:current-user-principal>
          <D:href>${principalHref}</D:href>
        </D:current-user-principal>
        <D:principal-URL>
          <D:href>${principalHref}</D:href>
        </D:principal-URL>
        <D:principal-collection-set>
          <D:href>/principals/</D:href>
        </D:principal-collection-set>
        <C:calendar-home-set>
          <D:href>${calendarHomeHref}</D:href>
        </C:calendar-home-set>
        <C:calendar-user-type>INDIVIDUAL</C:calendar-user-type>
        <C:calendar-user-address-set>
${userAddressHrefs.map((href) => `          <D:href>${href}</D:href>`).join('\n')}
        </C:calendar-user-address-set>
        <CS:email-address-set>
${userAddressHrefs.map((href) => `          <CS:email-address>${href.replace(/^mailto:/, '')}</CS:email-address>`).join('\n')}
        </CS:email-address-set>
        <C:schedule-inbox-URL>
          <D:href>/inbox/${escapeXml(config.username)}/</D:href>
        </C:schedule-inbox-URL>
        <C:schedule-outbox-URL>
          <D:href>/outbox/${escapeXml(config.username)}/</D:href>
        </C:schedule-outbox-URL>
        <CS:dropbox-home-URL>
          <D:href>/dropbox/${escapeXml(config.username)}/</D:href>
        </CS:dropbox-home-URL>
${buildPrivilegeSetXml()}
      </D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>
</D:multistatus>`
            );
        }));

        this.app.all('/calendars/:username/', guard(async (request, response) => {
            if (request.method === 'GET' || request.method === 'HEAD') {
                response.status(200).type('text/plain').send(request.method === 'HEAD' ? '' : 'Neutron Calendar Bridge calendars');
                return;
            }

            if (request.method !== 'PROPFIND') {
                response.status(405).send('Method not allowed');
                return;
            }

            const config = this.bridgeOf(request).getCalDAVConfig();
            const calendars = await this.bridgeOf(request).getCalendars();
            const defaultCalendar = calendars.find((calendar) => !calendar.removed) || null;
            const opaque = (calendar: (typeof calendars)[number]) => this.bridgeOf(request).isCalendarOpaque?.(calendar) ?? true;
            const freeBusyHrefs = calendars.filter((calendar) => !calendar.removed && opaque(calendar)).map((calendar) => buildCollectionPath(config.username, calendar.slug));
            const homeResponse = `
  <D:response>
    <D:href>/calendars/${escapeXml(config.username)}/</D:href>
    <D:propstat>
      <D:prop>
        <D:displayname>${escapeXml(config.username)} Calendars</D:displayname>
        <D:resourcetype>
          <D:collection/>
        </D:resourcetype>
        <D:owner>
          <D:href>/principals/${escapeXml(config.username)}/</D:href>
        </D:owner>${buildPrincipalLinksXml(config.username)}
${buildPrivilegeSetXml()}
${buildSupportedReportSetXml()}
${buildFreeBusySetXml(freeBusyHrefs)}
${HOME_COMPONENT_SETS_XML}
        ${
            defaultCalendar
                ? `<C:schedule-default-calendar-URL><D:href>${escapeXml(
                      buildCollectionPath(config.username, defaultCalendar.slug)
                  )}</D:href></C:schedule-default-calendar-URL>`
                : ''
        }
      </D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>`;
            const responses = calendars
                .filter((calendar) => !calendar.removed)
                .map(
                    (calendar) => `
  <D:response>
    <D:href>${escapeXml(buildCollectionPath(config.username, calendar.slug))}</D:href>
    <D:propstat>
      <D:prop>
        <D:displayname>${escapeXml(calendar.displayName)}</D:displayname>
        <D:resourcetype>
          <D:collection/>
          <C:calendar/>
        </D:resourcetype>
        <D:owner>
          <D:href>/principals/${escapeXml(config.username)}/</D:href>
        </D:owner>${buildPrincipalLinksXml(config.username)}
        <C:calendar-description>${escapeXml(calendar.description || '')}</C:calendar-description>
        <C:supported-calendar-component-set>
          <C:comp name="VEVENT"/>
        </C:supported-calendar-component-set>
        <CS:getctag>${escapeXml(calendar.ctag)}</CS:getctag>
        <A:calendar-color>${escapeXml(calendar.color)}</A:calendar-color>
        <A:calendar-order>${escapeXml(String(calendar.lastSyncedAt || 0))}</A:calendar-order>
${buildTransparencyXml(opaque(calendar))}
${buildPrivilegeSetXml(calendar.readOnly)}
${buildSupportedReportSetXml()}
      </D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>`
                )
                .join('\n');

            this.sendXml(
                response,
                207,
                `<?xml version="1.0" encoding="utf-8"?>
<D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav" xmlns:CS="http://calendarserver.org/ns/" xmlns:A="${APPLE_CALENDAR_NS}">
${homeResponse}
${responses}
</D:multistatus>`
            );
        }));

        this.app.all('/calendars/:username/:slug/', guard(async (request, response) => {
            const calendar = await this.bridgeOf(request).getCalendarBySlug(request.params.slug);

            // 0.34: a calendar created in Calendar.app becomes a Proton calendar at the path it chose.
            if (request.method === 'MKCALENDAR') {
                if (calendar) {
                    response.setHeader('Allow', 'OPTIONS, PROPFIND, PROPPATCH, REPORT, GET, HEAD, DELETE');
                    response.status(405).type('text/plain').send('A calendar with this path exists');
                    return;
                }
                const wanted = parseCalendarProperties(typeof request.body === 'string' ? request.body : '');
                // 0.35.1: Reminders' task list is refused, quietly — it asks on every refresh, which is
                // not a failure worth the Overview page; the reason is logged once per run.
                if (isTaskListRequest(wanted)) {
                    if (!this.taskListRefusalLogged) {
                        this.taskListRefusalLogged = true;
                        console.log(`[caldav] MKCALENDAR for a task list ("${secret(wanted.displayName ?? '')}", ${wanted.components?.join('+') || 'no components'}) refused: ${TASK_LIST_REFUSAL}`);
                    }
                    response.status(403).type('text/plain').send(TASK_LIST_REFUSAL);
                    return;
                }
                try {
                    await this.bridgeOf(request).createCalendarFromCalendarApp(request.params.slug, {
                        name: wanted.displayName ?? 'Calendar',
                        color: wanted.color,
                        description: wanted.description
                    });
                } catch (error) {
                    const status = slowDownStatus(error, response) ?? 403;
                    this.reportFailure(request, status, errorMessage(error));
                    response.status(status).type('text/plain').send(errorMessage(error));
                    return;
                }
                response.status(201).send(); // created in Proton (mirrored now, or by the next sync pass)
                return;
            }

            if (!calendar || calendar.removed) {
                response.status(404).send('Calendar not found');
                return;
            }

            // 0.34: renamed or recoloured in Calendar.app → Proton. Other properties are not stored (403),
            // the calendar's order is accepted silently (Calendar.app keeps its own).
            if (request.method === 'PROPPATCH') {
                const wanted = parseCalendarProperties(typeof request.body === 'string' ? request.body : '');
                const changes = {
                    ...(wanted.displayName !== undefined ? { name: wanted.displayName } : {}),
                    ...(wanted.color !== undefined ? { color: wanted.color } : {}),
                    ...(wanted.description !== undefined ? { description: wanted.description } : {})
                };
                if (wanted.transparency) {
                    await this.bridgeOf(request).setCalendarAvailability?.(request.params.slug, wanted.transparency === 'opaque');
                }
                if (Object.keys(changes).length) {
                    try {
                        await this.bridgeOf(request).updateCalendarAppearance(request.params.slug, changes);
                    } catch (error) {
                        const status = slowDownStatus(error, response) ?? 403;
                        this.reportFailure(request, status, errorMessage(error));
                        response.status(status).type('text/plain').send(errorMessage(error));
                        return;
                    }
                }
                // Calendar.app also sets its own housekeeping properties (order, time zone): accepted and
                // not stored, like most servers do; "Events affect availability" is stored (0.37.7). Anything else: 403.
                const applied = [
                    ...(wanted.displayName !== undefined ? ['<D:displayname/>'] : []),
                    ...(wanted.color !== undefined ? ['<A:calendar-color/>'] : []),
                    ...(wanted.description !== undefined ? ['<C:calendar-description/>'] : []),
                    ...(wanted.order !== undefined ? ['<A:calendar-order/>'] : []),
                    ...wanted.others.filter((name) => ACCEPTED_CALENDAR_PROPERTIES.has(name)).map((name) => `<C:${name}/>`)
                ];
                const refused = [
                    ...wanted.others.filter((name) => !ACCEPTED_CALENDAR_PROPERTIES.has(name)).map((name) => `<D:${name}/>`),
                    ...wanted.removed.map((name) => (name === 'displayname' ? '<D:displayname/>' : name.startsWith('calendar-') ? `<A:${name}/>` : `<D:${name}/>`))
                ];
                this.sendXml(
                    response,
                    207,
                    `<?xml version="1.0" encoding="utf-8"?>
<D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav" xmlns:A="${APPLE_CALENDAR_NS}">
  <D:response>
    <D:href>${escapeXml(request.path)}</D:href>${
        applied.length
            ? `
    <D:propstat>
      <D:prop>${applied.join('')}</D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>`
            : ''
    }${
        refused.length
            ? `
    <D:propstat>
      <D:prop>${refused.join('')}</D:prop>
      <D:status>HTTP/1.1 403 Forbidden</D:status>
    </D:propstat>`
            : ''
    }
  </D:response>
</D:multistatus>`
                );
                return;
            }

            const events = await this.bridgeOf(request).listEventsForSlug(request.params.slug);
            const activeEvents = events.filter((event) => !event.deleted);

            if (request.method === 'GET' || request.method === 'HEAD') {
                response
                    .type('text/plain')
                    .send(request.method === 'HEAD' ? '' : `CalDAV collection for ${calendar.displayName}`);
                return;
            }

            if (request.method === 'PROPFIND') {
                const depth = request.header('depth') || '0';
                const resourceResponses =
                    depth === '0'
                        ? ''
                        : activeEvents
                              .map(
                                  (event) => `
  <D:response>
    <D:href>${escapeXml(event.href)}</D:href>
    <D:propstat>
      <D:prop>
        <D:getetag>${escapeXml(event.etag)}</D:getetag>
        <D:getcontenttype>text/calendar; charset=utf-8</D:getcontenttype>
        <D:getcontentlength>${Buffer.byteLength(event.serializedIcs, 'utf8')}</D:getcontentlength>
        <D:resourcetype/>
      </D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>`
                              )
                              .join('\n');

                this.sendXml(
                    response,
                    207,
                    `<?xml version="1.0" encoding="utf-8"?>
<D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav" xmlns:CS="http://calendarserver.org/ns/">
  <D:response>
    <D:href>${escapeXml(request.path)}</D:href>
    <D:propstat>
      <D:prop>
        <D:displayname>${escapeXml(calendar.displayName)}</D:displayname>
        <D:resourcetype>
          <D:collection/>
          <C:calendar/>
        </D:resourcetype>${buildPrincipalLinksXml(this.bridgeOf(request).getCalDAVConfig().username, true)}
        <C:calendar-description>${escapeXml(calendar.description || '')}</C:calendar-description>
        <C:supported-calendar-component-set>
          <C:comp name="VEVENT"/>
        </C:supported-calendar-component-set>
        <CS:getctag>${escapeXml(calendar.ctag)}</CS:getctag>
        <D:sync-token>${escapeXml(this.buildSyncToken(request, request.params.slug, calendar.ctag))}</D:sync-token>
${buildTransparencyXml(this.bridgeOf(request).isCalendarOpaque?.(calendar) ?? true)}
${buildPrivilegeSetXml(calendar.readOnly)}
      </D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>
${resourceResponses}
</D:multistatus>`
                );
                return;
            }

            if (request.method === 'REPORT') {
                const reportBody = typeof request.body === 'string' ? request.body : '';
                const isSyncCollection = reportBody.includes('sync-collection');
                const isCalendarMultiGet = reportBody.includes('calendar-multiget');
                const syncTokenVersion = isSyncCollection ? parseSyncTokenVersion(reportBody) : null;
                const requestedHrefs = this.extractRequestedHrefs(request.body);
                const allEvents = isSyncCollection
                    ? await this.bridgeOf(request).listEventsForSlug(request.params.slug, true)
                    : activeEvents;
                const liveEvents = allEvents.filter((event) => !event.deleted);
                const deletedEvents = allEvents.filter((event) => event.deleted);

                if (isCalendarMultiGet) {
                    console.log(
                        `[caldav] multiget requested-hrefs=${requestedHrefs.length} sample=${secret(requestedHrefs.slice(0, 3).join(', '))}`
                    );
                    if (!requestedHrefs.length && reportBody) {
                        console.log(`[caldav] multiget body snippet=${secret(reportBody.slice(0, 500))}`);
                    }
                }

                const matchingEvents = liveEvents.filter((event) => {
                    if (!requestedHrefs.length) {
                        return !isSyncCollection || syncTokenVersion === null || event.lastSyncedAt > syncTokenVersion;
                    }

                    const normalizedEventHref = normalizeRequestedHref(event.href);
                    const decodedEventHref = decodeURIComponent(normalizedEventHref);
                    return requestedHrefs.some((href) => {
                        const normalizedHref = normalizeRequestedHref(href);
                        if (normalizedHref === normalizedEventHref) {
                            return true;
                        }
                        return decodeURIComponent(normalizedHref) === decodedEventHref;
                    });
                });

                const dedupedEvents = matchingEvents.filter((event, index, collection) => {
                    return (
                        collection.findIndex((candidate) => candidate.protonEventId === event.protonEventId) === index
                    );
                });

                const matchedHrefs = new Set(
                    dedupedEvents.map((event) => normalizeRequestedHref(event.href)).flatMap((href) => [
                        href,
                        decodeURIComponent(href)
                    ])
                );

                const foundResponses = dedupedEvents
                    .map(
                        (event) => `
  <D:response>
    <D:href>${escapeXml(event.href)}</D:href>
    <D:propstat>
      <D:prop>
        <D:getetag>${escapeXml(event.etag)}</D:getetag>
        <D:getcontenttype>text/calendar; charset=utf-8</D:getcontenttype>
        <D:getcontentlength>${Buffer.byteLength(event.serializedIcs, 'utf8')}</D:getcontentlength>
        <C:calendar-data>${escapeXml(event.serializedIcs)}</C:calendar-data>
      </D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>`
                    )
                    .join('\n');

                const missingResponses =
                    isCalendarMultiGet && requestedHrefs.length
                        ? requestedHrefs
                              .filter((href, index, collection) => collection.indexOf(href) === index)
                              .filter((href) => {
                                  const normalizedHref = normalizeRequestedHref(href);
                                  return !matchedHrefs.has(normalizedHref) && !matchedHrefs.has(decodeURIComponent(normalizedHref));
                              })
                              .map(
                                  (href) => `
  <D:response>
    <D:href>${escapeXml(href)}</D:href>
    <D:status>HTTP/1.1 404 Not Found</D:status>
  </D:response>`
                              )
                              .join('\n')
                        : '';

                const deletedResponses =
                    isSyncCollection
                        ? deletedEvents
                              .map(
                                  (event) => `
  <D:response>
    <D:href>${escapeXml(event.href)}</D:href>
    <D:status>HTTP/1.1 404 Not Found</D:status>
  </D:response>`
                              )
                              .join('\n')
                        : '';

                const body = [foundResponses, missingResponses, deletedResponses].filter(Boolean).join('\n');

                this.sendXml(
                    response,
                    207,
                    `<?xml version="1.0" encoding="utf-8"?>
<D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
${body}
${isSyncCollection ? `  <D:sync-token>${escapeXml(this.buildSyncToken(request, request.params.slug, calendar.ctag))}</D:sync-token>` : ''}
</D:multistatus>`
                );
                return;
            }

            if (request.method === 'DELETE') {
                // 0.37: deleting a calendar in Calendar.app takes it out of Calendar.app only (unticked here);
                // it stays in Proton and can be ticked again. Deleting it in Proton is too destructive to
                // take from a calendar app that may just be removing an account.
                try {
                    await this.bridgeOf(request).untickFromCalendarApp(request.params.slug);
                } catch (error) {
                    const status = slowDownStatus(error, response) ?? ((error as Error)?.name === 'CalendarNotFoundError' ? 404 : 500);
                    this.reportFailure(request, status, errorMessage(error));
                    response.status(status).type('text/plain').send(errorMessage(error));
                    return;
                }
                response.status(204).send();
                return;
            }

            response.status(405).send('Method not allowed');
        }));

        this.app.all('/calendars/:username/:slug/:resource', guard(async (request, response) => {
            const resourceUid = decodeURIComponent(request.params.resource.replace(/\.ics$/i, ''));

            if (request.method === 'GET' || request.method === 'HEAD') {
                const calendar = await this.bridgeOf(request).getCalendarBySlug(request.params.slug);
                if (!calendar || calendar.removed) {
                    response.status(404).send('Calendar not found');
                    return;
                }

                const events = await this.bridgeOf(request).listEventsForSlug(request.params.slug);
                const event = events.find((entry) => entry.href === request.path || entry.uid === resourceUid);
                if (!event) {
                    response.status(404).send('Event not found');
                    return;
                }

                response.setHeader('ETag', event.etag);
                response.type('text/calendar').send(request.method === 'HEAD' ? '' : event.serializedIcs);
                return;
            }

            if (request.method === 'PUT') {
                if (isDetailedLogging() && typeof request.body === 'string') {
                    // 0.48.6: what another app sends (Thunderbird answering an invitation, say), for tracing.
                    console.log(`[caldav] PUT event data (shown with detailed logging):${secret(`\n${request.body}`)}`);
                }
                try {
                    const record = await this.bridgeOf(request).upsertLocalEvent(
                        request.params.slug,
                        request.params.resource,
                        request.path,
                        withoutTimeZoneOnDates(typeof request.body === 'string' ? request.body : ''),
                        { ifMatch: request.get('If-Match') || undefined, client: caldavClientOf(request.header('user-agent')).kind }
                    );
                    if (!record.etag) {
                        response.status(204).send();
                        return;
                    }
                    response.setHeader('ETag', record.etag);
                    response.status(201).send('Created');
                } catch (error) {
                    const status = slowDownStatus(error, response) ?? (error instanceof StaleEventError ? 412 : error instanceof ReadOnlyEventError ? 403 : 500);
                    const message = errorMessage(error) || 'Failed to upsert event';
                    this.reportFailure(request, status, message, error);

                    response.status(status).send(message);
                }
                return;
            }

            if (request.method === 'DELETE') {
                try {
                    const events = await this.bridgeOf(request).listEventsForSlug(request.params.slug);
                    const event = events.find((entry) => entry.href === request.path || entry.uid === resourceUid);
                    // RFC 6638 §8.1: "Schedule-Reply: F" = remove an invitation without telling the organizer.
                    const notifyOrganizer = String(request.get('Schedule-Reply') || 'T').trim().toUpperCase() !== 'F';
                    await this.bridgeOf(request).deleteLocalEvent(request.params.slug, event?.uid || resourceUid, { notifyOrganizer });
                    response.status(204).send();
                } catch (error) {
                    const status = slowDownStatus(error, response) ?? (error instanceof ReadOnlyEventError ? 403 : 500);
                    const message = errorMessage(error) || 'Failed to delete event';
                    this.reportFailure(request, status, message);
                    response.status(status).send(message);
                }
                return;
            }

            response.status(405).send('Method not allowed');
        }));

        const buildSchedulingCollectionXml = (href: string, displayName: string, kind?: 'schedule-inbox' | 'schedule-outbox', extra = '') => `<?xml version="1.0" encoding="utf-8"?>
<D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
  <D:response>
    <D:href>${escapeXml(href)}</D:href>
    <D:propstat>
      <D:prop>
        <D:displayname>${escapeXml(displayName)}</D:displayname>
        <D:resourcetype>
          <D:collection/>${kind ? `\n          <C:${kind}/>` : ''}
        </D:resourcetype>
${buildPrivilegeSetXml()}${extra ? `\n${extra}` : ''}
      </D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>
</D:multistatus>`;

        this.app.all('/inbox/:username/', guard(async (request, response) => {
            if (request.method === 'PROPFIND') {
                // The inbox carries the (pre-RFC) list of calendars that count towards availability (0.37.7).
                const bridge = this.bridgeOf(request);
                const username = bridge.getCalDAVConfig().username;
                const calendars = typeof bridge.getCalendars === 'function' ? await bridge.getCalendars() : [];
                const hrefs = calendars.filter((calendar) => !calendar.removed && (bridge.isCalendarOpaque?.(calendar) ?? true)).map((calendar) => buildCollectionPath(username, calendar.slug));
                this.sendXml(response, 207, buildSchedulingCollectionXml(request.path, 'Scheduling Inbox', 'schedule-inbox', buildFreeBusySetXml(hrefs)));
                return;
            }

            // Proton puts incoming invitations straight into the calendar, so the inbox stays empty.
            if (request.method === 'REPORT') {
                this.sendXml(
                    response,
                    207,
                    `<?xml version="1.0" encoding="utf-8"?>
<D:multistatus xmlns:D="DAV:">
  <D:sync-token>${escapeXml(`${this.bridgeOf(request).getCalDAVConfig().baseUrl}/sync/inbox/0`)}</D:sync-token>
</D:multistatus>`
                );
                return;
            }

            if (request.method === 'GET' || request.method === 'HEAD') {
                response.status(200).type('text/plain').send(request.method === 'HEAD' ? '' : 'Scheduling inbox');
                return;
            }

            response.status(405).send('Method not allowed');
        }));

        this.app.all('/outbox/:username/', guard(async (request, response) => {
            if (request.method === 'PROPFIND') {
                this.sendXml(response, 207, buildSchedulingCollectionXml(request.path, 'Scheduling Outbox', 'schedule-outbox'));
                return;
            }

            if (request.method === 'GET' || request.method === 'HEAD') {
                response.status(200).type('text/plain').send(request.method === 'HEAD' ? '' : 'Scheduling outbox');
                return;
            }

            if (request.method === 'POST') {
                const body = typeof request.body === 'string' ? request.body : '';
                // With calendar-auto-schedule, the outbox only takes availability (free/busy) lookups
                // (0.33.2): each guest is answered with their busy periods — the user's own addresses from
                // the mirror, Proton users from Proton's busy-schedule endpoint when Proton shares them —
                // or with "no scheduling support" (RFC 6638 §3.2.9), which Calendar.app shows as unknown.
                const freeBusy = parseFreeBusyRequest(body);
                if (freeBusy) {
                    const responses: string[] = [];
                    let known = 0;
                    for (const recipient of freeBusy.attendees) {
                        const answer = await this.bridgeOf(request).freeBusyOf(emailOfCalendarAddress(recipient), freeBusy.start, freeBusy.end);
                        if (answer.known) {
                            known += 1;
                            responses.push(`  <C:response>
    <C:recipient><D:href>${escapeXml(recipient)}</D:href></C:recipient>
    <C:request-status>2.0;Success</C:request-status>
    <C:calendar-data>${escapeXml(freeBusyReplyIcs({ ...freeBusy, end: answer.end }, recipient, answer.periods))}</C:calendar-data>
  </C:response>`);
                        } else {
                            responses.push(`  <C:response>
    <C:recipient><D:href>${escapeXml(recipient)}</D:href></C:recipient>
    <C:request-status>5.3;No scheduling support for user</C:request-status>
  </C:response>`);
                        }
                    }
                    console.log(`[caldav] free/busy lookup: ${known} of ${freeBusy.attendees.length} guest(s) answered`);
                    this.sendXml(
                        response,
                        200,
                        `<?xml version="1.0" encoding="utf-8"?>
<C:schedule-response xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
${responses.join('\n')}
</C:schedule-response>`
                    );
                    return;
                }
                // Anything else would be Calendar.app delivering an invitation itself: never pretend it went out.
                const message = 'Invitations are not sent from Calendar.app. Invite guests in Proton Calendar for now.';
                this.reportFailure(request, 403, message);
                response.status(403).type('text/plain').send(message);
                return;
            }

            response.status(405).send('Method not allowed');
        }));

        this.app.all('/dropbox/:username/', guard(async (request, response) => {
            if (request.method === 'PROPFIND') {
                this.sendXml(response, 207, buildSchedulingCollectionXml(request.path, 'Attachments'));
                return;
            }

            if (request.method === 'GET' || request.method === 'HEAD') {
                response.status(200).type('text/plain').send(request.method === 'HEAD' ? '' : 'Calendar attachments');
                return;
            }

            response.status(405).send('Method not allowed');
        }));
    }

    private extractRequestedHrefs(body: unknown) {
        if (typeof body !== 'string') {
            return [];
        }

        const xmlDecode = (value: string) =>
            value
                .replace(/&amp;/g, '&')
                .replace(/&lt;/g, '<')
                .replace(/&gt;/g, '>')
                .replace(/&quot;/g, '"')
                .replace(/&#39;/g, "'");

        const hrefMatches = [
            ...body.matchAll(/<(?:[A-Za-z0-9_]+:)?href>([^<]+)<\/(?:[A-Za-z0-9_]+:)?href>/g)
        ].map((match) => normalizeRequestedHref(xmlDecode(match[1])));

        const fallbackMatches = [
            ...body.matchAll(/https?:\/\/[^<\s'"]+\.ics|\/calendars\/[^<\s'"]+\.ics/g)
        ].map((match) => normalizeRequestedHref(xmlDecode(match[0])));

        return [...new Set([...hrefMatches, ...fallbackMatches])];
    }

    /** The property names (local names) a PROPFIND body asks for; empty = all (allprop or no body). */
    private requestedPropertyNames(request: Request) {
        const body = typeof request.body === 'string' ? request.body : '';
        const propBlock = body.match(/<(?:[A-Za-z0-9_.-]+:)?prop(?:\s[^>]*)?>([\s\S]*?)<\/(?:[A-Za-z0-9_.-]+:)?prop\s*>/);
        if (!propBlock) {
            return [];
        }
        return [...new Set([...propBlock[1].matchAll(/<(?:[A-Za-z0-9_.-]+:)?([A-Za-z][A-Za-z0-9_.-]*)(?=[\s/>])/g)].map((match) => match[1]))];
    }

    /**
     * Guest autocomplete (0.33.1): answers a principal search from the account's contacts. Names and
     * addresses stay out of bridge.log; only how many principals were found is logged.
     */
    private async answerPrincipalSearch(request: Request, response: Response) {
        const body = typeof request.body === 'string' ? request.body : '';
        if (body.length > PRINCIPAL_SEARCH_BODY_LIMIT) {
            response.status(413).type('text/plain').send('Search too large');
            return;
        }
        const search = parsePrincipalSearch(body);
        if (!search) {
            response.status(403).type('text/plain').send('Unsupported report');
            return;
        }
        if (search.kind === 'principal-search-property-set') {
            this.sendXml(response, 200, searchPropertySetXml());
            return;
        }
        const config = this.bridgeOf(request).getCalDAVConfig();
        const ownAddresses = this.bridgeOf(request).getAccountAddresses?.() ?? [];
        const contacts = await this.bridgeOf(request).listContactsForSearch();
        const found = searchContacts(contacts, search);
        console.log(`[caldav] guest search: ${found.length} of ${contacts.length} contact(s) match`);
        this.sendXml(
            response,
            207,
            multistatusXml(
                found.map((contact) =>
                    principalResponseXml(
                        describeContactPrincipal(contact, `/principals/${config.username}/`, `/calendars/${config.username}/`, ownAddresses),
                        search.properties
                    )
                )
            )
        );
    }

    private buildSyncToken(request: Request, slug: string, ctag: string) {
        const config = this.bridgeOf(request).getCalDAVConfig();
        return `${config.baseUrl}/sync/${slug}/${encodeURIComponent(ctag)}`;
    }
    private sendXml(response: Response, statusCode: number, body: string) {
        response.status(statusCode);
        response.setHeader('Content-Type', XML_CONTENT_TYPE);
        response.send(body);
    }
}
