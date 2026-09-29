'use client';

import type { EngineRun } from '@/lib/engine-observability-types';
import type { LogEntry } from '@/lib/types';
import { EngineRunHistory } from './engine-run-history';
import type { LogsView } from './observability-navigation';

export function LogsPage({ logs, runs, view, requestedRunId, logFilter, setLogFilter, onViewChange, onRefresh, onClear }: {
    logs: LogEntry[]; runs: EngineRun[]; view: LogsView; requestedRunId: string | null; logFilter: string;
    setLogFilter: (value: string) => void; onViewChange: (view: LogsView) => void; onRefresh: () => void; onClear: () => void;
}) {
    return <div className="page-stack">
        <div className="page-header refined"><div><p className="page-kicker">Observability</p><h2>Logs</h2><p>Inspect event logs and durable engine-run history.</p></div>
            {view === 'events' && <div className="page-actions"><button className="btn btn-ghost" onClick={onRefresh}>Refresh events</button><button className="btn btn-danger" onClick={onClear}>Clear logs</button></div>}
        </div>
        <div className="filter-tabs wide" role="tablist" aria-label="Logs views">
            <button role="tab" aria-selected={view === 'events'} className={`filter-tab ${view === 'events' ? 'active' : ''}`} onClick={() => onViewChange('events')}>Events</button>
            <button role="tab" aria-selected={view === 'runs'} className={`filter-tab ${view === 'runs' ? 'active' : ''}`} onClick={() => onViewChange('runs')}>Run History</button>
        </div>
        {view === 'runs' ? <EngineRunHistory runs={runs} requestedRunId={requestedRunId} /> : <>
            <div className="filter-tabs wide" aria-label="Event level">{['all', 'INFO', 'WARN', 'ERROR', 'DEBUG'].map(level =>
                <button key={level} className={`filter-tab ${logFilter === level ? 'active' : ''}`} onClick={() => setLogFilter(level)}>{level}</button>)}</div>
            {logs.length === 0 ? <div className="empty-state refined"><div className="empty-icon">Logs</div><h3>No log entries yet</h3><p>Run the engine or test a connection to populate the activity stream.</p></div>
                : <div className="log-entries refined">{logs.map(log => <div key={log.id} className="log-entry"><span className={`log-level ${log.level}`}>{log.level}</span>
                    <span className="log-time">{new Date(log.timestamp).toLocaleString()}</span><span className="log-source">[{log.source}]</span><span className="log-message">{log.message}</span></div>)}</div>}
        </>}
    </div>;
}
