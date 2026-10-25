/**
 * Offline test for meetings you organize (invitations, stage 3a: single events).
 *
 * The Proton API is faked (calendars, canonical addresses, keys, mail settings, the events/sync
 * route and the mail "direct send"); everything that encrypts, builds the ICS and decides what
 * is sent is Proton's own code. Checks:
 * - the email policy (test / dry-run / live) stops everything before Proton changes;
 * - a new meeting: Proton's order (event without guests, invitation, then the guest list); the
 *   Proton guest decrypts the invitation with their own key and gets the event's key
 *   (AddedProtonAttendees); the ICS carries X-PM-SHARED-EVENT-ID / X-PM-SESSION-KEY;
 * - changes: time (update to everyone, answers reset), added guest (invitation to them only),
 *   removed guest (cancellation to them only), role only (no email);
 * - refusals: unknown Proton address, same person twice, someone else's meeting, recurring,
 *   shared calendar; rollback when the invitation cannot be sent;
 * - a change emailed but not saved ('incomplete') is finished by a retry without a second email;
 * - deleting: cancellation (SEQUENCE + 1) to all guests, or none with "don't notify".
 * No network, no real account, no emails.
 */
import { CryptoProxy } from '@protontech/crypto';
import { loadCryptoWorker } from '@proton/shared/lib/helpers/setupCryptoWorker';
import { readInvitation } from '../src/invitations.ts';
import { ProtonCalendarAPI } from '../src/proton-calendar-api.ts';
import { RateLimitedError } from '../src/request-control.ts';

let failures = 0;
const check = (condition: unknown, label: string) => {
    console.log(`${condition ? 'ok  ' : 'FAIL'} ${label}`);
    if (!condition) failures += 1;
};

const TOBI = 'tobi@proton.test';
const ANNA = 'anna@proton.test'; // a Proton guest
const CARLA = 'carla@example.org'; // a non-Proton guest
const DAN = 'dan@example.org';
const GHOST = 'ghost@proton.test'; // a Proton address that does not exist
const NOE2EE = 'noe2ee@proton.test'; // a Proton guest whose account has E2EE for mail switched off (external forwarding)

const VTIMEZONE = [
    'BEGIN:VTIMEZONE', 'TZID:Europe/Amsterdam',
    'BEGIN:DAYLIGHT', 'TZOFFSETFROM:+0100', 'TZOFFSETTO:+0200', 'TZNAME:CEST', 'DTSTART:19700329T020000',
    'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU', 'END:DAYLIGHT',
    'BEGIN:STANDARD', 'TZOFFSETFROM:+0200', 'TZOFFSETTO:+0100', 'TZNAME:CET', 'DTSTART:19701025T030000',
    'RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU', 'END:STANDARD',
    'END:VTIMEZONE'
].join('\r\n');

/** What Calendar.app PUTs for a meeting: itself as CHAIR among the guests. */
const calendarAppIcs = ({
    uid = 'CA1F9E2B-7D3C-4C1A-9B57-3E2E0D7F1A11',
    start = '20261005T100000',
    end = '20261005T110000',
    summary = 'Project kickoff',
    guests = [ANNA, CARLA],
    organizer = TOBI,
    rrule,
    roles = {} as Record<string, string>
}: { uid?: string; start?: string; end?: string; summary?: string; guests?: string[]; organizer?: string | null; rrule?: string; roles?: Record<string, string> } = {}) =>
    [
        'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Apple Inc.//macOS 26.0//EN',
        'BEGIN:VEVENT', `UID:${uid}`, 'DTSTAMP:20261001T080000Z',
        `DTSTART;TZID=Europe/Amsterdam:${start}`, `DTEND;TZID=Europe/Amsterdam:${end}`,
        rrule ? `RRULE:${rrule}` : '',
        `SUMMARY:${summary}`, 'LOCATION:Room 2', 'SEQUENCE:0', 'TRANSP:OPAQUE', 'X-APPLE-TRAVEL-ADVISORY-BEHAVIOR:AUTOMATIC',
        organizer ? `ORGANIZER;CN=Tobi:mailto:${organizer}` : '',
        organizer ? `ATTENDEE;CN=Tobi;CUTYPE=INDIVIDUAL;PARTSTAT=ACCEPTED;ROLE=CHAIR:mailto:${organizer}` : '',
        ...guests.map(
            (guest) => `ATTENDEE;CN=${guest.split('@')[0]};CUTYPE=INDIVIDUAL;EMAIL=${guest};PARTSTAT=NEEDS-ACTION;ROLE=${roles[guest] || 'REQ-PARTICIPANT'};RSVP=TRUE:mailto:${guest}`
        ),
        'BEGIN:VALARM', 'ACTION:DISPLAY', 'TRIGGER:-PT15M', 'DESCRIPTION:Reminder', 'END:VALARM',
        'END:VEVENT', 'END:VCALENDAR', ''
    ].filter(Boolean).join('\r\n');

const bytesIndexOf = (haystack: Uint8Array, needle: Uint8Array) => {
    outer: for (let i = 0; i + needle.length <= haystack.length; i += 1) {
        for (let j = 0; j < needle.length; j += 1) {
            if (haystack[i + j] !== needle[j]) continue outer;
        }
        return i;
    }
    return -1;
};

