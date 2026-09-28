import type Database from 'better-sqlite3';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import packageMetadata from '../../package.json';
import { config } from './config';
import { getAppliedMigrations, getDatabase, getRecentErrorLogRows } from './database';

export interface RuntimeMetadata {
    appVersion: string;
    gitCommit: string;
    nodeVersion: string;
    platform: string;
}

export interface DatabaseDiagnostics {
    reachable: boolean;
    sizeBytes: number | null;
    journalMode: string | null;
    resolvedPath: string;
    sanitizedPath: string;
    appliedMigrations: string[];
}

export interface RecentDiagnosticError {
    timestamp: string;
    source: string;
    message: string;
}

export type DiagnosticServiceState = 'connected' | 'failed' | 'testing' | 'not_tested' | 'unknown';

export interface DiagnosticServiceSummary {
    name: string;
    configured: boolean;
    latestState: DiagnosticServiceState;
}

export interface DiagnosticReportInput {
    runtime: RuntimeMetadata;
    database: Omit<DatabaseDiagnostics, 'resolvedPath'>;
    services: DiagnosticServiceSummary[];
    scheduler: { enabled: boolean; active: boolean };
    recentErrors: RecentDiagnosticError[];
}

interface RuntimeMetadataOptions {
    env?: Record<string, string | undefined>;
    readGitCommit?: () => string;
    appVersion?: string;
    nodeVersion?: string;
    platform?: string;
}

interface DatabaseDiagnosticsOptions {
    database?: Database.Database | null;
    databasePath?: string;
    statFile?: (filename: string) => { size: number };
}

const COMMIT_ENV_KEYS = ['RECOMENDARR_GIT_COMMIT', 'GIT_COMMIT', 'VERCEL_GIT_COMMIT_SHA'] as const;
const SECRET_KEY_PATTERN = /(?:x-plex-token|plex[_-]?token|sonarr[_-]?api[_-]?key|radarr[_-]?api[_-]?key|ai[_-]?api[_-]?key|tmdb[_-]?api[_-]?key|api[_-]?key|telegram[_-]?bot[_-]?token|telegram[_-]?chat[_-]?id|chat[_-]?id|password|passwd|secret|access[_-]?token|refresh[_-]?token|session[_-]?id)/i;

function normalizeCommit(value: string | undefined): string | null {
    const trimmed = value?.trim().toLowerCase() || '';
    return /^[a-f0-9]{7,64}$/.test(trimmed) ? trimmed.slice(0, 12) : null;
}

function readLocalGitCommit(): string {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
        encoding: 'utf8',
        timeout: 1500,
        windowsHide: true,
    });
}

export function getRuntimeMetadata(options: RuntimeMetadataOptions = {}): RuntimeMetadata {
    const env = options.env || process.env;
    let gitCommit: string | null = null;

    for (const key of COMMIT_ENV_KEYS) {
        gitCommit = normalizeCommit(env[key]);
        if (gitCommit) break;
    }

    if (!gitCommit) {
        try {
            gitCommit = normalizeCommit((options.readGitCommit || readLocalGitCommit)());
        } catch {
            gitCommit = null;
        }
    }

    return {
        appVersion: options.appVersion || packageMetadata.version,
        gitCommit: gitCommit || 'unknown',
        nodeVersion: options.nodeVersion || process.version,
        platform: options.platform || process.platform,
    };
}

export function sanitizeDatabasePath(databasePath: string): string {
    const normalized = databasePath.trim();
    const basename = normalized.split(/[\\/]/).filter(Boolean).at(-1) || 'recomendarr.db';
    if (/^[a-z]:[\\/]/i.test(normalized)) {
        return `${normalized.slice(0, 2)}\\...\\${basename}`;
    }
    if (normalized.startsWith('/')) {
        return `/.../${basename}`;
    }
    return `.../${basename}`;
}

