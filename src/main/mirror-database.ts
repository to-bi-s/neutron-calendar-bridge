import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readdirSync, readSync, renameSync, rmSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

import sqlite3 from '@journeyapps/sqlcipher';

import { BridgeCalendarRecord, BridgeEventRecord, CalendarKind } from '../shared/types';

const CALENDAR_KINDS: CalendarKind[] = ['own', 'shared', 'subscribed', 'holidays'];

type Row = Record<string, unknown>;

const toCalendarRecord = (row: Row): BridgeCalendarRecord => ({
    protonCalendarId: String(row.proton_calendar_id),
    slug: String(row.slug),
    displayName: String(row.display_name),
    color: String(row.color || '#5865F2'),
    description: String(row.description || ''),
    visible: Boolean(row.visible),
    removed: Boolean(row.removed),
    ctag: String(row.ctag),
    lastPolledAt: row.last_polled_at === null ? null : Number(row.last_polled_at),
    lastSyncedAt: row.last_synced_at === null ? null : Number(row.last_synced_at),
    readOnly: Boolean(row.read_only),
    readOnlyReason: typeof row.read_only_reason === 'string' && row.read_only_reason ? row.read_only_reason : null,
    kind: CALENDAR_KINDS.includes(row.kind as CalendarKind) ? (row.kind as CalendarKind) : 'own',
    feedCursor: typeof row.feed_cursor === 'string' && row.feed_cursor ? row.feed_cursor : null,
    fullSyncedAt: row.full_synced_at === null || row.full_synced_at === undefined ? null : Number(row.full_synced_at)
});

/** 0.35: a change from Calendar.app waiting for Proton. */
export interface OutboxItem {
    id: number;
    createdAt: number;
    protonCalendarId: string;
    slug: string;
    uid: string;
    /** 0.42: 'appearance' — a calendar's name/colour/description (uid CALENDAR_APPEARANCE_UID, ics the JSON of the changes, snapshot the calendar row). */
    kind: 'put' | 'delete' | 'appearance';
    resourceName: string;
    href: string;
    /** The ICS Calendar.app sent (a put). */
    ics: string | null;
    notifyOrganizer: boolean;
    /** The mirror row as it was before the first change (null: the event was new). */
    snapshot: BridgeEventRecord | null;
    attempts: number;
    lastError: string | null;
    lastAttemptAt: number | null;
}

const toOutboxItem = (row: Row): OutboxItem => {
    let snapshot: BridgeEventRecord | null = null;
    if (typeof row.snapshot === 'string' && row.snapshot) {
        try {
            snapshot = JSON.parse(row.snapshot) as BridgeEventRecord;
        } catch {
            snapshot = null;
        }
    }
    return {
        id: Number(row.id),
        createdAt: Number(row.created_at),
        protonCalendarId: String(row.proton_calendar_id),
        slug: String(row.slug),
        uid: String(row.uid),
        kind: row.kind === 'delete' || row.kind === 'appearance' ? row.kind : 'put',
        resourceName: String(row.resource_name),
        href: String(row.href),
        ics: typeof row.ics === 'string' ? row.ics : null,
        notifyOrganizer: Boolean(row.notify_organizer),
        snapshot,
        attempts: Number(row.attempts || 0),
        lastError: typeof row.last_error === 'string' ? row.last_error : null,
        lastAttemptAt: row.last_attempt_at === null || row.last_attempt_at === undefined ? null : Number(row.last_attempt_at)
    };
};

const toEventRecord = (row: Row): BridgeEventRecord => ({
    protonEventId: String(row.proton_event_id),
    protonCalendarId: String(row.proton_calendar_id),
    uid: String(row.uid),
    href: String(row.href),
    etag: String(row.etag),
    contentHash: String(row.content_hash),
    serializedIcs: String(row.serialized_ics),
    title: String(row.title || ''),
    description: String(row.description || ''),
    location: String(row.location || ''),
    startTimestamp: Number(row.start_timestamp),
    endTimestamp: Number(row.end_timestamp),
    timezone: String(row.timezone || 'UTC'),
    isAllDay: Boolean(row.is_all_day),
    modifiedTimestamp: Number(row.modified_timestamp),
    deleted: Boolean(row.deleted),
    lastSyncedAt: Number(row.last_synced_at),
    protonEventIds: parseEventIds(row.proton_event_ids, String(row.proton_event_id))
});

