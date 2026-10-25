/**
 * Video links (0.34.1): "Proton Meet" or "Zoom" typed as the location of an event in Calendar.app
 * makes the bridge create a room and save the event with the link, Proton's description block and
 * Proton's conference properties; served events carry the properties; a conference the stored event
 * has survives an edit in Calendar.app (which drops properties it does not know).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { SyncedCalendarEvent } from 'proton-calendar-client';

import { buildEventRecordShape, parseIcs, toIcs } from '../src/main/sync-utils';
import { conferenceLines, conferenceOfIcsText, firstVeventOf, icsHasConference, icsHasConferenceRemoval, restoreConferenceLines, withConferenceRemoved, withVideoLink } from '../src/main/video-links';
import { fakeSafeStorage } from './support/fake-safe-storage';

const stubElectron = () => {
    const resolved = require.resolve('electron');
    require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: { app: { setLoginItemSettings: () => undefined }, safeStorage: fakeSafeStorage } } as unknown as NodeJS.Module;
};

const TZ = 'Europe/Amsterdam';
const ME = 'tobi@proton.me';
const MEET = { provider: 2 as const, id: 'R4W0NWGAPM', url: 'https://meet.proton.me/join/id-R4W0NWGAPM#pwd-WHZqjp7mRFg2', host: ME };
const ZOOM = { provider: 1 as const, id: '123456789', url: 'https://us02web.zoom.us/j/123456789?pwd=abc', password: 'abc', host: ME };
const unfold = (ics: string) => ics.replace(/\r\n[ \t]/g, '');
const SEP = '~-~-~-~-~-~-~%~!~%~!~%~!~%~!~%~!~%~!~%~!~%~!~%~!~%~!~%~!~%~!~%~!~-~-~-~-~-~-~';

const vevent = (lines: string[]) => ['BEGIN:VEVENT', 'UID:u1', 'DTSTAMP:20260101T000000Z', 'DTSTART:20261005T090000Z', 'DTEND:20261005T100000Z', ...lines, 'END:VEVENT'];
const ics = (...blocks: string[][]) => `${['BEGIN:VCALENDAR', 'VERSION:2.0', ...blocks.flat(), 'END:VCALENDAR'].join('\r\n')}\r\n`;

test('ICS text: the link request is read, the link written into every VEVENT, stored lines restored', () => {
    const plain = ics(vevent(['SUMMARY:Standup', 'LOCATION:Proton Meet', 'DESCRIPTION:Agenda\\, as always', 'BEGIN:VALARM', 'TRIGGER:-PT5M', 'ACTION:DISPLAY', 'DESCRIPTION:Proton Meet', 'END:VALARM']));
    assert.deepEqual(firstVeventOf(plain), { location: 'Proton Meet', title: 'Standup', hasConference: false });
    const linked = withVideoLink(plain, MEET, (description) => `${description}\n${SEP}\nJoin Proton Meet: ${MEET.url}\n${SEP}`);
    const text = unfold(linked);
    assert.match(text, /\r\nLOCATION:https:\/\/meet\.proton\.me\/join\/id-R4W0NWGAPM#pwd-WHZqjp7mRFg2\r\n/);
    assert.match(text, /\r\nDESCRIPTION:Agenda\\, as always\\n~-~-[^\r\n]*\\nJoin Proton Meet: https:\/\/meet\.proton\.me[^\r\n]*\r\n/);
    assert.match(text, /\r\nX-PM-CONFERENCE-ID;X-PM-PROVIDER=2:R4W0NWGAPM\r\nX-PM-CONFERENCE-URL;X-PM-HOST="tobi@proton\.me":https:\/\/meet\.proton\.me\/join\/id-R4W0NWGAPM#pwd-WHZqjp7mRFg2\r\nEND:VEVENT/);
    assert.match(text, /BEGIN:VALARM\r\nTRIGGER:-PT5M\r\nACTION:DISPLAY\r\nDESCRIPTION:Proton Meet\r\nEND:VALARM/, "the alarm's own DESCRIPTION is not the event's");
    assert.ok(linked.split('\r\n').every((line) => line.length <= 75), 'folded');
    assert.deepEqual(firstVeventOf(linked), { location: MEET.url, title: 'Standup', hasConference: true });
    assert.deepEqual(conferenceOfIcsText(linked), MEET);
    assert.equal(withVideoLink(linked, ZOOM, (d) => d), linked, 'a VEVENT with a conference is left alone');

    // A series: the master and its exception both get the link; an event without LOCATION/DESCRIPTION gets them.
    const series = ics(vevent(['SUMMARY:Weekly', 'LOCATION:zoom', 'RRULE:FREQ=WEEKLY']), vevent(['RECURRENCE-ID:20261012T090000Z', 'SUMMARY:Weekly (moved)', 'LOCATION:Zoom']));
    const seriesLinked = unfold(withVideoLink(series, ZOOM, (d) => `${d}|block`));
    assert.equal((seriesLinked.match(/X-PM-CONFERENCE-ID;X-PM-PROVIDER=1:123456789/g) || []).length, 2);
    assert.equal((seriesLinked.match(/LOCATION:https:\/\/us02web\.zoom\.us\/j\/123456789\?pwd=abc/g) || []).length, 2);
    assert.equal((seriesLinked.match(/DESCRIPTION:\|block/g) || []).length, 2, 'a description is added where there was none');
    assert.match(seriesLinked, /X-PM-CONFERENCE-URL;X-PM-PASSWORD="abc";X-PM-HOST="tobi@proton\.me":https/);

    // Restoring: what the stored (served) version had and Calendar.app dropped.
    const served = ics(vevent(['SUMMARY:Weekly', 'LOCATION:x', 'RRULE:FREQ=WEEKLY', ...conferenceLines(MEET)]), vevent(['RECURRENCE-ID:20261012T090000Z', 'SUMMARY:Weekly (moved)', ...conferenceLines(ZOOM)]));
    const fromCalendarApp = ics(vevent(['SUMMARY:Weekly renamed', 'LOCATION:x', 'RRULE:FREQ=WEEKLY']), vevent(['RECURRENCE-ID:20261012T090000Z', 'SUMMARY:Weekly (moved)']), vevent(['RECURRENCE-ID:20261019T090000Z', 'SUMMARY:Weekly (new exception)']));
    const restoredText = unfold(restoreConferenceLines(fromCalendarApp, served));
    assert.match(restoredText, /SUMMARY:Weekly renamed\r\nLOCATION:x\r\nRRULE:FREQ=WEEKLY\r\nX-PM-CONFERENCE-ID;X-PM-PROVIDER=2:R4W0NWGAPM\r\nX-PM-CONFERENCE-URL[^\r\n]*\r\nEND:VEVENT/, 'the master gets its own lines back');
    assert.match(restoredText, /SUMMARY:Weekly \(moved\)\r\nX-PM-CONFERENCE-ID;X-PM-PROVIDER=1:123456789/, 'the exception gets its own');
    assert.match(restoredText, /SUMMARY:Weekly \(new exception\)\r\nX-PM-CONFERENCE-ID;X-PM-PROVIDER=2:R4W0NWGAPM/, "a new exception takes the master's");
    const servedWithFreeException = ics(vevent(['SUMMARY:Weekly', 'RRULE:FREQ=WEEKLY', ...conferenceLines(MEET)]), vevent(['RECURRENCE-ID:20261012T090000Z', 'SUMMARY:No call this week']));
    const editedAgain = ics(vevent(['SUMMARY:Weekly!', 'RRULE:FREQ=WEEKLY']), vevent(['RECURRENCE-ID:20261012T090000Z', 'SUMMARY:No call this week!']));
    const restoredAgain = unfold(restoreConferenceLines(editedAgain, servedWithFreeException));
    assert.match(restoredAgain, /SUMMARY:Weekly!\r\nRRULE:FREQ=WEEKLY\r\nX-PM-CONFERENCE-ID/);
    assert.doesNotMatch(restoredAgain, /No call this week!\r\nX-PM-CONFERENCE/, 'an occurrence stored without the link stays without it');
    // An alarm whose DESCRIPTION equals the event's is left alone.
    const sameTexts = ics(vevent(['SUMMARY:Standup', 'LOCATION:Proton Meet', 'DESCRIPTION:Reminder', 'BEGIN:VALARM', 'TRIGGER:-PT5M', 'ACTION:DISPLAY', 'DESCRIPTION:Reminder', 'END:VALARM']));
    const sameLinked = unfold(withVideoLink(sameTexts, MEET, (d) => `${d}|block`));
    assert.match(sameLinked, /BEGIN:VALARM\r\nTRIGGER:-PT5M\r\nACTION:DISPLAY\r\nDESCRIPTION:Reminder\r\nEND:VALARM/);
    assert.equal((sameLinked.match(/\|block/g) || []).length, 1);
    assert.equal(restoreConferenceLines(fromCalendarApp, undefined), fromCalendarApp, 'nothing stored: unchanged');
    assert.equal(restoreConferenceLines(fromCalendarApp, ics(vevent(['SUMMARY:x']))), fromCalendarApp, 'stored without a conference: unchanged');
    assert.equal(restoreConferenceLines(served, served), served, 'all there: unchanged');
    assert.equal(icsHasConference(served), true);
    assert.equal(icsHasConference(fromCalendarApp), false);

    // Taking the link off: the marker in every VEVENT, Proton's block out of the description.
    const removedText = unfold(withConferenceRemoved(served.replace('LOCATION:x', `LOCATION:Office\r\nDESCRIPTION:Agenda\\n${SEP}\\nJoin Proton Meet: ${MEET.url}\\n${SEP}`), (d) => d.split('\n' + SEP)[0]));
    assert.equal((removedText.match(/X-PM-CONFERENCE-ID:\r\nX-PM-CONFERENCE-URL:\r\nEND:VEVENT/g) || []).length, 2, 'the marker in both VEVENTs');
    assert.doesNotMatch(removedText, /X-PM-CONFERENCE-ID;/);
    assert.match(removedText, /DESCRIPTION:Agenda\r\n/);
    assert.equal(icsHasConferenceRemoval(removedText), true);
    assert.equal(icsHasConferenceRemoval(served), false);
    assert.equal(firstVeventOf(removedText)?.hasConference, false);
    assert.equal(conferenceOfIcsText(removedText), undefined);
    // The marker left in a stored copy is neither "a conference" nor restored, and a new link replaces it.
    assert.equal(icsHasConference(removedText), false);
    assert.equal(restoreConferenceLines(fromCalendarApp, removedText), fromCalendarApp, 'a stored marker restores nothing');
    const relinked = unfold(withVideoLink(removedText.replace(/LOCATION:Office/g, 'LOCATION:Proton Meet'), MEET, (d) => d));
    assert.doesNotMatch(relinked, /X-PM-CONFERENCE-ID:\r\n/, 'the marker gives way');
    assert.equal((relinked.match(/X-PM-CONFERENCE-ID;X-PM-PROVIDER=2/g) || []).length, 2);
});

test('served ICS carries the conference (and it is in the ETag); parseIcs reads it back', () => {
    const base = { uid: 'u1', title: 'Call', description: '', location: MEET.url, startTimestamp: 1_791_190_800, endTimestamp: 1_791_194_400, timezone: TZ, isAllDay: false, protonEventId: 'e', protonCalendarId: 'c', href: '/x.ics', modifiedTimestamp: 1 };
    const withMeet = toIcs({ ...base, conference: MEET });
    assert.match(unfold(withMeet), /X-PM-CONFERENCE-ID;X-PM-PROVIDER=2:R4W0NWGAPM\r\nX-PM-CONFERENCE-URL;X-PM-HOST="tobi@proton\.me":https:\/\/meet\.proton\.me/);
    assert.doesNotMatch(toIcs(base), /X-PM-CONFERENCE/);
    assert.notEqual(buildEventRecordShape({ ...base, conference: MEET }).contentHash, buildEventRecordShape(base).contentHash);
    assert.deepEqual(parseIcs(withMeet).eventData.conference, MEET);
    assert.equal('conference' in parseIcs(toIcs(base)).eventData, false, 'no lines: no field (an existing event keeps its own)');
});

const setup = async ({ recurring = false, meeting = false }: { recurring?: boolean; meeting?: boolean } = {}) => {
    stubElectron();
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { BridgeService } = require('../src/main/bridge-service') as typeof import('../src/main/bridge-service');
    const baseDir = mkdtempSync(join(tmpdir(), 'neutron-calendar-bridge-video-'));
    const service = new BridgeService(baseDir) as any;
    await service.mirrorDatabase.initialize();
    service.localCaldavPassword = 'test';
    const calendar = { protonCalendarId: 'private', slug: 'tobi-private', displayName: 'Tobi (Private)', color: '#123456', description: '', visible: true, removed: false, ctag: '1', lastPolledAt: null, lastSyncedAt: null };
    await service.mirrorDatabase.upsertCalendar(calendar);
    const client = await import('proton-calendar-client');
    const api = new client.ProtonCalendarAPI({ username: 'u', password: 'p' });
    const writes: Array<{ kind: string; detail?: unknown }> = [];
    const rooms: unknown[] = [];
    const roomChanges: unknown[] = [];
    const at = (day: number, hours: number) => ({ value: { year: 2026, month: 10, day, hours, minutes: 0, seconds: 0, isUTC: false }, parameters: { tzid: TZ } });
    const existing: SyncedCalendarEvent = {
        calendarId: 'private',
        eventId: 'ev-linked',
        uid: 'linked@proton.me',
        title: 'Weekly call',
        description: `Agenda\n${SEP}\nJoin Proton Meet: ${MEET.url}\n${SEP}`,
        location: MEET.url,
        startTimestamp: Date.UTC(2026, 9, 5, 8) / 1000,
        endTimestamp: Date.UTC(2026, 9, 5, 9) / 1000,
        timezone: TZ,
        isAllDay: false,
        modifiedTimestamp: 1_790_000_000,
        contentHash: 'x',
        decrypted: {
            vevent: {
                dtstart: at(5, 10),
                dtend: at(5, 11),
                ...(recurring ? { rrule: { value: { freq: 'WEEKLY' } } } : {}),
                ...(meeting ? { sequence: { value: 1 }, organizer: { value: `mailto:${ME}`, parameters: { cn: 'Tobi' } }, attendee: [{ value: 'mailto:anna@uni.nl', parameters: { cn: 'Anna', partstat: 'ACCEPTED', role: 'REQ-PARTICIPANT' } }] } : {})
            },
            conference: MEET,
            ...(meeting ? { participation: { isOrganizer: true, isAttendee: false, selfEmail: ME } } : {})
        } as any
    } as any;
    /** What Proton has now (a link taken off in Proton Calendar shows here before the next poll). */
    let inProton: SyncedCalendarEvent = existing;
    const reads: string[] = [];
    let zoomConnected = false;
    let zoomCode = 9100;
    service.protonAdapter = {
        isSignedIn: () => true,
        supportsSeriesSync: () => true,
        supportsInvitations: () => true,
        supportsOrganizing: () => true,
        supportsReminders: () => false,
        supportsVideoLinks: async () => true,
        videoProviderOfLocation: async (location: string) => client.videoProviderOfLocation(location),
        conferenceDescriber: async () => (description: string, conference: any) => client.descriptionWithConference(description, conference),
        conferenceUndescriber: async () => (description: string) => client.descriptionWithoutConference(description),
        renameProtonMeet: async (url: string, title: string) => {
            roomChanges.push(['rename', url, title]);
            return url === MEET.url;
        },
        deleteProtonMeet: async (url: string) => {
            roomChanges.push(['delete', url]);
            return url === MEET.url;
        },
        createVideoConference: async (provider: 1 | 2, options: unknown) => {
            rooms.push([provider, options]);
            if (provider === 1 && !zoomConnected) {
                throw Object.assign(new Error('Your subscription does not allow you to perform this operation'), { status: zoomCode === 2904 ? 422 : 403, data: { Code: zoomCode } });
            }
            return provider === 1 ? ZOOM : MEET;
        },
        parseIcs: (text: string) => api.parseIcsToVevents(text),
        listAddresses: () => [{ email: ME, displayName: 'Tobi', active: true, order: 1 }],
        listEvents: async () => (inProton.uid === existing.uid ? [inProton] : []),
        listEventsByUid: async (_calendarId: string, uid: string) => {
            reads.push(uid);
            return uid === inProton.uid ? [inProton] : [];
        },
        createEvent: async (_calendarId: string, eventData: any) => {
            writes.push({ kind: 'createEvent', detail: eventData });
            return { success: true, id: 'new-1' };
        },
        updateEvent: async (_calendarId: string, _eventId: string, eventData: any) => {
            writes.push({ kind: 'updateEvent', detail: eventData });
            return { success: true };
        },
        syncSeries: async (input: any) => {
            writes.push({ kind: 'syncSeries', detail: input.components.map((c: any) => c.vevent) });
            return { success: true, eventIds: input.components.map((_: unknown, i: number) => `new-${i}`) };
        },
        deleteEvent: async () => ({ success: true }),
        saveOrganizedEvent: async (input: any) => {
            writes.push({ kind: 'saveOrganizedEvent', detail: input.vevent });
            return { success: true, eventId: input.eventID || 'ev-new-meeting', emails: [] };
        }
    };
    service.refreshAccountAddresses();
    await service.syncEventsForCalendar(calendar);
    const put = (uid: string, text: string) => service.upsertLocalEvent('tobi-private', `${encodeURIComponent(uid)}.ics`, `/calendars/u/tobi-private/${encodeURIComponent(uid)}.ics`, text);
    return {
        service,
        writes,
        rooms,
        roomChanges,
        put,
        reads,
        deleteInProton: () => {
            inProton = { ...existing, uid: 'gone-from-proton' };
        },
        removeLinkInProton: () => {
            const { conference: _gone, ...decrypted } = existing.decrypted as any;
            inProton = { ...existing, location: '', description: 'Agenda', contentHash: 'y', decrypted };
        },
        setZoom: (value: boolean) => (zoomConnected = value),
        setZoomCode: (value: number) => (zoomCode = value),
        cleanup: async () => {
            await service.mirrorDatabase.close();
            rmSync(baseDir, { recursive: true, force: true });
        }
    };
};

