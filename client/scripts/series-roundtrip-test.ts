/**
 * Offline round-trip: syncSeries() encrypts a Calendar.app series with freshly generated keys,
 * a fake transport captures the request, and Proton's own reader decrypts it back.
 * No network, no real account.
 */
import { CryptoProxy } from '@protontech/crypto';
import { loadCryptoWorker } from '@proton/shared/lib/helpers/setupCryptoWorker';
import { readCalendarEvent, readSessionKeys } from '@proton/shared/lib/calendar/deserialize';
import { getCalendarEventDecryptionKeys } from '@proton/shared/lib/calendar/crypto/keys/helpers';
import { ProtonCalendarAPI } from '../src/proton-calendar-api.ts';

const ICS = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Apple Inc.//macOS 26.0//EN',
    'BEGIN:VEVENT', 'UID:series-1', 'DTSTAMP:20260929T100000Z',
    'DTSTART;TZID=Europe/Amsterdam:20260105T090000', 'DTEND;TZID=Europe/Amsterdam:20260105T100000',
    'RRULE:FREQ=WEEKLY;BYDAY=MO;UNTIL=20261228T225959Z', 'EXDATE;TZID=Europe/Amsterdam:20260216T090000',
    'SUMMARY:Team meeting', 'LOCATION:Room 4.12', 'SEQUENCE:2',
    'BEGIN:VALARM', 'ACTION:DISPLAY', 'TRIGGER:-PT15M', 'END:VALARM', 'END:VEVENT',
    'BEGIN:VEVENT', 'UID:series-1', 'RECURRENCE-ID;TZID=Europe/Amsterdam:20260330T090000',
    'DTSTART;TZID=Europe/Amsterdam:20260331T140000', 'DTEND;TZID=Europe/Amsterdam:20260331T150000',
    'SUMMARY:Team meeting (moved)', 'END:VEVENT',
    'END:VCALENDAR', ''
].join('\r\n');