const parseEventIds = (raw: unknown, protonEventId: string): Record<string, string> => {
    if (typeof raw === 'string' && raw) {
        try {
            const parsed = JSON.parse(raw);
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                return parsed as Record<string, string>;
            }
        } catch {
            // Fall through to the single-event default.
        }
    }
    return { '': protonEventId };
};

/** The files SQLite keeps next to a database. */
const SIDE_FILES = ['-wal', '-shm', '-journal'];

/** An unencrypted SQLite file starts with this header; an encrypted one looks like random bytes. */
const isUnencryptedDatabase = (filePath: string) => {
    if (!existsSync(filePath) || statSync(filePath).size < 16) {
        return false;
    }
    const header = Buffer.alloc(16);
    const fd = openSync(filePath, 'r');
    try {
        readSync(fd, header, 0, 16, 0);
    } finally {
        closeSync(fd);
    }
    return header.toString('latin1') === 'SQLite format 3\u0000';
};

const removeWithSideFiles = (filePath: string) => {
    for (const suffix of ['', ...SIDE_FILES]) {
        rmSync(`${filePath}${suffix}`, { force: true });
    }
};

/** Side files first: a journal must never be left next to a different main file (SQLite would roll it back into it). */
const moveWithSideFiles = (from: string, to: string) => {
    for (const suffix of [...SIDE_FILES, '']) {
        if (existsSync(`${from}${suffix}`)) {
            renameSync(`${from}${suffix}`, `${to}${suffix}`);
        }
    }
};

/** SQLCipher's raw key form: 64 hex digits, no key derivation (the key is random, not a password), as a string literal. */
const keyPragma = (key: string) => {
    if (!/^[0-9a-f]{64}$/i.test(key)) {
        throw new Error('The local copy needs a 256-bit key (64 hex digits).');
    }
    return `'x''${key}'''`;
};

/**
 * SQLCipher 4's settings (page size, HMAC, KDF) pinned: a later SQLCipher with other defaults still
 * opens the copy with the right key (instead of taking it for a wrong one and setting it aside).
 */
const CIPHER_SETTINGS = 'PRAGMA cipher_compatibility = 4;';

/** Errors that will not go away by trying again: the file is damaged (or not SQLite at all). */
const isLastingDamage = (error: unknown) => {
    const code = (error as { code?: string } | null)?.code;
    return code === 'SQLITE_CORRUPT' || code === 'SQLITE_NOTADB' || code === 'MIRROR_CHECK_FAILED';
};

const sqlString = (value: string) => `'${value.replace(/'/g, "''")}'`;

export interface MirrorOpenResult {
    /** An unencrypted copy (before 0.24) was converted in place. */
    converted: boolean;
    /** The file could not be opened with the key, or was damaged, and was set aside; a new, empty copy was started. */
    replacedBy?: string;
    /** Nothing on disk this run (the key could not be had). */
    inMemory: boolean;
    /** The unencrypted copy from before was damaged: deleted (it is only a copy), and a new, encrypted one started. */
    discardedDamaged?: boolean;
}

/**
 * The local copy of Proton's calendars (what Calendar.app is served), in SQLite. Since 0.24 it is
 * encrypted with SQLCipher: a random key kept with the saved login (Keychain), so the decrypted
 * events are not readable on disk. It is a copy: everything in it can be fetched from Proton again,
 * apart from Calendar.app's UIDs for meetings created on the Mac (Calendar.app then sees those again
 * as new events).
 */
export class MirrorDatabase {
    private db: sqlite3.Database | null = null;
    private readonly filePath: string;

    constructor(baseDir: string) {
        this.filePath = join(baseDir, 'mirror.db');
        mkdirSync(dirname(this.filePath), { recursive: true });
    }

    private get database() {
        if (!this.db) {
            throw new Error('The local copy is not open yet.');
        }
        return this.db;
    }

