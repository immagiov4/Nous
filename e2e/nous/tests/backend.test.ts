import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { getResolvedModelConfigForProvider } from '../../../apps/backend/src/config/modelConfig';
import { OPENROUTER_WORKFLOW_MODELS } from '../../../scripts/real-workflow-provider-config';
import { startPlaytestBackend } from '../backend';

vi.mock('../../../apps/backend/src/server', () => ({}));
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
it('persists small generation models so product resolution matches the recorded settings and preserves efforts', async () => {
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
  const effective = await getResolvedModelConfigForProvider('openrouter');
  const recorded = JSON.parse(await readFile(join(root, 'stack/generation-settings.json'), 'utf8'));
  expect(effective).toEqual(recorded.settings);
  expect(effective).toMatchObject({
    aiProvider: 'openrouter',
    lessonModel: OPENROUTER_WORKFLOW_MODELS.text,
    sceneModel: OPENROUTER_WORKFLOW_MODELS.scene,
    lessonReasoningEffort: 'high',
    sceneReasoningEffort: 'medium',
  });
  expect(fetcher.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(1);
});
