export interface PlexServerOption {
    id: string;
    name: string;
    owned: boolean;
    available: boolean;
}

export interface ConnectedPlexServer {
    id: string;
    name: string;
    url: string;
}

export type PlexSignInState =
    | { status: 'idle' }
    | { status: 'opening' }
    | { status: 'polling'; flowId: string }
    | { status: 'choosing'; flowId: string; servers: PlexServerOption[] }
    | { status: 'selecting'; flowId: string; serverId: string }
    | { status: 'connected'; server: ConnectedPlexServer }
    | { status: 'error'; message: string };

export type PlexSignInEvent =
    | { type: 'start' }
    | { type: 'started'; flowId: string }
    | { type: 'servers'; servers: PlexServerOption[] }
    | { type: 'choose'; serverId: string }
    | { type: 'connected'; server: ConnectedPlexServer }
    | { type: 'failed'; message: string; token?: string }
    | { type: 'reset' };

export const initialPlexSignInState: PlexSignInState = { status: 'idle' };

export function reducePlexSignInState(state: PlexSignInState, event: PlexSignInEvent): PlexSignInState {
    switch (event.type) {
        case 'start': return { status: 'opening' };
        case 'started': return { status: 'polling', flowId: event.flowId };
        case 'servers': {
            const flowId = 'flowId' in state ? state.flowId : '';
            if (event.servers.length === 1) return { status: 'selecting', flowId, serverId: event.servers[0].id };
            return { status: 'choosing', flowId, servers: event.servers };
        }
        case 'choose': {
            const flowId = 'flowId' in state ? state.flowId : '';
            return { status: 'selecting', flowId, serverId: event.serverId };
        }
        case 'connected': return { status: 'connected', server: event.server };
        case 'failed': return { status: 'error', message: event.message };
        case 'reset': return initialPlexSignInState;
    }
}
