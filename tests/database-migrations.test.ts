import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
    databasePath: '',
    connections: [] as import('better-sqlite3').Database[],
}));

vi.mock('../src/lib/config', () => ({
    config: { database: { get path() { return state.databasePath; } } },
}));

// Keep real SQLite behavior; track connections so even failed startup is cleaned up.
vi.mock('better-sqlite3', async (importOriginal) => {
    type SqliteConstructor = new (filename: string) => import('better-sqlite3').Database;
    const { default: Sqlite } = await importOriginal<{ default: SqliteConstructor }>();
    return {
        default: class extends Sqlite {
            constructor(filename: string) {
                super(filename);
                state.connections.push(this);
            }
        },
    };
});

const migrationKey = 'migration_cleanup_demo_library_v1';
const demoTitles = ['The Day the Earth Stood Still', 'The Night Manager'];
let directory: string;

async function startDatabase() {
    // Reload the module to simulate a new app process, bypassing the cached connection.
    vi.resetModules();
    const { getDatabase } = await import('../src/lib/database');
    return getDatabase();
}

function seed(db: Database.Database, title: string, status = 'added') {
    db.prepare(`
        INSERT INTO recommendations (id, title, media_type, source, status)
        VALUES (?, ?, 'movie', 'tmdb', ?)
    `).run(randomUUID(), title, status);
}

function titles(db: Database.Database) {
    return db.prepare('SELECT title FROM recommendations ORDER BY title').all();
}

function marker(db: Database.Database) {
    return db.prepare('SELECT value FROM settings WHERE key = ?').get(migrationKey);
}

beforeEach(() => {
    directory = mkdtempSync(path.join(tmpdir(), 'recomendarr-migrations-'));
    state.databasePath = path.join(directory, 'test.db');
});

afterEach(() => {
    for (const db of state.connections) {
        if (db.open) db.close();
    }
    state.connections.length = 0;
    rmSync(directory, { recursive: true, force: true });
});

async function existingDatabase() {
    const db = await startDatabase();
    // Model an existing database from before this migration was introduced.
    db.prepare('DELETE FROM settings WHERE key = ?').run(migrationKey);
    return db;
}

describe('demo Library cleanup migration', () => {
    it('removes the seeded added entries and preserves Voicemails for Isabelle', async () => {
        const db = await existingDatabase();
        for (const title of [...demoTitles, 'Voicemails for Isabelle']) seed(db, title);
        db.close();

        const migrated = await startDatabase();

        expect(titles(migrated)).toEqual([{ title: 'Voicemails for Isabelle' }]);
        expect(marker(migrated)).toEqual({ value: 'true' });
    });

    it('runs only once and preserves legitimate future additions of both titles', async () => {
        const db = await existingDatabase();
        for (const title of demoTitles) seed(db, title);
        db.close();

        const migrated = await startDatabase();
        expect(titles(migrated)).toEqual([]);
        expect(marker(migrated)).toEqual({ value: 'true' });
        for (const title of demoTitles) seed(migrated, title);
        migrated.close();

        const restarted = await startDatabase();
        expect(titles(restarted)).toEqual(demoTitles.map(title => ({ title })));
        expect(marker(restarted)).toEqual({ value: 'true' });
    });

    it.each(['pending', 'rejected', 'approved'])('preserves demo titles with status %s', async (status) => {
        const db = await existingDatabase();
        for (const title of demoTitles) seed(db, title, status);
        db.close();

        expect(titles(await startDatabase())).toEqual(demoTitles.map(title => ({ title })));
    });

    it('matches exact titles only', async () => {
        const db = await existingDatabase();
        const variants = ['The Night Manager ', 'The Night Manager: Season 2', 'the day the earth stood still'];
        for (const title of variants) seed(db, title);
        db.close();

        expect(titles(await startDatabase())).toEqual(variants.map(title => ({ title })));
    });

    it('can initialize a fresh empty database repeatedly', async () => {
        const db = await startDatabase();
        expect(titles(db)).toEqual([]);
        expect(marker(db)).toEqual({ value: 'true' });
        db.close();

        const restarted = await startDatabase();
        expect(titles(restarted)).toEqual([]);
        expect(marker(restarted)).toEqual({ value: 'true' });
    });

    it('does not record the marker if cleanup fails, and retries on the next startup', async () => {
        const db = await existingDatabase();
        seed(db, 'The Night Manager');
        db.exec(`
            CREATE TRIGGER fail_cleanup BEFORE DELETE ON recommendations
            BEGIN SELECT RAISE(ABORT, 'cleanup failed'); END;
        `);

        await expect(startDatabase()).rejects.toThrow('cleanup failed');
        expect(marker(db)).toBeUndefined();
        expect(titles(db)).toEqual([{ title: 'The Night Manager' }]);

        db.exec('DROP TRIGGER fail_cleanup');
        const retried = await startDatabase();
        expect(titles(retried)).toEqual([]);
        expect(marker(retried)).toEqual({ value: 'true' });
    });

    it('rolls back cleanup when writing the marker fails', async () => {
        const db = await existingDatabase();
        for (const title of demoTitles) seed(db, title);
        db.exec(`
            CREATE TRIGGER fail_marker BEFORE INSERT ON settings
            WHEN NEW.key = '${migrationKey}'
            BEGIN SELECT RAISE(ABORT, 'marker failed'); END;
        `);

        await expect(startDatabase()).rejects.toThrow('marker failed');
        expect(marker(db)).toBeUndefined();
        expect(titles(db)).toEqual(demoTitles.map(title => ({ title })));
    });
});
