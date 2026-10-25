/**
 * Reminders both ways (0.33): Calendar.app alarms (VALARM) ↔ Proton notifications.
 *
 * Proton keeps an event's reminders as `Notifications` on the event: `null` means "the calendar's
 * default reminders" (Proton's apps show the defaults and follow a change of them), a list means
 * exactly these (an empty list: none). Each entry is `{ Type: 0 email | 1 device, Trigger }` with a
 * relative trigger like "-PT15M"; for all-day events the trigger counts from the event's midnight
 * in the user's time zone ("-PT15H" = 9:00 the day before).
 *
 * Reading: Proton's own `readCalendarEvent` already turns the notifications (or the defaults) into
 * VALARM components; the library hands them to the bridge as ICS text, so Calendar.app shows them.
 *
 * Writing: Calendar.app's alarms go through Proton's own import rules (`getSupportedAlarms`:
 * display/audio → device, email → email, absolute triggers made relative, alarms after the start
 * and location-based "alarms" dropped, at most MAX_NOTIFICATIONS). Alarms that come out equal to
 * the calendar's defaults are stored as "defaults" (null); a new event without alarms gets the
 * defaults, an existing event whose alarms were all removed gets none.
 */
import { modelToValarmComponent } from '@proton/shared/lib/calendar/alarms/modelToValarm';
import { apiNotificationsToModel } from '@proton/shared/lib/calendar/alarms/notificationsToModel';
import { getSupportedAlarms } from '@proton/shared/lib/calendar/icsSurgery/valarm';
import { toApiNotifications } from '@proton/shared/lib/calendar/veventHelper';
import { getIsAbsoluteTrigger } from '@proton/shared/lib/calendar/alarms/trigger';
import { getIsPropertyAllDay } from '@proton/shared/lib/calendar/vcalHelper';
import { propertyToUTCDate } from '@proton/shared/lib/calendar/vcalConverter';
import { getMillisecondsFromTriggerString, parse as parseVcal, serialize } from '@proton/shared/lib/calendar/vcal';
import { convertUTCDateTimeToZone, fromUTCDate } from '@proton/shared/lib/date/timezone';
import type { VcalDateOrDateTimeProperty, VcalValarmComponent, VcalVeventComponent } from '@proton/shared/lib/interfaces/calendar';

/** A Proton notification as the API stores it. */
export interface ApiNotification {
    Type: number;
    Trigger: string;
}

/** What the bridge gets with a decrypted event. */
export interface EventReminders {
    /** True when the event follows the calendar's default reminders (the alarms below are those defaults). */
    hasDefaults: boolean;
    /** The reminders as VALARM components in ICS text ("BEGIN:VALARM … END:VALARM"), for the served ICS. */
    alarms: string[];
}

/** What a write to Proton needs. */
export interface ReminderDecision {
    /** The VALARMs to put in the VEVENT handed to createCalendarEvent (undefined: none / defaults). */
    components: VcalValarmComponent[] | undefined;
    hasDefaultNotifications: boolean;
    /** The notifications as the API will store them (null: the defaults). */
    notifications: ApiNotification[] | null;
}

const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

/** The time zone the alarms' absolute times are read in (the Mac's, where Calendar.app computed them). */
export const localTimeZone = () => {
    try {
        return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    } catch {
        return 'UTC';
    }
};

const alarmsOf = (vevent: Pick<VcalVeventComponent, 'components'> | undefined): VcalValarmComponent[] =>
    ((vevent?.components as VcalValarmComponent[] | undefined) || []).filter((component: any) => component?.component === 'valarm');

/**
 * Calendar.app stores an all-day event's alarm as an absolute time (9:00 the day before, in the
 * Mac's time zone, as UTC). Proton counts all-day triggers from the event's local midnight in
 * wall-clock terms (days and a time of day), so the absolute time is read in the local zone and
 * subtracted from the event's date on the wall clock — not as instants, which would be an hour off
 * for an alarm across a DST change, and not from UTC midnight, which Proton's own import would use
 * and which is off by the zone's offset.
 */
