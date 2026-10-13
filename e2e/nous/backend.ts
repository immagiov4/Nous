import '../../apps/backend/src/config/env';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  type GlobalModelConfig,
  getResolvedGlobalModelConfig,
  getResolvedModelConfigForProvider,
} from '../../apps/backend/src/config/modelConfig';
import { readGitIdentity } from '../../scripts/git-identity';
import { selectOpenRouterWorkflowModels } from '../../scripts/real-workflow-provider-config';
import { withRunCleanup } from '../../scripts/run-evidence';
import { dataRoot, REPO_ROOT } from './stack';

const settingsPath = (userId?: string) =>
  join(
    dataRoot(),
    'stack',
    userId ? `generation-settings-${userId}.json` : 'generation-settings.json'
  );

/** Only the account preparing current content is admitted to the generation configuration. */
export async function withGenerationSettings<T>(
  userId: string,
  operation: () => Promise<T>
): Promise<T> {
  await writeFile(settingsPath(userId), await readFile(settingsPath()));
  return withRunCleanup(operation, () => rm(settingsPath(userId), { force: true }));
}

/** Resolve admitted current accounts; all other accounts use ordinary product settings. */
export async function resolveGenerationModels(
  provider?: unknown,
  overrides?: unknown,
  userId?: string
): Promise<GlobalModelConfig> {
  const original = await getResolvedModelConfigForProvider(provider, overrides);
  if (!userId) return original;
  try {
    return JSON.parse(await readFile(settingsPath(userId), 'utf8')).settings;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return original;
    throw error;
  }
}

export async function startPlaytestBackend(): Promise<void> {
  const original = await getResolvedGlobalModelConfig();
  const selected = selectOpenRouterWorkflowModels(original);
  // Scene and playback models are live product settings, outside the durable lesson config.
  const settings = {
    ...selected,
    sceneModel: original.sceneModel,
    sceneIconModel: original.sceneIconModel,
    playbackPreparationModel: original.playbackPreparationModel,
  };
  await writeFile(
    settingsPath(),
    JSON.stringify({ appRevision: readGitIdentity(REPO_ROOT), settings })
  );
  const { startBackend } = await import('../../apps/backend/src/server');
  await startBackend({ resolveLessonModels: resolveGenerationModels });
}

if (import.meta.main) await startPlaytestBackend();
