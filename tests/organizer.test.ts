/**
 * Meetings you organize, from Calendar.app (invitations, stage 3a: single events; 3b: recurring). Proton-side
 * data is shaped like proton-calendar-client's decrypted output and ICS parsing goes through the
 * real client; saving and cancelling (Proton writes + invitation emails, tested in the client's
 * own offline test) are fakes that record what the bridge asks for.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ProtonParticipantProperty, ProtonVcalDateProperty, SyncedCalendarEvent } from 'proton-calendar-client';

import { INVITATION_MESSAGES, StaleEventError } from '../src/main/recurrence';
import { fakeSafeStorage } from './support/fake-safe-storage';

const TZ = 'Europe/Amsterdam';
const ME = 'tobi@proton.me';
const MY_ALIAS = 'tobi@pm.me';
const ANNA = 'anna@uni.nl';
const CARLA = 'carla@example.org';

const at = (year: number, month: number, day: number, hours: number): ProtonVcalDateProperty => ({
    value: { year, month, day, hours, minutes: 0, seconds: 0, isUTC: false },
    parameters: { tzid: TZ }
});
const person = (email: string, extra: Record<string, string> = {}): ProtonParticipantProperty => ({
    value: `mailto:${email}`,
    parameters: { cn: email, ...extra }
});
const emailOf = (property: any) => String(property?.value || '').replace(/^mailto:/i, '').toLowerCase();

/** A meeting you organize, as proton-calendar-client returns it. */
const meeting = (
    eventId: string,
    uid: string,
    guests: string[],
    extra: { start?: ProtonVcalDateProperty; title?: string; rrule?: boolean; recurrenceId?: ProtonVcalDateProperty } = {}
): SyncedCalendarEvent => {
    const start = extra.start ?? at(2026, 10, 7, 14);
    const end = { ...start, value: { ...start.value, hours: (start.value.hours ?? 0) + 1 } };
    return {
        calendarId: 'private',
        eventId,
        uid,
        title: extra.title ?? 'Project kickoff',
        description: '',
        location: '',
        startTimestamp: Date.UTC(start.value.year, start.value.month - 1, start.value.day, (start.value.hours ?? 0) - 2) / 1000,
        endTimestamp: Date.UTC(start.value.year, start.value.month - 1, start.value.day, (start.value.hours ?? 0) - 1) / 1000,
        timezone: TZ,
        isAllDay: false,
        modifiedTimestamp: 1_790_000_000,
        contentHash: `${eventId}-${guests.join(',')}-${start.value.hours}`,
        decrypted: {
            vevent: {
                dtstart: start,
                dtend: end,
                ...(extra.rrule ? { rrule: { value: { freq: 'WEEKLY', count: 4 } } } : {}),
                ...(extra.recurrenceId ? { 'recurrence-id': extra.recurrenceId } : {}),
                ...(guests.length ? { organizer: person(ME, { cn: 'Tobi' }) } : {}),
                ...(guests.length ? { attendee: guests.map((guest) => person(guest, { partstat: 'NEEDS-ACTION', role: 'REQ-PARTICIPANT' })) } : {})
            },
            participation: guests.length ? { isOrganizer: true, isAttendee: false, selfEmail: ME } : undefined
        }
    } as SyncedCalendarEvent;
};

const plain = (eventId: string, uid: string) => meeting(eventId, uid, [], { title: 'Dentist' });

const unfold = (ics: string) => ics.replace(/\r\n[ \t]/g, '');

/** What Calendar.app PUTs for a meeting it organizes: itself as CHAIR among the guests. */
const calendarAppMeeting = ({
    uid,
    guests = [ANNA],
    organizer = ME,
    start = '20261007T140000',
    extraLines = [] as string[]
}: { uid: string; guests?: string[]; organizer?: string; start?: string; extraLines?: string[] }) =>
    [
        'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Apple Inc.//macOS 26.0//EN',
        'BEGIN:VEVENT', `UID:${uid}`, 'DTSTAMP:20261001T080000Z',
        `DTSTART;TZID=${TZ}:${start}`, `DTEND;TZID=${TZ}:${start.replace('T14', 'T15')}`,
        'SUMMARY:Project kickoff',
        `ORGANIZER;CN=Tobi:mailto:${organizer}`,
        `ATTENDEE;CN=Tobi;CUTYPE=INDIVIDUAL;PARTSTAT=ACCEPTED;ROLE=CHAIR:mailto:${organizer}`,
        ...guests.map((guest) => `ATTENDEE;CUTYPE=INDIVIDUAL;PARTSTAT=NEEDS-ACTION;ROLE=REQ-PARTICIPANT;RSVP=TRUE:mailto:${guest}`),
        ...extraLines,
        'END:VEVENT', 'END:VCALENDAR', ''
    ].join('\r\n');

const clientParser = async () => {
    const client = await import('proton-calendar-client');
    const api = new client.ProtonCalendarAPI({ username: 'u', password: 'p' });
    return (ics: string) => api.parseIcsToVevents(ics);
};

const stubElectron = () => {
    const resolved = require.resolve('electron');
    require.cache[resolved] = {
        id: resolved,
        filename: resolved,
        loaded: true,
        exports: { app: { setLoginItemSettings: () => undefined }, safeStorage: fakeSafeStorage }
    } as unknown as NodeJS.Module;
};

type Outcome = { success: boolean; error?: string; reason?: string; warnings?: string[]; eventId?: string; protonUid?: string };

const HREF = (uid: string) => `/calendars/neutron-calendar-bridge/tobi-private/${encodeURIComponent(uid)}.ics`;