const relativeToLocalMidnight = (alarm: VcalValarmComponent, dtstart: VcalDateOrDateTimeProperty, timeZone: string): VcalValarmComponent => {
    if (!alarm?.trigger || !getIsPropertyAllDay(dtstart) || !getIsAbsoluteTrigger(alarm.trigger)) {
        return alarm;
    }
    const { year, month, day } = dtstart.value;
    const wall = convertUTCDateTimeToZone(fromUTCDate(propertyToUTCDate(alarm.trigger)), timeZone);
    const at = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hours, wall.minutes, wall.seconds || 0);
    const midnight = Date.UTC(year, month - 1, day);
    const minutes = Math.round((midnight - at) / 60000); // positive: before the event
    const total = Math.abs(minutes) * MINUTE;
    return {
        ...alarm,
        trigger: {
            value: {
                weeks: Math.floor(total / WEEK),
                days: Math.floor((total % WEEK) / DAY),
                hours: Math.floor((total % DAY) / HOUR),
                minutes: Math.floor((total % HOUR) / MINUTE),
                seconds: 0,
                isNegative: minutes >= 0
            }
        }
    } as VcalValarmComponent;
};

/** The alarms of a VEVENT as Proton can store them (relative triggers only, deduplicated, capped). */
export const normalizeAlarms = (vevent: VcalVeventComponent, timeZone = localTimeZone()): VcalValarmComponent[] => {
    const alarms = alarmsOf(vevent);
    if (!alarms.length || !vevent.dtstart) {
        return [];
    }
    const supported = getSupportedAlarms(
        alarms.map((alarm) => relativeToLocalMidnight(alarm, vevent.dtstart, timeZone)),
        vevent.dtstart
    );
    const seen = new Set<string>();
    return supported.filter((alarm) => {
        // 0.41.8: by the trigger's meaning ("-PT15M", "-PT0H15M", "-P0DT0H15M0S" are one alarm).
        const notification = toApiNotifications([alarm])[0];
        const key = `${notification.Type}:${canonicalTrigger(notification.Trigger)}`;
        if (seen.has(key)) {
            return false;
        }
        seen.add(key);
        return true;
    });
};


/** A trigger by its meaning (another client may have stored "-PT1H30M" for "-PT90M", or "-PT0M" for "PT0S"). */
const canonicalTrigger = (trigger: string) => {
    try {
        return String(getMillisecondsFromTriggerString(trigger));
    } catch {
        return trigger;
    }
};

/** Two notification lists with the same entries (order, duplicates and the spelling of triggers aside). */
export const sameNotifications = (a: ApiNotification[] | null | undefined, b: ApiNotification[] | null | undefined) => {
    const keys = (list: ApiNotification[] | null | undefined) =>
        [...new Set((list || []).map((entry) => `${entry.Type}:${canonicalTrigger(entry.Trigger)}`))].sort().join('\n');
    return keys(a) === keys(b);
};

/** The calendar's default reminders for part-day or all-day events, as the API stores them. */
export const defaultNotifications = (calendarSettings: any, isAllDay: boolean): ApiNotification[] => {
    const list = isAllDay ? calendarSettings?.DefaultFullDayNotifications : calendarSettings?.DefaultPartDayNotifications;
    return Array.isArray(list) ? list.map((entry: any) => ({ Type: Number(entry.Type), Trigger: String(entry.Trigger) })) : [];
};

/**
 * What to store for the alarms of a VEVENT coming from Calendar.app. `isCreate`: a new event
 * without alarms gets the calendar's defaults (as a new event in Proton Calendar does); an
 * existing event without alarms has had them removed.
 */
export const decideReminders = (
    vevent: VcalVeventComponent,
    calendarSettings: any,
    { isCreate = false, timeZone = localTimeZone() }: { isCreate?: boolean; timeZone?: string } = {}
): ReminderDecision => {
    const alarms = normalizeAlarms(vevent, timeZone);
    const isAllDay = Boolean(vevent.dtstart && getIsPropertyAllDay(vevent.dtstart));
    const defaults = defaultNotifications(calendarSettings, isAllDay);
    if (!alarms.length && isCreate) {
        return { components: undefined, hasDefaultNotifications: true, notifications: null };
    }
    const notifications = toApiNotifications(alarms);
    if (sameNotifications(notifications, defaults)) {
        return { components: undefined, hasDefaultNotifications: true, notifications: null };
    }
    return { components: alarms, hasDefaultNotifications: false, notifications };
};

