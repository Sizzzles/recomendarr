import type { EngineRun } from '@/lib/engine-observability-types';

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
    if (!latest || (latest.status !== 'failed' && latest.status !== 'partial')) return null;
    if (lastSuccess && Date.parse(lastSuccess.startedAt) >= Date.parse(latest.startedAt)) return null;
    return latest;
}