const appleIcs = (uid: string, lines: string[]) =>
    `${['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Apple Inc.//macOS 26.0//EN', 'BEGIN:VEVENT', `UID:${uid}`, 'DTSTAMP:20261001T000000Z', `DTSTART;TZID=${TZ}:20261006T100000`, `DTEND;TZID=${TZ}:20261006T110000`, ...lines, 'END:VEVENT', 'END:VCALENDAR'].join('\r\n')}\r\n`;

test('bridge service: "Proton Meet" as the location makes a room; the saved event has the link, the block and the properties', async () => {
    const { service, writes, rooms, put, cleanup } = await setup();
    try {
        const reply = await put('new@proton.me', appleIcs('new@proton.me', ['SUMMARY:Planning', 'LOCATION:Proton Meet', 'DESCRIPTION:Agenda']));
        assert.deepEqual(rooms, [[2, { title: 'Planning', calendarId: 'private' }]]);
        assert.equal(reply.etag, '', 'no ETag in the reply: Calendar.app fetches the event with the link at once (0.41.3)');
        assert.equal(writes.length, 1);
        const data = writes[0].detail as any;
        assert.equal(writes[0].kind, 'createEvent');
        assert.equal(data.location, MEET.url, 'the link is the location');
        assert.equal(data.description, `Agenda\n${SEP}\nJoin Proton Meet: ${MEET.url}\n${SEP}`, "Proton's block in the description");
        assert.deepEqual(data.conference, MEET, 'the conference travels with the write');
        const stored = await service.mirrorDatabase.getEventByUid('private', 'new@proton.me');
        assert.match(unfold(stored.serializedIcs), /X-PM-CONFERENCE-ID;X-PM-PROVIDER=2:R4W0NWGAPM/, 'served with the properties from now on');
        assert.doesNotMatch(unfold(stored.serializedIcs), /~-~-~|Join Proton Meet/, 'right after the save too, the notes Calendar.app fetches have no join block (0.41.7)');
        assert.equal(stored.location, MEET.url);

        // A save Proton refuses comes back from Calendar.app unchanged: the room is used again, not a new one per try.
        rooms.length = 0;
        writes.length = 0;
        const create = service.protonAdapter.createEvent;
        service.protonAdapter.createEvent = async () => ({ success: false, error: 'Proton refused it' });
        await assert.rejects(put('retry@proton.me', appleIcs('retry@proton.me', ['SUMMARY:Retry', 'LOCATION:Proton Meet'])));
        service.protonAdapter.createEvent = create;
        assert.equal(rooms.length, 1, 'a room was made for the refused save');
        await put('retry@proton.me', appleIcs('retry@proton.me', ['SUMMARY:Retry', 'LOCATION:Proton Meet']));
        assert.equal(rooms.length, 1, 'no second room for the same event');
        assert.deepEqual((writes[0].detail as any).conference, MEET);

        // A place that only mentions a provider is a place.
        writes.length = 0;
        rooms.length = 0;
        await put('place@proton.me', appleIcs('place@proton.me', ['SUMMARY:Lunch', 'LOCATION:Zoom Café\\, Groningen']));
        assert.equal(rooms.length, 0);
        assert.equal((writes[0].detail as any).location, 'Zoom Café, Groningen');
        assert.equal('conference' in (writes[0].detail as any), false);
    } finally {
        await cleanup();
    }
});

