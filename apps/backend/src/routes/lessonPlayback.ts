import { Router } from 'express';
import * as z from 'zod';

import { getCurrentUser } from '../auth/currentUser.js';
import {
  type LessonPlaybackApi,
  LessonPlaybackStaleError,
  LessonPlaybackTargetError,
} from '../workflows/lessonPlaybackApi.js';
import { createWorkflowAsyncRoute } from './workflows.js';

const targetSchema = z.object({
  projectId: z.string().trim().min(1),
  sectionId: z.string().trim().min(1),
});
const prepareParametersSchema = targetSchema.extend({ blockId: z.string().trim().min(1) });
const prepareBodySchema = z
  .object({ lessonKey: z.string().length(64), voice: z.string().trim().min(1) })
  .strict();
const INVALID_REQUEST = {
  success: false,
  code: 'lesson_playback_request_invalid',
  error: 'Richiesta di ascolto non valida.',
};

export const createLessonPlaybackRouter = (api: LessonPlaybackApi): Router => {
  const router = Router();
  const asyncRoute = createWorkflowAsyncRoute((response, error) => {
    if (error instanceof LessonPlaybackTargetError) {
      response
        .status(404)
        .json({ success: false, code: 'lesson_playback_not_found', error: 'Lezione non trovata.' });
      return true;
    }
    if (error instanceof LessonPlaybackStaleError) {
      response.status(409).json({
        success: false,
        code: 'lesson_playback_stale',
        error: 'La lezione è cambiata. Riaprila per ascoltarla.',
      });
      return true;
    }
    return false;
  });
  router.get(
    '/:projectId/sections/:sectionId/playback',
    asyncRoute(async (request, response) => {
      const params = targetSchema.safeParse(request.params);
      if (!params.success) return response.status(400).json(INVALID_REQUEST);
      return response.json(await api.get({ ...params.data, userId: getCurrentUser(request).id }));
    })
  );
  router.post(
    '/:projectId/sections/:sectionId/playback/blocks/:blockId/prepare',
    asyncRoute(async (request, response) => {
      const params = prepareParametersSchema.safeParse(request.params);
      const body = prepareBodySchema.safeParse(request.body);
      if (!params.success || !body.success) return response.status(400).json(INVALID_REQUEST);
      const result = await api.prepare({
        ...params.data,
        ...body.data,
        userId: getCurrentUser(request).id,
      });
      return response.status('block' in result ? 200 : 202).json(result);
    })
  );
  return router;
};
