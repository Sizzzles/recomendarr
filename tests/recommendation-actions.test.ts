import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ databasePath: '', connections: [] as import('better-sqlite3').Database[] }));
vi.mock('../src/lib/config', () => ({ config: { database: { get path() { return state.databasePath; } } } }));
vi.mock('better-sqlite3', async (importOriginal) => {
    type SqliteConstructor = new (filename: string) => import('better-sqlite3').Database;
    const { default: Sqlite } = await importOriginal<{ default: SqliteConstructor }>();
    return { default: class extends Sqlite { constructor(filename: string) { super(filename); state.connections.push(this); } } };
});

let directory: string;
beforeEach(() => { directory = mkdtempSync(path.join(tmpdir(), 'recomendarr-actions-')); state.databasePath = path.join(directory, 'test.db'); });
afterEach(() => { for (const db of state.connections) if (db.open) db.close(); state.connections.length = 0; rmSync(directory, { recursive: true, force: true }); });

async function setup() {
    vi.resetModules();
    const database = await import('../src/lib/database');
    const actions = await import('../src/lib/recommendation-actions');
    for (const [id, title] of [['one', 'One'], ['two', 'Two']]) database.addRecommendation({ id, title, mediaType: 'movie', source: 'tmdb', status: 'pending', genres: ['Drama'] });
    return { database, actions, db: database.getDatabase() };
}

async function setupIdentifiedRecommendation() {
    const result = await setup();
    result.database.addRecommendation({ id: 'identified', title: 'Identified', mediaType: 'movie', tmdbId: 42, imdbId: 'tt0042', source: 'tmdb', status: 'pending' });
    return result;
}

