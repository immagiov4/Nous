import { randomUUID } from 'node:crypto';

import { mergeWorkflowConfig } from './config.js';
import type { WorkflowRegistry } from './definition.js';
import { snapshotImmutableJson } from './jsonSnapshot.js';
import { materializeWorkflowStart } from './materialization.js';
import type { CreateWorkflowRunInput } from './postgresWorkflowStore.js';
import type { JsonValue, RegisteredWorkflow, WorkflowRun } from './types.js';
import {
  publishWorkflowTransientEvents,
  type WorkflowTransientEventPublisher,
} from './workflowObservability.js';

export interface WorkflowRunCreator {
  createRun(input: CreateWorkflowRunInput): Promise<{ created: boolean; run: WorkflowRun }>;
}

export interface StartWorkflowRunInput {
  configOverride?: Readonly<Record<string, unknown>>;
  createId?: () => string;
  /** User-wide active-work identity; use one namespace for mutually exclusive workflows. */
  dedupeKey?: string;
  /** Stable request semantics when the materialized input contains generated identities. */
  idempotencyInput?: unknown;
  input: unknown;
  mapPreviousIdempotencyInput?: (workflowInput: unknown) => JsonValue | undefined;
  projectId?: string;
  publishTransientEvent?: WorkflowTransientEventPublisher;
  registry: WorkflowRegistry;
  requestKey: string;
  store: WorkflowRunCreator;
  userId: string;
  workflowId: string;
}

const assertIdentity = (value: string, name: string): void => {
  if (!value.trim()) throw new Error(`${name} is required.`);
};

export const startWorkflowRun = async (
  input: StartWorkflowRunInput
): Promise<{ created: boolean; run: WorkflowRun }> => {
  assertIdentity(input.workflowId, 'workflowId');
  assertIdentity(input.userId, 'userId');
  assertIdentity(input.requestKey, 'requestKey');
  if (input.dedupeKey !== undefined) assertIdentity(input.dedupeKey, 'dedupeKey');

  const definition = input.registry.current(input.workflowId);
  if (!definition) throw new Error(`Workflow is not registered: ${input.workflowId}`);

  const workflowInput = snapshotImmutableJson(definition.inputSchema.parse(input.input));
  const idempotencyInput =
    input.idempotencyInput === undefined
      ? workflowInput
      : snapshotImmutableJson(input.idempotencyInput);
  const mergedConfig = mergeWorkflowConfig(
    { ...definition.executionDefaults },
    input.configOverride ?? {}
  );
  const resolvedConfig = snapshotImmutableJson(definition.configSchema.parse(mergedConfig));
  const materialization = materializeWorkflowStart(
    definition as RegisteredWorkflow,
    workflowInput,
    { resolvedConfig }
  );

  const result = await input.store.createRun({
    config: resolvedConfig,
    ...(input.dedupeKey === undefined ? {} : { dedupeKey: input.dedupeKey }),
    definitionHash: definition.definitionHash,
    definitionHashVersion: definition.definitionHashVersion,
    id: (input.createId ?? randomUUID)(),
    idempotencyInput,
    input: workflowInput,
    ...(input.mapPreviousIdempotencyInput === undefined
      ? {}
      : { mapPreviousIdempotencyInput: input.mapPreviousIdempotencyInput }),
    materialization,
    ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
    requestKey: input.requestKey,
    userId: input.userId,
    workflowId: definition.id,
  });
  if (result.created) {
    publishWorkflowTransientEvents(
      input.publishTransientEvent,
      { runId: result.run.id, workflowId: definition.id },
      materialization.transientEvents
    );
  }
  return result;
};