    /**
     * Opens the copy. `key`: encrypted with it; an unencrypted file from before is converted in place
     * first, and a file the key does not open is set aside (mirror.db.unreadable-<time>) for a new
     * copy. Without a key: unencrypted (tests). `memory`: nothing on disk this run (the key cannot be
     * had; the file is left as it is).
     */
    async initialize(options: { key?: string; memory?: boolean } = {}): Promise<MirrorOpenResult> {
        const result: MirrorOpenResult = { converted: false, inMemory: Boolean(options.memory) };
        if (this.db) {
            return result; // already open
        }
        if (options.memory) {
            this.db = await openDatabase(':memory:');
        } else if (options.key) {
            const pragma = keyPragma(options.key);
            this.finishInterruptedConversion();
            if (isUnencryptedDatabase(this.filePath)) {
                try {
                    await this.convert(pragma);
                    result.converted = true;
                } catch (error) {
                    if (!isLastingDamage(error)) {
                        throw error; // e.g. the disk is full: the next start tries again
                    }
                    // A damaged unencrypted copy is only a cache: deleted, and a new, encrypted one started.
                    removeWithSideFiles(this.filePath);
                    removeWithSideFiles(`${this.filePath}.encrypting`);
                    result.discardedDamaged = true;
                }
            }
            this.db = await openDatabase(this.filePath);
            let usable = await this.opensWith(pragma);
            if (usable) {
                try {
                    await this.createSchema();
                } catch (error) {
                    if (!isLastingDamage(error)) {
                        throw error;
                    }
                    usable = false;
                }
            }
            if (!usable) {
                // A wrong key (lost with the saved login) or a damaged file: set aside, a new copy started.
                await this.close();
                result.replacedBy = this.setAside();
                this.db = await openDatabase(this.filePath);
                await this.exec(`PRAGMA key = ${pragma}; ${CIPHER_SETTINGS}`);
                await this.createSchema();
            }
            this.restrictFile();
            return result;
        } else {
            this.db = await openDatabase(this.filePath);
            this.restrictFile();
        }
        await this.createSchema();
        return result;
    }

    /**
     * Keys the open file and checks it can be read and is sound: false for a wrong key ("file is
     * not a database") and for a damaged file (quick_check, a few ms for a copy of a few MB).
     */
    private async opensWith(pragma: string) {
        await this.exec(`PRAGMA key = ${pragma}; ${CIPHER_SETTINGS}`);
        // A wrong key is handled here; SQLCipher need not print its decryption errors on stderr.
        await this.exec(`PRAGMA cipher_log_level = NONE`);
        try {
            const rows = await this.all<Row>(`PRAGMA quick_check(1)`);
            return rows[0]?.quick_check === 'ok';
        } catch (error) {
            if (isLastingDamage(error)) {
                return false;
            }
            throw error;
        } finally {
            await this.exec(`PRAGMA cipher_log_level = ERROR`).catch(() => undefined);
        }
    }

    /**
     * An unencrypted copy (before 0.24) converted in place: exported into a new encrypted file,
     * checked, then put in its place; the unencrypted file is deleted. Interrupted, the unencrypted
     * file is still there and the next start converts it again.
     */
    private async convert(pragma: string) {
        const encrypted = `${this.filePath}.encrypting`;
        removeWithSideFiles(encrypted);
        const plain = await openDatabase(this.filePath);
        try {
            await execOn(
                plain,
                `ATTACH DATABASE ${sqlString(encrypted)} AS encrypted KEY ${pragma}; PRAGMA encrypted.cipher_compatibility = 4; ` +
                    `SELECT sqlcipher_export('encrypted'); DETACH DATABASE encrypted;`
            );
        } finally {
            await closeDatabase(plain);
        }
        const check = await openDatabase(encrypted);
        try {
            await execOn(check, `PRAGMA key = ${pragma}; ${CIPHER_SETTINGS}`);
            const rows = await allOn(check, `PRAGMA quick_check`);
            if (rows[0]?.quick_check !== 'ok') {
                throw Object.assign(new Error(`the converted copy failed its check (${JSON.stringify(rows[0])})`), { code: 'MIRROR_CHECK_FAILED' });
            }
        } finally {
            await closeDatabase(check);
        }
        const old = `${this.filePath}.unencrypted`;
        moveWithSideFiles(this.filePath, old);
        moveWithSideFiles(encrypted, this.filePath);
        removeWithSideFiles(old);
    }

