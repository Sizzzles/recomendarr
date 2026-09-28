import { getDatabase, freshDatabaseTimestamp } from './database';
import {
    emptyEngineRunSummary, pendingEngineStages, ENGINE_STAGE_NAMES,
    type EngineRun, type EngineRunStage, type EngineRunStatus, type EngineRunSummary, type EngineRunTrigger,
} from './engine-observability-types';
import { redactDiagnosticText } from './diagnostics';

interface EngineRunRow {
    id: string; trigger: EngineRunTrigger; source: string | null; engine_version: string;
    status: EngineRunStatus; started_at: string; completed_at: string | null; current_stage: EngineRun['currentStage'];
    summary_json: string; stages_json: string; error_message: string | null; created_at: string; updated_at: string;
}

function parseObject<T>(value: string, fallback: T): T {
    try {
        const parsed = JSON.parse(value);
        return parsed && typeof parsed === 'object' ? parsed as T : fallback;
    } catch { return fallback; }
}

function deserialize(row: EngineRunRow): EngineRun {
    const parsedSummary = parseObject<Record<string, unknown>>(row.summary_json, {});
    const summary = emptyEngineRunSummary();
    for (const key of Object.keys(summary) as Array<keyof EngineRunSummary>) {
        const value = parsedSummary[key];
        summary[key] = typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
    }
    const parsedStages = parseObject<unknown>(row.stages_json, []);
    const stages = Array.isArray(parsedStages) ? parsedStages.flatMap(value => {
        if (!value || typeof value !== 'object') return [];
        const candidate = value as Partial<EngineRunStage>;
        if (!candidate.name || !ENGINE_STAGE_NAMES.includes(candidate.name)) return [];
        const status = ['pending', 'running', 'succeeded', 'skipped', 'failed'].includes(candidate.status || '') ? candidate.status! : 'pending';
        return [{ name: candidate.name, status, startedAt: candidate.startedAt, completedAt: candidate.completedAt,
            durationMs: typeof candidate.durationMs === 'number' ? Math.max(0, candidate.durationMs) : undefined,
            applicableCount: Math.max(0, candidate.applicableCount || 0), attemptCount: Math.max(0, candidate.attemptCount || 0),
            successCount: Math.max(0, candidate.successCount || 0), failureCount: Math.max(0, candidate.failureCount || 0),
            skipReason: candidate.skipReason ? sanitizePublicText(candidate.skipReason) : undefined,
            failures: Array.isArray(candidate.failures) ? candidate.failures.filter(item => typeof item === 'string').slice(0, 10).map(sanitizePublicText) : [],
        } as EngineRunStage];
    }) : [];
    const durationMs = row.completed_at ? Math.max(0, Date.parse(row.completed_at) - Date.parse(row.started_at)) : undefined;
    return {
        id: row.id, trigger: row.trigger, source: row.source, engineVersion: row.engine_version,
        status: row.status, startedAt: row.started_at, completedAt: row.completed_at,
        currentStage: row.current_stage, summary, stages, errorMessage: row.error_message ? sanitizePublicText(row.error_message) : null,
        createdAt: row.created_at, updatedAt: row.updated_at, durationMs,
    };
}

