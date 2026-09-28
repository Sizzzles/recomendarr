import { NextResponse } from 'next/server';
import { createDatabaseBackup } from '@/lib/database-backup';

export const runtime = 'nodejs';

export async function POST() {
    try {
        const backup = await createDatabaseBackup();
        return new Response(new Uint8Array(backup.bytes), {
            headers: {
                'Content-Type': 'application/vnd.sqlite3',
                'Content-Disposition': `attachment; filename="${backup.filename}"`,
                'Cache-Control': 'no-store',
            },
        });
    } catch {
        console.error('Database backup failed');
        return NextResponse.json({ error: 'Unable to create database backup' }, {
            status: 500,
            headers: { 'Cache-Control': 'no-store' },
        });
    }
}
