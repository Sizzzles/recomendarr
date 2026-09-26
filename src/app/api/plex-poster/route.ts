import axios from 'axios';
import { NextRequest, NextResponse } from 'next/server';
import { getConfig } from '@/lib/config';

function validPlexPath(path: string | null): path is string {
    return Boolean(path && path.startsWith('/') && !path.startsWith('//') && !path.includes('..') && !path.includes('\\'));
}

export async function GET(request: NextRequest) {
    const path = request.nextUrl.searchParams.get('path');
    if (!validPlexPath(path)) {
        return NextResponse.json({ error: 'Invalid Plex poster path' }, { status: 400 });
    }
    const config = getConfig().mediaServer;
    const token = config.apiKey || config.plexToken;
    if (config.type !== 'plex' || !config.url || !token) {
        return NextResponse.json({ error: 'Plex is not connected' }, { status: 404 });
    }
    try {
        const response = await axios.get(`${config.url.replace(/\/$/, '')}${path}`, {
            headers: { 'X-Plex-Token': token, Accept: 'image/*' },
            responseType: 'arraybuffer',
            timeout: 10000,
        });
        return new NextResponse(response.data, {
            headers: {
                'Content-Type': response.headers['content-type'] || 'image/jpeg',
                'Cache-Control': 'private, no-store',
            },
        });
    } catch {
        return NextResponse.json({ error: 'Plex poster unavailable' }, { status: 502 });
    }
}
