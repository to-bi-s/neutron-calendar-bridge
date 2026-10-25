import { app, BrowserWindow, Menu, Notification, Tray, clipboard, ipcMain, nativeImage, dialog, nativeTheme, powerMonitor, shell } from 'electron';
import type { MenuItemConstructorOptions } from 'electron';
import { chmodSync, createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, WriteStream } from 'node:fs';
import { join } from 'node:path';
import { format } from 'node:util';

import type { BridgeNotification, BridgeService } from './bridge-service';
import { AccountManager } from './accounts';
import { trayMenuItems, trayOverallStatus, webCalendarUrl } from './tray-menu';
import type { TrayAction, TrayAppState, TrayMenuItem, TrayPage } from './tray-menu';
import { CalDAVServer } from './caldav-server';
import { createNotificationCenter } from './notification-center';
import { deleteLogFiles, removeOldLogsOnce } from './log-files';
import { logLine } from './private-log';
import { logPrefix } from './account-context';
import type { BridgeAppState } from '../shared/types';
import { PROFILE_FILE_NAME } from './caldav-profile';
import { catalogFor, currentLanguage, resolveLanguage, setLanguage, t, tn } from './i18n';
import { Updater } from './updater';
import type { CalendarAppSetupResult } from '../shared/types';

/** The name people see (menus, window, Dock, About, notifications). */
const APP_DISPLAY_NAME = 'Neutron Calendar Bridge';
const APP_SUBTITLE = 'Bridge for Proton Calendar';
/**
 * The name Electron files things under: the data folder (~/Library/Application Support/…), the log
 * folder (~/Library/Logs/…) and the Keychain item that encrypts the saved login and the local
 * CalDAV password. Changing it would come up as a fresh install (signed out, empty local copy).
 */
const INTERNAL_APP_NAME = 'neutron-calendar-bridge';
app.setName(INTERNAL_APP_NAME);

let mainWindow: BrowserWindow | null = null;
let verificationWindow: BrowserWindow | null = null;
/** 0.44.1: the verification window is still loading Proton's page (shown with a note meanwhile). */
let verificationLoading = false;
/** Proton's account page for a sign-in through it (0.28); one at a time. */
let tray: Tray | null = null;
/** What the menu-bar menu was last built from (rebuilt only when it changes). */
let trayMenuKey: string | null = '';
/** The items the native menu was last built from: what an open menu shows (updated in place by the spinner module). */
let lastTrayItems: TrayMenuItem[] = [];
/**
 * The spinning sync symbol (0.32.4): a small native module turns the account line's symbol while
 * the menu-bar menu is open, and updates an item of the open menu when a sync starts or ends
 * (Electron's setContextMenu only takes effect the next time the menu opens). A no-op without the
 * build (another platform, no Xcode tools): the symbol then simply stays still.
 */
type MenuImageReps = [Buffer, Buffer | null];
interface MenuSpinner {
    supported: boolean;
    error?: string | null;
    /** 0.45.2: with `set`, a further set of frames an item can turn with (an older build ignores it). */
    setFrames(frames: MenuImageReps[], intervalMs: number, set?: string): number;
    /** 0.45.2: `sets`, in the order of `indexes`, the frame set each item turns with ('' = the default). */
    setSpinning(indexes: number | number[], sets?: string[]): void;
    /** reps null: the item gets no image; undefined: its image stays. */
    updateItem(index: number, title: string, reps: MenuImageReps | null | undefined, enabled: boolean): void;
    /** 0.37.12: the items whose click keeps the menu open (drawn by the module), and their row geometry in points. */
    setKeepOpen(indexes: number[], metrics?: Partial<MenuRowMetrics>): void;
    isTracking(): boolean;
}
interface MenuRowMetrics {
    rowHeight: number;
    imageX: number;
    textX: number;
    keyRightInset: number;
    highlightInsetX: number;
    highlightInsetY: number;
    cornerRadius: number;
}
/** The geometry of a drawn menu row (0.37.12), matched to macOS's own rows by eye; NEUTRON_MENU_ROW="rowHeight=22,textX=36" overrides for trying values. */
const menuRowMetrics = (): Partial<MenuRowMetrics> => {
    const metrics: Partial<MenuRowMetrics> = { rowHeight: 22, imageX: 12, textX: 36, keyRightInset: 14, highlightInsetX: 5, highlightInsetY: 0, cornerRadius: 5 };
    for (const pair of (process.env.NEUTRON_MENU_ROW || '').split(',')) {
        const [key, value] = pair.split('=');
        if (key && key.trim() in metrics && Number.isFinite(Number(value))) {
            metrics[key.trim() as keyof MenuRowMetrics] = Number(value);
        }
    }
    return metrics;
};
// eslint-disable-next-line @typescript-eslint/no-require-imports
const menuSpinner = require(join(__dirname, '..', '..', 'native', 'menu-spinner')) as MenuSpinner;
const SPINNER_FRAMES = 12;
/** A menu built while the menu-bar menu was open: installed once it closes (installing it earlier would close it). */
let pendingTrayMenu: Menu | null = null;
let pendingTrayMenuTimer: NodeJS.Timeout | null = null;
let trayRefreshTimer: NodeJS.Timeout | null = null;
let isQuitting = false;
/** 0.36: the accounts (one BridgeService each), in their order. */
let accounts: AccountManager | null = null;
let caldavServer: CalDAVServer | null = null;
/** 1.0.2: updates from GitHub Releases; created with the window and the menu so both can show its state. */
let updater: Updater | null = null;
/** The app state with the updater's part (what the window gets). */
const appStateWithUpdate = async (state: Promise<BridgeAppState> | BridgeAppState): Promise<BridgeAppState> => ({ ...(await state), ...(updater ? { update: updater.getState() } : {}) });
/** How many accounts the application menu was built for ("Refresh Now" / "Refresh All Accounts"). */
let menuAccountCount = -1;
let completingVerification = false;

/** Page background for the effective theme, used before the renderer has painted. */
const windowBackground = () => (nativeTheme.shouldUseDarkColors ? '#15131c' : '#f6f4ff');

