import { randomUUID } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import postgres from 'postgres';
import { createProjectAssetStorage } from '../../apps/backend/src/projects/projectAsset';
import { PostgresWorkflowStore } from '../../apps/backend/src/workflows/persistence/postgresWorkflowStore';
import type { WorkflowAiUsageRecord } from '../../apps/backend/src/workflows/workflowAiMetering';
import { parsePlaytestArgs, main as runPlaytestCli } from '../../packages/playtest/src/cli';
import { recordDiagnostic } from '../../packages/playtest/src/diagnostics';
import {
  type RunEvidenceRecorder,
  withRunCleanup,
  withRunEvidence,
} from '../../scripts/run-evidence';
import { withFixtureRun } from './fixtures';
import { type FreshnessEvidence, withFreshnessEvidence } from './freshness';
import { stackStatus } from './stack';

async function recordGeneration(
  recorder: RunEvidenceRecorder,
  evidence: FreshnessEvidence
): Promise<void> {
  await recorder.writeJson(`generation-${evidence.requestKey}.json`, evidence);
  recorder.manifest.measurements.push({
    name: `generation-${evidence.requestKey}`,
    kind: 'workflow',
    attemptNumber: 1,
    startedAt: evidence.startedAt,
    endedAt: new Date(Date.parse(evidence.startedAt) + evidence.durationMs).toISOString(),
    durationMs: evidence.durationMs,
    outcome: evidence.outcome === 'current' ? 'passed' : 'failed',
  });
  if (!evidence.workflowId) return;
  recorder.manifest.workflows.push({
    name: `generation-${evidence.requestKey}`,
    runId: evidence.workflowId,
    status: evidence.workflowStatus,
  });
  const isolated = await stackStatus();
  const sql = postgres(isolated.DB_URL);
  try {
    const reader = new PostgresWorkflowStore({
      sqlClient: sql,
      projectAssetStorage: createProjectAssetStorage({
        serviceRoleKey: isolated.SERVICE_ROLE_KEY,
        supabaseUrl: isolated.API_URL,
      }),
    });
    const identity = { runId: evidence.workflowId, userId: evidence.userId };
    const [run, state] = await Promise.all([reader.getRun(identity), reader.getRunState(identity)]);
    await recorder.writeJson(`generation-${evidence.requestKey}-workflow.json`, { run, state });
    const usage = await sql<WorkflowAiUsageRecord[]>`
      select id, run_id as "runId", node_instance_id as "nodeInstanceId",
        attempt_number as "attemptNumber", provider, model,
        input_tokens as "inputTokens", output_tokens as "outputTokens",
        reasoning_tokens as "reasoningTokens", cache_read_tokens as "cacheReadTokens",
        cache_write_tokens as "cacheWriteTokens", provider_cost::float8 as "providerCost"
      from public.workflow_ai_usage where run_id = ${evidence.workflowId}
      order by id
    `;
    recorder.manifest.aiUsage.push(...usage);
    await recorder.writeJson(`generation-${evidence.requestKey}-usage.json`, usage);
  } finally {
    await sql.end();
  }
}

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
  return withFreshnessEvidence(
    evidence => recordGeneration(recorder, evidence),
    () =>
      withFixtureRun(
        () => runPlaytestCli(args, recorder.directory),
        async (fixture, inventory) => {
          if (inventory) {
            inventoryEvidence ??= recorder.writeJson('fixture-inventory.json', inventory);
            await inventoryEvidence;
          }
          await recorder.writeJson(`fixture-${randomUUID()}.json`, fixture);
        }
      )
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
