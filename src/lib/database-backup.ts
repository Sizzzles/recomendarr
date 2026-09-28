import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { readFile, unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { getDatabase } from './database';

interface BackupDatabase {
    backup(destination: string): Promise<unknown>;
}

interface DatabaseBackupDependencies {
    database?: BackupDatabase | Database.Database;
    tempDirectory?: string;
    randomId?: () => string;
    now?: () => Date;
    readFile?: (filename: string) => Promise<Uint8Array>;
    unlink?: (filename: string) => Promise<void>;
}

export interface DatabaseBackupResult {
    bytes: Uint8Array;
    filename: string;
}

function timestamp(date: Date): string {
    return date.toISOString().slice(0, 19).replace('T', '_').replaceAll(':', '-');
}

function isMissingFile(error: unknown): boolean {
    return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

export async function createDatabaseBackup(dependencies: DatabaseBackupDependencies = {}): Promise<DatabaseBackupResult> {
    const database = dependencies.database || getDatabase();
    const readSnapshot = dependencies.readFile || readFile;
    const removeSnapshot = dependencies.unlink || unlink;
    const temporaryPath = path.join(
        dependencies.tempDirectory || os.tmpdir(),
        `recomendarr-backup-${(dependencies.randomId || randomUUID)()}.db`,
    );
    const filename = `recomendarr-backup-${timestamp((dependencies.now || (() => new Date()))())}.db`;
    let removed = false;

    try {
        await database.backup(temporaryPath);
        const bytes = await readSnapshot(temporaryPath);
        await removeSnapshot(temporaryPath);
        removed = true;
        return { bytes, filename };
    } finally {
        if (!removed) {
            try {
                await removeSnapshot(temporaryPath);
            } catch (error) {
                if (!isMissingFile(error)) throw error;
            }
        }
    }
}
