# proton-calendar-client

An unofficial, standalone Node/TypeScript client for the Proton API, focused on Calendar. SRP login, session management, key decryption, and full event CRUD — without running a browser and without depending on a WebClients checkout at runtime.

This is a fork of [proton-calendar-client](https://github.com/TactlessAutist/proton-calendar-client) by **Tactless Autist**, who wrote the original library and the app it was extracted for, [proton-calendar-sync](https://github.com/TactlessAutist/proton-calendar-sync). The fork is maintained by **Tobi** as the library behind [Neutron Calendar Bridge](https://github.com/to-bi-s/neutron-calendar-bridge) (the fork of that app) and lives in `client/` of that repository as an npm workspace: `npm install` at the top of the repository installs and builds it; the commands below are run in `client/`. Unofficial: not affiliated with or endorsed by Proton AG; Proton, Proton Calendar and Proton Mail are trademarks of Proton AG.

Copyright (c) 2026 Tactless Autist (original work). Copyright (c) 2026 Tobi (modifications). See `LICENSE` (GPL-3.0-only, forced by vendored Proton code) and `NOTICE.md`.

## Changes in this fork

What the fork added to the original client, each described in its own section below:

- Sign-in with two-factor authentication and two-password mode, under the library's own identity (or one the calling app supplies); sessions resumed and renewed instead of signed in again; Proton's slow-downs waited out, reads retried, requests spread out.
- Proton's change feeds instead of listing calendars again and again, and decrypted events reused while nothing about them changed.
- Invitations: answering, organizing single and recurring meetings with Proton's own invitation, update and cancellation emails (built with Proton's code, in Proton's 34 languages), answers emailed by guests outside Proton, and filing the emails about meetings once they are dealt with.
- Reminders, contacts for a guest search, busy times (availability), calendar management (rename, recolour, create, delete) and video links (Proton Meet, Zoom).
- Recurring events round-tripped faithfully (repeat rules, skipped and moved occurrences, series edits).
- A refresh routine that merges a newer WebClients commit into the vendored Proton code three-way, keeps the local trims, and reports the dependency and route changes; the crypto now comes from Proton's npm package `@protontech/crypto` rather than vendored sources.
- Offline tests for all of it (`npm run check`) and live scenarios against Proton test accounts (`npm run test:live`).

## Why this exists

Proton has no public API. The official answers are: use the web app, or use Bridge (mail only, paid tier, no calendar). If you want programmatic access to your own calendar — automation, sync to a local client, scripting — the official way has a hole exactly the shape of "an API client". So this is one: the working auth and calendar path extracted out of Proton's open-source WebClients monorepo into a package you can actually `npm install`.

Everything stays end-to-end encrypted. Decryption happens locally with your keys, same as the web app does it; nothing is weakened, nothing extra is sent anywhere.

## What it includes

- `src/proton-calendar-api.ts` — the direct API surface: SRP auth, session handling, calendar/event CRUD, local decryption
- `src/proton-cli.ts` — stateless CLI wrapper (`proton-calendar-cli`)
- `src/proton-daemon.ts` — long-lived daemon entrypoint (`proton-calendar-daemon`) for callers that want a persistent session
- `vendor/@proton/...` — vendored Proton runtime closure (shared, key-transparency, sanitize, utils), at the WebClients commit in `vendor/manifest.json`
- `@protontech/crypto` (npm; Proton's crypto package: pmcrypto, SRP and Proton's OpenPGP.js fork) — what WebClients uses since April 2026 in place of its internal crypto and srp packages

## Quickstart

```bash
npm install
npm run build
```

```ts
import { createProtonCalendarAPI } from 'proton-calendar-client';

const api = await createProtonCalendarAPI({
    username: process.env.PROTON_USERNAME,
    password: process.env.PROTON_PASSWORD,
});
const calendars = await api.getCalendars();
```

Live smoke test (real login + create/read/update/search/delete against your account):

```bash
PROTON_USERNAME=... PROTON_PASSWORD=... npm run smoke
```

Refresh the vendored Proton code to a newer WebClients commit (the routine; monthly, or when Proton changes something the client relies on). `vendor/manifest.json` records the commit the files come from and the local trims; the routine clones WebClients beside the repository (`../../WebClients` from `client/`) if needed (history without file contents, the packages checked out sparsely), merges upstream's changes into the trimmed files three-way, follows moved files, re-walks the imports of `src/*.ts`, prunes what the build does not use, compares dependency versions, lists upstream changes to the API routes the client uses, and writes `vendor/REFRESH.md`:

```bash
npm run refresh:proton              # report only
npm run refresh:proton -- --apply   # do it, then npm run check; resolve conflicts it lists, then npm run test:live
npm run refresh:proton -- --to <commit or tag> --webclients /path/to/WebClients
```

Vendored files that differ from upstream on purpose carry a `proton-calendar-client: trimmed` comment and are listed as `trims` in the manifest. The two older scripts remain for special cases: `npm run vendor:proton` rebuilds `vendor/` from scratch (losing the trims), `node scripts/vendor-add-proton-modules.mjs src/x.ts` adds the modules one new source file needs.

Proton's code uses `Uint8Array.fromBase64` / `toBase64`; Node 22 needs the polyfill the library loads (`src/polyfill.ts`, core-js), newer runtimes have them natively.

`dist/` is self-contained (everything is bundled; only Node's built-in modules are imported), so the package declares no runtime dependencies: every package it builds from is a devDependency. The bridge, which links it as a workspace, gets `dist/` and nothing else to install or ship.

Offline tests (no account, no network): `npm run test:offline` (or `npm run check`).

Live tests against real Proton **test** accounts: `npm run test:live` (scenarios: `signin`, `session`, `plain`, `meeting`, `series`, `feed`, `twofactor` (needs `twoFactor` with a seeded session; left out while it is missing); `outside` on request, e.g. `npm run test:live -- outside`). They read `~/Proton/.neutron-test-accounts.json` (or `NEUTRON_TEST_ACCOUNTS`): `organizer` and `protonGuest` with username, password and a `session`, optionally `outsideGuest.address` (a non-Proton mailbox for the `outside` scenario, where someone clicks "Yes" on the invitation while the test waits). The sessions are seeded once by hand — `npm run seed:sessions` in the repository root signs each account in (Proton's CAPTCHA in an Electron window; the authenticator code from `totpSecret` or asked on the terminal) and writes the session into the file; every run writes the renewed tokens back and none signs out, so a seeded session lasts until Proton ends it (then the run says to seed again). Usernames must contain "test"; passwords and tokens are never printed; keep the file at `chmod 600` and out of any repository. Emails go only to those accounts (test mode). Every scenario removes its events afterwards (`--keep` leaves them; `--cleanup` only removes leftovers of earlier runs). Exit code 0: all passed; 1: a check failed; 3: inconclusive — Proton holds back emails of new free accounts after a burst (seen: about ten emails, then hours), so mailbox checks whose email has not arrived are skipped (the email must be in the sender's Sent folder). One run at a time.

## Sessions and Proton's limits

- **Signing in through Proton's page** (0.28–0.46, session fork): taken out in 0.47 — the fork is pulled as Proton's calendar web app, which Proton's rules do not allow other apps. Parked in a private side repository with the app's half. A session that came from it still resumes like any other saved session (with `keyPassword`).
- **Two-factor authentication and two-password mode** (0.27): after the password, Proton may ask for a second factor; pass `askSecondFactor` (called with `{ totp, securityKey, securityKeyOptions, wrong }`, return `{ code }` or null to give up; asked again with `wrong: true` after a refused code) or a one-shot `twoFactorCode`; without either, `TwoFactorRequiredError`. A security key alone cannot be used yet (the error says to add an authenticator app). In two-password mode the keys are unlocked with the mailbox password: pass `askMailboxPassword` (`{ wrong }` → the password or null) or `mailboxPassword`; otherwise `MailboxPasswordRequiredError`. The session handed to `onSession` carries `keyPassword` (the key the keys are unlocked with — as secret as the password) and `passwordMode`; passed back as `session`, resuming needs no password, code or `keys/salts` request (a renewed access token lacks the scope for the salts).
- **Staying signed in:** pass `onSession` in the credentials to receive the session (`{ UID, AccessToken, RefreshToken }`) after signing in and after each renewal, and pass it back as `session` next time: `initialize()` then resumes it without a password sign-in while Proton accepts it, and signs in with the password when Proton has ended it (the password is still needed to unlock the keys). Keep it as secret as the password. Proton's refresh tokens are single-use, so always keep the newest one. An expired access token (401) is renewed once with the refresh token and the request sent again; if Proton refuses the renewal, `SessionExpiredError`. `signOut()` ends the session at Proton.
- **Slow down:** a 429 (or a 503 with `Retry-After`) pauses every request until Proton's time; short pauses are waited out and the request sent again (Proton did not process it), a pause over a minute ends the request with `RateLimitedError` (`retryAt`). Requests are spread out (10 per second on average, bursts of 30). Reads without an answer, or with 502/503/504, are tried twice more with backoff; writes never. A request without an answer after a minute is given up.
- **App version:** error 5003 becomes `AppVersionError` ("Proton no longer accepts the app version this library presents"). The library presents itself as `proton-calendar-client/<version>` (app version `Other`), or as whatever the calling app passes in `appIdentity`; it borrows no other app's identity.
- **Statistics:** `getRequestStats()` — requests (in all and in the last hour), answers by kind, retries, slow-downs, sign-ins, session renewals, whether the session was resumed. A sync of one calendar over the bridge's window (a year back, two ahead) costs about 50 requests, whatever it holds.
- `findMailboxMessages()` lists emails in a folder without their content (read-only), e.g. to check that an email arrived.
- **Change feeds** (`src/change-feed.ts`): instead of listing a calendar again and again, ask what changed. `getCalendarChanges(calendarId, cursor)` follows Proton Calendar's own feed (`calendar/v1/{id}/modelevents/…`): with `cursor = null` it only fetches the cursor to start from (list the calendar in full once, then pass that cursor); afterwards it returns the events created or changed since then (`changed`: ID, UID, times, RRule, ModifyTime — not the encrypted parts; read them with `listEventsByUid`), the deleted ones (`deleted`: IDs only), `refresh` when Proton asks for a full read or no longer knows the cursor (400, code 2061: a fresh cursor comes along), and `keysChanged` (the calendar's bootstrap is read again). `getAccountChanges(cursor)` does the same for the account (`core/v4/events/latest`, `core/v5/events/…`): `calendars` (a calendar or a member — name, colour — added, changed, removed), `addresses` (read again right away, keys included), `mail` (messages created, changed, deleted), `settings`. Up to 20 pages are followed per call. Proton lists a change within a second.
- **Decrypted events are reused:** `listEvents` and `listEventsByUid` decrypt an event only when something about it changed (a fingerprint of everything Proton sends about it, guest answers included); `getDecryptStats()` counts decryptions and reuses. Up to 10 000 decrypted events are kept in memory.

## Invitations

`answerInvitation({ calendarID, eventID, answer })` answers an invitation (`ACCEPTED` / `TENTATIVE` / `DECLINED`) the way Proton Calendar does: your answer is saved in Proton and a `REPLY` is emailed to the organizer through your account, built and encrypted with Proton's own code (`src/invitations.ts`, ported from Proton's calendar app). `removeInvitation({ calendarID, eventID, notifyOrganizer })` removes one, declining it first if you had said yes or maybe.

