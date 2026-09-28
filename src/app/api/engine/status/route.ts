import { NextResponse } from 'next/server';
import { getActiveEngineRun, getLastSuccessfulEngineRun, getLatestCompletedEngineRun } from '@/lib/engine-runs';

export const dynamic = 'force-dynamic';

export async function GET() {
    const activeRun = getActiveEngineRun();
    return NextResponse.json({
        activeRun,
        latestRun: getLatestCompletedEngineRun(),
        lastSuccessfulRun: getLastSuccessfulEngineRun(),
        serverTime: new Date().toISOString(),
    }, { headers: { 'Cache-Control': 'no-store' } });
}
