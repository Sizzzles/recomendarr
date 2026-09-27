import { describe, expect, it } from 'vitest';
import { getBulkAddEligibility, getQueueEmptyState, pruneSelection, selectAllVisible, parseQueuePreferences, saveQueuePreferences } from '../src/components/app/queue-model';
import type { Recommendation } from '../src/lib/types';

class MemoryStorage {
    values = new Map<string, string>();
    getItem(key: string) { return this.values.get(key) ?? null; }
    setItem(key: string, value: string) { this.values.set(key, value); }
}

describe('Queue preferences', () => {
    it('persists and restores only a valid filter and sort in a versioned key', () => {
        const storage = new MemoryStorage();
        saveQueuePreferences(storage, { filter: 'not_now', sort: 'rating' });
        expect(parseQueuePreferences(storage)).toEqual({ filter: 'not_now', sort: 'rating' });
        expect(Array.from(storage.values.keys())).toEqual(['recomendarr.queue.preferences.v1']);
    });

    it.each([null, '{', '{}', '{"filter":"library","sort":"wat"}'])('falls back safely for %s', (value) => {
        const storage = new MemoryStorage();
        if (value !== null) storage.setItem('recomendarr.queue.preferences.v1', value);
        expect(parseQueuePreferences(storage)).toEqual({ filter: 'all', sort: 'newest' });
    });
});

describe('Queue selection', () => {
    const movie = { id: 'm', title: 'Movie', mediaType: 'movie', source: 'tmdb', status: 'pending' } as Recommendation;
    const series = { id: 's', title: 'Series', mediaType: 'series', source: 'tmdb', status: 'pending' } as Recommendation;
    it('selects visible IDs and prunes IDs no longer in the result', () => {
        expect(selectAllVisible([movie, series])).toEqual(new Set(['m', 's']));
        expect(pruneSelection(new Set(['m', 'gone']), [movie])).toEqual(new Set(['m']));
    });
    it('allows one media type and clearly rejects mixed media or ineligible status', () => {
        expect(getBulkAddEligibility([movie])).toEqual({ allowed: true, mediaType: 'movie' });
        expect(getBulkAddEligibility([movie, series])).toEqual({ allowed: false, reason: 'Bulk Add requires selecting only movies or only series.' });
        expect(getBulkAddEligibility([{ ...movie, status: 'rejected' }])).toEqual({ allowed: false, reason: 'Bulk Add is available only for pending recommendations.' });
    });
});

describe('Queue empty state', () => {
    const counts = { pending: 0, approved: 0, rejected: 0, added: 0, not_now: 0, watched: 0, total: 0 };
    it('describes loading and a database with no recommendations', () => {
        expect(getQueueEmptyState({ loading: true, search: '', filter: 'all', matchingCount: 0, counts, hasMore: false }).kind).toBe('loading');
        expect(getQueueEmptyState({ loading: false, search: '', filter: 'all', matchingCount: 0, counts, hasMore: false })).toMatchObject({ kind: 'never-generated', action: 'run-engine' });
    });
    it('prioritizes a no-match search and offers to clear it', () => {
        expect(getQueueEmptyState({ loading: false, search: 'Heat', filter: 'pending', matchingCount: 0, counts: { ...counts, total: 5 }, hasMore: false })).toMatchObject({ kind: 'no-search-results', action: 'clear-search' });
    });
    it('explains snoozed-only pending and completed triage', () => {
        expect(getQueueEmptyState({ loading: false, search: '', filter: 'pending', matchingCount: 0, counts: { ...counts, total: 2, not_now: 2 }, hasMore: false }).kind).toBe('snoozed-only');
        expect(getQueueEmptyState({ loading: false, search: '', filter: 'all', matchingCount: 0, counts: { ...counts, total: 2, added: 2 }, hasMore: false }).kind).toBe('triage-complete');
    });
    it('names an empty status and pagination exhaustion', () => {
        expect(getQueueEmptyState({ loading: false, search: '', filter: 'watched', matchingCount: 0, counts: { ...counts, total: 2, pending: 2 }, hasMore: false })).toMatchObject({ kind: 'empty-status', title: 'No watched titles' });
        expect(getQueueEmptyState({ loading: false, search: '', filter: 'pending', matchingCount: 3, counts: { ...counts, total: 3, pending: 3 }, hasMore: false }).kind).toBe('end');
    });
});
