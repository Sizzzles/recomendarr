export type EngineRunTrigger = 'manual' | 'scheduled';
export type EngineRunStatus = 'running' | 'succeeded' | 'partial' | 'failed' | 'interrupted';
export type EngineStageStatus = 'pending' | 'running' | 'succeeded' | 'skipped' | 'failed';
export type EngineStageName =
    | 'preparing'
    | 'syncing_watch_history'
    | 'building_context'
    | 'discovering_candidates'
    | 'ai_recommendations'
    | 'processing_candidates'
    | 'auto_adding'
    | 'finishing';

export const ENGINE_STAGE_NAMES: EngineStageName[] = [
    'preparing', 'syncing_watch_history', 'building_context', 'discovering_candidates',
    'ai_recommendations', 'processing_candidates', 'auto_adding', 'finishing',
];

export interface EngineRunSummary {
    watchedItemsProcessed: number;
    historyItemsSampled: number;
    tmdbCandidates: number;
    aiCandidates: number;
    candidatesConsidered: number;
    duplicatesRemoved: number;
    existingOrWatchedExcluded: number;
    rejectedTitleExcluded: number;
    userFilterExcluded: number;
    recommendationsSaved: number;
    candidatesUnprocessed: number;
    autoAddAttempted: number;
    addedToArr: number;
    errorCount: number;
}

export interface EngineRunStage {
    name: EngineStageName;
    status: EngineStageStatus;
    startedAt?: string;
    completedAt?: string;
    durationMs?: number;
    applicableCount: number;
    attemptCount: number;
    successCount: number;
    failureCount: number;
    skipReason?: string;
    failures: string[];
}

export interface EngineRun {
    id: string;
    trigger: EngineRunTrigger;
    source: string | null;
    engineVersion: string;
    status: EngineRunStatus;
    startedAt: string;
    completedAt: string | null;
    currentStage: EngineStageName;
    summary: EngineRunSummary;
    stages: EngineRunStage[];
    errorMessage: string | null;
    createdAt: string;
    updatedAt: string;
    durationMs?: number;
}

export function emptyEngineRunSummary(): EngineRunSummary {
    return {
        watchedItemsProcessed: 0, historyItemsSampled: 0, tmdbCandidates: 0, aiCandidates: 0,
        candidatesConsidered: 0, duplicatesRemoved: 0, existingOrWatchedExcluded: 0,
        rejectedTitleExcluded: 0, userFilterExcluded: 0, recommendationsSaved: 0,
        candidatesUnprocessed: 0, autoAddAttempted: 0, addedToArr: 0, errorCount: 0,
    };
}

export function pendingEngineStages(): EngineRunStage[] {
    return ENGINE_STAGE_NAMES.map(name => ({
        name, status: 'pending', applicableCount: 0, attemptCount: 0,
        successCount: 0, failureCount: 0, failures: [],
    }));
}

export type CoreService = 'media_server' | 'tmdb' | 'ai' | 'sonarr' | 'radarr';
export type StoredServiceHealthState = 'healthy' | 'degraded' | 'failed';
export type EffectiveServiceHealthState = StoredServiceHealthState | 'stale' | 'unknown' | 'not_configured' | 'disabled';
export type ServiceHealthSource = 'connection_test' | 'engine' | 'arr_operation' | 'plex_sign_in';

export interface ServiceHealthObservation {
    service: CoreService;
    state: StoredServiceHealthState;
    checkedAt: string;
    message: string;
    source: ServiceHealthSource;
    updatedAt: string;
}

export interface EffectiveServiceHealth extends Omit<ServiceHealthObservation, 'state'> {
    state: EffectiveServiceHealthState;
    reason: string;
    stale: boolean;
}
