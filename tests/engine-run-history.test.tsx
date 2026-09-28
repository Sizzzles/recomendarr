import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { EngineRunHistory } from '../src/components/app/engine-run-history';
import { emptyEngineRunSummary, pendingEngineStages } from '../src/lib/engine-observability-types';

function failedRun() {
    const stages = pendingEngineStages();
    const preparing = stages.find(stage => stage.name === 'preparing')!;
    preparing.status = 'failed';
    preparing.failureCount = 2;
    preparing.failures = ['Radarr library: Radarr Down', 'Sonarr library: Sonarr Down'];
    const syncing = stages.find(stage => stage.name === 'syncing_watch_history')!;
    syncing.status = 'failed';
    syncing.failureCount = 1;
    syncing.failures = ['Failed to fetch watch history: Plex Down'];
    return {
        id: 'failed-layout', trigger: 'manual' as const, source: 'manual', engineVersion: '3.0.1', status: 'failed' as const,
        startedAt: '2026-09-29T00:00:00.000Z', completedAt: '2026-09-29T00:00:03.000Z', currentStage: 'syncing_watch_history' as const,
        summary: { ...emptyEngineRunSummary(), errorCount: 3 }, stages,
        errorMessage: 'Failed to fetch watch history: Plex Down', createdAt: '2026-09-29T00:00:00.000Z', updatedAt: '2026-09-29T00:00:03.000Z', durationMs: 3000,
    };
}

describe('EngineRunHistory', () => {
    it('renders stage headings separately from single and multiple failure rows', () => {
        const markup = renderToStaticMarkup(<EngineRunHistory runs={[failedRun()]} />);
        expect(markup).toContain('class="engine-stage-heading"');
        expect(markup).toContain('aria-label="preparing details"');
        expect(markup).toContain('<li>Radarr library: Radarr Down</li><li>Sonarr library: Sonarr Down</li>');
        expect(markup).toContain('aria-label="syncing watch history details"');
        expect(markup).toContain('<li>Failed to fetch watch history: Plex Down</li>');
    });
});
