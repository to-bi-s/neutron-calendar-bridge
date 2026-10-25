# What the bridge does, in detail

The rules behind the features — for when you want to know exactly what happens when you answer, invite, move or delete something in your calendar app. The short version is in the [README](../README.md).

## Syncing

- **What is read**: the app follows Proton's change feeds — the same ones Proton Calendar polls — with one small request for the account and one per calendar, and re-reads only what changed. Everything is listed in full only at sign-in, once a day, with the Refresh button, or when Proton asks for it. Unchanged events are not decrypted again.
- **When**: at your interval while things change (Settings → Sync schedule; default every minute) and every 5 minutes after 10 quiet minutes; at once after the Mac wakes up, when the connection comes back, or when you change something in your calendar app. Public-holiday calendars are synced at sign-in and once a day at midnight.
- **Proton's slow-downs**: when Proton asks to slow down, every request waits for Proton's time and syncing pauses until then; requests are spread out, reads without an answer are tried again, changes are never sent twice.
- **Offline edits**: changes you make while Proton cannot be reached (no connection, Proton down, or a slow-down) are taken into the local copy at once — your calendar app shows them as saved — and sent in order once Proton answers again, invitations and answers included. The Overview and the calendar's yellow dot say how many wait. A change Proton then refuses is undone here (your calendar app shows Proton's version after its next refresh) and reported.
- **Read-only calendars**: subscribed, holiday, view-only shared and disabled calendars are read-only; an edit is refused with the reason instead of failing silently.
- **Fields Proton has no place for** — categories, attachments, the privacy class, a Tentative status — are dropped on save (links in the notes are kept; "show as free" is kept).

## Calendars

