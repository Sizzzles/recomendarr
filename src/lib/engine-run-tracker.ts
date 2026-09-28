import { redactDiagnosticText } from './diagnostics';
import { createEngineRun, recoverInterruptedEngineRuns, updateEngineRun } from './engine-runs';
import type {
    EngineRun, EngineRunStage, EngineRunSummary, EngineRunTrigger, EngineStageName,
} from './engine-observability-types';

type CandidateDisposition = 'duplicate' | 'existing_or_watched' | 'rejected_title' | 'user_filter' | 'saved';
type EngineRunUpdate = typeof updateEngineRun;
interface CoreFailure {
    stage: EngineStageName;
    message: string;
    alreadyCounted: boolean;
    stoppedReason: string;
}

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
    private readonly persist: EngineRunUpdate;

    constructor(run: EngineRun, persist: EngineRunUpdate = updateEngineRun) {
        this.run = run;
        this.persist = persist;
    }

    getRun(): EngineRun { return this.run; }

    private save(): EngineRun {
        this.run = this.persist(this.run.id, {
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
            if (!stage.failures.includes(message)) {
                if (stage.failures.length < 10) stage.failures.push(message);
                else stage.failures[stage.failures.length - 1] = message;
            }
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

    finish(input: { coreCompleted: boolean; fatalError?: string; coreFailure?: CoreFailure; completedAt?: string }): EngineRun {
        if (this.run.status !== 'running') return this.run;

        // Finalize a copy so a failed database write leaves the live tracker retryable.
        const next = structuredClone(this.run);
        const completedAt = input.completedAt || new Date().toISOString();
        const coreFailure = input.coreFailure || (input.fatalError ? {
            stage: next.currentStage,
            message: input.fatalError,
            alreadyCounted: false,
            stoppedReason: `Run stopped after ${next.currentStage.replaceAll('_', ' ')} failed`,
        } : undefined);
        if (coreFailure) {
            const message = publicError(coreFailure.message);
            next.errorMessage = message;
            const stage = next.stages.find(item => item.name === coreFailure.stage);
            if (!stage) throw new Error(`Unknown engine stage: ${coreFailure.stage}`);
            if (!coreFailure.alreadyCounted) {
                next.summary.errorCount += 1;
                stage.failureCount += 1;
                stage.attemptCount += 1;
                stage.applicableCount += 1;
            }
            if (!stage.failures.includes(message)) {
                if (stage.failures.length < 10) stage.failures.push(message);
                else stage.failures[stage.failures.length - 1] = message;
            }
            stage.status = 'failed';
            stage.completedAt ||= completedAt;
            stage.durationMs = stageDuration(stage);
        } else {
            next.errorMessage = next.stages.find(stage => stage.failures.length > 0)?.failures[0] || null;
        }
        if (!input.coreCompleted) {
            const reason = coreFailure?.stoppedReason || 'Run stopped after a critical engine failure';
            for (const stage of next.stages) {
                if (stage.status !== 'pending') continue;
                stage.status = 'skipped';
                stage.skipReason = reason;
                stage.completedAt = completedAt;
            }
        }
        const classified = next.summary.duplicatesRemoved + next.summary.existingOrWatchedExcluded +
            next.summary.rejectedTitleExcluded + next.summary.userFilterExcluded + next.summary.recommendationsSaved;
        next.summary.candidatesUnprocessed = Math.max(0, next.summary.candidatesConsidered - classified);
        next.status = !input.coreCompleted ? 'failed' : next.summary.errorCount > 0 ? 'partial' : 'succeeded';
        next.completedAt = completedAt;
        const persisted = this.persist(next.id, {
            status: next.status, completedAt: next.completedAt, currentStage: next.currentStage,
            summary: next.summary, stages: next.stages, errorMessage: next.errorMessage,
        });
        this.run = persisted;
        return this.run;
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
