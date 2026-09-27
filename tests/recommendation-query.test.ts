import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseRecommendationQuery } from '../src/lib/recommendation-query';

const state = vi.hoisted(() => ({ databasePath: '', connections: [] as import('better-sqlite3').Database[] }));
vi.mock('../src/lib/config', () => ({
    config: { database: { get path() { return state.databasePath; } } },
}));
vi.mock('better-sqlite3', async (importOriginal) => {
    const { default: Sqlite } = await importOriginal<typeof import('better-sqlite3')>();
    return { default: class extends Sqlite {
        constructor(filename: string) { super(filename); state.connections.push(this); }
    } };
});

let directory: string;
beforeEach(() => {
    directory = mkdtempSync(path.join(tmpdir(), 'recomendarr-query-'));
    state.databasePath = path.join(directory, 'test.db');
});
afterEach(() => {
    for (const database of state.connections) if (database.open) database.close();
    state.connections.length = 0;
    rmSync(directory, { recursive: true, force: true });
});

describe('parseRecommendationQuery', () => {
    it('normalizes search, status, sort, limit, and offset', () => {
        const query = parseRecommendationQuery(new URLSearchParams({
            status: 'pending,nope,rejected', search: '  Arrival  ', sort: 'title', limit: '100', offset: '0',
        }));
        expect(query).toEqual({
            statuses: ['pending', 'rejected'], statusFilterPresent: true,
            search: 'Arrival', sort: 'title', limit: 100, offset: 0,
        });
    });

    it.each([
        [{ search: '   ' }, { search: undefined }],
        [{ sort: 'unknown' }, { sort: 'newest' }],
        [{ limit: '4.5' }, { limit: 50 }],
        [{ limit: '0' }, { limit: 50 }],
        [{ limit: '101' }, { limit: 50 }],
        [{ limit: 'wat' }, { limit: 50 }],
        [{ offset: '-1' }, { offset: 0 }],
        [{ offset: '2.2' }, { offset: 0 }],
        [{ offset: 'wat' }, { offset: 0 }],
    ])('uses safe defaults for %o', (input, expected) => {
        expect(parseRecommendationQuery(new URLSearchParams(input))).toMatchObject(expected);
    });

    it('distinguishes no status filter from an explicit filter with no valid statuses', () => {
        expect(parseRecommendationQuery(new URLSearchParams())).toMatchObject({
            statuses: [], statusFilterPresent: false,
        });
        expect(parseRecommendationQuery(new URLSearchParams({ status: 'bogus,' }))).toMatchObject({
            statuses: [], statusFilterPresent: true,
        });
    });
});

describe('database recommendation query', () => {
    it('searches case-insensitively before pagination and treats wildcards literally', async () => {
        vi.resetModules();
        const database = await import('../src/lib/database');
        for (let index = 0; index < 5; index += 1) {
            database.addRecommendation({
                id: `other-${index}`, title: `Other ${index}`, mediaType: 'movie', source: 'tmdb', status: 'pending',
            });
        }
        database.addRecommendation({ id: 'title', title: '  ARRIVAL  ', mediaType: 'movie', source: 'tmdb', status: 'pending' });
        database.addRecommendation({ id: 'overview', title: 'Overview match', overview: 'an arrival story', mediaType: 'movie', source: 'tmdb', status: 'pending' });
        database.addRecommendation({ id: 'percent', title: '100% Real', mediaType: 'movie', source: 'tmdb', status: 'pending' });
        database.addRecommendation({ id: 'under', title: 'A_B', mediaType: 'movie', source: 'tmdb', status: 'pending' });

        expect(database.getRecommendations({ statuses: ['pending'], statusFilterPresent: true, search: ' arrival ', sort: 'title', limit: 1, offset: 1 })[0].id)
            .toBe('overview');
        expect(database.getMatchingRecommendationCount({ statuses: ['pending'], statusFilterPresent: true, search: 'arrival', sort: 'newest', limit: 50, offset: 0 }))
            .toBe(2);
        expect(database.getRecommendations({ statuses: [], statusFilterPresent: false, search: '%', sort: 'title', limit: 50, offset: 0 }).map(item => item.id))
            .toEqual(['percent']);
        expect(database.getRecommendations({ statuses: [], statusFilterPresent: false, search: '_', sort: 'title', limit: 50, offset: 0 }).map(item => item.id))
            .toEqual(['under']);
    });

    it('supports every deterministic sort with null ratings last', async () => {
        vi.resetModules();
        const database = await import('../src/lib/database');
        const db = database.getDatabase();
        const insert = db.prepare(`INSERT INTO recommendations
            (id,title,year,media_type,vote_average,source,status,created_at,updated_at)
            VALUES (?,?,?,'movie',? ,?,'pending',?,?)`);
        insert.run('b', 'beta', 2020, null, 'tmdb', '2024-01-02', '2024-01-02');
        insert.run('a', 'Alpha', 2022, 8, 'ai', '2024-01-01', '2024-01-01');
        insert.run('c', 'alpha', 2021, 8, 'tmdb', '2024-01-03', '2024-01-03');
        const ids = (sort: 'newest' | 'oldest' | 'rating' | 'title' | 'source') => database.getRecommendations({
            statuses: ['pending'], statusFilterPresent: true, sort, limit: 50, offset: 0,
        }).map(item => item.id);
        expect(ids('newest')).toEqual(['c', 'b', 'a']);
        expect(ids('oldest')).toEqual(['a', 'b', 'c']);
        expect(ids('rating')).toEqual(['c', 'a', 'b']);
        expect(ids('title')).toEqual(['c', 'a', 'b']);
        expect(ids('source')).toEqual(['a', 'c', 'b']);
    });
});