function sanitizePublicText(value: string): string {
    return redactDiagnosticText(value)
        .replace(/(["']?(?:api[_-]?key|token|password)["']?\s*[:=]\s*)["']?[^"'\s,;}]+["']?/gi, '$1[REDACTED]')
        .replace(/\s+/g, ' ').trim().slice(0, 300);
}

export function createEngineRun(input: {
    id?: string; trigger: EngineRunTrigger; source?: string | null; engineVersion: string; startedAt?: string;
}): EngineRun {
    const database = getDatabase();
    const startedAt = input.startedAt || freshDatabaseTimestamp();
    const id = input.id || crypto.randomUUID();
    try {
        database.prepare(`INSERT INTO engine_runs (
            id, trigger, source, engine_version, status, started_at, current_stage,
            summary_json, stages_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'running', ?, 'preparing', ?, ?, ?, ?)`)
            .run(id, input.trigger, input.source === undefined ? input.trigger : input.source, input.engineVersion, startedAt,
                JSON.stringify(emptyEngineRunSummary()), JSON.stringify(pendingEngineStages()), startedAt, startedAt);
    } catch (error) {
        if (String((error as Error).message).includes('engine_runs.status')) {
            throw new Error('Recommendation engine is already running');
        }
        throw error;
    }
    return getEngineRun(id)!;
}

export function updateEngineRun(id: string, patch: {
    status?: EngineRunStatus; completedAt?: string | null; currentStage?: EngineRun['currentStage'];
    summary?: Partial<EngineRunSummary>; stages?: EngineRunStage[]; errorMessage?: string | null;
}): EngineRun {
    const current = getEngineRun(id);
    if (!current) throw new Error(`Engine run ${id} was not found`);
    const updatedAt = freshDatabaseTimestamp(current.updatedAt);
    const summary = patch.summary ? { ...current.summary, ...patch.summary } : current.summary;
    getDatabase().prepare(`UPDATE engine_runs SET status = ?, completed_at = ?, current_stage = ?,
        summary_json = ?, stages_json = ?, error_message = ?, updated_at = ? WHERE id = ?`)
        .run(patch.status ?? current.status, patch.completedAt === undefined ? current.completedAt : patch.completedAt,
            patch.currentStage ?? current.currentStage, JSON.stringify(summary), JSON.stringify(patch.stages ?? current.stages),
            patch.errorMessage === undefined ? current.errorMessage : patch.errorMessage, updatedAt, id);
    return getEngineRun(id)!;
}

export function getEngineRun(id: string): EngineRun | null {
    const row = getDatabase().prepare('SELECT * FROM engine_runs WHERE id = ?').get(id) as EngineRunRow | undefined;
    return row ? deserialize(row) : null;
}

export function getActiveEngineRun(): EngineRun | null {
    const row = getDatabase().prepare("SELECT * FROM engine_runs WHERE status = 'running' LIMIT 1").get() as EngineRunRow | undefined;
    return row ? deserialize(row) : null;
}

export function getRecentEngineRuns(limit = 10): EngineRun[] {
    if (!Number.isInteger(limit) || limit < 1 || limit > 10) throw new Error('limit must be between 1 and 10');
    return (getDatabase().prepare('SELECT * FROM engine_runs ORDER BY started_at DESC, id DESC LIMIT ?').all(limit) as EngineRunRow[])
        .map(deserialize);
}

export function getLatestCompletedEngineRun(): EngineRun | null {
    const row = getDatabase().prepare("SELECT * FROM engine_runs WHERE status <> 'running' ORDER BY started_at DESC, id DESC LIMIT 1").get() as EngineRunRow | undefined;
    return row ? deserialize(row) : null;
}

export function getLastSuccessfulEngineRun(): EngineRun | null {
    const row = getDatabase().prepare("SELECT * FROM engine_runs WHERE status = 'succeeded' ORDER BY started_at DESC, id DESC LIMIT 1").get() as EngineRunRow | undefined;
    return row ? deserialize(row) : null;
}

export function recoverInterruptedEngineRuns(processStartedAt: string): number {
    const rows = getDatabase().prepare("SELECT * FROM engine_runs WHERE status = 'running' AND started_at < ?").all(processStartedAt) as EngineRunRow[];
    for (const row of rows) {
        const run = deserialize(row);
        const completedAt = freshDatabaseTimestamp(run.updatedAt);
        const classified = run.summary.duplicatesRemoved + run.summary.existingOrWatchedExcluded + run.summary.rejectedTitleExcluded + run.summary.userFilterExcluded + run.summary.recommendationsSaved;
        run.summary.candidatesUnprocessed = Math.max(0, run.summary.candidatesConsidered - classified);
        const stage = run.stages.find(item => item.name === run.currentStage);
        if (stage) {
            stage.status = 'failed'; stage.completedAt = completedAt;
            stage.durationMs = stage.startedAt ? Math.max(0, Date.parse(completedAt) - Date.parse(stage.startedAt)) : undefined;
            stage.failureCount += 1;
            if (!stage.failures.includes('The application restarted before this run completed.')) stage.failures.push('The application restarted before this run completed.');
        }
        updateEngineRun(run.id, { status: 'interrupted', completedAt, summary: run.summary, stages: run.stages,
            errorMessage: 'The application restarted before this run completed.' });
    }
    return rows.length;
}