test('bridge service: an existing conference survives an edit in Calendar.app; Zoom without Zoom connected is refused with the reason', async () => {
    const { service, writes, rooms, roomChanges, put, setZoom, setZoomCode, cleanup } = await setup();
    try {
        const stored = await service.mirrorDatabase.getEventByUid('private', 'linked@proton.me');
        assert.match(unfold(stored.serializedIcs), /X-PM-CONFERENCE-URL;X-PM-HOST="tobi@proton\.me":https:\/\/meet\.proton\.me/, 'a Proton-made link is served');
        // 0.41.1: the notes are served without Proton's join block (Proton Calendar hides it too).
        assert.match(unfold(stored.serializedIcs), /DESCRIPTION:Agenda\r\n/, 'served notes: just the text');
        assert.doesNotMatch(unfold(stored.serializedIcs), /~-~-~|Join Proton Meet/, 'no separator, no join line in the notes');
        // Calendar.app renames the event and sends it back without the X-PM lines.
        const edited = unfold(stored.serializedIcs)
            .replace('PRODID:-//Neutron Calendar Bridge//EN', 'PRODID:-//Apple Inc.//macOS 26.0//EN')
            .replace(/X-PM-CONFERENCE-[^\r\n]*\r\n/g, '')
            .replace('SUMMARY:Weekly call', 'SUMMARY:Weekly call (renamed)');
        assert.doesNotMatch(edited, /X-PM-CONFERENCE/);
        await put('linked@proton.me', edited);
        assert.equal(rooms.length, 0, 'no new room: the location is the link, not a request');
        assert.equal(writes.length, 1);
        assert.equal('conference' in (writes[0].detail as any), false, 'the write carries no conference of its own: the client keeps what Proton has');
        assert.equal((writes[0].detail as any).title, 'Weekly call (renamed)');
        assert.equal((writes[0].detail as any).description, `Agenda\n${SEP}\nJoin Proton Meet: ${MEET.url}\n${SEP}`, 'the block goes back in on the way to Proton (guests see it)');
        const after = await service.mirrorDatabase.getEventByUid('private', 'linked@proton.me');
        assert.match(unfold(after.serializedIcs), /X-PM-CONFERENCE-ID;X-PM-PROVIDER=2:R4W0NWGAPM/, 'still served with the properties');
        // The room follows the title (our own Meet room; after the save).
        assert.deepEqual(roomChanges, [['rename', MEET.url, 'Weekly call (renamed)']]);
        roomChanges.length = 0;
        // A save that does not change the title does not rename.
        await put('linked@proton.me', edited.replace('DTSTAMP:', 'SEQUENCE:3\r\nDTSTAMP:'));
        assert.deepEqual(roomChanges, []);

        // The link taken off: the location is no longer the link → Proton is told to remove the conference, the description loses the block.
        writes.length = 0;
        const unlinked = unfold(after.serializedIcs)
            .replace('PRODID:-//Neutron Calendar Bridge//EN', 'PRODID:-//Apple Inc.//macOS 26.0//EN')
            .replace(/X-PM-CONFERENCE-[^\r\n]*\r\n/g, '')
            .replace(/LOCATION:[^\r\n]*/, 'LOCATION:Office');
        await put('linked@proton.me', unlinked);
        assert.equal(writes.length, 1);
        assert.equal((writes[0].detail as any).conference, null, 'conference: null → the client removes it');
        assert.equal((writes[0].detail as any).location, 'Office');
        assert.equal((writes[0].detail as any).description, 'Agenda', "Proton's block is gone");
        assert.deepEqual(roomChanges, [], 'Proton removes the room itself when the conference goes off the event');
        const unlinkedRecord = await service.mirrorDatabase.getEventByUid('private', 'linked@proton.me');
        assert.equal(conferenceOfIcsText(unlinkedRecord.serializedIcs), undefined, 'not served with a conference any more');
        // Saved again as Calendar.app does (the marker is not in its copy): nothing comes back.
        writes.length = 0;
        await put('linked@proton.me', unlinked.replace('SUMMARY:Weekly call', 'SUMMARY:Weekly call again'));
        assert.equal('conference' in (writes[0].detail as any), false);

        // Deleting an event with our Meet room removes the room too.
        roomChanges.length = 0;
        await service.mirrorDatabase.upsertEvent({ ...after, deleted: false });
        await service.deleteLocalEvent('tobi-private', 'linked@proton.me');
        assert.deepEqual(roomChanges, [['delete', MEET.url]]);

        // A room someone else hosts (a pasted link, X-PM-HOST not ours or absent): never renamed or removed.
        roomChanges.length = 0;
        const foreign = { ...MEET, url: 'https://meet.proton.me/join/id-ZZZZZZZZZZ#pwd-ZZZZZZZZZZZZ', id: 'ZZZZZZZZZZ', host: 'someone@example.org' };
        const foreignIcs = `${['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Neutron Calendar Bridge//EN', 'BEGIN:VEVENT', 'UID:foreign@proton.me', 'DTSTAMP:20261001T000000Z', `DTSTART;TZID=${TZ}:20261007T100000`, `DTEND;TZID=${TZ}:20261007T110000`, 'SUMMARY:Their call', `LOCATION:${foreign.url}`, ...conferenceLines(foreign), 'END:VEVENT', 'END:VCALENDAR'].join('\r\n')}\r\n`;
        await service.mirrorDatabase.upsertEvent({ ...after, protonEventId: 'ev-foreign', uid: 'foreign@proton.me', href: '/calendars/u/tobi-private/foreign%40proton.me.ics', title: 'Their call', serializedIcs: foreignIcs, protonEventIds: { '': 'ev-foreign' } });
        await put('foreign@proton.me', foreignIcs.replace('PRODID:-//Neutron Calendar Bridge//EN', 'PRODID:-//Apple Inc.//macOS 26.0//EN').replace(/X-PM-CONFERENCE-[^\r\n]*\r\n/g, '').replace('SUMMARY:Their call', 'SUMMARY:Their call (renamed)'));
        await service.deleteLocalEvent('tobi-private', 'foreign@proton.me');
        assert.deepEqual(roomChanges, []);

        // Zoom: refused with a reason that names the fix; nothing written.
        writes.length = 0;
        // 0.37.14: a plan or connection refusal is a refusal for Calendar.app (ReadOnlyEventError → 403), not a server error.
        await assert.rejects(put('zoom@proton.me', appleIcs('zoom@proton.me', ['SUMMARY:Sales', 'LOCATION:Zoom'])), (error: any) => error.name === 'ReadOnlyEventError' && /Zoom links are not included in your Proton plan/.test(error.message));
        assert.equal(writes.length, 0);
        setZoomCode(2904);
        await assert.rejects(put('zoom@proton.me', appleIcs('zoom@proton.me', ['SUMMARY:Sales', 'LOCATION:Zoom'])), (error: any) => error.name === 'ReadOnlyEventError' && /Zoom is not connected to your Proton account/.test(error.message));
        setZoom(true);
        await put('zoom@proton.me', appleIcs('zoom@proton.me', ['SUMMARY:Sales', 'LOCATION:Zoom']));
        const data = writes[0].detail as any;
        assert.deepEqual(data.conference, ZOOM);
        assert.match(data.description, /Join Zoom Meeting: https:\/\/us02web\.zoom\.us\/j\/123456789\?pwd=abc \(ID: 123456789, passcode: abc\)\n\nMeeting host: tobi@proton\.me/);
    } finally {
        await cleanup();
    }
});

