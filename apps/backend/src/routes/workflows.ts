import { type NextFunction, type Request, type Response, Router } from 'express';
import * as z from 'zod';

import { getCurrentUser } from '../auth/currentUser.js';
import {
  type WorkflowRuntimeApi,
  WorkflowRuntimeUnavailableError,
} from '../workflows/runtime/workflowRuntimeApi.js';
import type { StepFailure } from '../workflows/types.js';
import {
  WorkflowReplicaOutdatedError,
  WorkflowRunNotFoundError,
  WorkflowRunRequestConflictError,
  WorkflowSignalError,
  type WorkflowSignalErrorCode,
} from '../workflows/workflowErrors.js';
import type { WorkflowPublicRunState } from '../workflows/workflowReadModel.js';

const WORKFLOW_CACHE_CONTROL = 'private, no-store';
const INVALID_REQUEST_RESPONSE = {
  code: 'workflow_request_invalid',
  error: 'Richiesta workflow non valida.',
  success: false,
} as const;
const RUN_NOT_FOUND_RESPONSE = {
  code: 'workflow_run_not_found',
  error: 'Esecuzione non trovata.',
  success: false,
} as const;
const RUNTIME_UNAVAILABLE_RESPONSE = {
  code: 'workflow_runtime_unavailable',
  error: 'Servizio workflow non disponibile.',
  success: false,
} as const;
const RUN_REQUEST_CONFLICT_RESPONSE = {
  code: 'workflow_run_request_conflict',
  error: 'Questa richiesta è già stata usata per un’altra operazione.',
  success: false,
} as const;

const routeParametersSchema = z.object({ runId: z.uuid() });
const waitRouteParametersSchema = routeParametersSchema.extend({ waitId: z.uuid() });
const cancellationBodySchema = z.preprocess(
  value => (value === undefined ? {} : value),
  z.object({}).strict()
);
const signalBodySchema = z
  .object({
    payload: z.json(),
    requestKey: z.string().trim().min(1),
    signalType: z.string().trim().min(1),
  })
  .strict();

interface WorkflowFailureDto {
  readonly code: string;
  readonly kind: StepFailure['kind'];
}

const toFailureDto = (failure: StepFailure): WorkflowFailureDto => ({
  code: failure.code,
  kind: failure.kind,
});

const toRunStateDto = (state: WorkflowPublicRunState) => ({
  publishedEvents: state.publishedEvents.map(event => ({
    createdAt: event.createdAt,
    eventType: event.eventType,
    payload: event.payload,
    schemaVersion: event.schemaVersion,
    sequence: event.sequence,
  })),
  nodes: state.nodes.map(node => ({
    attemptCount: node.attemptCount,
    availableAt: node.availableAt,
    ...(node.completedAt ? { completedAt: node.completedAt } : {}),
    createdAt: node.createdAt,
    definitionId: node.definitionId,
    ...(node.error ? { error: toFailureDto(node.error) } : {}),
    instanceId: node.instanceId,
    ...(node.itemKey ? { itemKey: node.itemKey } : {}),
    kind: node.kind,
    maxAttempts: node.maxAttempts,
    ...(node.parentInstanceId ? { parentInstanceId: node.parentInstanceId } : {}),
    status: node.status,
    updatedAt: node.updatedAt,
  })),
  run: {
    cancellationRequested: state.run.cancellationRequested,
    cleanupStatus: state.run.cleanupStatus,
    ...(state.run.completedAt ? { completedAt: state.run.completedAt } : {}),
    createdAt: state.run.createdAt,
    definitionHash: state.run.definitionHash,
    definitionHashVersion: state.run.definitionHashVersion,
    ...(state.run.error ? { error: toFailureDto(state.run.error) } : {}),
    id: state.run.id,
    ...(state.run.projectId ? { projectId: state.run.projectId } : {}),
    requestKey: state.run.requestKey,
    ...(state.run.startedAt ? { startedAt: state.run.startedAt } : {}),
    status: state.run.status,
    updatedAt: state.run.updatedAt,
    workflowId: state.run.workflowId,
  },
  waits: state.waits.map(wait => ({
    createdAt: wait.createdAt,
    expiresAt: wait.expiresAt,
    nodeInstanceId: wait.nodeInstanceId,
    schemaVersion: wait.schemaVersion,
    signalType: wait.signalType,
    waitId: wait.waitId,
  })),
});

type SignalErrorResponse = {
  code: string;
  error: string;
  status: number;
};

