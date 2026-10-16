import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import {
  getGlobalModelConfig,
  getResolvedGlobalModelConfig,
} from '../apps/backend/src/config/modelConfig.js';
import { runCodexAppServerTurn } from '../apps/backend/src/services/codexAppServer.js';
import { flawedAutomationLesson } from '../apps/backend/tests/fixtures/lessonReviewQuality.js';
import { type RunManifest, withRunEvidence } from './run-evidence.js';

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

test.each([
  { response: '{', errorName: 'SyntaxError', label: 'malformed JSON' },
  { response: '{}', errorName: 'ZodError', label: 'a schema-invalid object' },
])('records a failed evaluator call for $label', async ({ response, errorName }) => {
  vi.resetModules();
  const directory = await mkdtemp(join(tmpdir(), 'nous-evaluator-validation-'));
  vi.stubEnv('NOUS_E2E_DATA', directory);
  vi.stubEnv('REAL_LESSON_QUALITY_TESTS', 'I_ACCEPT_REAL_PROVIDER_COSTS');
  vi.stubEnv('CODEX_APP_SERVER_ENABLED', '');
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.mocked(getResolvedGlobalModelConfig).mockResolvedValue(getGlobalModelConfig());
  vi.mocked(runCodexAppServerTurn).mockResolvedValue(response);
  const actual = await vi.importActual<typeof import('./run-evidence.js')>('./run-evidence.js');
  let runDirectory = '';
  vi.mocked(withRunEvidence).mockImplementation((context, operation) =>
    actual.withRunEvidence(context, recorder => {
      runDirectory = recorder.directory;
      return operation(recorder);
    })
  );

  try {
    await expect(import('./run-lesson-review-quality.js')).rejects.toMatchObject({
      name: errorName,
    });
    const manifest: RunManifest = JSON.parse(
      await readFile(join(runDirectory, 'manifest.json'), 'utf8')
    );
    expect(manifest.outcome).toBe('failed');
    expect(manifest.measurements).toEqual([
      expect.objectContaining({
        name: 'seeded-original-evaluation',
        kind: 'call',
        outcome: 'failed',
      }),
      expect.objectContaining({ name: 'seeded-original', kind: 'case', outcome: 'failed' }),
    ]);
    expect(runCodexAppServerTurn).toHaveBeenCalledTimes(1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