describe('shared recommendation actions', () => {
    it('keeps snooze neutral, reject explicit, watched positive, and pending clearing unchanged', async () => {
        const { actions, database } = await setup();
        const snoozed = actions.applyRecommendationAction('one', 'not_now');
        expect(snoozed).toMatchObject({ status: 'not_now', feedbackReason: null });
        expect(new Date(snoozed.snoozedUntil!).getTime()).toBeGreaterThan(Date.now() + 6 * 86400000);
        const rejected = actions.applyRecommendationAction('one', 'reject', { reason: 'wrong_mood', notes: 'Later' });
        expect(rejected).toMatchObject({ status: 'rejected', feedbackReason: 'wrong_mood', feedbackNotes: 'Later' });
        expect(actions.applyRecommendationAction('one', 'watched').status).toBe('watched');
        actions.applyRecommendationAction('two', 'watched');
        expect(database.getFeedbackProfile().preferredGenres).toContain('drama');
        expect(actions.applyRecommendationAction('one', 'pending')).toMatchObject({ status: 'pending', snoozedUntil: null, feedbackReason: null, feedbackNotes: null, feedbackAt: null });
    });

    it('restores mutable state only at the expected version and writes a fresh updatedAt', async () => {
        const { actions } = await setup();
        const previous = actions.applyRecommendationAction('one', 'reject', { reason: 'too_old', notes: 'Old' });
        const current = actions.applyRecommendationAction('one', 'not_now');
        const restored = actions.restoreRecommendationState('one', previous, current.updatedAt!);
        expect(restored).toMatchObject({ status: 'rejected', feedbackReason: 'too_old', feedbackNotes: 'Old', feedbackAt: previous.feedbackAt, snoozedUntil: previous.snoozedUntil });
        expect(restored.updatedAt).not.toBe(previous.updatedAt);
        expect(restored.updatedAt).not.toBe(current.updatedAt);
    });

    it('refuses a stale restore without changing newer state', async () => {
        const { actions } = await setup();
        const previous = actions.applyRecommendationAction('one', 'reject', { reason: 'too_old' });
        const target = actions.applyRecommendationAction('one', 'not_now');
        const newer = actions.applyRecommendationAction('one', 'watched');
        expect(() => actions.restoreRecommendationState('one', previous, target.updatedAt!)).toThrowError(expect.objectContaining({ code: 'VERSION_CONFLICT' }));
        expect(actions.getRecommendationActionState('one')).toEqual(newer);
    });

    it('gives rapid watched actions distinct versions so stale Undo is rejected', async () => {
        const { actions } = await setup();
        const previous = actions.getRecommendationActionState('one');
        const first = actions.applyRecommendationAction('one', 'watched');
        const second = actions.applyRecommendationAction('one', 'watched');
        expect(second.updatedAt).not.toBe(first.updatedAt);
        expect(() => actions.restoreRecommendationState('one', previous, first.updatedAt!)).toThrowError(expect.objectContaining({ code: 'VERSION_CONFLICT' }));
    });

    it('removes a manual watched record by stable identifier when Undo restores a non-watched state', async () => {
        const { actions, db } = await setupIdentifiedRecommendation();
        const previous = actions.getRecommendationActionState('identified');
        const watched = actions.applyRecommendationAction('identified', 'watched');
        db.prepare("UPDATE watched_media_state SET normalized_title = 'renamed elsewhere' WHERE tmdb_id = 42").run();

        const restored = actions.restoreRecommendationState('identified', previous, watched.updatedAt!);

        expect(restored.status).toBe('pending');
        expect(db.prepare("SELECT COUNT(*) AS count FROM watched_media_state WHERE source = 'manual' AND tmdb_id = 42").get())
            .toEqual({ count: 0 });
    });

    it('removes manual watched persistence on Return to queue but preserves media-server history', async () => {
        const { actions, database, db } = await setupIdentifiedRecommendation();
        actions.applyRecommendationAction('identified', 'watched');
        actions.applyRecommendationAction('identified', 'pending');
        expect(db.prepare("SELECT COUNT(*) AS count FROM watched_media_state WHERE tmdb_id = 42").get()).toEqual({ count: 0 });

        database.syncWatchedMediaState([{ title: 'Identified', mediaType: 'movie', tmdbId: 42, lastPlayedDate: '2026-09-20T10:00:00.000Z' }]);
        actions.applyRecommendationAction('identified', 'pending');

        expect(db.prepare("SELECT source FROM watched_media_state WHERE tmdb_id = 42").get()).toEqual({ source: 'media_server' });
    });

    it('preserves media-server provenance when Undo restores a watched recommendation', async () => {
        const { actions, database, db } = await setupIdentifiedRecommendation();
        database.syncWatchedMediaState([{ title: 'Identified', mediaType: 'movie', tmdbId: 42, lastPlayedDate: '2026-09-20T10:00:00.000Z' }]);
        const previous = actions.getRecommendationActionState('identified');
        const pending = actions.applyRecommendationAction('identified', 'pending');

        actions.restoreRecommendationState('identified', previous, pending.updatedAt!);

        expect(db.prepare("SELECT source FROM watched_media_state WHERE tmdb_id = 42").get()).toEqual({ source: 'media_server' });
    });

    it('restores a batch atomically only when every expected version matches', async () => {
        const { actions } = await setup();
        const previous = [actions.getRecommendationActionState('one'), actions.getRecommendationActionState('two')];
        const current = actions.applyBulkRecommendationAction(['one', 'two'], 'not_now');
        const restored = actions.restoreBulkRecommendationStates(previous.map((item, index) => ({ id: item.id!, previous: item, expectedUpdatedAt: current[index].updatedAt! })));
        expect(restored.map((item: { status: string }) => item.status)).toEqual(['pending', 'pending']);
        const moved = actions.applyBulkRecommendationAction(['one', 'two'], 'not_now');
        actions.applyRecommendationAction('two', 'watched');
        expect(() => actions.restoreBulkRecommendationStates(previous.map((item, index) => ({ id: item.id!, previous: item, expectedUpdatedAt: moved[index].updatedAt! })))).toThrowError(expect.objectContaining({ code: 'VERSION_CONFLICT' }));
        expect(actions.getRecommendationActionState('one').status).toBe('not_now');
    });

    it('de-duplicates bulk IDs, preserves request order, and rolls back if any row is missing', async () => {
        const { actions } = await setup();
        const rows = actions.applyBulkRecommendationAction(['two', 'one', 'two'], 'not_now');
        expect(rows.map((row: { id?: string }) => row.id)).toEqual(['two', 'one']);
        expect(rows.every((row: { status: string }) => row.status === 'not_now')).toBe(true);
        expect(() => actions.applyBulkRecommendationAction(['one', 'missing'], 'pending')).toThrow();
        expect(actions.getRecommendationActionState('one').status).toBe('not_now');
    });
});
