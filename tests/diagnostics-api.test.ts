import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    getRuntimeMetadata: vi.fn(),
    getDatabaseDiagnostics: vi.fn(),
    getRecentDiagnosticErrors: vi.fn(),
    buildDiagnosticReport: vi.fn(),
    redactDiagnosticText: vi.fn((value: string) => value.replace(/plex-secret-value/g, '[REDACTED]')),
    getConfig: vi.fn(),
    getAllSavedSettings: vi.fn(),
    getSchedulerSnapshot: vi.fn(),
    mediaTest: vi.fn(),
    sonarrTest: vi.fn(),
    radarrTest: vi.fn(),
    aiTest: vi.fn(),
}));

vi.mock('../src/lib/diagnostics', () => ({
    getRuntimeMetadata: mocks.getRuntimeMetadata,
    getDatabaseDiagnostics: mocks.getDatabaseDiagnostics,
    getRecentDiagnosticErrors: mocks.getRecentDiagnosticErrors,
    buildDiagnosticReport: mocks.buildDiagnosticReport,
    redactDiagnosticText: mocks.redactDiagnosticText,
}));
vi.mock('@/lib/diagnostics', () => ({
    getRuntimeMetadata: mocks.getRuntimeMetadata,
    getDatabaseDiagnostics: mocks.getDatabaseDiagnostics,
    getRecentDiagnosticErrors: mocks.getRecentDiagnosticErrors,
    buildDiagnosticReport: mocks.buildDiagnosticReport,
    redactDiagnosticText: mocks.redactDiagnosticText,
}));
vi.mock('../src/lib/config', () => ({
    getConfig: mocks.getConfig,
    getAllSavedSettings: mocks.getAllSavedSettings,
}));
vi.mock('@/lib/config', () => ({
    getConfig: mocks.getConfig,
    getAllSavedSettings: mocks.getAllSavedSettings,
}));
vi.mock('../src/lib/scheduler', () => ({ getSchedulerSnapshot: mocks.getSchedulerSnapshot }));
vi.mock('@/lib/scheduler', () => ({ getSchedulerSnapshot: mocks.getSchedulerSnapshot }));
vi.mock('@/lib/media-server', () => ({ createMediaServerConnector: () => ({ testConnection: mocks.mediaTest }) }));
vi.mock('@/lib/sonarr', () => ({ testSonarrConnection: mocks.sonarrTest }));
vi.mock('@/lib/radarr', () => ({ testRadarrConnection: mocks.radarrTest }));
vi.mock('@/lib/ai-recommender', () => ({ testAiConnection: mocks.aiTest }));

import { GET } from '../src/app/api/diagnostics/route';

const secrets = {
    plex: 'plex-secret-value',
    sonarr: 'sonarr-secret-value',
    radarr: 'radarr-secret-value',
    ai: 'ai-secret-value',
    tmdb: 'tmdb-secret-value',
    discord: 'https://discord.com/api/webhooks/123/discord-secret-value',
    telegram: 'telegram-secret-value',
    chat: '-987654321',
};

function configWithSecrets() {
    return {
        mediaServer: { type: 'plex', url: 'https://plex.local', apiKey: secrets.plex, userId: '', plexToken: '' },
        sonarr: { url: 'https://sonarr.local', apiKey: secrets.sonarr },
        radarr: { url: 'https://radarr.local', apiKey: secrets.radarr },
        tmdb: { apiKey: secrets.tmdb, baseUrl: 'https://api.themoviedb.org/3' },
        ai: { enabled: true, providerUrl: 'https://ai.local', apiKey: secrets.ai, model: 'safe-model' },
        scheduler: { enabled: true },
        notifications: {
            discordEnabled: true, discordWebhookUrl: secrets.discord,
            telegramEnabled: true, telegramBotToken: secrets.telegram, telegramChatId: secrets.chat,
        },
    };
}

describe('diagnostics API', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.getRuntimeMetadata.mockReturnValue({ appVersion: '3.0.1', gitCommit: 'abcdef123456', nodeVersion: 'v24', platform: 'win32' });
        mocks.getDatabaseDiagnostics.mockReturnValue({
            reachable: true,
            sizeBytes: 1024,
            journalMode: 'wal',
            resolvedPath: 'C:\\private\\data\\recomendarr.db',
            sanitizedPath: 'C:\\...\\recomendarr.db',
            appliedMigrations: ['migration_a', 'migration_b'],
        });
        mocks.getRecentDiagnosticErrors.mockReturnValue([]);
        mocks.buildDiagnosticReport.mockReturnValue('Database path: C:\\...\\recomendarr.db');
        mocks.getConfig.mockReturnValue(configWithSecrets());
        mocks.getAllSavedSettings.mockReturnValue({ plex_server_identifier: 'server-id', media_server_api_key: secrets.plex });
        mocks.getSchedulerSnapshot.mockReturnValue({ active: true, nextRun: null });
    });

    it('returns allowlisted metadata with no-store caching and deterministic services', async () => {
        const response = await GET();
        const body = await response.json();

        expect(response.status).toBe(200);
        expect(response.headers.get('cache-control')).toBe('no-store');
        expect(body.database).toMatchObject({
            resolvedPath: 'C:\\private\\data\\recomendarr.db',
            sanitizedPath: 'C:\\...\\recomendarr.db',
            appliedMigrations: ['migration_a', 'migration_b'],
        });
        expect(body.services.map((service: { name: string }) => service.name)).toEqual([
            'Plex', 'Sonarr', 'Radarr', 'TMDb', 'AI', 'Discord', 'Telegram',
        ]);
        expect(body.services.every((service: { latestState: string }) => service.latestState === 'not_tested')).toBe(true);
    });

    it('never probes an external service', async () => {
        await GET();

        expect(mocks.mediaTest).not.toHaveBeenCalled();
        expect(mocks.sonarrTest).not.toHaveBeenCalled();
        expect(mocks.radarrTest).not.toHaveBeenCalled();
        expect(mocks.aiTest).not.toHaveBeenCalled();
    });

    it('does not serialize configured secrets and gives report formatting only the sanitized path', async () => {
        const response = await GET();
        const serialized = JSON.stringify(await response.json());

        for (const secret of Object.values(secrets)) expect(serialized).not.toContain(secret);
        expect(mocks.buildDiagnosticReport).toHaveBeenCalledWith(expect.objectContaining({
            database: expect.not.objectContaining({ resolvedPath: expect.anything() }),
        }));
        const reportInput = mocks.buildDiagnosticReport.mock.calls[0][0];
        expect(reportInput.database.sanitizedPath).toBe('C:\\...\\recomendarr.db');
        expect(reportInput.database).not.toHaveProperty('resolvedPath');
    });

    it('returns a generic failure when snapshot construction fails', async () => {
        mocks.getRuntimeMetadata.mockImplementation(() => { throw new Error(`leaked ${secrets.plex}`); });

        const response = await GET();
        const body = await response.json();

        expect(response.status).toBe(500);
        expect(body).toEqual({ error: 'Unable to collect diagnostics' });
        expect(JSON.stringify(body)).not.toContain(secrets.plex);
    });
});
