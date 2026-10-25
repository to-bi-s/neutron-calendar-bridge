import { createHash, randomBytes } from 'node:crypto';
import { homedir } from 'node:os';

/**
 * Quiet logs (0.24). bridge.log (and the terminal) leave out what is private unless "Detailed
 * logging" is on in Developer settings, so the log can be looked at, or sent along with a bug
 * report, without showing your calendars:
 * - parts of a log line marked with secret() (event titles, email subjects, calendar names, email
 *   text, calendar files, request paths naming a calendar or event) are written as ‹private›;
 * - email addresses as ‹address 1a2b›: the same tag for the same address within one run (so lines
 *   can still be told apart), a different one after a restart (so the tag cannot be checked
 *   against a guessed address in another log);
 * - your home folder as ~.
 */
const OPEN = '\u0001';
const CLOSE = '\u0002';
const MARKED = /\u0001([^\u0001\u0002]*)\u0002/g;
const STRAY_MARKS = /[\u0001\u0002]/g;
const ADDRESS = /[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;
const RUN_SALT = randomBytes(16);

/** Marks a private part of a log line: shown only with detailed logging. */
export const secret = (value: unknown) => `${OPEN}${String(value ?? '').replace(STRAY_MARKS, '')}${CLOSE}`;

/** Detailed logging is on until then (ms since 1970; 0: off; Infinity: until switched off). */
let detailedUntil = 0;

export const setDetailedLogging = (until: number) => {
    detailedUntil = until;
};

export const isDetailedLogging = (now = Date.now()) => now < detailedUntil;

const addressTag = (address: string) =>
    `‹address ${createHash('sha256').update(RUN_SALT).update(address.toLowerCase()).digest('hex').slice(0, 4)}›`;

const escapeForPattern = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const home = (() => {
    try {
        const folder = homedir();
        return folder && folder !== '/' ? new RegExp(`${escapeForPattern(folder)}(?=/|$|\\s)`, 'g') : null;
    } catch {
        return null;
    }
})();

/** A log line as it is written: private parts hidden, or with detailed logging only the marks removed. */
export const logLine = (line: string, detailed = isDetailedLogging()) => {
    if (detailed) {
        return line.replace(MARKED, '$1').replace(STRAY_MARKS, '');
    }
    const quiet = line.replace(MARKED, '‹private›').replace(STRAY_MARKS, '').replace(ADDRESS, addressTag);
    return home ? quiet.replace(home, '~') : quiet;
};

/** For notifications without details: email addresses left out. */
export const withoutAddresses = (text: string) => text.replace(ADDRESS, '(address hidden)');
