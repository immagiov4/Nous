import { Router } from 'express';
import * as z from 'zod';

import { getCurrentUser } from '../auth/currentUser.js';
import {
  type LessonGenerationApi,
  LessonGenerationTargetNotFoundError,
} from '../workflows/lessonGenerationApi.js';
import { createWorkflowAsyncRoute, type WorkflowRouteErrorHandler } from './workflows.js';

const LESSON_WORKFLOW_CACHE_CONTROL = 'private, no-store';
const startBodySchema = z
  .object({
    forceRegenerate: z.boolean().optional().default(false),
    projectId: z.string().trim().min(1),
    requestKey: z.string().trim().min(1),
    sectionId: z.string().trim().min(1),
  })
  .strict();
const startSublessonBodySchema = z
  .object({
    annotationNote: z.string().optional(),
    contextAfter: z.string().optional(),
    contextBefore: z.string().optional(),
    instructions: z.string(),
    parentSectionId: z.string().trim().min(1),
    projectId: z.string().trim().min(1),
    requestKey: z.string().trim().min(1),
    selectedText: z.string().trim().min(1),
  })
  .strict();
const runParametersSchema = z.object({ runId: z.string().trim().min(1) });
const requestLookupBodySchema = z.object({ requestKey: z.string().trim().min(1) }).strict();

const INVALID_REQUEST_RESPONSE = {
  code: 'lesson_generation_request_invalid',
  error: 'Richiesta di generazione non valida.',
  success: false,
} as const;

const sendLessonWorkflowError: WorkflowRouteErrorHandler = (response, error) => {
  if (!(error instanceof LessonGenerationTargetNotFoundError)) return false;
  response.status(404).json({
    code: 'lesson_generation_not_found',
    error: 'Lezione non trovata.',
    success: false,
  });
  return true;
};

export const createLessonWorkflowRouter = (api: LessonGenerationApi): Router => {
  const router = Router();
  const asyncRoute = createWorkflowAsyncRoute(sendLessonWorkflowError);

  router.post(
    '/lessons',
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
      if (result.busy) {
        return response.status(409).json({
          code: 'lesson_generation_busy',
          error: 'È già in corso la generazione di un’altra lezione di questo corso.',
          job: result.job,
          success: false,
        });
      }
      return response.status(result.created ? 202 : 200).json({
        created: result.created,
        job: result.job,
        success: true,
      });
    })
  );

  router.post(
    '/sublessons',
    asyncRoute(async (request, response) => {
      const body = startSublessonBodySchema.safeParse(request.body);
      if (!body.success) return response.status(400).json(INVALID_REQUEST_RESPONSE);

      const user = getCurrentUser(request);
      const { parentSectionId, projectId, requestKey, ...focus } = body.data;
      const result = await api.startSublesson({
        aiProvider: user.aiProvider,
        aiProviderOverrides: user.aiProviderOverrides,
        focus,
        parentSectionId,
        projectId,
        requestKey,
        userId: user.id,
      });
      if (result.busy) {
        return response.status(409).json({
          code: 'lesson_generation_busy',
          error: 'È già in corso la generazione di un’altra lezione di questo corso.',
          job: result.job,
          success: false,
        });
      }
      return response.status(result.created ? 202 : 200).json({
        created: result.created,
        job: result.job,
        success: true,
      });
    })
  );

  router.get(
    '/runs/:runId',
    asyncRoute(async (request, response) => {
      response.set('Cache-Control', LESSON_WORKFLOW_CACHE_CONTROL);
      const parameters = runParametersSchema.safeParse(request.params);
      if (!parameters.success) return response.status(400).json(INVALID_REQUEST_RESPONSE);

      const user = getCurrentUser(request);
      const job = await api.get({ runId: parameters.data.runId, userId: user.id });
      if (!job) {
        return response.status(404).json({
          code: 'lesson_generation_run_not_found',
          error: 'Generazione non trovata.',
          success: false,
        });
      }
      return response.json({ job, success: true });
    })
  );

  router.post(
    '/requests/resolve',
    asyncRoute(async (request, response) => {
      response.set('Cache-Control', LESSON_WORKFLOW_CACHE_CONTROL);
      const body = requestLookupBodySchema.safeParse(request.body);
      if (!body.success) return response.status(400).json(INVALID_REQUEST_RESPONSE);

      const user = getCurrentUser(request);
      const job = await api.getByRequestKey({ requestKey: body.data.requestKey, userId: user.id });
      if (!job) {
        return response.status(404).json({
          code: 'lesson_generation_run_not_found',
          error: 'Generazione non trovata.',
          success: false,
        });
      }
      return response.json({ job, success: true });
    })
  );

  return router;
};
