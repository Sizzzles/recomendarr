import { NextResponse } from 'next/server';
import { getRecommendations, getRecommendationCounts, getMatchingRecommendationCount } from '@/lib/database';
import { approveAndAdd, approveAndAddMany } from '@/lib/engine';
import type { FeedbackReason } from '@/lib/types';
import { parseRecommendationQuery } from '../../../lib/recommendation-query';
import { applyBulkRecommendationAction, applyRecommendationAction, restoreBulkRecommendationStates, restoreRecommendationState } from '../../../lib/recommendation-actions';
import type { RecommendationAction } from '../../../lib/recommendation-actions';

const feedbackReasons = new Set(['already_watched', 'wrong_genre', 'wrong_mood', 'too_mainstream', 'too_old', 'not_interested']);
const statuses = new Set(['pending', 'approved', 'rejected', 'added', 'not_now', 'watched']);
const validIds = (value: unknown): value is string[] => Array.isArray(value) && value.length > 0 && value.length <= 100
    && value.every(id => typeof id === 'string' && id.trim().length > 0);
const validRestore = (value: unknown) => {
    if (!value || typeof value !== 'object') return false;
    const entry = value as { id?: unknown; expectedUpdatedAt?: unknown; previous?: { status?: unknown } };
    return typeof entry.id === 'string' && Boolean(entry.id.trim()) && typeof entry.expectedUpdatedAt === 'string'
        && Boolean(entry.expectedUpdatedAt) && Boolean(entry.previous && statuses.has(String(entry.previous.status)));
};

export async function GET(request: Request) {
    try {
        const { searchParams } = new URL(request.url);
        const countsOnly = searchParams.get('counts') === 'true';

        if (countsOnly) {
            const counts = getRecommendationCounts();
            return NextResponse.json(counts);
        }

        const query = parseRecommendationQuery(searchParams);
        const recommendations = getRecommendations(query);
        const counts = getRecommendationCounts();
        const matchingCount = getMatchingRecommendationCount(query);
        return NextResponse.json({ recommendations, counts, matchingCount, query });
    } catch (err) {
        return NextResponse.json({ error: (err as Error).message }, { status: 500 });
    }
}

export async function PATCH(request: Request) {
    try {
        const body = await request.json();
        const { id, ids, action } = body;

        if (typeof action !== 'string') return NextResponse.json({ error: 'action is required' }, { status: 400 });

        if (!action || (!id && !Array.isArray(ids) && !Array.isArray(body.restores))) {
            return NextResponse.json({ error: 'id or ids and action required' }, { status: 400 });
        }

        if (action === 'restore') {
            if (Array.isArray(body.restores)) {
                if (body.restores.length === 0 || body.restores.length > 100 || !body.restores.every(validRestore)) {
                    return NextResponse.json({ error: 'restore entries are malformed' }, { status: 400 });
                }
                const recommendations = restoreBulkRecommendationStates(body.restores);
                return NextResponse.json({ success: true, recommendations });
            }
            if (!validRestore({ id, previous: body.previous, expectedUpdatedAt: body.expectedUpdatedAt })) {
                return NextResponse.json({ error: 'restore requires id, previous, and expectedUpdatedAt' }, { status: 400 });
            }
            const recommendation = restoreRecommendationState(id, body.previous, body.expectedUpdatedAt);
            return NextResponse.json({ success: true, recommendation });
        }

        const options = action === 'reject'
            ? { reason: body.feedbackReason as FeedbackReason | undefined, notes: body.feedbackNotes as string | undefined }
            : action === 'not_now' ? { days: 7 } : undefined;

        if (Array.isArray(ids)) {
            if (!validIds(ids)) return NextResponse.json({ error: 'ids must contain 1 to 100 non-empty strings' }, { status: 400 });
            if (action === 'reject' && (!feedbackReasons.has(body.feedbackReason) || (body.feedbackNotes !== undefined && typeof body.feedbackNotes !== 'string'))) {
                return NextResponse.json({ error: 'Reject requires a valid feedbackReason and optional text feedbackNotes' }, { status: 400 });
            }
            if (action === 'approve') {
                if (body.mediaType !== 'movie' && body.mediaType !== 'series') {
                    return NextResponse.json({ error: 'Bulk Add requires mediaType' }, { status: 400 });
                }
                if ((body.qualityProfileId !== undefined && (!Number.isInteger(body.qualityProfileId) || body.qualityProfileId <= 0))
                    || (body.rootFolderPath !== undefined && typeof body.rootFolderPath !== 'string')
                    || (body.searchForContent !== undefined && typeof body.searchForContent !== 'boolean')) {
                    return NextResponse.json({ error: 'Bulk Add options are malformed' }, { status: 400 });
                }
                const result = await approveAndAddMany(ids, {
                    mediaType: body.mediaType,
                    qualityProfileId: body.qualityProfileId,
                    rootFolderPath: body.rootFolderPath,
                    searchForContent: body.searchForContent,
                });
                return NextResponse.json({ success: true, ...result });
            }
            if (!['reject', 'pending', 'not_now', 'watched'].includes(action)) {
                return NextResponse.json({ error: 'Invalid bulk action' }, { status: 400 });
            }
            const recommendations = applyBulkRecommendationAction(ids, action as RecommendationAction, options);
            return NextResponse.json({ success: true, recommendations });
        }

        if (typeof id !== 'string' || !id.trim()) return NextResponse.json({ error: 'id must be a non-empty string' }, { status: 400 });
        if (action === 'reject' && (!feedbackReasons.has(body.feedbackReason) || (body.feedbackNotes !== undefined && typeof body.feedbackNotes !== 'string'))) {
            return NextResponse.json({ error: 'Reject requires a valid feedbackReason and optional text feedbackNotes' }, { status: 400 });
        }

        if (action === 'approve') {
            const options = {
                qualityProfileId: body.qualityProfileId,
                rootFolderPath: body.rootFolderPath,
                searchForContent: body.searchForContent,
            };
            const result = await approveAndAdd(id, options);
            return NextResponse.json(result);
        } else if (action === 'reject') {
            const recommendation = applyRecommendationAction(id, 'reject', options);
            return NextResponse.json({ success: true, message: 'Recommendation rejected', recommendation });
        } else if (action === 'pending') {
            const recommendation = applyRecommendationAction(id, 'pending');
            return NextResponse.json({ success: true, message: 'Recommendation reset to pending', recommendation });
        } else if (action === 'not_now') {
            const recommendation = applyRecommendationAction(id, 'not_now', { days: 7 });
            return NextResponse.json({ success: true, message: 'Recommendation snoozed for 7 days', recommendation });
        } else if (action === 'watched') {
            const recommendation = applyRecommendationAction(id, 'watched');
            return NextResponse.json({ success: true, message: 'Recommendation marked as watched', recommendation });
        }

        return NextResponse.json({ error: 'Invalid action' }, { status: 400 });
    } catch (err) {
        const code = (err as Error & { code?: string }).code;
        const status = code === 'VERSION_CONFLICT' ? 409 : ['NOT_FOUND', 'INVALID_BATCH', 'INELIGIBLE'].includes(code || '') ? 400 : 500;
        return NextResponse.json({ error: (err as Error).message, code }, { status });
    }
}
