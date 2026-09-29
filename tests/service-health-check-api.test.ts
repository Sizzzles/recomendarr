import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock('@/lib/service-health-check', () => ({ runPersistedServiceHealthCheck: mocks.run }));

import { POST } from '../src/app/api/service-health/check/route';

describe('POST /api/service-health/check', () => {
    it('returns only the sanitized health-check result with no-store caching', async () => {
        mocks.run.mockResolvedValue({
            results: [{ service: 'ai', state: 'failed', message: 'Configured key sk-...CF8A could not authenticate' }],
            summary: { healthy: 4, degraded: 0, failed: 1, disabled: 0, notConfigured: 0 },
        });
        const response = await POST();
        const serialized = JSON.stringify(await response.json());
        expect(response.status).toBe(200);
        expect(response.headers.get('cache-control')).toContain('no-store');
        expect(serialized).toContain('sk-...CF8A');
        expect(serialized).not.toContain('apiKey');
    });
});
