/**
 * Offline test for recurring meetings you organize (invitations, stage 3b).
 *
 * Same fake Proton as organizer-test.ts, extended with series (UID queries, RRULE / RECURRENCE-ID
 * on stored events, several operations per sync). The calendar app's saves are built like
 * Calendar.app's: the whole series (main event + changed occurrences) on every save. Checks, with
 * Proton's emails decrypted and read:
 * - a new weekly meeting, and a single meeting that starts repeating;
 * - "this occurrence": a new single edit (intermediate event, REQUEST with RECURRENCE-ID, Proton
 *   guest gets its key), an update of it;
 * - "all occurrences": a title change carried into the changed occurrence (an email each), a new
 *   time (changed occurrences cancelled and deleted, answers reset, IsBreakingChange);
 * - deleting one occurrence (CANCEL with STATUS:CANCELLED occurrence, EXDATE, CancelledOccurrenceContent
 *   for Proton guests) and a changed occurrence; deleting the series (a CANCEL each);
 * - refusals (guests of one occurrence, restored occurrence, undone change, two changes at once),
 *   stale copies, the email policy, a series created with a changed occurrence.
 * No network, no real account, no emails.
 */
import { CryptoProxy } from '@protontech/crypto';
import { loadCryptoWorker } from '@proton/shared/lib/helpers/setupCryptoWorker';
import { readInvitation } from '../src/invitations.ts';
import { ProtonCalendarAPI } from '../src/proton-calendar-api.ts';

let failures = 0;
const check = (condition: unknown, label: string) => {
    console.log(`${condition ? 'ok  ' : 'FAIL'} ${label}`);
    if (!condition) failures += 1;
};

const TOBI = 'tobi@proton.test';
const ANNA = 'anna@proton.test'; // a Proton guest
const DAN = 'dan@example.org'; // a non-Proton guest
const EVE = 'eve@example.org';

const VTIMEZONE = [
    'BEGIN:VTIMEZONE', 'TZID:Europe/Amsterdam',
    'BEGIN:DAYLIGHT', 'TZOFFSETFROM:+0100', 'TZOFFSETTO:+0200', 'TZNAME:CEST', 'DTSTART:19700329T020000',
    'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU', 'END:DAYLIGHT',
    'BEGIN:STANDARD', 'TZOFFSETFROM:+0200', 'TZOFFSETTO:+0100', 'TZNAME:CET', 'DTSTART:19701025T030000',
    'RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU', 'END:STANDARD',
    'END:VTIMEZONE'
].join('\r\n');

interface VeventSpec {
    start: string;
    end: string;
    summary?: string;
    guests?: string[];
    rrule?: string;
    exdates?: string[];
    recurrenceId?: string;
    status?: string;
}

/** Calendar.app's save of a meeting it organizes: itself as CHAIR among the guests. */
const veventLines = (uid: string, spec: VeventSpec) => [
    'BEGIN:VEVENT', `UID:${uid}`, 'DTSTAMP:20261001T080000Z',
    spec.recurrenceId ? `RECURRENCE-ID;TZID=Europe/Amsterdam:${spec.recurrenceId}` : '',
    `DTSTART;TZID=Europe/Amsterdam:${spec.start}`, `DTEND;TZID=Europe/Amsterdam:${spec.end}`,
    spec.rrule ? `RRULE:${spec.rrule}` : '',
    ...(spec.exdates || []).map((exdate) => `EXDATE;TZID=Europe/Amsterdam:${exdate}`),
    `SUMMARY:${spec.summary ?? 'Weekly sync'}`, 'SEQUENCE:0',
    spec.status ? `STATUS:${spec.status}` : '',
    `ORGANIZER;CN=Tobi:mailto:${TOBI}`,
    `ATTENDEE;CN=Tobi;CUTYPE=INDIVIDUAL;PARTSTAT=ACCEPTED;ROLE=CHAIR:mailto:${TOBI}`,
    ...(spec.guests ?? [ANNA, DAN]).map(
        (guest) => `ATTENDEE;CUTYPE=INDIVIDUAL;PARTSTAT=NEEDS-ACTION;ROLE=REQ-PARTICIPANT;RSVP=TRUE:mailto:${guest}`
    ),
    'END:VEVENT'
].filter(Boolean);

const calendarIcs = (uid: string, specs: VeventSpec[]) =>
    ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Apple Inc.//macOS 26.0//EN', ...specs.flatMap((spec) => veventLines(uid, spec)), 'END:VCALENDAR', ''].join('\r\n');