test('bridge service: a room added in Proton\'s apps (location not the link) survives any save; a move between calendars keeps the room', async () => {
    const { service, writes, roomChanges, put, cleanup } = await setup();
    try {
        // Proton's own forms leave LOCATION alone: the stored event has the properties, but its location is a place.
        const stored = await service.mirrorDatabase.getEventByUid('private', 'linked@proton.me');
        const protonMade = { ...stored, protonEventId: 'ev-proton-made', uid: 'proton-made@proton.me', href: '/calendars/u/tobi-private/proton-made%40proton.me.ics', location: 'Room 4', protonEventIds: { '': 'ev-proton-made' } };
        protonMade.serializedIcs = unfold(stored.serializedIcs).replace('UID:linked@proton.me', 'UID:proton-made@proton.me').replace(/LOCATION:[^\r\n]*/, 'LOCATION:Room 4');
        await service.mirrorDatabase.upsertEvent(protonMade);
        // Calendar.app re-saves it (a dismissed alert, a rename) without the X-PM lines and with the place as location.
        await put('proton-made@proton.me', protonMade.serializedIcs.replace('PRODID:-//Neutron Calendar Bridge//EN', 'PRODID:-//Apple Inc.//macOS 26.0//EN').replace(/X-PM-CONFERENCE-[^\r\n]*\r\n/g, '').replace('SUMMARY:Weekly call', 'SUMMARY:Weekly call (renamed)'));
        assert.equal(writes.length, 1);
        assert.equal('conference' in (writes[0].detail as any), false, 'kept: no removal gesture (the location never was the link)');
        assert.equal((writes[0].detail as any).description, protonMade.description, 'the description block stays');
        assert.deepEqual(roomChanges, [['rename', MEET.url, 'Weekly call (renamed)']]);
        const after = await service.mirrorDatabase.getEventByUid('private', 'proton-made@proton.me');
        assert.deepEqual(conferenceOfIcsText(after.serializedIcs), MEET, 'still served with the conference');

        // A move: Calendar.app PUTs the event into another calendar, then DELETEs it here.
        const other = { protonCalendarId: 'work', slug: 'tobi-work', displayName: 'Tobi (Work)', color: '#654321', description: '', visible: true, removed: false, ctag: '1', lastPolledAt: null, lastSyncedAt: null };
        await service.mirrorDatabase.upsertCalendar(other);
        writes.length = 0;
        roomChanges.length = 0;
        const moved = unfold(stored.serializedIcs).replace('PRODID:-//Neutron Calendar Bridge//EN', 'PRODID:-//Apple Inc.//macOS 26.0//EN').replace(/X-PM-CONFERENCE-[^\r\n]*\r\n/g, '');
        await service.upsertLocalEvent('tobi-work', 'linked%40proton.me.ics', '/calendars/u/tobi-work/linked%40proton.me.ics', moved);
        assert.equal(writes[0].kind, 'createEvent');
        assert.deepEqual((writes[0].detail as any).conference, MEET, 'created in the new calendar with the room carried over from the old one');
        const inWork = await service.mirrorDatabase.getEventByUid('work', 'linked@proton.me');
        assert.deepEqual(conferenceOfIcsText(inWork.serializedIcs), MEET, 'and served with it');
        await service.deleteLocalEvent('tobi-private', 'linked@proton.me');
        assert.deepEqual(roomChanges, [], 'the room is not removed: the event lives on in the other calendar');
    } finally {
        await cleanup();
    }
});

