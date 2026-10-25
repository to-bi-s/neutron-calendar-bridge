/**
 * Offline test for answering invitations (invitations, stage 2).
 *
 * Invitations are encrypted with Proton's own code and fresh keys, and the Proton API is faked:
 * key lookups, mail settings, answer/personal/upgrade/sync routes and the mail "direct send".
 * Checks, for a Proton organizer and for a non-Proton organizer:
 * - the email policy (test / dry-run / live) stops everything before Proton changes;
 * - the REPLY email: the Proton organizer can decrypt it with their own key (end-to-end), it is
 *   signed with your address key, the ICS says METHOD:REPLY and your answer; a non-Proton
 *   organizer gets it as normal (cleartext) email, also PGP/MIME-signed if you sign emails;
 * - Proton's order of steps (Proton organizer: answer then email; others: email then answer);
 * - invitations Proton Mail added to your calendar get calendar keys first ("upgrade");
 * - answering a series resets / aligns the answers of changed occurrences like Proton;
 * - deleting an invitation declines it (only if you had said yes/maybe) and removes the series.
 * No network, no real account, no emails.
 */
import { CryptoProxy } from '@protontech/crypto';
import { withPmAttendees } from '@proton/shared/lib/calendar/attendees';
import { getCreationKeys } from '@proton/shared/lib/calendar/crypto/keys/helpers';
import { createCalendarEvent } from '@proton/shared/lib/calendar/serialize';
import { loadCryptoWorker } from '@proton/shared/lib/helpers/setupCryptoWorker';
import { ProtonCalendarAPI } from '../src/proton-calendar-api.ts';
import { RateLimitedError } from '../src/request-control.ts';

let failures = 0;
const check = (condition: unknown, label: string) => {
    console.log(`${condition ? 'ok  ' : 'FAIL'} ${label}`);
    if (!condition) failures += 1;
};

const TOBI = 'tobi@proton.test';
const ANNA = 'anna@proton.test'; // a Proton organizer
const BOSS = 'boss@outlook.test'; // a non-Proton organizer

const VTIMEZONE = [
    'BEGIN:VTIMEZONE', 'TZID:Europe/Amsterdam',
    'BEGIN:DAYLIGHT', 'TZOFFSETFROM:+0100', 'TZOFFSETTO:+0200', 'TZNAME:CEST', 'DTSTART:19700329T020000',
    'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU', 'END:DAYLIGHT',
    'BEGIN:STANDARD', 'TZOFFSETFROM:+0200', 'TZOFFSETTO:+0100', 'TZNAME:CET', 'DTSTART:19701025T030000',
    'RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU', 'END:STANDARD',
    'END:VTIMEZONE'
].join('\r\n');

