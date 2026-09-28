import { redactDiagnosticText } from './diagnostics';
import { createEngineRun, recoverInterruptedEngineRuns, updateEngineRun } from './engine-runs';
import type {
    EngineRun, EngineRunStage, EngineRunSummary, EngineRunTrigger, EngineStageName,
} from './engine-observability-types';

type CandidateDisposition = 'duplicate' | 'existing_or_watched' | 'rejected_title' | 'user_filter' | 'saved';

function publicError(value: string): string {
    return redactDiagnosticText(value)
        .replace(/(["']?(?:api[_-]?key|token|password)["']?\s*[:=]\s*)["']?[^"'\s,;}]+["']?/gi, '$1[REDACTED]')
        .replace(/\s+/g, ' ').trim().slice(0, 300);
}

function stageDuration(stage: EngineRunStage): number | undefined {
    if (!stage.startedAt || !stage.completedAt) return undefined;
    return Math.max(0, Date.parse(stage.completedAt) - Date.parse(stage.startedAt));
}

export class EngineRunTracker {
    private run: EngineRun;

    constructor(run: EngineRun) { this.run = run; }

    getRun(): EngineRun { return this.run; }

    private save(): EngineRun {
        this.run = updateEngineRun(this.run.id, {
            status: this.run.status,
            completedAt: this.run.completedAt,
            currentStage: this.run.currentStage,
            summary: this.run.summary,
            stages: this.run.stages,
            errorMessage: this.run.errorMessage,
        });
        return this.run;
    }

    private stage(name: EngineStageName): EngineRunStage {
        const stage = this.run.stages.find(item => item.name === name);
        if (!stage) throw new Error(`Unknown engine stage: ${name}`);
        return stage;
    }

    startStage(name: EngineStageName, startedAt = new Date().toISOString()): EngineRun {
        const stage = this.stage(name);
        stage.status = 'running';
        stage.startedAt = startedAt;
        stage.completedAt = undefined;
        stage.durationMs = undefined;
        this.run.currentStage = name;
        return this.save();
    }

    completeStage(name: EngineStageName, completedAt = new Date().toISOString()): EngineRun {
        const stage = this.stage(name);
        stage.completedAt = completedAt;
        stage.durationMs = stageDuration(stage);
        stage.status = stage.failureCount > 0 ? 'failed' : 'succeeded';
        return this.save();
    }

    skipStage(name: EngineStageName, reason: string, completedAt = new Date().toISOString()): EngineRun {
        const stage = this.stage(name);
        stage.status = 'skipped';
        stage.skipReason = publicError(reason);
        stage.completedAt = completedAt;
        stage.durationMs = stageDuration(stage);
        return this.save();
    }

    recordAttempt(name: EngineStageName, outcome: 'success' | 'failure', error?: string): EngineRun {
        const stage = this.stage(name);
        stage.applicableCount += 1;
        stage.attemptCount += 1;
        if (outcome === 'success') stage.successCount += 1;
        else {
            stage.failureCount += 1;
            this.run.summary.errorCount += 1;
            const message = publicError(error || 'Operation failed');
            if (!stage.failures.includes(message) && stage.failures.length < 10) stage.failures.push(message);
            this.run.errorMessage = message;
        }
        return this.save();
    }

    recordCandidateCounts(input: { tmdbCandidates: number; aiCandidates: number }): EngineRun {
        if (!Number.isInteger(input.tmdbCandidates) || input.tmdbCandidates < 0 ||
            !Number.isInteger(input.aiCandidates) || input.aiCandidates < 0) throw new Error('Candidate counts must be non-negative integers');
        this.run.summary.tmdbCandidates = input.tmdbCandidates;
        this.run.summary.aiCandidates = input.aiCandidates;
        this.run.summary.candidatesConsidered = input.tmdbCandidates + input.aiCandidates;
        return this.save();
    }

    updateSummary(patch: Partial<Pick<EngineRunSummary,
        'watchedItemsProcessed' | 'historyItemsSampled' | 'autoAddAttempted' | 'addedToArr'>>): EngineRun {
        Object.assign(this.run.summary, patch);
        return this.save();
    }

    recordCandidateDisposition(disposition: CandidateDisposition, count = 1): EngineRun {
        if (!Number.isInteger(count) || count < 0) throw new Error('Disposition count must be a non-negative integer');
        const key: Record<CandidateDisposition, keyof EngineRunSummary> = {
            duplicate: 'duplicatesRemoved', existing_or_watched: 'existingOrWatchedExcluded',
            rejected_title: 'rejectedTitleExcluded', user_filter: 'userFilterExcluded', saved: 'recommendationsSaved',
        };
        const summaryKey = key[disposition];
        this.run.summary[summaryKey] += count;
        const classified = this.classifiedCandidates();
        if (classified > this.run.summary.candidatesConsidered) {
            this.run.summary[summaryKey] -= count;
            throw new Error('Candidate dispositions exceed candidates considered');
        }
        return this.save();
    }

    private classifiedCandidates(): number {
        const summary = this.run.summary;
        return summary.duplicatesRemoved + summary.existingOrWatchedExcluded + summary.rejectedTitleExcluded +
            summary.userFilterExcluded + summary.recommendationsSaved;
    }

    finish(input: { coreCompleted: boolean; fatalError?: string; completedAt?: string }): EngineRun {
        if (input.fatalError) {
            const message = publicError(input.fatalError);
            if (!this.run.errorMessage) this.run.errorMessage = message;
            this.run.summary.errorCount += 1;
            const stage = this.stage(this.run.currentStage);
            stage.failureCount += 1;
            stage.attemptCount += 1;
            stage.applicableCount += 1;
            if (!stage.failures.includes(message) && stage.failures.length < 10) stage.failures.push(message);
            stage.status = 'failed';
            stage.completedAt = input.completedAt || new Date().toISOString();
            stage.durationMs = stageDuration(stage);
        }
        this.run.summary.candidatesUnprocessed = Math.max(0, this.run.summary.candidatesConsidered - this.classifiedCandidates());
        this.run.status = !input.coreCompleted ? 'failed' : this.run.summary.errorCount > 0 ? 'partial' : 'succeeded';
        this.run.completedAt = input.completedAt || new Date().toISOString();
        return this.save();
    }
}

export function startEngineRun(trigger: EngineRunTrigger, options: {
    id?: string; source?: string | null; engineVersion: string; now?: () => string;
}): EngineRunTracker {
    return new EngineRunTracker(createEngineRun({
        id: options.id, trigger, source: options.source === undefined ? trigger : options.source,
        engineVersion: options.engineVersion, startedAt: (options.now || (() => new Date().toISOString()))(),
    }));
}

const recoveryState = globalThis as typeof globalThis & { __recomendarrRecoveredBoots?: Set<string> };

export function recoverEngineRunsAtStartup(processStartedAt: string): number {
    recoveryState.__recomendarrRecoveredBoots ||= new Set<string>();
    if (recoveryState.__recomendarrRecoveredBoots.has(processStartedAt)) return 0;
    const recovered = recoverInterruptedEngineRuns(processStartedAt);
    recoveryState.__recomendarrRecoveredBoots.add(processStartedAt);
    return recovered;
}
