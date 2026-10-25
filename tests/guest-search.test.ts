/**
 * Guest autocomplete (0.33.1): Calendar.app's principal searches on /principals/ are answered from
 * the account's contacts — the report bodies as Calendar.app sends them, the matching, and the
 * principals in the answer.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { CalDAVServer } from '../src/main/caldav-server';
import {
    contactPrincipalToken,
    emailOfContactPrincipalToken,
    parsePrincipalSearch,
    searchContacts,
    type SearchableContact
} from '../src/main/principal-search';
import { loginFetch, withLogin } from './support/caldav-login';

const fetch = loginFetch('bridge-user', 'bridge-pass');
const PORT = 33001;
const BASE = `http://127.0.0.1:${PORT}`;

/** What Calendar.app sends while "mü" is being typed into the guest field. */
const appleSearch = (text: string, extra = '') => `<?xml version="1.0" encoding="UTF-8"?>
<A:principal-property-search xmlns:A="DAV:" test="anyof">
  <A:property-search>
    <A:prop><A:displayname/></A:prop>
    <A:match match-type="starts-with">${text}</A:match>
  </A:property-search>
  <A:property-search>
    <A:prop><B:email-address-set xmlns:B="http://calendarserver.org/ns/"/></A:prop>
    <A:match match-type="starts-with">${text}</A:match>
  </A:property-search>
  <A:property-search>
    <A:prop><B:first-name xmlns:B="http://calendarserver.org/ns/"/></A:prop>
    <A:match match-type="starts-with">${text}</A:match>
  </A:property-search>
  <A:property-search>
    <A:prop><B:last-name xmlns:B="http://calendarserver.org/ns/"/></A:prop>
    <A:match match-type="starts-with">${text}</A:match>
  </A:property-search>
  <A:prop>
    <C:calendar-user-address-set xmlns:C="urn:ietf:params:xml:ns:caldav"/>
    <B:email-address-set xmlns:B="http://calendarserver.org/ns/"/>
    <A:displayname/>
    <B:last-name xmlns:B="http://calendarserver.org/ns/"/>
    <B:first-name xmlns:B="http://calendarserver.org/ns/"/>
    <C:calendar-user-type xmlns:C="urn:ietf:params:xml:ns:caldav"/>
    <B:record-type xmlns:B="http://calendarserver.org/ns/"/>
    <A:principal-URL/>
  </A:prop>${extra}
  <A:apply-to-principal-collection-set/>
</A:principal-property-search>`;

const calendarServerSearch = (tokens: string[], context = 'attendee') => `<?xml version="1.0" encoding="UTF-8"?>
<B:calendarserver-principal-search xmlns:B="http://calendarserver.org/ns/" xmlns:A="DAV:" context="${context}">
${tokens.map((token) => `  <B:search-token>${token}</B:search-token>`).join('\n')}
  <B:limit><B:nresults>50</B:nresults></B:limit>
  <A:prop>
    <A:displayname/>
    <C:calendar-user-address-set xmlns:C="urn:ietf:params:xml:ns:caldav"/>
    <B:record-type/>
  </A:prop>
</B:calendarserver-principal-search>`;

const contacts: SearchableContact[] = [
    { email: 'me@proton.me', name: 'me', self: true },
    { email: 'anna.mueller@example.org', name: 'Anna Müller', self: false },
    { email: 'jose@example.org', name: 'José García & Co', self: false },
    { email: 'nameless@example.net', name: '', self: false }
];

test('principal-property-search as Calendar.app sends it: properties, match type, anyof, requested props', () => {
    const search = parsePrincipalSearch(appleSearch('m&#252;'));
    assert.ok(search);
    assert.equal(search.kind, 'principal-property-search');
    assert.equal(search.test, 'anyof');
    assert.equal(search.searches.length, 4);
    assert.deepEqual(search.searches[0], { properties: ['displayname'], text: 'mü', matchType: 'starts-with' });
    assert.deepEqual(search.searches[1].properties, ['email-address-set']);
    assert.deepEqual(search.properties, [
        'calendar-user-address-set',
        'email-address-set',
        'displayname',
        'last-name',
        'first-name',
        'calendar-user-type',
        'record-type',
        'principal-URL'
    ]);
    assert.equal(search.limit, null);
    assert.equal(parsePrincipalSearch(appleSearch('x', '<A:limit><A:nresults>3</A:nresults></A:limit>'))?.limit, 3);
    assert.equal(parsePrincipalSearch('<D:calendar-multiget xmlns:D="DAV:"/>'), null);
});

