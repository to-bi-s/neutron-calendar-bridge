# Changelog

Neutron Calendar Bridge — Bridge for Proton Calendar, a fork of proton-calendar-sync by Tactless Autist. Versions before 1.0 were 0.x, x = patch number; from 1.0.0 on, major.minor.patch.

## 1.0.5 (snoozed alerts in Thunderbird come back; node-ical 0.27)
- **A reminder you snooze in Thunderbird comes back.** Thunderbird stores "snoozed until" and "dismissed up to" in the event itself and saves the event to record them. Proton has no place for either, so such a save writes nothing to Proton — but the copy Neutron Calendar Bridge served back came without them, Thunderbird read it at once and forgot the snooze: a snoozed reminder never showed again, as if it had been dismissed. The bridge now keeps Thunderbird's snooze and dismissal in the copy it serves (per occurrence for repeating events), also when the event is read again from Proton. Still no write to Proton for snoozing or dismissing. If the event is changed in Proton while a snooze waits, Thunderbird gets Proton's new version and keeps its dismissal and snooze too.
- Checked in Thunderbird on 2026-10-27: a reminder snoozed for two minutes came back on time and was dismissed, neither step wrote to Proton. The open point from 1.0.0 (one write after dismissing an *active snooze*) did not recur; it most likely came from the same lost snooze. bridge.log still names the reason of every write if it ever shows again.
- **node-ical 0.20.1 → 0.27.3** (the parser that reads events saved in your calendar app). Times, time zones (also Outlook's Windows names), all-day dates and durations come out exactly as before — compared case by case in three time zones. One fix comes with it: a description with an escaped backslash before an "n" (`\\n`) kept as written, not turned into a line break. node-ical drops moment-timezone, rrule and axios for Temporal, so the app ships fewer packages. It needs Node.js 22 or newer to build (DEVELOPMENT.md updated; Electron 40 brings its own Node 24). Two bridge tests that read the bridge's series back with node-ical count exceptions by moment: 0.27 files each one under its date and its date-time.
- **A title, description or location with a language tag or similar** (`SUMMARY;LANGUAGE=de:Zahnarzt`, as Outlook-style apps may write it) is saved as its text. node-ical hands such a value over as text plus its parameters, and the bridge passed that on as it was instead of the text (old and new node-ical alike; Calendar.app and Thunderbird do not write it that way).
- Updating: `git am` the patches, `npm install` (node-ical), `npm run check`, `npm run package:mac:release`.

## 1.0.4 (Tobi's list after the public release)
- **Info page in the words of the new README**: an **Info** card with what the app does and that it is free software; a new **Help** card between Version and Credits with the manual (README), the detailed rules (BEHAVIOUR.md), building and developing (DEVELOPMENT.md) and "Report a Problem" — all on GitHub, opened in the browser; the credits name the public repository. The app's **Help menu** has "Open GitHub (Manual and Source Code)" and "Report a Problem".
- **The side panel is as wide as Proton Calendar's** (251 instead of 220 pixels), so account addresses are no longer cut off.
- **Developer Options, simplified**: "Invitation emails" is one switch, **Send invitation emails** — on is live, off is the dry run (nothing sent, nothing changed in Proton, the would-be emails logged and listed). The test mode with its address list is out of the window (it stays in the code for the live tests: `invitationEmailMode: "test"` in the account's `config.json`). "Apply answers that guests outside Proton send by email" is out of the window too — tested, not needed, Proton records those answers itself; the code stays (`applyEmailedAnswers: true` in `config.json`).
- DEVELOPMENT.md without the "Updating from very old versions" section.
- **The same spacing between cards on every page** (24 px, as on Settings): Setup and Info had extra margins on top of it, the Overview's account cards sat closer together and had less padding than the other cards.
- Updating: `git am` the patch, `npm run check`, `npm run package:mac:release`.

## 1.0.3 (file names the updater can find; the README for users)
- **Release files without spaces in their names.** GitHub renames an uploaded `Neutron Calendar Bridge-….zip` to `Neutron.Calendar.Bridge-….zip`, while the updater asks for `Neutron-Calendar-Bridge-….zip` — so an app on 1.0.2 could have found a later release but not downloaded it. From 1.0.3 the ZIPs are `neutron-calendar-bridge-<version>-<arch>.zip` and the DMGs `neutron-calendar-bridge-<arch>.dmg` (no version in the name, so the README's download buttons always point at the newest release); the DMG window still shows the version. Apps on 1.0.2 read 1.0.3's `latest-mac.yml` and download fine — 1.0.2 is the only version this ever touched, and only going forward.
- **README rewritten for users**: who the app is for and what it solves, a graphical abstract, two download buttons, the ten things you get, setup for Calendar.app and Thunderbird with pictures, everyday use, privacy, limitations. The detailed rules moved to `docs/BEHAVIOUR.md`, everything about building, signing, releasing and translating to `docs/DEVELOPMENT.md`.
- After a two-architecture build the checkout's SQLCipher was the Intel one (electron-builder's last rebuild), so `npm test` failed with "incompatible architecture"; the package commands now restore this Mac's build at the end (`npm rebuild @journeyapps/sqlcipher`, also the fix by hand).
- Updating: `git am` the patch, `npm run check`, `npm run package:mac:release`; attach every file the script lists.

## 1.0.2 (automatic updates; the icon on older macOS)
- **Automatic updates.** The installed app asks GitHub Releases for a newer version a minute after starting and then once a day (Settings → General → "Check for updates automatically", on by default), downloads it in the background and installs it at **Restart to Update** (Info page, menu-bar menu) or at the next quit. "Check for Updates" on the Info page is live. The check sends GitHub nothing but the request for the release list (the app's name and version in it, as any download has); off, nothing goes there. Unpackaged runs (`npm start`) check nothing. Technically: electron-updater against the public repository's Releases; the builds now also produce `.zip` archives and `latest-mac.yml`, which have to be attached to each Release next to the DMGs (the release script lists them).
- **The app icon on macOS 15 and earlier** was the full-bleed square made for macOS 26 (a white tile with the glyph; macOS 26 cuts it into its own shape, older versions show it as it is). The app now ships the classic icon (the artwork on its plate) for every macOS, and the macOS 26 icon the proper way: an Icon Composer icon compiled into `Assets.car` (`npm run icon:tahoe` on a Mac with Xcode 26, then committed; `scripts/after-pack.cjs` puts it into the app with `CFBundleIconName`). Until that file exists macOS 26 shows the classic icon on its grey plate.
- README: Install explains where the app comes from (Releases, both architectures), how it updates itself, and that a Mac App Store version is planned.
- The verification window's CAPTCHA frame grows with Proton's page instead of scrolling inside (no white scrollbar strip in dark mode). Express 4.21.2 → 4.22.3 (its published advisories; none reachable on a localhost server behind authentication, fixed anyway).
- Updating: `git am` the patch, `npm install` (electron-updater), `npm run check`, `npm run package:mac:release`; attach **all** files the script lists to the Release (DMGs, ZIPs, blockmaps, latest-mac.yml) — from this version on, every Release needs them for the apps already installed to find it.

## 1.0.1 (Intel Macs)
- **A build for Intel Macs.** `npm run package:mac` and `npm run package:mac:release` now produce two DMGs, `…-arm64.dmg` (Apple silicon) and `…-x64.dmg` (Intel), from one run on either kind of Mac: SQLCipher is compiled per architecture by electron-builder as before, and the menu-spinner module is built for both and joined into one fat binary (`scripts/build-native.mjs`, lipo). Each DMG is signed, notarized, stapled and checked on its own; `--quick` builds this Mac's architecture only. The macOS workflow checks both bundles.
- README: the Install section names both downloads.
- Updating: `git am` the patch, `npm run check`, `npm run package:mac:release` (two notarizations, so about twice the wait).

## 1.0.0 (public release)
- **1.0.0 is 0.50.4 with a number that says the app is done.** Everything from the roadmap's parts A–C and stage 16 is in: Calendar.app and Thunderbird over local CalDAV, invitations in both directions, recurring meetings, reminders, video links, free/busy, several accounts, six languages, signed and notarized builds, one honest identity towards Proton. The repository is public from this version; its history starts here (the private history before it holds the earlier sign-in code, parked in a private side repository). The changelog below is kept as it was.
- Every plain event written to Proton (created or updated) is now one log line with the time it took, next to the 0.49.13 lines that say why a save was a write — so a "superfluous write" can be seen directly in bridge.log.
- Known open point: one Proton write after dismissing an *active snooze* in Thunderbird (seen once, 2026-10-21; a plain dismissal is no write, checked 2026-10-25). The log lines above name the cause when it happens again.
- Updating: `git am` the patch, `npm run check`, `npm run package:mac:release`.

## 0.50.4 (publishing prep)
- README for readers who did not build it: an Install section (the signed DMG from Releases, what the app needs and what it keeps on the Mac), the identity the app presents to Proton stated up front, the "not signed yet" sentence gone.
- Test fixtures that resembled real names and addresses replaced by made-up ones (`uni.invalid`, `tobi.bridge`); two stale comments about the former device profile removed.
- Noted for 1.0: `docs/screenshots` are from 0.38 (addresses blurred; `overview.png` shows the removed "Sign In with Proton" page) — to be retaken on the Mac with a test account.

## 0.50.3 (small stuff before 1.0)
- The verification window reads Electron's console-message event the current way (the positional arguments are deprecated and will be removed; the seeding script had the same change in 0.50.1).

## 0.50.2 (Tobi's question: the password in the form)
- **The password field is emptied once its sign-in is through.** It was emptied by the submit handler after a sign-in it finished itself — but since 0.49.9 the verification window completes the sign-in in the main process, so the typed password stayed in the form field of the running window (in memory only, never on disk: the bridge keeps the session, not the password) and showed up, masked, at the next sign-in after a sign-out. Now the field is cleared whenever the account is signed in or the sign-in page is not shown.
- Live tests (`twofactor`): the "older session" variant wrote a session without the password mode back to the accounts file; the write-back now keeps fields a renewed session does not carry, and the password-mode check is a note when the seeded session has none.

## 0.50.1 (first live run from seeded sessions)
- **Live tests: one session, several instances.** The `session` scenario renews the organizer's token, which rotates the refresh token and invalidates the access token every other instance of that account holds — the instance the `signin` scenario had cached then failed every later scenario with "Proton ended the session (its renewal was refused)". Now a renewal in any instance hands the new tokens to the shared one. (Before 0.50 every instance was its own password sign-in, so this never showed.)
- `seed:sessions` reads Electron's console-message event the current way (no deprecation warning).

## 0.50.0 (one identity; the repository ready to go public)
- **The library speaks to Proton as itself only.** `proton-calendar-client` no longer carries the sign-in that presented it as Proton's iOS Mail app (the anonymous session, the device fingerprint and profile, the borrowed version strings); it presents `proton-calendar-client/<version>` (Proton's generic app version "Other"), or the identity the calling app gives it, which the bridge always does (`NeutronCalendarBridge/<version>`, as since 0.45). The sign-in is the plain SRP one: `auth/info`, `auth/v4` (with the CAPTCHA token when Proton asked for one), then the second factor. The former device profile (`.native-device-profile.json` in the library's state folder) is removed at the first start. The removed code is parked in the private side repository that already holds "Sign In with Proton" (0.47), with the patches to put it back.
- **The bridge: no second identity either.** `NEUTRON_SIGN_IN_IDENTITY=ios-mail` (0.45, for test runs) is gone; a saved session from before 0.45 (opened under the former identity) is not resumed under the new one — you sign in once more. Sessions opened since 0.45 (every sign-in since) resume as before.
- **Live tests from seeded sessions.** A password sign-in under the own identity needs Proton's CAPTCHA, which no script can solve, so the live tests (the library's `npm run test:live`, the bridge's `tests/live/accounts.live.ts`) resume sessions seeded once by hand: `npm run seed:sessions` (repository root; an Electron window shows Proton's CAPTCHA, the authenticator code comes from `totpSecret` or is asked on the terminal) writes each test account's `session` into `~/Proton/.neutron-test-accounts.json`, and every run writes the renewed tokens back. No run signs out or ends a session any more; when Proton has ended one, the run stops and says to seed again. The `session` and `twofactor` scenarios check renewal and resumption (the sign-in with a code is covered offline). The weekly GitHub "Live" workflow is removed: live runs happen on a Mac with the seeded file.
- Updating: `git am` the patch, `npm run check`, build. The repository has no Proton identity left in it; see the roadmap for the publishing steps.

## 0.49.13 (leftovers)
- **Thunderbird's menu names in the five translations checked against Thunderbird's own localizations** (thunderbird-l10n: calendar.ftl, calendar-creation.ftl, lightning.dtd). Fixed: German "Gesamte Terminreihe" and "Kalender aktualisieren"; Dutch "Volledige serie" and "Agenda verversen"; French "Adresse e-mail : Aucune", "Séries complètes", "Actualiser l’agenda : Chaque minute", "nouvel agenda"; Spanish "Correo-e: Ninguna", "Series completas", "Refrescar calendario: Cada minuto", "Dirección" (the Location field); Italian "Ogni minuto". The rest matched.
- **"Calendar removed from Calendar.app only"** (a calendar deleted in a calendar app: unticked here, kept in Proton) names the app that did it, like the other texts since 0.49.6.
- **The one superfluous write after a dismissed alert**: not reproduced from the two logged saves (their bodies differ only in a CREATED line); the plain-event save now logs which comparison made it a write — "changes what Proton stores" or "changes the reminders (event: before → after)" — so the next occurrence names its cause.
- Updating: `git am` the patch, `npm run check`, build.

## 0.49.12 (Tobi's test: Tentative, the real answer)
- **Proton stores no Tentative status.** 0.49.9 passed it through and Proton's API refused the save: "Invalid event data (Unknown EventStatus: TENTATIVE)" — Proton knows confirmed and cancelled only (its web app has no such control either). Now a tentative copy is saved as confirmed, in meetings you organize and in plain events alike (the plain path had passed it through since before 0.49.9 and would have failed the same way), and a save that only sets Tentative is no change: nothing written, nothing sent, the app fetches the stored version and shows it confirmed. Card and README say so.
- Updating: `git am` the patch, `npm run check`, build.

## 0.49.11 (Tobi's wishes, verification window)
- **Proton's CAPTCHA in dark too**: the frame is requested with `Dark=true`, as Proton's own web app does for its dark theme (WebClients Captcha.tsx), when the app is dark.
- **The window closes as soon as the verification is done** (the token arrives), instead of showing "Verification completed" while the sign-in finishes; a failure is still reported in a dialog.
- Updating: `git am` the patch, `npm run check`, build.

## 0.49.10 (Tobi's wishes)
- **Verification window in the app's appearance**: the page around Proton's verification was always light; it now follows dark/light like the rest of the app (Proton's own frame inside follows the system's colour scheme as far as Proton supports it), and its texts are in the app's language.
- The Calendars page of a signed-out account no longer shows "Select the calendars to be synced…" above the signed-out note.
- Tier 3 on the Mac (Tobi): a "Show time as free" event appears as free in Thunderbird's Invite Attendees grid (free/busy end to end).
- Updating: `git am` the patch, `npm run check`, build.

## 0.49.9 (Tobi's tier-3 findings and two wishes)
- **Tentative on a meeting you organize is saved.** The library rebuilt the event from the calendar app's copy without its STATUS (the stored one stayed), so Thunderbird's Options → Status → Tentative was dropped — and since Proton's invite data had not changed, nothing was written or emailed. Now Tentative / Confirmed go along (absent = Confirmed, as Proton stores it; a cancellation is still only made by deleting the meeting). No emails for a status-only change, as in Proton Calendar. Plain events were right already.
- **The verification window opens by itself** after a sign-in you just started (once per challenge; the button stays for opening it again). The panel says so.
- **Calendars page of a signed-out account**: "This account is signed out. Its calendars are listed again once you sign in." with **Sign In Again**, instead of "No calendars mirrored yet."
- Tier 3 on the Mac (Tobi): read-only calendars refused (Thunderbird marks them read-only; a forced delete is refused with a dialog), Tasks disabled by Thunderbird (VEVENT-only calendars), offline edits replayed after sign-in, both apps on one calendar without duplicates. Free/busy for guests (the Invite Attendees grid) remains to be looked at.
- Tests: library organizer test (free + tentative round trip, back to busy + confirmed), harness (signed-out Calendars page).
- Updating: `git am` the patch, `npm run check`, build.

## 0.49.8 (Tobi's test: "Show time as free", second half)
- 0.49.7 saved TRANSP to Proton but the read side still dropped it: the library hands the bridge a chosen subset of the decrypted VEVENT (dates, rule, status, sequence, people, conference), and `transp` was not in it, so the served copy was always busy and Thunderbird reverted to Busy after its refresh. Now it is read too; the round trip is complete.
- Updating: `git am` the patch, `npm run check`, build.

## 0.49.7 (Tobi's test: "Show time as free")
- **"Show time as free" survives.** The library dropped TRANSP on every save as "a property Proton cannot store" — a leftover from before Proton's "Show as: Free"; Proton keeps it in the calendar-signed part. Now TRANSP:TRANSPARENT is saved (plain events and meetings you organize; busy is the default and not stored), served back as `TRANSP:TRANSPARENT`, and counts as a change (a save that only switches free/busy is written). The bridge's availability answers honoured it already.
- Thunderbird card and README: Proton has no categories, attachments/links or privacy setting — those are dropped on save; links in the description, "Show time as free" and "Tentative" are kept.
- Tests: served TRANSP, free vs. busy as a change.
- Updating: `git am` the patch, `npm run check`, build.

## 0.49.6 (Tobi's wish: emails dated like Proton's; refusals that name the app)
- **The dates in invitation emails as Proton Calendar's web app writes them on the same Mac.** Proton web takes the words from the invitation language and the long date and time format from the browser's region, then applies the account's "Time format" setting; the bridge used the language's own region (US for English: "Friday October 23rd, 2026 at 6:15 PM" where Proton web wrote "Friday 23 October 2026 at 18:15"). Now the Mac's region (the same source as Safari's) gives the format and the account's 12/24-hour setting (UserSettings.TimeFormat, read with the invitation language) the hours, in all languages. date-fns has no "English (Netherlands)": English with a non-US region takes British English formats. The joiner between date and time comes from the region too, as in Proton web (German words on a Dutch Mac: "16 März 2026 om 12:30").
- **Refusals name the app that asked.** The CalDAV server runs each request with its app known (User-Agent, 0.49.1), so the texts that said "Calendar.app" now say Thunderbird, the other app's name, or "your calendar app" outside a request: the stale-copy 412s, "asked for this change to be saved without telling your guests", "wants to send the invitations itself", the two move refusals, and "Manage calendars in Proton". The series-answer refusal tells Thunderbird users the route: right-click the event → Attendance → Complete Series.
- Tests: the date format (region, hours, the language's own region), the app names in the texts.
- Updating: `git am` the patch, `npm run check`, build.

## 0.49.5 (Tobi's test: "Submit my changes anyway" after a conflict)
- **Overwriting after a conflict works for a series you organize.** Thunderbird's "Submit my changes anyway" sends its whole item, the unchanged occurrences included — as they were before Proton's last change. The client refused that as "changes the whole series and <occurrence> at the same time", so the only way out was Discard. Now an occurrence in the save that matches the version the bridge served before the last change (one of the versions replaced in the last ten minutes) and not Proton's current one is taken for what it is, the app's stale copy, and left out: the series change goes through, the occurrences stay as Proton has them, and the app sees that after its refresh. An occurrence the user did change still goes along, and the client decides as before. Logged.
- Test: the stale copy after a rename in Proton — the occurrence left out, a changed one kept.
- Updating: `git am` the patch, `npm run check`, build.

## 0.49.4 (Tobi's test: Thunderbird replaying after the series answer)
- **An answer the series already has is nothing to do.** After 0.49.3 answered the series, Thunderbird kept replaying its cached copy — the series still at NEEDS-ACTION plus the occurrences clicked as ACCEPTED — and each replay was refused (403: the series is answered), so Thunderbird never took the server's version, showed only its own occurrences as accepted and retried at every refresh. Now, when every occurrence added in a save repeats the answer the series already has in Proton and nothing else changed, the bridge answers 204 without an ETag and logs "nothing to do": the app fetches the current version and the replay ends. Nothing is sent. An occurrence answered differently from the series is still refused (not possible in Proton).
- Test: the replayed copy after the series answer, from Thunderbird and unnamed.
- Updating: `git am` the patch, `npm run check`, build.

## 0.49.3 (Tobi's test: answering a recurring invitation in Thunderbird)
- **Thunderbird's answer to a series.** As a guest, Thunderbird only answers the occurrence you opened (its dialog has no "whole series", and the Attendance entries of its context menu stay empty without an email identity): the series stays at NEEDS-ACTION and a new occurrence carries the answer, which the bridge refused (403: Proton takes one answer per series). Now, when the series has not been answered yet and nothing else changed, the bridge takes that as the answer for the whole series — as Proton Calendar does when you answer from an occurrence — and emails the organizer; logged as such. An already answered series is still refused (Proton cannot answer one occurrence differently), and Calendar.app keeps its refusal, because there you chose "this occurrence" yourself. The app is known from its User-Agent (0.49.1); a save replayed from the offline queue keeps the old rule.
- **Warnings name the app.** "Calendar.app cannot sign in", "uses an old password", "connects again", the Setup alert and the Overview's "Last failed request" say Thunderbird (or the other app's name) when it was not Calendar.app; the Setup alert's second step is Calendar.app's own path only for Calendar.app. Falls back to "A calendar app" when the name is unknown.
- Thunderbird card, More Details: how recurring invitations are answered.
- Tests: the series answer from Thunderbird and the refusals around it; the harness checks the alerts named after Thunderbird.
- Updating: `git am` the patch, `npm run check`, build.

## 0.49.2 (Tobi's wish: one look everywhere)
- **Setup cards like every other card.** The header holds the card's name in small capitals and the first section's title right under it (APPLE CALENDAR / Auto Setup, THUNDERBIRD / Manual Setup, OTHER CALENDAR APPS / Manual Setup) with the same spacing as Settings and Info; the Apple card's second title, Manual Setup, is a title of the same size. The status lines sit under the header.
- **Small-capitals labels in one colour and spacing** across the app: the card kickers were in the text colour and spaced wider than the Overview's labels, the field labels and the detail cards. The Overview's account name is now the same size as the other card titles and sits as close to its label.
- **Developer Options card fixed**: since 0.48.1 it wore the sub-cards' class and so had their tint, padding and corners; it is a plain card again, the three sub-cards keep their look.
- Updating: `git am` the patch, `npm run check`, build.

## 0.49.1 (Tobi's wish: who is connected)
- **The bridge tells the apps apart.** Until now every correct login counted as Calendar.app — with Thunderbird alone, the Apple card said Connected. Now the User-Agent decides: Thunderbird (checked first, its string names Mac OS X too), Calendar.app and its helpers (CalendarAgent, dataaccessd, accountsd, …), or another CalDAV app, named after the first product in the string ("BusyCal/2025.1 …" → BusyCal; the string itself is not kept). Each is noted on its own, per account, and remembered across restarts (`thunderbirdLastSeenAt`, `otherClientLastSeen`), with one log line at the first sign-in of each.
- **Setup page: a pill on every card.** Thunderbird: Connected (a request in the last 3 hours, "Thunderbird is connected (last request …)"), Quiet ("Thunderbird last asked …"), or Not set up. Other Calendar Apps: Connected or Quiet with the app's name ("BusyCal is connected …"), Untested while none has ever signed in. The card titles are small capitals again (APPLE CALENDAR, THUNDERBIRD, OTHER CALENDAR APPS), and the Thunderbird and other-apps cards start with a "Manual Setup" heading like the Apple card's second half.
- Tests: the User-Agent classifier, per-app noting and the config round trip; the harness checks the three pills.
- Updating: `git am` the patch, `npm run check`, build.

## 0.49.0 (Tobi's wish: a tidier Setup page)
- **Setup page in three cards, one per app.** "Apple Calendar" (the pill alone says Connected / Quiet / Not set up — no second title) holds **Auto Setup** and, after an "or" line, **Manual Setup**: a line "If you would rather not install a profile." and a **Show Instructions** button that unfolds the values (host, port, username, password, principal path, security) and the Calendar.app steps that used to be the third card. When macOS refuses the profile, the instructions open by themselves. "Thunderbird" as before, with its name as the title.
- **New card "Other Calendar Apps"** (pill: Untested): the bridge is a CalDAV server on this Mac, so BusyCal, Fantastical and others should work too — with the server URL (the principal; `/.well-known/caldav` points there), username, password, host, port and the calendar home to copy, five general steps (add a CalDAV account, SSL off and what to enter when the app asks for server/port/path separately or finds nothing, find and tick the calendars with one account per Proton account, switch off the app's own invitation sending, a test event each way), a note asking for reports (GitHub issues; detailed logging and its private details), and More Details (whose password, this Mac only, no tasks/VTODO). In all six languages.
- Harness: Show/Hide Instructions, the other-apps URL and home; screenshots 06d (manual setup) and 06e (other apps).
- Updating: `git am` the patch, `npm run check`, build.

## 0.48.9
- **`npm run package:mac:quick`**: a signed build for testing on this Mac with one wait for Apple instead of two — the app is signed, notarized and stapled as always, the DMG only signed (not notarized). Gatekeeper accepts the app when it starts; only the DMG itself is not checked offline when opened. Builds given to others still go through `npm run package:mac:release`.

## 0.48.8 (Tobi's wish: Thunderbird setup)
- **Setup page: "Set Up Thunderbird".** A card with the account's username, the location to enter (its calendar home, `http://127.0.0.1:<port>/calendars/<user>/` — Thunderbird finds all of the account's calendars from there since 0.48.7) and its password, each copied with a click (the password removed from the clipboard again after 90 s), and three steps: New Calendar → On the Network, tick the calendars, and for each **Properties → Email: None** — the setting that makes Thunderbird leave invitations to the bridge (with an email identity it sends them itself, and they fail). Refresh interval, which password, where answers show and Thunderbird's identity warning under More Details. In all six languages.
- Tested: Thunderbird's discovery from the calendar home (home → principal → calendars, read-only ones as read-only).
- Updating: `git am` the patch, `npm run check`, build.

## 0.48.7 (Thunderbird: who is the guest)
- **Thunderbird can find out which guest is you.** It looks for the user's principal (addresses, scheduling inbox and outbox) through `current-user-principal` on a calendar, and else `principal-collection-set` on the calendar home; the bridge answered neither there (only at the top level, which Thunderbird does not ask). So Thunderbird never learned the account's addresses: it showed answer buttons, but saved invitations with your answer unchanged (seen in the log: PARTSTAT still NEEDS-ACTION after Accept and after Decline), and no reply went out. Every calendar now names its owner and the principal, and the home the principal collection.
- Updating: `git am` the patch, `npm run check`, build. In Thunderbird, restart it once so it reads the calendars' details again.

## 0.48.6 (tracing Thunderbird's answers)
- Thunderbird's answers to invitations reached the bridge as saves in which your answer had not changed, so no reply went to the organizer. To see why: with detailed logging on, every save from a calendar app now writes its event data into bridge.log (instead of only failed ones, 0.48.5), and a save of an invitation that changes nothing in Proton says which answer of yours it held ("none" when no guest has one of the account's addresses).
- Updating: `git am` the patch, `npm run check`, build.

