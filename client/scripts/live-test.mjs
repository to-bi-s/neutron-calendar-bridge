#!/usr/bin/env node
/**
 * Live tests against real Proton test accounts (roadmap stage 0, level 1): the built library
 * (dist/index.mjs) used the way the bridge uses it, end to end, with Proton's servers.
 *
 *   npm run test:live                    the default scenarios
 *   npm run test:live -- meeting series  only these
 *   npm run test:live -- outside         the outside-guest scenario (needs someone to click "Yes")
 *   npm run test:live -- --keep          leave this run's events (to look at them in Proton's web app)
 *   npm run test:live -- --cleanup       only remove what earlier runs left behind
 *
 * Exit code: 0 all passed; 1 a check failed; 3 inconclusive (checks skipped because Proton held
 * back emails, see below); 2 wrong use or a run already going.
 *
 * Accounts: NEUTRON_TEST_ACCOUNTS (default ~/Proton/.neutron-test-accounts.json), with `organizer`
 * and `protonGuest` ({ username, password, session }) and, for `outside`, `outsideGuest.address`.
 * Test accounts only: the Proton usernames must contain "test". Passwords and tokens are never printed.
 *
 * Sessions (0.50): the library speaks to Proton under its own identity, and a password sign-in under
 * it is answered with a CAPTCHA, which no script can solve. So the tests resume sessions seeded once
 * by hand: `npm run seed:sessions` (in the repository root; an Electron window shows Proton's CAPTCHA)
 * writes each account's `session` into the accounts file, and every run here writes the renewed
 * tokens back (Proton's refresh tokens are single-use). Nothing here signs out or ends a session; when
 * Proton has ended one, the run stops and says to seed again. The run lock lives in NEUTRON_TEST_STATE
 * (default ~/.cache/neutron-live-tests), which is also the library's state folder.
 *
 * Scenarios (each cleans up after itself; leftovers of earlier runs are removed first):
 *   signin    both accounts resume their sessions; addresses and calendars
 *   session   the organizer's session: an expired access token renewed (refresh token, single-use)
 *             and the new one handed over, the renewed session resumed again without a password
 *             sign-in; and how many requests a sync pass of one calendar costs (the bridge's window:
 *             a year back, two ahead)
 *   plain     an event without guests: create, change, delete
 *   meeting   a meeting with the Proton guest: invitation, answer, time change (answer reset),
 *             second answer, title change (answer kept), cancellation, and the emails about it
 *             leaving each Inbox once dealt with (fileCalendarEmails, folder "Neutron live tests")
 *   series    a weekly meeting: invitation, answer for the series, one occurrence moved (the
 *             series answer kept), the series cancelled
 *   outside   (only when named) a meeting with the outside guest: the invitation is sent; someone
 *             clicks "Yes" in that mailbox while the test waits (NEUTRON_OUTSIDE_WAIT_MIN, default
 *             15); then: when the reply arrived, whether Proton recorded it by itself (else the
 *             library's applyEmailedAnswers does), the reply leaving the organizer's Inbox, the
 *             cancellation.
 *
 * Changes are sent the way the bridge sends them: with Calendar.app's UID (not Proton's) and the
 * version Calendar.app was served as `basedOn`.
 *
 * Proton delivers emails between accounts in seconds, but holds back the emails of new free
 * accounts after a burst (seen live: about ten emails, then hours). A mailbox check whose email
 * Proton has not delivered (found by its Message-ID; the sender's Sent folder must have it) is
 * skipped, and the run is then inconclusive, not passed.
 *
 * Emails go only between the test accounts (test mode; allowlist = their addresses). Requests are
 * kept slow (polling every 5–15 s); one run at a time (lock file).
 */
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const args = process.argv.slice(2);
const KNOWN_FLAGS = ['--keep', '--cleanup'];
const flags = new Set(args.filter((arg) => arg.startsWith('--')));
const ALL = ['signin', 'session', 'plain', 'meeting', 'series', 'feed', 'twofactor', 'language', 'reminders', 'contacts', 'busy', 'calendars', 'video', 'outside'];
const DEFAULT = ['signin', 'session', 'plain', 'meeting', 'series', 'feed', 'twofactor', 'language', 'reminders', 'contacts', 'busy', 'calendars', 'video'];
const chosen = args.filter((arg) => !arg.startsWith('--'));
for (const flag of flags) {
    if (!KNOWN_FLAGS.includes(flag)) {
        console.error(`Unknown option ${flag} (known: ${KNOWN_FLAGS.join(', ')})`);
        process.exit(2);
    }
}
for (const name of chosen) {
    if (!ALL.includes(name)) {
        console.error(`Unknown scenario "${name}" (known: ${ALL.join(', ')})`);
        process.exit(2);
    }
}
let scenarios = flags.has('--cleanup') ? [] : chosen.length ? chosen : DEFAULT;

const ACCOUNTS_PATH = process.env.NEUTRON_TEST_ACCOUNTS || join(homedir(), 'Proton', '.neutron-test-accounts.json');
const STATE_DIR = process.env.NEUTRON_TEST_STATE || join(homedir(), '.cache', 'neutron-live-tests');
// The library reads its state folder when it is loaded; never an inherited one (e.g. the bridge's).
process.env.PROTON_CALENDAR_CLIENT_STATE_DIR = STATE_DIR;

/** The accounts file; a parse error is reported by position only (V8 quotes the file's text). */
const readAccounts = () => {
    let text;
    try {
        text = readFileSync(ACCOUNTS_PATH, 'utf8');
    } catch (error) {
        console.error(`${ACCOUNTS_PATH}: cannot be read (${error.code || 'error'})`);
        process.exit(2);
    }
    try {
        return JSON.parse(text);
    } catch (error) {
        const position = /position (\d+)/.exec(String(error.message));
        const where = position
            ? (() => {
                  const before = text.slice(0, Number(position[1]));
                  return ` at line ${before.split('\n').length}, column ${before.length - before.lastIndexOf('\n')}`;
              })()
            : '';
        console.error(`${ACCOUNTS_PATH}: not valid JSON${where}`);
        process.exit(2);
    }
};
const accounts = readAccounts();
const secrets = [];
const SEED_HINT = 'seed the sessions first: `npm run seed:sessions` in the repository root';
const hasSession = (account) => Boolean(account?.session?.UID && account.session.AccessToken && account.session.RefreshToken);
const noteSecrets = (account) => {
    for (const value of [account?.password, account?.totpSecret, account?.session?.AccessToken, account?.session?.RefreshToken, account?.session?.keyPassword]) {
        if (value) secrets.push(String(value));
    }
};
for (const role of ['organizer', 'protonGuest']) {
    const account = accounts[role];
    if (!account?.username) {
        console.error(`${ACCOUNTS_PATH}: "${role}" needs username (and a seeded session)`);
        process.exit(2);
    }
    if (!/test/i.test(account.username)) {
        console.error(`${ACCOUNTS_PATH}: "${role}" (${account.username}) does not look like a test account; refusing to run`);
        process.exit(2);
    }
    if (!hasSession(account)) {
        console.error(`${ACCOUNTS_PATH}: "${role}" has no session — ${SEED_HINT}`);
        process.exit(2);
    }
    noteSecrets(account);
}
noteSecrets(accounts.twoFactor);
const OUTSIDE = accounts.outsideGuest?.address || null;
const TWO_FACTOR = accounts.twoFactor?.username && hasSession(accounts.twoFactor) ? accounts.twoFactor : null;
if (TWO_FACTOR && !/test/i.test(TWO_FACTOR.username)) {
    console.error(`${ACCOUNTS_PATH}: "twoFactor" (${TWO_FACTOR.username}) does not look like a test account; refusing to run`);
    process.exit(2);
}
if (!TWO_FACTOR && scenarios.includes('twofactor')) {
    if (chosen.includes('twofactor')) {
        console.error(`${ACCOUNTS_PATH}: the twofactor scenario needs "twoFactor" with username and a seeded session (${SEED_HINT})`);
        process.exit(2);
    }
    scenarios = scenarios.filter((name) => name !== 'twofactor');
}

/**
 * The renewed session of an account, written back to the accounts file at once (the refresh token
 * it replaces is used up). The file is rewritten as a whole, readable by its owner only.
 */
