import {
  COURSE_SOURCE_UPLOAD_LIMITS,
  type CourseSourceUploadFile,
} from '@shared/courseSourceUpload';
import { PDF_SCANNED_PAGE_LIMIT_CODE } from '@shared/pdfTranscription';
import {
  SOURCE_INGESTION_REQUIRED_CODE,
  SOURCE_PREPARATION_CANCELLED_CODE,
  SOURCE_PREPARATION_UNUSABLE_CODE,
  SOURCE_STAGING_UNAVAILABLE_CODE,
} from '@shared/sourcePreparation';
import {
  countRetainedScannedPages,
  withPdfTranscriptionCollection,
} from '../services/pdfTranscriptionCollection.js';
import { PdfScannedPageLimitError } from '../services/pdfTranscriptionPolicy.js';
// Exposes project CRUD routes for the backend API.

import { normalizeLessonInstructionPacks } from '@shared/lessonInstructionPacks';
import { LessonQuizStateSchema } from '@shared/lessonQuizState';
import { SOURCE_ARCHIVE_VERSION_HASH_PATTERN } from '@shared/lessonSourceContext';
import { isProjectCoverMediaType, PROJECT_COVER_MAX_BYTES } from '@shared/projectBackupArchive';
import { InvalidProjectBackupAssetError } from '@shared/projectBackupAssets';
import {
  PROJECT_API_ERROR_CODE,
  PROJECT_PATCH_REBASE_MODE,
  PROJECT_REVISION_RESYNC_EVENT,
  type ProjectPatchRebaseMode,
} from '@shared/projectContract';
import { PROJECT_IMPORT_BINARY_KIND } from '@shared/projectImportContract';
import {
  decodeProjectSnapshotWire,
  type ProjectSnapshotWireDecodeOptions,
} from '@shared/projectSnapshotWire';
import { SOURCE_ARCHIVE_LESSON_CONTEXT_MAX_BYTES } from '@shared/sourceArchiveSelectors';
import { type Request, type Response, Router } from 'express';

import { getAuthMode, getCurrentUser } from '../auth/currentUser.js';
import {
  LIBRARY_SIBLING_CONFLICT_MESSAGE,
  LibrarySiblingSetChangedError,
} from '../projects/librarySiblingOrder.js';
import {
  publishProjectRevision,
  subscribeToProjectRevisionCatchUps,
  subscribeToProjectRevisions,
} from '../projects/projectEvents.js';
import {
  bindSourcePreparationProject,
  cancelProjectImportUpload,
  cancelProjectSourcePreparation,
  checkpointPreparedProjectSources,
  type completeProjectImportUpload,
  getPreparedProjectSources,
  getProjectImportUploadPaths,
  getProjectImportUploadStatus,
  getProjectSourcePreparation,
  listPreparingProjectSnapshots,
  ProjectImportCapacityError,
  ProjectImportConflictError,
  ProjectImportInputError,
  SourcePreparationCancelledError,
  startSourcePreparation,
  storeProjectImportChunk,
} from '../projects/projectImportChunks.js';
import {
  getPublicProjectImportConfig,
  projectImportConfig,
} from '../projects/projectImportConfig.js';
import { buildProjectMeta, normalizeProjectSnapshot } from '../projects/projectMeta.js';
import { isNavigationProjectPatch } from '../projects/projectPatch.js';
import { ProjectNotFoundError, ProjectRevisionConflictError } from '../projects/projectRevision.js';
import { getProjectStore } from '../projects/projectStore.js';
import {
  SourceArchivePreparationCapacityError,
  SourceArchivePreparationError,
  SourceArchiveUnusableError,
} from '../projects/sourceArchive.js';
import {
  SourceArchiveAccess,
  type SourceArchiveSelector,
} from '../projects/sourceArchiveAccess.js';
import {
  prepareSourceCollection,
  SourceIngestionRequiredError,
  SourcePreparationUnusableError,
} from '../projects/sourceIngestion.js';
import type { SourcePreparationJobContext } from '../projects/sourcePreparationContext.js';
import { SourceStagingUnavailableError } from '../projects/sourceStaging.js';
import { readSourceUploadMetadata } from '../projects/sourceUploadPayload.js';
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