const main = async () => {
    await loadCryptoWorker();
    const gen = async (name: string, email: string) => {
        const privateKey = await CryptoProxy.generateKey({ userIDs: [{ name, email }] });
        const armoredPublicKey = await CryptoProxy.exportPublicKey({ key: privateKey });
        const publicKey = await CryptoProxy.importPublicKey({ armoredKey: armoredPublicKey });
        return { privateKey, publicKey, armoredPublicKey };
    };
    const userKey = await gen('user', 'user@proton.test');
    const tobiKey = await gen('tobi', TOBI);
    const annaKey = await gen('anna', ANNA);
    const noE2eeKey = await gen('noe2ee', NOE2EE);
    const keysAllRequests: Array<{ email: string; internalOnly: string | undefined }> = [];
    const calendarKey = await gen('calendar', 'calendar@proton.test');
    const tobiAddressKeys = [{ ID: 'tobi-key', Flags: 3, Primary: 1, privateKey: tobiKey.privateKey, publicKey: tobiKey.publicKey }];
    const calendarKeys = [{ ID: 'cal-key', privateKey: calendarKey.privateKey, publicKey: calendarKey.publicKey, Key: { ID: 'cal-key', Flags: 3, PassphraseID: 'p' } }];
    const calendarData = { calendarID: 'cal-1', memberID: 'member-1', calendarKeys, calendarSettings: {} };
    const tobiAddress = { ID: 'addr-tobi', Email: TOBI, DisplayName: 'Tobi S', Status: 1, Receive: 1, Send: 1, Type: 1, Order: 1, Keys: [], SignedKeyList: null };
    const aliasAddress = { ...tobiAddress, ID: 'addr-alias', Email: 'tobi.alias@proton.test', DisplayName: 'Tobi', Order: 2 };

    // ---- Fake Proton ----
    type Request = { method: string; endpoint: string; body?: any; query?: any };
    const requests: Request[] = [];
    const sent: any[] = [];
    const events = new Map<string, any>();
    let eventCounter = 0;
    let attendeeCounter = 0;
    let calendarOwner = TOBI;
    let failSyncUpdates = 0;
    let failSends = 0;
    let networkFailSends = 0;
    /** 0.41: the connection is refused (the request never left). */
    let refusedConnectionSends = 0;
    let slowDownSends = 0;
    /** 0.41: Proton asks to slow down at the send after this many went out (once). */
    let slowDownAfterSent = -1;
    let networkFailKeys = 0;
    const mailSettings: any = { Sign: 0, PGPScheme: 16, DraftMIMEType: 'text/html', AttachPublicKey: 0, AutoSaveContacts: 1, RecipientLimit: 100 };
    const respond = (data: any, status = 200) => ({ status, data: { Code: 1000, ...data } });
    const uidOf = (cards: any[]) => {
        const signed = (cards || []).find((card: any) => card.Type === 2);
        return signed ? (String(signed.Data).match(/^UID:(.+)$/m)?.[1] || '').trim() : '';
    };
    const toStored = (event: any, payload: any) => {
        if (payload.SharedKeyPacket) event.SharedKeyPacket = payload.SharedKeyPacket;
        if (payload.CalendarKeyPacket) event.CalendarKeyPacket = payload.CalendarKeyPacket;
        if (payload.SharedEventContent) event.SharedEvents = payload.SharedEventContent;
        if (payload.CalendarEventContent) event.CalendarEvents = payload.CalendarEventContent;
        event.AttendeesEvents = payload.AttendeesEventContent || [];
        const previous = event.AttendeesInfo?.Attendees || [];
        event.AttendeesInfo = {
            Attendees: (payload.Attendees || []).map(({ Token, Status }: any) => ({
                ID: previous.find((entry: any) => entry.Token === Token)?.ID || `att-${(attendeeCounter += 1)}`,
                Token,
                Status
            })),
            MoreAttendees: 0
        };
        event.Notifications = payload.Notifications;
        event.UID = uidOf(event.SharedEvents) || event.UID;
        return event;
    };
    const route = (method: string, endpoint: string, body: any, query: any) => {
        requests.push({ method, endpoint, body, query });
        let match: RegExpMatchArray | null;
        if (method === 'GET' && endpoint === 'calendar/v1') {
            return respond({
                Calendars: [{ ID: 'cal-1', Type: 0, Owner: { Email: calendarOwner }, Members: [{ ID: 'member-1', AddressID: tobiAddress.ID, Email: TOBI, Permissions: calendarOwner === TOBI ? 127 : 112 }] }]
            });
        }
        if (method === 'GET' && endpoint.startsWith('core/v4/addresses/canonical?')) {
            const emails = [...endpoint.matchAll(/Emails\[\]=([^&]+)/g)].map((entry) => decodeURIComponent(entry[1]));
            return respond({
                Responses: emails.map((Email) => ({
                    Email,
                    // Gmail-style: dots do not count.
                    Response: { Code: 1000, CanonicalEmail: Email.toLowerCase().replace(/\.(?=[^@]*@gmail\.test$)/g, '') }
                }))
            });
        }
        if (method === 'GET' && endpoint === 'mail/v4/settings') return respond({ MailSettings: mailSettings });
        if (method === 'GET' && endpoint === 'core/v4/keys/all') {
            keysAllRequests.push({ email: query?.Email, internalOnly: query?.InternalOnly });
            if (query?.Email === NOE2EE) {
                // Flags 7 = not compromised | not obsolete | email no encrypt: Proton's key server answers like this
                // for an account with E2EE for mail off; ProtonMX says it is a Proton address all the same.
                return respond({ Address: { Keys: [{ PublicKey: noE2eeKey.armoredPublicKey, Flags: 7, Source: 0, Primary: 1 }], SignedKeyList: null }, Unverified: null, ProtonMX: true, Warnings: [] });
            }
            if (query?.Email === ANNA) {
                return respond({ Address: { Keys: [{ PublicKey: annaKey.armoredPublicKey, Flags: 3, Source: 0, Primary: 1 }], SignedKeyList: null }, Unverified: null, ProtonMX: true, Warnings: [] });
            }
            if (query?.Email === GHOST) {
                return { status: 422, data: { Code: 33102, Error: 'This address does not exist. Please try again' } };
            }
            return respond({ Address: { Keys: [], SignedKeyList: null }, Unverified: null, ProtonMX: false, Warnings: [] });
        }
        if (method === 'GET' && endpoint === 'contacts/v4/contacts/emails') return respond({ ContactEmails: [] });
        if (method === 'GET' && endpoint.startsWith('calendar/v1/vtimezones')) return respond({ Timezones: { 'Europe/Amsterdam': VTIMEZONE } });
        if (method === 'GET' && endpoint === 'calendar/v1/cal-1/events' && query?.UID) {
            return respond({ Events: [...events.values()].filter((event) => event.UID === query.UID).map((event) => structuredClone(event)) });
        }
        if (method === 'GET' && (match = endpoint.match(/^calendar\/v1\/cal-1\/events\/([^/]+)$/))) {
            const event = events.get(match[1]);
            return event ? respond({ Event: structuredClone(event) }) : { status: 404, data: { Code: 2501, Error: 'Event does not exist' } };
        }
        if (method === 'PUT' && endpoint === 'calendar/v1/cal-1/events/sync') {
            const responses = body.Events.map((operation: any) => {
                if (operation.DeletionReason !== undefined) {
                    events.delete(operation.ID);
                    return { Response: { Code: 1000 } };
                }
                if (operation.ID) {
                    if (failSyncUpdates > 0) {
                        failSyncUpdates -= 1;
                        return { Response: { Code: 2001, Error: 'Temporary failure' } };
                    }
                    const event = events.get(operation.ID);
                    toStored(event, operation.Event);
                    event.ModifyTime = (event.ModifyTime || 0) + 1;
                    return { Response: { Code: 1000, Event: structuredClone(event) } };
                }
                const id = `ev-${(eventCounter += 1)}`;
                const event = toStored(
                    { ID: id, CalendarID: 'cal-1', SharedEventID: `shared-${id}`, FullDay: 0, Color: null, IsOrganizer: 1, IsProtonProtonInvite: 0, IsPersonalSingleEdit: false, AddressID: null, AddressKeyPacket: null, RecurrenceID: null },
                    operation.Event
                );
                events.set(id, event);
                return { Response: { Code: 1000, Event: structuredClone(event) } };
            });
            // Like Proton: each answer carries its operation's Index; deletions get no answer.
            return {
                status: 200,
                data: {
                    Code: 1001,
                    Responses: responses
                        .map((entry: any, Index: number) => ({ Index, ...entry }))
                        .filter((_: any, index: number) => body.Events[index].DeletionReason === undefined)
                }
            };
        }
        if (method === 'POST' && endpoint === 'mail/v4/messages/send/direct') {
            if (failSends > 0) {
                failSends -= 1;
                return { status: 422, data: { Code: 2500, Error: 'Sending failed' } };
            }
            sent.push(body);
            return respond({ Sent: { ID: `msg-${sent.length}` } });
        }
        return { status: 404, data: { Code: 404, Error: `unexpected ${method} ${endpoint}` } };
    };

    const api: any = new ProtonCalendarAPI({ username: 'u', password: 'p' });
    api.session = { UID: 'session' };
    api.userData = {
        addresses: [tobiAddress, aliasAddress],
        addressKeys: tobiAddressKeys,
        addressKeysByAddressID: { [tobiAddress.ID]: tobiAddressKeys, [aliasAddress.ID]: tobiAddressKeys },
        userKeys: [{ ID: 'user-key', privateKey: userKey.privateKey, publicKey: userKey.publicKey }]
    };
    api.resolveCalendarData = async () => calendarData;
    api.makeCalendarRequest = async (endpoint: string, method: string, body: any, query: any) => route(method, endpoint, body, query);
    api.makeApiRequest = async (endpoint: string, method: string, body: any, query: any) => {
        // Proton asked to slow down for longer than the library waits inline.
        if (endpoint === 'mail/v4/messages/send/direct' && slowDownAfterSent >= 0 && sent.length === slowDownAfterSent) {
            slowDownAfterSent = -1;
            requests.push({ method, endpoint, body, query });
            throw new RateLimitedError('Proton asked to slow down until 12:00.', Date.now() + 60_000);
        }
        if (endpoint === 'mail/v4/messages/send/direct' && slowDownSends > 0) {
            slowDownSends -= 1;
            requests.push({ method, endpoint, body, query });
            throw new RateLimitedError('Proton asked to slow down until 12:00.', 1_900_000_000_000);
        }
        if (endpoint === 'mail/v4/messages/send/direct' && refusedConnectionSends > 0) {
            refusedConnectionSends -= 1;
            throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
        }
        // A dropped connection: no answer from Proton at all.
        if (endpoint === 'mail/v4/messages/send/direct' && networkFailSends > 0) {
            networkFailSends -= 1;
            requests.push({ method, endpoint, body, query });
            throw new TypeError('fetch failed');
        }
        if (endpoint === 'core/v4/keys/all' && networkFailKeys > 0) {
            networkFailKeys -= 1;
            throw new TypeError('fetch failed');
        }
        return route(method, endpoint, body, query);
    };
    const logged: any[] = [];
    api.configureInvitations({ prodId: '-//Neutron Calendar Bridge//EN', onEmail: (record: any) => logged.push(record) });

    const writes = () => requests.filter((request) => request.method !== 'GET');
    const reset = () => { requests.length = 0; sent.length = 0; logged.length = 0; };
    const veventOf = (ics: string) => api.parseIcsToVevents(ics)[0];
    const save = (ics: string, eventID?: string) => api.saveOrganizedEvent({ calendarID: 'cal-1', eventID, vevent: veventOf(ics) });
    const step = (request: Request) => {
        if (request.endpoint.endsWith('send/direct')) return 'email';
        if (request.endpoint.endsWith('events/sync')) {
            const [operation] = request.body.Events;
            if (operation.DeletionReason !== undefined) return 'delete';
            return operation.ID ? 'update' : 'create';
        }
        return request.endpoint;
    };
    const decrypted = async (id: string) => {
        const event = events.get(id);
        return readInvitation(api.getInvitationContext(), structuredClone(event));
    };
    const sessionKeyOf = async (id: string) => {
        const key: any = await CryptoProxy.decryptSessionKey({
            binaryMessage: Uint8Array.fromBase64(events.get(id).SharedKeyPacket),
            decryptionKeys: calendarKey.privateKey
        });
        return (key.data).toBase64();
    };

    /** Decrypt the ICS of a direct-send payload for one recipient (own key, or the clear session key). */
    const openEmail = async (payload: any, recipient: string, decryptionKey?: any) => {
        const pack = payload.Packages.find((candidate: any) => candidate.Addresses[recipient]);
        const address = pack.Addresses[recipient];
        const contents = Uint8Array.fromBase64(payload.Message.Attachments[0].Contents);
        const keyPackets = Uint8Array.fromBase64(payload.AttachmentKeys);
        const at = bytesIndexOf(contents, keyPackets);
        const dataPart = contents.slice(0, at);
        const signature = contents.slice(at + keyPackets.length);
        let sessionKey: any;
        if (decryptionKey) {
            sessionKey = await CryptoProxy.decryptSessionKey({
                binaryMessage: Uint8Array.fromBase64(address.AttachmentKeyPackets[0]),
                decryptionKeys: decryptionKey
            });
        } else {
            const [{ Key, Algorithm }] = pack.AttachmentKeys;
            sessionKey = { data: Uint8Array.fromBase64(Key), algorithm: Algorithm };
        }
        const { data: ics, verificationStatus } = await CryptoProxy.decryptMessage({
            binaryMessage: dataPart,
            sessionKeys: sessionKey,
            binarySignature: signature.length ? signature : undefined,
            verificationKeys: tobiKey.publicKey
        } as any);
        return { ics: String(ics).replace(/\r?\n[ \t]/g, ''), verified: (verificationStatus as unknown) === 1, pack, address };
    };
    /** The plain-text body, via a cleartext recipient's package (its session key is sent in the clear). */
    const bodyOf = async (payload: any) => {
        const pack = payload.Packages.find((candidate: any) => candidate.BodyKey);
        if (!pack) return '';
        const { data } = await CryptoProxy.decryptMessage({
            binaryMessage: Uint8Array.fromBase64(pack.Body),
            sessionKeys: { data: Uint8Array.fromBase64(pack.BodyKey.Key), algorithm: pack.BodyKey.Algorithm }
        } as any);
        return String(data);
    };
    const recipientsOf = (payload: any) => payload.Message.ToList.map(({ Address }: any) => Address).sort();

    // ======================================================================================
    // 1. Policy: nothing is created unless every guest may be emailed.
    // ======================================================================================
    reset();
    api.configureInvitations({ policy: { mode: 'test', allowlist: [ANNA] } });
    const blocked = await save(calendarAppIcs());
    check(!blocked.success && blocked.reason === 'blocked' && /carla@example\.org/.test(blocked.error), `test mode: a guest not on the allowlist refuses the meeting (${blocked.error})`);
    check(writes().length === 0 && events.size === 0, 'test mode: nothing created in Proton');
    check(logged.length === 1 && logged[0].outcome === 'blocked' && logged[0].kind === 'invitation', 'test mode: the blocked invitation is reported');

    reset();
    api.configureInvitations({ policy: { mode: 'dry-run', allowlist: [] } });
    const dry = await save(calendarAppIcs());
    check(!dry.success && dry.reason === 'dry-run' && writes().length === 0 && events.size === 0, `dry run: nothing created or sent (${dry.error})`);
    const preview = dry.emails[0]?.preview?.ics || '';
    check(/METHOD:REQUEST/.test(preview) && /ATTENDEE[^\n]*anna@proton\.test/.test(preview) && /ATTENDEE[^\n]*carla@example\.org/.test(preview),
        'dry run: the would-be invitation lists both guests');
    check(!/ATTENDEE[^\n]*mailto:tobi@proton\.test/.test(preview.replace(/\r?\n[ \t]/g, '')), 'your own CHAIR entry from Calendar.app is not a guest');
    check(dry.emails[0]?.to?.map((entry: any) => `${entry.email}:${entry.delivery}`).sort().join(',') === 'anna@proton.test:proton,carla@example.org:plain',
        `dry run: Anna end-to-end, Carla normal email (${dry.emails[0]?.to?.map((entry: any) => entry.delivery)})`);

    // ======================================================================================
    // 2. A new meeting.
    // ======================================================================================
    reset();
    api.configureInvitations({ policy: { mode: 'test', allowlist: [ANNA, ' Carla@Example.org ', DAN] } });
    const created = await save(calendarAppIcs());
    check(created.success, `creating a meeting works (${created.error || 'ok'}; ${created.warnings.join('; ')})`);
    const order = writes().map(step);
    check(order.join(' | ') === 'create | email | update', `Proton's order: event without guests, invitation, guest list (${order.join(' | ')})`);
    const intermediate = writes()[0].body.Events[0].Event;
    check(!intermediate.Attendees?.length && !intermediate.AttendeesEventContent, 'the first save has no guests');
    const id = created.eventId;
    check(id && events.has(id) && created.changedEventIds[0] === id, `the event ID is reported (${id})`);
    check(/@proton\.me$/.test(created.protonUid) && events.get(id).UID === created.protonUid && created.protonUid !== 'CA1F9E2B-7D3C-4C1A-9B57-3E2E0D7F1A11',
        `a new Proton UID, not Calendar.app's (${created.protonUid})`);
    check(sent.length === 1 && recipientsOf(sent[0]).join(',') === `${ANNA},${CARLA}`, 'one invitation to both guests');
    check(sent[0].Message.Sender.Address === TOBI && sent[0].Message.Sender.Name === 'Tobi S', 'sent from your calendar address');
    check(/^Invitation for an event starting on /.test(sent[0].Message.Subject), `Proton's subject (${sent[0].Message.Subject})`);
    const inviteBody = await bodyOf(sent[0]);
    check(/^You are invited to Project kickoff/.test(inviteBody), `Proton's body (${JSON.stringify(inviteBody.slice(0, 60))})`);
    check(sent[0].AutoSaveContacts === 1, 'guests saved as contacts per your mail setting (like Proton)');
    const annaInvite = await openEmail(sent[0], ANNA, annaKey.privateKey);
    check(annaInvite.address.Type === 1 && annaInvite.verified, 'Anna (Proton) decrypts the invitation with her own key; signed by you');
    check(/METHOD:REQUEST/.test(annaInvite.ics) && /ORGANIZER;CN=Tobi S:mailto:tobi@proton\.test/.test(annaInvite.ics), 'METHOD:REQUEST, you are the organizer');
    check(/X-PM-SHARED-EVENT-ID:shared-ev-1/.test(annaInvite.ics), 'carries the shared event ID Proton assigned');
    const sessionKey = await sessionKeyOf(id);
    check(annaInvite.ics.includes(`X-PM-SESSION-KEY:${sessionKey}`), "carries the event's shared session key");
    check(/SEQUENCE:0/.test(annaInvite.ics) && /SUMMARY:Project kickoff/.test(annaInvite.ics) && /BEGIN:VTIMEZONE/.test(annaInvite.ics), 'SEQUENCE 0, summary, VTIMEZONE');
    check(!/BEGIN:VALARM/.test(annaInvite.ics) && !/X-APPLE/.test(annaInvite.ics), 'no alarms or Apple properties in the invitation');
    const carlaInvite = await openEmail(sent[0], CARLA);
    check(carlaInvite.address.Type === 4 && !carlaInvite.address.BodyKeyPacket && /METHOD:REQUEST/.test(carlaInvite.ics), `Carla gets it as normal email (type ${carlaInvite.address.Type})`);
    const guestList = writes()[2].body.Events[0].Event;
    check(guestList.Attendees?.length === 2 && guestList.Attendees.every((entry: any) => entry.Status === 0), 'the guest list is saved, everyone "needs action"');
    const added = guestList.AddedProtonAttendees || [];
    check(added.length === 1 && added[0].Email === ANNA, 'Anna (Proton) is given the event key (AddedProtonAttendees)');
    const annaSessionKey: any = await CryptoProxy.decryptSessionKey({ binaryMessage: Uint8Array.fromBase64(added[0].AddressKeyPacket), decryptionKeys: annaKey.privateKey });
    check((annaSessionKey.data).toBase64() === sessionKey, "Anna's key packet opens the event's shared session key");
    check(guestList.Permissions === 1 && guestList.IsOrganizer === 1, 'guests may only see (Proton default), saved as organizer');
    const stored = await decrypted(id);
    check(stored.isOrganizer && stored.vevent.attendee?.length === 2 && stored.vevent.location?.value === 'Room 2', 'Proton reads it back: you organize it, two guests, location kept');
    check(stored.vevent.attendee.every((attendee: any) => attendee.parameters.cn === attendee.value.replace('mailto:', '')), 'guests stored like Proton does (CN = email)');
    check(logged.some((record) => record.outcome === 'sent' && record.method === 'REQUEST' && record.kind === 'invitation'), 'invitation reported to the listener');

    // ======================================================================================
    // 3. Changes.
    // ======================================================================================
    const annaToken = events.get(id).AttendeesInfo.Attendees[0].Token;
    const setAnswer = (status: number, token = annaToken) => {
        events.get(id).AttendeesInfo.Attendees.find((entry: any) => entry.Token === token).Status = status;
    };
    setAnswer(3); // Anna accepted

    reset();
    const unchangedRole = await save(calendarAppIcs({ guests: [ANNA, CARLA], roles: { [CARLA]: 'OPT-PARTICIPANT' } }), id);
    check(unchangedRole.success && sent.length === 0 && writes().map(step).join() === 'update', `role only: saved without emails (${unchangedRole.error || 'ok'})`);
    check(events.get(id).AttendeesInfo.Attendees.find((entry: any) => entry.Token === annaToken).Status === 3, "Anna's answer kept");
    const optional = (await decrypted(id)).vevent.attendee.find((attendee: any) => /carla/.test(attendee.value));
    check(optional?.parameters.role === 'OPT-PARTICIPANT', 'Carla is now optional');

    // 0.49.7/0.49.12: "Show time as free" goes along; a Tentative status cannot (Proton's API refuses it) and is saved as confirmed. No emails: Proton's invite data unchanged.
    reset();
    const freeTentative = await save(calendarAppIcs({ guests: [ANNA, CARLA], roles: { [CARLA]: 'OPT-PARTICIPANT' } }).replace('TRANSP:OPAQUE', 'TRANSP:TRANSPARENT\r\nSTATUS:TENTATIVE'), id);
    check(freeTentative.success && sent.length === 0, `free + tentative: saved without emails (${freeTentative.error || 'ok'})`);
    const freeStored = (await decrypted(id)).vevent;
    check(freeStored.transp?.value === 'TRANSPARENT' && freeStored.status?.value === 'CONFIRMED', `Proton reads back free; tentative is stored as confirmed, Proton has no other (${freeStored.transp?.value}, ${freeStored.status?.value})`);
    reset();
    const busyAgain = await save(calendarAppIcs({ guests: [ANNA, CARLA], roles: { [CARLA]: 'OPT-PARTICIPANT' } }), id);
    const busyStored = (await decrypted(id)).vevent;
    check(busyAgain.success && !busyStored.transp && busyStored.status?.value === 'CONFIRMED', `busy + confirmed again: TRANSP gone, status back (${busyStored.transp?.value}, ${busyStored.status?.value})`);

    reset();
    const addDan = await save(calendarAppIcs({ guests: [ANNA, CARLA, DAN], roles: { [CARLA]: 'OPT-PARTICIPANT' } }), id);
    check(addDan.success && writes().map(step).join(' | ') === 'email | update', `adding a guest: email, then save (${addDan.error || writes().map(step).join(' | ')})`);
    check(sent.length === 1 && recipientsOf(sent[0]).join() === DAN && /^Invitation for/.test(sent[0].Message.Subject), 'only Dan gets an invitation');
    const danIcs = (await openEmail(sent[0], DAN)).ics;
    check(/ATTENDEE[^\n]*anna@proton\.test/.test(danIcs) && /ATTENDEE[^\n]*dan@example\.org/.test(danIcs), "Dan's invitation lists all guests");
    check(events.get(id).AttendeesInfo.Attendees.length === 3 && events.get(id).AttendeesInfo.Attendees.find((entry: any) => entry.Token === annaToken).Status === 3,
        "Dan added; Anna's answer kept (no time change)");
    check(!writes()[1].body.Events[0].Event.AddedProtonAttendees?.length, 'no key packet for a non-Proton guest');

    reset();
    const moved = await save(calendarAppIcs({ start: '20261005T140000', end: '20261005T150000', guests: [ANNA, CARLA, DAN], roles: { [CARLA]: 'OPT-PARTICIPANT' } }), id);
    check(moved.success && writes().map(step).join(' | ') === 'email | update', `moving the meeting works (${moved.error || 'ok'})`);
    check(sent.length === 1 && recipientsOf(sent[0]).join(',') === `${ANNA},${CARLA},${DAN}` && /^Update for an event starting on /.test(sent[0].Message.Subject),
        `everyone gets an update (${sent[0]?.Message.Subject})`);
    const movedIcs = (await openEmail(sent[0], ANNA, annaKey.privateKey)).ics;
    check(/SEQUENCE:1/.test(movedIcs) && /DTSTART;TZID=Europe\/Amsterdam:20261005T140000/.test(movedIcs), 'SEQUENCE 1, new time');
    check(/PARTSTAT=NEEDS-ACTION[^\n]*anna|anna[^\n]*PARTSTAT=NEEDS-ACTION/i.test(movedIcs) || !/PARTSTAT=ACCEPTED/.test(movedIcs), 'answers reset in the update');
    check(events.get(id).AttendeesInfo.Attendees.every((entry: any) => entry.Status === 0), 'answers reset in Proton (time changed)');
    const updateBody = await bodyOf(sent[0]);
    check(/updated|changed/i.test(updateBody) && /TIME:/.test(updateBody), `body describes the update (${JSON.stringify(updateBody.slice(0, 80))})`);

    reset();
    const removeCarla = await save(calendarAppIcs({ start: '20261005T140000', end: '20261005T150000', guests: [ANNA, DAN] }), id);
    check(removeCarla.success && sent.length === 1 && recipientsOf(sent[0]).join() === CARLA, `removing Carla: only she is emailed (${removeCarla.error || recipientsOf(sent[0] || { Message: { ToList: [] } })})`);
    const cancelIcs = (await openEmail(sent[0], CARLA)).ics;
    check(/METHOD:CANCEL/.test(cancelIcs) && /ATTENDEE:mailto:carla@example\.org/.test(cancelIcs) && !/anna@proton\.test/.test(cancelIcs.replace(/ORGANIZER[^\n]*/, '')),
        'a cancellation addressed to Carla only');
    check(/^Cancellation of an event starting on /.test(sent[0].Message.Subject), 'cancellation subject');
    check(JSON.stringify(writes().find((request) => step(request) === 'update')?.body.Events[0].Event.RemovedAttendeeAddresses) === JSON.stringify([CARLA]),
        'Proton is told Carla was removed');
    check(events.get(id).AttendeesInfo.Attendees.length === 2, 'two guests left');

    // ======================================================================================
    // 4. Refusals.
    // ======================================================================================
    reset();
    api.configureInvitations({ policy: { mode: 'live', allowlist: [] } });
    const ghost = await save(calendarAppIcs({ start: '20261005T140000', end: '20261005T150000', guests: [ANNA, DAN, GHOST] }), id);
    check(!ghost.success && ghost.reason === 'unsupported' && /ghost@proton\.test/.test(ghost.error) && writes().length === 0,
        `a new guest Proton cannot email refuses the change (${ghost.error})`);

    // A Proton guest with E2EE for mail off: emailed like an outside guest (plain email), but still
    // given the event key with their internal address key, so the event is in their calendar
    // (Proton's inviteActions.getAddedAttendeesPublicKeysMap since 2026).
    reset();
    keysAllRequests.length = 0;
    const noE2ee = await save(calendarAppIcs({ guests: [NOE2EE], uid: 'noe2ee' }));
    check(noE2ee.success && sent.length === 1 && recipientsOf(sent[0]).join() === NOE2EE, `a Proton guest without mail E2EE is invited (${noE2ee.error || 'ok'})`);
    check(sent[0]?.Packages?.every((pack: any) => pack.Type !== 1), 'their invitation goes as a normal email (no Proton end-to-end package)');
    const noE2eeGuestList = writes().find((write) => write.body?.Events?.[0]?.Event?.AddedProtonAttendees?.length)?.body.Events[0].Event;
    check(noE2eeGuestList?.AddedProtonAttendees?.[0]?.Email === NOE2EE, 'but they get the event key (AddedProtonAttendees) like a Proton guest');
    check(keysAllRequests.some((request) => request.email === NOE2EE && request.internalOnly === 1), 'their internal key is fetched as such (InternalOnly=1), like Proton does');
    if (noE2eeGuestList?.AddedProtonAttendees?.[0]) {
        const theirSessionKey: any = await CryptoProxy.decryptSessionKey({ binaryMessage: Uint8Array.fromBase64(noE2eeGuestList.AddedProtonAttendees[0].AddressKeyPacket), decryptionKeys: noE2eeKey.privateKey });
        check(Boolean(theirSessionKey?.data), 'the key packet opens with their key');
    }

    reset();
    const twins = await save(calendarAppIcs({ guests: ['john.doe@gmail.test', 'johndoe@gmail.test'], uid: 'twins' }));
    check(!twins.success && twins.reason === 'unsupported' && writes().length === 0, `the same person twice refuses the meeting (${twins.error})`);

    reset();
    const foreign = await save(calendarAppIcs({ organizer: 'boss@outlook.test', uid: 'foreign' }));
    check(!foreign.success && foreign.reason === 'unsupported' && writes().length === 0, `someone else as organizer refused (${foreign.error})`);

    reset();
    const recurring = await save(calendarAppIcs({ rrule: 'FREQ=WEEKLY;COUNT=4', uid: 'weekly' }));
    check(recurring.success && step(writes()[0]) === 'create', `a recurring meeting is created like a single one (stage 3b) (${recurring.error || 'ok'})`);

    reset();
    calendarOwner = 'owner@proton.test';
    const shared = await save(calendarAppIcs({ uid: 'shared' }));
    check(!shared.success && shared.reason === 'unsupported' && writes().length === 0, `invites in a calendar shared with you refused (${shared.error})`);
    calendarOwner = TOBI;

    reset();
    const viaAlias = await save(calendarAppIcs({ organizer: aliasAddress.Email, uid: 'alias', guests: [DAN] }));
    check(viaAlias.success && events.get(viaAlias.eventId) && sent[0]?.Message.Sender.Address === TOBI,
        `Calendar.app using another of your addresses: organized from the calendar's address (${viaAlias.error || sent[0]?.Message.Sender.Address})`);

    reset();
    failSends = 1;
    const unsent = await save(calendarAppIcs({ uid: 'unsent', guests: [DAN] }));
    check(!unsent.success && unsent.reason === 'unsupported' && sent.length === 0, `Proton refused the invitation: refused, no automatic retry (${unsent.error})`);
    check(writes().map(step).join(' | ') === 'create | email | delete', `the event without guests is removed again (${writes().map(step).join(' | ')})`);

    reset();
    slowDownSends = 1;
    const slowed = await save(calendarAppIcs({ uid: 'slowed', guests: [DAN] }));
    check(!slowed.success && slowed.reason === 'rate-limited' && slowed.retryAt === 1_900_000_000_000 && sent.length === 0,
        `Proton asked to slow down at the invitation: "rate-limited" with its time, so the caller keeps the change and tries again (${slowed.reason}: ${slowed.error})`);
    check(writes().map(step).join(' | ') === 'create | email', `no removal during the slow-down (it would be refused too) (${writes().map(step).join(' | ')})`);
    check(slowed.leftover?.calendarID === 'cal-1' && events.has(slowed.leftover.eventID) && !events.get(slowed.leftover.eventID).AttendeesInfo?.Attendees?.length,
        'the event without guests is reported as a leftover, for the caller to remove once Proton allows it');

    reset();
    networkFailSends = 1;
    const dropped = await save(calendarAppIcs({ uid: 'dropped', guests: [DAN] }));
    check(dropped.success && writes().map(step).join(' | ') === 'create | email | update',
        `connection dropped while sending: counted as sent, the meeting is saved (${dropped.error || writes().map(step).join(' | ')})`);
    check(dropped.warnings.some((warning: string) => /may not have been sent/.test(warning)) && dropped.emails.some((record: any) => record.outcome === 'failed'),
        'and the possibly missing invitation is reported');

    // 0.41: a slow-down after the first email went out: the change goes ahead, the refused email waits
    // and goes out once the pause is over (sendDeferredEmails); a newer change outdates a waiting one.
    reset();
    const later = await save(calendarAppIcs({ uid: 'later-guest', guests: [DAN] }));
    check(later.success, `a meeting with Dan (${later.error || 'ok'})`);
    reset();
    slowDownAfterSent = 1;
    const both = await save(calendarAppIcs({ uid: 'later-guest', start: '20261006T140000', end: '20261006T150000', guests: [DAN, CARLA] }), later.eventId);
    check(both.success && sent.length === 1, `the first email went out, the change is saved (${both.error || sent.length})`);
    const waiting = both.emails.find((record: any) => record.outcome === 'failed');
    check(/sent once the pause is over/.test(waiting?.detail || ''), `the second email waits (${waiting?.detail})`);
    check(both.warnings.some((warning: string) => /waits: Proton asked to slow down/.test(warning)), 'and the warning says so');
    check(api.deferredEmailCount() === 1, 'one email waits');
    let flushed = await api.sendDeferredEmails();
    check(flushed.sent === 0 && flushed.waiting === 1 && sent.length === 1, 'during the pause nothing is sent');
    api.deferredEmails[0].retryAt = Date.now() - 1; // the pause is over
    logged.length = 0;
    flushed = await api.sendDeferredEmails();
    check(flushed.sent === 1 && flushed.waiting === 0 && sent.length === 2, `after the pause it goes out (${JSON.stringify(flushed)})`);
    check(logged.some((record: any) => record.outcome === 'sent' && record.to.some((to: any) => [DAN, CARLA].includes(to.email))), 'reported as sent to the listener');
    // Outdated by a newer change before the pause ended.
    reset();
    slowDownAfterSent = 1;
    const again = await save(calendarAppIcs({ uid: 'later-guest', start: '20261006T160000', end: '20261006T170000', guests: [DAN, CARLA, ANNA] }), later.eventId);
    check(api.deferredEmailCount() === 1, `again one waits (a new guest added: two emails) (${again.error || again.emails.map((record: any) => record.outcome).join()})`);
    logged.length = 0;
    await save(calendarAppIcs({ uid: 'later-guest', start: '20261006T180000', end: '20261006T190000', guests: [DAN, CARLA, ANNA] }), later.eventId);
    check(api.deferredEmailCount() === 0 && logged.some((record: any) => record.outcome === 'failed' && /a newer change of the meeting was emailed instead/.test(record.detail || '')),
        'a newer change of the meeting drops the waiting email (its guests got the newer one)');
    // Review fixes: a newer change that emails only a new guest keeps another guest's waiting email;
    // a change that is not saved discards the emails that were to wait for it; no answer keeps them waiting.
    reset();
    const scoped = await save(calendarAppIcs({ uid: 'scoped', guests: [DAN] }));
    reset();
    slowDownAfterSent = 1;
    await save(calendarAppIcs({ uid: 'scoped', start: '20261006T140000', end: '20261006T150000', guests: [DAN, CARLA] }), scoped.eventId);
    const waitingFor = api.deferredEmails.find((entry: any) => entry.email.record.eventUid === events.get(scoped.eventId).UID);
    check(Boolean(waitingFor), 'one email of this meeting waits');
    const waitingTo = waitingFor?.email.to.map((to: any) => to.Address).join();
    reset();
    await save(calendarAppIcs({ uid: 'scoped', start: '20261006T140000', end: '20261006T150000', guests: [DAN, CARLA, ANNA] }), scoped.eventId);
    check(api.deferredEmails.includes(waitingFor), `a newer change that emails only the new guest keeps the waiting one (to ${waitingTo})`);
    api.deferredEmails.length = 0;
    reset();
    slowDownAfterSent = 1;
    failSyncUpdates = 3;
    logged.length = 0;
    const unsaved = await save(calendarAppIcs({ uid: 'scoped', start: '20261006T160000', end: '20261006T170000', guests: [DAN, CARLA, ANNA, GHOST.replace('ghost', 'eve')] }), scoped.eventId);
    check(!unsaved.success, `the change is not saved in Proton (${unsaved.reason})`);
    check(api.deferredEmailCount() === 0 && logged.some((record: any) => /the change was not saved in Proton/.test(record.detail || '')),
        `its waiting emails are not kept, and reported as not sent (${api.deferredEmailCount()})`);
    failSyncUpdates = 0;
    api.deferredEmails.push({ email: { ...waitingFor.email }, retryAt: 0, since: Date.now() });
    refusedConnectionSends = 1;
    flushed = await api.sendDeferredEmails();
    check(flushed.sent === 0 && flushed.givenUp === 0 && api.deferredEmailCount() === 1, `no connection at all (refused): it waits on (${JSON.stringify(flushed)})`);
    flushed = await api.sendDeferredEmails();
    check(flushed.sent === 1 && api.deferredEmailCount() === 0, 'and goes out at the next try');
    // A dropped connection may have sent it: reported, not sent a second time.
    api.deferredEmails.push({ email: { ...waitingFor.email }, retryAt: 0, since: Date.now() });
    networkFailSends = 1;
    logged.length = 0;
    flushed = await api.sendDeferredEmails();
    check(flushed.givenUp === 1 && api.deferredEmailCount() === 0 && /may have been sent anyway/.test(logged[0]?.detail || ''),
        `a dropped connection: "may have been sent anyway", no second try (${logged[0]?.detail})`);

    // Waiting for more than a day: given up and reported.
    api.deferredEmails.push({ email: { record: { ...logged[0], outcome: 'failed' } } as any, retryAt: 0, since: Date.now() - 25 * 3600 * 1000 });
    logged.length = 0;
    flushed = await api.sendDeferredEmails();
    check(flushed.givenUp === 1 && logged[0]?.outcome === 'failed' && /for a day/.test(logged[0]?.detail || ''), 'an email waiting longer than a day is given up and reported');

    // ======================================================================================
    // 5. Emailed but not saved, then retried.
    // ======================================================================================
    reset();
    failSyncUpdates = 3;
    const half = await save(calendarAppIcs({ start: '20261006T090000', end: '20261006T100000', guests: [ANNA, DAN] }), id);
    check(!half.success && half.reason === 'incomplete' && sent.length === 1, `update emailed, Proton refused 3 times: incomplete (${half.reason})`);
    check(half.eventId === id && half.protonUid === events.get(id).UID, 'the event is named in the refusal');
    reset();
    const finished = await save(calendarAppIcs({ start: '20261006T090000', end: '20261006T100000', guests: [ANNA, DAN] }), id);
    check(finished.success && sent.length === 0 && writes().map(step).join() === 'update', `saving again finishes it without a second email (${finished.error || 'ok'})`);
    check(finished.warnings.some((warning: string) => /already sent/.test(warning)), 'and says so');
    const after = await decrypted(id);
    check(after.vevent.dtstart.value.day === 6 && after.vevent.sequence.value === 2, 'the change is in Proton');

    reset();
    failSyncUpdates = 3;
    const halfNew = await save(calendarAppIcs({ uid: 'half-new', guests: [DAN] }));
    check(!halfNew.success && halfNew.reason === 'incomplete' && halfNew.eventId && events.has(halfNew.eventId) && /@proton\.me$/.test(halfNew.protonUid),
        'new meeting invited but guest list not saved: incomplete, the event (without guests) is named');
    reset();
    const halfNewDone = await save(calendarAppIcs({ uid: 'half-new', guests: [DAN] }), halfNew.eventId);
    check(halfNewDone.success && sent.length === 0 && events.get(halfNew.eventId).AttendeesInfo.Attendees.length === 1,
        `saving it again adds the guest without a second invitation (${halfNewDone.error || 'ok'})`);

    reset();
    failSyncUpdates = 3;
    const elevenIcs = calendarAppIcs({ start: '20261006T110000', end: '20261006T120000', guests: [ANNA, DAN] });
    const halfAgain = await save(elevenIcs, id);
    check(!halfAgain.success && halfAgain.reason === 'incomplete' && sent.length === 1, 'another update emailed but not saved');
    events.get(id).ModifyTime += 100; // changed in Proton web in the meantime
    reset();
    const afterOutsideChange = await save(elevenIcs, id);
    check(afterOutsideChange.success && sent.length === 1, `the event changed elsewhere since: the update is emailed again (${afterOutsideChange.error || sent.length})`);

    // The copy Calendar.app edited is checked against Proton (guests and times).
    const current = calendarAppIcs({ start: '20261006T110000', end: '20261006T120000', guests: [ANNA, DAN] });
    reset();
    const stale = await api.saveOrganizedEvent({
        calendarID: 'cal-1', eventID: id,
        vevent: veventOf(calendarAppIcs({ start: '20261006T110000', end: '20261006T120000', guests: [ANNA] })),
        basedOn: veventOf(calendarAppIcs({ start: '20261006T110000', end: '20261006T120000', guests: [ANNA] }))
    });
    check(!stale.success && stale.reason === 'stale' && writes().length === 0, `a copy without a guest added meanwhile is refused as stale (${stale.error})`);
    reset();
    const staleTime = await api.saveOrganizedEvent({
        calendarID: 'cal-1', eventID: id, vevent: veventOf(current),
        basedOn: veventOf(calendarAppIcs({ start: '20261006T090000', end: '20261006T100000', guests: [ANNA, DAN] }))
    });
    check(!staleTime.success && staleTime.reason === 'stale' && writes().length === 0, 'a copy with an outdated time is refused as stale');
    reset();
    const fresh = await api.saveOrganizedEvent({
        calendarID: 'cal-1', eventID: id,
        vevent: veventOf(calendarAppIcs({ start: '20261006T110000', end: '20261006T120000', guests: [ANNA, DAN], roles: { [DAN]: 'OPT-PARTICIPANT' } })),
        basedOn: veventOf(current)
    });
    check(fresh.success && sent.length === 0, `an up-to-date copy saves (${fresh.error || 'ok'})`);

    reset();
    api.configureInvitations({ policy: { mode: 'dry-run', allowlist: [] } });
    const dryUpdate = await save(calendarAppIcs({ start: '20261006T150000', end: '20261006T160000', guests: [ANNA, DAN] }), id);
    check(dryUpdate.reason === 'dry-run' && writes().length === 0 && /^X-PM-SESSION-KEY:\(not shown\)$/m.test(dryUpdate.emails[0]?.preview?.ics || ''),
        "dry run of an update: nothing changes, and the event's session key is not in the preview");
    api.configureInvitations({ policy: { mode: 'live', allowlist: [] } });

    reset();
    networkFailKeys = 1;
    const lookupFailed = await save(calendarAppIcs({ start: '20261006T120000', end: '20261006T130000', guests: [ANNA, DAN] }), id);
    check(!lookupFailed.success && lookupFailed.reason === 'failed' && writes().length === 0,
        `a failed key lookup stops the change before anything is sent (no guest silently left out) (${lookupFailed.error})`);

    // ======================================================================================
    // 6. Deleting.
    // ======================================================================================
    reset();
    api.configureInvitations({ policy: { mode: 'test', allowlist: [ANNA] } });
    const blockedCancel = await api.cancelOrganizedEvent({ calendarID: 'cal-1', eventID: id, notifyAttendees: true });
    check(!blockedCancel.success && blockedCancel.reason === 'blocked' && events.has(id) && writes().length === 0, 'test mode: cancellation to Dan blocked, nothing deleted');

    reset();
    api.configureInvitations({ policy: { mode: 'live', allowlist: [] } });
    const sequenceBefore = (await decrypted(id)).vevent.sequence.value;
    const cancelled = await api.cancelOrganizedEvent({ calendarID: 'cal-1', eventID: id, notifyAttendees: true });
    check(cancelled.success && writes().map(step).join(' | ') === 'email | delete' && !events.has(id), `deleting: cancellation, then delete (${cancelled.error || writes().map(step).join(' | ')})`);
    check(recipientsOf(sent[0]).join(',') === `${ANNA},${DAN}`, 'every guest is told');
    const cancelAll = (await openEmail(sent[0], ANNA, annaKey.privateKey)).ics;
    check(/METHOD:CANCEL/.test(cancelAll) && new RegExp(`SEQUENCE:${sequenceBefore + 1}`).test(cancelAll), `METHOD:CANCEL with SEQUENCE + 1 (${sequenceBefore + 1})`);
    check(/X-PM-SHARED-EVENT-ID:/.test(cancelAll) && !/X-PM-SESSION-KEY/.test(cancelAll), 'shared event ID, no session key');

    reset();
    const quiet = await api.cancelOrganizedEvent({ calendarID: 'cal-1', eventID: viaAlias.eventId, notifyAttendees: false });
    check(quiet.success && sent.length === 0 && !events.has(viaAlias.eventId), '"don\'t notify": deleted without email');

    reset();
    const notMine = await api.cancelOrganizedEvent({ calendarID: 'cal-1', eventID: 'missing', notifyAttendees: true });
    check(!notMine.success && writes().length === 0, `unknown event refused (${notMine.error})`);

    // ======================================================================================
    // 7. withoutRefusedGuests: new guests who cannot be invited are left out, the rest is saved.
    // ======================================================================================
    const saveWithout = (ics: string, eventID?: string) =>
        api.saveOrganizedEvent({ calendarID: 'cal-1', eventID, vevent: veventOf(ics), withoutRefusedGuests: true });

    reset();
    api.configureInvitations({ policy: { mode: 'test', allowlist: [ANNA] } });
    const partly = await saveWithout(calendarAppIcs({ uid: 'partly', guests: [ANNA, 'typo@uni.invalid'] }));
    check(partly.success && partly.droppedGuests?.map((guest: any) => guest.email).join() === 'typo@uni.invalid' && /not on the test-mode allowlist/.test(partly.droppedGuests?.[0]?.reason),
        `test mode, a mistyped guest: saved without them (${partly.error || JSON.stringify(partly.droppedGuests)})`);
    check(sent.length === 1 && recipientsOf(sent[0]).join() === ANNA, 'only the allowed guest is invited');
    const partlyStored = await decrypted(partly.eventId);
    check(partlyStored.vevent.attendee?.length === 1 && /anna@proton\.test/.test(partlyStored.vevent.attendee[0].value) && partlyStored.isOrganizer,
        'Proton has the meeting with the allowed guest only');
    check(logged.some((record) => record.outcome === 'blocked' && record.to.some((to: any) => to.email === 'typo@uni.invalid')) && logged.some((record) => record.outcome === 'sent'),
        'the left-out guest is reported as blocked, the invitation as sent');
    check(partly.warnings.some((warning: string) => /Not invited: typo@uni\.invalid .*saved without/.test(warning)), `a warning says so (${partly.warnings.join('; ')})`);

    reset();
    const nobody = await saveWithout(calendarAppIcs({ uid: 'nobody', guests: ['typo@uni.invalid'] }));
    check(nobody.success && sent.length === 0 && nobody.droppedGuests?.length === 1, `test mode, the only guest refused: saved without guests (${nobody.error || 'ok'})`);
    const nobodyStored = await decrypted(nobody.eventId);
    check(!nobodyStored.vevent.attendee?.length && !nobodyStored.vevent.organizer, 'a plain event: no guests, no organizer');

    reset();
    const noOption = await save(calendarAppIcs({ uid: 'no-option', guests: [ANNA, 'typo@uni.invalid'] }));
    check(!noOption.success && noOption.reason === 'blocked' && writes().length === 0, 'without the option: refused as before, nothing changed');

    reset();
    api.configureInvitations({ policy: { mode: 'live', allowlist: [] } });
    const ghostLeftOut = await saveWithout(calendarAppIcs({ uid: 'ghost-out', guests: [DAN, GHOST] }));
    check(ghostLeftOut.success && ghostLeftOut.droppedGuests?.[0]?.email === GHOST && sent.length === 1 && recipientsOf(sent[0]).join() === DAN,
        `live, a Proton address that does not exist: saved without it, like Proton's "continue without" (${ghostLeftOut.error || ghostLeftOut.droppedGuests?.[0]?.reason})`);

    // Adding a refused guest to an existing meeting: the rest of the change goes through.
    reset();
    api.configureInvitations({ policy: { mode: 'test', allowlist: [ANNA] } });
    const renamedPlusTypo = await saveWithout(calendarAppIcs({ uid: 'partly', guests: [ANNA, 'other@typo.ml'], summary: 'Renamed kickoff' }), partly.eventId);
    check(renamedPlusTypo.success && renamedPlusTypo.droppedGuests?.[0]?.email === 'other@typo.ml' && sent.length === 1 && recipientsOf(sent[0]).join() === ANNA,
        `an existing meeting renamed while adding a refused guest: renamed, Anna updated, the new guest left out (${renamedPlusTypo.error || 'ok'})`);
    check((await decrypted(partly.eventId)).vevent.summary?.value === 'Renamed kickoff', 'the new title is saved');

    // A refused existing guest still refuses the whole change (dropping them would cancel their invitation).
    reset();
    api.configureInvitations({ policy: { mode: 'live', allowlist: [] } });
    const withDan = await save(calendarAppIcs({ uid: 'with-dan', guests: [ANNA, DAN] }));
    reset();
    api.configureInvitations({ policy: { mode: 'test', allowlist: [ANNA] } });
    const movedWithDan = await saveWithout(calendarAppIcs({ uid: 'with-dan', guests: [ANNA, DAN, 'new@typo.ml'], start: '20261005T160000', end: '20261005T170000' }), withDan.eventId);
    check(!movedWithDan.success && movedWithDan.reason === 'blocked' && /dan@example\.org/.test(movedWithDan.error) && sent.length === 0,
        `an update that would email a guest not on the list is still refused as a whole (${movedWithDan.error})`);
    api.configureInvitations({ policy: { mode: 'live', allowlist: [] } });

    console.log(failures ? `\n${failures} check(s) FAILED` : '\nall organizer checks passed');
    process.exit(failures ? 1 : 0);
};

main().catch((error) => {
    console.error('FAILED', error);
    process.exit(1);
});
