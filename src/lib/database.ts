import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { config } from './config';
import type { FeedbackProfile, FeedbackReason, Recommendation, LogEntry, MediaType, RecommendationStatus, WatchedItem } from './types';
import type { RecommendationQuery } from './recommendation-query';

let db: Database.Database | null = null;

export function getDatabase(): Database.Database {
    if (db) {
        // If the DB file was externally deleted, reset the connection
        const dbPath = path.resolve(config.database.path);
        if (!fs.existsSync(dbPath)) {
            try { db.close(); } catch { /* ignore */ }
            db = null;
        } else {
            return db;
        }
    }

    const dbPath = path.resolve(config.database.path);
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }

    db = new Database(dbPath);
    db.pragma('busy_timeout = 5000');
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');

    initializeDatabase(db);
    runDatabaseMigrations(db);
    return db;
}

function initializeDatabase(db: Database.Database) {
    db.exec(`
    CREATE TABLE IF NOT EXISTS recommendations (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      year INTEGER,
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
      snoozed_until TEXT,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'approved', 'rejected', 'added', 'not_now', 'watched')),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      level TEXT NOT NULL CHECK(level IN ('INFO', 'WARN', 'ERROR', 'DEBUG')),
      message TEXT NOT NULL,
      source TEXT NOT NULL,
      timestamp TEXT NOT NULL DEFAULT (datetime('now')),
      details TEXT
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS watch_history_cache (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      media_type TEXT NOT NULL,
      tmdb_id INTEGER,
      tvdb_id INTEGER,
      imdb_id TEXT,
      last_played TEXT,
      cached_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS watched_media_state (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      normalized_title TEXT NOT NULL,
      media_type TEXT NOT NULL CHECK(media_type IN ('movie', 'series')),
      tmdb_id INTEGER,
      tvdb_id INTEGER,
      imdb_id TEXT,
      last_played TEXT,
      play_count INTEGER,
      source TEXT NOT NULL DEFAULT 'media_server',
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_recommendations_status ON recommendations(status);
    CREATE INDEX IF NOT EXISTS idx_recommendations_tmdb ON recommendations(tmdb_id);
    CREATE INDEX IF NOT EXISTS idx_logs_level ON logs(level);
    CREATE INDEX IF NOT EXISTS idx_logs_timestamp ON logs(timestamp);
    CREATE INDEX IF NOT EXISTS idx_watched_state_tmdb ON watched_media_state(tmdb_id);
    CREATE INDEX IF NOT EXISTS idx_watched_state_tvdb ON watched_media_state(tvdb_id);
    CREATE INDEX IF NOT EXISTS idx_watched_state_title ON watched_media_state(normalized_title);
  `);

    // Dynamic schema evolution for missing columns
    const tableInfo = db.pragma("table_info(recommendations)") as { name: string }[];
    const columns = tableInfo.map(col => col.name);

    if (!columns.includes('language')) {
        db.exec("ALTER TABLE recommendations ADD COLUMN language TEXT;");
    }
    if (!columns.includes('feedback_reason')) {
        db.exec("ALTER TABLE recommendations ADD COLUMN feedback_reason TEXT;");
    }
    if (!columns.includes('feedback_notes')) {
        db.exec("ALTER TABLE recommendations ADD COLUMN feedback_notes TEXT;");
    }
    if (!columns.includes('feedback_at')) {
        db.exec("ALTER TABLE recommendations ADD COLUMN feedback_at TEXT;");
    }
}

