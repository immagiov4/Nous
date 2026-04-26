import { type Request, type Response, Router } from 'express';

import { getCurrentUser, resolveCurrentUser } from '../auth/currentUser.js';
import { getProjectStore } from '../projects/projectStore.js';
import type { ProjectSnapshot } from '../projects/types.js';
import { sendErrorResponse } from '../utils/httpResponses.js';

const router = Router();

router.use(resolveCurrentUser);

const getTargetIndex = (value: unknown): number | undefined => {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    return undefined;
  }

  return Math.trunc(value);
};

const getRouteParam = (value: string | string[] | undefined): string =>
  Array.isArray(value) ? value[0] || '' : value || '';

router.get('/config', (req: Request, res: Response) => {
  try {
    const currentUser = getCurrentUser(req);
    res.json({
      success: true,
      config: {
        ...getProjectStore().getConfig(),
        authMode: 'local-bypass',
        userId: currentUser.id,
      },
    });
  } catch (error) {
    sendErrorResponse(res, 500, error, 'Failed to read project sync config');
  }
});

router.get('/projects', async (req: Request, res: Response) => {
  try {
    const projects = await getProjectStore().listProjects(getCurrentUser(req).id);
    res.json({ success: true, projects });
  } catch (error) {
    sendErrorResponse(res, 500, error, 'Failed to list projects');
  }
});

router.post('/projects/by-id', async (req: Request, res: Response) => {
  try {
    const ids = Array.isArray(req.body?.ids)
      ? req.body.ids.filter((id: unknown): id is string => typeof id === 'string')
      : [];
    const projects = await getProjectStore().loadProjectsById(getCurrentUser(req).id, ids);
    res.json({ success: true, projects });
  } catch (error) {
    sendErrorResponse(res, 500, error, 'Failed to load projects');
  }
});

router.get('/projects/:id', async (req: Request, res: Response) => {
  try {
    const project = await getProjectStore().loadProject(
      getCurrentUser(req).id,
      getRouteParam(req.params.id)
    );
    res.json({ success: true, project });
  } catch (error) {
    sendErrorResponse(res, 500, error, 'Failed to load project');
  }
});

router.put('/projects/:id', async (req: Request, res: Response) => {
  try {
    const snapshot = { ...req.body?.snapshot, id: getRouteParam(req.params.id) } as ProjectSnapshot;
    const meta = await getProjectStore().saveProject(getCurrentUser(req).id, snapshot);
    res.json({ success: true, meta });
  } catch (error) {
    sendErrorResponse(res, 400, error, 'Failed to save project');
  }
});

router.delete('/projects/:id', async (req: Request, res: Response) => {
  try {
    await getProjectStore().deleteProject(getCurrentUser(req).id, getRouteParam(req.params.id));
    res.json({ success: true });
  } catch (error) {
    sendErrorResponse(res, 500, error, 'Failed to delete project');
  }
});

router.post('/projects/:id/export', async (req: Request, res: Response) => {
  try {
    const data = await getProjectStore().exportProject(
      getCurrentUser(req).id,
      getRouteParam(req.params.id)
    );
    res.json({ success: true, data });
  } catch (error) {
    sendErrorResponse(res, 500, error, 'Failed to export project');
  }
});

router.post('/projects/:id/touch', async (req: Request, res: Response) => {
  try {
    await getProjectStore().touchProject(getCurrentUser(req).id, getRouteParam(req.params.id));
    res.json({ success: true });
  } catch (error) {
    sendErrorResponse(res, 500, error, 'Failed to touch project');
  }
});

router.post('/import', async (req: Request, res: Response) => {
  try {
    const imported = await getProjectStore().importProject(getCurrentUser(req).id, req.body?.data);
    res.json({ success: true, ...imported });
  } catch (error) {
    sendErrorResponse(res, 400, error, 'Failed to import project');
  }
});

router.get('/folders', async (req: Request, res: Response) => {
  try {
    const folders = await getProjectStore().listFolders(getCurrentUser(req).id);
    res.json({ success: true, folders });
  } catch (error) {
    sendErrorResponse(res, 500, error, 'Failed to list folders');
  }
});

router.post('/folders', async (req: Request, res: Response) => {
  try {
    const folder = await getProjectStore().createFolder(getCurrentUser(req).id, {
      name: typeof req.body?.name === 'string' ? req.body.name : '',
      parentFolderId:
        typeof req.body?.parentFolderId === 'string' || req.body?.parentFolderId === null
          ? req.body.parentFolderId
          : null,
    });
    res.json({ success: true, folder });
  } catch (error) {
    sendErrorResponse(res, 400, error, 'Failed to create folder');
  }
});

router.patch('/folders/:id', async (req: Request, res: Response) => {
  try {
    const folder = await getProjectStore().renameFolder(
      getCurrentUser(req).id,
      getRouteParam(req.params.id),
      typeof req.body?.name === 'string' ? req.body.name : ''
    );
    res.json({ success: true, folder });
  } catch (error) {
    sendErrorResponse(res, 400, error, 'Failed to rename folder');
  }
});

router.delete('/folders/:id', async (req: Request, res: Response) => {
  try {
    await getProjectStore().deleteFolder(getCurrentUser(req).id, getRouteParam(req.params.id));
    res.json({ success: true });
  } catch (error) {
    sendErrorResponse(res, 500, error, 'Failed to delete folder');
  }
});

router.post('/folders/:id/move', async (req: Request, res: Response) => {
  try {
    const parentFolderId =
      typeof req.body?.parentFolderId === 'string' || req.body?.parentFolderId === null
        ? req.body.parentFolderId
        : null;
    const folder = await getProjectStore().moveFolder(
      getCurrentUser(req).id,
      getRouteParam(req.params.id),
      parentFolderId,
      getTargetIndex(req.body?.targetIndex)
    );
    res.json({ success: true, folder });
  } catch (error) {
    sendErrorResponse(res, 400, error, 'Failed to move folder');
  }
});

router.get('/placements', async (req: Request, res: Response) => {
  try {
    const placements = await getProjectStore().listPlacements(getCurrentUser(req).id);
    res.json({ success: true, placements });
  } catch (error) {
    sendErrorResponse(res, 500, error, 'Failed to list placements');
  }
});

router.post('/placements/move', async (req: Request, res: Response) => {
  try {
    const projectIds = Array.isArray(req.body?.projectIds)
      ? req.body.projectIds.filter((id: unknown): id is string => typeof id === 'string')
      : [];
    const folderId =
      typeof req.body?.folderId === 'string' || req.body?.folderId === null
        ? req.body.folderId
        : null;
    const placements = await getProjectStore().moveProjects(
      getCurrentUser(req).id,
      projectIds,
      folderId,
      getTargetIndex(req.body?.targetIndex)
    );
    res.json({ success: true, placements });
  } catch (error) {
    sendErrorResponse(res, 400, error, 'Failed to move projects');
  }
});

export default router;
