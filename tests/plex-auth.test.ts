import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPlexAuthService } from '../src/lib/plex-auth';

const PIN = { id: 42, code: 'claim-code', expiresAt: '2099-01-01T00:00:00Z', authToken: null };

function harness(initial: Record<string, string> = {}) {
    const settings = { ...initial };
    const post = vi.fn();
    const get = vi.fn();
    const request = vi.fn();
    const service = createPlexAuthService({
        http: { post, get, request },
        getSettings: () => ({ ...settings }),
        saveSetting: (key, value) => { settings[key] = value; },
        saveSettings: (values) => Object.assign(settings, values),
        deleteSettings: (keys) => keys.forEach((key) => delete settings[key]),
        createId: vi.fn()
            .mockReturnValue('flow-id')
            .mockReturnValueOnce('installation-id'),
        now: () => new Date('2026-09-27T00:00:00Z'),
    });
    return { service, settings, post, get, request };
}

describe('Plex sign-in', () => {
    beforeEach(() => vi.clearAllMocks());

    it('creates a strong PIN with a stable installation identifier without exposing tokens', async () => {
        const h = harness();
        h.post.mockResolvedValue({ data: PIN });

        const first = await h.service.startPlexSignIn();
        const second = await h.service.startPlexSignIn();

        expect(h.settings.plex_client_identifier).toBe('installation-id');
        expect(h.post).toHaveBeenNthCalledWith(1, 'https://plex.tv/api/v2/pins', { strong: true }, {
            headers: expect.objectContaining({
                'X-Plex-Client-Identifier': 'installation-id',
                'X-Plex-Product': 'Recomendarr',
            }),
        });
        expect(first).toMatchObject({ flowId: 'flow-id', code: 'claim-code' });
        expect(first.authUrl).toContain('clientID=installation-id');
        expect(JSON.stringify(first)).not.toContain('Token');
        expect(h.settings.plex_client_identifier).toBe('installation-id');
        expect(second.flowId).toBeDefined();
    });

    it('reports pending until Plex claims the PIN', async () => {
        const h = harness({ plex_client_identifier: 'existing-id' });
        h.post.mockResolvedValue({ data: PIN });
        h.get.mockResolvedValue({ data: PIN });
        const started = await h.service.startPlexSignIn();

        await expect(h.service.pollPlexSignIn(started.flowId)).resolves.toEqual({ status: 'pending' });
    });

    it('normalizes claimed server resources without exposing account or server tokens', async () => {
        const h = harness({ plex_client_identifier: 'existing-id' });
        h.post.mockResolvedValue({ data: PIN });
        h.get
            .mockResolvedValueOnce({ data: { ...PIN, authToken: 'account-secret' } })
            .mockResolvedValueOnce({ data: [{
                name: 'Home', clientIdentifier: 'server-1', provides: 'server', owned: true,
                accessToken: 'server-secret', connections: [
                    { uri: 'http://remote:32400', local: false, relay: false },
                    { uri: 'https://local.plex.direct:32400', local: true, relay: false },
                ],
            }, { name: 'No token', clientIdentifier: 'server-2', provides: 'server', connections: [] }] });
        const started = await h.service.startPlexSignIn();

        const result = await h.service.pollPlexSignIn(started.flowId);

        expect(result).toEqual({
            status: 'servers',
            servers: [{ id: 'server-1', name: 'Home', owned: true, available: true }],
        });
        expect(JSON.stringify(result)).not.toContain('secret');
    });

    it('rejects unknown and expired flows safely', async () => {
        const h = harness({ plex_client_identifier: 'existing-id' });
        await expect(h.service.pollPlexSignIn('missing')).rejects.toThrow('expired');

        h.post.mockResolvedValue({ data: { ...PIN, expiresAt: '2020-01-01T00:00:00Z' } });
        const started = await h.service.startPlexSignIn();
        await expect(h.service.pollPlexSignIn(started.flowId)).rejects.toThrow('expired');
    });

    it('reports a claimed account with no usable media servers', async () => {
        const h = harness({ plex_client_identifier: 'existing-id' });
        h.post.mockResolvedValue({ data: PIN });
        h.get
            .mockResolvedValueOnce({ data: { ...PIN, authToken: 'account-secret' } })
            .mockResolvedValueOnce({ data: [] });
        const started = await h.service.startPlexSignIn();

        await expect(h.service.pollPlexSignIn(started.flowId)).resolves.toEqual({ status: 'no_servers' });
    });

    it('validates connection candidates in preferred order and saves the resource token', async () => {
        const h = harness({ plex_client_identifier: 'existing-id', unrelated: 'keep-me' });
        h.post.mockResolvedValue({ data: PIN });
        h.get
            .mockResolvedValueOnce({ data: { ...PIN, authToken: 'account-secret' } })
            .mockResolvedValueOnce({ data: [{
                name: 'Home', clientIdentifier: 'server-1', provides: 'server', owned: true,
                accessToken: 'server-secret', connections: [
                    { uri: 'http://remote:32400', local: false, relay: false },
                    { uri: 'https://remote:32400', local: false, relay: false },
                    { uri: 'https://local:32400', local: true, relay: false },
                ],
            }] });
        h.request
            .mockRejectedValueOnce(new Error('local unavailable'))
            .mockResolvedValueOnce({ data: { MediaContainer: { friendlyName: 'Home' } } });
        const started = await h.service.startPlexSignIn();
        await h.service.pollPlexSignIn(started.flowId);

        const selected = await h.service.selectPlexServer(started.flowId, 'server-1');

        expect(h.request.mock.calls.map((call) => call[0].url)).toEqual([
            'https://local:32400/',
            'https://remote:32400/',
        ]);
        expect(selected).toEqual({ connected: true, server: { id: 'server-1', name: 'Home', url: 'https://remote:32400' } });
        expect(h.settings).toMatchObject({
            media_server_type: 'plex', media_server_url: 'https://remote:32400',
            media_server_api_key: 'server-secret', plex_server_identifier: 'server-1', plex_server_name: 'Home',
            unrelated: 'keep-me',
        });
        expect(JSON.stringify(selected)).not.toContain('server-secret');
        await expect(h.service.pollPlexSignIn(started.flowId)).rejects.toThrow('expired');
    });

    it('rejects non-Plex connection responses and uses relay only as a last resort', async () => {
        const h = harness({ plex_client_identifier: 'existing-id' });
        h.post.mockResolvedValue({ data: PIN });
        h.get
            .mockResolvedValueOnce({ data: { ...PIN, authToken: 'account-secret' } })
            .mockResolvedValueOnce({ data: [{
                name: 'Shared', clientIdentifier: 'server-1', provides: 'server', owned: false,
                accessToken: 'server-secret', connections: [
                    { uri: 'https://relay:32400', local: false, relay: true },
                    { uri: 'http://direct:32400', local: false, relay: false },
                ],
            }] });
        h.request
            .mockResolvedValueOnce({ data: { status: 'ok' } })
            .mockResolvedValueOnce({ data: { MediaContainer: {} } });
        const started = await h.service.startPlexSignIn();
        await h.service.pollPlexSignIn(started.flowId);

        await h.service.selectPlexServer(started.flowId, 'server-1');

        expect(h.request.mock.calls.map((call) => call[0].url)).toEqual([
            'http://direct:32400/', 'https://relay:32400/',
        ]);
    });

    it('disconnects only Plex connection settings', async () => {
        const h = harness({
            media_server_type: 'plex', media_server_url: 'https://plex', media_server_api_key: 'secret',
            plex_server_identifier: 'id', plex_server_name: 'Home', plex_account_name: 'Person',
            sonarr_api_key: 'keep-me', plex_client_identifier: 'keep-client-id',
        });

        await h.service.disconnectPlex();

        expect(h.settings).toEqual({ sonarr_api_key: 'keep-me', plex_client_identifier: 'keep-client-id' });
    });
});
