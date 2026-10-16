import { randomUUID } from 'node:crypto';
import { mkdir, realpath, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type GlobalModelConfig,
  type ReasoningEffort,
  resolveAiProviderForSlot,
  resolveCodexServiceTierForSlot,
  resolveTextModelConfig,
  type TextModelSlot,
} from '../apps/backend/src/config/modelConfig.js';
import {
  normalizeCodexReasoningEffort,
  withSettledCodexUsage,
} from '../apps/backend/src/services/codexAppServer.js';
import {
  type ModelExchange,
  withModelExchanges,
} from '../apps/backend/src/workflows/modelExchanges.js';
import {
  runWithWorkflowAttemptMetering,
  type WorkflowAiUsageRecord,
} from '../apps/backend/src/workflows/workflowAiMetering.js';
import type {
  WorkflowNodeRunState,
  WorkflowPublicRunState,
} from '../apps/backend/src/workflows/workflowReadModel.js';
import { readGitIdentity } from './git-identity.js';

const repositoryDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export interface RunEvidenceContext {
  captureModelExchanges?: true;
  scenario: string;
  provider: string;
  case?: string;
  slots: Record<string, { model: string; reasoningEffort?: string; serviceTier: string }>;
}

/** Reports the settings sent to the provider, including a role's explicit override. */
export const resolveRunEvidenceTextSlot = (
  config: GlobalModelConfig,
  slot: TextModelSlot,
  override?: ReasoningEffort
): RunEvidenceContext['slots'][string] => {
  const model = resolveTextModelConfig(config, slot);
  const effort = override ?? model.reasoningEffort;
  const isCodex = resolveAiProviderForSlot(config, slot) === 'codex';
  return {
    model: model.model,
    reasoningEffort: isCodex ? normalizeCodexReasoningEffort(effort) : effort,
    serviceTier: (isCodex && resolveCodexServiceTierForSlot(config, slot)) || 'normal',
  };
};

export interface RunMeasurement {
  name: string;
  kind: 'case' | 'call' | 'workflow';
  attemptNumber: number;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  outcome: 'passed' | 'failed';
}

export interface WorkflowEvidence {
  runId: string;
  name: string;
  status?: string;
  nodes?: Array<
    Pick<
      WorkflowNodeRunState,
      | 'instanceId'
      | 'definitionId'
      | 'status'
      | 'attemptCount'
      | 'createdAt'
      | 'availableAt'
      | 'updatedAt'
      | 'completedAt'
    > & { lifetimeDurationMs: number | null }
  >;
}

/** Persisted verbatim in manifest.json and once per completed run in history.jsonl. */
export interface RunManifest extends RunEvidenceContext {
  runId: string;
  git: { commitSha: string; dirty: boolean };
  startedAt: string;
  endedAt: string | null;
  durationMs: number | null;
  outcome: 'running' | 'passed' | 'failed';
  errorCode: string | null;
  measurements: RunMeasurement[];
  workflows: WorkflowEvidence[];
  aiUsage: WorkflowAiUsageRecord[];
  /** Relative paths to artifacts retained by the harness, including partial failed runs. */
  artifacts?: string[];
  /** Application-owned cleanup and writes that were incomplete at finalization. */
  resourcesAtRisk?: Array<{ kind: string; id: string }>;
  incompleteWrites?: string[];
}

const isInside = (directory: string, parent: string): boolean => {
  const path = relative(parent, directory);
  return path === '' || (!path.startsWith('..') && !isAbsolute(path));
};

// Resolve existing ancestors before creating directories, including junctions on Windows.
const canonicalDirectory = async (directory: string): Promise<string> => {
  try {
    return await realpath(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return join(await canonicalDirectory(dirname(directory)), basename(directory));
  }
};

const requireName = (name: string): void => {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name)) {
    throw new Error('Evidence names must be single path components.');
  }
};

/** Owns one external run directory; the wrapper finalizes it on success or failure. */
export class RunEvidenceRecorder {
  constructor(
    readonly directory: string,
    readonly manifest: RunManifest
  ) {}

  async writeEvidence(
    name: string,
    contents: string | Uint8Array,
    options?: { signal?: AbortSignal }
  ): Promise<void> {
    requireName(name);
    if (name.toLowerCase() === 'manifest.json' || name.toLowerCase() === 'history.jsonl') {
      throw new Error('Reserved evidence filename.');
    }
    await writeFile(join(this.directory, name), contents, options);
  }

  async writeJson(
    name: string,
    contents: unknown,
    options?: { signal?: AbortSignal }
  ): Promise<void> {
    await this.writeEvidence(name, JSON.stringify(contents, null, 2), options);
  }

  /** Writes the current lifecycle to the manifest and named trace, replacing an earlier snapshot. */
  async recordWorkflowState(
    workflow: WorkflowEvidence,
    state: Pick<WorkflowPublicRunState, 'run' | 'nodes'>
  ): Promise<void> {
    workflow.status = state.run.status;
    workflow.nodes = state.nodes.map(node => ({
      instanceId: node.instanceId,
      definitionId: node.definitionId,
      status: node.status,
      attemptCount: node.attemptCount,
      createdAt: node.createdAt,
      availableAt: node.availableAt,
      updatedAt: node.updatedAt,
      ...(node.completedAt ? { completedAt: node.completedAt } : {}),
      lifetimeDurationMs: node.completedAt
        ? Date.parse(node.completedAt) - Date.parse(node.createdAt)
        : null,
    }));
    await this.writeJson(`${workflow.name}-state.json`, state);
  }

