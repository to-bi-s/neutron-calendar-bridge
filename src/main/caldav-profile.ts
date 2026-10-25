import { createHash } from 'node:crypto';

/**
 * One-click Calendar.app setup (0.30): a macOS configuration profile with a CalDAV account payload
 * (`com.apple.caldav.account`) for the bridge — host 127.0.0.1, the port, no SSL, the local user
 * name and password, the principal URL. Opening the file hands it to System Settings, where the
 * user installs it; macOS then adds the account to Calendar.app (and removes it again when the
 * profile is removed). The profile is unsigned, so System Settings shows it as "not verified".
 *
 * Pure: no Electron, no file system (main.ts writes the file and opens it). The identifiers and
 * UUIDs are stable for one bridge (derived from the identifier), so installing the profile again
 * replaces the account instead of adding a second one.
 */
export interface CalDAVProfileInput {
    /** The account as Calendar.app lists it (its sidebar group). */
    accountName: string;
    /** The profile's name in System Settings. */
    profileName: string;
    /** Reverse-DNS identifier of the profile (stable); the payload gets `<identifier>.caldav`. */
    identifier: string;
    organization: string;
    description: string;
    host: string;
    port: number;
    username: string;
    password: string;
    /** `/principals/<username>/` */
    principalPath: string;
}

export const PROFILE_FILE_NAME = 'Neutron Calendar Bridge.mobileconfig';

/** A UUID (version 5 shape) derived from a name: the same name always gives the same UUID. */
export const stableUuid = (name: string): string => {
    const hash = createHash('sha1').update(`neutron-calendar-bridge:${name}`).digest();
    hash[6] = (hash[6] & 0x0f) | 0x50; // version 5
    hash[8] = (hash[8] & 0x3f) | 0x80; // variant
    const hex = hash.subarray(0, 16).toString('hex').toUpperCase();
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
};

const escapeXml = (value: string) =>
    value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const string = (key: string, value: string) => `\t\t\t<key>${escapeXml(key)}</key>\n\t\t\t<string>${escapeXml(value)}</string>`;
const integer = (key: string, value: number) => `\t\t\t<key>${escapeXml(key)}</key>\n\t\t\t<integer>${Math.trunc(value)}</integer>`;
const boolean = (key: string, value: boolean) => `\t\t\t<key>${escapeXml(key)}</key>\n\t\t\t<${value ? 'true' : 'false'}/>`;

/** The principal URL as Calendar.app expects it in a profile: a full URL. */
export const principalUrl = (host: string, port: number, principalPath: string) => `http://${host}:${port}${principalPath}`;

export const buildCalDAVProfile = (input: CalDAVProfileInput): string => {
    if (!Number.isInteger(input.port) || input.port < 1 || input.port > 65535) {
        throw new Error(`not a port: ${input.port}`);
    }
    if (!input.username || !input.password) {
        throw new Error('the CalDAV user name and password are not known yet');
    }
    const payloadIdentifier = `${input.identifier}.caldav`;
    const payload = [
        string('PayloadType', 'com.apple.caldav.account'),
        integer('PayloadVersion', 1),
        string('PayloadIdentifier', payloadIdentifier),
        string('PayloadUUID', stableUuid(payloadIdentifier)),
        string('PayloadDisplayName', `${input.accountName} (${input.profileName})`),
        string('PayloadDescription', `The "${input.accountName}" CalDAV account for Calendar.app, served by ${input.profileName}`),
        string('PayloadOrganization', input.organization),
        string('CalDAVAccountDescription', input.accountName),
        string('CalDAVHostName', input.host),
        integer('CalDAVPort', input.port),
        boolean('CalDAVUseSSL', false),
        string('CalDAVUsername', input.username),
        string('CalDAVPassword', input.password),
        string('CalDAVPrincipalURL', principalUrl(input.host, input.port, input.principalPath))
    ].join('\n');
    const top = (key: string, value: string) => `\t<key>${escapeXml(key)}</key>\n\t<string>${escapeXml(value)}</string>`;
    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>PayloadContent</key>
\t<array>
\t\t<dict>
${payload}
\t\t</dict>
\t</array>
${top('PayloadDescription', input.description)}
${top('PayloadDisplayName', input.profileName)}
${top('PayloadIdentifier', input.identifier)}
${top('PayloadOrganization', input.organization)}
\t<key>PayloadRemovalDisallowed</key>
\t<false/>
${top('PayloadScope', 'User')}
${top('PayloadType', 'Configuration')}
${top('PayloadUUID', stableUuid(input.identifier))}
\t<key>PayloadVersion</key>
\t<integer>1</integer>
</dict>
</plist>
`;
};
