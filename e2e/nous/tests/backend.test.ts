import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import {
  getResolvedGlobalModelConfig,
  getResolvedModelConfigForProvider,
} from '../../../apps/backend/src/config/modelConfig';
import { OPENROUTER_WORKFLOW_MODELS } from '../../../scripts/real-workflow-provider-config';
import { resolveGenerationModels, startPlaytestBackend, withGenerationSettings } from '../backend';

const boot = vi.hoisted(() =>
  vi.fn<(options: { resolveLessonModels?: typeof resolveGenerationModels }) => Promise<void>>(
    async () => {}
  )
);
vi.mock('../../../apps/backend/src/server', () => ({ startBackend: boot }));
vi.mock('../../../scripts/git-identity', () => ({
  readGitIdentity: () => ({ commitSha: 'revision', dirty: true }),
}));
let root: string;
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});
it('scopes small generation models to current accounts and leaves global application settings unchanged', async () => {
  root = await mkdtemp(join(tmpdir(), 'nous-generation-config-'));
  await mkdir(join(root, 'stack'));
  vi.stubEnv('NOUS_E2E_DATA', root);
  vi.stubEnv('SUPABASE_URL', 'http://127.0.0.1:55321');
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'test-service');
  const fetcher = vi.fn(async (_url: string, options?: RequestInit) =>
    Response.json(
      options?.method === 'POST'
        ? []
        : [
            {
              ai_provider: 'codex',
              lesson_model: 'original-model',
              lesson_reasoning_effort: 'high',
              scene_model: 'original-scene',
              scene_reasoning_effort: 'medium',
            },
          ]
    )
  );
  vi.stubGlobal('fetch', fetcher);
  await startPlaytestBackend();
  const resolver = boot.mock.calls[0][0].resolveLessonModels;
  if (!resolver) throw new Error('The backend must use the scoped lesson resolver');
  const original = await getResolvedGlobalModelConfig();
  expect(await resolver(undefined, undefined, 'any-user')).toEqual(original);
  const effective = await withGenerationSettings('current-user', () =>
    resolveGenerationModels('openrouter', undefined, 'current-user')
  );
  expect(await resolveGenerationModels('openrouter', undefined, 'current-user')).toEqual(
    await getResolvedModelConfigForProvider('openrouter')
  );
  expect(await getResolvedGlobalModelConfig()).toEqual(original);
  const recorded = JSON.parse(await readFile(join(root, 'stack/generation-settings.json'), 'utf8'));
  expect(effective).toEqual(recorded.settings);
  expect(effective).toMatchObject({
    aiProvider: 'openrouter',
    lessonModel: OPENROUTER_WORKFLOW_MODELS.text,
    sceneModel: 'original-scene',
    lessonReasoningEffort: 'high',
    sceneReasoningEffort: 'medium',
  });
  await expect(
    withGenerationSettings('failed-current-user', async () => {
      throw new Error('Generation failed');
    })
  ).rejects.toThrow('Generation failed');
  expect(await resolveGenerationModels(undefined, undefined, 'failed-current-user')).toEqual(
    original
  );
  expect(fetcher.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(0);
});