const WEEKLY = 'FREQ=WEEKLY;COUNT=6';
const series = (extra: Partial<VeventSpec> = {}): VeventSpec => ({ start: '20261005T100000', end: '20261005T110000', rrule: WEEKLY, ...extra });

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
    const calendarKeys = [{ ID: 'cal-key', privateKey: calendarKey.privateKey, publicKey: calendarKey.publicKey, Key: { ID: 'cal-key', Flags: 3, PassphraseID: 'p' } }];
    const calendarData = { calendarID: 'cal-1', memberID: 'member-1', calendarKeys, calendarSettings: {} };
    const tobiAddress = { ID: 'addr-tobi', Email: TOBI, DisplayName: 'Tobi S', Status: 1, Receive: 1, Send: 1, Type: 1, Order: 1, Keys: [], SignedKeyList: null };

    // ---- Fake Proton ----
    type Request = { method: string; endpoint: string; body?: any; query?: any };
    const requests: Request[] = [];
    const sent: any[] = [];
    const events = new Map<string, any>();
    let eventCounter = 0;
    let attendeeCounter = 0;
    let modifyCounter = 0;
    let calendarOwner = TOBI;
    let failSyncUpdates = 0;
    const mailSettings: any = { Sign: 0, PGPScheme: 16, DraftMIMEType: 'text/html', AttachPublicKey: 0, AutoSaveContacts: 1, RecipientLimit: 100 };
    const respond = (data: any, status = 200) => ({ status, data: { Code: 1000, ...data } });
    const signedOf = (cards: any[]) => String((cards || []).find((card: any) => card.Type === 2)?.Data || '');
    const toStored = (event: any, payload: any) => {
        if (payload.SharedKeyPacket) event.SharedKeyPacket = payload.SharedKeyPacket;
        if (payload.CalendarKeyPacket) event.CalendarKeyPacket = payload.CalendarKeyPacket;
        if (payload.SharedEventContent) event.SharedEvents = payload.SharedEventContent;
        if (payload.CalendarEventContent) event.CalendarEvents = payload.CalendarEventContent;
        event.AttendeesEvents = payload.AttendeesEventContent || [];
        const previous = event.AttendeesInfo?.Attendees || [];
        event.AttendeesInfo = {
            Attendees: (payload.Attendees || []).map(({ Token, Status, Comment }: any) => ({
                ID: previous.find((entry: any) => entry.Token === Token)?.ID || `att-${(attendeeCounter += 1)}`,
                Token,
                Status,
                Comment
            })),
            MoreAttendees: 0
        };
        event.Notifications = payload.Notifications;
        const signed = signedOf(event.SharedEvents).replace(/\r?\n[ \t]/g, '');
        event.UID = (signed.match(/^UID:(.+)$/m)?.[1] || event.UID || '').trim();
        event.RRule = signed.match(/^RRULE:(.+)$/m)?.[1]?.trim() || null;
        event.RecurrenceID = /^RECURRENCE-ID/m.test(signed) ? 1 : null;
        event.ModifyTime = (modifyCounter += 1);
        return event;
    };
    const route = (method: string, endpoint: string, body: any, query: any) => {
        requests.push({ method, endpoint, body, query });
        let match: RegExpMatchArray | null;
        if (method === 'GET' && endpoint === 'calendar/v1') {
            return respond({ Calendars: [{ ID: 'cal-1', Type: 0, Owner: { Email: calendarOwner }, Members: [{ ID: 'member-1', AddressID: tobiAddress.ID, Email: TOBI, Permissions: calendarOwner === TOBI ? 127 : 112 }] }] });
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
        if (method === 'GET' && endpoint === 'calendar/v1/cal-1/events' && query?.UID) {
            return respond({ Events: [...events.values()].filter((event) => event.UID === query.UID).map((event) => structuredClone(event)) });
        }
        if (method === 'GET' && (match = endpoint.match(/^calendar\/v1\/cal-1\/events\/([^/]+)$/))) {
            const event = events.get(match[1]);
            return event ? respond({ Event: structuredClone(event) }) : { status: 404, data: { Code: 2501, Error: 'Event does not exist' } };
        }
        if (method === 'PUT' && endpoint === 'calendar/v1/cal-1/events/sync') {
            if (failSyncUpdates > 0 && body.Events.some((operation: any) => operation.ID && operation.DeletionReason === undefined)) {
                // Proton applies a request as a whole or not at all.
                failSyncUpdates -= 1;
                return { status: 200, data: { Code: 1001, Responses: body.Events.map(() => ({ Response: { Code: 2001, Error: 'Temporary failure' } })) } };
            }
            const responses = body.Events.map((operation: any) => {
                if (operation.DeletionReason !== undefined) {
                    if (!events.has(operation.ID)) {
                        return { Response: { Code: 2501, Error: 'Event does not exist' } };
                    }
                    events.delete(operation.ID);
                    return { Response: { Code: 1000 } };
                }
                if (operation.ID) {
                    const event = events.get(operation.ID);
                    toStored(event, operation.Event);
                    event.IsPersonalSingleEdit = operation.Event.IsPersonalSingleEdit;
                    return { Response: { Code: 1000, Event: structuredClone(event) } };
                }
                const id = `ev-${(eventCounter += 1)}`;
                const event = toStored(
                    { ID: id, CalendarID: 'cal-1', SharedEventID: `shared-${id}`, FullDay: 0, Color: null, IsOrganizer: 1, IsProtonProtonInvite: 0, IsPersonalSingleEdit: !!operation.Event.IsPersonalSingleEdit, AddressID: null, AddressKeyPacket: null },
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
                        .filter((entry: any, index: number) => body.Events[index].DeletionReason === undefined || entry.Response.Code !== 1000)
                }
            };
        }
        if (method === 'POST' && endpoint === 'mail/v4/messages/send/direct') {
            sent.push(body);
            return respond({ Sent: { ID: `msg-${sent.length}` } });
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
    const logged: any[] = [];
    api.configureInvitations({ prodId: '-//Neutron Calendar Bridge//EN', policy: { mode: 'live', allowlist: [] }, onEmail: (record: any) => logged.push(record) });

    const writes = () => requests.filter((request) => request.method !== 'GET');
    const reset = () => { requests.length = 0; sent.length = 0; logged.length = 0; };
    const parse = (ics: string) => api.parseIcsToVevents(ics);
    const step = (request: Request) => {
        if (request.endpoint.endsWith('send/direct')) return 'email';
        if (request.endpoint.endsWith('events/sync')) {
            return request.body.Events.map((operation: any) => (operation.DeletionReason !== undefined ? 'delete' : operation.ID ? 'update' : 'create')).join('+');
        }
        return request.endpoint;
    };
    const order = () => writes().map(step).join(' | ');
    const read = async (id: string) => readInvitation(api.getInvitationContext(), structuredClone(events.get(id)));
    const ofUid = (uid: string) => [...events.values()].filter((event) => event.UID === uid);
    const masterOf = (uid: string) => ofUid(uid).find((event) => !event.RecurrenceID);
    const editsOf = (uid: string) => ofUid(uid).filter((event) => event.RecurrenceID);
    const openEmail = async (payload: any, recipient: string, decryptionKey?: any) => {
        const pack = payload.Packages.find((candidate: any) => candidate.Addresses[recipient]);
        const address = pack.Addresses[recipient];
        const contents = Uint8Array.fromBase64(payload.Message.Attachments[0].Contents);
        const keyPackets = Uint8Array.fromBase64(payload.AttachmentKeys);
        const at = bytesIndexOf(contents, keyPackets);
        let sessionKey: any;
        if (decryptionKey) {
            sessionKey = await CryptoProxy.decryptSessionKey({ binaryMessage: Uint8Array.fromBase64(address.AttachmentKeyPackets[0]), decryptionKeys: decryptionKey });
        } else {
            const [{ Key, Algorithm }] = pack.AttachmentKeys;
            sessionKey = { data: Uint8Array.fromBase64(Key), algorithm: Algorithm };
        }
        const { data } = await CryptoProxy.decryptMessage({ binaryMessage: contents.slice(0, at), sessionKeys: sessionKey } as any);
        return String(data).replace(/\r?\n[ \t]/g, '');
    };
    const veventOf = (ics: string) => ics.slice(ics.indexOf('BEGIN:VEVENT'));
    const recipientsOf = (payload: any) => payload.Message.ToList.map(({ Address }: any) => Address).sort().join(',');
    const sharedKeyOf = async (id: string) => {
        const key: any = await CryptoProxy.decryptSessionKey({ binaryMessage: Uint8Array.fromBase64(events.get(id).SharedKeyPacket), decryptionKeys: calendarKey.privateKey });
        return (key.data).toBase64();
    };
    /** Calendar.app's save; basedOn = what was served (Proton's current version, built the same way). */
    const save = (uid: string, specs: VeventSpec[], eventID?: string, basedOn?: VeventSpec[]) =>
        api.saveOrganizedSeries({
            calendarID: 'cal-1',
            eventID,
            vevents: parse(calendarIcs(uid, specs)),
            basedOn: basedOn ? parse(calendarIcs(uid, basedOn)) : undefined
        });

    // ======================================================================================
    // 1. A new weekly meeting.
    // ======================================================================================
    reset();
    const created = await save('CA-WEEKLY', [series()]);
    check(created.success && order() === 'create | email | update', `weekly meeting created like a single one (${created.error || order()})`);
    const uid = created.protonUid;
    const masterId = created.eventId;
    const createIcs = await openEmail(sent[0], ANNA, annaKey.privateKey);
    check(/RRULE:FREQ=WEEKLY;COUNT=6/.test(createIcs) && /^Invitation for an event starting on /.test(sent[0].Message.Subject), 'the invitation carries the repeat rule');
    check(events.get(masterId).RRule === 'FREQ=WEEKLY;COUNT=6', 'stored as a series in Proton');
    let state: VeventSpec[] = [series()]; // what the bridge would serve now

    // ======================================================================================
    // 2. "This occurrence": move the second one.
    // ======================================================================================
    reset();
    const moved = { start: '20261012T140000', end: '20261012T150000', recurrenceId: '20261012T100000' };
    const single = await save(uid, [...state, moved], masterId, state);
    check(single.success, `changing one occurrence works (${single.error || 'ok'}; ${single.warnings.join('; ')})`);
    check(order() === 'create | email | update', `Proton's order: occurrence without guests, email, guests (${order()})`);
    check(writes()[0].body.Events[0].Event.Attendees === undefined || !writes()[0].body.Events[0].Event.Attendees.length, 'the first save of the occurrence has no guests');
    const edits = editsOf(uid);
    check(edits.length === 1 && masterOf(uid)?.ID === masterId, 'Proton has the series and one changed occurrence');
    const editId = edits[0]?.ID;
    const singleIcs = await openEmail(sent[0], ANNA, annaKey.privateKey);
    check(recipientsOf(sent[0]) === `${ANNA},${DAN}` && /^Update for an event starting on /.test(sent[0].Message.Subject), `both guests get an update (${sent[0]?.Message.Subject})`);
    check(/RECURRENCE-ID;TZID=Europe\/Amsterdam:20261012T100000/.test(singleIcs) && /DTSTART;TZID=Europe\/Amsterdam:20261012T140000/.test(singleIcs) && !/RRULE/.test(veventOf(singleIcs)),
        'the email is about that occurrence: RECURRENCE-ID, new time, no RRULE');
    check(singleIcs.includes(`X-PM-SHARED-EVENT-ID:shared-${editId}`) && singleIcs.includes(`X-PM-SESSION-KEY:${await sharedKeyOf(editId)}`), "the occurrence's own shared event and key");
    const added = writes()[2].body.Events[0].Event.AddedProtonAttendees || [];
    check(added.length === 1 && added[0].Email === ANNA, 'Anna gets the key of the changed occurrence');
    check(single.emails[0]?.kind === 'update', 'logged as an update');
    check(single.emails[0]?.recurrenceId === '20261012T100000', `logged with the occurrence (${single.emails[0]?.recurrenceId})`);
    const editRead = await read(editId);
    check(editRead.vevent.attendee?.length === 2 && editRead.vevent.sequence.value === 1, 'occurrence stored with guests, SEQUENCE 1 (time changed)');
    state = [series(), { ...moved }];

    reset();
    const retitled = { ...moved, summary: 'Weekly sync (moved)' };
    const editAgain = await save(uid, [series(), retitled], masterId, state);
    check(editAgain.success && order() === 'email | update' && /^Update for an event/.test(sent[0]?.Message.Subject), `changing it again: update email, then save (${editAgain.error || order()})`);
    check((await read(editId)).vevent.summary.value === 'Weekly sync (moved)', 'the change is saved');
    state = [series(), retitled];

    reset();
    const unchanged = await save(uid, state, masterId, state);
    check(unchanged.success && writes().length === 0, 'saving the same version again changes nothing');

    // ======================================================================================
    // 3. "All occurrences": a new title is carried into the changed occurrence.
    // ======================================================================================
    reset();
    const renamed = await save(uid, [series({ summary: 'Team sync' }), retitled], masterId, state);
    check(renamed.success, `renaming the series works (${renamed.error || 'ok'})`);
    check(order() === 'email | email | update+update', `an email for the series and one for the changed occurrence, one save (${order()})`);
    const seriesIcs = await openEmail(sent[0], ANNA, annaKey.privateKey);
    check(/SUMMARY:Team sync/.test(seriesIcs) && /RRULE:/.test(seriesIcs) && /SEQUENCE:0/.test(seriesIcs), 'series update: new title, same SEQUENCE (no time change)');
    const seriesBody = sent[0] ? await (async () => {
        const pack = sent[0].Packages.find((candidate: any) => candidate.BodyKey);
        const { data } = await CryptoProxy.decryptMessage({ binaryMessage: Uint8Array.fromBase64(pack.Body), sessionKeys: { data: Uint8Array.fromBase64(pack.BodyKey.Key), algorithm: pack.BodyKey.Algorithm } } as any);
        return String(data);
    })() : '';
    check(/All events in this series were updated|series/i.test(seriesBody), `Proton's text for a series update (${JSON.stringify(seriesBody.slice(0, 60))})`);
    const occurrenceIcs = await openEmail(sent[1], ANNA, annaKey.privateKey);
    check(/RECURRENCE-ID/.test(occurrenceIcs) && /SUMMARY:Team sync/.test(occurrenceIcs), "Proton's rule: the changed occurrence takes the series' new title");
    check((await read(editId)).vevent.summary.value === 'Team sync' && editsOf(uid).length === 1, 'the changed occurrence stays, renamed');
    state = [series({ summary: 'Team sync' }), { ...retitled, summary: 'Team sync' }];

    // ======================================================================================
    // 4. Deleting one occurrence.
    // ======================================================================================
    reset();
    const masterSequence = (await read(masterId)).vevent.sequence.value;
    const third = await save(uid, [series({ summary: 'Team sync', exdates: ['20261019T100000'] }), state[1]], masterId, state);
    check(third.success && order() === 'email | update', `deleting the third occurrence: cancellation, then the EXDATE (${third.error || order()})`);
    const cancelIcs = await openEmail(sent[0], ANNA, annaKey.privateKey);
    check(/METHOD:CANCEL/.test(cancelIcs) && /RECURRENCE-ID;TZID=Europe\/Amsterdam:20261019T100000/.test(cancelIcs), 'CANCEL for that occurrence');
    check(new RegExp(`SEQUENCE:${masterSequence + 2}`).test(cancelIcs), `SEQUENCE + 2 like Proton (${masterSequence + 2})`);
    check(recipientsOf(sent[0]) === `${ANNA},${DAN}` && /^Cancellation of an event starting on /.test(sent[0].Message.Subject), 'both guests get a cancellation');
    const exdateUpdate = writes()[1].body.Events[0].Event;
    check(!!exdateUpdate.CancelledOccurrenceContent?.length, 'Proton guests: the cancelled occurrence is sent along (CancelledOccurrenceContent)');
    check((await read(masterId)).vevent.exdate?.length === 1 && (await read(masterId)).vevent.sequence.value === masterSequence, 'EXDATE on the series, SEQUENCE unchanged');
    state = [series({ summary: 'Team sync', exdates: ['20261019T100000'] }), state[1]];

    reset();
    const dropEdit = await save(uid, [series({ summary: 'Team sync', exdates: ['20261019T100000', '20261012T100000'] })], masterId, state);
    check(dropEdit.success && order() === 'email | delete+update', `deleting the changed occurrence: cancellation, then delete + EXDATE (${dropEdit.error || order()})`);
    check(/RECURRENCE-ID;TZID=Europe\/Amsterdam:20261012T100000/.test(await openEmail(sent[0], ANNA, annaKey.privateKey)), 'CANCEL for the changed occurrence');
    check(!writes()[1].body.Events[1].Event.CancelledOccurrenceContent, 'no CancelledOccurrenceContent for a changed occurrence (like Proton)');
    check(editsOf(uid).length === 0 && !events.has(editId), 'the changed occurrence is gone');
    state = [series({ summary: 'Team sync', exdates: ['20261012T100000', '20261019T100000'] })];

    // ======================================================================================
    // 5. Refusals and stale copies.
    // ======================================================================================
    reset();
    const fourth = { start: '20261026T100000', end: '20261026T110000', recurrenceId: '20261026T100000', summary: 'Team sync', guests: [ANNA] };
    const guestsOnce = await save(uid, [...state, fourth], masterId, state);
    check(!guestsOnce.success && guestsOnce.reason === 'unsupported' && writes().length === 0, `guests changed for one occurrence: refused (${guestsOnce.error})`);
    const restore = await save(uid, [series({ summary: 'Team sync', exdates: ['20261012T100000'] })], masterId, state);
    check(!restore.success && restore.reason === 'unsupported' && writes().length === 0, `a deleted occurrence brought back: refused (${restore.error})`);
    const two = await save(uid, [
        ...state,
        { start: '20261026T120000', end: '20261026T130000', recurrenceId: '20261026T100000', summary: 'Team sync' },
        { start: '20261102T120000', end: '20261102T130000', recurrenceId: '20261102T100000', summary: 'Team sync' }
    ], masterId, state);
    check(!two.success && two.reason === 'unsupported' && writes().length === 0, `two occurrences in one save: refused (${two.error})`);
    const combo = await save(uid, [series({ summary: 'Renamed', exdates: ['20261012T100000', '20261019T100000', '20261102T100000'] })], masterId, state);
    check(!combo.success && combo.reason === 'unsupported' && writes().length === 0, `series renamed and an occurrence deleted at once: refused (${combo.error})`);
    const stale = await save(uid, [series({ summary: 'Renamed', exdates: ['20261012T100000', '20261019T100000'] })], masterId, [series({ summary: 'Team sync' })]);
    check(!stale.success && stale.reason === 'stale' && writes().length === 0, `a copy without the latest deleted occurrences: stale (${stale.error})`);

    reset();
    api.configureInvitations({ policy: { mode: 'test', allowlist: [ANNA] } });
    const blocked = await save(uid, [...state, { start: '20261026T120000', end: '20261026T130000', recurrenceId: '20261026T100000', summary: 'Team sync' }], masterId, state);
    check(!blocked.success && blocked.reason === 'blocked' && writes().length === 0, 'test mode: Dan not allowed, nothing created');
    api.configureInvitations({ policy: { mode: 'dry-run', allowlist: [] } });
    const dry = await save(uid, [series({ summary: 'Team sync', exdates: ['20261012T100000', '20261019T100000', '20261102T100000'] })], masterId, state);
    check(!dry.success && dry.reason === 'dry-run' && writes().length === 0 && /METHOD:CANCEL/.test(dry.emails[0]?.preview?.ics || ''), 'dry run: the would-be cancellation is reported, nothing changes');
    api.configureInvitations({ policy: { mode: 'live', allowlist: [] } });

    // ======================================================================================
    // 6. "All occurrences", new time: changed occurrences are cancelled and deleted.
    // ======================================================================================
    reset();
    const fifth = { start: '20261102T160000', end: '20261102T170000', recurrenceId: '20261102T100000', summary: 'Team sync' };
    const fifthSaved = await save(uid, [...state, fifth], masterId, state);
    check(fifthSaved.success && editsOf(uid).length === 1, `another occurrence changed (${fifthSaved.error || 'ok'})`);
    state = [...state, fifth];
    const annaToken = events.get(masterId).AttendeesInfo.Attendees[0].Token;
    events.get(masterId).AttendeesInfo.Attendees[0].Status = 3; // Anna accepted the series
    reset();
    const later = await save(uid, [series({ start: '20261005T110000', end: '20261005T120000', summary: 'Team sync', exdates: ['20261012T110000', '20261019T110000'] }), fifth], masterId, state);
    check(later.success, `moving the whole series works (${later.error || 'ok'})`);
    check(order() === 'email | email | delete+update', `cancellation for the changed occurrence, update for the series, one save (${order()})`);
    const seriesMail = await openEmail(sent[0], ANNA, annaKey.privateKey);
    const cancelMail = await openEmail(sent[1], ANNA, annaKey.privateKey);
    check(/METHOD:REQUEST/.test(seriesMail) && /RRULE:FREQ=WEEKLY/.test(veventOf(seriesMail)) && /METHOD:CANCEL/.test(cancelMail) && /RECURRENCE-ID;TZID=Europe\/Amsterdam:20261102T100000/.test(cancelMail),
        'REQUEST (series), then CANCEL (changed occurrence), in Proton\'s order');
    const movedSeries = writes()[2].body.Events[1].Event;
    check(movedSeries.IsBreakingChange === 1, 'saved as a breaking change');
    check(editsOf(uid).length === 0, 'changed occurrences deleted (Proton rule)');
    const after = await read(masterId);
    check(after.vevent.sequence.value === masterSequence + 1 && after.vevent.exdate?.length === 2, 'SEQUENCE + 1; the EXDATEs Calendar.app moved along are kept');
    check(events.get(masterId).AttendeesInfo.Attendees.find((entry: any) => entry.Token === annaToken).Status === 0, "Anna's answer reset (time changed)");
    state = [series({ start: '20261005T110000', end: '20261005T120000', summary: 'Team sync', exdates: ['20261012T110000', '20261019T110000'] })];

    // ======================================================================================
    // 7. Deleting the series.
    // ======================================================================================
    reset();
    const sixth = { start: '20261109T150000', end: '20261109T160000', recurrenceId: '20261109T110000', summary: 'Team sync' };
    await save(uid, [...state, sixth], masterId, state);
    reset();
    const deleted = await api.cancelOrganizedEvent({ calendarID: 'cal-1', eventID: masterId, notifyAttendees: true });
    check(deleted.success && order() === 'email | email | delete+delete', `deleting the series: a cancellation each, then everything deleted (${deleted.error || order()})`);
    check(/METHOD:CANCEL/.test(await openEmail(sent[0], ANNA, annaKey.privateKey)) && /RRULE/.test(await openEmail(sent[0], ANNA, annaKey.privateKey)), 'the series is cancelled');
    check(/RECURRENCE-ID/.test(await openEmail(sent[1], ANNA, annaKey.privateKey)), 'and the changed occurrence');
    check(ofUid(uid).length === 0, 'nothing left in Proton');

    // ======================================================================================
    // 8. A single meeting that starts repeating; a series created with a changed occurrence.
    // ======================================================================================
    reset();
    const one = await api.saveOrganizedEvent({ calendarID: 'cal-1', vevent: parse(calendarIcs('CA-ONE', [{ start: '20261006T090000', end: '20261006T100000', guests: [DAN] }]))[0] });
    reset();
    const repeating = await save('CA-ONE', [{ start: '20261006T090000', end: '20261006T100000', guests: [DAN], rrule: 'FREQ=DAILY;COUNT=3' }], one.eventId, [{ start: '20261006T090000', end: '20261006T100000', guests: [DAN] }]);
    check(repeating.success && order() === 'email | update' && /RRULE:FREQ=DAILY;COUNT=3/.test(await openEmail(sent[0], DAN)), `a meeting that starts repeating: update with the repeat rule (${repeating.error || order()})`);
    check(events.get(one.eventId).RRule === 'FREQ=DAILY;COUNT=3', 'Proton has the series');

    reset();
    const split = await save('CA-SPLIT', [
        series({ start: '20261007T100000', end: '20261007T110000', guests: [EVE] }),
        { start: '20261014T150000', end: '20261014T160000', recurrenceId: '20261014T100000', guests: [EVE] }
    ]);
    check(split.success && editsOf(split.protonUid).length === 1, `a new series with a changed occurrence (Calendar.app's "all future"): both created (${split.error || 'ok'})`);
    check(sent.length === 2 && /^Invitation/.test(sent[0].Message.Subject) && /^Update/.test(sent[1].Message.Subject), 'an invitation, and an update for the occurrence');

    // ======================================================================================
    // 9. Guests changed for the whole series (Calendar.app applies it to the changed occurrence too).
    // ======================================================================================
    reset();
    const team = await save('CA-TEAM', [series({ summary: 'Team' })]);
    const teamUid = team.protonUid;
    const teamId = team.eventId;
    let teamState: VeventSpec[] = [series({ summary: 'Team' })];
    const teamMoved = { start: '20261012T160000', end: '20261012T170000', recurrenceId: '20261012T100000', summary: 'Team' };
    await save(teamUid, [...teamState, teamMoved], teamId, teamState);
    teamState = [...teamState, teamMoved];
    check(editsOf(teamUid).length === 1, 'setup: a series with a changed occurrence');
    reset();
    const swapped = await save(teamUid, [series({ summary: 'Team', guests: [ANNA, EVE] }), { ...teamMoved, guests: [ANNA, EVE] }], teamId, teamState);
    check(swapped.success, `Eve in, Dan out, for the whole series (${swapped.error || 'ok'})`);
    const sentTo = (address: string) => sent.filter((payload) => payload.Message.ToList.some(({ Address }: any) => Address === address));
    const danMails = await Promise.all(sentTo(DAN).map((payload) => openEmail(payload, DAN)));
    const eveMails = await Promise.all(sentTo(EVE).map((payload) => openEmail(payload, EVE)));
    check(danMails.length === 2 && danMails.every((ics) => /METHOD:CANCEL/.test(ics)) && danMails.some((ics) => /RECURRENCE-ID/.test(ics)),
        `Dan gets a cancellation for the series and for the changed occurrence (${danMails.length})`);
    check(eveMails.length === 2 && eveMails.every((ics) => /METHOD:REQUEST/.test(ics)) && sentTo(EVE).some((payload) => /^Invitation/.test(payload.Message.Subject)),
        `Eve gets the series and the changed occurrence (${eveMails.length})`);
    check(sentTo(ANNA).length === 0, 'Anna is not emailed: only the guest list changed (like Proton)');
    check(order().endsWith('update+update') && !/create|delete/.test(order()), `one save, nothing deleted (${order()})`);
    const guestsOf = async (id: string) => ((await read(id)).vevent.attendee || []).map((attendee: any) => attendee.value.replace(/^mailto:/i, '')).sort().join(',');
    check((await guestsOf(teamId)) === `${ANNA},${EVE}` && (await guestsOf(editsOf(teamUid)[0].ID)) === `${ANNA},${EVE}`, 'Proton: Anna and Eve on the series and the changed occurrence');
    teamState = [series({ summary: 'Team', guests: [ANNA, EVE] }), { ...teamMoved, guests: [ANNA, EVE] }];

    // ======================================================================================
    // 10. All guests removed; then guests added again.
    // ======================================================================================
    reset();
    const alone = await save(teamUid, [series({ summary: 'Team', guests: [] }), { ...teamMoved, guests: [] }], teamId, teamState);
    check(alone.success && sent.length >= 2 && sent.every((payload) => payload.Message.Subject.startsWith('Cancel')), `all guests removed: cancellations (${alone.error || sent.map((payload) => payload.Message.Subject).join(' / ')})`);
    check((await guestsOf(teamId)) === '' && editsOf(teamUid).length === 1 && (await guestsOf(editsOf(teamUid)[0].ID)) === '', 'Proton: no guests left, the changed occurrence stays');
    teamState = [series({ summary: 'Team', guests: [] }), { ...teamMoved, guests: [] }];
    reset();
    const back = await save(teamUid, [series({ summary: 'Team', guests: [EVE] }), { ...teamMoved, guests: [EVE] }], teamId, teamState);
    check(back.success && sentTo(EVE).length === 2 && /^Invitation/.test(sentTo(EVE)[0].Message.Subject) && /^Update/.test(sentTo(EVE)[1].Message.Subject),
        `guests added to a series without guests: invitation for the series, Proton's "Update" text for the occurrence (${back.error || sent.map((payload) => payload.Message.Subject).join(' / ')})`);
    check((await guestsOf(teamId)) === EVE, 'Proton: Eve on the series');
    teamState = [series({ summary: 'Team', guests: [EVE] }), { ...teamMoved, guests: [EVE] }];

    // ======================================================================================
    // 11. The series stops repeating ("all occurrences", repeat rule removed).
    // ======================================================================================
    reset();
    const once = await save(teamUid, [{ start: '20261005T100000', end: '20261005T110000', summary: 'Team', guests: [EVE] }], teamId, teamState);
    check(once.success && events.get(teamId)?.RRule === null && editsOf(teamUid).length === 0, `a series that stops repeating: one event left (${once.error || order()})`);
    check(sentTo(EVE).some((payload) => /^Update/.test(payload.Message.Subject)), 'Eve gets an update');

    // ======================================================================================
    // 12. Review fixes.
    // ======================================================================================
    const saveIcs = (ics: string, eventID?: string, basedOn?: VeventSpec[], uid?: string) =>
        api.saveOrganizedSeries({ calendarID: 'cal-1', eventID, vevents: parse(ics), basedOn: basedOn ? parse(calendarIcs(uid!, basedOn)) : undefined });
    const localOf = (property: any) => {
        const { year, month, day, hours, minutes } = property.value;
        const pad = (n: number) => String(n).padStart(2, '0');
        return `${year}${pad(month)}${pad(day)}T${pad(hours)}${pad(minutes)}00${property.value.isUTC ? 'Z' : ''}|${property.parameters?.tzid || ''}`;
    };

    // a) The series written in another time zone (same instants) with a new title: changed occurrences keep their time.
    reset();
    const tz = await save('CA-TZ', [series({ summary: 'TZ' })]);
    let tzState: VeventSpec[] = [series({ summary: 'TZ' })];
    const tzMoved = { start: '20261012T140000', end: '20261012T150000', recurrenceId: '20261012T100000', summary: 'TZ' };
    await save(tz.protonUid, [...tzState, tzMoved], tz.eventId, tzState);
    tzState = [...tzState, tzMoved];
    reset();
    const inUtc = calendarIcs(tz.protonUid, [series({ summary: 'TZ renamed' }), { ...tzMoved, summary: 'TZ renamed' }])
        .replace('DTSTART;TZID=Europe/Amsterdam:20261005T100000', 'DTSTART:20261005T080000Z')
        .replace('DTEND;TZID=Europe/Amsterdam:20261005T110000', 'DTEND:20261005T090000Z');
    const renamedUtc = await saveIcs(inUtc, tz.eventId, tzState, tz.protonUid);
    const tzEdit = editsOf(tz.protonUid)[0];
    const tzEditRead = await read(tzEdit.ID);
    check(renamedUtc.success && localOf(tzEditRead.vevent.dtstart) === '20261012T140000|Europe/Amsterdam' && localOf(tzEditRead.vevent.dtend) === '20261012T150000|Europe/Amsterdam',
        `series sent in UTC: the changed occurrence keeps its own time (${renamedUtc.error || localOf(tzEditRead.vevent.dtstart)})`);
    check(tzEditRead.vevent.summary?.value === 'TZ renamed' && localOf((await read(tz.eventId)).vevent.dtstart) === '20261005T100000|Europe/Amsterdam', 'renamed; the series keeps its stored start (Proton\'s rule)');
    const tzMails = await Promise.all(sent.map((payload) => openEmail(payload, ANNA, annaKey.privateKey)));
    check(tzMails.length === 2 && tzMails.some((ics) => /RECURRENCE-ID/.test(ics) && /DTSTART;TZID=Europe\/Amsterdam:20261012T140000/.test(ics)), 'the occurrence\'s email has its real time');
    tzState = [series({ summary: 'TZ renamed' }), { ...tzMoved, summary: 'TZ renamed' }];

    // b) An occurrence Proton changed that the calendar app was never shown: not overwritten.
    const tzThird = { start: '20261019T150000', end: '20261019T160000', recurrenceId: '20261019T100000', summary: 'TZ renamed' };
    await save(tz.protonUid, [...tzState, tzThird], tz.eventId, tzState);
    reset();
    const unseen = await save(tz.protonUid, [...tzState, { start: '20261019T100000', end: '20261019T110000', recurrenceId: '20261019T100000', summary: 'Other title' }], tz.eventId, tzState);
    check(!unseen.success && unseen.reason === 'unsupported' && writes().length === 0 && /does not have that version/.test(unseen.error),
        `a changed occurrence the calendar app does not know is not overwritten (${unseen.error})`);
    tzState = [...tzState, tzThird];

    // c) Interrupted "this occurrence": the retry neither emails again nor resets answers.
    events.get(tz.eventId).AttendeesInfo.Attendees.forEach((entry: any) => { entry.Status = 3; }); // everyone accepted the series
    reset();
    failSyncUpdates = 99;
    const fourthRetitled = { start: '20261026T100000', end: '20261026T110000', recurrenceId: '20261026T100000', summary: 'Fourth' };
    const interrupted = await save(tz.protonUid, [...tzState, fourthRetitled], tz.eventId, tzState);
    failSyncUpdates = 0;
    check(!interrupted.success && interrupted.reason === 'incomplete' && sent.length === 1, `occurrence created, guests emailed, guest list not saved: incomplete (${interrupted.error})`);
    check(/PARTSTAT=ACCEPTED/.test(await openEmail(sent[0], ANNA, annaKey.privateKey)), 'the first email keeps the answers (title only)');
    reset();
    const finished = await save(tz.protonUid, [...tzState, fourthRetitled], tz.eventId, [...tzState, { ...fourthRetitled, guests: [] }]);
    const fourthRead = (await Promise.all(editsOf(tz.protonUid).map((event) => read(event.ID)))).find((entry) => entry.vevent.summary?.value === 'Fourth');
    check(finished.success && sent.length === 0, `the retry finishes it without a second email (${finished.error || sent.length})`);
    check((fourthRead?.vevent.attendee || []).length === 2 && events.get(fourthRead!.event.ID).AttendeesInfo.Attendees.every((entry: any) => entry.Status === 3), 'guests saved, answers kept');
    tzState = [...tzState, fourthRetitled];

    reset();
    failSyncUpdates = 99;
    const fifthRetitled = { start: '20261102T100000', end: '20261102T110000', recurrenceId: '20261102T100000', summary: 'Fifth' };
    await save(tz.protonUid, [...tzState, fifthRetitled], tz.eventId, tzState);
    failSyncUpdates = 0;
    reset();
    // Calendar.app took the served copy (no guests on that occurrence) and saves again.
    const servedHalf = [...tzState, { ...fifthRetitled, guests: [] }];
    const finishedFromServed = await save(tz.protonUid, servedHalf, tz.eventId, servedHalf);
    const fifthRead = (await Promise.all(editsOf(tz.protonUid).map((event) => read(event.ID)))).find((entry) => entry.vevent.summary?.value === 'Fifth');
    check(finishedFromServed.success && sent.length === 0 && (fifthRead?.vevent.attendee || []).length === 2,
        `the served copy without guests finishes it too, no second email (${finishedFromServed.error || sent.length})`);
    tzState = [...tzState, fifthRetitled];

    // Later (retry memory gone, e.g. the bridge restarted), an unrelated save does not re-send it; changing it finishes it.
    reset();
    failSyncUpdates = 99;
    const sixthRetitled = { start: '20261109T100000', end: '20261109T110000', recurrenceId: '20261109T100000', summary: 'Sixth' };
    await save(tz.protonUid, [...tzState, sixthRetitled], tz.eventId, tzState);
    failSyncUpdates = 0;
    api.pendingOrganizerEmails.clear();
    reset();
    const servedSixth = [...tzState, { ...sixthRetitled, guests: [] }];
    const unrelated = await save(tz.protonUid, servedSixth, tz.eventId, servedSixth);
    check(unrelated.success && writes().length === 0 && unrelated.warnings.some((warning: string) => /not finished/.test(warning)),
        `memory gone: an unrelated save leaves it, with a warning, nothing sent (${unrelated.error || order()})`);
    reset();
    const changedSixth = await save(tz.protonUid, [...tzState, { ...sixthRetitled, summary: 'Sixth, again' }], tz.eventId, servedSixth);
    const sixthRead = (await Promise.all(editsOf(tz.protonUid).map((event) => read(event.ID)))).find((entry) => entry.vevent.summary?.value === 'Sixth, again');
    check(changedSixth.success && sent.length === 1 && (sixthRead?.vevent.attendee || []).length === 2, `changing it again finishes it, with its email (${changedSixth.error || order()})`);
    tzState = [...tzState, { ...sixthRetitled, summary: 'Sixth, again' }];

    // d) Guests added to a series in a calendar shared with you, or too many: refused.
    reset();
    const solo = await save('CA-SOLO', [series({ summary: 'Solo', guests: [] })]);
    const soloState = [series({ summary: 'Solo', guests: [] })];
    calendarOwner = 'boss@proton.test';
    reset();
    const shared = await save(solo.protonUid, [series({ summary: 'Solo', guests: [DAN] })], solo.eventId, soloState);
    calendarOwner = TOBI;
    check(!shared.success && shared.reason === 'unsupported' && writes().length === 0 && /shared calendar/.test(shared.error), `guests added in a shared calendar: refused (${shared.error})`);
    mailSettings.RecipientLimit = 1;
    reset();
    const crowd = await save(solo.protonUid, [series({ summary: 'Solo', guests: [ANNA, DAN] })], solo.eventId, soloState);
    mailSettings.RecipientLimit = 100;
    check(!crowd.success && crowd.reason === 'unsupported' && writes().length === 0 && /At most 1/.test(crowd.error), `more guests than allowed: refused (${crowd.error})`);

    // e) A rule re-spelled without WKST and an occurrence moved: only the occurrence changes.
    reset();
    const wkstRule = 'FREQ=WEEKLY;INTERVAL=2;COUNT=4;WKST=SU';
    const biweekly = await save('CA-WKST', [series({ summary: 'Biweekly', rrule: wkstRule })]);
    const biweeklyState = [series({ summary: 'Biweekly', rrule: wkstRule })];
    reset();
    const respelled = await save(biweekly.protonUid, [series({ summary: 'Biweekly', rrule: 'FREQ=WEEKLY;INTERVAL=2;COUNT=4' }), { start: '20261019T150000', end: '20261019T160000', recurrenceId: '20261019T100000', summary: 'Biweekly' }], biweekly.eventId, biweeklyState);
    check(respelled.success && order() === 'create | email | update' && editsOf(biweekly.protonUid).length === 1 && /WKST=SU/.test(events.get(biweekly.eventId).RRule),
        `WKST dropped by the calendar app is not a series change (${respelled.error || order()})`);

    // f) Long events: the occurrence starting at the RECURRENCE-ID, not the one overlapping it.
    reset();
    const daily = await save('CA-DAILY', [series({ summary: 'Shift', start: '20261005T100000', end: '20261006T100000', rrule: 'FREQ=DAILY;COUNT=3' })]);
    reset();
    const dailyExcluded = await save(daily.protonUid, [series({ summary: 'Shift', start: '20261005T100000', end: '20261006T100000', rrule: 'FREQ=DAILY;COUNT=3', exdates: ['20261006T100000'] })], daily.eventId, [series({ summary: 'Shift', start: '20261005T100000', end: '20261006T100000', rrule: 'FREQ=DAILY;COUNT=3' })]);
    check(dailyExcluded.success && order() === 'email | update' && (await read(daily.eventId)).vevent.exdate?.length === 1, `24-hour daily series: the second day can be deleted (${dailyExcluded.error || order()})`);

    // g) A moved series: EXDATEs sent in UTC are stored like Proton writes them.
    reset();
    const utcExdates = calendarIcs(daily.protonUid, [series({ summary: 'Shift', start: '20261005T110000', end: '20261006T110000', rrule: 'FREQ=DAILY;COUNT=3' })])
        .replace('END:VEVENT', 'EXDATE:20261007T090000Z\r\nEND:VEVENT');
    const movedDaily = await saveIcs(utcExdates, daily.eventId, [series({ summary: 'Shift', start: '20261005T100000', end: '20261006T100000', rrule: 'FREQ=DAILY;COUNT=3', exdates: ['20261006T100000'] })], daily.protonUid);
    const movedExdates = (await read(daily.eventId)).vevent.exdate || [];
    check(movedDaily.success && movedExdates.length === 1 && localOf(movedExdates[0]) === '20261007T110000|Europe/Amsterdam',
        `moved series: the UTC EXDATE is kept in the series' time zone (${movedDaily.error || movedExdates.map(localOf).join()})`);

    // h) A series change and an occurrence change in one save (e.g. made offline): refused, not half done.
    reset();
    const both = await save(biweekly.protonUid, [series({ summary: 'Biweekly renamed', rrule: wkstRule }), { start: '20261019T170000', end: '20261019T180000', recurrenceId: '20261019T100000', summary: 'Biweekly renamed' }],
        biweekly.eventId, [...biweeklyState, { start: '20261019T150000', end: '20261019T160000', recurrenceId: '20261019T100000', summary: 'Biweekly' }]);
    check(!both.success && both.reason === 'unsupported' && writes().length === 0, `series renamed and an occurrence moved at once: refused (${both.error})`);
    reset();
    const renamedOnly = await save(biweekly.protonUid, [series({ summary: 'Biweekly renamed', rrule: wkstRule }), { start: '20261019T150000', end: '20261019T160000', recurrenceId: '20261019T100000', summary: 'Biweekly renamed' }],
        biweekly.eventId, [...biweeklyState, { start: '20261019T150000', end: '20261019T160000', recurrenceId: '20261019T100000', summary: 'Biweekly' }]);
    check(renamedOnly.success, `the same rename with the occurrence renamed along (as Calendar.app may do) goes through (${renamedOnly.error || 'ok'})`);

    // i) A new series whose changed occurrence has other guest roles: refused before anything is created.
    reset();
    const rolesIcs = calendarIcs('CA-ROLES', [series({ summary: 'Roles' }), { start: '20261012T140000', end: '20261012T150000', recurrenceId: '20261012T100000', summary: 'Roles' }]);
    const lastDan = rolesIcs.lastIndexOf('ROLE=REQ-PARTICIPANT;RSVP=TRUE:mailto:dan@example.org');
    const optionalDan = `${rolesIcs.slice(0, lastDan)}ROLE=OPT-PARTICIPANT;RSVP=TRUE:mailto:dan@example.org${rolesIcs.slice(lastDan + 'ROLE=REQ-PARTICIPANT;RSVP=TRUE:mailto:dan@example.org'.length)}`;
    const roles = await saveIcs(optionalDan);
    check(!roles.success && roles.reason === 'unsupported' && writes().length === 0, `new series, an occurrence with other guest roles: refused, nothing created (${roles.error})`);

    // j) Floating time: occurrences cannot be changed from here.
    reset();
    const floating = calendarIcs('CA-FLOAT', [series({ summary: 'Float' }), { start: '20261012T140000', end: '20261012T150000', recurrenceId: '20261012T100000', summary: 'Float' }])
        .replace(/;TZID=Europe\/Amsterdam/g, '');
    const floatingResult = await saveIcs(floating);
    check(!floatingResult.success && floatingResult.reason === 'unsupported' && writes().length === 0, `floating-time series with a changed occurrence: refused (${floatingResult.error})`);

    // k) withoutRefusedGuests: a new weekly meeting with a mistyped guest in test mode is saved without them.
    reset();
    api.configureInvitations({ policy: { mode: 'test', allowlist: [ANNA] } });
    const typoIcs = calendarIcs('CA-TYPO', [series({ summary: 'Typo', guests: [ANNA, 'typo@uni.invalid'] })]);
    const typoRefused = await saveIcs(typoIcs);
    check(!typoRefused.success && typoRefused.reason === 'blocked' && writes().length === 0, 'without the option: refused, nothing created');
    reset();
    const typoSaved = await api.saveOrganizedSeries({ calendarID: 'cal-1', vevents: parse(typoIcs), withoutRefusedGuests: true });
    check(typoSaved.success && typoSaved.droppedGuests?.[0]?.email === 'typo@uni.invalid' && sent.length === 1 && sent[0].Message.ToList.map(({ Address }: any) => Address).join() === ANNA,
        `with it: the series is created and only Anna is invited (${typoSaved.error || JSON.stringify(typoSaved.droppedGuests)})`);
    const typoMaster = await read(typoSaved.eventId);
    check(typoMaster.vevent.rrule && typoMaster.vevent.attendee?.length === 1, 'Proton has the weekly series with Anna only');
    api.configureInvitations({ policy: { mode: 'live', allowlist: [] } });

    console.log(failures ? `\n${failures} check(s) FAILED` : '\nall series checks passed');
    process.exit(failures ? 1 : 0);
};

main().catch((error) => {
    console.error('FAILED', error);
    process.exit(1);
});
