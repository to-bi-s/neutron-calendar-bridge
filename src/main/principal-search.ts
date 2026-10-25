/**
 * Guest autocomplete (0.33.1): Calendar.app looks guests up on the server with a REPORT on the
 * principal collection (/principals/) — DAV:principal-property-search (RFC 3744, with Apple's
 * match-type attribute) or, where the server advertises it, calendarserver-principal-search — and
 * suggests the principals that come back while you type a guest. The bridge answers from the
 * Proton account's contacts and its own addresses (BridgeService.listContactsForSearch()): each
 * contact address is a principal of its own under /principals/contacts/<token>/.
 *
 * Pure functions: parsing the two report bodies, matching contacts, building the multistatus.
 */

export interface SearchableContact {
    email: string;
    name: string;
    /** One of the account's own addresses (the signed-in user). */
    self: boolean;
}

export type MatchType = 'starts-with' | 'contains' | 'equals' | 'ends-with';

/** One <property-search>: the text must match one of the named properties. */
export interface PropertySearch {
    properties: string[];
    text: string;
    matchType: MatchType;
}

export interface PrincipalSearchRequest {
    kind: 'principal-property-search' | 'calendarserver-principal-search' | 'principal-search-property-set';
    /** principal-property-search: whether one (anyof) or every (allof) property-search must match. */
    test: 'anyof' | 'allof';
    searches: PropertySearch[];
    /** calendarserver-principal-search: every token must match (some field). */
    tokens: string[];
    /** calendarserver-principal-search context: attendee (people), location, resource. */
    context: string;
    /** Local names of the properties Calendar.app asked for; empty = all the bridge knows. */
    properties: string[];
    limit: number | null;
}

/** The properties a principal of the bridge answers (local names, in Apple's namespaces). */
export const PRINCIPAL_PROPERTIES = [
    'displayname',
    'resourcetype',
    'principal-URL',
    'calendar-user-address-set',
    'calendar-user-type',
    'email-address-set',
    'first-name',
    'last-name',
    'record-type',
    'calendar-home-set'
] as const;

const SEARCHABLE_PROPERTIES = ['displayname', 'email-address-set', 'calendar-user-address-set', 'first-name', 'last-name'];

const localName = (qualified: string) => qualified.replace(/^[A-Za-z0-9_.-]+:/, '');

const codePoint = (code: number) =>
    Number.isInteger(code) && code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : '\ufffd';

