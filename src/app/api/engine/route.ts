import { NextResponse } from 'next/server';
import { runRecommendationEngine, getIsRunning } from '@/lib/engine';
import type { EngineFilters } from '@/lib/engine';
import { getActiveEngineRun } from '@/lib/engine-runs';

export async function POST(request: Request) {
    try {
        const activeRun = getActiveEngineRun();
        if (getIsRunning() || activeRun) {
            return NextResponse.json({ error: 'Engine is already running', activeRun }, { status: 409 });
        }

        // Parse optional filters from request body
        let filters: EngineFilters | undefined;
        try {
            const body = await request.json();
            if (body.filters) {
                filters = body.filters;
            }
        } catch {
            // No body or invalid JSON — run without filters
        }

        const result = await runRecommendationEngine(filters);
        return NextResponse.json(result);
    } catch (err) {
        const activeRun = getActiveEngineRun();
        if ((err as Error).message.includes('already running') && activeRun) {
            return NextResponse.json({ error: 'Engine is already running', activeRun }, { status: 409 });
        }
        return NextResponse.json({ error: (err as Error).message }, { status: 500 });
    }
}

export async function GET() {
    const activeRun = getActiveEngineRun();
    return NextResponse.json({ running: Boolean(activeRun || getIsRunning()), activeRun });
}