- Renaming or recolouring a calendar in Calendar.app changes it in Proton (your view of it, as in Proton Calendar's edit form); the colour becomes the nearest of Proton's own calendar colours.
- A calendar created in Calendar.app under the bridge's account becomes a personal Proton calendar with its own key, ticked and synced right away. An account with several addresses chooses on the Calendars page which address owns new calendars.
- Deleting a calendar in Calendar.app takes it out of Calendar.app only: it is unticked here and kept in Proton; tick it again on the Calendars page.
- Reminders (tasks) are not served — Proton Calendar has none. macOS turns Reminders on for every new CalDAV account; switch it off in System Settings → Internet Accounts for the bridge's account.

## Reminders (alerts)

An event's Proton notifications — or the calendar's default reminders — are served as alerts, and alerts you add, change or remove in your calendar app are stored in Proton: display and sound alerts as device notifications, email alerts as email notifications. For a meeting or an invitation the reminders go through Proton's personal part, so changing an alert never emails anyone. Alerts equal to the calendar's defaults count as "the defaults" (Proton keeps following the calendar's setting); removing all alerts stores "none". What Proton cannot keep is left out: alerts after the start, location-based alerts, more than 10.

## Answering invitations

Accept, Maybe and Decline in your calendar app do what the same buttons do in Proton Calendar: your answer is saved in Proton and emailed to the organizer (an iCalendar `REPLY`). The email is built and encrypted with Proton's own code and sent through your Proton account: end-to-end to Proton users, PGP where the organizer's key is pinned in your contacts, normal email to everyone else. Deleting an invitation declines it (the organizer is told only if you had said yes or maybe, and not when the app asks not to notify), then removes it — for a recurring invitation, the whole series.

What Proton itself cannot do is refused with the reason: answering one occurrence of a series on its own (Proton takes one answer for the series, plus answers for occurrences the organizer changed), "no answer", delegating. In Thunderbird, an answer given on one occurrence of a series counts for the series, as it would in Proton Calendar.

## Meetings you organize

Inviting people to an event does what Proton Calendar does: the event is saved in Proton with you as the organizer (the calendar's address) and the guests get an invitation (`REQUEST`) — Proton users end-to-end and with the event added to their Proton calendar. Later changes follow Proton's rules: a new time, title, place or notes sends everyone an update (answers are reset when the time changes); adding or removing guests sends only them an invitation or a cancellation; deleting the meeting sends everyone a cancellation (`CANCEL`), unless your app is told not to notify. Guests' answers always come from Proton, never from your app's copy, and a save from an outdated copy is refused so it cannot remove a guest added in the meantime.

A new guest who cannot be invited — an address Proton cannot email, say — is left out, like Proton's "continue without": the meeting is saved and the other guests are emailed; your app shows a refusal and then reloads the saved meeting without that guest, the reason is on the Overview page and the calendar's dot turns yellow. Refused before anything is sent: two addresses of the same person, inviting from a calendar someone shared with you, an organizer that is not one of your addresses, moving a meeting with guests to another calendar (Calendar.app does that as copy + delete, which would invite and then cancel everyone — move it in Proton Calendar).

### Recurring meetings

Proton Calendar asks whether a change is for "all events" or "this event"; Calendar.app and Thunderbird instead send their whole new version of the series. The bridge reads what changed and does what Proton Calendar does for that choice:

- **The series itself** (time, repeat rule, title, place, notes, guests): like "all events". A new title, place or notes goes to everyone and into occurrences you had changed before (one email each). A new time or repeat rule resets everyone's answers, and occurrences you had changed before are cancelled and removed (Proton's rule). Guests are always changed for the whole series.
- **One occurrence changed** ("this event only"): an update for that date.
- **One occurrence deleted**: a cancellation for that date. Deleting the whole meeting cancels the series and each changed occurrence.
- **"All future events"** splits the meeting in two, which Proton Calendar does not offer for meetings: the old series ends at that date (an update for everyone, answers reset, its changed occurrences cancelled) and the rest becomes a new meeting with a new invitation. Change the whole series instead if you want to keep answers.

Refused with the reason: guests changed for one occurrence only, bringing back a deleted occurrence, undoing a change to one occurrence, changing several occurrences in one save (change them one at a time). Notes guests added to their answer are not carried into an occurrence you change.

### Answers from guests outside Proton

Proton guests answer straight into your event. Everyone else answers by email, and Proton records those answers by itself, usually within a minute or two, and your calendar app shows them at the next sync. Nothing to set up.

As a safety net there is a hidden option (`applyEmailedAnswers` in the account's configuration file; it used to be a developer option in Settings — tested, and not needed in practice). With it on, at the start of each sync the bridge does what Proton Mail would: it looks at the emails with a calendar attachment that arrived since the last sync (the first time, or after a longer break: the last 30 days; never trash, and spam only when the reply answers an invitation the bridge sent), decrypts them on this Mac and applies replies to meetings you organize, for the guest who sent the email. Like Proton Mail it leaves out answers to an older or newer version of the meeting, to a cancelled meeting or to one occurrence, and answers older than the one Proton has; stricter than Proton Mail, it also leaves out emails that fail DMARC or that Proton marked as phishing or suspicious. Nothing is sent and the emails are not touched. Each answer is listed on the Overview page and in `bridge.log`, with the reason when it was not applied. A guest's note with the answer ("Running late") is shown on the Overview.

## Emails about meetings

**Settings → Emails About Meetings** decides what happens to invitations, updates, cancellations and guests' answers in your Inbox once they are dealt with: leave them (the default), or move them to the Bin, the Archive or a folder (default "Calendar", created if it does not exist; top level only). After each sync the bridge looks at the emails with a calendar attachment in your Inbox from the last 30 days and moves those that are dealt with:

- an invitation or update once it is in your calendar and you have answered it (here or in Proton), or once a newer version has replaced it;
- a cancellation once the meeting (or the occurrence) is cancelled or gone in your calendar;
- a guest's answer to a meeting you organize once Proton has it, or once a newer answer from that guest is in Proton;
- emails about a meeting the bridge saw leave your calendar, as long as nothing of that meeting is left in your calendars.

These always stay in the Inbox: invitations you have not answered, starred emails, counter-proposals ("propose new time") and answers with a note in the calendar file (Proton keeps neither), answers to meetings that are not in your calendars, emails failing DMARC or marked as phishing, and anything the bridge cannot tell. Each move, and why an email stays, is written to `bridge.log`; Settings shows how many were moved since the app started and how many wait. A note a guest wrote only in the text of the email is not looked at: pick Archive or a folder rather than the Bin if that matters to you. The bridge reads only what it needs (decrypted on this Mac) and changes nothing else: no read marks, no answers, nothing sent.

## Video links

Type **Proton Meet** or **Zoom** as the location of an event and the bridge makes the room when you save — Proton Meet the way Proton Calendar does (the room's password only ever travels in the link; works on free accounts), Zoom through Proton when Zoom is connected in Proton Calendar's settings. The saved event has the join link as its location and Proton's conference fields, so Proton Calendar shows its conference widget; guests get the "Join Proton Meet" block in the invitation. A link made in Proton Calendar survives edits in your calendar app. Renaming the event renames your Proton Meet room, deleting the event removes it; replacing or clearing the location takes the link off the event.

## Availability and guest search (Calendar.app)

Calendar.app's availability view for a meeting is answered: your own busy times from the mirrored calendars (repeating events expanded; events marked free, cancelled or declined by you count as free; Maybe and tentative as tentatively busy), and other Proton users' busy times when Proton shares them with your account (inside an organization on Proton's Business, Family, Duo, Visionary or Mail Essentials/Business plans; for everyone else Calendar.app shows "no information"). While you type a guest, the names and addresses of your Proton contacts and your own addresses are suggested.

## Emails: language and modes

The invitation emails use Proton's own wording and Proton's own translations (34 languages). "Same as Proton Calendar" (the default) follows the *Invitation language* in Proton Calendar's settings, and the account's language when that is not set; or pick a language in Settings → Emails. Dates in the emails follow the language and your Proton 12/24-hour setting, as in Proton web.

Emails go out like from Proton Calendar. Every email (sent, blocked, dry run, failed) is listed on the Overview page and written to `bridge.log`. Emails are only sent for something you did in your calendar app, never during a sync. Recipients' keys are taken from Proton's key server (and your contacts) without Proton's extra key-transparency check. Developers can switch the emails off (dry run) under Settings → Developer Options; see [DEVELOPMENT.md](DEVELOPMENT.md#developer-options-in-the-app).

## Privacy, in one place

- The local copy of your calendars is encrypted (SQLCipher, with a random key kept with the saved login in the Keychain). The calendars are decrypted in the app's memory while it runs.
- `bridge.log` leaves out event titles, calendar names, email addresses and subjects, email text and calendar files unless "Detailed logging" is on.
- The CalDAV server listens on 127.0.0.1 only, over plain HTTP (nothing leaves the Mac); programs on this Mac need the generated password (Digest or Basic authentication; Calendar.app uses Digest); web pages cannot reach it at all.
- Notifications can leave event titles out (Settings → General). The app's files are readable by you only.
- Proton's telemetry (Sentry) is stubbed out of the bundled library: nothing is reported anywhere.
- The update check asks github.com for the release list (the request carries the app's name and version); it can be switched off.