const setup = async (events: SyncedCalendarEvent[], { series = false }: { series?: boolean } = {}) => {
    stubElectron();
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { BridgeService } = require('../src/main/bridge-service') as typeof import('../src/main/bridge-service');
    const baseDir = mkdtempSync(join(tmpdir(), 'neutron-calendar-bridge-organizer-'));
    const service = new BridgeService(baseDir) as any;
    await service.mirrorDatabase.initialize();
    service.localCaldavPassword = 'test';
    const calendar = {
        protonCalendarId: 'private', slug: 'tobi-private', displayName: 'Tobi (Private)', color: '#123456',
        description: '', visible: true, removed: false, ctag: '1', lastPolledAt: null, lastSyncedAt: null
    };
    await service.mirrorDatabase.upsertCalendar(calendar);

    const parse = await clientParser();
    const proton = { events: [...events] };
    const calls: Array<{ action: string; input: any }> = [];
    let nextOutcome: (Outcome & { addEvent?: SyncedCalendarEvent }) | null = null;
    let created = 0;
    const own = new Set([ME, MY_ALIAS]);
    const guestsOf = (vevent: any) => (vevent.attendee || []).map(emailOf).filter((email: string) => !own.has(email));
    const startOf = (vevent: any): ProtonVcalDateProperty => ({ value: vevent.dtstart.value, parameters: { tzid: vevent.dtstart.parameters?.tzid } });
    const takeOutcome = () => {
        const outcome = nextOutcome;
        nextOutcome = null;
        if (outcome?.addEvent) proton.events.push(outcome.addEvent);
        return outcome ? { emails: [], changedEventIds: [], deletedEventIds: [], warnings: [], ...outcome } : null;
    };
    service.protonAdapter = {
        isSignedIn: () => true,
        getSignedInUsername: () => 'tobi',
        supportsSeriesSync: () => true,
        supportsInvitations: () => true,
        supportsOrganizing: () => true,
        parseIcs: parse,
        listAddresses: () => [
            { email: ME, displayName: 'Tobi', active: true, order: 1 },
            { email: MY_ALIAS, displayName: 'Tobi', active: true, order: 2 }
        ],
        listEvents: async () => proton.events,
        listEventsByUid: async (_calendarId: string, uid: string) => proton.events.filter((event) => event.uid === uid),
        syncSeries: async () => {
            calls.push({ action: 'syncSeries', input: null });
            return { success: true, eventIds: [] };
        },
        updateEvent: async () => {
            calls.push({ action: 'updateEvent', input: null });
            return { success: true };
        },
        saveOrganizedEvent: async (input: any) => {
            calls.push({ action: 'save', input });
            const refused = takeOutcome();
            if (refused) return refused;
            if (!input.eventID) {
                created += 1;
                const event = meeting(`ev-new-${created}`, `new-${created}@proton.me`, guestsOf(input.vevent), { start: startOf(input.vevent) });
                proton.events.push(event);
                return { success: true, emails: [], changedEventIds: [event.eventId], deletedEventIds: [], warnings: [], eventId: event.eventId, protonUid: event.uid };
            }
            const index = proton.events.findIndex((event) => event.eventId === input.eventID);
            const previous = proton.events[index];
            proton.events[index] = meeting(previous.eventId, previous.uid, guestsOf(input.vevent), { start: startOf(input.vevent) });
            return { success: true, emails: [], changedEventIds: [input.eventID], deletedEventIds: [], warnings: [], eventId: input.eventID, protonUid: previous.uid };
        },
        cancelOrganizedEvent: async (input: any) => {
            calls.push({ action: 'cancel', input });
            const refused = takeOutcome();
            if (refused) return refused;
            const uid = proton.events.find((event) => event.eventId === input.eventID)?.uid;
            // A stage 3b client deletes a series with all its occurrences.
            proton.events = proton.events.filter((event) => event.eventId !== input.eventID && !(series && event.uid === uid));
            return { success: true, emails: [], changedEventIds: [], deletedEventIds: [input.eventID], warnings: [], eventId: input.eventID, protonUid: uid };
        },
        ...(series
            ? {
                  supportsOrganizingSeries: () => true,
                  // Proton's series after the save: the main event and the changed occurrences as sent.
                  saveOrganizedSeries: async (input: any) => {
                      calls.push({ action: 'saveSeries', input });
                      const refused = takeOutcome();
                      if (refused) return refused;
                      const master = input.vevents.find((vevent: any) => !vevent['recurrence-id']);
                      let masterId = input.eventID;
                      let uid: string;
                      if (!masterId) {
                          created += 1;
                          masterId = `ev-new-${created}`;
                          uid = `new-${created}@proton.me`;
                      } else {
                          uid = proton.events.find((event) => event.eventId === masterId)!.uid;
                          proton.events = proton.events.filter((event) => event.uid !== uid);
                      }
                      proton.events.push(meeting(masterId, uid, guestsOf(master), { start: startOf(master), rrule: Boolean(master.rrule) }));
                      input.vevents
                          .filter((vevent: any) => vevent['recurrence-id'])
                          .forEach((vevent: any, index: number) =>
                              proton.events.push(
                                  meeting(`${masterId}-x${index + 1}`, uid, guestsOf(vevent), { start: startOf(vevent), recurrenceId: startOf({ dtstart: vevent['recurrence-id'] }) })
                              )
                          );
                      return { success: true, emails: [], changedEventIds: [masterId], deletedEventIds: [], warnings: [], eventId: masterId, protonUid: uid };
                  }
              }
            : {})
    };
    service.refreshAccountAddresses();
    await service.syncEventsForCalendar(calendar);
    calls.length = 0;
    const rows = async () => (await service.mirrorDatabase.listEventsForCalendar('private', true)) as any[];
    const row = async (uid: string) => (await rows()).find((entry: any) => entry.uid === uid);
    const put = (uid: string, ics: string, ifMatch?: string) =>
        service.upsertLocalEvent('tobi-private', `${encodeURIComponent(uid)}.ics`, HREF(uid), ics, { ifMatch });
    const failNext = (outcome: Outcome & { addEvent?: SyncedCalendarEvent }) => {
        nextOutcome = outcome;
    };
    const cleanup = async () => {
        await service.mirrorDatabase.close();
        rmSync(baseDir, { recursive: true, force: true });
    };
    return { service, calendar, calls, rows, row, put, failNext, cleanup, proton };
};

