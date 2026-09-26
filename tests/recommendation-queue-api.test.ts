import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    getRecommendations: vi.fn(),
    getRecommendationCounts: vi.fn(),
    updateRecommendationStatus: vi.fn(),
    snoozeRecommendation: vi.fn(),
    addWatchedRecommendation: vi.fn(),
    approveAndAdd: vi.fn(),
    searchTmdbTitles: vi.fn(),
    getTmdbExternalIds: vi.fn(),
}));

vi.mock('../src/lib/database', () => ({
    getRecommendations: mocks.getRecommendations,
    getRecommendationCounts: mocks.getRecommendationCounts,
    updateRecommendationStatus: mocks.updateRecommendationStatus,
    snoozeRecommendation: mocks.snoozeRecommendation,
    addWatchedRecommendation: mocks.addWatchedRecommendation,
}));
vi.mock('@/lib/database', () => ({
    getRecommendations: mocks.getRecommendations,
    getRecommendationCounts: mocks.getRecommendationCounts,
    updateRecommendationStatus: mocks.updateRecommendationStatus,
    snoozeRecommendation: mocks.snoozeRecommendation,
    addWatchedRecommendation: mocks.addWatchedRecommendation,
}));

vi.mock('../src/lib/engine', () => ({ approveAndAdd: mocks.approveAndAdd }));
vi.mock('@/lib/engine', () => ({ approveAndAdd: mocks.approveAndAdd }));
vi.mock('../src/lib/tmdb', () => ({
    searchTmdbTitles: mocks.searchTmdbTitles,
    getTmdbExternalIds: mocks.getTmdbExternalIds,
}));
vi.mock('@/lib/tmdb', () => ({
    searchTmdbTitles: mocks.searchTmdbTitles,
    getTmdbExternalIds: mocks.getTmdbExternalIds,
}));

import { GET as getRecommendationsRoute, PATCH } from '../src/app/api/recommendations/route';
import { GET as searchWatched, POST as addWatched } from '../src/app/api/watched/route';

beforeEach(() => {
    vi.clearAllMocks();
    mocks.getRecommendations.mockReturnValue([]);
    mocks.getRecommendationCounts.mockReturnValue({
        pending: 0, approved: 0, rejected: 0, added: 0, not_now: 0, watched: 0, total: 0,
    });
    mocks.snoozeRecommendation.mockReturnValue(true);
});

describe('recommendation queue API', () => {
    it('accepts Not now and Watched filters', async () => {
        await getRecommendationsRoute(new Request('http://localhost/api/recommendations?status=not_now,watched'));

        expect(mocks.getRecommendations).toHaveBeenCalledWith(['not_now', 'watched'], 50, 0);
    });

    it('uses the dedicated seven-day snooze action', async () => {
        const response = await PATCH(new Request('http://localhost/api/recommendations', {
            method: 'PATCH',
            body: JSON.stringify({ id: 'rec-1', action: 'not_now' }),
        }));

        expect(response.status).toBe(200);
        expect(mocks.snoozeRecommendation).toHaveBeenCalledWith('rec-1', 7);
        expect(mocks.updateRecommendationStatus).not.toHaveBeenCalledWith('rec-1', 'rejected', expect.anything());
    });

    it('marks a recommendation watched without rejection feedback', async () => {
        const response = await PATCH(new Request('http://localhost/api/recommendations', {
            method: 'PATCH',
            body: JSON.stringify({ id: 'rec-2', action: 'watched' }),
        }));

        expect(response.status).toBe(200);
        expect(mocks.updateRecommendationStatus).toHaveBeenCalledWith('rec-2', 'watched');
    });
});

describe('manual Watched search API', () => {
    it('searches TMDb for movie and series titles', async () => {
        const results = [{ title: 'Heat', mediaType: 'movie', tmdbId: 949, source: 'tmdb', status: 'watched' }];
        mocks.searchTmdbTitles.mockResolvedValue(results);

        const response = await searchWatched(new Request('http://localhost/api/watched?query=Heat'));

        expect(response.status).toBe(200);
        expect(mocks.searchTmdbTitles).toHaveBeenCalledWith('Heat');
        await expect(response.json()).resolves.toEqual({ results });
    });

    it('enriches and adds a selected search result to Watched', async () => {
        mocks.getTmdbExternalIds.mockResolvedValue({ imdb_id: 'tt0113277' });
        mocks.addWatchedRecommendation.mockImplementation(item => ({ ...item, id: 'saved-1' }));
        const recommendation = {
            title: 'Heat',
            year: 1995,
            mediaType: 'movie',
            tmdbId: 949,
            genres: ['Crime'],
            source: 'tmdb',
            status: 'watched',
        };

        const response = await addWatched(new Request('http://localhost/api/watched', {
            method: 'POST',
            body: JSON.stringify({ recommendation }),
        }));

        expect(response.status).toBe(200);
        expect(mocks.getTmdbExternalIds).toHaveBeenCalledWith(949, 'movie');
        expect(mocks.addWatchedRecommendation).toHaveBeenCalledWith(expect.objectContaining({
            ...recommendation,
            imdbId: 'tt0113277',
            status: 'watched',
        }));
    });
});