/**
 * The app's language (0.32): the setting, or macOS's language when it is one of ours. Everything
 * produced from now on (menus, notifications, status texts) is in it; the window asks for the
 * catalog and translates itself; the menus are built again.
 */
const applyLanguage = (choice: string) => {
    setLanguage(resolveLanguage(choice, app.getLocale()));
    trayMenuKey = null; // built again in the new language
    setApplicationMenu();
    void refreshTrayMenu();
};

/** Applies the Appearance setting to Electron, which drives nativeTheme and the prefers-color-scheme media query. */
const applyThemeSource = (theme: 'system' | 'light' | 'dark') => {
    nativeTheme.themeSource = theme;
};

const PANEL_WIDTH = 420;
const PANEL_HEIGHT = 640;

const VERIFICATION_MESSAGE_PREFIX = '__BRIDGE_VERIFY_MESSAGE__';

const MAX_LOG_BYTES = 5 * 1024 * 1024;

/** Yours only: 0600 for files, 0700 for folders (also ones made before with other permissions). */
const restrict = (path: string, mode = 0o600) => {
    try {
        if (existsSync(path)) {
            chmodSync(path, mode);
        }
    } catch (error) {
        console.warn(`[app] could not restrict the permissions of ${path}: ${error instanceof Error ? error.message : String(error)}`);
    }
};

/**
 * Mirrors console output to ~/Library/Logs/<app name>/bridge.log (previous file kept as
 * bridge.log.1), so failed Calendar.app requests can be traced after the fact. Quiet by default
 * (no titles, addresses, subjects, email text or calendar files; see private-log.ts); readable by
 * you only.
 */
