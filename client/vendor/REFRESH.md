# Proton code refresh — 2026-10-12

From WebClients 46dfd76cb9 (2026-10-08) to 775c785f41 (2026-10-12, origin/main). Applied.

## Vendored files

292 files: 280 unchanged upstream, 4 updated, 0 moved, 8 trimmed and untouched upstream, 0 with merge conflicts, 0 removed upstream, 0 removed upstream but trimmed here (kept).

Trimmed, unchanged upstream:
- vendor/@proton/key-transparency/lib/helpers/utils.ts
- vendor/@proton/key-transparency/lib/storage/ktStorageAPI.ts
- vendor/@proton/shared/lib/calendar/formatData.ts
- vendor/@proton/shared/lib/calendar/sanitize.ts
- vendor/@proton/shared/lib/date/timezone.ts
- vendor/@proton/shared/lib/helpers/metrics.ts
- vendor/@proton/shared/lib/i18n/dateFnLocales.ts
- vendor/@proton/shared/lib/i18n/dateFnsLocaleMap.ts

## Import closure of src/*.ts

291 Proton files needed; 0 not vendored yet.

## Build

The bundle builds. 0 vendored file(s) nothing bundles were removed.

## Versions

Dependencies (WebClients resolves per its lockfile):
- @noble/ed25519: ours 1.7.5; WebClients 1.7.5
- @openpgp/web-stream-tools: ours —; WebClients 0.3.1
- @protontech/crypto: ours 2.1.3; WebClients 2.1.3
- @protontech/mimemessage: ours 1.1.4; WebClients 1.1.4
- @protontech/openpgp: ours 6.3.1 (installed as openpgp); WebClients 6.3.1
- @protontech/timezone-support: ours 2.1.0; WebClients 2.1.0
- core-js: ours 3.50.0; WebClients 3.50.0
- date-fns: ours 2.30.0; WebClients 2.30.0, 3.6.0, 4.1.0, 4.4.0
- dompurify: ours 3.2.6; WebClients 3.4.16  ← differs
- file-saver: ours 2.0.5; WebClients 2.0.5
- ical.js: ours 1.5.0; WebClients 1.5.0
- lodash: ours 4.17.21; WebClients 4.17.21, 4.18.1
- node-fetch: ours 3.3.2; WebClients 2.7.0, 3.3.2
- pkijs: ours 3.2.5; WebClients 3.4.1  ← differs
- tinycolor2: ours 1.6.0; WebClients 1.6.0
- ttag: ours 1.8.12; WebClients 1.8.12
- ua-parser-js: ours 1.0.41; WebClients 1.0.41

App identity: the client presents ios-mail@7.11.7; Proton Mail for iOS in the App Store is 7.11.7.
Fallback identity web-account@5.0.425.0; the newest proton-account release tag in WebClients is 5.0.425.0.
A session fork is pulled as web-calendar@5.0.135.5; calendar.proton.me runs 5.0.135.6  ← update CALENDAR_WEB_APP_VERSION.

## API helpers used by the client

24 helpers imported by src/ (createCalendar, createZoomMeeting, getBusySlots, getCalendarUserSettings, getCanonicalAddresses, getEvent, getEventByUID, getMailSettings, getMessage, getPaginatedAttendeesInfo, getPublicKeysVcardHelper, getVtimezones, labelMessages, queryCalendars, queryContactEmails, queryEvents, queryMessageMetadata, removeCalendar, sendMessageDirect, setupCalendar, syncMultipleEvents, updateAttendeePartstat, updateMember, updatePersonalEventPart); 20 lib/api file(s) in the bundle.
No upstream change to those files touches a URL, a method or an imported helper.

## Manifest

vendor/manifest.json: upstream 775c785f41 (2026-10-12), 292 files in 4 packages, 8 trimmed.

## Next

1. pull session forks as web-calendar@5.0.135.6
2. `npm run check`
3. `npm run test:live`
4. update NOTICE.md if vendored packages or licences changed

## This run (2026-10-12, the second refresh)

Four vendored files changed upstream in four days, all additive and none in what the client calls: `api/auth.ts` (optional `ClaimedAddressID` on `auth`/`getInfo`), `constants.ts` (`ADDRESS_TYPE.TYPE_HANDLE = 7`), `api/telemetry.ts`, `payments/constants.ts`. Proton Meet's recipe (`packages/meet/utils/cryptoUtils.ts`, `getMeetingLink.ts`, `hooks/useSaveMeeting.ts`, `api/meet.ts`) and the calendar API files are byte-identical to 46dfd76cb9. The invitation-email strings were regenerated from the new commit (no string changed). `CALENDAR_WEB_APP_VERSION` 5.0.135.5 → 5.0.135.6 (calendar.proton.me); the Mail identity and the account fallback bumped to 5.0.426.0 (tagged 2026-10-12). Live: signin 6/6, session 7/7, plain 8/8, meeting 34/34, video 15/15, calendars 13/13.