function runDatabaseMigrations(db: Database.Database) {
    runMigration(db, 'migration_cleanup_demo_library_v1', () => {
        db.prepare(
            `DELETE FROM recommendations
             WHERE status = 'added'
             AND title IN (?, ?)`
        ).run(
            'The Day the Earth Stood Still',
            'The Night Manager'
        );
    });

    runMigration(db, 'migration_add_not_now_queue_v1', () => {
        const tableInfo = db.pragma("table_info(recommendations)") as { name: string }[];
        if (!tableInfo.some(column => column.name === 'snoozed_until')) {
            db.exec('ALTER TABLE recommendations ADD COLUMN snoozed_until TEXT;');
        }

        const table = db.prepare(
            "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'recommendations'"
        ).get() as { sql?: string } | undefined;
        if (table?.sql?.includes("'not_now'") && table.sql.includes("'watched'")) {
            return;
        }

        db.exec(`
          CREATE TABLE recommendations_new (
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
            snoozed_until TEXT,
            status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'approved', 'rejected', 'added', 'not_now', 'watched')),
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at TEXT NOT NULL DEFAULT (datetime('now'))
          );

          INSERT INTO recommendations_new (
            id, title, year, language, media_type, tmdb_id, tvdb_id, imdb_id,
            overview, poster_url, genres, vote_average, source, ai_reasoning,
            based_on, feedback_reason, feedback_notes, feedback_at,
            snoozed_until, status, created_at, updated_at
          )
          SELECT
            id, title, year, language, media_type, tmdb_id, tvdb_id, imdb_id,
            overview, poster_url, genres, vote_average, source, ai_reasoning,
            based_on, feedback_reason, feedback_notes, feedback_at,
            snoozed_until, status, created_at, updated_at
          FROM recommendations;

          DROP TABLE recommendations;
          ALTER TABLE recommendations_new RENAME TO recommendations;
          CREATE INDEX IF NOT EXISTS idx_recommendations_status ON recommendations(status);
          CREATE INDEX IF NOT EXISTS idx_recommendations_tmdb ON recommendations(tmdb_id);
        `);
    });

    runMigration(db, 'migration_add_watched_media_state_v1', () => {
        db.prepare(`
            UPDATE recommendations
            SET status = 'watched',
                snoozed_until = NULL,
                feedback_reason = NULL,
                feedback_notes = NULL,
                feedback_at = NULL,
                updated_at = datetime('now')
            WHERE status = 'rejected' AND feedback_reason = 'already_watched'
        `).run();
    });
}

function runMigration(db: Database.Database, key: string, migration: () => void) {
    const transaction = db.transaction(() => {
        const completed = db.prepare(
            'SELECT value FROM settings WHERE key = ?'
        ).get(key) as { value: string } | undefined;

        if (completed?.value === 'true') {
            return;
        }

        migration();

        db.prepare(
            `INSERT INTO settings (key, value)
             VALUES (?, ?)
             ON CONFLICT(key)
             DO UPDATE SET value = excluded.value`
        ).run(key, 'true');
    });

    transaction.immediate();
}

function normalizeTitle(value: string): string {
    return value.trim().toLowerCase();
}

function watchedStateId(item: WatchedItem): string {
    if (item.tmdbId) return `tmdb:${item.mediaType}:${item.tmdbId}`;
    if (item.tvdbId) return `tvdb:${item.mediaType}:${item.tvdbId}`;
    if (item.imdbId) return `imdb:${item.mediaType}:${item.imdbId.toLowerCase()}`;
    return `title:${item.mediaType}:${normalizeTitle(item.title)}`;
}

function resetExpiredNotNowRecommendations(db: Database.Database) {
    db.prepare(`
        UPDATE recommendations
        SET status = 'pending', snoozed_until = NULL, updated_at = datetime('now')
        WHERE status = 'not_now'
          AND snoozed_until IS NOT NULL
          AND datetime(snoozed_until) <= datetime('now')
    `).run();
}

// ---- Recommendation CRUD ----

