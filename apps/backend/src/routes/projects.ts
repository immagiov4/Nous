// Exposes project CRUD routes for the backend API.

import { Readable } from 'node:stream';

import { SOURCE_ARCHIVE_LESSON_CONTEXT_MAX_BYTES } from '@shared/sourceArchiveSelectors';
import { type Request, type Response, Router } from 'express';

import { getAuthMode, getCurrentUser } from '../auth/currentUser.js';
import { publishProjectRevision, subscribeToProjectRevisions } from '../projects/projectEvents.js';
import {
  cancelProjectImportUpload,
  completeProjectImportUpload,
  getProjectImportUploadStatus,
  ProjectImportCapacityError,
  ProjectImportInputError,
  storeProjectImportChunk,
} from '../projects/projectImportChunks.js';
import { getPublicProjectImportConfig } from '../projects/projectImportConfig.js';
import { ProjectRevisionConflictError } from '../projects/projectRevision.js';
import { getProjectStore } from '../projects/projectStore.js';
import { PROJECT_SOURCE_ARCHIVE_MAX_COMPRESSED_BYTES } from '../projects/sourceArchive.js';
import {
  SourceArchiveAccess,
  type SourceArchiveSelector,
} from '../projects/sourceArchiveAccess.js';
import type {
  ProjectCoverFile,
  ProjectPatch,
  ProjectRevisionEvent,
  ProjectSnapshot,
  ProjectSourceArchiveVersion,
  SectionPatch,
} from '../projects/types.js';
import {
  getCourseCoverRegenerationStatus,
  startOrResumeCourseCoverRegeneration,
} from '../services/courseCoverRegeneration.js';
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
const PROJECT_COVER_MAX_BYTES = 6 * 1024 * 1024;
const PROJECT_SNAPSHOT_MULTIPART_MAX_BYTES = 300_000_000;
const PROJECT_COVER_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const BASE64_DATA_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/u;
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
const CORRELATION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SOURCE_HASH_PATTERN = /^[0-9a-f]{64}$/u;
const COURSE_COVER_JOB_STATUS_ROUTE_ERROR = 'Unable to read course cover regeneration status.';
const COURSE_COVER_JOB_START_ROUTE_ERROR = 'Unable to start course cover regeneration.';
const ADMIN_REQUIRED_MESSAGE = 'Solo un amministratore puo eseguire questa operazione.';
const IMPORT_DIAGNOSTIC_LIST_ERROR = 'Unable to list import diagnostics.';
const IMPORT_DIAGNOSTIC_RECORD_ERROR = 'Unable to record import diagnostic.';

class ProjectImportDiagnosticInputError extends Error {}

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

