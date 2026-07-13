// Exposes project CRUD routes for the backend API.
import { type Request, type Response, Router } from 'express';

import { getAuthMode, getCurrentUser } from '../auth/currentUser.js';
import { publishProjectRevision, subscribeToProjectRevisions } from '../projects/projectEvents.js';
import {
  completeProjectImportUpload,
  ProjectImportInputError,
  storeProjectImportChunk,
} from '../projects/projectImportChunks.js';
import { ProjectRevisionConflictError } from '../projects/projectRevision.js';
import { getProjectStore } from '../projects/projectStore.js';
import type {
  ProjectPatch,
  ProjectRevisionEvent,
  ProjectSnapshot,
  ProjectSourceFile,
  SectionPatch,
} from '../projects/types.js';
import { sendErrorResponse } from '../utils/httpResponses.js';
import { timestampIso } from '../utils/time.js';
import {
  isRecord,
  readNullableString,
  readOptionalString,
  readStringArray,
} from '../utils/validation.js';

const router = Router();

const PROJECT_SOURCE_KINDS = new Set(['document', 'codebase', 'learn-mode', 'imported-json']);
const PROJECT_EVENT_HEARTBEAT_MS = 25_000;
const LIBRARY_IMPORT_DIAGNOSTIC_CODES = new Set([
  'LIBRARY_ARCHIVE_ENTRY_MISSING',
  'LIBRARY_ARCHIVE_INVALID',
  'LIBRARY_ARCHIVE_PROJECT_INVALID',
  'LIBRARY_ARCHIVE_PROJECT_TOO_LARGE',
  'LIBRARY_ARCHIVE_SINGLE_PROJECT',
  'LIBRARY_ARCHIVE_UNEXPECTED',
  'LIBRARY_ARCHIVE_VERSION_UNSUPPORTED',
  'LIBRARY_ARCHIVE_ZIP_UNREADABLE',
]);
const LIBRARY_IMPORT_DIAGNOSTIC_STAGES = new Set([
  'manifest-read',
  'nested-project-read',
  'unknown',
  'zip-open',
]);
const CORRELATION_ID_PATTERN = /^[0-9a-f-]{36}$/u;

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

const readExpectedRevision = (body: Record<string, unknown>): number | undefined => {
  if (body.expectedRevision === undefined) {
    return undefined;
  }
  if (!Number.isSafeInteger(body.expectedRevision) || (body.expectedRevision as number) < 1) {
    throw new Error('Revisione progetto non valida.');
  }
  return body.expectedRevision as number;
};

const readOptionalSafeInteger = (value: unknown): number | undefined =>
  Number.isSafeInteger(value) && (value as number) >= 0 ? (value as number) : undefined;

const publishMetaRevision = (userId: string, meta: { id: string; revision?: number }): void => {
  if (typeof meta.revision === 'number') {
    publishProjectRevision(userId, { projectId: meta.id, revision: meta.revision });
  }
};

