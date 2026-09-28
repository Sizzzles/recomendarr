import { describe, expect, it, vi } from 'vitest';
import { ServiceAttemptAccumulator, changedHealthServices } from '../src/lib/service-health-observer';

describe('ServiceAttemptAccumulator', () => {
    it.each([
        [2, 0, 'healthy'], [1, 1, 'degraded'], [0, 2, 'failed'],
    ] as const)('aggregates %i successes and %i failures as %s', (successes, failures, expected) => {
        const writer = vi.fn();
        const observer = new ServiceAttemptAccumulator('tmdb', 'engine', writer, () => '2026-09-29T00:00:00.000Z');
        for (let count = 0; count < successes; count++) observer.recordSuccess('Last query succeeded');
        for (let count = 0; count < failures; count++) observer.recordFailure(`Request ${count} failed token=secret`);
        observer.flush();
        expect(writer).toHaveBeenCalledOnce();
        expect(writer.mock.calls[0][0]).toMatchObject({ service: 'tmdb', state: expected, checkedAt: '2026-09-29T00:00:00.000Z' });
        expect(JSON.stringify(writer.mock.calls[0][0])).not.toContain('secret');
    });

    it('does not write when nothing applicable was attempted', () => {
        const writer = vi.fn();
        new ServiceAttemptAccumulator('ai', 'engine', writer).flush();
        expect(writer).not.toHaveBeenCalled();
    });
});

describe('changedHealthServices', () => {
    it('invalidates only services whose relevant persisted values changed', () => {
        const before = { media_server_url: 'http://plex', media_server_api_key: 'abc', sonarr_url: 'http://sonarr', ai_enabled: 'false' };
        const after = { ...before, sonarr_url: 'http://new-sonarr', ai_enabled: 'true' };
        expect(changedHealthServices(before, after)).toEqual(['ai', 'sonarr']);
    });

    it('covers Plex identity and TMDb key without reacting to unrelated settings', () => {
        expect(changedHealthServices({ plex_server_identifier: 'one', tmdb_api_key: 'a', cron_schedule: 'old' },
            { plex_server_identifier: 'two', tmdb_api_key: 'b', cron_schedule: 'new' }))
            .toEqual(['media_server', 'tmdb']);
    });
});