## 0.48.5 (third Thunderbird test)
- **All-day events from Thunderbird are saved.** Thunderbird writes an all-day event's dates with a time zone (`DTSTART;TZID=Europe/Amsterdam;VALUE=DATE:20261021`), which RFC 5545 does not allow on a plain date; Proton refused such an event ("Invalid event data (Cannot contain both TZID and date value)", a 500 every minute as Thunderbird kept trying). The bridge now drops the time zone from plain dates (DTSTART, DTEND, DUE, RECURRENCE-ID, EXDATE, RDATE) before saving; date-times keep theirs.
- With detailed logging on, a save that fails with a server error also writes the event data the app sent into bridge.log, for tracing (left out otherwise).
- Updating: `git am` the patch, `npm run check`, build.

## 0.48.4 (second Thunderbird test)
- **A deleted meeting no longer comes back from another app's old copy.** Thunderbird re-saved a meeting two minutes after it had been deleted in Calendar.app (it had just dismissed the meeting's alert, and still had its old copy); the bridge took the save as a new meeting, created it again in Proton and re-sent the invitation to the guest — which is why the meeting "reappeared" for the guest too. A save "if it is still the version I read" (If-Match) of an event that no longer exists is now refused (412: the app drops its copy at its next refresh); a new event (no If-Match) is created as before, and Calendar.app's Undo after a delete still works.
- **No more "wrong password" for Thunderbird's parallel requests.** Thunderbird sends several requests at once with one sign-in (Digest), numbered; they can arrive out of order, and the bridge took a lower number after a higher one for a replay and reported a wrong password ("Calendar.app uses an old password"). Now each number counts once, in any order; a number used twice gets a fresh challenge (no access), not a wrong-password warning.
- Updating: `git am` the patch, `npm run check`, build.

