/**
 * How the bridge's notifications reach macOS (notification-center.ts): the same key once a minute,
 * more than three within 10 s summed up (naming the page with the details), a long stream summed up
 * every 30 s, "connected again" removing "cannot be reached", a click opening the page, and only a
 * bounded number kept referenced.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import type { BridgeNotification } from '../src/main/bridge-service';
import { createNotificationCenter } from '../src/main/notification-center';

const setup = () => {
    let clock = 1_000_000;
    const timers: Array<{ at: number; run: () => void }> = [];
    const shown: Array<{ title: string; subtitle?: string; body: string; closed: boolean; click: () => void }> = [];
    const opened: string[] = [];
    const center = createNotificationCenter({
        appName: 'Neutron Calendar Bridge',
        create: (content) => {
            const handlers: Record<string, () => void> = {};
            const entry = { ...content, closed: false, click: () => handlers.click?.() };
            shown.push(entry);
            return {
                on: (event: string, handler: () => void) => {
                    handlers[event] = handler;
                },
                show: () => undefined,
                close: () => {
                    entry.closed = true;
                    handlers.close?.();
                }
            };
        },
        open: (page) => opened.push(page),
        now: () => clock,
        schedule: (run, ms) => timers.push({ at: clock + ms, run })
    });
    /** Lets time pass, running what is due. */
    const advance = (ms: number) => {
        clock += ms;
        for (const timer of timers.filter((entry) => entry.at <= clock)) {
            timers.splice(timers.indexOf(timer), 1);
            timer.run();
        }
    };
    const note = (key: string, page: BridgeNotification['page'] = 'calendars', extra: Partial<BridgeNotification> = {}): BridgeNotification => ({
        key,
        title: `Title ${key}`,
        body: `Body ${key}`,
        page,
        ...extra
    });
    return { center, shown, opened, advance, note };
};

test('the same notification within a minute is shown once; a click opens its page', () => {
    const { center, shown, opened, advance, note } = setup();
    center.show(note('a', 'settings', { subtitle: 'Team meeting — Tobi (Private)' }));
    center.show(note('a', 'settings'));
    assert.equal(shown.length, 1);
    assert.deepEqual(
        { title: shown[0].title, subtitle: shown[0].subtitle, body: shown[0].body },
        { title: 'Title a', subtitle: 'Team meeting — Tobi (Private)', body: 'Body a' },
        'only what macOS shows is passed on'
    );
    shown[0].click();
    assert.deepEqual(opened, ['settings']);
    advance(61_000);
    center.show(note('a', 'settings'));
    assert.equal(shown.length, 2, 'again after a minute');
});

test('more than three within 10 s: one summary naming the page with the reasons', () => {
    const { center, shown, opened, advance, note } = setup();
    for (const key of ['a', 'b', 'c', 'd', 'e']) center.show(note(key));
    assert.deepEqual(shown.map((entry) => entry.title), ['Title a', 'Title b', 'Title c'], 'three one by one, the rest held');
    advance(10_000);
    assert.equal(shown.length, 4);
    assert.equal(shown[3].title, 'Neutron Calendar Bridge');
    assert.equal(shown[3].body, '2 more changes need your attention. The Calendars page shows the reasons.');
    shown[3].click();
    assert.deepEqual(opened, ['calendars']);

    // Mixed kinds: the summary does not claim they are all changes.
    advance(60_000);
    for (const key of ['f', 'g', 'h']) center.show(note(key));
    center.show(note('mail', 'settings'));
    center.show(note('connection:lost', 'overview'));
    advance(10_000);
    assert.equal(shown.at(-1)!.body, '2 more notifications. The app shows the details.');
    shown.at(-1)!.click();
    assert.equal(opened.at(-1), 'overview');
});

test('a single held notification is shown as it is', () => {
    const { center, shown, advance, note } = setup();
    for (const key of ['a', 'b', 'c', 'd']) center.show(note(key));
    advance(10_000);
    assert.deepEqual(shown.map((entry) => entry.title), ['Title a', 'Title b', 'Title c', 'Title d']);
});

test('a long stream: a summary every 30 s, not every notification', () => {
    const { center, shown, advance, note } = setup();
    for (let second = 0; second < 120; second += 1) {
        center.show(note(`n${second}`));
        advance(1000);
    }
    const summaries = shown.filter((entry) => entry.title === 'Neutron Calendar Bridge');
    assert.equal(shown.length - summaries.length, 3, 'three one by one at the start');
    assert.ok(summaries.length >= 3 && summaries.length <= 5, `${summaries.length} summaries in two minutes`);
    assert.ok(summaries.every((entry, index) => index === 0 || /more changes/.test(entry.body)));
    // Only the newest summary stays on screen.
    assert.equal(summaries.filter((entry) => !entry.closed).length, 1);
});

test('"connected again" removes "cannot be reached", which can come back later', () => {
    const { center, shown, advance, note } = setup();
    center.show(note('connection:lost', 'overview'));
    advance(20_000);
    center.show(note('connection:back', 'overview', { replaces: 'connection:lost' }));
    assert.equal(shown.length, 2, 'shown although less than a minute later');
    assert.equal(shown[0].closed, true, 'the old one is gone');
    advance(5_000);
    center.show(note('connection:lost', 'overview'));
    assert.equal(shown.length, 3, 'a new outage is announced again');
});

test('at most 50 notifications are kept referenced', () => {
    const { center, advance, note } = setup();
    for (let index = 0; index < 120; index += 1) {
        center.show(note(`k${index}`, 'overview'));
        advance(11_000);
    }
    assert.ok(center.liveCount() <= 50, `${center.liveCount()} kept`);
});