test('matching: word starts, accents folded, own address first, anyof/allof, limit', () => {
    const found = (text: string) => searchContacts(contacts, parsePrincipalSearch(appleSearch(text))!).map((contact) => contact.email);
    assert.deepEqual(found('mü'), ['anna.mueller@example.org']); // last name
    assert.deepEqual(found('mu'), ['anna.mueller@example.org']); // without the umlaut, too
    assert.deepEqual(found('Mueller'), ['anna.mueller@example.org']); // the address, after the dot
    assert.deepEqual(found('jos'), ['jose@example.org']);
    assert.deepEqual(found('garc'), ['jose@example.org']); // a middle word of the name
    assert.deepEqual(found('m'), ['me@proton.me', 'anna.mueller@example.org']); // the own address first
    assert.deepEqual(found('nameless'), ['nameless@example.net']); // no name: the address is the display name
    assert.deepEqual(found('zzz'), []);
    assert.deepEqual(found(''), []); // nothing typed yet: nothing (Calendar.app does not ask then)

    const allOf = parsePrincipalSearch(appleSearch('anna').replace('test="anyof"', 'test="allof"'))!;
    assert.equal(allOf.test, 'allof');
    assert.deepEqual(searchContacts(contacts, allOf), []); // "anna" is not also a last name and address

    const limited = parsePrincipalSearch(appleSearch('m', '<A:limit><A:nresults>1</A:nresults></A:limit>'))!;
    assert.deepEqual(
        searchContacts(contacts, limited).map((contact) => contact.email),
        ['me@proton.me']
    );
});

test('calendarserver-principal-search: every token must match; rooms and resources are not known', () => {
    const tokens = (list: string[], context?: string) =>
        searchContacts(contacts, parsePrincipalSearch(calendarServerSearch(list, context))!).map((contact) => contact.email);
    assert.deepEqual(tokens(['anna']), ['anna.mueller@example.org']);
    assert.deepEqual(tokens(['anna', 'mü']), ['anna.mueller@example.org']);
    assert.deepEqual(tokens(['anna', 'garcia']), []);
    assert.deepEqual(tokens(['anna'], 'location'), []);
    assert.deepEqual(tokens([]), []);
    const parsed = parsePrincipalSearch(calendarServerSearch(['a']))!;
    assert.equal(parsed.limit, 50);
    assert.deepEqual(parsed.properties, ['displayname', 'calendar-user-address-set', 'record-type']);
});

test('contact principal tokens: the address, base64url, nothing else accepted', () => {
    const token = contactPrincipalToken('anna.mueller@example.org');
    assert.match(token, /^[A-Za-z0-9_-]+$/);
    assert.equal(emailOfContactPrincipalToken(token), 'anna.mueller@example.org');
    assert.equal(emailOfContactPrincipalToken('not-base64!'), null);
    assert.equal(emailOfContactPrincipalToken(Buffer.from('no-at-sign').toString('base64url')), null);
    assert.equal(emailOfContactPrincipalToken('../etc'), null);
});

