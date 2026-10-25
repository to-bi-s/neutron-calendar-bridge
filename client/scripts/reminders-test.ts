/**
 * Offline test for reminders both ways (0.33): Calendar.app's alarms → Proton notifications (display
 * and audio → device, email → email; absolute all-day triggers made relative to the local midnight;
 * location alarms, alarms after the start and duplicates dropped; the cap), the defaults decision
 * (equal to the calendar's defaults → stored as defaults; a new event without alarms → defaults;
 * an existing one without → none), Proton's own getVeventParts seeing the same notifications, and
 * Proton's notifications → VALARM text for the served ICS.
 */
import { getVeventParts } from '@proton/shared/lib/calendar/veventHelper';
import { parse } from '@proton/shared/lib/calendar/vcal';

import {
    alarmBlocksOf,
    alarmsFromNotifications,
    decideReminders,
    defaultNotifications,
    normalizeAlarms,
    parseAlarmBlocks,
    remindersOf,
    sameNotifications,
    serializeAlarms,
    withDecidedAlarms,
} from '../src/reminders.ts';

let failures = 0;
const check = (condition: unknown, label: string) => {
    console.log(`${condition ? 'ok  ' : 'FAIL'} ${label}`);
    if (!condition) failures += 1;
};
const TZ = 'Europe/Amsterdam';
const calendarSettings = {
    DefaultPartDayNotifications: [{ Type: 1, Trigger: '-PT15M' }],
    DefaultFullDayNotifications: [{ Type: 1, Trigger: '-PT15H' }], // 9:00 the day before
};

const veventOf = (ics: string): any => {
    const parsed: any = parse(ics.replace(/\n/g, '\r\n'));
    return parsed.component === 'vevent' ? parsed : parsed.components.find((c: any) => c.component === 'vevent');
};

// Calendar.app's alarms on a timed event: a display alarm with Apple's extras, an audio alarm, an
// email alarm, a duplicate, a location alarm, and one after the start.
const timed = veventOf(`BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:timed@example
DTSTAMP:20261010T100000Z
DTSTART;TZID=Europe/Amsterdam:20261020T140000
DTEND;TZID=Europe/Amsterdam:20261020T150000
SUMMARY:Timed
BEGIN:VALARM
X-WR-ALARMUID:11111111-1111-1111-1111-111111111111
UID:11111111-1111-1111-1111-111111111111
TRIGGER:-PT30M
ACTION:DISPLAY
DESCRIPTION:Reminder
ACKNOWLEDGED:20261010T100000Z
END:VALARM
BEGIN:VALARM
TRIGGER:-PT1H
ACTION:AUDIO
ATTACH;VALUE=URI:Chord
END:VALARM
BEGIN:VALARM
TRIGGER:-P1D
ACTION:EMAIL
SUMMARY:Timed
DESCRIPTION:Tomorrow
ATTENDEE:mailto:me@proton.me
END:VALARM
BEGIN:VALARM
TRIGGER:-PT30M
ACTION:DISPLAY
DESCRIPTION:Duplicate
END:VALARM
BEGIN:VALARM
X-APPLE-PROXIMITY:DEPART
TRIGGER;VALUE=DATE-TIME:19760401T005545Z
ACTION:DISPLAY
DESCRIPTION:Leaving home
END:VALARM
BEGIN:VALARM
TRIGGER:PT10M
ACTION:DISPLAY
DESCRIPTION:After the start
END:VALARM
END:VEVENT
END:VCALENDAR`);

const alarms = normalizeAlarms(timed, TZ);
const triggers = alarms.map((alarm) => `${alarm.action.value}:${JSON.stringify(alarm.trigger.value)}`);
check(alarms.length === 3, `timed event: 3 of 6 alarms kept (${alarms.length}): display, audio, email — duplicate, location and after-start dropped`);
check(alarms[0].action.value === 'DISPLAY' && alarms[0].trigger.value.minutes === 30 && alarms[0].trigger.value.isNegative, `display -PT30M kept (${triggers[0]})`);
check(alarms[1].action.value === 'DISPLAY' && alarms[1].trigger.value.hours === 1, `audio alarm becomes a device notification one hour before (${triggers[1]})`);
check(alarms[2].action.value === 'EMAIL' && alarms[2].trigger.value.days === 1, `email alarm kept as email, one day before (${triggers[2]})`);

