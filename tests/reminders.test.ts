/**
 * Reminders both ways (0.33): Proton's notifications (or the calendar's defaults) are served to
 * Calendar.app as VALARMs and change the ETag; Calendar.app's alarms on a plain event travel with
 * the write; on a meeting or invitation an alarm change goes through the personal part alone
 * (setEventReminders) — no organizer write, no emails — also together with an answer or a change,
 * and for a meeting created in Calendar.app with alarms; an older client leaves everything as it was.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SyncedCalendarEvent } from 'proton-calendar-client';
import { fakeSafeStorage } from './support/fake-safe-storage';
import { buildEventRecordShape, toIcs } from '../src/main/sync-utils';
import { buildSeriesIcs, groupIntoSeries } from '../src/main/recurrence';

const electronApp: any = { setLoginItemSettings: () => undefined, isPackaged: false };
const stubElectron = () => {
    const resolved = require.resolve('electron');
    require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: { app: electronApp, safeStorage: fakeSafeStorage } } as unknown as NodeJS.Module;
};

const TZ = 'Europe/Amsterdam';
const ME = 'tobi@proton.me';
const ALARM_30 = 'BEGIN:VALARM\r\nTRIGGER:-PT30M\r\nACTION:DISPLAY\r\nDESCRIPTION:Reminder\r\nEND:VALARM';
const ALARM_1D_EMAIL = 'BEGIN:VALARM\r\nTRIGGER:-P1D\r\nACTION:EMAIL\r\nSUMMARY:Project sync\r\nDESCRIPTION:Tomorrow\r\nATTENDEE:mailto:tobi@proton.me\r\nEND:VALARM';
const at = (year: number, month: number, day: number, hours: number) => ({ value: { year, month, day, hours, minutes: 0, seconds: 0, isUTC: false }, parameters: { tzid: TZ } });
const person = (email: string, parameters: Record<string, string> = {}) => ({ value: `mailto:${email}`, parameters });

const plain = (reminders?: { hasDefaults: boolean; alarms: string[] }): SyncedCalendarEvent => ({
    calendarId: 'private',
    eventId: 'ev-plain',
    uid: 'plain@proton.me',
    title: 'Dentist',
    description: '',
    location: '',
    startTimestamp: Date.UTC(2026, 9, 5, 8) / 1000,
    endTimestamp: Date.UTC(2026, 9, 5, 9) / 1000,
    timezone: TZ,
    isAllDay: false,
    modifiedTimestamp: 1_790_000_000,
    contentHash: 'x',
    decrypted: { vevent: { dtstart: at(2026, 10, 5, 10), dtend: at(2026, 10, 5, 11) }, ...(reminders ? { reminders } : {}) }
});

const meeting = (reminders?: { hasDefaults: boolean; alarms: string[] }, extra: Partial<SyncedCalendarEvent> = {}): SyncedCalendarEvent => ({
    ...plain(reminders),
    eventId: 'ev-organized',
    uid: 'organized@proton.me',
    title: 'Project sync',
    decrypted: {
        vevent: {
            dtstart: at(2026, 10, 5, 10),
            dtend: at(2026, 10, 5, 11),
            sequence: { value: 1 },
            organizer: person(ME, { cn: 'Tobi' }),
            attendee: [person('anna@uni.nl', { cn: 'Anna', partstat: 'ACCEPTED', role: 'REQ-PARTICIPANT' })]
        },
        participation: { isOrganizer: true, isAttendee: false, selfEmail: ME },
        ...(reminders ? { reminders } : {})
    },
    ...extra
});

test('served ICS: a plain event carries its reminders as VALARMs inside the VEVENT, and the ETag follows them', () => {
    const base = { ...plain(), href: '/x.ics', protonEventId: 'ev-plain', protonCalendarId: 'private' } as any;
    const without = buildEventRecordShape(base);
    const withAlarms = buildEventRecordShape({ ...base, alarms: [ALARM_30, ALARM_1D_EMAIL] });
    const other = buildEventRecordShape({ ...base, alarms: [ALARM_30] });
    assert.doesNotMatch(without.serializedIcs, /VALARM/);
    const U = 'UID:[0-9A-F-]{36}\\r\\nX-WR-ALARMUID:[0-9A-F-]{36}\\r\\n';
    assert.match(withAlarms.serializedIcs, new RegExp(`BEGIN:VEVENT[\\s\\S]*BEGIN:VALARM\\r\\n${U}TRIGGER:-PT30M\\r\\nACTION:DISPLAY[\\s\\S]*END:VALARM\\r\\nBEGIN:VALARM\\r\\n${U}TRIGGER:-P1D\\r\\nACTION:EMAIL[\\s\\S]*END:VALARM\\r\\nEND:VEVENT`));
    // 0.41.8: stable alarm IDs (Calendar.app matches alarms by them): the same on every serving, different per alarm.
    const ids = (text: string) => [...text.matchAll(/^X-WR-ALARMUID:(\S+)/gm)].map((m) => m[1]);
    assert.deepEqual(ids(buildEventRecordShape({ ...base, alarms: [ALARM_30, ALARM_1D_EMAIL] }).serializedIcs), ids(withAlarms.serializedIcs), 'stable');
    assert.equal(new Set(ids(buildEventRecordShape({ ...base, alarms: [ALARM_30, ALARM_30] }).serializedIcs)).size, 2, 'two equal alarms, two IDs');
    // 0.41.9: an email alarm carries the title; a new title (the organizer renamed the meeting) keeps its ID.
    const renamed = buildEventRecordShape({ ...base, title: 'Dentist (moved)', alarms: [ALARM_30, ALARM_1D_EMAIL.replace('SUMMARY:Project sync', 'SUMMARY:Project sync (renamed)')] });
    assert.deepEqual(ids(renamed.serializedIcs), ids(withAlarms.serializedIcs), 'same IDs after the title changed');
    assert.notEqual(without.contentHash, withAlarms.contentHash, 'reminders are part of the content hash');
    assert.notEqual(other.contentHash, withAlarms.contentHash, 'a different set, a different hash');
    assert.equal(toIcs({ ...base, alarms: [] }), toIcs(base), 'no alarms: the ICS as before 0.33');
});

test('served ICS: a meeting (series ICS) carries each member\'s reminders', () => {
    const ics = unfold(buildSeriesIcs(groupIntoSeries([meeting({ hasDefaults: true, alarms: [ALARM_30] })])[0], 2026));
    assert.match(ics, /ATTENDEE[^\r\n]*anna@uni\.nl\r\nBEGIN:VALARM\r\nUID:[0-9A-F-]{36}\r\nX-WR-ALARMUID:[0-9A-F-]{36}\r\nTRIGGER:-PT30M\r\nACTION:DISPLAY\r\nDESCRIPTION:Reminder\r\nEND:VALARM\r\nEND:VEVENT/);
});

const setup = async (events: SyncedCalendarEvent[], { reminders = true }: { reminders?: boolean } = {}) => {
    stubElectron();
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { BridgeService } = require('../src/main/bridge-service') as typeof import('../src/main/bridge-service');
    const baseDir = mkdtempSync(join(tmpdir(), 'neutron-calendar-bridge-reminders-'));
    const service = new BridgeService(baseDir) as any;
    await service.mirrorDatabase.initialize();
    service.localCaldavPassword = 'test';
    const calendar = { protonCalendarId: 'private', slug: 'tobi-private', displayName: 'Tobi (Private)', color: '#123456', description: '', visible: true, removed: false, ctag: '1', lastPolledAt: null, lastSyncedAt: null };
    await service.mirrorDatabase.upsertCalendar(calendar);
    const client = await import('proton-calendar-client');
    const api = new client.ProtonCalendarAPI({ username: 'u', password: 'p' });
    const writes: Array<{ kind: string; detail?: unknown }> = [];
    service.protonAdapter = {
        isSignedIn: () => true,
        supportsSeriesSync: () => true,
        supportsInvitations: () => true,
        supportsOrganizing: () => true,
        parseIcs: (ics: string) => api.parseIcsToVevents(ics),
        listAddresses: () => [{ email: ME, displayName: 'Tobi', active: true, order: 1 }],
        listEvents: async () => events,
        syncSeries: async (input: any) => {
            writes.push({ kind: 'syncSeries', detail: input.components.map((c: any) => (c.vevent.components || []).length) });
            return { success: true, eventIds: input.components.map((_: unknown, i: number) => `new-${i}`) };
        },
        updateEvent: async (_calendarId: string, _eventId: string, eventData: any) => {
            writes.push({ kind: 'updateEvent', detail: eventData.alarms });
            return { success: true };
        },
        createEvent: async (_calendarId: string, eventData: any) => {
            writes.push({ kind: 'createEvent', detail: eventData.alarms });
            return { success: true, id: 'new-1' };
        },
        deleteEvent: async () => ({ success: true }),
        saveOrganizedEvent: async (input: any) => {
            writes.push({ kind: 'saveOrganizedEvent' });
            return { success: true, eventId: input.eventID || 'new-meeting', emails: [] };
        },
        answerInvitation: async (input: any) => {
            writes.push({ kind: 'answerInvitation', detail: input.answer });
            return { success: true, emails: [] };
        },
        ...(reminders
            ? {
                  supportsReminders: () => true,
                  alarmBlocksOf: async (ics: string) => client.alarmBlocksOf(ics),
                  alarmNormalizer: async () => (vevent: any) => client.normalizeAlarms(vevent, TZ),
                  setEventReminders: async (_calendarId: string, eventId: string, alarms: string[]) => {
                      writes.push({ kind: 'setEventReminders', detail: { eventId, alarms } });
                      return { success: true, changed: true };
                  }
              }
            : {})
    };
    service.refreshAccountAddresses();
    await service.syncEventsForCalendar(calendar);
    const rows = await service.mirrorDatabase.listEventsForCalendar('private');
    const row = (uid: string) => rows.find((entry: any) => entry.uid === uid);
    const put = (record: any, ics: string) => service.upsertLocalEvent('tobi-private', `${encodeURIComponent(record.uid)}.ics`, record.href, ics);
    const cleanup = async () => {
        await service.mirrorDatabase.close();
        rmSync(baseDir, { recursive: true, force: true });
    };
    return { service, writes, row, put, cleanup };
};

const unfold = (ics: string) => ics.replace(/\r\n[ \t]/g, '');
const asCalendarApp = (ics: string, edit: (text: string) => string) =>
    edit(unfold(ics).replace('PRODID:-//Neutron Calendar Bridge//EN', 'PRODID:-//Apple Inc.//macOS 26.0//EN'));
const withAlarms = (ics: string, alarms: string[]) => asCalendarApp(ics, (text) => text.replace(/BEGIN:VALARM[\s\S]*?END:VALARM\r\n/g, '').replace('END:VEVENT', `${alarms.join('\r\n')}${alarms.length ? '\r\n' : ''}END:VEVENT`));

test('a plain event: Calendar.app\'s alarms travel with the write (as VALARM blocks); none means none', async () => {
    const { service, writes, row, put, cleanup } = await setup([plain({ hasDefaults: true, alarms: [ALARM_30] })]);
    try {
        const record = row('plain@proton.me');
        assert.match(record.serializedIcs, /TRIGGER:-PT30M/, 'served with the default reminder');
        await put(record, withAlarms(record.serializedIcs, [ALARM_1D_EMAIL, ALARM_30]));
        assert.equal(writes.length, 1, JSON.stringify(writes));
        assert.equal(writes[0].kind, 'updateEvent');
        assert.deepEqual(writes[0].detail, [ALARM_1D_EMAIL, ALARM_30], 'the VALARM blocks, as the client sent them');
        await put(record, withAlarms(record.serializedIcs, []));
        assert.deepEqual(writes[1].detail, [], 'all alarms removed: an empty list (the client stores "none")');

        // Re-saved with nothing Proton stores changed (Apple's PRODID, DTSTAMP): not rewritten.
        writes.length = 0;
        const stored = (await service.mirrorDatabase.getEventByUid('private', 'plain@proton.me')) as any;
        const resaved = asCalendarApp(stored.serializedIcs, (text) => text.replace(/DTSTAMP:\d{8}T\d{6}Z/, 'DTSTAMP:20261006T120000Z'));
        const result = await put(record, resaved);
        assert.deepEqual(writes, [], 'a plain event re-saved with nothing Proton stores changed is not rewritten');
        assert.equal(result.etag, '', 'no ETag: Calendar.app re-reads the stored version');
        // The same with an alert dismissed (ACKNOWLEDGED, X-WR-ALARMUID added to the same alarm).
        await put(record, withAlarms(record.serializedIcs, [ALARM_30]));
        writes.length = 0;
        const withDismissed = asCalendarApp(((await service.mirrorDatabase.getEventByUid('private', 'plain@proton.me')) as any).serializedIcs, (text) =>
            text.replace('END:VALARM', 'ACKNOWLEDGED:20261005T081500Z\r\nX-WR-ALARMUID:abc\r\nEND:VALARM')
        );
        await put(record, withDismissed);
        assert.deepEqual(writes, [], 'dismissing an alert (ACKNOWLEDGED added) does not rewrite the event');
    } finally {
        await cleanup();
    }
});

test('a meeting you organize: an alarm change alone goes through the personal part, nothing else is written', async () => {
    const { writes, row, put, cleanup } = await setup([meeting({ hasDefaults: true, alarms: [ALARM_30] })]);
    try {
        const record = row('organized@proton.me');
        const result = await put(record, withAlarms(record.serializedIcs, [ALARM_1D_EMAIL]));
        assert.equal(result.etag, '', 'no ETag: Calendar.app fetches Proton\'s version again');
        assert.deepEqual(writes.map((w) => w.kind), ['setEventReminders'], 'no organizer write, so no emails');
        assert.deepEqual(writes[0].detail, { eventId: 'ev-organized', alarms: [ALARM_1D_EMAIL] });

        // The same alarms again (Calendar.app re-saving after the fetch): nothing to do.
        writes.length = 0;
        await put(record, withAlarms(record.serializedIcs, [ALARM_30]));
        assert.deepEqual(writes, [], 'unchanged reminders: no write');
        // Apple's extras on the same alarm do not count as a change either.
        await put(record, withAlarms(record.serializedIcs, ['BEGIN:VALARM\r\nX-WR-ALARMUID:1\r\nUID:1\r\nTRIGGER:-PT30M\r\nACTION:DISPLAY\r\nDESCRIPTION:Erinnerung\r\nACKNOWLEDGED:20261001T100000Z\r\nEND:VALARM']));
        assert.deepEqual(writes, [], 'UID, ACKNOWLEDGED and the text are not reminders');
    } finally {
        await cleanup();
    }
});

test('an invitation: accepting and changing the alarm in one save answers, then sets the reminder', async () => {
    const invitation = meeting({ hasDefaults: true, alarms: [ALARM_30] }, {
        eventId: 'ev-invited',
        uid: 'invited@uni.nl',
        decrypted: {
            vevent: {
                dtstart: at(2026, 10, 5, 10),
                dtend: at(2026, 10, 5, 11),
                sequence: { value: 1 },
                organizer: person('dean@uni.nl', { cn: 'The Dean' }),
                attendee: [person(ME, { cn: 'Tobi', partstat: 'NEEDS-ACTION', role: 'REQ-PARTICIPANT' })]
            },
            participation: { isOrganizer: false, isAttendee: true, selfEmail: ME, selfAttendeeIndex: 0 },
            reminders: { hasDefaults: true, alarms: [ALARM_30] }
        }
    });
    const { writes, row, put, cleanup } = await setup([invitation]);
    try {
        const record = row('invited@uni.nl');
        const accepted = withAlarms(record.serializedIcs, [ALARM_1D_EMAIL]).replace(/(ATTENDEE;[^\r\n]*PARTSTAT=)NEEDS-ACTION([^\r\n]*:mailto:tobi@proton\.me)/, '$1ACCEPTED$2');
        await put(record, accepted);
        assert.deepEqual(writes.map((w) => w.kind), ['answerInvitation', 'setEventReminders']);
        assert.deepEqual(writes[1].detail, { eventId: 'ev-invited', alarms: [ALARM_1D_EMAIL] });
    } finally {
        await cleanup();
    }
});

test('0.40: an invitation series — an alert for one occurrence that is not an event of its own is refused with Proton\'s rule', async () => {
    const series = meeting({ hasDefaults: true, alarms: [ALARM_30] }, {
        eventId: 'ev-invited-series',
        uid: 'weekly@uni.nl',
        decrypted: {
            vevent: {
                dtstart: at(2026, 10, 5, 10),
                dtend: at(2026, 10, 5, 11),
                rrule: { value: { freq: 'WEEKLY' } },
                sequence: { value: 1 },
                organizer: person('dean@uni.nl', { cn: 'The Dean' }),
                attendee: [person(ME, { cn: 'Tobi', partstat: 'ACCEPTED', role: 'REQ-PARTICIPANT' })]
            },
            participation: { isOrganizer: false, isAttendee: true, selfEmail: ME, selfAttendeeIndex: 0 },
            reminders: { hasDefaults: true, alarms: [ALARM_30] }
        }
    } as any);
    const { writes, row, put, cleanup } = await setup([series]);
    try {
        const record = row('weekly@uni.nl');
        const unfolded = record.serializedIcs.replace(/\r\n[ \t]/g, '');
        const block = unfolded.match(/BEGIN:VEVENT\r\n[\s\S]*?END:VEVENT\r\n/)![0];
        assert.match(block, /RRULE:FREQ=WEEKLY/, 'the served series');
        // What Calendar.app sends for "this event only" with a new alert: the occurrence of 12 October as a VEVENT of its own.
        const occurrence = (start: string, end: string) =>
            block
                .replace(/RRULE:[^\r\n]*\r\n/, '')
                .replace(/DTSTART;TZID=Europe\/Amsterdam:20261005T100000/, `RECURRENCE-ID;TZID=Europe/Amsterdam:20261012T100000\r\nDTSTART;TZID=Europe/Amsterdam:${start}`)
                .replace(/DTEND;TZID=Europe\/Amsterdam:20261005T110000/, `DTEND;TZID=Europe/Amsterdam:${end}`)
                .replace(/BEGIN:VALARM[\s\S]*?END:VALARM\r\n/g, '')
                .replace('END:VEVENT', 'BEGIN:VALARM\r\nTRIGGER:-P1D\r\nACTION:DISPLAY\r\nDESCRIPTION:Reminder\r\nEND:VALARM\r\nEND:VEVENT');
        const withOccurrence = (start: string, end: string) => unfolded.replace('END:VCALENDAR', `${occurrence(start, end)}END:VCALENDAR`);
        await assert.rejects(put(record, withOccurrence('20261012T100000', '20261012T110000')), (error: any) =>
            error.name === 'InvitationNotSupportedError' && /Set the reminder on all events instead/.test(error.message)
        );
        assert.deepEqual(writes, [], 'nothing written');
        // Moving that occurrence is something else (refused as before), not taken for a reminder change.
        await assert.rejects(put(record, withOccurrence('20261012T140000', '20261012T150000')), (error: any) =>
            error.name === 'InvitationNotSupportedError' && !/Set the reminder on all events instead/.test(error.message)
        );
        // The whole series' alert goes through as before.
        await put(record, withAlarms(record.serializedIcs, [ALARM_1D_EMAIL]));
        assert.deepEqual(writes.map((w) => w.kind), ['setEventReminders']);
    } finally {
        await cleanup();
    }
});

test('a meeting created in Calendar.app with alarms: saved, then its reminders set', async () => {
    const { writes, row, put, cleanup } = await setup([plain({ hasDefaults: true, alarms: [] })]);
    try {
        const record = row('plain@proton.me');
        const asMeeting = asCalendarApp(record.serializedIcs, (text) =>
            text.replace('END:VEVENT', `ORGANIZER;CN=Tobi:mailto:${ME}\r\nATTENDEE;CN=Anna;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:anna@uni.nl\r\n${ALARM_30}\r\nEND:VEVENT`)
        );
        await put(record, asMeeting);
        assert.deepEqual(writes.map((w) => w.kind), ['saveOrganizedEvent', 'setEventReminders']);
        assert.deepEqual((writes[1].detail as any).alarms, [ALARM_30]);
    } finally {
        await cleanup();
    }
});

test('a changed occurrence split off in Calendar.app with its own alarm: set after the exception exists', async () => {
    const weekly = meeting({ hasDefaults: true, alarms: [] }, {
        decrypted: {
            vevent: {
                dtstart: at(2026, 10, 5, 10),
                dtend: at(2026, 10, 5, 11),
                rrule: { value: { freq: 'WEEKLY' } },
                sequence: { value: 1 },
                organizer: person(ME, { cn: 'Tobi' }),
                attendee: [person('anna@uni.nl', { cn: 'Anna', partstat: 'ACCEPTED', role: 'REQ-PARTICIPANT' })]
            },
            participation: { isOrganizer: true, isAttendee: false, selfEmail: ME },
            reminders: { hasDefaults: true, alarms: [] }
        }
    });
    const { service, writes, row, put, cleanup } = await setup([weekly]);
    try {
        service.protonAdapter.supportsOrganizingSeries = () => true;
        service.protonAdapter.saveOrganizedSeries = async () => {
            writes.push({ kind: 'saveOrganizedSeries' });
            // The exception now exists in Proton: the mirror learns its ID at the re-read.
            const current = await service.mirrorDatabase.getEventByUid('private', 'organized@proton.me');
            await service.mirrorDatabase.upsertEvent({ ...current, protonEventIds: { ...current.protonEventIds, '20261012T100000': 'ev-exception' } });
            return { success: true, eventId: 'ev-organized', emails: [] };
        };
        const record = row('organized@proton.me');
        const master = unfold(record.serializedIcs);
        const exception = master
            .match(/BEGIN:VEVENT[\s\S]*?END:VEVENT/)![0]
            .replace(/RRULE:[^\r\n]*\r\n/, '')
            .replace(/DTSTART;TZID=Europe\/Amsterdam:20261005T100000/, 'RECURRENCE-ID;TZID=Europe/Amsterdam:20261012T100000\r\nDTSTART;TZID=Europe/Amsterdam:20261012T140000')
            .replace(/DTEND;TZID=Europe\/Amsterdam:20261005T110000/, 'DTEND;TZID=Europe/Amsterdam:20261012T150000')
            .replace('END:VEVENT', `${ALARM_30}\r\nEND:VEVENT`);
        const ics = asCalendarApp(master, (text) => text.replace('END:VCALENDAR', `${exception}\r\nEND:VCALENDAR`));
        // 0.40.2: only an alert on that occurrence, at its usual time — refused (the library makes no event of its own for it).
        const alertOnly = ics.replace('DTSTART;TZID=Europe/Amsterdam:20261012T140000', 'DTSTART;TZID=Europe/Amsterdam:20261012T100000').replace('DTEND;TZID=Europe/Amsterdam:20261012T150000', 'DTEND;TZID=Europe/Amsterdam:20261012T110000');
        await assert.rejects(put(record, alertOnly), (error: any) => error.name === 'InvitationNotSupportedError' && /Set the reminder on all events instead/.test(error.message));
        assert.deepEqual(writes, [], 'nothing saved, nothing dropped silently');
        // Moved (14:00) and with its own alert: saved, then the alert set on the new occurrence.
        await put(record, ics);
        assert.deepEqual(writes.map((w) => w.kind), ['saveOrganizedSeries', 'setEventReminders']);
        assert.deepEqual(writes[1].detail, { eventId: 'ev-exception', alarms: [ALARM_30] }, 'the new occurrence gets the alarm Calendar.app shows for it');
    } finally {
        await cleanup();
    }
});

test('a failed personal-part write is told when nothing else was saved, and no re-read happens when nothing changed', async () => {
    const { service, writes, row, put, cleanup } = await setup([meeting({ hasDefaults: true, alarms: [ALARM_30] })]);
    try {
        const record = row('organized@proton.me');
        let refreshed = 0;
        service.refreshAfterInvitationWrite = async () => {
            refreshed += 1;
        };
        service.protonAdapter.setEventReminders = async () => ({ success: true, changed: false });
        await put(record, withAlarms(record.serializedIcs, [ALARM_1D_EMAIL]));
        assert.equal(refreshed, 0, 'Proton already had them: no re-read');
        service.protonAdapter.setEventReminders = async () => ({ success: false, changed: false, error: 'Proton said no' });
        await assert.rejects(put(record, withAlarms(record.serializedIcs, [ALARM_1D_EMAIL])), /The reminders could not be saved in Proton: Proton said no/);
        assert.deepEqual(writes, [], 'and nothing else was written');
    } finally {
        await cleanup();
    }
});

test('a meeting created in Calendar.app without alarms: saved with the calendar\'s defaults, no reminder write', async () => {
    const { writes, row, put, cleanup } = await setup([plain({ hasDefaults: true, alarms: [] })]);
    try {
        const record = row('plain@proton.me');
        const asMeeting = asCalendarApp(record.serializedIcs, (text) =>
            text.replace('END:VEVENT', `ORGANIZER;CN=Tobi:mailto:${ME}\r\nATTENDEE;CN=Anna;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:anna@uni.nl\r\nEND:VEVENT`)
        );
        await put(record, asMeeting);
        assert.deepEqual(writes.map((w) => w.kind), ['saveOrganizedEvent']);
    } finally {
        await cleanup();
    }
});

test('an older client without reminders: everything as before 0.33', async () => {
    const { writes, row, put, cleanup } = await setup([plain(), meeting()], { reminders: false });
    try {
        const event = row('plain@proton.me');
        await put(event, withAlarms(event.serializedIcs, [ALARM_30]));
        assert.equal(writes[0].kind, 'updateEvent');
        assert.equal(writes[0].detail, undefined, 'no alarms handed over');
        const record = row('organized@proton.me');
        writes.length = 0;
        const result = await put(record, withAlarms(record.serializedIcs, [ALARM_30]));
        assert.equal(result.etag, '');
        assert.deepEqual(writes, [], 'an alert on a meeting: accepted without any write');
    } finally {
        await cleanup();
    }
});
