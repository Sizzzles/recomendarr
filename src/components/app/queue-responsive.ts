export const QUEUE_DETAIL_OVERLAY_BREAKPOINT = 1320;

export function shouldUseQueueDetailOverlay(
    viewportWidth: number,
    breakpoint = QUEUE_DETAIL_OVERLAY_BREAKPOINT
): boolean {
    return viewportWidth < breakpoint;
}

export function getScrollLockPadding(viewportWidth: number, documentWidth: number): number {
    return Math.max(0, viewportWidth - documentWidth);
}

export function getDialogFocusWrapTarget(
    currentIndex: number,
    focusableCount: number,
    movingBackward: boolean
): number | null {
    if (focusableCount <= 0) return null;
    if (movingBackward && currentIndex === 0) return focusableCount - 1;
    if (!movingBackward && currentIndex === focusableCount - 1) return 0;
    return null;
}
