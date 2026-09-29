import { NextResponse } from 'next/server';
import { runPersistedServiceHealthCheck } from '@/lib/service-health-check';

export const dynamic = 'force-dynamic';

export async function POST() {
    const result = await runPersistedServiceHealthCheck();
    return NextResponse.json(result, { headers: { 'Cache-Control': 'no-store' } });
}
