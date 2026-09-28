import type { SettingsFormData } from './models';

export type GuidedService = 'mediaServer' | 'sonarr' | 'radarr' | 'tmdb' | 'ai' | 'discord' | 'telegram' | 'scheduler';

const SERVICE_GUIDANCE_IDS: Record<GuidedService, string> = {
    mediaServer: 'media-server-guidance',
    sonarr: 'sonarr-guidance',
    radarr: 'radarr-guidance',
    tmdb: 'tmdb-guidance',
    ai: 'ai-guidance',
    discord: 'discord-guidance',
    telegram: 'telegram-guidance',
    scheduler: 'scheduler-guidance',
};

const SERVICE_TEST_NAMES: Partial<Record<GuidedService, string>> = {
    mediaServer: 'Test media server connection',
    sonarr: 'Test Sonarr connection',
    radarr: 'Test Radarr connection',
    ai: 'Test AI provider connection',
    discord: 'Send Discord test notification',
    telegram: 'Send Telegram test notification',
};

export function getServiceGuidanceId(service: GuidedService): string {
    return SERVICE_GUIDANCE_IDS[service];
}

export function getServiceTestAccessibleName(service: GuidedService): string {
    return SERVICE_TEST_NAMES[service] || `Test ${service} connection`;
}

export function getServiceGuidance(service: GuidedService, form: SettingsFormData, plexAuthenticated: boolean): string[] {
    switch (service) {
        case 'mediaServer':
            if (form.media_server_type === 'plex') return plexAuthenticated
                ? ['Plex sign-in uses the authenticated server and stored credentials. Manual fields are optional fallback settings.']
                : ['Sign in with Plex, or provide both a server URL and Plex token for manual setup.'];
            return [`${form.media_server_type === 'jellyfin' ? 'Jellyfin' : 'Emby'} requires a server URL and API key.`];
        case 'sonarr': return ['Connection testing requires a URL and API key. Adding series also requires a quality profile and root folder.'];
        case 'radarr': return ['Connection testing requires a URL and API key. Adding movies also requires a quality profile and root folder.'];
        case 'tmdb': return ['A custom TMDb API key is optional while the built-in key is available; a custom value overrides it.'];
        case 'ai': return form.ai_enabled === 'true' ? ['Provider URL, model, and API key are required while AI recommendations are enabled.'] : ['AI configuration is optional while AI recommendations are disabled.'];
        case 'discord': return form.discord_enabled === 'true' ? ['A webhook URL is required while Discord notifications are enabled.'] : ['Discord credentials are optional while notifications are disabled.'];
        case 'telegram': return form.telegram_enabled === 'true' ? ['A bot token and chat ID are required while Telegram notifications are enabled.'] : ['Telegram credentials are optional while notifications are disabled.'];
        case 'scheduler': return form.scheduler_enabled === 'true' ? ['A valid cron schedule is required while automatic runs are enabled.'] : ['No schedule is required while automatic runs are disabled.'];
    }
}
