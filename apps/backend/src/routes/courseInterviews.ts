import { CourseInterviewStartRequestSchema } from '@shared/courseInterviewContract.js';
import { Router } from 'express';
import * as z from 'zod';

import { getCurrentUser } from '../auth/currentUser.js';
import {
  type CourseInterviewApi,
  CourseInterviewTargetNotFoundError,
} from '../workflows/courseInterviewApi.js';
import { createWorkflowAsyncRoute, type WorkflowRouteErrorHandler } from './workflows.js';

const COURSE_INTERVIEW_CACHE_CONTROL = 'private, no-store';
const projectParametersSchema = z.object({ projectId: z.string().trim().min(1) });
const INVALID_REQUEST_RESPONSE = {
  code: 'course_interview_request_invalid',
  error: 'Richiesta di intervista non valida.',
  success: false,
} as const;

const sendCourseInterviewError: WorkflowRouteErrorHandler = (response, error) => {
  if (!(error instanceof CourseInterviewTargetNotFoundError)) return false;
  response.status(404).json({
    code: 'course_interview_not_found',
    error: 'Intervista non trovata.',
    success: false,
  });
  return true;
};

export const createCourseInterviewRouter = (api: CourseInterviewApi): Router => {
  const router = Router();
  const asyncRoute = createWorkflowAsyncRoute(sendCourseInterviewError);

  router.post(
    '/',
    asyncRoute(async (request, response) => {
      const body = CourseInterviewStartRequestSchema.safeParse(request.body);
      if (!body.success) return response.status(400).json(INVALID_REQUEST_RESPONSE);

      const user = getCurrentUser(request);
      const result = await api.start({
        aiProvider: user.aiProvider,
        aiProviderOverrides: user.aiProviderOverrides,
        ...body.data,
        userId: user.id,
      });
      return response.status(result.created ? 202 : 200).json({
        created: result.created,
        run: result.run,
        success: true,
      });
    })
  );

  router.get(
    '/:projectId/active',
    asyncRoute(async (request, response) => {
      response.set('Cache-Control', COURSE_INTERVIEW_CACHE_CONTROL);
      const parameters = projectParametersSchema.safeParse(request.params);
      if (!parameters.success) return response.status(400).json(INVALID_REQUEST_RESPONSE);

      const run = await api.getActive({
        projectId: parameters.data.projectId,
        userId: getCurrentUser(request).id,
      });
      if (!run) {
        return response.status(404).json({
          code: 'course_interview_active_run_not_found',
          error: 'Nessuna intervista attiva.',
          success: false,
        });
      }
      return response.json({ run, success: true });
    })
  );

  return router;
};