export function addRecommendation(rec: Recommendation): Recommendation {
    const db = getDatabase();
    const id = rec.id || crypto.randomUUID();

    // Check for duplicates by tmdb_id
    if (rec.tmdbId) {
        const existing = db.prepare(
            'SELECT id FROM recommendations WHERE tmdb_id = ? AND media_type = ?'
        ).get(rec.tmdbId, rec.mediaType) as { id: string } | undefined;
        if (existing) return { ...rec, id: existing.id };
    }

    db.prepare(`
    INSERT INTO recommendations (id, title, year, language, media_type, tmdb_id, tvdb_id, imdb_id, overview, poster_url, genres, vote_average, source, ai_reasoning, based_on, feedback_reason, feedback_notes, feedback_at, snoozed_until, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
        id, rec.title, rec.year || null, rec.language || null, rec.mediaType,
        rec.tmdbId || null, rec.tvdbId || null, rec.imdbId || null,
        rec.overview || null, rec.posterUrl || null,
        rec.genres ? JSON.stringify(rec.genres) : null,
        rec.voteAverage || null, rec.source,
        rec.aiReasoning || null, rec.basedOn || null,
        rec.feedbackReason || null, rec.feedbackNotes || null, rec.feedbackAt || null,
        rec.snoozedUntil || null,
        rec.status
    );

    return { ...rec, id };
}

function recommendationQueryParts(query: RecommendationQuery) {
    const clauses: string[] = [];
    const params: Array<string | number> = [];
    if (query.statusFilterPresent) {
        if (query.statuses.length === 0) clauses.push('0 = 1');
        else {
            clauses.push(`status IN (${query.statuses.map(() => '?').join(', ')})`);
            params.push(...query.statuses);
        }
    }
    if (query.search) {
        const escaped = query.search.replace(/[\\%_]/g, value => `\\${value}`);
        clauses.push(`(title LIKE ? ESCAPE '\\' COLLATE NOCASE
            OR overview LIKE ? ESCAPE '\\' COLLATE NOCASE
            OR ai_reasoning LIKE ? ESCAPE '\\' COLLATE NOCASE
            OR feedback_reason LIKE ? ESCAPE '\\' COLLATE NOCASE
            OR feedback_notes LIKE ? ESCAPE '\\' COLLATE NOCASE)`);
        params.push(...Array(5).fill(`%${escaped}%`));
    }
    return { where: clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '', params };
}

const recommendationOrder: Record<RecommendationQuery['sort'], string> = {
    newest: 'created_at DESC, id ASC',
    oldest: 'created_at ASC, id ASC',
    rating: 'vote_average IS NULL ASC, vote_average DESC, created_at DESC, id ASC',
    title: 'title COLLATE NOCASE ASC, year ASC, id ASC',
    source: 'source ASC, created_at DESC, id ASC',
};

export function getRecommendations(query: RecommendationQuery): Recommendation[];
export function getRecommendations(status?: RecommendationStatus | RecommendationStatus[], limit?: number, offset?: number): Recommendation[];
export function getRecommendations(statusOrQuery?: RecommendationStatus | RecommendationStatus[] | RecommendationQuery, limit = 50, offset = 0): Recommendation[] {
    const db = getDatabase();
    resetExpiredNotNowRecommendations(db);
    const normalized: RecommendationQuery = typeof statusOrQuery === 'object' && !Array.isArray(statusOrQuery)
        ? statusOrQuery
        : {
            statuses: Array.isArray(statusOrQuery) ? statusOrQuery.filter(Boolean) : statusOrQuery ? [statusOrQuery] : [],
            statusFilterPresent: Boolean(statusOrQuery), sort: 'newest', limit, offset,
        };
    const { where, params } = recommendationQueryParts(normalized);
    const sql = `SELECT * FROM recommendations${where} ORDER BY ${recommendationOrder[normalized.sort]} LIMIT ? OFFSET ?`;
    const rows = db.prepare(sql).all(...params, normalized.limit, normalized.offset) as Record<string, unknown>[];
    return rows.map(rowToRecommendation);
}

export function getMatchingRecommendationCount(query: RecommendationQuery): number {
    const database = getDatabase();
    resetExpiredNotNowRecommendations(database);
    const { where, params } = recommendationQueryParts(query);
    const row = database.prepare(`SELECT COUNT(*) AS count FROM recommendations${where}`).get(...params) as { count: number };
    return row.count;
}

export function updateRecommendationStatus(
    id: string,
    status: RecommendationStatus,
    feedback?: { reason?: FeedbackReason; notes?: string }
): boolean {
    const db = getDatabase();
    let result: Database.RunResult;

    if (status === 'rejected') {
        result = db.prepare(
            "UPDATE recommendations SET status = ?, snoozed_until = NULL, feedback_reason = ?, feedback_notes = ?, feedback_at = datetime('now'), updated_at = datetime('now') WHERE id = ?"
        ).run(status, feedback?.reason || null, feedback?.notes || null, id);
    } else if (status === 'pending') {
        result = db.prepare(
            "UPDATE recommendations SET status = ?, snoozed_until = NULL, feedback_reason = NULL, feedback_notes = NULL, feedback_at = NULL, updated_at = datetime('now') WHERE id = ?"
        ).run(status, id);
        db.prepare(`
            DELETE FROM watched_media_state
            WHERE source = 'manual'
              AND EXISTS (
                SELECT 1 FROM recommendations recommendation
                WHERE recommendation.id = ?
                  AND recommendation.media_type = watched_media_state.media_type
                  AND (
                    (recommendation.tmdb_id IS NOT NULL AND recommendation.tmdb_id = watched_media_state.tmdb_id)
                    OR (recommendation.tvdb_id IS NOT NULL AND recommendation.tvdb_id = watched_media_state.tvdb_id)
                    OR (recommendation.imdb_id IS NOT NULL AND lower(recommendation.imdb_id) = lower(watched_media_state.imdb_id))
                    OR lower(trim(recommendation.title)) = watched_media_state.normalized_title
                  )
              )
        `).run(id);
    } else if (status === 'watched') {
        result = db.prepare(
            "UPDATE recommendations SET status = ?, snoozed_until = NULL, feedback_reason = NULL, feedback_notes = NULL, feedback_at = NULL, updated_at = datetime('now') WHERE id = ?"
        ).run(status, id);
    } else {
        result = db.prepare(
            "UPDATE recommendations SET status = ?, updated_at = datetime('now') WHERE id = ?"
        ).run(status, id);
    }

    if (status === 'watched' && result.changes > 0) {
        const row = db.prepare('SELECT * FROM recommendations WHERE id = ?').get(id) as Record<string, unknown>;
        syncWatchedMediaState([rowToRecommendation(row)], 'manual');
    }

    return result.changes > 0;
}

export function snoozeRecommendation(id: string, days = 7): boolean {
    const db = getDatabase();
    const snoozeDays = Math.max(1, Math.min(365, Math.floor(days)));
    const result = db.prepare(`
        UPDATE recommendations
        SET status = 'not_now',
            snoozed_until = datetime('now', '+' || ? || ' days'),
            feedback_reason = NULL,
            feedback_notes = NULL,
            feedback_at = NULL,
            updated_at = datetime('now')
        WHERE id = ?
    `).run(snoozeDays, id);
    return result.changes > 0;
}

export function syncWatchedMediaState(items: WatchedItem[], source: 'media_server' | 'manual' = 'media_server'): void {
    const db = getDatabase();
    const upsert = db.prepare(`
        INSERT INTO watched_media_state (
          id, title, normalized_title, media_type, tmdb_id, tvdb_id, imdb_id,
          last_played, play_count, source, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
        ON CONFLICT(id) DO UPDATE SET
          title = excluded.title,
          normalized_title = excluded.normalized_title,
          tmdb_id = excluded.tmdb_id,
          tvdb_id = excluded.tvdb_id,
          imdb_id = excluded.imdb_id,
          last_played = excluded.last_played,
          play_count = excluded.play_count,
          source = excluded.source,
          updated_at = datetime('now')
    `);

    const transaction = db.transaction((watchedItems: WatchedItem[]) => {
        for (const item of watchedItems) {
            upsert.run(
                watchedStateId(item), item.title, normalizeTitle(item.title), item.mediaType,
                item.tmdbId || null, item.tvdbId || null, item.imdbId || null,
                item.lastPlayedDate || null, item.playCount || null, source
            );
        }

        db.prepare(`
            UPDATE recommendations
            SET status = 'watched',
                snoozed_until = NULL,
                feedback_reason = NULL,
                feedback_notes = NULL,
                feedback_at = NULL,
                updated_at = datetime('now')
            WHERE EXISTS (
                SELECT 1 FROM watched_media_state watched
                WHERE watched.media_type = recommendations.media_type
                  AND (
                    (recommendations.tmdb_id IS NOT NULL AND watched.tmdb_id = recommendations.tmdb_id)
                    OR (recommendations.tvdb_id IS NOT NULL AND watched.tvdb_id = recommendations.tvdb_id)
                    OR (recommendations.imdb_id IS NOT NULL AND lower(watched.imdb_id) = lower(recommendations.imdb_id))
                    OR watched.normalized_title = lower(trim(recommendations.title))
                  )
            )
        `).run();
    });
    transaction(items);
}

export function getWatchedMediaSignalSets(): {
    tmdbIds: Set<number>;
    tvdbIds: Set<number>;
    imdbIds: Set<string>;
    titles: Set<string>;
} {
    const db = getDatabase();
    const rows = db.prepare(`
        SELECT tmdb_id, tvdb_id, imdb_id, normalized_title
        FROM watched_media_state
    `).all() as Array<{
        tmdb_id: number | null;
        tvdb_id: number | null;
        imdb_id: string | null;
        normalized_title: string;
    }>;

    return {
        tmdbIds: new Set(rows.flatMap(row => row.tmdb_id ? [row.tmdb_id] : [])),
        tvdbIds: new Set(rows.flatMap(row => row.tvdb_id ? [row.tvdb_id] : [])),
        imdbIds: new Set(rows.flatMap(row => row.imdb_id ? [row.imdb_id.toLowerCase()] : [])),
        titles: new Set(rows.map(row => row.normalized_title)),
    };
}

export function addWatchedRecommendation(rec: Recommendation): Recommendation {
    const db = getDatabase();
    const existing = rec.tmdbId
        ? db.prepare('SELECT id FROM recommendations WHERE tmdb_id = ? AND media_type = ?').get(rec.tmdbId, rec.mediaType) as { id: string } | undefined
        : db.prepare('SELECT id FROM recommendations WHERE lower(title) = ? AND media_type = ?').get(normalizeTitle(rec.title), rec.mediaType) as { id: string } | undefined;

    if (existing) {
        db.prepare(`
            UPDATE recommendations
            SET status = 'watched',
                tvdb_id = COALESCE(?, tvdb_id),
                imdb_id = COALESCE(?, imdb_id),
                snoozed_until = NULL,
                feedback_reason = NULL,
                feedback_notes = NULL,
                feedback_at = NULL,
                updated_at = datetime('now')
            WHERE id = ?
        `).run(rec.tvdbId || null, rec.imdbId || null, existing.id);
        const saved = { ...rec, id: existing.id, status: 'watched' as const };
        syncWatchedMediaState([saved], 'manual');
        return saved;
    }

    const saved = addRecommendation({ ...rec, status: 'watched' });
    syncWatchedMediaState([saved], 'manual');
    return saved;
}

export function getRecommendationCounts(): Record<string, number> {
    const db = getDatabase();
    resetExpiredNotNowRecommendations(db);
    const rows = db.prepare(
        'SELECT status, COUNT(*) as count FROM recommendations GROUP BY status'
    ).all() as { status: string; count: number }[];

    const counts: Record<string, number> = { pending: 0, approved: 0, rejected: 0, added: 0, not_now: 0, watched: 0, total: 0 };
    for (const row of rows) {
        counts[row.status] = row.count;
        counts.total += row.count;
    }
    return counts;
}

function rowToRecommendation(row: Record<string, unknown>): Recommendation {
    return {
        id: row.id as string,
        title: row.title as string,
        year: row.year as number | undefined,
        language: row.language as string | undefined,
        mediaType: row.media_type as 'movie' | 'series',
        tmdbId: row.tmdb_id as number | undefined,
        tvdbId: row.tvdb_id as number | undefined,
        imdbId: row.imdb_id as string | undefined,
        overview: row.overview as string | undefined,
        posterUrl: row.poster_url as string | undefined,
        genres: row.genres ? JSON.parse(row.genres as string) : undefined,
        voteAverage: row.vote_average as number | undefined,
        source: row.source as 'tmdb' | 'ai',
        aiReasoning: row.ai_reasoning as string | undefined,
        basedOn: row.based_on as string | undefined,
        status: row.status as RecommendationStatus,
        snoozedUntil: row.snoozed_until as string | undefined,
        feedbackReason: row.feedback_reason as FeedbackReason | undefined,
        feedbackNotes: row.feedback_notes as string | undefined,
        feedbackAt: row.feedback_at as string | undefined,
        createdAt: row.created_at as string,
        updatedAt: row.updated_at as string,
    };
}

export function getRecommendationById(id: string): Recommendation | undefined {
    const row = getDatabase().prepare('SELECT * FROM recommendations WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return row ? rowToRecommendation(row) : undefined;
}

function topKeys<T extends string>(counts: Map<T, number>, minCount = 1): T[] {
    return Array.from(counts.entries())
        .filter(([, count]) => count >= minCount)
        .sort((a, b) => b[1] - a[1])
        .map(([key]) => key);
}

function pushMediaType(counts: Map<MediaType, number>, mediaType: MediaType) {
    counts.set(mediaType, (counts.get(mediaType) || 0) + 1);
}

export function getFeedbackProfile(limit = 200): FeedbackProfile {
    const db = getDatabase();
    const rows = db.prepare(`
        SELECT title, media_type, genres, status, feedback_reason
        FROM recommendations
        WHERE status IN ('rejected', 'added', 'watched')
        ORDER BY updated_at DESC
        LIMIT ?
    `).all(limit) as Array<{
        title: string;
        media_type: MediaType;
        genres: string | null;
        status: 'rejected' | 'added' | 'watched';
        feedback_reason: FeedbackReason | null;
    }>;

    const preferredGenres = new Map<string, number>();
    const avoidedGenres = new Map<string, number>();
    const preferredMediaTypes = new Map<MediaType, number>();
    const avoidedMediaTypes = new Map<MediaType, number>();
    const feedbackReasons = new Map<FeedbackReason, number>();
    const rejectedTitles = new Set<string>();

    for (const row of rows) {
        const genres = row.genres ? (JSON.parse(row.genres) as string[]) : [];
        // Roadmap: watched may later be separated from positive preference signals because
        // consumption does not necessarily imply liking. Preserve current learning for now.
        if (row.status === 'added' || row.status === 'watched') {
            pushMediaType(preferredMediaTypes, row.media_type);
            for (const genre of genres) {
                preferredGenres.set(genre.toLowerCase(), (preferredGenres.get(genre.toLowerCase()) || 0) + 1);
            }
            continue;
        }

        rejectedTitles.add(row.title.toLowerCase());
        pushMediaType(avoidedMediaTypes, row.media_type);
        for (const genre of genres) {
            avoidedGenres.set(genre.toLowerCase(), (avoidedGenres.get(genre.toLowerCase()) || 0) + 1);
        }
        if (row.feedback_reason) {
            feedbackReasons.set(row.feedback_reason, (feedbackReasons.get(row.feedback_reason) || 0) + 1);
        }
    }

    const feedbackReasonRecord: Partial<Record<FeedbackReason, number>> = {};
    for (const [reason, count] of feedbackReasons.entries()) {
        feedbackReasonRecord[reason] = count;
    }

    const preferredGenreList = topKeys(preferredGenres, 2);
    const avoidedGenreList = topKeys(avoidedGenres, 2);
    const preferredMediaTypeList = topKeys(preferredMediaTypes, 2);
    const avoidedMediaTypeList = topKeys(avoidedMediaTypes, 2);

    const summaryParts: string[] = [];
    if (preferredGenreList.length > 0) {
        summaryParts.push(`Positive feedback is strongest for ${preferredGenreList.slice(0, 3).join(', ')}.`);
    }
    if (avoidedGenreList.length > 0) {
        summaryParts.push(`Repeated rejection signal exists for ${avoidedGenreList.slice(0, 3).join(', ')}.`);
    }
    const dominantReason = Object.entries(feedbackReasonRecord).sort((a, b) => (b[1] || 0) - (a[1] || 0))[0];
    if (dominantReason) {
        summaryParts.push(`Most common rejection reason is ${dominantReason[0].replaceAll('_', ' ')}.`);
    }

    return {
        rejectedTitles: Array.from(rejectedTitles),
        preferredGenres: preferredGenreList,
        avoidedGenres: avoidedGenreList,
        preferredMediaTypes: preferredMediaTypeList,
        avoidedMediaTypes: avoidedMediaTypeList,
        feedbackReasons: feedbackReasonRecord,
        summary: summaryParts.join(' '),
    };
}

// ---- Logs ----

export function addLog(entry: Omit<LogEntry, 'id' | 'timestamp'>): void {
    const db = getDatabase();
    db.prepare(
        'INSERT INTO logs (level, message, source, details) VALUES (?, ?, ?, ?)'
    ).run(entry.level, entry.message, entry.source, entry.details || null);
}

export function getLogs(level?: string, limit = 100, offset = 0): LogEntry[] {
    const db = getDatabase();
    let query = 'SELECT * FROM logs';
    const params: (string | number)[] = [];

    if (level) {
        query += ' WHERE level = ?';
        params.push(level);
    }
    query += ' ORDER BY timestamp DESC LIMIT ? OFFSET ?';
    params.push(limit, offset);

    return db.prepare(query).all(...params) as LogEntry[];
}

export function clearLogs(): void {
    const db = getDatabase();
    db.prepare('DELETE FROM logs').run();
}

// ---- Settings ----

export function getSetting(key: string): string | null {
    const db = getDatabase();
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
    return row?.value ?? null;
}

export function setSetting(key: string, value: string): void {
    const db = getDatabase();
    db.prepare(
        'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = ?'
    ).run(key, value, value);
}

export function getAllSettings(): Record<string, string> {
    const db = getDatabase();
    const rows = db.prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[];
    const settings: Record<string, string> = {};
    for (const row of rows) {
        settings[row.key] = row.value;
    }
    return settings;
}
