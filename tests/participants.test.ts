/**
 * Events with an organizer and guests (invitations, stage 1: shown and protected, no emails).
 * Proton-side data is shaped like proton-calendar-client's decrypted output; ICS parsing goes
 * through the real client, like Calendar.app's saves would.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import * as nodeIcal from 'node-ical';
import type { ProtonParticipantProperty, ProtonVcalDateProperty, SyncedCalendarEvent } from 'proton-calendar-client';

import { CalDAVServer } from '../src/main/caldav-server';
import {
    INVITATION_MESSAGES,
    buildSeriesIcs,
    groupIntoSeries,
    icsHasParticipants,
    isRecurringSeries,
    onlyOwnAnswerChanged,
    readParticipants,
    sameForProton,
    seriesHasParticipants
} from '../src/main/recurrence';
import { loginFetch, withLogin } from './support/caldav-login';
import { fakeSafeStorage } from './support/fake-safe-storage';

const fetch = loginFetch('neutron-calendar-bridge', 'p');

const TZ = 'Europe/Amsterdam';
const ME = 'tobi@proton.me';
const MY_ALIAS = 'tobi@pm.me';

const at = (year: number, month: number, day: number, hours: number): ProtonVcalDateProperty => ({
    value: { year, month, day, hours, minutes: 0, seconds: 0, isUTC: false },
    parameters: { tzid: TZ }
});
const person = (email: string, extra: Record<string, string> = {}): ProtonParticipantProperty => ({
    value: `mailto:${email}`,
    parameters: { cn: email, ...extra }
});

const meetingIOrganize: SyncedCalendarEvent = {
    calendarId: 'private',
    eventId: 'ev-organized',
    uid: 'organized@proton.me',
    title: 'Project sync',
    description: '',
    location: 'Room 4.12',
    startTimestamp: Date.UTC(2026, 9, 5, 8) / 1000,
    endTimestamp: Date.UTC(2026, 9, 5, 9) / 1000,
    timezone: TZ,
    isAllDay: false,
    modifiedTimestamp: 1_790_000_000,
    contentHash: 'x',
    decrypted: {
        vevent: {
            dtstart: at(2026, 10, 5, 10),
            dtend: at(2026, 10, 5, 11),
            sequence: { value: 1 },
            organizer: person(ME, { cn: 'Tobi' }),
            attendee: [
                person('anna@uni.nl', { cn: 'Anna de Vries', partstat: 'ACCEPTED', role: 'REQ-PARTICIPANT' }),
                person('bob@example.org', { partstat: 'NEEDS-ACTION', role: 'OPT-PARTICIPANT' }),
                person('carol@proton.me', { cn: 'Doe, Carol: PI', partstat: 'DECLINED' })
            ]
        },
        participation: { isOrganizer: true, isAttendee: false, selfEmail: ME }
    }
};

const invitationIReceived: SyncedCalendarEvent = {
    ...meetingIOrganize,
    eventId: 'ev-invited',
    uid: 'invited@uni.nl',
    title: 'Faculty meeting',
    decrypted: {
        vevent: {
            dtstart: at(2026, 10, 7, 14),
            dtend: at(2026, 10, 7, 15),
            organizer: person('dean@uni.nl', { cn: 'The Dean' }),
            attendee: [
                person('dean@uni.nl', { partstat: 'ACCEPTED' }),
                // Proton matched me by a differently written variant of my alias.
                person('Tobi@PM.me', { partstat: 'NEEDS-ACTION' })
            ]
        },
        participation: { isOrganizer: false, isAttendee: true, selfEmail: MY_ALIAS, selfAttendeeIndex: 1 }
    }
};

const plainEvent: SyncedCalendarEvent = {
    ...meetingIOrganize,
    eventId: 'ev-plain',
    uid: 'plain@proton.me',
    title: 'Dentist',
    decrypted: { vevent: { dtstart: at(2026, 10, 9, 8), dtend: at(2026, 10, 9, 9) } }
};

const icsLines = (ics: string) => ics.replace(/\r\n[ \t]/g, '').split('\r\n');

// ─── Reading and serving ─────────────────────────────────────────────────────

test('organizer, guests and their answers are read from the decrypted event', () => {
    const participants = readParticipants(meetingIOrganize)!;
    assert.equal(participants.selfRole, 'organizer');
    assert.equal(participants.organizer?.email, ME);
    assert.equal(participants.organizer?.name, 'Tobi');
    assert.equal(participants.organizer?.isSelf, true);
    assert.deepEqual(
        participants.attendees.map((a) => [a.email, a.partstat, a.role, a.name ?? null]),
        [
            ['anna@uni.nl', 'ACCEPTED', 'REQ-PARTICIPANT', 'Anna de Vries'],
            ['bob@example.org', 'NEEDS-ACTION', 'OPT-PARTICIPANT', null], // CN equal to the address is not repeated
            ['carol@proton.me', 'DECLINED', 'REQ-PARTICIPANT', 'Doe, Carol: PI']
        ]
    );
    assert.equal(readParticipants(plainEvent), undefined, 'plain events have no participants');
});

test('your own guest entry uses the address Proton matched you by', () => {
    const participants = readParticipants(invitationIReceived)!;
    assert.equal(participants.selfRole, 'attendee');
    const me = participants.attendees.find((a) => a.isSelf)!;
    assert.equal(me.email, MY_ALIAS);
    assert.equal(me.partstat, 'NEEDS-ACTION');
});

test('meetings are served with ORGANIZER and ATTENDEE lines Calendar.app understands', () => {
    const [series] = groupIntoSeries([meetingIOrganize]);
    assert.equal(isRecurringSeries(series), false);
    assert.equal(seriesHasParticipants(series), true);
    const ics = buildSeriesIcs(series, 2026);
    const lines = icsLines(ics);

    assert.ok(lines.includes('ORGANIZER;CN=Tobi:mailto:tobi@proton.me'));
    assert.ok(lines.includes('ATTENDEE;CN=Anna de Vries;CUTYPE=INDIVIDUAL;ROLE=REQ-PARTICIPANT;PARTSTAT=ACCEPTED;RSVP=TRUE:mailto:anna@uni.nl'));
    assert.ok(lines.includes('ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=OPT-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:bob@example.org'));
    assert.ok(
        lines.includes('ATTENDEE;CN="Doe, Carol: PI";CUTYPE=INDIVIDUAL;ROLE=REQ-PARTICIPANT;PARTSTAT=DECLINED;RSVP=TRUE:mailto:carol@proton.me'),
        'names with , ; : are quoted'
    );
    assert.ok(!ics.includes('X-PM-'), 'no Proton-internal parameters leak out');
    assert.ok(ics.split('\r\n').every((line) => Buffer.byteLength(line, 'utf8') <= 75), 'long lines folded');
    assert.equal(icsHasParticipants(ics), true);

    // A standard parser reads them back.
    const parsed = Object.values(nodeIcal.sync.parseICS(ics)).find((entry: any) => entry?.type === 'VEVENT') as any;
    const attendees = [parsed.attendee].flat();
    assert.equal(attendees.length, 3);
    assert.deepEqual(
        attendees.map((a: any) => a.params.PARTSTAT),
        ['ACCEPTED', 'NEEDS-ACTION', 'DECLINED']
    );
    assert.equal(parsed.organizer.params.CN, 'Tobi');
});

test('an invitation is served with you as a guest under your matched address', () => {
    const lines = icsLines(buildSeriesIcs(groupIntoSeries([invitationIReceived])[0], 2026));
    assert.ok(lines.includes('ORGANIZER;CN=The Dean:mailto:dean@uni.nl'));
    assert.ok(lines.some((line) => line.startsWith('ATTENDEE;') && line.endsWith(':mailto:tobi@pm.me') && line.includes('PARTSTAT=NEEDS-ACTION')));
});

// ─── Comparing versions ──────────────────────────────────────────────────────

const clientParser = async () => {
    const client = await import('proton-calendar-client');
    const api = new client.ProtonCalendarAPI({ username: 'u', password: 'p' });
    return (ics: string) => api.parseIcsToVevents(ics);
};

/** What Calendar.app sends back: its own PRODID and DTSTAMP, maybe an alarm, the rest re-serialised. */
const asCalendarAppWouldSave = (ics: string, edit: (text: string) => string = (text) => text) =>
    edit(
        unfold(ics)
            .replace('PRODID:-//Neutron Calendar Bridge//EN', 'PRODID:-//Apple Inc.//macOS 26.0//EN')
            .replace(/DTSTAMP:\d{8}T\d{6}Z/, 'DTSTAMP:20261001T120000Z')
    );

