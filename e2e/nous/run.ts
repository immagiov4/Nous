import { randomUUID } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import postgres from 'postgres';
import { createProjectAssetStorage } from '../../apps/backend/src/projects/projectAsset';
import { PostgresWorkflowStore } from '../../apps/backend/src/workflows/persistence/postgresWorkflowStore';
import type { WorkflowAiUsageRecord } from '../../apps/backend/src/workflows/workflowAiMetering';
import {
  parsePlaytestArgs,
  main as runPlaytestCli,
  runCommand as runPlaytestCommand,
} from '../../packages/playtest/src/cli';
import { recordDiagnostic } from '../../packages/playtest/src/diagnostics';
import {
  type RunEvidenceRecorder,
  withRunCleanup,
  withRunEvidence,
} from '../../scripts/run-evidence';
import { withFixtureRun } from './fixtures';
import {
  type FreshnessEvidence,
  PREPARATION_TIMEOUT_CODE,
  withFreshnessEvidence,
} from './freshness';
import type { PreparationDeadline } from './preparationDeadline';
import { stopStack } from './stack';

function updateGenerationLedger(recorder: RunEvidenceRecorder, evidence: FreshnessEvidence): void {
  const name = `generation-${evidence.requestKey}`;
  const measurement = {
    name,
    kind: 'workflow' as const,
    attemptNumber: 1,
    startedAt: evidence.startedAt,
    endedAt: new Date(Date.parse(evidence.startedAt) + evidence.durationMs).toISOString(),
    durationMs: evidence.durationMs,
    outcome: evidence.outcome === 'current' ? ('passed' as const) : ('failed' as const),
  };
  const previous = recorder.manifest.measurements.find(entry => entry.name === name);
  if (previous) Object.assign(previous, measurement);
  else recorder.manifest.measurements.push(measurement);
  if (
    evidence.workflowId &&
    !recorder.manifest.workflows.some(workflow => workflow.runId === evidence.workflowId)
  )
    recorder.manifest.workflows.push({
      name,
      runId: evidence.workflowId,
      status: evidence.workflowStatus,
    });
}

