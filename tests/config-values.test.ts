import { describe, expect, it } from 'vitest';
import { resolveSecretOverride } from '../src/lib/config-values';

describe('secret setting overrides', () => {
    it('keeps the stored secret when any masked media-server value is submitted', () => {
        expect(resolveSecretOverride('••••oken', 'real-jellyfin-key')).toBe('real-jellyfin-key');
    });

    it('accepts a newly typed secret', () => {
        expect(resolveSecretOverride('new-key', 'old-key')).toBe('new-key');
    });
});
