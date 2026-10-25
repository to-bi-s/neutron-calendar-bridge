# Developing and releasing Neutron Calendar Bridge

Everything a contributor or maintainer needs that a user does not: how the app is built, tested, signed, released and translated, and how it is put together. The user side is in the [README](../README.md); what the app does in detail is in [BEHAVIOUR.md](BEHAVIOUR.md).

## If you have never built an app like this

You don't need to be a programmer to build or poke at this app, but a few words help when the instructions below say "Node", "npm" or "Electron":

- **Node.js** is a program that runs JavaScript outside a browser — the same language web pages use, but on your Mac as an ordinary program. This app is written in TypeScript (JavaScript with type annotations) and everything that builds, tests and packages it is a Node.js script. Get it from [nodejs.org](https://nodejs.org) (the "LTS" installer; version 20 or newer) or, if you use Homebrew, `brew install node`. Afterwards `node --version` in the Terminal prints the version.
- **npm** comes with Node.js. It downloads the open-source packages the app depends on (`npm install` reads `package.json`, fetches them into `node_modules/`) and runs the project's named commands (`npm run check`, `npm start`, … — the list is the `scripts` section of `package.json`).
- **Electron** is what turns a web-technology app into a Mac app: a window with Chromium inside for the interface (`src/renderer/`), and Node.js behind it for the real work (`src/main/`: talking to Proton, the local database, the CalDAV server). npm installs it like any other package.
- **The Xcode Command Line Tools** are Apple's compilers. Two small pieces of the app are not JavaScript — the encrypted database (SQLCipher) and the module that animates the menu-bar menu — and are compiled on your Mac during `npm install` and `npm run build`. `xcode-select --install` gets them (a few hundred MB, no Apple ID needed). Signing and notarizing a build for others (further down) is the one step that needs an Apple Developer account; running the app from source does not.
- **git** is how the source is fetched and how changes are tracked; it is part of the Command Line Tools.

With those four in place, the five commands under "Building from source" are all there is: clone, install, check, start. Everything the app does is in `src/` and `client/src/`, in files whose names say what they hold; the comments at the top of each file explain the rest.

## How it works

- `src/main/proton-adapter.ts` — wraps the library in `client/` (proton-calendar-client, the fork of Tactless Autist's library): sign-in (CAPTCHA via a window with Proton's own verification page, second factor, mailbox password), session handling, reading and writing events.
- `src/main/bridge-service.ts` — the sync engine: one per Proton account, reconciles Proton and the local copy in both directions, follows Proton's change feeds, runs the outbox for changes made while Proton could not be reached.
- `src/main/mirror-database.ts` — the local copy of calendars and events (SQLite, encrypted with SQLCipher; the key lives with the saved login).
- `src/main/caldav-server.ts` — an Express CalDAV server (PROPFIND/REPORT/sync-token, Apple's calendar-color namespace, free/busy and guest search for Calendar.app) bound to 127.0.0.1, Digest or Basic authentication with a generated password.
- `src/main/secret-store.ts` — the saved login, Proton's session, the CalDAV password and the key of the local copy, encrypted with a key in the macOS Keychain (Electron `safeStorage`).
- `src/main/private-log.ts` — quiet logs: titles, addresses and texts are left out of `bridge.log` unless "Detailed logging" is on.
- `src/main/updater.ts` — automatic updates from GitHub Releases (electron-updater).
- `src/renderer/` — the window (plain HTML/CSS/JS, no framework); `src/locales/` — the five translations.

The app identifies itself to Proton as `NeutronCalendarBridge/<version>` with Proton's generic app version `Other` — never as one of Proton's own apps. Proton answers such a sign-in with a CAPTCHA; the password is used for the SRP sign-in only and not kept.

## Building from source

You need macOS, Node.js 20 or newer, and the Xcode Command Line Tools (see above): the encrypted local copy (SQLCipher) is compiled during `npm install`, and `npm run build` compiles the small native module that turns the sync symbol in the menu-bar menu (`native/menu-spinner`, for Apple silicon and Intel in one fat binary). The library is an npm workspace in `client/`, so one install at the top covers both (the library's `prepare` script builds it):

```bash
git clone https://github.com/to-bi-s/neutron-calendar-bridge.git
cd neutron-calendar-bridge
npm install
npm run check        # library build + its offline tests, bridge tests, texts and catalogs, bridge build
npm start            # runs the bridge from the checkout
```

The lock file is committed; `npm ci` installs exactly those versions. `npm run check` is the gate before every change: it runs the library's build and offline tests, the bridge's tests (`npm test` alone runs just those), the texts-and-catalogs check (every text of the window and the code has its entry in the five language catalogs) and the bridge build, and stops at the first failure.

A packaged app:

```bash
npm run package:mac  # → release/: a DMG and a ZIP per architecture (arm64 and x64, from either kind of Mac), plus latest-mac.yml for the updater
```

Both package commands end with `npm rebuild @journeyapps/sqlcipher`: electron-builder compiles SQLCipher in `node_modules` once per architecture and leaves the last one (Intel) behind, which the tests on an Apple-silicon Mac could not load — the rebuild puts this Mac's build back. If `npm test` ever fails with "incompatible architecture", that command is the fix.

This build is not signed or notarized (unless a Developer ID certificate is in your Keychain, which electron-builder then uses). macOS therefore blocks the first start: right-click the app in Applications → **Open**, or allow it under System Settings → Privacy & Security after the first refusal. The app keeps its data in `~/Library/Application Support/neutron-calendar-bridge` and its log in `~/Library/Logs/neutron-calendar-bridge/bridge.log`.

### The macOS 26 app icon

`resources/icons/app-icon.icns` is the icon for macOS up to 15. macOS 26 wants an Icon Composer icon: `resources/icons/AppIcon.icon` compiled into `resources/icons/Assets.car` (`npm run icon:tahoe`, needs the full Xcode 26 selected with `xcode-select`). The compiled file is committed; the build's afterPack hook (`scripts/after-pack.cjs`) puts it into the app with `CFBundleIconName`.

## Signed builds

A build that opens on any Mac without a warning is signed with a Developer ID and notarized by Apple. It needs an Apple Developer Program membership and two things in your login Keychain, set up once:

1. **The certificate**: Xcode → Settings → Accounts → (your Apple ID) → Manage Certificates → **+** → **Developer ID Application**. `security find-identity -v -p codesigning` then lists "Developer ID Application: *Name* (*Team ID*)".
2. **Notarization credentials**: create an app-specific password at [account.apple.com](https://account.apple.com) (Sign-In and Security → App-Specific Passwords), then store it under a profile name (the command asks for the password; nothing is written to the repository):

   ```bash
   xcrun notarytool store-credentials neutron-notary --apple-id <your Apple ID> --team-id <Team ID>
   ```

Then:

```bash
npm run package:mac:release   # both architectures: signed, notarized and stapled apps and DMGs, checked as Gatekeeper checks them
npm run package:mac:quick     # for testing: this Mac's architecture only, the DMG only signed (one wait for Apple instead of two)
```

The app is signed with the hardened runtime and `resources/entitlements.mac.plist` (only what Electron's JavaScript engine needs; library validation stays on, since every native module is signed with the same certificate). `NEUTRON_NOTARY_PROFILE` picks another profile name. Notarization usually takes a few minutes per upload. Builds given to others go through the full release. CI builds stay unsigned.

## Releasing

Two repositories: this public one (`main` = the published history, starting at 1.0.0) and a private one with the full history before 1.0.0. Work happens on the private `main`; a release carries the new commits to the public branch:

```bash
npm run package:mac:release                 # the release script lists the files to attach at the end
git checkout public
git cherry-pick <last published commit>..main
git push origin public:main
git tag -a v<version> -m "Neutron Calendar Bridge <version>" && git push origin v<version>
git checkout main && git push legacy main
```

Then on GitHub → Releases → Draft a new release: the tag, the version as title, the version's CHANGELOG section as body, and **every file the script listed** attached in the "Attach binaries" box: the two DMGs (what people download), the two ZIPs, their `.blockmap` files and `latest-mac.yml` (what the installed apps update from — a release without them is invisible to the updater). Asset names must not contain spaces (`package.json` → `build.mac.artifactName`; GitHub would rename them and the updater would not find them). The DMGs carry no version in their file name so that the README's download buttons can always point at `releases/latest/download/…`.

## Continuous integration

GitHub Actions (`.github/workflows/`): **Check** on every push and pull request — `npm ci` and `npm run check` on Linux in two time zones (Europe/Amsterdam, Pacific/Auckland), plus the window harnesses in Electron under Xvfb (screenshots as an artifact); **macOS** weekly and when the native module, `package.json` or the lock change — the native module compiled with Xcode, `npm run check` on macOS, the unsigned DMGs for both architectures built and their bundles checked (identifier, version, native modules, the library's `dist/`), kept for three days. Live tests (the library's scenarios and the bridge's two-account run against Proton test accounts) run on a Mac from sessions seeded by hand (`npm run seed:sessions`, which shows Proton's CAPTCHA once per account), not in Actions; see the [library's README](../client/README.md).

## Translations

The app's own texts come in English, German, Dutch, French, Spanish and Italian. English is the source text; the other languages are catalogs in `src/locales/<code>.json` (English text → translation, `{name}` placeholders kept, plurals as `one|other`). A missing entry falls back to English. `npm run strings` collects the texts from the code and the window into `src/locales/keys.json` and reports what each catalog is missing; `npm run check` fails on a missing or mismatched entry; `npm run test:i18n` applies every catalog to the built window in Electron and reports anything that stayed English. The invitation emails are a separate matter: they use Proton's own translations in 34 languages, taken from Proton's open-source web app (Settings → Emails → Language of the emails). Developer statistics and the library's own error texts stay English.

## Developer options in the app

Settings → Developer Options (off by default; active only while "Enable developer options" is ticked):

- **Send invitation emails** (1.0.4: one switch): on = live, like Proton Calendar; off = dry run — nothing is sent and nothing changes in Proton, the emails that would have gone out are listed on the Overview and in `bridge.log`. While it is off, the Emails card in Settings says so. The old *test* mode (emails only to an allowlist, anything else refused) still exists for the live tests but is no longer in the window: `invitationEmailMode: "test"` and `invitationEmailAllowlist` in the account's `config.json`.
- Not in the window any more (1.0.4), still in the code: `applyEmailedAnswers: true` in the account's `config.json` makes the bridge read guests' emailed answers itself, as a safety net for the case that Proton does not record one; tested and not needed in practice (see [BEHAVIOUR.md](BEHAVIOUR.md#answers-from-guests-outside-proton)).
- **Detailed logging**: `bridge.log` with titles, addresses, subjects and email texts, for 24 hours or until switched off; "Delete the Logs" afterwards.
- Request statistics and the sync passes of the last hour.
