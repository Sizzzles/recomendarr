import { redactDiagnosticText } from './diagnostics';
import { recordServiceHealth } from './service-health';
import type { CoreService, ServiceHealthObservation, ServiceHealthSource } from './engine-observability-types';
import type { AppConfig } from './config';

type HealthWriter = (observation: Omit<ServiceHealthObservation, 'updatedAt'>) => unknown;

function sanitize(value: string): string {
    return redactDiagnosticText(value)
        .replace(/\b(token|api[_-]?key|password)\s*=\s*[^\s,;]+/gi, '$1=[REDACTED]')
        .replace(/\s+/g, ' ').trim().slice(0, 300);
}

export class ServiceAttemptAccumulator {
    private successes = 0;
    private failures = 0;
    private successMessage = '';
    private failureMessage = '';
    private flushed = false;

    constructor(
        private readonly service: CoreService,
        private readonly source: ServiceHealthSource,
        private readonly writer: HealthWriter = recordServiceHealth,
        private readonly now: () => string = () => new Date().toISOString(),
        private readonly configurationStillCurrent: () => boolean = () => true,
    ) {}

    recordSuccess(message = 'Last query succeeded'): void {
        this.successes += 1;
        if (!this.successMessage) this.successMessage = sanitize(message);
    }

    recordFailure(message: string): void {
        this.failures += 1;
        if (!this.failureMessage) this.failureMessage = sanitize(message);
    }

    flush(): void {
        if (this.flushed) return;
        this.flushed = true;
        if (this.successes + this.failures === 0 || !this.configurationStillCurrent()) return;
        const state = this.failures === 0 ? 'healthy' : this.successes === 0 ? 'failed' : 'degraded';
        const message = state === 'healthy' ? this.successMessage || 'Last query succeeded'
            : state === 'failed' ? this.failureMessage || 'All attempted operations failed'
                : this.failureMessage || 'Some attempted operations failed';
        this.writer({ service: this.service, state, checkedAt: this.now(), message, source: this.source });
    }
}

const HEALTH_SETTING_KEYS: Record<CoreService, string[]> = {
    media_server: [
        'media_server_type', 'media_server_url', 'media_server_api_key', 'media_server_user_id', 'plex_token',
        'plex_server_identifier', 'plex_server_name', 'plex_account_name',
    ],
    tmdb: ['tmdb_api_key'],
    ai: ['ai_enabled', 'ai_provider_url', 'ai_api_key', 'ai_model'],
    sonarr: ['sonarr_url', 'sonarr_api_key'],
    radarr: ['radarr_url', 'radarr_api_key'],
};

export function changedHealthServices(before: Record<string, string>, after: Record<string, string>): CoreService[] {
    return (Object.keys(HEALTH_SETTING_KEYS) as CoreService[]).filter(service =>
        HEALTH_SETTING_KEYS[service].some(key => (before[key] || '') !== (after[key] || ''))
    );
}

export function configurationMatchesSavedService(service: CoreService, saved: AppConfig, tested: AppConfig): boolean {
    const values = (config: AppConfig): unknown => {
        switch (service) {
            case 'media_server': return config.mediaServer;
            case 'tmdb': return config.tmdb;
            case 'ai': return config.ai;
            case 'sonarr': return { url: config.sonarr.url, apiKey: config.sonarr.apiKey };
            case 'radarr': return { url: config.radarr.url, apiKey: config.radarr.apiKey };
        }
    };
    return JSON.stringify(values(saved)) === JSON.stringify(values(tested));
}
