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
            <ul className="engine-stage-list">{run.stages.map(stage => <li key={stage.name}><div><span>{stage.name.replaceAll('_', ' ')}</span>
                {stage.skipReason && <small>{stage.skipReason}</small>}{stage.failures.map(failure => <small key={failure}>{failure}</small>)}</div>
                <span>{stage.status}{stage.durationMs !== undefined ? ` · ${formatElapsed(stage.durationMs)}` : ''}</span></li>)}</ul>
        </details>) : <p className="helper-copy">Run history will appear after the engine runs.</p>}</div>
    </section>;
}
