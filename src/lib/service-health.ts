import { freshDatabaseTimestamp, getDatabase } from './database';
import { redactDiagnosticText } from './diagnostics';
import type {
    CoreService, EffectiveServiceHealth, ServiceHealthObservation,
    ServiceHealthSource, StoredServiceHealthState,
} from './engine-observability-types';

const SERVICES: CoreService[] = ['media_server', 'tmdb', 'ai', 'sonarr', 'radarr'];
const DAY_MS = 24 * 60 * 60 * 1000;

interface HealthRow {
    service: CoreService; state: StoredServiceHealthState; checked_at: string;
    message: string | null; source: ServiceHealthSource; updated_at: string;
}

function sanitize(value: string): string {
    return redactDiagnosticText(value).replace(/\s+/g, ' ').trim().slice(0, 300);
}

function rowToObservation(row: HealthRow): ServiceHealthObservation {
    return { service: row.service, state: row.state, checkedAt: row.checked_at,
        message: row.message || '', source: row.source, updatedAt: row.updated_at };
}

export function recordServiceHealth(input: Omit<ServiceHealthObservation, 'updatedAt'>): ServiceHealthObservation {
    const updatedAt = freshDatabaseTimestamp();
    const message = sanitize(input.message);
    getDatabase().prepare(`INSERT INTO service_health (service, state, checked_at, message, source, updated_at)
        VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(service) DO UPDATE SET state = excluded.state,
        checked_at = excluded.checked_at, message = excluded.message, source = excluded.source,
        updated_at = excluded.updated_at`).run(input.service, input.state, input.checkedAt, message, input.source, updatedAt);
    return getServiceHealthObservations().find(item => item.service === input.service)!;
}

export function clearServiceHealth(service: CoreService): void {
    getDatabase().prepare('DELETE FROM service_health WHERE service = ?').run(service);
}

export function getServiceHealthObservations(): ServiceHealthObservation[] {
    return (getDatabase().prepare('SELECT * FROM service_health ORDER BY service').all() as HealthRow[]).map(rowToObservation);
}

function ageReason(observation: ServiceHealthObservation, ageMs: number): string {
    const days = Math.max(1, Math.floor(ageMs / DAY_MS));
    const description = observation.state === 'healthy' ? 'successful check' : 'check';
    return `Last ${description} ${days} day${days === 1 ? '' : 's'} ago`;
}

export function getEffectiveServiceHealth(input: {
    now?: string;
    configured: Record<CoreService, boolean>;
    disabled?: Partial<Record<CoreService, boolean>>;
}): EffectiveServiceHealth[] {
    const now = Date.parse(input.now || new Date().toISOString());
    const observations = new Map(getServiceHealthObservations().map(item => [item.service, item]));
    return SERVICES.map(service => {
        const observation = observations.get(service);
        const base = observation || { service, checkedAt: '', message: '', source: 'engine' as const, updatedAt: '' };
        if (input.disabled?.[service]) return { ...base, state: 'disabled', stale: false, reason: `${service === 'ai' ? 'AI' : service} is disabled` };
        if (!input.configured[service]) return { ...base, state: 'not_configured', stale: false, reason: 'Not configured' };
        if (!observation) return { ...base, state: 'unknown', stale: false, reason: 'Never checked' };
        const ageMs = Math.max(0, now - Date.parse(observation.checkedAt));
        if (ageMs > DAY_MS) return { ...observation, state: 'stale', stale: true, reason: ageReason(observation, ageMs) };
        return { ...observation, stale: false, reason: observation.message || (observation.state === 'healthy' ? 'Last query succeeded' : 'Last check failed') };
    });
}
