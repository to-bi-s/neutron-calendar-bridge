/**
 * Offline test for 0.40.1: time zones by the names Proton's API accepts — macOS's old names mapped,
 * zones on Proton's list kept, every time of a VEVENT covered, the instant unchanged.
 */
import { supportedTzid, withSupportedZones } from '../src/zones.ts';
import { ProtonCalendarAPI } from '../src/proton-calendar-api.ts';
import { propertyToUTCDate } from '@proton/shared/lib/calendar/vcalConverter';

let failures = 0;
const check = (condition: unknown, label: string) => {
    console.log(`${condition ? 'ok  ' : 'FAIL'} ${label}`);
    if (!condition) failures += 1;
};

check(supportedTzid('Asia/Calcutta') === 'Asia/Kolkata', "macOS's Asia/Calcutta becomes Asia/Kolkata");
check(supportedTzid('Asia/Saigon') === 'Asia/Ho_Chi_Minh', 'Asia/Saigon becomes Asia/Ho_Chi_Minh');
check(supportedTzid('America/Buenos_Aires') === 'America/Argentina/Buenos_Aires', 'America/Buenos_Aires becomes America/Argentina/Buenos_Aires');
check(supportedTzid('Europe/Kyiv') === 'Europe/Kiev', 'Europe/Kyiv (not on Proton\'s list yet) becomes Europe/Kiev');
check(supportedTzid('Europe/Amsterdam') === 'Europe/Amsterdam', 'Europe/Amsterdam is on the list and stays (not Europe/Brussels)');
check(supportedTzid('America/New_York') === 'America/New_York', 'a listed zone stays');
check(supportedTzid('Not/A_Zone') === 'Not/A_Zone', 'an unknown zone is left as it is');
check(supportedTzid(undefined) === undefined && supportedTzid('') === '', 'no zone: nothing to map');

const api: any = new ProtonCalendarAPI({ username: 'u', password: 'p' });
const ics = [
    'BEGIN:VCALENDAR', 'VERSION:2.0',
    'BEGIN:VEVENT', 'UID:z1', 'DTSTAMP:20260101T000000Z',
    'DTSTART;TZID=Asia/Calcutta:20261020T100000',
    'DTEND;TZID=Asia/Calcutta:20261020T110000',
    'RRULE:FREQ=WEEKLY;COUNT=4',
    'EXDATE;TZID=Asia/Calcutta:20261027T100000',
    'SUMMARY:Stand-up', 'END:VEVENT',
    'BEGIN:VEVENT', 'UID:z1', 'DTSTAMP:20260101T000000Z',
    'RECURRENCE-ID;TZID=Asia/Calcutta:20261103T100000',
    'DTSTART;TZID=Asia/Calcutta:20261103T120000',
    'DTEND;TZID=Asia/Calcutta:20261103T130000',
    'SUMMARY:Stand-up (moved)', 'END:VEVENT',
    'END:VCALENDAR'
].join('\r\n');
const [master, exception] = api.parseIcsToVevents(ics);
check(master.dtstart.parameters.tzid === 'Asia/Kolkata' && master.dtend.parameters.tzid === 'Asia/Kolkata', 'start and end of a parsed event in Asia/Kolkata');
check(master.exdate?.[0]?.parameters?.tzid === 'Asia/Kolkata', 'excluded dates too');
check(exception['recurrence-id'].parameters.tzid === 'Asia/Kolkata' && exception.dtstart.parameters.tzid === 'Asia/Kolkata', 'the occurrence id of an exception too');
check(+propertyToUTCDate(master.dtstart) === Date.parse('2026-10-20T04:30:00Z'), 'the instant is unchanged (10:00 IST = 04:30 UTC)');

const utc = { dtstart: { value: { year: 2026, month: 10, day: 20, hours: 9, minutes: 0, seconds: 0, isUTC: true } } } as any;
check(withSupportedZones(utc).dtstart === utc.dtstart, 'a UTC time is not touched');
const amsterdam = { dtstart: { value: { year: 2026, month: 10, day: 20, hours: 9, minutes: 0, seconds: 0, isUTC: false }, parameters: { tzid: 'Europe/Amsterdam' } } } as any;
check(withSupportedZones(amsterdam).dtstart === amsterdam.dtstart, 'a listed zone: the property is the same object');

if (failures) {
    console.error(`${failures} check(s) failed`);
    process.exit(1);
}
console.log('zones test passed');