const parseArchiveProjectSave = async (
  req: Request,
  projectId: string
): Promise<{
  snapshot: ProjectSnapshot;
  expectedRevision?: number;
  sourceFile: { bytes: Uint8Array; mimeType: string; name: string };
}> => {
  const multipartRequest = new globalThis.Request(`http://localhost${req.originalUrl}`, {
    body: Readable.toWeb(req) as unknown as ReadableStream,
    duplex: 'half',
    headers: req.headers as HeadersInit,
    method: req.method,
  } as RequestInit & { duplex: 'half' });
  const fields = await multipartRequest.formData();
  const archive = fields.get('archive');
  if (!(archive instanceof File)) {
    throw new Error('Archivio ZIP mancante.');
  }
  if (archive.size > PROJECT_SOURCE_ARCHIVE_MAX_COMPRESSED_BYTES) {
    throw new Error('L’archivio supera il limite massimo consentito.');
  }
  const serializedSnapshot = fields.get('snapshot');
  if (
    typeof serializedSnapshot !== 'string' ||
    Buffer.byteLength(serializedSnapshot, 'utf8') > PROJECT_SNAPSHOT_MULTIPART_MAX_BYTES
  ) {
    throw new Error('Snapshot progetto mancante o troppo grande.');
  }
  const snapshot = requireProjectSnapshot({ snapshot: JSON.parse(serializedSnapshot) }, projectId);
  const sourceFile = isRecord(snapshot.source) ? snapshot.source.file : null;
  if (
    !isRecord(snapshot.source) ||
    snapshot.source.kind !== 'archive' ||
    !isRecord(sourceFile) ||
    typeof sourceFile.name !== 'string' ||
    typeof sourceFile.mimeType !== 'string' ||
    sourceFile.name !== archive.name
  ) {
    throw new Error('La sorgente del progetto non è un archivio.');
  }
  const expectedRevisionField = fields.get('expectedRevision');
  const expectedRevision =
    expectedRevisionField === null
      ? undefined
      : readExpectedRevision({ expectedRevision: Number(expectedRevisionField) });
  return {
    snapshot,
    expectedRevision,
    sourceFile: {
      bytes: new Uint8Array(await archive.arrayBuffer()),
      mimeType: sourceFile.mimeType,
      name: sourceFile.name,
    },
  };
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

const requireSourceArchiveSelector = (value: unknown): SourceArchiveSelector => {
  if (
    !isRecord(value) ||
    (value.kind !== 'file' && value.kind !== 'directory') ||
    typeof value.path !== 'string'
  ) {
    throw new Error('Selettore sorgente archivio non valido.');
  }
  return { kind: value.kind, path: value.path };
};

class SourceArchiveVersionMismatchError extends Error {
  constructor() {
    super('L’archivio sorgente è cambiato. Ricarica il progetto e riprova.');
    this.name = 'SourceArchiveVersionMismatchError';
  }
}

const requireSourceArchiveVersion = (value: unknown): ProjectSourceArchiveVersion => {
  if (
    !isRecord(value) ||
    typeof value.sourceId !== 'string' ||
    !value.sourceId ||
    typeof value.sourceHash !== 'string' ||
    !SOURCE_HASH_PATTERN.test(value.sourceHash)
  ) {
    throw new Error('Versione archivio sorgente mancante o non valida.');
  }
  return { sourceHash: value.sourceHash, sourceId: value.sourceId };
};

const isSameSourceArchiveVersion = (
  left: ProjectSourceArchiveVersion,
  right: ProjectSourceArchiveVersion
): boolean => left.sourceId === right.sourceId && left.sourceHash === right.sourceHash;

const getSourceArchiveAccess = async (
  userId: string,
  projectId: string,
  expectedVersion: ProjectSourceArchiveVersion
) => {
  const store = getProjectStore();
  const index = await store.loadProjectSourceArchiveIndex(userId, projectId);
  if (!index) {
    return null;
  }
  if (!isSameSourceArchiveVersion(index.version, expectedVersion)) {
    throw new SourceArchiveVersionMismatchError();
  }
  const requireCurrentArchiveEntry = async (
    loadEntry: () => Promise<Uint8Array | null>
  ): Promise<Uint8Array> => {
    const bytes = await loadEntry();
    if (bytes) {
      return bytes;
    }
    const currentIndex = await store.loadProjectSourceArchiveIndex(userId, projectId);
    if (!currentIndex || !isSameSourceArchiveVersion(currentIndex.version, expectedVersion)) {
      throw new SourceArchiveVersionMismatchError();
    }
    throw new Error('Source archive entry is missing.');
  };
  return new SourceArchiveAccess({
    index: { entries: index.entries },
    maxContextBytes: SOURCE_ARCHIVE_LESSON_CONTEXT_MAX_BYTES,
    readByteRange: (path, start, endExclusive) =>
      requireCurrentArchiveEntry(() =>
        store.loadProjectSourceArchiveEntryRange(
          userId,
          projectId,
          path,
          expectedVersion,
          start,
          endExclusive
        )
      ),
    readBytes: path =>
      requireCurrentArchiveEntry(() =>
        store.loadProjectSourceArchiveEntry(userId, projectId, path, expectedVersion)
      ),
  });
};

const requireProjectCoverFile = (body: unknown): ProjectCoverFile => {
  const cover = getBodyRecord(body).cover;
  if (
    !isRecord(cover) ||
    typeof cover.name !== 'string' ||
    typeof cover.mimeType !== 'string' ||
    !PROJECT_COVER_MIME_TYPES.has(cover.mimeType) ||
    typeof cover.data !== 'string' ||
    !BASE64_DATA_PATTERN.test(cover.data)
  ) {
    throw new Error('Copertina progetto mancante o non valida.');
  }
  if (Buffer.from(cover.data, 'base64').byteLength > PROJECT_COVER_MAX_BYTES) {
    throw new Error('La copertina del progetto supera la dimensione massima consentita.');
  }
  return { name: cover.name, mimeType: cover.mimeType, data: cover.data };
};

router.get('/config', (req: Request, res: Response) => {
  try {
    const currentUser = getCurrentUser(req);
    res.json({
      success: true,
      config: {
        authMode: getAuthMode(),
        import: getPublicProjectImportConfig(),
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

router.get('/covers/regenerate/status', (req: Request, res: Response) => {
  res.set('Cache-Control', 'no-store');
  res.set('Pragma', 'no-cache');
  try {
    const currentUser = getCurrentUser(req);
    res.json({ success: true, job: getCourseCoverRegenerationStatus(currentUser.id) });
  } catch (error) {
    console.error('[Nous][CourseCover] Status route failed.', { error });
    res.status(500).json({ success: false, error: COURSE_COVER_JOB_STATUS_ROUTE_ERROR });
  }
});

router.get('/covers/regenerate', (req: Request, res: Response) => {
  res.set('Cache-Control', 'no-store');
  res.set('Pragma', 'no-cache');
  try {
    const currentUser = getCurrentUser(req);
    const job = startOrResumeCourseCoverRegeneration(
      currentUser.id,
      currentUser.aiProvider,
      currentUser.aiProviderOverrides
    );
    res.status(job.status === 'running' ? 202 : 200).json({ success: true, job });
  } catch (error) {
    console.error('[Nous][CourseCover] Start route failed.', { error });
    res.status(500).json({ success: false, error: COURSE_COVER_JOB_START_ROUTE_ERROR });
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
    const projectRecord = await getProjectStore().loadProjectWithRevision(
      getCurrentUser(req).id,
      getRouteParam(req.params.id)
    );
    res.json({
      success: true,
      project: projectRecord?.snapshot || null,
      revision: projectRecord?.revision,
    });
  } catch (error) {
    sendErrorResponse(res, 500, error, 'Failed to load project');
  }
});

router.patch('/projects/:id/favorite', async (req: Request, res: Response) => {
  try {
    const isFavorite = getBodyRecord(req.body).isFavorite;
    if (typeof isFavorite !== 'boolean') {
      throw new Error('Stato preferito non valido.');
    }
    const userId = getCurrentUser(req).id;
    const meta = await getProjectStore().setProjectFavorite(
      userId,
      getRouteParam(req.params.id),
      isFavorite
    );
    publishMetaRevision(userId, meta);
    res.json({ success: true, meta });
  } catch (error) {
    sendErrorResponse(res, 400, error, 'Failed to update project favorite');
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

router.get('/projects/:id/sources', async (req: Request, res: Response) => {
  try {
    const sources = await getProjectStore().loadProjectSources(
      getCurrentUser(req).id,
      getRouteParam(req.params.id)
    );
    res.json({ success: true, sources });
  } catch (error) {
    sendErrorResponse(res, 500, error, 'Failed to load project sources');
  }
});

router.get('/projects/:id/source/archive', async (req: Request, res: Response) => {
  try {
    const archiveIndex = await getProjectStore().loadProjectSourceArchiveIndex(
      getCurrentUser(req).id,
      getRouteParam(req.params.id)
    );
    if (!archiveIndex) {
      res.status(404).json({ success: false, error: 'Archivio sorgente non disponibile.' });
      return;
    }
    res.json({
      success: true,
      archiveIndex: { entries: archiveIndex.entries },
      archiveVersion: archiveIndex.version,
    });
  } catch (error) {
    sendErrorResponse(res, 500, error, 'Failed to load project source archive');
  }
});

router.post('/projects/:id/source/archive/query', async (req: Request, res: Response) => {
  try {
    const body = getBodyRecord(req.body);
    const archiveVersion = requireSourceArchiveVersion(body.archiveVersion);
    const access = await getSourceArchiveAccess(
      getCurrentUser(req).id,
      getRouteParam(req.params.id),
      archiveVersion
    );
    if (!access) {
      res.status(404).json({ success: false, error: 'Archivio sorgente non disponibile.' });
      return;
    }

    let result: unknown;
    switch (body.operation) {
      case 'tree':
        result = access.getTree();
        break;
      case 'list-directory':
        if (body.path !== undefined && typeof body.path !== 'string') {
          throw new Error('Percorso sorgente archivio non valido.');
        }
        result = access.listDirectory(body.path);
        break;
      case 'read-file':
        if (typeof body.path !== 'string') {
          throw new Error('Percorso sorgente archivio non valido.');
        }
        if (body.cursorBytes !== undefined && typeof body.cursorBytes !== 'number') {
          throw new Error('Cursore sorgente archivio non valido.');
        }
        result = await access.readTextPage(body.path, body.cursorBytes);
        break;
      case 'search-text':
        if (typeof body.query !== 'string') {
          throw new Error('Ricerca sorgente archivio non valida.');
        }
        result = await access.searchLiteral(body.query);
        break;
      case 'resolve-selectors': {
        if (!Array.isArray(body.selectors) || body.selectors.length === 0) {
          throw new Error('Selettori sorgente archivio mancanti.');
        }
        result = await access.resolveSelectors(body.selectors.map(requireSourceArchiveSelector));
        break;
      }
      default:
        throw new Error('Operazione sorgente archivio non valida.');
    }
    res.json({ success: true, result });
  } catch (error) {
    sendErrorResponse(
      res,
      error instanceof SourceArchiveVersionMismatchError ? 409 : 400,
      error,
      'Failed to query project source archive'
    );
  }
});

router.get('/projects/:id/cover', async (req: Request, res: Response) => {
  try {
    const cover = await getProjectStore().loadProjectCover(
      getCurrentUser(req).id,
      getRouteParam(req.params.id)
    );
    res.json({ success: true, cover });
  } catch (error) {
    sendErrorResponse(res, 500, error, 'Failed to load project cover');
  }
});

router.post('/projects/:id/cover', async (req: Request, res: Response) => {
  try {
    const saved = await getProjectStore().saveProjectCover(
      getCurrentUser(req).id,
      getRouteParam(req.params.id),
      requireProjectCoverFile(req.body)
    );
    if (!saved) {
      res.status(409).json({
        success: false,
        error: 'Il corso è cambiato prima del salvataggio della cover.',
      });
      return;
    }
    res.json({ success: true });
  } catch (error) {
    sendErrorResponse(res, 400, error, 'Failed to save project cover');
  }
});

router.put('/projects/:id', async (req: Request, res: Response) => {
  try {
    const userId = getCurrentUser(req).id;
    const projectId = getRouteParam(req.params.id);
    let snapshot: ProjectSnapshot;
    let expectedRevision: number | undefined;
    let sourceFile: { bytes: Uint8Array; mimeType: string; name: string } | undefined;
    if (req.is('multipart/form-data')) {
      ({ expectedRevision, snapshot, sourceFile } = await parseArchiveProjectSave(req, projectId));
    } else {
      snapshot = requireProjectSnapshot(req.body, projectId);
      if (
        isRecord(snapshot.source) &&
        snapshot.source.kind === 'archive' &&
        isRecord(snapshot.source.file) &&
        typeof snapshot.source.file.data === 'string' &&
        snapshot.source.file.data
      ) {
        throw new Error('Gli archivi devono essere inviati come file binari.');
      }
      expectedRevision = readExpectedRevision(getBodyRecord(req.body));
    }
    const saved = await getProjectStore().saveProject(userId, snapshot, {
      expectedRevision,
      sourceFile,
    });
    publishMetaRevision(userId, saved.meta);
    res.json({ success: true, ...saved });
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
    contentBlocks: Array.isArray(value.contentBlocks) ? value.contentBlocks : undefined,
    generatedVisuals: Array.isArray(value.generatedVisuals) ? value.generatedVisuals : undefined,
    imageRefs: Array.isArray(value.imageRefs) ? value.imageRefs : undefined,
    isCompleted: typeof value.isCompleted === 'boolean' ? value.isCompleted : undefined,
    learningAids: Array.isArray(value.learningAids) ? value.learningAids : undefined,
    quiz: Array.isArray(value.quiz) ? value.quiz : undefined,
    visualPlanningDecision: isRecord(value.visualPlanningDecision)
      ? value.visualPlanningDecision
      : undefined,
  };
};

const requireProjectPatch = (body: unknown, _routeProjectId: string): ProjectPatch => {
  const bodyRecord = getBodyRecord(body);
  const patchRecord = bodyRecord.patch;

  if (!isRecord(patchRecord)) {
    throw new Error('Patch progetto mancante o non valida.');
  }

  return {
    title: readOptionalString(patchRecord.title),
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

router.put('/import/chunks/:uploadId/:chunkIndex', async (req: Request, res: Response) => {
  try {
    const userId = getCurrentUser(req).id;
    const chunk = req.is('application/octet-stream')
      ? new Uint8Array(
          await new globalThis.Request(`http://localhost${req.originalUrl}`, {
            body: Readable.toWeb(req) as unknown as ReadableStream,
            duplex: 'half',
            headers: req.headers as HeadersInit,
            method: req.method,
          } as RequestInit & { duplex: 'half' }).arrayBuffer()
        )
      : typeof req.body === 'string'
        ? req.body
        : '';
    const result = await storeProjectImportChunk({
      userId,
      uploadId: getRouteParam(req.params.uploadId),
      chunkIndex: readOptionalSafeInteger(Number(getRouteParam(req.params.chunkIndex))) ?? -1,
      chunkCount: readOptionalSafeInteger(Number(req.query.chunkCount)) ?? -1,
      chunk,
    });
    res.status(202).json({ success: true, complete: false, ...result });
  } catch (error) {
    if (error instanceof ProjectImportCapacityError) res.set('Retry-After', '1');
    sendErrorResponse(
      res,
      error instanceof ProjectImportCapacityError
        ? 429
        : error instanceof ProjectImportInputError
          ? 400
          : 500,
      error,
      'Failed to store project import chunk'
    );
  }
});

router.delete('/import/chunks/:uploadId', async (req: Request, res: Response) => {
  try {
    await cancelProjectImportUpload(getCurrentUser(req).id, getRouteParam(req.params.uploadId));
    res.status(204).end();
  } catch (error) {
    sendErrorResponse(
      res,
      error instanceof ProjectImportInputError ? 400 : 500,
      error,
      'Failed to cancel project import'
    );
  }
});

router.get('/import/chunks/:uploadId', async (req: Request, res: Response) => {
  try {
    const userId = getCurrentUser(req).id;
    const upload = getProjectImportUploadStatus(userId, getRouteParam(req.params.uploadId));
    if (!upload) {
      res
        .status(404)
        .json({ success: false, error: 'Caricamento del backup non trovato o scaduto.' });
      return;
    }
    if (!upload.completed) {
      res.status(202).json({ success: true, uploadStatus: upload.status });
      return;
    }
    const snapshot = await getProjectStore().loadProject(userId, upload.completed.projectId);
    if (!snapshot) throw new Error('Imported project could not be loaded.');
    res.json({
      success: true,
      complete: true,
      meta: upload.completed.meta,
      snapshot,
      uploadStatus: upload.status,
    });
  } catch (error) {
    sendErrorResponse(
      res,
      error instanceof ProjectImportInputError ? 400 : 500,
      error,
      'Failed to read project import status'
    );
  }
});

router.post('/import/chunks/:uploadId/complete', async (req: Request, res: Response) => {
  try {
    const userId = getCurrentUser(req).id;
    const store = getProjectStore();
    const completionBody = isRecord(req.body) ? req.body : {};
    const completed = await completeProjectImportUpload({
      userId,
      uploadId: getRouteParam(req.params.uploadId),
      importData: async data => {
        const imported = await store.importProject(userId, data);
        publishMetaRevision(userId, imported.meta);
        return { projectId: imported.meta.id, meta: imported.meta };
      },
      importBinary: async bytes => {
        const snapshotRecord = completionBody.snapshot;
        const sourceFile = completionBody.sourceFile;
        if (
          !isRecord(snapshotRecord) ||
          !isRecord(sourceFile) ||
          typeof snapshotRecord.id !== 'string'
        ) {
          throw new ProjectImportInputError('Metadati del backup binario non validi.');
        }
        const snapshot = requireProjectSnapshot({ snapshot: snapshotRecord }, snapshotRecord.id);
        if (
          !isRecord(snapshot.source) ||
          snapshot.source.kind !== 'archive' ||
          !isRecord(snapshot.source.file) ||
          typeof sourceFile.name !== 'string' ||
          typeof sourceFile.mimeType !== 'string' ||
          snapshot.source.file.name !== sourceFile.name ||
          snapshot.source.file.mimeType !== sourceFile.mimeType
        ) {
          throw new ProjectImportInputError('Metadati della sorgente archivio non validi.');
        }
        const imported = await store.saveProject(userId, snapshot, {
          sourceFile: { bytes, name: sourceFile.name, mimeType: sourceFile.mimeType },
        });
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

router.get('/import-diagnostics', async (req: Request, res: Response) => {
  res.set('Cache-Control', 'no-store');
  try {
    if (getCurrentUser(req).role !== 'admin') {
      res.status(403).json({ success: false, error: ADMIN_REQUIRED_MESSAGE });
      return;
    }
    const correlationId = readOptionalString(req.query.correlationId);
    if (correlationId && !CORRELATION_ID_PATTERN.test(correlationId)) {
      throw new ProjectImportDiagnosticInputError('Correlation ID non valido.');
    }
    const diagnostics = await getProjectStore().listProjectImportDiagnostics(correlationId);
    res.json({ success: true, diagnostics });
  } catch (error) {
    if (error instanceof ProjectImportDiagnosticInputError) {
      sendErrorResponse(res, 400, error, IMPORT_DIAGNOSTIC_LIST_ERROR);
      return;
    }
    console.error('[Projects] Failed to list import diagnostics.', { error });
    res.status(500).json({ success: false, error: IMPORT_DIAGNOSTIC_LIST_ERROR });
  }
});

router.post('/import-diagnostics', async (req: Request, res: Response) => {
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
      throw new ProjectImportDiagnosticInputError('Diagnostica importazione non valida.');
    }

    const diagnostic = {
      correlationId,
      code,
      stage,
      fileBytes: readOptionalSafeInteger(body.fileBytes),
      limitBytes: readOptionalSafeInteger(body.limitBytes),
      projectCount: readOptionalSafeInteger(body.projectCount),
      projectIndex: readOptionalSafeInteger(body.projectIndex),
    };
    const userId = getCurrentUser(req).id;
    await getProjectStore().recordProjectImportDiagnostic(userId, diagnostic);
    console.warn('[Projects] Library backup import failed.', { ...diagnostic, userId });
    res.status(204).end();
  } catch (error) {
    if (error instanceof ProjectImportDiagnosticInputError) {
      sendErrorResponse(res, 400, error, IMPORT_DIAGNOSTIC_RECORD_ERROR);
      return;
    }
    console.error('[Projects] Failed to record import diagnostic.', { error });
    res.status(500).json({ success: false, error: IMPORT_DIAGNOSTIC_RECORD_ERROR });
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