async function recordGeneration(
  recorder: RunEvidenceRecorder,
  evidence: FreshnessEvidence,
  deadline: PreparationDeadline
): Promise<void> {
  updateGenerationLedger(recorder, evidence);
  if (evidence.errorCode === PREPARATION_TIMEOUT_CODE) {
    await deadline.settle(
      'deadline-checkpoint-write',
      signal =>
        recorder.writeJson(
          `generation-${evidence.requestKey}-deadline.json`,
          structuredClone(evidence),
          { signal }
        ),
      'write'
    );
    return;
  }
  await deadline.step(
    'generation-snapshot-write',
    signal =>
      recorder.writeJson(
        `generation-${evidence.requestKey}-snapshot.json`,
        structuredClone(evidence),
        { signal }
      ),
    'write'
  );
  if (!evidence.workflowId) return;
  const isolated = deadline.isolated;
  const sql = postgres(isolated.DB_URL);
  deadline.ownConnection(sql);
  try {
    const reader = new PostgresWorkflowStore({
      sqlClient: sql,
      projectAssetStorage: createProjectAssetStorage({
        serviceRoleKey: isolated.SERVICE_ROLE_KEY,
        supabaseUrl: isolated.API_URL,
      }),
    });
    const identity = { runId: evidence.workflowId, userId: evidence.userId };
    const [run, state] = await deadline.step('workflow-snapshot-read', () =>
      Promise.all([reader.getRun(identity), reader.getRunState(identity)])
    );
    await deadline.step(
      'workflow-snapshot-write',
      signal =>
        recorder.writeJson(
          `generation-${evidence.requestKey}-workflow.json`,
          { run, state },
          { signal }
        ),
      'write'
    );
    const usage = await deadline.step(
      'generation-usage-read',
      () => sql<WorkflowAiUsageRecord[]>`
      select id, run_id as "runId", node_instance_id as "nodeInstanceId", attempt_number as "attemptNumber", provider, model,
        input_tokens as "inputTokens", output_tokens as "outputTokens", reasoning_tokens as "reasoningTokens",
        cache_read_tokens as "cacheReadTokens", cache_write_tokens as "cacheWriteTokens", provider_cost::float8 as "providerCost"
      from public.workflow_ai_usage where run_id = ${evidence.workflowId} order by id
    `
    );
    recorder.manifest.aiUsage.push(...usage);
    await deadline.step(
      'generation-usage-write',
      signal =>
        recorder.writeJson(`generation-${evidence.requestKey}-usage.json`, usage, { signal }),
      'write'
    );
  } finally {
    await deadline.settle('evidence-connection-close', () => sql.end(), 'cleanup');
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

/** Publish one immutable final generation record; provisional collectors cannot overwrite it. */
async function refreshGeneration(
  recorder: RunEvidenceRecorder,
  evidence: FreshnessEvidence,
  deadline: PreparationDeadline,
  signal: AbortSignal
): Promise<void> {
  // The publication cannot report its own completed write before it has happened.
  if (!deadline.signal.aborted && evidence.preparation)
    evidence.preparation.steps = evidence.preparation.steps.filter(
      step => step.name !== 'final-generation-write'
    );
  updateGenerationLedger(recorder, evidence);
  const resources = evidence.preparation?.possiblyLeakedResources ?? [];
  recorder.manifest.resourcesAtRisk ??= [];
  recorder.manifest.resourcesAtRisk.push(
    ...resources.flatMap(resource => [
      { kind: 'account', id: resource.accountId },
      { kind: 'project', id: resource.projectId },
    ])
  );
  recorder.manifest.incompleteWrites ??= [];
  recorder.manifest.incompleteWrites.push(
    ...(evidence.preparation?.steps
      .filter(step => step.kind === 'write' && step.status !== 'completed')
      .map(step => step.name) ?? [])
  );
  const filename = `generation-${evidence.requestKey}.json`;
  try {
    await recorder.writeJson(filename, evidence, { signal });
  } catch (error) {
    if (!deadline.signal.aborted) recorder.manifest.incompleteWrites.push(filename);
    throw error;
  }
}

function executePlaytest(
  args: string[],
  values: ReturnType<typeof parsePlaytestArgs>,
  recorder: RunEvidenceRecorder
) {
  if (values['run-dir'])
    throw new Error('Nous playtest output is managed by NOUS_E2E_DATA; omit --run-dir.');
  return runCliWithFixtures(args, recorder);
}
type RunFinalization = {
  expired?: PreparationDeadline;
  indexing?: Promise<void>;
  publications: Promise<void>[];
  finishing?: PreparationDeadline;
  allSkipped?: boolean;
};

async function finishNousRun(
  deadlines: PreparationDeadline[],
  finalization: RunFinalization
): Promise<void> {
  finalization.expired = deadlines.find(deadline => deadline.signal.aborted);
  finalization.finishing = finalization.expired ?? deadlines.at(-1);
  if (finalization.allSkipped) return;
  if (finalization.finishing)
    await finalization.finishing.settle('isolated-stack-stop', () => stopStack(), 'cleanup');
  else await stopStack();
}

async function executeAndRecordSelection(
  args: string[],
  values: ReturnType<typeof parsePlaytestArgs>,
  recorder: RunEvidenceRecorder,
  finalization: RunFinalization
) {
  const summary = await executePlaytest(args, values, recorder);
  finalization.allSkipped = summary.records.every(record => record.outcome === 'skipped');
  return summary;
}

async function executeAndFinalize(
  args: string[],
  values: ReturnType<typeof parsePlaytestArgs>,
  recorder: RunEvidenceRecorder,
  finalization: RunFinalization
) {
  try {
    return await withRunCleanup(
      () =>
        withFreshnessEvidence(
          (evidence, deadline) => recordGeneration(recorder, evidence, deadline),
          () => executeAndRecordSelection(args, values, recorder, finalization),
          (evidence, deadline, signal) => {
            const publication = refreshGeneration(recorder, evidence, deadline, signal);
            finalization.publications.push(publication);
            return publication;
          },
          deadlines => finishNousRun(deadlines, finalization)
        ),
      async () => {
        // Expired publications are detached from preparation, but must precede indexing.
        const indexing = Promise.allSettled(finalization.publications).then(() =>
          linkArtifacts(recorder)
        );
        finalization.indexing = indexing;
        if (finalization.finishing)
          await finalization.finishing.settle('artifact-index', () => indexing, 'cleanup');
        else await indexing;
      }
    );
  } catch (error) {
    if (finalization.expired)
      throw Object.assign(
        new Error('Fresh preparation deadline expired. See the retained run evidence.'),
        { code: 'PLAYTEST_OPERATIONAL_ERROR', cause: error }
      );
    throw error;
  }
}

/** Nous owns run identity and persistence; learner outcomes remain in the generic reports. */
export async function main(args: string[] = process.argv.slice(2)) {
  const values = parsePlaytestArgs(args);
  const finalization: RunFinalization = { publications: [] };
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
        executeAndFinalize(args, values, recorder, finalization)
      ),
    async (persist, recorder) => {
      if (finalization.expired) {
        recorder.manifest.incompleteWrites ??= [];
        recorder.manifest.incompleteWrites.push('manifest.json', 'history.jsonl');
        await finalization.expired.settle(
          'manifest-and-history-write',
          signal =>
            withRunCleanup(
              () => finalization.indexing ?? Promise.resolve(),
              () => persist(signal)
            ),
          'write'
        );
      } else await persist();
    }
  );
}

/** Keep metadata-only inspection outside the run evidence and stack lifecycle. */
export async function runCommand(args: string[] = process.argv.slice(2)) {
  if (parsePlaytestArgs(args)['coverage-map']) return runPlaytestCommand(args);
  return main(args);
}

if (import.meta.main) {
  try {
    await runCommand();
  } catch (error) {
    recordDiagnostic('nous-run', error);
    console.error('Nous playtest execution failed. See the retained run evidence.');
    process.exitCode = 1;
  }
}