const decision = decideReminders(timed, calendarSettings, { isCreate: false, timeZone: TZ });
check(!decision.hasDefaultNotifications && decision.notifications?.length === 3, 'not the defaults: explicit notifications');
check(JSON.stringify(decision.notifications) === JSON.stringify([{ Type: 1, Trigger: '-PT30M' }, { Type: 1, Trigger: '-PT1H' }, { Type: 0, Trigger: '-P1D' }]), `notifications as the API stores them: ${JSON.stringify(decision.notifications)}`);
const parts = getVeventParts(withDecidedAlarms(timed, decision));
check(JSON.stringify(parts.notificationsPart) === JSON.stringify(decision.notifications), "Proton's getVeventParts derives the same notifications from the VEVENT handed to createCalendarEvent (no absolute triggers left)");
const personalSigned = String((parts.personalPart as any)?.[2] || '');
check((personalSigned.match(/BEGIN:VALARM/g) || []).length === 3 && !/VALUE=DATE-TIME/.test(personalSigned), 'the three alarms go into the signed personal part (as ICS text, relative triggers)');

// Equal to the calendar's defaults → stored as defaults.
const likeDefaults = veventOf(`BEGIN:VEVENT
UID:d@example
DTSTAMP:20261010T100000Z
DTSTART;TZID=Europe/Amsterdam:20261020T140000
DTEND;TZID=Europe/Amsterdam:20261020T150000
BEGIN:VALARM
TRIGGER:-PT15M
ACTION:DISPLAY
DESCRIPTION:Reminder
END:VALARM
END:VEVENT`);
const d1 = decideReminders(likeDefaults, calendarSettings, { timeZone: TZ });
check(d1.hasDefaultNotifications && d1.notifications === null && d1.components === undefined, 'an alarm equal to the calendar default is stored as "defaults"');
check(!('components' in withDecidedAlarms(likeDefaults, d1)), 'and the VEVENT handed to Proton carries no VALARM then');

// No alarms: a new event gets the defaults, an existing one has had them removed.
const none = veventOf(`BEGIN:VEVENT
UID:n@example
DTSTAMP:20261010T100000Z
DTSTART;TZID=Europe/Amsterdam:20261020T140000
DTEND;TZID=Europe/Amsterdam:20261020T150000
END:VEVENT`);
check(decideReminders(none, calendarSettings, { isCreate: true, timeZone: TZ }).hasDefaultNotifications, 'a new event without alarms: the calendar defaults');
const removed = decideReminders(none, calendarSettings, { isCreate: false, timeZone: TZ });
check(!removed.hasDefaultNotifications && removed.notifications?.length === 0, 'an existing event without alarms: no reminders (an empty list)');
check(decideReminders(none, { DefaultPartDayNotifications: [] }, { isCreate: false, timeZone: TZ }).hasDefaultNotifications, 'no alarms and no defaults: the same thing, stored as defaults');