export function getDatabaseDiagnostics(options: DatabaseDiagnosticsOptions = {}): DatabaseDiagnostics {
    const resolvedPath = options.databasePath || path.resolve(config.database.path);
    const statFile = options.statFile || fs.statSync;
    let sizeBytes: number | null = null;
    let reachable = false;
    let journalMode: string | null = null;
    let appliedMigrations: string[] = [];

    try {
        sizeBytes = statFile(resolvedPath).size;
    } catch {
        sizeBytes = null;
    }

    try {
        const database = options.database === undefined ? getDatabase() : options.database;
        if (database) {
            database.prepare('SELECT 1').get();
            const journal = database.pragma('journal_mode', { simple: true });
            journalMode = typeof journal === 'string' ? journal.toLowerCase() : null;
            appliedMigrations = getAppliedMigrations(database);
            reachable = true;
        }
    } catch {
        reachable = false;
        journalMode = null;
        appliedMigrations = [];
    }

    return {
        reachable,
        sizeBytes,
        journalMode,
        resolvedPath,
        sanitizedPath: sanitizeDatabasePath(resolvedPath),
        appliedMigrations,
    };
}

function redactUrl(value: string): string {
    try {
        const url = new URL(value);
        if (url.hostname.toLowerCase() === 'discord.com' && url.pathname.includes('/api/webhooks/')) {
            return `${url.origin}/api/webhooks/[REDACTED]`;
        }
        for (const key of [...url.searchParams.keys()]) {
            if (SECRET_KEY_PATTERN.test(key)) url.searchParams.set(key, '[REDACTED]');
        }
        if (url.username || url.password) {
            url.username = '[REDACTED]';
            url.password = '[REDACTED]';
        }
        return url.toString();
    } catch {
        return value;
    }
}

export function redactDiagnosticText(value: string): string {
    let redacted = value.replace(/https?:\/\/[^\s]+/gi, (url) => redactUrl(url));
    redacted = redacted.replace(/(authorization\s*[:=]\s*bearer\s+)[^\s,;]+/gi, '$1[REDACTED]');
    redacted = redacted.replace(/([a-z0-9_-]+\s*[:=]\s*)([^\s,;]+)/gi, (match, prefix: string, secret: string, offset: number, input: string) => {
        const key = prefix.split(/[:=]/, 1)[0];
        if (!SECRET_KEY_PATTERN.test(key)) return match;
        const before = input.slice(Math.max(0, offset - 16), offset).toLowerCase();
        if (before.endsWith('safe')) return match;
        return `${prefix}[REDACTED]`;
    });
    return redacted.replace(/\s+/g, ' ').trim();
}

export function getRecentDiagnosticErrors(database: Database.Database = getDatabase()): RecentDiagnosticError[] {
    return getRecentErrorLogRows(20, database).map((row) => ({
        timestamp: row.timestamp,
        source: row.source,
        message: redactDiagnosticText(row.message).slice(0, 300),
    }));
}

function formatBytes(bytes: number | null): string {
    if (bytes === null) return 'unknown';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function buildDiagnosticReport(input: DiagnosticReportInput): string {
    const lines = [
        'Recomendarr diagnostics',
        '',
        'Application',
        `Version: ${input.runtime.appVersion}`,
        `Git commit: ${input.runtime.gitCommit}`,
        `Node: ${input.runtime.nodeVersion}`,
        `Platform: ${input.runtime.platform}`,
        '',
        'Services',
        ...input.services.map((service) => `${service.name}: ${service.latestState} (${service.configured ? 'configured' : 'not configured'})`),
        '',
        'Scheduler',
        `Enabled: ${input.scheduler.enabled ? 'yes' : 'no'}`,
        `Active: ${input.scheduler.active ? 'yes' : 'no'}`,
        '',
        'Database',
        `Database reachable: ${input.database.reachable ? 'yes' : 'no'}`,
        `Database size: ${formatBytes(input.database.sizeBytes)}`,
        `Journal mode: ${input.database.journalMode?.toUpperCase() || 'unknown'}`,
        `Applied migrations: ${input.database.appliedMigrations.length}`,
        `Database path: ${input.database.sanitizedPath}`,
        '',
        'Applied migration keys',
        ...(input.database.appliedMigrations.length ? input.database.appliedMigrations : ['None']),
        '',
        'Recent errors',
        ...(input.recentErrors.length
            ? input.recentErrors.map((error) => `${error.timestamp} [${error.source}] ${error.message}`)
            : ['None']),
    ];
    return lines.join('\n');
}
