import Database from 'better-sqlite3';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ createDatabaseBackup: vi.fn() }));
vi.mock('../src/lib/database-backup', () => ({ createDatabaseBackup: mocks.createDatabaseBackup }));
vi.mock('@/lib/database-backup', () => ({ createDatabaseBackup: mocks.createDatabaseBackup }));

import { POST } from '../src/app/api/database-backup/route';

let directory: string;
let validDatabaseBytes: Buffer;

beforeAll(() => {
    directory = mkdtempSync(path.join(os.tmpdir(), 'recomendarr-backup-api-'));
    const databasePath = path.join(directory, 'valid.db');
    const database = new Database(databasePath);
    database.exec("CREATE TABLE proof (value TEXT NOT NULL); INSERT INTO proof VALUES ('route-row');");
    database.close();
    validDatabaseBytes = readFileSync(databasePath);
});
afterAll(() => rmSync(directory, { recursive: true, force: true }));
beforeEach(() => {
    vi.clearAllMocks();
    mocks.createDatabaseBackup.mockResolvedValue({
        bytes: validDatabaseBytes,
        filename: 'recomendarr-backup-2026-09-27_01-02-03.db',
    });
});

describe('database backup API', () => {
    it('returns a valid SQLite download with safe private headers', async () => {
        const response = await POST();
        const downloadedPath = path.join(directory, 'response.db');
        writeFileSync(downloadedPath, Buffer.from(await response.arrayBuffer()));
        const downloaded = new Database(downloadedPath, { readonly: true });

        expect(downloaded.prepare('SELECT value FROM proof').pluck().get()).toBe('route-row');
        downloaded.close();
        expect(response.headers.get('content-type')).toBe('application/vnd.sqlite3');
        expect(response.headers.get('content-disposition')).toBe('attachment; filename="recomendarr-backup-2026-09-27_01-02-03.db"');
        expect(response.headers.get('cache-control')).toBe('no-store');
        expect(JSON.stringify(Object.fromEntries(response.headers))).not.toMatch(/(?:\\|\/)tmp|db-wal|db-shm/i);
    });

    it('returns a generic no-store failure without paths or upstream details', async () => {
        mocks.createDatabaseBackup.mockRejectedValue(new Error('C:\\secret\\recomendarr.db is locked'));
        const response = await POST();
        const body = await response.json();

        expect(response.status).toBe(500);
        expect(response.headers.get('cache-control')).toBe('no-store');
        expect(body).toEqual({ error: 'Unable to create database backup' });
        expect(JSON.stringify(body)).not.toContain('C:\\secret');
    });
});
