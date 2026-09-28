import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ databasePath: '', connections: [] as import('better-sqlite3').Database[] }));
vi.mock('../src/lib/config', () => ({ config: { database: { get path() { return state.databasePath; } } } }));
vi.mock('better-sqlite3', async (importOriginal) => {
    type Constructor = new (filename: string) => import('better-sqlite3').Database;
    const { default: Sqlite } = await importOriginal<{ default: Constructor }>();
    return { default: class extends Sqlite { constructor(filename: string) { super(filename); state.connections.push(this); } } };
});

let directory: string;
beforeEach(() => { directory = mkdtempSync(path.join(tmpdir(), 'engine-tracker-')); state.databasePath = path.join(directory, 'test.db'); });
afterEach(() => { for (const db of state.connections) if (db.open) db.close(); state.connections.length = 0; rmSync(directory, { recursive: true, force: true }); });

async function modules() {
    vi.resetModules();
    const database = await import('../src/lib/database');
    database.getDatabase();
    return { database, tracker: await import('../src/lib/engine-run-tracker'), runs: await import('../src/lib/engine-runs') };
}

describe('EngineRunTracker', () => {
    it('persists ordered stages, source/version, durations, and succeeds with legitimate skips', async () => {
        const { tracker, runs } = await modules();
        const run = tracker.startEngineRun('manual', { id: 'visible-run-id', engineVersion: '3.0.1', now: () => '2026-09-29T00:00:00.000Z' });
        run.startStage('preparing', '2026-09-29T00:00:01.000Z');
        run.recordAttempt('preparing', 'success');
        run.completeStage('preparing', '2026-09-29T00:00:03.500Z');
        run.skipStage('ai_recommendations', 'AI is disabled', '2026-09-29T00:00:04.000Z');
        const completed = run.finish({ coreCompleted: true, completedAt: '2026-09-29T00:00:05.000Z' });

        expect(completed).toMatchObject({ id: 'visible-run-id', source: 'manual', engineVersion: '3.0.1', status: 'succeeded' });
        expect(completed.stages.map(stage => stage.name)).toEqual([
            'preparing', 'syncing_watch_history', 'building_context', 'discovering_candidates',
            'ai_recommendations', 'processing_candidates', 'auto_adding', 'finishing',
        ]);
        expect(completed.stages[0].durationMs).toBe(2500);
        expect(completed.stages[4]).toMatchObject({ status: 'skipped', skipReason: 'AI is disabled', failureCount: 0 });
        expect(runs.getEngineRun('visible-run-id')?.status).toBe('succeeded');
    });

    it('classifies attempted recoverable failures as partial and retains ten unique public failures', async () => {
        const { tracker } = await modules();
        const run = tracker.startEngineRun('scheduled', { engineVersion: '3.0.1' });
        run.startStage('discovering_candidates');
        run.recordAttempt('discovering_candidates', 'success');
        for (let index = 0; index < 12; index++) run.recordAttempt('discovering_candidates', 'failure', `Failure ${index} api_key=secret`);
        run.recordAttempt('discovering_candidates', 'failure', 'Failure 0 api_key=secret');
        run.completeStage('discovering_candidates');
        const completed = run.finish({ coreCompleted: true });

        expect(completed.status).toBe('partial');
        expect(completed.errorMessage).toMatch(/Failure 0/);
        expect(completed.errorMessage).not.toContain('secret');
        const stage = completed.stages.find(item => item.name === 'discovering_candidates')!;
        expect(stage.failureCount).toBe(13);
        expect(stage.failures).toHaveLength(10);
        expect(new Set(stage.failures).size).toBe(10);
        expect(completed.summary.errorCount).toBe(13);
    });

    it('classifies core failure and keeps the exact terminal candidate partition', async () => {
        const { tracker } = await modules();
        const run = tracker.startEngineRun('manual', { engineVersion: '3.0.1' });
        run.recordCandidateCounts({ tmdbCandidates: 9, aiCandidates: 3 });
        run.recordCandidateDisposition('duplicate', 2);
        run.recordCandidateDisposition('existing_or_watched', 3);
        run.recordCandidateDisposition('rejected_title', 1);
        run.recordCandidateDisposition('user_filter', 1);
        run.recordCandidateDisposition('saved', 2);
        const failed = run.finish({ coreCompleted: false, fatalError: 'Database password=hunter2 failed' });

        expect(failed.status).toBe('failed');
        expect(failed.summary.candidatesConsidered).toBe(12);
        expect(failed.summary.candidatesUnprocessed).toBe(3);
        expect(failed.summary.candidatesConsidered).toBe(
            failed.summary.duplicatesRemoved + failed.summary.existingOrWatchedExcluded +
            failed.summary.rejectedTitleExcluded + failed.summary.userFilterExcluded +
            failed.summary.recommendationsSaved + failed.summary.candidatesUnprocessed
        );
        expect(failed.errorMessage).not.toContain('hunter2');
    });

    it('enforces one active run and recovers stale runs only once per process', async () => {
        const { tracker, runs } = await modules();
        tracker.startEngineRun('manual', { id: 'old-run', engineVersion: '3.0.1', now: () => '2026-09-28T00:00:00.000Z' });
        expect(() => tracker.startEngineRun('manual', { engineVersion: '3.0.1' })).toThrow(/already running/i);

        expect(tracker.recoverEngineRunsAtStartup('2026-09-29T00:00:00.000Z')).toBe(1);
        expect(tracker.recoverEngineRunsAtStartup('2026-09-29T00:00:00.000Z')).toBe(0);
        expect(runs.getEngineRun('old-run')).toMatchObject({ status: 'interrupted', completedAt: expect.any(String) });

        tracker.startEngineRun('manual', { id: 'current-run', engineVersion: '3.0.1', now: () => '2026-09-29T00:00:01.000Z' });
        expect(tracker.recoverEngineRunsAtStartup('2026-09-29T00:00:00.000Z')).toBe(0);
        expect(runs.getEngineRun('current-run')?.status).toBe('running');
    });
});
