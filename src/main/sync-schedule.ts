/**
 * Small, Electron-free rules for the sync queue and the status dots (tested on their own):
 * which group a calendar belongs to, when public holidays are synced, and what a calendar's dot
 * and the menu-bar dot show.
 */
import type { CalendarKind, CalendarStatus } from '../shared/types';
import { t } from './i18n';

/** Proton's calendar types (CALENDAR_TYPE): 0 personal, 1 subscribed, 2 holidays. */
const TYPE_SUBSCRIPTION = 1;
const TYPE_HOLIDAYS = 2;
/** MEMBER_PERMISSIONS.OWNS: every permission bit. */
const PERMISSIONS_OWNS = 127;

/**
 * The group on the Calendars page. Own vs shared like Proton's getIsOwnedCalendar (the client's
 * `owned`); an older client without it: full permissions mean it is yours.
 */
export const calendarKindOf = (remote: { type?: number; owned?: boolean; permissions?: number }): CalendarKind => {
    if (remote.type === TYPE_HOLIDAYS) {
        return 'holidays';
    }
    if (remote.type === TYPE_SUBSCRIPTION) {
        return 'subscribed';
    }
    if (remote.owned === false) {
        return 'shared';
    }
    if (remote.owned === undefined && typeof remote.permissions === 'number' && (remote.permissions & PERMISSIONS_OWNS) !== PERMISSIONS_OWNS) {
        return 'shared';
    }
    return 'own';
};

/** The local calendar day (YYYY-MM-DD) of a moment, for "once a day". */
export const localDayOf = (date: Date) => {
    const pad = (value: number) => String(value).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
};

/** Milliseconds until the next local midnight (00:00), at least one second. */
export const msUntilLocalMidnight = (now: Date) => {
    const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0, 0);
    return Math.max(1000, next.getTime() - now.getTime());
};

/** What started a sync pass. */
export type SyncPassKind = 'auto' | 'refresh' | 'login';

/** After this long without a change (from Proton or Calendar.app) the bridge asks less often. */
export const QUIET_AFTER_MS = 10 * 60_000;
/** How often it asks when quiet (your interval, if that is longer). */
export const QUIET_INTERVAL_MS = 5 * 60_000;

/**
 * When the next automatic sync pass is due (0.26): your interval while things change (a change
 * in the last ten minutes, from Proton's feeds or from Calendar.app, a sign-in, waking up), every
 * five minutes when quiet. With a client that cannot follow the feeds (a full listing every pass),
 * the interval is fixed as before.
 */
export const nextSyncDelayMs = ({
    now,
    lastActivityAt,
    intervalMs,
    adaptive
}: {
    now: number;
    lastActivityAt: number;
    intervalMs: number;
    adaptive: boolean;
}) => {
    if (!adaptive || now - lastActivityAt < QUIET_AFTER_MS) {
        return intervalMs;
    }
    return Math.max(intervalMs, QUIET_INTERVAL_MS);
};

/**
 * Public holidays do not change: synced right after signing in (app start), once a day from
 * midnight on, and by hand one calendar at a time; never by the Refresh button.
 */
export const includesHolidays = (kind: SyncPassKind, lastHolidaySyncDay: string | null, today: string) =>
    kind === 'login' || (kind === 'auto' && lastHolidaySyncDay !== today);

export interface CalendarStatusInput {
    removed: boolean;
    syncEnabled: boolean;
    /** The bridge cannot reach Proton (or is signed out). */
    connectionError: { message: string; at: number } | null;
    error: { message: string; at: number } | null;
    warning: { message: string; at: number } | null;
}

/** A calendar's dot: off when not synced; red for connection or sync trouble; yellow for a refusal. */
export const calendarStatusOf = ({ removed, syncEnabled, connectionError, error, warning }: CalendarStatusInput): {
    status: CalendarStatus;
    message: string | null;
    at: number | null;
} => {
    if (removed) {
        return { status: 'off', message: t('Removed in Proton'), at: null };
    }
    if (!syncEnabled) {
        return { status: 'off', message: t('Not synced (unticked)'), at: null };
    }
    if (connectionError) {
        return { status: 'error', message: t('No connection to Proton: {message}', { message: connectionError.message }), at: connectionError.at };
    }
    if (error) {
        return { status: 'error', message: t('Sync failed: {message}', { message: error.message }), at: error.at };
    }
    if (warning) {
        return { status: 'warning', message: warning.message, at: warning.at };
    }
    return { status: 'ok', message: null, at: null };
};

/** The menu-bar menu's account dot: red, yellow, syncing (instead of green) or green. */
/** 0.45.2: 'warning-syncing' — something needs attention and a sync runs (a yellow turning symbol). */
export type TrayCalendarsStatus = 'ok' | 'syncing' | 'warning' | 'warning-syncing' | 'error';

export const trayCalendarsStatusOf = (statuses: CalendarStatus[], syncing: boolean): TrayCalendarsStatus => {
    if (statuses.includes('error')) {
        return 'error';
    }
    if (statuses.includes('warning')) {
        return syncing ? 'warning-syncing' : 'warning';
    }
    return syncing ? 'syncing' : 'ok';
};

/**
 * Which refused or failed Calendar.app requests raise a calendar's yellow dot: changes that were
 * refused (403) or failed (5xx). An outdated copy (412) is reloaded silently and is no problem.
 */
export const isWarningWorthy = (method: string, status: number) =>
    (method === 'PUT' || method === 'DELETE') && (status === 403 || status >= 500);

/** The calendar a CalDAV path points into: /calendars/<user>/<slug>/<resource>. */
export const calendarSlugOfPath = (path: string) => {
    const [, root, , slug] = path.split('/');
    return root === 'calendars' && slug ? decodeURIComponent(slug) : null;
};
