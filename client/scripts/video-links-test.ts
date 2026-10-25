/**
 * Offline test for video links (0.34.1): the conference properties read from and written to a
 * vevent, their ICS lines (parsed back by Proton's own parser), the description block, the
 * location trigger. Creating a room needs Proton: live scenario `video`.
 */
import { parse, serialize } from '@proton/shared/lib/calendar/vcal';

import {
    SEPARATOR_PROTON_EVENTS,
    conferenceLines,
    conferenceOf,
    conferenceOfIcs,
    conferenceRemovalLines,
    descriptionWithConference,
    descriptionWithoutConference,
    parseProtonMeetUrl,
    protonMeetUrl,
    randomString,
    videoProviderOfLocation,
    withConference,
} from '../src/video-links.ts';

let failures = 0;
const check = (condition: unknown, label: string) => {
    console.log(`${condition ? 'ok  ' : 'FAIL'} ${label}`);
    if (!condition) failures += 1;
};

const meet = { provider: 2 as const, id: 'R4W0NWGAPM', url: protonMeetUrl('R4W0NWGAPM', 'WHZqjp7mRFg2'), host: 'tobi@proton.me' };
const zoom = { provider: 1 as const, id: '123456789', url: 'https://us02web.zoom.us/j/123456789?pwd=abc', password: 'abc', host: 'tobi@proton.me' };

// vevent round trip
const base: any = { component: 'vevent', uid: { value: 'u1' }, summary: { value: 'Call' } };
const withMeet = withConference(base, meet);
check(JSON.stringify(conferenceOf(withMeet)) === JSON.stringify(meet), 'Proton Meet: written to and read from a vevent');
check(withMeet['x-pm-conference-id'].parameters['x-pm-provider'] === '2' && !('x-pm-password' in withMeet['x-pm-conference-url'].parameters), 'provider parameter, no password parameter for Meet');
const withZoom = withConference(withMeet, zoom);
check(JSON.stringify(conferenceOf(withZoom)) === JSON.stringify(zoom), 'Zoom replaces it, with its passcode');
check(conferenceOf(withConference(withZoom, null)) === undefined, 'null removes it');
check(withConference(withZoom, undefined) === withZoom, 'undefined leaves it');
check(conferenceOf(base) === undefined && conferenceOf(undefined) === undefined, 'none on a plain vevent');

// ICS lines, parsed back by Proton's parser (as the bridge's served ICS comes back from Calendar.app)
const ics = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'BEGIN:VEVENT', 'UID:u1', 'DTSTAMP:20260101T000000Z', 'DTSTART:20261005T090000Z', 'DTEND:20261005T100000Z', 'SUMMARY:Call', ...conferenceLines(zoom), 'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
const parsed: any = parse(ics);
const vevent = parsed.components.find((c: any) => c.component === 'vevent');
check(JSON.stringify(conferenceOf(vevent)) === JSON.stringify(zoom), `Proton's parser reads the lines back (${JSON.stringify(conferenceOf(vevent))})`);
check(JSON.stringify(conferenceOfIcs(ics)) === JSON.stringify(zoom), 'and so does the text reader');
check(JSON.stringify(conferenceOfIcs(['BEGIN:VEVENT', ...conferenceLines(meet), 'END:VEVENT'].join('\r\n'))) === JSON.stringify(meet), 'Meet lines read back');
check(conferenceOfIcs('BEGIN:VEVENT\r\nUID:x\r\nEND:VEVENT') === undefined, 'no lines, no conference');
const reserialized = serialize(withConference(vevent, meet));
check(/X-PM-CONFERENCE-ID;X-PM-PROVIDER=2:R4W0NWGAPM/.test(reserialized) && /X-PM-CONFERENCE-URL;X-PM-HOST=tobi@proton.me:https:\/\/meet\.proton\.me\/join\/id-R4W0NWGAPM#pwd-WHZqjp7mRFg2/.test(reserialized.replace(/\r\n /g, '')), `Proton serialises them the same way (${reserialized.match(/X-PM[^\r\n]*/g)?.join(' | ')})`);

// description block
const described = descriptionWithConference('Agenda', meet);
check(described === `Agenda\n${SEPARATOR_PROTON_EVENTS}\nJoin Proton Meet: ${meet.url}\n${SEPARATOR_PROTON_EVENTS}`, 'the Meet block after the text');
check(descriptionWithConference('', meet).startsWith(`\n${SEPARATOR_PROTON_EVENTS}`), 'with an empty description: the block alone');
check(descriptionWithoutConference(described) === 'Agenda', 'removed again');
check(descriptionWithConference(described, zoom).includes('Join Zoom Meeting: ' + zoom.url + ' (ID: 123456789, passcode: abc)') && descriptionWithConference(described, zoom).split(SEPARATOR_PROTON_EVENTS).length === 3, 'an older block is replaced, Zoom with ID and passcode');
check(descriptionWithConference('Agenda', undefined) === 'Agenda', 'nothing to add: unchanged');

// trigger
check(videoProviderOfLocation('Proton Meet') === 2 && videoProviderOfLocation(' protonmeet ') === 2 && videoProviderOfLocation('Meet') === 2, 'Proton Meet as a location');
check(videoProviderOfLocation('Zoom') === 1 && videoProviderOfLocation('zoom meeting') === 1, 'Zoom as a location');
check(videoProviderOfLocation('Zoom office') === null && videoProviderOfLocation('') === null && videoProviderOfLocation(undefined) === null, 'anything else is a place');

// links and the removal marker
check(JSON.stringify(parseProtonMeetUrl(meet.url)) === JSON.stringify({ linkName: 'R4W0NWGAPM', password: 'WHZqjp7mRFg2' }), 'a Meet link is taken apart');
check(parseProtonMeetUrl(zoom.url) === null && parseProtonMeetUrl('https://meet.proton.me/join/id-short#pwd-x') === null, 'other links are not');
const removalIcs = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'BEGIN:VEVENT', 'UID:u1', 'DTSTAMP:20260101T000000Z', 'DTSTART:20261005T090000Z', 'DTEND:20261005T100000Z', ...conferenceRemovalLines(), 'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
const removalVevent: any = (parse(removalIcs) as any).components.find((c: any) => c.component === 'vevent');
check('x-pm-conference-id' in removalVevent && conferenceOf(removalVevent) === undefined, 'the removal marker parses to empty properties, which mean no conference');

// password strings
check(/^[A-Za-z0-9]{12}$/.test(randomString(12)) && randomString(12) !== randomString(12), 'random 12-character passwords');

if (failures) {
    console.error(`${failures} video-link check(s) failed`);
    process.exit(1);
}
console.log('all video-link checks passed');
