import { describe, expect, it } from 'vitest';
import { initialPlexSignInState, reducePlexSignInState } from '../src/components/app/plex-sign-in-model';

const home = { id: 'home', name: 'Home', owned: true, available: true };
const shared = { id: 'shared', name: 'Shared', owned: false, available: true };

describe('Plex sign-in UI state', () => {
    it('moves from idle through opening and polling', () => {
        const opening = reducePlexSignInState(initialPlexSignInState, { type: 'start' });
        expect(opening).toEqual({ status: 'opening' });
        expect(reducePlexSignInState(opening, { type: 'started', flowId: 'flow' })).toEqual({
            status: 'polling', flowId: 'flow',
        });
    });

    it('automatically selects the only discovered server', () => {
        const state = reducePlexSignInState({ status: 'polling', flowId: 'flow' }, {
            type: 'servers', servers: [home],
        });
        expect(state).toEqual({ status: 'selecting', flowId: 'flow', serverId: 'home' });
    });

    it('asks the user to choose when several servers are discovered', () => {
        const state = reducePlexSignInState({ status: 'polling', flowId: 'flow' }, {
            type: 'servers', servers: [home, shared],
        });
        expect(state).toEqual({ status: 'choosing', flowId: 'flow', servers: [home, shared] });
    });

    it('represents a connected server', () => {
        const state = reducePlexSignInState(initialPlexSignInState, {
            type: 'connected', server: { id: 'home', name: 'Home', url: 'https://plex' },
        });
        expect(state.status).toBe('connected');
    });

    it('makes expiry retryable and ignores secret-shaped error properties', () => {
        const state = reducePlexSignInState({ status: 'polling', flowId: 'flow' }, {
            type: 'failed', message: 'Plex sign-in expired', token: 'do-not-render',
        });
        expect(state).toEqual({ status: 'error', message: 'Plex sign-in expired' });
        expect(JSON.stringify(state)).not.toContain('do-not-render');
        expect(reducePlexSignInState(state, { type: 'reset' })).toEqual(initialPlexSignInState);
    });
});
