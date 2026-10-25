/**
 * Offline test for moving emails about meetings out of the Inbox once they are dealt with
 * (calendar-emails.ts).
 *
 * The Proton API is faked: the mailbox (Inbox list, full messages, encrypted attachments, folders,
 * moving), the calendar with meetings you organize (created with this client's organizer code) and
 * invitations to you (encrypted like Proton stores them). Checks:
 * - answers to your meetings: waiting until Proton has the answer, then moved; superseded answers and
 *   Proton guests' replies count as dealt with; counter-proposals, answers with a note, loose senders,
 *   single occurrences, answers whose time only looks older, and meetings that are not in your
 *   calendars (unless known to be deleted) stay;
 * - invitations and updates: waiting for your answer or for Proton to apply the update (a newer
 *   SEQUENCE, or a newer DTSTAMP with a change), then moved; outdated versions, removed occurrences and
 *   meetings you removed before the email count as dealt with; re-invitations to a cancelled meeting,
 *   invitations after a removal, not on the guest list, meetings you organize stay;
 * - cancellations: moved once cancelled (single edit or EXDATE) or deleted; not otherwise;
 * - Outlook time zone names, UIDs longer than Proton keeps;
 * - Bin, Archive, a folder found (any case) or created once, folder refused or deleted, ten emails per
 *   request, a refused move, starred / non-Inbox emails untouched (also when starred just before the
 *   move), dry run, outages (nothing moved), limits, paging without duplicates;
 * - nothing written but the moves and the folder.
 * No network, no real account, no emails.
 */
import { CryptoProxy } from '@protontech/crypto';
import { withPmAttendees } from '@proton/shared/lib/calendar/attendees';
import { getCreationKeys } from '@proton/shared/lib/calendar/crypto/keys/helpers';
import { createCalendarEvent } from '@proton/shared/lib/calendar/serialize';
import { loadCryptoWorker } from '@proton/shared/lib/helpers/setupCryptoWorker';
import { encryptAttachment } from '@proton/shared/lib/mail/send/attachments';
import { ProtonCalendarAPI } from '../src/proton-calendar-api.ts';

let failures = 0;
const check = (condition: unknown, label: string) => {
    console.log(`${condition ? 'ok  ' : 'FAIL'} ${label}`);
    if (!condition) failures += 1;
};

const TOBI = 'tobi@proton.test';
const ANNA = 'anna@proton.test'; // a Proton guest
const CARLA = 'carla@example.org'; // guests outside Proton
const DAN = 'dan@example.org';
const JOHN_SMITH = 'john.smith@corp.test';
const JOHNSMITH = 'johnsmith@corp.test';
const BOSS = 'boss@outlook.test'; // organizes meetings you are invited to

const VTIMEZONE = [
    'BEGIN:VTIMEZONE', 'TZID:Europe/Amsterdam',
    'BEGIN:DAYLIGHT', 'TZOFFSETFROM:+0100', 'TZOFFSETTO:+0200', 'TZNAME:CEST', 'DTSTART:19700329T020000',
    'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU', 'END:DAYLIGHT',
    'BEGIN:STANDARD', 'TZOFFSETFROM:+0200', 'TZOFFSETTO:+0100', 'TZNAME:CET', 'DTSTART:19701025T030000',
    'RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU', 'END:STANDARD',
    'END:VTIMEZONE'
].join('\r\n');

const calendarAppIcs = ({ uid, summary, guests }: { uid: string; summary: string; guests: string[] }) =>
    [
        'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Apple Inc.//macOS 26.0//EN',
        'BEGIN:VEVENT', `UID:${uid}`, 'DTSTAMP:20261001T080000Z',
        'DTSTART;TZID=Europe/Amsterdam:20261105T100000', 'DTEND;TZID=Europe/Amsterdam:20261105T110000',
        `SUMMARY:${summary}`, 'SEQUENCE:0',
        `ORGANIZER;CN=Tobi:mailto:${TOBI}`,
        `ATTENDEE;CN=Tobi;CUTYPE=INDIVIDUAL;PARTSTAT=ACCEPTED;ROLE=CHAIR:mailto:${TOBI}`,
        ...guests.map((guest) => `ATTENDEE;CN=${guest.split('@')[0]};CUTYPE=INDIVIDUAL;PARTSTAT=NEEDS-ACTION;ROLE=REQ-PARTICIPANT;RSVP=TRUE:mailto:${guest}`),
        'END:VEVENT', 'END:VCALENDAR', ''
    ].join('\r\n');

const stamp = (unix: number) => new Date(unix * 1000).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

/** A guest's answer like Outlook / Gmail send it. */
const replyIcs = ({ uid, answers, method = 'REPLY', sequence = 0, dtstamp, extra = [] as string[] }:
    { uid: string; answers: Record<string, string>; method?: string; sequence?: number; dtstamp: number; extra?: string[] }) =>
    [
        'BEGIN:VCALENDAR', `METHOD:${method}`, 'PRODID:Microsoft Exchange Server 2010', 'VERSION:2.0',
        'BEGIN:VEVENT',
        ...Object.entries(answers).map(([email, partstat]) => `ATTENDEE;PARTSTAT=${partstat};CN=${email.split('@')[0]}:mailto:${email}`),
        `ORGANIZER;CN=Tobi S:mailto:${TOBI}`, `UID:${uid}`, `SEQUENCE:${sequence}`, `DTSTAMP:${stamp(dtstamp)}`,
        'DTSTART:20261105T090000Z', 'DTEND:20261105T100000Z', 'SUMMARY:Accepted: Project kickoff',
        ...extra,
        'END:VEVENT', 'END:VCALENDAR', ''
    ].join('\r\n');