const PROJECT_EVENT_HEARTBEAT_MS = 25_000;
const BASE64_DATA_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/u;
const LIBRARY_IMPORT_DIAGNOSTIC_CODES = new Set([
  'LIBRARY_ARCHIVE_ENTRY_MISSING',
  'LIBRARY_ARCHIVE_INVALID',
  'LIBRARY_ARCHIVE_MANIFEST_TOO_LARGE',
  'LIBRARY_ARCHIVE_PROJECT_IMPORT_FAILED',
  'LIBRARY_ARCHIVE_PROJECT_INVALID',
  'LIBRARY_ARCHIVE_PROJECT_TOO_LARGE',
  'LIBRARY_ARCHIVE_ROLLBACK_INCOMPLETE',
  'LIBRARY_ARCHIVE_SINGLE_PROJECT',
  'LIBRARY_ARCHIVE_UNEXPECTED',
  'LIBRARY_ARCHIVE_VERSION_UNSUPPORTED',
  'LIBRARY_ARCHIVE_ZIP_UNREADABLE',
]);
const LIBRARY_IMPORT_DIAGNOSTIC_STAGES = new Set([
  'manifest-read',
  'nested-project-read',
  'unknown',
  'project-import',
  'rollback',
  'zip-open',
]);
const CORRELATION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
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

const readProjectPatchRebaseMode = (
  body: Record<string, unknown>
): ProjectPatchRebaseMode | undefined => {
  if (body.rebaseMode === undefined) return undefined;
  if (
    body.rebaseMode !== PROJECT_PATCH_REBASE_MODE.navigation &&
    body.rebaseMode !== PROJECT_PATCH_REBASE_MODE.quiz
  ) {
    throw new Error('Modalità di rebase progetto non valida.');
  }
  return body.rebaseMode;
};

const readProjectImportChunk = (req: Request): string | Uint8Array => {
  if (req.is('application/octet-stream')) {
    return Buffer.isBuffer(req.body) ? new Uint8Array(req.body) : new Uint8Array();
  }
  return typeof req.body === 'string' ? req.body : '';
};

const projectImportChunkErrorStatus = (error: unknown): number => {
  if (error instanceof ProjectImportConflictError) return 409;
  if (error instanceof ProjectImportCapacityError) return 429;
  if (error instanceof ProjectImportInputError) return 400;
  return 500;
};

const readProjectImportExpectedRevision = (value: unknown): number | undefined => {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') {
    throw new ProjectImportInputError('Revisione progetto non valida.');
  }
  try {
    return readExpectedRevision({ expectedRevision: Number(value) });
  } catch {
    throw new ProjectImportInputError('Revisione progetto non valida.');
  }
};

const readOptionalSafeInteger = (value: unknown): number | undefined =>
  Number.isSafeInteger(value) && (value as number) >= 0 ? (value as number) : undefined;

const publishMetaRevision = (userId: string, meta: { id: string; revision?: number }): void => {
  if (typeof meta.revision === 'number') {
    publishProjectRevision(userId, { projectId: meta.id, revision: meta.revision });
  }
};

