import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { DashboardPage } from '../src/components/app/dashboard-page';
import { LogsPage } from '../src/components/app/logs-page';
import { EMPTY_DASHBOARD_SUMMARY } from '../src/components/app/models';
import { emptyEngineRunSummary, pendingEngineStages } from '../src/lib/engine-observability-types';

const run = {
    id: 'run-in-logs', trigger: 'manual' as const, source: 'manual', engineVersion: '3.0.1', status: 'failed' as const,
    startedAt: '2026-09-29T00:00:00.000Z', completedAt: '2026-09-29T00:00:01.000Z', currentStage: 'preparing' as const,
    summary: { ...emptyEngineRunSummary(), errorCount: 1 }, stages: pendingEngineStages(), errorMessage: 'Public error',
    createdAt: '2026-09-29T00:00:00.000Z', updatedAt: '2026-09-29T00:00:01.000Z', durationMs: 1000,
};

describe('observability page placement', () => {
    it('keeps Dashboard current-state focused without the run-history list', () => {
        const markup = renderToStaticMarkup(<DashboardPage
            summary={EMPTY_DASHBOARD_SUMMARY} pendingRecs={[]} isRunning={false} onRun={vi.fn()} onOpenRecommendations={vi.fn()}
            engineFilters={{ genres: [], language: 'all', yearMin: 0, yearMax: 0, mediaType: 'all', vibePrompt: '', minRating: 0, providers: [] }}
            setEngineFilters={vi.fn()} observability={{ activeRun: null, latestRun: run, lastSuccessfulRun: null, runs: [run], services: [] }}
            checkingHealth={false} healthCheckMessage={null} onCheckHealth={vi.fn()} onViewRunDetails={vi.fn()} />);
        expect(markup).toContain('Run health check');
        expect(markup).not.toContain('Last ten runs');
        expect(markup).not.toContain('run-in-logs');
    });

    it('shows durable run history in the dedicated Logs view', () => {
        const markup = renderToStaticMarkup(<LogsPage logs={[]} runs={[run]} view="runs" requestedRunId="run-in-logs"
            logFilter="all" setLogFilter={vi.fn()} onViewChange={vi.fn()} onRefresh={vi.fn()} onClear={vi.fn()} />);
        expect(markup).toContain('Run History');
        expect(markup).toContain('Last ten runs');
        expect(markup).toContain('run-in-logs');
        expect(markup).not.toContain('Clear logs');
    });
});
