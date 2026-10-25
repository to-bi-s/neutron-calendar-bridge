/**
 * Answering invitations from Calendar.app (invitations, stage 2). Proton-side data is shaped like
 * proton-calendar-client's decrypted output and ICS parsing goes through the real client; the
 * answering itself (Proton answer + REPLY email, tested in the client's own offline test) is a
 * fake that records what the bridge asks for.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ProtonParticipantProperty, ProtonVcalDateProperty, SyncedCalendarEvent } from 'proton-calendar-client';

import { CalDAVServer } from '../src/main/caldav-server';
import { ConfigStore, normalizeEmailList } from '../src/main/config-store';
import {
    INVITATION_MESSAGES,
    StaleEventError,
    answersNewOccurrence,
    buildSeriesIcs,
    groupIntoSeries,
    ownAnswerChanges
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

const invitation = (
    eventId: string,
    uid: string,
    myAnswer: string,
    extra: { rrule?: boolean; recurrenceId?: ProtonVcalDateProperty; start?: ProtonVcalDateProperty; organizer?: string } = {}
): SyncedCalendarEvent => {
    const start = extra.start ?? at(2026, 10, 7, 14);
    const end = { ...start, value: { ...start.value, hours: (start.value.hours ?? 0) + 1 } };
    const organizer = extra.organizer ?? 'dean@uni.nl';
    return {
        calendarId: 'private',
        eventId,
        uid,
        title: 'Faculty meeting',
        description: '',
        location: '',
        startTimestamp: Date.UTC(2026, 9, 7, 12) / 1000,
        endTimestamp: Date.UTC(2026, 9, 7, 13) / 1000,
        timezone: TZ,
        isAllDay: false,
        modifiedTimestamp: 1_790_000_000,
        contentHash: `${eventId}-${myAnswer}`,
        decrypted: {
            vevent: {
                dtstart: start,
                dtend: end,
                ...(extra.rrule ? { rrule: { value: { freq: 'WEEKLY', count: 6 } } } : {}),
                ...(extra.recurrenceId ? { 'recurrence-id': extra.recurrenceId } : {}),
                organizer: person(organizer, { cn: 'The Dean' }),
                attendee: [person(organizer, { partstat: 'ACCEPTED' }), person(MY_ALIAS, { partstat: myAnswer })]
            },
            participation: { isOrganizer: false, isAttendee: true, selfEmail: MY_ALIAS, selfAttendeeIndex: 1 }
        }
    };
};

const unfold = (ics: string) => ics.replace(/\r\n[ \t]/g, '');
/** Calendar.app's save of what we served, with the answer of every listed VEVENT (by RECURRENCE-ID or '' ) changed. */
const withMyAnswers = (ics: string, answers: Record<string, string>) => {
    const blocks = unfold(ics).split(/(?=BEGIN:VEVENT\r\n)/);
    return blocks
        .map((block) => {
            if (!block.startsWith('BEGIN:VEVENT')) return block;
            const recurrenceId = block.match(/^RECURRENCE-ID[^:\r\n]*:(\S+)$/m)?.[1] ?? '';
            const answer = answers[recurrenceId];
            return answer
                ? block.replace(/(ATTENDEE;[^\r\n]*PARTSTAT=)[A-Z-]+([^\r\n]*:mailto:tobi@pm\.me)/, `$1${answer}$2`)
                : block;
        })
        .join('')
        .replace('PRODID:-//Neutron Calendar Bridge//EN', 'PRODID:-//Apple Inc.//macOS 26.0//EN');
};

const clientParser = async () => {
    const client = await import('proton-calendar-client');
    const api = new client.ProtonCalendarAPI({ username: 'u', password: 'p' });
    return (ics: string) => api.parseIcsToVevents(ics);
};

// ─── Recognising answers ─────────────────────────────────────────────────────

const series = () => [
    invitation('ev-master', 'weekly@uni.nl', 'NEEDS-ACTION', { rrule: true }),
    invitation('ev-edit', 'weekly@uni.nl', 'DECLINED', { recurrenceId: at(2026, 10, 14, 14), start: at(2026, 10, 14, 16) })
];

