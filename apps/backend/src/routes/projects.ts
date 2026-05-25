import { type Request, type Response, Router } from 'express';

import { getCurrentUser, LOCAL_AUTH_MODE, resolveCurrentUser } from '../auth/currentUser.js';
import { getProjectStore } from '../projects/projectStore.js';
import type { ProjectPatch, ProjectSnapshot, SectionPatch } from '../projects/types.js';
import { sendErrorResponse } from '../utils/httpResponses.js';
import { timestampIso } from '../utils/time.js';
import {
  isRecord,
  readNullableString,
  readOptionalString,
  readStringArray,
} from '../utils/validation.js';

const router = Router();

router.use(resolveCurrentUser);

const PROJECT_SOURCE_KINDS = new Set(['document', 'codebase', 'learn-mode', 'imported-json']);

const getTargetIndex = (value: unknown): number | undefined => {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    return undefined;
  }

  return Math.trunc(value);
};

const getRouteParam = (value: string | string[] | undefined): string =>
  Array.isArray(value) ? value[0] || '' : value || '';

const getBodyRecord = (body: unknown): Record<string, unknown> => {
  if (!isRecord(body)) {
    throw new Error('Corpo della richiesta non valido.');
  }

  return body;
};

const readProjectSourceKind = (value: unknown): ProjectSnapshot['sourceKind'] | undefined =>
  typeof value === 'string' && PROJECT_SOURCE_KINDS.has(value)
    ? (value as ProjectSnapshot['sourceKind'])
    : undefined;

const readLearningPlan = (value: unknown): ProjectSnapshot['learningPlan'] | undefined => {
  if (value === null) {
    return null;
  }

  if (!isRecord(value)) {
    return undefined;
  }

  if (value.sections !== undefined && !Array.isArray(value.sections)) {
    return undefined;
  }

  if (value.modules !== undefined && !Array.isArray(value.modules)) {
    return undefined;
  }

  return value as ProjectSnapshot['learningPlan'];
};

const readUserProfile = (value: unknown): ProjectSnapshot['userProfile'] | undefined => {
  if (value === null) {
    return null;
  }

  if (!isRecord(value)) {
    return undefined;
  }

  return value as ProjectSnapshot['userProfile'];
};

const requireProjectSnapshot = (body: unknown, routeProjectId: string): ProjectSnapshot => {
  const bodyRecord = getBodyRecord(body);
  const snapshotRecord = bodyRecord.snapshot;

  if (!isRecord(snapshotRecord)) {
    throw new Error('Snapshot progetto mancante o non valida.');
  }

  return {
    id: routeProjectId,
    version: readOptionalString(snapshotRecord.version) || '4.1',
    sourceKind: readProjectSourceKind(snapshotRecord.sourceKind),
    state: readOptionalString(snapshotRecord.state),
    source: snapshotRecord.source,
    learningPlan: readLearningPlan(snapshotRecord.learningPlan),
    isLearnMode:
      typeof snapshotRecord.isLearnMode === 'boolean' ? snapshotRecord.isLearnMode : undefined,
    userProfile: readUserProfile(snapshotRecord.userProfile),
    syllabus: Array.isArray(snapshotRecord.syllabus) ? snapshotRecord.syllabus : undefined,
    researchCoursePlan:
      snapshotRecord.researchCoursePlan === null || isRecord(snapshotRecord.researchCoursePlan)
        ? snapshotRecord.researchCoursePlan
        : undefined,
    researchDossiersBySectionId: isRecord(snapshotRecord.researchDossiersBySectionId)
      ? snapshotRecord.researchDossiersBySectionId
      : undefined,
    activeSectionId: readNullableString(snapshotRecord.activeSectionId),
    createdAt: readOptionalString(snapshotRecord.createdAt) || timestampIso(),
    updatedAt: readOptionalString(snapshotRecord.updatedAt) || timestampIso(),
    lastOpenedAt: readOptionalString(snapshotRecord.lastOpenedAt) || timestampIso(),
    documentAssets: snapshotRecord.documentAssets,
    documentIndex: snapshotRecord.documentIndex,
  };
};

