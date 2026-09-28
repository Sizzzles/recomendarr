'use client';

import { useEffect, useState } from 'react';
import type { EngineRun } from '@/lib/engine-observability-types';
import { formatElapsed } from './engine-observability-model';

const LABELS: Record<string, string> = {
    preparing: 'Preparing', syncing_watch_history: 'Syncing watch history', building_context: 'Building context',
    discovering_candidates: 'Discovering candidates', ai_recommendations: 'AI recommendations',
    processing_candidates: 'Processing candidates', auto_adding: 'Adding to library', finishing: 'Finishing',
};

export function EngineRunStatus({ run }: { run: EngineRun }) {
    const [now, setNow] = useState(() => Date.parse(run.startedAt));
    useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 1000); return () => window.clearInterval(timer); }, []);
    return <section className="settings-card engine-run-live" aria-live="polite">
        <div className="section-heading"><div><p className="section-kicker">Current run</p><h3>{LABELS[run.currentStage]}</h3></div>
            <strong>{formatElapsed(now - Date.parse(run.startedAt))}</strong></div>
        <p className="run-id">Run ID: <code>{run.id}</code></p>
        <ol className="engine-stage-list">{run.stages.map(stage => <li key={stage.name} className={`stage-${stage.status}`}>
            <span>{LABELS[stage.name]}</span><span>{stage.status}{stage.durationMs !== undefined ? ` · ${formatElapsed(stage.durationMs)}` : ''}</span>
        </li>)}</ol>
    </section>;
}
