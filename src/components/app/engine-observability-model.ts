import type { EffectiveServiceHealth, EngineRun } from '@/lib/engine-observability-types';

export function getPollingIntervals(input: { visible: boolean; running: boolean }) {
    if (!input.visible) return { status: 10_000, health: 300_000, history: null };
    return { status: input.running ? 2_000 : 15_000, health: 60_000, history: 15_000 };
}

export function formatElapsed(milliseconds: number): string {
    const seconds = Math.max(0, Math.floor(milliseconds / 1000));
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    return [hours, minutes, seconds % 60].map(value => String(value).padStart(2, '0')).join(':');
}

export function prominentRunIssue(latest: EngineRun | null, lastSuccess: EngineRun | null): EngineRun | null {
    if (!latest || (latest.status !== 'failed' && latest.status !== 'partial' && latest.status !== 'interrupted')) return null;
    if (lastSuccess && Date.parse(lastSuccess.startedAt) >= Date.parse(latest.startedAt)) return null;
    return latest;
}

export function clearActiveRunAfterStatusFailure<T extends { activeRun: EngineRun | null }>(state: T): T {
    return { ...state, activeRun: null };
}

export function prominentRunIssueHeading(status: EngineRun['status']): string {
    if (status === 'interrupted') return 'Engine run was interrupted';
    if (status === 'failed') return 'Engine run failed';
    return 'Engine run completed partially';
}

export function primaryRunIssueStage(run: EngineRun): EngineRun['stages'][number] | undefined {
    if (run.errorMessage) {
        const owner = run.stages.find(stage => stage.failures.includes(run.errorMessage!));
        if (owner) return owner;
    }
    return run.stages.find(stage => stage.name === run.currentStage && stage.status === 'failed')
        || run.stages.find(stage => stage.status === 'failed');
}

export interface ServiceHealthIssue {
    service: EffectiveServiceHealth['service'];
    severity: 'failed' | 'degraded' | 'soft';
    message: string;
    state: EffectiveServiceHealth['state'];
}

export function currentServiceHealthIssue(services: EffectiveServiceHealth[]): ServiceHealthIssue | null {
    const ranked = ['failed', 'degraded', 'stale', 'unknown'] as const;
    for (const state of ranked) {
        const service = services.find(item => item.state === state);
        if (service) return {
            service: service.service,
            state: service.state,
            severity: state === 'failed' ? 'failed' : state === 'degraded' ? 'degraded' : 'soft',
            message: service.reason,
        };
    }
    return null;
}