/** Long lines are folded at 75 octets; edits below work on whole (unfolded) lines. */
const unfold = (ics: string) => ics.replace(/\r\n[ \t]/g, '');

test('saves that change nothing Proton stores are recognised as such', async () => {
    const parse = await clientParser();
    const served = buildSeriesIcs(groupIntoSeries([meetingIOrganize])[0], 2026);
    const withAlarm = asCalendarAppWouldSave(served, (text) =>
        text.replace('END:VEVENT', 'BEGIN:VALARM\r\nACTION:DISPLAY\r\nTRIGGER:-PT15M\r\nEND:VALARM\r\nEND:VEVENT')
    );
    assert.equal(sameForProton(parse(served), parse(withAlarm)), true, 'adding an alert is not a change for Proton');

    const organizerListedAsGuest = asCalendarAppWouldSave(served, (text) =>
        text.replace('END:VEVENT', 'ATTENDEE;PARTSTAT=ACCEPTED:mailto:tobi@proton.me\r\nEND:VEVENT')
    );
    assert.equal(sameForProton(parse(served), parse(organizerListedAsGuest)), true, 'organizer repeated as guest is ignored');

    const moved = asCalendarAppWouldSave(served, (text) => text.replace('T100000', 'T110000'));
    assert.equal(sameForProton(parse(served), parse(moved)), false, 'moving the meeting is a change');
    // 0.40: the same instant in another zone (Amsterdam 10:00 = London 09:00) is a change too: Proton stores the zone.
    const otherZone = asCalendarAppWouldSave(served, (text) => text.replace(/TZID=Europe\/Amsterdam:(\d{8})T100000/g, 'TZID=Europe/London:$1T090000').replace(/TZID=Europe\/Amsterdam:(\d{8})T110000/g, 'TZID=Europe/London:$1T100000'));
    assert.match(otherZone, /DTSTART;TZID=Europe\/London:20261005T090000/, 'the edit moved the start to London time');
    assert.match(otherZone, /DTEND;TZID=Europe\/London:20261005T100000/, 'and the end');
    assert.equal(sameForProton(parse(served), parse(otherZone)), false, 'a time-zone-only move is a change');
    const sameZoneRespelled = asCalendarAppWouldSave(served);
    assert.equal(sameForProton(parse(served), parse(sameZoneRespelled)), true, 'the same zone re-serialised is not');
    const guestRemoved = asCalendarAppWouldSave(served, (text) =>
        text.replace(/ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=OPT-PARTICIPANT[^\r\n]*\r\n/, '')
    );
    assert.equal(sameForProton(parse(served), parse(guestRemoved)), false, 'removing a guest is a change');
});

