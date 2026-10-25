/**
 * Video links (0.34.1): the conference an event carries in Proton — `X-PM-CONFERENCE-ID` (signed
 * part; parameter `X-PM-PROVIDER`: 1 Zoom, 2 Proton Meet) and `X-PM-CONFERENCE-URL` (encrypted
 * part; parameters `X-PM-HOST`, `X-PM-PASSWORD` for Zoom) — read from and written to the vevent,
 * as ICS lines for a served event, and in the description block Proton Calendar's own forms add
 * ("Join Proton Meet: <url>" between Proton's separators, which its apps and invitation emails show).
 *
 * Creating a Proton Meet link is Proton's client-side recipe (packages/meet/utils/cryptoUtils.ts,
 * useSaveMeeting.ts): a random 12-character password that only ever travels in the URL fragment,
 * an AES-256 session key wrapped with a bcrypt hash of that password (so the server never learns
 * it), the meeting name AES-GCM-encrypted with a key derived from the session key, the password
 * PGP-encrypted to the user's primary key (so Proton's own apps can read the link back), and an SRP
 * verifier of the password for the room's door. See createProtonMeet in proton-calendar-api.ts.
 */
import type { VcalVeventComponent } from '@proton/shared/lib/interfaces/calendar';

export type VideoConferenceProvider = 1 | 2;
export const VIDEO_PROVIDER_ZOOM: VideoConferenceProvider = 1;
export const VIDEO_PROVIDER_PROTON_MEET: VideoConferenceProvider = 2;

export interface VideoConference {
    provider: VideoConferenceProvider;
    /** Zoom's meeting ID, Proton Meet's link name (the id-… part of the URL). */
    id: string;
    url: string;
    /** Zoom's passcode; Proton Meet carries its password in the URL fragment. */
    password?: string;
    /** The address that hosts the meeting (the calendar's address). */
    host?: string;
}

/** Proton's separator around the conference block in a description (videoConferencing/constants.ts). */
export const SEPARATOR_PROTON_EVENTS = '~-~-~-~-~-~-~%~!~%~!~%~!~%~!~%~!~%~!~%~!~%~!~%~!~%~!~%~!~%~!~%~!~-~-~-~-~-~-~';

export const PROTON_MEET_ORIGIN = 'https://meet.proton.me';

/** What a user types as the location to ask for a link (case and spaces do not matter). */
export const videoProviderOfLocation = (location: string | undefined): VideoConferenceProvider | null => {
    const key = (location || '').toLowerCase().replace(/[\s._-]+/g, '');
    if (key === 'protonmeet' || key === 'meet') {
        return VIDEO_PROVIDER_PROTON_MEET;
    }
    if (key === 'zoom' || key === 'zoommeeting') {
        return VIDEO_PROVIDER_ZOOM;
    }
    return null;
};

const stringOf = (property: unknown) => {
    const value = (property as { value?: unknown } | undefined)?.value;
    return typeof value === 'string' ? value : '';
};

const parametersOf = (property: unknown) => ((property as { parameters?: Record<string, unknown> } | undefined)?.parameters ?? {}) as Record<string, unknown>;

/** The conference of a vevent (Proton's x-pm-conference-* properties), if it has one. */
export const conferenceOf = (vevent: Partial<VcalVeventComponent> | undefined): VideoConference | undefined => {
    const idProperty = (vevent as any)?.['x-pm-conference-id'];
    const urlProperty = (vevent as any)?.['x-pm-conference-url'];
    const id = stringOf(idProperty);
    const url = stringOf(urlProperty);
    if (!id || !url) {
        return undefined;
    }
    const providerValue = Number(parametersOf(idProperty)['x-pm-provider']);
    const provider: VideoConferenceProvider = providerValue === VIDEO_PROVIDER_ZOOM ? VIDEO_PROVIDER_ZOOM : VIDEO_PROVIDER_PROTON_MEET;
    const urlParameters = parametersOf(urlProperty);
    const password = typeof urlParameters['x-pm-password'] === 'string' ? (urlParameters['x-pm-password'] as string) : undefined;
    const host = typeof urlParameters['x-pm-host'] === 'string' ? (urlParameters['x-pm-host'] as string) : undefined;
    return { provider, id, url, ...(password ? { password } : {}), ...(host ? { host } : {}) };
};

/** The vevent with this conference (or without any, for null); other properties untouched. */
export const withConference = <T extends Partial<VcalVeventComponent>>(vevent: T, conference: VideoConference | null | undefined): T => {
    if (conference === undefined) {
        return vevent;
    }
    const result: any = { ...vevent };
    delete result['x-pm-conference-id'];
    delete result['x-pm-conference-url'];
    if (conference) {
        result['x-pm-conference-id'] = { value: conference.id, parameters: { 'x-pm-provider': String(conference.provider) } };
        result['x-pm-conference-url'] = {
            value: conference.url,
            parameters: {
                ...(conference.password ? { 'x-pm-password': conference.password } : {}),
                ...(conference.host ? { 'x-pm-host': conference.host } : {})
            }
        };
    }
    return result as T;
};

