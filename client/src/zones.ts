/**
 * 0.40.1 (bridge): time zones Proton's API accepts. Proton refuses an event whose TZID is not on
 * its list ("Invalid event data (Invalid timezone)"), and macOS still names several zones by their
 * old IANA names (Asia/Calcutta, Asia/Saigon, Asia/Katmandu, America/Buenos_Aires …), or by the
 * new ones Proton does not list yet (Europe/Kyiv). Proton's own web app maps such names with
 * getSupportedTimezone before it saves; the library does the same for everything it writes.
 *
 * A zone on Proton's list is kept as it is: getSupportedTimezone alone would also move zones Proton
 * does accept to the zone they are linked to in the time-zone database (Europe/Amsterdam to
 * Europe/Brussels). Aliases have the same rules, so the instant of every time stays the same.
 */
import { getSupportedTimezone } from '@proton/shared/lib/date/timezone';
import { FALLBACK_ALLOWED_SUPPORTED_TIMEZONES_LIST } from '@proton/shared/lib/date/timezoneDatabase';
import type { VcalVeventComponent } from '@proton/shared/lib/interfaces/calendar';

const ALLOWED = new Set<string>(FALLBACK_ALLOWED_SUPPORTED_TIMEZONES_LIST);

/** The name Proton accepts for a time zone; an empty or unknown one is returned as it is. */
export const supportedTzid = <T extends string | undefined>(tzid: T): T => {
    if (!tzid || ALLOWED.has(tzid)) {
        return tzid;
    }
    try {
        return (getSupportedTimezone(tzid) || tzid) as T;
    } catch {
        return tzid;
    }
};

const withSupportedZone = (property: any) => {
    const tzid = property?.parameters?.tzid;
    if (!tzid || property.value?.isUTC) {
        return property;
    }
    const supported = supportedTzid(tzid);
    return supported === tzid ? property : { ...property, parameters: { ...property.parameters, tzid: supported } };
};

/** The VEVENT with every time (start, end, occurrence, excluded and added dates) in a zone Proton accepts. */
export const withSupportedZones = <T extends VcalVeventComponent>(vevent: T): T => {
    const anyVevent = vevent as any;
    if (!anyVevent) {
        return vevent;
    }
    const result: any = { ...anyVevent };
    for (const key of ['dtstart', 'dtend', 'recurrence-id']) {
        if (anyVevent[key]) {
            result[key] = withSupportedZone(anyVevent[key]);
        }
    }
    for (const key of ['exdate', 'rdate']) {
        if (Array.isArray(anyVevent[key])) {
            result[key] = anyVevent[key].map(withSupportedZone);
        }
    }
    return result as T;
};
