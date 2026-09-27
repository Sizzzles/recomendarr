import type { RecommendationStatus } from './types';

export type RecommendationSort = 'newest' | 'oldest' | 'rating' | 'title' | 'source';

export interface RecommendationQuery {
    statuses: RecommendationStatus[];
    statusFilterPresent: boolean;
    search?: string;
    sort: RecommendationSort;
    limit: number;
    offset: number;
}

const STATUSES = new Set<RecommendationStatus>([
    'pending', 'approved', 'rejected', 'added', 'not_now', 'watched',
]);
const SORTS = new Set<RecommendationSort>(['newest', 'oldest', 'rating', 'title', 'source']);

function integerInRange(value: string | null, fallback: number, min: number, max = Number.MAX_SAFE_INTEGER) {
    if (value === null || !/^\d+$/.test(value)) return fallback;
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

export function parseRecommendationQuery(searchParams: URLSearchParams): RecommendationQuery {
    const statusFilterPresent = searchParams.has('status');
    const statuses = (searchParams.get('status') || '')
        .split(',')
        .map(value => value.trim())
        .filter((value): value is RecommendationStatus => STATUSES.has(value as RecommendationStatus));
    const rawSearch = searchParams.get('search');
    const search = rawSearch?.trim() || undefined;
    const rawSort = searchParams.get('sort') as RecommendationSort | null;

    return {
        statuses: Array.from(new Set(statuses)),
        statusFilterPresent,
        search,
        sort: rawSort && SORTS.has(rawSort) ? rawSort : 'newest',
        limit: integerInRange(searchParams.get('limit'), 50, 1, 100),
        offset: integerInRange(searchParams.get('offset'), 0, 0),
    };
}