/** An invitation to you as stored in Proton, or as emailed by the organizer (with a METHOD). */
const invitationIcs = ({
    uid, method, sequence = 0, status, recurrenceId, ridTzid = 'Europe/Amsterdam', rrule, exdates = [], withTobi = true,
    summary = 'Team meeting', location, dtstamp = '20261001T100000Z', organizer = BOSS, carla = 'NEEDS-ACTION'
}: {
    uid: string; method?: string; sequence?: number; status?: string; recurrenceId?: string; ridTzid?: string; rrule?: string;
    exdates?: string[]; withTobi?: boolean; summary?: string; location?: string; dtstamp?: string; organizer?: string; carla?: string;
}) =>
    [
        'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Test//EN', method ? `METHOD:${method}` : '',
        'BEGIN:VEVENT', `UID:${uid}`, dtstamp ? `DTSTAMP:${dtstamp}` : '',
        recurrenceId ? `RECURRENCE-ID;TZID=${ridTzid}:${recurrenceId}` : '',
        `DTSTART;TZID=${ridTzid}:${recurrenceId || '20261005T100000'}`,
        `DTEND;TZID=${ridTzid}:${(recurrenceId || '20261005T100000').replace('T10', 'T11')}`,
        rrule ? `RRULE:${rrule}` : '',
        ...exdates.map((exdate) => `EXDATE;TZID=Europe/Amsterdam:${exdate}`),
        `SUMMARY:${summary}`, location ? `LOCATION:${location}` : '', `SEQUENCE:${sequence}`, status ? `STATUS:${status}` : '',
        `ORGANIZER;CN=Boss:mailto:${organizer}`,
        withTobi ? `ATTENDEE;CN=Tobi;ROLE=REQ-PARTICIPANT;RSVP=TRUE;PARTSTAT=NEEDS-ACTION:mailto:${TOBI}` : '',
        `ATTENDEE;CN=Carla;ROLE=REQ-PARTICIPANT;RSVP=TRUE;PARTSTAT=${carla}:mailto:carla@example.org`,
        'END:VEVENT', 'END:VCALENDAR', ''
    ].filter(Boolean).join('\r\n');

