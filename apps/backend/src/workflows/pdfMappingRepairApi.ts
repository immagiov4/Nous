import {
  needsPdfMappingRepair,
  type PdfMappingRepairResult,
  type PdfMappingRepairSnapshot,
  type PdfMappingRepairStage,
  type PdfMappingRepairStatus,
} from '@shared/pdfMappingRepairContract.js';

import type { GlobalModelConfig } from '../config/modelConfig.js';
import type { ProjectStore } from '../projects/types.js';
import type { WorkflowRegistry } from './definition.js';
import {
  getProjectPdfMappingRepairState,
  PDF_MAPPING_REPAIR_WORKFLOW_ID,
  PdfMappingRepairResultSchema,
  PdfMappingRepairWorkflowInputSchema,
} from './pdfMappingRepairWorkflow.js';
import { WorkflowRuntimeUnavailableError } from './runtime/workflowRuntimeApi.js';
import type { WorkflowRun } from './types.js';
import { WorkflowRunNotFoundError } from './workflowErrors.js';
import type { WorkflowTransientEventPublisher } from './workflowObservability.js';
import type { WorkflowNodeRunState, WorkflowRunState } from './workflowReadModel.js';
import { startWorkflowRun, type WorkflowRunCreator } from './workflowStart.js';

interface PdfMappingRepairProjectReader {
  loadProjectWithRevision: ProjectStore['loadProjectWithRevision'];
}

interface PdfMappingRepairRunReader {
  getRun(input: { runId: string; userId: string }): Promise<WorkflowRun | null>;
  getRunState(input: { runId: string; userId: string }): Promise<WorkflowRunState | null>;
}

export interface PdfMappingRepairStartInput {
  readonly aiProvider?: unknown;
  readonly aiProviderOverrides?: unknown;
  readonly projectId: string;
  readonly requestKey: string;
  readonly userId: string;
}

interface PdfMappingRepairStarter {
  start(input: PdfMappingRepairStartInput): Promise<{ created: boolean; run: WorkflowRun }>;
}

export type PdfMappingRepairStartResult =
  | { readonly result: PdfMappingRepairResult }
  | { readonly created: boolean; readonly job: PdfMappingRepairSnapshot };

export interface PdfMappingRepairApi {
  get(input: { runId: string; userId: string }): Promise<PdfMappingRepairSnapshot | null>;
  start(input: PdfMappingRepairStartInput): Promise<PdfMappingRepairStartResult>;
}

export class PdfMappingRepairTargetNotFoundError extends Error {
  constructor() {
    super('The requested PDF mapping repair target does not exist.');
    this.name = 'PdfMappingRepairTargetNotFoundError';
  }
}

const rejectUnavailableRuntime = (): Promise<never> =>
  Promise.reject(new WorkflowRuntimeUnavailableError());

export const unavailablePdfMappingRepairApi: PdfMappingRepairApi = {
  get: rejectUnavailableRuntime,
  start: rejectUnavailableRuntime,
};

const mapRunStatus = (status: WorkflowRun['status']): PdfMappingRepairStatus => {
  if (status === 'completed') return 'completed';
  if (status === 'failed' || status === 'cancelled' || status === 'expired') return 'failed';
  if (status === 'queued') return 'queued';
  return 'running';
};

const MAPPING_NODE_IDS = new Set([
  'prepare-course-source-finalization',
  'map-course-source-fast-batches',
  'map-course-source-fast-batch',
  'map-course-source-repair-batches',
  'map-course-source-repair-batch',
  'complete-course-source-finalization',
]);

const mapNodeStage = (node: WorkflowNodeRunState): PdfMappingRepairStage => {
  if (node.definitionId === 'persist-pdf-mapping-repair') return 'saving';
  return MAPPING_NODE_IDS.has(node.definitionId) ? 'mapping' : 'preparing';
};

