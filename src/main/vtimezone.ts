/**
 * Builds RFC 5545 VTIMEZONE components from the platform's IANA time zone data (via Intl),
 * with yearly RRULE-based DST transitions (e.g. Europe: last Sunday of March / October).
 */

const MINUTE = 60_000;
const DAY = 86_400_000;
const WEEKDAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];

const formatterCache = new Map<string, Intl.DateTimeFormat>();
const vtimezoneCache = new Map<string, string[] | null>();

const getFormatter = (timeZone: string) => {
    let formatter = formatterCache.get(timeZone);
    if (!formatter) {
        formatter = new Intl.DateTimeFormat('en-US', {
            timeZone,
            hourCycle: 'h23',
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit'
        });
        formatterCache.set(timeZone, formatter);
    }
    return formatter;
};

export const isKnownTimeZone = (timeZone: string) => {
    try {
        getFormatter(timeZone);
        return true;
    } catch {
        return false;
    }
};

/** Offset of `timeZone` from UTC at the given instant, in minutes (e.g. +60 for CET). */
export const getUtcOffsetMinutes = (timeZone: string, epochMs: number) => {
    const instant = Math.floor(epochMs / 1000) * 1000;
    const parts = Object.fromEntries(
        getFormatter(timeZone)
            .formatToParts(new Date(instant))
            .map((part) => [part.type, part.value])
    );
    const asUtc = Date.UTC(
        Number(parts.year),
        Number(parts.month) - 1,
        Number(parts.day),
        Number(parts.hour) % 24,
        Number(parts.minute),
        Number(parts.second)
    );
    return Math.round((asUtc - instant) / MINUTE);
};

interface Transition {
    /** First instant (UTC ms) at which the new offset applies. */
    at: number;
    from: number;
    to: number;
}

const findTransitions = (timeZone: string, year: number): Transition[] => {
    const start = Date.UTC(year, 0, 1);
    const end = Date.UTC(year + 1, 0, 1);
    const transitions: Transition[] = [];
    let previousInstant = start;
    let previousOffset = getUtcOffsetMinutes(timeZone, start);

    for (let instant = start + DAY; instant <= end; instant += DAY) {
        const offset = getUtcOffsetMinutes(timeZone, instant);
        if (offset !== previousOffset) {
            let low = previousInstant;
            let high = instant;
            while (high - low > MINUTE) {
                const middle = low + Math.floor((high - low) / (2 * MINUTE)) * MINUTE;
                if (getUtcOffsetMinutes(timeZone, middle) === previousOffset) {
                    low = middle;
                } else {
                    high = middle;
                }
            }
            transitions.push({ at: high, from: previousOffset, to: offset });
            previousOffset = offset;
        }
        previousInstant = instant;
    }

    return transitions;
};

const pad = (value: number, width: number = 2) => String(Math.abs(value)).padStart(width, '0');

const formatOffset = (minutes: number) =>
    `${minutes < 0 ? '-' : '+'}${pad(Math.floor(Math.abs(minutes) / 60))}${pad(Math.abs(minutes) % 60)}`;

const daysInMonth = (year: number, month: number) => new Date(Date.UTC(year, month, 0)).getUTCDate();

/** Day of month in `year` matching an RRULE BYDAY like "-1SU" or "2SU" for `month` (1-12). */
const resolveByDay = (year: number, month: number, nth: number, weekday: number) => {
    const lastDay = daysInMonth(year, month);
    if (nth < 0) {
        const lastWeekday = new Date(Date.UTC(year, month - 1, lastDay)).getUTCDay();
        return lastDay - ((lastWeekday - weekday + 7) % 7);
    }
    const firstWeekday = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
    return 1 + ((weekday - firstWeekday + 7) % 7) + (nth - 1) * 7;
};

const formatLocal = (year: number, month: number, day: number, hours: number, minutes: number) =>
    `${pad(year, 4)}${pad(month)}${pad(day)}T${pad(hours)}${pad(minutes)}00`;