test('0.41: a series whose link was taken off in Proton Calendar — an edit in Calendar.app before the next poll does not bring it back', async () => {
    const { service, writes, reads, removeLinkInProton, put, cleanup } = await setup({ recurring: true });
    try {
        const stored = await service.mirrorDatabase.getEventByUid('private', 'linked@proton.me');
        assert.match(unfold(stored.serializedIcs), /RRULE:FREQ=WEEKLY/);
        assert.match(unfold(stored.serializedIcs), /X-PM-CONFERENCE-ID/, 'the mirror still has the link');
        removeLinkInProton();
        // Calendar.app's copy is the served one (link as location); it changes only the title.
        const edited = unfold(stored.serializedIcs)
            .replace('SUMMARY:Weekly call', 'SUMMARY:Weekly call (moved room)')
            .replace(/X-PM-[^\r\n]*\r\n/g, '')
            .replace('PRODID:-//Neutron Calendar Bridge//EN', 'PRODID:-//Apple Inc.//macOS 26.0//EN');
        await put('linked@proton.me', edited);
        assert.deepEqual(reads, ['linked@proton.me'], 'the series was read again before the write (one request)');
        const remembered = service.replacedVersions.get('private\u0000linked@proton.me') ?? [];
        assert.ok(remembered.some((version: any) => version.etag === stored.etag), "the replaced version is remembered, so Calendar.app's If-Match still counts where only answers changed (review)");
        assert.equal(writes[0].kind, 'syncSeries');
        const [master] = writes[0].detail as any[];
        assert.equal(master.summary?.value, 'Weekly call (moved room)', 'the change went through');
        assert.equal(JSON.stringify(master).includes('R4W0NWGAPM'), false, 'no link anywhere: not as conference, place or notes');
        assert.equal(master.location?.value ?? '', '', 'the place that was the link is cleared');
        assert.equal(master.description?.value, 'Agenda', "Proton's block left the notes, the rest stays");
    } finally {
        await cleanup();
    }
});