router.get('/config', (req: Request, res: Response) => {
  try {
    const currentUser = getCurrentUser(req);
    res.json({
      success: true,
      config: {
        ...getProjectStore().getConfig(),
        authMode: LOCAL_AUTH_MODE,
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
    const ids = readStringArray(getBodyRecord(req.body).ids);
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
    const userId = getCurrentUser(req).id;
    const projectId = getRouteParam(req.params.id);
    const snapshot = requireProjectSnapshot(req.body, projectId);
    const bodyRecord = getBodyRecord(req.body);
    // Client autosave strips the PDF base64 from `source.file.data` to avoid
    // resending ~100 MB on every debounced save. When omitSource=true we
    // preserve the source already on disk instead of overwriting with the
    // stripped one.
    if (bodyRecord.omitSource === true) {
      const existing = await getProjectStore().loadProject(userId, projectId);
      if (existing?.source) {
        snapshot.source = existing.source;
      }
    }
    const meta = await getProjectStore().saveProject(userId, snapshot);
    res.json({ success: true, meta });
  } catch (error) {
    sendErrorResponse(res, 400, error, 'Failed to save project');
  }
});

const readSectionPatch = (body: Record<string, unknown>): SectionPatch | undefined => {
  const value = body.section;
  if (!isRecord(value)) {
    return undefined;
  }

  const sectionId = readNullableString(value.sectionId);
  if (!sectionId) {
    return undefined;
  }

  return {
    sectionId,
    annotations: Array.isArray(value.annotations) ? value.annotations : undefined,
    content: readOptionalString(value.content),
    generatedVisuals: Array.isArray(value.generatedVisuals) ? value.generatedVisuals : undefined,
    imageRefs: Array.isArray(value.imageRefs) ? value.imageRefs : undefined,
    isCompleted: typeof value.isCompleted === 'boolean' ? value.isCompleted : undefined,
    quiz: Array.isArray(value.quiz) ? value.quiz : undefined,
  };
};

const requireProjectPatch = (body: unknown, _routeProjectId: string): ProjectPatch => {
  const bodyRecord = getBodyRecord(body);
  const patchRecord = bodyRecord.patch;

  if (!isRecord(patchRecord)) {
    throw new Error('Patch progetto mancante o non valida.');
  }

  return {
    activeSectionId: readNullableString(patchRecord.activeSectionId),
    state: readOptionalString(patchRecord.state),
    isLearnMode: typeof patchRecord.isLearnMode === 'boolean' ? patchRecord.isLearnMode : undefined,
    source: patchRecord.source,
    learningPlan: patchRecord.learningPlan as Record<string, unknown> | null | undefined,
    userProfile: patchRecord.userProfile as Record<string, unknown> | null | undefined,
    syllabus: Array.isArray(patchRecord.syllabus) ? patchRecord.syllabus : undefined,
    researchCoursePlan:
      patchRecord.researchCoursePlan === null || isRecord(patchRecord.researchCoursePlan)
        ? (patchRecord.researchCoursePlan as Record<string, unknown> | null)
        : undefined,
    researchDossiersBySectionId: isRecord(patchRecord.researchDossiersBySectionId)
      ? patchRecord.researchDossiersBySectionId
      : undefined,
    documentAssets: patchRecord.documentAssets as Record<string, unknown> | null | undefined,
    documentIndex: patchRecord.documentIndex as Record<string, unknown> | null | undefined,
    section: readSectionPatch(patchRecord),
    updatedAt: readOptionalString(patchRecord.updatedAt),
  };
};

router.patch('/projects/:id', async (req: Request, res: Response) => {
  try {
    const patch = requireProjectPatch(req.body, getRouteParam(req.params.id));
    const meta = await getProjectStore().patchProject(
      getCurrentUser(req).id,
      getRouteParam(req.params.id),
      patch
    );
    res.json({ success: true, meta });
  } catch (error) {
    sendErrorResponse(res, 400, error, 'Failed to patch project');
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
    const imported = await getProjectStore().importProject(
      getCurrentUser(req).id,
      getBodyRecord(req.body).data
    );
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
    const body = getBodyRecord(req.body);
    const folder = await getProjectStore().createFolder(getCurrentUser(req).id, {
      name: readOptionalString(body.name) || '',
      parentFolderId: readNullableString(body.parentFolderId) ?? null,
    });
    res.json({ success: true, folder });
  } catch (error) {
    sendErrorResponse(res, 400, error, 'Failed to create folder');
  }
});

router.patch('/folders/:id', async (req: Request, res: Response) => {
  try {
    const body = getBodyRecord(req.body);
    const folder = await getProjectStore().renameFolder(
      getCurrentUser(req).id,
      getRouteParam(req.params.id),
      readOptionalString(body.name) || ''
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
    const body = getBodyRecord(req.body);
    const parentFolderId = readNullableString(body.parentFolderId) ?? null;
    const folder = await getProjectStore().moveFolder(
      getCurrentUser(req).id,
      getRouteParam(req.params.id),
      parentFolderId,
      getTargetIndex(body.targetIndex)
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
    const body = getBodyRecord(req.body);
    const projectIds = readStringArray(body.projectIds);
    const folderId = readNullableString(body.folderId) ?? null;
    const placements = await getProjectStore().moveProjects(
      getCurrentUser(req).id,
      projectIds,
      folderId,
      getTargetIndex(body.targetIndex)
    );
    res.json({ success: true, placements });
  } catch (error) {
    sendErrorResponse(res, 400, error, 'Failed to move projects');
  }
});

export default router;
