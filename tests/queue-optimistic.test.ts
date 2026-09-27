import { describe, expect, it, vi } from 'vitest';
import { beginOptimisticTransition, createUndoWindow, matchesQueueSearch, reconcileRecommendation, rollbackOptimisticTransition } from '../src/components/app/queue-optimistic';
import type { Recommendation } from '../src/lib/types';

const recommendation: Recommendation = {
    id: 'one', title: 'One', mediaType: 'movie', source: 'tmdb', status: 'pending',
    feedbackReason: 'wrong_mood', feedbackNotes: 'note', feedbackAt: 'feedback-time', snoozedUntil: 'snooze-time', updatedAt: 'old',
};
const counts = { pending: 1, approved: 0, rejected: 0, added: 0, not_now: 0, watched: 0, total: 1 };

describe('optimistic Queue state', () => {
    it('removes a transitioned row from the current view and adjusts counts', () => {
        const result = beginOptimisticTransition([recommendation], counts, 'one', 'not_now', ['pending']);
        expect(result.recommendations).toEqual([]);
        expect(result.counts).toMatchObject({ pending: 0, not_now: 1, total: 1 });
        expect(result.previous).toEqual(recommendation);
    });

    it('retains a row when the destination belongs to the current view', () => {
        const result = beginOptimisticTransition([recommendation], counts, 'one', 'rejected', ['pending', 'rejected']);
        expect(result.recommendations[0]).toMatchObject({ id: 'one', status: 'rejected' });
    });

    it('rolls back every previous field and reconciles authoritative rows', () => {
        const optimistic = beginOptimisticTransition([recommendation], counts, 'one', 'not_now', ['pending']);
        expect(rollbackOptimisticTransition(optimistic.recommendations, optimistic.counts, optimistic.previous)).toEqual({ recommendations: [recommendation], counts });
        const authoritative = { ...recommendation, status: 'not_now' as const, updatedAt: 'server' };
        expect(reconcileRecommendation([recommendation], authoritative, ['pending'])).toEqual([]);
    });

    it('preserves row position and removes authoritative rows that no longer match search', () => {
        const two = { ...recommendation, id: 'two', title: 'Two' };
        const three = { ...recommendation, id: 'three', title: 'Three' };
        expect(reconcileRecommendation([recommendation, two, three], { ...two, status: 'rejected' }, ['pending', 'rejected'])).toEqual([recommendation, { ...two, status: 'rejected' }, three]);
        expect(reconcileRecommendation([recommendation], { ...recommendation, feedbackNotes: null }, ['pending'], item => matchesQueueSearch(item, 'note'))).toEqual([]);
        const optimistic = beginOptimisticTransition([recommendation, two, three], counts, 'two', 'not_now', ['pending']);
        expect(rollbackOptimisticTransition(optimistic.recommendations, optimistic.counts, optimistic.previous).recommendations.map(item => item.id)).toEqual(['one', 'two', 'three']);
    });

    it('expires after eight seconds and replacement cancels the older window', () => {
        vi.useFakeTimers();
        const expired = vi.fn();
        const first = createUndoWindow(expired);
        const second = createUndoWindow(expired);
        first.cancel();
        vi.advanceTimersByTime(7999);
        expect(expired).not.toHaveBeenCalled();
        vi.advanceTimersByTime(1);
        expect(expired).toHaveBeenCalledTimes(1);
        second.cancel();
        vi.useRealTimers();
    });
});