test('a meeting created in Calendar.app is saved in Proton and served under Calendar.app\'s UID', async () => {
    const { service, calendar, calls, row, rows, put, cleanup } = await setup([]);
    try {
        const uid = 'CA1F9E2B-7D3C-4C1A-9B57-3E2E0D7F1A11';
        const result = await put(uid, calendarAppMeeting({ uid, guests: [ANNA, CARLA] }));
        assert.equal(calls.length, 1);
        assert.equal(calls[0].action, 'save');
        assert.equal(calls[0].input.calendarID, 'private');
        assert.equal(calls[0].input.eventID, undefined, 'a new event');
        assert.equal(calls[0].input.vevent.uid.value, uid);
        assert.equal(result.etag, '', 'no ETag: Calendar.app re-fetches Proton\'s version');

        const saved = await row(uid);
        assert.ok(saved, 'mirror row under Calendar.app\'s UID');
        assert.equal(saved.href, HREF(uid));
        assert.equal(saved.protonEventId, 'ev-new-1');
        assert.match(unfold(saved.serializedIcs), new RegExp(`^UID:${uid}$`, 'm'));
        assert.match(unfold(saved.serializedIcs), /^ORGANIZER;CN=Tobi:mailto:tobi@proton\.me$/m);
        assert.match(unfold(saved.serializedIcs), /^ATTENDEE;[^\r\n]*:mailto:anna@uni\.nl$/m);

        // The next sync keeps it there (Proton knows it as new-1@proton.me).
        await service.syncEventsForCalendar(await service.mirrorDatabase.getCalendarBySlug(calendar.slug));
        const live = (await rows()).filter((entry) => !entry.deleted);
        assert.deepEqual(live.map((entry) => entry.uid), [uid], 'no duplicate under the Proton UID');
    } finally {
        await cleanup();
    }
});

test('a guest who cannot be invited is left out: the meeting is saved, Calendar.app gets a refusal and Proton\'s version', async () => {
    const { service, calls, row, put, cleanup } = await setup([]);
    try {
        // The client (with withoutRefusedGuests) saves without the mistyped guest and says so.
        const save = service.protonAdapter.saveOrganizedEvent;
        service.protonAdapter.saveOrganizedEvent = async (input: any) => {
            const typo = (input.vevent.attendee || []).filter((attendee: any) => emailOf(attendee).endsWith('.invalid'));
            const outcome = await save({ ...input, vevent: { ...input.vevent, attendee: input.vevent.attendee.filter((attendee: any) => !typo.includes(attendee)) } });
            return input.withoutRefusedGuests && typo.length
                ? { ...outcome, droppedGuests: typo.map((attendee: any) => ({ email: emailOf(attendee), reason: 'not on the test-mode allowlist' })) }
                : outcome;
        };
        const uid = 'TYPO-1';
        await assert.rejects(put(uid, calendarAppMeeting({ uid, guests: [ANNA, 't.j.jansen@uni.invalid'] })), (error: any) => {
            assert.equal(error.name, 'InvitationNotSupportedError', 'a 403');
            assert.match(error.message, /^Saved without t\.j\.jansen@uni\.invalid \(not on the test-mode allowlist\)/);
            assert.equal(error.partial, true, 'notified as "Saved, with changes", whatever the language');
            return true;
        });
        assert.equal(calls[0].input.withoutRefusedGuests, true, 'the bridge asks the client to leave refused guests out');
        const saved = await row(uid);
        assert.ok(saved && !saved.deleted, 'the meeting is in the mirror under Calendar.app\'s UID, so Calendar.app reloads it instead of losing it');
        assert.match(unfold(saved.serializedIcs), /ATTENDEE;[^\r\n]*:mailto:anna@uni\.nl/);
        assert.doesNotMatch(unfold(saved.serializedIcs), /rug\.ml/);
    } finally {
        await cleanup();
    }
});

test('changing a meeting you organize saves it in Proton; an outdated copy is refused', async () => {
    const { calls, row, put, cleanup } = await setup([meeting('ev-m', 'organized@proton.me', [ANNA])]);
    try {
        const before = await row('organized@proton.me');
        const moved = unfold(before.serializedIcs).replace(/T140000/g, 'T160000').replace(/T150000/g, 'T170000');
        await assert.rejects(put('organized@proton.me', moved, '"outdated"'), (error: any) => {
            assert.ok(error instanceof StaleEventError);
            assert.equal(error.message, INVITATION_MESSAGES.staleMeeting);
            return true;
        });
        assert.deepEqual(calls, [], 'nothing sent from an outdated copy');

        const result = await put('organized@proton.me', moved.replace('END:VEVENT', `ATTENDEE;ROLE=REQ-PARTICIPANT:mailto:${CARLA}\r\nEND:VEVENT`), before.etag);
        assert.equal(calls.length, 1);
        assert.equal(calls[0].input.eventID, 'ev-m');
        assert.deepEqual(calls[0].input.vevent.attendee.map(emailOf).sort(), [ANNA, CARLA]);
        assert.equal(result.etag, '');
        const after = await row('organized@proton.me');
        assert.match(unfold(after.serializedIcs), /^DTSTART;TZID=Europe\/Amsterdam:20261007T160000$/m, 'served from Proton\'s new version');
        assert.match(unfold(after.serializedIcs), /mailto:carla@example\.org/);

        // Removing every guest is a change too (the client cancels for them).
        calls.length = 0;
        const withoutGuests = unfold(after.serializedIcs).replace(/^(ORGANIZER|ATTENDEE)[^\r\n]*\r\n/gm, '');
        await put('organized@proton.me', withoutGuests, after.etag);
        assert.equal(calls[0]?.action, 'save');
        assert.equal(calls[0].input.vevent.attendee, undefined);
    } finally {
        await cleanup();
    }
});

