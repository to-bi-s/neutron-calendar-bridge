import type { BridgeNotification } from './bridge-service';

/** What main.ts needs of Electron's Notification (a fake in tests). */
export interface ShownNotification {
    on(event: 'click' | 'close', handler: () => void): unknown;
    show(): void;
    close(): void;
}

export interface NotificationCenterOptions {
    appName: string;
    create: (content: { title: string; subtitle?: string; body: string }) => ShownNotification;
    /** A click opens the bridge window on this page (0.36: for this account). */
    open: (page: BridgeNotification['page'], accountId?: string | null) => void;
    now?: () => number;
    schedule?: (run: () => void, ms: number) => unknown;
}

/** The same key within this long is shown once. */
const SAME_KEY_MS = 60_000;
/** At most this many one by one within BURST_MS; more are held and summed up. */
const ONE_BY_ONE = 3;
const BURST_MS = 10_000;
/** After a summary, the next one comes this much later at the earliest (a long stream: one every 30 s). */
const QUIET_AFTER_SUMMARY_MS = 30_000;
/** Notifications on screen kept referenced (or their click handler can be lost); the oldest are let go. */
const MAX_LIVE = 50;

/**
 * macOS notifications for what the bridge reports: the same key once a minute, more than three
 * within 10 s summed up in one (naming the page that shows the details), "connected again"
 * removing "cannot be reached" (BridgeNotification.replaces).
 */
export const createNotificationCenter = ({ appName, create, open, now = Date.now, schedule = setTimeout }: NotificationCenterOptions) => {
    const recent = new Map<string, number>();
    const live = new Map<string, ShownNotification>();
    let shownOneByOne: number[] = [];
    let held: BridgeNotification[] = [];
    let heldTimer: unknown = null;
    let quietUntil = 0;

    const present = (key: string, content: { title: string; subtitle?: string; body: string }, page: BridgeNotification['page'], accountId: string | null = null) => {
        const notification = create({ title: content.title, subtitle: content.subtitle, body: content.body });
        live.get(key)?.close();
        live.delete(key);
        live.set(key, notification);
        for (const oldest of live.keys()) {
            if (live.size <= MAX_LIVE) break;
            live.delete(oldest);
        }
        const forget = () => {
            if (live.get(key) === notification) live.delete(key);
        };
        notification.on('click', () => {
            forget();
            open(page, accountId);
        });
        notification.on('close', forget);
        notification.show();
    };

    const showHeld = () => {
        heldTimer = null;
        const notes = held;
        held = [];
        if (notes.length === 1) {
            present(notes[0].key, notes[0], notes[0].page, notes[0].accountId ?? null);
        } else if (notes.length > 1) {
            const page = new Set(notes.map((note) => note.page)).size === 1 ? notes[0].page : 'overview';
            const body =
                page === 'calendars'
                    ? `${notes.length} more changes need your attention. The Calendars page shows the reasons.`
                    : `${notes.length} more notifications. The app shows the details.`;
            present('summary', { title: appName, body }, page);
            quietUntil = now() + QUIET_AFTER_SUMMARY_MS;
        }
    };

    return {
        show(note: BridgeNotification) {
            if (note.replaces) {
                // e.g. "connected again": "cannot be reached" goes away, and may be shown again later.
                live.get(note.replaces)?.close();
                live.delete(note.replaces);
                recent.delete(note.replaces);
                held = held.filter((entry) => entry.key !== note.replaces);
            }
            const at = now();
            for (const [key, when] of recent) {
                if (at - when >= SAME_KEY_MS) recent.delete(key);
            }
            if (recent.has(note.key)) {
                return;
            }
            recent.set(note.key, at);
            shownOneByOne = shownOneByOne.filter((when) => at - when < BURST_MS);
            if (heldTimer || at < quietUntil || shownOneByOne.length >= ONE_BY_ONE) {
                held.push(note);
                heldTimer ??= schedule(showHeld, Math.max(BURST_MS, quietUntil - at));
                return;
            }
            shownOneByOne.push(at);
            present(note.key, note, note.page, note.accountId ?? null);
        },
        /** For tests: notifications kept referenced. */
        liveCount: () => live.size
    };
};