// RECURRENCE-ID 2026-10-12 / 10-19 10:00 Amsterdam (CEST) in UTC, as Proton stores RecurrenceID.
const RID_12 = Date.UTC(2026, 9, 12, 8) / 1000;

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
    const calendarKeys = [{ ID: 'cal-key', privateKey: calendarKey.privateKey, publicKey: calendarKey.publicKey, Key: { ID: 'cal-key', Flags: 3, PassphraseID: 'p' } }];
    const calendarData = { calendarID: 'cal-1', memberID: 'member-1', calendarKeys, calendarSettings: {} };
    const tobiAddress = { ID: 'addr-tobi', Email: TOBI, DisplayName: 'Tobi S', Status: 1, Receive: 1, Send: 1, Type: 1, Order: 1, Keys: [], SignedKeyList: null };

    // ---- Fake Proton: calendar ----
    type Request = { method: string; endpoint: string; body?: any; query?: any };
    const requests: Request[] = [];
    const events = new Map<string, any>();
    let eventCounter = 0;
    let attendeeCounter = 0;
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
    /** An invitation to you in your calendar, encrypted like Proton stores it. */
    const addInvitation = async ({ id, tobiStatus = 0, recurrenceID = null, ...ics }: Parameters<typeof invitationIcs>[0] & { id: string; tobiStatus?: number; recurrenceID?: number | null }) => {
        const helper: any = new ProtonCalendarAPI({ username: 'u', password: 'p' });
        const [vevent] = helper.parseIcsToVevents(invitationIcs(ics));
        const withTokens = await withPmAttendees(vevent, async (emails: string[]) => Object.fromEntries(emails.map((email) => [email, email])));
        const creationKeys = await getCreationKeys({ newAddressKeys: tobiAddressKeys as any, newCalendarKeys: calendarKeys as any });
        const data: any = await createCalendarEvent({ eventComponent: withTokens, isCreateEvent: true, isSwitchCalendar: false, hasDefaultNotifications: true, ...creationKeys } as any);
        const tokens = withTokens.attendee.map((attendee: any) => attendee.parameters['x-pm-token']);
        const emails = withTokens.attendee.map((attendee: any) => attendee.value.replace('mailto:', ''));
        const event: any = {
            ID: id, CalendarID: 'cal-1', UID: ics.uid, FullDay: 0, Color: null, IsOrganizer: 0, IsProtonProtonInvite: 0,
            RecurrenceID: recurrenceID,
            SharedKeyPacket: data.SharedKeyPacket, CalendarKeyPacket: data.CalendarKeyPacket, AddressKeyPacket: null, AddressID: null,
            SharedEvents: data.SharedEventContent || [], CalendarEvents: data.CalendarEventContent || [], AttendeesEvents: data.AttendeesEventContent || [],
            AttendeesInfo: {
                Attendees: tokens.map((Token: string, index: number) => ({ ID: `att-${(attendeeCounter += 1)}`, Token, Status: emails[index] === TOBI ? tobiStatus : 3 })),
                MoreAttendees: 0
            },
            Notifications: null
        };
        events.set(id, event);
        return event;
    };
    const answerAs = (eventID: string, status: number) => {
        // Tobi is the first attendee of every invitation here.
        events.get(eventID).AttendeesInfo.Attendees[0].Status = status;
    };

    // ---- Fake Proton: mailbox ----
    const messages = new Map<string, any>();
    const attachmentData = new Map<string, Uint8Array>();
    const folders: any[] = [];
    let refuseFolder = false;
    let refuseMove: string | null = null; // a message ID Proton refuses to move
    let listOutages = 0;
    let failLookupFor: string | null = null; // a UID whose lookup answers 503
    let afterList: (() => void) | null = null; // runs once after the next list request
    let leak: string | null = null; // a message the Inbox list returns although it is not in the Inbox
    let attachmentCounter = 0;
    const metadataOf = (message: any) => {
        const { ParsedHeaders, Attachments, Body, ...metadata } = message;
        return metadata;
    };
    const SYSTEM_LABELS = new Set(['0', '3', '4', '6']);

    const route = (method: string, endpoint: string, body: any, query: any) => {
        requests.push({ method, endpoint, body, query });
        let match: RegExpMatchArray | null;
        if (method === 'GET' && endpoint === 'calendar/v1') {
            return respond({ Calendars: [{ ID: 'cal-1', Type: 0, Owner: { Email: TOBI }, Members: [{ ID: 'member-1', AddressID: tobiAddress.ID, Email: TOBI, Permissions: 127, Flags: 1 }] }] });
        }
        if (method === 'GET' && endpoint.startsWith('core/v4/addresses/canonical?')) {
            const emails = [...endpoint.matchAll(/Emails\[\]=([^&]+)/g)].map((entry) => decodeURIComponent(entry[1]));
            return respond({ Responses: emails.map((Email) => ({ Email, Response: { Code: 1000, CanonicalEmail: Email.toLowerCase() } })) });
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
            if (failLookupFor === query.UID) return { status: 503, data: { Code: 503, Error: 'Service unavailable' } };
            return respond({ Events: [...events.values()].filter((event) => event.UID === query.UID).map((event) => structuredClone(event)) });
        }
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
                data: { Code: 1001, Responses: responses.map((entry: any, Index: number) => ({ Index, ...entry })).filter((_: any, index: number) => body.Events[index].DeletionReason === undefined) }
            };
        }
        if (method === 'POST' && endpoint === 'mail/v4/messages/send/direct') return respond({ Sent: { ID: 'sent' } });
        if (method === 'GET' && endpoint === 'mail/v4/messages') {
            if (listOutages > 0) {
                listOutages -= 1;
                return { status: 503, data: { Code: 503, Error: 'Service unavailable' } };
            }
            const begin = Number(query?.Begin || 0);
            const list = [...messages.values()]
                .filter((message) => message.Time >= begin && message.NumAttachments > 0 && ((message.LabelIDs || []).includes(String(query?.LabelID)) || message.ID === leak))
                .sort((a, b) => (Number(query?.Desc) ? b.Time - a.Time : a.Time - b.Time) || a.ID.localeCompare(b.ID));
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
        if (method === 'GET' && endpoint === 'core/v4/labels') {
            return respond({ Labels: Number(query?.Type) === 3 ? structuredClone(folders) : [] });
        }
        if (method === 'POST' && endpoint === 'core/v4/labels') {
            if (refuseFolder) return { status: 422, data: { Code: 2500, Error: 'You have reached the maximum number of folders' } };
            const label = { ID: `folder-${folders.length + 1}`, Name: body.Name, Color: body.Color, Type: body.Type, ParentID: body.ParentID, Notify: body.Notify, Path: body.Name };
            folders.push(label);
            return respond({ Label: structuredClone(label) });
        }
        if (method === 'PUT' && endpoint === 'mail/v4/messages/label') {
            const exclusive = new Set([...SYSTEM_LABELS, ...folders.map(({ ID }) => ID)]);
            const Responses = body.IDs.map((ID: string) => {
                const message = messages.get(ID);
                if (!exclusive.has(body.LabelID)) return { ID, Response: { Code: 2501, Error: 'Label does not exist' } };
                if (!message || ID === refuseMove) return { ID, Response: { Code: 2501, Error: 'Message cannot be moved' } };
                message.LabelIDs = [...message.LabelIDs.filter((label: string) => !exclusive.has(label)), body.LabelID];
                return { ID, Response: { Code: 1000 } };
            });
            return { status: 200, data: { Code: 1001, Responses, UndoToken: { Token: 'undo' } } };
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
    api.makeApiRequest = async (endpoint: string, method: string, body: any, query: any) => route(method, endpoint, body, query);
    api.makeBinaryRequest = async (endpoint: string) => {
        requests.push({ method: 'GET', endpoint });
        const data = attachmentData.get(endpoint.split('/').pop()!);
        if (!data) {
            const error: any = new Error('Attachment does not exist');
            error.status = 422;
            throw error;
        }
        return data.slice().buffer;
    };
    api.configureInvitations({ prodId: '-//Neutron Calendar Bridge//EN', policy: { mode: 'live', allowlist: [] } });

    const RECEIVED = 1;
    const DMARC_FAIL = 2 ** 26;
    let clock = Math.floor(Date.now() / 1000) - 6 * 3600;
    let messageCounter = 0;
    /** An email in your mailbox (Inbox by default), its calendar file encrypted to your address key. */
    const mail = async ({ from = CARLA, subject = 'Accepted: Project kickoff', ics, labels = ['0', '5', '15'], flags = RECEIVED, time = (clock += 60), name = 'invite.ics' }:
        { from?: string; subject?: string; ics?: string; labels?: string[]; flags?: number; time?: number; name?: string }) => {
        const ID = `msg-${(messageCounter += 1)}`;
        const stored: any[] = [];
        if (ics !== undefined) {
            const data = new TextEncoder().encode(ics);
            const packets = await encryptAttachment(data as any, { name, type: 'text/calendar; charset=UTF-8', size: data.length } as File, false, tobiKey.publicKey);
            const attachmentID = `att-mail-${(attachmentCounter += 1)}`;
            attachmentData.set(attachmentID, packets.data as Uint8Array);
            stored.push({ ID: attachmentID, Name: name, MIMEType: 'text/calendar', Size: data.length, KeyPackets: (packets.keys as Uint8Array).toBase64(), Headers: {} });
        } else {
            stored.push({ ID: `att-mail-${(attachmentCounter += 1)}`, Name: 'report.pdf', MIMEType: 'application/pdf', Size: 10, KeyPackets: '', Headers: {} });
        }
        const message: any = {
            ID, AddressID: tobiAddress.ID, Subject: subject, Sender: { Name: from.split('@')[0], Address: from }, ToList: [{ Name: 'Tobi', Address: TOBI }],
            Time: time, Flags: flags, LabelIDs: labels, MIMEType: 'text/html', NumAttachments: stored.length,
            AttachmentsMetadata: stored.map(({ ID: id, Name, MIMEType, Size }) => ({ ID: id, Name, MIMEType, Size, Disposition: 'attachment' })),
            ParsedHeaders: { 'X-Original-To': TOBI }, Attachments: stored, Body: '-----BEGIN PGP MESSAGE-----'
        };
        messages.set(ID, message);
        return message;
    };
    const inInbox = (message: any) => messages.get(message.ID).LabelIDs.includes('0');
    const labelsOf = (message: any) => messages.get(message.ID).LabelIDs as string[];
    const reset = () => {
        api.calendarEmailsState = { emails: new Map() };
        requests.length = 0;
    };
    /** Meetings known to be deleted (passed by the caller, e.g. the bridge saw them disappear). */
    const goneMeetings: Array<{ uid: string; at: number }> = [];
    const runWrites: Request[] = [];
    const run = async (input: any = {}) => {
        const start = requests.length;
        const result = await api.fileCalendarEmails({ moveTo: 'archive', goneMeetings, ...input });
        runWrites.push(...requests.slice(start).filter((request) => request.method !== 'GET'));
        return result;
    };
    const filedIds = (result: any, outcome = 'moved') => result.filed.filter((entry: any) => entry.outcome === outcome).map((entry: any) => entry.messageId);
    const writes = () => requests.filter((request) => request.method !== 'GET');
    const leftFor = (result: any, message: any) => result.left.find((entry: any) => entry.messageId === message.ID);
    /** Clears the Inbox of earlier cases (as if Tobi had dealt with them). */
    const clearInbox = () => {
        for (const message of messages.values()) message.LabelIDs = message.LabelIDs.filter((label: string) => label !== '0');
    };
    /** A cancellation for a meeting known to be deleted: an email that is always dealt with. */
    let disposable = 0;
    const doneMail = async () => {
        const uid = `deleted-${(disposable += 1)}@outlook.test`;
        goneMeetings.push({ uid, at: clock });
        return mail({ from: BOSS, subject: 'Canceled: Old meeting', ics: invitationIcs({ uid, method: 'CANCEL', status: 'CANCELLED', sequence: 1 }) });
    };

    // ======================================================================================
    // Setup: a meeting you organize with Anna (Proton), Carla, Dan and the two John Smiths.
    // ======================================================================================
    const created = await api.saveOrganizedEvent({ calendarID: 'cal-1', vevent: api.parseIcsToVevents(calendarAppIcs({ uid: 'kickoff', summary: 'Project kickoff', guests: [ANNA, CARLA, DAN, JOHNSMITH] }))[0] });
    check(created.success, `meeting created (${created.error || 'ok'})`);
    const meetingID = created.eventId;
    const UID = events.get(meetingID).UID;
    const { readInvitation } = await import('../src/invitations.ts');
    const invitation = await readInvitation(api.getInvitationContext(), structuredClone(events.get(meetingID)));
    const tokens = Object.fromEntries(invitation.vevent.attendee.map((attendee: any) => [attendee.value.replace('mailto:', ''), attendee.parameters['x-pm-token']])) as Record<string, string>;
    const guestEntry = (email: string) => events.get(meetingID).AttendeesInfo.Attendees.find((entry: any) => entry.Token === tokens[email]);
    /** Proton records a guest's answer (as it now does by itself for emailed answers). */
    const protonRecords = (email: string, status: number, updateTime: number) => {
        const entry = guestEntry(email);
        entry.Status = status;
        entry.UpdateTime = updateTime;
    };
    reset();

    // ======================================================================================
    // 1. Answers to your meeting.
    // ======================================================================================
    const carlaStamp = clock;
    const carla = await mail({ ics: replyIcs({ uid: UID, answers: { [CARLA]: 'ACCEPTED' }, dtstamp: carlaStamp }) });
    let result = await run();
    check(!result.error && result.filed.length === 0 && result.waiting === 1 && inInbox(carla), `Proton does not have Carla's answer yet: it waits in the Inbox (${JSON.stringify(result.filed)} ${result.error || ''})`);
    check(!writes().length, 'nothing written while waiting');
    requests.length = 0;
    result = await run();
    check(result.checked === 0 && result.waiting === 1 && !requests.some((request) => /calendar\/v1\/events/.test(request.endpoint)), 'not checked again before its time');
    protonRecords(CARLA, 3, carlaStamp);
    requests.length = 0;
    result = await run({ changedUids: [UID] });
    check(filedIds(result).join() === carla.ID && !inInbox(carla) && labelsOf(carla).includes('6'), `Carla's answer is in Proton: moved to the Archive (${JSON.stringify(result.filed)})`);
    const filed = result.filed[0] || {};
    check(filed.kind === 'answer' && filed.destination === 'Archive' && filed.eventTitle === 'Project kickoff' && /Proton has this answer/.test(filed.why) && filed.from === CARLA,
        `the report says what, where and why (${filed.kind}, ${filed.destination}, ${filed.eventTitle}, ${filed.why})`);
    const moves = writes();
    check(moves.length === 1 && moves[0].endpoint === 'mail/v4/messages/label' && moves[0].body.LabelID === '6' && moves[0].body.IDs.join() === carla.ID, 'one move request, with the Archive label');
    check(requests.some((request) => request.endpoint === `mail/v4/messages/${carla.ID}`), 'the email is looked at again right before the move');

    // Answers superseded by a later one Proton recorded after the email arrived: moved.
    const superseded = await mail({ from: DAN, ics: replyIcs({ uid: UID, answers: { [DAN]: 'ACCEPTED' }, dtstamp: clock }) });
    protonRecords(DAN, 2, clock + 10);
    result = await run();
    check(filedIds(result).join() === superseded.ID, 'an answer superseded by a later one from the same guest is moved');
    // An answer whose time stamp merely looks older than Proton's (and says something else): stays.
    const olderLooking = await mail({ ics: replyIcs({ uid: UID, answers: { [CARLA]: 'DECLINED' }, dtstamp: carlaStamp - 3600 }) });
    result = await run();
    check(inInbox(olderLooking) && /another answer from this guest/.test(leftFor(result, olderLooking)?.why), `a different answer with an older time stamp stays (${leftFor(result, olderLooking)?.why})`);

    // Counter-proposals and answers with a note: stay even though Proton has the answer.
    const counter = await mail({ subject: 'New Time Proposed: Project kickoff', ics: replyIcs({ uid: UID, method: 'COUNTER', answers: { [CARLA]: 'ACCEPTED' }, dtstamp: carlaStamp }) });
    const noted = await mail({ ics: replyIcs({ uid: UID, answers: { [CARLA]: 'ACCEPTED' }, dtstamp: carlaStamp, extra: ['COMMENT:Can I bring Dan?'] }) });
    const googleNote = await mail({ ics: replyIcs({ uid: UID, answers: { [CARLA]: 'ACCEPTED' }, dtstamp: carlaStamp }).replace(`ATTENDEE;PARTSTAT=ACCEPTED;CN=carla`, 'ATTENDEE;PARTSTAT=ACCEPTED;X-RESPONSE-COMMENT="Running late";CN=carla') });
    result = await run();
    check(inInbox(counter) && /proposes another time/.test(leftFor(result, counter)?.why), 'a counter-proposal stays (the proposed time is only in the email)');
    check(inInbox(noted) && /note/.test(leftFor(result, noted)?.why), 'an answer with a COMMENT stays');
    check(inInbox(googleNote) && /note/.test(leftFor(result, googleNote)?.why), "an answer with Google's X-RESPONSE-COMMENT stays");
    check(leftFor(result, noted)?.note === 'Can I bring Dan?' && leftFor(result, googleNote)?.note === 'Running late', `and the note itself goes to the caller, for the Overview (0.41.10) (${leftFor(result, noted)?.note} / ${leftFor(result, googleNote)?.note})`);

    // A loosely matching sender, an answer to one occurrence: stay, reported once.
    const loose = await mail({ from: JOHN_SMITH, ics: replyIcs({ uid: UID, answers: { [JOHN_SMITH]: 'ACCEPTED' }, dtstamp: clock }) });
    const occurrence = await mail({ ics: replyIcs({ uid: UID, answers: { [CARLA]: 'ACCEPTED' }, dtstamp: clock + 5, extra: ['RECURRENCE-ID:20261105T090000Z'] }) });
    result = await run();
    check(inInbox(loose) && /loosely matches/.test(leftFor(result, loose)?.why), 'a loosely matching sender stays');
    check(inInbox(occurrence) && /single occurrence/.test(leftFor(result, occurrence)?.why), 'an answer to one occurrence stays');
    result = await run({ changedUids: [UID] });
    check(!leftFor(result, loose) && result.leftCount >= 2, '… each reported only once');

    // A Proton guest's reply: waits until Proton has it, then moved.
    const annaStamp = clock;
    const anna = await mail({ from: ANNA, ics: replyIcs({ uid: UID, answers: { [ANNA]: 'ACCEPTED' }, dtstamp: annaStamp, extra: ['X-PM-PROTON-REPLY;VALUE=BOOLEAN:TRUE'] }) });
    result = await run();
    check(inInbox(anna) && !filedIds(result).includes(anna.ID), 'a Proton guest\'s reply waits while Proton does not show the answer');
    protonRecords(ANNA, 3, annaStamp);
    result = await run({ changedUids: [UID] });
    check(filedIds(result).join() === anna.ID, 'and is moved once it does');

    // Failing DMARC: never opened, stays. Starred / not in the Inbox: never touched.
    const forged = await mail({ ics: replyIcs({ uid: UID, answers: { [CARLA]: 'DECLINED' }, dtstamp: clock }), flags: RECEIVED | DMARC_FAIL });
    const starred = await mail({ ics: replyIcs({ uid: UID, answers: { [CARLA]: 'ACCEPTED' }, dtstamp: carlaStamp }), labels: ['0', '5', '10', '15'] });
    const archived = await mail({ ics: replyIcs({ uid: UID, answers: { [CARLA]: 'ACCEPTED' }, dtstamp: carlaStamp }), labels: ['6', '5', '15'] });
    leak = archived.ID; // even if Proton's list returned it for the Inbox
    requests.length = 0;
    result = await run();
    leak = null;
    check(inInbox(forged) && !requests.some((request) => request.endpoint === `mail/v4/messages/${forged.ID}`) && /DMARC/.test(leftFor(result, forged)?.why), 'an email failing DMARC is not opened and stays');
    check(inInbox(starred) && labelsOf(archived).join() === '6,5,15' && !writes().length, 'a starred email and one outside the Inbox are left alone');
    check(!requests.some((request) => [starred.ID, archived.ID].some((id) => request.endpoint === `mail/v4/messages/${id}`)), '… and not even opened');

    // An email without a calendar file: not opened.
    const pdf = await mail({ subject: 'Report' });
    requests.length = 0;
    await run();
    check(!requests.some((request) => request.endpoint === `mail/v4/messages/${pdf.ID}`) && inInbox(pdf), 'an email without a calendar file is not opened');

    // A meeting that is not in your calendars (organized elsewhere, or deleted): stays, unless known deleted.
    clearInbox();
    reset();
    const elsewhere = await mail({ from: DAN, ics: replyIcs({ uid: 'organized-in-icloud@example.org', answers: { [DAN]: 'DECLINED' }, dtstamp: clock }) });
    result = await run();
    check(inInbox(elsewhere) && /not in your calendars/.test(leftFor(result, elsewhere)?.why), 'an answer to a meeting that is not in your calendars stays');
    goneMeetings.push({ uid: 'organized-in-icloud@example.org', at: clock });
    result = await run({ changedUids: ['organized-in-icloud@example.org'] });
    check(filedIds(result).join() === elsewhere.ID && /deleted/.test(result.filed[0]?.why), 'known to be deleted from your calendar: moved');

    // ======================================================================================
    // 2. Invitations and updates to you.
    // ======================================================================================
    clearInbox();
    reset();
    await addInvitation({ id: 'inv-1', uid: 'team@outlook.test', tobiStatus: 0 });
    const invite = await mail({ from: BOSS, subject: 'Invitation: Team meeting', ics: invitationIcs({ uid: 'team@outlook.test', method: 'REQUEST' }) });
    result = await run();
    check(inInbox(invite) && result.waiting === 1 && result.filed.length === 0, 'an invitation you have not answered waits in the Inbox');
    answerAs('inv-1', 3);
    result = await run({ changedUids: ['team@outlook.test'] });
    check(filedIds(result).join() === invite.ID && result.filed[0]?.kind === 'invitation' && result.filed[0]?.why === 'you answered (yes)' && result.filed[0]?.eventTitle === 'Team meeting',
        `answered: the invitation is moved (${result.filed[0]?.why})`);

    // An update with a newer SEQUENCE: waits until Proton has it; then moved (you had answered).
    const update = await mail({ from: BOSS, subject: 'Updated invitation: Team meeting', ics: invitationIcs({ uid: 'team@outlook.test', method: 'REQUEST', sequence: 1, summary: 'Team meeting (new room)', dtstamp: '20261002T100000Z' }) });
    result = await run();
    check(inInbox(update) && result.waiting === 1, 'an update not yet in your calendar waits');
    await addInvitation({ id: 'inv-1', uid: 'team@outlook.test', sequence: 1, tobiStatus: 3, summary: 'Team meeting (new room)', dtstamp: '20261002T100000Z' });
    result = await run({ changedUids: ['team@outlook.test'] });
    check(filedIds(result).join() === update.ID && result.filed[0]?.kind === 'update', 'the update is in your calendar and you had answered: moved');

    // Same SEQUENCE, newer DTSTAMP, a new place: Proton applies it when opened, so it waits.
    const room = await mail({ from: BOSS, subject: 'Updated: Team meeting', ics: invitationIcs({ uid: 'team@outlook.test', method: 'REQUEST', sequence: 1, summary: 'Team meeting (new room)', location: 'Room 5', dtstamp: '20261003T100000Z' }) });
    result = await run();
    check(inInbox(room) && result.waiting === 1, 'a same-version update with a newer time stamp and a new place waits');
    await addInvitation({ id: 'inv-1', uid: 'team@outlook.test', sequence: 1, tobiStatus: 3, summary: 'Team meeting (new room)', location: 'Room 5', dtstamp: '20261003T100000Z' });
    result = await run({ changedUids: ['team@outlook.test'] });
    check(filedIds(result).join() === room.ID, '… and is moved once the new place is in your calendar');
    // Same SEQUENCE, newer DTSTAMP, nothing changed (a resend with everyone's answers as in Proton): moved.
    const resend = await mail({ from: BOSS, ics: invitationIcs({ uid: 'team@outlook.test', method: 'REQUEST', sequence: 1, summary: 'Team meeting (new room)', location: 'Room 5', dtstamp: '20261003T120000Z', carla: 'ACCEPTED' }) });
    result = await run();
    check(filedIds(result).join() === resend.ID, 'a resend without changes is moved');
    // A resend showing another guest's answer differently counts as a change for Proton (getIsEquivalentAttendee): waits.
    const guestsDiffer = await mail({ from: BOSS, ics: invitationIcs({ uid: 'team@outlook.test', method: 'REQUEST', sequence: 1, summary: 'Team meeting (new room)', location: 'Room 5', dtstamp: '20261003T130000Z' }) });
    result = await run();
    check(inInbox(guestsDiffer) && !filedIds(result).includes(guestsDiffer.ID), 'a resend whose guest list differs from Proton\'s waits for Proton to apply it');

    // An update that needs a new answer (Proton reset it): waits for your answer.
    const moved = await mail({ from: BOSS, ics: invitationIcs({ uid: 'team@outlook.test', method: 'REQUEST', sequence: 2, dtstamp: '20261004T100000Z' }) });
    await addInvitation({ id: 'inv-1', uid: 'team@outlook.test', sequence: 2, tobiStatus: 0, dtstamp: '20261004T100000Z' });
    result = await run();
    check(inInbox(moved) && !filedIds(result).includes(moved.ID), 'an update whose answer Proton reset waits for your answer');
    answerAs('inv-1', 1);
    result = await run({ changedUids: ['team@outlook.test'] });
    check(filedIds(result).includes(moved.ID) && /maybe/.test(result.filed.find((entry: any) => entry.messageId === moved.ID)?.why), 'answered "maybe": moved');
    // An old version arriving late: moved even while the current one waits for you.
    const stale = await mail({ from: BOSS, ics: invitationIcs({ uid: 'team@outlook.test', method: 'REQUEST', sequence: 1 }) });
    answerAs('inv-1', 0);
    result = await run();
    check(filedIds(result).join() === stale.ID && /newer version/.test(result.filed[0]?.why), 'an older version of the invitation is moved');

    // Re-invited to a cancelled meeting (a newer version than the cancellation): waits for you.
    await addInvitation({ id: 'inv-2', uid: 'restored@outlook.test', sequence: 1, status: 'CANCELLED', tobiStatus: 3, dtstamp: '20261002T100000Z' });
    const reinvite = await mail({ from: BOSS, ics: invitationIcs({ uid: 'restored@outlook.test', method: 'REQUEST', sequence: 2, dtstamp: '20261003T100000Z' }) });
    const beforeCancel = await mail({ from: BOSS, ics: invitationIcs({ uid: 'restored@outlook.test', method: 'REQUEST', sequence: 0 }) });
    result = await run();
    check(inInbox(reinvite) && !filedIds(result).includes(reinvite.ID), 're-invited to a cancelled meeting: stays for your answer');
    check(filedIds(result).includes(beforeCancel.ID), 'the invitation from before the cancellation is moved');

    // Not in your calendars: waits. Removed by you after it arrived: moved. Arrived after the removal: waits.
    const gone = await mail({ from: BOSS, ics: invitationIcs({ uid: 'removed@outlook.test', method: 'REQUEST' }) });
    result = await run();
    check(inInbox(gone) && !filedIds(result).includes(gone.ID), 'an invitation that is not in your calendars waits');
    goneMeetings.push({ uid: 'removed@outlook.test', at: clock + 1 });
    const again = await mail({ from: BOSS, subject: 'Invitation (again)', ics: invitationIcs({ uid: 'removed@outlook.test', method: 'REQUEST', sequence: 1, dtstamp: '20261005T100000Z' }), time: clock + 120 });
    result = await run({ changedUids: ['removed@outlook.test'] });
    check(filedIds(result).join() === gone.ID && /you removed/.test(result.filed[0]?.why), 'removed from your calendar after it arrived: moved');
    check(inInbox(again), 'a new invitation after the removal stays');

    // Not on the guest list, or a meeting you organize: stays.
    await addInvitation({ id: 'inv-3', uid: 'group@outlook.test', withTobi: false });
    const group = await mail({ from: BOSS, ics: invitationIcs({ uid: 'group@outlook.test', method: 'REQUEST', withTobi: false }) });
    const own = await mail({ from: TOBI, ics: invitationIcs({ uid: 'kickoff-copy', method: 'REQUEST', organizer: TOBI }) });
    result = await run();
    check(inInbox(group) && /guest list/.test(leftFor(result, group)?.why), 'not on the guest list: stays');
    check(inInbox(own) && /you organize/.test(leftFor(result, own)?.why), 'an invitation you organize yourself: stays');

    // An update without DTSTAMP (the email's arrival counts, like Proton) with a new place: waits.
    await addInvitation({ id: 'inv-nostamp', uid: 'nostamp@outlook.test', tobiStatus: 3 });
    const noStamp = await mail({ from: BOSS, ics: invitationIcs({ uid: 'nostamp@outlook.test', method: 'REQUEST', location: 'Room 9', dtstamp: '' }) });
    result = await run();
    check(inInbox(noStamp) && !filedIds(result).includes(noStamp.ID), 'an update without DTSTAMP and with a new place waits for Proton');

    // Marked deleted, but one occurrence of it is still in your calendar: the series invitation stays.
    await addInvitation({ id: 'orph-12', uid: 'orph@outlook.test', recurrenceId: '20261012T100000', recurrenceID: RID_12, tobiStatus: 3 });
    const orphan = await mail({ from: BOSS, ics: invitationIcs({ uid: 'orph@outlook.test', method: 'REQUEST', rrule: 'FREQ=WEEKLY;COUNT=6' }) });
    goneMeetings.push({ uid: 'orph@outlook.test', at: clock + 600 });
    result = await run({ changedUids: ['orph@outlook.test'] });
    check(inInbox(orphan) && !filedIds(result).includes(orphan.ID), 'a deletion does not count while part of the meeting is still in your calendar');

    // Occurrences of a weekly meeting.
    clearInbox();
    reset();
    const RRULE = 'FREQ=WEEKLY;COUNT=6';
    await addInvitation({ id: 'series', uid: 'weekly@outlook.test', rrule: RRULE, exdates: ['20261019T100000'], sequence: 2, tobiStatus: 3 });
    await addInvitation({ id: 'edit-12', uid: 'weekly@outlook.test', recurrenceId: '20261012T100000', recurrenceID: RID_12, sequence: 1, tobiStatus: 2 });
    const editMail = await mail({ from: BOSS, ics: invitationIcs({ uid: 'weekly@outlook.test', method: 'REQUEST', recurrenceId: '20261012T100000', sequence: 1 }) });
    const outlookTz = await mail({ from: BOSS, ics: invitationIcs({ uid: 'weekly@outlook.test', method: 'REQUEST', recurrenceId: '20261012T100000', ridTzid: 'W. Europe Standard Time', sequence: 1 }) });
    const removedMail = await mail({ from: BOSS, ics: invitationIcs({ uid: 'weekly@outlook.test', method: 'REQUEST', recurrenceId: '20261019T100000', sequence: 1 }) });
    const pendingEdit = await mail({ from: BOSS, ics: invitationIcs({ uid: 'weekly@outlook.test', method: 'REQUEST', recurrenceId: '20261026T100000', sequence: 1 }) });
    result = await run();
    check(filedIds(result).includes(editMail.ID) && filedIds(result).includes(outlookTz.ID), `a changed occurrence you answered is moved, also with Outlook's time zone name (${leftFor(result, outlookTz)?.why || 'ok'})`);
    check(filedIds(result).includes(removedMail.ID), 'a change to an occurrence removed since is moved');
    check(inInbox(pendingEdit) && !filedIds(result).includes(pendingEdit.ID), 'a change to an occurrence Proton has not added yet waits (even though the series has a newer SEQUENCE)');

    // A UID longer than Proton keeps (191 characters): still found.
    const longUid = `${'x'.repeat(220)}@outlook.test`;
    await addInvitation({ id: 'inv-long', uid: longUid.slice(-191), tobiStatus: 3 });
    const longCancel = await mail({ from: BOSS, ics: invitationIcs({ uid: longUid, method: 'CANCEL', sequence: 1, status: 'CANCELLED' }) });
    result = await run();
    check(inInbox(longCancel) && !filedIds(result).includes(longCancel.ID), 'a cancellation with a long UID waits while the meeting is still active');
    await addInvitation({ id: 'inv-long', uid: longUid.slice(-191), sequence: 1, status: 'CANCELLED', tobiStatus: 2 });
    result = await run({ changedUids: [longUid.slice(-191)] });
    check(filedIds(result).join() === longCancel.ID, '… and is moved once it is cancelled');

    // ======================================================================================
    // 3. Cancellations.
    // ======================================================================================
    clearInbox();
    reset();
    await addInvitation({ id: 'inv-4', uid: 'off@outlook.test', tobiStatus: 3 });
    const cancel = await mail({ from: BOSS, subject: 'Canceled: Team meeting', ics: invitationIcs({ uid: 'off@outlook.test', method: 'CANCEL', sequence: 1, status: 'CANCELLED' }) });
    result = await run();
    check(inInbox(cancel) && result.waiting === 1, 'a cancellation Proton has not applied yet waits');
    await addInvitation({ id: 'inv-4', uid: 'off@outlook.test', sequence: 1, status: 'CANCELLED', tobiStatus: 2 });
    result = await run({ changedUids: ['off@outlook.test'] });
    check(filedIds(result).join() === cancel.ID && result.filed[0]?.kind === 'cancellation', 'cancelled in your calendar: moved');
    // One occurrence cancelled the way Proton does it (a cancelled single edit), and one by EXDATE.
    await addInvitation({ id: 'edit-cancelled', uid: 'weekly@outlook.test', recurrenceId: '20261012T100000', recurrenceID: RID_12, sequence: 3, status: 'CANCELLED', tobiStatus: 2 });
    events.delete('edit-12');
    const occurrenceCancel = await mail({ from: BOSS, ics: invitationIcs({ uid: 'weekly@outlook.test', method: 'CANCEL', recurrenceId: '20261012T100000', sequence: 3, status: 'CANCELLED' }) });
    const exdateCancel = await mail({ from: BOSS, ics: invitationIcs({ uid: 'weekly@outlook.test', method: 'CANCEL', recurrenceId: '20261019T100000', sequence: 3, status: 'CANCELLED' }) });
    const neverAdded = await mail({ from: BOSS, ics: invitationIcs({ uid: 'never-added@outlook.test', method: 'CANCEL', sequence: 1, status: 'CANCELLED' }) });
    result = await run();
    check(filedIds(result).includes(occurrenceCancel.ID) && filedIds(result).includes(exdateCancel.ID), 'an occurrence cancelled (single edit or EXDATE): moved');
    check(inInbox(neverAdded) && /nothing to cancel/.test(leftFor(result, neverAdded)?.why), 'a cancellation for a meeting that is not in your calendars stays');

    // ======================================================================================
    // 4. Destinations: Bin, a folder (found, created, refused, deleted), chunks, races.
    // ======================================================================================
    clearInbox();
    reset();
    const toBin = await doneMail();
    result = await run({ moveTo: 'trash' });
    check(filedIds(result).join() === toBin.ID && labelsOf(toBin).includes('3') && result.filed[0]?.destination === 'Trash', 'moved to the Bin (Trash label)');

    const toFolder = await doneMail();
    requests.length = 0;
    result = await run({ moveTo: 'folder' });
    const creation = requests.find((request) => request.method === 'POST' && request.endpoint === 'core/v4/labels');
    check(creation?.body.Name === 'Calendar' && creation?.body.Type === 3 && creation?.body.Notify === 0 && !creation?.body.ParentID && result.folderCreated === 'Calendar',
        `the folder "Calendar" is created (${JSON.stringify(creation?.body)})`);
    check(filedIds(result).join() === toFolder.ID && labelsOf(toFolder).includes('folder-1') && result.filed[0]?.destination === 'Calendar', 'and the email moved into it');
    const toFolder2 = await doneMail();
    requests.length = 0;
    result = await run({ moveTo: 'folder', folderName: ' Calendar ' });
    check(filedIds(result).join() === toFolder2.ID && !requests.some((request) => request.endpoint === 'core/v4/labels'), 'the next run uses the same folder without looking it up again');
    // The folder deleted meanwhile: the move fails, the folder is looked up (and created) again.
    folders.splice(0, folders.length);
    const afterDelete = await doneMail();
    result = await run({ moveTo: 'folder' });
    check(filedIds(result, 'failed').join() === afterDelete.ID && inInbox(afterDelete), 'the folder was deleted: the move fails, the email stays');
    api.calendarEmailsState.emails.get(afterDelete.ID).nextCheck = 0; // a minute later
    result = await run({ moveTo: 'folder' });
    check(filedIds(result).join() === afterDelete.ID && result.folderCreated === 'Calendar', '… next run the folder is created again and the email moved');
    // An existing folder with another case is used, not duplicated.
    folders.push({ ID: 'folder-existing', Name: 'meetings', Type: 3, ParentID: null, Path: 'meetings' });
    const toExisting = await doneMail();
    requests.length = 0;
    result = await run({ moveTo: 'folder', folderName: 'Meetings' });
    check(filedIds(result).join() === toExisting.ID && labelsOf(toExisting).includes('folder-existing') && !requests.some((request) => request.method === 'POST'), 'an existing folder named "meetings" is used for "Meetings"');
    // Creating the folder is refused (e.g. the plan's folder limit): nothing moved, not retried every run.
    refuseFolder = true;
    const blocked = await doneMail();
    result = await run({ moveTo: 'folder', folderName: 'Other' });
    check(inInbox(blocked) && /maximum number of folders/.test(result.folderError || '') && result.filed.length === 0, `folder refused: the email stays, the reason is reported (${result.folderError})`);
    requests.length = 0;
    result = await run({ moveTo: 'folder', folderName: 'Other' });
    check(!requests.some((request) => request.endpoint === 'core/v4/labels') && result.folderError && inInbox(blocked), 'not tried again right away');
    refuseFolder = false;
    clearInbox();

    // Twelve emails: two move requests (ten at a time); one refused by Proton stays and is moved next run.
    reset();
    const many: any[] = [];
    for (let index = 0; index < 12; index += 1) many.push(await doneMail());
    refuseMove = many[3].ID;
    result = await run({ maxOpened: 20 });
    const labelPuts = writes().filter((request) => request.endpoint === 'mail/v4/messages/label');
    check(labelPuts.length === 2 && labelPuts[0].body.IDs.length === 10 && labelPuts[1].body.IDs.length === 2, `ten per request (${labelPuts.map((request) => request.body.IDs.length).join(' + ')})`);
    check(filedIds(result).length === 11 && filedIds(result, 'failed').join() === many[3].ID && inInbox(many[3]), 'a move Proton refuses is reported and the email stays');
    refuseMove = null;
    requests.length = 0;
    result = await run();
    check(inInbox(many[3]) && result.filed.length === 0 && !writes().length, 'a refused move is not retried right away (no warning every sync)');
    api.calendarEmailsState.emails.get(many[3].ID).nextCheck = 0; // its next check is due
    result = await run({ maxChecks: 0 });
    check(inInbox(many[3]) && result.filed.length === 0 && result.more, 'without a fresh check (limit reached), an earlier verdict is not acted on');
    result = await run();
    check(filedIds(result).join() === many[3].ID, '… the next run with a check moves it');

    // Starred (or moved by you) between the listing and the move: left alone.
    clearInbox();
    reset();
    const raced = await doneMail();
    afterList = () => messages.get(raced.ID).LabelIDs.push('10');
    result = await run();
    check(inInbox(raced) && result.filed.length === 0, 'starred right before the move: not moved');

    // ======================================================================================
    // 5. Dry run, outages, limits, paging.
    // ======================================================================================
    clearInbox();
    reset();
    api.configureInvitations({ prodId: '-//Neutron Calendar Bridge//EN', policy: { mode: 'dry-run', allowlist: [] } });
    const dry = await doneMail();
    const foldersBefore = folders.length;
    requests.length = 0;
    result = await run({ moveTo: 'folder', folderName: 'Dry folder' });
    check(filedIds(result, 'dry-run').join() === dry.ID && inInbox(dry) && !writes().length && folders.length === foldersBefore && result.wouldMove === 1,
        'dry run: listed as would-be moved, nothing moved, no folder created');
    result = await run({ moveTo: 'folder', folderName: 'Dry folder', changedUids: [] });
    check(result.filed.length === 0, '… listed only once');
    api.configureInvitations({ prodId: '-//Neutron Calendar Bridge//EN', policy: { mode: 'live', allowlist: [] } });
    result = await run({ moveTo: 'folder', folderName: 'Dry folder' });
    check(filedIds(result).join() === dry.ID && result.folderCreated === 'Dry folder', 'back to live: the folder is created and the email moved');

    clearInbox();
    reset();
    const later = await doneMail();
    listOutages = 1;
    result = await run();
    check(result.error && inInbox(later) && !writes().length, `no connection while listing: nothing happens, error reported (${result.error})`);
    // An outage while checking an older email: the newer one already found dealt with is not moved either.
    await addInvitation({ id: 'inv-5', uid: 'outage@outlook.test', tobiStatus: 3 });
    const outageMail = await mail({ from: BOSS, ics: invitationIcs({ uid: 'outage@outlook.test', method: 'REQUEST' }), time: later.Time - 30 });
    failLookupFor = 'outage@outlook.test';
    requests.length = 0;
    result = await run();
    check(result.error && inInbox(outageMail) && inInbox(later) && !writes().length, 'Proton busy while checking: the run stops and nothing is moved');
    failLookupFor = null;
    result = await run();
    check(filedIds(result).includes(outageMail.ID) && filedIds(result).includes(later.ID), 'the next run catches up');

    clearInbox();
    reset();
    const batch: any[] = [];
    for (let index = 0; index < 3; index += 1) batch.push(await doneMail());
    result = await run({ maxOpened: 2 });
    check(result.opened === 2 && result.more && filedIds(result).length === 2, 'at most maxOpened emails opened per run');
    result = await run({ maxOpened: 2 });
    check(result.opened === 1 && filedIds(result).length === 1 && batch.every((message) => !inInbox(message)), 'the rest next run');
    for (let index = 0; index < 3; index += 1) batch.push(await doneMail());
    result = await run({ maxChecks: 1 });
    check(result.checked === 1 && result.more && filedIds(result).length === 1, 'at most maxChecks emails checked per run');

    // More than a page; a new email arriving between page requests shifts the pages: each email once.
    clearInbox();
    reset();
    const target = await doneMail();
    for (let index = 0; index < 100; index += 1) await mail({ subject: `Report ${index}` });
    afterList = () => {
        void mail({ subject: 'Report (new)', time: clock + 3600 });
    };
    result = await run();
    check(filedIds(result).join() === target.ID && result.filed.length === 1, `paging: the email on the second page is moved once (${result.filed.length})`);

    // Nothing but moves and folders was ever written by this feature.
    const unexpected = runWrites.filter((request) => !(request.method === 'PUT' && request.endpoint === 'mail/v4/messages/label') && !(request.method === 'POST' && request.endpoint === 'core/v4/labels'));
    check(runWrites.length > 0 && unexpected.length === 0, `only moves and the folder were written (${unexpected.map((request) => `${request.method} ${request.endpoint}`).join(', ') || 'ok'})`);

    console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll calendar-email checks passed.');
    if (failures) process.exitCode = 1;
};

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