test('adding guests to one of your events in Calendar.app turns it into a meeting', async () => {
    const { calls, row, put, cleanup } = await setup([plain('ev-plain', 'plain@proton.me')]);
    try {
        const before = await row('plain@proton.me');
        const withGuest = unfold(before.serializedIcs).replace(
            'END:VEVENT',
            `ORGANIZER:mailto:${MY_ALIAS}\r\nATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:${ANNA}\r\nEND:VEVENT`
        );
        await put('plain@proton.me', withGuest, before.etag);
        assert.deepEqual(calls.map((call) => [call.action, call.input.eventID]), [['save', 'ev-plain']]);
        assert.match(unfold((await row('plain@proton.me')).serializedIcs), /mailto:anna@uni\.nl/);
    } finally {
        await cleanup();
    }
});

test('meetings the bridge cannot send for are refused before anything is sent (recurring ones: client without stage 3b)', async () => {
    const { service, calls, row, put, cleanup } = await setup([meeting('ev-weekly', 'weekly@proton.me', [ANNA], { rrule: true })]);
    try {
        const weekly = await row('weekly@proton.me');
        await assert.rejects(put('weekly@proton.me', unfold(weekly.serializedIcs).replace(/T140000/g, 'T160000'), weekly.etag), {
            name: 'InvitationNotSupportedError',
            message: INVITATION_MESSAGES.organizeRecurring
        });
        await assert.rejects(put('new-weekly', calendarAppMeeting({ uid: 'new-weekly', extraLines: ['RRULE:FREQ=WEEKLY;COUNT=3'] })), {
            message: INVITATION_MESSAGES.organizeRecurring
        });
        await assert.rejects(put('not-mine', calendarAppMeeting({ uid: 'not-mine', organizer: 'boss@outlook.com' })), {
            message: INVITATION_MESSAGES.organizeForeign
        });
        const clientScheduled = calendarAppMeeting({ uid: 'client-sends' }).replace(
            `ATTENDEE;CUTYPE=INDIVIDUAL;PARTSTAT=NEEDS-ACTION`,
            'ATTENDEE;CUTYPE=INDIVIDUAL;SCHEDULE-AGENT=CLIENT;PARTSTAT=NEEDS-ACTION'
        );
        await assert.rejects(put('client-sends', clientScheduled), { message: INVITATION_MESSAGES.organizeClientScheduling });
        const dontNotify = calendarAppMeeting({ uid: 'dont-send' }).replace(
            `ATTENDEE;CUTYPE=INDIVIDUAL;PARTSTAT=NEEDS-ACTION`,
            'ATTENDEE;CUTYPE=INDIVIDUAL;SCHEDULE-AGENT=NONE;PARTSTAT=NEEDS-ACTION'
        );
        await assert.rejects(put('dont-send', dontNotify), { message: INVITATION_MESSAGES.organizeDontNotify });
        await assert.rejects(service.deleteLocalEvent('tobi-private', 'weekly@proton.me'), { message: INVITATION_MESSAGES.organizeRecurring });

        // Calendar.app moving a meeting to another calendar: a copy with the same UID, then a delete.
        await service.mirrorDatabase.upsertCalendar({
            protonCalendarId: 'work', slug: 'tobi-work', displayName: 'Work', color: '#654321', description: '', visible: true,
            removed: false, ctag: '1', lastPolledAt: null, lastSyncedAt: null
        });
        await service.mirrorDatabase.upsertEvent({ ...weekly, protonCalendarId: 'work', protonEventId: 'ev-work', href: '/calendars/neutron-calendar-bridge/tobi-work/moving.ics', uid: 'moving@proton.me', protonEventIds: { '': 'ev-work' } });
        await assert.rejects(put('moving@proton.me', calendarAppMeeting({ uid: 'moving@proton.me' })), { message: INVITATION_MESSAGES.moveMeeting });
        assert.deepEqual(calls, [], 'the client was never asked');
    } finally {
        await cleanup();
    }
});

test('deleting a meeting you organize cancels it (or not, when Calendar.app says not to notify)', async () => {
    const { service, calls, row, cleanup } = await setup([
        meeting('ev-a', 'a@proton.me', [ANNA]),
        meeting('ev-b', 'b@proton.me', [ANNA, CARLA])
    ]);
    try {
        await service.deleteLocalEvent('tobi-private', 'a@proton.me');
        await service.deleteLocalEvent('tobi-private', 'b@proton.me', { notifyOrganizer: false });
        assert.deepEqual(calls, [
            { action: 'cancel', input: { calendarID: 'private', eventID: 'ev-a', notifyAttendees: true } },
            { action: 'cancel', input: { calendarID: 'private', eventID: 'ev-b', notifyAttendees: false } }
        ]);
        assert.equal((await row('a@proton.me')).deleted, true);
        assert.equal((await row('b@proton.me')).deleted, true);
    } finally {
        await cleanup();
    }
});