export const xmlUnescape = (value: string) =>
    value
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&#(\d+);/g, (_match, code: string) => codePoint(Number(code)))
        .replace(/&#x([0-9a-fA-F]+);/g, (_match, code: string) => codePoint(parseInt(code, 16)))
        .replace(/&amp;/g, '&');

export const xmlEscape = (value: string) =>
    value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');

/** The element names (local names) that appear as empty or opening tags inside an XML fragment. */
const elementNames = (fragment: string) =>
    [...fragment.matchAll(/<([A-Za-z0-9_.-]+(?::[A-Za-z0-9_.-]+)?)(?=[\s/>])/g)].map((match) => localName(match[1]));

/** The contents of every <name>…</name> element (the first level only, nesting is not expected). */
const elements = (body: string, name: string) =>
    [...body.matchAll(new RegExp(`<(?:[A-Za-z0-9_.-]+:)?${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/(?:[A-Za-z0-9_.-]+:)?${name}\\s*>`, 'g'))].map(
        (match) => match[1]
    );

const attribute = (tag: string, name: string) => {
    const match = tag.match(new RegExp(`\\s${name}\\s*=\\s*"([^"]*)"`)) || tag.match(new RegExp(`\\s${name}\\s*=\\s*'([^']*)'`));
    return match ? xmlUnescape(match[1]) : null;
};

const asMatchType = (value: string | null): MatchType =>
    value === 'starts-with' || value === 'contains' || value === 'equals' || value === 'ends-with' ? value : 'contains';

/**
 * Reads a principal search report. null when the body is none of the three reports (the caller
 * then answers like for any other unsupported report).
 */
export const parsePrincipalSearch = (body: string): PrincipalSearchRequest | null => {
    const rootMatch = body.match(
        /<(?:[A-Za-z0-9_.-]+:)?(principal-property-search|calendarserver-principal-search|principal-search-property-set)(\s[^>]*)?>/
    );
    if (!rootMatch) {
        return null;
    }
    const kind = rootMatch[1] as PrincipalSearchRequest['kind'];
    const rootTag = rootMatch[0];
    const request: PrincipalSearchRequest = {
        kind,
        test: attribute(rootTag, 'test') === 'anyof' ? 'anyof' : 'allof',
        searches: [],
        tokens: [],
        context: attribute(rootTag, 'context') || 'attendee',
        properties: [],
        limit: null
    };
    if (kind === 'principal-search-property-set') {
        return request;
    }

    let rest = body;
    if (kind === 'principal-property-search') {
        const searchBlocks = [
            ...body.matchAll(/<(?:[A-Za-z0-9_.-]+:)?property-search(?:\s[^>]*)?>([\s\S]*?)<\/(?:[A-Za-z0-9_.-]+:)?property-search\s*>/g)
        ];
        for (const block of searchBlocks) {
            const inner = block[1];
            const propBlock = elements(inner, 'prop')[0] || '';
            const matchTag = inner.match(/<(?:[A-Za-z0-9_.-]+:)?match(\s[^>]*)?>([\s\S]*?)<\/(?:[A-Za-z0-9_.-]+:)?match\s*>/);
            const text = matchTag ? xmlUnescape(matchTag[2]).trim() : '';
            const properties = elementNames(propBlock).filter((name) => SEARCHABLE_PROPERTIES.includes(name));
            if (text && properties.length) {
                request.searches.push({ properties, text, matchType: asMatchType(matchTag ? attribute(matchTag[0], 'match-type') : null) });
            }
            rest = rest.replace(block[0], '');
        }
    } else {
        request.tokens = elements(body, 'search-token')
            .map((token) => xmlUnescape(token).trim())
            .filter(Boolean);
    }

    const limit = elements(rest, 'nresults')[0];
    if (limit && /^\d+$/.test(limit.trim())) {
        request.limit = Number(limit.trim());
    }
    const requested = elements(rest.replace(/<(?:[A-Za-z0-9_.-]+:)?limit(?:\s[^>]*)?>[\s\S]*?<\/(?:[A-Za-z0-9_.-]+:)?limit\s*>/g, ''), 'prop')[0];
    if (requested) {
        request.properties = [...new Set(elementNames(requested))];
    }
    return request;
};

/** Lower-case without accents, so "mu" finds "Müller" and "jose" finds "José". */
const fold = (value: string) =>
    value
        .normalize('NFD')
        .replace(/\p{M}+/gu, '')
        .toLowerCase();

const firstName = (name: string) => name.trim().split(/\s+/)[0] || '';
const lastName = (name: string) => {
    const words = name.trim().split(/\s+/);
    return words.length > 1 ? words[words.length - 1] : '';
};

const fieldsOf = (contact: SearchableContact, property: string) => {
    switch (property) {
        case 'displayname':
            return [contact.name || contact.email];
        case 'first-name':
            return [firstName(contact.name)];
        case 'last-name':
            return [lastName(contact.name)];
        case 'calendar-user-address-set':
            return [contact.email, `mailto:${contact.email}`]; // Calendar.app resolves a guest with equals "mailto:…"
        default:
            return [contact.email];
    }
};

/** Whether text matches value: starts-with also matches the start of any word (and the part after @). */
const matches = (value: string, text: string, matchType: MatchType) => {
    const haystack = fold(value);
    const needle = fold(text);
    if (!haystack || !needle) {
        return false;
    }
    switch (matchType) {
        case 'equals':
            return haystack === needle;
        case 'ends-with':
            return haystack.endsWith(needle);
        case 'starts-with':
            return new RegExp(`(?:^|[\\s@.,;_-])${needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(haystack);
        default:
            return haystack.includes(needle);
    }
};

const matchesSearch = (contact: SearchableContact, search: PropertySearch) =>
    search.properties.some((property) => fieldsOf(contact, property).some((value) => matches(value, search.text, search.matchType)));

const matchesToken = (contact: SearchableContact, token: string) =>
    SEARCHABLE_PROPERTIES.some((property) => fieldsOf(contact, property).some((value) => matches(value, token, 'starts-with')));

/** The contacts a search request selects, in the order given (own addresses first), within the limit. */
export const searchContacts = (contacts: SearchableContact[], request: PrincipalSearchRequest): SearchableContact[] => {
    if (request.kind === 'principal-search-property-set') {
        return [];
    }
    if (request.kind === 'calendarserver-principal-search' && request.context !== 'attendee') {
        return []; // the bridge knows people, not rooms or resources
    }
    const selected = contacts.filter((contact) => {
        if (request.kind === 'calendarserver-principal-search') {
            return request.tokens.length > 0 && request.tokens.every((token) => matchesToken(contact, token));
        }
        if (!request.searches.length) {
            return false;
        }
        return request.test === 'anyof'
            ? request.searches.some((search) => matchesSearch(contact, search))
            : request.searches.every((search) => matchesSearch(contact, search));
    });
    return request.limit !== null ? selected.slice(0, Math.max(0, request.limit)) : selected;
};

/** /principals/contacts/<token>/ — the token is the address, base64url, so the path stays a plain path. */
export const contactPrincipalToken = (email: string) => Buffer.from(email, 'utf8').toString('base64url');

export const emailOfContactPrincipalToken = (token: string) => {
    if (!/^[A-Za-z0-9_-]+$/.test(token)) {
        return null;
    }
    const email = Buffer.from(token, 'base64url').toString('utf8');
    return email.includes('@') && Buffer.from(email, 'utf8').toString('base64url') === token ? email : null;
};

export interface PrincipalDescription {
    href: string;
    displayName: string;
    /** mailto: addresses. */
    addresses: string[];
    firstName: string;
    lastName: string;
    /** Only the signed-in user's principal has a calendar home. */
    calendarHomeHref: string | null;
}

export const describeContactPrincipal = (contact: SearchableContact, selfHref: string, selfHome: string, ownAddresses: string[]): PrincipalDescription =>
    contact.self
        ? {
              href: selfHref,
              displayName: contact.name || contact.email,
              addresses: (ownAddresses.length ? ownAddresses : [contact.email]).map((email) => `mailto:${email}`),
              firstName: firstName(contact.name),
              lastName: lastName(contact.name),
              calendarHomeHref: selfHome
          }
        : {
              href: `/principals/contacts/${contactPrincipalToken(contact.email)}/`,
              displayName: contact.name || contact.email,
              addresses: [`mailto:${contact.email}`],
              firstName: firstName(contact.name),
              lastName: lastName(contact.name),
              calendarHomeHref: null
          };

/** One <D:response> for a principal: the requested properties (all known ones when none were named). */
export const principalResponseXml = (principal: PrincipalDescription, requested: string[]) => {
    const wanted = requested.length ? requested : [...PRINCIPAL_PROPERTIES];
    const found: string[] = [];
    const missing: string[] = [];
    for (const name of wanted) {
        switch (name) {
            case 'displayname':
                found.push(`<D:displayname>${xmlEscape(principal.displayName)}</D:displayname>`);
                break;
            case 'resourcetype':
                found.push('<D:resourcetype><D:collection/><D:principal/></D:resourcetype>');
                break;
            case 'principal-URL':
                found.push(`<D:principal-URL><D:href>${xmlEscape(principal.href)}</D:href></D:principal-URL>`);
                break;
            case 'calendar-user-address-set':
                found.push(
                    `<C:calendar-user-address-set>${principal.addresses.map((address) => `<D:href>${xmlEscape(address)}</D:href>`).join('')}</C:calendar-user-address-set>`
                );
                break;
            case 'calendar-user-type':
                found.push('<C:calendar-user-type>INDIVIDUAL</C:calendar-user-type>');
                break;
            case 'email-address-set':
                found.push(
                    `<CS:email-address-set>${principal.addresses
                        .map((address) => `<CS:email-address>${xmlEscape(address.replace(/^mailto:/i, ''))}</CS:email-address>`)
                        .join('')}</CS:email-address-set>`
                );
                break;
            case 'first-name':
                if (principal.firstName) {
                    found.push(`<CS:first-name>${xmlEscape(principal.firstName)}</CS:first-name>`);
                } else {
                    missing.push('<CS:first-name/>');
                }
                break;
            case 'last-name':
                if (principal.lastName) {
                    found.push(`<CS:last-name>${xmlEscape(principal.lastName)}</CS:last-name>`);
                } else {
                    missing.push('<CS:last-name/>');
                }
                break;
            case 'record-type':
                found.push('<CS:record-type>users</CS:record-type>');
                break;
            case 'calendar-home-set':
                if (principal.calendarHomeHref) {
                    found.push(`<C:calendar-home-set><D:href>${xmlEscape(principal.calendarHomeHref)}</D:href></C:calendar-home-set>`);
                } else {
                    missing.push('<C:calendar-home-set/>');
                }
                break;
            default:
                // Unknown property: reported as not found, in no particular namespace (Calendar.app ignores it).
                if (/^[A-Za-z][A-Za-z0-9_.-]*$/.test(name)) {
                    missing.push(`<D:${name}/>`);
                }
        }
    }
    return `  <D:response>
    <D:href>${xmlEscape(principal.href)}</D:href>${
        found.length || !missing.length
            ? `
    <D:propstat>
      <D:prop>
${found.map((line) => `        ${line}`).join('\n')}
      </D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>`
            : ''
    }${
        missing.length
            ? `
    <D:propstat>
      <D:prop>
${missing.map((line) => `        ${line}`).join('\n')}
      </D:prop>
      <D:status>HTTP/1.1 404 Not Found</D:status>
    </D:propstat>`
            : ''
    }
  </D:response>`;
};

/** The answer to principal-search-property-set: the properties a search may name (RFC 3744 §9.5). */
export const searchPropertySetXml = () => `<?xml version="1.0" encoding="utf-8"?>
<D:principal-search-property-set xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav" xmlns:CS="http://calendarserver.org/ns/">
  <D:principal-search-property>
    <D:prop><D:displayname/></D:prop>
    <D:description xml:lang="en">Name</D:description>
  </D:principal-search-property>
  <D:principal-search-property>
    <D:prop><CS:email-address-set/></D:prop>
    <D:description xml:lang="en">Email address</D:description>
  </D:principal-search-property>
  <D:principal-search-property>
    <D:prop><C:calendar-user-address-set/></D:prop>
    <D:description xml:lang="en">Calendar address</D:description>
  </D:principal-search-property>
  <D:principal-search-property>
    <D:prop><CS:first-name/></D:prop>
    <D:description xml:lang="en">First name</D:description>
  </D:principal-search-property>
  <D:principal-search-property>
    <D:prop><CS:last-name/></D:prop>
    <D:description xml:lang="en">Last name</D:description>
  </D:principal-search-property>
</D:principal-search-property-set>`;

export const multistatusXml = (responses: string[]) => `<?xml version="1.0" encoding="utf-8"?>
<D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav" xmlns:CS="http://calendarserver.org/ns/">
${responses.join('\n')}
</D:multistatus>`;
