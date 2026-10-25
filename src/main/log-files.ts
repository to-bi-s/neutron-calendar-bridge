import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Written once the logs from before 0.24 (with titles, addresses and email text) are gone. */
const QUIET_MARKER = '.quiet-logs';

export const LOG_FILE_NAMES = ['bridge.log', 'bridge.log.1'];

/** Deletes bridge.log and bridge.log.1. */
export const deleteLogFiles = (logDir: string) => {
    for (const name of LOG_FILE_NAMES) {
        rmSync(join(logDir, name), { force: true });
    }
};

/**
 * The first start of 0.24: the logs written before (titles, calendar names, addresses, subjects and
 * the email text of dry runs) are deleted, so that from now on the log only holds quiet lines
 * (unless detailed logging is switched on). True when they were deleted.
 */
export const removeOldLogsOnce = (logDir: string) => {
    const marker = join(logDir, QUIET_MARKER);
    if (existsSync(marker)) {
        return false;
    }
    const hadLogs = LOG_FILE_NAMES.some((name) => existsSync(join(logDir, name)));
    deleteLogFiles(logDir);
    writeFileSync(marker, 'The logs from before 0.24 were deleted; bridge.log is quiet unless detailed logging is on.\n', { mode: 0o600 });
    return hadLogs;
};