test('0.41: a series with its link still in Proton keeps it on an edit; a single event is not read again', async () => {
    const { service, writes, reads, put, cleanup } = await setup({ recurring: true });
    try {
        const stored = await service.mirrorDatabase.getEventByUid('private', 'linked@proton.me');
        const edited = unfold(stored.serializedIcs).replace('SUMMARY:Weekly call', 'SUMMARY:Weekly call 2').replace(/X-PM-[^\r\n]*\r\n/g, '');
        await put('linked@proton.me', edited);
        assert.deepEqual(reads, ['linked@proton.me']);
        assert.ok(JSON.stringify(writes[0].detail).includes('R4W0NWGAPM'), 'the link travels with the series as before');
    } finally {
        await cleanup();
    }
    const single = await setup();
    try {
        const stored = await single.service.mirrorDatabase.getEventByUid('private', 'linked@proton.me');
        await single.put('linked@proton.me', unfold(stored.serializedIcs).replace('SUMMARY:Weekly call', 'SUMMARY:Call'));
        assert.deepEqual(single.reads, [], 'a single event keeps what Proton has without a read');
    } finally {
        await single.cleanup();
    }
});

test('0.41 (review): a series with a link deleted in Proton meanwhile — the edit is refused as outdated, not created anew', async () => {
    const { service, writes, deleteInProton, put, cleanup } = await setup({ recurring: true });
    try {
        const stored = await service.mirrorDatabase.getEventByUid('private', 'linked@proton.me');
        deleteInProton();
        const edited = unfold(stored.serializedIcs).replace('SUMMARY:Weekly call', 'SUMMARY:Weekly call 3');
        await assert.rejects(put('linked@proton.me', edited), (error: any) => error.name === 'StaleEventError');
        assert.deepEqual(writes, [], 'nothing written: no new series');
        assert.equal((await service.mirrorDatabase.getEventByUid('private', 'linked@proton.me'))?.deleted ?? true, true, 'gone here too: Calendar.app re-reads');
    } finally {
        await cleanup();
    }
});

