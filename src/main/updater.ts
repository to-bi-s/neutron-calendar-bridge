/**
 * 1.0.2: automatic updates from the GitHub Releases of the public repository (electron-updater).
 *
 * The installed app checks once a minute after starting and then once a day (Settings → General →
 * "Check for updates automatically", default on; off: only the button on Info checks), downloads a
 * newer version in the background and installs it when you click "Restart to Update" — or at the
 * next quit. The check asks github.com for the release feed and `latest-mac.yml`; nothing about you
 * is sent (the request carries the app's name and version, as every download does). An unpackaged
 * run (`npm start`) checks nothing: there is nothing to update.
 *
 * What the window and the menu show comes from `UpdateState`; `onChange` tells main.ts to refresh them.
 */
import { app } from 'electron';
import { autoUpdater } from 'electron-updater';
import type { UpdateInfo } from 'electron-updater';

import type { UpdateState, UpdateStatus } from '../shared/types';

/** The first check after starting, and the time between checks while the app runs. */
const FIRST_CHECK_DELAY_MS = 60_000;
const CHECK_EVERY_MS = 24 * 60 * 60 * 1000;
/** The release page of a version (the release notes live there). */
export const releasePageUrl = (version: string) => `https://github.com/to-bi-s/neutron-calendar-bridge/releases/tag/v${version}`;

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

export class Updater {
    private state: UpdateState = {
        status: app.isPackaged ? 'idle' : 'unsupported',
        version: null,
        percent: null,
        error: null,
        checkedAt: null,
        automatic: true
    };
    private timer: NodeJS.Timeout | null = null;
    private firstTimer: NodeJS.Timeout | null = null;
    private listening = false;
    /** The running check or download (a second click does not start another). */
    private inFlight: Promise<void> | null = null;

    constructor(private readonly onChange: () => void) {}

    getState(): UpdateState {
        return { ...this.state };
    }

    /** Starts the schedule (packaged app only); `automatic` is the setting, applied to the schedule. */
    start(automatic: boolean) {
        this.setAutomatic(automatic);
    }

    setAutomatic(automatic: boolean) {
        const changed = this.state.automatic !== automatic;
        this.state.automatic = automatic;
        this.stopSchedule();
        if (automatic && app.isPackaged) {
            this.firstTimer = setTimeout(() => {
                this.firstTimer = null;
                void this.check(false);
                this.timer = setInterval(() => void this.check(false), CHECK_EVERY_MS);
            }, FIRST_CHECK_DELAY_MS);
        }
        if (changed) {
            console.log(`[update] automatic checks: ${automatic ? 'on (a minute after starting, then daily)' : 'off (the button on Info only)'}`);
            this.onChange();
        }
    }

    stop() {
        this.stopSchedule();
    }

    /** Checks now; a manual check says "up to date" when it is, a scheduled one stays quiet. */
    async check(manual: boolean): Promise<UpdateState> {
        if (!app.isPackaged) {
            return this.getState();
        }
        if (this.inFlight) {
            await this.inFlight;
            return this.getState();
        }
        if (this.state.status === 'downloaded' || this.state.status === 'downloading') {
            return this.getState(); // the update is here or on its way: nothing to check
        }
        this.listen();
        this.set({ status: 'checking', error: null });
        console.log(`[update] checking for updates (${manual ? 'asked' : 'scheduled'}); this is ${app.getVersion()}`);
        this.inFlight = autoUpdater
            .checkForUpdates()
            .then(() => undefined)
            .catch((error) => {
                // The 'error' event has set the state; a lost connection on a scheduled check is not worth a red card.
                if (!manual && this.state.status === 'error') {
                    this.set({ status: 'idle' });
                }
                console.warn(`[update] the check failed: ${errorText(error)}`);
            })
            .finally(() => {
                this.inFlight = null;
            });
        await this.inFlight;
        return this.getState();
    }

    /** Installs the downloaded update: quits and starts the new version. */
    install() {
        if (this.state.status !== 'downloaded') {
            return false;
        }
        console.log(`[update] installing ${this.state.version ?? '?'} and restarting`);
        setImmediate(() => autoUpdater.quitAndInstall(false, true));
        return true;
    }

    private listen() {
        if (this.listening) {
            return;
        }
        this.listening = true;
        autoUpdater.autoDownload = true;
        autoUpdater.autoInstallOnAppQuit = true;
        autoUpdater.allowPrerelease = false;
        autoUpdater.allowDowngrade = false;
        // The app's own log (bridge.log) rather than electron-log; only what happens, never a token.
        autoUpdater.logger = {
            info: (message: unknown) => console.log(`[update] ${String(message)}`),
            warn: (message: unknown) => console.warn(`[update] ${String(message)}`),
            error: (message: unknown) => console.warn(`[update] ${String(message)}`),
            debug: () => undefined
        };
        autoUpdater.on('checking-for-update', () => this.set({ status: 'checking' }));
        autoUpdater.on('update-available', (info: UpdateInfo) => {
            console.log(`[update] ${info.version} is available; downloading`);
            this.set({ status: 'downloading', version: info.version, percent: 0, error: null, checkedAt: Date.now() });
        });
        autoUpdater.on('update-not-available', (info: UpdateInfo) => {
            console.log(`[update] up to date (newest: ${info.version})`);
            this.set({ status: 'up-to-date', version: null, percent: null, error: null, checkedAt: Date.now() });
        });
        autoUpdater.on('download-progress', (progress: { percent: number }) => {
            this.set({ status: 'downloading', percent: Math.max(0, Math.min(100, Math.round(progress.percent))) });
        });
        autoUpdater.on('update-downloaded', (info: UpdateInfo) => {
            console.log(`[update] ${info.version} downloaded; installed at "Restart to Update" or the next quit`);
            this.set({ status: 'downloaded', version: info.version, percent: 100, error: null });
        });
        autoUpdater.on('error', (error: Error) => {
            this.set({ status: 'error', error: errorText(error), checkedAt: Date.now() });
        });
    }

    private set(patch: Partial<UpdateState>) {
        const next = { ...this.state, ...patch };
        const changed = (Object.keys(next) as Array<keyof UpdateState>).some((key) => next[key] !== this.state[key]);
        this.state = next;
        if (changed) {
            this.onChange();
        }
    }

    private stopSchedule() {
        if (this.firstTimer) {
            clearTimeout(this.firstTimer);
            this.firstTimer = null;
        }
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
    }
}

export type { UpdateState, UpdateStatus };
