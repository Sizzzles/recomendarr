import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Recommendation } from '../src/lib/types';

const mocks = vi.hoisted(() => ({ getRecommendationById: vi.fn(), updateRecommendationStatus: vi.fn(), addMovieToRadarr: vi.fn() }));
vi.mock('../src/lib/database', () => ({
    getRecommendationById: mocks.getRecommendationById,
    getRecommendations: vi.fn(() => []), addRecommendation: vi.fn(), updateRecommendationStatus: mocks.updateRecommendationStatus,
    getFeedbackProfile: vi.fn(() => ({ rejectedTitles: [], preferredGenres: [], avoidedGenres: [], preferredMediaTypes: [], avoidedMediaTypes: [], feedbackReasons: {}, summary: '' })),
    getWatchedMediaSignalSets: vi.fn(() => ({ tmdbIds: new Set(), tvdbIds: new Set(), imdbIds: new Set(), titles: new Set() })), addLog: vi.fn(),
}));
vi.mock('@/lib/database', () => ({
    getRecommendationById: mocks.getRecommendationById,
    getRecommendations: vi.fn(() => []), addRecommendation: vi.fn(), updateRecommendationStatus: mocks.updateRecommendationStatus,
    getFeedbackProfile: vi.fn(() => ({ rejectedTitles: [], preferredGenres: [], avoidedGenres: [], preferredMediaTypes: [], avoidedMediaTypes: [], feedbackReasons: {}, summary: '' })),
    getWatchedMediaSignalSets: vi.fn(() => ({ tmdbIds: new Set(), tvdbIds: new Set(), imdbIds: new Set(), titles: new Set() })), addLog: vi.fn(),
}));
vi.mock('../src/lib/radarr', () => ({
    lookupMovieByTerm: vi.fn(async (title: string) => [{ title, tmdbId: 1 }]),
    addMovieToRadarr: mocks.addMovieToRadarr,
    getAllRadarrMovies: vi.fn(async () => []),
}));

import { approveAndAddMany } from '../src/lib/engine';

const rec = (id: string, mediaType: 'movie' | 'series' = 'movie'): Recommendation => ({ id, title: id, mediaType, source: 'tmdb', status: 'pending' });

beforeEach(() => {
    vi.clearAllMocks();
    mocks.getRecommendationById.mockImplementation((id: string) => rec(id));
    mocks.addMovieToRadarr.mockResolvedValue({ success: true, message: 'added' });
});

describe('approveAndAddMany', () => {
    it('de-duplicates before side effects and returns ordered partial results', async () => {
        const process = vi.fn(async (id: string) => id === 'bad' ? { success: false, message: 'failed' } : { success: true, message: 'added' });
        const result = await approveAndAddMany(['good', 'bad', 'good', 'last'], { mediaType: 'movie' }, process);
        expect(process.mock.calls.map(call => call[0])).toEqual(['good', 'bad', 'last']);
        expect(result.results.map(item => item.id)).toEqual(['good', 'bad', 'last']);
        expect(result.totals).toEqual({ added: 2, failed: 1, unchanged: 0 });
    });

    it('validates every media type before any external side effect', async () => {
        mocks.getRecommendationById.mockImplementation((id: string) => id === 'show' ? rec(id, 'series') : rec(id));
        const process = vi.fn();
        await expect(approveAndAddMany(['movie', 'show'], { mediaType: 'movie' }, process)).rejects.toThrow('same media type');
        expect(process).not.toHaveBeenCalled();
    });

    it('continues after a thrown item error and preserves its failure', async () => {
        const process = vi.fn(async (id: string) => { if (id === 'bad') throw new Error('offline'); return { success: true, message: 'added' }; });
        const result = await approveAndAddMany(['bad', 'good'], { mediaType: 'movie' }, process);
        expect(result.results[0]).toMatchObject({ id: 'bad', outcome: 'failed', message: 'offline' });
        expect(result.results[1]).toMatchObject({ id: 'good', outcome: 'added' });
    });

    it('processes a selected recommendation even when it is outside the legacy first page', async () => {
        mocks.getRecommendationById.mockReturnValue({ ...rec('older'), tmdbId: 1 });
        const result = await approveAndAddMany(['older'], { mediaType: 'movie' });
        expect(result.totals).toEqual({ added: 1, failed: 0, unchanged: 0 });
        expect(mocks.updateRecommendationStatus).toHaveBeenCalledWith('older', 'added');
    });
});