const mapStage = (state: WorkflowRunState): PdfMappingRepairStage => {
  if (state.run.status === 'completed') return 'ready';
  const current = [...state.nodes].reverse().find(node => node.status !== 'completed');
  return current ? mapNodeStage(current) : 'preparing';
};

const parseRunInput = (run: WorkflowRun) => PdfMappingRepairWorkflowInputSchema.parse(run.input);

const createQueuedSnapshot = (run: WorkflowRun): PdfMappingRepairSnapshot => {
  const input = parseRunInput(run);
  return {
    createdAt: run.createdAt,
    id: run.id,
    projectId: input.projectId,
    stage: 'preparing',
    status: mapRunStatus(run.status),
    updatedAt: run.updatedAt,
  };
};

const createSnapshot = (run: WorkflowRun, state: WorkflowRunState): PdfMappingRepairSnapshot => {
  const input = parseRunInput(run);
  const result =
    state.run.status === 'completed' ? PdfMappingRepairResultSchema.parse(run.output) : undefined;
  return {
    createdAt: state.run.createdAt,
    ...(state.run.error?.code ? { errorCode: state.run.error.code } : {}),
    id: state.run.id,
    projectId: input.projectId,
    ...(result ? { result } : {}),
    stage: mapStage(state),
    status: mapRunStatus(state.run.status),
    updatedAt: state.run.updatedAt,
  };
};

export const createPdfMappingRepairStarter = (dependencies: {
  readonly publishTransientEvent?: WorkflowTransientEventPublisher;
  readonly registry: WorkflowRegistry;
  readonly resolveModels: (
    aiProvider?: unknown,
    aiProviderOverrides?: unknown
  ) => Promise<GlobalModelConfig>;
  readonly store: WorkflowRunCreator;
}): PdfMappingRepairStarter => ({
  async start(input) {
    const models = await dependencies.resolveModels(input.aiProvider, input.aiProviderOverrides);
    return startWorkflowRun({
      configOverride: { models },
      dedupeKey: JSON.stringify([PDF_MAPPING_REPAIR_WORKFLOW_ID, input.projectId]),
      input: {
        projectId: input.projectId,
        userId: input.userId,
      },
      projectId: input.projectId,
      publishTransientEvent: dependencies.publishTransientEvent,
      registry: dependencies.registry,
      requestKey: input.requestKey,
      store: dependencies.store,
      userId: input.userId,
      workflowId: PDF_MAPPING_REPAIR_WORKFLOW_ID,
    });
  },
});

export const createPdfMappingRepairApi = (dependencies: {
  readonly projectReader: PdfMappingRepairProjectReader;
  readonly runReader: PdfMappingRepairRunReader;
  readonly starter: PdfMappingRepairStarter;
}): PdfMappingRepairApi => ({
  async get(input) {
    const state = await dependencies.runReader.getRunState(input);
    const run = state ? await dependencies.runReader.getRun(input) : null;
    if (!run || !state || run.workflowId !== PDF_MAPPING_REPAIR_WORKFLOW_ID) return null;
    return createSnapshot(run, state);
  },

  async start(input) {
    const project = await dependencies.projectReader.loadProjectWithRevision(
      input.userId,
      input.projectId
    );
    if (!project) throw new PdfMappingRepairTargetNotFoundError();
    if (!needsPdfMappingRepair(getProjectPdfMappingRepairState(project.snapshot))) {
      return {
        result: {
          projectId: input.projectId,
          projectRevision: project.revision,
          repaired: false,
        },
      };
    }

    const started = await dependencies.starter.start(input);
    if (started.created) {
      return { created: true, job: createQueuedSnapshot(started.run) };
    }
    const request = { runId: started.run.id, userId: input.userId };
    const state = await dependencies.runReader.getRunState(request);
    const run = state ? await dependencies.runReader.getRun(request) : null;
    if (!run || !state || run.workflowId !== PDF_MAPPING_REPAIR_WORKFLOW_ID) {
      throw new WorkflowRunNotFoundError();
    }
    return { created: false, job: createSnapshot(run, state) };
  },
});