const saveSession = (role, session) => {
    const account = accounts[role];
    if (!account) return;
    // Fields the renewed session does not carry (an instance resumed without them) stay as seeded.
    const keyPassword = session.keyPassword || account.session?.keyPassword;
    const passwordMode = session.passwordMode || account.session?.passwordMode;
    account.session = {
        UID: session.UID,
        AccessToken: session.AccessToken,
        RefreshToken: session.RefreshToken,
        ...(keyPassword ? { keyPassword } : {}),
        ...(passwordMode ? { passwordMode } : {}),
        savedAt: new Date().toISOString()
    };
    noteSecrets(account);
    const temporary = `${ACCOUNTS_PATH}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(accounts, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, ACCOUNTS_PATH);
    // Every instance of this account speaks for the same session: a renewal in one (the session
    // scenario's) invalidates the tokens the others hold, so the shared instance takes the new ones.
    const shared = sessions[role]?.api;
    if (shared?.session && shared.session.UID === session.UID) {
        Object.assign(shared.session, { AccessToken: session.AccessToken, RefreshToken: session.RefreshToken });
    }
};
/** The credentials to resume an account's seeded session with (no password sign-in from here). */
const resumeCredentials = (role, extra = {}) => {
    const account = accounts[role];
    return {
        username: account.username,
        password: '',
        session: { ...account.session },
        onSession: (session) => saveSession(role, session),
        ...extra
    };
};
/** Proton ended a seeded session: nothing more is tried in this run. */
const sessionGone = (error) => error?.name === 'SessionExpiredError' || /ended the session|sign in again/i.test(String(error?.message));

if (scenarios.includes('outside') && !OUTSIDE) {
    console.error(`${ACCOUNTS_PATH}: the outside scenario needs outsideGuest.address`);
    process.exit(2);
}
if ((statSync(ACCOUNTS_PATH).mode & 0o077) !== 0) {
    console.warn(`warning: ${ACCOUNTS_PATH} is readable by others (chmod 600 it)`);
}

/** Never let a password or a token reach the output. */
const redact = (text) => secrets.reduce((value, secret) => value.split(secret).join('<secret>'), String(text));

// One run at a time: a second one would remove the first one's events as "leftovers".
mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
const LOCK = join(STATE_DIR, 'live-test.lock');
const takeLock = () => {
    try {
        const fd = openSync(LOCK, 'wx', 0o600);
        writeSync(fd, `${process.pid} ${Date.now()}\n`);
        closeSync(fd);
        return true;
    } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        const [pid, at] = readFileSync(LOCK, 'utf8').trim().split(' ').map(Number);
        let alive = false;
        try {
            process.kill(pid, 0);
            alive = true;
        } catch {
            alive = false;
        }
        if (alive && Date.now() - at < 3 * 3600_000) {
            return false;
        }
        unlinkSync(LOCK); // left by a run that ended without cleaning up
        return takeLock();
    }
};
if (!takeLock()) {
    console.error(`Another live test is running (${LOCK}); one run at a time.`);
    process.exit(2);
}
const releaseLock = () => {
    try {
        unlinkSync(LOCK);
    } catch {
        // already gone
    }
};

const { createProtonCalendarAPI } = await import('../dist/index.mjs');

// ---------------------------------------------------------------------------------------------
// Checks and output

const results = [];
let current = null;
/** Ctrl-C: the running scenario stops at its next wait, then this run's events are removed. */
let interrupted = false;
const check = (condition, label, detail) => {
    const ok = Boolean(condition);
    current.checks.push({ ok, label });
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${!ok && detail !== undefined ? ` — ${redact(typeof detail === 'string' ? detail : JSON.stringify(detail))}` : ''}`);
    return ok;
};
/** A check that cannot be made for a reason outside the library (Proton held back an email). */
const skip = (label, why) => {
    current.checks.push({ ok: true, skipped: true, label });
    console.log(`  SKIP ${label} — ${why}`);
};
/** A check that must hold for the scenario to go on. */
const must = (condition, label, detail) => {
    if (!check(condition, label, detail)) {
        throw new Error(`stopped: ${label}`);
    }
};
const note = (text) => console.log(`       ${redact(text)}`);

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/** Polls until `probe` returns something truthy (Proton needs a moment to deliver and auto-add). */
const waitFor = async (label, probe, { timeoutMs = 120_000, intervalMs = 5000 } = {}) => {
    const started = Date.now();
    for (;;) {
        const value = await probe();
        if (value) {
            note(`${label}: after ${Math.round((Date.now() - started) / 1000)} s`);
            return value;
        }
        if (Date.now() - started > timeoutMs || interrupted) {
            return null;
        }
        await wait(intervalMs);
    }
};

// ---------------------------------------------------------------------------------------------
// Events as Calendar.app sends them

const RUN = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '');
const PREFIX = '[neutron-live';
const titled = (text) => `${PREFIX} ${RUN}] ${text}`;
const FOLDER = 'Neutron live tests';
/** Meetings start at this minute, so their emails' subjects (date and time only) differ between runs. */
const MINUTE = Number(RUN.slice(12, 14)) % 60;

const VTIMEZONE = [
    'BEGIN:VTIMEZONE', 'TZID:Europe/Amsterdam',
    'BEGIN:DAYLIGHT', 'TZOFFSETFROM:+0100', 'TZOFFSETTO:+0200', 'TZNAME:CEST', 'DTSTART:19700329T020000',
    'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU', 'END:DAYLIGHT',
    'BEGIN:STANDARD', 'TZOFFSETFROM:+0200', 'TZOFFSETTO:+0100', 'TZNAME:CET', 'DTSTART:19701025T030000',
    'RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU', 'END:STANDARD',
    'END:VTIMEZONE'
];

const pad = (n) => String(n).padStart(2, '0');
/** A Unix time as local Amsterdam time, YYYYMMDDTHHMMSS. */
const wallClock = (unixSeconds) => {
    const parts = Object.fromEntries(
        new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Amsterdam', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })
            .formatToParts(new Date(unixSeconds * 1000))
            .map(({ type, value }) => [type, value])
    );
    return `${parts.year}${parts.month}${parts.day}T${parts.hour}${parts.minute}${parts.second}`;
};
/** Today in Amsterdam, fixed for the whole run (a run may cross midnight). */
const TODAY = wallClock(Math.floor(Date.now() / 1000)).slice(0, 8);
/** Local Amsterdam time `days` calendar days from TODAY at `hour`:`minutes`, as YYYYMMDDTHHMMSS. */
const localTime = (days, hour, minutes = MINUTE) => {
    const date = new Date(Date.UTC(Number(TODAY.slice(0, 4)), Number(TODAY.slice(4, 6)) - 1, Number(TODAY.slice(6, 8)) + days));
    return `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}T${pad(hour)}${pad(minutes)}00`;
};
const dtstamp = () => new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');

/** One VEVENT like Calendar.app writes it: the organizer as CHAIR, the guests with their answers. */
const vevent = ({ uid, start, end, summary, organizer, guests = [], answers = {}, rrule, recurrenceId, sequence }) => [
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `DTSTAMP:${dtstamp()}`,
    ...(recurrenceId ? [`RECURRENCE-ID;TZID=Europe/Amsterdam:${recurrenceId}`] : []),
    `DTSTART;TZID=Europe/Amsterdam:${start}`,
    `DTEND;TZID=Europe/Amsterdam:${end}`,
    `SUMMARY:${summary}`,
    ...(sequence !== undefined ? [`SEQUENCE:${sequence}`] : []),
    ...(rrule ? [`RRULE:${rrule}`] : []),
    ...(organizer ? [`ORGANIZER;CN=${organizer}:mailto:${organizer}`] : []),
    ...(organizer ? [`ATTENDEE;CN=${organizer};CUTYPE=INDIVIDUAL;PARTSTAT=ACCEPTED;ROLE=CHAIR:mailto:${organizer}`] : []),
    ...guests.map((guest) => `ATTENDEE;CN=${guest};CUTYPE=INDIVIDUAL;PARTSTAT=${answers[guest] || 'NEEDS-ACTION'};ROLE=REQ-PARTICIPANT;RSVP=TRUE:mailto:${guest}`),
    'END:VEVENT'
];
const calendarFile = (...vevents) =>
    ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Apple Inc.//macOS 26.0//EN', 'CALSCALE:GREGORIAN', ...VTIMEZONE, ...vevents.flat(), 'END:VCALENDAR'].join('\r\n');

const partstatOf = (event, email) =>
    event?.decrypted?.vevent?.attendee?.find((attendee) => attendee.value.replace(/^mailto:/i, '').toLowerCase() === email.toLowerCase())?.parameters?.partstat;
const masterOf = (events) => events.find((event) => !event.decrypted?.vevent?.['recurrence-id']) ?? null;
const startOf = (event) => event.startTimestamp;

// ---------------------------------------------------------------------------------------------
// Accounts

const sessions = {};
const signInFailures = {};
/** Proton asked for verification or to slow down: nothing more is tried in this run. */
let abortRun = null;
const allowlist = () => [
    ...new Set([
        accounts.organizer.username,
        accounts.protonGuest.username,
        ...Object.values(sessions).flatMap((session) => session.addresses),
        ...(OUTSIDE ? [OUTSIDE] : [])
    ].map((address) => address.toLowerCase()))
];
const signIn = async (role) => {
    if (sessions[role]) return sessions[role];
    if (signInFailures[role]) throw signInFailures[role];
    const account = accounts[role];
    const started = Date.now();
    let api;
    try {
        api = await createProtonCalendarAPI(resumeCredentials(role));
    } catch (error) {
        const failure = new Error(`${role} could not resume its session: ${redact(error?.message || error)}${sessionGone(error) ? ` — ${SEED_HINT}` : ''}`);
        signInFailures[role] = failure;
        if (sessionGone(error) || error?.name === 'HumanVerificationRequiredError' || /429|too many|verification/i.test(String(error?.message))) {
            abortRun = failure.message;
        }
        throw failure;
    }
    const seconds = Math.round((Date.now() - started) / 100) / 10;
    const addresses = api.listAddresses().filter((address) => address.active).map((address) => address.email);
    const calendars = await api.listCalendars();
    const calendar = calendars.find((entry) => entry.type === 0 && entry.owned !== false) ?? calendars[0];
    sessions[role] = { api, email: addresses[0], addresses, calendar, calendars, role, seconds };
    for (const session of Object.values(sessions)) {
        session.api.configureInvitations({ policy: { mode: 'test', allowlist: allowlist() }, prodId: '-//Neutron Calendar Bridge//EN' });
    }
    return sessions[role];
};

/** Test events (title starts with "[neutron-live") in the next 120 days, by UID. */
const leftovers = async ({ api, calendar }) => {
    const from = new Date(Date.now() - 2 * 86_400_000);
    const to = new Date(Date.now() + 120 * 86_400_000);
    const events = (await api.listEvents(calendar.id, from, to)).filter((event) => (event.title || '').startsWith(PREFIX));
    const byUid = new Map();
    for (const event of events) {
        byUid.set(event.uid, [...(byUid.get(event.uid) ?? []), event]);
    }
    return byUid;
};

