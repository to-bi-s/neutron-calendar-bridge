/**
 * Makes an unencrypted local copy as 0.23 could leave it after a crash, then dies (SIGKILL):
 * - journal: a transaction in progress, its original pages in a hot rollback journal;
 * - wal: committed rows still only in the write-ahead log.
 * Usage: node make-crashed-copy.cjs <file> <journal|wal>
 */
const sqlite3 = require('@journeyapps/sqlcipher');

const [file, mode] = process.argv.slice(2);
const db = new sqlite3.Database(file);
const insert = (id, name) =>
    `INSERT INTO calendars (proton_calendar_id, slug, display_name, color, ctag) VALUES ('${id}', '${id}', '${name}', '#000000', '1')`;
db.serialize(() => {
    if (mode === 'wal') db.run('PRAGMA journal_mode=WAL');
    db.run(
        'CREATE TABLE calendars (proton_calendar_id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL, color TEXT NOT NULL, ' +
            "description TEXT NOT NULL DEFAULT '', visible INTEGER NOT NULL DEFAULT 1, removed INTEGER NOT NULL DEFAULT 0, ctag TEXT NOT NULL, " +
            'last_polled_at INTEGER, last_synced_at INTEGER)'
    );
    db.run(insert('committed', 'Committed calendar'));
    if (mode === 'wal') {
        db.run('PRAGMA wal_autocheckpoint=0');
        db.run(insert('in-wal', 'Only in the WAL'), () => process.kill(process.pid, 'SIGKILL'));
    } else {
        db.run('PRAGMA cache_size=1');
        db.run('BEGIN');
        // Enough writes to spill pages into the file while the journal holds the originals.
        for (let index = 0; index < 2000; index += 1) db.run(insert(`uncommitted-${index}`, `Uncommitted ${'x'.repeat(200)}`));
        db.run('SELECT 1', () => process.kill(process.pid, 'SIGKILL'));
    }
});
