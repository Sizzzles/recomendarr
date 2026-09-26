import axios, { type AxiosRequestConfig } from 'axios';
import { randomUUID } from 'crypto';
import { deleteSettings, getAllSavedSettings, saveSetting, saveSettings } from './config';

const PLEX_PIN_URL = 'https://plex.tv/api/v2/pins';
const PLEX_RESOURCES_URL = 'https://clients.plex.tv/api/v2/resources';
const PLEX_PRODUCT = 'Recomendarr';
const PLEX_VERSION = '3.0.1';

interface HttpClient {
    post(url: string, data?: unknown, config?: AxiosRequestConfig): Promise<{ data: unknown }>;
    get(url: string, config?: AxiosRequestConfig): Promise<{ data: unknown }>;
    request(config: AxiosRequestConfig): Promise<{ data: unknown }>;
}

interface PlexConnection {
    uri: string;
    local?: boolean;
    relay?: boolean;
}

interface PlexResource {
    name?: string;
    clientIdentifier?: string;
    provides?: string;
    owned?: boolean;
    accessToken?: string;
    connections?: PlexConnection[];
}

interface PendingFlow {
    pinId: number | string;
    code: string;
    expiresAt: number;
    resources?: Map<string, PlexResource>;
}

export interface PlexServerChoice {
    id: string;
    name: string;
    owned: boolean;
    available: boolean;
}

export interface PlexAuthDependencies {
    http: HttpClient;
    getSettings: () => Record<string, string>;
    saveSetting: (key: string, value: string) => void;
    saveSettings: (values: Record<string, string>) => void;
    deleteSettings: (keys: string[]) => void;
    createId: () => string;
    now: () => Date;
}

export class PlexAuthError extends Error {
    constructor(message: string, public readonly code: string, public readonly status = 400) {
        super(message);
        this.name = 'PlexAuthError';
    }
}

function clientHeaders(clientId: string, token?: string) {
    return {
        Accept: 'application/json',
        'X-Plex-Product': PLEX_PRODUCT,
        'X-Plex-Version': PLEX_VERSION,
        'X-Plex-Client-Identifier': clientId,
        ...(token ? { 'X-Plex-Token': token } : {}),
    };
}

function pinExpiry(data: Record<string, unknown>, now: number): number {
    if (typeof data.expiresAt === 'string') return new Date(data.expiresAt).getTime();
    if (typeof data.expiresIn === 'number') return now + data.expiresIn * 1000;
    return now + 5 * 60 * 1000;
}