`saveOrganizedEvent({ calendarID, eventID?, vevent })` creates or changes a single meeting you organize the way Proton Calendar's event form does (`src/organizer.ts`): guests get an invitation (`REQUEST`), an update or a cancellation (`CANCEL`) by email, Proton guests also get the event's key, and Proton stores the guest list. A new event gets a Proton UID (returned as `protonUid`). `cancelOrganizedEvent({ calendarID, eventID, notifyAttendees })` deletes one, sending the guests a cancellation first; for a series, a cancellation for the series and each changed occurrence, then everything is deleted.

`saveOrganizedSeries({ calendarID, eventID?, vevents, basedOn? })` does the same for recurring meetings (`src/organizer-series.ts`). A calendar app sends its whole new version of the series (main event plus changed occurrences), so the change is read from the difference to Proton's series and carried out like Proton Calendar's "all events" (series updated; a new time or repeat rule cancels and removes changed occurrences and resets answers, other changes are merged into them) or "this event" (one occurrence changed, or deleted with a cancellation). Guests changed for one occurrence only, a deleted occurrence brought back, an occurrence change undone and several occurrence changes in one save are refused. `basedOn` is the version the app edited; a series changed in Proton since is refused (`stale`). Offline test: `npm run test:organizer-series`.

`applyEmailedAnswers({ since, maxPages? })` applies the answers that guests outside Proton send by email to meetings you organize (`src/emailed-answers.ts`). Proton normally records these answers by itself within a minute or two (seen in October 2026, also for replies never opened in Proton Mail), so this is a safety net for answers Proton does not have yet. It reads the emails with a calendar attachment that arrived since `since` (Unix seconds; not spam or trash), decrypts the attachments locally and applies REPLY / COUNTER answers like Proton Mail: to the guest who sent the email, not for older or newer versions of the meeting, cancelled meetings, single occurrences or answers Proton already has, with the reply's DTSTAMP as answer time. Stricter than Proton Mail: emails failing DMARC or flagged as phishing / suspicious are skipped. Nothing is sent and the mailbox is not changed (no read flags). Returns each answer (`applied`, `dry-run` or `skipped` with a reason) and a `cursor` to pass as `since` next time; in dry-run mode answers are only reported. Offline test: `npm run test:emailed-answers`.

