import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MediaServerConfig } from '../src/lib/types';

const mocks = vi.hoisted(() => ({
    create: vi.fn(),
    get: vi.fn(),
    addLog: vi.fn(),
}));

vi.mock('axios', () => ({
    default: { create: mocks.create },
}));

vi.mock('../src/lib/database', () => ({
    addLog: mocks.addLog,
}));

import { createMediaServerConnector } from '../src/lib/media-server';

function plexConfig(overrides: Partial<MediaServerConfig> = {}): MediaServerConfig {
    return {
        type: 'plex',
        url: 'http://plex:32400',
        apiKey: 'settings-token',
        plexToken: 'environment-token',
        userId: '',
        ...overrides,
    };
}

beforeEach(() => {
    vi.clearAllMocks();
    mocks.create.mockReturnValue({ get: mocks.get });
});

describe('Plex connector authentication', () => {
    it('uses apiKey ahead of plexToken in Axios headers', () => {
        createMediaServerConnector(plexConfig());

        expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({
            headers: expect.objectContaining({ 'X-Plex-Token': 'settings-token' }),
        }));
    });

    it('falls back to plexToken when apiKey is empty', () => {
        createMediaServerConnector(plexConfig({ apiKey: '' }));

        expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({
            headers: expect.objectContaining({ 'X-Plex-Token': 'environment-token' }),
        }));
    });

    it('uses a token-free server-side proxy for poster URLs', async () => {
        mocks.get
            .mockResolvedValueOnce({
                data: { MediaContainer: { Directory: [{ key: '1', type: 'movie', title: 'Movies' }] } },
            })
            .mockResolvedValueOnce({
                data: { MediaContainer: { Metadata: [{ title: 'Arrival', thumb: '/library/metadata/1/thumb' }] } },
            });

        const items = await createMediaServerConnector(plexConfig()).getWatchHistory();

        expect(items[0].posterUrl).toBe('/api/plex-poster?path=%2Flibrary%2Fmetadata%2F1%2Fthumb');
        expect(items[0].posterUrl).not.toContain('settings-token');
    });
});

describe('Plex connection validation', () => {
    it('accepts a response containing MediaContainer', async () => {
        mocks.get.mockResolvedValue({ data: { MediaContainer: { friendlyName: 'Living Room' } } });

        await expect(createMediaServerConnector(plexConfig()).testConnection()).resolves.toBe(true);
    });

    it.each([
        ['missing response data', undefined],
        ['an empty response body', {}],
        ['a non-Plex response body', { status: 'ok' }],
    ])('rejects %s', async (_description, data) => {
        mocks.get.mockResolvedValue({ data });

        await expect(createMediaServerConnector(plexConfig()).testConnection()).resolves.toBe(false);
        expect(mocks.addLog).toHaveBeenCalledWith(expect.objectContaining({
            level: 'ERROR',
            source: 'plex',
        }));
    });
});

describe('Plex watched-history mapping', () => {
    it('uses a series title when Plex returns recently viewed episode metadata', async () => {
        mocks.get
            .mockResolvedValueOnce({
                data: { MediaContainer: { Directory: [{ key: '2', type: 'show', title: 'TV' }] } },
            })
            .mockResolvedValueOnce({
                data: {
                    MediaContainer: {
                        Metadata: [{
                            title: 'Pilot',
                            grandparentTitle: 'Twin Peaks',
                            year: 1990,
                            lastViewedAt: 1_700_000_000,
                        }],
                    },
                },
            });

        const items = await createMediaServerConnector(plexConfig()).getWatchHistory();

        expect(items[0]).toMatchObject({ title: 'Twin Peaks', mediaType: 'series' });
    });
});
