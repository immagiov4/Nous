import { randomUUID } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { parsePlaytestArgs, main as runPlaytestCli } from '../../packages/playtest/src/cli';
import { recordDiagnostic } from '../../packages/playtest/src/diagnostics';
import {
  type RunEvidenceRecorder,
  withRunCleanup,
  withRunEvidence,
} from '../../scripts/run-evidence';
import { withFixtureRun } from './fixtures';

/** Index files after execution so failed runs link only artifacts that were retained. */
async function linkArtifacts(recorder: RunEvidenceRecorder): Promise<void> {
  const entries = await readdir(recorder.directory, { recursive: true, withFileTypes: true });
  recorder.manifest.artifacts = entries
    .filter(entry => entry.isFile() && entry.name !== 'manifest.json')
    .map(entry =>
      relative(recorder.directory, join(entry.parentPath, entry.name)).replaceAll('\\', '/')
    )
    .sort((left, right) => (left < right ? -1 : Number(left > right)));
}

function runCliWithFixtures(args: string[], recorder: RunEvidenceRecorder) {
  let inventoryEvidence: Promise<void> | undefined;
  return withFixtureRun(
    () => runPlaytestCli(args, recorder.directory),
    async (fixture, inventory) => {
      if (inventory) {
        inventoryEvidence ??= recorder.writeJson('fixture-inventory.json', inventory);
        await inventoryEvidence;
      }
      await recorder.writeJson(`fixture-${randomUUID()}.json`, fixture);
    }
  );
}

/** Nous owns run identity and persistence; learner outcomes remain in the generic reports. */
export async function main(args: string[] = process.argv.slice(2)) {
  const values = parsePlaytestArgs(args);
  return withRunEvidence(
    {
      scenario: 'playtest',
      provider: values.provider ?? '',
      slots: {
        learner: { model: values.model ?? '', serviceTier: 'normal' },
        judge: { model: values.model ?? '', serviceTier: 'normal' },
      },
    },
    recorder =>
      recorder.measure({ name: 'playtest', kind: 'case' }, () =>
        withRunCleanup(
          async () => {
            if (values['run-dir'])
              throw new Error('Nous playtest output is managed by NOUS_E2E_DATA; omit --run-dir.');
            return runCliWithFixtures(args, recorder);
          },
          () => linkArtifacts(recorder)
        )
      )
  );
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    recordDiagnostic('nous-run', error);
    console.error('Nous playtest execution failed. See the retained run evidence.');
    process.exitCode = 1;
  }
}
