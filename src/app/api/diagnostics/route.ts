import { NextResponse } from 'next/server';
import { getAllSavedSettings, getConfig } from '@/lib/config';
import {
    buildDiagnosticReport,
    getDatabaseDiagnostics,
    getRecentDiagnosticErrors,
    getRuntimeMetadata,
    redactDiagnosticText,
    type DiagnosticServiceSummary,
} from '@/lib/diagnostics';
import { getSchedulerSnapshot } from '@/lib/scheduler';

export const runtime = 'nodejs';

export async function GET() {
    try {
        const runtimeMetadata = getRuntimeMetadata();
        const database = getDatabaseDiagnostics();
        const recentErrors = getRecentDiagnosticErrors();
        const config = getConfig();
        const savedSettings = getAllSavedSettings();
        const scheduler = getSchedulerSnapshot();

        const services: DiagnosticServiceSummary[] = [
            {
                name: config.mediaServer.type === 'plex' ? 'Plex' : config.mediaServer.type === 'jellyfin' ? 'Jellyfin' : 'Emby',
                configured: config.mediaServer.type === 'plex'
                    ? Boolean(savedSettings.plex_server_identifier || (config.mediaServer.url && config.mediaServer.apiKey))
                    : Boolean(config.mediaServer.url && config.mediaServer.apiKey),
                latestState: 'not_tested',
            },
            { name: 'Sonarr', configured: Boolean(config.sonarr.url && config.sonarr.apiKey), latestState: 'not_tested' },
            { name: 'Radarr', configured: Boolean(config.radarr.url && config.radarr.apiKey), latestState: 'not_tested' },
            { name: 'TMDb', configured: Boolean(config.tmdb.apiKey), latestState: 'not_tested' },
            {
                name: 'AI',
                configured: Boolean(config.ai.enabled && config.ai.providerUrl && config.ai.apiKey && config.ai.model),
                latestState: 'not_tested',
            },
            {
                name: 'Discord',
                configured: Boolean(config.notifications.discordEnabled && config.notifications.discordWebhookUrl),
                latestState: 'not_tested',
            },
            {
                name: 'Telegram',
                configured: Boolean(config.notifications.telegramEnabled && config.notifications.telegramBotToken && config.notifications.telegramChatId),
                latestState: 'not_tested',
            },
        ];

        const reportDatabase = {
            reachable: database.reachable,
            sizeBytes: database.sizeBytes,
            journalMode: database.journalMode,
            sanitizedPath: database.sanitizedPath,
            appliedMigrations: database.appliedMigrations,
        };
        const report = buildDiagnosticReport({
            runtime: runtimeMetadata,
            database: reportDatabase,
            services,
            scheduler: { enabled: config.scheduler.enabled, active: scheduler.active },
            recentErrors,
        });

        return NextResponse.json({
            runtime: runtimeMetadata,
            database,
            services,
            scheduler: { enabled: config.scheduler.enabled, active: scheduler.active, nextRun: scheduler.nextRun },
            recentErrors,
            report,
        }, { headers: { 'Cache-Control': 'no-store' } });
    } catch (error) {
        console.error(`Diagnostics collection failed: ${redactDiagnosticText((error as Error).message)}`);
        return NextResponse.json({ error: 'Unable to collect diagnostics' }, {
            status: 500,
            headers: { 'Cache-Control': 'no-store' },
        });
    }
}