const escapeParameter = (value: string) => `"${value.replace(/"/g, '')}"`;

/** The two ICS lines of a conference, for a served VEVENT (unfolded; the caller folds). */
export const conferenceLines = (conference: VideoConference | undefined): string[] =>
    conference
        ? [
              `X-PM-CONFERENCE-ID;X-PM-PROVIDER=${conference.provider}:${conference.id}`,
              `X-PM-CONFERENCE-URL${conference.password ? `;X-PM-PASSWORD=${escapeParameter(conference.password)}` : ''}${
                  conference.host ? `;X-PM-HOST=${escapeParameter(conference.host)}` : ''
              }:${conference.url}`
          ]
        : [];

/** A property parameter value as written in an ICS line (quoted or bare). */
const parameterIn = (parameters: string, name: string) => {
    const match = parameters.match(new RegExp(`;${name}=(?:"([^"]*)"|([^;:]*))`, 'i'));
    return match ? (match[1] ?? match[2] ?? '') : undefined;
};

/** The conference written in a VEVENT's ICS text (unfolded lines), if any. */
export const conferenceOfIcs = (vevent: string): VideoConference | undefined => {
    const unfolded = vevent.replace(/\r?\n[ \t]/g, '');
    const idLine = unfolded.match(/^X-PM-CONFERENCE-ID((?:;[^:\r\n]*)?):([^\r\n]*)$/im);
    const urlLine = unfolded.match(/^X-PM-CONFERENCE-URL((?:;[^:\r\n]*)?):([^\r\n]*)$/im);
    if (!idLine || !urlLine || !idLine[2].trim() || !urlLine[2].trim()) {
        return undefined;
    }
    const provider = Number(parameterIn(idLine[1], 'X-PM-PROVIDER')) === VIDEO_PROVIDER_ZOOM ? VIDEO_PROVIDER_ZOOM : VIDEO_PROVIDER_PROTON_MEET;
    const password = parameterIn(urlLine[1], 'X-PM-PASSWORD');
    const host = parameterIn(urlLine[1], 'X-PM-HOST');
    return { provider, id: idLine[2].trim(), url: urlLine[2].trim(), ...(password ? { password } : {}), ...(host ? { host } : {}) };
};

const conferenceBlockPattern = new RegExp(`\\n?${SEPARATOR_PROTON_EVENTS.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*?${SEPARATOR_PROTON_EVENTS.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'g');

/** The description without Proton's conference block (videoConfHelpers.removeVideoConfInfoFromDescription). */
export const descriptionWithoutConference = (description: string) => description.replace(conferenceBlockPattern, '');

/**
 * The description with Proton's conference block, as Proton Calendar's event form writes it
 * (videoConfHelpers.addVideoConfInfoToDescription); an older block is replaced.
 */
export const descriptionWithConference = (description: string, conference: VideoConference | undefined) => {
    const base = descriptionWithoutConference(description || '');
    if (!conference) {
        return base;
    }
    const block =
        conference.provider === VIDEO_PROVIDER_PROTON_MEET
            ? `\n${SEPARATOR_PROTON_EVENTS}\nJoin Proton Meet: ${conference.url}\n${SEPARATOR_PROTON_EVENTS}`
            : `\n${SEPARATOR_PROTON_EVENTS}\nJoin Zoom Meeting: ${conference.url} (ID: ${conference.id}${conference.password ? `, passcode: ${conference.password}` : ''})\n\n${
                  conference.host ? `Meeting host: ${conference.host}` : ''
              }\n${SEPARATOR_PROTON_EVENTS}`;
    return base ? `${base}${block}` : block;
};

/** Proton Meet's join link (packages/meet/utils/getMeetingLink.ts): /join/id-<link name>#pwd-<password>. */
export const protonMeetUrl = (linkName: string, password: string) => `${PROTON_MEET_ORIGIN}/join/id-${linkName}#pwd-${password}`;

/** The room (link name) and password of a Proton Meet join link (Proton's parseMeetingLink); null for anything else. */
export const parseProtonMeetUrl = (url: string): { linkName: string; password: string } | null => {
    const match = url.trim().match(/^https:\/\/meet(?:\.[\w-]+)?\.[\w.-]+\/join\/id-([A-Za-z0-9]{10})#pwd-([A-Za-z0-9]{12})$/);
    return match ? { linkName: match[1], password: match[2] } : null;
};

/** The two ICS lines that mean "the link was removed" (empty values; Proton stores none). */
export const conferenceRemovalLines = () => ['X-PM-CONFERENCE-ID:', 'X-PM-CONFERENCE-URL:'];

const RANDOM_CHARSET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

/** A random string from Proton's default charset (packages/utils/getRandomString.ts). */
export const randomString = (length: number) => {
    const values = crypto.getRandomValues(new Uint32Array(length));
    let result = '';
    for (let index = 0; index < length; index += 1) {
        result += RANDOM_CHARSET[values[index] % RANDOM_CHARSET.length];
    }
    return result;
};
