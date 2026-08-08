import type { WorkflowRegistry } from './definition.js';
import type { WorkflowCancellationRequestResult } from './postgresWorkflowCancellationStore.js';
import type {
  ReceiveWorkflowSignalInput,
  ReceiveWorkflowSignalResult,
} from './postgresWorkflowSignalStore.js';
import type { JsonValue, RegisteredWorkflow } from './types.js';
import {
  publishWorkflowTransientEvents,
  type WorkflowTransientEventPublisher,
} from './workflowObservability.js';
import {
  createWorkflowPublicRunState,
  type WorkflowPublicRunState,
  type WorkflowPublishedEventState,
  type WorkflowRunState,
} from './workflowReadModel.js';

export type WorkflowPublishedEventProjector = (
  state: WorkflowRunState
) => readonly WorkflowPublishedEventState[];

export interface WorkflowRuntimeApi {
  getRunState(input: { runId: string; userId: string }): Promise<WorkflowPublicRunState | null>;
  receiveSignal(input: {
    payload: JsonValue;
    requestKey: string;
    runId: string;
    signalType: string;
    userId: string;
    waitId: string;
  }): Promise<Pick<ReceiveWorkflowSignalResult, 'runId' | 'status'>>;
  requestCancellation(input: {
    runId: string;
    userId: string;
  }): Promise<WorkflowCancellationRequestResult>;
}

export class WorkflowRuntimeUnavailableError extends Error {
  constructor() {
    super('The workflow runtime API has not been composed.');
    this.name = 'WorkflowRuntimeUnavailableError';
  }
}

const rejectUnavailableRuntime = (): Promise<never> =>
  Promise.reject(new WorkflowRuntimeUnavailableError());

export const unavailableWorkflowRuntimeApi: WorkflowRuntimeApi = {
  getRunState: rejectUnavailableRuntime,
  receiveSignal: rejectUnavailableRuntime,
  requestCancellation: rejectUnavailableRuntime,
};

export interface WorkflowRuntimeApiStore {
  cancellation: {
    request(input: { runId: string; userId: string }): Promise<WorkflowCancellationRequestResult>;
  };
  getRunState(input: { runId: string; userId: string }): Promise<WorkflowRunState | null>;
  signals: {
    receive(input: ReceiveWorkflowSignalInput): Promise<ReceiveWorkflowSignalResult>;
  };
}

export const createWorkflowRuntimeApi = (input: {
  publishTransientEvent?: WorkflowTransientEventPublisher;
  publishedEventProjectors?: ReadonlyMap<string, WorkflowPublishedEventProjector>;
  registry: WorkflowRegistry;
  store: WorkflowRuntimeApiStore;
}): WorkflowRuntimeApi => ({
  async getRunState(request) {
    const state = await input.store.getRunState(request);
    if (!state) return null;
    const publishedEvents =
      input.publishedEventProjectors?.get(state.run.workflowId)?.(state) ?? [];
    return createWorkflowPublicRunState({ publishedEvents, state });
  },
  requestCancellation: request => input.store.cancellation.request(request),
  async receiveSignal(request) {
    const result = await input.store.signals.receive({
      payload: request.payload,
      requestKey: request.requestKey,
      resolveDefinition: boundary => {
        const definition = input.registry.resolve(boundary.workflowId, boundary.definitionHash);
        return definition?.definitionHashVersion === boundary.definitionHashVersion
          ? (definition as RegisteredWorkflow)
          : null;
      },
      runId: request.runId,
      signalType: request.signalType,
      userId: request.userId,
      waitId: request.waitId,
    });
    if (result.status === 'consumed') {
      publishWorkflowTransientEvents(
        input.publishTransientEvent,
        { runId: result.runId, workflowId: result.workflowId },
        result.transientEvents
      );
    }
    return { runId: result.runId, status: result.status };
  },
});
