import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    getRecommendations: vi.fn(),
    getRecommendationCounts: vi.fn(),
    getMatchingRecommendationCount: vi.fn(),
    updateRecommendationStatus: vi.fn(),
    snoozeRecommendation: vi.fn(),
    addWatchedRecommendation: vi.fn(),
    approveAndAdd: vi.fn(),
    approveAndAddMany: vi.fn(),
    searchTmdbTitles: vi.fn(),
    getTmdbExternalIds: vi.fn(),
    applyRecommendationAction: vi.fn(),
    applyBulkRecommendationAction: vi.fn(),
    restoreRecommendationState: vi.fn(),
    restoreBulkRecommendationStates: vi.fn(),
}));

vi.mock('../src/lib/database', () => ({
    getRecommendations: mocks.getRecommendations,
    getRecommendationCounts: mocks.getRecommendationCounts,
    getMatchingRecommendationCount: mocks.getMatchingRecommendationCount,
    updateRecommendationStatus: mocks.updateRecommendationStatus,
    snoozeRecommendation: mocks.snoozeRecommendation,
    addWatchedRecommendation: mocks.addWatchedRecommendation,
}));
vi.mock('@/lib/database', () => ({
    getRecommendations: mocks.getRecommendations,
    getRecommendationCounts: mocks.getRecommendationCounts,
    getMatchingRecommendationCount: mocks.getMatchingRecommendationCount,
    updateRecommendationStatus: mocks.updateRecommendationStatus,
    snoozeRecommendation: mocks.snoozeRecommendation,
    addWatchedRecommendation: mocks.addWatchedRecommendation,
}));

vi.mock('../src/lib/engine', () => ({ approveAndAdd: mocks.approveAndAdd, approveAndAddMany: mocks.approveAndAddMany }));
vi.mock('@/lib/engine', () => ({ approveAndAdd: mocks.approveAndAdd, approveAndAddMany: mocks.approveAndAddMany }));
vi.mock('../src/lib/recommendation-actions', () => ({
    applyRecommendationAction: mocks.applyRecommendationAction,
    applyBulkRecommendationAction: mocks.applyBulkRecommendationAction,
    restoreRecommendationState: mocks.restoreRecommendationState,
    restoreBulkRecommendationStates: mocks.restoreBulkRecommendationStates,
    RecommendationActionError: class RecommendationActionError extends Error { constructor(message: string, public code: string) { super(message); } },
}));
vi.mock('@/lib/recommendation-actions', () => ({
    applyRecommendationAction: mocks.applyRecommendationAction,
    applyBulkRecommendationAction: mocks.applyBulkRecommendationAction,
    restoreRecommendationState: mocks.restoreRecommendationState,
    restoreBulkRecommendationStates: mocks.restoreBulkRecommendationStates,
    RecommendationActionError: class RecommendationActionError extends Error { constructor(message: string, public code: string) { super(message); } },
}));
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
    mocks.getMatchingRecommendationCount.mockReturnValue(0);
    mocks.applyRecommendationAction.mockReturnValue({ id: 'rec-1', title: 'One', mediaType: 'movie', source: 'tmdb', status: 'not_now', updatedAt: 'v2' });
});