    /**
     * A conversion cut short (the app quit or crashed): the unencrypted file moved aside but the
     * encrypted one not yet in its place goes back, to be converted again; one left over after the
     * encrypted copy is in place is deleted. A half-written encrypted file is deleted either way.
     */
    private finishInterruptedConversion() {
        const old = `${this.filePath}.unencrypted`;
        if (existsSync(old) && !existsSync(this.filePath)) {
            moveWithSideFiles(old, this.filePath);
        } else {
            removeWithSideFiles(old); // also side files left without their main file
        }
        removeWithSideFiles(`${this.filePath}.encrypting`);
    }

    /**
     * A file the key does not open (the key was lost with the saved login) is moved aside for a new
     * copy; only the newest one is kept (it holds nothing Proton does not have, apart from
     * Calendar.app's UIDs for meetings created on the Mac).
     */
    private setAside() {
        const directory = dirname(this.filePath);
        const prefix = `${basename(this.filePath)}.unreadable-`;
        for (const name of readdirSync(directory)) {
            if (name.startsWith(prefix)) {
                rmSync(join(directory, name), { force: true });
            }
        }
        const aside = `${this.filePath}.unreadable-${Date.now()}`;
        moveWithSideFiles(this.filePath, aside);
        return aside;
    }

    /** The copy is yours only (0600), like the saved login. */
    private restrictFile() {
        try {
            chmodSync(this.filePath, 0o600);
        } catch {
            // not created yet, or not ours to change
        }
    }