test('refusals and half-done saves', async () => {
    const { service, calls, row, put, failNext, cleanup } = await setup([meeting('ev-m', 'organized@proton.me', [ANNA])]);
    try {
        const before = await row('organized@proton.me');
        failNext({ success: false, reason: 'blocked', error: 'Test mode: this change would email anna@uni.nl, which is not on the allowlist. Nothing was changed.' });
        await assert.rejects(put('organized@proton.me', unfold(before.serializedIcs).replace(/T140000/g, 'T160000'), before.etag), {
            name: 'InvitationNotSupportedError',
            message: /Test mode/
        });
        assert.equal((await row('organized@proton.me')).serializedIcs, before.serializedIcs, 'mirror unchanged');

        failNext({ success: false, reason: 'blocked', error: 'Test mode: cancelling this event would email anna@uni.nl …' });
        await assert.rejects(service.deleteLocalEvent('tobi-private', 'organized@proton.me'), { name: 'InvitationNotSupportedError' });
        assert.equal((await row('organized@proton.me')).deleted, false, 'still there');

        // Guests invited, but Proton did not take the guest list: the event (without guests) is
        // mapped to Calendar.app's UID, and the save is refused (no automatic retry).
        const uid = 'HALF-DONE';
        failNext({
            success: false,
            reason: 'incomplete',
            error: 'Your guests were invited, but Proton did not save the guest list …',
            eventId: 'ev-half',
            protonUid: 'half@proton.me',
            addEvent: meeting('ev-half', 'half@proton.me', [])
        });
        await assert.rejects(put(uid, calendarAppMeeting({ uid })), { name: 'InvitationNotSupportedError', message: /guest list/ });
        const half = await row(uid);
        assert.equal(half?.protonEventId, 'ev-half', 'the event Proton has is served under Calendar.app\'s UID');
        assert.doesNotMatch(unfold(half.serializedIcs), /ATTENDEE/);

        // Saving again finishes it on that event.
        calls.length = 0;
        await put(uid, calendarAppMeeting({ uid }), half.etag);
        assert.equal(calls[0].input.eventID, 'ev-half');
        assert.match(unfold((await row(uid)).serializedIcs), /mailto:anna@uni\.nl/);
    } finally {
        await cleanup();
    }
});

test('a meeting deleted and saved again (Undo) is a new meeting, served once', async () => {
    const { service, calls, row, rows, put, cleanup } = await setup([meeting('ev-m', 'organized@proton.me', [ANNA])]);
    try {
        const before = await row('organized@proton.me');
        await service.deleteLocalEvent('tobi-private', 'organized@proton.me');
        assert.equal((await row('organized@proton.me')).deleted, true);
        calls.length = 0;
        const again = await put('organized@proton.me', unfold(before.serializedIcs));
        assert.deepEqual(calls.map((call) => [call.action, call.input.eventID]), [['save', undefined]], 'created anew');
        const revived = await row('organized@proton.me');
        assert.equal(revived.deleted, false, 'served again under the same UID');
        assert.equal(revived.protonEventId, 'ev-new-1');
        assert.equal(again.etag, '');

        // A later edit changes that meeting; it does not create yet another one.
        calls.length = 0;
        await put('organized@proton.me', unfold(revived.serializedIcs).replace(/T140000/g, 'T160000').replace(/T150000/g, 'T170000'), revived.etag);
        assert.deepEqual(calls.map((call) => [call.action, call.input.eventID]), [['save', 'ev-new-1']]);
        assert.equal((await rows()).filter((entry) => !entry.deleted).length, 1);
    } finally {
        await cleanup();
    }
});

test('0.48.4: a save "if still the version I read" of a deleted meeting is refused: not created again, nothing sent', async () => {
    const { service, calls, row, put, cleanup } = await setup([meeting('ev-t', 'tb@proton.me', [ANNA])]);
    const original = console.log;
    console.log = () => undefined;
    try {
        const before = await row('tb@proton.me');
        await service.deleteLocalEvent('tobi-private', 'tb@proton.me');
        calls.length = 0;
        // Thunderbird, a minute later: dismissing the alert re-saves its old copy with If-Match.
        await assert.rejects(put('tb@proton.me', unfold(before.serializedIcs).replace('END:VEVENT', 'X-MOZ-LASTACK:20261019T224500Z\r\nEND:VEVENT'), before.etag), (error: any) => error.name === 'StaleEventError');
        assert.deepEqual(calls, [], 'nothing saved in Proton, no invitation sent');
        assert.equal((await row('tb@proton.me')).deleted, true, 'still deleted');
    } finally {
        console.log = original;
        await cleanup();
    }
});

test('the copy Calendar.app edited goes along; a meeting changed in Proton meanwhile is a 412', async () => {
    const { calls, row, put, failNext, cleanup } = await setup([meeting('ev-m', 'organized@proton.me', [ANNA])]);
    try {
        const before = await row('organized@proton.me');
        const moved = unfold(before.serializedIcs).replace(/T140000/g, 'T160000').replace(/T150000/g, 'T170000');
        failNext({ success: false, reason: 'stale', error: 'This meeting changed in Proton since your calendar app last read it …' });
        await assert.rejects(put('organized@proton.me', moved, before.etag), (error: any) => error instanceof StaleEventError);
        assert.equal(calls[0].input.basedOn.attendee.map(emailOf).join(), ANNA, 'the served version is passed as basedOn');
        assert.equal(calls[0].input.basedOn.dtstart.value.hours, 14);
    } finally {
        await cleanup();
    }
});