test('caldav server: the principal collection answers guest searches from the contacts', async () => {
    let searches = 0;
    const fakeBridgeService = withLogin({
        isSignedIn: () => true,
        getCalDAVConfig: () => ({
            host: '127.0.0.1',
            port: PORT,
            username: 'bridge-user',
            password: 'bridge-pass',
            security: 'HTTP' as const,
            baseUrl: BASE,
            serverPath: '/principals/bridge-user/'
        }),
        getAccountAddresses: () => ['me@proton.me', 'alias@proton.me'],
        getSignedInUsername: () => 'me@proton.me',
        async listContactsForSearch() {
            searches += 1;
            return contacts;
        }
    });
    const server = new CalDAVServer(fakeBridgeService as any);
    await server.start();
    try {
        // Calendar.app first reads the collection and what can be searched.
        const collection = await fetch(`${BASE}/principals/`, { method: 'PROPFIND', headers: { Depth: '1' } });
        assert.equal(collection.status, 207);
        const collectionBody = await collection.text();
        assert.match(collectionBody, /<D:principal-property-search\/>/);
        assert.match(collectionBody, /<CS:calendarserver-principal-search\/>/);
        assert.match(collectionBody, /<D:href>\/principals\/bridge-user\/<\/D:href>/);
        assert.doesNotMatch(collectionBody, /example\.org/); // the contacts are not listed, only searched

        const propertySet = await fetch(`${BASE}/principals/`, {
            method: 'REPORT',
            body: '<?xml version="1.0"?><D:principal-search-property-set xmlns:D="DAV:"/>'
        });
        assert.equal(propertySet.status, 200);
        assert.match(await propertySet.text(), /<D:principal-search-property-set[\s\S]*<CS:email-address-set\/>/);

        // The search: a contact and the user's own principal.
        const found = await fetch(`${BASE}/principals/`, { method: 'REPORT', headers: { Depth: '0' }, body: appleSearch('m') });
        assert.equal(found.status, 207);
        const foundBody = await found.text();
        const token = contactPrincipalToken('anna.mueller@example.org');
        assert.match(foundBody, new RegExp(`<D:href>/principals/contacts/${token}/</D:href>`));
        assert.match(foundBody, /<D:displayname>Anna Müller<\/D:displayname>/);
        assert.match(foundBody, /<CS:first-name>Anna<\/CS:first-name>/);
        assert.match(foundBody, /<CS:last-name>Müller<\/CS:last-name>/);
        assert.match(foundBody, /<C:calendar-user-address-set><D:href>mailto:anna.mueller@example.org<\/D:href><\/C:calendar-user-address-set>/);
        assert.match(foundBody, /<CS:email-address-set><CS:email-address>anna.mueller@example.org<\/CS:email-address><\/CS:email-address-set>/);
        assert.match(foundBody, /<C:calendar-user-type>INDIVIDUAL<\/C:calendar-user-type>/);
        assert.match(foundBody, /<CS:record-type>users<\/CS:record-type>/);
        // The own principal: its real href and every own address.
        assert.match(foundBody, /<D:href>\/principals\/bridge-user\/<\/D:href>/);
        assert.match(foundBody, /<D:href>mailto:me@proton.me<\/D:href><D:href>mailto:alias@proton.me<\/D:href>/);
        assert.doesNotMatch(foundBody, /jose@example.org/);
        // Only the requested properties: no calendar-home-set was asked for.
        assert.doesNotMatch(foundBody, /calendar-home-set/);

        // Special characters in names and in the typed text are escaped both ways.
        const ampersand = await fetch(`${BASE}/principals/`, { method: 'REPORT', body: appleSearch('garc&#237;a &amp;') });
        const ampersandBody = await ampersand.text();
        assert.match(ampersandBody, /<D:displayname>José García &amp; Co<\/D:displayname>/);

        // The same search on the user's principal URL (apply-to-principal-collection-set).
        const viaPrincipal = await fetch(`${BASE}/principals/bridge-user/`, { method: 'REPORT', body: calendarServerSearch(['jos']) });
        assert.equal(viaPrincipal.status, 207);
        assert.match(await viaPrincipal.text(), /jose@example.org/);

        // A contact's principal can be read on its own; an unknown token is 404.
        const contact = await fetch(`${BASE}/principals/contacts/${token}/`, {
            method: 'PROPFIND',
            headers: { Depth: '0' },
            body: '<?xml version="1.0"?><D:propfind xmlns:D="DAV:"><D:prop><D:displayname/><D:resourcetype/><D:nonsense/></D:prop></D:propfind>'
        });
        assert.equal(contact.status, 207);
        const contactBody = await contact.text();
        assert.match(contactBody, /<D:displayname>Anna Müller<\/D:displayname>/);
        assert.match(contactBody, /<D:principal\/>/);
        assert.match(contactBody, /<D:nonsense\/>[\s\S]*404 Not Found/);
        assert.doesNotMatch(contactBody, /first-name/);
        const unknown = await fetch(`${BASE}/principals/contacts/nope!/`, { method: 'PROPFIND' });
        assert.equal(unknown.status, 404);

        // Other reports on the collection are refused, not crashed on.
        const other = await fetch(`${BASE}/principals/`, { method: 'REPORT', body: '<D:sync-collection xmlns:D="DAV:"/>' });
        assert.equal(other.status, 403);
        assert.ok(searches >= 3);
    } finally {
        await server.stop();
    }
});

