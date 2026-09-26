import { beforeEach, describe, expect, it, vi } from 'vitest';

const auth = vi.hoisted(() => ({
    startPlexSignIn: vi.fn(), pollPlexSignIn: vi.fn(), selectPlexServer: vi.fn(),
    disconnectPlex: vi.fn(), getPlexConnectionState: vi.fn(),
}));

vi.mock('../src/lib/plex-auth', () => ({ ...auth,
    PlexAuthError: class PlexAuthError extends Error {
        constructor(message: string, public code: string, public status = 400) { super(message); }
    },
}));
vi.mock('@/lib/plex-auth', () => ({ ...auth,
    PlexAuthError: class PlexAuthError extends Error {
        constructor(message: string, public code: string, public status = 400) { super(message); }
    },
}));

import { GET, POST } from '../src/app/api/plex-auth/route';

function request(body: unknown) {
    return new Request('http://localhost/api/plex-auth', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
}

describe('Plex auth API', () => {
    beforeEach(() => vi.clearAllMocks());

    it('returns only public connection state', async () => {
        auth.getPlexConnectionState.mockReturnValue({ connected: true, server: { id: 'one', name: 'Home', url: 'https://plex' } });
        const response = await GET();
        expect(await response.json()).toEqual({ connected: true, server: { id: 'one', name: 'Home', url: 'https://plex' } });
    });

    it.each([
        ['start', {}, 'startPlexSignIn'],
        ['poll', { flowId: 'flow' }, 'pollPlexSignIn'],
        ['select', { flowId: 'flow', serverId: 'server' }, 'selectPlexServer'],
        ['disconnect', {}, 'disconnectPlex'],
    ])('dispatches %s without exposing returned secret properties', async (action, values, method) => {
        auth[method as keyof typeof auth].mockResolvedValue({ ok: true, token: undefined });
        const response = await POST(request({ action, ...values }));
        const body = await response.text();
        expect(response.status).toBe(200);
        expect(body).not.toContain('secret-token');
    });

    it.each([
        [{}, 400],
        [{ action: 'unknown' }, 400],
        [{ action: 'poll' }, 400],
        [{ action: 'select', flowId: 'flow' }, 400],
    ])('rejects malformed action input', async (body, status) => {
        const response = await POST(request(body));
        expect(response.status).toBe(status);
    });

    it('maps safe Plex auth errors without serializing attached secrets', async () => {
        const { PlexAuthError } = await import('@/lib/plex-auth');
        const error = new PlexAuthError('Sign-in expired', 'expired', 410) as Error & { token?: string };
        error.token = 'secret-token';
        auth.pollPlexSignIn.mockRejectedValue(error);

        const response = await POST(request({ action: 'poll', flowId: 'flow' }));
        const body = await response.text();
        expect(response.status).toBe(410);
        expect(JSON.parse(body)).toEqual({ error: 'Sign-in expired', code: 'expired' });
        expect(body).not.toContain('secret-token');
    });
});