// All-day: Calendar.app's absolute trigger (9:00 the day before, Amsterdam = 07:00Z in October) → -PT15H.
const allDay = veventOf(`BEGIN:VEVENT
UID:a@example
DTSTAMP:20261010T100000Z
DTSTART;VALUE=DATE:20261020
DTEND;VALUE=DATE:20261021
BEGIN:VALARM
TRIGGER;VALUE=DATE-TIME:20261019T070000Z
ACTION:DISPLAY
DESCRIPTION:Reminder
END:VALARM
END:VEVENT`);
const allDayAlarms = normalizeAlarms(allDay, TZ);
const allDayNotifications = decideReminders(allDay, { DefaultFullDayNotifications: [] }, { timeZone: TZ }).notifications;
check(JSON.stringify(allDayNotifications) === JSON.stringify([{ Type: 1, Trigger: '-PT15H' }]), `all-day absolute trigger 07:00Z the day before → -PT15H (9:00 local the day before): ${JSON.stringify(allDayNotifications)} (${JSON.stringify(allDayAlarms[0]?.trigger.value)})`);
check(decideReminders(allDay, calendarSettings, { timeZone: TZ }).hasDefaultNotifications, 'which equals the full-day default, so it is stored as "defaults"');
const utcAllDay = decideReminders(allDay, { DefaultFullDayNotifications: [] }, { timeZone: 'UTC' }).notifications;
check(utcAllDay?.[0]?.Trigger === '-PT17H', `the same absolute time read in UTC is 17 hours before (${utcAllDay?.[0]?.Trigger}): the local zone matters`);
// Across a DST change the arithmetic is on the wall clock: 2 days before at 9:00 stays "-P1DT15H".
const dstEvent = veventOf(`BEGIN:VEVENT
UID:dst@example
DTSTAMP:20260310T100000Z
DTSTART;VALUE=DATE:20260330
DTEND;VALUE=DATE:20260331
BEGIN:VALARM
TRIGGER;VALUE=DATE-TIME:20260328T080000Z
ACTION:DISPLAY
END:VALARM
BEGIN:VALARM
TRIGGER;VALUE=DATE-TIME:20260323T080000Z
ACTION:DISPLAY
END:VALARM
END:VEVENT`);
const dst = decideReminders(dstEvent, {}, { timeZone: TZ }).notifications;
check(JSON.stringify(dst) === JSON.stringify([{ Type: 1, Trigger: '-P1DT15H' }, { Type: 1, Trigger: '-P6DT15H' }]), `across the start of DST (29 March): 2 days / 1 week before at 9:00 → -P1DT15H / -P6DT15H, not an hour off: ${JSON.stringify(dst)}`);
const autumn = veventOf(`BEGIN:VEVENT
UID:dst2@example
DTSTAMP:20261010T100000Z
DTSTART;VALUE=DATE:20261026
DTEND;VALUE=DATE:20261027
BEGIN:VALARM
TRIGGER;VALUE=DATE-TIME:20261024T070000Z
ACTION:DISPLAY
END:VALARM
END:VEVENT`);
check(decideReminders(autumn, {}, { timeZone: TZ }).notifications?.[0]?.Trigger === '-P1DT15H', `across the end of DST (25 October): 2 days before at 9:00 → -P1DT15H (${decideReminders(autumn, {}, { timeZone: TZ }).notifications?.[0]?.Trigger})`);
const noTrigger = veventOf(`BEGIN:VEVENT
UID:nt@example
DTSTAMP:20261010T100000Z
DTSTART;VALUE=DATE:20261026
DTEND;VALUE=DATE:20261027
BEGIN:VALARM
ACTION:DISPLAY
END:VALARM
END:VEVENT`);
check(normalizeAlarms(noTrigger, TZ).length === 0, 'an alarm without TRIGGER is dropped, not a crash');
check(sameNotifications([{ Type: 1, Trigger: '-PT1H30M' }, { Type: 1, Trigger: '-PT0M' }], [{ Type: 1, Trigger: '-PT90M' }, { Type: 1, Trigger: 'PT0S' }]), 'triggers compare by meaning, not spelling (-PT1H30M = -PT90M, -PT0M = PT0S)');

// A relative all-day trigger (what the bridge serves from Proton) passes through unchanged.
const relativeAllDay = veventOf(`BEGIN:VEVENT
UID:r@example
DTSTAMP:20261010T100000Z
DTSTART;VALUE=DATE:20261020
DTEND;VALUE=DATE:20261021
BEGIN:VALARM
TRIGGER:-PT15H
ACTION:DISPLAY
END:VALARM
BEGIN:VALARM
TRIGGER:-P1W
ACTION:DISPLAY
END:VALARM
END:VEVENT`);
check(JSON.stringify(decideReminders(relativeAllDay, {}, { timeZone: TZ }).notifications) === JSON.stringify([{ Type: 1, Trigger: '-PT15H' }, { Type: 1, Trigger: '-P1W' }]), 'relative all-day triggers pass through (-PT15H, -P1W)');

// The cap.
const many = veventOf(`BEGIN:VEVENT
UID:m@example
DTSTAMP:20261010T100000Z
DTSTART;TZID=Europe/Amsterdam:20261020T140000
DTEND;TZID=Europe/Amsterdam:20261020T150000
${Array.from({ length: 12 }, (_, i) => `BEGIN:VALARM\nTRIGGER:-PT${i + 1}M\nACTION:DISPLAY\nEND:VALARM`).join('\n')}
END:VEVENT`);
check(normalizeAlarms(many, TZ).length === 10, `at most 10 alarms (Proton's limit): ${normalizeAlarms(many, TZ).length}`);

