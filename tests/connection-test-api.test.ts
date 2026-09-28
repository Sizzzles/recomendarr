import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    getConfigWithOverrides: vi.fn(),
    getConfig: vi.fn(), recordServiceHealth: vi.fn(),
    createMediaServerConnector: vi.fn(),
    testSonarrConnection: vi.fn(), getSonarrQualityProfiles: vi.fn(), getSonarrRootFolders: vi.fn(),
    testRadarrConnection: vi.fn(), getRadarrQualityProfiles: vi.fn(), getRadarrRootFolders: vi.fn(),
    testAiConnection: vi.fn(), sendTestNotification: vi.fn(), axiosGet: vi.fn(),
}));

vi.mock('@/lib/config', () => ({ getConfigWithOverrides: mocks.getConfigWithOverrides, getConfig: mocks.getConfig }));
vi.mock('@/lib/service-health', () => ({ recordServiceHealth: mocks.recordServiceHealth }));
vi.mock('@/lib/service-health-observer', async () => import('../src/lib/service-health-observer'));
vi.mock('@/lib/media-server', () => ({ createMediaServerConnector: mocks.createMediaServerConnector }));
vi.mock('@/lib/sonarr', () => ({
    testSonarrConnection: mocks.testSonarrConnection,
    getSonarrQualityProfiles: mocks.getSonarrQualityProfiles,
    getSonarrRootFolders: mocks.getSonarrRootFolders,
}));
vi.mock('@/lib/radarr', () => ({
    testRadarrConnection: mocks.testRadarrConnection,
    getRadarrQualityProfiles: mocks.getRadarrQualityProfiles,
    getRadarrRootFolders: mocks.getRadarrRootFolders,
}));
vi.mock('@/lib/ai-recommender', () => ({ testAiConnection: mocks.testAiConnection }));
vi.mock('@/lib/notifications', () => ({ sendTestNotification: mocks.sendTestNotification }));
vi.mock('axios', () => ({ default: { get: mocks.axiosGet } }));

import { POST } from '../src/app/api/test-connection/route';

function request(body: unknown) {
    return new Request('http://localhost/api/test-connection', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
}

function baseConfig() {
    return {
        mediaServer: { type: 'plex', url: 'https://plex', apiKey: 'plex-secret' },
        sonarr: { url: 'https://sonarr', apiKey: 'sonarr-secret' },
        radarr: { url: 'https://radarr', apiKey: 'radarr-secret' },
        tmdb: { baseUrl: 'https://tmdb', apiKey: 'tmdb-secret' },
        ai: { enabled: true, providerUrl: 'https://ai', apiKey: 'ai-secret', model: 'gpt-test' },
    };
}

describe('connection test API', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.getConfigWithOverrides.mockReturnValue(baseConfig());
        mocks.getConfig.mockReturnValue(baseConfig());
        mocks.createMediaServerConnector.mockReturnValue({
            testConnection: vi.fn().mockResolvedValue(true),
            getUsers: vi.fn().mockResolvedValue([{ id: '1', name: 'Primary' }]),
        });
        mocks.testSonarrConnection.mockResolvedValue(true);
        mocks.getSonarrQualityProfiles.mockResolvedValue([{ id: 1, name: 'HD' }]);
        mocks.getSonarrRootFolders.mockResolvedValue([{ id: 1, path: '/tv', freeSpace: 10 }]);
        mocks.testRadarrConnection.mockResolvedValue(true);
        mocks.getRadarrQualityProfiles.mockResolvedValue([{ id: 2, name: 'UHD' }]);
        mocks.getRadarrRootFolders.mockResolvedValue([{ id: 2, path: '/movies', freeSpace: 20 }]);
        mocks.testAiConnection.mockResolvedValue(true);
        mocks.axiosGet.mockResolvedValue({ data: { title: 'Fight Club' } });
    });

    it.each([
        ['mediaServer', 'Connected to Plex'], ['sonarr', 'Connected to Sonarr'],
        ['radarr', 'Connected to Radarr'], ['ai', 'Connected to AI provider'],
        ['tmdb', 'Connected to TMDb'], ['discord', 'Discord test notification sent'],
        ['telegram', 'Telegram test notification sent'],
    ])('returns a normalized success for %s', async (service, message) => {
        const response = await POST(request({ service, settings: {} }));
        const body = await response.json();
        expect(response.status).toBe(200);
        expect(body).toMatchObject({ success: true, message });
    });

    it('persists health only when the tested configuration matches saved settings', async () => {
        await POST(request({ service: 'tmdb', settings: {} }));
        expect(mocks.recordServiceHealth).toHaveBeenCalledWith(expect.objectContaining({ service: 'tmdb', state: 'healthy' }));

        mocks.recordServiceHealth.mockClear();
        mocks.getConfigWithOverrides.mockReturnValue({ ...baseConfig(), tmdb: { baseUrl: 'https://other', apiKey: 'different' } });
        await POST(request({ service: 'tmdb', settings: { tmdb_api_key: 'different' } }));
        expect(mocks.recordServiceHealth).not.toHaveBeenCalled();
    });

    it('preserves safe discovery collections and exposes only allowlisted details', async () => {
        const response = await POST(request({ service: 'sonarr', settings: {} }));
        const body = await response.json();
        expect(body.profiles).toEqual([{ id: 1, name: 'HD' }]);
        expect(body.rootFolders).toEqual([{ id: 1, path: '/tv', freeSpace: 10 }]);
        expect(body.details).toEqual({ profileCount: 1, rootFolderCount: 1 });
        expect(JSON.stringify(body)).not.toContain('sonarr-secret');
    });

    it('returns a useful sanitized failure for false and thrown upstream results', async () => {
        mocks.testSonarrConnection.mockResolvedValue(false);
        const falseResponse = await POST(request({ service: 'sonarr', settings: {} }));
        expect(await falseResponse.json()).toMatchObject({ success: false, message: 'Could not connect to Sonarr. Check the URL and API key.' });

        mocks.testRadarrConnection.mockRejectedValue(new Error('radarr-secret leaked from upstream'));
        const thrownResponse = await POST(request({ service: 'radarr', settings: {} }));
        const serialized = JSON.stringify(await thrownResponse.json());
        expect(thrownResponse.status).toBe(200);
        expect(serialized).toContain('Could not connect to Radarr');
        expect(serialized).not.toContain('radarr-secret');
    });

    it.each([
        [{ settings: {} }, 400],
        [{ service: 'unknown', settings: {} }, 400],
        [{ service: 'sonarr', settings: 'invalid' }, 400],
    ])('rejects malformed requests', async (body, status) => {
        const response = await POST(request(body));
        expect(response.status).toBe(status);
    });
});
