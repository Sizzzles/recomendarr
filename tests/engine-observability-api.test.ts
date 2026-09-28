import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    active: vi.fn(), recent: vi.fn(), one: vi.fn(), latestCompleted: vi.fn(), lastSuccess: vi.fn(), health: vi.fn(), config: vi.fn(),
}));
vi.mock('@/lib/engine-runs', () => ({
    getActiveEngineRun: mocks.active, getRecentEngineRuns: mocks.recent, getEngineRun: mocks.one,
    getLatestCompletedEngineRun: mocks.latestCompleted, getLastSuccessfulEngineRun: mocks.lastSuccess,
}));
vi.mock('@/lib/service-health', () => ({ getEffectiveServiceHealth: mocks.health }));
vi.mock('@/lib/config', () => ({ getConfig: mocks.config }));

import { GET as getStatus } from '../src/app/api/engine/status/route';
import { GET as getRuns } from '../src/app/api/engine/runs/route';
import { GET as getHealth } from '../src/app/api/service-health/route';

const run = { id: 'run-visible-123', status: 'succeeded', summary: {}, stages: [], source: 'manual', engineVersion: '3.0.1' };

describe('engine observability APIs', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.active.mockReturnValue(null);
        mocks.recent.mockReturnValue([run]);
        mocks.latestCompleted.mockReturnValue(run);
        mocks.lastSuccess.mockReturnValue(run);
        mocks.config.mockReturnValue({
            mediaServer: { url: '', apiKey: '', plexToken: '' }, tmdb: { apiKey: 'built-in' },
            ai: { enabled: false, providerUrl: '', model: '' }, sonarr: { url: '', apiKey: '' }, radarr: { url: '', apiKey: '' },
        });
        mocks.health.mockReturnValue([{ service: 'tmdb', state: 'healthy', reason: 'Last query succeeded' }]);
    });

    it('returns authoritative active/latest/last-success status with no-store caching', async () => {
        mocks.active.mockReturnValue({ ...run, status: 'running' });
        const response = await getStatus();
        const body = await response.json();
        expect(response.headers.get('cache-control')).toContain('no-store');
        expect(body.activeRun.id).toBe('run-visible-123');
        expect(body.latestRun.id).toBe('run-visible-123');
        expect(body.lastSuccessfulRun.id).toBe('run-visible-123');
    });

    it('defaults runs to ten and rejects malformed or out-of-range limits', async () => {
        const response = await getRuns(new Request('http://localhost/api/engine/runs'));
        expect(response.status).toBe(200);
        expect(mocks.recent).toHaveBeenCalledWith(10);
        expect((await response.json()).runs[0].id).toBe('run-visible-123');
        for (const value of ['nope', '0', '11', '2.5']) {
            expect((await getRuns(new Request(`http://localhost/api/engine/runs?limit=${value}`))).status).toBe(400);
        }
    });

    it('returns one run by id and never exposes raw JSON fields', async () => {
        mocks.one.mockReturnValue(run);
        const response = await getRuns(new Request('http://localhost/api/engine/runs?id=run-visible-123'));
        const serialized = JSON.stringify(await response.json());
        expect(serialized).toContain('run-visible-123');
        expect(serialized).not.toContain('summary_json');
        expect(serialized).not.toContain('stages_json');
    });

    it('returns effective health with concise reasons and no-store caching', async () => {
        const response = await getHealth();
        expect(response.headers.get('cache-control')).toContain('no-store');
        expect(await response.json()).toEqual({ services: [{ service: 'tmdb', state: 'healthy', reason: 'Last query succeeded' }] });
        expect(mocks.health).toHaveBeenCalledWith(expect.objectContaining({ configured: expect.any(Object), disabled: { ai: true } }));
    });
});