test('pressing Accept on an invitation is recognised as only your answer changing', async () => {
    const parse = await clientParser();
    const served = buildSeriesIcs(groupIntoSeries([invitationIReceived])[0], 2026);
    const accepted = asCalendarAppWouldSave(served, (text) =>
        text.replace(/(ATTENDEE;[^\r\n]*PARTSTAT=)NEEDS-ACTION([^\r\n]*:mailto:tobi@pm\.me)/, '$1ACCEPTED$2')
    );
    assert.match(accepted, /PARTSTAT=ACCEPTED;RSVP=TRUE:mailto:tobi@pm\.me/, 'the edit really changed your answer');
    assert.equal(onlyOwnAnswerChanged(parse(served), parse(accepted), [ME, MY_ALIAS]), true);

    const acceptedAndMoved = accepted.replace('T140000', 'T150000');
    assert.equal(onlyOwnAnswerChanged(parse(served), parse(acceptedAndMoved), [ME, MY_ALIAS]), false);
});

// ─── The bridge's write paths ────────────────────────────────────────────────

const stubElectron = () => {
    const resolved = require.resolve('electron');
    require.cache[resolved] = {
        id: resolved,
        filename: resolved,
        loaded: true,
        exports: { app: { setLoginItemSettings: () => undefined }, safeStorage: fakeSafeStorage }
    } as unknown as NodeJS.Module;
};

