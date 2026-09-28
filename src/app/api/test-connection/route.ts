import { NextResponse } from 'next/server';
import { createMediaServerConnector } from '@/lib/media-server';
import { testSonarrConnection, getSonarrQualityProfiles, getSonarrRootFolders } from '@/lib/sonarr';
import { testRadarrConnection, getRadarrQualityProfiles, getRadarrRootFolders } from '@/lib/radarr';
import { testAiConnection } from '@/lib/ai-recommender';
import { getConfig, getConfigWithOverrides } from '@/lib/config';
import { sendTestNotification } from '@/lib/notifications';
import { configurationMatchesSavedService } from '@/lib/service-health-observer';
import { recordServiceHealth } from '@/lib/service-health';
import type { CoreService } from '@/lib/engine-observability-types';

const SERVICES = new Set(['mediaServer', 'sonarr', 'radarr', 'ai', 'tmdb', 'discord', 'telegram']);

function failure(message: string, extra: Record<string, unknown> = {}) {
    return NextResponse.json({ success: false, message, ...extra });
}

export async function POST(request: Request) {
    let body: unknown;
    try { body = await request.json(); } catch {
        return NextResponse.json({ error: 'Valid JSON body required' }, { status: 400 });
    }
    if (!body || typeof body !== 'object') return NextResponse.json({ error: 'Request body required' }, { status: 400 });
    const { service, settings } = body as { service?: unknown; settings?: unknown };
    if (typeof service !== 'string' || !SERVICES.has(service)) return NextResponse.json({ error: 'Unknown service' }, { status: 400 });
    if (settings !== undefined && (typeof settings !== 'object' || settings === null || Array.isArray(settings))) {
        return NextResponse.json({ error: 'settings must be an object' }, { status: 400 });
    }
    const overrides = (settings || {}) as Record<string, string>;
    const config = getConfigWithOverrides(overrides);
    const coreService = ({ mediaServer: 'media_server', sonarr: 'sonarr', radarr: 'radarr', ai: 'ai', tmdb: 'tmdb' } as const)[service as 'mediaServer' | 'sonarr' | 'radarr' | 'ai' | 'tmdb'] as CoreService | undefined;
    const observe = (success: boolean, message: string) => {
        if (!coreService || !configurationMatchesSavedService(coreService, getConfig(), config)) return;
        recordServiceHealth({ service: coreService, state: success ? 'healthy' : 'failed', checkedAt: new Date().toISOString(), message, source: 'connection_test' });
    };
    const observedFailure = (message: string, extra: Record<string, unknown> = {}) => {
        observe(false, message);
        return failure(message, extra);
    };

    switch (service) {
        case 'mediaServer': {
            const label = config.mediaServer.type === 'plex' ? 'Plex' : config.mediaServer.type === 'jellyfin' ? 'Jellyfin' : 'Emby';
            try {
                const connector = createMediaServerConnector(config.mediaServer);
                if (!await connector.testConnection()) return observedFailure(`Could not connect to ${label}. Check the server URL and credentials.`, { users: [], type: config.mediaServer.type });
                let users: { id: string; name: string }[] = [];
                try { users = await connector.getUsers(); } catch { /* Connection remains valid. */ }
                observe(true, 'Last query succeeded');
                return NextResponse.json({ success: true, message: `Connected to ${label}`, details: { serverType: config.mediaServer.type, userCount: users.length }, users, type: config.mediaServer.type });
            } catch {
                return observedFailure(`Could not connect to ${label}. Check the server URL and credentials.`, { users: [], type: config.mediaServer.type });
            }
        }
        case 'sonarr': {
            try {
                if (!await testSonarrConnection(config.sonarr)) return observedFailure('Could not connect to Sonarr. Check the URL and API key.', { profiles: [], rootFolders: [] });
                let profiles: { id: number; name: string }[] = [];
                let rootFolders: { id: number; path: string; freeSpace?: number }[] = [];
                try { profiles = await getSonarrQualityProfiles(config.sonarr); rootFolders = await getSonarrRootFolders(config.sonarr); } catch { /* Connection remains valid. */ }
                observe(true, 'Last query succeeded');
                return NextResponse.json({ success: true, message: 'Connected to Sonarr', details: { profileCount: profiles.length, rootFolderCount: rootFolders.length }, profiles, rootFolders });
            } catch { return observedFailure('Could not connect to Sonarr. Check the URL and API key.', { profiles: [], rootFolders: [] }); }
        }
        case 'radarr': {
            try {
                if (!await testRadarrConnection(config.radarr)) return observedFailure('Could not connect to Radarr. Check the URL and API key.', { profiles: [], rootFolders: [] });
                let profiles: { id: number; name: string }[] = [];
                let rootFolders: { id: number; path: string; freeSpace?: number }[] = [];
                try { profiles = await getRadarrQualityProfiles(config.radarr); rootFolders = await getRadarrRootFolders(config.radarr); } catch { /* Connection remains valid. */ }
                observe(true, 'Last query succeeded');
                return NextResponse.json({ success: true, message: 'Connected to Radarr', details: { profileCount: profiles.length, rootFolderCount: rootFolders.length }, profiles, rootFolders });
            } catch { return observedFailure('Could not connect to Radarr. Check the URL and API key.', { profiles: [], rootFolders: [] }); }
        }
        case 'ai': {
            try {
                if (!await testAiConnection(config.ai)) return observedFailure('Could not connect to the AI provider. Check the provider URL, model, and API key.');
                observe(true, 'Model query succeeded');
                return NextResponse.json({ success: true, message: 'Connected to AI provider', details: { model: config.ai.model }, model: config.ai.model });
            } catch { return observedFailure('Could not connect to the AI provider. Check the provider URL, model, and API key.'); }
        }
        case 'tmdb': {
            try {
                const axios = (await import('axios')).default;
                const response = await axios.get(`${config.tmdb.baseUrl}/movie/550`, { params: { api_key: config.tmdb.apiKey } });
                observe(true, 'Last query succeeded');
                return NextResponse.json({ success: true, message: 'Connected to TMDb', details: { sampleTitle: response.data.title }, movieTitle: response.data.title });
            } catch { return observedFailure('Could not connect to TMDb. Check network access or the optional custom API key.'); }
        }
        case 'discord':
            try { await sendTestNotification('discord', overrides); return NextResponse.json({ success: true, message: 'Discord test notification sent' }); }
            catch { return failure('Could not send the Discord test. Check the webhook URL.'); }
        case 'telegram':
            try { await sendTestNotification('telegram', overrides); return NextResponse.json({ success: true, message: 'Telegram test notification sent' }); }
            catch { return failure('Could not send the Telegram test. Check the bot token and chat ID.'); }
    }
}
