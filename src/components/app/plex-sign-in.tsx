'use client';

import { useCallback, useEffect, useReducer, useRef } from 'react';
import {
    initialPlexSignInState,
    getPlexPopupFeatures,
    reducePlexSignInState,
    type ConnectedPlexServer,
} from './plex-sign-in-model';
import { discoverConnectedPlexUsers, type DiscoveredPlexUser } from './plex-sign-in-client';

interface PlexSignInProps {
    onConnectionChange?: (server: ConnectedPlexServer | null, users?: DiscoveredPlexUser[]) => void;
    toast?: (message: string, type?: string) => void;
}

async function plexRequest(body?: Record<string, string>) {
    const response = await fetch('/api/plex-auth', body ? {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    } : undefined);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Plex sign-in failed');
    return data;
}

export function PlexSignIn({ onConnectionChange, toast }: PlexSignInProps) {
    const [state, dispatch] = useReducer(reducePlexSignInState, initialPlexSignInState);
    const popupRef = useRef<Window | null>(null);

    useEffect(() => {
        let active = true;
        plexRequest().then((data) => {
            if (!active || !data.connected || !data.server) return;
            dispatch({ type: 'connected', server: data.server });
            onConnectionChange?.(data.server);
        }).catch(() => undefined);
        return () => { active = false; };
    }, [onConnectionChange]);

    const fail = useCallback((error: unknown) => {
        const message = error instanceof Error ? error.message : 'Plex sign-in failed';
        dispatch({ type: 'failed', message });
        toast?.(message, 'error');
    }, [toast]);

    const start = async () => {
        dispatch({ type: 'start' });
        popupRef.current = window.open(
            'about:blank',
            'recomendarr-plex-auth',
            getPlexPopupFeatures(window.screen.availWidth, window.screen.availHeight)
        );
        if (!popupRef.current) {
            fail(new Error('Allow popups for Recomendarr, then try again.'));
            return;
        }
        try {
            const data = await plexRequest({ action: 'start' });
            popupRef.current.location.href = data.authUrl;
            dispatch({ type: 'started', flowId: data.flowId });
        } catch (error) {
            popupRef.current?.close();
            fail(error);
        }
    };

    useEffect(() => {
        if (state.status !== 'polling') return;
        let cancelled = false;
        const poll = async () => {
            try {
                const data = await plexRequest({ action: 'poll', flowId: state.flowId });
                if (cancelled) return;
                if (data.status === 'servers') {
                    popupRef.current?.close();
                    window.focus();
                    dispatch({ type: 'servers', servers: data.servers });
                }
                else if (data.status === 'no_servers') fail(new Error('No available Plex Media Server was found for this account.'));
                else if (popupRef.current?.closed) {
                    dispatch({ type: 'popup_closed' });
                    toast?.('Plex sign-in was closed before it finished.', 'error');
                }
            } catch (error) {
                if (!cancelled) fail(error);
            }
        };
        void poll();
        const timer = window.setInterval(poll, 1500);
        return () => { cancelled = true; window.clearInterval(timer); };
    }, [fail, state, toast]);

    useEffect(() => {
        if (state.status !== 'selecting') return;
        let cancelled = false;
        plexRequest({ action: 'select', flowId: state.flowId, serverId: state.serverId })
            .then(async (data) => {
                if (cancelled) return;
                popupRef.current?.close();
                window.focus();
                try {
                    const users = await discoverConnectedPlexUsers();
                    if (cancelled) return;
                    dispatch({ type: 'connected', server: data.server });
                    onConnectionChange?.(data.server, users);
                    toast?.(`Connected to ${data.server.name}`, 'success');
                } catch (error) {
                    if (cancelled) return;
                    dispatch({ type: 'connected', server: data.server });
                    onConnectionChange?.(data.server, []);
                    toast?.((error as Error).message, 'error');
                }
            })
            .catch((error) => { if (!cancelled) fail(error); });
        return () => { cancelled = true; };
    }, [fail, onConnectionChange, state, toast]);

    const disconnect = async () => {
        try {
            await plexRequest({ action: 'disconnect' });
            dispatch({ type: 'reset' });
            onConnectionChange?.(null);
            toast?.('Plex disconnected', 'success');
        } catch (error) { fail(error); }
    };

    return (
        <div className="plex-sign-in-card">
            {state.status === 'connected' ? (
                <>
                    <div><strong>Connected to {state.server.name}</strong></div>
                    <div className="plex-sign-in-actions">
                        <button type="button" className="btn btn-ghost btn-sm" onClick={start}>Change server</button>
                        <button type="button" className="btn btn-ghost btn-sm" onClick={disconnect}>Disconnect</button>
                    </div>
                </>
            ) : state.status === 'choosing' ? (
                <div className="plex-server-list">
                    <strong>Choose a Plex server</strong>
                    {state.servers.map((server) => (
                        <button key={server.id} type="button" className="btn btn-ghost" disabled={!server.available}
                            onClick={() => dispatch({ type: 'choose', serverId: server.id })}>
                            {server.name}{server.owned ? '' : ' (shared)'}
                        </button>
                    ))}
                </div>
            ) : (
                <>
                    <div>
                        <strong>Sign in with Plex</strong>
                        <small>Authorize Recomendarr, then choose one of your available Plex servers.</small>
                        {state.status === 'error' && <p className="plex-auth-error">{state.message}</p>}
                    </div>
                    <button type="button" className="btn btn-primary" onClick={start}
                        disabled={state.status === 'opening' || state.status === 'polling' || state.status === 'selecting'}>
                        {state.status === 'opening' ? 'Opening Plex...' : state.status === 'polling' ? 'Waiting for Plex...' : state.status === 'selecting' ? 'Connecting...' : state.status === 'error' ? 'Try again' : 'Sign in with Plex'}
                    </button>
                </>
            )}
        </div>
    );
}