const setup = async (events: SyncedCalendarEvent[]) => {
    stubElectron();
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { BridgeService } = require('../src/main/bridge-service') as typeof import('../src/main/bridge-service');
    const baseDir = mkdtempSync(join(tmpdir(), 'neutron-calendar-bridge-participants-'));
    const service = new BridgeService(baseDir) as any;
    await service.mirrorDatabase.initialize();
    service.localCaldavPassword = 'test';
    const calendar = {
        protonCalendarId: 'private',
        slug: 'tobi-private',
        displayName: 'Tobi (Private)',
        color: '#123456',
        description: '',
        visible: true,
        removed: false,
        ctag: '1',
        lastPolledAt: null,
        lastSyncedAt: null
    };
    await service.mirrorDatabase.upsertCalendar(calendar);

    const parse = await clientParser();
    const writes: string[] = [];
    service.protonAdapter = {
        isSignedIn: () => true,
        supportsSeriesSync: () => true,
        parseIcs: parse,
        listAddresses: () => [
            { email: ME, displayName: 'Tobi', active: true, order: 1 },
            { email: MY_ALIAS, displayName: 'Tobi', active: true, order: 2 }
        ],
        listEvents: async () => events,
        syncSeries: async () => {
            writes.push('syncSeries');
            return { success: true, eventIds: ['new-1'] };
        },
        updateEvent: async () => {
            writes.push('updateEvent');
            return { success: true };
        },
        createEvent: async () => {
            writes.push('createEvent');
            return { success: true, id: 'new-1' };
        },
        deleteEvent: async () => {
            writes.push('deleteEvent');
            return { success: true };
        }
    };
    service.refreshAccountAddresses();
    await service.syncEventsForCalendar(calendar);
    const rows = await service.mirrorDatabase.listEventsForCalendar('private');
    const row = (uid: string) => rows.find((entry: any) => entry.uid === uid);
    const cleanup = async () => {
        await service.mirrorDatabase.close();
        rmSync(baseDir, { recursive: true, force: true });
    };
    return { service, writes, row, cleanup };
};

const put = (service: any, record: any, ics: string) =>
    service.upsertLocalEvent('tobi-private', `${encodeURIComponent(record.uid)}.ics`, record.href, ics);

test('sync serves meetings and invitations with guests, plain events unchanged', async () => {
    const { row, cleanup } = await setup([meetingIOrganize, invitationIReceived, plainEvent]);
    try {
        assert.match(row('organized@proton.me').serializedIcs, /^ATTENDEE;CN=Anna de Vries/m);
        assert.match(row('invited@uni.nl').serializedIcs, /^ORGANIZER;CN=The Dean:mailto:dean@uni\.nl/m);
        assert.doesNotMatch(row('plain@proton.me').serializedIcs, /ORGANIZER|ATTENDEE/);
    } finally {
        await cleanup();
    }
});

