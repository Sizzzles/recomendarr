import type { RecommendationSort } from '../../lib/recommendation-query';
import type { Counts, RecommendationFilter } from './models';
import type { MediaType, Recommendation } from '../../lib/types';

export const QUEUE_PREFERENCES_KEY = 'recomendarr.queue.preferences.v1';
export interface QueuePreferences { filter: RecommendationFilter; sort: RecommendationSort }
interface StorageLike { getItem(key: string): string | null; setItem(key: string, value: string): void }

const filters = new Set<RecommendationFilter>(['all', 'pending', 'not_now', 'watched', 'rejected']);
const sorts = new Set<RecommendationSort>(['newest', 'oldest', 'rating', 'title', 'source']);

export function parseQueuePreferences(storage: Pick<StorageLike, 'getItem'>): QueuePreferences {
    try {
        const value = JSON.parse(storage.getItem(QUEUE_PREFERENCES_KEY) || 'null') as Partial<QueuePreferences> | null;
        if (value && filters.has(value.filter as RecommendationFilter) && sorts.has(value.sort as RecommendationSort)) {
            return value as QueuePreferences;
        }
    } catch { /* invalid browser state */ }
    return { filter: 'all', sort: 'newest' };
}

export function saveQueuePreferences(storage: Pick<StorageLike, 'setItem'>, preferences: QueuePreferences) {
    try { storage.setItem(QUEUE_PREFERENCES_KEY, JSON.stringify(preferences)); } catch { /* storage can be unavailable */ }
}

export interface QueueEmptyStateInput {
    loading: boolean;
    search: string;
    filter: RecommendationFilter;
    matchingCount: number;
    counts: Counts;
    hasMore: boolean;
}

export interface QueueEmptyState {
    kind: 'loading' | 'never-generated' | 'no-search-results' | 'snoozed-only' | 'empty-status' | 'triage-complete' | 'end' | 'none';
    title: string;
    description: string;
    action?: 'clear-search' | 'run-engine';
}

export function getQueueEmptyState(input: QueueEmptyStateInput): QueueEmptyState {
    if (input.loading) return { kind: 'loading', title: 'Loading titles', description: 'Fetching recommendations from the queue.' };
    if (input.search.trim() && input.matchingCount === 0) return { kind: 'no-search-results', title: `No matches for “${input.search.trim()}”`, description: 'Try another title or clear the search.', action: 'clear-search' };
    if (input.counts.total === 0) return { kind: 'never-generated', title: 'No recommendations yet', description: 'Run the recommendation engine to build your first queue.', action: 'run-engine' };
    if (input.filter === 'pending' && input.matchingCount === 0 && input.counts.not_now > 0) return { kind: 'snoozed-only', title: 'Everything pending is snoozed', description: 'Open Not now to review titles that will return later.' };
    if (input.filter === 'all' && input.matchingCount === 0 && input.counts.total > 0) return { kind: 'triage-complete', title: 'Active queue complete', description: 'Your remaining titles are in history or waiting outside the active queue.' };
    if (input.matchingCount === 0) return { kind: 'empty-status', title: `No ${input.filter.replace('_', ' ')} titles`, description: 'Choose another queue filter or run the engine again.' };
    if (!input.hasMore) return { kind: 'end', title: 'End of queue', description: 'You have reached the end of these results.' };
    return { kind: 'none', title: '', description: '' };
}

export function selectAllVisible(recommendations: Recommendation[]) {
    return new Set(recommendations.flatMap(item => item.id ? [item.id] : []).slice(0, 100));
}

export function pruneSelection(selection: Set<string>, recommendations: Recommendation[]) {
    const visible = new Set(recommendations.flatMap(item => item.id ? [item.id] : []));
    return new Set(Array.from(selection).filter(id => visible.has(id)));
}

export function getBulkAddEligibility(recommendations: Recommendation[]): { allowed: true; mediaType: MediaType } | { allowed: false; reason: string } {
    if (recommendations.length === 0) return { allowed: false, reason: 'Select at least one recommendation.' };
    if (recommendations.some(item => item.status !== 'pending')) return { allowed: false, reason: 'Bulk Add is available only for pending recommendations.' };
    const types = new Set(recommendations.map(item => item.mediaType));
    if (types.size !== 1) return { allowed: false, reason: 'Bulk Add requires selecting only movies or only series.' };
    return { allowed: true, mediaType: recommendations[0].mediaType };
}
