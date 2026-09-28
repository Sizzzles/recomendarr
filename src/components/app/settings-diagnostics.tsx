'use client';

import { useCallback, useEffect, useReducer, useRef } from 'react';
import {
    buildCopiedDiagnostics,
    diagnosticsReducer,
    downloadDatabaseBackup,
    formatBytes,
    INITIAL_SETTINGS_DIAGNOSTICS_STATE,
    parseDiagnosticsResponse,
    restoreActionFocus,
    type PublicConnectionState,
} from './settings-diagnostics-model';

interface SettingsDiagnosticsProps {
    connectionStates: PublicConnectionState[];
}

export function SettingsDiagnostics({ connectionStates }: SettingsDiagnosticsProps) {
    const [state, dispatch] = useReducer(diagnosticsReducer, INITIAL_SETTINGS_DIAGNOSTICS_STATE);
    const resetTimers = useRef<number[]>([]);
    const backupButtonRef = useRef<HTMLButtonElement>(null);

    const resetAfter = useCallback((action: Parameters<typeof diagnosticsReducer>[1]) => {
        const timer = window.setTimeout(() => dispatch(action), 4000);
        resetTimers.current.push(timer);
    }, []);

    useEffect(() => () => resetTimers.current.forEach(window.clearTimeout), []);

    const loadDiagnostics = useCallback(async () => {
        dispatch({ type: 'diagnostics_loading' });
        try {
            const response = await fetch('/api/diagnostics', { cache: 'no-store' });
            if (!response.ok) throw new Error('Unable to load diagnostics');
            dispatch({ type: 'diagnostics_ready', value: parseDiagnosticsResponse(await response.json()) });
        } catch {
            dispatch({ type: 'diagnostics_error', message: 'Diagnostics could not be loaded. Try again.' });
        }
    }, []);

    useEffect(() => { void loadDiagnostics(); }, [loadDiagnostics]);

    const copyDiagnostics = async () => {
        if (state.diagnostics.status !== 'ready') return;
        dispatch({ type: 'copy_started' });
        try {
            await navigator.clipboard.writeText(buildCopiedDiagnostics({
                report: state.diagnostics.value.report,
                connectionStates,
            }));
            dispatch({ type: 'copy_succeeded' });
            resetAfter({ type: 'copy_reset' });
        } catch {
            dispatch({ type: 'copy_failed', message: 'Could not copy diagnostics. Check clipboard permissions.' });
        }
    };

    const downloadBackup = async () => {
        const actionButton = backupButtonRef.current;
        dispatch({ type: 'backup_started' });
        try {
            const result = await downloadDatabaseBackup({
                fetchBackup: () => fetch('/api/database-backup', { method: 'POST' }),
                createObjectUrl: (blob) => URL.createObjectURL(blob),
                revokeObjectUrl: (url) => URL.revokeObjectURL(url),
                triggerDownload: (url, filename) => {
                    const anchor = document.createElement('a');
                    anchor.href = url;
                    anchor.download = filename;
                    anchor.style.display = 'none';
                    document.body.appendChild(anchor);
                    anchor.click();
                    anchor.remove();
                },
            });
            dispatch({ type: 'backup_download_started', filename: result.filename });
            resetAfter({ type: 'backup_reset' });
        } catch {
            dispatch({ type: 'backup_failed', message: 'Database backup could not be downloaded. Try again.' });
        } finally {
            window.requestAnimationFrame(() => restoreActionFocus(actionButton));
        }
    };

    const diagnostics = state.diagnostics.status === 'ready' ? state.diagnostics.value : null;

    return (
        <section className="settings-card diagnostics-card">
            <div className="section-heading">
                <div>
                    <p className="section-kicker">Support and recovery</p>
                    <h3>Diagnostics and database</h3>
                </div>
                <button className="btn btn-ghost btn-sm" type="button" onClick={() => void loadDiagnostics()} disabled={state.diagnostics.status === 'loading'}>
                    {state.diagnostics.status === 'loading' ? 'Refreshing...' : 'Refresh'}
                </button>
            </div>

            {state.diagnostics.status === 'error' && <p className="diagnostics-status error" role="alert">{state.diagnostics.message}</p>}
            {state.diagnostics.status === 'loading' && <p className="diagnostics-status" role="status">Collecting local diagnostics...</p>}

            {diagnostics && (
                <>
                    <div className="settings-grid three diagnostics-summary">
                        <div className="settings-metric-card"><span>App version</span><strong>{diagnostics.runtime.appVersion}</strong></div>
                        <div className="settings-metric-card"><span>Git commit</span><strong>{diagnostics.runtime.gitCommit}</strong></div>
                        <div className="settings-metric-card"><span>Database</span><strong>{diagnostics.database.reachable ? 'Reachable' : 'Unavailable'}</strong></div>
                        <div className="settings-metric-card"><span>Database size</span><strong>{formatBytes(diagnostics.database.sizeBytes)}</strong></div>
                        <div className="settings-metric-card"><span>Journal mode</span><strong>{diagnostics.database.journalMode?.toUpperCase() || 'Unknown'}</strong></div>
                        <div className="settings-metric-card"><span>Applied migrations</span><strong>{diagnostics.database.appliedMigrations.length}</strong></div>
                    </div>

                    <div className="diagnostics-path">
                        <span>Resolved database path</span>
                        <code>{diagnostics.database.resolvedPath}</code>
                        <small>The copied report uses only {diagnostics.database.sanitizedPath}.</small>
                    </div>

                    <details className="migration-details">
                        <summary>Applied migration keys ({diagnostics.database.appliedMigrations.length})</summary>
                        {diagnostics.database.appliedMigrations.length ? (
                            <ul>{diagnostics.database.appliedMigrations.map((migration) => <li key={migration}><code>{migration}</code></li>)}</ul>
                        ) : <p className="helper-copy">No recorded migrations.</p>}
                    </details>

                    <div className="diagnostics-actions">
                        <div>
                            <button className="btn btn-ghost" type="button" onClick={() => void copyDiagnostics()} disabled={state.copy.status === 'copying'}>
                                {state.copy.status === 'copying' ? 'Copying...' : 'Copy diagnostics'}
                            </button>
                            {state.copy.status === 'copied' && <span className="diagnostics-status success" role="status">Copied sanitized diagnostics.</span>}
                            {state.copy.status === 'error' && <span className="diagnostics-status error" role="alert">{state.copy.message}</span>}
                        </div>
                        <div>
                            <button ref={backupButtonRef} className="btn btn-ghost" type="button" onClick={() => void downloadBackup()} disabled={state.backup.status === 'preparing'}>
                                {state.backup.status === 'preparing' ? 'Preparing backup...' : 'Download database backup'}
                            </button>
                            {state.backup.status === 'download-started' && <span className="diagnostics-status success" role="status">Download started for {state.backup.filename}.</span>}
                            {state.backup.status === 'error' && <span className="diagnostics-status error" role="alert">{state.backup.message}</span>}
                        </div>
                    </div>
                </>
            )}
        </section>
    );
}