    private async createSchema() {
        await this.exec(`
            CREATE TABLE IF NOT EXISTS calendars (
                proton_calendar_id TEXT PRIMARY KEY,
                slug TEXT NOT NULL UNIQUE,
                display_name TEXT NOT NULL,
                color TEXT NOT NULL,
                description TEXT NOT NULL DEFAULT '',
                visible INTEGER NOT NULL DEFAULT 1,
                removed INTEGER NOT NULL DEFAULT 0,
                ctag TEXT NOT NULL,
                last_polled_at INTEGER,
                last_synced_at INTEGER
            );
        `);

        await this.exec(`
            CREATE TABLE IF NOT EXISTS events (
                proton_event_id TEXT PRIMARY KEY,
                proton_calendar_id TEXT NOT NULL,
                uid TEXT NOT NULL,
                href TEXT NOT NULL UNIQUE,
                etag TEXT NOT NULL,
                content_hash TEXT NOT NULL,
                serialized_ics TEXT NOT NULL,
                title TEXT NOT NULL DEFAULT '',
                description TEXT NOT NULL DEFAULT '',
                location TEXT NOT NULL DEFAULT '',
                start_timestamp INTEGER NOT NULL,
                end_timestamp INTEGER NOT NULL,
                timezone TEXT NOT NULL DEFAULT 'UTC',
                is_all_day INTEGER NOT NULL DEFAULT 0,
                modified_timestamp INTEGER NOT NULL,
                deleted INTEGER NOT NULL DEFAULT 0,
                last_synced_at INTEGER NOT NULL,
                FOREIGN KEY (proton_calendar_id) REFERENCES calendars (proton_calendar_id)
            );
        `);

        await this.exec(`
            CREATE UNIQUE INDEX IF NOT EXISTS idx_events_calendar_uid
            ON events(proton_calendar_id, uid);
        `);

        // Added later: all Proton event IDs of a recurring series. Older databases lack the column.
        const columns = await this.all<Row>(`PRAGMA table_info(events)`);
        if (!columns.some((column) => column.name === 'proton_event_ids')) {
            await this.exec(`ALTER TABLE events ADD COLUMN proton_event_ids TEXT`);
        }

        // Added later: read-only calendars (subscribed, holidays, ...).
        const calendarColumns = await this.all<Row>(`PRAGMA table_info(calendars)`);
        if (!calendarColumns.some((column) => column.name === 'read_only')) {
            await this.exec(`ALTER TABLE calendars ADD COLUMN read_only INTEGER NOT NULL DEFAULT 0`);
        }
        if (!calendarColumns.some((column) => column.name === 'read_only_reason')) {
            await this.exec(`ALTER TABLE calendars ADD COLUMN read_only_reason TEXT`);
        }
        // Added later: which group a calendar belongs to (own, shared, subscribed, holidays).
        if (!calendarColumns.some((column) => column.name === 'kind')) {
            await this.exec(`ALTER TABLE calendars ADD COLUMN kind TEXT`);
        }
        // Added in 0.26: Proton's change feed per calendar (the cursor, and when it was last listed in full).
        if (!calendarColumns.some((column) => column.name === 'feed_cursor')) {
            await this.exec(`ALTER TABLE calendars ADD COLUMN feed_cursor TEXT`);
        }
        if (!calendarColumns.some((column) => column.name === 'full_synced_at')) {
            await this.exec(`ALTER TABLE calendars ADD COLUMN full_synced_at INTEGER`);
        }

        await this.exec(`
            CREATE INDEX IF NOT EXISTS idx_events_calendar
            ON events(proton_calendar_id);
        `);

        // 0.35: changes from Calendar.app made while Proton could not be reached, waiting to be sent.
        await this.exec(`
            CREATE TABLE IF NOT EXISTS outbox (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                created_at INTEGER NOT NULL,
                proton_calendar_id TEXT NOT NULL,
                slug TEXT NOT NULL,
                uid TEXT NOT NULL,
                kind TEXT NOT NULL,
                resource_name TEXT NOT NULL,
                href TEXT NOT NULL,
                ics TEXT,
                notify_organizer INTEGER NOT NULL DEFAULT 1,
                snapshot TEXT,
                attempts INTEGER NOT NULL DEFAULT 0,
                last_error TEXT,
                last_attempt_at INTEGER
            );
        `);
        await this.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_outbox_calendar_uid ON outbox(proton_calendar_id, uid);`);
    }

    // ----- 0.35: the outbox (changes waiting for Proton) -----

    async listOutbox(): Promise<OutboxItem[]> {
        const rows = await this.all<Row>(`SELECT * FROM outbox ORDER BY id ASC`);
        return rows.map(toOutboxItem);
    }

    async getOutboxItem(protonCalendarId: string, uid: string): Promise<OutboxItem | null> {
        const row = await this.get<Row>(`SELECT * FROM outbox WHERE proton_calendar_id = ? AND uid = ?`, [protonCalendarId, uid]);
        return row ? toOutboxItem(row) : null;
    }

    /** Adds a waiting change, or replaces the one waiting for the same event (its snapshot kept). */
    async putOutboxItem(item: Omit<OutboxItem, 'id' | 'attempts' | 'lastError' | 'lastAttemptAt'>) {
        await this.run(
            `INSERT INTO outbox (created_at, proton_calendar_id, slug, uid, kind, resource_name, href, ics, notify_organizer, snapshot)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(proton_calendar_id, uid) DO UPDATE SET
                kind = excluded.kind, resource_name = excluded.resource_name, href = excluded.href, ics = excluded.ics,
                notify_organizer = excluded.notify_organizer, attempts = 0, last_error = NULL, last_attempt_at = NULL`,
            [
                item.createdAt,
                item.protonCalendarId,
                item.slug,
                item.uid,
                item.kind,
                item.resourceName,
                item.href,
                item.ics,
                item.notifyOrganizer ? 1 : 0,
                item.snapshot ? JSON.stringify(item.snapshot) : null
            ]
        );
    }

    async noteOutboxAttempt(id: number, error: string | null) {
        await this.run(`UPDATE outbox SET attempts = attempts + 1, last_error = ?, last_attempt_at = ? WHERE id = ?`, [error, Date.now(), id]);
    }

    async removeOutboxItem(id: number) {
        await this.run(`DELETE FROM outbox WHERE id = ?`, [id]);
    }

    async clearOutbox() {
        await this.run(`DELETE FROM outbox`);
    }

    async close() {
        const db = this.db;
        this.db = null;
        if (db) {
            await closeDatabase(db);
        }
    }

    async upsertCalendar(record: BridgeCalendarRecord) {
        await this.run(
            `
            INSERT INTO calendars (
                proton_calendar_id, slug, display_name, color, description,
                visible, removed, ctag, last_polled_at, last_synced_at, read_only, read_only_reason, kind
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(proton_calendar_id) DO UPDATE SET
                slug = excluded.slug,
                display_name = excluded.display_name,
                color = excluded.color,
                description = excluded.description,
                visible = excluded.visible,
                removed = excluded.removed,
                ctag = excluded.ctag,
                last_polled_at = excluded.last_polled_at,
                last_synced_at = excluded.last_synced_at,
                read_only = excluded.read_only,
                read_only_reason = excluded.read_only_reason,
                kind = excluded.kind
            `,
            [
                record.protonCalendarId,
                record.slug,
                record.displayName,
                record.color,
                record.description,
                record.visible ? 1 : 0,
                record.removed ? 1 : 0,
                record.ctag,
                record.lastPolledAt,
                record.lastSyncedAt,
                record.readOnly ? 1 : 0,
                record.readOnlyReason ?? null,
                record.kind ?? 'own'
            ]
        );
    }

    async listCalendars(includeRemoved: boolean = false) {
        const rows = await this.all<Row>(
            `
            SELECT * FROM calendars
            ${includeRemoved ? '' : 'WHERE removed = 0'}
            ORDER BY display_name COLLATE NOCASE ASC
            `
        );
        return rows.map(toCalendarRecord);
    }

    async getCalendarById(protonCalendarId: string) {
        const row = await this.get<Row>(
            `SELECT * FROM calendars WHERE proton_calendar_id = ?`,
            [protonCalendarId]
        );
        return row ? toCalendarRecord(row) : null;
    }

    async getCalendarBySlug(slug: string) {
        const row = await this.get<Row>(
            `SELECT * FROM calendars WHERE slug = ? AND removed = 0`,
            [slug]
        );
        return row ? toCalendarRecord(row) : null;
    }

    async markMissingCalendarsRemoved(activeCalendarIds: string[]) {
        if (!activeCalendarIds.length) {
            await this.run(`UPDATE calendars SET removed = 1, ctag = ?`, [`${Date.now()}`]);
            return;
        }

        const placeholders = activeCalendarIds.map(() => '?').join(', ');
        await this.run(
            `UPDATE calendars SET removed = 1, ctag = ? WHERE proton_calendar_id NOT IN (${placeholders})`,
            [`${Date.now()}`, ...activeCalendarIds]
        );
    }

    /**
     * A calendar's details from Proton (name, colour, read-only, group, ...), without touching what
     * a sync of its events writes (ctag, last polled / synced), which may be running at the same time.
     * `bumpCtag`: something Calendar.app shows changed.
     */
    async updateCalendarMetadata(record: BridgeCalendarRecord, bumpCtag: boolean) {
        await this.run(
            `UPDATE calendars SET slug = ?, display_name = ?, color = ?, description = ?, visible = ?, removed = 0,
                read_only = ?, read_only_reason = ?, kind = ? WHERE proton_calendar_id = ?`,
            [
                record.slug,
                record.displayName,
                record.color,
                record.description,
                record.visible ? 1 : 0,
                record.readOnly ? 1 : 0,
                record.readOnlyReason ?? null,
                record.kind ?? 'own',
                record.protonCalendarId
            ]
        );
        if (bumpCtag) {
            await this.run(`UPDATE calendars SET ctag = ? WHERE proton_calendar_id = ?`, [`${Date.now()}`, record.protonCalendarId]);
        }
    }

    /** After a sync of a calendar's events: polled now; if something changed, a new ctag for Calendar.app. */
    /**
     * The calendar's place in Proton's change feed: the cursor to ask from next time (null: list in
     * full first), and when it was last listed in full. Only the fields given are changed.
     */
    async setCalendarFeed(protonCalendarId: string, feed: { cursor?: string | null; fullSyncedAt?: number | null }) {
        const sets: string[] = [];
        const params: unknown[] = [];
        if (feed.cursor !== undefined) {
            sets.push('feed_cursor = ?');
            params.push(feed.cursor);
        }
        if (feed.fullSyncedAt !== undefined) {
            sets.push('full_synced_at = ?');
            params.push(feed.fullSyncedAt);
        }
        if (!sets.length) {
            return;
        }
        await this.run(`UPDATE calendars SET ${sets.join(', ')} WHERE proton_calendar_id = ?`, [...params, protonCalendarId]);
    }

    /** The row a Proton event belongs to: keyed by it, or holding it as one of a series' occurrences. */
    async findEventByProtonId(protonCalendarId: string, protonEventId: string) {
        const rows = await this.all<Row>(
            `SELECT * FROM events WHERE proton_calendar_id = ? AND (proton_event_id = ? OR proton_event_ids LIKE ? ESCAPE '\\')`,
            [protonCalendarId, protonEventId, `%${JSON.stringify(protonEventId).slice(1, -1).replace(/[\\%_]/g, (char) => `\\${char}`)}%`]
        );
        const records = rows.map(toEventRecord);
        return records.find((record) => record.protonEventId === protonEventId || Object.values(record.protonEventIds).includes(protonEventId)) ?? null;
    }

    async recordCalendarPoll(protonCalendarId: string, changed: boolean) {
        const now = Date.now();
        if (changed) {
            await this.run(`UPDATE calendars SET last_polled_at = ?, last_synced_at = ?, ctag = ? WHERE proton_calendar_id = ?`, [
                now,
                now,
                `${now}`,
                protonCalendarId
            ]);
        } else {
            await this.run(`UPDATE calendars SET last_polled_at = ? WHERE proton_calendar_id = ?`, [now, protonCalendarId]);
        }
    }

    async bumpCalendarCtag(protonCalendarId: string) {
        await this.run(
            `UPDATE calendars SET ctag = ?, last_synced_at = ? WHERE proton_calendar_id = ?`,
            [`${Date.now()}`, Date.now(), protonCalendarId]
        );
    }

    async upsertEvent(record: BridgeEventRecord) {
        await this.run(
            `
            INSERT INTO events (
                proton_event_id, proton_calendar_id, uid, href, etag, content_hash,
                serialized_ics, title, description, location, start_timestamp, end_timestamp,
                timezone, is_all_day, modified_timestamp, deleted, last_synced_at, proton_event_ids
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(proton_event_id) DO UPDATE SET
                proton_calendar_id = excluded.proton_calendar_id,
                uid = excluded.uid,
                href = excluded.href,
                etag = excluded.etag,
                content_hash = excluded.content_hash,
                serialized_ics = excluded.serialized_ics,
                title = excluded.title,
                description = excluded.description,
                location = excluded.location,
                start_timestamp = excluded.start_timestamp,
                end_timestamp = excluded.end_timestamp,
                timezone = excluded.timezone,
                is_all_day = excluded.is_all_day,
                modified_timestamp = excluded.modified_timestamp,
                deleted = excluded.deleted,
                last_synced_at = excluded.last_synced_at,
                proton_event_ids = excluded.proton_event_ids
            `,
            [
                record.protonEventId,
                record.protonCalendarId,
                record.uid,
                record.href,
                record.etag,
                record.contentHash,
                record.serializedIcs,
                record.title,
                record.description,
                record.location,
                record.startTimestamp,
                record.endTimestamp,
                record.timezone,
                record.isAllDay ? 1 : 0,
                record.modifiedTimestamp,
                record.deleted ? 1 : 0,
                record.lastSyncedAt,
                JSON.stringify(record.protonEventIds || { '': record.protonEventId })
            ]
        );
    }

    async listEventsForCalendar(protonCalendarId: string, includeDeleted: boolean = false) {
        const rows = await this.all<Row>(
            `
            SELECT * FROM events
            WHERE proton_calendar_id = ?
            ${includeDeleted ? '' : 'AND deleted = 0'}
            ORDER BY start_timestamp ASC
            `,
            [protonCalendarId]
        );
        return rows.map(toEventRecord);
    }

    async getEventByProtonId(protonEventId: string) {
        const row = await this.get<Row>(
            `SELECT * FROM events WHERE proton_event_id = ?`,
            [protonEventId]
        );
        return row ? toEventRecord(row) : null;
    }

    async getEventByUid(protonCalendarId: string, uid: string) {
        const row = await this.get<Row>(
            `SELECT * FROM events WHERE proton_calendar_id = ? AND uid = ?`,
            [protonCalendarId, uid]
        );
        return row ? toEventRecord(row) : null;
    }

    /** Live (not deleted) rows with this UID in any calendar. */
    async findLiveEventsByUid(uid: string) {
        const rows = await this.all<Row>(`SELECT * FROM events WHERE uid = ? AND deleted = 0`, [uid]);
        return rows.map(toEventRecord);
    }

    async markEventDeleted(protonEventId: string) {
        return this.run(
            `UPDATE events SET deleted = 1, last_synced_at = ? WHERE proton_event_id = ? AND deleted = 0`,
            [Date.now(), protonEventId]
        );
    }

    async removeEventByUid(protonCalendarId: string, uid: string) {
        await this.run(
            `DELETE FROM events WHERE proton_calendar_id = ? AND uid = ?`,
            [protonCalendarId, uid]
        );
    }

    async markMissingEventsDeleted(protonCalendarId: string, activeEventIds: string[]) {
        if (!activeEventIds.length) {
            return this.run(
                `UPDATE events SET deleted = 1, last_synced_at = ? WHERE proton_calendar_id = ? AND deleted = 0`,
                [Date.now(), protonCalendarId]
            );
        }

        const placeholders = activeEventIds.map(() => '?').join(', ');
        return this.run(
            `UPDATE events SET deleted = 1, last_synced_at = ? WHERE proton_calendar_id = ? AND deleted = 0 AND proton_event_id NOT IN (${placeholders})`,
            [Date.now(), protonCalendarId, ...activeEventIds]
        );
    }

    async deleteEventsForCalendar(protonCalendarId: string) {
        return this.run(`DELETE FROM events WHERE proton_calendar_id = ?`, [protonCalendarId]);
    }

    async clearAll() {
        await this.run(`DELETE FROM outbox`);
        await this.run(`DELETE FROM events`);
        await this.run(`DELETE FROM calendars`);
    }

    private exec(sql: string) {
        return execOn(this.database, sql);
    }

    private run(sql: string, params: unknown[] = []) {
        return new Promise<number>((resolve, reject) => {
            this.database.run(sql, params, function (error) {
                if (error) {
                    reject(error);
                    return;
                }
                resolve(this.changes ?? 0);
            });
        });
    }

    private get<T extends Row>(sql: string, params: unknown[] = []) {
        return new Promise<T | null>((resolve, reject) => {
            this.database.get(sql, params, (error, row) => {
                if (error) {
                    reject(error);
                    return;
                }
                resolve((row as T | undefined) || null);
            });
        });
    }

    private all<T extends Row>(sql: string, params: unknown[] = []) {
        return new Promise<T[]>((resolve, reject) => {
            this.database.all(sql, params, (error, rows) => {
                if (error) {
                    reject(error);
                    return;
                }
                resolve((rows as T[]) || []);
            });
        });
    }
}

const openDatabase = (filePath: string) =>
    new Promise<sqlite3.Database>((resolve, reject) => {
        const db = new sqlite3.Database(filePath, (error) => (error ? reject(error) : resolve(db)));
    });

const closeDatabase = (db: sqlite3.Database) =>
    new Promise<void>((resolve, reject) => {
        db.close((error) => (error ? reject(error) : resolve()));
    });

const execOn = (db: sqlite3.Database, sql: string) =>
    new Promise<void>((resolve, reject) => {
        db.exec(sql, (error) => (error ? reject(error) : resolve()));
    });

const allOn = (db: sqlite3.Database, sql: string) =>
    new Promise<Row[]>((resolve, reject) => {
        db.all(sql, [], (error, rows) => (error ? reject(error) : resolve((rows as Row[]) || [])));
    });
