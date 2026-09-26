import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Recommendation, WatchedItem } from '../src/lib/types';

const state = vi.hoisted(() => ({
    databasePath: '',
    connections: [] as import('better-sqlite3').Database[],
}));

vi.mock('../src/lib/config', () => ({
    config: { database: { get path() { return state.databasePath; } } },
}));

vi.mock('better-sqlite3', async (importOriginal) => {
    const { default: Sqlite } = await importOriginal<typeof import('better-sqlite3')>();
    return {
        default: class extends Sqlite {
            constructor(filename: string) {
                super(filename);
                state.connections.push(this);
            }
        },
    };
});

let directory: string;

async function loadDatabaseModule() {
    vi.resetModules();
    return import('../src/lib/database');
}

async function startDatabase() {
    const database = await loadDatabaseModule();
    return { database, db: database.getDatabase() };
}

function recommendation(id: string, title: string, status: Recommendation['status'] = 'pending', genres = ['Drama']): Recommendation {
    return {
        id,
        title,
        mediaType: 'movie',
        tmdbId: Number(id.replace(/\D/g, '')) || undefined,
        genres,
        source: 'tmdb',
        status,
    };
}

beforeEach(() => {
    directory = mkdtempSync(path.join(tmpdir(), 'recomendarr-queues-'));
    state.databasePath = path.join(directory, 'test.db');
});

afterEach(() => {
    for (const db of state.connections) {
        if (db.open) db.close();
    }
    state.connections.length = 0;
    rmSync(directory, { recursive: true, force: true });
});

describe('Not now queue', () => {
    it('snoozes for seven days, clears feedback, and moves the item out of pending', async () => {
        const { database, db } = await startDatabase();
        database.addRecommendation(recommendation('rec-101', 'Arrival'));
        db.prepare(`
            UPDATE recommendations
            SET feedback_reason = 'wrong_mood', feedback_notes = 'Later', feedback_at = datetime('now')
            WHERE id = 'rec-101'
        `).run();

        expect(database.snoozeRecommendation('rec-101')).toBe(true);

        expect(database.getRecommendations('pending')).toEqual([]);
        const snoozed = database.getRecommendations('not_now');
        expect(snoozed).toHaveLength(1);
        expect(snoozed[0]).toMatchObject({
            id: 'rec-101',
            status: 'not_now',
            feedbackReason: null,
            feedbackNotes: null,
            feedbackAt: null,
        });
        expect(snoozed[0].snoozedUntil).toBeTruthy();
        const timing = db.prepare(`
            SELECT
                datetime(snoozed_until) > datetime('now', '+6 days') AS after_six_days,
                datetime(snoozed_until) <= datetime('now', '+7 days', '+1 minute') AS within_seven_days
            FROM recommendations WHERE id = 'rec-101'
        `).get() as { after_six_days: number; within_seven_days: number };
        expect(timing).toEqual({ after_six_days: 1, within_seven_days: 1 });
    });

    it('restores expired snoozes while leaving active snoozes alone', async () => {
        const { database, db } = await startDatabase();
        database.addRecommendation(recommendation('rec-201', 'Expired'));
        database.addRecommendation(recommendation('rec-202', 'Still Snoozed'));
        db.prepare("UPDATE recommendations SET status = 'not_now', snoozed_until = datetime('now', '-1 minute') WHERE id = 'rec-201'").run();
        db.prepare("UPDATE recommendations SET status = 'not_now', snoozed_until = datetime('now', '+1 day') WHERE id = 'rec-202'").run();

        expect(database.getRecommendations('pending').map(item => item.id)).toContain('rec-201');
        expect(database.getRecommendations('not_now').map(item => item.id)).toEqual(['rec-202']);
        expect(db.prepare("SELECT snoozed_until FROM recommendations WHERE id = 'rec-201'").get())
            .toEqual({ snoozed_until: null });
    });

    it('clears snooze and feedback fields when manually returned to pending', async () => {
        const { database, db } = await startDatabase();
        database.addRecommendation(recommendation('rec-301', 'Return Me'));
        database.snoozeRecommendation('rec-301');
        db.prepare("UPDATE recommendations SET feedback_reason = 'too_old', feedback_notes = 'No', feedback_at = datetime('now') WHERE id = 'rec-301'").run();

        expect(database.updateRecommendationStatus('rec-301', 'pending')).toBe(true);

        expect(db.prepare(`
            SELECT status, snoozed_until, feedback_reason, feedback_notes, feedback_at
            FROM recommendations WHERE id = 'rec-301'
        `).get()).toEqual({
            status: 'pending',
            snoozed_until: null,
            feedback_reason: null,
            feedback_notes: null,
            feedback_at: null,
        });
    });
});

