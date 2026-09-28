import { NextResponse } from 'next/server';
import { getEngineRun, getRecentEngineRuns } from '@/lib/engine-runs';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
    const url = new URL(request.url);
    const id = url.searchParams.get('id');
    if (id !== null) {
        if (!id.trim()) return NextResponse.json({ error: 'A non-empty run id is required' }, { status: 400 });
        const run = getEngineRun(id);
        return run ? NextResponse.json({ run }, { headers: { 'Cache-Control': 'no-store' } })
            : NextResponse.json({ error: 'Run not found' }, { status: 404 });
    }

    const rawLimit = url.searchParams.get('limit');
    const limit = rawLimit === null ? 10 : Number(rawLimit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 10) {
        return NextResponse.json({ error: 'limit must be an integer between 1 and 10' }, { status: 400 });
    }
    return NextResponse.json({ runs: getRecentEngineRuns(limit) }, { headers: { 'Cache-Control': 'no-store' } });
}
