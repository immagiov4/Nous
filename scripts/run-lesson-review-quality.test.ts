import { afterEach, expect, test, vi } from 'vitest';
import {
  getGlobalModelConfig,
  getResolvedGlobalModelConfig,
} from '../apps/backend/src/config/modelConfig.js';
import { runCodexAppServerTurn } from '../apps/backend/src/services/codexAppServer.js';
import { flawedAutomationLesson } from '../apps/backend/tests/fixtures/lessonReviewQuality.js';
import { withRunEvidence } from './run-evidence.js';

vi.mock('../apps/backend/src/config/modelConfig.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../apps/backend/src/config/modelConfig.js')>()),
  getResolvedGlobalModelConfig: vi.fn(),
}));
vi.mock('../apps/backend/src/services/codexAppServer.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../apps/backend/src/services/codexAppServer.js')>()),
  runCodexAppServerTurn: vi.fn(),
  closeManagedCodexAccountClient: vi.fn(),
}));
vi.mock('../apps/backend/src/services/lessonGenerationModel.js', () => ({
  generateLessonContent: vi.fn(async () => flawedAutomationLesson),
  reviewLessonContentDraftStrict: vi.fn(async () => flawedAutomationLesson),
}));
vi.mock('../apps/backend/src/workflows/runtime/workflowRuntimeComposition.js', () => ({
  createProductionRegistry: () => ({
    current: () => ({ executionDefaults: { maxAttempts: 1 } }),
  }),
}));
vi.mock('./run-evidence.js', async importOriginal => ({
  ...(await importOriginal<typeof import('./run-evidence.js')>()),
  withRunEvidence: vi.fn(),
}));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

test.each([
  { fastSlots: ['lesson'] as const, expectedTier: 'fast' },
  { fastSlots: [] as const, expectedTier: 'normal' },
])('uses the resolved $expectedTier tier for every evaluator request and its evidence', async ({
  fastSlots,
  expectedTier,
}) => {
  vi.resetModules();
  vi.stubEnv('REAL_LESSON_QUALITY_TESTS', 'I_ACCEPT_REAL_PROVIDER_COSTS');
  vi.stubEnv('CODEX_APP_SERVER_ENABLED', '');
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.mocked(getResolvedGlobalModelConfig).mockResolvedValue({
    ...getGlobalModelConfig(),
    lessonReasoningEffort: 'high',
    codexFastModelSlots: [...fastSlots],
  });
  const evaluate = vi.mocked(runCodexAppServerTurn);
  evaluate.mockImplementation(async () =>
    JSON.stringify(
      Object.fromEntries(
        ['definitions', 'prerequisites', 'language', 'prose', 'learnerText', 'coverage'].map(
          criterion => [
            criterion,
            { evidence: 'Controlled evaluation.', passed: evaluate.mock.calls.length > 1 },
          ]
        )
      )
    )
  );
  vi.mocked(withRunEvidence).mockImplementation(async (_context, operation) =>
    operation({
      directory: 'controlled-evidence',
      measure: async (_measurement, run) => run(),
      writeJson: async () => {},
    } as Parameters<Parameters<typeof withRunEvidence>[1]>[0])
  );

  await import('./run-lesson-review-quality.js');

  expect(evaluate).toHaveBeenCalledTimes(4);
  for (const [request] of evaluate.mock.calls) {
    expect(request.serviceTier ?? 'normal').toBe(expectedTier);
    expect(request.reasoningEffort).toBe('high');
  }
  const context = vi.mocked(withRunEvidence).mock.calls[0][0];
  expect(context.slots.evaluator).toEqual({
    model: 'gpt-5.6-luna',
    reasoningEffort: 'high',
    serviceTier: expectedTier,
  });
});