`saveOrganizedEvent` and `saveOrganizedSeries` take `withoutRefusedGuests: true` to leave out new guests who cannot be invited (not on the test-mode allowlist, or an address Proton cannot email) and save the rest, like Proton's "continue without"; the outcome lists them in `droppedGuests`. Without it such a save is refused as a whole (nothing changed). `listCalendars()` reports `owned` (your calendar, not one shared with you). `fileCalendarEmails({ moveTo, folderName?, changedUids?, goneMeetings? })` moves emails about meetings that are dealt with out of the Inbox, to the Trash, the Archive or a top-level folder (created if missing) (`src/calendar-emails.ts`). It looks at Inbox emails with a calendar attachment from the last 30 days and decides like Proton Mail's `updateEventInvitation` whether opening the email would still change anything: an invitation or update counts as dealt with once that version is in your calendar and answered (or outdated), a cancellation once applied, a guest's answer once Proton has it (or a newer one). Counter-proposals, answers with a note, starred emails, unanswered invitations and meetings that are not in your calendars stay; absence only counts for meetings the caller reports in `goneMeetings` (deleted, with the time). `changedUids` makes the emails about those meetings be checked now; others are checked again after 1, 2, 5, 10, 30 minutes, then hourly. Each email is checked to be still in the Inbox and not starred right before the move (ten per request). Nothing else is written; a dry run only reports. Offline test: `npm run test:calendar-emails`.

