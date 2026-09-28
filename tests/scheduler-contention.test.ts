import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    addLog: vi.fn(),
    getIsRunning: vi.fn(),
    runRecommendationEngine: vi.fn(),
}));

vi.mock('../src/lib/database', () => ({ addLog: mocks.addLog }));
vi.mock('../src/lib/engine', () => ({
    getIsRunning: mocks.getIsRunning,
    runRecommendationEngine: mocks.runRecommendationEngine,
}));
vi.mock('../src/lib/config', () => ({
    getConfig: () => ({ scheduler: { enabled: true, cronSchedule: '0 * * * *', autoAdd: false } }),
}));

describe('scheduled engine contention', () => {
    beforeEach(() => vi.clearAllMocks());

    it('returns a clear skip when the in-memory guard already sees an active run', async () => {
        mocks.getIsRunning.mockReturnValue(true);
        const { runScheduledRecommendation } = await import('../src/lib/scheduler');
        await expect(runScheduledRecommendation()).resolves.toEqual({ started: false, reason: 'already_running' });
        expect(mocks.runRecommendationEngine).not.toHaveBeenCalled();
        expect(mocks.addLog).toHaveBeenCalledWith(expect.objectContaining({ level: 'WARN', message: expect.stringMatching(/skipped.*already running/i) }));
    });

    it('handles the durable active-run race as a skip instead of rejecting', async () => {
        mocks.getIsRunning.mockReturnValue(false);
        mocks.runRecommendationEngine.mockRejectedValue(new Error('An engine run is already running'));
        const { runScheduledRecommendation } = await import('../src/lib/scheduler');
        await expect(runScheduledRecommendation()).resolves.toEqual({ started: false, reason: 'already_running' });
        expect(mocks.addLog).toHaveBeenCalledWith(expect.objectContaining({ level: 'WARN', message: expect.stringMatching(/skipped.*already running/i) }));
    });
});
