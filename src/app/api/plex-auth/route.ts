import { NextResponse } from 'next/server';
import {
    disconnectPlex,
    getPlexConnectionState,
    PlexAuthError,
    pollPlexSignIn,
    selectPlexServer,
    startPlexSignIn,
} from '@/lib/plex-auth';

export async function GET() {
    return NextResponse.json(getPlexConnectionState());
}

function requiredString(value: unknown): string | null {
    return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export async function POST(request: Request) {
    try {
        const body = await request.json() as Record<string, unknown>;
        switch (body.action) {
            case 'start':
                return NextResponse.json(await startPlexSignIn());
            case 'poll': {
                const flowId = requiredString(body.flowId);
                if (!flowId) return NextResponse.json({ error: 'flowId is required' }, { status: 400 });
                return NextResponse.json(await pollPlexSignIn(flowId));
            }
            case 'select': {
                const flowId = requiredString(body.flowId);
                const serverId = requiredString(body.serverId);
                if (!flowId || !serverId) {
                    return NextResponse.json({ error: 'flowId and serverId are required' }, { status: 400 });
                }
                return NextResponse.json(await selectPlexServer(flowId, serverId));
            }
            case 'disconnect':
                return NextResponse.json(await disconnectPlex());
            default:
                return NextResponse.json({ error: 'Unknown Plex auth action' }, { status: 400 });
        }
    } catch (error) {
        if (error instanceof PlexAuthError) {
            return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
        }
        return NextResponse.json({ error: 'Plex sign-in could not be completed.' }, { status: 502 });
    }
}