test('an alert added in Calendar.app to a meeting is accepted without writing to Proton', async () => {
    const { service, writes, row, cleanup } = await setup([meetingIOrganize]);
    try {
        const record = row('organized@proton.me');
        const result = await put(
            service,
            record,
            asCalendarAppWouldSave(record.serializedIcs, (text) =>
                text.replace('END:VEVENT', 'BEGIN:VALARM\r\nACTION:DISPLAY\r\nTRIGGER:-PT15M\r\nEND:VALARM\r\nEND:VEVENT')
            )
        );
        assert.equal(result.etag, '', 'no ETag: Calendar.app re-fetches Proton\'s version');
        assert.deepEqual(writes, []);
    } finally {
        await cleanup();
    }
});

test('changes to events with guests are refused with the reason that fits', async () => {
    const { service, writes, row, cleanup } = await setup([meetingIOrganize, invitationIReceived, plainEvent]);
    try {
        const meeting = row('organized@proton.me');
        await assert.rejects(put(service, meeting, unfold(meeting.serializedIcs).replace('T100000', 'T113000')), {
            name: 'InvitationNotSupportedError',
            message: INVITATION_MESSAGES.changeOrganized
        });

        const invitation = row('invited@uni.nl');
        const accepted = unfold(invitation.serializedIcs).replace(
            /(ATTENDEE;[^\r\n]*PARTSTAT=)NEEDS-ACTION([^\r\n]*:mailto:tobi@pm\.me)/,
            '$1ACCEPTED$2'
        );
        await assert.rejects(put(service, invitation, accepted), {
            name: 'InvitationNotSupportedError',
            message: INVITATION_MESSAGES.answerInvitation
        });
        await assert.rejects(put(service, invitation, unfold(invitation.serializedIcs).replace('Faculty meeting', 'Mine now')), {
            message: INVITATION_MESSAGES.changeInvitation
        });

        const plain = row('plain@proton.me');
        const withGuest = plain.serializedIcs.replace(
            'END:VEVENT',
            'ORGANIZER:mailto:tobi@proton.me\r\nATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:anna@uni.nl\r\nEND:VEVENT'
        );
        await assert.rejects(put(service, plain, withGuest), { message: INVITATION_MESSAGES.addGuests });

        await assert.rejects(service.deleteLocalEvent('tobi-private', 'organized@proton.me'), {
            message: INVITATION_MESSAGES.deleteOrganized
        });
        await assert.rejects(service.deleteLocalEvent('tobi-private', 'invited@uni.nl'), {
            message: INVITATION_MESSAGES.deleteInvitation
        });
        assert.deepEqual(writes, [], 'nothing reached Proton');

        // Plain events stay fully editable.
        await put(service, plain, plain.serializedIcs.replace('SUMMARY:Dentist', 'SUMMARY:Dentist (moved)'));
        await service.deleteLocalEvent('tobi-private', 'plain@proton.me');
        assert.deepEqual(writes, ['updateEvent', 'deleteEvent']);
    } finally {
        await cleanup();
    }
});

test('a refusal from the client itself (guests added in Proton since the last sync) becomes a 403', async () => {
    const { service, row, cleanup } = await setup([plainEvent]);
    try {
        service.protonAdapter.updateEvent = async () => ({
            success: false,
            error: 'This event has an organizer or guests. Changing it needs invitation emails, which are not supported yet; change it in Proton Calendar instead.'
        });
        const plain = row('plain@proton.me');
        await assert.rejects(put(service, plain, plain.serializedIcs.replace('Dentist', 'Dentist 2')), {
            name: 'InvitationNotSupportedError'
        });
    } finally {
        await cleanup();
    }
});

// ─── CalDAV surface ──────────────────────────────────────────────────────────

