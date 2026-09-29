import type { Page } from './models';

export type LogsView = 'events' | 'runs';

export function logsLocationForRun(runId: string): string {
    const encoded = encodeURIComponent(runId);
    return `/?page=logs&view=runs&run=${encoded}#run-${encoded}`;
}

export function parseObservabilityLocation(value: string): { page: Page; view: LogsView; runId: string | null } {
    const url = new URL(value);
    if (url.searchParams.get('page') !== 'logs') return { page: 'dashboard', view: 'events', runId: null };
    return {
        page: 'logs',
        view: url.searchParams.get('view') === 'runs' ? 'runs' : 'events',
        runId: url.searchParams.get('run'),
    };
}