`applyEmailedAnswers` also returns `ignored`: opened emails that held nothing to apply, with the reason (for logs), including replies about meetings that are not in your calendars (deleted, or not yours).

Emails go through a policy, set with `configureInvitations({ policy: { mode, allowlist } })`: `test` (the default; only to allowlisted addresses, anything else refused before Proton changes), `dry-run` (nothing sent or changed; the would-be emails are returned) or `live`. If an email went out but Proton then refused the change (`incomplete`), the same action within 15 minutes finishes it without emailing again. Key transparency is not verified when looking up recipients' keys. Email text is English.

**Languages (0.31).** The emails are written in Proton's own words: the strings of Proton's email code and Proton's translations of them, extracted from the WebClients commit the vendored code comes from (`applications/calendar/locales/<code>.json` → `src/invitation-locales.generated.ts`, by `scripts/extract-invitation-locales.mjs`, which the refresh routine runs; 34 languages, 27 strings, all translated except in Kabyle). `configureInvitations({ policy: { language } })`: `'proton'` (the default) follows Proton Calendar's "Invitation language" setting (`CalendarUserSettings.InviteLocale`, read every 10 minutes; when unset, the account's language, `UserSettings.Locale`; English when neither is known), or one of `INVITATION_LANGUAGES` by code (`de_DE`, `nl_NL`, …; `matchInvitationLanguage('de')` finds the code). The dates in the emails follow the language too (date-fns locales). Offline test `scripts/invitation-language-test.ts`; live scenario `language` (a German invitation delivered, a cancellation in the account's language).

**Reminders (0.33).** Events come back with their reminders: `decrypted.reminders = { hasDefaults, alarms }` — Proton's notifications (device or email, relative triggers; `null` in Proton means the calendar's default reminders, which `readCalendarEvent` expands) as VALARM blocks of ICS text, for a served ICS. Writing: `EventData.alarms` (VALARM blocks) on `createEvent`/`updateEvent`, and the VALARMs of the VEVENTs given to `syncSeries`, become the event's notifications after Proton's own import rules (`getSupportedAlarms`: display/audio → device, email → email; absolute triggers made relative — for all-day events relative to the local midnight, the way Calendar.app means them; location alarms, alarms after the start, duplicates and anything past 10 dropped). Alarms equal to the calendar's defaults are stored as "defaults" (`Notifications: null`), a new event without alarms gets the defaults, an existing one whose alarms were all removed gets none (`[]`). `setEventReminders(calendarId, eventId, alarms)` sets reminders alone through Proton's personal-part endpoint (`…/events/{id}/personal`), for meetings you organize and invitations alike — no emails, no SEQUENCE change — and reports `changed: false` when Proton already has them. `src/reminders.ts`; offline test `scripts/reminders-test.ts`; live scenario `reminders`.