const sendProjectWriteError = (res: Response, error: unknown, fallbackMessage: string): void => {
  sendErrorResponse(
    res,
    error instanceof ProjectRevisionConflictError ? 409 : 400,
    error,
    fallbackMessage
  );
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

const requireProjectSourceFile = (body: unknown): ProjectSourceFile => {
  const source = getBodyRecord(body).source;
  if (
    !isRecord(source) ||
    typeof source.name !== 'string' ||
    typeof source.mimeType !== 'string' ||
    typeof source.data !== 'string' ||
    !source.data
  ) {
    throw new Error('Sorgente progetto mancante o non valida.');
  }

  return {
    name: source.name,
    mimeType: source.mimeType,
    data: source.data,
  };
};

router.get('/config', (req: Request, res: Response) => {
  try {
    const currentUser = getCurrentUser(req);
    res.json({
      success: true,
      config: {
        ...getProjectStore().getConfig(),
        authMode: getAuthMode(),
        userId: currentUser.id,
      },
    });
  } catch (error) {
    sendErrorResponse(res, 500, error, 'Failed to read project sync config');
  }
});

router.get('/events', (req: Request, res: Response) => {
  const userId = getCurrentUser(req).id;
  res.status(200);
  res.set({
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'Content-Type': 'text/event-stream',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();
  res.write('retry: 2000\n\n');

  const unsubscribe = subscribeToProjectRevisions(userId, event => {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  });
  const heartbeat = globalThis.setInterval(
    () => res.write(': heartbeat\n\n'),
    PROJECT_EVENT_HEARTBEAT_MS
  );
  req.on('close', () => {
    globalThis.clearInterval(heartbeat);
    unsubscribe();
  });
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

router.get('/projects/:id/source', async (req: Request, res: Response) => {
  try {
    const source = await getProjectStore().loadProjectSource(
      getCurrentUser(req).id,
      getRouteParam(req.params.id)
    );
    res.json({ success: true, source });
  } catch (error) {
    sendErrorResponse(res, 500, error, 'Failed to load project source');
  }
});

router.post('/projects/:id/source', async (req: Request, res: Response) => {
  try {
    const sourceRef = await getProjectStore().saveProjectSource(
      getCurrentUser(req).id,
      getRouteParam(req.params.id),
      requireProjectSourceFile(req.body)
    );
    res.json({ success: true, sourceRef });
  } catch (error) {
    sendErrorResponse(res, 400, error, 'Failed to save project source');
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
    const meta = await getProjectStore().saveProject(userId, snapshot, {
      expectedRevision: readExpectedRevision(bodyRecord),
    });
    publishMetaRevision(userId, meta);
    res.json({ success: true, meta });
  } catch (error) {
    sendProjectWriteError(res, error, 'Failed to save project');
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
    learningAids: Array.isArray(value.learningAids) ? value.learningAids : undefined,
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
    const body = getBodyRecord(req.body);
    const projectId = getRouteParam(req.params.id);
    const userId = getCurrentUser(req).id;
    const patch = requireProjectPatch(body, projectId);
    const meta = await getProjectStore().patchProject(userId, projectId, patch, {
      expectedRevision: readExpectedRevision(body),
    });
    publishMetaRevision(userId, meta);
    res.json({ success: true, meta });
  } catch (error) {
    sendProjectWriteError(res, error, 'Failed to patch project');
  }
});

router.delete('/projects/:id', async (req: Request, res: Response) => {
  try {
    const userId = getCurrentUser(req).id;
    const projectId = getRouteParam(req.params.id);
    const existingMeta = (await getProjectStore().listProjects(userId)).find(
      project => project.id === projectId
    );
    await getProjectStore().deleteProject(userId, projectId);
    if (existingMeta?.revision) {
      const event: ProjectRevisionEvent = {
        deleted: true,
        projectId,
        revision: existingMeta.revision + 1,
      };
      publishProjectRevision(userId, event);
    }
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
    const userId = getCurrentUser(req).id;
    const imported = await getProjectStore().importProject(userId, getBodyRecord(req.body).data);
    publishMetaRevision(userId, imported.meta);
    res.json({ success: true, ...imported });
  } catch (error) {
    sendErrorResponse(res, 400, error, 'Failed to import project');
  }
});

router.post('/import/chunks', async (req: Request, res: Response) => {
  try {
    const userId = getCurrentUser(req).id;
    const body = getBodyRecord(req.body);
    const result = await storeProjectImportChunk({
      userId,
      uploadId: readOptionalString(body.uploadId) || '',
      chunkIndex: readOptionalSafeInteger(body.chunkIndex) ?? -1,
      chunkCount: readOptionalSafeInteger(body.chunkCount) ?? -1,
      chunk: typeof body.chunk === 'string' ? body.chunk : '',
    });
    res.status(202).json({ success: true, complete: false, ...result });
  } catch (error) {
    sendErrorResponse(
      res,
      error instanceof ProjectImportInputError ? 400 : 500,
      error,
      'Failed to store project import chunk'
    );
  }
});

router.post('/import/chunks/:uploadId/complete', async (req: Request, res: Response) => {
  try {
    const userId = getCurrentUser(req).id;
    const store = getProjectStore();
    const completed = await completeProjectImportUpload({
      userId,
      uploadId: getRouteParam(req.params.uploadId),
      importData: async data => {
        const imported = await store.importProject(userId, data);
        publishMetaRevision(userId, imported.meta);
        return { projectId: imported.meta.id, meta: imported.meta };
      },
    });
    const snapshot = await store.loadProject(userId, completed.projectId);
    if (!snapshot) {
      throw new Error('Imported project could not be loaded.');
    }
    res.json({ success: true, complete: true, meta: completed.meta, snapshot });
  } catch (error) {
    sendErrorResponse(
      res,
      error instanceof ProjectImportInputError ? 400 : 500,
      error,
      'Failed to complete project import'
    );
  }
});

router.post('/import-diagnostics', (req: Request, res: Response) => {
  try {
    const body = getBodyRecord(req.body);
    const correlationId = readOptionalString(body.correlationId);
    const code = readOptionalString(body.code);
    const stage = readOptionalString(body.stage);
    if (
      !correlationId ||
      !CORRELATION_ID_PATTERN.test(correlationId) ||
      !code ||
      !LIBRARY_IMPORT_DIAGNOSTIC_CODES.has(code) ||
      !stage ||
      !LIBRARY_IMPORT_DIAGNOSTIC_STAGES.has(stage)
    ) {
      throw new Error('Diagnostica importazione non valida.');
    }

    console.warn('[Projects] Library backup import failed.', {
      correlationId,
      code,
      stage,
      userId: getCurrentUser(req).id,
      fileBytes: readOptionalSafeInteger(body.fileBytes),
      limitBytes: readOptionalSafeInteger(body.limitBytes),
      projectCount: readOptionalSafeInteger(body.projectCount),
      projectIndex: readOptionalSafeInteger(body.projectIndex),
    });
    res.status(204).end();
  } catch (error) {
    sendErrorResponse(res, 400, error, 'Failed to record import diagnostic');
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
