import Database from 'better-sqlite3';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDatabaseBackup } from '../src/lib/database-backup';

const tempDirectories: string[] = [];

afterEach(() => {
    while (tempDirectories.length) rmSync(tempDirectories.pop()!, { recursive: true, force: true });
});

describe('database backup helper', () => {
    it('awaits backup, then the full read, then deletion before resolving bytes', async () => {
        const calls: string[] = [];
        let releaseRead!: (value: Buffer) => void;
        const readPromise = new Promise<Buffer>((resolve) => { releaseRead = resolve; });
        const resultPromise = createDatabaseBackup({
            database: { backup: vi.fn(async () => { calls.push('backup'); }) },
            tempDirectory: 'C:\\temp', randomId: () => 'temporary-id',
            now: () => new Date('2026-09-27T01:02:03Z'),
            readFile: vi.fn(async () => { calls.push('read-start'); return readPromise; }),
            unlink: vi.fn(async () => { calls.push('unlink'); }),
        });

        await vi.waitFor(() => expect(calls).toEqual(['backup', 'read-start']));
        expect(calls).not.toContain('unlink');
        releaseRead(Buffer.from('complete snapshot'));

        const result = await resultPromise;
        expect(calls).toEqual(['backup', 'read-start', 'unlink']);
        expect(Buffer.from(result.bytes).toString()).toBe('complete snapshot');
        expect(result.filename).toBe('recomendarr-backup-2026-09-27_01-02-03.db');
    });

    it.each(['backup', 'read'])('cleans a partial temporary file after %s failure', async (stage) => {
        const unlink = vi.fn(async () => undefined);
        await expect(createDatabaseBackup({
            database: { backup: vi.fn(async () => { if (stage === 'backup') throw new Error('backup failed'); }) },
            tempDirectory: 'C:\\temp', randomId: () => 'temporary-id',
            now: () => new Date('2026-09-27T01:02:03Z'),
            readFile: vi.fn(async () => { if (stage === 'read') throw new Error('read failed'); return Buffer.from('unused'); }),
            unlink,
        })).rejects.toThrow(`${stage} failed`);
        expect(unlink).toHaveBeenCalledWith(expect.stringMatching(/temporary-id\.db$/));
    });

    it('retries cleanup after an unlink failure and does not return backup bytes', async () => {
        const unlink = vi.fn().mockRejectedValueOnce(new Error('file busy')).mockResolvedValueOnce(undefined);
        await expect(createDatabaseBackup({
            database: { backup: vi.fn(async () => undefined) },
            tempDirectory: 'C:\\temp', randomId: () => 'temporary-id',
            now: () => new Date('2026-09-27T01:02:03Z'),
            readFile: vi.fn(async () => Buffer.from('snapshot')), unlink,
        })).rejects.toThrow('file busy');
        expect(unlink).toHaveBeenCalledTimes(2);
    });

    it('ignores an already absent temporary file during failure cleanup', async () => {
        const missing = Object.assign(new Error('missing'), { code: 'ENOENT' });
        await expect(createDatabaseBackup({
            database: { backup: vi.fn(async () => { throw new Error('backup failed'); }) },
            tempDirectory: 'C:\\temp', randomId: () => 'temporary-id',
            now: () => new Date('2026-09-27T01:02:03Z'), readFile: vi.fn(),
            unlink: vi.fn(async () => { throw missing; }),
        })).rejects.toThrow('backup failed');
    });

    it('creates a valid consistent SQLite snapshot with the online backup API', async () => {
        const directory = mkdtempSync(path.join(os.tmpdir(), 'recomendarr-backup-test-'));
        tempDirectories.push(directory);
        const source = new Database(path.join(directory, 'source.db'));
        source.exec("CREATE TABLE proof (value TEXT NOT NULL); INSERT INTO proof VALUES ('snapshot-row');");

        const result = await createDatabaseBackup({
            database: source, tempDirectory: directory, randomId: () => 'temporary-id',
            now: () => new Date('2026-09-27T01:02:03Z'),
        });
        source.close();

        const downloadedPath = path.join(directory, 'downloaded.db');
        await import('node:fs/promises').then(({ writeFile }) => writeFile(downloadedPath, result.bytes));
        const downloaded = new Database(downloadedPath, { readonly: true });
        expect(downloaded.prepare('SELECT value FROM proof').pluck().get()).toBe('snapshot-row');
        downloaded.close();
        expect(() => readFileSync(path.join(directory, 'recomendarr-backup-temporary-id.db'))).toThrow();
    });
});