**Contacts (0.33.1).** `listContactEmails()` lists the account's contact addresses with their names (`{ email, name, contactId }`, Proton's `ContactEmails`, which Proton keeps readable for its own autocomplete — not the encrypted contact cards), for a guest search. Live scenario `contacts`.

**Availability (0.33.2).** `getBusySchedule(email, start, end, timeZone)` asks Proton's busy-schedule endpoint for another user's busy times the way Proton Calendar's event form does (four kinds merged, paged) → `{ accessible, slots }`; Proton only shares them inside an organization on an eligible plan, so for anyone else `accessible` is false (a 4xx answer is mapped to that, not thrown). `busyPeriodsOf(ics, start, end, ownEmails)` and `mergeBusyPeriods` (`src/busy.ts`) turn served ICS text into busy periods — series expanded with Proton's iterator, exceptions and excluded occurrences honoured, transparent, cancelled and declined events free — for the bridge's own free/busy answers. Offline test `scripts/busy-test.ts`; live scenario `busy`.

**Calendar management (0.34).** `updateCalendarAppearance(calendarId, { name?, color?, description? })` renames/recolours a calendar through your member entry (`updateMember`, as Proton Calendar's edit form does — shared, subscribed and holiday calendars included); `createCalendar({ name, color?, description?, address? })` creates a personal calendar and sets up its key like Proton does (`generateCalendarKeyPayload` with the primary key of the owning address — `address` names one of your active addresses (0.37), the first active one otherwise; an address that is not yours is refused; a failed key setup removes the calendar again); `deleteCalendar(id)` for the tests' cleanup. Colours: Proton accepts only its accent colours, so `normalizeCalendarColor` maps any `#RGB`/`#RRGGBB`/`#RRGGBBAA` to the nearest one. Live scenario `calendars`.

**Video links (0.34.1).** `createVideoConference(provider, { title?, calendarId? })` makes a meeting room: Proton Meet (2) the way Proton Calendar's event form does — the room's password is generated here and only ever travels in the URL fragment, the session key is wrapped with a bcrypt hash of it, the room name is encrypted with a key derived from the session key, the password is PGP-encrypted to your primary key and an SRP verifier is registered (`POST meet/v1/meetings`; works on a free account) — or Zoom (1) through `calendar/v1/videoconferences` (needs Zoom connected in Proton: otherwise 403 "Your subscription does not allow…"). The conference lives on the event as Proton's `x-pm-conference-id` (signed; `x-pm-provider`) and `x-pm-conference-url` (encrypted; `x-pm-host`, Zoom's `x-pm-password`): `decrypted.conference`, `EventData.conference` (set / `null` to remove / undefined keeps an existing one — Calendar.app does not know these properties). `src/video-links.ts`: `conferenceOf`, `withConference`, `conferenceLines` (for a served ICS), `conferenceOfIcs`, `descriptionWithConference` (Proton's block between its separators, as its apps and invitation emails show it), `videoProviderOfLocation` (the trigger: "Proton Meet" or "Zoom" typed as the location). Proton Meet's own API host (`meet-api.proton.me`) serves what the mail/calendar hosts do not (`protonApi({ host: 'meet' })`): `renameProtonMeet(url, title)` renames a room of this account to follow its event (the session key is unlocked with the password in the link, as Proton's Meet app does), `deleteProtonMeet(url)` removes one; both false for a link that is not this account's room. Found live: Proton removes the room itself when the conference is taken off the event (code 2501 afterwards), but not when the event is deleted — the bridge does that. `conferenceRemovalLines()` are the empty properties that tell the organizer and plain paths "the link was removed". Offline test `scripts/video-links-test.ts`; live scenario `video`.

## Limitations

- Unofficial. Proton can change or break any of this at any time, and their terms may not love it. Use with your own account, at your own risk.
- Calendar-focused. The auth path is the general Proton one, but only calendar endpoints have been exercised end to end.
- Credentials go in via env vars or caller-supplied config; the library does not store them. Persist them yourself, carefully, or use the OS keychain.
- CAPTCHA / human-verification challenges during login need to be handled by the caller (see the bridge at the top of this repository for one approach).
- `.native-device-profile.json` is local runtime state and is never committed.

## License

GPL-3.0-only. This package vendors GPL-3.0 Proton code, so that is not negotiable; original code in `src/` and `scripts/` is copyright Tactless Autist, the fork's modifications copyright Tobi, both under the same license. Upstream notices are preserved — see `NOTICE.md`.