/** Removes test events without emailing anyone (organizer: cancel silently; guest: remove silently). */
const removeTestEvents = async (session, { onlyRun = false } = {}) => {
    const { api, calendar } = session;
    let removed = 0;
    for (const [uid, events] of await leftovers(session)) {
        if (onlyRun && !events.some((event) => event.title.includes(RUN))) continue;
        const main = masterOf(events) ?? events[0];
        const participation = main.decrypted?.participation;
        let outcome;
        if (participation?.isOrganizer) {
            outcome = await api.cancelOrganizedEvent({ calendarID: calendar.id, eventID: main.eventId, notifyAttendees: false });
        } else if (participation?.isAttendee) {
            outcome = await api.removeInvitation({ calendarID: calendar.id, eventID: main.eventId, notifyOrganizer: false });
        } else {
            outcome = await api.deleteEventInCalendar(calendar.id, main.eventId);
        }
        if (outcome?.success) {
            removed += 1;
            note(`removed from ${session.role}: "${main.title}" (${events.length} event(s))`);
        } else {
            note(`could not remove ${uid} from ${session.role}: ${outcome?.reason ?? ''} ${outcome?.error ?? ''}`);
        }
    }
    return removed;
};
/** Test calendars (name starts with "[neutron-live") left by earlier runs of the calendars scenario. */
const removeTestCalendars = async (session) => {
    let removed = 0;
    for (const calendar of await session.api.listCalendars()) {
        if ((calendar.name || '').startsWith(PREFIX) && calendar.owned !== false) {
            await session.api.deleteCalendar(calendar.id);
            removed += 1;
        }
    }
    return removed;
};
const cleanUp = async (label, options) => {
    for (const role of ['protonGuest', 'organizer']) {
        try {
            const session = await signIn(role);
            const removed = await removeTestEvents(session, options);
            if (!options?.onlyRun) note(`${role}: ${removed} test event(s) of earlier runs removed`);
            const calendars = await removeTestCalendars(session);
            if (calendars) note(`${role}: ${calendars} test calendar(s) removed`);
        } catch (error) {
            note(`${label}: ${role}: ${redact(error?.message || error)}`);
        }
    }
};

// ---------------------------------------------------------------------------------------------
// Mailboxes

const fileEmails = (session, uids) =>
    session.api.fileCalendarEmails({
        moveTo: 'folder', folderName: FOLDER, changedUids: uids, lookbackDays: 2, maxOpened: 200, maxChecks: 200, budgetMs: 60_000
    });

const HELD = "Proton has not delivered the organizer's email yet (held back after a burst; seen with new accounts)";
/** Recipients whose emails Proton held back in this run: the next ones are not waited for long. */
const held = new Set();
/**
 * The recipient's copy of an email the library reported as sent, found by its Message-ID. If it
 * has not arrived, the sender's Sent folder must have it (else the send itself is in doubt: FAIL).
 */
const deliveredTo = async (recipient, sender, record, label) => {
    if (!record?.externalId) {
        check(false, `${label}: the email log has the email's Message-ID`, record);
        return null;
    }
    const sentAt = Math.floor(Date.parse(record.at) / 1000);
    const probe = async () => (await recipient.api.findMailboxMessages({ externalId: record.externalId, since: sentAt - 300 }))[0] || null;
    const message = await waitFor(label, probe, { timeoutMs: held.has(recipient.role) ? 20_000 : 150_000, intervalMs: 10_000 });
    if (!message) {
        held.add(recipient.role);
        const sentCopy = (await sender.api.findMailboxMessages({ labelID: '7', externalId: record.externalId, since: sentAt - 300 }))[0];
        check(sentCopy, `${label}: not delivered yet, but in the sender's Sent folder`, record);
    }
    return message;
};
const filedOne = (run, message) => run.filed.find((email) => email.messageId === message.id);
/** The email was looked at in a complete run and left in the Inbox. */
const stayed = (run, message) => !run.error && !run.more && run.waiting >= 1 && !filedOne(run, message);

// ---------------------------------------------------------------------------------------------
// Scenarios

