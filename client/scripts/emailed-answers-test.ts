/**
 * Offline test for answers that guests outside Proton send by email (invitations, stage 4).
 *
 * The Proton API is faked: the mailbox (message list, full messages, encrypted attachments), the
 * calendars and events, and the attendee answer route. Meetings are created with this client's own
 * organizer code; the reply attachments are encrypted to your address key with Proton's own
 * attachment code, so reading them goes through the real key packets and decryption. Checks:
 * - REPLY and COUNTER-with-an-answer are applied to the guest who sent the email, with the reply's
 *   DTSTAMP as answer time (the email's time without DTSTAMP, or for Yahoo); dry run only reports;
 * - nothing is applied for: forged answers (sender ≠ the answering guest), people not invited, single
 *   occurrences, older or newer versions, cancelled meetings, disabled calendars, other people's
 *   meetings or calendars, replies to another of your addresses, Proton-to-Proton replies, answers
 *   Proton already has; emails failing DMARC, phishing or suspicious, PGP/MIME, sent or bounced;
 * - the run: only emails with a calendar attachment are opened, pages, cursor, a run stopped by an
 *   outage is resumed, an email Proton keeps refusing is given up after three runs, switching from
 *   dry run to live applies what the dry run only reported.
 * No network, no real account, no emails.
 */
import { CryptoProxy } from '@protontech/crypto';
import { loadCryptoWorker } from '@proton/shared/lib/helpers/setupCryptoWorker';
import { encryptAttachment } from '@proton/shared/lib/mail/send/attachments';
import { ProtonCalendarAPI } from '../src/proton-calendar-api.ts';

let failures = 0;
const check = (condition: unknown, label: string) => {
    console.log(`${condition ? 'ok  ' : 'FAIL'} ${label}`);
    if (!condition) failures += 1;
};

const TOBI = 'tobi@proton.test';
const ALIAS = 'tobi.alias@proton.test';
const ANNA = 'anna@proton.test'; // a Proton guest
const CARLA = 'carla@example.org'; // guests outside Proton
const DAN = 'dan@example.org';
const ELI = 'eli@example.org'; // not invited
const JOHN_GMAIL = 'john.doe@gmail.com'; // Gmail: dots do not count (Proton's server and Proton's guess agree)
const JOHN_SMITH = 'john.smith@corp.test'; // two different people at a domain where dots count
const JOHNSMITH = 'johnsmith@corp.test';

const VTIMEZONE = [
    'BEGIN:VTIMEZONE', 'TZID:Europe/Amsterdam',
    'BEGIN:DAYLIGHT', 'TZOFFSETFROM:+0100', 'TZOFFSETTO:+0200', 'TZNAME:CEST', 'DTSTART:19700329T020000',
    'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU', 'END:DAYLIGHT',
    'BEGIN:STANDARD', 'TZOFFSETFROM:+0200', 'TZOFFSETTO:+0100', 'TZNAME:CET', 'DTSTART:19701025T030000',
    'RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU', 'END:STANDARD',
    'END:VTIMEZONE'
].join('\r\n');

const calendarAppIcs = ({
    uid = 'CA1F9E2B-7D3C-4C1A-9B57-3E2E0D7F1A11',
    start = '20261105T100000',
    end = '20261105T110000',
    summary = 'Project kickoff',
    guests = [ANNA, CARLA, DAN]
}: { uid?: string; start?: string; end?: string; summary?: string; guests?: string[] } = {}) =>
    [
        'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Apple Inc.//macOS 26.0//EN',
        'BEGIN:VEVENT', `UID:${uid}`, 'DTSTAMP:20261001T080000Z',
        `DTSTART;TZID=Europe/Amsterdam:${start}`, `DTEND;TZID=Europe/Amsterdam:${end}`,
        `SUMMARY:${summary}`, 'SEQUENCE:0',
        `ORGANIZER;CN=Tobi:mailto:${TOBI}`,
        `ATTENDEE;CN=Tobi;CUTYPE=INDIVIDUAL;PARTSTAT=ACCEPTED;ROLE=CHAIR:mailto:${TOBI}`,
        ...guests.map((guest) => `ATTENDEE;CN=${guest.split('@')[0]};CUTYPE=INDIVIDUAL;PARTSTAT=NEEDS-ACTION;ROLE=REQ-PARTICIPANT;RSVP=TRUE:mailto:${guest}`),
        'END:VEVENT', 'END:VCALENDAR', ''
    ].join('\r\n');

const stamp = (unix: number) => new Date(unix * 1000).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

