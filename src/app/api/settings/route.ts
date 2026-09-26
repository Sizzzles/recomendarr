import { NextRequest, NextResponse } from 'next/server';
import { getAllSavedSettings, saveSettings, isSetupComplete, getConfig } from '@/lib/config';
import { getSchedulerSnapshot, syncRecommendationScheduler } from '@/lib/scheduler';
import cron from 'node-cron';

// GET /api/settings — returns current config and setup status
export async function GET() {
    try {
        const config = getConfig();
        const savedSettings = getAllSavedSettings();
        const setupComplete = isSetupComplete();
        const schedulerSnapshot = getSchedulerSnapshot();

        const mediaApiKeyMask = config.mediaServer.apiKey ? '••••' + config.mediaServer.apiKey.slice(-4) : '';
        const safeRaw = { ...savedSettings };
        if (safeRaw.media_server_api_key) safeRaw.media_server_api_key = mediaApiKeyMask;
        if (safeRaw.plex_token) safeRaw.plex_token = '••••' + safeRaw.plex_token.slice(-4);

        return NextResponse.json({
            setupComplete,
            config: {
                mediaServer: {
                    type: config.mediaServer.type,
                    url: config.mediaServer.url,
                    apiKey: mediaApiKeyMask,
                    hasApiKey: !!config.mediaServer.apiKey,
                },
                sonarr: {
                    url: config.sonarr.url,
                    apiKey: config.sonarr.apiKey ? '••••' + config.sonarr.apiKey.slice(-4) : '',
                    hasApiKey: !!config.sonarr.apiKey,
                },
                radarr: {
                    url: config.radarr.url,
                    apiKey: config.radarr.apiKey ? '••••' + config.radarr.apiKey.slice(-4) : '',
                    hasApiKey: !!config.radarr.apiKey,
                },
                ai: {
                    enabled: config.ai.enabled,
                    providerUrl: config.ai.providerUrl,
                    apiKey: config.ai.apiKey ? '••••' + config.ai.apiKey.slice(-4) : '',
                    hasApiKey: !!config.ai.apiKey,
                    model: config.ai.model,
                },
                scheduler: {
                    enabled: config.scheduler.enabled,
                    cronSchedule: config.scheduler.cronSchedule,
                    autoAdd: config.scheduler.autoAdd,
                    nextRun: schedulerSnapshot.nextRun,
                    active: schedulerSnapshot.active,
                },
                notifications: {
                    discordEnabled: config.notifications.discordEnabled,
                    hasDiscordWebhook: !!config.notifications.discordWebhookUrl,
                    telegramEnabled: config.notifications.telegramEnabled,
                    hasTelegramBotToken: !!config.notifications.telegramBotToken,
                    hasTelegramChatId: !!config.notifications.telegramChatId,
                    notifyOnRunComplete: config.notifications.notifyOnRunComplete,
                    notifyOnNewRecommendations: config.notifications.notifyOnNewRecommendations,
                    notifyOnErrors: config.notifications.notifyOnErrors,
                },
            },
            raw: safeRaw,
        });
    } catch (err) {
        return NextResponse.json({ error: (err as Error).message }, { status: 500 });
    }
}

// PUT /api/settings — save settings
export async function PUT(request: NextRequest) {
    try {
        const body = await request.json();
        const { settings } = body;

        if (!settings || typeof settings !== 'object') {
            return NextResponse.json({ error: 'settings object required' }, { status: 400 });
        }

        const normalized: Record<string, string> = {};
        for (const [key, value] of Object.entries(settings)) {
            if (value !== undefined && value !== null) {
                normalized[key] = String(value);
            }
        }

        const storedMediaKey = getConfig().mediaServer.apiKey;
        const storedMediaMask = storedMediaKey ? '••••' + storedMediaKey.slice(-4) : '';
        if (normalized.media_server_api_key?.startsWith('••••') ||
            normalized.media_server_api_key === storedMediaMask ||
            (normalized.media_server_type === 'plex' && normalized.media_server_api_key === '' && Boolean(storedMediaKey))) {
            delete normalized.media_server_api_key;
        }

        const schedulerEnabled = normalized.scheduler_enabled === 'true';
        if (schedulerEnabled && normalized.cron_schedule && !cron.validate(normalized.cron_schedule)) {
            return NextResponse.json({ error: 'Invalid cron schedule' }, { status: 400 });
        }

        saveSettings(normalized);
        syncRecommendationScheduler();

        return NextResponse.json({ success: true, saved: Object.keys(normalized).length });
    } catch (err) {
        return NextResponse.json({ error: (err as Error).message }, { status: 500 });
    }
}
