/**
 * Availability (0.33.2): Calendar.app's free/busy lookup — a POST to the scheduling outbox with a
 * VFREEBUSY request (RFC 6638 §4.2 / RFC 5546 §3.3) for the guests of a meeting being planned — and
 * the bridge's answer per guest (a VFREEBUSY reply with FREEBUSY periods, or "no scheduling
 * support" when nothing is known about that address). Pure functions.
 */

export interface FreeBusyRequest {
    uid: string;
    organizer: string;
    /** The recipients as given (mailto:…), in order. */
    attendees: string[];
    /** The window in unix milliseconds. */
    start: number;
    end: number;
}

/** The lines of an ICS text, unfolded (a line starting with a space or tab continues the previous one). */
const unfold = (ics: string) => ics.replace(/\r?\n[ \t]/g, '').split(/\r?\n/);

/** 20261005T090000Z → unix ms; a floating or date value is read as UTC (a free/busy window is UTC). */
const utcMsOf = (value: string) => {
    const match = value.trim().match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})Z?)?$/);
    if (!match) {
        return NaN;
    }
    const [, year, month, day, hour = '0', minute = '0', second = '0'] = match;
    return Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second));
};

/** The value of the first property with this name (parameters skipped, quoted ones with colons too). */
const propertyValue = (lines: string[], name: string) => {
    const pattern = new RegExp(`^${name}(?:;(?:"[^"]*"|[^:"])*)?:(.*)$`, 'i');
    for (const line of lines) {
        const match = line.match(pattern);
        if (match) {
            return match[1].trim();
        }
    }
    return '';
};

/** The VFREEBUSY of an outbox POST, or null when the body holds none. */
export const parseFreeBusyRequest = (body: string): FreeBusyRequest | null => {
    const lines = unfold(body);
    const begin = lines.findIndex((line) => /^BEGIN:VFREEBUSY$/i.test(line.trim()));
    if (begin < 0) {
        return null;
    }
    const endIndex = lines.findIndex((line, index) => index > begin && /^END:VFREEBUSY$/i.test(line.trim()));
    const block = lines.slice(begin + 1, endIndex < 0 ? undefined : endIndex);
    const attendees = block
        .map((line) => line.match(/^ATTENDEE(?:;(?:"[^"]*"|[^:"])*)?:(.*)$/i))
        .filter((match): match is RegExpMatchArray => Boolean(match))
        .map((match) => match[1].trim())
        .filter(Boolean);
    return {
        uid: propertyValue(block, 'UID'),
        organizer: propertyValue(block, 'ORGANIZER'),
        attendees,
        start: utcMsOf(propertyValue(block, 'DTSTART')),
        end: utcMsOf(propertyValue(block, 'DTEND'))
    };
};

export const icsUtc = (ms: number) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');

/** The VFREEBUSY reply for one recipient (METHOD:REPLY, as RFC 5546 §3.3.2 wants it). */
export const freeBusyReplyIcs = (
    request: FreeBusyRequest,
    attendee: string,
    periods: Array<{ start: number; end: number; tentative?: boolean }>,
    now: number = Date.now()
) => {
    const lines = [
        'BEGIN:VCALENDAR',
        'VERSION:2.0',
        'PRODID:-//Neutron Calendar Bridge//EN',
        'METHOD:REPLY',
        'BEGIN:VFREEBUSY',
        `UID:${request.uid || `freebusy-${now}@neutron-calendar-bridge`}`, // as sent (already in ICS form; one unfolded line)
        `DTSTAMP:${icsUtc(now)}`,
        `DTSTART:${icsUtc(request.start)}`,
        `DTEND:${icsUtc(request.end)}`,
        ...(request.organizer ? [`ORGANIZER:${request.organizer}`] : []),
        `ATTENDEE:${attendee}`,
        // 0.40: tentatively busy (your answer Maybe, or a tentative event) as BUSY-TENTATIVE.
        ...periods.map((period) => `FREEBUSY;FBTYPE=${period.tentative ? 'BUSY-TENTATIVE' : 'BUSY'}:${icsUtc(period.start)}/${icsUtc(period.end)}`),
        'END:VFREEBUSY',
        'END:VCALENDAR'
    ];
    return `${lines.join('\r\n')}\r\n`;
};

/** mailto:Anna@Example.org → anna@example.org (what the lookups are keyed by). */
export const emailOfCalendarAddress = (value: string) => value.trim().replace(/^mailto:/i, '').toLowerCase();