test('Calendar.app moving a meeting (copy, then delete): both halves refused', async () => {
    const { service, calls, row, put, cleanup } = await setup([meeting('ev-m', 'organized@proton.me', [ANNA])]);
    try {
        const original = await row('organized@proton.me');
        await service.mirrorDatabase.upsertCalendar({
            protonCalendarId: 'work', slug: 'tobi-work', displayName: 'Work', color: '#654321', description: '', visible: true,
            removed: false, ctag: '1', lastPolledAt: null, lastSyncedAt: null
        });
        await assert.rejects(
            service.upsertLocalEvent('tobi-work', 'organized%40proton.me.ics', '/calendars/neutron-calendar-bridge/tobi-work/organized%40proton.me.ics', unfold(original.serializedIcs)),
            { message: INVITATION_MESSAGES.moveMeeting }
        );
        await assert.rejects(service.deleteLocalEvent('tobi-private', 'organized@proton.me'), { message: INVITATION_MESSAGES.moveMeetingDelete });
        assert.deepEqual(calls, [], 'nobody was emailed');
        assert.equal((await row('organized@proton.me')).deleted, false);
        void put;
    } finally {
        await cleanup();
    }
});

test('invitation emails are logged with what they were', async () => {
    const { service, cleanup } = await setup([]);
    try {
        service.recordInvitationEmail({
            at: '2026-10-01T10:00:00.000Z', method: 'REQUEST', kind: 'update', from: ME,
            to: [{ email: ANNA, name: ANNA, delivery: 'proton' }], subject: 'Update for an event', eventTitle: 'Project kickoff',
            eventUid: 'x@proton.me', outcome: 'sent'
        });
        service.recordInvitationEmail({
            at: '2026-10-01T10:01:00.000Z', method: 'REPLY', answer: 'ACCEPTED', from: ME,
            to: [{ email: ANNA, name: ANNA }], subject: 'Re: Invitation', eventTitle: 'Talk', eventUid: 'y', outcome: 'sent'
        });
        const [reply, update] = service.recentInvitationEmails;
        assert.equal(update.kind, 'update');
        assert.equal(reply.kind, 'answer', 'a stage 2 record without kind is an answer');
        assert.equal(reply.answer, 'ACCEPTED');
    } finally {
        await cleanup();
    }
});

/** An occurrence Calendar.app changed ("this event only"), added to the served series. */
const withOccurrence = (servedIcs: string, recurrenceId: string, start: string, guests = [ANNA]) => {
    const unfolded = unfold(servedIcs);
    const occurrence = [
        'BEGIN:VEVENT', `UID:${unfolded.match(/^UID:(.+)$/m)![1]}`, 'DTSTAMP:20261001T090000Z',
        `RECURRENCE-ID;TZID=${TZ}:${recurrenceId}`,
        `DTSTART;TZID=${TZ}:${start}`, `DTEND;TZID=${TZ}:${start.replace(/T(\d\d)/, (_, hours) => `T${String(Number(hours) + 1).padStart(2, '0')}`)}`,
        'SUMMARY:Project kickoff',
        `ORGANIZER;CN=Tobi:mailto:${ME}`,
        ...guests.map((guest) => `ATTENDEE;PARTSTAT=NEEDS-ACTION;ROLE=REQ-PARTICIPANT:mailto:${guest}`),
        'END:VEVENT'
    ].join('\r\n');
    return unfolded.replace('END:VCALENDAR', `${occurrence}\r\nEND:VCALENDAR`);
};

test('recurring meetings you organize go to the client as a whole series (stage 3b)', async () => {
    const { calls, row, put, cleanup } = await setup([meeting('ev-w', 'weekly@proton.me', [ANNA], { rrule: true })], { series: true });
    try {
        // One occurrence moved in Calendar.app ("this event only").
        const served = await row('weekly@proton.me');
        const result = await put('weekly@proton.me', withOccurrence(served.serializedIcs, '20261014T140000', '20261014T160000'), served.etag);
        assert.deepEqual(calls.map((call) => call.action), ['saveSeries']);
        const [{ input }] = calls;
        assert.equal(input.calendarID, 'private');
        assert.equal(input.eventID, 'ev-w', 'the series\' main event');
        assert.equal(input.vevents.length, 2, 'the main event and the changed occurrence');
        assert.ok(input.vevents[1]['recurrence-id']);
        assert.equal(input.basedOn.length, 1, 'the served version (main event only) as basedOn');
        assert.ok(input.basedOn[0].rrule);
        assert.equal(result.etag, '', 'no ETag: Calendar.app re-fetches Proton\'s version');
        const after = await row('weekly@proton.me');
        assert.deepEqual(after.protonEventIds, { '': 'ev-w', '20261014T140000': 'ev-w-x1' }, 'served with the changed occurrence');

        // The next save is based on that: both VEVENTs go along.
        calls.length = 0;
        await put('weekly@proton.me', unfold(after.serializedIcs).replace(/SUMMARY:Project kickoff/g, 'SUMMARY:Kickoff'), after.etag);
        assert.equal(calls[0].action, 'saveSeries');
        assert.equal(calls[0].input.basedOn.length, 2);
    } finally {
        await cleanup();
    }
});

test('a recurring meeting created in Calendar.app; a single meeting that starts repeating', async () => {
    const { calls, row, put, cleanup } = await setup([meeting('ev-one', 'one@proton.me', [ANNA])], { series: true });
    try {
        const uid = 'CA-WEEKLY-1';
        await put(uid, calendarAppMeeting({ uid, extraLines: ['RRULE:FREQ=WEEKLY;COUNT=4'] }));
        assert.deepEqual(calls.map((call) => [call.action, call.input.eventID, call.input.basedOn]), [['saveSeries', undefined, undefined]]);
        assert.equal((await row(uid)).protonEventId, 'ev-new-1', 'served under Calendar.app\'s UID');

        calls.length = 0;
        const one = await row('one@proton.me');
        await put('one@proton.me', unfold(one.serializedIcs).replace('END:VEVENT', 'RRULE:FREQ=DAILY;COUNT=3\r\nEND:VEVENT'), one.etag);
        assert.deepEqual(calls.map((call) => [call.action, call.input.eventID]), [['saveSeries', 'ev-one']], 'the series path, not the single one');
        assert.match(unfold((await row('one@proton.me')).serializedIcs), /^RRULE:/m);

        // Single meetings keep the stage 3a path.
        calls.length = 0;
        const single = 'CA-SINGLE-1';
        await put(single, calendarAppMeeting({ uid: single }));
        assert.deepEqual(calls.map((call) => call.action), ['save']);
    } finally {
        await cleanup();
    }
});