test('0.41.1: a meeting with a link — an alert-only save is still no change (the block the bridge adds back does not count)', async () => {
    const { service, writes, put, cleanup } = await setup();
    try {
        const stored = await service.mirrorDatabase.getEventByUid('private', 'linked@proton.me');
        // Calendar.app's copy of the served event, saved with notes edited only by the bridge's own block: same for Proton.
        const sameNotes = unfold(stored.serializedIcs).replace('PRODID:-//Neutron Calendar Bridge//EN', 'PRODID:-//Apple Inc.//macOS 26.0//EN').replace(/X-PM-CONFERENCE-[^\r\n]*\r\n/g, '');
        const { sameForProton } = await import('../src/main/recurrence');
        const parse = (text: string) => service.protonAdapter.parseIcs(text);
        const withBlock = sameNotes.replace('DESCRIPTION:Agenda', `DESCRIPTION:Agenda\\n${SEP}\\nJoin Proton Meet: ${MEET.url}\\n${SEP}`);
        assert.equal(sameForProton(parse(sameNotes), parse(withBlock)), true, 'notes with and without the join block compare equal');
        assert.equal(sameForProton(parse(sameNotes), parse(sameNotes.replace('DESCRIPTION:Agenda', 'DESCRIPTION:Agenda 2'))), false, 'a real change of the notes still counts');
        await put('linked@proton.me', sameNotes);
        assert.ok(writes.length <= 1);
    } finally {
        await cleanup();
    }
});

test('0.41.2: "Proton Meet" again after the link was taken off makes a new room (not the deleted one); a refused save still reuses its room', async () => {
    const { service, writes, rooms, put, cleanup } = await setup();
    try {
        await put('again@proton.me', appleIcs('again@proton.me', ['SUMMARY:Again', 'LOCATION:Proton Meet']));
        assert.equal(rooms.length, 1, 'a room made');
        const made = await service.mirrorDatabase.getEventByUid('private', 'again@proton.me');
        const asCalendarApp = (text: string) => unfold(text).replace('PRODID:-//Neutron Calendar Bridge//EN', 'PRODID:-//Apple Inc.//macOS 26.0//EN').replace(/X-PM-CONFERENCE-[^\r\n]*\r\n/g, '');
        writes.length = 0;
        await put('again@proton.me', asCalendarApp(made.serializedIcs).replace(/LOCATION:[^\r\n]*\r\n/, ''));
        assert.equal((writes[0].detail as any).conference, null, 'the link taken off');
        const removed = await service.mirrorDatabase.getEventByUid('private', 'again@proton.me');
        writes.length = 0;
        rooms.length = 0;
        await put('again@proton.me', asCalendarApp(removed.serializedIcs).replace('END:VEVENT', 'LOCATION:Proton Meet\r\nEND:VEVENT'));
        assert.equal(rooms.length, 1, 'asked again: a new room (Proton deleted the old one with the link)');
        assert.ok((writes[0].detail as any).conference?.url, 'and it is on the event');
    } finally {
        await cleanup();
    }
});

test('0.41.4: Calendar.app keeps the conference fields in its copy — clearing the location still takes the link off, and "Proton Meet" again makes a new room', async () => {
    const { service, writes, rooms, put, cleanup } = await setup();
    try {
        await put('kept@proton.me', appleIcs('kept@proton.me', ['SUMMARY:Kept', 'LOCATION:Proton Meet']));
        const made = await service.mirrorDatabase.getEventByUid('private', 'kept@proton.me');
        // This time Calendar.app's copy keeps the X-PM lines.
        const copy = unfold(made.serializedIcs).replace('PRODID:-//Neutron Calendar Bridge//EN', 'PRODID:-//Apple Inc.//macOS 26.0//EN');
        assert.match(copy, /X-PM-CONFERENCE-ID/);
        writes.length = 0;
        await put('kept@proton.me', copy.replace(/LOCATION:[^\r\n]*\r\n/, ''));
        assert.equal((writes[0].detail as any).conference, null, 'taken off although the copy still had the fields');
        const removed = await service.mirrorDatabase.getEventByUid('private', 'kept@proton.me');
        // Calendar.app may still send the old fields with the new request.
        writes.length = 0;
        rooms.length = 0;
        const again = unfold(removed.serializedIcs).replace('PRODID:-//Neutron Calendar Bridge//EN', 'PRODID:-//Apple Inc.//macOS 26.0//EN').replace('END:VEVENT', 'LOCATION:Proton Meet\r\nEND:VEVENT');
        await put('kept@proton.me', again);
        assert.equal(rooms.length, 1, 'a new room');
        // A stale copy (not refreshed since the link went) saved with another change: the dead link does not come back.
        const linkedNow = await service.mirrorDatabase.getEventByUid('private', 'kept@proton.me');
        await service.mirrorDatabase.upsertEvent({ ...linkedNow, serializedIcs: removed.serializedIcs });
        writes.length = 0;
        rooms.length = 0;
        await put('kept@proton.me', copy.replace(/LOCATION:[^\r\n]*\r\n/, '').replace('SUMMARY:Kept', 'SUMMARY:Kept 2'));
        assert.equal(JSON.stringify(writes[0].detail).includes('R4W0NWGAPM'), false, 'stale conference fields are not written back');
        await service.mirrorDatabase.upsertEvent(linkedNow);
        // And: replacing the link with "Proton Meet" in one go, the old fields still in the copy → the old link off, a new one made.
        const linked = await service.mirrorDatabase.getEventByUid('private', 'kept@proton.me');
        rooms.length = 0;
        writes.length = 0;
        const swap = unfold(linked.serializedIcs).replace('PRODID:-//Neutron Calendar Bridge//EN', 'PRODID:-//Apple Inc.//macOS 26.0//EN').replace(/LOCATION:[^\r\n]*/, 'LOCATION:Proton Meet');
        await put('kept@proton.me', swap);
        assert.equal(rooms.length, 1, 'replaced in one save: a new room');
    } finally {
        await cleanup();
    }
});


