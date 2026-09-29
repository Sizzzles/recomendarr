import { describe, expect, it } from 'vitest';
import { logsLocationForRun, parseObservabilityLocation } from '../src/components/app/observability-navigation';

describe('observability navigation', () => {
    it('builds and parses a stable Logs run-history deep link', () => {
        const location = logsLocationForRun('run id/unsafe');
        expect(location).toBe('/?page=logs&view=runs&run=run%20id%2Funsafe#run-run%20id%2Funsafe');
        expect(parseObservabilityLocation(`http://localhost${location}`)).toEqual({ page: 'logs', view: 'runs', runId: 'run id/unsafe' });
    });

    it('falls back safely for missing or malformed run targets', () => {
        expect(parseObservabilityLocation('http://localhost/?page=logs&view=runs')).toEqual({ page: 'logs', view: 'runs', runId: null });
        expect(parseObservabilityLocation('http://localhost/')).toEqual({ page: 'dashboard', view: 'events', runId: null });
    });
});
