import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import {
    buildDiagnosticReport,
    getDatabaseDiagnostics,
    getRecentDiagnosticErrors,
    getRuntimeMetadata,
    redactDiagnosticText,
    sanitizeDatabasePath,
} from '../src/lib/diagnostics';
import { getAppliedMigrations } from '../src/lib/database';

const opened: Database.Database[] = [];

function memoryDb() {
    const database = new Database(':memory:');
    opened.push(database);
    database.exec(`
        CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            level TEXT NOT NULL,
            message TEXT NOT NULL,
            source TEXT NOT NULL,
            timestamp TEXT NOT NULL,
            details TEXT
        );
    `);
    return database;
}

afterEach(() => {
    while (opened.length) opened.pop()?.close();
});

describe('runtime diagnostics', () => {
    it('uses deployment metadata before local git and normalizes the commit', () => {
        const metadata = getRuntimeMetadata({
            env: {
                RECOMENDARR_GIT_COMMIT: 'ABCDEF1234567890',
                GIT_COMMIT: '1111111111111111',
                VERCEL_GIT_COMMIT_SHA: '2222222222222222',
            },
            readGitCommit: () => '3333333333333333',
            appVersion: '3.0.1',
            nodeVersion: 'v24.0.0',
            platform: 'win32',
        });

        expect(metadata).toEqual({
            appVersion: '3.0.1',
            gitCommit: 'abcdef123456',
            nodeVersion: 'v24.0.0',
            platform: 'win32',
        });
    });

    it('falls through malformed environment values to local git then unknown', () => {
        const fromGit = getRuntimeMetadata({
            env: { RECOMENDARR_GIT_COMMIT: 'not a commit!' },
            readGitCommit: () => 'fedcba9876543210',
            appVersion: '3.0.1',
        });
        const unknown = getRuntimeMetadata({
            env: { GIT_COMMIT: '' },
            readGitCommit: () => { throw new Error('no git'); },
            appVersion: '3.0.1',
        });

        expect(fromGit.gitCommit).toBe('fedcba987654');
        expect(unknown.gitCommit).toBe('unknown');
    });
});

describe('database diagnostics', () => {
    it.each([
        ['C:\\private\\recomendarr\\data\\recomendarr.db', 'C:\\...\\recomendarr.db'],
        ['/app/private/data/recomendarr.db', '/.../recomendarr.db'],
        ['recomendarr.db', '.../recomendarr.db'],
    ])('sanitizes %s', (input, expected) => {
        expect(sanitizeDatabasePath(input)).toBe(expected);
    });

    it('returns only completed migration keys in deterministic order', () => {
        const database = memoryDb();
        const insert = database.prepare('INSERT INTO settings (key, value) VALUES (?, ?)');
        insert.run('migration_z_last', 'true');
        insert.run('ordinary_setting', 'true');
        insert.run('migration_a_first', 'true');
        insert.run('migration_incomplete', 'false');

        expect(getAppliedMigrations(database)).toEqual(['migration_a_first', 'migration_z_last']);
    });

    it('reports reachability, size, journal mode, paths, and migration count', () => {
        const database = memoryDb();
        database.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('migration_one', 'true');

        expect(getDatabaseDiagnostics({
            database,
            databasePath: 'C:\\secret\\data\\recomendarr.db',
            statFile: () => ({ size: 13_000_000 }),
        })).toEqual({
            reachable: true,
            sizeBytes: 13_000_000,
            journalMode: 'memory',
            resolvedPath: 'C:\\secret\\data\\recomendarr.db',
            sanitizedPath: 'C:\\...\\recomendarr.db',
            appliedMigrations: ['migration_one'],
        });
    });

    it('returns a safe partial summary when database inspection fails', () => {
        expect(getDatabaseDiagnostics({
            database: null,
            databasePath: '/app/data/recomendarr.db',
            statFile: () => { throw new Error('unavailable'); },
        })).toMatchObject({
            reachable: false,
            sizeBytes: null,
            journalMode: null,
            sanitizedPath: '/.../recomendarr.db',
            appliedMigrations: [],
        });
    });
});

describe('diagnostic error safety', () => {
    it('caps errors at 20, newest first, normalizes whitespace, truncates, and omits details', () => {
        const database = memoryDb();
        const insert = database.prepare(`
            INSERT INTO logs (level, message, source, timestamp, details)
            VALUES ('ERROR', ?, 'engine', ?, 'SECRET_DETAILS')
        `);
        for (let index = 0; index < 25; index += 1) {
            insert.run(`error ${index}   ${'x'.repeat(350)}`, `2026-09-27T00:${String(index).padStart(2, '0')}:00.000Z`);
        }

        const errors = getRecentDiagnosticErrors(database);

        expect(errors).toHaveLength(20);
        expect(errors[0].message.startsWith('error 24 ')).toBe(true);
        expect(errors[0].message.length).toBeLessThanOrEqual(300);
        expect(JSON.stringify(errors)).not.toContain('SECRET_DETAILS');
    });

    it('redacts credential values and credential-bearing URLs', () => {
        const secretText = [
            'X-Plex-Token=plex-secret',
            'sonarr_api_key=sonarr-secret',
            'radarrApiKey: radarr-secret',
            'ai_api_key=sk-ai-secret',
            'tmdb_api_key=tmdb-secret',
            'Authorization: Bearer bearer-secret',
            'password=hunter2',
            'https://discord.com/api/webhooks/123/discord-secret',
            'telegram_bot_token=123456:telegram-secret',
            'telegram_chat_id=-123456',
            'https://example.test/path?api_key=query-secret&safe=yes',
        ].join(' ');

        const redacted = redactDiagnosticText(secretText);

        for (const secret of ['plex-secret', 'sonarr-secret', 'radarr-secret', 'sk-ai-secret', 'tmdb-secret', 'bearer-secret', 'hunter2', 'discord-secret', 'telegram-secret', '-123456', 'query-secret']) {
            expect(redacted).not.toContain(secret);
        }
        expect(redacted).toContain('[REDACTED]');
    });

    it('builds reports from the sanitized path and never the resolved path', () => {
        const report = buildDiagnosticReport({
            runtime: { appVersion: '3.0.1', gitCommit: 'abcdef123456', nodeVersion: 'v24', platform: 'win32' },
            database: {
                reachable: true,
                sizeBytes: 13_000_000,
                journalMode: 'wal',
                sanitizedPath: 'C:\\...\\recomendarr.db',
                appliedMigrations: ['migration_a', 'migration_b'],
            },
            services: [{ name: 'Plex', configured: true, latestState: 'not_tested' }],
            scheduler: { enabled: true, active: true },
            recentErrors: [],
        });

        expect(report).toContain('Database path: C:\\...\\recomendarr.db');
        expect(report).toContain('Database size: 12.4 MB');
        expect(report).not.toContain('private');
    });
});