const SCENARIOS = {
    async signin() {
        for (const role of ['organizer', 'protonGuest']) {
            const session = await signIn(role);
            must(session.email, `${role}: session resumed as ${session.email} (${session.seconds} s)`);
            check(session.addresses.some((address) => address.toLowerCase() === accounts[role].username.toLowerCase()), `${role}: the address is the account's`, session.addresses);
            must(session.calendar, `${role}: calendar "${session.calendar?.name}"`, session.calendars.map((entry) => entry.name));
        }
    },

    async session() {
        let saved = null;
        const onSession = (value) => {
            saved = value;
            saveSession('organizer', value);
        };
        const first = await createProtonCalendarAPI(resumeCredentials('organizer', { onSession }));
        must(typeof first.getRequestStats === 'function', 'the library reports request statistics');
        check(first.getRequestStats().resumedSession && first.getRequestStats().signIns === 0, 'the seeded session is resumed without a password sign-in');
        const firstRefresh = first.session.RefreshToken;
        first.session.AccessToken = 'expired-on-purpose';
        const calendars = await first.listCalendars();
        check(calendars.length > 0 && first.getRequestStats().sessionRenewals === 1, 'an expired access token is renewed and the request goes through');
        check(saved?.RefreshToken && saved.RefreshToken !== firstRefresh, 'the renewal brings a new refresh token (handed over again, written to the accounts file)');

        // What a sync pass of one calendar costs (the bridge's default window).
        const calendar = calendars.find((entry) => entry.type === 0) ?? calendars[0];
        const before = first.getRequestStats().requests;
        await first.listCalendars();
        await first.listEvents(calendar.id, new Date(Date.now() - 365 * 86_400_000), new Date(Date.now() + 730 * 86_400_000));
        note(`a sync pass of one calendar: ${first.getRequestStats().requests - before} request(s)`);

        // The renewed session, resumed again (as the next run will).
        const resumed = await createProtonCalendarAPI(resumeCredentials('organizer', { onSession }));
        const resumedStats = resumed.getRequestStats();
        check(resumedStats.resumedSession && resumedStats.signIns === 0, `the renewed session is resumed without a password sign-in (${resumedStats.requests} requests)`);
        check((await resumed.listCalendars()).length === calendars.length, 'and reads the calendars');
        // (Nothing is signed out: the session stays seeded for the next run.)
    },

    /** Two-factor authentication (0.27): a session of a 2FA account resumed and renewed without a code. */
    async twofactor() {
        const account = TWO_FACTOR;
        let saved = null;
        const onSession = (value) => {
            saved = value;
            saveSession('twoFactor', value);
        };
        const askSecondFactor = async () => {
            check(false, 'resuming asked for a second factor');
            return null;
        };
        // Resume: no password sign-in, no code, no salts, also after the access token was renewed.
        const resumed = await createProtonCalendarAPI(resumeCredentials('twoFactor', { session: { ...account.session, AccessToken: 'expired-on-purpose' }, askSecondFactor, onSession }));
        const resumedStats = resumed.getRequestStats();
        check(resumedStats.resumedSession && resumedStats.signIns === 0 && resumedStats.sessionRenewals === 1, `resumed after a renewal without a password sign-in or a code (${resumedStats.requests} requests)`, resumedStats);
        must(saved?.keyPassword && saved.RefreshToken, 'the session handed over carries the key password');
        if (saved.passwordMode) check(saved.passwordMode === 1 || saved.passwordMode === 2, `password mode ${saved.passwordMode}`);
        else note('no password mode in the seeded session (a resumed session does not learn it; `npm run seed:sessions -- --force twoFactor` records it)');
        const calendars = await resumed.listCalendars();
        check(calendars.length > 0, `the resumed session reads the calendars: ${calendars.length}`);
        check(resumed.listAddresses().some((address) => address.email.toLowerCase() === account.username.toLowerCase()), 'the keys are unlocked (addresses readable)');

        // A session saved without the key password (an older version): the password unlocks the keys, still no code.
        if (account.password) {
            const older = await createProtonCalendarAPI({
                username: account.username,
                password: account.password,
                session: { UID: saved.UID, AccessToken: saved.AccessToken, RefreshToken: saved.RefreshToken },
                askSecondFactor,
                // Its renewals go to the file too (the tokens are the session's), but it knows no password mode.
                onSession
            });
            check(older.getRequestStats().signIns === 0 && older.listAddresses().length > 0, 'an older saved session (no key password): keys unlocked with the password, no code');
        } else {
            note('no password for the twoFactor account: the older-session variant (keys unlocked with the password) is skipped');
        }
        // (The sign-in with a code itself is covered offline, sign-in-test; live it would need a CAPTCHA.)
    },

    async plain() {
        const organizer = await signIn('organizer');
        const { api, calendar } = organizer;
        const start = Date.now() + 10 * 86_400_000;
        const created = await api.createEventInCalendar(calendar.id, {
            title: titled('plain event'), description: 'created by the live test', location: 'Groningen',
            startTime: Math.floor(start / 1000), endTime: Math.floor(start / 1000) + 3600, timezone: 'Europe/Amsterdam', isAllDay: false
        });
        const eventId = created?.success ? created.id : null;
        must(eventId, 'created', created);
        const read = async () => (await api.listEvents(calendar.id, new Date(start - 86_400_000), new Date(start + 86_400_000))).find((event) => event.eventId === eventId);
        const first = await read();
        check(first?.title === titled('plain event') && first?.location === 'Groningen', 'read back: title and place');
        check(first && first.endTimestamp - first.startTimestamp === 3600, 'read back: one hour');
        const update = await api.updateEventInCalendar(calendar.id, eventId, {
            title: titled('plain event, changed'), description: '', location: '',
            startTime: Math.floor(start / 1000) + 1800, endTime: Math.floor(start / 1000) + 5400, timezone: 'Europe/Amsterdam', isAllDay: false
        });
        must(update?.success, 'change saved', update);
        const second = await read();
        check(second?.title === titled('plain event, changed'), 'changed: title');
        check(second && second.startTimestamp === first.startTimestamp + 1800, 'changed: 30 minutes later');
        const deletion = await api.deleteEventInCalendar(calendar.id, eventId);
        must(deletion?.success, 'delete accepted', deletion);
        check(!(await read()), 'deleted');
    },

    /** Reminders both ways (0.33): alarms written with an event become Proton notifications; the personal part alone; the defaults. */
    async reminders() {
        const organizer = await signIn('organizer');
        const { api, calendar } = organizer;
        const start = Date.now() + 12 * 86_400_000;
        const window = [new Date(start - 86_400_000), new Date(start + 86_400_000)];
        const alarm = (trigger, action = 'DISPLAY') => `BEGIN:VALARM\r\nTRIGGER:${trigger}\r\nACTION:${action}\r\nDESCRIPTION:Reminder\r\nEND:VALARM`;
        const base = {
            title: titled('reminders event'), description: 'created by the live test', location: 'Groningen',
            startTime: Math.floor(start / 1000), endTime: Math.floor(start / 1000) + 3600, timezone: 'Europe/Amsterdam', isAllDay: false
        };
        // Created with two alarms (display 30 min, email 1 day).
        const created = await api.createEventInCalendar(calendar.id, { ...base, alarms: [alarm('-PT30M'), alarm('-P1D', 'EMAIL')] });
        const eventId = created?.success ? created.id : null;
        must(eventId, 'created with alarms', created);
        const read = async () => (await api.listEvents(calendar.id, ...window)).find((event) => event.eventId === eventId);
        const first = await read();
        const notifications = (event) => (Array.isArray(event?.raw?.Notifications) ? event.raw.Notifications.map((entry) => `${entry.Type}:${entry.Trigger}`).sort() : event?.raw?.Notifications);
        check(JSON.stringify(notifications(first)) === JSON.stringify(['0:-P1D', '1:-PT30M']), `Proton stores two notifications: ${JSON.stringify(notifications(first))}`);
        check(first?.decrypted?.reminders && !first.decrypted.reminders.hasDefaults && first.decrypted.reminders.alarms.length === 2, `read back as two VALARMs, not the defaults`, first?.decrypted?.reminders);
        check(first?.decrypted?.reminders?.alarms.some((text) => /TRIGGER:-PT30M/.test(text) && /ACTION:DISPLAY/.test(text)) && first?.decrypted?.reminders?.alarms.some((text) => /TRIGGER:-P1D/.test(text) && /ACTION:EMAIL/.test(text)), 'the VALARM texts have the triggers and actions');

        // The personal part alone: one alarm.
        const set = await api.setEventReminders(calendar.id, eventId, [alarm('-PT1H')]);
        must(set?.success && set.changed, 'setEventReminders: changed', set);
        const second = await read();
        check(JSON.stringify(notifications(second)) === JSON.stringify(['1:-PT1H']), `now one notification: ${JSON.stringify(notifications(second))}`);
        const again = await api.setEventReminders(calendar.id, eventId, [alarm('-PT1H')]);
        check(again?.success && !again.changed, 'the same again: nothing to change');

        // None.
        const cleared = await api.setEventReminders(calendar.id, eventId, []);
        must(cleared?.success && cleared.changed, 'all reminders removed', cleared);
        const third = await read();
        check(Array.isArray(third?.raw?.Notifications) && third.raw.Notifications.length === 0, `Proton stores an empty list (none), not the defaults: ${JSON.stringify(third?.raw?.Notifications)}`);
        check(third?.decrypted?.reminders && !third.decrypted.reminders.hasDefaults && third.decrypted.reminders.alarms.length === 0, 'read back: no alarms, not the defaults');

        // An update of the event without alarms given keeps whatever Proton has (an older bridge); with the defaults' value → defaults.
        const settings = (await api.resolveCalendarData(calendar.id)).calendarSettings;
        const defaults = (settings?.DefaultPartDayNotifications || []).map((entry) => `${entry.Type}:${entry.Trigger}`).sort();
        note(`calendar defaults (part-day): ${JSON.stringify(defaults)}`);
        if (defaults.length) {
            const asDefaults = await api.setEventReminders(calendar.id, eventId, settings.DefaultPartDayNotifications.map((entry) => alarm(entry.Trigger, entry.Type === 0 ? 'EMAIL' : 'DISPLAY')));
            must(asDefaults?.success && asDefaults.changed, 'alarms equal to the defaults set', asDefaults);
            const fourth = await read();
            check(fourth?.raw?.Notifications === null && fourth?.decrypted?.reminders?.hasDefaults, `stored as the defaults (Notifications null): ${JSON.stringify(fourth?.raw?.Notifications)}`);
            check(JSON.stringify((fourth?.decrypted?.reminders?.alarms || []).map((text) => text.match(/TRIGGER:([^\r\n]+)/)?.[1]).sort()) === JSON.stringify(defaults.map((entry) => entry.split(':').slice(1).join(':')).sort()), 'read back: the defaults as alarms');
        }

        // An update through updateEvent with alarms replaces them; without (undefined) → defaults as before 0.33.
        const update = await api.updateEventInCalendar(calendar.id, eventId, { ...base, title: titled('reminders event, changed'), alarms: [alarm('-PT10M')] });
        must(update?.success, 'updated with one alarm', update);
        const fifth = await read();
        check(JSON.stringify(notifications(fifth)) === JSON.stringify(['1:-PT10M']), `after the update: ${JSON.stringify(notifications(fifth))}`);

        // An all-day event: the trigger counts from the local midnight.
        const day = new Date(start);
        const allDayStart = Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate() + 1) / 1000;
        const allDay = await api.createEventInCalendar(calendar.id, {
            ...base, title: titled('reminders all-day'), startTime: allDayStart, endTime: allDayStart + 86_400, isAllDay: true,
            alarms: ['BEGIN:VALARM\r\nTRIGGER;VALUE=DATE-TIME:' + new Date((allDayStart - 15 * 3600) * 1000).toISOString().replace(/[-:]|\.\d{3}/g, '') + '\r\nACTION:DISPLAY\r\nEND:VALARM']
        });
        const allDayId = allDay?.success ? allDay.id : null;
        must(allDayId, 'all-day event created with an absolute alarm', allDay);
        const readAllDay = (await api.listEvents(calendar.id, ...window)).find((event) => event.eventId === allDayId);
        // The absolute time is 15 h before UTC midnight; read in this machine's zone it is 15 h before the local midnight only in UTC.
        const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
        const expectedHours = 15 - Math.round(((Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate() + 1) - allDayStart * 1000) / 3_600_000)) + (() => { const probe = new Date(allDayStart * 1000); const local = new Date(probe.toLocaleString('en-US', { timeZone: zone })); return Math.round((probe.getTime() - Date.UTC(local.getFullYear(), local.getMonth(), local.getDate(), local.getHours(), local.getMinutes())) / 3_600_000); })();
        note(`all-day notifications: ${JSON.stringify(notifications(readAllDay))} (this machine's zone ${zone}: expected -PT${expectedHours}H)`);
        check(Array.isArray(readAllDay?.raw?.Notifications) && readAllDay.raw.Notifications.length === 1 && readAllDay.raw.Notifications[0].Trigger === `-PT${expectedHours}H`, 'all-day: one relative notification counted from the local midnight');

        for (const id of [eventId, allDayId]) {
            const deletion = await api.deleteEventInCalendar(calendar.id, id);
            check(deletion?.success, `deleted ${id === eventId ? 'the event' : 'the all-day event'}`);
        }
    },

    /** Guest autocomplete (0.33.1): the account's contact addresses, read in clear. */
    async contacts() {
        const organizer = await signIn('organizer');
        const contacts = await organizer.api.listContactEmails();
        must(Array.isArray(contacts), 'listContactEmails returns a list', contacts);
        note(`${contacts.length} contact address(es)${contacts.length ? `, e.g. ${contacts[0].name ? `"${contacts[0].name}" ` : ''}<${contacts[0].email.replace(/^(.).*(@.*)$/, '$1…$2')}>` : ''}`);
        check(contacts.every((entry) => typeof entry.email === 'string' && entry.email.includes('@') && typeof entry.name === 'string'), 'every entry has an address and a name field');
        const guest = accounts.protonGuest.username.toLowerCase();
        note(`the Proton guest ${contacts.some((entry) => entry.email.toLowerCase() === guest) ? 'is' : 'is not'} among the organizer's contacts`);
    },

    /** Availability (0.33.2): what Proton's busy-schedule endpoint answers for the guest, for the organizer themself and for an outsider. */
    async busy() {
        const organizer = await signIn('organizer');
        const { api } = organizer;
        const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
        const start = Math.floor(Date.now() / 1000);
        const end = start + 7 * 86_400;
        for (const [label, email] of [
            ['the Proton guest', accounts.protonGuest.username],
            ['the organizer themself', accounts.organizer.username],
            ['an address outside Proton', 'nobody@example.org']
        ]) {
            let outcome;
            try {
                const schedule = await api.getBusySchedule(email, start, end, zone);
                outcome = `accessible=${schedule.accessible}, ${schedule.slots.length} slot(s)`;
                check(typeof schedule.accessible === 'boolean' && Array.isArray(schedule.slots), `${label}: a schedule object comes back`);
            } catch (error) {
                outcome = `error: ${error?.message} (status ${error?.status ?? '?'})`;
                check(false, `${label}: the lookup must not throw (4xx are mapped to "not accessible")`);
            }
            note(`${label}: ${outcome}`);
        }
    },

    /** Calendar management (0.34): a calendar created, renamed and recoloured like Calendar.app would, then removed. */
    async calendars() {
        const organizer = await signIn('organizer');
        const { api } = organizer;
        const name = titled('calendar');
        // 0.37: the owning address can be named (one of the account's active addresses); a wrong one is refused.
        const ownAddress = api.listAddresses().find((entry) => entry.active)?.email;
        const created = await api.createCalendar({ name, color: '#FF9500FF', description: 'made by the live tests', address: ownAddress });
        must(typeof created?.id === 'string' && created.id, 'createCalendar returns the new ID', created);
        await api.createCalendar({ name: titled('wrong address'), address: 'nobody@example.invalid' }).then(
            () => check(false, 'a calendar for an address that is not ours is refused'),
            (error) => check(/not an active address/.test(error?.message || ''), `a calendar for an address that is not ours is refused (${error?.message})`)
        );
        try {
            let listed = (await api.listCalendars()).find((calendar) => calendar.id === created.id);
            must(listed, 'the new calendar is listed', listed);
            check(listed.name === name, `the name as given (${listed.name === name ? 'yes' : listed.name})`);
            check(/^#[0-9a-f]{6}$/i.test(listed.color) && listed.color.toLowerCase() !== '#ff9500ff', `Calendar.app's #RRGGBBAA colour stored as the nearest Proton accent colour (${listed.color})`);
            check(listed.writable === true && listed.owned === true, 'owned and writable');
            // Its key works: an event can be created and read back in it.
            const start = Date.now() + 3 * 86_400_000;
            const event = await api.createEventInCalendar(created.id, {
                title: titled('in the new calendar'), description: '', location: '',
                startTime: Math.floor(start / 1000), endTime: Math.floor(start / 1000) + 3600, timezone: 'Europe/Amsterdam', isAllDay: false
            });
            check(event?.success, `an event can be created in it (${event?.success ? 'ok' : JSON.stringify(event)})`);
            const read = (await api.listEvents(created.id, new Date(start - 86_400_000), new Date(start + 86_400_000))).find((entry) => entry.eventId === event?.id);
            check(read?.title === titled('in the new calendar'), 'and read back decrypted');

            await api.updateCalendarAppearance(created.id, { name: `${name} (renamed)`, color: '#34c759' });
            listed = (await api.listCalendars()).find((calendar) => calendar.id === created.id);
            check(listed?.name === `${name} (renamed)`, `renamed (${listed?.name})`);
            const greenish = listed?.color && parseInt(listed.color.slice(3, 5), 16) > parseInt(listed.color.slice(1, 3), 16);
            check(greenish, `recoloured towards green (${listed?.color})`);
            check(listed?.description === 'made by the live tests', 'the description stayed');
            await api.updateCalendarAppearance(created.id, { color: '#ff2d55' });
            listed = (await api.listCalendars()).find((calendar) => calendar.id === created.id);
            check(listed?.name === `${name} (renamed)` && listed?.color.toLowerCase() === '#ec3e7c', `a colour change alone keeps the name; #ff2d55 → Proton's #EC3E7C (${listed?.color})`);
        } finally {
            await api.deleteCalendar(created.id);
            check(!(await api.listCalendars()).some((calendar) => calendar.id === created.id), 'removed again');
        }
    },

    /** Video links (0.34.1): a Proton Meet room made the way Proton Calendar does, stored on an event, kept across a plain update, removed; Zoom asked once. */
    async video() {
        const organizer = await signIn('organizer');
        const { api, calendar } = organizer;
        let meet;
        try {
            meet = await api.createVideoConference(2, { title: titled('meet room'), calendarId: calendar.id });
        } catch (error) {
            note(`Proton Meet could not be created: ${redact(error?.message || error)} (status ${error?.status ?? '?'}, code ${error?.data?.Code ?? '?'})`);
            check(false, 'a Proton Meet room is created (if this fails: Meet is not available to this account — see the note)');
        }
        if (meet) {
            check(meet.provider === 2 && /^https:\/\/meet\.proton\.me\/join\/id-[A-Za-z0-9]{10}#pwd-[A-Za-z0-9]{12}$/.test(meet.url), `a join link with a 10-character room and a 12-character password in the fragment (${meet.url.replace(/#pwd-.*/, '#pwd-…')})`);
            check(meet.id.length === 10 && meet.host === accounts.organizer.username, `room id and host (${meet.host})`);
            const start = Date.now() + 4 * 86_400_000;
            const created = await api.createEventInCalendar(calendar.id, {
                title: titled('video call'), description: 'agenda', location: 'Proton Meet',
                startTime: Math.floor(start / 1000), endTime: Math.floor(start / 1000) + 1800, timezone: 'Europe/Amsterdam', isAllDay: false,
                conference: meet
            });
            must(created?.success, 'an event with the conference is created', created);
            const read = async () => (await api.listEvents(calendar.id, new Date(start - 86_400_000), new Date(start + 86_400_000))).find((event) => event.eventId === created.id);
            let event = await read();
            check(event?.decrypted?.conference?.url === meet.url && event?.decrypted?.conference?.provider === 2, `read back: the conference (provider ${event?.decrypted?.conference?.provider}, id ${event?.decrypted?.conference?.id})`);
            check(event?.decrypted?.conference?.host === meet.host, 'read back: the host');
            // 0.34.2: the room follows the title (Proton Meet's own API host).
            const before = (await api.protonApi({ url: `meet/v1/meetings/by-link/${meet.id}`, method: 'get' }))?.Meeting?.MeetingName;
            check((await api.renameProtonMeet(meet.url, titled('video call (renamed)'))) === true, 'the room is renamed after the event');
            const after = (await api.protonApi({ url: `meet/v1/meetings/by-link/${meet.id}`, method: 'get' }))?.Meeting?.MeetingName;
            check(typeof before === 'string' && typeof after === 'string' && before !== after, 'Proton holds the new (encrypted) name');
            check((await api.renameProtonMeet('https://meet.proton.me/join/id-AAAAAAAAAA#pwd-BBBBBBBBBBBB', 'x')) === false, 'a link that is not a room of this account: nothing done');
            const updated = await api.updateEventInCalendar(calendar.id, created.id, {
                title: titled('video call (renamed)'), description: 'agenda', location: 'Proton Meet',
                startTime: Math.floor(start / 1000), endTime: Math.floor(start / 1000) + 1800, timezone: 'Europe/Amsterdam', isAllDay: false
            });
            check(updated?.success, 'a plain update without the conference field');
            event = await read();
            check(event?.decrypted?.conference?.url === meet.url, 'keeps the conference (Calendar.app does not know it)');
            const removed = await api.updateEventInCalendar(calendar.id, created.id, {
                title: titled('video call (renamed)'), description: 'agenda', location: '',
                startTime: Math.floor(start / 1000), endTime: Math.floor(start / 1000) + 1800, timezone: 'Europe/Amsterdam', isAllDay: false,
                conference: null
            });
            check(removed?.success, 'an update with conference: null');
            event = await read();
            check(!event?.decrypted?.conference, 'removes it');
            const roomAfterRemoval = await api.protonApi({ url: `meet/v1/meetings/by-link/${meet.id}`, method: 'get' }).then(() => 'still there', (error) => `gone (${error?.status}, code ${error?.data?.Code})`);
            note(`the room after the link was removed from the event: ${roomAfterRemoval}`);
            await api.deleteEventInCalendar(calendar.id, created.id);
            if (roomAfterRemoval === 'still there') {
                check((await api.deleteProtonMeet(meet.url)) === true, 'the room is removed by the bridge');
            }
            // A second room: does Proton remove it when the event itself is deleted?
            const second = await api.createVideoConference(2, { title: titled('second room'), calendarId: calendar.id });
            const secondEvent = await api.createEventInCalendar(calendar.id, {
                title: titled('second call'), description: '', location: 'Proton Meet',
                startTime: Math.floor(start / 1000) + 7200, endTime: Math.floor(start / 1000) + 9000, timezone: 'Europe/Amsterdam', isAllDay: false,
                conference: second
            });
            must(secondEvent?.success, 'a second event with a room', secondEvent);
            await api.deleteEventInCalendar(calendar.id, secondEvent.id);
            const roomAfterDelete = await api.protonApi({ url: `meet/v1/meetings/by-link/${second.id}`, method: 'get' }).then(() => 'still there', (error) => `gone (${error?.status}, code ${error?.data?.Code})`);
            note(`the room after its event was deleted: ${roomAfterDelete}`);
            if (roomAfterDelete === 'still there') {
                check((await api.deleteProtonMeet(second.url)) === true, 'the room is removed by the bridge');
                const gone = await api.protonApi({ url: `meet/v1/meetings/by-link/${second.id}`, method: 'get' }).then(() => false, (error) => error?.status);
                check(gone !== false, `and cannot be found any more (status ${gone})`);
            }
        }
        try {
            const zoom = await api.createVideoConference(1, { calendarId: calendar.id });
            note(`Zoom: a meeting came back (${zoom.url.replace(/\/\/[^/]+/, '//…')}) — Zoom is connected in this account`);
        } catch (error) {
            note(`Zoom: ${redact(error?.message || error)} (status ${error?.status ?? '?'}, code ${error?.data?.Code ?? '?'}) — expected without Zoom connected in Proton`);
        }
    },

    /** Proton's change feeds (0.26): what the bridge polls instead of listing (see change-feed.ts). */
    async feed() {
        const organizer = await signIn('organizer');
        const { api, calendar } = organizer;
        const start = Date.now() + 11 * 86_400_000;
        const window = [new Date(start - 86_400_000), new Date(start + 86_400_000)];

        const account0 = await api.getAccountChanges(null);
        must(!account0.started && typeof account0.cursor === 'string' && account0.cursor.length > 8, `account feed: a cursor (${account0.requests} request)`, account0);
        const feed0 = await api.getCalendarChanges(calendar.id, null);
        must(!feed0.started && typeof feed0.cursor === 'string' && feed0.cursor.length > 8, `calendar feed: a cursor (${feed0.requests} request)`, feed0);
        const quiet = await api.getCalendarChanges(calendar.id, feed0.cursor);
        check(quiet.started && !quiet.changed.length && !quiet.deleted.length && !quiet.refresh && quiet.requests === 1, 'calendar feed: nothing new = one small request, the cursor unchanged', quiet);

        // Created: the feed names the event, with its UID and times, nothing encrypted.
        const created = await api.createEventInCalendar(calendar.id, {
            title: titled('feed event'), description: 'created by the live test', location: 'Groningen',
            startTime: Math.floor(start / 1000), endTime: Math.floor(start / 1000) + 3600, timezone: 'Europe/Amsterdam', isAllDay: false
        });
        const eventId = created?.success ? created.id : null;
        must(eventId, 'created', created);
        const seen = await waitFor('calendar feed: the creation', async () => {
            const changes = await api.getCalendarChanges(calendar.id, feed0.cursor);
            return changes.changed.some((stub) => stub.id === eventId) ? changes : null;
        }, { timeoutMs: 60_000, intervalMs: 3000 });
        must(seen, 'calendar feed: the created event is listed');
        const stub = seen.changed.find((entry) => entry.id === eventId);
        check(stub.uid && stub.startTime === Math.floor(start / 1000) && stub.calendarId === calendar.id && !stub.rrule, 'calendar feed: UID, start and calendar come along', stub);
        check(seen.cursor !== feed0.cursor && !seen.refresh, 'calendar feed: the cursor moved on, no full read asked');
        const byUid = await api.listEventsByUid(calendar.id, stub.uid);
        check(byUid.length === 1 && byUid[0].title === titled('feed event'), 'the UID from the feed reads the event back (decrypted)');

        // Changed: listed again, with the new times.
        const update = await api.updateEventInCalendar(calendar.id, eventId, {
            title: titled('feed event, changed'), description: '', location: '',
            startTime: Math.floor(start / 1000) + 1800, endTime: Math.floor(start / 1000) + 5400, timezone: 'Europe/Amsterdam', isAllDay: false
        });
        must(update?.success, 'change saved', update);
        const changed = await waitFor('calendar feed: the change', async () => {
            const changes = await api.getCalendarChanges(calendar.id, seen.cursor);
            return changes.changed.some((entry) => entry.id === eventId) ? changes : null;
        }, { timeoutMs: 60_000, intervalMs: 3000 });
        must(changed, 'calendar feed: the changed event is listed');
        check(changed.changed.find((entry) => entry.id === eventId)?.startTime === Math.floor(start / 1000) + 1800, 'calendar feed: with the new start');

        // Decrypted once: reading the window again reuses the decrypted copy.
        const stats0 = api.getDecryptStats();
        await api.listEvents(calendar.id, ...window);
        const stats1 = api.getDecryptStats();
        await api.listEvents(calendar.id, ...window);
        const stats2 = api.getDecryptStats();
        check(stats1.decrypted > stats0.decrypted && stats2.decrypted === stats1.decrypted && stats2.reused > stats1.reused, `unchanged events are not decrypted again (${stats2.decrypted} decrypted, ${stats2.reused} reused)`, [stats0, stats1, stats2]);

        // Deleted: only the ID.
        const deletion = await api.deleteEventInCalendar(calendar.id, eventId);
        must(deletion?.success, 'delete accepted', deletion);
        const deleted = await waitFor('calendar feed: the deletion', async () => {
            const changes = await api.getCalendarChanges(calendar.id, changed.cursor);
            return changes.deleted.includes(eventId) ? changes : null;
        }, { timeoutMs: 60_000, intervalMs: 3000 });
        must(deleted, 'calendar feed: the deleted event is listed by ID');
        check(!deleted.changed.some((entry) => entry.id === eventId), 'calendar feed: and not as changed');

        // The whole run from the first cursor: created and deleted = deleted (the last word counts).
        const whole = await api.getCalendarChanges(calendar.id, feed0.cursor);
        check(whole.deleted.includes(eventId) && !whole.changed.some((entry) => entry.id === eventId), 'calendar feed: from the first cursor the event counts as deleted only');

        // A cursor Proton does not know: a fresh one and a full read asked (how Proton answers is noted).
        const lost = await api.getCalendarChanges(calendar.id, 'neutron-unknown-cursor');
        check(lost.refresh && lost.cursor && lost.cursor !== 'neutron-unknown-cursor', 'calendar feed: an unknown cursor asks for a full read with a fresh cursor', lost);
        const lostAccount = await api.getAccountChanges('neutron-unknown-cursor');
        check(lostAccount.refresh && lostAccount.calendars && lostAccount.cursor !== 'neutron-unknown-cursor', 'account feed: an unknown cursor the same', lostAccount);

        // The account feed since the start of this scenario: nothing about calendars or addresses.
        const account = await api.getAccountChanges(account0.cursor);
        check(account.started && !account.calendars && !account.addresses && !account.refresh, `account feed: no calendar or address change (mail: ${account.mail}, ${account.requests} request(s))`, account);

        // A calendar renamed in Proton (the member's name): the account feed says "calendars". Renamed back.
        const member = (await api.listCalendars()).find((entry) => entry.id === calendar.id);
        if (member?.memberID) {
            const renamed = await api.getAccountChanges(null);
            await api.protonApi({ url: `calendar/v1/${calendar.id}/members/${member.memberID}`, method: 'put', data: { Name: `${member.name} (feed test)` } });
            try {
                const seenRename = await waitFor('account feed: the rename', async () => {
                    const changes = await api.getAccountChanges(renamed.cursor);
                    return changes.calendars ? changes : null;
                }, { timeoutMs: 60_000, intervalMs: 3000 });
                check(seenRename, 'account feed: a calendar renamed in Proton is reported (calendars)');
            } finally {
                await api.protonApi({ url: `calendar/v1/${calendar.id}/members/${member.memberID}`, method: 'put', data: { Name: member.name } });
            }
            check((await api.listCalendars()).find((entry) => entry.id === calendar.id)?.name === member.name, 'the calendar has its name back');
        } else {
            skip('account feed: a calendar renamed in Proton is reported', 'the calendar list carries no member ID');
        }

        // A guest's answer to a meeting you organize: an UPDATE in the organizer's calendar feed; the
        // answer email: "mail" in the account feed.
        const guest = await signIn('protonGuest');
        const uid = `neutron-live-${RUN}-feed-meeting@neutron.test`;
        const day = 13;
        const saved = await api.saveOrganizedEvent({
            calendarID: calendar.id,
            vevent: api.parseIcsToVevents(calendarFile(vevent({ uid, summary: titled('feed meeting'), organizer: organizer.email, guests: [guest.email], start: localTime(day, 10), end: localTime(day, 11) })))[0]
        });
        must(saved.success, 'organizer: meeting saved', saved);
        const protonUid = saved.protonUid;
        const afterSave = await api.getCalendarChanges(calendar.id, null);
        const accountAfterSave = await api.getAccountChanges(null);
        const received = await waitFor('guest: invitation in the calendar', async () => masterOf(await guest.api.listEventsByUid(guest.calendar.id, protonUid)));
        must(received, 'guest: the invitation was added to the calendar');
        const yes = await guest.api.answerInvitation({ calendarID: guest.calendar.id, eventID: received.eventId, answer: 'ACCEPTED' });
        must(yes.success, 'guest: accepted', yes);
        const answerSeen = await waitFor("organizer's calendar feed: the guest's answer", async () => {
            const changes = await api.getCalendarChanges(calendar.id, afterSave.cursor);
            return changes.changed.some((entry) => entry.uid === protonUid) ? changes : null;
        }, { timeoutMs: 120_000, intervalMs: 5000 });
        check(answerSeen, "organizer's calendar feed: a guest's answer is reported as a change to the meeting", answerSeen);
        if (answerSeen) {
            check(partstatOf(masterOf(await api.listEventsByUid(calendar.id, protonUid)), guest.email) === 'ACCEPTED', 'organizer: reading the UID again has the answer');
        }
        const answerMail = yes.emails.find((email) => email.kind === 'answer' && email.outcome === 'sent');
        if (answerMail) {
            const mailSeen = await waitFor('account feed: the answer email', async () => {
                const changes = await api.getAccountChanges(accountAfterSave.cursor);
                return changes.mail ? changes : null;
            }, { timeoutMs: held.has('organizer') ? 20_000 : 150_000, intervalMs: 10_000 });
            if (mailSeen) {
                check(true, 'account feed: an arriving email is reported (mail)');
            } else {
                held.add('organizer');
                skip('account feed: an arriving email is reported (mail)', HELD);
            }
        } else {
            skip('account feed: an arriving email is reported (mail)', 'the answer was not emailed');
        }
    },

    async meeting() {
        const organizer = await signIn('organizer');
        const guest = await signIn('protonGuest');
        // Calendar.app's UID: the bridge keeps sending it for a meeting created there (Proton has its own).
        const uid = `neutron-live-${RUN}-meeting@neutron.test`;
        const summary = titled('meeting');
        const day = 12;
        const asSent = (fields) => organizer.api.parseIcsToVevents(calendarFile(vevent({ uid, summary, organizer: organizer.email, guests: [guest.email], ...fields })))[0];

        // Invitation
        const created = await organizer.api.saveOrganizedEvent({
            calendarID: organizer.calendar.id,
            vevent: asSent({ start: localTime(day, 10), end: localTime(day, 11) })
        });
        must(created.success, 'organizer: meeting saved', created);
        const invitation = created.emails.find((email) => email.kind === 'invitation');
        check(invitation?.outcome === 'sent' && invitation.to.some((to) => to.email === guest.email && to.delivery === 'proton'), 'organizer: invitation sent to the guest, end-to-end', created.emails);
        const protonUid = created.protonUid;
        const inOrganizer = async () => masterOf(await organizer.api.listEventsByUid(organizer.calendar.id, protonUid));
        const inGuest = async () => masterOf(await guest.api.listEventsByUid(guest.calendar.id, protonUid));
        const meeting = await inOrganizer();
        check(meeting?.decrypted?.participation?.isOrganizer, 'organizer: is the organizer');
        check(partstatOf(meeting, guest.email) === 'NEEDS-ACTION', 'organizer: guest has not answered yet', partstatOf(meeting, guest.email));

        const received = await waitFor('guest: invitation in the calendar', inGuest);
        must(received, 'guest: the invitation was added to the calendar (pending)');
        check(received.decrypted?.participation?.isAttendee, 'guest: is a guest');
        check(partstatOf(received, guest.email) === 'NEEDS-ACTION', 'guest: needs to answer');
        check(received.title === summary, 'guest: title');

        // The unanswered invitation stays in the Inbox.
        const invitationMail = await deliveredTo(guest, organizer, invitation, 'guest: invitation email delivered');
        if (invitationMail) {
            const run = await fileEmails(guest, [protonUid]);
            check(stayed(run, invitationMail), 'guest mailbox: the unanswered invitation stays', run);
        } else {
            skip('guest mailbox: the unanswered invitation stays', HELD);
        }

        // Answer: yes
        const yes = await guest.api.answerInvitation({ calendarID: guest.calendar.id, eventID: received.eventId, answer: 'ACCEPTED' });
        must(yes.success, 'guest: accepted', yes);
        check(yes.emails.some((email) => email.kind === 'answer' && email.outcome === 'sent'), 'guest: answer emailed to the organizer', yes.emails);
        check(partstatOf(await inGuest(), guest.email) === 'ACCEPTED', 'guest: own copy says accepted');
        check(await waitFor('organizer: sees the answer', async () => partstatOf(await inOrganizer(), guest.email) === 'ACCEPTED'), 'organizer: guest accepted');
        if (invitationMail) {
            const run = await fileEmails(guest, [protonUid]);
            const filed = filedOne(run, invitationMail);
            check(filed?.outcome === 'moved' && filed.destination === FOLDER, 'guest mailbox: the answered invitation moved to the folder', run);
        } else {
            skip('guest mailbox: the answered invitation moved to the folder', HELD);
        }

        // Time change: update to the guest, answer reset. basedOn: what Calendar.app was served.
        const moved = await organizer.api.saveOrganizedEvent({
            calendarID: organizer.calendar.id,
            eventID: meeting.eventId,
            vevent: asSent({ start: localTime(day, 14), end: localTime(day, 15), answers: { [guest.email]: 'ACCEPTED' }, sequence: 0 }),
            basedOn: asSent({ start: localTime(day, 10), end: localTime(day, 11), answers: { [guest.email]: 'ACCEPTED' }, sequence: 0 })
        });
        must(moved.success, 'organizer: moved to 14:00', moved);
        const updateRecord = moved.emails.find((email) => email.kind === 'update');
        check(updateRecord?.outcome === 'sent', 'organizer: update sent', moved.emails);
        check(partstatOf(await inOrganizer(), guest.email) === 'NEEDS-ACTION', 'organizer: answer reset by the new time');
        const updated = await waitFor('guest: sees the new time', async () => {
            const event = await inGuest();
            return event && wallClock(startOf(event)) === localTime(day, 14) ? event : null;
        });
        must(updated, 'guest: copy moved to 14:00');
        check(partstatOf(updated, guest.email) === 'NEEDS-ACTION', 'guest: needs to answer again');

        // The update waits for an answer.
        const updateMail = await deliveredTo(guest, organizer, updateRecord, 'guest: update email delivered');
        if (updateMail) {
            const run = await fileEmails(guest, [protonUid]);
            check(stayed(run, updateMail), 'guest mailbox: the unanswered update stays', run);
        } else {
            skip('guest mailbox: the unanswered update stays', HELD);
        }

        // Second answer: maybe
        const maybe = await guest.api.answerInvitation({ calendarID: guest.calendar.id, eventID: updated.eventId, answer: 'TENTATIVE' });
        must(maybe.success, 'guest: maybe', maybe);
        check(await waitFor('organizer: sees maybe', async () => partstatOf(await inOrganizer(), guest.email) === 'TENTATIVE'), 'organizer: guest said maybe');
        if (updateMail) {
            const run = await fileEmails(guest, [protonUid]);
            check(filedOne(run, updateMail)?.outcome === 'moved', 'guest mailbox: the answered update moved', run);
        } else {
            skip('guest mailbox: the answered update moved', HELD);
        }

        // The organizer's Inbox: the guest's answer, once Proton has it.
        const replyMail = await deliveredTo(organizer, guest, maybe.emails.find((email) => email.kind === 'answer'), "organizer: the guest's answer delivered");
        if (replyMail) {
            const replyFiled = await waitFor("organizer: the guest's answer leaves the Inbox", async () => filedOne(await fileEmails(organizer, [protonUid]), replyMail), { timeoutMs: 90_000, intervalMs: 10_000 });
            check(replyFiled?.outcome === 'moved', "organizer mailbox: the guest's answer moved", replyFiled);
        } else {
            skip("organizer mailbox: the guest's answer moved", "Proton has not delivered the guest's email yet");
        }

        // Title only: an update, the answer stays (Proton resets answers only for a new time).
        const retitled = await organizer.api.saveOrganizedEvent({
            calendarID: organizer.calendar.id,
            eventID: meeting.eventId,
            vevent: asSent({ start: localTime(day, 14), end: localTime(day, 15), summary: `${summary} (renamed)`, answers: { [guest.email]: 'TENTATIVE' }, sequence: 1 }),
            basedOn: asSent({ start: localTime(day, 14), end: localTime(day, 15), answers: { [guest.email]: 'TENTATIVE' }, sequence: 1 })
        });
        must(retitled.success, 'organizer: renamed', retitled);
        check(retitled.emails.some((email) => email.kind === 'update' && email.outcome === 'sent'), 'organizer: update sent for the new title', retitled.emails);
        const afterRename = await inOrganizer();
        check(afterRename?.title === `${summary} (renamed)`, 'organizer: new title stored');
        check(partstatOf(afterRename, guest.email) === 'TENTATIVE', "organizer: the guest's answer kept", partstatOf(afterRename, guest.email));

        // Cancellation
        const cancelled = await organizer.api.cancelOrganizedEvent({ calendarID: organizer.calendar.id, eventID: meeting.eventId, notifyAttendees: true });
        must(cancelled.success, 'organizer: cancelled', cancelled);
        const cancelRecord = cancelled.emails.find((email) => email.kind === 'cancellation');
        check(cancelRecord?.outcome === 'sent', 'organizer: cancellation sent', cancelled.emails);
        check(!(await inOrganizer()), 'organizer: meeting gone');
        const gone = await waitFor('guest: sees the cancellation', async () => {
            const event = await inGuest();
            return !event || event.decrypted?.vevent?.status?.value === 'CANCELLED' ? { event } : null;
        });
        must(gone, 'guest: copy cancelled or removed');
        note(`guest copy after cancellation: ${gone.event ? `kept, status ${gone.event.decrypted?.vevent?.status?.value}` : 'removed'}`);
        const cancelMail = await deliveredTo(guest, organizer, cancelRecord, 'guest: cancellation email delivered');
        if (cancelMail) {
            const cancelFiled = await waitFor('guest: cancellation leaves the Inbox', async () => filedOne(await fileEmails(guest, [protonUid]), cancelMail), { timeoutMs: 90_000, intervalMs: 10_000 });
            check(cancelFiled?.outcome === 'moved', 'guest mailbox: the applied cancellation moved', cancelFiled);
        } else {
            skip('guest mailbox: the applied cancellation moved', HELD);
        }
        if (gone.event) {
            const removed = await guest.api.removeInvitation({ calendarID: guest.calendar.id, eventID: gone.event.eventId, notifyOrganizer: false });
            check(removed.success && removed.emails.length === 0, 'guest: cancelled copy removed without email', removed);
        }
    },

    /** 0.31: invitation emails in Proton's languages — a German invitation, a cancellation in the account's language (Proton's setting). */
    async language() {
        const organizer = await signIn('organizer');
        const guest = await signIn('protonGuest');
        const uid = `neutron-live-${RUN}-language@neutron.test`;
        const summary = titled('language');
        const day = 13;
        const asSent = (fields) => organizer.api.parseIcsToVevents(calendarFile(vevent({ uid, summary, organizer: organizer.email, guests: [guest.email], ...fields })))[0];
        const policy = organizer.api.getInvitationEmailPolicy();
        try {
            organizer.api.configureInvitations({ policy: { ...policy, language: 'de_DE' } });
            const created = await organizer.api.saveOrganizedEvent({ calendarID: organizer.calendar.id, vevent: asSent({ start: localTime(day, 10), end: localTime(day, 11) }) });
            must(created.success, 'organizer: meeting saved with the German email setting', created);
            const invitation = created.emails.find((email) => email.kind === 'invitation');
            check(invitation?.outcome === 'sent', 'organizer: invitation sent', created.emails);
            check(/^Einladung zu einem Termin/.test(invitation?.subject || '') && /(Montag|Dienstag|Mittwoch|Donnerstag|Freitag|Samstag|Sonntag)/.test(invitation?.subject || ''), `organizer: German subject with a German date — "${invitation?.subject}"`);
            const mail = await deliveredTo(guest, organizer, invitation, 'guest: German invitation delivered');
            if (mail) {
                check(mail.subject === invitation.subject, 'guest mailbox: the subject as sent', mail.subject);
            } else {
                skip('guest mailbox: the subject as sent', HELD);
            }
            const protonUid = created.protonUid;
            const meeting = masterOf(await organizer.api.listEventsByUid(organizer.calendar.id, protonUid));
            must(meeting, 'organizer: the meeting is in the calendar');

            // Proton's own setting: the test account has no "Invitation language" and English as its language.
            organizer.api.configureInvitations({ policy: { ...policy, language: 'proton' } });
            const protonLocale = await organizer.api.getProtonInviteLocale();
            note(`Proton's invitation language for the organizer: ${protonLocale}`);
            const cancelled = await organizer.api.cancelOrganizedEvent({ calendarID: organizer.calendar.id, eventID: meeting.eventId, notifyAttendees: true });
            must(cancelled.success, 'organizer: cancelled', cancelled);
            const cancelRecord = cancelled.emails.find((email) => email.kind === 'cancellation');
            const expectEnglish = !protonLocale || protonLocale.startsWith('en');
            check(cancelRecord?.outcome === 'sent' && (expectEnglish ? /^Cancellation of an event/.test(cancelRecord.subject) : cancelRecord.subject.length > 0), `organizer: cancellation in Proton's language — "${cancelRecord?.subject}"`);
            await waitFor('guest: sees the cancellation', async () => {
                const event = masterOf(await guest.api.listEventsByUid(guest.calendar.id, protonUid));
                return !event || event.decrypted?.vevent?.status?.value === 'CANCELLED' ? { event } : null;
            });
        } finally {
            organizer.api.configureInvitations({ policy });
        }
    },

    async series() {
        const organizer = await signIn('organizer');
        const guest = await signIn('protonGuest');
        const uid = `neutron-live-${RUN}-series@neutron.test`;
        const summary = titled('weekly');
        const day = 21;
        const rrule = 'FREQ=WEEKLY;COUNT=4';
        const master = (fields = {}) => vevent({ uid, start: localTime(day, 9), end: localTime(day, 10), summary, organizer: organizer.email, guests: [guest.email], rrule, ...fields });

        const created = await organizer.api.saveOrganizedSeries({
            calendarID: organizer.calendar.id,
            vevents: organizer.api.parseIcsToVevents(calendarFile(master()))
        });
        must(created.success, 'organizer: weekly meeting saved', created);
        check(created.emails.filter((email) => email.kind === 'invitation' && email.outcome === 'sent').length === 1, 'organizer: one invitation', created.emails);
        const protonUid = created.protonUid;
        must(protonUid, "organizer: Proton's UID of the series", created);
        const organizerEvents = () => organizer.api.listEventsByUid(organizer.calendar.id, protonUid);
        const guestEvents = () => guest.api.listEventsByUid(guest.calendar.id, protonUid);
        const series = masterOf(await organizerEvents());
        must(series, 'organizer: series stored');
        check(series.decrypted?.vevent?.rrule, 'organizer: with its repeat rule');

        const received = await waitFor('guest: series in the calendar', async () => masterOf(await guestEvents()));
        must(received, 'guest: series added (pending)');
        check(received.decrypted?.vevent?.rrule, 'guest: with its repeat rule');

        const yes = await guest.api.answerInvitation({ calendarID: guest.calendar.id, eventID: received.eventId, answer: 'ACCEPTED' });
        must(yes.success, 'guest: accepted the series', yes);
        check(yes.emails.filter((email) => email.kind === 'answer').length === 1, 'guest: one answer email', yes.emails);
        check(await waitFor('organizer: sees the answer', async () => partstatOf(masterOf(await organizerEvents()), guest.email) === 'ACCEPTED'), 'organizer: guest accepted the series');

        // Move the second occurrence one hour later ("only this event"), as Calendar.app sends it:
        // the whole series with Calendar.app's UID, based on the version it was served.
        const secondDay = localTime(day + 7, 9);
        const answered = { [guest.email]: 'ACCEPTED' };
        const changed = await organizer.api.saveOrganizedSeries({
            calendarID: organizer.calendar.id,
            eventID: series.eventId,
            vevents: organizer.api.parseIcsToVevents(calendarFile(
                master({ answers: answered, sequence: 0 }),
                vevent({ uid, recurrenceId: secondDay, start: localTime(day + 7, 10), end: localTime(day + 7, 11), summary, organizer: organizer.email, guests: [guest.email], answers: answered, sequence: 0 })
            )),
            basedOn: organizer.api.parseIcsToVevents(calendarFile(master({ answers: answered, sequence: 0 })))
        });
        must(changed.success, 'organizer: second occurrence moved', changed);
        const updates = changed.emails.filter((email) => email.kind === 'update');
        check(updates.length === 1 && updates[0].recurrenceId === secondDay, 'organizer: one update, for that occurrence', changed.emails);
        const edit = await waitFor('guest: sees the moved occurrence', async () => (await guestEvents()).find((event) => event.decrypted?.vevent?.['recurrence-id']));
        must(edit, 'guest: the occurrence is a single edit now');
        check(wallClock(edit.startTimestamp) === localTime(day + 7, 10), 'guest: the occurrence at its new time (an hour later)', wallClock(edit.startTimestamp));
        check(partstatOf(masterOf(await organizerEvents()), guest.email) === 'ACCEPTED', "organizer: the guest's answer for the series kept");

        // Cancel the series.
        const cancelled = await organizer.api.cancelOrganizedEvent({ calendarID: organizer.calendar.id, eventID: series.eventId, notifyAttendees: true });
        must(cancelled.success, 'organizer: series cancelled', cancelled);
        check(cancelled.emails.filter((email) => email.kind === 'cancellation').length >= 1, 'organizer: cancellation sent', cancelled.emails);
        check((await organizerEvents()).length === 0, 'organizer: series and occurrence gone');
        const gone = await waitFor('guest: sees the cancellation', async () => {
            const events = await guestEvents();
            return events.every((event) => event.decrypted?.vevent?.status?.value === 'CANCELLED') ? { events } : null;
        });
        must(gone, 'guest: everything cancelled or removed');
        note(`guest copies after cancellation: ${gone.events.length}`);
    },

    async outside() {
        const organizer = await signIn('organizer');
        const uid = `neutron-live-${RUN}-outside@neutron.test`;
        const summary = titled('outside guest');
        const day = 15;
        const invitedAt = Math.floor(Date.now() / 1000);
        const created = await organizer.api.saveOrganizedEvent({
            calendarID: organizer.calendar.id,
            vevent: organizer.api.parseIcsToVevents(calendarFile(vevent({ uid, start: localTime(day, 16), end: localTime(day, 17), summary, organizer: organizer.email, guests: [OUTSIDE] })))[0]
        });
        must(created.success, 'organizer: meeting with the outside guest saved', created);
        const invitation = created.emails.find((email) => email.kind === 'invitation');
        check(invitation?.outcome === 'sent' && invitation.to.some((to) => to.email === OUTSIDE), `organizer: invitation sent to ${OUTSIDE} (${invitation?.to?.[0]?.delivery})`, created.emails);
        const protonUid = created.protonUid;
        const inOrganizer = async () => masterOf(await organizer.api.listEventsByUid(organizer.calendar.id, protonUid));

        const minutes = Number(process.env.NEUTRON_OUTSIDE_WAIT_MIN || 15);
        console.log(`  ACTION: in ${OUTSIDE}, open "${invitation?.subject}" ("${summary}") and click Yes (waiting up to ${minutes} min)`);

        // Proton records outside answers by itself (seen live since 0.18). Watch for the reply email
        // (dry run of the library's own handling: reads only) and for Proton's record, separately.
        let reply = null;
        let replyAt = null;
        const policy = organizer.api.getInvitationEmailPolicy();
        const findReply = async () => {
            organizer.api.configureInvitations({ policy: { ...policy, mode: 'dry-run' } });
            try {
                const run = await organizer.api.applyEmailedAnswers({ since: invitedAt - 60, budgetMs: 15_000 });
                return run.answers.find((answer) => answer.eventUid === protonUid) ||
                    run.ignored.find((entry) => (entry.from || '').toLowerCase() === OUTSIDE.toLowerCase() && ((entry.subject || '').includes(RUN) || (entry.subject || '').includes(invitation.subject))) ||
                    null;
            } finally {
                organizer.api.configureInvitations({ policy });
            }
        };
        const answered = await waitFor('organizer: the outside guest answered', async () => {
            if (!reply) {
                reply = await findReply();
                if (reply) {
                    replyAt = Date.now();
                    note(`the reply email arrived ${Math.round(replyAt / 1000 - invitedAt)} s after the invitation`);
                }
            }
            if (partstatOf(await inOrganizer(), OUTSIDE) === 'ACCEPTED') {
                return 'proton';
            }
            // Proton has not recorded it 3 minutes after the reply arrived: the library's safety net.
            if (replyAt && Date.now() - replyAt > 180_000) {
                const run = await organizer.api.applyEmailedAnswers({ since: invitedAt - 60, budgetMs: 15_000 });
                return run.answers.some((answer) => answer.eventUid === protonUid && answer.outcome === 'applied') ? 'library' : null;
            }
            return null;
        }, { timeoutMs: minutes * 60_000, intervalMs: 15_000 });
        must(answered, `organizer: the outside guest's "Yes" arrived within ${minutes} min`);
        note(answered === 'proton' ? 'Proton recorded the answer by itself' : "Proton had not recorded it after 3 min: applied by the library's applyEmailedAnswers");
        check(partstatOf(await inOrganizer(), OUTSIDE) === 'ACCEPTED', 'organizer: the outside guest accepted');

        if (reply?.messageId) {
            const filed = await waitFor('organizer: the reply leaves the Inbox', async () => filedOne(await fileEmails(organizer, [protonUid]), { id: reply.messageId }), { timeoutMs: 120_000, intervalMs: 15_000 });
            check(filed?.outcome === 'moved', "organizer mailbox: the outside guest's reply moved to the folder", filed);
        } else {
            skip("organizer mailbox: the outside guest's reply moved to the folder", 'the reply email was not seen');
        }

        const cancelled = await organizer.api.cancelOrganizedEvent({ calendarID: organizer.calendar.id, eventID: (await inOrganizer()).eventId, notifyAttendees: true });
        must(cancelled.success, 'organizer: cancelled', cancelled);
        check(cancelled.emails.some((email) => email.kind === 'cancellation' && email.to.some((to) => to.email === OUTSIDE)), `organizer: cancellation sent to ${OUTSIDE}`, cancelled.emails);
        console.log(`  ACTION (optional): ${OUTSIDE} should now have the cancellation "${cancelled.emails[0]?.subject}"`);
    }
};

// ---------------------------------------------------------------------------------------------
// Run

process.on('SIGINT', () => {
    if (interrupted) process.exit(130);
    interrupted = true;
    console.log('\nStopping: removing this run\'s events (Ctrl-C again to quit at once)…');
});

const started = Date.now();
console.log(`Live tests ${RUN} (${scenarios.length ? scenarios.join(', ') : 'cleanup only'})`);
current = { name: 'cleanup before', checks: [] };
console.log(`\n▶ ${current.name}`);
await cleanUp('cleanup before');
results.push(current);

for (const name of scenarios) {
    if (abortRun || interrupted) break;
    current = { name, checks: [], started: Date.now() };
    console.log(`\n▶ ${name}`);
    try {
        await SCENARIOS[name]();
    } catch (error) {
        if (!String(error?.message).startsWith('stopped:')) {
            console.log(`  FAIL ${redact(error?.stack || error)}`);
            current.checks.push({ ok: false, label: `${name}: ${redact(error?.message || error)}` });
        }
    }
    current.seconds = Math.round((Date.now() - current.started) / 1000);
    results.push(current);
    if (!flags.has('--keep')) {
        await cleanUp(`cleanup after ${name}`, { onlyRun: true });
    }
}
if (interrupted && flags.has('--keep')) {
    await cleanUp('cleanup after Ctrl-C', { onlyRun: true });
}

console.log('\nSummary');
let failed = 0;
let skipped = 0;
for (const { name, checks, seconds } of results) {
    const bad = checks.filter((entry) => !entry.ok);
    const skips = checks.filter((entry) => entry.skipped);
    failed += bad.length;
    skipped += skips.length;
    const passed = checks.length - bad.length - skips.length;
    console.log(
        `  ${bad.length ? 'FAIL' : skips.length ? '??  ' : 'ok  '} ${name}: ${passed}/${checks.length - skips.length}${skips.length ? `, ${skips.length} skipped` : ''}${seconds !== undefined ? ` (${seconds} s)` : ''}`
    );
    for (const entry of bad) console.log(`         - ${entry.label}`);
    for (const entry of skips) console.log(`         ? ${entry.label}`);
}
if (abortRun) console.log(`\nStopped early: ${abortRun}`);
if (interrupted) console.log('\nStopped by Ctrl-C.');
const verdict = failed
    ? `${failed} check(s) failed`
    : skipped
      ? `Inconclusive: ${skipped} check(s) skipped (Proton held back emails); everything else passed`
      : abortRun || interrupted
        ? 'Stopped before all scenarios ran'
        : 'All live checks passed';
console.log(`\n${verdict} in ${Math.round((Date.now() - started) / 1000)} s.`);
releaseLock();
process.exit(failed ? 1 : skipped || abortRun || interrupted ? 3 : 0);
