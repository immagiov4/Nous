import { Router } from 'express';
import * as z from 'zod';

import { getCurrentUser } from '../auth/currentUser.js';
import {
  type ArtifactDraftApi,
  ArtifactDraftSourceNotFoundError,
  ArtifactDraftTargetNotFoundError,
} from '../workflows/artifactDraftApi.js';
import { createWorkflowAsyncRoute, type WorkflowRouteErrorHandler } from './workflows.js';

const ARTIFACT_DRAFT_CACHE_CONTROL = 'private, no-store';
const startBodySchema = z
  .object({
    generationNotes: z.string().optional(),
    lessonMarkdown: z.string().trim().min(1),
    projectId: z.string().trim().min(1),
    requestText: z.string().trim().min(1),
    requestedVisualKind: z.enum(['html', 'image', 'mermaid', 'svg']).optional(),
    requestKey: z.string().trim().min(1),
    sectionDescription: z.string(),
    sectionId: z.string().trim().min(1),
    sectionTitle: z.string().trim().min(1),
    sourceVisualId: z.string().trim().min(1).optional(),
  })
  .strict();
const runParametersSchema = z.object({ runId: z.string().trim().min(1) });

const INVALID_REQUEST_RESPONSE = {
  code: 'artifact_draft_request_invalid',
  error: 'Richiesta di generazione non valida.',
  success: false,
} as const;

const sendArtifactDraftError: WorkflowRouteErrorHandler = (response, error) => {
  if (error instanceof ArtifactDraftSourceNotFoundError) {
    response.status(404).json({
      code: 'artifact_draft_source_not_found',
      error: 'Artefatto sorgente non trovato.',
      success: false,
    });
    return true;
  }
  if (!(error instanceof ArtifactDraftTargetNotFoundError)) return false;
  response.status(404).json({
    code: 'artifact_draft_target_not_found',
    error: 'Lezione non trovata.',
    success: false,
  });
  return true;
};

export const createArtifactDraftRouter = (api: ArtifactDraftApi): Router => {
  const router = Router();
  const asyncRoute = createWorkflowAsyncRoute(sendArtifactDraftError);

  router.post(
    '/',
    asyncRoute(async (request, response) => {
      const body = startBodySchema.safeParse(request.body);
      if (!body.success) return response.status(400).json(INVALID_REQUEST_RESPONSE);

      const user = getCurrentUser(request);
      const result = await api.start({
        aiProvider: user.aiProvider,
        aiProviderOverrides: user.aiProviderOverrides,
        ...body.data,
        userId: user.id,
      });
      return response.status(result.created ? 202 : 200).json({ ...result, success: true });
    })
  );

  router.get(
    '/runs/:runId',
    asyncRoute(async (request, response) => {
      response.set('Cache-Control', ARTIFACT_DRAFT_CACHE_CONTROL);
      const parameters = runParametersSchema.safeParse(request.params);
      if (!parameters.success) return response.status(400).json(INVALID_REQUEST_RESPONSE);

      const user = getCurrentUser(request);
      const job = await api.get({ runId: parameters.data.runId, userId: user.id });
      if (!job) {
        return response.status(404).json({
          code: 'artifact_draft_run_not_found',
          error: 'Generazione non trovata.',
          success: false,
        });
      }
      return response.json({ job, success: true });
    })
  );

  return router;
};