describe('Watched queue and learning', () => {
    it('keeps Not now neutral while watched, added, and rejected retain their intended signals', async () => {
        const { database } = await startDatabase();
        database.addRecommendation(recommendation('rec-401', 'Watched One', 'watched', ['Drama']));
        database.addRecommendation(recommendation('rec-402', 'Watched Two', 'watched', ['Drama']));
        database.addRecommendation(recommendation('rec-403', 'Added One', 'added', ['Comedy']));
        database.addRecommendation(recommendation('rec-404', 'Added Two', 'added', ['Comedy']));
        database.addRecommendation(recommendation('rec-405', 'Rejected One', 'rejected', ['Horror']));
        database.addRecommendation(recommendation('rec-406', 'Rejected Two', 'rejected', ['Horror']));
        database.addRecommendation(recommendation('rec-407', 'Neutral One', 'not_now', ['Western']));
        database.addRecommendation(recommendation('rec-408', 'Neutral Two', 'not_now', ['Western']));

        const profile = database.getFeedbackProfile();

        expect(profile.preferredGenres).toEqual(expect.arrayContaining(['drama', 'comedy']));
        expect(profile.avoidedGenres).toContain('horror');
        expect(profile.preferredGenres).not.toContain('western');
        expect(profile.avoidedGenres).not.toContain('western');
        expect(profile.rejectedTitles).toEqual(expect.arrayContaining(['rejected one', 'rejected two']));
        expect(profile.rejectedTitles).not.toContain('neutral one');
        expect(profile.rejectedTitles).not.toContain('watched one');
    });

    it('synchronizes media-server history into the watched queue without negative feedback', async () => {
        const { database } = await startDatabase();
        database.addRecommendation(recommendation('rec-501', 'The Matrix', 'rejected'));
        const watched: WatchedItem[] = [{
            title: 'The Matrix',
            mediaType: 'movie',
            tmdbId: 501,
            lastPlayedDate: new Date().toISOString(),
        }];

        database.syncWatchedMediaState(watched);

        expect(database.getRecommendations('watched')[0]).toMatchObject({
            id: 'rec-501',
            status: 'watched',
            feedbackReason: null,
        });
        expect(database.getFeedbackProfile().rejectedTitles).not.toContain('the matrix');
    });

    it('manually marks an existing recommendation watched and clears prior feedback', async () => {
        const { database, db } = await startDatabase();
        database.addRecommendation(recommendation('rec-550', 'Manual History', 'rejected'));
        db.prepare("UPDATE recommendations SET feedback_reason = 'wrong_genre', feedback_notes = 'Old signal', feedback_at = datetime('now') WHERE id = 'rec-550'").run();

        expect(database.updateRecommendationStatus('rec-550', 'watched')).toBe(true);

        expect(database.getRecommendations('watched')[0]).toMatchObject({
            id: 'rec-550',
            feedbackReason: null,
            feedbackNotes: null,
            feedbackAt: null,
        });
        expect(database.getWatchedMediaSignalSets().titles).toContain('manual history');
    });

    it('adds a manually selected title to Watched and moves a duplicate instead of inserting it twice', async () => {
        const { database } = await startDatabase();
        database.addRecommendation(recommendation('rec-601', 'Existing Film', 'pending'));

        const saved = database.addWatchedRecommendation({
            ...recommendation('new-id', 'Existing Film', 'watched'),
            id: undefined,
            tmdbId: 601,
            imdbId: 'tt1234567',
        });

        expect(saved).toMatchObject({ id: 'rec-601', status: 'watched' });
        expect(database.getRecommendations('watched')).toHaveLength(1);
        expect(database.getRecommendationCounts()).toMatchObject({ not_now: 0, watched: 1 });
        expect(database.getWatchedMediaSignalSets()).toMatchObject({
            tmdbIds: new Set([601]),
            imdbIds: new Set(['tt1234567']),
            titles: new Set(['existing film']),
        });
    });
});

describe('queue schema migration', () => {
    it('preserves every existing recommendation column and converts legacy already-watched rejection', async () => {
        const legacy = new Database(state.databasePath);
        legacy.exec(`
            CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
            CREATE TABLE recommendations (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL,
                year INTEGER,
                language TEXT,
                media_type TEXT NOT NULL CHECK(media_type IN ('movie', 'series')),
                tmdb_id INTEGER,
                tvdb_id INTEGER,
                imdb_id TEXT,
                overview TEXT,
                poster_url TEXT,
                genres TEXT,
                vote_average REAL,
                source TEXT NOT NULL CHECK(source IN ('tmdb', 'ai')),
                ai_reasoning TEXT,
                based_on TEXT,
                feedback_reason TEXT,
                feedback_notes TEXT,
                feedback_at TEXT,
                status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'approved', 'rejected', 'added')),
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                updated_at TEXT NOT NULL DEFAULT (datetime('now'))
            );
            INSERT INTO recommendations (
                id, title, year, language, media_type, tmdb_id, tvdb_id, imdb_id,
                overview, poster_url, genres, vote_average, source, ai_reasoning,
                based_on, feedback_reason, feedback_notes, feedback_at, status,
                created_at, updated_at
            ) VALUES (
                'legacy-1', 'Lifetime Watch', 1999, 'en', 'movie', 603, 99, 'tt0133093',
                'Overview', '/poster.jpg', '["Action"]', 8.7, 'ai', 'Because',
                'Reference', 'already_watched', 'Seen years ago', '2020-01-01 00:00:00', 'rejected',
                '2020-01-02 00:00:00', '2020-01-03 00:00:00'
            );
        `);
        legacy.close();

        const { database, db } = await startDatabase();
        const migrated = database.getRecommendations('watched')[0];

        expect(migrated).toMatchObject({
            id: 'legacy-1',
            title: 'Lifetime Watch',
            year: 1999,
            language: 'en',
            mediaType: 'movie',
            tmdbId: 603,
            tvdbId: 99,
            imdbId: 'tt0133093',
            overview: 'Overview',
            posterUrl: '/poster.jpg',
            genres: ['Action'],
            voteAverage: 8.7,
            source: 'ai',
            aiReasoning: 'Because',
            basedOn: 'Reference',
            status: 'watched',
            feedbackReason: null,
            feedbackNotes: null,
            feedbackAt: null,
            createdAt: '2020-01-02 00:00:00',
        });
        expect(db.prepare("SELECT value FROM settings WHERE key = 'migration_add_not_now_queue_v1'").get())
            .toEqual({ value: 'true' });
        expect(db.prepare("SELECT value FROM settings WHERE key = 'migration_add_watched_media_state_v1'").get())
            .toEqual({ value: 'true' });
        expect(db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'recommendations'").get())
            .toMatchObject({ sql: expect.stringContaining("'not_now', 'watched'") });
    });
});
