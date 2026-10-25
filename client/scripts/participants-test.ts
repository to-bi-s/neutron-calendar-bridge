/**
 * Offline test for events with an organizer and guests (invitations, stage 1).
 *
 * A meeting is encrypted with Proton's own code (withPmAttendees + createCalendarEvent) and
 * freshly generated keys, then shaped the way Proton's API returns it: guest list encrypted,
 * guests' answers in clear text keyed by token. One guest "accepts" by changing that clear status.
 * Checks that the client decrypts organizer, guests, answers and your own role, fetches the
 * remaining answers of long guest lists, and refuses every write that could touch such an event.
 * No network, no real account, no emails.
 */
import { CryptoProxy } from '@protontech/crypto';
import { loadCryptoWorker } from '@proton/shared/lib/helpers/setupCryptoWorker';
import { createCalendarEvent } from '@proton/shared/lib/calendar/serialize';
import { getCreationKeys } from '@proton/shared/lib/calendar/crypto/keys/helpers';
import { withPmAttendees } from '@proton/shared/lib/calendar/attendees';
import { PARTICIPANTS_WRITE_REFUSED, ProtonCalendarAPI } from '../src/proton-calendar-api.ts';

let failures = 0;
const check = (condition: unknown, label: string) => {
    console.log(`${condition ? 'ok  ' : 'FAIL'} ${label}`);
    if (!condition) failures += 1;
};

const address = (Email: string, Order = 1) => ({ ID: `addr-${Email}`, Email, Status: 1, Receive: 1, Send: 1, Type: 1, Order });

const MEETING = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Test//EN',
    'BEGIN:VEVENT', 'UID:meeting-1@proton.test', 'DTSTAMP:20260929T100000Z',
    'DTSTART;TZID=Europe/Amsterdam:20261005T100000', 'DTEND;TZID=Europe/Amsterdam:20261005T110000',
    'SUMMARY:Project sync', 'SEQUENCE:0',
    'ORGANIZER;CN=Tobi:mailto:tobi@proton.test',
    'ATTENDEE;CN=Anna;ROLE=REQ-PARTICIPANT;RSVP=TRUE;PARTSTAT=NEEDS-ACTION:mailto:anna@proton.test',
    'ATTENDEE;CN=Bob;ROLE=OPT-PARTICIPANT;RSVP=TRUE;PARTSTAT=NEEDS-ACTION:mailto:bob@example.org',
    'END:VEVENT', 'END:VCALENDAR', ''
].join('\r\n');