test('your answers are read per occurrence; anything else changing is not an answer', async () => {
    const parse = await clientParser();
    const served = buildSeriesIcs(groupIntoSeries(series())[0], 2026);
    const own = [ME, MY_ALIAS];

    const acceptAll = withMyAnswers(served, { '': 'ACCEPTED', '20261014T140000': 'ACCEPTED' });
    assert.deepEqual(ownAnswerChanges(parse(served), parse(acceptAll), own), [
        { key: '', answer: 'ACCEPTED' },
        { key: '20261014T140000', answer: 'ACCEPTED' }
    ]);
    const maybeOnce = withMyAnswers(served, { '20261014T140000': 'TENTATIVE' });
    assert.deepEqual(ownAnswerChanges(parse(served), parse(maybeOnce), own), [{ key: '20261014T140000', answer: 'TENTATIVE' }]);
    assert.equal(ownAnswerChanges(parse(served), parse(acceptAll.replace('T140000', 'T150000')), own), null, 'moved as well');
    assert.equal(ownAnswerChanges(parse(served), parse(served), own), null, 'nothing changed');

    // Calendar.app answering a single, unchanged occurrence adds a VEVENT of its own.
    const occurrence = [
        'BEGIN:VEVENT', 'UID:weekly@uni.nl', 'DTSTAMP:20261001T120000Z',
        'RECURRENCE-ID;TZID=Europe/Amsterdam:20261021T140000',
        'DTSTART;TZID=Europe/Amsterdam:20261021T140000', 'DTEND;TZID=Europe/Amsterdam:20261021T150000',
        'SUMMARY:Faculty meeting', 'ORGANIZER;CN=The Dean:mailto:dean@uni.nl',
        'ATTENDEE;PARTSTAT=ACCEPTED:mailto:tobi@pm.me', 'END:VEVENT'
    ].join('\r\n');
    const withOccurrence = unfold(served).replace('END:VCALENDAR', `${occurrence}\r\nEND:VCALENDAR`);
    assert.equal(ownAnswerChanges(parse(served), parse(withOccurrence), own), null);
    assert.equal(answersNewOccurrence(parse(served), parse(withOccurrence), own), true);
    assert.equal(answersNewOccurrence(parse(served), parse(acceptAll), own), false);
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

type Outcome = { success: boolean; error?: string; reason?: string; warnings?: string[]; retryAt?: number };

const setup = async (events: SyncedCalendarEvent[]) => {
    stubElectron();
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { BridgeService } = require('../src/main/bridge-service') as typeof import('../src/main/bridge-service');
    const baseDir = mkdtempSync(join(tmpdir(), 'neutron-calendar-bridge-invitations-'));
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
    let nextOutcome: Outcome | null = null;
    const answer = (eventId: string, value: string) => {
        proton.events = proton.events.map((event) => {
            if (event.eventId !== eventId) return event;
            const vevent: any = event.decrypted!.vevent;
            return {
                ...event,
                contentHash: `${eventId}-${value}`,
                decrypted: {
                    ...event.decrypted,
                    vevent: { ...vevent, attendee: [vevent.attendee[0], { ...vevent.attendee[1], parameters: { ...vevent.attendee[1].parameters, partstat: value } }] }
                }
            };
        });
    };
    service.protonAdapter = {
        isSignedIn: () => true,
        getSignedInUsername: () => 'tobi',
        supportsSeriesSync: () => true,
        supportsInvitations: () => true,
        parseIcs: parse,
        listAddresses: () => [
            { email: ME, displayName: 'Tobi', active: true, order: 1 },
            { email: MY_ALIAS, displayName: 'Tobi', active: true, order: 2 }
        ],
        listEvents: async () => {
            calls.push({ action: 'listEvents', input: null });
            return proton.events;
        },
        listEventsByUid: async (_calendarId: string, uid: string) => proton.events.filter((event) => event.uid === uid),
        syncSeries: async () => {
            calls.push({ action: 'syncSeries', input: null });
            return { success: true, eventIds: [] };
        },
        answerInvitation: async (input: any) => {
            calls.push({ action: 'answer', input });
            if (nextOutcome) {
                const outcome = nextOutcome;
                nextOutcome = null;
                return { emails: [], changedEventIds: [], deletedEventIds: [], warnings: [], ...outcome };
            }
            answer(input.eventID, input.answer);
            for (const id of input.alignSingleEditIDs || []) answer(id, input.answer);
            return { success: true, emails: [], changedEventIds: [input.eventID], deletedEventIds: [], warnings: [] };
        },
        removeInvitation: async (input: any) => {
            calls.push({ action: 'remove', input });
            if (nextOutcome) {
                const outcome = nextOutcome;
                nextOutcome = null;
                return { emails: [], changedEventIds: [], deletedEventIds: [], warnings: [], ...outcome };
            }
            const uid = proton.events.find((event) => event.eventId === input.eventID)?.uid;
            proton.events = proton.events.filter((event) => event.uid !== uid);
            return { success: true, emails: [], changedEventIds: [], deletedEventIds: [input.eventID], warnings: [] };
        }
    };
    service.refreshAccountAddresses();
    await service.syncEventsForCalendar(calendar);
    calls.length = 0;
    const row = async (uid: string) =>
        (await service.mirrorDatabase.listEventsForCalendar('private', true)).find((entry: any) => entry.uid === uid);
    const put = async (uid: string, ics: string, ifMatch?: string, client?: 'calendar-app' | 'thunderbird' | 'other') => {
        const record = await row(uid);
        return service.upsertLocalEvent('tobi-private', `${encodeURIComponent(uid)}.ics`, record.href, ics, { ifMatch, client });
    };
    const failNext = (outcome: Outcome) => {
        nextOutcome = outcome;
    };
    const cleanup = async () => {
        await service.mirrorDatabase.close();
        rmSync(baseDir, { recursive: true, force: true });
    };
    return { service, calls, row, put, failNext, cleanup, proton, calendar };
};

test('Accept in Calendar.app answers the invitation in Proton and serves the new answer', async () => {
    const { service, calls, row, put, cleanup } = await setup([invitation('ev-invited', 'invited@uni.nl', 'NEEDS-ACTION')]);
    try {
        const before = await row('invited@uni.nl');
        const served = before.serializedIcs;
        calls.length = 0;
        const result = await put('invited@uni.nl', withMyAnswers(served, { '': 'ACCEPTED' }), before.etag);
        assert.deepEqual(
            calls,
            [{ action: 'answer', input: { calendarID: 'private', eventID: 'ev-invited', answer: 'ACCEPTED', alignSingleEditIDs: [] } }],
            'only that invitation is re-read, not the whole calendar'
        );
        assert.equal(result.etag, '', 'no ETag: Calendar.app re-fetches');
        const after = await row('invited@uni.nl');
        assert.match(unfold(after.serializedIcs), /PARTSTAT=ACCEPTED;RSVP=TRUE:mailto:tobi@pm\.me/, 'mirror re-read from Proton');
        assert.notEqual(after.etag, '');
        assert.ok(service.calendarEmailsChangedUids.has('invited@uni.nl'), 'its invitation email is checked at the next look at the Inbox');

        // Calendar.app retrying the same save: nothing more happens.
        const retry = await put('invited@uni.nl', withMyAnswers(after.serializedIcs, {}));
        assert.equal(retry.etag, '');
        assert.equal(calls.length, 1);

        // A save from an outdated copy (Calendar.app still shows NEEDS-ACTION) is not an answer.
        await assert.rejects(put('invited@uni.nl', withMyAnswers(served, { '': 'DECLINED' }), before.etag), {
            name: 'StaleEventError'
        });
        assert.equal(calls.length, 1, 'nothing was sent');
        await put('invited@uni.nl', withMyAnswers(after.serializedIcs, { '': 'DECLINED' }), `W/${after.etag}`);
        assert.equal(calls.length, 2, 'the current copy is answered');
    } finally {
        await cleanup();
    }
});

test('an answer from a copy older only by its PRODID (a served file that changed in nothing Proton stores) is not refused', async () => {
    const { service, calls, row, put, cleanup, calendar } = await setup([invitation('ev-invited', 'invited@uni.nl', 'NEEDS-ACTION')]);
    try {
        // As Calendar.app has it from an earlier version: the same event, served with another PRODID.
        const current = await row('invited@uni.nl');
        const old = current.serializedIcs.replace('PRODID:-//Neutron Calendar Bridge//EN', 'PRODID:-//Neutron Calendar Bridge 0.20//EN');
        assert.notEqual(old, current.serializedIcs);
        await service.mirrorDatabase.upsertEvent({ ...current, serializedIcs: old, etag: 'etag-from-0.20' });
        await service.syncEventsForCalendar(calendar);
        assert.notEqual((await row('invited@uni.nl')).etag, 'etag-from-0.20', 'the first sync serves the new PRODID');
        calls.length = 0;

        await put('invited@uni.nl', withMyAnswers(old, { '': 'ACCEPTED' }), 'etag-from-0.20');
        assert.deepEqual(calls.map((call) => call.action), ['answer'], 'answered, no 412');

        // A copy that differs in something Proton stores (here: the answer) still counts as outdated.
        await assert.rejects(put('invited@uni.nl', withMyAnswers(old, { '': 'DECLINED' }), 'etag-from-0.20'), { name: 'StaleEventError' });
        assert.equal(calls.length, 1);
    } finally {
        await cleanup();
    }
});

test('a series: "accept all" is one series answer, occurrences answered the same way follow it', async () => {
    const { calls, row, put, cleanup } = await setup(series());
    try {
        const served = (await row('weekly@uni.nl')).serializedIcs;
        await put('weekly@uni.nl', withMyAnswers(served, { '': 'ACCEPTED', '20261014T140000': 'ACCEPTED' }));
        assert.deepEqual(calls, [
            { action: 'answer', input: { calendarID: 'private', eventID: 'ev-master', answer: 'ACCEPTED', alignSingleEditIDs: ['ev-edit'] } }
        ]);
    } finally {
        await cleanup();
    }
});

test('a series: series and a changed occurrence answered differently get one answer each', async () => {
    const { calls, row, put, cleanup } = await setup(series());
    try {
        const served = (await row('weekly@uni.nl')).serializedIcs;
        await put('weekly@uni.nl', withMyAnswers(served, { '': 'ACCEPTED', '20261014T140000': 'TENTATIVE' }));
        assert.deepEqual(
            calls.map(({ input }) => [input.eventID, input.answer, input.alignSingleEditIDs ?? null]),
            [
                ['ev-master', 'ACCEPTED', []],
                ['ev-edit', 'TENTATIVE', null]
            ]
        );
    } finally {
        await cleanup();
    }
});

test('a changed occurrence alone is answered on its own', async () => {
    const { calls, row, put, cleanup } = await setup(series());
    try {
        const served = (await row('weekly@uni.nl')).serializedIcs;
        await put('weekly@uni.nl', withMyAnswers(served, { '20261014T140000': 'ACCEPTED' }));
        assert.deepEqual(calls.map(({ input }) => [input.eventID, input.answer]), [['ev-edit', 'ACCEPTED']]);
    } finally {
        await cleanup();
    }
});

test('Proton asked to slow down at an answer: 503 with its time, syncing pauses; later writes wait in the outbox (0.40)', async () => {
    const { service, calls, row, put, failNext, cleanup } = await setup([invitation('ev-invited', 'invited@uni.nl', 'NEEDS-ACTION')]);
    try {
        const served = (await row('invited@uni.nl')).serializedIcs;
        const retryAt = Date.now() + 15 * 60_000;
        failNext({ success: false, reason: 'rate-limited', retryAt, error: 'Proton asked to slow down: your answer was not sent or saved yet.' });
        await assert.rejects(put('invited@uni.nl', withMyAnswers(served, { '': 'ACCEPTED' })), (error: any) =>
            error.name === 'RateLimitedError' && error.retryAt === retryAt
        );
        assert.equal(service.slowDownUntil, retryAt, 'no sync pass before Proton’s time');
        calls.length = 0;
        // 0.40: a write made during the pause is kept and sent when it is over (nothing was sent yet).
        await put('invited@uni.nl', withMyAnswers(served, { '': 'ACCEPTED' }));
        assert.deepEqual(calls, [], 'the next write waits without asking Proton');
        assert.equal(service.pendingChangeCount(), 1, 'in the outbox');
    } finally {
        await cleanup();
    }
});

test('refusals: email policy -> 403 with the reason, errors -> 500, unsendable answers refused', async () => {
    const { service, calls, row, put, failNext, cleanup } = await setup([invitation('ev-invited', 'invited@uni.nl', 'NEEDS-ACTION')]);
    try {
        const served = (await row('invited@uni.nl')).serializedIcs;
        const blocked = 'Test mode: answering would email dean@uni.nl, which is not on the allowlist. Nothing was changed.';
        failNext({ success: false, reason: 'blocked', error: blocked });
        await assert.rejects(put('invited@uni.nl', withMyAnswers(served, { '': 'ACCEPTED' })), {
            name: 'InvitationNotSupportedError',
            message: blocked
        });
        failNext({ success: false, reason: 'dry-run', error: 'Dry run: would have emailed your answer to dean@uni.nl; nothing was changed.' });
        await assert.rejects(put('invited@uni.nl', withMyAnswers(served, { '': 'ACCEPTED' })), { name: 'InvitationNotSupportedError' });
        failNext({ success: false, reason: 'failed', error: 'Proton API unreachable' });
        await assert.rejects(put('invited@uni.nl', withMyAnswers(served, { '': 'ACCEPTED' })), (error: any) =>
            error.name === 'Error' && error.message === 'Proton API unreachable'
        );
        assert.match(unfold((await row('invited@uni.nl')).serializedIcs), /PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:tobi@pm\.me/);

        calls.length = 0;
        await assert.rejects(put('invited@uni.nl', withMyAnswers(served, { '': 'DELEGATED' })), {
            message: INVITATION_MESSAGES.answerUnsupported
        });
        await assert.rejects(put('invited@uni.nl', withMyAnswers(served, { '': 'ACCEPTED' }).replace('Faculty meeting', 'Mine')), {
            message: INVITATION_MESSAGES.changeInvitation
        });
        assert.deepEqual(calls, []);

        // A client without answering support: the stage-1 refusal.
        service.protonAdapter.supportsInvitations = () => false;
        await assert.rejects(put('invited@uni.nl', withMyAnswers(served, { '': 'ACCEPTED' })), {
            message: INVITATION_MESSAGES.answerInvitation
        });
    } finally {
        await cleanup();
    }
});

test('answering a single occurrence Proton has no event for is refused with the reason', async () => {
    const { calls, row, put, cleanup } = await setup(series());
    try {
        const served = unfold((await row('weekly@uni.nl')).serializedIcs);
        const occurrence = [
            'BEGIN:VEVENT', 'UID:weekly@uni.nl', 'DTSTAMP:20261001T120000Z',
            'RECURRENCE-ID;TZID=Europe/Amsterdam:20261021T140000',
            'DTSTART;TZID=Europe/Amsterdam:20261021T140000', 'DTEND;TZID=Europe/Amsterdam:20261021T150000',
            'SUMMARY:Faculty meeting', 'ORGANIZER;CN=The Dean:mailto:dean@uni.nl',
            'ATTENDEE;PARTSTAT=ACCEPTED:mailto:tobi@pm.me', 'END:VEVENT'
        ].join('\r\n');
        await assert.rejects(put('weekly@uni.nl', served.replace('END:VCALENDAR', `${occurrence}\r\nEND:VCALENDAR`)), {
            message: INVITATION_MESSAGES.answerOccurrence
        });
        assert.deepEqual(calls, []);
    } finally {
        await cleanup();
    }
});

test('0.49.3: Thunderbird answering one occurrence of a series not answered yet answers the series; an answered series is still refused', async () => {
    const { calls, row, put, cleanup } = await setup(series());
    try {
        const served = unfold((await row('weekly@uni.nl')).serializedIcs);
        const occurrence = (answer: string) => [
            'BEGIN:VEVENT', 'UID:weekly@uni.nl', 'DTSTAMP:20261001T120000Z',
            'RECURRENCE-ID;TZID=Europe/Amsterdam:20261021T140000',
            'DTSTART;TZID=Europe/Amsterdam:20261021T140000', 'DTEND;TZID=Europe/Amsterdam:20261021T150000',
            'SUMMARY:Faculty meeting', 'ORGANIZER;CN=The Dean:mailto:dean@uni.nl',
            `ATTENDEE;PARTSTAT=${answer}:mailto:tobi@pm.me`, 'END:VEVENT'
        ].join('\r\n');
        const withOccurrence = (answer: string, base = served) => base.replace('END:VCALENDAR', `${occurrence(answer)}\r\nEND:VCALENDAR`);

        // Calendar.app (no client named, or named): "this occurrence" stays refused.
        await assert.rejects(put('weekly@uni.nl', withOccurrence('ACCEPTED'), undefined, 'calendar-app'), { message: INVITATION_MESSAGES.answerOccurrence });
        assert.deepEqual(calls, []);

        // Thunderbird: the series takes the answer (the single edit Proton knows follows it).
        const result = await put('weekly@uni.nl', withOccurrence('ACCEPTED'), undefined, 'thunderbird');
        assert.deepEqual(calls, [{ action: 'answer', input: { calendarID: 'private', eventID: 'ev-master', answer: 'ACCEPTED', alignSingleEditIDs: [] } }]);
        assert.equal(result.etag, '', 'no ETag: Thunderbird re-fetches the series with the answer');
        assert.match(unfold((await row('weekly@uni.nl')).serializedIcs), /RRULE[\s\S]*PARTSTAT=ACCEPTED[^\r\n]*:mailto:tobi@pm\.me/);

        // 0.49.4: Thunderbird replays its cached copy — the series still NEEDS-ACTION, plus occurrences copied
        // from it (as Thunderbird makes them) answered ACCEPTED, like the series now is: nothing to do, 204
        // without ETag, nothing sent. A moved occurrence is a change of its own and is not taken.
        calls.length = 0;
        const master = served.match(/BEGIN:VEVENT\r\n[\s\S]*?END:VEVENT/)![0];
        assert.match(master, /RRULE:FREQ=WEEKLY/);
        const copied = (day: string, answer: string, start = '140000', end = '150000') =>
            master
                .replace(/RRULE:[^\r\n]*\r\n/, '')
                .replace(/DTSTART;TZID=Europe\/Amsterdam:20261007T140000/, `RECURRENCE-ID;TZID=Europe/Amsterdam:${day}T140000\r\nDTSTART;TZID=Europe/Amsterdam:${day}T${start}`)
                .replace(/DTEND;TZID=Europe\/Amsterdam:20261007T150000/, `DTEND;TZID=Europe/Amsterdam:${day}T${end}`)
                .replace(/PARTSTAT=NEEDS-ACTION([^\r\n]*:mailto:tobi@pm\.me)/, `PARTSTAT=${answer}$1`);
        assert.match(copied('20261021', 'ACCEPTED'), /RECURRENCE-ID[\s\S]*PARTSTAT=ACCEPTED[^\r\n]*:mailto:tobi@pm\.me/);
        const stale = served.replace('END:VCALENDAR', `${copied('20261021', 'ACCEPTED')}\r\n${copied('20261028', 'ACCEPTED')}\r\nEND:VCALENDAR`);
        const replay = await put('weekly@uni.nl', stale, undefined, 'thunderbird');
        assert.equal(replay.etag, '');
        assert.deepEqual(calls, [], 'nothing sent for an answer the series already has');
        assert.match(unfold((await row('weekly@uni.nl')).serializedIcs), /RRULE[\s\S]*PARTSTAT=ACCEPTED[^\r\n]*:mailto:tobi@pm\.me/, 'the mirror keeps the answered series');
        // Also when the client is not named (Calendar.app): same answer, nothing to do.
        await put('weekly@uni.nl', stale);
        assert.deepEqual(calls, []);
        // A moved occurrence with that answer is not "nothing to do".
        await assert.rejects(put('weekly@uni.nl', served.replace('END:VCALENDAR', `${copied('20261021', 'ACCEPTED', '160000', '170000')}\r\nEND:VCALENDAR`), undefined, 'thunderbird'), { message: INVITATION_MESSAGES.answerOccurrence });

        // The series is answered now: declining one occurrence is not possible in Proton.
        calls.length = 0;
        const answered = unfold((await row('weekly@uni.nl')).serializedIcs);
        await assert.rejects(put('weekly@uni.nl', withOccurrence('DECLINED', answered), undefined, 'thunderbird'), { message: INVITATION_MESSAGES.answerOccurrence });
        // Not a sendable answer either.
        await assert.rejects(put('weekly@uni.nl', withOccurrence('DELEGATED'), undefined, 'other'), { message: INVITATION_MESSAGES.answerOccurrence });
        assert.deepEqual(calls, []);
    } finally {
        await cleanup();
    }
});

test('deleting an invitation declines and removes it (the whole series); meetings you organize stay protected', async () => {
    const organized: SyncedCalendarEvent = {
        ...invitation('ev-organized', 'organized@proton.me', 'NEEDS-ACTION', { organizer: ME }),
        decrypted: {
            vevent: {
                dtstart: at(2026, 10, 5, 10),
                dtend: at(2026, 10, 5, 11),
                organizer: person(ME, { cn: 'Tobi' }),
                attendee: [person('anna@uni.nl', { partstat: 'ACCEPTED' })]
            },
            participation: { isOrganizer: true, isAttendee: false, selfEmail: ME }
        }
    };
    const { service, calls, row, cleanup } = await setup([...series(), invitation('ev-single', 'single@uni.nl', 'ACCEPTED'), organized]);
    try {
        await service.deleteLocalEvent('tobi-private', 'weekly@uni.nl');
        await service.deleteLocalEvent('tobi-private', 'single@uni.nl', { notifyOrganizer: false });
        assert.deepEqual(calls, [
            { action: 'remove', input: { calendarID: 'private', eventID: 'ev-master', notifyOrganizer: true } },
            { action: 'remove', input: { calendarID: 'private', eventID: 'ev-single', notifyOrganizer: false } }
        ]);
        assert.equal((await row('weekly@uni.nl')).deleted, true);
        assert.equal((await row('single@uni.nl')).deleted, true);
        assert.deepEqual([...service.calendarEmailsGone.keys()].sort(), ['single@uni.nl', 'weekly@uni.nl'], 'their invitation emails count as dealt with');

        await assert.rejects(service.deleteLocalEvent('tobi-private', 'organized@proton.me'), {
            message: INVITATION_MESSAGES.deleteOrganized
        });
        assert.equal(calls.length, 2);
    } finally {
        await cleanup();
    }
});

test('0.40.3: a meeting the organizer cancelled — Calendar.app\'s save before its delete is taken as it is, then the delete removes it', async () => {
    const cancelled = invitation('ev-cancelled', 'cancelled@uni.nl', 'ACCEPTED');
    (cancelled.decrypted as any).vevent.status = { value: 'CANCELLED' };
    const { service, calls, row, put, cleanup } = await setup([cancelled]);
    try {
        const served = (await row('cancelled@uni.nl')).serializedIcs;
        assert.match(unfold(served), /STATUS:CANCELLED/, 'served as cancelled (greyed out, struck through)');
        calls.length = 0;
        // Calendar.app declines as part of "Delete" …
        const declined = await put('cancelled@uni.nl', withMyAnswers(served, { '': 'DECLINED' }));
        assert.equal(declined.etag, '', 'accepted; Calendar.app fetches Proton\'s version again');
        // … or changes something else of the copy: nothing can be changed in Proton either way.
        await put('cancelled@uni.nl', withMyAnswers(served, {}).replace('SUMMARY:Faculty meeting', 'SUMMARY:Faculty meeting (cancelled)'));
        assert.deepEqual(calls, [], 'nothing answered or written, no email to the organizer');
        // The delete that follows.
        await service.deleteLocalEvent('tobi-private', 'cancelled@uni.nl');
        assert.deepEqual(calls, [{ action: 'remove', input: { calendarID: 'private', eventID: 'ev-cancelled', notifyOrganizer: true } }], 'removed (the library sends no decline for a cancelled meeting)');
        assert.equal((await row('cancelled@uni.nl')).deleted, true);
    } finally {
        await cleanup();
    }
});

test('a refused decline leaves the invitation in place', async () => {
    const { service, row, failNext, cleanup } = await setup([invitation('ev-single', 'single@uni.nl', 'ACCEPTED')]);
    try {
        failNext({ success: false, reason: 'blocked', error: 'Test mode: …' });
        await assert.rejects(service.deleteLocalEvent('tobi-private', 'single@uni.nl'), { name: 'InvitationNotSupportedError' });
        assert.equal((await row('single@uni.nl')).deleted, false);
        assert.equal(service.calendarEmailsGone.size, 0, 'not removed: its emails stay');
    } finally {
        await cleanup();
    }
});

test('emailed but not saved in Proton: refused (no automatic retry), mirror re-read', async () => {
    const { calls, row, put, failNext, cleanup } = await setup([invitation('ev-invited', 'invited@uni.nl', 'NEEDS-ACTION')]);
    try {
        const served = (await row('invited@uni.nl')).serializedIcs;
        calls.length = 0;
        failNext({ success: false, reason: 'incomplete', error: 'Your answer was emailed to the organizer, but Proton did not save it.' });
        await assert.rejects(put('invited@uni.nl', withMyAnswers(served, { '': 'ACCEPTED' })), { name: 'InvitationNotSupportedError' });
        assert.deepEqual(calls.map(({ action }) => action), ['answer']);
    } finally {
        await cleanup();
    }
});

test('two saves of the same invitation at once run one after the other', async () => {
    const { service, calls, row, put, cleanup } = await setup([invitation('ev-invited', 'invited@uni.nl', 'NEEDS-ACTION')]);
    try {
        const served = (await row('invited@uni.nl')).serializedIcs;
        let release: () => void = () => undefined;
        const gate = new Promise<void>((resolve) => (release = resolve));
        const original = service.protonAdapter.answerInvitation;
        service.protonAdapter.answerInvitation = async (input: any) => {
            await gate;
            return original(input);
        };
        calls.length = 0;
        const first = put('invited@uni.nl', withMyAnswers(served, { '': 'ACCEPTED' }));
        const second = put('invited@uni.nl', withMyAnswers(served, { '': 'ACCEPTED' }));
        await new Promise((resolve) => setTimeout(resolve, 50));
        release();
        await Promise.all([first, second]);
        assert.equal(calls.filter(({ action }) => action === 'answer').length, 1, 'the second save saw the answer already in place');
    } finally {
        await cleanup();
    }
});

// ─── Settings ────────────────────────────────────────────────────────────────

test('email settings: live by default (test and dry run are developer options), addresses cleaned, policy handed to the client', async () => {
    const baseDir = mkdtempSync(join(tmpdir(), 'neutron-calendar-bridge-config-'));
    try {
        const store = new ConfigStore(baseDir);
        assert.equal(store.load().invitationEmailMode, 'live', '0.32.3: live by default');
        assert.deepEqual(store.load().invitationEmailAllowlist, []);
        assert.deepEqual(
            normalizeEmailList([' Anna@Proton.me ', 'anna@proton.me', 'not an address', 'mailto:me@outlook.com', '']),
            ['Anna@Proton.me', 'me@outlook.com']
        );
        store.update({ invitationEmailMode: 'yolo' as any, invitationEmailAllowlist: ['x@y.z'] });
        assert.equal(store.load().invitationEmailMode, 'live', 'unknown modes fall back to live');
        store.update({ invitationEmailMode: 'test' });
        assert.equal(store.load().invitationEmailMode, 'test', 'an explicit test mode (a config from before 0.32.3) is kept');
    } finally {
        rmSync(baseDir, { recursive: true, force: true });
    }

    const { service, cleanup } = await setup([]);
    try {
        const applied: any[] = [];
        service.protonAdapter.setInvitationOptions = (options: any) => applied.push(options);
        // 0.32.3: the mode under Developer Options counts only while they are on; otherwise live.
        const testing = await service.updateConfig({ developerMode: true, invitationEmailMode: 'test', invitationEmailAllowlist: ['a@b.cd'] });
        assert.equal(testing.invitationEmailMode, 'test');
        assert.equal(testing.invitationEmailModeSetting, 'test');
        assert.deepEqual(applied.at(-1).policy, { mode: 'test', allowlist: ['a@b.cd'], language: 'proton' });
        const developerOff = await service.updateConfig({ developerMode: false });
        assert.equal(developerOff.invitationEmailMode, 'live', 'developer options off: live, whatever the setting says');
        assert.equal(developerOff.invitationEmailModeSetting, 'test', 'the setting is kept for when they are on again');
        assert.equal(applied.at(-1).policy.mode, 'live', 'the client is told at once');
        await service.updateConfig({ developerMode: true });
        assert.equal(applied.at(-1).policy.mode, 'test', 'and again when they come back on');
        const state = await service.updateConfig({ invitationEmailMode: 'live', invitationEmailAllowlist: ['a@b.cd'] });
        assert.equal(state.invitationEmailMode, 'live');
        assert.deepEqual(applied.at(-1).policy, { mode: 'live', allowlist: ['a@b.cd'], language: 'proton' }, "the language: Proton Calendar's setting by default");
        assert.equal(applied.at(-1).prodId, '-//Neutron Calendar Bridge//EN');
        await assert.rejects(service.updateConfig({ invitationEmailMode: 'loud' }), /Unknown invitation email mode/);

        // 0.31: the language of the emails — one of the client's languages, or Proton Calendar's setting.
        service.protonAdapter.listInvitationLanguages = async () => [{ code: 'en_US', name: 'English' }, { code: 'de_DE', name: 'Deutsch' }];
        let asked = 0;
        let cached: string | null = null;
        service.protonAdapter.peekProtonInviteLocale = () => cached;
        service.protonAdapter.getProtonInviteLocale = async () => {
            asked += 1;
            await new Promise((resolve) => setTimeout(resolve, 1)); // a request
            cached = 'nl_NL';
            return cached;
        };
        const german = await service.updateConfig({ invitationEmailLanguage: 'de_DE' });
        assert.equal(german.protonInviteLanguage, null, 'the state shows what is known, without waiting for Proton');
        await new Promise((resolve) => setTimeout(resolve, 10));
        assert.ok(asked >= 1, 'Proton is asked in the background');
        assert.equal((await service.getBridgeState()).protonInviteLanguage, 'nl_NL', 'and the next state has it');
        assert.equal(german.invitationEmailLanguage, 'de_DE');
        assert.deepEqual(applied.at(-1).policy, { mode: 'live', allowlist: ['a@b.cd'], language: 'de_DE' }, 'handed to the client');
        assert.deepEqual(german.invitationEmailLanguages, [{ code: 'en_US', name: 'English' }, { code: 'de_DE', name: 'Deutsch' }], 'the languages on offer');
        await assert.rejects(service.updateConfig({ invitationEmailLanguage: 'tlh_QO' }), /Unknown invitation email language/);
        assert.equal((await service.updateConfig({ invitationEmailLanguage: 'proton' })).invitationEmailLanguage, 'proton');
        assert.equal(applied.at(-1).policy.language, 'proton');

        applied.at(-1).onEmail({
            at: '2026-10-01T10:00:00.000Z', method: 'REPLY', answer: 'ACCEPTED', from: MY_ALIAS,
            to: [{ email: 'dean@uni.nl', name: 'The Dean', delivery: 'plain' }], subject: 'Re: Invitation',
            eventTitle: 'Faculty meeting', eventUid: 'invited@uni.nl', outcome: 'sent'
        });
        const entries = (await service.getBridgeState()).recentInvitationEmails;
        assert.equal(entries.length, 1);
        assert.equal(entries[0].to[0].email, 'dean@uni.nl');
        assert.equal(entries[0].at, Date.parse('2026-10-01T10:00:00.000Z'));
    } finally {
        await cleanup();
    }
});

// ─── CalDAV surface ──────────────────────────────────────────────────────────

test('CalDAV: DELETE passes "Schedule-Reply: F" on, outdated saves get 412', async () => {
    const config = {
        host: '127.0.0.1',
        port: 32996,
        username: 'neutron-calendar-bridge',
        password: 'p',
        security: 'HTTP' as const,
        baseUrl: 'http://127.0.0.1:32996',
        serverPath: '/principals/neutron-calendar-bridge/'
    };
    const deletes: any[] = [];
    const ifMatches: any[] = [];
    const fake = {
        isSignedIn: () => true,
        getCalDAVConfig: () => config,
        getSignedInUsername: () => 'tobi',
        getAccountAddresses: () => [ME],
        listEventsForSlug: async () => [],
        deleteLocalEvent: async (slug: string, uid: string, options: any) => deletes.push({ slug, uid, options }),
        upsertLocalEvent: async (_slug: string, _resource: string, _href: string, _ics: string, options: any) => {
            ifMatches.push(options?.ifMatch);
            throw new StaleEventError();
        },
        recordCalDAVError: () => undefined
    };
    const server = new CalDAVServer(withLogin(fake) as any);
    await server.start();
    try {
        const url = `${config.baseUrl}/calendars/neutron-calendar-bridge/tobi-private/invited%40uni.nl.ics`;
        assert.equal((await fetch(url, { method: 'DELETE' })).status, 204);
        assert.equal((await fetch(url, { method: 'DELETE', headers: { 'Schedule-Reply': 'F' } })).status, 204);
        assert.deepEqual(
            deletes.map(({ uid, options }) => [uid, options.notifyOrganizer]),
            [
                ['invited@uni.nl', true],
                ['invited@uni.nl', false]
            ]
        );

        const stale = await fetch(url, { method: 'PUT', headers: { 'Content-Type': 'text/calendar', 'If-Match': '"old"' }, body: 'BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n' });
        assert.equal(stale.status, 412, 'a save from an outdated copy is answered 412 Precondition Failed');
        assert.deepEqual(ifMatches, ['"old"'], 'If-Match is passed on');
    } finally {
        await server.stop();
    }
});

test('0.44.2: an invitation the organizer cancelled after the last sync — Calendar.app\'s "declined" save before its delete is taken (not refused), then the delete removes it', async () => {
    const { service, calls, row, put, failNext, proton, cleanup } = await setup([invitation('ev-late', 'late@uni.nl', 'NEEDS-ACTION')]);
    try {
        const served = (await row('late@uni.nl')).serializedIcs;
        assert.doesNotMatch(unfold(served), /STATUS:CANCELLED/, 'not yet known as cancelled here');
        // Proton has it cancelled by now; the library refuses the answer as such.
        const event = proton.events.find((entry: any) => entry.eventId === 'ev-late') as any;
        event.decrypted.vevent.status = { value: 'CANCELLED' };
        failNext({ success: false, reason: 'cancelled', error: 'The organizer cancelled this event; there is nothing to answer' });
        calls.length = 0;
        const declined = await put('late@uni.nl', withMyAnswers(served, { '': 'DECLINED' }));
        assert.equal(declined.etag, '', 'taken; Calendar.app fetches Proton\'s version again');
        assert.match(unfold((await row('late@uni.nl')).serializedIcs), /STATUS:CANCELLED/, 're-read: now served as cancelled');
        calls.length = 0;
        await service.deleteLocalEvent('tobi-private', 'late@uni.nl');
        assert.deepEqual(calls.map(({ action }) => action), ['remove'], 'the delete that follows removes it');
        assert.equal((await row('late@uni.nl')).deleted, true);
    } finally {
        await cleanup();
    }
});
