import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import {
    buildCopiedDiagnostics,
    diagnosticsReducer,
    downloadDatabaseBackup,
    formatBytes,
    parseAttachmentFilename,
    parseDiagnosticsResponse,
    restoreActionFocus,
    type CopyDiagnosticsInput,
    type DiagnosticsResponse,
    type SanitizedDiagnosticReport,
} from '../src/components/app/settings-diagnostics-model';

const responseFixture = {
    runtime: { appVersion: '3.0.1', gitCommit: 'abcdef1', nodeVersion: 'v24', platform: 'win32' },
    database: {
        reachable: true,
        sizeBytes: 13_000_000,
        journalMode: 'wal',
        resolvedPath: 'C:\\private\\data\\recomendarr.db',
        sanitizedPath: 'C:\\...\\recomendarr.db',
        appliedMigrations: ['migration_z', 'migration_a'],
    },
    services: [],
    scheduler: { enabled: true, active: true, nextRun: null },
    recentErrors: [],
    report: 'Database path: C:\\...\\recomendarr.db',
};

describe('settings diagnostics model', () => {
    it('moves diagnostics, clipboard, and backup operations through explicit states', () => {
        let state = diagnosticsReducer(undefined, { type: 'diagnostics_loading' });
        expect(state.diagnostics).toEqual({ status: 'loading' });
        state = diagnosticsReducer(state, { type: 'diagnostics_ready', value: parseDiagnosticsResponse(responseFixture) });
        expect(state.diagnostics.status).toBe('ready');
        state = diagnosticsReducer(state, { type: 'diagnostics_error', message: 'Unavailable' });
        expect(state.diagnostics).toEqual({ status: 'error', message: 'Unavailable' });

        state = diagnosticsReducer(state, { type: 'copy_started' });
        expect(state.copy.status).toBe('copying');
        state = diagnosticsReducer(state, { type: 'copy_succeeded' });
        expect(state.copy.status).toBe('copied');
        state = diagnosticsReducer(state, { type: 'copy_reset' });
        expect(state.copy.status).toBe('idle');
        state = diagnosticsReducer(state, { type: 'copy_failed', message: 'Clipboard unavailable' });
        expect(state.copy).toEqual({ status: 'error', message: 'Clipboard unavailable' });

        state = diagnosticsReducer(state, { type: 'backup_started' });
        expect(state.backup.status).toBe('preparing');
        state = diagnosticsReducer(state, { type: 'backup_succeeded', filename: 'recomendarr-backup.db' });
        expect(state.backup).toEqual({ status: 'downloaded', filename: 'recomendarr-backup.db' });
        state = diagnosticsReducer(state, { type: 'backup_reset' });
        expect(state.backup.status).toBe('idle');
        state = diagnosticsReducer(state, { type: 'backup_failed', message: 'Backup failed' });
        expect(state.backup).toEqual({ status: 'error', message: 'Backup failed' });
    });

    it('validates diagnostics responses and sorts migration names', () => {
        const parsed = parseDiagnosticsResponse(responseFixture);
        expect(parsed.database.appliedMigrations).toEqual(['migration_a', 'migration_z']);
        expect(parsed.report).toBe('Database path: C:\\...\\recomendarr.db');
        expect(() => parseDiagnosticsResponse({ ...responseFixture, report: 42 })).toThrow('Invalid diagnostics response');
    });

    it('copies only the branded report plus normalized public connection states', () => {
        const parsed = parseDiagnosticsResponse(responseFixture);
        const unsafe = {
            report: parsed.report,
            connectionStates: [{ name: 'Plex', state: 'Connected' }],
            resolvedPath: 'C:\\private\\data\\recomendarr.db',
        } as unknown as CopyDiagnosticsInput;
        const copied = buildCopiedDiagnostics(unsafe);
        expect(copied).toContain('Plex: connected');
        expect(copied).toContain('C:\\...\\recomendarr.db');
        expect(copied).not.toContain('C:\\private');
    });

    it('enforces branded copied-report inputs at compile time', () => {
        const fullResponse = parseDiagnosticsResponse(responseFixture);
        if (false) {
            // @ts-expect-error A full response must never be accepted by the copy formatter.
            buildCopiedDiagnostics(fullResponse);
            // @ts-expect-error An unvalidated string is not a sanitized diagnostic report.
            buildCopiedDiagnostics({ report: 'plain string', connectionStates: [] });
        }
        expectTypeOf<SanitizedDiagnosticReport>().toBeString();
    });

    it('formats byte sizes and accepts only a safe attachment basename', () => {
        expect(formatBytes(null)).toBe('Unknown');
        expect(formatBytes(13_000_000)).toBe('12.4 MB');
        expect(parseAttachmentFilename('attachment; filename="recomendarr-backup-2026-09-27_01-02-03.db"')).toBe('recomendarr-backup-2026-09-27_01-02-03.db');
        expect(parseAttachmentFilename('attachment; filename="..\\private\\stolen.db"')).toMatch(/^recomendarr-backup-/);
        expect(parseAttachmentFilename(null)).toMatch(/^recomendarr-backup-.*\.db$/);
    });

    it('revokes object URLs after triggering a backup download', async () => {
        const click = vi.fn();
        const revokeObjectUrl = vi.fn();
        const result = await downloadDatabaseBackup({
            fetchBackup: vi.fn().mockResolvedValue(new Response(new Blob(['sqlite']), {
                headers: { 'Content-Disposition': 'attachment; filename="recomendarr-backup-2026-09-27_01-02-03.db"' },
            })),
            createObjectUrl: vi.fn().mockReturnValue('blob:backup'),
            revokeObjectUrl,
            triggerDownload: vi.fn(() => click()),
            now: () => new Date('2026-09-27T01:02:03Z'),
        });
        expect(result.filename).toBe('recomendarr-backup-2026-09-27_01-02-03.db');
        expect(click).toHaveBeenCalledOnce();
        expect(revokeObjectUrl).toHaveBeenCalledWith('blob:backup');
    });

    it('still revokes the object URL if triggering the download fails', async () => {
        const revokeObjectUrl = vi.fn();
        await expect(downloadDatabaseBackup({
            fetchBackup: vi.fn().mockResolvedValue(new Response(new Blob(['sqlite']))),
            createObjectUrl: vi.fn().mockReturnValue('blob:backup'),
            revokeObjectUrl,
            triggerDownload: vi.fn(() => { throw new Error('blocked'); }),
        })).rejects.toThrow('blocked');
        expect(revokeObjectUrl).toHaveBeenCalledWith('blob:backup');
    });

    it('restores focus to the action that started an async operation', () => {
        const focus = vi.fn();
        restoreActionFocus({ focus });
        expect(focus).toHaveBeenCalledOnce();
    });
});

expectTypeOf<DiagnosticsResponse>().toBeObject();
