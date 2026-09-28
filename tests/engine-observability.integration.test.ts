import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
    databasePath: '',
    getWatchHistory: vi.fn(), getRecommendations: vi.fn(), discover: vi.fn(),
    connections: [] as import('better-sqlite3').Database[],
}));

vi.mock('better-sqlite3', async (importOriginal) => {
    type Constructor = new (filename: string) => import('better-sqlite3').Database;
    const { default: Sqlite } = await importOriginal<{ default: Constructor }>();
    return { default: class extends Sqlite { constructor(filename: string) { super(filename); state.connections.push(this); } } };
});

vi.mock('../src/lib/config', () => ({
    config: { database: { get path() { return state.databasePath; } } },
    getConfig: () => ({
        database: { path: state.databasePath }, mediaServer: { type: 'plex', url: 'http://plex', apiKey: 'key', userId: '', plexToken: '' },
        sonarr: { url: '', apiKey: '', qualityProfileId: 1, rootFolder: '/tv' },
        radarr: { url: '', apiKey: '', qualityProfileId: 1, rootFolder: '/movies' },
        tmdb: { apiKey: 'builtin', baseUrl: 'https://tmdb' }, ai: { enabled: false, providerUrl: '', apiKey: '', model: '' },
        scheduler: { enabled: false, cronSchedule: '', autoAdd: false }, notifications: {},
        app: { maxRecommendationsPerRun: 10, watchHistoryLimit: 50 },
    }),
}));
vi.mock('../src/lib/media-server', () => ({ createMediaServerConnector: () => ({ getWatchHistory: state.getWatchHistory }) }));
vi.mock('../src/lib/tmdb', () => ({
    getRecommendationsForItem: state.getRecommendations, discoverByFilters: state.discover,
    getTmdbExternalIds: vi.fn().mockResolvedValue({}), searchTmdb: vi.fn().mockResolvedValue(null),
    getTmdbCredits: vi.fn().mockResolvedValue(null), searchTmdbKeyword: vi.fn().mockResolvedValue(null),
    discoverByKeywords: vi.fn().mockResolvedValue([]), discoverByCrew: vi.fn().mockResolvedValue([]),
}));
vi.mock('../src/lib/ai-recommender', () => ({ generateTasteProfile: vi.fn(), getAiRecommendations: vi.fn() }));
vi.mock('../src/lib/radarr', () => ({ getAllRadarrMovies: vi.fn().mockResolvedValue([]), addMovieToRadarr: vi.fn() }));
vi.mock('../src/lib/sonarr', () => ({ getAllSonarrSeries: vi.fn().mockResolvedValue([]), addSeriesToSonarr: vi.fn() }));
vi.mock('../src/lib/notifications', () => ({ notifyRunResult: vi.fn().mockResolvedValue(undefined) }));

let directory: string;
beforeEach(() => {
    directory = mkdtempSync(path.join(tmpdir(), 'engine-observability-integration-'));
    state.databasePath = path.join(directory, 'test.db');
    state.getWatchHistory.mockResolvedValue([{ title: 'Arrival', mediaType: 'movie', tmdbId: 329865, language: 'en' }]);
    state.discover.mockResolvedValue([]);
    state.getRecommendations.mockResolvedValue([{ title: 'Contact', mediaType: 'movie', tmdbId: 686, language: 'en', overview: 'First contact', posterUrl: '/poster.jpg', genres: ['Sci-Fi'], voteAverage: 7.5, source: 'tmdb', status: 'pending' }]);
});
afterEach(() => {
    for (const connection of state.connections) if (connection.open) connection.close();
    state.connections.length = 0;
    vi.clearAllMocks();
    rmSync(directory, { recursive: true, force: true });
});

describe('engine observability integration', () => {
    it('persists a completed run with exact candidate accounting and visible Run ID logs', async () => {
        vi.resetModules();
        const engine = await import('../src/lib/engine');
        const runs = await import('../src/lib/engine-runs');
        const database = await import('../src/lib/database');

        await engine.runRecommendationEngine();
        const run = runs.getRecentEngineRuns(1)[0];
        expect(run).toMatchObject({ status: 'succeeded', source: 'manual', engineVersion: '3.0.1' });
        expect(run.summary).toMatchObject({ tmdbCandidates: 1, aiCandidates: 0, candidatesConsidered: 1, recommendationsSaved: 1, candidatesUnprocessed: 0 });
        expect(database.getLogs('INFO', 50, 0).some(log => log.details?.includes(run.id))).toBe(true);
    });

    it('classifies an attempted TMDb failure as partial instead of healthy success', async () => {
        state.getRecommendations.mockRejectedValue(new Error('provider token=do-not-persist'));
        vi.resetModules();
        const engine = await import('../src/lib/engine');
        const runs = await import('../src/lib/engine-runs');

        await engine.runRecommendationEngine();
        const run = runs.getRecentEngineRuns(1)[0];
        expect(run.status).toBe('partial');
        expect(run.summary.errorCount).toBeGreaterThan(0);
        expect(JSON.stringify(run)).not.toContain('do-not-persist');
    });
});