const sendProjectWriteError = (
  res: Response,
  error: unknown,
  fallbackMessage: string,
  fallbackStatus = 400
): void => {
  if (
    error instanceof ProjectRevisionConflictError ||
    error instanceof ProjectImportConflictError
  ) {
    res.status(409).json({ code: error.code, error: error.message, success: false });
    return;
  }
  if (error instanceof PdfScannedPageLimitError) {
    res
      .status(422)
      .json({ success: false, code: PDF_SCANNED_PAGE_LIMIT_CODE, error: error.message });
    return;
  }
  if (error instanceof SourcePreparationCancelledError) {
    res
      .status(409)
      .json({ success: false, code: SOURCE_PREPARATION_CANCELLED_CODE, error: error.message });
    return;
  }
  if (error instanceof SourcePreparationUnusableError) {
    res.status(422).json({
      success: false,
      code: SOURCE_PREPARATION_UNUSABLE_CODE,
      error: error.message,
      sourceWarnings: error.failures,
    });
    return;
  }
  if (error instanceof SourceIngestionRequiredError) {
    res
      .status(400)
      .json({ success: false, code: SOURCE_INGESTION_REQUIRED_CODE, error: error.message });
    return;
  }
  if (error instanceof SourceStagingUnavailableError) {
    res
      .status(503)
      .json({ success: false, code: SOURCE_STAGING_UNAVAILABLE_CODE, error: error.message });
    return;
  }
  if (error instanceof SourceArchivePreparationCapacityError) {
    res.status(429).json({
      code: PROJECT_API_ERROR_CODE.sourceArchiveBusy,
      error: error.message,
      success: false,
    });
    return;
  }
  if (error instanceof SourceArchiveUnusableError) {
    res.status(422).json({
      code: PROJECT_API_ERROR_CODE.sourceArchiveUnusable,
      error: error.message,
      sourceWarnings: error.warnings,
      success: false,
    });
    return;
  }
  if (error instanceof SourceArchivePreparationError) {
    res.status(422).json({
      code: PROJECT_API_ERROR_CODE.sourceArchiveInvalid,
      error: error.message,
      success: false,
    });
    return;
  }
  sendErrorResponse(
    res,
    error instanceof ProjectNotFoundError ? 404 : fallbackStatus,
    error,
    fallbackMessage
  );
};

const requireProjectSnapshot = (
  body: unknown,
  routeProjectId: string,
  options: ProjectSnapshotWireDecodeOptions = {}
): ProjectSnapshot => {
  const bodyRecord = getBodyRecord(body);
  const snapshot = decodeProjectSnapshotWire(bodyRecord.snapshot, options);
  const now = timestampIso();

  return {
    ...snapshot,
    id: routeProjectId,
    version: snapshot.version || '4.1',
    createdAt: snapshot.createdAt || now,
    updatedAt: snapshot.updatedAt || now,
    lastOpenedAt: snapshot.lastOpenedAt || now,
  };
};

const importBinaryProjectUpload = async (input: {
  body: Record<string, unknown>;
  bytes: Uint8Array;
  expectedRevision?: number;
  store: ReturnType<typeof getProjectStore>;
  userId: string;
  context: SourcePreparationJobContext;
}) => {
  input.context.signal.throwIfAborted();
  if (input.body.payloadKind === PROJECT_IMPORT_BINARY_KIND.backup) {
    if (typeof input.body.targetProjectId !== 'string') {
      throw new ProjectImportInputError('Identificativo del progetto importato non valido.');
    }
    const targetProjectId = input.body.targetProjectId.trim();
    if (!targetProjectId) {
      throw new ProjectImportInputError('Identificativo del progetto importato non valido.');
    }
    try {
      return await input.store.importProjectArchive(
        input.userId,
        input.bytes,
        targetProjectId,
        input.context
      );
    } catch (error) {
      if (error instanceof InvalidProjectBackupAssetError) {
        throw new ProjectImportInputError('Il backup contiene identificativi non validi.');
      }
      throw error;
    }
  }
  if (input.body.payloadKind !== PROJECT_IMPORT_BINARY_KIND.sourceArchive) {
    throw new ProjectImportInputError('Tipo di backup binario mancante o non valido.');
  }

  const snapshotRecord = input.body.snapshot;
  const sourceFile = input.body.sourceFile;
  if (!isRecord(snapshotRecord) || !isRecord(sourceFile) || typeof snapshotRecord.id !== 'string') {
    throw new ProjectImportInputError('Metadati del backup binario non validi.');
  }
  const snapshot = requireProjectSnapshot({ snapshot: snapshotRecord }, snapshotRecord.id, {
    externalArchiveBytesAvailable: input.bytes.byteLength > 0,
  });
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
  return input.store.saveProject(input.userId, snapshot, {
    expectedRevision: input.expectedRevision ?? readExpectedRevision(input.body),
    sourceFile: { bytes: input.bytes, name: sourceFile.name, mimeType: sourceFile.mimeType },
    sourcePreparation: input.context,
  });
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
  readonly code = PROJECT_API_ERROR_CODE.sourceArchiveChanged;

  constructor() {
    super('L’archivio sorgente è cambiato. Ricarica il progetto e riprova.');
    this.name = 'SourceArchiveVersionMismatchError';
  }
}