const main = async () => {
    await loadCryptoWorker();
    const gen = async (name: string) => {
        const privateKey = await CryptoProxy.generateKey({ userIDs: [{ name, email: `${name}@example.test` }] });
        const publicKey = await CryptoProxy.importPublicKey({ armoredKey: await CryptoProxy.exportPublicKey({ key: privateKey }) });
        return { privateKey, publicKey };
    };
    const address = await gen('address');
    const calendar = await gen('calendar');
    const addressKeys = [{ ID: 'addr-key', privateKey: address.privateKey, publicKey: address.publicKey, primary: 1 }];
    const calendarKeys = [{ ID: 'cal-key', privateKey: calendar.privateKey, publicKey: calendar.publicKey, Key: { ID: 'cal-key', Flags: 3, PassphraseID: 'p' } }];

    const api: any = new ProtonCalendarAPI({ username: 'u', password: 'p' });
    api.session = { UID: 'session' };
    api.userData = { addressKeys, addresses: [] };
    api.resolveCalendarData = async () => ({ calendarID: 'cal-1', memberID: 'member-1', calendarKeys, calendarSettings: {} });
    api.getEvent = async () => null;
    api.invalidateEventCaches = () => undefined;
    const captured: any[] = [];
    api.makeCalendarRequest = async (_endpoint: string, _method: string, body: any) => {
        captured.push(body);
        return {
            status: 200,
            data: { Responses: body.Events.map((_: any, index: number) => ({ Index: index, Response: { Code: 1000, Event: { ID: `proton-${index}` } } })) }
        };
    };

    const vevents = api.parseIcsToVevents(ICS);
    const result = await api.syncSeries({ calendarId: 'cal-1', components: vevents.map((vevent: any) => ({ vevent })), deleteEventIds: ['old-exception'] });
    console.log('result:', JSON.stringify(result));
    const request = captured[0];

    // Update path: Proton holds the master at SEQUENCE 2 (from the ICS); resending the same ICS must go out as 3.
    const created = request.Events[0].Event;
    const storedMaster: any = {
        ID: 'proton-0', CalendarID: 'cal-1', UID: 'series-1', FullDay: 0, Color: null,
        SharedKeyPacket: created.SharedKeyPacket, CalendarKeyPacket: created.CalendarKeyPacket,
        SharedEvents: created.SharedEventContent || [], CalendarEvents: created.CalendarEventContent || [],
        AttendeesEvents: [], AttendeesInfo: undefined, Notifications: created.Notifications
    };
    api.getEvent = async (id: string) => (id === 'proton-0' ? storedMaster : null);
    const decryptedStored = await api.decryptCalendarEvent(storedMaster, { calendarID: 'cal-1', memberID: 'member-1', calendarKeys, calendarSettings: {} });
    console.log('stored sequence before update:', decryptedStored?.sequence, '(master was created with SEQUENCE 2 from the ICS)');
    const updateResult = await api.syncSeries({ calendarId: 'cal-1', components: [{ vevent: vevents[0], protonEventId: 'proton-0' }] });
    console.log('update result:', JSON.stringify(updateResult), 'operation:', captured[1].Events[0].ID ? 'update' : 'create');
    {
        const entry = captured[1].Events[0];
        const apiEvent: any = { ...entry.Event, SharedKeyPacket: created.SharedKeyPacket, CalendarKeyPacket: created.CalendarKeyPacket, ID: 'u', CalendarID: 'cal-1', UID: 'series-1' };
        const privateKeys = await getCalendarEventDecryptionKeys({ calendarEvent: apiEvent, addressKeys: addressKeys as any, calendarKeys: calendarKeys as any });
        const [sharedSessionKey, calendarSessionKey] = await readSessionKeys({ calendarEvent: apiEvent, privateKeys });
        const { veventComponent } = await readCalendarEvent({
            event: { SharedEvents: apiEvent.SharedEventContent || [], CalendarEvents: apiEvent.CalendarEventContent || [], AttendeesEvents: [], AttendeesInfo: undefined, Notifications: apiEvent.Notifications, FullDay: 0, CalendarID: 'cal-1', ID: 'u', UID: 'series-1', Color: null } as any,
            publicKeysMap: {}, addresses: [], sharedSessionKey, calendarSessionKey, calendarSettings: {} as any, encryptingAddressID: undefined,
            getAttendeeVerificationPreferences: async () => ({} as any)
        });
        const outgoing = (veventComponent as any).sequence?.value;
        console.log('outgoing sequence on update:', outgoing, outgoing === 3 ? 'OK (stored 2 + 1)' : 'WRONG');
        if (outgoing !== 3) process.exit(1);
    }
    console.log('operations:', request.Events.map((entry: any) => (entry.DeletionReason !== undefined ? `delete ${entry.ID}` : entry.ID ? `update ${entry.ID}` : 'create')));

    for (const [index, entry] of request.Events.entries()) {
        if (!entry.Event) continue;
        const apiEvent: any = { ...entry.Event, ID: `x${index}`, CalendarID: 'cal-1', UID: 'series-1' };
        const privateKeys = await getCalendarEventDecryptionKeys({ calendarEvent: apiEvent, addressKeys: addressKeys as any, calendarKeys: calendarKeys as any });
        const [sharedSessionKey, calendarSessionKey] = await readSessionKeys({ calendarEvent: apiEvent, privateKeys });
        const { veventComponent } = await readCalendarEvent({
            event: { SharedEvents: apiEvent.SharedEventContent || [], CalendarEvents: apiEvent.CalendarEventContent || [], AttendeesEvents: [], AttendeesInfo: undefined, Notifications: apiEvent.Notifications, FullDay: 0, CalendarID: 'cal-1', ID: apiEvent.ID, UID: 'series-1', Color: null } as any,
            publicKeysMap: {}, addresses: [], sharedSessionKey, calendarSessionKey, calendarSettings: {} as any, encryptingAddressID: undefined,
            getAttendeeVerificationPreferences: async () => ({} as any)
        });
        const v: any = veventComponent;
        console.log(`component ${index}:`, JSON.stringify({
            summary: v.summary?.value, dtstart: v.dtstart, rrule: v.rrule?.value, exdate: v.exdate, recurrenceId: v['recurrence-id'], alarms: v.components?.length ?? 0, sequence: v.sequence?.value
        }));
    }
};

main().catch((error) => { console.error('FAILED', error); process.exit(1); });
