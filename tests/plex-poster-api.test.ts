import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ get: vi.fn(), getConfig: vi.fn() }));
vi.mock('axios', () => ({ default: { get: mocks.get } }));
vi.mock('@/lib/config', () => ({ getConfig: mocks.getConfig }));

import { GET } from '../src/app/api/plex-poster/route';

describe('Plex poster proxy', () => {
    beforeEach(() => vi.clearAllMocks());

    it('uses the legacy Plex token when no media-server API key is stored', async () => {
        mocks.getConfig.mockReturnValue({ mediaServer: {
            type: 'plex', url: 'http://plex:32400', apiKey: '', plexToken: 'legacy-token',
        } });
        mocks.get.mockResolvedValue({ data: new Uint8Array([1]), headers: { 'content-type': 'image/jpeg' } });
        const request = { nextUrl: new URL('http://localhost/api/plex-poster?path=%2Flibrary%2Fmetadata%2F1%2Fthumb') };

        const response = await GET(request as never);

        expect(response.status).toBe(200);
        expect(mocks.get).toHaveBeenCalledWith('http://plex:32400/library/metadata/1/thumb', expect.objectContaining({
            headers: expect.objectContaining({ 'X-Plex-Token': 'legacy-token' }),
        }));
    });

    it('rejects external and traversal paths', async () => {
        mocks.getConfig.mockReturnValue({ mediaServer: { type: 'plex', url: 'http://plex', apiKey: 'token' } });
        for (const path of ['https://evil.test/a', '/../secret', '//evil.test/a']) {
            const response = await GET({ nextUrl: new URL(`http://localhost/api/plex-poster?path=${encodeURIComponent(path)}`) } as never);
            expect(response.status).toBe(400);
        }
        expect(mocks.get).not.toHaveBeenCalled();
    });
});