const invitationIcs = ({ uid, organizer, rrule, recurrenceId, summary = 'Project sync' }: {
    uid: string; organizer: string; rrule?: string; recurrenceId?: string; summary?: string;
}) => [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Test//EN',
    'BEGIN:VEVENT', `UID:${uid}`, 'DTSTAMP:20260929T100000Z',
    recurrenceId ? `RECURRENCE-ID;TZID=Europe/Amsterdam:${recurrenceId}` : '',
    `DTSTART;TZID=Europe/Amsterdam:${recurrenceId || '20261005T100000'}`,
    `DTEND;TZID=Europe/Amsterdam:${(recurrenceId || '20261005T100000').replace('T10', 'T11')}`,
    rrule ? `RRULE:${rrule}` : '',
    `SUMMARY:${summary}`, 'SEQUENCE:0',
    `ORGANIZER;CN=Organizer:mailto:${organizer}`,
    `ATTENDEE;CN=Tobi;ROLE=REQ-PARTICIPANT;RSVP=TRUE;PARTSTAT=NEEDS-ACTION:mailto:${TOBI}`,
    'ATTENDEE;CN=Carla;ROLE=REQ-PARTICIPANT;RSVP=TRUE;PARTSTAT=NEEDS-ACTION:mailto:carla@example.org',
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
    const calendarKey = await gen('calendar', 'calendar@proton.test');
    const tobiAddressKeys = [{ ID: 'tobi-key', Flags: 3, Primary: 1, privateKey: tobiKey.privateKey, publicKey: tobiKey.publicKey }];
    const annaAddressKeys = [{ ID: 'anna-key', Flags: 3, Primary: 1, privateKey: annaKey.privateKey, publicKey: annaKey.publicKey }];
    const calendarKeys = [{ ID: 'cal-key', privateKey: calendarKey.privateKey, publicKey: calendarKey.publicKey, Key: { ID: 'cal-key', Flags: 3, PassphraseID: 'p' } }];
    const calendarData = { calendarID: 'cal-1', memberID: 'member-1', calendarKeys, calendarSettings: {} };
    const tobiAddress = { ID: 'addr-tobi', Email: TOBI, DisplayName: 'Tobi', Status: 1, Receive: 1, Send: 1, Type: 1, Order: 1, Keys: [], SignedKeyList: null };

    // ---- Proton-shaped invitations in Tobi's calendar ----
    const events = new Map<string, any>();
    let attendeeCounter = 0;
    const addInvitation = async ({
        id, uid, organizer, rrule, recurrenceId, tobiStatus = 0, p2p, autoAdded = false, notifications = null
    }: { id: string; uid: string; organizer: string; rrule?: string; recurrenceId?: string; tobiStatus?: number; p2p: boolean; autoAdded?: boolean; notifications?: any }) => {
        const api: any = new ProtonCalendarAPI({ username: 'u', password: 'p' });
        const [vevent] = api.parseIcsToVevents(invitationIcs({ uid, organizer, rrule, recurrenceId }));
        const withTokens = await withPmAttendees(vevent, async (emails: string[]) =>
            Object.fromEntries(emails.map((email) => [email, email]))
        );
        const creationKeys = await getCreationKeys({ newAddressKeys: annaAddressKeys as any, newCalendarKeys: calendarKeys as any });
        const data: any = await createCalendarEvent({
            eventComponent: withTokens,
            isCreateEvent: true,
            isSwitchCalendar: false,
            hasDefaultNotifications: true,
            ...creationKeys
        } as any);
        const tokens = withTokens.attendee.map((attendee: any) => attendee.parameters['x-pm-token']);
        const event: any = {
            ID: id, CalendarID: 'cal-1', UID: uid, FullDay: 0, Color: null, IsOrganizer: 0,
            IsProtonProtonInvite: p2p ? 1 : 0,
            RecurrenceID: recurrenceId ? 1791187200 : null,
            SharedKeyPacket: data.SharedKeyPacket, CalendarKeyPacket: data.CalendarKeyPacket,
            AddressKeyPacket: null, AddressID: null,
            SharedEvents: data.SharedEventContent || [], CalendarEvents: data.CalendarEventContent || [],
            AttendeesEvents: data.AttendeesEventContent || [],
            AttendeesInfo: {
                Attendees: tokens.map((Token: string, index: number) => ({
                    ID: `att-${(attendeeCounter += 1)}`, Token, Status: index === 0 ? tobiStatus : 3
                })),
                MoreAttendees: 0
            },
            Notifications: notifications
        };
        if (autoAdded) {
            // As Proton Mail adds it: the shared session key encrypted to your address key.
            const [sessionKey] = await Promise.all([
                CryptoProxy.decryptSessionKey({ binaryMessage: Uint8Array.fromBase64(data.SharedKeyPacket), decryptionKeys: calendarKey.privateKey })
            ]);
            const addressKeyPacket = await CryptoProxy.encryptSessionKey({ ...(sessionKey as any), encryptionKeys: tobiKey.publicKey, format: 'binary' });
            event.AddressKeyPacket = (addressKeyPacket as unknown as Uint8Array<ArrayBuffer>).toBase64();
            event.AddressID = tobiAddress.ID;
            event.SharedKeyPacket = null;
            event.CalendarKeyPacket = null;
            event.CalendarEvents = event.CalendarEvents.filter((card: any) => card.Type === 2); // signed only
        }
        events.set(id, event);
        return event;
    };

    // ---- Fake Proton API ----
    type Request = { method: string; endpoint: string; body?: any; query?: any };
    const requests: Request[] = [];
    const sent: any[] = [];
    let mailSettings: any = { Sign: 0, PGPScheme: 16, DraftMIMEType: 'text/html', AttachPublicKey: 0, AutoSaveContacts: 1 };
    let failAttendeePuts = 0;
    let failSyncs = 0;
    let slowDownSends = 0;
    const respond = (data: any, status = 200) => ({ status, data: { Code: 1000, ...data } });
    const route = (method: string, endpoint: string, body: any, query: any) => {
        requests.push({ method, endpoint, body, query });
        let match: RegExpMatchArray | null;
        if (method === 'GET' && endpoint === 'mail/v4/settings') return respond({ MailSettings: mailSettings });
        if (method === 'GET' && endpoint === 'core/v4/keys/all') {
            if (query?.Email === ANNA) {
                return respond({ Address: { Keys: [{ PublicKey: annaKey.armoredPublicKey, Flags: 3, Source: 0, Primary: 1 }], SignedKeyList: null }, Unverified: null, ProtonMX: true, Warnings: [] });
            }
            return respond({ Address: { Keys: [], SignedKeyList: null }, Unverified: null, ProtonMX: false, Warnings: [] });
        }
        if (method === 'GET' && endpoint === 'contacts/v4/contacts/emails') return respond({ ContactEmails: [] });
        if (method === 'GET' && endpoint.startsWith('calendar/v1/vtimezones')) return respond({ Timezones: { 'Europe/Amsterdam': VTIMEZONE } });
        if (method === 'GET' && (match = endpoint.match(/^calendar\/v1\/cal-1\/events\/([^/]+)$/))) {
            const event = events.get(match[1]);
            return event ? respond({ Event: structuredClone(event) }) : { status: 404, data: { Code: 2501, Error: 'Event does not exist' } };
        }
        if (method === 'GET' && endpoint === 'calendar/v1/cal-1/events' && query?.UID) {
            return respond({ Events: [...events.values()].filter((event) => event.UID === query.UID).map((event) => structuredClone(event)) });
        }
        if (method === 'PUT' && (match = endpoint.match(/^calendar\/v1\/cal-1\/events\/([^/]+)\/attendees\/([^/]+)$/))) {
            if (failAttendeePuts > 0) {
                failAttendeePuts -= 1;
                return { status: 503, data: { Code: 503, Error: 'Service unavailable' } };
            }
            const event = events.get(match[1]);
            const attendee = event?.AttendeesInfo.Attendees.find((entry: any) => entry.ID === match![2]);
            if (!attendee) return { status: 422, data: { Code: 2001, Error: 'No such attendee' } };
            attendee.Status = body.Status;
            return respond({ Event: structuredClone(event) });
        }
        if (method === 'PUT' && (match = endpoint.match(/^calendar\/v1\/cal-1\/events\/([^/]+)\/personal$/))) {
            return respond({ Event: structuredClone(events.get(match[1])) });
        }
        if (method === 'PUT' && (match = endpoint.match(/^calendar\/v1\/cal-1\/events\/([^/]+)\/upgrade$/))) {
            const event = events.get(match[1]);
            event.SharedKeyPacket = body.SharedKeyPacket;
            event.AddressKeyPacket = null;
            event.AddressID = null;
            return respond({ Event: structuredClone(event) });
        }
        if (method === 'PUT' && endpoint === 'calendar/v1/cal-1/events/sync') {
            if (failSyncs > 0) {
                failSyncs -= 1;
                return { status: 503, data: { Code: 503, Error: 'Service unavailable' } };
            }
            for (const { ID } of body.Events) events.delete(ID);
            return { status: 200, data: { Code: 1001, Responses: body.Events.map(() => ({ Response: { Code: 1000 } })) } };
        }
        if (method === 'POST' && endpoint === 'mail/v4/messages/send/direct') {
            sent.push(body);
            return respond({ Sent: { ID: `msg-${sent.length}`, ExternalID: `ext-${sent.length}@proton.me` } });
        }
        return { status: 404, data: { Code: 404, Error: `unexpected ${method} ${endpoint}` } };
    };

    const api: any = new ProtonCalendarAPI({ username: 'u', password: 'p' });
    api.session = { UID: 'session' };
    api.userData = {
        addresses: [tobiAddress],
        addressKeys: tobiAddressKeys,
        addressKeysByAddressID: { [tobiAddress.ID]: tobiAddressKeys },
        userKeys: [{ ID: 'user-key', privateKey: userKey.privateKey, publicKey: userKey.publicKey }]
    };
    api.resolveCalendarData = async () => calendarData;
    api.makeCalendarRequest = async (endpoint: string, method: string, body: any, query: any) => route(method, endpoint, body, query);
    api.makeApiRequest = async (endpoint: string, method: string, body: any, query: any) => {
        if (endpoint === 'mail/v4/messages/send/direct' && slowDownSends > 0) {
            slowDownSends -= 1;
            throw new RateLimitedError('Proton asked to slow down until 12:00.', 1_900_000_000_000);
        }
        return route(method, endpoint, body, query);
    };
    const logged: any[] = [];
    api.configureInvitations({ prodId: '-//Neutron Calendar Bridge//EN', onEmail: (record: any) => logged.push(record) });

    const writes = () => requests.filter((request) => request.method !== 'GET');
    const reset = () => { requests.length = 0; sent.length = 0; logged.length = 0; };
    const statusOf = (id: string, index = 0) => events.get(id)?.AttendeesInfo.Attendees[index].Status;

    /** Decrypt the REPLY attachment of a direct-send payload with the given key (or clear session key). */
    const openReply = async (payload: any, recipient: string, decryptionKey?: any) => {
        const pack = payload.Packages[0];
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
        return { ics: String(ics), verified: (verificationStatus as unknown) === 1, pack, address };
    };

    // ======================================================================================
    // 1. Email policy: nothing changes in Proton unless the email may go out.
    // ======================================================================================
    await addInvitation({ id: 'p2p', uid: 'p2p@proton.test', organizer: ANNA, p2p: true, notifications: [] });
    reset();
    api.configureInvitations({ policy: { mode: 'test', allowlist: ['someone.else@proton.test'] } });
    const blocked = await api.answerInvitation({ calendarID: 'cal-1', eventID: 'p2p', answer: 'ACCEPTED' });
    check(!blocked.success && blocked.reason === 'blocked', `test mode: organizer not on the allowlist -> refused (${blocked.error})`);
    check(writes().length === 0 && statusOf('p2p') === 0, 'test mode: nothing written to Proton, answer unchanged');
    check(logged.length === 1 && logged[0].outcome === 'blocked', 'test mode: the blocked email is reported');

    reset();
    api.configureInvitations({ policy: { mode: 'dry-run', allowlist: [ANNA] } });
    const dry = await api.answerInvitation({ calendarID: 'cal-1', eventID: 'p2p', answer: 'ACCEPTED' });
    check(!dry.success && dry.reason === 'dry-run', `dry run: refused as a whole (${dry.error})`);
    check(writes().length === 0 && sent.length === 0 && statusOf('p2p') === 0, 'dry run: nothing written, nothing sent');
    const preview = dry.emails[0]?.preview?.ics || '';
    check(/METHOD:REPLY/.test(preview) && /PARTSTAT=ACCEPTED/.test(preview), 'dry run: the would-be REPLY is reported');
    check(dry.emails[0]?.to?.[0]?.delivery === 'proton', `dry run: Proton organizer would get it end-to-end (${dry.emails[0]?.to?.[0]?.delivery})`);

    // ======================================================================================
    // 2. Proton organizer, live (via allowlist): answer first, then an end-to-end REPLY.
    // ======================================================================================
    reset();
    api.configureInvitations({ policy: { mode: 'test', allowlist: [' Anna@Proton.test '] } });
    const accepted = await api.answerInvitation({ calendarID: 'cal-1', eventID: 'p2p', answer: 'ACCEPTED' });
    check(accepted.success, `accepting a Proton invitation works (${accepted.error || 'ok'}; ${accepted.warnings.join('; ')})`);
    check(statusOf('p2p') === 3, 'your answer is ACCEPTED in Proton');
    const order = writes().map((request) => `${request.method} ${request.endpoint.replace(/^.*\/events\/[^/]+\//, '')}`);
    check(order[0] === 'PUT attendees/' + events.get('p2p').AttendeesInfo.Attendees[0].ID && order[1] === 'POST mail/v4/messages/send/direct',
        `Proton-Proton order: answer, then email (${order.join(' | ')})`);
    check(order.includes('PUT personal'), 'notifications re-saved when you start attending (like Proton)');
    const personalBody = writes().find((request) => request.endpoint.endsWith('/personal'))?.body;
    check(personalBody && personalBody.Notifications === null, `accepting an invitation without reminders gives the calendar defaults (${JSON.stringify(personalBody?.Notifications)})`);
    const answerPut = writes().find((request) => /\/attendees\//.test(request.endpoint));
    const dtstampMatch = (await openReply(sent[0], ANNA, annaKey.privateKey)).ics.match(/DTSTAMP:(\d{8}T\d{6})Z/);
    const dtstampSeconds = dtstampMatch ? Date.UTC(+dtstampMatch[1].slice(0, 4), +dtstampMatch[1].slice(4, 6) - 1, +dtstampMatch[1].slice(6, 8), +dtstampMatch[1].slice(9, 11), +dtstampMatch[1].slice(11, 13), +dtstampMatch[1].slice(13, 15)) / 1000 : NaN;
    check(answerPut?.body.UpdateTime === dtstampSeconds, `answer time equals the reply's DTSTAMP, so the organizer does not see it as out of date (${answerPut?.body.UpdateTime} vs ${dtstampSeconds})`);
    const p2pReply = await openReply(sent[0], ANNA, annaKey.privateKey);
    check(p2pReply.address.Type === 1 && !!p2pReply.address.BodyKeyPacket, 'package for the organizer is Proton end-to-end (type 1)');
    check(/METHOD:REPLY/.test(p2pReply.ics), 'organizer decrypts the ICS with their own key: METHOD:REPLY');
    check(/ATTENDEE;PARTSTAT=ACCEPTED:mailto:tobi@proton\.test/.test(p2pReply.ics), 'ICS carries your answer only');
    check(/X-PM-PROTON-REPLY;VALUE=BOOLEAN:TRUE/i.test(p2pReply.ics), 'ICS marked as a Proton reply');
    check(!/carla@example\.org/.test(p2pReply.ics), 'other guests are not in the reply');
    check(/BEGIN:VTIMEZONE/.test(p2pReply.ics) && /PRODID:-\/\/Neutron Calendar Bridge\/\/EN/.test(p2pReply.ics), 'VTIMEZONE included, PRODID identifies the bridge');
    check(p2pReply.verified, 'ICS signature verifies with your address key');
    check(sent[0].Message.ToList[0].Address === ANNA && sent[0].Message.Sender.Address === TOBI, 'from you to the organizer');
    check(/^Re: Invitation for an event starting on /.test(sent[0].Message.Subject), `Proton's subject (${sent[0].Message.Subject})`);
    check(sent[0].AutoSaveContacts === 0, 'organizer not auto-saved as a contact (like Proton)');
    check(logged.some((record) => record.outcome === 'sent' && record.to[0].email === ANNA), 'sent email reported to the listener');
    check(logged.every((record) => record.outcome !== 'sent' || /^ext-\d+@proton\.me$/.test(record.externalId || '')), "sent emails carry their Message-ID (Proton's ExternalID)");

    reset();
    const same = await api.answerInvitation({ calendarID: 'cal-1', eventID: 'p2p', answer: 'ACCEPTED' });
    check(same.success && writes().length === 0 && sent.length === 0, 'answering the same again sends nothing');

    // ======================================================================================
    // 3. Non-Proton organizer: email first, then answer; plain email (and signed variant).
    // ======================================================================================
    await addInvitation({ id: 'ext', uid: 'ext@outlook.test', organizer: BOSS, p2p: false, tobiStatus: 3 });
    reset();
    api.configureInvitations({ policy: { mode: 'live', allowlist: [] } });
    const maybe = await api.answerInvitation({ calendarID: 'cal-1', eventID: 'ext', answer: 'TENTATIVE' });
    check(maybe.success && statusOf('ext') === 1, `maybe to a non-Proton invitation works (${maybe.error || 'ok'})`);
    const extOrder = writes().map((request) => request.endpoint.split('/').slice(-2).join('/'));
    check(extOrder[0] === 'send/direct' && extOrder[1].startsWith('attendees/'), `external order: email, then answer (${extOrder.join(' | ')})`);
    check(!extOrder.some((entry) => entry.endsWith('personal')), 'yes -> maybe keeps notifications (no personal update)');
    const extReply = await openReply(sent[0], BOSS);
    check(extReply.pack.Type === 4 && extReply.address.Type === 4 && !extReply.address.PublicKey, 'non-Proton organizer: cleartext package (type 4)');
    check(/PARTSTAT=TENTATIVE/.test(extReply.ics) && !/X-PM-PROTON-REPLY/.test(extReply.ics), 'cleartext REPLY with your answer, not marked Proton');
    check(maybe.emails[0].to[0].delivery === 'plain', 'reported as normal email');

    reset();
    slowDownSends = 1;
    const slowed = await api.answerInvitation({ calendarID: 'cal-1', eventID: 'ext', answer: 'ACCEPTED' });
    check(!slowed.success && slowed.reason === 'rate-limited' && slowed.retryAt === 1_900_000_000_000 && writes().length === 0 && statusOf('ext') === 1,
        `Proton asked to slow down at the answer: "rate-limited" with its time, nothing sent or saved (${slowed.reason}: ${slowed.error})`);

    reset();
    mailSettings = { ...mailSettings, Sign: 1 };
    const signedDecline = await api.answerInvitation({ calendarID: 'cal-1', eventID: 'ext', answer: 'DECLINED' });
    check(signedDecline.success && statusOf('ext') === 2, `decline with "sign external emails" on works (${signedDecline.error || 'ok'})`);
    const signedPack = sent[0]?.Packages?.[0];
    check(signedPack?.Type === 32 && signedPack?.MIMEType === 'multipart/mixed', `signed cleartext: PGP/MIME package (type ${signedPack?.Type}, ${signedPack?.MIMEType})`);
    const declinePersonal = writes().find((request) => request.endpoint.endsWith('/personal'))?.body;
    check(Array.isArray(declinePersonal?.Notifications) && declinePersonal.Notifications.length === 0, 'maybe -> no: reminders dropped (like Proton)');
    mailSettings = { ...mailSettings, Sign: 0 };

    reset();
    mailSettings = { ...mailSettings, Sign: 0 };
    failAttendeePuts = 3;
    const half = await api.answerInvitation({ calendarID: 'cal-1', eventID: 'ext', answer: 'ACCEPTED' });
    check(!half.success && half.reason === 'incomplete' && sent.length === 1 && statusOf('ext') === 2,
        `email sent but Proton kept refusing the answer (3 tries): reported as incomplete (${half.reason})`);
    reset();
    const finished = await api.answerInvitation({ calendarID: 'cal-1', eventID: 'ext', answer: 'ACCEPTED' });
    check(finished.success && sent.length === 0 && statusOf('ext') === 3, 'answering again saves it without a second email');
    check(finished.warnings.some((warning: string) => /already been emailed/.test(warning)), 'and says so');
    reset();
    failAttendeePuts = 1;
    const flaky = await api.answerInvitation({ calendarID: 'cal-1', eventID: 'ext', answer: 'TENTATIVE' });
    check(flaky.success && sent.length === 1 && statusOf('ext') === 1, 'one failed save after the email is retried transparently');

    // ======================================================================================
    // 4. Invitation Proton Mail added to the calendar: upgraded to calendar keys first.
    // ======================================================================================
    await addInvitation({ id: 'auto', uid: 'auto@proton.test', organizer: ANNA, p2p: true, autoAdded: true });
    reset();
    const autoAnswer = await api.answerInvitation({ calendarID: 'cal-1', eventID: 'auto', answer: 'ACCEPTED' });
    check(autoAnswer.success, `answering an auto-added invitation works (${autoAnswer.error || 'ok'})`);
    check(writes()[0]?.endpoint.endsWith('/upgrade'), 'it is upgraded before anything else');
    const upgradedKey = await CryptoProxy.decryptSessionKey({
        binaryMessage: Uint8Array.fromBase64(events.get('auto').SharedKeyPacket), decryptionKeys: calendarKey.privateKey
    });
    check(!!upgradedKey && events.get('auto').AddressKeyPacket === null, 'shared key now readable with the calendar key');

    // ======================================================================================
    // 5. A series: answering the whole series updates changed occurrences silently.
    // ======================================================================================
    const RRULE = 'FREQ=WEEKLY;COUNT=6';
    await addInvitation({ id: 'master', uid: 'weekly@proton.test', organizer: ANNA, p2p: true, rrule: RRULE, tobiStatus: 0 });
    await addInvitation({ id: 'edit-aligned', uid: 'weekly@proton.test', organizer: ANNA, p2p: true, recurrenceId: '20261012T100000', tobiStatus: 2 });
    await addInvitation({ id: 'edit-other', uid: 'weekly@proton.test', organizer: ANNA, p2p: true, recurrenceId: '20261019T100000', tobiStatus: 1 });
    await addInvitation({ id: 'edit-open', uid: 'weekly@proton.test', organizer: ANNA, p2p: true, recurrenceId: '20261026T100000', tobiStatus: 0 });
    reset();
    api.configureInvitations({ policy: { mode: 'test', allowlist: [ANNA] } });
    const series = await api.answerInvitation({ calendarID: 'cal-1', eventID: 'master', answer: 'ACCEPTED', alignSingleEditIDs: ['edit-aligned'] });
    check(series.success && statusOf('master') === 3, `series accepted (${series.error || 'ok'})`);
    check(sent.length === 1, `one email for the series (${sent.length})`);
    check(statusOf('edit-aligned') === 3, 'occurrence answered the same in Calendar.app: set to ACCEPTED silently');
    check(statusOf('edit-other') === 0, "differing occurrence reset to needs-action (Proton's rule)");
    check(statusOf('edit-open') === 0 && !writes().some((request) => request.endpoint.includes('/edit-open/')), 'unanswered occurrence left alone');
    check(writes().some((request) => request.endpoint.endsWith('edit-other/personal') && Array.isArray(request.body.Notifications) && request.body.Notifications.length === 0),
        'reset occurrence: notifications dropped (like Proton)');
    const seriesIcs = (await openReply(sent[0], ANNA, annaKey.privateKey)).ics;
    check(/RRULE:FREQ=WEEKLY;COUNT=6/.test(seriesIcs) && !/RECURRENCE-ID/.test(seriesIcs), 'series REPLY carries the RRULE, no RECURRENCE-ID');

    reset();
    const single = await api.answerInvitation({ calendarID: 'cal-1', eventID: 'edit-other', answer: 'DECLINED' });
    check(single.success && statusOf('edit-other') === 2 && statusOf('master') === 3, 'answering one changed occurrence leaves the series answer');
    const singleIcs = (await openReply(sent[0], ANNA, annaKey.privateKey)).ics;
    check(/RECURRENCE-ID;TZID=Europe\/Amsterdam:20261019T100000/.test(singleIcs), 'occurrence REPLY carries its RECURRENCE-ID');

    // ======================================================================================
    // 6. Deleting invitations.
    // ======================================================================================
    reset();
    api.configureInvitations({ policy: { mode: 'test', allowlist: [] } });
    const blockedDelete = await api.removeInvitation({ calendarID: 'cal-1', eventID: 'master', notifyOrganizer: true });
    check(!blockedDelete.success && blockedDelete.reason === 'blocked' && events.has('master') && writes().length === 0,
        'test mode: removing an accepted invitation (decline email) is refused, nothing deleted');

    reset();
    api.configureInvitations({ policy: { mode: 'test', allowlist: [ANNA] } });
    const removed = await api.removeInvitation({ calendarID: 'cal-1', eventID: 'master', notifyOrganizer: true });
    check(removed.success, `removing an accepted series works (${removed.error || 'ok'})`);
    const removeOrder = writes().map((request) => request.endpoint.split('/').slice(-2).join('/'));
    check(removeOrder[0] === 'send/direct' && removeOrder[1]?.startsWith('attendees/') && removeOrder[removeOrder.length - 1] === 'events/sync',
        `decline email, answer, then delete (${removeOrder.join(' | ')})`);
    const declineIcs = (await openReply(sent[0], ANNA, annaKey.privateKey)).ics;
    check(/PARTSTAT=DECLINED/.test(declineIcs), 'the organizer gets a DECLINED reply');
    check(['master', 'edit-aligned', 'edit-other', 'edit-open'].every((id) => !events.has(id)), 'the whole series is gone');

    await addInvitation({ id: 'pending', uid: 'pending@outlook.test', organizer: BOSS, p2p: false, tobiStatus: 0 });
    reset();
    api.configureInvitations({ policy: { mode: 'dry-run', allowlist: [] } });
    const dryRemove = await api.removeInvitation({ calendarID: 'cal-1', eventID: 'pending', notifyOrganizer: true });
    check(!dryRemove.success && dryRemove.reason === 'dry-run' && events.has('pending') && writes().length === 0,
        'dry run: removing an unanswered invitation changes nothing either');
    reset();
    api.configureInvitations({ policy: { mode: 'test', allowlist: [] } });
    const quiet = await api.removeInvitation({ calendarID: 'cal-1', eventID: 'pending', notifyOrganizer: true });
    check(quiet.success && sent.length === 0 && !events.has('pending'), 'unanswered invitation: removed without email (allowed in test mode)');

    await addInvitation({ id: 'noreply', uid: 'noreply@outlook.test', organizer: BOSS, p2p: false, tobiStatus: 3 });
    reset();
    const noNotify = await api.removeInvitation({ calendarID: 'cal-1', eventID: 'noreply', notifyOrganizer: false });
    check(noNotify.success && sent.length === 0 && !events.has('noreply'), '"don\'t notify" (Schedule-Reply: F): removed without email');

    // ======================================================================================
    // 7. Refusals.
    // ======================================================================================
    reset();
    api.configureInvitations({ policy: { mode: 'live', allowlist: [] } });
    const notMine = await api.answerInvitation({ calendarID: 'cal-1', eventID: 'missing', answer: 'ACCEPTED' });
    check(!notMine.success && writes().length === 0, `unknown event refused (${notMine.error})`);
    await addInvitation({ id: 'inactive', uid: 'inactive@proton.test', organizer: ANNA, p2p: true });
    api.userData.addresses = [{ ...tobiAddress, Send: 0 }];
    reset();
    const inactive = await api.answerInvitation({ calendarID: 'cal-1', eventID: 'inactive', answer: 'ACCEPTED' });
    check(!inactive.success && inactive.reason === 'unsupported' && writes().length === 0, `address that cannot send: refused (${inactive.error})`);
    api.userData.addresses = [tobiAddress];
    check(JSON.stringify(api.getInvitationEmailPolicy()) === JSON.stringify({ mode: 'live', allowlist: [], language: 'proton' }), 'policy readable (language: Proton Calendar\'s setting by default)');
    let badMode = false;
    try { api.configureInvitations({ policy: { mode: 'yolo', allowlist: [] } }); } catch { badMode = true; }
    check(badMode, 'unknown email mode rejected');

    console.log(failures ? `\n${failures} check(s) FAILED` : '\nall invitation checks passed');
    process.exit(failures ? 1 : 0);
};

main().catch((error) => {
    console.error('FAILED', error);
    process.exit(1);
});
