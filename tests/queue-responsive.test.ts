import { describe, expect, it } from 'vitest';
import {
    QUEUE_DETAIL_OVERLAY_BREAKPOINT,
    getDialogFocusWrapTarget,
    getScrollLockPadding,
    shouldUseQueueDetailOverlay,
} from '../src/components/app/queue-responsive';

describe('responsive Queue helpers', () => {
    it('uses the detail overlay below the responsive breakpoint', () => {
        expect(QUEUE_DETAIL_OVERLAY_BREAKPOINT).toBe(1320);
        expect(shouldUseQueueDetailOverlay(1920)).toBe(false);
        expect(shouldUseQueueDetailOverlay(1320)).toBe(false);
        expect(shouldUseQueueDetailOverlay(1319)).toBe(true);
        expect(shouldUseQueueDetailOverlay(1234)).toBe(true);
        expect(shouldUseQueueDetailOverlay(768)).toBe(true);
        expect(shouldUseQueueDetailOverlay(390)).toBe(true);
    });

    it('calculates scrollbar compensation without returning negative padding', () => {
        expect(getScrollLockPadding(1920, 1905)).toBe(15);
        expect(getScrollLockPadding(390, 390)).toBe(0);
        expect(getScrollLockPadding(375, 390)).toBe(0);
    });

    it('wraps keyboard focus at both ends of the dialog', () => {
        expect(getDialogFocusWrapTarget(0, 4, true)).toBe(3);
        expect(getDialogFocusWrapTarget(3, 4, false)).toBe(0);
        expect(getDialogFocusWrapTarget(1, 4, false)).toBeNull();
        expect(getDialogFocusWrapTarget(0, 0, true)).toBeNull();
    });
});