## 0.48.3 (first Thunderbird test)
- **Thunderbird can sign in.** Two things stopped it (seen in Tobi's log): Thunderbird marks its requests with `Origin: http://127.0.0.1:<port>` — the bridge's own address — and the protection against web pages refused every request with an Origin (403); now the bridge's own origin is allowed (any other origin, port or host name still is not). And `GET`/`HEAD` on a collection that already ends in "/" was redirected to "…//", where Thunderbird's Digest sign-in no longer matched, which the bridge reported as Calendar.app using a wrong password; only a path without the final slash is redirected now.
- Updating: `git am` the patch, `npm run check`, build.

## 0.48.2 (Tobi's wish)
- **Shorter, plainer texts on the Settings page**: what a setting does for you, without the technical detail (accounts, sync schedule, email language, tidying the Inbox, notifications, developer options and their modes, detailed logging); the warnings for test mode and dry run too. In all six languages. The details stay in the README.
- Updating: `git am` the patch, `npm run check`, build.

## 0.48.1 (Tobi's wishes)
- **A shorter Auto Setup card on the Setup page**, readable at a glance: one line on whether Calendar.app is connected ("Calendar.app is connected (last request 5m ago). Nothing to do." / "Click Set Up Calendar.app and follow the steps."), after the click two short steps (install the profile in System Settings → General → Device Management; the calendars then show up under "Proton (address)"), and a note in blue: **Switch Off Reminders** — macOS turns Reminders on for every new account and a profile cannot prevent that (tested with 0.48); Proton Calendar has no tasks. Everything else — the path on macOS 13 and 14, why the profile shows as "not verified", removing an account added by hand, removing the profile later, when to set up again, what Reminders does if left on — is under **More Details**, folded away. In all six languages.
- **Developer options in sub-cards**: Invitation emails (mode, test addresses, emailed answers), Detailed logging (with Delete the Logs) and Requests to Proton each in a card of their own, instead of one long dashed box.
- Updating: `git am` the patch, `npm run check`, build.

## 0.48.0 (Tobi's wishes)
- **Calendars can be ticked and unticked while an account syncs.** Ticking one used to wait until its sync — and everything queued before it — was done, and the window locked all switches meanwhile. Now the tick is saved at once and its sync is queued; unticking takes the calendar out of Calendar.app at once and clears its local copy once a running sync of it has ended. Only the switch just clicked waits, and only for the save.
- **New accounts in Calendar.app: Reminders.** A configuration profile has no setting to turn Reminders off (Apple's CalDAV payload has no such key). Instead the bridge now tells Calendar.app what the account offers: its calendar home answers `supported-calendar-component-sets` (which Calendar.app asks for) with events only — no task lists. To check on the Mac: whether macOS then leaves Reminders off for a newly added account (and stops asking for its task list). Accounts already set up keep their setting: turn Reminders off in System Settings → Internet Accounts.
- Updating: `git am` the patch, `npm run check`, build.

## 0.47.0 (Tobi's decision)
- **"Sign In with Proton" is out of the app**, parked in a private side repository (`neutron-proton-page-sign-in`) with a patch that brings it back. Proton's page handed the bridge a session for Proton's web calendar, so the bridge then spoke to Proton as Proton's own apps — not allowed for other apps by Proton's rules, and a developer option only since 0.45. Should Proton offer third-party apps a sign-in through its page, it can come back from there.
- Removed: the library's session fork (`src/fork-sign-in.ts`, `consumeFork`, `signInWithProtonFork`, the calendar web app's version string and its check in `refresh:proton`), the app's sign-in window (`proton-sign-in-window.ts`), the developer option "Offer Sign In with Proton", the button and its texts, their tests and the window harnesses (also in CI), and the old sign-in screenshot.
- Accounts signed in through Proton's page keep their saved session until Proton ends it (it resumes like any other); then the bridge says so and you sign in with the form. The test for that ("no password kept: told to sign in again, nothing retried") now covers the bridge's own sign-in, which keeps no password either.
- Updating: `git am` the patch, `npm install` (the library's files changed), `npm run check`, build.

## 0.46.0 (Tobi's wish)
- **Every account is in the menu-bar menu right from the start**, with what it is doing, instead of only once all of them have signed in and synced. A line under the address says what is going on when that is not plain sailing: "Connecting to Proton…", "Verification Needed — Open the Bridge", "No Connection — Trying Again", "Proton Asked to Slow Down", "Signed Out — Sign In on the Setup Page", "Not Working — See Overview", "Needs Attention — See Calendars", "A Calendar Fails — See Calendars" (a click opens the page).
- **Blue means: nothing verified yet, nothing wrong either.** An account is blue while it signs in and during its first sync after the app started (the sync symbol turns in blue, in the menu and in the app), and turns green as soon as that went through — each account on its own, so the first one done is green while the other one still syncs. Yellow (something did not go right) and red (something fails) win over blue.
- **The top line of the menu shows the connection to Proton**, not how the accounts are doing: green as soon as one account is signed in and Proton answers; blue while connecting (after the app starts); yellow when Proton asked to slow down (it answers, but syncing waits); red with no connection, or when no account is signed in ("No Connection", "Signed out", "Not Connected"). An account with trouble no longer turns it yellow or red: its own line shows that.
- Icons: `status-connecting` and `account-connecting` are blue now, the yellow status dot moved to `status-warning`; a blue set of spinner frames (`spinner-initial/`) and `account-syncing-initial.png` (all made by `scripts/make-spinner-frames.py`; the green and yellow ones are unchanged). The native module is unchanged (it has the named sets since 0.45.3).
- Updating: `git am` the patch, `npm run check`, build.

## 0.45.6 (Tobi's wish, from the 0.45.5 test)
- **Subscribed, holiday and view-only calendars can really be deleted in Calendar.app now** (which unticks them here; tick them again on the Calendars page). Tested on the Mac with 0.45.5's switch: Calendar.app only sends the DELETE for a calendar whose properties it may change (DAV:write-properties), so read-only calendars now grant that too, besides 0.45.4's DAV:unbind.
- With it, Calendar.app can also rename and recolour such calendars. Proton keeps name and colour per member, so this changes them for you only, as in Proton Calendar. Their events stay read-only (no write, write-content or bind).
- The switch `NEUTRON_READ_ONLY_PRIVILEGES` stays for trying things out; without it the default is `unbind,write-properties`.
- Updating: `git am` the patch, `npm run check`, build.

## 0.45.5 (experiment, for 0.45.4's open point)
- 0.45.4 did not help: the log shows Calendar.app never sends the DELETE for a read-only calendar (only for your own ones), so it wants a permission other than DAV:unbind before it does. To find out which one without a new build per guess, the extra permissions of read-only calendars can be set when starting the app: `NEUTRON_READ_ONLY_PRIVILEGES="unbind,write-properties"` (comma-separated; read is always granted; known names: write, write-properties, write-content, bind, unbind, all). Without it, nothing changes from 0.45.4. `bridge.log` notes the set in use once.
- Updating: `git am` the patch, `npm run check`, build.

## 0.45.4 (Tobi's wish)
- **Subscribed, holiday and view-only calendars can be deleted in Calendar.app too** — which, as for your own calendars since 0.37, only unticks them here (nothing is removed in Proton; tick them again on the Calendars page). Calendar.app asked "really delete?" and then did nothing: it only deletes a calendar the server marks as removable (DAV:unbind), which read-only calendars were not. Their events stay read-only (still no write permission).
- To check on the Mac: Calendar.app should still not offer to change or delete single events of such a calendar (if it does, the bridge refuses as before).
- Updating: `git am` the patch, `npm run check`, build.

## 0.45.3 (Tobi's wish, to test on the Mac)
- **Each line of the menu-bar menu turns in its own colour.** The native module (`native/menu-spinner`) takes named sets of frames (`setFrames(frames, interval, 'warning')`) and, per turning line, the set it uses (`setSpinning(indexes, sets)`): with two accounts syncing at once, the one that needs attention turns yellow and the other green (0.45.2 turned both yellow). All lines still turn in step. Backwards compatible: a module built before this ignores the names and turns every line green; a failed build leaves the symbol still, as before.
- Not compiled outside the Mac (Objective-C++): `npm run build:native` on the Mac is the test.
- Updating: `git am` the patch, `npm run build:native`, `npm run check`, build.

## 0.45.2 (Tobi's wish)
- **Syncing while something needs attention shows as such.** A calendar or account with a yellow status that syncs now shows the turning sync symbol in yellow (in the app: the calendar's sync control, its group's, the account's symbol in the side panel and on its card; in the menu-bar menu: the account's line) — before, the yellow ring stayed until the sync ended (and in the menu the yellow won over the sync symbol). Red still wins, green turns green.
- Menu: a second set of spinner frames in yellow (`resources/icons/menu/spinner-warning/`, and `account-syncing-warning.png`), made by `scripts/make-spinner-frames.py`; the app switches the native module to the yellow frames while a yellow line turns (the module turns all lines with one set, so with two accounts syncing at once and one of them yellow, both turn yellow). The native module is unchanged.
- Updating: `git am` the patch, `npm run check`, build.

## 0.45.1 (Tobi's wish)
- **Signing in looks inviting, not like a warning.** While an account is signing in (until it is in, or Proton refuses), its status shows "Signing In" in light blue instead of a yellow "Connecting", on the sign-in page and on its card; the CAPTCHA and authenticator-code cards are light blue too (yellow stays for what is not right: refusals, warnings). Light and dark mode.
- Updating: `git am` the patch, `npm run check`, build.

## 0.45.0 (patch 45 — stage 16, part 3: signing in under its own name by default)
- **The bridge's own sign-in is the regular way, under its own name.** The Setup page asks for your Proton address and password and signs in as Neutron Calendar Bridge (x-pm-appversion "Other", User-Agent `NeutronCalendarBridge/<version>`), no longer as Proton's iOS Mail app. Proton shows a CAPTCHA at such a sign-in (in a window of Proton's own page), then asks for the authenticator code or mailbox password if the account has one. Tested on Tobi's real account with 0.44: calendars, events, meetings, answers, Proton Meet all work.
- **The password is not kept** after such a sign-in: Proton asks for a CAPTCHA at every password sign-in, so the bridge could not sign in again by itself anyway. The session is kept (encrypted) and renewed as before; if Proton ends it, you are asked to sign in again ("Proton ended the session. Sign in again on the Setup page.").
- **Sign In with Proton** (Proton's own page, 0.28) is now a developer option ("Offer Sign In with Proton"), with the reason: its session is one for Proton's web calendar, so the bridge speaks to Proton as Proton's own apps, which Proton's rules do not allow other apps. The developer options "Offer the password form" and "Sign in with the app's own identity (test)" are gone (the form is always there, and always uses the bridge's own name).
- Accounts signed in with an earlier version keep their session (and its identity) until they sign in again; sign out and in to move one to the bridge's own name.
- Automated test runs: `NEUTRON_SIGN_IN_IDENTITY=ios-mail` keeps the old identity (and the kept password) for the bridge's sign-in; the weekly live workflow sets it for the bridge's two-account run, as it cannot solve a CAPTCHA (to be decided: see roadmap, stage 16). The library's live scenarios sign in as before.
- README: sign-in and Setup sections rewritten. The sign-in screenshot still shows Sign In with Proton.
- Updating: `git am` the patch, `npm run check`, build.

## 0.44.2 (Tobi's report)
- **Removing an invitation the organizer had just cancelled was refused.** Calendar.app saves a "declined" copy of a cancelled invitation before it deletes it. 0.40.3 takes that save as it is, but only when the bridge already knows of the cancellation; right after the organizer cancelled (before the next sync), the save went to Proton as an answer, Proton said "cancelled, nothing to answer", and Calendar.app got a refusal (403) and never sent the delete (it retried the save). Now that answer is taken as it is too: nothing is sent or written, the invitation is read again (served as cancelled), and the delete that follows removes it. The library reports this case with its own reason ('cancelled').
- Updating: `git am` the patch, `npm run check`, build.

## 0.44.1 (from Tobi's tests of 0.44.0)
- **A meeting renamed soon after it was made no longer vanishes from Calendar.app.** After saving a change to a meeting, the bridge reads it back from Proton by its UID; when that found nothing, the event was marked deleted here — Calendar.app dropped it until the next sync pass brought it back (Proton had it all along). A meeting made in Calendar.app has another UID in Proton, which the bridge only learned at the next pass. Now Proton's UID is kept from the moment the meeting is made, and a lookup that finds nothing no longer deletes anything: the calendar's changes (matched by Proton's event ID) decide, which also notices a real deletion. After a deletion or cancellation the bridge's own change, it is removed at once as before; a series with a video link deleted in Proton meanwhile is still refused as outdated. bridge.log says when a lookup missed ("re-read of … after a change: Proton listed 0 event(s) by its … UID").
- **Sign-in with Proton's CAPTCHA:** the verification window opens at once with "Loading Proton's verification…" (it stayed hidden until Proton's page had loaded, which looked as if nothing happened); Proton asking for verification no longer shows as a red error ("Error invoking remote method …") next to the panel that explains it.
- The same miss in a sync pass from Proton's change feed (a change reported, the lookup by UID empty) no longer deletes either; a deletion the feed reports still does.
- Reviewed by a separate agent; fixed from it: a waiting (outbox) change to a series with a video link deleted in Proton meanwhile is refused at its replay instead of written anew (that would invite everyone again); "removed at once" only when the change removed this event itself (not when a series save deleted a changed occurrence); the verification window closed while loading no longer throws. Left as it is: a calendar never listed with the change feed is listed in full in this rare case.
- Under the app's own identity (0.44.0) everything worked in Tobi's test on his real account: sign-in with CAPTCHA and authenticator code, resuming after a restart, calendars, a calendar made, recoloured, renamed and deleted from Calendar.app, events, a meeting with invitation, answer, update and Proton Meet room.
- Updating: `git am` the patch, `npm run check`, build.

## 0.44.0 (patch 44 — stage 16, part 2: the app's own identity, as a test)
- **Developer option "Sign in with the app's own identity (test)"** (under "Offer the password form"): the password form then signs in as Neutron Calendar Bridge — x-pm-appversion `Other` (Proton has no product name for a third-party calendar client: `external-calendar-…` is refused) and the User-Agent `NeutronCalendarBridge/<version> (macOS; …)` — instead of as Proton's iOS Mail app. The sign-in is then the plain one: no anonymous session first (Proton refuses it to third-party names) and no iOS device fingerprint. Proton asks for a CAPTCHA (the existing verification window shows it); two-factor codes and a separate mailbox password work as before.
- The account keeps the identity it signed in with: the saved session records it, and renewals and every request use it, also after the option is turned off. Accounts signed in before (or through Sign In with Proton) are unchanged. bridge.log says "signed in under the app's own identity (Other)".
- Library: `Credentials.appIdentity` (the identity for sign-in, renewal and API calls; the plain sign-in with it). New offline test `app-identity-test`.
- Purpose: to find out with a test account whether Proton's calendar API works under an honest identity, before the repository goes public. Proton has not confirmed it accepts this.

## 0.43.0 (patch 43 — stage 16, part 1: signed builds)
- **Signed and notarized builds**: `npm run package:mac:release` signs the app with a Developer ID (hardened runtime), has Apple notarize it and staples the ticket, does the same for the DMG, and checks the result as Gatekeeper does (signature, Developer ID, hardened runtime, Gatekeeper's verdict, stapled tickets). The certificate and the notarization password stay in the Keychain (README → Signed builds); nothing secret is in the repository or printed.
- **Own entitlements** (`resources/entitlements.mac.plist`): only what Electron's JavaScript engine needs under the hardened runtime. electron-builder's default also turned off library validation; it stays on, since every native module (SQLCipher, the menu spinner) is signed with the same certificate.
- `npm run package:mac` and the CI build stay unsigned as before.
- Updating from an unsigned build: macOS asks once more for the Keychain item "neutron-calendar-bridge Safe Storage" (a differently signed app) — **Always Allow**. Data, saved logins and Calendar.app accounts carry over.

## 0.42.2 (from the C4 check on the Mac)
- **A new calendar colour no longer snaps back to the old one.** Proton only takes its own 20 colours, so the bridge uses the one closest to what Calendar.app sends. When that was the calendar's colour already (Calendar.app's yellow on an orange calendar), the colour came back as before at the next sync. Now the next closest Proton colour is taken (yellow → Proton's olive yellow), so a colour change in Calendar.app always changes the colour; a colour (nearly) the same as the calendar's own keeps it.
- Updating: `git am` the patch, `npm run check`, build.

## 0.42.1 (from the C4 check on the Mac)
- **Calendar.app stopped refreshing an account after a calendar was renamed with Wi-Fi off** ("The request for account … failed", even after a restart, until it sent the change once more). The connection to Proton timed out instead of failing at once, so the bridge only put the change in the outbox after 27 seconds; Calendar.app had given up on the request by then, kept the change as unsent and refused to refresh the account until it got it through. A rename or recolour now waits at most 5 seconds for Proton, then goes to the outbox and Calendar.app gets its answer (if the slow request still reaches Proton, the outbox sends the same values once more, after it).
- While the bridge already knows Proton cannot be reached (its 15-second connection watch runs), saves, deletions and calendar changes from Calendar.app go straight to the outbox, without first waiting for a connection that would time out.
- Updating: `git am` the patch, `npm run check`, build.

## 0.42.0 (patch 42 — robustness)
- **Renaming or recolouring a calendar while Proton cannot be reached** (or during a slow-down) waits in the outbox like event changes: Calendar.app shows the new name or colour at once (before: refused, the old name stayed), sync passes keep it while it waits, and it goes out when Proton answers again (several changes of the same calendar as one). Refused then, the calendar shows Proton's name again and the Overview says why.
- **An event a slow-down left in Proton without guests** (the first step of a new meeting, 0.23) is saved with the account's settings until it is removed; before, it was only remembered while the app ran, and quitting during the pause left it in Proton for good. It is removed at the first sync Proton allows, after a restart too, and only for the account that left it; while Proton cannot be reached yet (a Mac just woken) it stays saved.
- README: how to remove Time Machine backups and local snapshots from before 0.24, which still hold the unencrypted local copy.
- Reviewed by a separate agent (fixed from it: a leftover forgotten when Proton could not be reached; calendar changes arriving close together keep their order).
- PROPPATCH stays property by property (not all-or-nothing as RFC 4918 wants): Calendar.app sends one property at a time; kept as decided.
- Updating: apply 0.41.10 first if not done, then `git am` the patch, `npm run check`, build.

## 0.41.10 (from the 0.41 checks on the Mac)
- **A guest's note shows on the Overview without the developer option.** The note with an emailed answer ("Running late") was only shown when the bridge applied the answer itself (developer option); usually Proton records the answer, and the bridge's tidying of the Inbox only left the email there with the reason. That step now passes the note on: the Overview's Invitation Emails list shows it ("Note — … ← guest", "Note from …: …"), bridge.log has it as private.
- Updating: `git am` the patch, `npm run check`, build.

## 0.41.9 (Tobi's report)
- **Alerts still piled up on the guest's side when the organizer renamed a meeting.** 0.41.8 built each served alert's ID from its whole content, and an email alert carries the event's title — a new title gave every email alert a new ID, which Calendar.app took for a new alert next to the old one. The ID now comes only from the event, the alert's place, its kind and its time.
- Updating: `git am` the patch, `npm run check`, build. Remove the extra alerts once more on the guest's side (Calendar.app keeps those it has).

## 0.41.8 (Tobi's report)
- **No more alerts piling up.** Editing an invitation again and again left more and more identical alerts on it (up to Proton's ten). The alerts the bridge served had no ID of their own; Calendar.app matches alerts by their ID, kept its own copy of an invitation's alert next to the one served again, and sent them all back. Every served alert now has a stable ID (UID / X-WR-ALARMUID, as Apple writes them), and alerts that mean the same ("15 minutes before", however the time is written) are saved once.
- Updating: `git am` the patch, `npm run check`, build. An event that already has extra alerts: remove them in Calendar.app once (keep the one you want) and save.

## 0.41.7 (Tobi's report)
- **No join block flashing in the notes.** Right after a link was made, Calendar.app showed Proton's join block in the notes for a few seconds, until the next sync. The version just written to Proton (block included, for guests) was kept as Calendar.app's copy until then; it is now kept without the block, as every later version is served (0.41.1).
- Updating: `git am` the patch, `npm run check`, build.

## 0.41.6 (from Tobi's bridge.log)
- bridge.log showed why taking a link off did nothing: the stored place did not count as the link, while Calendar.app's copy still carried the link's conference fields — so the bridge kept the link and, for "Proton Meet" typed again, saw no need for a room.
- **The place counts as the link by its room:** the same link up to escaping, the `#pwd-…` part (Proton keeps the password apart), a query, a trailing slash or letter case, or a web address naming the room. 
- **"Proton Meet" on an event that has a link** puts that link back as the place (no second room), instead of leaving the words with the link hidden behind them; Calendar.app fetches the result at once.
- The bridge.log line now tells the kinds apart: empty, the link, the link (other spelling), a request for a room, another web address, text — for the new place and the stored one (still nothing of the content).
- Updating: `git am` the patch, `npm run check`, build.

## 0.41.5 (Tobi's report)
- **Taking a link off, again:** on a meeting it still went unnoticed on the Mac (no trace in bridge.log), although the same steps work in the tests. "The place is the link" is now decided by the room the place names (the link's ID), not by exact text, so another spelling of the link (escaping, spaces) no longer hides a change. And every save of an event with a link writes one line to bridge.log with what the decision was based on — the kind of place (empty, the link, a request for a room, something else), whether the stored place is the link, and whether Calendar.app's copy carries the conference fields — without any of the event's content, so a case that still goes wrong can be told from the log.
- Updating: `git am` the patch, `npm run check`, build.

## 0.41.4 (Tobi's report)
- **Taking a link off works when Calendar.app keeps Proton's conference fields.** Clearing the location (or replacing the link) counted as "take the link off" only if Calendar.app's copy no longer had Proton's hidden conference fields; Calendar.app keeps them (seen with a meeting), so the link stayed on the event in Proton and "Proton Meet" typed again made no new room. Now the location alone decides: it was the link and no longer is → the link comes off (fields that name the same link do not count). Fields left over in a copy Calendar.app has not refreshed since the link went are not written back either (they would bring the deleted room back).
- Updating: `git am` the patch, `npm run check`, build.

## 0.41.3 (Tobi's report)
- **A new video link shows in Calendar.app at once.** After "Proton Meet" became a link, the bridge answered the save with the event's version tag (ETag) as if Calendar.app's copy were current, so Calendar.app kept showing "Proton Meet" until a later sync changed the tag — the link seemed not to be made. The reply now leaves the tag out whenever the bridge changed the event on the way (a link made or taken off), and Calendar.app fetches the saved version right away.
- Updating: `git am` the patch, `npm run check`, build.

## 0.41.2 (Tobi's report)
- **"Proton Meet" works again after a link was taken off.** The bridge remembers a room it made for a save, so a save Calendar.app sends again after a refusal does not make a second room. That memory was also used after the link had been taken off (in Calendar.app or in Proton Calendar, which deletes the room with it), so typing "Proton Meet" again gave the old, deleted room or nothing. The memory now ends once the save with the room went through, and when the link is taken off.
- Updating: `git am` the patch, `npm run check`, build.

## 0.41.1 (from the 0.41.0 checks on the Mac)
- **Notes without Proton's join block.** An event with a video link showed Proton's block — the separator line, "Join Proton Meet: …", the separator again — in Calendar.app's notes (Proton Calendar hides it and shows its conference box), and it stayed there when the link was taken off. Calendar.app now gets the notes without the block (the location is the link); while the event keeps its link the bridge puts the block back on the way to Proton, so guests' emails and Proton Calendar are as before, and an alert-only change to a meeting still emails nobody (the block does not count as a change). A notes text you wrote yourself is left as it is.
- Updating: `git am` the patch, `npm run check`, build. Calendar.app shows the cleaned notes after its next refresh.

## 0.41.0 (patch 41 — video links, invitations, mailbox)
- **A video link taken off in Proton Calendar stays off.** Editing a repeating event in Calendar.app before the bridge had seen the removal sent the link back with the series (Calendar.app's copy and the local one still had it). A series with a link is now read again from Proton before it is written (one request, only for such series); if the link is gone, Calendar.app's copy loses it too (the place that was the link, Proton's block in the notes), and the rest of the change goes through. A series deleted in Proton meanwhile is refused as outdated instead of being created again.
- **Outdated copies while changes wait:** the check before a change joins the outbox (0.40) now has the same leeway as a live save — a copy older only in what Proton does not store, or (meetings you organize) only in guests' answers, still counts — and meetings get the meeting's wording.
- **Mailbox** (developer option "Apply answers that guests outside Proton send by email"): a reply in Spam is used when it answers an invitation this account sent (In-Reply-To / References name that email; the bridge remembers the Message-IDs of the invitations it sends, per account, 90 days); every six hours the last week is looked through again, so a reply moved out of Spam later is picked up; a guest's note with the answer (COMMENT; Google's X-RESPONSE-COMMENT) is shown with it on the Overview (and in bridge.log as private). The extra passes never move the mailbox cursor, have their own page budget and continue where they got to.
- **Emails after a slow-down:** when Proton asks to slow down while a change is being emailed, after the first email went out, the change is saved and the emails to the remaining guests wait (the Overview says how many); they are sent at the first sync after the pause. A newer change of the meeting that emails those guests replaces them; a change not saved in Proton takes them back; an email that may already have gone out (a dropped connection) is reported, not sent twice; one waiting longer than a day is reported as not sent (notification). They are kept in memory only (a restart reports nothing more for them).
- Library and bridge: new `withoutLocation` (bridge), `answersOneOf`, `replyCommentOf`, `sendDeferredEmails`, `commitDeferredEmails`, `deferredEmailCount`; `EmailedAnswer.comment`; `applyEmailedAnswers` input `repliesTo`, `lookBackFrom`. Reviewed by a separate agent in two rounds (fixed from it: waiting emails dropped too early or kept for unsaved changes, the replaced version after the re-read, a deleted series created anew, Spam checks hiding later moves, temporary errors giving emails up, a queue race, a look-back that could never finish, a possible double send).
- Updating: apply 0.40.4 first if not done, then `git am` the patch, `npm run check`, build.

## 0.40.4 (Tobi's report)
- **An invitee from your other account is shown by name.** Inviting your second account's address to a meeting made in the first, Calendar.app showed the invitee as "neutron-<id>": it recognises the address as one of its own accounts and shows that account's CalDAV principal, which the bridge named after its user name. The principal is now named after the account: Proton's display name of its first address, else the address (the user name only while signed out).
- Updating: `git am` the patch, `npm run check`, build. Calendar.app picks up the new name when it next refreshes the account (or after a restart of Calendar.app).

## 0.40.3 (Tobi's report)
- **Deleting a meeting the organizer cancelled** (shown greyed out and struck through) was refused with "You were invited to this event, so only its organizer can change it". Calendar.app saves a changed copy (your answer) before it sends the delete, and that save was refused, so the delete never came. For a cancelled invitation Proton Calendar offers only Delete, so such a save is now taken as it is, with nothing written; the delete that follows removes the meeting, without emailing the organizer.
- bridge.log: a refused change of an invitation logs the shape of both versions (dates, status, number of guests; no text), so the next case can be told apart.
- Updating: `git am` the patch, `npm run check`, build.

## 0.40.2 (from the 0.40.0 checks on the Mac)
- **An alert on one occurrence of a series you organize** was dropped without a word: Calendar.app showed it, the bridge accepted the save, and the next sync took it away. The library makes no event of its own for an occurrence when nothing guests see changed, and Proton keeps the reminders of a series for all its events unless the occurrence is an event of its own, so there was nothing to put the alert on. Such a save is now refused with that reason, as 0.40.0 does for invitation series. An occurrence that really is changed (moved, retitled) still gets its own alert.
- bridge.log: the warning about occurrences that keep the series' reminders also says what kind of save it was.
- Updating: `git am` the patch, `npm run check`, build.

## 0.40.1 (from the 0.40.0 checks on the Mac)
- **Time zones by the names Proton accepts.** Changing an event's or a meeting's time zone in Calendar.app could be refused with "Invalid event data (Invalid timezone)": macOS still writes several zones by their old names (Asia/Calcutta, Asia/Saigon, America/Buenos_Aires …) or by new ones Proton does not list yet (Europe/Kyiv), and Proton's API takes only the names on its list. Every time the bridge writes — start, end, occurrence, excluded dates; plain events, series and meetings — is now given in the name Proton accepts, as Proton's web app does (Asia/Calcutta → Asia/Kolkata); zones on Proton's list are kept as they are (Europe/Amsterdam stays). The instant never changes; Calendar.app then shows Proton's name for the zone.
- Library: `supportedTzid`, `withSupportedZones`; offline test `test:zones`.
- Updating: `git am` the patch, `npm run check`, build.

## 0.40.0 (patch 40 — sync edge cases)
- **Time-zone-only moves are saved.** Moving an event to another time zone at the same instant (Calendar.app's time-zone field) was taken for "unchanged" and never reached Proton; now the zone is compared too. For a meeting it is saved like in Proton Calendar: no update email, guests' answers kept (Proton counts it as the same time).
- **Events with DURATION instead of an end** (some calendar apps write them so) are saved with their end: series, meetings and invitations now too (plain events already were), and availability no longer counts the occurrences of such a series as zero-length. Weeks and days count on the wall clock, hours and minutes as elapsed time (RFC 5545), across DST changes; an end in the hour that occurs twice when the clocks go back is written in UTC.
- **Availability:** events you answered Maybe, and tentative events, are answered as *tentatively busy* (FBTYPE=BUSY-TENTATIVE) rather than busy; where they overlap a busy time, busy wins.
- **Series that ended long ago stay out.** A series limited by a number of occurrences (COUNT) whose last occurrence was before the sync window could appear after a change in Proton; its end is now worked out, the same way in every sync pass (a series with a changed occurrence inside the window keeps its master).
- **Changes during a slow-down wait in the outbox** like offline changes (0.35) instead of being refused, and go out after the pause. Only a write already under way when Proton asks to slow down is told to wait, as before; a refused app version stays a refusal. A save from an outdated copy (Calendar.app's If-Match not the current version) is refused at once rather than kept to overwrite a newer version later — this also closes that gap for offline changes.
- **An alert on one occurrence of an invitation series** — which Proton Calendar does not allow (it offers "all events" only, unless the organizer changed that occurrence) — is refused with that reason instead of "only its organizer can change it".
- Library: `withDtendFromDuration`, `seriesLastEndOf`; `BusyPeriod.tentative`; reviewed by a separate agent (fixed from it: the outdated-copy check, the same COUNT rule for the full pass, an iterator that cannot walk a rule no longer ends a series, the ambiguous end hour, an app-version refusal kept through a later slow-down).
- Updating: `git am` the patch, `npm run check`, build.

## 0.39.0 (patch 39 — several accounts, loose ends)
- **Web Calendar per account.** Each account's block in the menu-bar menu has its own Web Calendar under Refresh Now: it opens Proton Calendar in the browser for that address (Proton's account page picks the browser's session with that address; if the browser has none, Proton shows its account chooser or sign-in). With one account the entry keeps ⌘W; the separate Web Calendar section is shown only while no account is signed in. View → Web Calendar opens the first account's, Help → Proton Calendar on the Web the plain one.
- **Setup page:** the step says which Calendar.app account to look for — "Proton (address)" with several accounts, "Proton" with one — instead of always "Proton".
- **Account order kept:** every write of the account list also goes to `accounts.json.bak`; if `accounts.json` is lost or damaged, the list is rebuilt in that order (before, in the folders' order), and an account missing from the copy joins at the end.
- Updating: `git am` the patch, `npm run check`, build.

## 0.38.3 (Tobi's request)
- Developer option **Offer the password form on the sign-in page** (Settings → Developer Options; off by default, in force only while developer options are on): the bridge's own sign-in — password, authenticator code, mailbox password handled by the bridge — shows beside Sign In with Proton again, for testing.
- Updating: `git am` the patch, `npm run check`, build.

## 0.38.2 (Tobi's requests)
- Sign-in page: only **Sign In with Proton**. The link "Or sign in with your password here" and the password form are gone from the page (the form stays in the code as the fallback for a library without the Proton-page sign-in); the subtitle says that the password stays with Proton.
- "Add Account", then the window closed without adding one: the next opening showed the sign-in page again until a restart. Closing the window now cancels adding (Proton's page, if open, is closed too), and the window opens on the accounts next time.
- Updating: `git am` the patch, `npm run check`, build.

## 0.38.1 (Tobi's request)
- Sign in with Proton: Proton's page opens in the app's appearance — dark when the app is dark, light when light, the Mac's when "Same as macOS" — instead of always light. (Proton's page keeps its theme in a cookie that the sign-in window's throwaway session never had; the bridge now plants it with Proton's "automatic" mode before the page loads, so the page follows the window's colour scheme. The switch at the top right of the page still works for that sign-in.)
- Updating: `git apply` the patch, `npm run check`, build.

## 0.38.0 (stage 14 — one repository, one name)
- **One repository.** The library `proton-calendar-client` lives in `client/` of this repository (its history included) as an npm workspace: one `npm install` at the top installs and builds both, one `package-lock.json` covers both, `npm ci` installs exactly those versions. `npm run check` finds the library in `client/`; the library's refresh routine looks for a WebClients checkout beside the repository.
- **One name.** The repository is `neutron-calendar-bridge`, like the package, the data folder (`~/Library/Application Support/neutron-calendar-bridge`), the log folder (`~/Library/Logs/neutron-calendar-bridge`) and the Keychain item ("neutron-calendar-bridge Safe Storage"). The bundle identifier is `io.github.to-bi-s.neutron-calendar-bridge` (was upstream's `com.proton.calendar.sync`), the Calendar.app profile identity `io.github.to-bi-s.neutron-calendar-bridge.calendar-app.<account>`. Every account is alike now: its CalDAV user name is `neutron-<id>` (was `proton-<id>`) and its Calendar.app account is named "Proton (address)"; the special handling of a first account from before 0.36 is gone, as is the move of data folders from an earlier name.
- **Fresh start on this Mac.** An installation of 0.37 or older is not carried over (another bundle identifier, another data folder): quit the old app, remove its Calendar.app profiles, install this one, sign in again and run Set Up Calendar.app for each account; then delete the old data folder, log folder and Keychain item.
- README: one for the repository ("Building from source", "Setting up Calendar.app", the library's own README in `client/`); fork, maintainer and upstream credits in both; `repository` URLs in both `package.json`; the packaged app carries the copyright line (original work Tactless Autist, modifications Tobi, GPL-3.0-only) in its Info.plist.

## 0.37.17 (patch 13p — Tobi's requests)
- Setup page: the card is labelled "Auto Setup for Calendar.app" (was "Calendar.app"), in all six languages.
- Calendars page: a little space between the title and the account's address below it (the address sat on the title).
- Updating: `git apply` the app patch, `npm run check`, build.

## 0.37.16 (patch 13o — stage 13 findings)
- Calendars page: the switches keep the keyboard focus. Toggling one (click or Space) disabled the rows while the change was saved and rebuilt them afterwards, which dropped the focus — a second Space did nothing. The focus now returns to the same switch, also when the list is rebuilt by a sync, and the rows are always rebuilt after a save (before, a failed save could leave them disabled).
- Updating: `git apply` the app patch, `npm run check`, build.

## 0.37.15 (patch 13n — stage 13 findings)
- Menu-bar menu: with several accounts syncing at once, every syncing account's symbol turns — before, only the first one did and the others showed a still symbol (the native module turned one item). They turn in step, like one symbol.
- Updating: `git apply` the app patch, `npm run check` (rebuilds the native module), build.

## 0.37.14 (patch 13m — stage 13 findings)
- Video links: when Zoom is not in the plan or not connected, the refusal is answered to Calendar.app as a refusal (403, like the bridge's other refusals) instead of a server error (500); Calendar.app shows the same message either way, but no longer takes it for a failure of the bridge. A failure to reach Proton stays a server error.
- Updating: `git apply` the app patch, `npm run check`, build.

## 0.37.13 (patch 13l — the drawn Refresh Now rows: keyboard and VoiceOver)
- The Refresh Now rows the native module draws (0.37.12) behave like native items for the keyboard and for VoiceOver too: Return, Enter and Space press a highlighted row; VoiceOver reads it as a menu item with its title, its state and its ⌘R, and VO-Space presses it. (⌘R itself never depended on the drawing — the key equivalent stays on the item.)
- Updating: `git apply` the app patch, `npm run check` (rebuilds the native module), build.

## 0.37.12 (patch 13k — Tobi's request, second take)
- Menu-bar menu: Refresh Now keeps the menu open without the close-and-reopen of 0.37.11. The native menu module now draws the Refresh Now rows itself — an item with its own view is the one thing macOS does not dismiss on a click — with the system's selection highlight, the sync symbol, the title and ⌘R where it applies; the click blinks like a native item and starts the refresh, the menu stays and the symbol turns in it. Row geometry can be tried out with `NEUTRON_MENU_ROW="rowHeight=22,textX=36,…"` (row height, image and text position, key-equivalent inset, highlight insets and corner radius) until it matches macOS's own rows. Without the module (other platforms) the menu closes as before.
- Updating: `git apply` the app patch, `npm run check` (rebuilds the native module), build.

## 0.37.11 (patch 13j — Tobi's request)
- Menu-bar menu: Refresh Now (of any account) no longer takes the menu away — macOS closes a native menu on every click, so the bridge opens it again right after the click, with the sync symbol turning on the account's line. All other items close the menu as before.
- Updating: `git apply` the app patch, `npm run check`, build.

## 0.37.10 (patch 13i — Tobi's app icon, revised)
- App icon: Tobi's revised artwork (`resources/icons/app-icon.png`), as `app-icon.icns` (the artwork as it is) and `app-icon-tahoe.icns` (the plate full-bleed for macOS 26), the 0.32.5 recipe.
- Updating: `git apply` the app patch (the patch carries the two `.icns` files; `app-icon.png` is Tobi's own copy), `npm run check`, `npm run package:mac`; a changed icon shows in Finder and the Dock after the install — Notification Center may keep the previous one until a restart (see the stage 13 notes).

## 0.37.9 (patch 13h — stage 13 findings)
- Setup page: the Calendar.app card stayed "Connected" after the account had been removed from Calendar.app — for the rest of the bridge's run, because a request seen at any time during the run counted as connected. Now only the last 3 hours count (Calendar.app refreshes every few minutes while the account exists); after that the card says "Quiet" with the time of the last request, in this run or not.
- Updating: `git apply` the app patch, `npm run check`, build.

## 0.37.8 (patch 13g — stage 13 findings)
- Calendar management: Calendar.app sends a calendar's name, colour and description back after every edit and right after creating a calendar — mostly unchanged. The bridge wrote each of these to Proton (two requests per PROPPATCH); now it writes only what differs from what it serves.
- A calendar without a description was served with its name as the description, which Calendar.app then sent back — so a calendar created in Calendar.app ended up with its own name as its description in Proton. The description is served as it is (empty when there is none).
- Updating: `git apply` the app patch, `npm run check`, build.

## 0.37.7 (patch 13f — stage 13 findings)
- **Availability in Calendar.app.** When the Availability panel opens, Calendar.app asks every calendar whether its events count towards availability (`schedule-calendar-transp`, RFC 6638) and the principal for its email addresses (`email-address-set`); the bridge answered neither, and the panel said "This calendar does not support availability" without ever asking for anyone's busy times. Both are answered now: own and shared calendars count, holiday and subscribed calendars do not (as in Proton Calendar), and the addresses are the account's. The old form of the same list (`calendar-free-busy-set`) is on the calendar home and the scheduling inbox too.
- **"Events affect availability"** (Calendar.app → calendar → Get Info) is stored per calendar and honoured: a calendar switched off there is left out of your own busy times and served as transparent. Before, the switch was accepted and forgotten.
- Updating: `git apply` the app patch, `npm run check`, build; quit and reopen Calendar.app.

## 0.37.6 (patch 13e — stage 13 findings)
- Detailed logging (Settings → Developer Options): every PROPFIND from Calendar.app is followed by a `props:` line naming the properties it asked for (names only; a PROPFIND carries no values). For reading a client's feature detection off the log — first use: why Calendar.app's Availability panel says "This calendar does not support availability" although the bridge announces scheduling (0.37.5 did not change that).
- Updating: `git apply` the app patch, `npm run check`, build.

## 0.37.5 (patch 13d — stage 13 findings)
- Calendar.app's Availability panel said "This calendar does not support availability" for the bridge's accounts and never asked for anyone's busy times (0.33.2 was only ever tested with hand-made requests). Calendar.app looks for `calendar-schedule` — Apple's earlier scheduling draft, which defined the free/busy lookup through the outbox — in the server's DAV capabilities; the bridge announced only RFC 6638's `calendar-auto-schedule`. It now announces both, as iCloud and Google do. Nothing else changes: invitations stay with the bridge (implicit scheduling), and the outbox still refuses anything but a free/busy lookup.
- Updating: `git apply` the app patch, `npm run check`, build. Calendar.app reads a server's capabilities when it refreshes the account: quit and reopen Calendar.app after the update if the panel still says so.

## 0.37.4 (patch 13c — Tobi's review of the German and Dutch texts)
- Calendar.app is called by its localized name with the `.app` suffix in every language, like a proper name: Kalender.app (de), Agenda.app (nl), Calendrier.app (fr), Calendario.app (es, it) — instead of "Kalender-App", "Agenda-app", "l'app Calendrier", "la app Calendario", "l'app Calendario". 47–48 strings per language; the English catalog is unchanged.
- Updating: `git apply` the app patch, `npm run check`, build.

## 0.37.3 (patch 13b — stage 13 findings)
- When Proton ends a session (ended in Proton's Sessions settings, password changed) while the bridge is signed in, the bridge now reacts in the same pass: the first calendar whose sync is refused triggers the sign-in again (or "Sign in with Proton again on the Setup page"), the other calendars are not tried on the dead session, and the mailbox step waits. Before, each calendar logged its own error and the switch came with the next pass — up to five minutes later on a quiet account (since 0.26 a quiet pass skips the calendar listing, which was the only place the refusal was recognised). Found in the stage 13 Mac tests.
- Updating: `git apply` the app patch, `npm run check`, build.

## 0.37.2 (patch 13a — stage 13 findings)
- bridge.log: the CalDAV request lines said `auth=none` for every request from Calendar.app (they decoded Basic only; Calendar.app signs in with Digest). They now name the scheme — `auth=digest`, `auth=basic`, `auth=none` — and never the user name (an older Calendar.app account may sign in with an address).
- Updating: `git apply` the app patch, `npm run check`, build. Library patch 37c (`createCalendar` with an address — the client half of patch 37) if it is not in yet.

## 0.37.1 (patch 37b)
- Calendars page: the "Address for calendars created in Calendar.app" card sits at the bottom, under the calendars.
- Setup page: "Set Up Manually" is a plain card, always open (no more "Show the values").
- Updating: `git apply` the app patch, `npm run check`, build.

## 0.37.0 (calendar management, the rest — patch 37)
- **Deleting a calendar in Calendar.app takes it out of Calendar.app only.** The bridge unticks it (as on the Calendars page: no longer served, its local events dropped) and answers 204; the calendar stays in Proton with everything in it, and ticking it again on the Calendars page brings it back. A notification says so. Before, the deletion was refused with an error Calendar.app showed as "not permitted".
- **Address for calendars created in Calendar.app.** An account with several addresses gets a setting at the top of its Calendars page: which address owns a calendar made with File → New Calendar (its key, its invitations) — the first active one by default. Calendar.app cannot say which, so it is set here. Library: `createCalendar({ …, address? })` (an address that is not the account's is refused).
- Setup page: a hint to switch Reminders off for the bridge account in System Settings → Internet Accounts (Reminders keeps asking for a task list otherwise — refused since 0.35.1, harmless).
- Reviewed: only active addresses are offered and accepted; an address disabled in Proton later is let go of (the first active one owns the calendar, the setting is cleared, a log line says so); changes that waited for Proton in a calendar deleted in Calendar.app are dropped quietly (the notification says how many) instead of being reported as refused; the notification body names no calendar (the subtitle does, as elsewhere).
- Updating: `git apply` both patches, `npm install` in both folders, `npm run check`, build.

## 0.36.4 (patch 36e)
- **bridge.log names the account.** Every line from an account's service — sync passes, Calendar.app requests and their handling, notifications, outbox — starts with the account's tag, `[a:3f9a]` (the first four characters of its ID; the address is added only while detailed logging is on). The request lines end with `acct=a:3f9a`. Settings → Accounts shows each account's tag next to its name. Done without touching the log calls: each account's service runs inside its own context (Node's AsyncLocalStorage), which awaits, timers and callbacks inherit.
- Updating: `git apply` the app patch, `npm run check`, build.

## 0.36.3 (patch 36d)
- Info page: "This Fork" now lists what was added, in the order a visitor looks for it (meetings and invitations, repeating events, reminders, several accounts, one-click setup and Sign in with Proton, video links, calendar management, offline edits, privacy, light on Proton, languages and looks) — in six languages.
- Every checkbox in the window is a sliding switch like Proton's (Settings, the calendar rows); keyboard focus and disabled states kept.
- Updating: `git apply` the app patch, `npm run check`, build.

## 0.36.2 (patch 36c)
- `npm run check` no longer hangs on a Mac where the bridge is running: the accounts test listened on the bridge's own port (31876), failed with "address already in use" and, failing, never shut its services down. It uses a port of its own and shuts down whatever it started.
- Found by that test: an app-wide setting written before the first start's migration (e.g. by a test, or a future start-up path) dropped the account keys the old `config.json` still held. The app's settings file now leaves keys outside its scope untouched.
- Updating: `git apply` the app patch, `npm run check`, build.

## 0.36.1 (menu — patch 36b)
- Web Calendar is back in its own section above Quit Bridge, with ⌘W, once (Tobi, after 0.36: Proton's web calendar cannot be opened for a given account, so one entry per account made no sense). An account's block in the menu is its address and Refresh Now.
- Updating: `git apply` the app patch, `npm run check`, build.

## 0.36.0 (several accounts — stage 12, WP10; patch 36)
- **Several Proton accounts.** Settings → Accounts → Add Account opens the sign-in page you know (Proton's page or the password form) for another account; each account has its own Proton session, local copy, outbox, saved login, settings for its calendars and emails, and its own CalDAV principal under the same local server (user name `proton-<id>`, never the address: the path is in every log line), with its own Calendar.app account and profile ("Proton (address)"). Sign Out works as before — the session ends and the local copy is cleared, the account stays listed with its CalDAV password, settings and profile for signing in again; Remove deletes it from this Mac (nothing changes in Proton). Everything lives under `accounts/<id>/` in the app's folder, with the list in `accounts.json` (written atomically; a lost list is rebuilt from the folders); the account from before is moved there at the first start and stays the first — its CalDAV user name and its installed Calendar.app profile keep working. App-wide settings (appearance, language, checks and window, notifications, developer options) stay shared.
- **The window.** Overview: one card per account (status, last sync, waiting changes, failed requests, invitation emails, Sign In Again when a session ended). Calendars: with one account as before; with several, one tab per account — "Calendars" with the address under it in small grey. The side panel lists every account with its dot or sync symbol and its status line. Setup and the Emails card show one account at a time (a row of account chips chooses, from the second account on). Settings → Accounts: the accounts in order with ▲ ▼ and Sign Out, and Add Account; the order is the order everywhere (panel, tabs, Overview, menu-bar menu).
- **Menu-bar menu.** With several accounts, one block per account (address, Refresh Now) without shortcuts; with one, ⌘R stays. The window's View menu keeps ⌘R ("Refresh All Accounts" with several). (0.36.0 had moved Web Calendar under Refresh Now, once per account; 0.36.1 puts it back above Quit Bridge — Proton's web calendar has no way to open a given account.)
- An account that asks for a code or a verification in the background (session recovery), or whose session Proton ended, gets the sign-in page addressed to it (its address as the heading, a way back). Notifications name the account while there are several.
- Reviewed in three rounds (data safety of the migration and the list, cross-account CalDAV access, lifecycle races, the window); live run with two test accounts side by side (`tests/live/accounts.live.ts`); window states checked under a virtual display (`tests/electron/renderer-accounts.harness.js`).
- Known limits (0.36.0; the log lines are named since 0.36.4): the menu's sync symbol spins for the first syncing account only; Calendar.app's "Reminders" switch for each bridge account is best left off (0.35.1).
- Updating: `git apply` the app patch (library unchanged), `npm install`, `npm run check`, build. First start: the account moves into `accounts/<id>/` (log line `[accounts] the account from before 0.36 moved …`).

## 0.35.1 (Reminders' task list — patch 35b)
- **No more "DEFAULT_TASK_CALENDAR_NAME" calendars.** Reminders (macOS's CalendarAgent) asks every CalDAV account for its default task list on each refresh — a MKCALENDAR for a VTODO-only collection named with Apple's untranslated key (which Reminders shows as "Reminders") — and asks again as long as the account has none. Since 0.34 honours MKCALENDAR, each of those requests became a new Proton calendar (one per refresh; before 0.34 they got a harmless 404). The bridge now recognises a task-list request (a component set without VEVENT, or Apple's name) and refuses it with 403 and the reason, quietly: logged once per run, not on the Overview page, because it repeats. Calendars already created this way are empty; delete them in Proton Calendar (the bridge still refuses deletion from Calendar.app). Turning off Reminders for the account in System Settings → Internet Accounts stops the request altogether.
- Updating: `git apply` the app patch (library unchanged), `npm run check`, build.

## 0.35.0 (offline edits — stage 11, WP9; patch 35)
- **Changes made while Proton cannot be reached are kept and sent later.** A save or deletion from Calendar.app that gets no answer from Proton (no connection, DNS, a timeout, a server error) is no longer a failure: it goes into the local copy as if saved — with an ETag, served like any other event — and into an outbox on disk (in the encrypted local copy), with the event as Proton last had it. Sync passes leave such events alone (neither overwritten with Proton's older version nor marked deleted). Once Proton answers again — a sync pass that works, a save that works, or the minute-by-minute retry — the outbox is sent oldest first, each change through the same path as a live save: invitations and answers are emailed then, under the email mode in force (decided: a meeting invitation created offline is emailed once back online). A later save of a waiting event replaces the waiting one; an event created and deleted while offline is simply forgotten.
- A change Proton refuses once it is back (changed in Proton meanwhile, deleted there, not allowed) is undone here — the local copy shows Proton's version again and Calendar.app re-reads it at its next refresh — and reported on the Overview ("Last Failed Calendar.app Request") and as a notification ("Change not saved"). No answer again: the change keeps waiting.
- Overview: a card "Changes Waiting for Proton" with the count; the calendar's yellow dot says "n changes wait for Proton". Signing out drops what still waits (said in a notification).
- Not offline: Proton asking to slow down (Calendar.app is told to wait, as before), an ended session, a refusal.
- Updating: `git apply` the app patch (library unchanged), `npm install`, `npm run check`, build.

## 0.34.2 (video links, the rest — patch 34c)
- **The room follows the event.** Renaming an event with a Proton Meet room of yours in Calendar.app renames the room (Proton Meet's own API, the way its app does it; the room's key is unlocked with the password in the link). Deleting the event from Calendar.app removes the room (Proton leaves rooms behind when an event is deleted; the bridge does not). Both best effort, after the save.
- **Taking the link off.** The link is the event's location: replace or clear the location in Calendar.app and the link is removed from the event in Proton — the conference properties go, the "Join Proton Meet" block leaves the description, and Proton removes the Meet room itself (found live). Typing "Proton Meet" again afterwards makes a new room. Only events whose location *was* the link have this gesture: a room added in Proton's own apps (which leave the location alone) stays whatever you do to the location in Calendar.app — remove such a link in Proton Calendar. Moving an event to another calendar in Calendar.app keeps its room (Calendar.app does that as a copy and a delete). Cancelling a meeting you organize removes its room too, so guests' copies of the link stop working with the meeting.
- Library: `renameProtonMeet(url, title)`, `deleteProtonMeet(url)` (Proton Meet's API host `meet-api.proton.me`, which serves what the mail/calendar hosts do not — the earlier 404 was that, not a missing endpoint); `conferenceRemovalLines()`; the organizer path and the series path take empty conference properties as "removed".
- Updating: `git apply` both patches (34 and 34b first), `npm install` in both folders, `npm run check`, build.

## 0.34.1 (video links — stage 10, part 2 of WP8b; patch 34b)
- **Video links from Calendar.app.** "Proton Meet" or "Zoom" typed as an event's location (case and spaces do not matter) makes the bridge create the room when the event is saved and store the event with the join link as its location, Proton's conference block in the description (between Proton's separators, as Proton Calendar's own form writes it — guests see it in the invitation email) and Proton's conference properties (`X-PM-CONFERENCE-ID` with the provider, `X-PM-CONFERENCE-URL` with the host, Zoom's passcode), which Proton Calendar shows as its conference widget. Repeating events get the link on every occurrence.
- Proton Meet rooms are created exactly as Proton Calendar creates them (the client runs Proton's recipe: a random password that only ever travels in the URL fragment, the room's session key wrapped with a bcrypt hash of it, the room name encrypted to that key, the password PGP-encrypted to your primary key, an SRP verifier) — confirmed live on a free account. Zoom goes through Proton's own endpoint and needs a plan that includes it and Zoom connected in Proton Calendar's settings; otherwise the save is refused with the matching hint (Calendar.app shows it and keeps the event as typed). A save Calendar.app sends again (after a refusal further down, say) uses the room made the first time instead of making another. Rooms stay when an event is deleted (Proton Calendar leaves them too).
- Served events carry the conference properties (part of the ETag). Calendar.app drops properties it does not know when it writes an event back: the bridge puts the stored ones back, so a link made in Proton Calendar — or by the bridge — survives an edit in Calendar.app. Before, an edit in Calendar.app of a plain event with a Zoom link made in Proton silently dropped the link. Removing a link is done in Proton Calendar.
- Library: `createVideoConference()`, `EventData.conference` (set / null / undefined = keep), `decrypted.conference`, `src/video-links.ts`; offline test, live scenario `video`.
- Updating: `git apply` both patches (34 first), `npm install` in both folders, `npm run check`, build.

## 0.34.0 (calendar management — stage 10, part 1 of WP8b; patch 34)
- **Rename and recolour calendars in Calendar.app.** Calendar.app's PROPPATCH (name, colour; its calendar order is accepted and ignored) goes to Proton the way Proton Calendar's edit form does it — your member entry, so it works for calendars shared with you and for subscribed and holiday calendars too — and into the mirror at once. Proton accepts only its own accent colours: the colour Calendar.app sends becomes the nearest one (Proton's own helper does the same), and Calendar.app shows Proton's colour after its next refresh.
- **Create calendars in Calendar.app.** File → New Calendar under the bridge's account (MKCALENDAR) creates a personal Proton calendar with its own key (the client runs Proton's calendar setup: a fresh calendar key, its passphrase encrypted to and signed by your primary address key); the CalDAV collection keeps the path Calendar.app chose, the calendar is ticked and synced right away. A calendar whose key setup fails is removed again rather than left broken.
- Deleting a calendar from Calendar.app stays refused (403 with the reason; it is too easy to do by accident when removing an account) — delete it in Proton Calendar.
- Library: `updateCalendarAppearance()`, `createCalendar()`, `deleteCalendar()` (tests only), `normalizeCalendarColor()`; live scenario `calendars` (create, event in it, rename, recolour, remove) passed on the organizer account.
- Updating: `git apply` both patches, `npm install` in both folders, `npm run check`, build.

## 0.33.3 (patch 33d)
- Test only: the availability test assumed a UTC machine (on a Mac in Europe/Amsterdam a timed event lands on the all-day event's local midnight and the two merge, so `npm run check` failed). The suite now passes in Europe/Amsterdam, UTC, America/New_York, Pacific/Auckland and Asia/Kolkata. No change to the app.

## 0.33.2 (availability — stage 9, part 3; patch 33c)
- **Availability in Calendar.app.** The free/busy lookup Calendar.app sends to the outbox while a meeting is planned (its availability view) is answered per guest instead of "no scheduling support" for everyone: your own addresses from the mirror — every ticked own or shared calendar, repeating events expanded with Proton's own iterator (exceptions and excluded occurrences honoured), events marked free (TRANSP:TRANSPARENT), cancelled or declined by you count as free, overlapping periods merged — and other Proton users from Proton's busy-schedule endpoint, the way Proton Calendar's event form asks it. Proton only shares busy times inside an organization on an eligible plan (Business, Family, Duo, Visionary, Mail Essentials/Business); for anyone else, and for addresses outside Proton, the answer stays "no scheduling support" (Calendar.app: no information). Your own busy times are kept for 30 seconds, Proton's answers for two minutes, "not shared" for ten and a failed lookup for one, so typing in the guest field does not read the mirror or ask Proton again and again; all-day events are busy on this Mac's local days; windows are capped at 92 days (the reply says which window it answers).
- Library: `getBusySchedule()`, `busyPeriodsOf()` / `mergeBusyPeriods()` (`src/busy.ts`); offline test `scripts/busy-test.ts`; live scenario `busy` (the test accounts, individual plans: Proton answers "not accessible" — expected).
- Updating: `git apply` both patches (33 and 33b first if not applied yet), `npm install` in both folders, `npm run check`, build.

## 0.33.1 (guest autocomplete — stage 9, part 2; patch 33b)
- **Guest autocomplete in Calendar.app.** Typing a guest into a meeting suggests your Proton contacts (names and addresses) and your own addresses: Calendar.app looks guests up on the server (a search of the principal collection, `/principals/`), and the bridge answers it from the account's contact addresses — the ones Proton keeps readable for its own autocomplete, not the encrypted contact cards. The search matches the start of any word of the name or address, ignoring case and accents ("mu" finds "Müller"); the contacts are read when first searched and again after ten minutes, in the background.
- Each contact is a principal of its own (`/principals/contacts/…/`), so Calendar.app can read it again; contacts' names and addresses stay out of bridge.log (only how many matched is logged).
- Library: `listContactEmails()` (the contact addresses with names); live scenario `contacts`.
- Updating: `git apply` both patches (33 first if not applied yet), `npm install` in both folders, `npm run check`, build. Calendar.app learns what a server can search when it refreshes the account (Calendar → Refresh Calendars, or quit and reopen Calendar.app).

## 0.33.0 (reminders both ways — stage 9, part 1)
- **Reminders in both directions.** Calendar.app shows an event's Proton notifications as alerts (the calendar's default reminders when the event follows them; device notifications as "Message" alerts, email notifications as "Email" alerts), and alerts you add, change or remove in Calendar.app are stored in Proton the way Proton Calendar's own import does it: display and sound → device notification, email → email notification, an all-day alert at a time of day → "the day before at 9:00" counted from the event's local midnight; alerts after the start, location alerts and anything past Proton's 10 are left out. Alerts equal to the calendar's default reminders are stored as "the defaults" (Proton then keeps following the calendar's setting); a new event without alerts gets the defaults; removing all alerts stores none.
- For a meeting you organize or an invitation you received, a changed alert goes through Proton's personal part alone: nobody is emailed, nothing else about the meeting moves; together with an answer or another change it is done right after that change.
- Fixed on the way: an edit from Calendar.app to a plain or recurring event without guests used to reset the event's custom reminders to the calendar defaults; and an email alert's own ATTENDEE line made the bridge take a plain event for a meeting.
- Updating: `git apply` both patches, `npm install` in the library folder and in the app folder, `npm run check`, build. Existing events show their reminders after the first full sync (the Refresh button); Calendar.app re-reads them (their ETags change).

## 0.32.7 (patch 32h)
- Calendars page: hovering a sync arrow shows "Sync {calendar} now" / "Sync every ticked calendar in {group}" (and "Syncing…", "Queued…") at once, in the same box the status dots use, instead of the native tooltip that took a second to appear.
- Calendars page: a line under the title — "Select the calendars to be synced by Neutron Calendar Bridge."
- (Unchanged, confirmed: every calendar of a newly signed-in account is ticked; the app keeps a list of calendars you unticked, not of ticked ones.)

## 0.32.6 (patch 32g)
- Menu-bar menu: Setup, Settings, **Info** in that order (Info moved below Settings).
- The small labels above the page titles (BRIDGE, MIRRORED CALENDARS, CALENDAR.APP, CONFIGURATION, ABOUT) are gone; the cards keep theirs.
- Settings → Emails: "Like Outlook.app, …".

## 0.32.5 (patch 32f)
- Tobi's new app icon: `app-icon.icns` from the artwork as it is (plate with margins, like Apple's own icons), `app-icon-tahoe.icns` full bleed for macOS 26 (the plate scaled to the whole canvas, which Tahoe cuts into its own rounded square). The menu-bar icon stays.

## 0.32.4 (patch 32e)
- The sync symbol on the account line of the menu-bar menu **turns while a calendar syncs** and the menu is open (one turn per second, clockwise), and the menu's items change in place while it is open — a sync that starts or ends is shown at once instead of at the next opening. Done by a small native module (`native/menu-spinner`, Objective-C, Node-API): Electron's menu stays the native macOS menu, the module only swaps the item's image on a timer.
- Building: `npm run build` now also compiles the module with node-gyp (`native/menu-spinner/build/Release/menu_spinner.node`), which needs Xcode's command-line tools like @journeyapps/sqlcipher does. A failed build is reported and the app runs as before (the symbol stays still; bridge.log says so at start); `npm run build:native` builds it on its own and fails loudly. While the menu is open, a rebuilt menu (a sync starting or ending, a sign-in) is installed after it closes, since installing it earlier would close it.
- `scripts/make-spinner-frames.py` draws the 12 frames (`resources/icons/menu/spinner/`).

## 0.32.3 (patch 32d)
- Settings: **Invitations and Mailbox** are one card ("Emails"): the language of the emails and what happens to emails about meetings in your Inbox. The explanatory paragraphs about invitations are gone (the Setup guide still has the short version).
- The email mode (**test / dry run / live**) and the test-mode address list moved to **Developer Options**. They count only while developer options are on; otherwise emails go out like from Proton Calendar — **live is now the default** (it was test with an empty list). A config that had set test or dry run keeps that setting; it is in force whenever developer options are on, and the Emails card says so in orange. If you relied on test mode with developer options off, switch them on.
- Developer Options are hidden while the switch is off and appear when it is on.
- Setup page: the introductory sentence is gone.

## 0.32.2 (patch 32c)
- Calendars page: the introductory paragraph is gone (the list speaks for itself; the dot and the arrows still explain themselves on hover).
- Setup page: the "Set Up Manually" card shows that it opens — a "Show the values ⌄" control on the right, "Hide the values ⌃" while open, the whole header highlighted on hover.
- "Developer Settings" is called "Developer Options", like the switch that turns them on.

## 0.32.1 (patch 32b)
- Menu-bar menu: the status line opens the **Overview**; **Setup** has its own entry (Cmd-U) above Settings; Info now comes before Setup and Settings; "Open Bridge" is gone (the status and account lines open the window). The View menu matches (Overview Cmd-F1, Calendars, Setup Cmd-U, Info Cmd-I).
- English titles in Title Case, as macOS does it: page and section headings, card labels, menu items, button labels and the sign-in and Calendar.app card titles ("Sign In to Proton", "Emails About Meetings", "Set Up Calendar.app", "Last Sync"). Hints, messages and field labels stay in sentence case. The other languages are unchanged (German, Dutch, French, Spanish and Italian have their own capitalisation rules).

## 0.32.0 (the app in six languages)
- The app speaks **English, German, Dutch, French, Spanish and Italian**: the window (all pages, hints and status texts), the menu-bar menu and the app menus, notifications, the status messages, and the reasons Calendar.app is given when a change is refused. Settings → General → **Language**: "Same as macOS" (the default: macOS's language when it is one of the six, else English) or a fixed language; the change applies at once, no restart.
- What stays English: the developer statistics panel, the library's own error texts (Proton's error messages are passed on as they come), `bridge.log`.
- For translators: English is the source text; `src/locales/<code>.json` holds the translations (`npm run strings` lists what is missing, `npm run check` fails on a missing entry, `npm run test:i18n` applies every catalog to the real window).
- Updating: `git apply` the app patch, `npm install` in the app folder (no new dependencies; the lock file), `npm run check`, build. The library is unchanged (0.31's). The language setting starts as "Same as macOS".

## 0.31.0 (invitation emails in Proton's languages)
- Invitation emails (invitations, updates, cancellations, your answers) are written in **Proton's own words and translations** — the texts of Proton Calendar's web app, in 34 languages (German, Dutch, French, Spanish, Italian, Portuguese, Polish, Czech, Swedish, Danish, Norwegian, Finnish, Hungarian, Romanian, Croatian, Slovenian, Slovak, Greek, Turkish, Russian, Ukrainian, Belarusian, Georgian, Japanese, Korean, Chinese, Hindi, Indonesian, Catalan, Kabyle …), dates included. Settings → Invitations → **Language of the emails**: "Same as Proton Calendar" (the default: the Invitation language in Proton Calendar's settings, else the account's language) or a fixed language.
- Updating: `git apply` both patches, `npm install` in the library folder and in the app folder, `npm run check`, build. Nothing to set up: emails follow Proton Calendar's setting from the first start.

## 0.30.1 (patch 30b)
- The account the profile adds is called **Proton** in Calendar.app (the profile itself is still listed as "Neutron Calendar Bridge" in System Settings). Installing the profile again renames an account installed by 0.30.0.

## 0.30.0 (one-click Calendar.app setup)
- The Setup page's **Set up Calendar.app** writes a macOS configuration profile with the bridge's CalDAV account (host 127.0.0.1, port, user name, password, principal URL, no SSL) and hands it to macOS, which shows it in System Settings → General → Device Management (Privacy & Security → Profiles on macOS 13 and 14). Installing it adds the account to Calendar.app; removing the profile removes the account. The profile is unsigned ("not verified"): it is made on your Mac by the bridge. Installing it again replaces the account rather than adding a second one.
- The page shows whether Calendar.app is connected: "Connected" with the time of its last request (remembered across restarts), "Quiet" when it has not asked for hours, "Not set up" before the first time.
- The profile file holds the bridge's password, so it lives in the app's folder (yours only) for five minutes at most and is removed at quit and at the next start; System Settings keeps its own copy from the moment it was opened.
- The values for setting the account up by hand are still there, folded under "Set up manually" (opened by itself when Calendar.app sends a wrong password).
- Updating: `git apply` the app patch, `npm run check`, build. The library is unchanged. An account you added by hand before keeps working; there is no need to install the profile.

## 0.29.1 (patch 29b)
- The menu item is called **Refresh now** ("Refreshing…" while a pass runs) and its text lines up with the account's address above it.
- From now on a patch with a letter (29b, 30a, …) raises the last number of the version, so the app's About box and Info page show which patch is in.

## 0.29.0 (Refresh now in the menu)
- The menu-bar menu has **Refresh now** directly under the account: the same pass as the Refresh button (every ticked calendar, mailbox included; public holidays are synced daily on their own). While a pass runs it reads "Refreshing…" and is greyed; signed out it is not shown. Also in the app's View menu as Refresh Now, Cmd-R (which used to reload the window — DevTools can still do that).
- Updating: `git apply` the app patch, `npm run check`, build. The library is unchanged.

## 0.28.0 (sign in with Proton)
- **Sign in with Proton:** the Setup page's first choice is now Proton's own sign-in page, opened in a window of its own (a fresh in-memory browser session, no scripts of the bridge in it). Whatever your account needs — password, authenticator code, security key, passkey, SSO — is handled by Proton's page; nothing of it reaches the bridge. Proton then hands the bridge a session of its own (listed under Proton's Settings → Security → Sessions, where you can end it any time) together with the key your calendars are decrypted with, the same way Proton's desktop apps sign in. The bridge stores no password this way; when Proton ends the session, it asks you to sign in with Proton again instead of signing in by itself. The password form stays available ("Or sign in with your password here").
- A passkey kept in iCloud Keychain is used through the "scan with your iPhone" route Proton's page offers; macOS does not give third-party apps the Mac's own passkey prompt.
- Updating: `git apply` both patches, `npm install` in the library folder and in the app folder, `npm run check`, build. An existing sign-in is kept as it is.
- Fixes found on the Mac (patches 28b and 28c): the app crashed the moment Proton's page handed the session over (the window was closed from inside the page's own navigation; it now waits for the next turn of the event loop — `npm run test:window` exercises this in real Electron), and the handover then failed with "Invalid selector": Proton's page saw "Electron" in the window's user agent, took it for Proton's own Mail desktop app and prepared the session for that client, which the bridge (asking as the calendar web app) could not take over. The window now presents itself as the plain Chromium it is. (The library also asks again for a moment when Proton does not know a fresh fork yet.)

## 0.27.0 (two-factor authentication, two-password mode)
- Accounts with two-factor authentication can sign in: after the password, the Setup page asks for the 6-digit code from your authenticator app (a wrong code is asked again). Security keys cannot be used by the bridge yet: an account that has only a security key is told to add an authenticator app for the bridge; one with both uses the code.
- Accounts in Proton's two-password mode can sign in: the Setup page asks for the mailbox password, which unlocks the keys. It is not kept; only the derived key is, with the session.
- The saved session now carries the key the calendars are decrypted with (encrypted in the Keychain item, as Proton's apps do). Resuming at the next start therefore needs neither a password nor a code, and no longer fails after Proton renewed the access token (0.25's "missing scope: locked", which forced a password sign-in at every start). The code is only asked for when Proton ends the session.
- A sign-in that happens in the background (app start, Proton ended the session) and needs a code or the mailbox password shows the prompt on the Setup page and says so with one notification; syncing waits until it is answered. Unanswered for 10 minutes, it gives up and the status says why.
- Updating: `git apply` both patches, `npm install` in the library folder and in the app folder, `npm run check`, build. The session saved by 0.26 still works (the password unlocks the keys once); from the next renewal on it carries the key.

## 0.26.0 (efficient sync)
- The app no longer lists every calendar's whole window once a minute. It follows Proton's change feeds (what Proton Calendar itself polls): one small request for the account and one per calendar tell it what was created, changed or deleted since the last check, and only those series are read again. Everything is listed in full at sign-in, at the first check of a day, with the Refresh button, with a click on one calendar, and when Proton asks for it. On the test account a quiet check went from 55 requests to 2; a creation, change or deletion in Proton costs 3.
- Unchanged events are not decrypted again (the decrypted copy is reused while nothing about the event changed).
- Checks come at the interval set in Settings → Sync schedule ("Check for changes every") while things change — a change from Proton or Calendar.app, a sign-in, waking up, reconnecting — and every 5 minutes after 10 quiet minutes. The next check is always one interval after the last pass ended.
- The calendar list is read again only when the feed reports a calendar added, changed or removed; the mailbox (emailed answers, emails about meetings) only when mail arrived, a meeting changed, or in a full pass. A new calendar is listed in full first.
- Developer settings → Requests to Proton: the passes of the last hour (how many, how many full, requests, events decrypted, changes), the last pass's kind, the feeds (calendars following them, when everything was last listed in full), the cadence (next check), and decryptions reused.
- Updating: `git apply` both patches, then `npm install` in the library folder and in the app folder (the library is rebuilt), `npm run check`, build. The local copy gets two new columns by itself.

## 0.25.0 (library refresh)
- Fix for 0.24: Calendar.app never sends its password as "Basic" credentials over plain HTTP, so since 0.24 every request from Calendar.app was refused (401) and nothing synced; a freshly added account could not be verified. The bridge now offers Digest authentication as well, which Calendar.app answers (the password is checked exactly as before; other programs may still use Basic).
- The Proton code the app is built on (proton-calendar-client's vendored WebClients sources) is current again: WebClients of 2026-10-08 instead of 2025-08-20, with Proton's crypto now coming from its npm package `@protontech/crypto` (Proton's OpenPGP.js 6 fork instead of the vendored OpenPGP.js 5). Nothing changes in how the app works; sign-in, syncing, invitations and the mailbox features were tested live on the test accounts.
- The app presents itself to Proton as the current iOS Mail app (7.11.7), so Proton does not retire the version string under it.
- A Proton guest whose account has end-to-end encryption for mail switched off (external forwarding) is invited like an outside guest and still gets the meeting into their Proton calendar, as Proton's own apps do now.
- The app is a third of its former size: the library ships only its built bundle.
- For development: `npm run refresh:proton` in the library reports (or, with `--apply`, performs) the next refresh — see the library's README.
- Updating: `git apply` both patches, then `npm install` in the library folder (new dependencies) and in the app folder, `npm run check`, build.

## 0.24.0
- The local copy of your calendars is encrypted (SQLCipher), with a random key kept with your saved login in the Keychain. The copy from before is converted at the first start, nothing is lost, and no unencrypted copy is left on the disk (Time Machine backups and snapshots made before the update still have the old one). If macOS does not let the app read the Keychain item, or the copy cannot be opened, the copy is left as it is and the app works on one in memory (the Overview says so).
- Calendar.app now has to sign in with the password shown on the Setup page. If it uses an old one, a notification says so and the Setup page shows the password to enter (with a Copy button; the copied password is removed from the clipboard after 90 s) and where; the Overview points there too. The user name is not checked. Calendar.app may ask for the password once after the update if it never had the current one.
- Quiet logs: `bridge.log` leaves out event titles, calendar names, email addresses and subjects, email text and calendar files; addresses appear as a short tag so lines can still be told apart. The logs from before the update are deleted at the first start. Developer settings → **Detailed logging** (for 24 hours, or until switched off) puts the details in while tracing a problem; **Delete the logs** removes them afterwards.
- Settings → General → **Show event titles in notifications**: switch it off and notifications only say what happened, without the event or calendar name and without addresses. (macOS keeps notifications in the Notification Center until you clear them.)
- The app's files (saved login, local copy, settings, log) are readable by you only.
- Building needs the Xcode Command Line Tools (`xcode-select --install`): the encryption is compiled during `npm install`.

## 0.23.0
- Stays signed in like Proton's own apps: an expired access is renewed in the background, and the app resumes its session at start instead of signing in with the password every time (fewer sign-ins, fewer CAPTCHAs). Signing out ends the session at Proton.
- If Proton ends the session (e.g. after signing out everywhere or changing the password), the app signs in again with the saved login, once; if that fails, a notification says why.
- When Proton asks to slow down, the app does exactly that: every request waits for Proton's time, a long pause stops syncing until then (shown, and notified), and nothing is lost. Requests are spread out instead of fired in bursts; reads that get no answer are tried again a little later, changes are never sent twice. A request that hangs is given up after a minute.
- Changes made in Calendar.app while Proton asks to slow down are not lost: Calendar.app is told to try again at Proton's time (meetings and answers included); nothing is sent twice.
- Opened before the network is up: the saved session is tried first once Proton answers. If Proton asks you to verify while the app signs in again by itself, a notification says so. A meeting saved while one of its emails could not be sent is notified.
- An app version Proton no longer accepts is said plainly instead of a generic sign-in failure.
- Developer settings: how the app talks to Proton (requests in the last hour and per sync pass, answers, slow-downs, sign-ins, renewals).

## 0.22 (library only)
- Live tests on test accounts (`npm run test:live` in proton-calendar-client); the email log names the occurrence of a series an email is about.

## 0.21.0
- Subtitle "Bridge for Proton Calendar" and the note on the Info page: unofficial, not affiliated with Proton AG.
- macOS notifications with the exact reason when Calendar.app's change was refused or only partly saved (Calendar.app itself only says "not permitted"), when Proton cannot be reached for 5 minutes or keeps refusing to sync, and for mailbox problems. Several at once are summed up. Can be turned off in Settings.
- Syncs right after the Mac wakes up (once the network is back), and as soon as Proton can be reached again after more than 2 minutes without it.
- Opened without a connection (e.g. at login before the Wi-Fi is up): signs in as soon as Proton can be reached. If the first sync after signing in fails, the regular sync still runs.
- Status symbols readable without colour: a yellow ring for "needs attention", a red "!" for a problem (Calendars page and menu-bar menu); hover shows the reason.
- Info: this changelog, and a "Check for updates" button for later (greyed out for now).
- A saved login that cannot be read (e.g. Keychain access denied) is left as it is: quit, reopen and choose "Always Allow" to get it back. Signing in again keeps the old file aside. A login that was encrypted is never saved in plain text.
- "Open on startup" is registered again when macOS does not have it (e.g. after a build under another path); Settings says when macOS has it switched off.
- Web pages can no longer reach the local calendar server (only programs on this Mac can).
- Answering an invitation from a copy that differs only in the file's PRODID is not refused.
- For development: `npm run check` runs every test of the app and the library in one go.
- Updating: quit the app before replacing it; choose "Always Allow" when macOS asks about the Keychain.

## 0.20.0
- Emails about meetings can leave the Inbox once they are dealt with, like in Outlook: leave them, or move them to the Bin, the Archive or a folder (created if needed). Invitations once answered, cancellations once applied, guests' answers once Proton has them. Unanswered invitations, starred emails, counter-proposals and answers with a note stay.

## 0.19.0
- The window can be dragged by the top of either side.
- Info links to the fork's author on GitHub.
- Developer settings (off by default) at the bottom of Settings. "Apply answers that guests outside Proton send by email" moved there: Proton now records those answers itself.
- Replies about meetings that no longer exist are only logged.

## 0.18.0
- Calendars page in groups (My Calendars, Shared with me, Subscribed, Public Holidays) with a status per calendar, sync buttons for a calendar or a group, and a sync queue.
- Setup tab with the connection values and the Calendar.app guide.
- Menu-bar menu: status, account, Open Bridge, Info, Settings, Web Calendar, Quit, with shortcuts.
- Public holidays sync at sign-in and once a day at midnight, not with every refresh.
- A new guest who cannot be invited (not on the test-mode list, address Proton cannot email) is left out and the rest of the meeting is saved.

## 0.17.0
- Answers that guests outside Proton send by email are applied to your meetings.

## 0.16.0
- App icon without macOS 26's grey plate.

## 0.15.0
- Menu bar like Proton Mail Bridge, one menu-bar icon from launch, new app icon.

## 0.14.0
- Meetings: no false "changed meanwhile" error after a sync pass rewrote the event.

## 0.13.0
- Recurring meetings: moving or deleting a series with changed occurrences no longer reports an error Proton did not make.

## 0.12.0
- Recurring meetings you organize can be created and changed from Calendar.app (whole series, one occurrence, all future events).

## 0.11.0
- Meetings you organize: inviting guests from Calendar.app sends Proton's invitations, updates and cancellations.

## 0.10.0
- All-day events stay all-day both ways. Subscribed, holiday, view-only and disabled calendars are read-only in Calendar.app. Dock icon while the window is open.

## 0.9.0
- Invitations can be answered from Calendar.app (Accept, Maybe, Decline, or delete to decline); the organizer is emailed like Proton Calendar does. Test mode and dry run keep emails to addresses you choose.

## 0.8.0
- Meetings and invitations show organizer, guests and answers; guest lists can no longer be wiped by an edit from the Mac.

## 0.2.0 – 0.7.0
- Recurring events sync both ways: repeat rules, skipped and moved occurrences, edits from Calendar.app.
- Choose which calendars to sync.
- One failing calendar no longer stops the others; per-calendar errors are shown.
- Events created in Calendar.app keep their identity (no duplicates).
- Refused requests are answered with a reason, shown in the app and written to bridge.log.
- Correct time zones; stable output that does not re-sync unchanged events.
- Proton's Sentry telemetry removed from the bundled library.
- Dark mode, version badge, Info page; the fork gets its name, Neutron Calendar Bridge.

## 0.1.0
- proton-calendar-sync by Tactless Autist: the original app and library.
