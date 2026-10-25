/**
 * Availability (0.33.2): the busy periods of a calendar's events in a window, for a free/busy
 * answer. An event counts as busy unless it says otherwise (TRANSP:TRANSPARENT), is cancelled
 * (STATUS:CANCELLED) or the user declined it (their own ATTENDEE with PARTSTAT=DECLINED). Series
 * are expanded with Proton's own occurrence iterator (`getOccurrencesBetween`, DST-aware), their
 * exceptions replace the occurrences they modify, excluded occurrences are left out.
 */
import { getOccurrences, getOccurrencesBetween } from '@proton/shared/lib/calendar/recurrence/recurring';
import { getDtendProperty, propertyToUTCDate } from '@proton/shared/lib/calendar/vcalConverter';
import { getIsPropertyAllDay } from '@proton/shared/lib/calendar/vcalHelper';
import { durationToMilliseconds, parse as parseVcal } from '@proton/shared/lib/calendar/vcal';
import type { VcalVeventComponent } from '@proton/shared/lib/interfaces/calendar';

import { withDtendFromDuration } from './duration';

/**
 * A busy period in unix milliseconds. An all-day period runs from the UTC midnight of its first day
 * to the UTC midnight after its last day (the dates as written); the caller places them in the
 * user's zone when the answer needs instants.
 */
export interface BusyPeriod {
    start: number;
    end: number;
    allDay: boolean;
    /**
     * 0.40 (bridge): only tentatively busy — your own answer is Maybe (PARTSTAT=TENTATIVE) or the event
     * itself is STATUS:TENTATIVE; answered as FBTYPE=BUSY-TENTATIVE. Absent = busy.
     */
    tentative?: boolean;
}

const veventsOf = (ics: string): VcalVeventComponent[] => {
    const parsed: any = parseVcal(ics.replace(/\r?\n/g, '\r\n'));
    if (parsed?.component === 'vevent') {
        return [withDtendFromDuration(parsed)];
    }
    // 0.40 (bridge): DURATION becomes DTEND, so a series written with DURATION expands to its real length.
    return (parsed?.components || []).filter((component: any) => component?.component === 'vevent').map(withDtendFromDuration);
};

const isTransparent = (vevent: any) => String(vevent?.transp?.value || '').toUpperCase() === 'TRANSPARENT';
const isCancelled = (vevent: any) => String(vevent?.status?.value || '').toUpperCase() === 'CANCELLED';

const declinedBy = (vevent: any, ownEmails: string[]) => {
    if (!ownEmails.length) {
        return false;
    }
    const own = new Set(ownEmails.map((email) => email.toLowerCase()));
    const attendees: any[] = Array.isArray(vevent?.attendee) ? vevent.attendee : [];
    return attendees.some((attendee) => {
        const email = String(attendee?.value || '').replace(/^mailto:/i, '').toLowerCase();
        return own.has(email) && String(attendee?.parameters?.partstat || '').toUpperCase() === 'DECLINED';
    });
};

const overlaps = (start: number, end: number, windowStart: number, windowEnd: number) => start < windowEnd && end > windowStart;

/** 0.40: tentatively busy — your own answer is Maybe, or the event itself is tentative. */
const tentativeFor = (vevent: any, ownEmails: string[]) => {
    if (String(vevent?.status?.value || '').toUpperCase() === 'TENTATIVE') {
        return true;
    }
    if (!ownEmails.length) {
        return false;
    }
    const own = new Set(ownEmails.map((email) => email.toLowerCase()));
    const attendees: any[] = Array.isArray(vevent?.attendee) ? vevent.attendee : [];
    return attendees.some((attendee) => {
        const email = String(attendee?.value || '').replace(/^mailto:/i, '').toLowerCase();
        return own.has(email) && String(attendee?.parameters?.partstat || '').toUpperCase() === 'TENTATIVE';
    });
};
const withKind = (period: BusyPeriod, tentative: boolean): BusyPeriod => (tentative ? { ...period, tentative: true } : period);

/** The periods of one occurrence-less component, if it is busy and in the window. */
const singlePeriod = (vevent: any, windowStart: number, windowEnd: number, ownEmails: string[]): BusyPeriod | null => {
    if (!vevent?.dtstart || isTransparent(vevent) || isCancelled(vevent) || declinedBy(vevent, ownEmails)) {
        return null;
    }
    const start = +propertyToUTCDate(vevent.dtstart);
    const allDay = getIsPropertyAllDay(vevent.dtstart);
    // getDtendProperty gives DTEND, or the start for an event without one — then a DURATION counts.
    const fromDtend = vevent.dtend ? +propertyToUTCDate(getDtendProperty(vevent)) : NaN;
    const fromDuration = !vevent.dtend && vevent.duration?.value ? start + durationToMilliseconds(vevent.duration.value) : NaN;
    const end = Math.max(Number.isFinite(fromDtend) ? fromDtend : Number.isFinite(fromDuration) ? fromDuration : start, allDay ? start + 86_400_000 : start);
    return overlaps(start, end, windowStart, windowEnd) ? withKind({ start, end, allDay }, tentativeFor(vevent, ownEmails)) : null;
};

