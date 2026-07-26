import { type NextFunction, type Request, type Response, Router } from 'express';

import { getCurrentUser } from '../auth/currentUser.js';
import { getProjectStore } from '../projects/projectStore.js';
import {
  enqueueGenerationJob,
  getGenerationJob,
  waitForGenerationJob,
} from '../services/generationJobService.js';

const router = Router();
const MAX_IMAGE_PROMPT_CHARS = 12_000;
const MAX_DEDUPE_KEY_CHARS = 200;
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
  '/:jobId',
  asyncRoute(async (req: Request, res: Response) => {
    const currentUser = getCurrentUser(req);
    const job = await getGenerationJob(currentUser.id, String(req.params.jobId));
    if (!job) return res.status(404).json({ success: false, error: 'Generazione non trovata.' });
    return res.json({ success: true, job });
  })
);

router.get(
  '/:jobId/wait',
  asyncRoute(async (req: Request, res: Response) => {
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
      controller.signal
    );
    res.off('close', onClientDisconnect);
    if (controller.signal.aborted) return;
    if (!job) return res.status(404).json({ success: false, error: 'Generazione non trovata.' });
    return res.json({ success: true, job });
  })
);

export default router;