describe('recommendation queue API', () => {
    it('accepts Not now and Watched filters', async () => {
        await getRecommendationsRoute(new Request('http://localhost/api/recommendations?status=not_now,watched'));

        expect(mocks.getRecommendations).toHaveBeenCalledWith(expect.objectContaining({
            statuses: ['not_now', 'watched'], statusFilterPresent: true, sort: 'newest', limit: 50, offset: 0,
        }));
    });

    it('returns the normalized query and matching count with safe defaults', async () => {
        mocks.getMatchingRecommendationCount.mockReturnValue(7);
        const response = await getRecommendationsRoute(new Request('http://localhost/api/recommendations?status=bogus&sort=nope&limit=-1&offset=2.5&search=%20Arrival%20'));
        expect(response.status).toBe(200);
        expect(mocks.getRecommendations).toHaveBeenCalledWith(expect.objectContaining({
            statuses: [], statusFilterPresent: true, search: 'Arrival', sort: 'newest', limit: 50, offset: 0,
        }));
        await expect(response.json()).resolves.toMatchObject({ matchingCount: 7, query: { search: 'Arrival', sort: 'newest', limit: 50, offset: 0 } });
    });

    it('uses the dedicated seven-day snooze action', async () => {
        const response = await PATCH(new Request('http://localhost/api/recommendations', {
            method: 'PATCH',
            body: JSON.stringify({ id: 'rec-1', action: 'not_now' }),
        }));

        expect(response.status).toBe(200);
        expect(mocks.applyRecommendationAction).toHaveBeenCalledWith('rec-1', 'not_now', { days: 7 });
        expect(await response.json()).toMatchObject({ success: true, recommendation: { updatedAt: 'v2' } });
    });

    it('marks a recommendation watched without rejection feedback', async () => {
        const response = await PATCH(new Request('http://localhost/api/recommendations', {
            method: 'PATCH',
            body: JSON.stringify({ id: 'rec-2', action: 'watched' }),
        }));

        expect(response.status).toBe(200);
        expect(mocks.applyRecommendationAction).toHaveBeenCalledWith('rec-2', 'watched');
    });

    it('supports transactional bulk actions and state restore', async () => {
        mocks.applyBulkRecommendationAction.mockReturnValue([{ id: 'a', status: 'not_now' }, { id: 'b', status: 'not_now' }]);
        const bulk = await PATCH(new Request('http://localhost/api/recommendations', { method: 'PATCH', body: JSON.stringify({ ids: ['a', 'b'], action: 'not_now' }) }));
        expect(bulk.status).toBe(200);
        expect(mocks.applyBulkRecommendationAction).toHaveBeenCalledWith(['a', 'b'], 'not_now', { days: 7 });

        mocks.restoreRecommendationState.mockReturnValue({ id: 'a', status: 'pending', updatedAt: 'fresh' });
        const previous = { id: 'a', title: 'A', mediaType: 'movie', source: 'tmdb', status: 'pending' };
        const restore = await PATCH(new Request('http://localhost/api/recommendations', { method: 'PATCH', body: JSON.stringify({ id: 'a', action: 'restore', previous, expectedUpdatedAt: 'current' }) }));
        expect(restore.status).toBe(200);
        expect(mocks.restoreRecommendationState).toHaveBeenCalledWith('a', previous, 'current');
    });

    it('maps a stale restore to HTTP 409', async () => {
        const error = Object.assign(new Error('changed'), { code: 'VERSION_CONFLICT' });
        mocks.restoreRecommendationState.mockImplementation(() => { throw error; });
        const response = await PATCH(new Request('http://localhost/api/recommendations', { method: 'PATCH', body: JSON.stringify({ id: 'a', action: 'restore', previous: { status: 'pending' }, expectedUpdatedAt: 'old' }) }));
        expect(response.status).toBe(409);
    });

    it('returns itemized partial results for same-type Bulk Add', async () => {
        mocks.approveAndAddMany.mockResolvedValue({ results: [{ id: 'a', outcome: 'added' }, { id: 'b', outcome: 'failed' }], totals: { added: 1, failed: 1, unchanged: 0 } });
        const response = await PATCH(new Request('http://localhost/api/recommendations', { method: 'PATCH', body: JSON.stringify({ ids: ['a', 'b', 'a'], action: 'approve', mediaType: 'movie', qualityProfileId: 1, rootFolderPath: '/movies', searchForContent: true }) }));
        expect(response.status).toBe(200);
        expect(mocks.approveAndAddMany).toHaveBeenCalledWith(['a', 'b', 'a'], { mediaType: 'movie', qualityProfileId: 1, rootFolderPath: '/movies', searchForContent: true });
        await expect(response.json()).resolves.toMatchObject({ totals: { added: 1, failed: 1 } });
    });

    it.each([
        [{ ids: [null], action: 'not_now' }, 400],
        [{ id: 'a', action: 'reject' }, 400],
        [{ action: 'restore', restores: [{ id: 'a' }] }, 400],
        [{ ids: ['a'], action: 'approve', mediaType: 'movie', qualityProfileId: 'bad' }, 400],
    ])('rejects malformed PATCH payload %#', async (body, status) => {
        const response = await PATCH(new Request('http://localhost/api/recommendations', { method: 'PATCH', body: JSON.stringify(body) }));
        expect(response.status).toBe(status);
    });

    it('maps typed Bulk Add validation failures to 400', async () => {
        mocks.approveAndAddMany.mockRejectedValue(Object.assign(new Error('mixed'), { code: 'INVALID_BATCH' }));
        const response = await PATCH(new Request('http://localhost/api/recommendations', { method: 'PATCH', body: JSON.stringify({ ids: ['a'], action: 'approve', mediaType: 'movie' }) }));
        expect(response.status).toBe(400);
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
