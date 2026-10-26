/**
 * 1.0.5: Thunderbird's own alert state. Thunderbird keeps "dismissed up to" (`X-MOZ-LASTACK`) and
 * "snoozed until" (`X-MOZ-SNOOZE-TIME`, for an occurrence of a series `X-MOZ-SNOOZE-TIME-<occurrence>`
 * on the series) in the event itself and saves the event to record them. Proton stores neither, so
 * such a save writes nothing to Proton, and the copy served back used to come without them:
 * Thunderbird read it at once and forgot the snooze (snoozed alerts never came back). The served
 * copy now keeps the lines of the last save that had any, per VEVENT (by RECURRENCE-ID), also when
 * the event is rebuilt from Proton by the sync. Plain text work on the VEVENT's own lines.
 */
import { createHash } from 'node:crypto';

import { BridgeEventRecord } from '../shared/types';

const STATE_LINE = /^X-MOZ-(LASTACK|SNOOZE-TIME(-[^;:]*)?)[;:]/i;

/** True when an ICS comes from an app that keeps its alert state this way (Thunderbird and its relatives). */
export const carriesAlarmState = (ics: string) => /^X-MOZ-/im.test(ics);

/** The state lines of each VEVENT, by its RECURRENCE-ID value ('' for the series or a single event). */
const stateLinesByOccurrence = (ics: string) => {
    const found = new Map<string, string[]>();
    let lines: string[] | null = null;
    let key = '';
    let depth = 0;
    for (const line of ics.replace(/\r?\n[ \t]/g, '').split(/\r?\n/)) {
        if (/^BEGIN:VEVENT\s*$/i.test(line)) {
            lines = [];
            key = '';
            depth = 0;
        } else if (lines && /^END:VEVENT\s*$/i.test(line)) {
            if (lines.length) found.set(key, lines);
            lines = null;
        } else if (lines) {
            if (/^BEGIN:/i.test(line)) depth += 1;
            else if (/^END:/i.test(line)) depth -= 1;
            else if (depth === 0 && /^RECURRENCE-ID[;:]/i.test(line)) key = line.slice(line.indexOf(':') + 1).trim();
            else if (depth === 0 && STATE_LINE.test(line)) lines.push(line);
        }
    }
    return found;
};

/**
 * `target` with the alert state of `source` in each of its VEVENTs (its own state lines replaced, so a
 * dismissed snooze goes too). The same text when nothing changes; otherwise the row's ETag follows.
 */
export const withAlarmStateOf = (target: BridgeEventRecord, source: string): BridgeEventRecord => {
    const state = stateLinesByOccurrence(source);
    const eol = target.serializedIcs.includes('\r\n') ? '\r\n' : '\n';
    const out: string[] = [];
    let block: string[] | null = null;
    let key = '';
    let depth = 0;
    for (const line of target.serializedIcs.split(/\r?\n/)) {
        if (/^BEGIN:VEVENT\s*$/i.test(line)) {
            block = [line];
            key = '';
            depth = 0;
            continue;
        }
        if (!block) {
            out.push(line);
            continue;
        }
        if (/^END:VEVENT\s*$/i.test(line)) {
            out.push(...block, ...(state.get(key) ?? []), line);
            block = null;
            continue;
        }
        if (/^BEGIN:/i.test(line)) depth += 1;
        else if (/^END:/i.test(line)) depth -= 1;
        else if (depth === 0 && /^RECURRENCE-ID[;:]/i.test(line)) key = line.slice(line.indexOf(':') + 1).trim();
        if (depth === 0 && STATE_LINE.test(line)) continue;
        block.push(line);
    }
    const serializedIcs = out.join(eol);
    if (serializedIcs === target.serializedIcs) {
        return target;
    }
    // A copy with state lines is hashed as text, so the sync rebuilding the same copy gets the same ETag.
    const contentHash = createHash('sha256').update(serializedIcs).digest('hex');
    return { ...target, serializedIcs, contentHash, etag: `"${contentHash}"` };
};