function orderedConnections(connections: PlexConnection[] = []): PlexConnection[] {
    const rank = (connection: PlexConnection) => {
        if (connection.relay) return 4;
        const https = connection.uri.startsWith('https://');
        if (connection.local && https) return 0;
        if (!connection.local && https) return 1;
        if (connection.local) return 2;
        return 3;
    };
    return [...connections].filter((item) => /^https?:\/\//.test(item.uri)).sort((a, b) => rank(a) - rank(b));
}

export function createPlexAuthService(deps: PlexAuthDependencies) {
    const pending = new Map<string, PendingFlow>();

    function getClientId(): string {
        const existing = deps.getSettings().plex_client_identifier;
        if (existing) return existing;
        const created = deps.createId();
        deps.saveSetting('plex_client_identifier', created);
        return created;
    }

    function requireFlow(flowId: string): PendingFlow {
        const flow = pending.get(flowId);
        if (!flow || flow.expiresAt <= deps.now().getTime()) {
            if (flow) pending.delete(flowId);
            throw new PlexAuthError('Plex sign-in expired. Please start again.', 'expired', 410);
        }
        return flow;
    }

    return {
        async startPlexSignIn() {
            const clientId = getClientId();
            const response = await deps.http.post(PLEX_PIN_URL, { strong: true }, { headers: clientHeaders(clientId) });
            const data = response.data as Record<string, unknown>;
            if ((typeof data.id !== 'number' && typeof data.id !== 'string') || typeof data.code !== 'string') {
                throw new PlexAuthError('Plex returned an invalid sign-in response.', 'invalid_response', 502);
            }
            const flowId = deps.createId();
            pending.set(flowId, {
                pinId: data.id,
                code: data.code,
                expiresAt: pinExpiry(data, deps.now().getTime()),
            });
            const params = new URLSearchParams({
                clientID: clientId,
                code: data.code,
                'context[device][product]': PLEX_PRODUCT,
            });
            return {
                flowId,
                code: data.code,
                expiresAt: new Date(pending.get(flowId)!.expiresAt).toISOString(),
                authUrl: `https://app.plex.tv/auth/#!?${params.toString()}`,
            };
        },

        async pollPlexSignIn(flowId: string): Promise<
            { status: 'pending' } | { status: 'no_servers' } | { status: 'servers'; servers: PlexServerChoice[] }
        > {
            const flow = requireFlow(flowId);
            if (flow.resources) {
                return { status: 'servers', servers: [...flow.resources.values()].map(publicServer) };
            }
            const clientId = getClientId();
            const pinResponse = await deps.http.get(`${PLEX_PIN_URL}/${encodeURIComponent(String(flow.pinId))}`, {
                params: { code: flow.code },
                headers: clientHeaders(clientId),
            });
            const pin = pinResponse.data as Record<string, unknown>;
            if (typeof pin.authToken !== 'string' || !pin.authToken) return { status: 'pending' };

            const resourcesResponse = await deps.http.get(PLEX_RESOURCES_URL, {
                params: { includeHttps: 1, includeRelay: 1, includeIPv6: 1 },
                headers: clientHeaders(clientId, pin.authToken),
            });
            const resources = Array.isArray(resourcesResponse.data) ? resourcesResponse.data as PlexResource[] : [];
            const usable = resources.filter((resource) =>
                resource.provides?.split(',').includes('server') &&
                resource.clientIdentifier && resource.accessToken && Array.isArray(resource.connections)
            );
            flow.resources = new Map(usable.map((resource) => [resource.clientIdentifier!, resource]));
            if (flow.resources.size === 0) return { status: 'no_servers' };
            return { status: 'servers', servers: [...flow.resources.values()].map(publicServer) };
        },

        async selectPlexServer(flowId: string, serverId: string) {
            const flow = requireFlow(flowId);
            const resource = flow.resources?.get(serverId);
            if (!resource?.accessToken || !resource.clientIdentifier) {
                throw new PlexAuthError('That Plex server is not available for this sign-in.', 'server_not_found', 404);
            }
            for (const connection of orderedConnections(resource.connections)) {
                const url = connection.uri.replace(/\/$/, '');
                try {
                    const response = await deps.http.request({
                        method: 'GET', url: `${url}/`, timeout: 5000,
                        headers: clientHeaders(getClientId(), resource.accessToken),
                    });
                    if (!(response.data as { MediaContainer?: unknown })?.MediaContainer) continue;
                    deps.saveSettings({
                        media_server_type: 'plex',
                        media_server_url: url,
                        media_server_api_key: resource.accessToken,
                        plex_server_identifier: resource.clientIdentifier,
                        plex_server_name: resource.name || 'Plex Server',
                    });
                    pending.delete(flowId);
                    return {
                        connected: true,
                        server: { id: resource.clientIdentifier, name: resource.name || 'Plex Server', url },
                    };
                } catch {
                    // Try the next advertised connection.
                }
            }
            throw new PlexAuthError('Recomendarr could not reach that Plex server.', 'server_unreachable', 502);
        },

        async disconnectPlex() {
            deps.deleteSettings([
                'media_server_type', 'media_server_url', 'media_server_api_key', 'plex_token',
                'plex_server_identifier', 'plex_server_name', 'plex_account_name',
            ]);
            return { disconnected: true };
        },
    };
}

function publicServer(resource: PlexResource): PlexServerChoice {
    return {
        id: resource.clientIdentifier!,
        name: resource.name || 'Plex Server',
        owned: Boolean(resource.owned),
        available: orderedConnections(resource.connections).length > 0,
    };
}

const service = createPlexAuthService({
    http: axios,
    getSettings: getAllSavedSettings,
    saveSetting,
    saveSettings,
    deleteSettings,
    createId: randomUUID,
    now: () => new Date(),
});

export const startPlexSignIn = service.startPlexSignIn;
export const pollPlexSignIn = service.pollPlexSignIn;
export const selectPlexServer = service.selectPlexServer;
export const disconnectPlex = service.disconnectPlex;

export function getPlexConnectionState() {
    const settings = getAllSavedSettings();
    return {
        connected: settings.media_server_type === 'plex' && Boolean(settings.media_server_api_key && settings.media_server_url),
        server: settings.plex_server_identifier ? {
            id: settings.plex_server_identifier,
            name: settings.plex_server_name || 'Plex Server',
            url: settings.media_server_url,
        } : undefined,
        method: settings.plex_server_identifier ? 'plex_sign_in' : settings.media_server_api_key ? 'manual' : undefined,
    };
}