const requireSourceArchiveVersion = (value: unknown): ProjectSourceArchiveVersion => {
  if (
    !isRecord(value) ||
    typeof value.representationHash !== 'string' ||
    !SOURCE_ARCHIVE_VERSION_HASH_PATTERN.test(value.representationHash) ||
    typeof value.sourceId !== 'string' ||
    !value.sourceId ||
    typeof value.sourceHash !== 'string' ||
    !SOURCE_ARCHIVE_VERSION_HASH_PATTERN.test(value.sourceHash)
  ) {
    throw new Error('Versione archivio sorgente mancante o non valida.');
  }
  return {
    representationHash: value.representationHash,
    sourceHash: value.sourceHash,
    sourceId: value.sourceId,
  };
};

const isSameSourceArchiveVersion = (
  left: ProjectSourceArchiveVersion,
  right: ProjectSourceArchiveVersion
): boolean =>
  left.sourceId === right.sourceId &&
  left.sourceHash === right.sourceHash &&
  left.representationHash === right.representationHash;

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
    !isProjectCoverMediaType(cover.mimeType) ||
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
  const unsubscribeCatchUp = subscribeToProjectRevisionCatchUps(() => {
    res.write(`event: ${PROJECT_REVISION_RESYNC_EVENT}\ndata: {}\n\n`);
  });
  const heartbeat = globalThis.setInterval(
    () => res.write(': heartbeat\n\n'),
    PROJECT_EVENT_HEARTBEAT_MS
  );
  req.on('close', () => {
    globalThis.clearInterval(heartbeat);
    unsubscribe();
    unsubscribeCatchUp();
  });
});

