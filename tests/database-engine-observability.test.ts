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

let directory: string;

async function loadModules() {
    vi.resetModules();
    const database = await import('../src/lib/database');
    const runs = await import('../src/lib/engine-runs');
    const health = await import('../src/lib/service-health');
    return { database, runs, health, db: database.getDatabase() };
}

beforeEach(() => {
    directory = mkdtempSync(path.join(tmpdir(), 'recomendarr-observability-'));
    state.databasePath = path.join(directory, 'test.db');
});

afterEach(() => {
    for (const connection of state.connections) {
        if (connection.open) connection.close();
    }
    state.connections.length = 0;
    rmSync(directory, { recursive: true, force: true });
});

describe('engine observability migration', () => {
    it('adds the schema transactionally and preserves existing rows', async () => {
        const initialized = await loadModules();
        initialized.db.exec(`
            INSERT INTO recommendations (id, title, media_type, source, status)
            VALUES ('keep-me', 'Preserved', 'movie', 'tmdb', 'pending');
            INSERT INTO logs (level, message, source) VALUES ('INFO', 'Preserved', 'test');
            DELETE FROM settings WHERE key = 'migration_add_engine_observability_v1';
            DROP TABLE service_health;
            DROP TABLE engine_runs;
        `);
        initialized.db.close();

        const { db } = await loadModules();
        const runColumns = db.pragma('table_info(engine_runs)') as Array<{ name: string; notnull: number }>;

        expect(runColumns.map(column => column.name)).toEqual(expect.arrayContaining([
            'id', 'trigger', 'source', 'engine_version', 'status', 'started_at', 'completed_at',
            'current_stage', 'summary_json', 'stages_json', 'error_message', 'created_at', 'updated_at',
        ]));
        expect(runColumns.find(column => column.name === 'source')?.notnull).toBe(0);
        expect(runColumns.find(column => column.name === 'engine_version')?.notnull).toBe(1);
        expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'service_health'").get()).toBeTruthy();
        expect(db.prepare('SELECT title FROM recommendations WHERE id = ?').get('keep-me')).toEqual({ title: 'Preserved' });
        expect(db.prepare('SELECT message FROM logs').get()).toEqual({ message: 'Preserved' });
        expect(db.prepare('SELECT value FROM settings WHERE key = ?').get('migration_add_engine_observability_v1')).toEqual({ value: 'true' });
    });

    it('is idempotent and permits only one running row', async () => {
        const first = await loadModules();
        first.runs.createEngineRun({ id: 'run-1', trigger: 'manual', source: null, engineVersion: '3.0.1' });
        expect(() => first.runs.createEngineRun({ id: 'run-2', trigger: 'scheduled', source: 'scheduled', engineVersion: '3.0.1' }))
            .toThrow(/already running/i);
        first.db.close();

        const restarted = await loadModules();
        expect(restarted.runs.getActiveEngineRun()?.id).toBe('run-1');
        expect(restarted.db.prepare('SELECT COUNT(*) AS count FROM engine_runs').get()).toEqual({ count: 1 });
    });
});

describe('engine run repository', () => {
    it('distinguishes a new recommendation insert from an existing row', async () => {
        const { database } = await loadModules();
        const recommendation = { title: 'Arrival', mediaType: 'movie' as const, tmdbId: 329865, source: 'tmdb' as const, status: 'pending' as const };
        expect(database.addRecommendationWithResult(recommendation).inserted).toBe(true);
        expect(database.addRecommendationWithResult(recommendation).inserted).toBe(false);
    });

    it('deserializes storage JSON into typed public models and orders recent runs deterministically', async () => {
        const { runs, db } = await loadModules();
        runs.createEngineRun({ id: 'run-b', trigger: 'scheduled', source: 'scheduled', engineVersion: '3.0.1', startedAt: '2026-09-29T01:00:00.000Z' });
        runs.updateEngineRun('run-b', { status: 'succeeded', completedAt: '2026-09-29T01:00:02.000Z' });
        runs.createEngineRun({ id: 'run-a', trigger: 'manual', source: null, engineVersion: '3.0.0', startedAt: '2026-09-29T01:00:00.000Z' });
        runs.updateEngineRun('run-a', {
            status: 'partial',
            completedAt: '2026-09-29T01:00:03.000Z',
            summary: { recommendationsSaved: 2, errorCount: 1 },
            stages: [{ name: 'preparing', status: 'failed', failureCount: 1, failures: ['Public failure'] }],
            errorMessage: 'Public failure',
        });

        const recent = runs.getRecentEngineRuns(10);
        expect(recent.map(run => run.id)).toEqual(['run-b', 'run-a']);
        expect(recent[1].source).toBeNull();
        expect(recent[1].engineVersion).toBe('3.0.0');
        expect(recent[1].summary.recommendationsSaved).toBe(2);
        expect(recent[1].stages[0].failures).toEqual(['Public failure']);
        expect('summary_json' in recent[1]).toBe(false);
        expect('stages_json' in recent[1]).toBe(false);

        db.prepare("UPDATE engine_runs SET summary_json = '{bad', stages_json = 'null' WHERE id = 'run-a'").run();
        expect(runs.getEngineRun('run-a')?.summary.recommendationsSaved).toBe(0);
        expect(runs.getEngineRun('run-a')?.stages).toEqual([]);
        expect(() => runs.getRecentEngineRuns(0)).toThrow(/between 1 and 10/i);
    });
});

describe('service health repository', () => {
    it('stores sanitized observations and derives stale and unknown reasons', async () => {
        const { health } = await loadModules();
        health.recordServiceHealth({
            service: 'tmdb',
            state: 'healthy',
            checkedAt: '2026-09-26T00:00:00.000Z',
            message: 'Last query succeeded with api_key=super-secret',
            source: 'engine',
        });

        const effective = health.getEffectiveServiceHealth({
            now: '2026-09-29T00:00:00.000Z',
            configured: { media_server: true, tmdb: true, ai: false, sonarr: false, radarr: false },
            disabled: { ai: true },
        });

        expect(effective.find(item => item.service === 'tmdb')).toMatchObject({ state: 'stale' });
        expect(effective.find(item => item.service === 'tmdb')?.reason).toMatch(/3 days ago/i);
        expect(effective.find(item => item.service === 'tmdb')?.reason).not.toContain('super-secret');
        expect(effective.find(item => item.service === 'media_server')).toMatchObject({ state: 'unknown', reason: 'Never checked' });
        expect(effective.find(item => item.service === 'ai')).toMatchObject({ state: 'disabled', reason: 'AI is disabled' });
        expect(effective.find(item => item.service === 'sonarr')).toMatchObject({ state: 'not_configured' });

        health.clearServiceHealth('tmdb');
        expect(health.getServiceHealthObservations()).toEqual([]);
    });

    it('keeps a run failure until a newer health observation supersedes it', async () => {
        const { health } = await loadModules();
        health.recordServiceHealth({
            service: 'radarr', state: 'failed', checkedAt: '2026-09-29T01:00:00.000Z',
            message: 'Could not load Radarr library', source: 'engine',
        });
        expect(health.getServiceHealthObservations()).toEqual([
            expect.objectContaining({ service: 'radarr', state: 'failed', source: 'engine' }),
        ]);

        health.recordServiceHealth({
            service: 'radarr', state: 'healthy', checkedAt: '2026-09-29T02:00:00.000Z',
            message: 'Connection test succeeded', source: 'connection_test',
        });
        expect(health.getServiceHealthObservations()).toEqual([
            expect.objectContaining({ service: 'radarr', state: 'healthy', source: 'connection_test' }),
        ]);
    });
});
