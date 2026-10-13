import '../../apps/backend/src/config/env';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { patchAndPersistGlobalModelConfig } from '../../apps/backend/src/config/modelConfig';
import { readGitIdentity } from '../../scripts/git-identity';
import { configureWorkflowProviderModels } from '../../scripts/real-workflow-provider-config';
import { dataRoot, REPO_ROOT } from './stack';

// Apply small models in this isolated backend only; retain the app's configured efforts.
export async function startPlaytestBackend(): Promise<void> {
  const selected = await configureWorkflowProviderModels('openrouter');
  const settings = await patchAndPersistGlobalModelConfig(selected);
  await writeFile(
    join(dataRoot(), 'stack', 'generation-settings.json'),
    JSON.stringify({ appRevision: readGitIdentity(REPO_ROOT), settings })
  );
  await import('../../apps/backend/src/server');
}

if (import.meta.main) await startPlaytestBackend();