router.get('/projects', async (req: Request, res: Response) => {
  try {
    const projects = await getProjectStore().listProjects(getCurrentUser(req).id);
    const preparations = listPreparingProjectSnapshots(getCurrentUser(req).id);
    const byId = new Map(preparations.map(preparation => [preparation.snapshot.id, preparation]));
    const storedIds = new Set(projects.map(project => project.id));
    const pending = preparations
      .filter(preparation => !storedIds.has(preparation.snapshot.id))
      .map(({ snapshot, status }) => ({
        ...buildProjectMeta(snapshot),
        sourcePreparationStatus: status,
      }));
    res.json({
      success: true,
      projects: [
        ...projects.map(project => {
          const preparation = byId.get(project.id);
          return preparation
            ? { ...project, sourcePreparationStatus: preparation.status }
            : project;
        }),
        ...pending,
      ],
    });
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
      preparation: getProjectSourcePreparation(
        getCurrentUser(req).id,
        getRouteParam(req.params.id)
      ),
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
      isFavorite,
      { expectedRevision: readExpectedRevision(getBodyRecord(req.body)) }
    );
    publishMetaRevision(userId, meta);
    res.json({ success: true, meta });
  } catch (error) {
    sendProjectWriteError(res, error, 'Failed to update project favorite');
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

router.get('/projects/:id/sources/:sourceId', async (req: Request, res: Response) => {
  try {
    const source = await getProjectStore().loadProjectSourceById(
      getCurrentUser(req).id,
      getRouteParam(req.params.id),
      getRouteParam(req.params.sourceId)
    );
    res.json({ success: true, source });
  } catch (error) {
    sendErrorResponse(res, 500, error, 'Failed to load project source by ID');
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
    if (error instanceof SourceArchiveVersionMismatchError) {
      res.status(409).json({ code: error.code, error: error.message, success: false });
      return;
    }
    sendErrorResponse(res, 400, error, 'Failed to query project source archive');
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
    const userId = getCurrentUser(req).id;
    const meta = await getProjectStore().saveProjectCover(
      userId,
      getRouteParam(req.params.id),
      requireProjectCoverFile(req.body),
      { expectedRevision: readExpectedRevision(getBodyRecord(req.body)) }
    );
    if (!meta) {
      res.status(409).json({
        code: PROJECT_API_ERROR_CODE.coverRevisionConflict,
        success: false,
        error: 'Il corso è cambiato prima del salvataggio della cover.',
      });
      return;
    }
    publishMetaRevision(userId, meta);
    res.json({ success: true, meta });
  } catch (error) {
    sendProjectWriteError(res, error, 'Failed to save project cover');
  }
});

const projectSourceIds = (source: unknown): string[] =>
  isRecord(source) && Array.isArray(source.sources)
    ? source.sources.flatMap(descriptor =>
        isRecord(descriptor) && typeof descriptor.id === 'string' ? [descriptor.id] : []
      )
    : [];

router.put('/projects/:id', async (req: Request, res: Response) => {
  try {
    const userId = getCurrentUser(req).id;
    const projectId = getRouteParam(req.params.id);
    if (req.is('multipart/form-data')) throw new SourceIngestionRequiredError();
    const snapshot = requireProjectSnapshot(req.body, projectId);
    if (
      isRecord(snapshot.source) &&
      snapshot.source.kind === 'archive' &&
      isRecord(snapshot.source.file) &&
      snapshot.source.file.data
    )
      throw new SourceIngestionRequiredError();
    const expectedRevision = readExpectedRevision(getBodyRecord(req.body));
    const store = getProjectStore();
    const previous = isRecord(snapshot.source)
      ? await store.loadProject(userId, projectId)
      : undefined;
    const saved = await store.saveProject(userId, snapshot, { expectedRevision });
    const retainedIds = projectSourceIds(saved.snapshot.source);
    if (projectSourceIds(previous?.source).some(id => !retainedIds.includes(id)))
      await cancelProjectSourcePreparation(userId, projectId, retainedIds);
    publishMetaRevision(userId, saved.meta);
    res.json({ success: true, ...saved });
  } catch (error) {
    sendProjectWriteError(res, error, 'Failed to save project');
  }
});

const readNullableArray = (value: unknown): unknown[] | null | undefined => {
  if (value === null) return null;
  return Array.isArray(value) ? value : undefined;
};

const readLessonContentBlocksPatch = (
  section: Record<string, unknown>
): unknown[] | null | undefined => {
  if (!Object.hasOwn(section, 'contentBlocks')) return undefined;

  const contentBlocks = readNullableArray(section.contentBlocks);
  if (contentBlocks === undefined) {
    throw new Error('Blocchi contenuto lezione non validi.');
  }
  return contentBlocks;
};

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
    annotations: readNullableArray(value.annotations),
    quizState: LessonQuizStateSchema.nullish().parse(value.quizState),
    content: readNullableString(value.content),
    contentBlocks: readLessonContentBlocksPatch(value),
    generationWarnings: readNullableArray(value.generationWarnings),
    generatedVisuals: readNullableArray(value.generatedVisuals),
    imageRefs: readNullableArray(value.imageRefs),
    isCompleted: typeof value.isCompleted === 'boolean' ? value.isCompleted : undefined,
    instructionPacks: Array.isArray(value.instructionPacks)
      ? normalizeLessonInstructionPacks(value.instructionPacks)
      : undefined,
    learningAids: readNullableArray(value.learningAids),
    lastGenerationRunId: readNullableString(value.lastGenerationRunId),
    quiz: readNullableArray(value.quiz),
    visualPlanningDecision:
      value.visualPlanningDecision === null || isRecord(value.visualPlanningDecision)
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
  if (Object.hasOwn(patchRecord, 'source')) {
    throw new Error('La sorgente non può essere modificata da una patch progetto generica.');
  }

  return {
    title: readOptionalString(patchRecord.title),
    activeSectionId: readNullableString(patchRecord.activeSectionId),
    state: readOptionalString(patchRecord.state),
    isLearnMode: typeof patchRecord.isLearnMode === 'boolean' ? patchRecord.isLearnMode : undefined,
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
    const rebaseMode = readProjectPatchRebaseMode(body);
    if (rebaseMode === PROJECT_PATCH_REBASE_MODE.navigation && !isNavigationProjectPatch(patch)) {
      throw new Error('Il rebase di navigazione accetta solo campi di navigazione.');
    }
    const meta = await getProjectStore().patchProject(userId, projectId, patch, {
      expectedRevision: readExpectedRevision(body),
      rebaseMode,
      expectedQuizState: LessonQuizStateSchema.nullish().parse(body.expectedQuizState),
      expectedLessonGenerationRunId:
        body.expectedLessonGenerationRunId === null
          ? null
          : readOptionalString(body.expectedLessonGenerationRunId),
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
    await cancelProjectSourcePreparation(userId, projectId);
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
    sendProjectWriteError(res, error, 'Failed to touch project', 500);
  }
});

router.post('/import', async (req: Request, res: Response) => {
  try {
    const userId = getCurrentUser(req).id;
    const data = normalizeProjectSnapshot(getBodyRecord(req.body).data, true);
    const serialized = JSON.stringify(data);
    if (serialized === undefined)
      throw new ProjectImportInputError('Il progetto da importare non è valido.');
    const bytes = Buffer.from(serialized);
    const uploadId = crypto.randomUUID();
    const chunkCount = Math.ceil(bytes.length / projectImportConfig.maxChunkBytes);
    for (let chunkIndex = 0; chunkIndex < chunkCount; chunkIndex += 1) {
      const received = await storeProjectImportChunk({
        userId,
        projectId: data.id,
        contentKey: req.get('X-Source-Content-Key'),
        uploadId,
        chunkIndex,
        chunkCount,
        chunk: bytes.subarray(
          chunkIndex * projectImportConfig.maxChunkBytes,
          (chunkIndex + 1) * projectImportConfig.maxChunkBytes
        ),
      });
      if (received.uploadId) {
        res.status(202).json({
          success: true,
          uploadId: received.uploadId,
          uploadStatus: received.uploadStatus,
        });
        return;
      }
    }
    bindSourcePreparationProject({ userId, uploadId, projectId: data.id, snapshot: data });
    startSourcePreparation({
      userId,
      uploadId,
      importBinary: async (_bytes, _revision, context) => {
        const imported = await getProjectStore().importProject(userId, data, context);
        publishMetaRevision(userId, imported.meta);
        return { ...imported, projectId: imported.meta.id };
      },
    });
    res.status(202).json({ success: true, uploadId, uploadStatus: 'finalizing' });
  } catch (error) {
    sendProjectWriteError(res, error, 'Failed to import project', 400);
  }
});

router.put('/import/chunks/:uploadId/:chunkIndex', async (req: Request, res: Response) => {
  try {
    const userId = getCurrentUser(req).id;
    const chunk = readProjectImportChunk(req);
    const result = await storeProjectImportChunk({
      userId,
      uploadId: getRouteParam(req.params.uploadId),
      chunkIndex: readOptionalSafeInteger(Number(getRouteParam(req.params.chunkIndex))) ?? -1,
      chunkCount: readOptionalSafeInteger(Number(req.query.chunkCount)) ?? -1,
      chunk,
      sourceUpload: req.query.sourceUpload === 'true',
      projectId: readOptionalString(req.query.projectId),
      contentKey: readOptionalString(req.query.contentKey),
      expectedRevision: readProjectImportExpectedRevision(req.query.expectedRevision),
    });
    res.status(202).json({ success: true, complete: false, ...result });
  } catch (error) {
    if (error instanceof SourceStagingUnavailableError) {
      sendProjectWriteError(res, error, 'Source staging is unavailable');
      return;
    }
    if (error instanceof ProjectImportCapacityError) res.set('Retry-After', '1');
    sendProjectWriteError(
      res,
      error,
      'Failed to store project import chunk',
      projectImportChunkErrorStatus(error)
    );
  }
});

router.delete('/import/chunks/:uploadId', async (req: Request, res: Response) => {
  try {
    const userId = getCurrentUser(req).id;
    const uploadId = getRouteParam(req.params.uploadId);
    await cancelProjectImportUpload(userId, uploadId);
    const status = getProjectImportUploadStatus(userId, uploadId);
    if (status?.status === 'finalizing') {
      res.status(202).json({ success: true, uploadStatus: status.status });
      return;
    }
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
    if (upload.status === 'failed') {
      sendProjectWriteError(
        res,
        upload.failure,
        'Source preparation failed',
        upload.failure instanceof ProjectImportInputError ? 400 : 500
      );
      return;
    }
    if (!upload.completed) {
      res
        .status(202)
        .json({ success: true, uploadStatus: upload.status, progress: upload.progress });
      return;
    }
    const snapshot =
      upload.completed.snapshot ??
      (await getProjectStore().loadProject(userId, upload.completed.projectId));
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

const readSourcePreparationSubmission = async (
  userId: string,
  uploadId: string,
  completionBody: Record<string, unknown>
) => {
  const metadata =
    completionBody.metadataBytes === undefined
      ? completionBody
      : await readSourceUploadMetadata(
          getProjectImportUploadPaths(userId, uploadId),
          completionBody.metadataBytes
        );
  if (!isRecord(metadata)) throw new ProjectImportInputError('Metadati delle fonti non validi.');
  const snapshotRecord = metadata.snapshot;
  if (!isRecord(snapshotRecord) || typeof snapshotRecord.id !== 'string')
    throw new ProjectImportInputError('Metadati delle fonti non validi.');
  const snapshot = requireProjectSnapshot({ snapshot: snapshotRecord }, snapshotRecord.id, {
    externalArchiveBytesAvailable: false,
    externalSourceFilesAvailable: true,
  });
  if (!Array.isArray(metadata.sourceFiles))
    throw new ProjectImportInputError('Elenco delle fonti mancante.');
  const files: CourseSourceUploadFile[] = metadata.sourceFiles.map(file => {
    if (
      !isRecord(file) ||
      typeof file.id !== 'string' ||
      typeof file.name !== 'string' ||
      typeof file.mimeType !== 'string' ||
      !Number.isSafeInteger(file.byteSize) ||
      (file.byteSize as number) < 0 ||
      (file.byteSize as number) > COURSE_SOURCE_UPLOAD_LIMITS.maxFileBytes
    )
      throw new ProjectImportInputError('File sorgente non valido.');
    return {
      id: file.id,
      name: file.name,
      mimeType: file.mimeType,
      byteSize: file.byteSize as number,
    };
  });
  return { snapshot, files };
};

const bindQueuedProjectImport = ({
  userId,
  uploadId,
  projectId,
  title,
}: {
  userId: string;
  uploadId: string;
  projectId?: string;
  title?: string;
}) => {
  if (!projectId) return;
  bindSourcePreparationProject({
    userId,
    uploadId,
    projectId: projectId.trim(),
    snapshot: normalizeProjectSnapshot({ id: projectId.trim(), state: 'LIBRARY', title }, true),
  });
};

router.post('/import/chunks/:uploadId/complete', async (req: Request, res: Response) => {
  try {
    const userId = getCurrentUser(req).id;
    const store = getProjectStore();
    const completionBody = isRecord(req.body) ? req.body : {};
    const uploadId = getRouteParam(req.params.uploadId);
    const existing = getProjectImportUploadStatus(userId, uploadId);
    if (existing?.status === 'failed') throw existing.failure;
    if (existing?.status === 'finalizing' || existing?.status === 'completed') {
      res.status(202).json({ success: true, uploadId, uploadStatus: 'finalizing' });
      return;
    }
    if (completionBody.payloadKind === PROJECT_IMPORT_BINARY_KIND.sourceArchive) {
      await cancelProjectImportUpload(userId, getRouteParam(req.params.uploadId));
      throw new SourceIngestionRequiredError();
    }
    let submission: Awaited<ReturnType<typeof readSourcePreparationSubmission>> | undefined;
    if (completionBody.payloadKind === PROJECT_IMPORT_BINARY_KIND.sourceSet) {
      try {
        submission = await readSourcePreparationSubmission(userId, uploadId, completionBody);
        bindSourcePreparationProject({
          userId,
          uploadId,
          projectId: submission.snapshot.id,
          snapshot: submission.snapshot,
          sourceIds: projectSourceIds(submission.snapshot.source),
        });
      } catch (error) {
        await cancelProjectImportUpload(userId, uploadId);
        throw error;
      }
    }
    const completionInput: Parameters<typeof completeProjectImportUpload>[0] = {
      userId,
      uploadId: getRouteParam(req.params.uploadId),
      importData: async (data, context) => {
        const snapshot = normalizeProjectSnapshot(data, true);
        bindSourcePreparationProject({
          userId,
          uploadId: completionInput.uploadId,
          projectId: snapshot.id,
          snapshot,
        });
        const imported = await store.importProject(userId, snapshot, context);
        publishMetaRevision(userId, imported.meta);
        return { ...imported, projectId: imported.meta.id };
      },
      importFile:
        completionBody.payloadKind === PROJECT_IMPORT_BINARY_KIND.sourceSet
          ? async (path, expectedRevision, jobContext) => {
              if (!submission) throw new Error('Source preparation submission is missing.');
              const { snapshot, files } = submission;
              jobContext.signal.throwIfAborted();
              const storedSnapshot = await store.loadProject(userId, snapshot.id);
              const context = {
                ...jobContext,
                userId,
                uploadId: completionInput.uploadId,
                projectId: snapshot.id,
                checkpointPreparedSources: (checkpoint: ProjectSnapshot) =>
                  checkpointPreparedProjectSources(userId, completionInput.uploadId, checkpoint),
                previousScannedPages: countRetainedScannedPages(
                  storedSnapshot?.source,
                  snapshot.source,
                  files.map(file => file.id)
                ),
              };
              const upload = {
                path,
                files,
                offset: completionBody.metadataBytes as number | undefined,
              };
              const prepared = await withPdfTranscriptionCollection(context, () =>
                prepareSourceCollection({
                  snapshot,
                  upload,
                  context,
                  storedSnapshot,
                  preparedSnapshot: getPreparedProjectSources(userId, completionInput.uploadId),
                })
              );
              context.signal.throwIfAborted();
              checkpointPreparedProjectSources(userId, completionInput.uploadId, prepared.snapshot);
              context.reportProgress({ step: 'persistence', completed: 0, total: files.length });
              const imported = await store.saveProject(userId, prepared.snapshot, {
                expectedRevision,
                sourceFiles: upload,
                sourcePreparation: context,
              });
              context.reportProgress({
                step: 'persistence',
                completed: files.length,
                total: files.length,
              });
              publishMetaRevision(userId, imported.meta);
              return {
                projectId: imported.meta.id,
                meta: imported.meta,
                snapshot: structuredClone(imported.snapshot),
              };
            }
          : undefined,
      importBinary: async (bytes, expectedRevision, context) => {
        const imported = await importBinaryProjectUpload({
          body: completionBody,
          bytes,
          context,
          expectedRevision,
          store,
          userId,
        });
        publishMetaRevision(userId, imported.meta);
        return { ...imported, projectId: imported.meta.id };
      },
    };
    if (!submission)
      bindQueuedProjectImport({
        userId,
        uploadId,
        projectId: readOptionalString(completionBody.targetProjectId) ?? existing?.projectId,
        title: readOptionalString(completionBody.fileName),
      });
    startSourcePreparation(completionInput);
    res
      .status(202)
      .json({ success: true, uploadId: completionInput.uploadId, uploadStatus: 'finalizing' });
  } catch (error) {
    sendProjectWriteError(
      res,
      error,
      'Failed to complete project import',
      error instanceof ProjectImportInputError ? 400 : 500
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
    if (error instanceof LibrarySiblingSetChangedError) {
      console.warn('[Projects] Folder deletion conflicted with a concurrent library update.', {
        error,
      });
      res.status(409).json({ error: LIBRARY_SIBLING_CONFLICT_MESSAGE, success: false });
      return;
    }
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