test('0.49.5: after a conflict, a series save that still carries the occurrences as they were before Proton\'s change leaves them out (Thunderbird\'s "Submit my changes anyway")', async () => {
    const { service, calendar, calls, row, put, proton, cleanup } = await setup(
        [
            meeting('ev-w', 'weekly@proton.me', [ANNA], { rrule: true }),
            meeting('ev-w-x', 'weekly@proton.me', [ANNA], { start: at(2026, 10, 14, 16), recurrenceId: at(2026, 10, 14, 14) })
        ],
        { series: true }
    );
    const resync = async () => service.syncEventsForCalendar(await service.mirrorDatabase.getCalendarBySlug(calendar.slug));
    try {
        const before = await row('weekly@proton.me');
        assert.match(unfold(before.serializedIcs), /RECURRENCE-ID/, 'setup: the series with its changed occurrence');
        // Renamed in Proton meanwhile — the series and, as Proton does, its occurrence too.
        const rename = (event: SyncedCalendarEvent, hash: string) => {
            const renamed = structuredClone(event);
            renamed.title = 'Renamed in Proton';
            (renamed.decrypted as any).vevent.summary = { value: 'Renamed in Proton' };
            renamed.contentHash = hash;
            return renamed;
        };
        proton.events = proton.events.map((event) => rename(event, `${event.eventId}-renamed`));
        await resync();
        const current = await row('weekly@proton.me');
        assert.notEqual(current.etag, before.etag, 'setup: Proton\'s change is in');
        // The stale copy, with its series title changed, saved with the current ETag (what "Submit my
        // changes anyway" does): the series change goes through, the stale occurrence is left out.
        const retitle = (ics: string, inMaster: string, inOccurrence: string) =>
            ics.replace(/BEGIN:VEVENT[\s\S]*?END:VEVENT/g, (block) => block.replace('SUMMARY:Project kickoff', /RECURRENCE-ID/.test(block) ? inOccurrence : inMaster));
        const stale = retitle(unfold(before.serializedIcs), 'SUMMARY:My title', 'SUMMARY:Project kickoff');
        assert.equal((stale.match(/SUMMARY:Project kickoff/g) || []).length, 1, 'setup: only the series title changed, the occurrence as served');
        calls.length = 0;
        await put('weekly@proton.me', stale, current.etag);
        assert.equal(calls.length, 1);
        assert.equal(calls[0].action, 'saveSeries');
        assert.equal(calls[0].input.vevents.length, 1, 'the stale occurrence is not part of the save');
        assert.equal(calls[0].input.vevents[0].summary.value, 'My title');
        // The same copy more than the memory allows (or an occurrence changed by the user) still goes along.
        calls.length = 0;
        const changedOccurrence = retitle(unfold(before.serializedIcs), 'SUMMARY:My title', 'SUMMARY:Occurrence title');
        await put('weekly@proton.me', changedOccurrence, (await row('weekly@proton.me')).etag);
        assert.equal(calls[0].input.vevents.length, 2, 'an occurrence the user changed goes along (the client decides)');
    } finally {
        await cleanup();
    }
});

test('0.49.12: a Tentative status is no change — Proton stores confirmed or cancelled only, nothing is written or sent', async () => {
    const { calls, row, put, cleanup } = await setup([meeting('ev-m', 'meeting@proton.me', [ANNA])]);
    try {
        const served = await row('meeting@proton.me');
        const unfolded = unfold(served.serializedIcs);
        const tentative = /STATUS:CONFIRMED/.test(unfolded) ? unfolded.replace('STATUS:CONFIRMED', 'STATUS:TENTATIVE') : unfolded.replace('END:VEVENT', 'STATUS:TENTATIVE\r\nEND:VEVENT');
        const result = await put('meeting@proton.me', tentative, served.etag);
        assert.deepEqual(calls, [], 'nothing written, no email');
        assert.equal(result.etag, '', 'no ETag: the app fetches the stored (confirmed) version');
    } finally {
        await cleanup();
    }
});

test('deleting a recurring meeting you organize cancels the whole series', async () => {
    const { service, calls, row, cleanup } = await setup(
        [
            meeting('ev-w', 'weekly@proton.me', [ANNA], { rrule: true }),
            meeting('ev-w-x', 'weekly@proton.me', [ANNA], { start: at(2026, 10, 14, 16), recurrenceId: at(2026, 10, 14, 14) })
        ],
        { series: true }
    );
    try {
        assert.equal(Object.keys((await row('weekly@proton.me')).protonEventIds).length, 2);
        await service.deleteLocalEvent('tobi-private', 'weekly@proton.me');
        assert.deepEqual(calls, [{ action: 'cancel', input: { calendarID: 'private', eventID: 'ev-w', notifyAttendees: true } }], 'the main event\'s ID');
        assert.equal((await row('weekly@proton.me')).deleted, true);
    } finally {
        await cleanup();
    }
});