test('robustness: bad character references, mailto: equals, a huge search', async () => {
    assert.equal(parsePrincipalSearch(appleSearch('&#99999999;x'))?.searches[0].text, '�x');
    const resolve = parsePrincipalSearch(
        `<D:principal-property-search xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav"><D:property-search><D:prop><C:calendar-user-address-set/></D:prop><D:match match-type="equals">mailto:JOSE@example.org</D:match></D:property-search><D:prop><D:displayname/></D:prop></D:principal-property-search>`
    )!;
    assert.deepEqual(
        searchContacts(contacts, resolve).map((contact) => contact.email),
        ['jose@example.org']
    );
});

test('bridge service: the contact list is read once for concurrent searches, kept on failure, dropped at sign-out', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { fakeSafeStorage } = await import('./support/fake-safe-storage');
    const resolved = require.resolve('electron');
    require.cache[resolved] = {
        id: resolved,
        filename: resolved,
        loaded: true,
        exports: { app: { setLoginItemSettings: () => undefined }, safeStorage: fakeSafeStorage }
    } as unknown as NodeJS.Module;
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { BridgeService } = require('../src/main/bridge-service') as typeof import('../src/main/bridge-service');
    const baseDir = mkdtempSync(join(tmpdir(), 'neutron-calendar-bridge-contacts-'));
    const service = new BridgeService(baseDir) as any;
    try {
        let reads = 0;
        let release: () => void = () => undefined;
        let fail = false;
        service.accountAddresses = ['Me@proton.me'];
        service.protonAdapter = {
            isSignedIn: () => true,
            getSignedInUsername: () => 'me',
            async listContactEmails() {
                reads += 1;
                await new Promise<void>((resolve) => (release = resolve));
                if (fail) throw new Error('offline');
                return [
                    { email: 'me@proton.me', name: 'Me', contactId: 'c0' },
                    { email: 'Anna@example.org', name: 'Anna', contactId: 'c1' },
                    { email: 'anna@example.org', name: 'Anna again', contactId: 'c2' }
                ];
            }
        };
        // Two keystrokes before the list is there: both wait for the one read.
        const first = service.listContactsForSearch();
        const second = service.listContactsForSearch();
        await new Promise((resolve) => setTimeout(resolve, 10));
        release();
        const [a, b] = await Promise.all([first, second]);
        assert.equal(reads, 1);
        assert.deepEqual(a, [
            { email: 'Me@proton.me', name: 'me', self: true },
            { email: 'Anna@example.org', name: 'Anna', self: false }
        ]); // the own address once (first), duplicates by case once
        assert.deepEqual(b, a);
        assert.deepEqual(await service.listContactsForSearch(), a);
        assert.equal(reads, 1); // cached

        // A failed refresh keeps the last list.
        service.contacts.at -= 11 * 60_000;
        fail = true;
        const stale = await service.listContactsForSearch(); // served from the cache, refresh in the background
        assert.deepEqual(stale, a);
        await new Promise((resolve) => setTimeout(resolve, 10));
        release();
        await service.contactsRefresh;
        assert.equal(reads, 2);
        assert.deepEqual(await service.listContactsForSearch(), a);
        assert.equal(reads, 2); // not before the retry pause

        // A refresh still running at sign-out keeps nothing for the next account.
        service.contacts = null;
        fail = false;
        const during = service.listContactsForSearch();
        await new Promise((resolve) => setTimeout(resolve, 10));
        service.contacts = null;
        service.contactsRefresh = null;
        service.session += 1; // what signOut() does to the contacts
        release();
        await during;
        assert.equal(service.contacts, null);
    } finally {
        rmSync(baseDir, { recursive: true, force: true });
    }
});
