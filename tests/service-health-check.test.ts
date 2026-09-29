import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    createMediaServerConnector: vi.fn(), testSonarr: vi.fn(), testRadarr: vi.fn(), testAi: vi.fn(),
    axiosGet: vi.fn(), record: vi.fn(), getConfig: vi.fn(),
}));
vi.mock('@/lib/media-server', () => ({ createMediaServerConnector: mocks.createMediaServerConnector }));
vi.mock('@/lib/sonarr', () => ({ testSonarrConnection: mocks.testSonarr }));
vi.mock('@/lib/radarr', () => ({ testRadarrConnection: mocks.testRadarr }));
vi.mock('@/lib/ai-recommender', () => ({ testAiConnection: mocks.testAi }));
vi.mock('@/lib/service-health', () => ({ recordServiceHealth: mocks.record }));
vi.mock('@/lib/config', () => ({ getConfig: mocks.getConfig }));
vi.mock('axios', () => ({ default: { get: mocks.axiosGet } }));

function config(overrides: Record<string, unknown> = {}) {
    return {
        mediaServer: { type: 'plex', url: 'https://plex', apiKey: 'plex-secret', plexToken: '' },
        tmdb: { baseUrl: 'https://tmdb', apiKey: 'tmdb-secret' },
        ai: { enabled: true, providerUrl: 'https://api.openai.com/v1', apiKey: 'sk-test-secret-CF8A', model: 'gpt-4o' },
        sonarr: { url: 'https://sonarr', apiKey: 'sonarr-secret' },
        radarr: { url: 'https://radarr', apiKey: 'radarr-secret' },
        ...overrides,
    };
}

describe('persisted service health check', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.getConfig.mockReturnValue(config());
        mocks.createMediaServerConnector.mockReturnValue({ testConnection: vi.fn().mockResolvedValue(true) });
        mocks.testSonarr.mockResolvedValue(true); mocks.testRadarr.mockResolvedValue(true);
        mocks.testAi.mockResolvedValue(true); mocks.axiosGet.mockResolvedValue({ data: { title: 'Fight Club' } });
    });

    it('checks all configured services, persists observations, and returns an all-healthy summary', async () => {
        const { runPersistedServiceHealthCheck } = await import('../src/lib/service-health-check');
        const result = await runPersistedServiceHealthCheck();
        expect(result.summary).toEqual({ healthy: 5, degraded: 0, failed: 0, disabled: 0, notConfigured: 0 });
        expect(result.results.map(item => item.state)).toEqual(['healthy', 'healthy', 'healthy', 'healthy', 'healthy']);
        expect(mocks.record).toHaveBeenCalledTimes(5);
    });

    it('reports failures safely and abbreviates only the configured AI key', async () => {
        mocks.testAi.mockRejectedValue(new Error('provider leaked sk-provider-raw-secret'));
        const { runPersistedServiceHealthCheck } = await import('../src/lib/service-health-check');
        const result = await runPersistedServiceHealthCheck();
        const ai = result.results.find(item => item.service === 'ai');
        expect(ai).toMatchObject({ state: 'failed' });
        expect(ai?.message).toContain('sk-...CF8A');
        const serialized = JSON.stringify(result);
        expect(serialized).not.toContain('sk-test-secret-CF8A');
        expect(serialized).not.toContain('sk-provider-raw-secret');
        expect(serialized).not.toContain('plex-secret');
    });

    it('does not call disabled AI or unconfigured optional Arr services', async () => {
        mocks.getConfig.mockReturnValue(config({
            ai: { enabled: false, providerUrl: '', apiKey: '', model: '' },
            sonarr: { url: '', apiKey: '' }, radarr: { url: '', apiKey: '' },
        }));
        const { runPersistedServiceHealthCheck } = await import('../src/lib/service-health-check');
        const result = await runPersistedServiceHealthCheck();
        expect(result.summary).toMatchObject({ healthy: 2, disabled: 1, notConfigured: 2, failed: 0 });
        expect(mocks.testAi).not.toHaveBeenCalled();
        expect(mocks.testSonarr).not.toHaveBeenCalled();
        expect(mocks.testRadarr).not.toHaveBeenCalled();
        expect(mocks.record).toHaveBeenCalledTimes(2);
    });
});