const main = async () => {
    await loadCryptoWorker();
    const gen = async (name: string) => {
        const privateKey = await CryptoProxy.generateKey({ userIDs: [{ name, email: `${name}@example.test` }] });
        const publicKey = await CryptoProxy.importPublicKey({ armoredKey: await CryptoProxy.exportPublicKey({ key: privateKey }) });
        return { privateKey, publicKey };
    };
    const addressKey = await gen('address');
    const calendarKey = await gen('calendar');
    const addressKeys = [{ ID: 'addr-key', privateKey: addressKey.privateKey, publicKey: addressKey.publicKey, primary: 1 }];
    const calendarKeys = [{ ID: 'cal-key', privateKey: calendarKey.privateKey, publicKey: calendarKey.publicKey, Key: { ID: 'cal-key', Flags: 3, PassphraseID: 'p' } }];
    const calendarData = { calendarID: 'cal-1', memberID: 'member-1', calendarKeys, calendarSettings: {} };

    const api: any = new ProtonCalendarAPI({ username: 'u', password: 'p' });
    api.session = { UID: 'session' };
    api.userData = { addressKeys, addresses: [address('tobi@proton.test', 1), address('tobi@pm.test', 2)] };
    api.resolveCalendarData = async () => calendarData;
    api.invalidateEventCaches = () => undefined;
    const requests: Array<{ endpoint: string; method: string; body?: any }> = [];
    let attendeePages: Record<number, any> = {};
    api.makeCalendarRequest = async (endpoint: string, method: string, body: any, query: any) => {
        requests.push({ endpoint, method, body });
        if (method === 'GET' && endpoint.endsWith('/attendees')) {
            return { status: 200, data: attendeePages[query?.Page] || { Attendees: [], MoreAttendees: 0 } };
        }
        return { status: 200, data: { Responses: [] } };
    };

    // 1. Encrypt the meeting exactly as Proton's app would (tokens per guest, answers split into clear part).
    const [parsed] = api.parseIcsToVevents(MEETING);
    const withTokens = await withPmAttendees(parsed, async (emails: string[]) =>
        Object.fromEntries(emails.map((email) => [email, email]))
    );
    const creationKeys = await getCreationKeys({ newAddressKeys: addressKeys as any, newCalendarKeys: calendarKeys as any });
    const data: any = await createCalendarEvent({
        eventComponent: withTokens,
        isCreateEvent: true,
        isSwitchCalendar: false,
        hasDefaultNotifications: true,
        ...creationKeys
    } as any);
    check(Array.isArray(data.Attendees) && data.Attendees.length === 2, 'Proton splits two guests into the clear answer list');

    // 2. What the API returns for it; Anna has since accepted (3), Bob not yet answered (0).
    const apiEvent: any = {
        ID: 'ev-1', CalendarID: 'cal-1', UID: 'meeting-1@proton.test', FullDay: 0, Color: null, IsOrganizer: 1,
        SharedKeyPacket: data.SharedKeyPacket, CalendarKeyPacket: data.CalendarKeyPacket,
        SharedEvents: data.SharedEventContent || [], CalendarEvents: data.CalendarEventContent || [],
        AttendeesEvents: data.AttendeesEventContent || [],
        AttendeesInfo: {
            Attendees: data.Attendees.map((attendee: any, index: number) => ({
                ID: `att-${index}`, Token: attendee.Token, Status: index === 0 ? 3 : 0
            })),
            MoreAttendees: 0
        },
        Notifications: data.Notifications
    };

    // 3. Organizer's view.
    const asOrganizer = await api.decryptCalendarEvent(apiEvent, calendarData);
    const organizer = asOrganizer?.vevent?.organizer;
    const guests = asOrganizer?.vevent?.attendee || [];
    check(organizer?.value === 'mailto:tobi@proton.test', `organizer decrypted (${organizer?.value})`);
    check(guests.length === 2, `both guests decrypted (${guests.length})`);
    const partstatOf = (email: string) => guests.find((guest: any) => guest.value === `mailto:${email}`)?.parameters?.partstat;
    check(partstatOf('anna@proton.test') === 'ACCEPTED', `Anna's answer merged from clear list (${partstatOf('anna@proton.test')})`);
    check(partstatOf('bob@example.org') === 'NEEDS-ACTION', `Bob still pending (${partstatOf('bob@example.org')})`);
    check(
        guests.find((guest: any) => guest.value === 'mailto:bob@example.org')?.parameters?.role === 'OPT-PARTICIPANT',
        'optional guest keeps ROLE=OPT-PARTICIPANT'
    );
    check(asOrganizer?.participation?.isOrganizer === true && asOrganizer?.participation?.isAttendee === false, 'you are the organizer');
    check(asOrganizer?.participation?.selfEmail === 'tobi@proton.test', 'organizer address identified');

    // 4. Guest's view of the same event (Anna's account).
    api.userData.addresses = [address('anna@proton.test')];
    const asGuest = await api.decryptCalendarEvent(apiEvent, calendarData);
    check(asGuest?.participation?.isAttendee === true && asGuest?.participation?.isOrganizer === false, 'you are a guest');
    check(asGuest?.participation?.selfAttendeeIndex === guests.findIndex((g: any) => g.value === 'mailto:anna@proton.test'), 'your guest entry identified');
    api.userData.addresses = [address('tobi@proton.test', 1), address('tobi@pm.test', 2)];

    // 5. Long guest lists: the listing carries only the first page of answers.
    const truncated: any = {
        ...apiEvent,
        AttendeesInfo: { Attendees: [apiEvent.AttendeesInfo.Attendees[0]], MoreAttendees: 1 }
    };
    attendeePages = { 1: { Attendees: [{ ...apiEvent.AttendeesInfo.Attendees[1], Status: 2 }], MoreAttendees: 0 } };
    await api.completeAttendeeAnswers('cal-1', [truncated]);
    const afterPaging = await api.decryptCalendarEvent(truncated, calendarData);
    const bob = afterPaging?.vevent?.attendee?.find((guest: any) => guest.value === 'mailto:bob@example.org');
    check(bob?.parameters?.partstat === 'DECLINED', `second page of answers fetched and merged (${bob?.parameters?.partstat})`);
    check(truncated.AttendeesInfo.MoreAttendees === 0, 'paging stops when Proton says there are no more');

    // 6. No write may touch an event with guests (no invitation emails can be sent yet).
    api.getEvent = async (id: string) => (id === 'ev-1' ? apiEvent : null);
    requests.length = 0;
    const [plainVevent] = api.parseIcsToVevents(MEETING.replace(/^(ORGANIZER|ATTENDEE).*\r\n/gm, ''));
    const refusedUpdate = await api.syncSeries({ calendarId: 'cal-1', components: [{ vevent: plainVevent, protonEventId: 'ev-1' }] });
    check(!refusedUpdate.success && refusedUpdate.error === PARTICIPANTS_WRITE_REFUSED, 'series write to a guest event refused');
    const refusedCreate = await api.syncSeries({ calendarId: 'cal-1', components: [{ vevent: parsed }] });
    check(!refusedCreate.success && refusedCreate.error === PARTICIPANTS_WRITE_REFUSED, 'creating an event with guests refused');
    const refusedSeriesDelete = await api.syncSeries({ calendarId: 'cal-1', components: [], deleteEventIds: ['ev-1'] });
    check(!refusedSeriesDelete.success, 'deleting a guest event through syncSeries refused');
    const refusedPlainUpdate = await api.updateEvent('ev-1', { title: 'x', description: '', location: '', startTime: 1, endTime: 2, timezone: 'UTC', isAllDay: false }, 'cal-1');
    check(!refusedPlainUpdate.success && refusedPlainUpdate.error === PARTICIPANTS_WRITE_REFUSED, 'plain update of a guest event refused');
    const refusedDelete = await api.deleteEvent('ev-1', 'cal-1');
    check(!refusedDelete.success && refusedDelete.error === PARTICIPANTS_WRITE_REFUSED, 'plain delete of a guest event refused');
    check(requests.every((request) => request.method === 'GET'), `nothing was written to Proton (${requests.map((r) => r.method).join(',') || 'no requests'})`);

    // 7. Plain events stay writable.
    const plainApiEvent = { ...apiEvent, ID: 'ev-plain', AttendeesEvents: [], AttendeesInfo: { Attendees: [], MoreAttendees: 0 } };
    api.getEvent = async (id: string) => (id === 'ev-plain' ? plainApiEvent : null);
    const plainDelete = await api.deleteEvent('ev-plain', 'cal-1');
    check(plainDelete.success, 'deleting a plain event still works');

    // 8. Account addresses for CalDAV.
    const listed = api.listAddresses().map((entry: any) => entry.email);
    check(JSON.stringify(listed) === JSON.stringify(['tobi@proton.test', 'tobi@pm.test']), `addresses listed in Proton's order (${listed.join(', ')})`);

    // 9. Which calendars can be written (Proton's getIsCalendarWritable, plus disabled ones).
    const { getCalendarWritability } = await import('../src/proton-calendar-api.ts');
    const owner = 127;
    check(getCalendarWritability(0, owner, 1).writable === true, 'own personal calendar is writable');
    check(getCalendarWritability(1, owner, 1).readOnlyReason === 'subscribed calendar', 'subscribed calendar is read-only');
    check(getCalendarWritability(2, 96, 1).readOnlyReason === 'holidays calendar', 'holidays calendar is read-only');
    check(getCalendarWritability(0, 96, 1).writable === false, 'calendar shared to view only is read-only');
    check(getCalendarWritability(0, 112, 1).writable === true, 'calendar shared with edit rights is writable');
    check(getCalendarWritability(0, owner, 33).readOnlyReason === 'disabled calendar', 'disabled calendar is read-only');
    check(getCalendarWritability(undefined, undefined, undefined).writable === true, 'missing data: writable, as before');

    console.log(failures ? `\n${failures} check(s) FAILED` : '\nall participant checks passed');
    process.exit(failures ? 1 : 0);
};

main().catch((error) => {
    console.error('FAILED', error);
    process.exit(1);
});