test('series refusals: a stale copy is a 412, a refusal a 403 with the client\'s reason', async () => {
    const { calls, row, put, failNext, cleanup } = await setup([meeting('ev-w', 'weekly@proton.me', [ANNA], { rrule: true })], { series: true });
    try {
        const served = await row('weekly@proton.me');
        const moved = withOccurrence(served.serializedIcs, '20261014T140000', '20261014T160000');
        await assert.rejects(put('weekly@proton.me', moved, '"outdated"'), (error: any) => error instanceof StaleEventError);
        assert.deepEqual(calls, [], 'an outdated copy never reaches the client');

        failNext({ success: false, reason: 'stale', error: 'This meeting changed in Proton since your calendar app last read it …' });
        await assert.rejects(put('weekly@proton.me', moved, served.etag), (error: any) => error instanceof StaleEventError);

        failNext({ success: false, reason: 'unsupported', error: 'Guests can only be changed for the whole series (like in Proton Calendar). …' });
        await assert.rejects(put('weekly@proton.me', withOccurrence(served.serializedIcs, '20261014T140000', '20261014T140000', [ANNA, CARLA]), served.etag), {
            name: 'InvitationNotSupportedError',
            message: /whole series/
        });
        assert.equal((await row('weekly@proton.me')).serializedIcs, served.serializedIcs, 'mirror unchanged');
    } finally {
        await cleanup();
    }
});

test('a copy from before the last sync is accepted when only the format or answers changed (else 412)', async () => {
    const { service, calendar, calls, row, put, proton, cleanup } = await setup([plain('ev-plain', 'plain@proton.me')]);
    const resync = async () => service.syncEventsForCalendar(await service.mirrorDatabase.getCalendarBySlug(calendar.slug));
    try {
        // Calendar.app holds the first version's ETag; a sync pass writes the same event out again.
        const first = await row('plain@proton.me');
        proton.events[0] = { ...proton.events[0], modifiedTimestamp: proton.events[0].modifiedTimestamp + 60, contentHash: 'rewritten' };
        await resync();
        const rewritten = await row('plain@proton.me');
        assert.notEqual(rewritten.etag, first.etag, 'setup: the sync pass changed the ETag');
        // Adding a guest from that copy (what failed silently with a 412 live).
        const withGuest = unfold(first.serializedIcs).replace('END:VEVENT', `ORGANIZER:mailto:${ME}\r\nATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:${ANNA}\r\nEND:VEVENT`);
        await put('plain@proton.me', withGuest, first.etag);
        assert.deepEqual(calls.map((call) => [call.action, call.input.eventID]), [['save', 'ev-plain']], 'accepted: only the format differed');

        // A meeting: a guest's answer arrives (sync pass) — a save from the copy before it still goes through.
        calls.length = 0;
        await resync();
        const meetingRow = await row('plain@proton.me');
        const answered = structuredClone(proton.events[0]);
        (answered.decrypted as any).vevent.attendee[0].parameters.partstat = 'ACCEPTED';
        proton.events[0] = { ...answered, contentHash: 'answered' };
        await resync();
        assert.notEqual((await row('plain@proton.me')).etag, meetingRow.etag);
        const moved = unfold(meetingRow.serializedIcs).replace(/T140000/g, 'T160000').replace(/T150000/g, 'T170000');
        await put('plain@proton.me', moved, meetingRow.etag);
        assert.equal(calls.length, 1, 'accepted: only an answer differed');

        // The title changed in Proton meanwhile: that copy would undo it — 412, nothing sent.
        calls.length = 0;
        const beforeRename = await row('plain@proton.me');
        proton.events[0] = { ...proton.events[0], title: 'Renamed in Proton', contentHash: 'renamed' };
        (proton.events[0].decrypted as any).vevent = { ...(proton.events[0].decrypted as any).vevent, summary: { value: 'Renamed in Proton' } };
        await resync();
        await assert.rejects(put('plain@proton.me', unfold(beforeRename.serializedIcs).replace(/T160000/g, 'T180000'), beforeRename.etag), (error: any) => error instanceof StaleEventError);
        assert.deepEqual(calls, [], 'refused before anything was sent');

        // An ETag the bridge never served stays a 412.
        await assert.rejects(put('plain@proton.me', moved, '"made-up"'), (error: any) => error instanceof StaleEventError);
    } finally {
        await cleanup();
    }
});

test('0.44.1: a meeting made in Calendar.app, renamed before the next sync — not found by UID right after the save, it stays (it vanished until the next pass)', async () => {
    const { service, row, put, cleanup } = await setup([]);
    const adapter = service.protonAdapter as any;
    const lookup = adapter.listEventsByUid;
    const logs: string[] = [];
    const log = console.log;
    console.log = (...args: unknown[]) => logs.push(args.join(' '));
    try {
        const uid = 'B0D9E1F2-6C3A-4E1B-8A47-2D1C0E6F9A22';
        await put(uid, calendarAppMeeting({ uid, guests: [ANNA] }));
        assert.equal(service.protonUidOf(await row(uid)), 'new-1@proton.me', 'Proton\'s UID known right after the meeting was made');
        // Proton's search by UID misses the just-saved event once (or the UID is not Proton's).
        let missed = 0;
        adapter.listEventsByUid = async (calendarId: string, wanted: string) => (missed++ === 0 ? [] : lookup(calendarId, wanted));
        const renamed = calendarAppMeeting({ uid, guests: [ANNA] }).replace(/SUMMARY:[^\r\n]*/, 'SUMMARY:Breakfast with Hack');
        await put(uid, renamed);
        const after = await row(uid);
        assert.ok(after && !after.deleted, 'still served to Calendar.app');
        assert.ok(logs.some((line) => /re-read of .* after a change: Proton listed 0 event\(s\) by its Proton UID/.test(line)), 'the miss is logged');
        // A real cancellation still removes it at once.
        adapter.listEventsByUid = lookup;
        await service.deleteLocalEvent('tobi-private', uid);
        assert.equal((await row(uid))?.deleted ?? true, true, 'cancelled: gone');
    } finally {
        console.log = log;
        await cleanup();
    }
});
