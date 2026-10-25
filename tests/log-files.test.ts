/**
 * Stage 3 (0.24): the logs written before 0.24 (titles, addresses, the email text of dry runs) are
 * deleted at the first start, once; Developer settings can delete the logs at any time.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { deleteLogFiles, removeOldLogsOnce } from '../src/main/log-files';

test('the logs from before 0.24 are deleted once; later logs are kept', () => {
    const logDir = mkdtempSync(join(tmpdir(), 'neutron-calendar-bridge-logdir-'));
    try {
        writeFileSync(join(logDir, 'bridge.log'), 'sent: invitation for "Dentist" to anna@example.org\n');
        writeFileSync(join(logDir, 'bridge.log.1'), 'older\n');
        writeFileSync(join(logDir, 'other.txt'), 'not ours\n');
        assert.equal(removeOldLogsOnce(logDir), true);
        assert.deepEqual(readdirSync(logDir).sort(), ['.quiet-logs', 'other.txt']);
        assert.equal(statSync(join(logDir, '.quiet-logs')).mode & 0o777, 0o600);

        writeFileSync(join(logDir, 'bridge.log'), 'quiet line\n');
        assert.equal(removeOldLogsOnce(logDir), false, 'only once');
        assert.ok(existsSync(join(logDir, 'bridge.log')), 'the quiet log is kept');

        deleteLogFiles(logDir);
        assert.deepEqual(readdirSync(logDir).sort(), ['.quiet-logs', 'other.txt'], '"Delete the Logs"');
        deleteLogFiles(logDir); // nothing there: no error
    } finally {
        rmSync(logDir, { recursive: true, force: true });
    }
});

test('a fresh install has nothing to delete', () => {
    const logDir = mkdtempSync(join(tmpdir(), 'neutron-calendar-bridge-logdir-'));
    try {
        assert.equal(removeOldLogsOnce(logDir), false);
        assert.deepEqual(readdirSync(logDir), ['.quiet-logs']);
    } finally {
        rmSync(logDir, { recursive: true, force: true });
    }
});
