export interface DiscoveredPlexUser {
    id: string;
    name: string;
}

type FetchLike = (input: string, init?: RequestInit) => Promise<{ ok: boolean; json(): Promise<unknown> }>;

export async function discoverConnectedPlexUsers(fetcher: FetchLike = fetch): Promise<DiscoveredPlexUser[]> {
    const response = await fetcher('/api/test-connection', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ service: 'mediaServer', settings: { media_server_type: 'plex' } }),
    });
    const data = await response.json() as { success?: boolean; users?: DiscoveredPlexUser[]; error?: string };
    if (!response.ok || !data.success) throw new Error(data.error || 'Plex connection test failed');
    return Array.isArray(data.users) ? data.users : [];
}
