/**
 * 0.40 (bridge): events written with DURATION instead of DTEND. RFC 5545 allows either; Proton stores
 * only DTEND (its import converts, its API does not), and Proton's own helpers read a missing DTEND as
 * a zero-length event. Every VEVENT the library parses gets its DTEND computed from DURATION here, so
 * the write paths, invitations and busy times all see the real end.
 *
 * RFC 5545 3.3.6: weeks and days are nominal (the same wall-clock time on a later day, across a DST
 * change), hours, minutes and seconds exact (elapsed time). A DURATION on an all-day event counts
 * whole days only.
 */
import { convertUTCDateTimeToZone, convertZonedDateTimeToUTC } from '@proton/shared/lib/date/timezone';
import type { VcalVeventComponent } from '@proton/shared/lib/interfaces/calendar';

interface DurationValue {
    weeks?: number;
    days?: number;
    hours?: number;
    minutes?: number;
    seconds?: number;
    isNegative?: boolean;
}

interface DateTimeFields {
    year: number;
    month: number;
    day: number;
    hours: number;
    minutes: number;
    seconds: number;
}

const isUtcZone = (tzid?: string) => !tzid || tzid === 'UTC' || tzid === 'Etc/UTC' || tzid === 'Z';

/** Wall-clock fields moved by a number of milliseconds (as if the fields were UTC). */
const shiftFields = (fields: DateTimeFields, ms: number): DateTimeFields => {
    const date = new Date(Date.UTC(fields.year, fields.month - 1, fields.day, fields.hours, fields.minutes, fields.seconds) + ms);
    return {
        year: date.getUTCFullYear(),
        month: date.getUTCMonth() + 1,
        day: date.getUTCDate(),
        hours: date.getUTCHours(),
        minutes: date.getUTCMinutes(),
        seconds: date.getUTCSeconds()
    };
};

const DAY = 86_400_000;

/** DTEND for a VEVENT that has DTSTART and DURATION but no DTEND; any other VEVENT is returned as it is. */
export const withDtendFromDuration = <T extends VcalVeventComponent>(vevent: T): T => {
    const anyVevent = vevent as any;
    const duration: DurationValue | undefined = anyVevent?.duration?.value;
    if (!anyVevent?.dtstart?.value || anyVevent.dtend || !duration) {
        return vevent;
    }
    const sign = duration.isNegative ? -1 : 1;
    const nominalDays = sign * ((duration.weeks || 0) * 7 + (duration.days || 0));
    const exactMs = sign * (((duration.hours || 0) * 60 + (duration.minutes || 0)) * 60 + (duration.seconds || 0)) * 1000;
    const { duration: _dropped, ...rest } = anyVevent;
    const start = anyVevent.dtstart;

    if (start.parameters?.type === 'date' || typeof start.value.hours !== 'number') {
        // All-day: whole days, at least one (a zero or negative length is not an all-day event).
        const end = shiftFields({ ...start.value, hours: 0, minutes: 0, seconds: 0 }, Math.max(1, nominalDays) * DAY);
        return { ...rest, dtend: { value: { year: end.year, month: end.month, day: end.day }, parameters: { type: 'date' } } } as T;
    }

    const fields: DateTimeFields = {
        year: start.value.year,
        month: start.value.month,
        day: start.value.day,
        hours: start.value.hours,
        minutes: start.value.minutes,
        seconds: start.value.seconds || 0
    };
    // Nominal days on the wall clock first, then the exact part as elapsed time.
    const afterDays = shiftFields(fields, nominalDays * DAY);
    const tzid: string | undefined = start.parameters?.tzid;
    let endFields: DateTimeFields;
    let endInUtc: DateTimeFields | null = null;
    if (start.value.isUTC || (tzid && isUtcZone(tzid)) || !tzid) {
        // UTC, or floating time (no zone): elapsed time and wall clock are the same.
        endFields = shiftFields(afterDays, exactMs);
    } else {
        try {
            const utc = convertZonedDateTimeToUTC(afterDays, tzid);
            const target = shiftFields({ ...utc, seconds: utc.seconds || 0 } as DateTimeFields, exactMs);
            endFields = convertUTCDateTimeToZone(target, tzid) as DateTimeFields;
            // A wall-clock end that is read back as another instant (the hour that occurs twice when
            // the clocks go back): the end is written in UTC instead, which is never ambiguous.
            const readBack = convertZonedDateTimeToUTC(endFields, tzid);
            if (Date.UTC(readBack.year, readBack.month - 1, readBack.day, readBack.hours, readBack.minutes, readBack.seconds || 0) !== Date.UTC(target.year, target.month - 1, target.day, target.hours, target.minutes, target.seconds)) {
                endInUtc = target;
            }
        } catch {
            endFields = shiftFields(afterDays, exactMs); // an unknown zone: the wall clock
        }
    }
    if (Date.UTC(endFields.year, endFields.month - 1, endFields.day, endFields.hours, endFields.minutes, endFields.seconds) < Date.UTC(fields.year, fields.month - 1, fields.day, fields.hours, fields.minutes, fields.seconds)) {
        endFields = fields; // a negative length: zero, as Proton reads an event without an end
    }
    if (endInUtc) {
        return { ...rest, dtend: { value: { ...endInUtc, isUTC: true } } } as T;
    }
    return {
        ...rest,
        dtend: {
            value: { ...endFields, isUTC: Boolean(start.value.isUTC) },
            ...(start.parameters ? { parameters: { ...start.parameters } } : {})
        }
    } as T;
};