/** The VEVENT with its alarms replaced by what Proton stores (none when the defaults apply). */
export const withDecidedAlarms = <T extends VcalVeventComponent>(vevent: T, decision: ReminderDecision): T => {
    const { components, ...rest } = vevent as T & { components?: unknown };
    const others = ((components as any[]) || []).filter((component) => component?.component !== 'valarm');
    const all = [...others, ...(decision.components || [])];
    return (all.length ? { ...rest, components: all } : rest) as T;
};

/**
 * VALARM components as ICS text blocks (for the served ICS). Proton's components carry only
 * TRIGGER and ACTION; RFC 5545 wants a DESCRIPTION on a display alarm and SUMMARY, DESCRIPTION and
 * an ATTENDEE on an email alarm, so those are filled in (the event's title, the account's address)
 * for clients that insist — Calendar.app reads them back as what they are.
 */
export const serializeAlarms = (alarms: VcalValarmComponent[] | undefined, details: { title?: string; ownEmail?: string } = {}): string[] =>
    (alarms || [])
        .filter((alarm: any) => alarm?.component === 'valarm')
        .map((alarm: any) => {
            const isEmail = String(alarm.action?.value || '').toLowerCase() === 'email';
            const text = details.title?.trim() || 'Reminder';
            const complete = {
                ...alarm,
                ...(alarm.description ? {} : { description: { value: text } }),
                ...(isEmail && !alarm.summary ? { summary: { value: text } } : {}),
                ...(isEmail && !alarm.attendee?.length && details.ownEmail ? { attendee: [{ value: `mailto:${details.ownEmail}` }] } : {})
            };
            return serialize(complete).replace(/\r?\n/g, '\r\n').trim();
        });

/** VALARM ICS text blocks back to components (what a client sent, kept as text by the bridge). */
export const parseAlarmBlocks = (blocks: string[]): VcalValarmComponent[] => {
    const alarms: VcalValarmComponent[] = [];
    for (const block of blocks) {
        try {
            const parsed: any = parseVcal(block.trim());
            if (parsed?.component === 'valarm') {
                alarms.push(parsed as VcalValarmComponent);
            }
        } catch {
            // an alarm the parser cannot read is left out
        }
    }
    return alarms;
};

/** The VALARM blocks in an ICS text (inside the first VEVENT, or anywhere when there is only one). */
export const alarmBlocksOf = (ics: string): string[] => {
    const unfolded = ics.replace(/\r?\n[ \t]/g, '');
    return [...unfolded.matchAll(/^BEGIN:VALARM[ \t]*$[\s\S]*?^END:VALARM[ \t]*$/gim)].map((match) => match[0].replace(/\r?\n/g, '\r\n'));
};

/** Proton's notifications (null: the calendar's defaults) as VALARM components, as readCalendarEvent builds them. */
export const alarmsFromNotifications = (notifications: ApiNotification[] | null, isAllDay: boolean, calendarSettings: any): VcalValarmComponent[] =>
    apiNotificationsToModel({ notifications: notifications as any, isAllDay, calendarSettings: calendarSettings || {} }).map((model) => modelToValarmComponent(model) as VcalValarmComponent);

/** The reminders of a decrypted event, for the bridge. */
export const remindersOf = (veventComponent: VcalVeventComponent, hasDefaultNotifications: boolean, ownEmail?: string): EventReminders => ({
    hasDefaults: Boolean(hasDefaultNotifications),
    alarms: serializeAlarms(alarmsOf(veventComponent), { title: (veventComponent as any)?.summary?.value, ownEmail })
});

/** The notifications an existing Proton event stores, for comparisons (null: defaults). */
export const notificationsOfEvent = (event: { Notifications?: any } | null | undefined): ApiNotification[] | null =>
    Array.isArray(event?.Notifications) ? event!.Notifications.map((entry: any) => ({ Type: Number(entry.Type), Trigger: String(entry.Trigger) })) : null;