  async measure<Result>(
    input: Pick<RunMeasurement, 'name' | 'kind'> & { attemptNumber?: number },
    operation: () => Promise<Result>
  ): Promise<Result> {
    const startedAt = new Date().toISOString();
    const started = performance.now();
    let outcome: RunMeasurement['outcome'] = 'failed';
    try {
      const result = await (input.kind === 'call'
        ? runWithWorkflowAttemptMetering(
            {
              attemptNumber: input.attemptNumber ?? 1,
              nodeInstanceId: input.name,
              runId: this.manifest.runId,
              record: async usage => {
                this.manifest.aiUsage.push(usage);
              },
            },
            operation
          )
        : operation());
      outcome = 'passed';
      return result;
    } finally {
      this.manifest.measurements.push({
        ...input,
        attemptNumber: input.attemptNumber ?? 1,
        startedAt,
        endedAt: new Date().toISOString(),
        durationMs: performance.now() - started,
        outcome,
      });
    }
  }
}

/** Error identifiers are retained; messages and provider text are never copied. */
export const runErrorCode = (error: unknown): string => {
  // Cleanup aggregation keeps the operation failure as the cause; report that primary failure.
  if (error instanceof AggregateError && error.cause !== undefined)
    return runErrorCode(error.cause);
  if (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string'
  ) {
    return error.code;
  }
  return error instanceof Error ? error.constructor.name : 'UnknownError';
};

/** Always clean up; retain both failures with the operation's error as the cause. */
export const withRunCleanup = async <Result>(
  operation: () => Promise<Result>,
  cleanup: () => Promise<void>
): Promise<Result> => {
  let failed = false;
  let primaryError: unknown;
  let result!: Result;
  try {
    result = await operation();
  } catch (error) {
    failed = true;
    primaryError = error;
  }
  try {
    await cleanup();
  } catch (error) {
    if (failed) {
      throw new AggregateError(
        [primaryError, error],
        'Run cleanup failed after the operation failed.',
        {
          cause: primaryError,
        }
      );
    }
    throw error;
  }
  if (failed) throw primaryError;
  return result;
};

/** Validate the output before work starts and retain a redacted failure manifest. */
export const withRunEvidence = async <Result>(
  context: RunEvidenceContext,
  operation: (recorder: RunEvidenceRecorder) => Promise<Result>,
  finalize?: (
    persist: (signal?: AbortSignal) => Promise<void>,
    recorder: RunEvidenceRecorder
  ) => Promise<void>
): Promise<Result> => {
  const dataDirectory = process.env.NOUS_E2E_DATA?.trim();
  if (!dataDirectory) throw new Error('NOUS_E2E_DATA is required for real-provider evidence.');
  requireName(context.scenario);
  const scenarioDirectory = await canonicalDirectory(
    resolve(dataDirectory, 'runs', context.scenario)
  );
  const repository = await realpath(repositoryDirectory);
  if (isInside(scenarioDirectory, repository))
    throw new Error('NOUS_E2E_DATA must be outside the repository.');
  const startedAt = new Date().toISOString();
  const started = performance.now();
  const runId = `${startedAt.replaceAll(':', '-')}-${randomUUID()}`;
  const directory = join(scenarioDirectory, runId);
  await mkdir(directory, { recursive: true });
  const manifest: RunManifest = {
    ...context,
    runId,
    git: readGitIdentity(repositoryDirectory),
    startedAt,
    endedAt: null,
    durationMs: null,
    outcome: 'running',
    errorCode: null,
    measurements: [],
    workflows: [],
    aiUsage: [],
  };
  const recorder = new RunEvidenceRecorder(directory, manifest);
  const exchanges: ModelExchange[] = [];
  const saveManifest = (signal?: AbortSignal) =>
    writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest, null, 2), { signal });
  await saveManifest();
  return withRunCleanup(
    async () => {
      try {
        const result = await withSettledCodexUsage(() =>
          context.captureModelExchanges
            ? withModelExchanges(exchanges, () => operation(recorder))
            : operation(recorder)
        );
        manifest.outcome = 'passed';
        return result;
      } catch (error) {
        manifest.outcome = 'failed';
        manifest.errorCode = runErrorCode(error);
        throw error;
      }
    },
    async () => {
      manifest.endedAt = new Date().toISOString();
      manifest.durationMs = performance.now() - started;
      if (context.captureModelExchanges) {
        await recorder.writeEvidence(
          'model-exchanges.jsonl',
          exchanges
            .toSorted((left, right) => left.startedAt.localeCompare(right.startedAt))
            .map(exchange => `${JSON.stringify(exchange)}\n`)
            .join('')
        );
      }
      const persist = async (signal?: AbortSignal) => {
        const snapshot = JSON.stringify(manifest);
        await writeFile(join(directory, 'manifest.json'), snapshot, { signal });
        await writeFile(join(scenarioDirectory, 'history.jsonl'), `${snapshot}\n`, {
          flag: 'a',
          signal,
        });
      };
      if (finalize) await finalize(persist, recorder);
      else await persist();
    }
  );
};
