/**
 * Which app a CalDAV request comes from (0.49.1), and its name for messages (0.49.6).
 *
 * The User-Agent decides: Thunderbird (checked first: its string also names "Mac OS X"), Calendar.app
 * and its helpers (CalendarAgent, dataaccessd, accountsd, …), or another CalDAV app, named after the
 * first product in the string that is not a browser engine ("BusyCal/2025.1 (Macintosh…)" → BusyCal).
 * Nothing is kept of the string itself.
 *
 * The CalDAV server runs each request inside `runWithClient`, so the texts of refusals deep in the
 * bridge can name the app that asked ("Thunderbird shows the current version after its next
 * refresh") without the client being threaded through every call; outside a request (sync passes,
 * the queue) the name is a neutral "your calendar app".
 */
import { AsyncLocalStorage } from 'node:async_hooks';

import { t } from './i18n';
import type { CalDAVClient } from '../shared/types';

const GENERIC_PRODUCTS = /^(?:Mozilla|AppleWebKit|Gecko|KHTML|Safari|Version|CFNetwork|Darwin|Macintosh|Intel|Mac|OS|X|like|rv|Thunderbird)$/i;

export const caldavClientOf = (userAgent: string | undefined): CalDAVClient => {
    const agent = (userAgent ?? '').trim();
    if (/\bThunderbird\b/i.test(agent)) {
        return { kind: 'thunderbird', name: null };
    }
    if (/\b(?:CalendarAgent|dataaccessd|accountsd|remindd|CoreDAV|iOS\/|macOS\/|Mac OS X\/|CalendarFoundation|Calendar\/)/i.test(agent)) {
        return { kind: 'calendar-app', name: null };
    }
    const products = agent.match(/[A-Za-z][A-Za-z0-9._-]*(?=\/\d)/g) ?? [];
    const name = products.find((product) => product.length >= 3 && !GENERIC_PRODUCTS.test(product)) ?? null;
    return { kind: 'other', name: name ? name.slice(0, 40) : null };
};

/** The app's name for the user: Calendar.app, Thunderbird, another app's own name, or undefined (unknown). */
export const clientDisplayName = (client?: CalDAVClient | null): string | undefined =>
    !client || client.kind === 'calendar-app' ? 'Calendar.app' : client.kind === 'thunderbird' ? 'Thunderbird' : client.name ?? undefined;

const storage = new AsyncLocalStorage<CalDAVClient>();

/** Runs a request's handling with its app known to everything inside. */
export const runWithClient = <T>(client: CalDAVClient, run: () => T): T => storage.run(client, run);

/** The app behind the running request, if any. */
export const currentClient = (): CalDAVClient | null => storage.getStore() ?? null;

/** The app's name for a message: the request's app when known, else "your calendar app". */
export const currentAppName = (): string => {
    const client = currentClient();
    return (client && clientDisplayName(client)) || t('your calendar app');
};
