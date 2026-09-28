import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    retrieveModel: vi.fn(),
    createChatCompletion: vi.fn(),
    addLog: vi.fn(),
}));

vi.mock('openai', () => ({
    default: class MockOpenAI {
        models = { retrieve: mocks.retrieveModel };
        chat = { completions: { create: mocks.createChatCompletion } };
    },
}));

vi.mock('../src/lib/config', () => ({
    getConfig: () => ({
        ai: {
            enabled: true,
            providerUrl: 'https://api.openai.com/v1',
            apiKey: 'test-key',
            model: 'gpt-4o',
        },
    }),
}));

vi.mock('../src/lib/database', () => ({ addLog: mocks.addLog }));

import { testAiConnection } from '../src/lib/ai-recommender';

describe('AI connection probe', () => {
    beforeEach(() => vi.clearAllMocks());

    it('validates model access without creating a billable completion', async () => {
        mocks.retrieveModel.mockResolvedValue({ id: 'gpt-4o', object: 'model' });

        await expect(testAiConnection()).resolves.toBe(true);

        expect(mocks.retrieveModel).toHaveBeenCalledWith('gpt-4o');
        expect(mocks.createChatCompletion).not.toHaveBeenCalled();
    });

    it('fails when the key or selected model cannot be validated', async () => {
        mocks.retrieveModel.mockRejectedValue(new Error('Unauthorized'));

        await expect(testAiConnection()).resolves.toBe(false);
    });
});