test('CalDAV: scheduling announced, own addresses listed, outbox honest, no-op saves answered 204', async () => {
    const recorded: any[] = [];
    const config = {
        host: '127.0.0.1',
        port: 33020,
        username: 'neutron-calendar-bridge',
        password: 'p',
        security: 'HTTP' as const,
        baseUrl: 'http://127.0.0.1:33020',
        serverPath: '/principals/neutron-calendar-bridge/'
    };
    const fake = {
        isSignedIn: () => true,
        getCalDAVConfig: () => config,
        getSignedInUsername: () => 'tobi',
        getAccountAddresses: () => [ME, MY_ALIAS],
        upsertLocalEvent: async () => ({ etag: '' }),
        recordCalDAVError: (entry: any) => recorded.push(entry),
        // 0.33.2: nothing is known about these guests (availability has its own test).
        freeBusyOf: async () => ({ known: false })
    };
    const server = new CalDAVServer(withLogin(fake) as any);
    await server.start();
    const base = config.baseUrl;
    try {
        const principal = await fetch(`${base}/principals/neutron-calendar-bridge/`, { method: 'PROPFIND' });
        assert.match(principal.headers.get('dav') || '', /calendar-schedule, calendar-auto-schedule/, 'calendar-schedule: what the Availability panel looks for (0.37.5)');
        const principalXml = await principal.text();
        assert.match(principalXml, /<D:href>mailto:tobi@proton\.me<\/D:href>\s*<D:href>mailto:tobi@pm\.me<\/D:href>/);
        assert.match(principalXml, /<C:calendar-user-type>INDIVIDUAL<\/C:calendar-user-type>/);

        const inbox = await fetch(`${base}/inbox/neutron-calendar-bridge/`, { method: 'PROPFIND' });
        assert.match(await inbox.text(), /<C:schedule-inbox\/>/);
        const inboxReport = await fetch(`${base}/inbox/neutron-calendar-bridge/`, { method: 'REPORT', body: '<D:sync-collection xmlns:D="DAV:"/>' });
        assert.equal(inboxReport.status, 207);

        const freeBusy = await fetch(`${base}/outbox/neutron-calendar-bridge/`, {
            method: 'POST',
            headers: { 'Content-Type': 'text/calendar' },
            body: [
                'BEGIN:VCALENDAR', 'METHOD:REQUEST', 'BEGIN:VFREEBUSY', 'ORGANIZER:mailto:tobi@proton.me',
                'ATTENDEE:mailto:anna@uni.nl', 'ATTENDEE;CN="Bob, B.":mailto:bob@example.org',
                'DTSTART:20261005T000000Z', 'DTEND:20261006T000000Z', 'END:VFREEBUSY', 'END:VCALENDAR', ''
            ].join('\r\n')
        });
        assert.equal(freeBusy.status, 200);
        const freeBusyXml = await freeBusy.text();
        assert.match(freeBusyXml, /<C:schedule-response/);
        assert.equal((freeBusyXml.match(/5\.3;No scheduling support for user/g) || []).length, 2);
        assert.match(freeBusyXml, /mailto:bob@example\.org/);

        const invite = await fetch(`${base}/outbox/neutron-calendar-bridge/`, {
            method: 'POST',
            headers: { 'Content-Type': 'text/calendar' },
            body: 'BEGIN:VCALENDAR\r\nMETHOD:REQUEST\r\nBEGIN:VEVENT\r\nUID:x\r\nATTENDEE:mailto:anna@uni.nl\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n'
        });
        assert.equal(invite.status, 403, 'an invitation Calendar.app tries to send itself is refused, not faked');
        assert.equal(recorded.length, 1);

        const noOp = await fetch(`${base}/calendars/neutron-calendar-bridge/tobi-private/meeting.ics`, {
            method: 'PUT',
            headers: { 'Content-Type': 'text/calendar' },
            body: 'BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n'
        });
        assert.equal(noOp.status, 204);
        assert.equal(noOp.headers.get('etag'), null);
    } finally {
        await server.stop();
    }
});
