import type Database from 'better-sqlite3';
import { freshDatabaseTimestamp, getDatabase, getRecommendationById, removeManualWatchedMediaState, syncWatchedMediaState } from './database';
import type { FeedbackReason, Recommendation } from './types';

export type RecommendationAction = 'not_now' | 'reject' | 'watched' | 'pending';
export interface RecommendationActionOptions { reason?: FeedbackReason; notes?: string; days?: number }

export class RecommendationActionError extends Error {
    constructor(message: string, public code: 'NOT_FOUND' | 'INVALID_BATCH' | 'INELIGIBLE' | 'VERSION_CONFLICT') { super(message); }
}

function requireRecommendation(id: string) {
    const recommendation = getRecommendationById(id);
    if (!recommendation) throw new RecommendationActionError(`Recommendation ${id} was not found`, 'NOT_FOUND');
    return recommendation;
}

function applyWithDatabase(db: Database.Database, id: string, action: RecommendationAction, options: RecommendationActionOptions = {}) {
    const existing = requireRecommendation(id);
    const updatedAt = freshDatabaseTimestamp(existing.updatedAt);
    let result: Database.RunResult;
    if (action === 'not_now') {
        const days = Math.max(1, Math.min(365, Math.floor(options.days ?? 7)));
        const snoozedUntil = new Date(Date.now() + days * 86400000).toISOString();
        result = db.prepare(`UPDATE recommendations SET status='not_now', snoozed_until=?, feedback_reason=NULL,
            feedback_notes=NULL, feedback_at=NULL, updated_at=? WHERE id=?`).run(snoozedUntil, updatedAt, id);
    } else if (action === 'reject') {
        result = db.prepare(`UPDATE recommendations SET status='rejected', snoozed_until=NULL, feedback_reason=?,
            feedback_notes=?, feedback_at=?, updated_at=? WHERE id=?`).run(options.reason || null, options.notes || null, updatedAt, updatedAt, id);
    } else {
        result = db.prepare(`UPDATE recommendations SET status=?, snoozed_until=NULL, feedback_reason=NULL,
            feedback_notes=NULL, feedback_at=NULL, updated_at=? WHERE id=?`).run(action === 'watched' ? 'watched' : 'pending', updatedAt, id);
    }
    if (result.changes !== 1) throw new RecommendationActionError(`Recommendation ${id} was not found`, 'NOT_FOUND');
    const updated = requireRecommendation(id);
    if (action === 'watched') {
        syncWatchedMediaState([updated], 'manual');
        db.prepare('UPDATE recommendations SET updated_at = ? WHERE id = ?').run(freshDatabaseTimestamp(updated.updatedAt), id);
        return requireRecommendation(id);
    }
    if (action === 'pending') {
        removeManualWatchedMediaState(updated, db);
    }
    return updated;
}

export function applyRecommendationAction(id: string, action: RecommendationAction, options: RecommendationActionOptions = {}) {
    return getDatabase().transaction(() => applyWithDatabase(getDatabase(), id.trim(), action, options)).immediate();
}

export function applyBulkRecommendationAction(ids: string[], action: RecommendationAction, options: RecommendationActionOptions = {}) {
    if (!Array.isArray(ids) || ids.some(id => typeof id !== 'string')) throw new RecommendationActionError('Bulk IDs must be strings', 'INVALID_BATCH');
    const normalized = Array.from(new Set(ids.map(id => id.trim()).filter(Boolean)));
    if (normalized.length === 0 || normalized.length > 100) throw new RecommendationActionError('Bulk actions require 1 to 100 unique IDs', 'INVALID_BATCH');
    const db = getDatabase();
    return db.transaction(() => {
        const rows = normalized.map(requireRecommendation);
        if (action === 'pending' && rows.some(row => !['not_now', 'rejected', 'watched'].includes(row.status))) {
            throw new RecommendationActionError('Only Not now, Rejected, or Watched items can return to queue', 'INELIGIBLE');
        }
        return normalized.map(id => applyWithDatabase(db, id, action, options));
    }).immediate();
}

export function restoreRecommendationState(id: string, previous: Recommendation, expectedUpdatedAt: string) {
    const db = getDatabase();
    return db.transaction(() => {
        const existing = requireRecommendation(id);
        if (existing.updatedAt !== expectedUpdatedAt) throw new RecommendationActionError('Recommendation changed after this action', 'VERSION_CONFLICT');
        return restoreWithDatabase(db, id, previous, expectedUpdatedAt);
    }).immediate();
}

function restoreWithDatabase(db: Database.Database, id: string, previous: Recommendation, expectedUpdatedAt: string) {
    const updatedAt = freshDatabaseTimestamp(expectedUpdatedAt);
    const result = db.prepare(`UPDATE recommendations SET status=?, snoozed_until=?, feedback_reason=?,
        feedback_notes=?, feedback_at=?, updated_at=? WHERE id=? AND updated_at=?`).run(
        previous.status, previous.snoozedUntil || null, previous.feedbackReason || null,
        previous.feedbackNotes || null, previous.feedbackAt || null, updatedAt, id, expectedUpdatedAt,
    );
    if (result.changes !== 1) throw new RecommendationActionError('Recommendation changed after this action', 'VERSION_CONFLICT');
    const restored = requireRecommendation(id);
    if (restored.status === 'watched') {
        syncWatchedMediaState([restored], 'manual');
        db.prepare('UPDATE recommendations SET updated_at = ? WHERE id = ?').run(freshDatabaseTimestamp(restored.updatedAt), id);
    }
    else removeManualWatchedMediaState(restored, db);
    return requireRecommendation(id);
}

export function restoreBulkRecommendationStates(entries: Array<{ id: string; previous: Recommendation; expectedUpdatedAt: string }>) {
    if (!Array.isArray(entries) || entries.some(entry => !entry || typeof entry.id !== 'string')) {
        throw new RecommendationActionError('Restore entries are malformed', 'INVALID_BATCH');
    }
    const normalized = Array.from(new Map(entries.map(entry => [entry.id.trim(), { ...entry, id: entry.id.trim() }])).values());
    if (normalized.length === 0 || normalized.length > 100 || normalized.some(entry => !entry.id || !entry.expectedUpdatedAt || !entry.previous)) {
        throw new RecommendationActionError('Restore requires 1 to 100 complete entries', 'INVALID_BATCH');
    }
    const db = getDatabase();
    return db.transaction(() => {
        for (const entry of normalized) {
            if (requireRecommendation(entry.id).updatedAt !== entry.expectedUpdatedAt) {
                throw new RecommendationActionError('Recommendation changed after this action', 'VERSION_CONFLICT');
            }
        }
        return normalized.map(entry => restoreWithDatabase(db, entry.id, entry.previous, entry.expectedUpdatedAt));
    }).immediate();
}

export function getRecommendationActionState(id: string) { return requireRecommendation(id); }
