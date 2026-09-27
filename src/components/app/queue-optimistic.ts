import type { Recommendation, RecommendationStatus } from '../../lib/types';
import type { Counts } from './models';

const transitionTargets = new WeakMap<Recommendation, RecommendationStatus>();
const transitionIndexes = new WeakMap<Recommendation, number>();

function updateCounts(counts: Counts, from: RecommendationStatus, to: RecommendationStatus): Counts {
    if (from === to) return counts;
    return { ...counts, [from]: Math.max(0, counts[from] - 1), [to]: counts[to] + 1 };
}

export function matchesQueueSearch(recommendation: Recommendation, search: string) {
    const query = search.trim().toLocaleLowerCase();
    if (!query) return true;
    return [recommendation.title, recommendation.overview, recommendation.aiReasoning, recommendation.feedbackReason, recommendation.feedbackNotes]
        .some(value => String(value || '').toLocaleLowerCase().includes(query));
}

export function reconcileRecommendation(
    recommendations: Recommendation[],
    updated: Recommendation,
    visibleStatuses: RecommendationStatus[],
    predicate: (item: Recommendation) => boolean = () => true,
) {
    const index = recommendations.findIndex(item => item.id === updated.id);
    const without = recommendations.filter(item => item.id !== updated.id);
    if (!visibleStatuses.includes(updated.status) || !predicate(updated)) return without;
    if (index < 0) return [...without, updated];
    const result = [...without];
    result.splice(index, 0, updated);
    return result;
}

export function beginOptimisticTransition(
    recommendations: Recommendation[],
    counts: Counts,
    id: string,
    status: RecommendationStatus,
    visibleStatuses: RecommendationStatus[],
) {
    const previous = recommendations.find(item => item.id === id);
    if (!previous) throw new Error('Recommendation is not present in the current queue');
    transitionTargets.set(previous, status);
    transitionIndexes.set(previous, recommendations.findIndex(item => item.id === id));
    const optimistic = { ...previous, status };
    return {
        previous,
        recommendations: reconcileRecommendation(recommendations, optimistic, visibleStatuses),
        counts: updateCounts(counts, previous.status, status),
    };
}

export function rollbackOptimisticTransition(recommendations: Recommendation[], counts: Counts, previous: Recommendation) {
    const target = transitionTargets.get(previous);
    const nextCounts = target ? updateCounts(counts, target, previous.status) : counts;
    const without = recommendations.filter(item => item.id !== previous.id);
    const index = transitionIndexes.get(previous) ?? without.length;
    const restored = [...without];
    restored.splice(Math.min(index, restored.length), 0, previous);
    return { recommendations: restored, counts: nextCounts };
}

export function createUndoWindow(onExpire: () => void, duration = 8000) {
    const timer = setTimeout(onExpire, duration);
    return { cancel: () => clearTimeout(timer) };
}
