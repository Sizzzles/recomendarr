import { describe, expect, it } from 'vitest';
import { clearActiveRunAfterStatusFailure, formatElapsed, getPollingIntervals, primaryRunIssueStage, prominentRunIssue, prominentRunIssueHeading } from '../src/components/app/engine-observability-model';

describe('engine observability model', () => {
    it('uses visible and hidden polling policies without fake progress', () => {
        expect(getPollingIntervals({ visible: true, running: true })).toEqual({ status: 2000, health: 60000, history: 15000 });
        expect(getPollingIntervals({ visible: true, running: false })).toEqual({ status: 15000, health: 60000, history: 15000 });
        expect(getPollingIntervals({ visible: false, running: true })).toEqual({ status: 10000, health: 300000, history: null });
    });

    it('formats elapsed time as HH:MM:SS', () => {
        expect(formatElapsed(3_661_000)).toBe('01:01:01');
        expect(formatElapsed(-1)).toBe('00:00:00');
    });

    it('shows only a failure or partial newer than the latest success', () => {
        const failed = { id: 'bad', status: 'failed', startedAt: '2026-09-29T02:00:00Z' } as never;
        const success = { id: 'good', status: 'succeeded', startedAt: '2026-09-29T01:00:00Z' } as never;
        expect(prominentRunIssue(failed, success)?.id).toBe('bad');
        expect(prominentRunIssue(failed, { ...success, startedAt: '2026-09-29T03:00:00Z' } as never)).toBeNull();
    });

    it('shows a recent interruption but dismisses it after a later success', () => {
        const interrupted = { id: 'interrupted', status: 'interrupted', startedAt: '2026-09-29T02:00:00Z' } as never;
        const olderSuccess = { id: 'older', status: 'succeeded', startedAt: '2026-09-29T01:00:00Z' } as never;
        const newerSuccess = { id: 'newer', status: 'succeeded', startedAt: '2026-09-29T03:00:00Z' } as never;
        expect(prominentRunIssue(interrupted, olderSuccess)?.id).toBe('interrupted');
        expect(prominentRunIssueHeading('interrupted')).toBe('Engine run was interrupted');
        expect(prominentRunIssue(interrupted, newerSuccess)).toBeNull();
    });

    it('clears stale active state after a status polling failure while retaining durable history', () => {
        const activeRun = { id: 'stale', status: 'running' } as never;
        const latestRun = { id: 'latest', status: 'succeeded' } as never;
        const previous = { activeRun, latestRun, lastSuccessfulRun: latestRun, runs: [latestRun], services: [] };
        expect(clearActiveRunAfterStatusFailure(previous)).toEqual({ ...previous, activeRun: null });
    });

    it('labels a failed run with the stage that owns its primary error', () => {
        const run = {
            errorMessage: 'Failed to fetch watch history: Plex Down',
            currentStage: 'syncing_watch_history',
            stages: [
                { name: 'preparing', status: 'failed', failures: ['Radarr library: Radarr Down'] },
                { name: 'syncing_watch_history', status: 'failed', failures: ['Failed to fetch watch history: Plex Down'] },
            ],
        } as never;
        expect(primaryRunIssueStage(run)?.name).toBe('syncing_watch_history');
    });
});
