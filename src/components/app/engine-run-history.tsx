'use client';

import type { EngineRun } from '@/lib/engine-observability-types';
import { formatElapsed } from './engine-observability-model';
import { formatDateTime } from './utils';

export function EngineRunHistory({ runs }: { runs: EngineRun[] }) {
    return <section className="settings-card"><div className="section-heading"><div><p className="section-kicker">Run history</p><h3>Last ten runs</h3></div></div>
        <div className="engine-run-history">{runs.length ? runs.map(run => <details key={run.id} id={`run-${run.id}`}>
            <summary><span className={`run-status status-${run.status}`}>{run.status}</span><strong>{formatDateTime(run.startedAt)}</strong>
                <span>{run.trigger} · {run.durationMs === undefined ? 'Running' : formatElapsed(run.durationMs)} · {run.summary.recommendationsSaved} saved</span></summary>
            <p className="run-id">Run ID: <code>{run.id}</code> · Engine {run.engineVersion}</p>
            {run.errorMessage && <p className="engine-error-copy">{run.errorMessage}</p>}
            <p>{run.summary.watchedItemsProcessed} watched · {run.summary.candidatesConsidered} candidates · {run.summary.recommendationsSaved} saved · {run.summary.errorCount} errors</p>
            <ul className="engine-stage-list engine-stage-history">{run.stages.map(stage => {
                const messages = [...(stage.skipReason ? [stage.skipReason] : []), ...stage.failures];
                const label = stage.name.replaceAll('_', ' ');
                return <li key={stage.name}>
                    <div className="engine-stage-heading">
                        <span className="engine-stage-name">{label}</span>
                        <span className="engine-stage-state">{stage.status}{stage.durationMs !== undefined ? ` · ${formatElapsed(stage.durationMs)}` : ''}</span>
                    </div>
                    {messages.length > 0 && <ul className="engine-stage-messages" aria-label={`${label} details`}>
                        {messages.map((message, index) => <li key={`${index}-${message}`}>{message}</li>)}
                    </ul>}
                </li>;
            })}</ul>
        </details>) : <p className="helper-copy">Run history will appear after the engine runs.</p>}</div>
    </section>;
}