test('0.41.5: the link in another spelling (spacing, escaping) is still the link: nothing taken off; a meeting\'s cleared place takes it off', async () => {
    const { service, writes, put, cleanup } = await setup();
    try {
        const stored = await service.mirrorDatabase.getEventByUid('private', 'linked@proton.me');
        const copy = unfold(stored.serializedIcs).replace('PRODID:-//Neutron Calendar Bridge//EN', 'PRODID:-//Apple Inc.//macOS 26.0//EN');
        const url = MEET.url;
        await put('linked@proton.me', copy.replace(/LOCATION:[^\r\n]*/, `LOCATION:${url.replace('#', '\\#')} `).replace('SUMMARY:Weekly call', 'SUMMARY:Weekly call 4'));
        assert.notEqual((writes[0].detail as any).conference, null, 'not taken off');
    } finally {
        await cleanup();
    }
    const meeting = await setup({ meeting: true });
    try {
        const stored = await meeting.service.mirrorDatabase.getEventByUid('private', 'linked@proton.me');
        const copy = unfold(stored.serializedIcs).replace('PRODID:-//Neutron Calendar Bridge//EN', 'PRODID:-//Apple Inc.//macOS 26.0//EN');
        await meeting.put('linked@proton.me', copy.replace(/LOCATION:[^\r\n]*\r\n/, ''));
        assert.equal(meeting.writes[0].kind, 'saveOrganizedEvent');
        assert.deepEqual((meeting.writes[0].detail as any)['x-pm-conference-id']?.value, '', 'the meeting is saved with the removal marker');
    } finally {
        await meeting.cleanup();
    }
});

test('0.41.6: conference URL stored without the #pwd part (password apart) — clearing the place takes the link off; "Proton Meet" on a linked event brings its link back as the place', async () => {
    const { service, writes, rooms, put, cleanup } = await setup();
    try {
        const stored = await service.mirrorDatabase.getEventByUid('private', 'linked@proton.me');
        const bare = MEET.url.replace(/\\?#.*$/, '');
        const variant = unfold(stored.serializedIcs).replace(/(X-PM-CONFERENCE-URL[^:\r\n]*:)[^\r\n]*/, `$1${bare}`);
        assert.notEqual(variant, unfold(stored.serializedIcs), 'the stored conference URL has no #pwd part now');
        await service.mirrorDatabase.upsertEvent({ ...stored, serializedIcs: variant });
        const copy = variant.replace('PRODID:-//Neutron Calendar Bridge//EN', 'PRODID:-//Apple Inc.//macOS 26.0//EN');
        // A linked event whose place is not the link (text): "Proton Meet" brings its link back as the place, no new room.
        await service.mirrorDatabase.upsertEvent({ ...stored, serializedIcs: variant.replace(/LOCATION:[^\r\n]*/, 'LOCATION:Room 4') });
        writes.length = 0;
        const reply = await put('linked@proton.me', copy.replace(/LOCATION:[^\r\n]*/, 'LOCATION:Proton Meet'));
        assert.equal(rooms.length, 0, 'no second room');
        assert.equal(reply.etag, '', 'Calendar.app fetches the place it now has');
        assert.ok(String((writes[0].detail as any).location).includes('R4W0NWGAPM'), `the place is the link again (${(writes[0].detail as any).location})`);
        // Cleared: taken off (the copy still carries the same fields, as Calendar.app does).
        const now = await service.mirrorDatabase.getEventByUid('private', 'linked@proton.me');
        await service.mirrorDatabase.upsertEvent({ ...now, serializedIcs: variant });
        writes.length = 0;
        await put('linked@proton.me', copy.replace(/LOCATION:[^\r\n]*\r\n/, ''));
        assert.equal((writes[0].detail as any).conference, null, 'taken off although the stored URL and the place are spelt differently');
    } finally {
        await cleanup();
    }
});

test('0.44.1 (review): a waiting change to a linked series deleted in Proton meanwhile — refused at its replay, not written anew; a lookup miss outside the outbox is checked against the calendar\'s changes', async () => {
    const { service, writes, deleteInProton, cleanup } = await setup({ recurring: true });
    try {
        const calendar = await service.mirrorDatabase.getCalendarBySlug('tobi-private');
        const stored = await service.mirrorDatabase.getEventByUid('private', 'linked@proton.me');
        deleteInProton();
        // As during the outbox's replay: the change still waits (a sync pass leaves its row alone).
        service.notePending('private', 'linked@proton.me', true);
        await assert.rejects(service.withFreshConference(calendar, stored), (error: any) => error.name === 'StaleEventError');
        assert.deepEqual(writes, [], 'nothing written');
        service.notePending('private', 'linked@proton.me', false);
    } finally {
        await cleanup();
    }
});
