/**
 * Offline test for 0.42.2: a calendar colour from Calendar.app becomes one of Proton's accent colours,
 * and a new colour always changes the calendar — when Proton's closest colour is the calendar's own,
 * the next closest is taken.
 */
import { normalizeCalendarColor } from '../src/proton-calendar-api.ts';

let failures = 0;
const check = (condition: unknown, label: string) => {
    console.log(`${condition ? 'ok  ' : 'FAIL'} ${label}`);
    if (!condition) failures += 1;
};

const ORANGE = '#F78400';
check(normalizeCalendarColor('#FFCC00FF') === ORANGE, "Calendar.app's yellow is closest to Proton's orange");
check(normalizeCalendarColor('#FFCC00FF', '#5252CC') === ORANGE, 'on a calendar of another colour it becomes orange');
const shifted = normalizeCalendarColor('#FFCC00FF', ORANGE);
check(shifted !== ORANGE && /^#[0-9A-F]{6}$/.test(shifted), `on an orange calendar it becomes the next closest (${shifted}), not orange again`);
check(normalizeCalendarColor('#f78400', ORANGE) === ORANGE, "the calendar's own colour keeps it");
check(normalizeCalendarColor('#F98602FF', ORANGE) === ORANGE, 'a colour nearly the same as its own keeps it (Calendar.app rounding)');
check(normalizeCalendarColor('#FF2968FF', ORANGE) === '#EC3E7C', 'a colour closest to another one: that one, as before');
check(normalizeCalendarColor('#FFCC00', 'not a colour') === ORANGE, 'an unreadable current colour changes nothing');
let threw = false;
try {
    normalizeCalendarColor('yellow');
} catch {
    threw = true;
}
check(threw, 'not a colour: refused');

if (failures) {
    console.error(`${failures} check(s) failed`);
    process.exit(1);
}
console.log('calendar colours: all checks passed');
