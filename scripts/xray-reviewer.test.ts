import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  getGlobalModelConfig,
  resetModelConfigForTesting,
} from '../apps/backend/src/config/modelConfig.js';
import {
  closeManagedCodexAccountClient,
  runCodexAppServerTurn,
} from '../apps/backend/src/services/codexAppServer.js';
import { reviewRecordedTrace } from './xray-reviewer.js';

vi.mock('../apps/backend/src/services/codexAppServer.js', () => ({
  closeManagedCodexAccountClient: vi.fn(),
  normalizeCodexReasoningEffort: (effort: string) => effort,
  runCodexAppServerTurn: vi.fn(),
}));

beforeEach(() => resetModelConfigForTesting());
afterEach(() => {
  vi.resetAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  resetModelConfigForTesting();
});

it('waits for persisted settings and uses the Codex lesson model in the call and report', async () => {
  vi.stubEnv('SUPABASE_URL', 'https://example.supabase.co');
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'test-service-key');
  const persisted = Promise.withResolvers<Response>();
  vi.stubGlobal(
    'fetch',
    vi.fn(() => persisted.promise)
  );
  vi.mocked(runCodexAppServerTurn).mockResolvedValue('review response');
  const pending = reviewRecordedTrace('recorded trace', { type: 'object' });
  expect(runCodexAppServerTurn).not.toHaveBeenCalled();
  persisted.resolve(
    new Response(
      JSON.stringify([
        {
          ai_provider: 'openrouter',
          ai_provider_overrides: { lesson: 'openrouter' },
          lesson_model: 'openrouter-lesson',
          codex_lesson_model: 'persisted-codex-lesson',
          lesson_reasoning_effort: 'high',
        },
      ]),
      { status: 200 }
    )
  );
  await expect(pending).resolves.toEqual({
    response: 'review response',
    reviewer: { model: 'persisted-codex-lesson', reasoningEffort: 'high' },
  });
  expect(runCodexAppServerTurn).toHaveBeenCalledWith(
    expect.objectContaining({
      model: 'persisted-codex-lesson',
      reasoningEffort: 'high',
      input: [{ type: 'text', text: 'recorded trace' }],
      outputSchema: { type: 'object' },
    })
  );
  expect(getGlobalModelConfig().aiProvider).toBe('openrouter');
  expect(getGlobalModelConfig().aiProviderOverrides).toEqual({ lesson: 'openrouter' });
  expect(closeManagedCodexAccountClient).toHaveBeenCalledOnce();
});
