import { type NextFunction, type Request, type Response, Router } from 'express';

import { getCurrentUser } from '../auth/currentUser.js';
import { getProjectStore } from '../projects/projectStore.js';
import {
  enqueueGenerationJob,
  getGenerationJob,
  getLatestLessonGenerationJob,
  waitForGenerationJob,
} from '../services/generationJobService.js';
import { isRecord } from '../utils/validation.js';

const router = Router();
const MAX_IMAGE_PROMPT_CHARS = 12_000;
const MAX_DEDUPE_KEY_CHARS = 200;
const GENERATION_JOB_CACHE_CONTROL = 'private, no-store';
const asyncRoute =
  (handler: (req: Request, res: Response) => Promise<unknown>) =>
  (req: Request, res: Response, next: NextFunction): void => {
    void handler(req, res).catch(next);
  };

router.post(
  '/lessons',
  asyncRoute(async (req: Request, res: Response) => {
    const projectId = typeof req.body?.projectId === 'string' ? req.body.projectId.trim() : '';
    const sectionId = typeof req.body?.sectionId === 'string' ? req.body.sectionId.trim() : '';
    const forceRegenerate = req.body?.forceRegenerate === true;
    const requestKey = typeof req.body?.requestKey === 'string' ? req.body.requestKey.trim() : '';
    if (!projectId || !sectionId || (forceRegenerate && !requestKey)) {
      return res
        .status(400)
        .json({ success: false, error: 'Richiesta di generazione non valida.' });
    }

    const currentUser = getCurrentUser(req);
    const project = await getProjectStore().loadProject(currentUser.id, projectId);
    const sectionExists = project?.learningPlan?.modules?.some(module =>
      module.children?.some(child => child.id === sectionId && child.kind !== 'exercise')
    );
    if (!project || !sectionExists) {
      return res.status(404).json({ success: false, error: 'Lezione non trovata.' });
    }

    const regenerationSuffix = forceRegenerate ? `:regenerate:${requestKey}` : '';
    const { created, job } = await enqueueGenerationJob({
      dedupeKey: `lesson:${projectId}:${sectionId}${regenerationSuffix}`,
      kind: 'lesson',
      payload: {
        aiProvider: currentUser.aiProvider,
        aiProviderOverrides: currentUser.aiProviderOverrides,
        forceRegenerate,
        projectId,
        sectionId,
      },
      projectId,
      userId: currentUser.id,
    });
    const activeSectionId = isRecord(job.payload) ? job.payload.sectionId : undefined;
    if (!created && typeof activeSectionId === 'string' && activeSectionId !== sectionId) {
      return res.status(409).json({
        success: false,
        error: 'È già in corso la generazione di un’altra lezione di questo corso.',
        job,
      });
    }
    return res.status(created ? 202 : 200).json({ success: true, job });
  })
);

router.post(
  '/images',
  asyncRoute(async (req: Request, res: Response) => {
    const projectId = typeof req.body?.projectId === 'string' ? req.body.projectId.trim() : '';
    const prompt = typeof req.body?.prompt === 'string' ? req.body.prompt.trim() : '';
    const dedupeKey = typeof req.body?.dedupeKey === 'string' ? req.body.dedupeKey.trim() : '';
    if (
      !projectId ||
      !prompt ||
      prompt.length > MAX_IMAGE_PROMPT_CHARS ||
      !dedupeKey ||
      dedupeKey.length > MAX_DEDUPE_KEY_CHARS
    ) {
      return res
        .status(400)
        .json({ success: false, error: 'Richiesta di generazione non valida.' });
    }

    const currentUser = getCurrentUser(req);
    const project = await getProjectStore().loadProject(currentUser.id, projectId);
    if (!project) {
      return res.status(404).json({ success: false, error: 'Progetto non trovato.' });
    }

    const { created, job } = await enqueueGenerationJob({
      dedupeKey: `image:${projectId}:${dedupeKey}`,
      kind: 'image',
      payload: {
        aiProvider: currentUser.aiProvider,
        aiProviderOverrides: currentUser.aiProviderOverrides,
        prompt,
      },
      projectId,
      userId: currentUser.id,
    });
    return res.status(created ? 202 : 200).json({ success: true, job });
  })
);

router.get(
  '/lessons/:projectId/:sectionId/latest',
  asyncRoute(async (req: Request, res: Response) => {
    res.set('Cache-Control', GENERATION_JOB_CACHE_CONTROL);
    const currentUser = getCurrentUser(req);
    const job = await getLatestLessonGenerationJob(
      currentUser.id,
      String(req.params.projectId),
      String(req.params.sectionId)
    );
    if (!job) return res.status(404).json({ success: false, error: 'Generazione non trovata.' });
    return res.json({ success: true, job });
  })
);

router.get(
  '/:jobId',
  asyncRoute(async (req: Request, res: Response) => {
    res.set('Cache-Control', GENERATION_JOB_CACHE_CONTROL);
    const currentUser = getCurrentUser(req);
    const job = await getGenerationJob(currentUser.id, String(req.params.jobId));
    if (!job) return res.status(404).json({ success: false, error: 'Generazione non trovata.' });
    return res.json({ success: true, job });
  })
);

router.get(
  '/:jobId/wait',
  asyncRoute(async (req: Request, res: Response) => {
    res.set('Cache-Control', GENERATION_JOB_CACHE_CONTROL);
    const currentUser = getCurrentUser(req);
    const controller = new AbortController();
    const onClientDisconnect = () => {
      if (res.writableEnded) return;
      controller.abort();
      console.info('[Generation job] Client observer disconnected.', {
        jobId: String(req.params.jobId),
      });
    };
    res.once('close', onClientDisconnect);
    const job = await waitForGenerationJob(
      currentUser.id,
      String(req.params.jobId),
      controller.signal,
      typeof req.query.afterStage === 'string' ? req.query.afterStage : undefined
    );
    res.off('close', onClientDisconnect);
    if (controller.signal.aborted) return;
    if (!job) return res.status(404).json({ success: false, error: 'Generazione non trovata.' });
    return res.json({ success: true, job });
  })
);

export default router;