// Reading: Proton's notifications (or the defaults) → VALARM text for the served ICS.
const read = alarmsFromNotifications([{ Type: 1, Trigger: '-PT30M' }, { Type: 0, Trigger: '-P1D' }], false, calendarSettings);
const reminders = remindersOf({ component: 'vevent', components: read } as any, false);
check(!reminders.hasDefaults && reminders.alarms.length === 2, `two reminders read from Proton (${reminders.alarms.length}), not the defaults`);
check(/^BEGIN:VALARM\r\n[\s\S]*TRIGGER:-PT30M[\s\S]*ACTION:DISPLAY[\s\S]*DESCRIPTION:Reminder[\s\S]*END:VALARM$/.test(reminders.alarms[0]), `the first as ICS text, with the DESCRIPTION RFC 5545 wants:\n${reminders.alarms[0].replace(/\r\n/g, ' | ')}`);
check(/ACTION:EMAIL/.test(reminders.alarms[1]) && /TRIGGER:-P1D/.test(reminders.alarms[1]) && /SUMMARY:Reminder/.test(reminders.alarms[1]) && !/ATTENDEE/.test(reminders.alarms[1]), 'the email reminder as ACTION:EMAIL with a SUMMARY (no ATTENDEE without an address)');
const titled = remindersOf({ component: 'vevent', summary: { value: 'Team lunch' }, components: read } as any, false, 'me@proton.me');
check(/DESCRIPTION:Team lunch/.test(titled.alarms[0]) && /ATTENDEE:mailto:me@proton\.me/.test(titled.alarms[1]) && /SUMMARY:Team lunch/.test(titled.alarms[1]), 'with the event title and the account address: DESCRIPTION / SUMMARY / ATTENDEE filled in');
const defaults = alarmsFromNotifications(null, true, calendarSettings);
const defaultReminders = remindersOf({ component: 'vevent', components: defaults } as any, true);
check(defaultReminders.hasDefaults && defaultReminders.alarms.length === 1 && /TRIGGER:-PT15H/.test(defaultReminders.alarms[0]), `an all-day event on the defaults: hasDefaults, one alarm -PT15H (${defaultReminders.alarms[0]?.match(/TRIGGER[^\r]*/)?.[0]})`);

// Round trip of the text form.
const blocks = alarmBlocksOf(`BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:x\r\n${reminders.alarms.join('\r\n')}\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n`);
check(blocks.length === 2, 'alarm blocks found in ICS text');
const reparsed = parseAlarmBlocks(blocks);
check(reparsed.length === 2 && serializeAlarms(reparsed).join('|') === reminders.alarms.join('|'), 'text → components → text is stable');
check(JSON.stringify(decideReminders({ component: 'vevent', dtstart: timed.dtstart, components: reparsed } as any, calendarSettings, { timeZone: TZ }).notifications) === JSON.stringify([{ Type: 1, Trigger: '-PT30M' }, { Type: 0, Trigger: '-P1D' }]), 'and the served alarms, sent back by a client as they are, decide to the same notifications');
check(sameNotifications([{ Type: 1, Trigger: '-PT15M' }, { Type: 1, Trigger: '-PT15M' }], defaultNotifications(calendarSettings, false)), 'sameNotifications ignores duplicates and order');

// 0.41.8: one alarm written three ways ("-PT15M", "-PT0H15M", "-P0DT0H15M0S"), as several clients do, is one notification.
const spelledAlarm = (trigger: string) => `BEGIN:VALARM\nTRIGGER:${trigger}\nACTION:EMAIL\nSUMMARY:x\nDESCRIPTION:x\nATTENDEE:mailto:tobi@proton.me\nEND:VALARM`;
const spelledIcs = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'BEGIN:VEVENT', 'UID:s1', 'DTSTAMP:20261001T000000Z', `DTSTART;TZID=${TZ}:20261020T100000`, `DTEND;TZID=${TZ}:20261020T110000`, spelledAlarm('-PT15M'), spelledAlarm('-PT0H15M'), spelledAlarm('-P0DT0H15M0S'), 'END:VEVENT', 'END:VCALENDAR'].join('\n');
const three = normalizeAlarms(veventOf(spelledIcs), TZ);
check(three.length === 1, `three spellings of "15 minutes before": one alarm (${three.length})`);

console.log(failures ? `\n${failures} check(s) failed` : '\nall reminders checks passed');
process.exit(failures ? 1 : 0);
