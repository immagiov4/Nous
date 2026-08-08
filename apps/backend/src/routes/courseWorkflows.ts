import { Router } from 'express';
import * as z from 'zod';

import { getCurrentUser } from '../auth/currentUser.js';
import {
  type CourseGenerationApi,
  CourseGenerationTargetNotFoundError,
} from '../workflows/courseGenerationApi.js';
import {
  type PdfMappingRepairApi,
  PdfMappingRepairTargetNotFoundError,
  unavailablePdfMappingRepairApi,
} from '../workflows/pdfMappingRepairApi.js';
import { createWorkflowAsyncRoute, type WorkflowRouteErrorHandler } from './workflows.js';

const COURSE_WORKFLOW_CACHE_CONTROL = 'private, no-store';
const startBodySchema = z
  .object({
    assessmentHistory: z.array(
      z
        .object({
          role: z.enum(['model', 'user']),
          text: z.string(),
        })
        .strict()
    ),
    mode: z.enum(['document', 'learn']),
    projectId: z.string().trim().min(1),
    requestKey: z.string().trim().min(1),
  })
  .strict();
const runParametersSchema = z.object({ runId: z.string().trim().min(1) });
const pdfMappingRepairBodySchema = z
  .object({
    projectId: z.string().trim().min(1),
    requestKey: z.string().trim().min(1),
  })
  .strict();

const INVALID_REQUEST_RESPONSE = {
  code: 'course_generation_request_invalid',
  error: 'Richiesta di generazione non valida.',
  success: false,
} as const;

const sendCourseWorkflowError: WorkflowRouteErrorHandler = (response, error) => {
  if (
    !(error instanceof CourseGenerationTargetNotFoundError) &&
    !(error instanceof PdfMappingRepairTargetNotFoundError)
  ) {
    return false;
  }
  response.status(404).json({
    code: 'course_generation_not_found',
    error: 'Corso non trovato.',
    success: false,
  });
  return true;
};

export const createCourseWorkflowRouter = (
  api: CourseGenerationApi,
  pdfMappingRepairApi: PdfMappingRepairApi = unavailablePdfMappingRepairApi
): Router => {
  const router = Router();
  const asyncRoute = createWorkflowAsyncRoute(sendCourseWorkflowError);

  router.post(
    '/courses',
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
      return response.status(result.created ? 202 : 200).json({
        created: result.created,
        job: result.job,
        success: true,
      });
    })
  );

  router.get(
    '/courses/:projectId/active',
    asyncRoute(async (request, response) => {
      response.set('Cache-Control', COURSE_WORKFLOW_CACHE_CONTROL);
      const parameters = z
        .object({ projectId: z.string().trim().min(1) })
        .safeParse(request.params);
      if (!parameters.success) return response.status(400).json(INVALID_REQUEST_RESPONSE);

      const user = getCurrentUser(request);
      const job = await api.getActive({
        projectId: parameters.data.projectId,
        userId: user.id,
      });
      if (!job) {
        return response.status(404).json({
          code: 'course_generation_active_run_not_found',
          error: 'Nessuna generazione attiva.',
          success: false,
        });
      }
      return response.json({ job, success: true });
    })
  );

  router.get(
    '/runs/:runId',
    asyncRoute(async (request, response) => {
      response.set('Cache-Control', COURSE_WORKFLOW_CACHE_CONTROL);
      const parameters = runParametersSchema.safeParse(request.params);
      if (!parameters.success) return response.status(400).json(INVALID_REQUEST_RESPONSE);

      const user = getCurrentUser(request);
      const job = await api.get({ runId: parameters.data.runId, userId: user.id });
      if (!job) {
        return response.status(404).json({
          code: 'course_generation_run_not_found',
          error: 'Generazione non trovata.',
          success: false,
        });
      }
      return response.json({ job, success: true });
    })
  );

  router.post(
    '/pdf-mapping-repairs',
    asyncRoute(async (request, response) => {
      const body = pdfMappingRepairBodySchema.safeParse(request.body);
      if (!body.success) return response.status(400).json(INVALID_REQUEST_RESPONSE);

      const user = getCurrentUser(request);
      const result = await pdfMappingRepairApi.start({
        aiProvider: user.aiProvider,
        aiProviderOverrides: user.aiProviderOverrides,
        ...body.data,
        userId: user.id,
      });
      if ('result' in result) {
        return response.json({ result: result.result, success: true });
      }
      return response.status(result.created ? 202 : 200).json({
        created: result.created,
        job: result.job,
        success: true,
      });
    })
  );

  router.get(
    '/pdf-mapping-repairs/:runId',
    asyncRoute(async (request, response) => {
      response.set('Cache-Control', COURSE_WORKFLOW_CACHE_CONTROL);
      const parameters = runParametersSchema.safeParse(request.params);
      if (!parameters.success) return response.status(400).json(INVALID_REQUEST_RESPONSE);

      const job = await pdfMappingRepairApi.get({
        runId: parameters.data.runId,
        userId: getCurrentUser(request).id,
      });
      if (!job) {
        return response.status(404).json({
          code: 'pdf_mapping_repair_run_not_found',
          error: 'Riparazione PDF non trovata.',
          success: false,
        });
      }
      return response.json({ job, success: true });
    })
  );

  return router;
};