const setupFileLogging = () => {
    const logDir = app.getPath('logs');
    mkdirSync(logDir, { recursive: true, mode: 0o700 });
    restrict(logDir, 0o700);
    const logFile = join(logDir, 'bridge.log');
    // The logs from before 0.24 held titles, addresses and email text: deleted once.
    const oldLogsDeleted = removeOldLogsOnce(logDir);
    let stream: WriteStream | null = null;
    let written = 0;

    const open = () => {
        if (existsSync(logFile) && statSync(logFile).size > MAX_LOG_BYTES) {
            renameSync(logFile, `${logFile}.1`);
        }
        written = existsSync(logFile) ? statSync(logFile).size : 0;
        const next = createWriteStream(logFile, { flags: 'a', mode: 0o600 });
        restrict(logFile);
        restrict(`${logFile}.1`);
        next.on('error', () => {
            if (stream === next) {
                stream = null; // only this stream: a newer one (after a rotation or "Delete the Logs") keeps going
            }
        });
        stream = next;
    };
    open();

    for (const level of ['log', 'warn', 'error'] as const) {
        const original = console[level].bind(console);
        console[level] = (...args: unknown[]) => {
            // Quiet unless detailed logging is on (private-log.ts): the terminal shows the same.
            // 0.36.4: lines from an account's service carry its tag ("[a:3f9a] …").
            const text = `${logPrefix()}${logLine(format(...args))}`;
            original(text);
            if (!stream) {
                return;
            }
            const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${text}\n`;
            stream.write(line);
            written += Buffer.byteLength(line);
            if (written > MAX_LOG_BYTES) {
                stream.end();
                stream = null;
                open();
            }
        };
    }

    process.on('unhandledRejection', (reason) => {
        console.error('[app] unhandled promise rejection:', reason);
    });

    /** Developer settings → "Delete the Logs": bridge.log and bridge.log.1 removed, a new bridge.log started. */
    const deleteLogs = () => {
        stream?.end();
        stream = null;
        deleteLogFiles(logDir);
        open();
    };

    return { logFile, oldLogsDeleted, deleteLogs };
};

let fileLogging: ReturnType<typeof setupFileLogging> | null = null;

/** The CalDAV password copied from the Setup page: removed from the clipboard after 90 s or at quit, if still there. */
/**
 * One-click Calendar.app setup (0.30): the configuration profile is written to the app's folder
 * (yours only) and handed to macOS, which shows it in System Settings for you to install. The file
 * holds the CalDAV password, so it is removed again a few minutes later, at quit, and at the next
 * start (System Settings keeps its own copy from the moment the file was opened).
 */
const PROFILE_REMOVAL_MS = 5 * 60_000;
let profileRemovalTimer: NodeJS.Timeout | null = null;
const profileFolder = () => join(app.getPath('userData'), 'calendar-app-setup');
const removeProfileFile = () => {
    if (profileRemovalTimer) {
        clearTimeout(profileRemovalTimer);
        profileRemovalTimer = null;
    }
    try {
        rmSync(profileFolder(), { recursive: true, force: true });
    } catch (error) {
        console.warn(`[setup] could not remove the Calendar.app profile file: ${error instanceof Error ? error.message : String(error)}`);
    }
};
const setUpCalendarApp = async (accountId: string): Promise<CalendarAppSetupResult> => {
    if (!accounts) {
        return { opened: false, error: t('The bridge is not started yet.') };
    }
    try {
        const profile = accounts.serviceOf(accountId).getCalDAVProfile();
        removeProfileFile();
        const folder = profileFolder();
        mkdirSync(folder, { recursive: true, mode: 0o700 });
        chmodSync(folder, 0o700);
        const file = join(folder, PROFILE_FILE_NAME);
        writeFileSync(file, profile, { mode: 0o600 });
        chmodSync(file, 0o600);
        const problem = await shell.openPath(file);
        profileRemovalTimer = setTimeout(removeProfileFile, PROFILE_REMOVAL_MS);
        profileRemovalTimer.unref?.();
        if (problem) {
            console.warn(`[setup] macOS did not take the Calendar.app profile: ${problem}`);
            return { opened: false, error: problem };
        }
        console.log('[setup] the Calendar.app profile was handed to System Settings');
        return { opened: true, error: null };
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`[setup] Calendar.app profile: ${message}`);
        return { opened: false, error: message };
    }
};
/** System Settings → Profiles (General → Device Management on macOS 15 and later). */
const openProfilesSettings = () => shell.openExternal('x-apple.systempreferences:com.apple.Profiles-Settings.extension');

let copiedPassword: string | null = null;
const clearCopiedPassword = () => {
    if (copiedPassword && clipboard.readText() === copiedPassword) {
        clipboard.clear();
    }
    copiedPassword = null;
};

const iconPath = (...parts: string[]) => join(__dirname, '..', '..', 'resources', 'icons', ...parts);

/**
 * The menu-bar icon: always the same one (menu-bar-icon.png, @2x picked up by macOS). A template
 * image, so macOS draws it dark or light to match the menu bar like its own icons.
 */
const createTrayIcon = () => {
    const image = nativeImage.createFromPath(iconPath('menu-bar-icon.png'));
    image.setTemplateImage(true);
    return image;
};

/** macOS notifications: grouped, deduplicated, a click opens the page (see notification-center.ts). */
const notificationCenter = createNotificationCenter({
    appName: APP_DISPLAY_NAME,
    create: (content) => new Notification(content),
    open: (page, accountId) => void openBridge(page, accountId ?? null)
});

const showNotification = (note: BridgeNotification) => {
    if (Notification.isSupported()) {
        notificationCenter.show(note);
    }
};

/** Coloured status symbols in the menu (resources/icons/menu, with @2x). */
const menuIconPath = (name: string) => iconPath('menu', `${name}.png`);
const menuIcon = (name: string) => nativeImage.createFromPath(menuIconPath(name));
/** The PNG bytes (1x and @2x) for the spinner module: read here, since inside app.asar they are not files Cocoa can open. */
const menuImageReps = (path: string): MenuImageReps => {
    const read = (file: string) => {
        try {
            return readFileSync(file);
        } catch {
            return null;
        }
    };
    return [read(path) ?? Buffer.alloc(0), read(path.replace(/\.png$/, '@2x.png'))];
};

/**
 * Dock icon only while one of the app's windows is open (the app is a menu-bar app otherwise;
 * Info.plist has LSUIElement). With the icon the app is also in Cmd-Tab and has its menu (Cmd-Q).
 */
const updateDockVisibility = () => {
    if (process.platform !== 'darwin' || !app.dock) {
        return;
    }
    const windowOpen = BrowserWindow.getAllWindows().some((window) => !window.isDestroyed() && window.isVisible());
    if (windowOpen) {
        void app.dock.show();
    } else {
        app.dock.hide();
    }
};

/** Shows a window in front of other apps (a menu-bar app is not brought forward by show() alone). */
const revealWindow = async (window: BrowserWindow) => {
    if (process.platform === 'darwin' && app.dock) {
        // Become a regular app first; switching while the window is up can push it behind others.
        await app.dock.show();
    }
    if (window.isMinimized()) {
        window.restore();
    }
    window.show();
    app.focus({ steal: true });
    window.focus();
};

const ensureWindow = async () => {
    if (mainWindow) {
        return mainWindow;
    }

    mainWindow = new BrowserWindow({
        width: 1060,
        height: 720,
        minWidth: 820,
        minHeight: 560,
        show: false,
        backgroundColor: windowBackground(),
        titleBarStyle: 'hiddenInset',
        trafficLightPosition: { x: 16, y: 18 },
        title: APP_DISPLAY_NAME,
        webPreferences: {
            preload: join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false
        }
    });

    await mainWindow.loadFile(join(__dirname, '..', 'renderer', 'index.html'));

    mainWindow.on('close', (event) => {
        if (isQuitting) {
            return;
        }
        event.preventDefault();
        mainWindow?.hide();
        // 0.38.2: closing the window while "Add Account" is open means "not now": the account being
        // added is dropped, so the next opening shows the accounts.
        if (accounts?.isAddingAccount()) {
            void accounts.cancelAddAccount().catch((error) => console.warn(`[accounts] cancelling Add Account on close: ${error instanceof Error ? error.message : String(error)}`));
        }
    });

    mainWindow.on('closed', () => {
        mainWindow = null;
        updateDockVisibility();
    });
    mainWindow.on('show', updateDockVisibility);
    mainWindow.on('hide', updateDockVisibility);

    return mainWindow;
};

/** Launch, opening the app again, clicking the Dock icon: always show, never hide. */
const showWindow = async () => {
    const window = await ensureWindow();
    if (!window.isVisible()) {
        window.center();
    }
    await revealWindow(window);
    return window;
};

/** Opens the window on one of its pages (menu-bar menu, app menu; 0.36: for an account). */
const openBridge = async (page: TrayPage, accountId: string | null = null) => {
    const window = await showWindow();
    window.webContents.send('bridge:navigate', page, accountId);
};

/**
 * Web Calendar: Proton Calendar in the browser (what Help used to do). 0.39: for an account (its
 * address as Proton's account-picker hint); the View menu's entry opens the first account's, the Help
 * menu's the plain web calendar.
 */
const openWebCalendar = (accountId: string | null | 'first' = null) => {
    const service = accountId === 'first' ? accounts?.list()[0] : accountId ? accounts?.byId(accountId)?.service : null;
    let address: string | null = null;
    try {
        address = service?.accountLabel() ?? null;
    } catch {
        address = null;
    }
    return shell.openExternal(webCalendarUrl(address));
};

/** Refresh now (menu-bar menu, View menu, Cmd-R): the Refresh button's pass — one account, or all (null). */
const syncNowFromMenu = async (accountId: string | null = null) => {
    if (!accounts) {
        return;
    }
    try {
        await accounts.refreshNow(accountId);
    } catch (error) {
        console.warn(`[sync] sync now: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
        await refreshTrayMenu();
    }
};

const runTrayAction = (action: TrayAction) => {
    if (action === 'quit') {
        app.quit();
    } else if (action === 'install-update') {
        if (!updater?.install()) {
            void openBridge('info', null);
        }
    } else if (action === 'web') {
        void openWebCalendar();
    } else if ('web' in action) {
        void openWebCalendar(action.web);
    } else if ('sync' in action) {
        // 0.37.12 (Tobi): Refresh Now keeps the menu up — the native module draws those rows itself
        // (an item with a view is the one thing macOS does not dismiss). Without the module (another
        // platform) the menu closes as any menu does.
        void syncNowFromMenu(action.sync);
    } else {
        void openBridge(action.open, action.account ?? null);
    }
};

const buildCaptchaIframeUrl = (token: string, dark: boolean) => {
    const url = new URL('/core/v4/captcha', 'https://mail-api.proton.me');
    url.searchParams.set('Token', token);
    url.searchParams.set('ForceWebMessaging', '1');
    if (dark) {
        url.searchParams.set('Dark', 'true'); // 0.49.11: as Proton's web app asks for its dark CAPTCHA (Captcha.tsx)
    }
    return url.toString();
};

const escapeForTemplate = (value: string) =>
    value.replaceAll('\\', '\\\\').replaceAll('`', '\\`').replaceAll('${', '\\${');

const renderVerificationHostPage = async (window: BrowserWindow, token: string) => {
    // 0.49.10: the page around Proton's verification follows the app's appearance, its texts the app's language;
    // 0.49.11: Proton's frame inside is asked for its dark version too.
    const dark = nativeTheme.shouldUseDarkColors;
    const iframeUrl = buildCaptchaIframeUrl(token, dark);
    const escapedIframeUrl = escapeForTemplate(iframeUrl);
    const texts = { title: escapeForTemplate(t('Proton Verification')), kicker: escapeForTemplate(t('Human verification')), heading: escapeForTemplate(t('Finish sign-in')), copy: escapeForTemplate(t("Complete Proton's verification step below. The bridge will finish signing in automatically.")) };
    await window.webContents.executeJavaScript(
        `
        document.open();
        document.write(\`
            <!doctype html>
            <html lang="en">
            <head>
                <meta charset="utf-8" />
                <meta name="viewport" content="width=device-width, initial-scale=1" />
                <title>${texts.title}</title>
                <style>
                    :root { color-scheme: ${dark ? 'dark' : 'light'}; }
                    body {
                        margin: 0;
                        font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
                        background: ${dark ? 'linear-gradient(180deg, #1c1b22 0%, #15131c 100%)' : 'linear-gradient(180deg, #faf9ff 0%, #f6f4ff 100%)'};
                        color: ${dark ? '#e8e6f0' : '#262a33'};
                    }
                    .shell {
                        min-height: 100vh;
                        display: grid;
                        place-items: center;
                        padding: 28px;
                    }
                    .card {
                        width: min(780px, calc(100vw - 56px));
                        border-radius: 24px;
                        background: ${dark ? '#1f1d27' : '#ffffff'};
                        border: 1px solid ${dark ? 'rgba(170, 150, 255, 0.16)' : 'rgba(110, 89, 202, 0.14)'};
                        box-shadow: 0 24px 60px rgba(${dark ? '0, 0, 0, 0.45' : '39, 21, 92, 0.12'});
                        padding: 24px;
                    }
                    .kicker {
                        margin: 0 0 8px;
                        font-size: 11px;
                        font-weight: 700;
                        letter-spacing: 0.14em;
                        text-transform: uppercase;
                        color: ${dark ? '#9f94c9' : '#7c72a0'};
                    }
                    h1 {
                        margin: 0;
                        font-size: 34px;
                        line-height: 1.05;
                        letter-spacing: -0.03em;
                    }
                    p {
                        margin: 12px 0 0;
                        color: ${dark ? '#b3b0c4' : '#5b6070'};
                        line-height: 1.6;
                    }
                    iframe {
                        width: 100%;
                        min-height: 560px;
                        margin-top: 20px;
                        border: 0;
                        border-radius: 18px;
                        background: ${dark ? '#26242f' : '#ffffff'};
                    }
                </style>
            </head>
            <body>
                <main class="shell">
                    <section class="card">
                        <p class="kicker">${texts.kicker}</p>
                        <h1>${texts.heading}</h1>
                        <p>${texts.copy}</p>
                        <iframe
                            id="captcha-frame"
                            title="Proton verification"
                            sandbox="allow-scripts allow-same-origin allow-popups"
                            src="${escapedIframeUrl}"
                        ></iframe>
                    </section>
                </main>
            </body>
            </html>
        \`);
        document.close();
        `,
        true
    );

    await window.webContents.executeJavaScript(
        `
        (() => {
            const normalizeMessageData = (data) => {
                if (typeof data !== 'string') {
                    return data;
                }
                try {
                    return JSON.parse(data);
                } catch {
                    return data;
                }
            };

            if (window.__bridgeVerificationListenerInstalled) {
                return;
            }

            window.__bridgeVerificationListenerInstalled = true;
            window.addEventListener('message', (event) => {
                const data = normalizeMessageData(event.data);
                if (!data || typeof data !== 'object') {
                    return;
                }

                if (!data.type) {
                    return;
                }

                console.log('${VERIFICATION_MESSAGE_PREFIX}' + JSON.stringify({
                    origin: event.origin,
                    data
                }));
            });
        })();
        `,
        true
    );
};

/** 0.36: the account Proton asks to verify: one restoring its session, else the one being signed in. */
const verifyingService = (): BridgeService | null =>
    accounts ? (accounts.list().find((service) => service.getPendingHumanVerification()) ?? accounts.pendingService()) : null;

const openVerificationWindow = async () => {
    const service = verifyingService();
    if (!service) {
        throw new Error('Bridge service is not ready');
    }

    const challenge = service.getPendingHumanVerification();
    if (!challenge) {
        throw new Error('There is no pending verification challenge.');
    }

    if (verificationWindow && !verificationWindow.isDestroyed()) {
        verificationWindow.show();
        verificationWindow.focus();
        if (!verificationLoading) {
            // (Still loading Proton's page: the first call puts the CAPTCHA in when it is there.)
            await renderVerificationHostPage(verificationWindow, challenge.token);
        }
        return;
    }

    verificationWindow = new BrowserWindow({
        width: 860,
        height: 820,
        minWidth: 760,
        minHeight: 680,
        show: false,
        title: t('Proton Verification'),
        backgroundColor: windowBackground(),
        parent: mainWindow ?? undefined,
        modal: false,
        webPreferences: {
            preload: join(__dirname, 'verification-preload.js'),
            contextIsolation: true,
            nodeIntegration: false
        }
    });

    verificationWindow.webContents.on('console-message', async (event) => {
        // 0.50.3: the message from the event object (Electron deprecates the positional arguments).
        const message = event.message;
        const verifying = verifyingService();
        if (typeof message !== 'string' || !message.startsWith(VERIFICATION_MESSAGE_PREFIX) || !verifying || completingVerification) {
            return;
        }

        try {
            const payload = JSON.parse(message.slice(VERIFICATION_MESSAGE_PREFIX.length));
            const data = payload?.data;
            if (data?.type === 'pm_height' && Number.isFinite(data.height)) {
                const [currentWidth] = verificationWindow?.getSize() || [860];
                const nextHeight = Math.max(720, Math.min(1000, Math.ceil(Number(data.height)) + 300));
                verificationWindow?.setSize(currentWidth, nextHeight);
                return;
            }

            if (data?.type !== 'pm_captcha' || typeof data.token !== 'string') {
                return;
            }

            completingVerification = true;
            // 0.49.11: the window has done its part once Proton's token is here; it closes at once instead of
            // showing "Verification completed" while the sign-in finishes (a failure is told in a dialog).
            verificationWindow?.close();
            await verifying.completeHumanVerification({
                token: data.token,
                tokenType: 'captcha'
            });
            await refreshTrayMenu();
        } catch (error) {
            await refreshTrayMenu();
            dialog.showErrorBox(
                t('Verification Error'),
                error instanceof Error ? error.message : t('Proton verification failed')
            );
        } finally {
            completingVerification = false;
        }
    });

    verificationWindow.on('closed', () => {
        verificationWindow = null;
        verificationLoading = false;
        updateDockVisibility();
    });
    verificationWindow.on('show', updateDockVisibility);
    verificationWindow.on('hide', updateDockVisibility);

    // 0.44.1: shown at once with a note while Proton's page loads (Proton Mail's web app, for the
    // CAPTCHA's origin: that took long enough to look as if nothing happened).
    const dark = nativeTheme.shouldUseDarkColors;
    const loading = `<!doctype html><html><head><meta charset="utf-8"><title>${t('Proton Verification')}</title><style>
        body{margin:0;height:100vh;display:grid;place-items:center;font-family:-apple-system,BlinkMacSystemFont,sans-serif;
        background:${dark ? '#1c1b22' : '#f6f4ff'};color:${dark ? '#e8e6f0' : '#262a33'}}
        .spin{width:28px;height:28px;margin:0 auto 14px;border-radius:50%;border:3px solid rgba(110,89,202,.25);border-top-color:#6d4aff;animation:r 0.9s linear infinite}
        @keyframes r{to{transform:rotate(360deg)}}</style></head>
        <body><div><div class="spin"></div>${t('Loading Proton\'s verification…')}</div></body></html>`;
    const opened = verificationWindow;
    verificationLoading = true;
    const gone = () => opened.isDestroyed() || verificationWindow !== opened;
    await opened.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(loading)}`);
    if (gone()) return void (verificationLoading = false); // closed while loading
    opened.show();
    try {
        await opened.loadURL('https://mail.proton.me');
    } catch (error) {
        verificationLoading = false;
        if (gone()) return;
        throw error;
    }
    if (gone()) return void (verificationLoading = false);
    await renderVerificationHostPage(opened, challenge.token);
    verificationLoading = false;
    opened.focus();
};

const gotLock = app.requestSingleInstanceLock();

if (!gotLock) {
    app.quit();
} else {
    app.on('second-instance', () => {
        void showWindow();
    });
}

/** The frames of one spinner set (resources/icons/menu/<folder>/frame-NN.png). */
const spinnerFrames = (folder: 'spinner' | 'spinner-warning' | 'spinner-initial') =>
    Array.from({ length: SPINNER_FRAMES }, (_, index) => menuImageReps(iconPath('menu', folder, `frame-${String(index).padStart(2, '0')}.png`)));

/**
 * The state the menu shows: "Connecting…" until the list of accounts is read. 0.46: from then on every
 * account has its line, with what it is doing (restoring its login, its first pass…), instead of
 * waiting until all of them have signed in and synced.
 */
const currentTrayState = (): TrayAppState | null => (accounts?.isLoaded() ? { ...accounts.getTrayState(), update: updater?.getState() ?? null } : null);

/** Menu-bar icon with its menu; left and right click both open the menu (like Proton Mail Bridge). */
const ensureTray = () => {
    if (!tray) {
        tray = new Tray(createTrayIcon());
        trayMenuKey = '';
        if (menuSpinner.supported) {
            // 0.45.2: the yellow set by name first, then the green default: a build without named sets
            // takes each as the default, so it ends with the green one (and turns every line green).
            menuSpinner.setFrames(spinnerFrames('spinner-warning'), 1000 / SPINNER_FRAMES, 'warning');
            menuSpinner.setFrames(spinnerFrames('spinner-initial'), 1000 / SPINNER_FRAMES, 'initial'); // 0.46: blue, the first pass after starting
            const loaded = menuSpinner.setFrames(spinnerFrames('spinner'), 1000 / SPINNER_FRAMES);
            console.log(`[tray] spinning sync symbol: ${loaded} frames (and a yellow and a blue set)`);
        } else {
            console.log(`[tray] spinning sync symbol not available${menuSpinner.error ? ` (${menuSpinner.error})` : ''}: the symbol stays still`);
        }
    }
    void refreshTrayMenu();
};

const refreshTrayMenu = async () => {
    if (!tray) {
        return;
    }
    const state = currentTrayState();
    const message = state ? (state.accounts.length ? state.accounts.map((account) => (state.accounts.length > 1 && account.username ? `${account.username}: ${account.message}` : account.message)).filter(Boolean).join('\n') : state.signingIn?.message) : trayOverallStatus(null).label;
    tray.setToolTip(`${APP_DISPLAY_NAME} v${app.getVersion()}${message ? ` — ${message}` : ''}`);
    if (accounts && accounts.count() !== menuAccountCount) {
        setApplicationMenu(); // "Refresh Now" / "Refresh All Accounts"
    }
    const items = trayMenuItems(state);
    const key = JSON.stringify(items);
    if (key === trayMenuKey) {
        return;
    }
    trayMenuKey = key;
    // The menu may be open right now: change its items in place (same layout only — a different
    // number of items means a different menu, which the next opening shows).
    if (menuSpinner.isTracking() && lastTrayItems.length === items.length) {
        items.forEach((item, index) => {
            const before = lastTrayItems[index];
            if (item.type !== 'item' || before.type !== 'item') {
                return;
            }
            if (item.label !== before.label || item.icon !== before.icon || (item.enabled ?? true) !== (before.enabled ?? true)) {
                menuSpinner.updateItem(index, item.label, item.icon === before.icon ? undefined : item.icon ? menuImageReps(menuIconPath(item.icon)) : null, item.enabled ?? true);
            }
        });
    }
    lastTrayItems = items;
    // 0.37.15: every syncing account's line turns, not only the first. 0.45.2: each in its own colour —
    // yellow while that account also needs attention, green otherwise.
    // 0.46: and blue during an account's first pass after the app started.
    const spinnerSets: Record<string, string> = { 'account-syncing': '', 'account-syncing-warning': 'warning', 'account-syncing-initial': 'initial' };
    const turning = items.map((item, index) => (item.type === 'item' && item.icon && item.icon in spinnerSets ? index : -1)).filter((index) => index >= 0);
    menuSpinner.setSpinning(
        turning,
        turning.map((index) => spinnerSets[(items[index] as { icon?: string }).icon ?? ''] ?? '')
    );
    menuSpinner.setKeepOpen(
        items.map((item, index) => (item.type === 'item' && typeof item.action === 'object' && 'sync' in item.action ? index : -1)).filter((index) => index >= 0),
        menuRowMetrics()
    );
    const menu = Menu.buildFromTemplate(
            items.map((item): MenuItemConstructorOptions =>
                item.type === 'separator'
                    ? { type: 'separator' }
                    : {
                          label: item.label,
                          icon: item.icon ? menuIcon(item.icon) : undefined,
                          accelerator: item.accelerator,
                          enabled: item.enabled ?? true,
                          click: () => runTrayAction(item.action)
                      }
            )
    );
    if (menuSpinner.isTracking()) {
        // Installing it now would close the open menu (Electron drops the old menu controller, whose
        // teardown cancels tracking): the open menu was updated in place above, this one waits.
        pendingTrayMenu = menu;
        pendingTrayMenuTimer ??= setInterval(installPendingTrayMenu, 200);
    } else {
        pendingTrayMenu = null;
        tray.setContextMenu(menu);
    }
};

const installPendingTrayMenu = () => {
    if (!pendingTrayMenu || !tray || menuSpinner.isTracking()) {
        return;
    }
    tray.setContextMenu(pendingTrayMenu);
    pendingTrayMenu = null;
    if (pendingTrayMenuTimer) {
        clearInterval(pendingTrayMenuTimer);
        pendingTrayMenuTimer = null;
    }
};

/**
 * The app's own menu (while its window is open): the menu-bar menu's shortcuts work here too.
 * Standard Edit / Window menus stay (copy and paste in the forms, Cmd-M); Cmd-W opens the web
 * calendar like in the menu-bar menu, so the window menu's Close has no shortcut.
 */
const setApplicationMenu = () => {
    if (process.platform !== 'darwin') {
        return;
    }
    menuAccountCount = accounts?.count() ?? -1;
    Menu.setApplicationMenu(
        Menu.buildFromTemplate([
            {
                label: APP_DISPLAY_NAME,
                submenu: [
                    { role: 'about', label: t('About {app}', { app: APP_DISPLAY_NAME }) },
                    { type: 'separator' },
                    { label: t('Settings…'), accelerator: 'CommandOrControl+,', click: () => void openBridge('settings') },
                    { type: 'separator' },
                    { role: 'services' },
                    { type: 'separator' },
                    { role: 'hide', label: t('Hide {app}', { app: APP_DISPLAY_NAME }) },
                    { role: 'hideOthers' },
                    { role: 'unhide' },
                    { type: 'separator' },
                    { label: t('Quit Bridge'), accelerator: 'CommandOrControl+Q', click: () => app.quit() }
                ]
            },
            { role: 'editMenu' },
            {
                label: t('View'),
                submenu: [
                    { label: t('Overview'), accelerator: 'CommandOrControl+F1', click: () => void openBridge('overview') },
                    { label: t('Calendars'), click: () => void openBridge('calendars') },
                    { label: t('Setup'), accelerator: 'CommandOrControl+U', click: () => void openBridge('setup') },
                    { label: t('Info'), accelerator: 'CommandOrControl+I', click: () => void openBridge('info') },
                    { type: 'separator' },
                    { label: (accounts?.count() ?? 1) > 1 ? t('Refresh All Accounts') : t('Refresh Now'), accelerator: 'CommandOrControl+R', click: () => void syncNowFromMenu(null) },
                    { label: t('Web Calendar'), accelerator: 'CommandOrControl+W', click: () => void openWebCalendar('first') },
                    { type: 'separator' },
                    { role: 'toggleDevTools' },
                    { type: 'separator' },
                    { role: 'togglefullscreen' }
                ]
            },
            {
                label: t('Window'),
                role: 'window',
                submenu: [
                    { role: 'minimize' },
                    { role: 'zoom' },
                    { label: t('Close Window'), click: (_item, window) => window?.close() },
                    { type: 'separator' },
                    { role: 'front' }
                ]
            },
            {
                role: 'help',
                submenu: [{ label: t('Proton Calendar on the Web'), click: () => void openWebCalendar() }]
            }
        ])
    );
};

const registerIpcHandlers = () => {
    const manager = () => {
        if (!accounts) {
            throw new Error('Bridge service is not ready');
        }
        return accounts;
    };
    /** A sign-in step: the result is the whole state (the menu follows). */
    const afterSignInStep = async (run: (manager: AccountManager) => Promise<unknown>) => {
        const current = manager();
        try {
            await run(current);
        } finally {
            await refreshTrayMenu();
        }
        return current.getAppState();
    };

    ipcMain.handle('bridge:sign-in', async (_event, credentials, accountId: string | null) => afterSignInStep(async (current) => (await current.signingIn(accountId)).signIn(credentials)));
    ipcMain.handle('bridge:complete-human-verification', async (_event, submission) =>
        afterSignInStep(async () => {
            const service = verifyingService();
            if (!service) {
                throw new Error('Bridge service is not ready');
            }
            await service.completeHumanVerification(submission);
        })
    );
    ipcMain.handle('bridge:answer-sign-in-prompt', async (_event, accountId: string | null, answer) => afterSignInStep(async (current) => (await current.signingIn(accountId)).answerSignInPrompt(answer)));
    ipcMain.handle('bridge:cancel-sign-in-prompt', async (_event, accountId: string | null) => afterSignInStep(async (current) => (await current.signingIn(accountId)).cancelSignInPrompt()));
    ipcMain.handle('bridge:cancel-human-verification', async () =>
        afterSignInStep(async () => {
            const service = verifyingService();
            if (!service) {
                throw new Error('Bridge service is not ready');
            }
            await service.cancelHumanVerification();
        })
    );
    // 0.36: accounts
    ipcMain.handle('bridge:add-account', async () => {
        manager().addAccount();
        return manager().getAppState();
    });
    ipcMain.handle('bridge:cancel-add-account', async () => {
        await manager().cancelAddAccount();
        return manager().getAppState();
    });
    ipcMain.handle('bridge:sign-out', async (_event, accountId: string) => afterSignInStep((current) => current.signOutAccount(String(accountId))));
    ipcMain.handle('bridge:remove-account', async (_event, accountId: string) => afterSignInStep((current) => current.removeAccount(String(accountId))));
    ipcMain.handle('bridge:set-account-order', async (_event, accountIds: unknown) => {
        manager().setOrder(Array.isArray(accountIds) ? accountIds.map(String) : []);
        await refreshTrayMenu();
        return manager().getAppState();
    });

    ipcMain.handle('bridge:get-state', async () => appStateWithUpdate(manager().getAppState()));
    ipcMain.handle('bridge:check-for-updates', async () => (updater ? updater.check(true) : null));
    ipcMain.handle('bridge:install-update', async () => Boolean(updater?.install()));
    ipcMain.handle('bridge:get-calendars', async (_event, accountId: string) => manager().serviceOf(accountId).getCalendars());
    ipcMain.handle('bridge:get-caldav-config', async (_event, accountId: string | null) => manager().serviceOf(accountId).getCalDAVConfig());
    ipcMain.handle('bridge:get-translations', async () => ({ language: currentLanguage(), catalog: catalogFor(currentLanguage()), locale: app.getLocale() }));
    ipcMain.handle('bridge:set-up-calendar-app', async (_event, accountId: string) => setUpCalendarApp(String(accountId)));
    ipcMain.handle('bridge:open-profiles-settings', async () => {
        await openProfilesSettings();
    });
    ipcMain.handle('bridge:refresh-now', async (_event, accountId: string | null) => {
        const status = await manager().refreshNow(accountId ? String(accountId) : null);
        await refreshTrayMenu();
        return status;
    });
    ipcMain.handle('bridge:set-open-at-login', async (_event, enabled: boolean) => {
        const current = manager();
        // App-wide: any account's service writes the shared setting and registers the login item.
        await current.serviceOf(null).setOpenAtLogin(enabled);
        await refreshTrayMenu();
        return current.getAppState();
    });
    ipcMain.handle('bridge:set-calendar-sync-enabled', async (_event, accountId: string, protonCalendarId: string, enabled: boolean) => {
        const current = manager();
        await current.serviceOf(accountId).setCalendarSyncEnabled(protonCalendarId, Boolean(enabled));
        await refreshTrayMenu();
        return current.getAppState();
    });
    ipcMain.handle('bridge:sync-calendar', async (_event, accountId: string, protonCalendarId: string) => {
        const current = manager();
        await current.serviceOf(accountId).syncCalendar(String(protonCalendarId || ''));
        return current.getAppState();
    });
    ipcMain.handle('bridge:sync-category', async (_event, accountId: string, kind: string) => {
        const current = manager();
        if (!['own', 'shared', 'subscribed', 'holidays'].includes(kind)) {
            throw new Error(`Unknown calendar group: ${kind}`);
        }
        await current.serviceOf(accountId).syncCategory(kind as 'own' | 'shared' | 'subscribed' | 'holidays');
        return current.getAppState();
    });
    ipcMain.handle('bridge:get-sync-status', async (_event, accountId: string) => manager().serviceOf(accountId).getSyncStatus());
    ipcMain.handle('bridge:update-config', async (_event, patch, accountId: string | null) => {
        const current = manager();
        const state = await current.updateConfig(patch, accountId);
        if (patch && typeof patch.theme === 'string') {
            applyThemeSource(current.getThemePreference());
        }
        if (patch && typeof patch.autoUpdate === 'boolean') {
            updater?.setAutomatic(patch.autoUpdate);
        }
        if (patch && typeof patch.appLanguage === 'string') {
            applyLanguage(current.getAppLanguagePreference());
            return appStateWithUpdate(current.getAppState()); // with the language now in use
        }
        return appStateWithUpdate(state);
    });
    ipcMain.handle('bridge:open-external', async (_event, url: unknown) => {
        // Only web links, and only ones the app itself put on the page.
        if (typeof url === 'string' && /^https:\/\/(github\.com|proton\.me|www\.gnu\.org)\//.test(url)) {
            await shell.openExternal(url);
        }
    });
    ipcMain.handle('bridge:delete-logs', async () => {
        if (!fileLogging) {
            throw new Error('File logging is not available.');
        }
        fileLogging.deleteLogs();
        console.log('[app] the logs were deleted (Developer settings); a new bridge.log is started');
    });

    // The CalDAV password to the clipboard, removed again after 90 s if it is still there (clipboard
    // managers may keep it anyway).
    ipcMain.handle('bridge:copy-caldav-password', async (_event, accountId: string) => {
        const { password } = manager().serviceOf(accountId).getCalDAVConfig();
        clipboard.writeText(password);
        copiedPassword = password;
        setTimeout(clearCopiedPassword, 90_000).unref?.();
    });

    ipcMain.handle('bridge:get-changelog', async () => {
        try {
            return readFileSync(join(app.getAppPath(), 'CHANGELOG.md'), 'utf8');
        } catch {
            return '';
        }
    });

    ipcMain.handle('bridge:open-human-verification', async () => {
        await openVerificationWindow();
    });
    ipcMain.on('bridge:captcha-height', (_event, height: number) => {
        if (!verificationWindow || verificationWindow.isDestroyed()) {
            return;
        }

        const [currentWidth] = verificationWindow.getSize();
        const nextHeight = Math.max(720, Math.min(1000, Math.ceil(height) + 300));
        verificationWindow.setSize(currentWidth, nextHeight);
    });

    ipcMain.on('bridge:captcha-solved', async (_event, submission) => {
        const verifying = verifyingService();
        if (!verifying || completingVerification) {
            return;
        }

        completingVerification = true;
        try {
            await verifying.completeHumanVerification(submission);
            verificationWindow?.close();
            await refreshTrayMenu();
            void mainWindow?.webContents.send('bridge:verification-complete');
        } catch (error) {
            await refreshTrayMenu();
            dialog.showErrorBox(
                t('Verification Error'),
                error instanceof Error ? error.message : t('Proton verification failed')
            );
        } finally {
            completingVerification = false;
        }
    });

    ipcMain.on('bridge:verification-debug', (_event, payload) => {
        console.log('[verification-debug]', JSON.stringify(payload));
    });
};

app.on('before-quit', () => {
    isQuitting = true;
    clearCopiedPassword();
    removeProfileFile();
});

if (gotLock) {
    app.whenReady()
        .then(async () => {
            // The app's folder (login, local copy, settings) is yours only.
            restrict(app.getPath('userData'), 0o700);
            removeProfileFile(); // a Calendar.app profile file left by a previous run
            try {
                fileLogging = setupFileLogging();
                console.log(`[app] ${APP_DISPLAY_NAME} ${app.getVersion()} starting; log: ${fileLogging.logFile}`);
                if (fileLogging.oldLogsDeleted) {
                    console.log('[app] the logs from before 0.24 (with titles, addresses and email text) were deleted; this log is quiet unless detailed logging is on');
                }
            } catch (error) {
                console.error('[app] file logging unavailable:', error);
            }
            // The menu-bar icon comes first, before signing in and the first sync.
            ensureTray();
            trayRefreshTimer = setInterval(() => {
                void refreshTrayMenu();
            }, 2_000);
            setApplicationMenu();
            app.setAboutPanelOptions({
                applicationName: APP_DISPLAY_NAME,
                applicationVersion: app.getVersion(),
                version: '',
                credits: `${APP_SUBTITLE}. Unofficial: not affiliated with or endorsed by Proton AG.`,
                copyright: 'Original work © 2026 Tactless Autist; modifications © 2026 Tobi. GPL-3.0-only.'
            });
            const manager = new AccountManager(app.getPath('userData'), {
                appVersion: app.getVersion(),
                onNotify: showNotification,
                // Syncing calendars, dots changing colour: the window and the menu follow right away.
                onStateChange: () => {
                    if (mainWindow && !mainWindow.isDestroyed()) {
                        mainWindow.webContents.send('bridge:state-changed');
                    }
                    void refreshTrayMenu();
                }
            });
            accounts = manager;
            // Back from sleep: sync now instead of at the next regular time.
            powerMonitor.on('resume', () => accounts?.handleSystemResume());
            applyThemeSource(manager.getThemePreference());
            applyLanguage(manager.getAppLanguagePreference());
            caldavServer = new CalDAVServer({ list: () => manager.list(), byUsername: (username) => manager.byUsername(username), any: () => manager.serviceOf(null), listenOn: () => manager.listenOn() });
            registerIpcHandlers();
            await manager.initialize();
            manager.refreshLoginItem();
            await caldavServer.start();

            await showWindow();
            await refreshTrayMenu();
            updater = new Updater(() => {
                if (mainWindow && !mainWindow.isDestroyed()) {
                    mainWindow.webContents.send('bridge:state-changed');
                }
                void refreshTrayMenu();
            });
            updater.start(manager.sharedConfig.load().autoUpdate);
        })
        .catch((error) => {
            dialog.showErrorBox(t('Startup Error'), error instanceof Error ? error.message : t('Unknown startup error'));
            app.quit();
        });
}

app.on('window-all-closed', () => {
    // Keep the tray app alive even when the window is hidden/closed.
});

// Opening the app while it runs, or clicking its Dock icon. (This used to toggle: macOS also sends
// it at launch and on re-open, which hid the window that had just been shown — hence "click twice".)
app.on('activate', () => {
    void showWindow();
});

app.on('will-quit', async () => {
    updater?.stop();
    if (pendingTrayMenuTimer) {
        clearInterval(pendingTrayMenuTimer);
        pendingTrayMenuTimer = null;
    }
    if (trayRefreshTimer) {
        clearInterval(trayRefreshTimer);
        trayRefreshTimer = null;
    }
    try {
        await caldavServer?.stop();
        await accounts?.shutdown();
    } catch (error) {
        dialog.showErrorBox(t('Shutdown Error'), error instanceof Error ? error.message : t('Unknown error'));
    }
});
