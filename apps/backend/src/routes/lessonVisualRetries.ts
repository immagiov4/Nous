import { Router } from 'express';
import * as z from 'zod';

import { getCurrentUser } from '../auth/currentUser.js';
import {
  LessonVisualRetryPlanError,
  type LessonVisualRetryStarter,
  LessonVisualRetryTargetError,
} from '../workflows/lessonVisualRetryStart.js';
import { createWorkflowAsyncRoute, type WorkflowRouteErrorHandler } from './workflows.js';

const parametersSchema = z.object({
  projectId: z.string().trim().min(1),
  sectionId: z.string().trim().min(1),
  slotId: z.string().trim().min(1),
});
const bodySchema = z.object({ requestKey: z.string().trim().min(1) }).strict();
const INVALID_REQUEST_RESPONSE = {
  code: 'lesson_visual_retry_request_invalid',
  error: 'Richiesta di rigenerazione non valida.',
  success: false,
} as const;

const sendLessonVisualRetryError: WorkflowRouteErrorHandler = (response, error) => {
  if (error instanceof LessonVisualRetryTargetError) {
    response.status(404).json({
      code: 'lesson_visual_retry_not_found',
      error: 'Esempio visivo da rigenerare non trovato.',
      success: false,
    });
    return true;
  }
  if (!(error instanceof LessonVisualRetryPlanError)) return false;
  response.status(409).json({
    code: 'lesson_visual_retry_plan_invalid',
    error: 'Questo esempio visivo non può essere rigenerato.',
    success: false,
  });
  return true;
};

export const createLessonVisualRetryRouter = (starter: LessonVisualRetryStarter): Router => {
  const router = Router();
  const asyncRoute = createWorkflowAsyncRoute(sendLessonVisualRetryError);
  router.post(
    '/:projectId/sections/:sectionId/visuals/:slotId/retry',
    asyncRoute(async (request, response) => {
      const parameters = parametersSchema.safeParse(request.params);
      const body = bodySchema.safeParse(request.body);
      if (!parameters.success || !body.success) {
        return response.status(400).json(INVALID_REQUEST_RESPONSE);
      }
      const user = getCurrentUser(request);
      const result = await starter.start({
        aiProvider: user.aiProvider,
        aiProviderOverrides: user.aiProviderOverrides,
        projectId: parameters.data.projectId,
        requestKey: body.data.requestKey,
        sectionId: parameters.data.sectionId,
        slotId: parameters.data.slotId,
        userId: user.id,
      });
      return response.status(result.created ? 202 : 200).json({
        created: result.created,
        run: {
          createdAt: result.run.createdAt,
          id: result.run.id,
          status: result.run.status,
          updatedAt: result.run.updatedAt,
        },
        success: true,
      });
    })
  );
  return router;
};