const buildRuleObservance = (transition: Transition) => {
    // DTSTART of an observance is the wall-clock time just before the switch (RFC 5545 §3.6.5).
    const local = new Date(transition.at + transition.from * MINUTE);
    const year = local.getUTCFullYear();
    const month = local.getUTCMonth() + 1;
    const day = local.getUTCDate();
    const weekday = local.getUTCDay();
    const nth = day + 7 > daysInMonth(year, month) ? -1 : Math.ceil(day / 7);
    const firstDay = resolveByDay(1970, month, nth, weekday);
    const kind = transition.to > transition.from ? 'DAYLIGHT' : 'STANDARD';

    return [
        `BEGIN:${kind}`,
        `DTSTART:${formatLocal(1970, month, firstDay, local.getUTCHours(), local.getUTCMinutes())}`,
        `RRULE:FREQ=YEARLY;BYMONTH=${month};BYDAY=${nth}${WEEKDAYS[weekday]}`,
        `TZOFFSETFROM:${formatOffset(transition.from)}`,
        `TZOFFSETTO:${formatOffset(transition.to)}`,
        `END:${kind}`
    ];
};

const buildFixedObservance = (transition: Transition) => {
    const local = new Date(transition.at + transition.from * MINUTE);
    const kind = transition.to > transition.from ? 'DAYLIGHT' : 'STANDARD';
    return [
        `BEGIN:${kind}`,
        `DTSTART:${formatLocal(
            local.getUTCFullYear(),
            local.getUTCMonth() + 1,
            local.getUTCDate(),
            local.getUTCHours(),
            local.getUTCMinutes()
        )}`,
        `TZOFFSETFROM:${formatOffset(transition.from)}`,
        `TZOFFSETTO:${formatOffset(transition.to)}`,
        `END:${kind}`
    ];
};

/**
 * VTIMEZONE lines for `timeZone`, using the DST rules in force in `referenceYear`.
 * Returns null for unknown zones or UTC (callers then emit UTC times / no VTIMEZONE).
 */
export const buildVtimezoneLines = (
    timeZone: string,
    referenceYear: number = new Date().getUTCFullYear()
): string[] | null => {
    if (!timeZone || timeZone === 'UTC' || timeZone === 'Etc/UTC' || !isKnownTimeZone(timeZone)) {
        return null;
    }

    const cacheKey = `${timeZone}|${referenceYear}`;
    if (vtimezoneCache.has(cacheKey)) {
        return vtimezoneCache.get(cacheKey) ?? null;
    }

    const transitions = findTransitions(timeZone, referenceYear);
    let observances: string[];

    const daylight = transitions.filter((transition) => transition.to > transition.from);
    const standard = transitions.filter((transition) => transition.to < transition.from);

    if (transitions.length === 0) {
        const offset = formatOffset(getUtcOffsetMinutes(timeZone, Date.UTC(referenceYear, 0, 1)));
        observances = [
            'BEGIN:STANDARD',
            'DTSTART:19700101T000000',
            `TZOFFSETFROM:${offset}`,
            `TZOFFSETTO:${offset}`,
            'END:STANDARD'
        ];
    } else if (transitions.length === 2 && daylight.length === 1 && standard.length === 1) {
        observances = [...buildRuleObservance(standard[0]), ...buildRuleObservance(daylight[0])];
    } else {
        // Unusual year (rules changed mid-year): pin the observed offsets from that year on.
        const initial = formatOffset(transitions[0].from);
        observances = [
            'BEGIN:STANDARD',
            'DTSTART:19700101T000000',
            `TZOFFSETFROM:${initial}`,
            `TZOFFSETTO:${initial}`,
            'END:STANDARD',
            ...transitions.flatMap(buildFixedObservance)
        ];
    }

    const lines = ['BEGIN:VTIMEZONE', `TZID:${timeZone}`, ...observances, 'END:VTIMEZONE'];
    vtimezoneCache.set(cacheKey, lines);
    return lines;
};
