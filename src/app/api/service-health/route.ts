import { NextResponse } from 'next/server';
import { getConfig } from '@/lib/config';
import { getEffectiveServiceHealth } from '@/lib/service-health';

export const dynamic = 'force-dynamic';

export async function GET() {
    const config = getConfig();
    const services = getEffectiveServiceHealth({
        configured: {
            media_server: Boolean(config.mediaServer.url && (config.mediaServer.apiKey || config.mediaServer.plexToken)),
            tmdb: Boolean(config.tmdb.apiKey),
            ai: Boolean(config.ai.providerUrl && config.ai.model),
            sonarr: Boolean(config.sonarr.url && config.sonarr.apiKey),
            radarr: Boolean(config.radarr.url && config.radarr.apiKey),
        },
        disabled: { ai: !config.ai.enabled },
    });
    return NextResponse.json({ services }, { headers: { 'Cache-Control': 'no-store' } });
}