/** A reply like Outlook / Gmail send it. */
const replyIcs = ({
    uid,
    answers = {} as Record<string, string>,
    method = 'REPLY',
    organizer = TOBI as string | null,
    sequence = 0 as number | null,
    dtstamp = undefined as number | undefined,
    extra = [] as string[],
    dtstart = true
}: { uid: string; answers?: Record<string, string>; method?: string; organizer?: string | null; sequence?: number | null; dtstamp?: number; extra?: string[]; dtstart?: boolean }) =>
    [
        'BEGIN:VCALENDAR', `METHOD:${method}`, 'PRODID:Microsoft Exchange Server 2010', 'VERSION:2.0',
        'BEGIN:VEVENT',
        ...Object.entries(answers).map(([email, partstat]) => `ATTENDEE;PARTSTAT=${partstat};CN=${email.split('@')[0]}:mailto:${email}`),
        organizer ? `ORGANIZER;CN=Tobi S:mailto:${organizer}` : '',
        `UID:${uid}`,
        sequence === null ? '' : `SEQUENCE:${sequence}`,
        dtstamp ? `DTSTAMP:${stamp(dtstamp)}` : '',
        dtstart ? 'DTSTART:20261105T090000Z' : '', dtstart ? 'DTEND:20261105T100000Z' : '',
        'SUMMARY:Accepted: Project kickoff',
        ...extra,
        'END:VEVENT', 'END:VCALENDAR', ''
    ].filter(Boolean).join('\r\n');

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
    const strangerKey = await gen('stranger', 'stranger@example.org');
    const annaKey = await gen('anna', ANNA);
    const calendarKey = await gen('calendar', 'calendar@proton.test');
    const tobiAddressKeys = [{ ID: 'tobi-key', Flags: 3, Primary: 1, privateKey: tobiKey.privateKey, publicKey: tobiKey.publicKey }];
    const calendarKeys = [{ ID: 'cal-key', privateKey: calendarKey.privateKey, publicKey: calendarKey.publicKey, Key: { ID: 'cal-key', Flags: 3, PassphraseID: 'p' } }];
    const calendarData = { calendarID: 'cal-1', memberID: 'member-1', calendarKeys, calendarSettings: {} };
    const tobiAddress = { ID: 'addr-tobi', Email: TOBI, DisplayName: 'Tobi S', Status: 1, Receive: 1, Send: 1, Type: 1, Order: 1, Keys: [], SignedKeyList: null };
    const aliasAddress = { ...tobiAddress, ID: 'addr-alias', Email: ALIAS, DisplayName: 'Tobi', Order: 2 };

    // ---- Fake Proton: calendar ----
    type Request = { method: string; endpoint: string; body?: any; query?: any };
    const requests: Request[] = [];
    const events = new Map<string, any>();
    const foreignEvents: any[] = []; // events in calendars that are not yours
    let eventCounter = 0;
    let attendeeCounter = 0;
    let calendarFlags = 1; // CALENDAR_FLAGS.ACTIVE, as Proton returns for a normal calendar
    let serverStripsDots = false; // what if Proton's server ignored dots at every domain?
    let refuseAnswers = 0; // updateAttendeePartstat refused (422) this many times
    const mailSettings: any = { Sign: 0, PGPScheme: 16, DraftMIMEType: 'text/html', AttachPublicKey: 0, AutoSaveContacts: 0, RecipientLimit: 100 };
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
                Status,
                UpdateTime: null
            })),
            MoreAttendees: 0
        };
        event.Notifications = payload.Notifications;
        event.UID = uidOf(event.SharedEvents) || event.UID;
        return event;
    };

    // ---- Fake Proton: mailbox ----
    const messages = new Map<string, any>(); // full messages
    const attachmentData = new Map<string, Uint8Array>();
    let downloadOutages = 0; // attachment downloads failing with 503 this many times
    let afterList: (() => void) | null = null; // runs once after the next list request (mailbox changes meanwhile)
    let attachmentCounter = 0;
    const metadataOf = (message: any) => {
        const { ParsedHeaders, Attachments, Body, ...metadata } = message;
        return metadata;
    };

    const route = (method: string, endpoint: string, body: any, query: any) => {
        requests.push({ method, endpoint, body, query });
        let match: RegExpMatchArray | null;
        if (method === 'GET' && endpoint === 'calendar/v1') {
            return respond({
                Calendars: [
                    { ID: 'cal-1', Type: 0, Owner: { Email: TOBI }, Members: [{ ID: 'member-1', AddressID: tobiAddress.ID, Email: TOBI, Permissions: 127, Flags: calendarFlags }] },
                    // A calendar someone shared with you: not yours, so its meetings are not touched.
                    { ID: 'cal-shared', Type: 0, Owner: { Email: 'boss@proton.test' }, Members: [{ ID: 'member-2', AddressID: tobiAddress.ID, Email: TOBI, Permissions: 112, Flags: 0 }] }
                ]
            });
        }
        if (method === 'GET' && endpoint.startsWith('core/v4/addresses/canonical?')) {
            const emails = [...endpoint.matchAll(/Emails\[\]=([^&]+)/g)].map((entry) => decodeURIComponent(entry[1]));
            return respond({
                Responses: emails.map((Email) => ({
                    Email,
                    Response: {
                        Code: 1000,
                        CanonicalEmail: serverStripsDots
                            ? Email.toLowerCase().replace(/\.(?=[^@]*@)/g, '')
                            : Email.toLowerCase().replace(/\.(?=[^@]*@gmail\.com$)/g, '')
                    }
                }))
            });
        }
        if (method === 'GET' && endpoint === 'mail/v4/settings') return respond({ MailSettings: mailSettings });
        if (method === 'GET' && endpoint === 'core/v4/keys/all') {
            if (query?.Email === ANNA) {
                return respond({ Address: { Keys: [{ PublicKey: annaKey.armoredPublicKey, Flags: 3, Source: 0, Primary: 1 }], SignedKeyList: null }, Unverified: null, ProtonMX: true, Warnings: [] });
            }
            return respond({ Address: { Keys: [], SignedKeyList: null }, Unverified: null, ProtonMX: false, Warnings: [] });
        }
        if (method === 'GET' && endpoint === 'contacts/v4/contacts/emails') return respond({ ContactEmails: [] });
        if (method === 'GET' && endpoint.startsWith('calendar/v1/vtimezones')) return respond({ Timezones: { 'Europe/Amsterdam': VTIMEZONE } });
        if (method === 'GET' && endpoint === 'calendar/v1/events' && query?.UID) {
            // getEventByUID: every calendar you can see, yours and shared ones.
            const all = [...events.values(), ...foreignEvents].filter((event) => event.UID === query.UID);
            const page = all.slice(Number(query.Page || 0) * Number(query.PageSize || 100), (Number(query.Page || 0) + 1) * Number(query.PageSize || 100));
            return respond({ Events: page.map((event) => structuredClone(event)) });
        }
        if (method === 'GET' && endpoint === 'calendar/v1/cal-1/events' && query?.UID) {
            return respond({ Events: [...events.values()].filter((event) => event.UID === query.UID).map((event) => structuredClone(event)) });
        }
        if (method === 'GET' && (match = endpoint.match(/^calendar\/v1\/cal-1\/events\/([^/]+)$/))) {
            const event = events.get(match[1]);
            return event ? respond({ Event: structuredClone(event) }) : { status: 404, data: { Code: 2501, Error: 'Event does not exist' } };
        }
        if (method === 'PUT' && (match = endpoint.match(/^calendar\/v1\/cal-1\/events\/([^/]+)\/attendees\/([^/]+)$/))) {
            if (refuseAnswers > 0) {
                refuseAnswers -= 1;
                return { status: 422, data: { Code: 2001, Error: 'Invalid update time' } };
            }
            const attendee = events.get(match[1])?.AttendeesInfo?.Attendees.find((entry: any) => entry.ID === match![2]);
            if (!attendee) return { status: 404, data: { Code: 2501, Error: 'Attendee does not exist' } };
            attendee.Status = body.Status;
            attendee.UpdateTime = body.UpdateTime;
            return respond({ Attendee: structuredClone(attendee) });
        }
        if (method === 'PUT' && endpoint === 'calendar/v1/cal-1/events/sync') {
            const responses = body.Events.map((operation: any) => {
                if (operation.DeletionReason !== undefined) {
                    events.delete(operation.ID);
                    return { Response: { Code: 1000 } };
                }
                if (operation.ID) {
                    const event = events.get(operation.ID);
                    toStored(event, operation.Event);
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
        if (method === 'POST' && endpoint === 'mail/v4/messages/send/direct') return respond({ Sent: { ID: 'sent' } });
        if (method === 'GET' && endpoint === 'mail/v4/messages') {
            // LabelID 15 (almost all mail) leaves out spam and trash; Attachments=1 only emails with attachments.
            const begin = Number(query?.Begin || 0);
            const list = [...messages.values()]
                .filter((message) => message.Time >= begin && message.NumAttachments > 0)
                .filter((message) =>
                    query?.LabelID === '4'
                        ? (message.LabelIDs || []).includes('4')
                        : !(message.LabelIDs || []).some((label: string) => label === '3' || label === '4')
                )
                .sort((a, b) => a.Time - b.Time || a.ID.localeCompare(b.ID));
            const size = Number(query?.PageSize || 50);
            const page = Number(query?.Page || 0);
            const listed = respond({ Total: list.length, Messages: list.slice(page * size, (page + 1) * size).map(metadataOf) });
            const hook = afterList;
            afterList = null;
            hook?.();
            return listed;
        }
        if (method === 'GET' && (match = endpoint.match(/^mail\/v4\/messages\/([^/]+)$/))) {
            const message = messages.get(match[1]);
            return message ? respond({ Message: structuredClone(message) }) : { status: 422, data: { Code: 15052, Error: 'Message does not exist' } };
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
    api.makeApiRequest = async (endpoint: string, method: string, body: any, query: any) => route(method, endpoint, body, query);
    api.makeBinaryRequest = async (endpoint: string) => {
        requests.push({ method: 'GET', endpoint });
        if (downloadOutages > 0) {
            downloadOutages -= 1;
            const error: any = new Error('Service unavailable');
            error.status = 503;
            throw error;
        }
        const match = endpoint.match(/^mail\/v4\/attachments\/([^/]+)$/);
        const data = match && attachmentData.get(match[1]);
        if (!data) {
            const error: any = new Error('Attachment does not exist');
            error.status = 422;
            throw error;
        }
        return data.slice().buffer;
    };
    api.configureInvitations({ prodId: '-//Neutron Calendar Bridge//EN', policy: { mode: 'live', allowlist: [] } });

    // ---- Helpers ----
    const RECEIVED = 1;
    const SENT = 2;
    const DMARC_FAIL = 2 ** 26;
    const PHISHING = 2 ** 30;
    const SUSPICIOUS = 2 ** 33;
    let clock = Math.floor(Date.now() / 1000) - 6 * 3600;
    let messageCounter = 0;
    type AttachmentSpec = { ics?: string; name?: string; type?: string; bytes?: Uint8Array; key?: any };
    /** An email in your mailbox; attachments encrypted to your address key like Proton stores them. */
    const mail = async ({
        from = CARLA,
        to = TOBI as string | null,
        subject = 'Accepted: Project kickoff',
        attachments = [] as AttachmentSpec[],
        flags = RECEIVED,
        labels = ['0', '5', '15'],
        mimeType = 'text/html',
        listMetadata = true,
        time = (clock += 60)
    }: { from?: string; to?: string | null; subject?: string; attachments?: AttachmentSpec[]; flags?: number; labels?: string[]; mimeType?: string; listMetadata?: boolean; time?: number } = {}) => {
        const ID = `msg-${(messageCounter += 1)}`;
        const stored: any[] = [];
        for (const { ics, name = 'invite.ics', type = 'text/calendar; method=REPLY; charset=UTF-8', bytes, key = tobiKey.publicKey } of attachments) {
            const data = bytes || new TextEncoder().encode(ics || '');
            const packets = await encryptAttachment(data as any, { name, type, size: data.length } as File, false, key);
            const attachmentID = `att-mail-${(attachmentCounter += 1)}`;
            attachmentData.set(attachmentID, packets.data as Uint8Array);
            stored.push({ ID: attachmentID, Name: name, MIMEType: type, Size: data.length, KeyPackets: (packets.keys as Uint8Array).toBase64(), Headers: {} });
        }
        const message: any = {
            ID,
            AddressID: to === ALIAS ? aliasAddress.ID : tobiAddress.ID,
            Subject: subject,
            Sender: { Name: from.split('@')[0], Address: from },
            ToList: to ? [{ Name: 'Tobi', Address: to }] : [],
            Time: time,
            Flags: flags,
            LabelIDs: labels,
            MIMEType: mimeType,
            NumAttachments: stored.length,
            ...(listMetadata ? { AttachmentsMetadata: stored.map(({ ID: id, Name, MIMEType, Size }) => ({ ID: id, Name, MIMEType, Size, Disposition: 'attachment' })) } : {}),
            ParsedHeaders: to ? { 'X-Original-To': to } : {},
            Attachments: stored,
            Body: '-----BEGIN PGP MESSAGE-----'
        };
        messages.set(ID, message);
        return message;
    };
    const resetState = () => {
        api.emailedAnswersState = { processed: new Map(), failures: new Map() };
    };
    const run = (since: number, maxPages?: number) => api.applyEmailedAnswers({ since, ...(maxPages ? { maxPages } : {}) });
    const answerWrites = () => requests.filter((request) => request.method === 'PUT' && /\/attendees\//.test(request.endpoint));
    const opened = () => requests.filter((request) => /^mail\/v4\/messages\/msg-/.test(request.endpoint)).map((request) => request.endpoint.split('/').pop());
    const statusOf = (eventID: string, email: string, tokens: Record<string, string>) =>
        events.get(eventID).AttendeesInfo.Attendees.find((entry: any) => entry.Token === tokens[email]);
    /** Runs over just this email (fresh state, since = its time). */
    const only = async (message: any) => {
        resetState();
        requests.length = 0;
        return run(message.Time);
    };

    // ======================================================================================
    // Setup: a meeting you organize with Anna (Proton), Carla and Dan (outside Proton).
    // ======================================================================================
    const created = await api.saveOrganizedEvent({ calendarID: 'cal-1', vevent: api.parseIcsToVevents(calendarAppIcs())[0] });
    check(created.success, `meeting created (${created.error || 'ok'})`);
    const meetingID = created.eventId;
    const UID = events.get(meetingID).UID;
    // Each guest's answer token, from the decrypted guest list.
    const { readInvitation } = await import('../src/invitations.ts');
    const tokensOf = async (eventID: string) => {
        const invitation = await readInvitation(api.getInvitationContext(), structuredClone(events.get(eventID)));
        return Object.fromEntries(invitation.vevent.attendee.map((attendee: any) => [attendee.value.replace('mailto:', ''), attendee.parameters['x-pm-token']])) as Record<string, string>;
    };
    const tokens = await tokensOf(meetingID);
    check(tokens[CARLA] && tokens[DAN] && tokens[ANNA], 'every guest has an answer token');

    // ======================================================================================
    // 1. Applied: Carla accepts by email.
    // ======================================================================================
    const carlaStamp = clock - 30;
    let message = await mail({ attachments: [{ ics: replyIcs({ uid: UID, answers: { [CARLA]: 'ACCEPTED' }, dtstamp: carlaStamp }) }] });
    let result = await only(message);
    check(!result.error && result.answers.length === 1 && result.answers[0].outcome === 'applied', `Carla's emailed answer is applied (${JSON.stringify(result.answers[0] || result.error)})`);
    const applied = result.answers[0] || {};
    check(applied.answer === 'ACCEPTED' && applied.from === CARLA && applied.to === TOBI && applied.eventUid === UID && applied.eventTitle === 'Project kickoff' && applied.calendarID === 'cal-1' && applied.eventID === meetingID,
        'the report names the guest, your address, the meeting and its calendar');
    check(statusOf(meetingID, CARLA, tokens).Status === 3, 'Proton now has Carla as accepted');
    const write = answerWrites()[0];
    check(answerWrites().length === 1 && write.endpoint === `calendar/v1/cal-1/events/${meetingID}/attendees/${statusOf(meetingID, CARLA, tokens).ID}`,
        `one answer update, for Carla's entry (${write?.endpoint})`);
    check(write?.body.Status === 3 && write?.body.UpdateTime === carlaStamp, `the answer time is the reply's DTSTAMP (${write?.body.UpdateTime - carlaStamp})`);
    check(statusOf(meetingID, ANNA, tokens).Status === 0 && statusOf(meetingID, DAN, tokens).Status === 0, "nobody else's answer changed");
    check(result.opened === 1 && result.cursor === message.Time, `one email opened, cursor at it (${result.opened}, ${result.cursor - message.Time})`);
    check(!requests.some((request) => request.method !== 'GET' && !/\/attendees\//.test(request.endpoint)), 'nothing else is written: no email sent, mailbox untouched');

    // The same email again (e.g. after a restart): Proton already has the answer, nothing reported.
    result = await only(message);
    check(!result.error && result.answers.length === 0 && answerWrites().length === 0, 'the same answer again: nothing to do, nothing reported');
    check(/Proton already has this answer/.test(result.ignored[0]?.why), `… only the log says why (${result.ignored[0]?.why})`);

    // An older answer arriving later (DTSTAMP before the one Proton has): ignored quietly.
    message = await mail({ attachments: [{ ics: replyIcs({ uid: UID, answers: { [CARLA]: 'DECLINED' }, dtstamp: carlaStamp - 3600 }) }] });
    result = await only(message);
    check(result.answers.length === 0 && answerWrites().length === 0 && statusOf(meetingID, CARLA, tokens).Status === 3, 'an older answer is not applied over a newer one');

    // Carla changes her mind to "maybe".
    message = await mail({ subject: 'Tentative: Project kickoff', attachments: [{ ics: replyIcs({ uid: UID, answers: { [CARLA]: 'TENTATIVE' }, dtstamp: clock }) }] });
    result = await only(message);
    check(result.answers[0]?.outcome === 'applied' && statusOf(meetingID, CARLA, tokens).Status === 1, 'a later "maybe" replaces the yes');

    // Case and dots in the sender's address do not matter.
    message = await mail({ from: 'Carla@Example.org', attachments: [{ ics: replyIcs({ uid: UID, answers: { [CARLA]: 'DECLINED' }, dtstamp: clock }) }] });
    result = await only(message);
    check(result.answers[0]?.outcome === 'applied' && statusOf(meetingID, CARLA, tokens).Status === 2, 'sender written with capitals: still Carla');

    // ======================================================================================
    // 2. COUNTER, DTSTAMP missing, Yahoo, duplicate attachments.
    // ======================================================================================
    message = await mail({ from: DAN, attachments: [{ ics: replyIcs({ uid: UID, method: 'COUNTER', answers: { [DAN]: 'ACCEPTED' }, dtstamp: clock }) }] });
    result = await only(message);
    check(result.answers[0]?.outcome === 'applied' && statusOf(meetingID, DAN, tokens).Status === 3, 'a counter-proposal with "yes" applies the yes (like Proton)');
    message = await mail({ from: DAN, attachments: [{ ics: replyIcs({ uid: UID, method: 'COUNTER', answers: { [DAN]: 'NEEDS-ACTION' }, dtstamp: clock }) }] });
    result = await only(message);
    check(result.answers.length === 0 && answerWrites().length === 0, 'a counter-proposal without an answer changes nothing');

    message = await mail({ from: DAN, attachments: [{ ics: replyIcs({ uid: UID, answers: { [DAN]: 'TENTATIVE' } }) }] });
    result = await only(message);
    check(result.answers[0]?.outcome === 'applied' && answerWrites()[0]?.body.UpdateTime === message.Time, 'without DTSTAMP the email\'s time is the answer time');

    message = await mail({
        from: DAN,
        attachments: [{ ics: replyIcs({ uid: UID, answers: { [DAN]: 'DECLINED' }, dtstamp: clock - 99999, extra: ['X-YAHOO-YID:dan123', 'X-YAHOO-USER-STATUS:DECLINED'] }) }]
    });
    result = await only(message);
    check(result.answers[0]?.outcome === 'applied' && answerWrites()[0]?.body.UpdateTime === message.Time && statusOf(meetingID, DAN, tokens).Status === 2,
        'Yahoo: the email\'s time, not its DTSTAMP (Proton\'s workaround)');

    const both = replyIcs({ uid: UID, answers: { [DAN]: 'ACCEPTED' }, dtstamp: clock + 60 });
    message = await mail({ from: DAN, attachments: [{ ics: both, name: 'invite.ics', type: 'application/ics' }, { ics: both, name: 'reply.ics', type: 'text/calendar; method=REPLY' }] });
    result = await only(message);
    check(result.answers.length === 1 && answerWrites().length === 1 && statusOf(meetingID, DAN, tokens).Status === 3, 'the same answer in two attachments counts once');

    // Yahoo puts the answer in X-YAHOO-USER-STATUS and leaves PARTSTAT at NEEDS-ACTION (getAttendeePartstat).
    message = await mail({ from: DAN, attachments: [{ ics: replyIcs({ uid: UID, answers: { [DAN]: 'NEEDS-ACTION' }, extra: ['X-YAHOO-YID:dan123', 'X-YAHOO-USER-STATUS:TENTATIVE'] }) }] });
    result = await only(message);
    check(result.answers[0]?.outcome === 'applied' && result.answers[0]?.answer === 'TENTATIVE' && statusOf(meetingID, DAN, tokens).Status === 1,
        `Yahoo's "maybe" is read from X-YAHOO-USER-STATUS (${result.answers[0]?.answer})`);

    // A DTSTAMP in the future is not trusted beyond the email's arrival.
    message = await mail({ from: DAN, attachments: [{ ics: replyIcs({ uid: UID, answers: { [DAN]: 'ACCEPTED' }, dtstamp: clock + 86400 }) }] });
    result = await only(message);
    check(result.answers[0]?.outcome === 'applied' && answerWrites()[0]?.body.UpdateTime === message.Time, "a future DTSTAMP counts as the email's arrival");

    // DTSTAMP with a time zone (not UTC, against the RFC): read in that zone, like Proton.
    const zoned = clock + 30; // after Dan's last answer, before this email arrives
    const amsterdam = new Date(zoned * 1000).toLocaleString('sv-SE', { timeZone: 'Europe/Amsterdam' }).replace(/[-:]/g, '').replace(' ', 'T');
    message = await mail({ from: DAN, attachments: [{ ics: replyIcs({ uid: UID, answers: { [DAN]: 'DECLINED' }, extra: [`DTSTAMP;TZID=Europe/Amsterdam:${amsterdam}`] }) }] });
    result = await only(message);
    check(result.answers[0]?.outcome === 'applied' && answerWrites()[0]?.body.UpdateTime === zoned, `a DTSTAMP with TZID is read in that zone (${answerWrites()[0]?.body.UpdateTime - zoned})`);

    // ======================================================================================
    // 3. Not applied, with a reason.
    // ======================================================================================
    const before = () => JSON.stringify(events.get(meetingID).AttendeesInfo.Attendees);
    const expectSkip = async (label: string, spec: Parameters<typeof mail>[0], reason: RegExp) => {
        const snapshot = before();
        message = await mail(spec);
        result = await only(message);
        const entry = result.answers[0];
        check(result.answers.length === 1 && entry.outcome === 'skipped' && reason.test(entry.reason || '') && answerWrites().length === 0 && before() === snapshot,
            `${label} (${entry?.outcome}: ${entry?.reason || result.error || 'nothing reported'})`);
    };
    // Dan sends an email that answers for Carla: forged, nothing changes.
    await expectSkip('an answer for someone else than the sender is refused',
        { from: DAN, attachments: [{ ics: replyIcs({ uid: UID, answers: { [CARLA]: 'DECLINED' }, dtstamp: clock + 120 }) }] }, /not the sender's own answer/);
    await expectSkip('an address that only loosely matches a guest (dots) is reported, not applied',
        { from: 'c.arla@example.org', attachments: [{ ics: replyIcs({ uid: UID, answers: { 'c.arla@example.org': 'DECLINED' }, dtstamp: clock + 120 }) }] }, /only loosely matches the guest carla@example\.org/);
    await expectSkip('a sender answering in the name of a loosely matching address is reported, not applied',
        { from: 'c.arla@example.org', attachments: [{ ics: replyIcs({ uid: UID, answers: { [CARLA]: 'DECLINED' }, dtstamp: clock + 120 }) }] }, /only loosely matches the address that answers \(carla@example\.org\)/);
    await expectSkip('a reply without a start time is refused, like Proton',
        { attachments: [{ ics: replyIcs({ uid: UID, answers: { [CARLA]: 'ACCEPTED' }, dtstamp: clock + 120, dtstart: false }) }] }, /no start time/);
    await expectSkip('someone who is not invited cannot answer',
        { from: ELI, attachments: [{ ics: replyIcs({ uid: UID, answers: { [ELI]: 'ACCEPTED' }, dtstamp: clock + 120 }) }] }, /not a guest/);
    await expectSkip('answers to a single occurrence are not applied',
        { attachments: [{ ics: replyIcs({ uid: UID, answers: { [CARLA]: 'ACCEPTED' }, dtstamp: clock + 120, extra: ['RECURRENCE-ID:20261105T090000Z'] }) }] }, /single occurrence/);
    await expectSkip('an answer for a newer version than Proton has is not applied',
        { attachments: [{ ics: replyIcs({ uid: UID, answers: { [CARLA]: 'ACCEPTED' }, sequence: 3, dtstamp: clock + 120 }) }] }, /newer version/);
    // A meeting that no longer exists (or is not yours): nothing to do, only the log says why.
    const expectNoMeeting = async (label: string, uid: string) => {
        const snapshot = before();
        message = await mail({ attachments: [{ ics: replyIcs({ uid, answers: { [CARLA]: 'ACCEPTED' }, dtstamp: clock + 120 }) }] });
        result = await only(message);
        check(result.answers.length === 0 && /no meeting with this UID/.test(result.ignored[0]?.why) && answerWrites().length === 0 && before() === snapshot,
            `${label} (${result.ignored[0]?.why || JSON.stringify(result.answers[0])})`);
    };
    await expectNoMeeting('an answer to a meeting that no longer exists is only logged', 'unknown@example.org');
    // The same UID in a calendar someone shared with you: not your meeting.
    foreignEvents.push({ ...structuredClone(events.get(meetingID)), ID: 'ev-foreign', CalendarID: 'cal-shared', UID: 'shared-meeting@proton.me' });
    await expectNoMeeting('a meeting in a calendar shared with you is not touched', 'shared-meeting@proton.me');
    // Sent to your alias, about a meeting you organize from your main address.
    await expectSkip('a reply to another of your addresses than the meeting\'s is not applied',
        { to: ALIAS, attachments: [{ ics: replyIcs({ uid: UID, organizer: ALIAS, answers: { [CARLA]: 'ACCEPTED' }, dtstamp: clock + 120 }) }] }, /not for a meeting you organize from this address/);
    await expectSkip('an email failing DMARC is not used',
        { flags: RECEIVED | DMARC_FAIL, attachments: [{ ics: replyIcs({ uid: UID, answers: { [CARLA]: 'ACCEPTED' }, dtstamp: clock + 120 }) }] }, /DMARC/);
    await expectSkip('an email Proton marked as phishing is not used',
        { flags: RECEIVED | PHISHING, attachments: [{ ics: replyIcs({ uid: UID, answers: { [CARLA]: 'ACCEPTED' }, dtstamp: clock + 120 }) }] }, /phishing/);
    await expectSkip('an email Proton marked as suspicious is not used (flag beyond 32 bits)',
        { flags: RECEIVED + SUSPICIOUS, attachments: [{ ics: replyIcs({ uid: UID, answers: { [CARLA]: 'ACCEPTED' }, dtstamp: clock + 120 }) }] }, /suspicious/);
    await expectSkip('a PGP/MIME email is not read',
        { mimeType: 'multipart/mixed', attachments: [{ ics: replyIcs({ uid: UID, answers: { [CARLA]: 'ACCEPTED' }, dtstamp: clock + 120 }) }] }, /PGP\/MIME/);
    await expectSkip('an email without X-Original-To is reported',
        { to: null, attachments: [{ ics: replyIcs({ uid: UID, answers: { [CARLA]: 'ACCEPTED' }, dtstamp: clock + 120 }) }] }, /which of your addresses/);
    {
        const snapshot = before();
        message = await mail({ attachments: [{ ics: 'BEGIN:VCALENDAR\r\nMETHOD:REPLY\r\nBEGIN:VEVENT\r\nsecret body line here\r\n;;;\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n' }] });
        result = await only(message);
        const entry = result.answers[0];
        check(!JSON.stringify(result).includes('secret') && before() === snapshot && answerWrites().length === 0,
            `a broken file: nothing applied, its content not repeated in the report (${entry?.reason || 'nothing reported'})`);
    }
    await expectSkip('an attachment that cannot be decrypted is reported, not retried',
        { attachments: [{ ics: replyIcs({ uid: UID, answers: { [CARLA]: 'ACCEPTED' }, dtstamp: clock + 120 }), key: strangerKey.publicKey }] }, /could not be read/);

    // Older version: move the meeting (SEQUENCE 1, answers reset), then a late answer to SEQUENCE 0.
    const moved = await api.saveOrganizedEvent({ calendarID: 'cal-1', eventID: meetingID, vevent: api.parseIcsToVevents(calendarAppIcs({ start: '20261105T140000', end: '20261105T150000' }))[0] });
    check(moved.success && events.get(meetingID).AttendeesInfo.Attendees.every((entry: any) => entry.Status === 0), `meeting moved, answers reset (${moved.error || 'ok'})`);
    await expectSkip('an answer to the previous time of the meeting is not applied',
        { attachments: [{ ics: replyIcs({ uid: UID, answers: { [CARLA]: 'ACCEPTED' }, sequence: 0, dtstamp: clock + 300 }) }] }, /older version/);
    message = await mail({ attachments: [{ ics: replyIcs({ uid: UID, answers: { [CARLA]: 'ACCEPTED' }, sequence: 1, dtstamp: clock + 300 }) }] });
    result = await only(message);
    check(result.answers[0]?.outcome === 'applied' && statusOf(meetingID, CARLA, tokens).Status === 3, 'an answer to the new time is applied');

    // Disabled calendar, and one that needs attention in Proton.
    calendarFlags = 1 | 32;
    await expectSkip('a meeting in a disabled calendar is not changed',
        { from: DAN, attachments: [{ ics: replyIcs({ uid: UID, answers: { [DAN]: 'ACCEPTED' }, sequence: 1, dtstamp: clock + 300 }) }] }, /disabled/);
    calendarFlags = 1 | 4;
    await expectSkip('a meeting in a calendar that needs a reset is not changed',
        { from: DAN, attachments: [{ ics: replyIcs({ uid: UID, answers: { [DAN]: 'ACCEPTED' }, sequence: 1, dtstamp: clock + 300 }) }] }, /needs attention/);
    calendarFlags = 1;

    // ======================================================================================
    // 4. Not ours: nothing reported at all.
    // ======================================================================================
    const expectSilent = async (label: string, spec: Parameters<typeof mail>[0]) => {
        const snapshot = before();
        message = await mail(spec);
        result = await only(message);
        check(!result.error && result.answers.length === 0 && answerWrites().length === 0 && before() === snapshot, `${label} (${JSON.stringify(result.answers[0] || result.error || 'ok')})`);
    };
    await expectSilent('a Proton guest\'s reply (already in the event) is ignored',
        { from: ANNA, attachments: [{ ics: replyIcs({ uid: UID, answers: { [ANNA]: 'ACCEPTED' }, sequence: 1, dtstamp: clock + 300, extra: ['X-PM-PROTON-REPLY;VALUE=BOOLEAN:TRUE'] }) }] });
    check(/Proton guest/.test(result.ignored[0]?.why), `… and the log says why (${result.ignored[0]?.why})`);
    await expectSilent('a reply sent to an address that is not the meeting\'s organizer is ignored',
        { to: ALIAS, attachments: [{ ics: replyIcs({ uid: UID, answers: { [CARLA]: 'ACCEPTED' }, sequence: 1, dtstamp: clock + 300 }) }] });
    check(/not addressed to the organizer/.test(result.ignored[0]?.why), `… and the log says why (${result.ignored[0]?.why})`);
    await expectSilent('an invitation from someone else (METHOD:REQUEST) is not an answer',
        { from: ELI, attachments: [{ ics: replyIcs({ uid: 'their-meeting@example.org', method: 'REQUEST', organizer: ELI, answers: { [TOBI]: 'NEEDS-ACTION' }, dtstamp: clock + 300 }) }] });
    check(result.ignored[0]?.why === 'not an answer (METHOD:REQUEST)', `… and the log says why (${result.ignored[0]?.why})`);
    await expectSilent('an email you sent is not read',
        { flags: SENT, attachments: [{ ics: replyIcs({ uid: UID, answers: { [CARLA]: 'DECLINED' }, sequence: 1, dtstamp: clock + 300 }) }] });
    check(!opened().includes(message.ID), 'an email you sent is not even opened');
    await expectSilent('a calendar part without an .ics name is not read (Proton Mail does not either)',
        { attachments: [{ ics: replyIcs({ uid: UID, answers: { [CARLA]: 'DECLINED' }, sequence: 1, dtstamp: clock + 300 }), name: 'reply' }] });
    check(!opened().includes(message.ID), 'not opened');
    await expectSilent('a bounce is not read',
        { from: 'MAILER-DAEMON@example.org', subject: 'Undelivered Mail Returned to Sender', attachments: [{ ics: replyIcs({ uid: UID, answers: { [CARLA]: 'DECLINED' }, sequence: 1, dtstamp: clock + 300 }) }] });
    await expectSilent('an email in spam is not read',
        { labels: ['4'], attachments: [{ ics: replyIcs({ uid: UID, answers: { [CARLA]: 'DECLINED' }, sequence: 1, dtstamp: clock + 300 }) }] });
    await expectSilent('an email in trash is not read',
        { labels: ['3'], attachments: [{ ics: replyIcs({ uid: UID, answers: { [CARLA]: 'DECLINED' }, sequence: 1, dtstamp: clock + 300 }) }] });

    // Cancelled meeting: STATUS:CANCELLED in the calendar part.
    const second = await api.saveOrganizedEvent({ calendarID: 'cal-1', vevent: api.parseIcsToVevents(calendarAppIcs({ uid: 'second-meeting', summary: 'Retro', guests: [CARLA] }))[0] });
    const secondID = second.eventId;
    const secondUID = events.get(secondID).UID;
    for (const card of events.get(secondID).CalendarEvents) {
        if (card.Type === 2 || card.Type === 0) card.Data = String(card.Data).replace('END:VEVENT', 'STATUS:CANCELLED\r\nEND:VEVENT');
    }
    await expectSkip('a cancelled meeting is not changed',
        { attachments: [{ ics: replyIcs({ uid: secondUID, answers: { [CARLA]: 'ACCEPTED' }, dtstamp: clock + 300 }) }] }, /cancelled/);

    // ======================================================================================
    // 4b. Who the guest is, as Proton identifies guests (answer token from the canonical address).
    // ======================================================================================
    const third = await api.saveOrganizedEvent({ calendarID: 'cal-1', vevent: api.parseIcsToVevents(calendarAppIcs({ uid: 'third-meeting', summary: 'Strict', guests: [JOHN_GMAIL, JOHN_SMITH, JOHNSMITH] }))[0] });
    const thirdID = third.eventId;
    const thirdUID = events.get(thirdID).UID;
    const thirdTokens = await tokensOf(thirdID);
    message = await mail({ from: 'johndoe@gmail.com', attachments: [{ ics: replyIcs({ uid: thirdUID, answers: { [JOHN_GMAIL]: 'ACCEPTED' }, dtstamp: clock }) }] });
    result = await only(message);
    check(result.answers[0]?.outcome === 'applied' && statusOf(thirdID, JOHN_GMAIL, thirdTokens).Status === 3,
        `Gmail without the dot is the same guest (Proton's server says so) (${result.answers[0]?.reason || result.answers[0]?.outcome})`);
    message = await mail({ from: JOHNSMITH, attachments: [{ ics: replyIcs({ uid: thirdUID, answers: { [JOHNSMITH]: 'DECLINED' }, dtstamp: clock }) }] });
    result = await only(message);
    check(result.answers[0]?.outcome === 'applied' && statusOf(thirdID, JOHNSMITH, thirdTokens).Status === 2 && statusOf(thirdID, JOHN_SMITH, thirdTokens).Status === 0,
        'johnsmith@ and john.smith@ at a normal domain are two guests: the answer goes to the sender only');
    // Even if Proton's server ignored dots everywhere (same answer token), the guest's address must be the sender's.
    serverStripsDots = true;
    message = await mail({ from: 'jo.hnsmith@corp.test', attachments: [{ ics: replyIcs({ uid: thirdUID, answers: { 'jo.hnsmith@corp.test': 'ACCEPTED' }, dtstamp: clock }) }] });
    result = await only(message);
    check(result.answers[0]?.outcome === 'skipped' && /only loosely matches the guest/.test(result.answers[0]?.reason) && statusOf(thirdID, JOHNSMITH, thirdTokens).Status === 2,
        `same token by the server's rules, different mailbox: not applied (${result.answers[0]?.reason})`);
    serverStripsDots = false;
    message = await mail({ from: JOHN_SMITH, attachments: [{ ics: replyIcs({ uid: thirdUID, answers: { [JOHN_SMITH]: 'DELEGATED' }, dtstamp: clock }) }] });
    result = await only(message);
    check(result.answers[0]?.outcome === 'skipped' && /DELEGATED/.test(result.answers[0]?.reason) && statusOf(thirdID, JOHN_SMITH, thirdTokens).Status === 0,
        `delegating is reported, not applied (${result.answers[0]?.reason})`);

    // ======================================================================================
    // 5. Dry run: reported, not applied; switching to live applies it.
    // ======================================================================================
    api.configureInvitations({ policy: { mode: 'dry-run', allowlist: [] } });
    resetState();
    requests.length = 0;
    message = await mail({ from: DAN, attachments: [{ ics: replyIcs({ uid: UID, answers: { [DAN]: 'DECLINED' }, sequence: 1, dtstamp: clock + 300 }) }] });
    const dryStart = message.Time;
    result = await run(dryStart);
    check(result.answers.length === 1 && result.answers[0].outcome === 'dry-run' && result.answers[0].answer === 'DECLINED' && answerWrites().length === 0 && statusOf(meetingID, DAN, tokens).Status === 0,
        `dry run: reported, not applied (${result.answers[0]?.outcome})`);
    result = await run(dryStart);
    check(result.answers.length === 0 && result.opened === 0, 'dry run: the same email is not reported twice in a session');
    api.configureInvitations({ policy: { mode: 'live', allowlist: [] } });
    requests.length = 0;
    result = await run(dryStart); // the bridge passes the cursor from before the dry run again
    check(result.answers.length === 1 && result.answers[0].outcome === 'applied' && statusOf(meetingID, DAN, tokens).Status === 2, 'switched to live: what the dry run reported is applied');

    // ======================================================================================
    // 6. The run: candidates, pages, cursor, outages, giving up.
    // ======================================================================================
    resetState();
    requests.length = 0;
    const runStart = clock + 60;
    const pdf = await mail({ from: ELI, subject: 'Slides', attachments: [{ name: 'slides.pdf', type: 'application/pdf', bytes: new Uint8Array([37, 80, 68, 70]) }] });
    const noMetadata = await mail({ from: DAN, listMetadata: false, attachments: [{ ics: replyIcs({ uid: UID, answers: { [DAN]: 'TENTATIVE' }, sequence: 1, dtstamp: clock + 400 }) }] });
    result = await run(runStart);
    check(!opened().includes(pdf.ID), 'an email with only a PDF is not opened');
    check(opened().includes(noMetadata.ID) && result.answers[0]?.outcome === 'applied', 'without attachment details in the list, an email with attachments is opened');
    check(result.cursor === noMetadata.Time, 'cursor at the newest email handled');
    requests.length = 0;
    result = await run(runStart);
    check(result.opened === 0 && result.answers.length === 0, 'next run: handled emails are not opened again');

    // An outage while downloading: the run stops before that email and resumes next time.
    resetState();
    requests.length = 0;
    const outageMail = await mail({ attachments: [{ ics: replyIcs({ uid: UID, answers: { [CARLA]: 'DECLINED' }, sequence: 1, dtstamp: clock + 500 }) }] });
    const afterOutage = await mail({ from: DAN, attachments: [{ ics: replyIcs({ uid: UID, answers: { [DAN]: 'ACCEPTED' }, sequence: 1, dtstamp: clock + 500 }) }] });
    downloadOutages = 3;
    for (let attempt = 0; attempt < 3; attempt += 1) {
        result = await run(outageMail.Time);
    }
    check(result.error && /unavailable/i.test(result.error) && result.cursor === outageMail.Time && result.answers.length === 0 && statusOf(meetingID, CARLA, tokens).Status === 3,
        `an outage stops the run before the email, three times in a row (${result.error})`);
    result = await run(outageMail.Time);
    check(!result.error && result.answers.map((entry: any) => entry.outcome).join() === 'applied,applied' && statusOf(meetingID, CARLA, tokens).Status === 2 && statusOf(meetingID, DAN, tokens).Status === 3,
        'after the outage both emails are applied (outages never make it give up)');
    check(result.cursor === afterOutage.Time, 'cursor moves past both');

    // Proton refuses the update: tried in three runs, then given up so later emails are not blocked.
    resetState();
    const refused = await mail({ attachments: [{ ics: replyIcs({ uid: UID, answers: { [CARLA]: 'ACCEPTED' }, sequence: 1, dtstamp: clock + 600 }) }] });
    const later = await mail({ from: DAN, attachments: [{ ics: replyIcs({ uid: UID, answers: { [DAN]: 'TENTATIVE' }, sequence: 1, dtstamp: clock + 600 }) }] });
    refuseAnswers = 3;
    result = await run(refused.Time);
    check(result.error && result.cursor === refused.Time && statusOf(meetingID, DAN, tokens).Status === 3, `refused once: the run stops (${result.error})`);
    result = await run(refused.Time);
    check(result.error && statusOf(meetingID, DAN, tokens).Status === 3, 'refused twice: still stops');
    result = await run(refused.Time);
    const gaveUp = result.answers.find((entry: any) => entry.messageId === refused.ID);
    check(!result.error && gaveUp?.outcome === 'skipped' && /given up after 3 tries/.test(gaveUp.reason) && statusOf(meetingID, DAN, tokens).Status === 1 && result.cursor === later.Time,
        `refused three times: given up, the later email is applied (${gaveUp?.reason})`);

    // Pages: 250 emails with attachments, two pages per run.
    resetState();
    const pagesStart = clock + 60;
    let last: any;
    for (let index = 0; index < 250; index += 1) {
        last = await mail({ from: ELI, subject: `Report ${index}`, attachments: [{ name: `report-${index}.pdf`, type: 'application/pdf', bytes: new Uint8Array([1]) }] });
    }
    requests.length = 0;
    result = await run(pagesStart, 2);
    check(!result.error && result.more && result.cursor > pagesStart + 150 * 60 && result.cursor < last.Time && requests.filter((request) => request.endpoint === 'mail/v4/messages').length === 2,
        `two list requests per run, then the cursor waits (${(result.cursor - pagesStart) / 60} emails in)`);
    check(requests.filter((request) => request.endpoint === 'mail/v4/messages')[1].query.Begin > pagesStart, 'the second request starts at the newest email seen (not a page offset)');
    result = await run(result.cursor - 600, 2);
    check(!result.error && !result.more && result.cursor === last.Time, 'the next run continues to the end');
    check(requests.filter((request) => request.method === 'GET' && /^mail\/v4\/messages\/msg-/.test(request.endpoint)).length === 0, 'none of them opened (no calendar attachment)');
    check(requests.every((request) => request.endpoint !== 'mail/v4/messages' || (request.query?.LabelID === '15' && request.query?.Attachments === 1 && request.query?.Desc === 0 && !('NewsletterSubscriptionID' in request.query))),
        'the list asks for all mail except spam and trash, with attachments, oldest first');

    // An email trashed while the run is between two list requests does not hide the next one.
    resetState();
    const shiftStart = clock + 60;
    const shiftMails: any[] = [];
    for (let index = 0; index < 100; index += 1) {
        shiftMails.push(await mail({ from: ELI, subject: `Scan ${index}`, attachments: [{ name: `scan-${index}.pdf`, type: 'application/pdf', bytes: new Uint8Array([2]) }] }));
    }
    const afterShift = await mail({ from: DAN, attachments: [{ ics: replyIcs({ uid: UID, answers: { [DAN]: 'DECLINED' }, sequence: 1, dtstamp: clock + 700 }) }] });
    afterList = () => {
        shiftMails[5].LabelIDs = ['3'];
    };
    result = await run(shiftStart);
    check(!result.error && result.answers.some((entry: any) => entry.messageId === afterShift.ID && entry.outcome === 'applied') && result.cursor === afterShift.Time,
        `an email trashed between two list requests does not hide the next one (${JSON.stringify(result.answers.map((entry: any) => entry.outcome))})`);

    // At most 25 emails opened per run; out of time, the run stops before opening more.
    resetState();
    const budgetStart = clock + 60;
    for (let index = 0; index < 27; index += 1) {
        await mail({ from: ELI, subject: `Invitation ${index}`, attachments: [{ ics: replyIcs({ uid: `their-${index}@example.org`, method: 'REQUEST', organizer: ELI, answers: { [TOBI]: 'NEEDS-ACTION' } }), type: 'text/calendar; method=REQUEST' }] });
    }
    result = await run(budgetStart);
    check(!result.error && result.opened === 25 && result.more, `at most 25 emails opened per run (${result.opened})`);
    result = await run(result.cursor - 600);
    check(!result.error && result.opened === 2 && !result.more, `the next run opens the rest (${result.opened})`);
    resetState();
    result = await api.applyEmailedAnswers({ since: budgetStart, budgetMs: -1 });
    check(!result.error && result.opened === 1 && result.more && result.cursor === budgetStart + 0 * 60, `out of time: one email per run at least, then stop (${result.opened})`);

    // ======================================================================================
    // 0.41: replies in Spam (only to an invitation this account sent), replies moved out of Spam
    // (behind the cursor: the look-back), and the guest's note.
    // ======================================================================================
    resetState();
    const spamStart = clock + 60;
    const spamReply = await mail({ from: DAN, labels: ['4'], attachments: [{ ics: replyIcs({ uid: UID, answers: { [DAN]: 'ACCEPTED' }, sequence: 1, dtstamp: clock + 900 }) }] });
    spamReply.ParsedHeaders = { ...spamReply.ParsedHeaders, 'X-Original-To': TOBI, 'In-Reply-To': '<Invite-0001@proton.me>' };
    const spamOther = await mail({ from: DAN, labels: ['4'], attachments: [{ ics: replyIcs({ uid: UID, answers: { [DAN]: 'DECLINED' }, sequence: 1, dtstamp: clock + 960 }) }] });
    spamOther.ParsedHeaders = { ...spamOther.ParsedHeaders, 'X-Original-To': TOBI, 'In-Reply-To': '<somebody-else@example.org>' };
    result = await run(spamStart);
    check(!result.answers.some((entry: any) => entry.messageId === spamReply.ID), 'without the sent Message-IDs, Spam is not read (as before)');
    resetState();
    result = await api.applyEmailedAnswers({ since: spamStart, repliesTo: ['invite-0001@proton.me'] });
    const fromSpam = result.answers.find((entry: any) => entry.messageId === spamReply.ID);
    check(fromSpam?.outcome === 'applied', `a reply in Spam to an invitation this account sent is applied (${fromSpam?.outcome} ${fromSpam?.reason || ''})`);
    check(!result.answers.some((entry: any) => entry.messageId === spamOther.ID), 'a reply in Spam to anything else is not used');
    check(result.cursor === spamStart, `the Spam pass does not move the cursor (${result.cursor} vs ${spamStart})`);
    check(requests.some((request) => request.endpoint === 'mail/v4/messages' && request.query?.LabelID === '4'), 'Spam is listed on its own');

    // A reply moved out of Spam after the cursor passed its arrival time: found by the look-back.
    resetState();
    const movedOut = await mail({ from: DAN, labels: ['4'], attachments: [{ ics: replyIcs({ uid: UID, answers: { [DAN]: 'TENTATIVE' }, sequence: 1, dtstamp: clock + 1200 }) }] });
    movedOut.ParsedHeaders = { ...movedOut.ParsedHeaders, 'X-Original-To': TOBI };
    const pastIt = clock + 600;
    result = await run(pastIt);
    check(!result.answers.some((entry: any) => entry.messageId === movedOut.ID), 'still in Spam, behind the cursor: not seen');
    movedOut.LabelIDs = ['0', '5', '15'];
    result = await run(pastIt);
    check(!result.answers.some((entry: any) => entry.messageId === movedOut.ID), 'moved to the Inbox, without a look-back: missed (the old gap)');
    resetState();
    result = await api.applyEmailedAnswers({ since: pastIt, lookBackFrom: movedOut.Time - 1 });
    const lookedBack = result.answers.find((entry: any) => entry.messageId === movedOut.ID);
    check(lookedBack?.outcome === 'applied', `with the look-back it is applied (${lookedBack?.outcome} ${lookedBack?.reason || ''})`);
    check(result.cursor === pastIt, 'the look-back does not move the cursor');

    // Review fixes: Spam checked and found to answer none of the sent invitations is still read by the
    // look-back once moved out (it may answer an invitation sent from Proton's web app).
    resetState();
    const webReply = await mail({ from: DAN, labels: ['4'], attachments: [{ ics: replyIcs({ uid: UID, answers: { [DAN]: 'ACCEPTED' }, sequence: 1, dtstamp: clock + 1300 }) }] });
    webReply.ParsedHeaders = { ...webReply.ParsedHeaders, 'X-Original-To': TOBI, 'In-Reply-To': '<sent-from-the-web@proton.me>' };
    const webSince = clock + 600;
    result = await api.applyEmailedAnswers({ since: webSince, repliesTo: ['invite-0001@proton.me'], lookBackFrom: webReply.Time - 1 });
    check(!result.answers.some((entry: any) => entry.messageId === webReply.ID), 'in Spam, answering an invitation not in the list: not used');
    webReply.LabelIDs = ['0', '5', '15'];
    result = await api.applyEmailedAnswers({ since: webSince, repliesTo: ['invite-0001@proton.me'], lookBackFrom: webReply.Time - 1 });
    check(result.answers.some((entry: any) => entry.messageId === webReply.ID && entry.outcome === 'applied'), 'moved out of Spam: the look-back reads it (the Spam check did not mark it as handled)');

    // A look-back cut short continues where it got to (same window), instead of starting over.
    resetState();
    const backStart = clock + 60;
    for (let index = 0; index < 120; index += 1) {
        await mail({ from: ELI, subject: `Old ${index}`, attachments: [{ name: `old-${index}.pdf`, type: 'application/pdf', bytes: new Uint8Array([3]) }] });
    }
    const backSince = clock + 600;
    requests.length = 0;
    result = await api.applyEmailedAnswers({ since: backSince, lookBackFrom: backStart, maxPages: 1 });
    check(result.more, 'one page per pass: the look-back is cut short');
    requests.length = 0;
    result = await api.applyEmailedAnswers({ since: backSince, lookBackFrom: backStart, maxPages: 1 });
    const lookBackBegins = requests.filter((request) => request.endpoint === 'mail/v4/messages').map((request) => Number(request.query.Begin));
    check(lookBackBegins.some((begin) => begin > backStart), `the next run continues after the first page (${lookBackBegins.join()})`);
    check(!result.more, `and finishes (${JSON.stringify({ more: result.more, error: result.error, opened: result.opened })})`);

    // The guest's note travels with the answer (COMMENT; Google: X-RESPONSE-COMMENT on the ATTENDEE).
    resetState();
    const noted = await mail({ from: DAN, attachments: [{ ics: replyIcs({ uid: UID, answers: { [DAN]: 'DECLINED' }, sequence: 1, dtstamp: clock + 1500 }).replace('END:VEVENT', 'COMMENT:Sorry\\, I am travelling that week.\r\nEND:VEVENT') }] });
    result = await only(noted);
    check(result.answers[0]?.comment === 'Sorry, I am travelling that week.', `the note is reported with the answer (${JSON.stringify(result.answers[0]?.comment)})`);
    const { replyCommentOf } = await import('../src/emailed-answers.ts');
    check(replyCommentOf({ attendee: [{ value: 'mailto:x@gmail.com', parameters: { 'x-response-comment': 'See you there' } }] }) === 'See you there', "Google's note on the attendee is read too");
    check(replyCommentOf({ attendee: [{ value: 'mailto:x@gmail.com', parameters: {} }] }) === undefined, 'no note: nothing');

    // Not initialized.
    const fresh = new ProtonCalendarAPI({ username: 'u', password: 'p' });
    let refusedUninitialized = false;
    try {
        await fresh.applyEmailedAnswers({ since: 0 });
    } catch {
        refusedUninitialized = true;
    }
    check(refusedUninitialized, 'refuses before sign-in');

    console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll emailed-answer checks passed.');
    process.exit(failures ? 1 : 0);
};

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
