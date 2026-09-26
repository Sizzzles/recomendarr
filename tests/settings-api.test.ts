import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    getAllSavedSettings: vi.fn(), saveSettings: vi.fn(), isSetupComplete: vi.fn(), getConfig: vi.fn(),
    syncRecommendationScheduler: vi.fn(), getSchedulerSnapshot: vi.fn(),
}));
vi.mock('../src/lib/config', () => ({
    getAllSavedSettings: mocks.getAllSavedSettings, saveSettings: mocks.saveSettings,
    isSetupComplete: mocks.isSetupComplete, getConfig: mocks.getConfig,
}));
vi.mock('@/lib/config', () => ({
    getAllSavedSettings: mocks.getAllSavedSettings, saveSettings: mocks.saveSettings,
    isSetupComplete: mocks.isSetupComplete, getConfig: mocks.getConfig,
}));
vi.mock('../src/lib/scheduler', () => ({
    syncRecommendationScheduler: mocks.syncRecommendationScheduler,
    getSchedulerSnapshot: mocks.getSchedulerSnapshot,
}));
vi.mock('@/lib/scheduler', () => ({
    syncRecommendationScheduler: mocks.syncRecommendationScheduler,
    getSchedulerSnapshot: mocks.getSchedulerSnapshot,
}));
vi.mock('node-cron', () => ({ default: { validate: () => true } }));

import { GET, PUT } from '../src/app/api/settings/route';

function baseConfig() {
    return {
        mediaServer: { type: 'plex', url: 'https://plex', apiKey: 'super-secret-token' },
        sonarr: { url: '', apiKey: '' }, radarr: { url: '', apiKey: '' },
        ai: { enabled: false, providerUrl: '', apiKey: '', model: '' },
        scheduler: { enabled: false, cronSchedule: '', autoAdd: false },
        notifications: {},
    };
}

describe('settings API Plex token handling', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.getConfig.mockReturnValue(baseConfig());
        mocks.getAllSavedSettings.mockReturnValue({ media_server_api_key: 'super-secret-token', sonarr_url: 'http://sonarr' });
        mocks.getSchedulerSnapshot.mockReturnValue({ nextRun: null, active: false });
    });

    it('masks the Plex token in config and raw settings', async () => {
        const response = await GET();
        const body = await response.json();
        expect(JSON.stringify(body)).not.toContain('super-secret-token');
        expect(body.raw.media_server_api_key).toBe('••••oken');
    });

    it('does not expose a legacy plex_token setting', async () => {
        mocks.getAllSavedSettings.mockReturnValue({ plex_token: 'legacy-secret-token' });
        const response = await GET();
        const body = await response.json();
        expect(JSON.stringify(body)).not.toContain('legacy-secret-token');
        expect(body.raw.plex_token).toBe('••••oken');
    });

    it('does not overwrite the Plex token when the masked placeholder is saved', async () => {
        const response = await PUT(new Request('http://localhost/api/settings', {
            method: 'PUT', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ settings: { media_server_api_key: '••••oken', sonarr_url: 'http://new-sonarr' } }),
        }) as never);
        expect(response.status).toBe(200);
        expect(mocks.saveSettings).toHaveBeenCalledWith({ sonarr_url: 'http://new-sonarr' });
    });
});
