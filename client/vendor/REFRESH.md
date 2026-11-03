# Proton code refresh — 2026-10-31

From WebClients 775c785f41 (2026-10-12) to 01c27d31ba (2026-10-30, origin/main). Applied.

## Vendored files

292 files: 150 unchanged upstream, 130 updated, 3 moved, 3 trimmed and untouched upstream, 2 with merge conflicts, 6 removed upstream, 0 removed upstream but trimmed here (kept).

Merge conflicts (resolve by hand, markers are in the files):
- vendor/@proton/key-transparency/lib/helpers/utils.ts (1 conflict)
- vendor/@proton/shared/lib/helpers/metrics.ts (1 conflict)

Removed upstream (deleted here; check the importers below):
- vendor/@proton/shared/lib/interfaces/calendar/index.ts
- vendor/@proton/shared/lib/interfaces/index.ts
- vendor/@proton/shared/lib/keys/add/index.ts
- vendor/@proton/shared/lib/keys/import/index.ts
- vendor/@proton/shared/lib/keys/index.ts
- vendor/@proton/shared/lib/keys/reactivation/index.ts

Moved upstream:
- vendor/@proton/shared/lib/date-fns-utc/index.ts → vendor/@proton/shared/lib/date-fns-utc.ts
- vendor/@proton/shared/lib/i18n/index.ts → vendor/@proton/shared/lib/i18n.ts
- vendor/@proton/shared/lib/window/index.ts → vendor/@proton/shared/lib/window.ts

Trimmed, unchanged upstream:
- vendor/@proton/shared/lib/calendar/sanitize.ts
- vendor/@proton/shared/lib/i18n/dateFnLocales.ts
- vendor/@proton/shared/lib/i18n/dateFnsLocaleMap.ts

Updated (trimmed and merged ones marked):
- vendor/@proton/key-transparency/lib/storage/ktStorageAPI.ts (trimmed; merged)
- vendor/@proton/shared/lib/calendar/formatData.ts (trimmed; merged)
- vendor/@proton/shared/lib/date/timezone.ts (trimmed; merged)

## Import closure of src/*.ts

197 Proton files needed; 16 not vendored yet.

To add:
- vendor/@proton/metrics/Metrics.ts
- vendor/@proton/metrics/constants.ts
- vendor/@proton/metrics/lib/Counter.ts
- vendor/@proton/metrics/lib/Histogram.ts
- vendor/@proton/metrics/lib/Metric.ts
- vendor/@proton/metrics/lib/MetricsApi.ts
- vendor/@proton/metrics/lib/MetricsBase.ts
- vendor/@proton/metrics/lib/MetricsRequestService.ts
- vendor/@proton/metrics/metricsInstance.ts
- vendor/@proton/shared/lib/payments/coupons.ts
- vendor/@proton/shared/lib/payments/plan/constants.ts
- vendor/@proton/shared/lib/payments/plan/helpers.ts
- vendor/@proton/shared/lib/payments/subscription/helpers/plan-audience.ts
- vendor/@proton/shared/lib/payments/subscription/helpers/plan-info.ts
- vendor/@proton/shared/lib/payments/subscription/helpers/plan-matching.ts
- vendor/@proton/shared/lib/payments/type-guards.ts

Unresolved imports (a file missing upstream, or a package not vendored):
- @proton/shared/lib/keys (from src/proton-calendar-api.ts)
- @proton/shared/lib/interfaces (from src/invitations.ts)
- @proton/shared/lib/keys (from src/invitations.ts)

tsconfig.json paths added (packages whose exports map into a folder): @proton/key-transparency/*.

## Build

The bundle does not build yet (nothing pruned; fix the errors, then `node scripts/prune-vendor-by-build.mjs`):
- Could not resolve "@proton/key-transparency/lib/keys/getPublicKeysEmailHelper" (src/invitations.ts:25)
- Could not resolve "@proton/shared/lib/interfaces" (src/invitations.ts:58)
- Could not resolve "@proton/shared/lib/keys" (src/invitations.ts:72)
- Could not resolve "@proton/shared/lib/keys" (src/proton-calendar-api.ts:45)

## Versions

Dependencies (WebClients resolves per its lockfile):
- @noble/ed25519: ours 1.7.5; WebClients 1.7.5
- @openpgp/web-stream-tools: ours —; WebClients 0.3.1
- @protontech/crypto: ours 2.1.3; WebClients 2.2.0  ← differs
- @protontech/mimemessage: ours 1.1.4; WebClients 1.1.4
- @protontech/openpgp: ours 6.3.1 (installed as openpgp); WebClients 6.3.1
- @protontech/timezone-support: ours 2.1.0; WebClients 2.1.0
- core-js: ours 3.50.0; WebClients 3.50.0
- date-fns: ours 2.30.0; WebClients 2.30.0, 3.6.0, 4.1.0, 4.4.0
- dompurify: ours 3.2.6; WebClients 3.4.16, 3.4.17  ← differs
- file-saver: ours 2.0.5; WebClients 2.0.5
- ical.js: ours 1.5.0; WebClients 1.5.0
- lodash: ours 4.17.21; WebClients 4.17.21, 4.18.1
- node-fetch: ours 3.3.2; WebClients 2.7.0, 3.3.2
- pkijs: ours 3.2.5; WebClients 3.4.1  ← differs
- tinycolor2: ours 1.6.0; WebClients 1.6.0
- ttag: ours 1.8.12; WebClients 1.8.12
- ua-parser-js: ours 1.0.41; WebClients 1.0.41

## API helpers used by the client

24 helpers imported by src/ (createCalendar, createZoomMeeting, getBusySlots, getCalendarUserSettings, getCanonicalAddresses, getEvent, getEventByUID, getMailSettings, getMessage, getPaginatedAttendeesInfo, getPublicKeysVcardHelper, getVtimezones, labelMessages, queryCalendars, queryContactEmails, queryEvents, queryMessageMetadata, removeCalendar, sendMessageDirect, setupCalendar, syncMultipleEvents, updateAttendeePartstat, updateMember, updatePersonalEventPart); 13 lib/api file(s) in the bundle.

Upstream changes in those files touching a URL, a method or an imported helper:

```diff
packages/shared/lib/api/auth.ts
@@ -111,4 +111,10 @@ export const setLocalKey = (Key: string) => ({
     },
 });
+/** Where the device that created a fork's user code is, for the user approving it. */
+export const getForkCodeLocation = (userCode: string) => ({
+    method: 'get',
+    url: `auth/v4/sessions/forks/code/${encodeURIComponent(userCode)}`,
+});
+
 export const pushForkSession = (data: {
     Payload?: string;
```

## Manifest

vendor/manifest.json: upstream 01c27d31ba (2026-10-30), 302 files in 5 packages, 8 trimmed.

## Next

1. resolve 2 merge conflict(s)
2. fix the build, then `node scripts/prune-vendor-by-build.mjs`
3. `npm run check`
4. `npm run test:live`
5. update NOTICE.md if vendored packages or licences changed
