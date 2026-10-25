/**
 * 0.30: the configuration profile that adds the bridge's account to Calendar.app — a plist with one
 * com.apple.caldav.account payload, the values Calendar.app needs, stable identifiers, escaped text.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { PROFILE_FILE_NAME, buildCalDAVProfile, principalUrl, stableUuid } from '../src/main/caldav-profile';

const input = {
    accountName: 'Proton',
    profileName: 'Neutron Calendar Bridge',
    identifier: 'io.github.to-bi-s.neutron-calendar-bridge.calendar-app',
    organization: 'Neutron Calendar Bridge',
    description: 'Adds the account.',
    host: '127.0.0.1',
    port: 31876,
    username: 'neutron-calendar-bridge',
    password: 'p4ss<&>"word',
    principalPath: '/principals/neutron-calendar-bridge/'
};

/** The <key>…</key> followed by its value element, from the plist text. */
const valueOf = (plist: string, key: string) => {
    const match = plist.match(new RegExp(`<key>${key}</key>\\s*(<string>([^<]*)</string>|<integer>(\\d+)</integer>|<(true|false)/>)`));
    assert.ok(match, `${key} present`);
    return match[2] ?? match[3] ?? match[4];
};

test('a CalDAV account payload with the bridge values, no SSL, the principal as a full URL', () => {
    const plist = buildCalDAVProfile(input);
    assert.match(plist, /^<\?xml version="1\.0" encoding="UTF-8"\?>\n<!DOCTYPE plist/);
    assert.equal(valueOf(plist, 'PayloadType'), 'com.apple.caldav.account', 'the payload (the first PayloadType in the text)');
    assert.equal(valueOf(plist, 'CalDAVHostName'), '127.0.0.1');
    assert.equal(valueOf(plist, 'CalDAVPort'), '31876');
    assert.equal(valueOf(plist, 'CalDAVUseSSL'), 'false');
    assert.equal(valueOf(plist, 'CalDAVUsername'), 'neutron-calendar-bridge');
    assert.equal(valueOf(plist, 'CalDAVPassword'), 'p4ss&lt;&amp;&gt;&quot;word', 'the password escaped for XML');
    assert.equal(valueOf(plist, 'CalDAVPrincipalURL'), 'http://127.0.0.1:31876/principals/neutron-calendar-bridge/');
    assert.equal(valueOf(plist, 'CalDAVAccountDescription'), 'Proton', 'the name Calendar.app shows');
    assert.match(plist, /<key>PayloadDisplayName<\/key>\s*<string>Neutron Calendar Bridge<\/string>\s*<key>PayloadIdentifier<\/key>\s*<string>io\.github\.to-bi-s\.neutron-calendar-bridge\.calendar-app<\/string>/, 'the profile is named after the bridge in System Settings');
    assert.equal(valueOf(plist, 'PayloadScope'), 'User');
    assert.equal(valueOf(plist, 'PayloadRemovalDisallowed'), 'false', 'the user can remove it');
    assert.equal(plist.match(/<key>PayloadType<\/key>\s*<string>Configuration<\/string>/g)?.length, 1, 'the profile itself');
    assert.equal(plist.match(/<dict>/g)?.length, 2, 'one profile, one payload');
    assert.equal(plist.includes('p4ss<&>"word'), false, 'no raw special characters');
});

test('stable identifiers: the same bridge gives the same profile UUIDs (installing again replaces, not duplicates)', () => {
    const first = buildCalDAVProfile(input);
    const second = buildCalDAVProfile({ ...input, password: 'another' });
    assert.equal(valueOf(first, 'PayloadUUID'), valueOf(second, 'PayloadUUID'));
    assert.equal(valueOf(first, 'PayloadIdentifier'), 'io.github.to-bi-s.neutron-calendar-bridge.calendar-app.caldav', 'the payload identifier (first in the text)');
    assert.match(stableUuid('x'), /^[0-9A-F]{8}-[0-9A-F]{4}-5[0-9A-F]{3}-[89AB][0-9A-F]{3}-[0-9A-F]{12}$/, 'UUID shape, version 5');
    assert.notEqual(stableUuid('x'), stableUuid('y'));
    const uuids = first.match(/<key>PayloadUUID<\/key>\s*<string>([^<]*)<\/string>/g) || [];
    assert.equal(uuids.length, 2);
    assert.notEqual(uuids[0], uuids[1], 'profile and payload have different UUIDs');
});

test('refused without a port, a user name or a password; the file name', () => {
    assert.throws(() => buildCalDAVProfile({ ...input, port: 0 }), /not a port/);
    assert.throws(() => buildCalDAVProfile({ ...input, password: '' }), /not known yet/);
    assert.throws(() => buildCalDAVProfile({ ...input, username: '' }), /not known yet/);
    assert.equal(principalUrl('127.0.0.1', 1, '/principals/u/'), 'http://127.0.0.1:1/principals/u/');
    assert.equal(PROFILE_FILE_NAME, 'Neutron Calendar Bridge.mobileconfig');
});