/**
 * The busy periods of the events in an ICS text (one event, or a series with its exceptions as
 * Proton stores and the bridge serves them) between windowStart and windowEnd (unix ms).
 */
export const busyPeriodsOf = (ics: string, windowStart: number, windowEnd: number, ownEmails: string[] = []): BusyPeriod[] => {
    const vevents = veventsOf(ics);
    const exceptions = vevents.filter((vevent: any) => vevent['recurrence-id']);
    const masters = vevents.filter((vevent: any) => !vevent['recurrence-id']);
    const periods: BusyPeriod[] = [];

    for (const exception of exceptions) {
        const period = singlePeriod(exception, windowStart, windowEnd, ownEmails);
        if (period) {
            periods.push(period);
        }
    }
    for (const master of masters as any[]) {
        if (!master.rrule) {
            const period = singlePeriod(master, windowStart, windowEnd, ownEmails);
            if (period) {
                periods.push(period);
            }
            continue;
        }
        if (!master.dtstart || isTransparent(master) || isCancelled(master) || declinedBy(master, ownEmails)) {
            continue;
        }
        const replaced = new Set(exceptions.map((exception: any) => +propertyToUTCDate(exception['recurrence-id'])));
        const tentative = tentativeFor(master, ownEmails);
        const allDay = getIsPropertyAllDay(master.dtstart);
        for (const occurrence of getOccurrencesBetween(master, windowStart, windowEnd)) {
            const start = +occurrence.utcStart;
            if (replaced.has(start)) {
                continue; // the exception above speaks for this occurrence
            }
            // All-day occurrences end on the start of their last day in Proton's iterator (inclusive).
            const end = allDay ? +occurrence.utcEnd + 86_400_000 : Math.max(+occurrence.utcEnd, start);
            if (overlaps(start, end, windowStart, windowEnd)) {
                periods.push(withKind({ start, end, allDay }, tentative));
            }
        }
    }
    return periods;
};

/** Overlapping and touching periods of one kind merged, clipped to the window, sorted. */
const mergeKind = (periods: BusyPeriod[], windowStart: number, windowEnd: number): BusyPeriod[] => {
    const clipped = periods
        .map((period) => ({ ...period, start: Math.max(period.start, windowStart), end: Math.min(period.end, windowEnd) }))
        .filter((period) => period.end > period.start)
        .sort((a, b) => a.start - b.start || a.end - b.end);
    const merged: BusyPeriod[] = [];
    for (const period of clipped) {
        const last = merged[merged.length - 1];
        if (last && period.start <= last.end) {
            last.end = Math.max(last.end, period.end);
            last.allDay = last.allDay && period.allDay;
        } else {
            merged.push({ ...period });
        }
    }
    return merged;
};

/**
 * Sorted, overlapping and touching periods merged, clipped to the window. 0.40: busy and tentatively
 * busy are merged apart, and busy wins where they overlap (a tentative period keeps only the parts
 * no busy period covers).
 */
export const mergeBusyPeriods = (periods: BusyPeriod[], windowStart: number, windowEnd: number): BusyPeriod[] => {
    const busy = mergeKind(periods.filter((period) => !period.tentative).map(({ tentative: _t, ...period }) => period), windowStart, windowEnd);
    const tentative: BusyPeriod[] = [];
    for (const period of mergeKind(periods.filter((period) => period.tentative), windowStart, windowEnd)) {
        let pieces = [{ start: period.start, end: period.end }];
        for (const block of busy) {
            pieces = pieces.flatMap((piece) =>
                block.end <= piece.start || block.start >= piece.end
                    ? [piece]
                    : [
                          ...(block.start > piece.start ? [{ start: piece.start, end: block.start }] : []),
                          ...(block.end < piece.end ? [{ start: block.end, end: piece.end }] : [])
                      ]
            );
        }
        tentative.push(...pieces.map((piece) => ({ ...piece, allDay: period.allDay, tentative: true })));
    }
    return [...busy, ...tentative].sort((a, b) => a.start - b.start || a.end - b.end);
};

/**
 * 0.40 (bridge): when a COUNT-limited series ends — the end of its last occurrence, in unix ms as
 * Proton's iterator gives local times (within a day of the instant: callers keep a day's slack).
 * Null when the series has no COUNT (open-ended, or ended by UNTIL, which the caller reads itself)
 * or a COUNT too large to walk.
 */
export const seriesLastEndOf = (vevent: Pick<VcalVeventComponent, 'dtstart' | 'rrule' | 'exdate'> | undefined): number | null => {
    const count = (vevent as any)?.rrule?.value?.count;
    if (!vevent?.dtstart || typeof count !== 'number' || count > 5000) {
        return null;
    }
    const occurrences = getOccurrences({ component: vevent as any, maxCount: count });
    const last = occurrences[occurrences.length - 1];
    if (!last) {
        // COUNT=0 has none; otherwise the iterator could not walk the rule (it says nothing then): unknown.
        return count === 0 ? +propertyToUTCDate(vevent.dtstart) : null;
    }
    return +last.localEnd;
};