const SIGNAL_ERROR_RESPONSES: Record<WorkflowSignalErrorCode, SignalErrorResponse> = {
  workflow_signal_forbidden: {
    code: 'workflow_wait_not_found',
    error: 'Richiesta di conferma non trovata.',
    status: 404,
  },
  workflow_signal_request_conflict: {
    code: 'workflow_signal_request_conflict',
    error: 'Questa richiesta è già stata usata per una conferma diversa.',
    status: 409,
  },
  workflow_signal_type_mismatch: {
    code: 'workflow_signal_type_mismatch',
    error: 'La conferma non corrisponde alla richiesta in attesa.',
    status: 409,
  },
  workflow_wait_expired: {
    code: 'workflow_wait_expired',
    error: 'La richiesta di conferma è scaduta.',
    status: 410,
  },
  workflow_wait_obsolete: {
    code: 'workflow_wait_obsolete',
    error: 'La richiesta di conferma non è più attiva.',
    status: 409,
  },
  workflow_wait_unknown: {
    code: 'workflow_wait_not_found',
    error: 'Richiesta di conferma non trovata.',
    status: 404,
  },
};

export type WorkflowRouteErrorHandler = (response: Response, error: unknown) => boolean;

const sendKnownWorkflowError: WorkflowRouteErrorHandler = (response, error) => {
  if (error instanceof WorkflowRunNotFoundError) {
    response.status(404).json(RUN_NOT_FOUND_RESPONSE);
    return true;
  }
  if (error instanceof WorkflowSignalError) {
    const mapped = SIGNAL_ERROR_RESPONSES[error.code];
    response.status(mapped.status).json({ code: mapped.code, error: mapped.error, success: false });
    return true;
  }
  if (error instanceof z.ZodError) {
    response.status(400).json({
      code: 'workflow_signal_payload_invalid',
      error: 'Contenuto della conferma non valido.',
      success: false,
    });
    return true;
  }
  return false;
};

export const createWorkflowAsyncRoute = (sendDomainError: WorkflowRouteErrorHandler) =>
  function workflowAsyncRoute(handler: (request: Request, response: Response) => Promise<unknown>) {
    return (request: Request, response: Response, next: NextFunction): void => {
      void handler(request, response).catch(error => {
        if (
          error instanceof WorkflowRuntimeUnavailableError ||
          error instanceof WorkflowReplicaOutdatedError
        ) {
          response.status(503).json(RUNTIME_UNAVAILABLE_RESPONSE);
          return;
        }
        if (error instanceof WorkflowRunRequestConflictError) {
          response.status(409).json(RUN_REQUEST_CONFLICT_RESPONSE);
          return;
        }
        if (!sendDomainError(response, error)) next(error);
      });
    };
  };

export const createWorkflowRouter = (api: WorkflowRuntimeApi): Router => {
  const router = Router();
  const asyncRoute = createWorkflowAsyncRoute(sendKnownWorkflowError);

  router.get(
    '/runs/:runId',
    asyncRoute(async (request, response) => {
      const parameters = routeParametersSchema.safeParse(request.params);
      if (!parameters.success) return response.status(400).json(INVALID_REQUEST_RESPONSE);

      response.set('Cache-Control', WORKFLOW_CACHE_CONTROL);
      const state = await api.getRunState({
        runId: parameters.data.runId,
        userId: getCurrentUser(request).id,
      });
      if (!state) return response.status(404).json(RUN_NOT_FOUND_RESPONSE);
      return response.json({ state: toRunStateDto(state), success: true });
    })
  );

  router.post(
    '/runs/:runId/cancellation',
    asyncRoute(async (request, response) => {
      const parameters = routeParametersSchema.safeParse(request.params);
      const body = cancellationBodySchema.safeParse(request.body);
      if (!parameters.success || !body.success) {
        return response.status(400).json(INVALID_REQUEST_RESPONSE);
      }

      const cancellation = await api.requestCancellation({
        runId: parameters.data.runId,
        userId: getCurrentUser(request).id,
      });
      return response.json({ cancellation, success: true });
    })
  );

  router.post(
    '/runs/:runId/waits/:waitId/signals',
    asyncRoute(async (request, response) => {
      const parameters = waitRouteParametersSchema.safeParse(request.params);
      const body = signalBodySchema.safeParse(request.body);
      if (!parameters.success || !body.success) {
        return response.status(400).json(INVALID_REQUEST_RESPONSE);
      }

      const signal = await api.receiveSignal({
        payload: body.data.payload,
        requestKey: body.data.requestKey,
        runId: parameters.data.runId,
        signalType: body.data.signalType,
        userId: getCurrentUser(request).id,
        waitId: parameters.data.waitId,
      });
      return response.json({ signal, success: true });
    })
  );

  return router;
};
