import axios from 'axios';
import { testAiConnection } from '@/lib/ai-recommender';
import type { AppConfig } from '@/lib/config';
import { getConfig } from '@/lib/config';
import { createMediaServerConnector } from '@/lib/media-server';
import { testRadarrConnection } from '@/lib/radarr';
import { recordServiceHealth } from '@/lib/service-health';
import { testSonarrConnection } from '@/lib/sonarr';
import type { CoreService, EffectiveServiceHealthState } from '@/lib/engine-observability-types';

export interface CoreHealthCheckResult {
    service: CoreService;
    state: Extract<EffectiveServiceHealthState, 'healthy' | 'degraded' | 'failed' | 'disabled' | 'not_configured'>;
    message: string;
}

export interface HealthCheckSummary {
    healthy: number;
    degraded: number;
    failed: number;
    disabled: number;
    notConfigured: number;
}

function configuredKeyIdentifier(secret: string): string | null {
    const value = secret.trim();
    if (!value) return null;
    const prefix = value.startsWith('sk-') ? 'sk-' : 'key-';
    return `${prefix}...${value.slice(-4)}`;
}

function persist(result: CoreHealthCheckResult): CoreHealthCheckResult {
    if (result.state === 'healthy' || result.state === 'degraded' || result.state === 'failed') {
        recordServiceHealth({ service: result.service, state: result.state, checkedAt: new Date().toISOString(), message: result.message, source: 'connection_test' });
    }
    return result;
}

export async function checkCoreService(service: CoreService, config: AppConfig, persistResult = true): Promise<CoreHealthCheckResult> {
    let result: CoreHealthCheckResult;
    if (service === 'media_server') {
        if (!config.mediaServer.url || !(config.mediaServer.apiKey || config.mediaServer.plexToken)) {
            result = { service, state: 'not_configured', message: 'Not configured' };
        } else {
            try {
                const connected = await createMediaServerConnector(config.mediaServer).testConnection();
                result = connected
                    ? { service, state: 'healthy', message: 'Media server connection succeeded' }
                    : { service, state: 'failed', message: 'Could not connect to the configured media server' };
            } catch { result = { service, state: 'failed', message: 'Could not connect to the configured media server' }; }
        }
    } else if (service === 'tmdb') {
        if (!config.tmdb.apiKey) result = { service, state: 'not_configured', message: 'Not configured' };
        else {
            try {
                await axios.get(`${config.tmdb.baseUrl}/movie/550`, { params: { api_key: config.tmdb.apiKey } });
                result = { service, state: 'healthy', message: 'TMDb query succeeded' };
            } catch { result = { service, state: 'failed', message: 'Could not connect to TMDb' }; }
        }
    } else if (service === 'ai') {
        if (!config.ai.enabled) result = { service, state: 'disabled', message: 'AI is disabled' };
        else if (!config.ai.providerUrl || !config.ai.model || !config.ai.apiKey) result = { service, state: 'not_configured', message: 'AI configuration is incomplete' };
        else {
            const identity = configuredKeyIdentifier(config.ai.apiKey);
            try {
                const connected = await testAiConnection(config.ai);
                result = connected
                    ? { service, state: 'healthy', message: 'AI model query succeeded' }
                    : { service, state: 'failed', message: `Could not connect to the AI provider${identity ? ` using ${identity}` : ''}` };
            } catch { result = { service, state: 'failed', message: `Could not connect to the AI provider${identity ? ` using ${identity}` : ''}` }; }
        }
    } else if (service === 'sonarr') {
        if (!config.sonarr.url || !config.sonarr.apiKey) result = { service, state: 'not_configured', message: 'Not configured' };
        else {
            try { result = await testSonarrConnection(config.sonarr)
                ? { service, state: 'healthy', message: 'Sonarr connection succeeded' }
                : { service, state: 'failed', message: 'Could not connect to Sonarr' }; }
            catch { result = { service, state: 'failed', message: 'Could not connect to Sonarr' }; }
        }
    } else {
        if (!config.radarr.url || !config.radarr.apiKey) result = { service, state: 'not_configured', message: 'Not configured' };
        else {
            try { result = await testRadarrConnection(config.radarr)
                ? { service, state: 'healthy', message: 'Radarr connection succeeded' }
                : { service, state: 'failed', message: 'Could not connect to Radarr' }; }
            catch { result = { service, state: 'failed', message: 'Could not connect to Radarr' }; }
        }
    }
    return persistResult ? persist(result) : result;
}

export async function runPersistedServiceHealthCheck(): Promise<{ results: CoreHealthCheckResult[]; summary: HealthCheckSummary }> {
    const config = getConfig();
    const services: CoreService[] = ['media_server', 'tmdb', 'ai', 'sonarr', 'radarr'];
    const results: CoreHealthCheckResult[] = [];
    for (const service of services) results.push(await checkCoreService(service, config));
    const summary: HealthCheckSummary = { healthy: 0, degraded: 0, failed: 0, disabled: 0, notConfigured: 0 };
    for (const result of results) {
        if (result.state === 'not_configured') summary.notConfigured += 1;
        else summary[result.state] += 1;
    }
    return { results, summary };
}
