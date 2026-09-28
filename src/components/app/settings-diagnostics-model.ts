export type SanitizedDiagnosticReport = string & { readonly __sanitizedDiagnosticReport: unique symbol };

export interface DiagnosticsResponse {
    runtime: {
        appVersion: string;
        gitCommit: string;
        nodeVersion: string;
        platform: string;
    };
    database: {
        reachable: boolean;
        sizeBytes: number | null;
        journalMode: string | null;
        resolvedPath: string;
        sanitizedPath: string;
        appliedMigrations: string[];
    };
    services: Array<{ name: string; configured: boolean; latestState: string }>;
    scheduler: { enabled: boolean; active: boolean; nextRun: string | null };
    recentErrors: Array<{ timestamp: string; source: string; message: string }>;
    report: SanitizedDiagnosticReport;
}

export interface PublicConnectionState {
    name: string;
    state: string;
}

export interface CopyDiagnosticsInput {
    report: SanitizedDiagnosticReport;
    connectionStates: PublicConnectionState[];
}

export function restoreActionFocus(target: Pick<HTMLElement, 'focus'> | null): void {
    target?.focus();
}

type OperationState<T = never> =
    | { status: 'idle' }
    | { status: 'loading' | 'copying' | 'preparing' }
    | { status: 'error'; message: string }
    | ({ status: 'ready' } & T)
    | { status: 'copied' }
    | { status: 'download-started'; filename: string };

export interface SettingsDiagnosticsState {
    diagnostics: OperationState<{ value: DiagnosticsResponse }>;
    copy: OperationState;
    backup: OperationState;
}

export type SettingsDiagnosticsAction =
    | { type: 'diagnostics_loading' }
    | { type: 'diagnostics_ready'; value: DiagnosticsResponse }
    | { type: 'diagnostics_error'; message: string }
    | { type: 'copy_started' }
    | { type: 'copy_succeeded' }
    | { type: 'copy_failed'; message: string }
    | { type: 'copy_reset' }
    | { type: 'backup_started' }
    | { type: 'backup_download_started'; filename: string }
    | { type: 'backup_failed'; message: string }
    | { type: 'backup_reset' };

export const INITIAL_SETTINGS_DIAGNOSTICS_STATE: SettingsDiagnosticsState = {
    diagnostics: { status: 'idle' },
    copy: { status: 'idle' },
    backup: { status: 'idle' },
};

export function diagnosticsReducer(
    state: SettingsDiagnosticsState = INITIAL_SETTINGS_DIAGNOSTICS_STATE,
    action: SettingsDiagnosticsAction
): SettingsDiagnosticsState {
    switch (action.type) {
        case 'diagnostics_loading': return { ...state, diagnostics: { status: 'loading' } };
        case 'diagnostics_ready': return { ...state, diagnostics: { status: 'ready', value: action.value } };
        case 'diagnostics_error': return { ...state, diagnostics: { status: 'error', message: action.message } };
        case 'copy_started': return { ...state, copy: { status: 'copying' } };
        case 'copy_succeeded': return { ...state, copy: { status: 'copied' } };
        case 'copy_failed': return { ...state, copy: { status: 'error', message: action.message } };
        case 'copy_reset': return { ...state, copy: { status: 'idle' } };
        case 'backup_started': return { ...state, backup: { status: 'preparing' } };
        case 'backup_download_started': return { ...state, backup: { status: 'download-started', filename: action.filename } };
        case 'backup_failed': return { ...state, backup: { status: 'error', message: action.message } };
        case 'backup_reset': return { ...state, backup: { status: 'idle' } };
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

export function parseDiagnosticsResponse(value: unknown): DiagnosticsResponse {
    if (!isRecord(value) || !isRecord(value.runtime) || !isRecord(value.database) ||
        typeof value.report !== 'string' || !Array.isArray(value.services) ||
        !isRecord(value.scheduler) || !Array.isArray(value.recentErrors) ||
        !Array.isArray(value.database.appliedMigrations)) {
        throw new Error('Invalid diagnostics response');
    }

    const database = value.database as unknown as DiagnosticsResponse['database'];
    const parsed = value as unknown as DiagnosticsResponse;
    return {
        ...parsed,
        database: {
            ...database,
            appliedMigrations: [...database.appliedMigrations].sort((left, right) => left.localeCompare(right)),
        },
        report: value.report as SanitizedDiagnosticReport,
    };
}

export function buildCopiedDiagnostics(input: CopyDiagnosticsInput): string {
    const connectionLines = input.connectionStates.map(({ name, state }) =>
        `${String(name).trim()}: ${String(state).trim().toLowerCase()}`
    );
    return connectionLines.length
        ? `${input.report}\n\nLatest local connection-test states\n${connectionLines.join('\n')}`
        : input.report;
}

export function formatBytes(bytes: number | null): string {
    if (bytes === null) return 'Unknown';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function fallbackBackupFilename(now = new Date()): string {
    const timestamp = now.toISOString().replace('T', '_').replace(/:/g, '-').slice(0, 19);
    return `recomendarr-backup-${timestamp}.db`;
}

export function parseAttachmentFilename(header: string | null, now = new Date()): string {
    const match = header?.match(/filename\s*=\s*"?([^";]+)"?/i);
    const candidate = match?.[1]?.trim() || '';
    if (/^recomendarr-backup-\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}\.db$/.test(candidate)) return candidate;
    return fallbackBackupFilename(now);
}

interface BackupDownloadDependencies {
    fetchBackup: () => Promise<Response>;
    createObjectUrl: (blob: Blob) => string;
    revokeObjectUrl: (url: string) => void;
    scheduleUrlRevocation?: (revoke: () => void) => void;
    triggerDownload: (url: string, filename: string) => void;
    now?: () => Date;
}

export async function downloadDatabaseBackup(dependencies: BackupDownloadDependencies): Promise<{ filename: string }> {
    const response = await dependencies.fetchBackup();
    if (!response.ok) throw new Error('Unable to create database backup');
    const blob = await response.blob();
    const filename = parseAttachmentFilename(response.headers.get('content-disposition'), dependencies.now?.());
    const objectUrl = dependencies.createObjectUrl(blob);
    try {
        dependencies.triggerDownload(objectUrl, filename);
        const revoke = () => dependencies.revokeObjectUrl(objectUrl);
        if (dependencies.scheduleUrlRevocation) dependencies.scheduleUrlRevocation(revoke);
        else setTimeout(revoke, 1000);
        return { filename };
    } catch (error) {
        dependencies.revokeObjectUrl(objectUrl);
        throw error;
    }
}
