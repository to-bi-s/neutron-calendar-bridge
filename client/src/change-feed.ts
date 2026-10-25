/**
 * Proton's change feeds (stage 5, "WP4 efficient sync"), as Proton Calendar and Proton Mail use
 * them instead of listing everything again:
 *
 * - per calendar: `calendar/v1/{calendarID}/modelevents/latest` gives a cursor; from then on
 *   `calendar/v1/{calendarID}/modelevents/{cursor}` lists what happened since it — events created,
 *   changed or deleted (`CalendarEvents[]`, with the event's metadata but not its encrypted parts),
 *   calendar keys and settings changed, a `Refresh` flag when the server wants a full re-read, `More`
 *   when there is another page, and the next cursor (`CalendarModelEventID`);
 * - for the account: `core/v4/events/latest` and `core/v5/events/{cursor}`: calendars added,
 *   changed or removed (`Calendars[]`, `CalendarMembers[]` — a calendar's name and colour are the
 *   member's), addresses, settings, and the mailbox (`Messages[]`).
 *
 * This file holds the shapes and the parsing of the answers (tested offline); the requests are made
 * by ProtonCalendarAPI.getCalendarChanges / getAccountChanges.
 */

/** Proton's EVENT_ACTIONS. */
export const FEED_ACTION_DELETE = 0;
export const FEED_ACTION_CREATE = 1;
export const FEED_ACTION_UPDATE = 2;

/** What the feed says about a created or changed event: its metadata, never its encrypted parts. */
export interface ChangedEventStub {
    id: string;
    uid: string;
    calendarId: string;
    /** Unix seconds. */
    startTime: number;
    endTime: number;
    /** The series rule, when it is a recurring series' master. */
    rrule: string | null;
    /** Unix seconds; the occurrence a changed single occurrence stands for, when it is one. */
    recurrenceId: number | null;
    modifyTime: number;
}

export interface CalendarChanges {
    calendarId: string;
    /** The cursor to pass next time. */
    cursor: string;
    /** `null` was passed: nothing could be listed yet, everything must be read in full once. */
    started: boolean;
    /** Proton asks for a full re-read (or the cursor was unknown to it): list everything again. */
    refresh: boolean;
    /** Created or changed events, by Proton event ID (the last word on each). */
    changed: ChangedEventStub[];
    /** Deleted events: Proton event IDs (the feed carries nothing else about them). */
    deleted: string[];
    /** The calendar's keys or settings changed (its bootstrap data is read again on the next use). */
    keysChanged: boolean;
    /** Feed pages read for this answer. */
    requests: number;
}

export interface AccountChanges {
    cursor: string;
    started: boolean;
    refresh: boolean;
    /** Calendars added, changed or removed, or a calendar member (name, colour, permissions) changed. */
    calendars: boolean;
    /** The account's addresses changed (one added, removed, disabled, or its keys). */
    addresses: boolean;
    /** The mailbox changed: messages created, changed (read, moved) or deleted. */
    mail: boolean;
    /** Mail or calendar settings changed. */
    settings: boolean;
    requests: number;
}

const stubOf = (calendarId: string, event: any): ChangedEventStub | null => {
    if (!event || typeof event.ID !== 'string' || typeof event.UID !== 'string') {
        return null;
    }
    return {
        id: event.ID,
        uid: event.UID,
        calendarId: typeof event.CalendarID === 'string' ? event.CalendarID : calendarId,
        startTime: Number(event.StartTime) || 0,
        endTime: Number(event.EndTime) || 0,
        rrule: typeof event.RRule === 'string' && event.RRule ? event.RRule : null,
        recurrenceId: typeof event.RecurrenceID === 'number' ? event.RecurrenceID : null,
        modifyTime: Number(event.ModifyTime) || 0
    };
};

/**
 * Folds one page of a calendar's feed into `changes`. A later page's word on an event replaces an
 * earlier one's (created then deleted within the pages = deleted).
 */
export const applyCalendarFeedPage = (changes: CalendarChanges, page: any): { more: boolean } => {
    if (!page || typeof page !== 'object') {
        throw new Error('Proton answered the calendar feed without a body');
    }
    if (typeof page.CalendarModelEventID === 'string' && page.CalendarModelEventID) {
        changes.cursor = page.CalendarModelEventID;
    }
    if (page.Refresh) {
        changes.refresh = true;
    }
    if ((Array.isArray(page.CalendarKeys) && page.CalendarKeys.length) || (Array.isArray(page.CalendarSettings) && page.CalendarSettings.length)) {
        changes.keysChanged = true;
    }
    const changedById = new Map(changes.changed.map((stub) => [stub.id, stub]));
    const deleted = new Set(changes.deleted);
    for (const item of Array.isArray(page.CalendarEvents) ? page.CalendarEvents : []) {
        if (!item || typeof item.ID !== 'string') {
            continue;
        }
        if (item.Action === FEED_ACTION_DELETE) {
            changedById.delete(item.ID);
            deleted.add(item.ID);
        } else if (item.Action === FEED_ACTION_CREATE || item.Action === FEED_ACTION_UPDATE) {
            const stub = stubOf(changes.calendarId, item.Event);
            if (stub) {
                deleted.delete(item.ID);
                changedById.set(item.ID, stub);
            } else {
                // Metadata missing: the only safe reading is "read everything again".
                changes.refresh = true;
            }
        }
    }
    changes.changed = [...changedById.values()];
    changes.deleted = [...deleted];
    changes.requests += 1;
    return { more: page.More === 1 || page.More === true };
};

const hasItems = (value: unknown) => Array.isArray(value) && value.length > 0;

/** Folds one page of the account feed into `changes`. */
export const applyAccountFeedPage = (changes: AccountChanges, page: any): { more: boolean } => {
    if (!page || typeof page !== 'object') {
        throw new Error('Proton answered the account feed without a body');
    }
    if (typeof page.EventID === 'string' && page.EventID) {
        changes.cursor = page.EventID;
    }
    if (page.Refresh) {
        changes.refresh = true;
    }
    if (hasItems(page.Calendars) || hasItems(page.CalendarMembers)) {
        changes.calendars = true;
    }
    if (hasItems(page.Addresses)) {
        changes.addresses = true;
    }
    if (hasItems(page.Messages) || hasItems(page.Conversations)) {
        changes.mail = true;
    }
    if (page.MailSettings || page.CalendarUserSettings || page.UserSettings) {
        changes.settings = true;
    }
    changes.requests += 1;
    return { more: page.More === 1 || page.More === true };
};

export const emptyCalendarChanges = (calendarId: string, cursor: string): CalendarChanges => ({
    calendarId,
    cursor,
    started: false,
    refresh: false,
    changed: [],
    deleted: [],
    keysChanged: false,
    requests: 0
});

export const emptyAccountChanges = (cursor: string): AccountChanges => ({
    cursor,
    started: false,
    refresh: false,
    calendars: false,
    addresses: false,
    mail: false,
    settings: false,
    requests: 0
});

/** How many pages of a feed are read in one go before the rest is left for the next time. */
export const MAX_FEED_PAGES = 20;
