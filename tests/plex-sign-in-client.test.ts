import { describe, expect, it, vi } from 'vitest';
import { discoverConnectedPlexUsers } from '../src/components/app/plex-sign-in-client';

describe('automatic Plex connection discovery', () => {
    it('tests the stored Plex connection and returns discovered users', async () => {
        const fetcher = vi.fn().mockResolvedValue({
            ok: true,
            json: async () => ({ success: true, users: [{ id: '1', name: 'Primary User' }] }),
        });

        const users = await discoverConnectedPlexUsers(fetcher as never);

        expect(users).toEqual([{ id: '1', name: 'Primary User' }]);
        expect(fetcher).toHaveBeenCalledWith('/api/test-connection', expect.objectContaining({
            method: 'POST',
            body: JSON.stringify({ service: 'mediaServer', settings: { media_server_type: 'plex' } }),
        }));
    });
});
