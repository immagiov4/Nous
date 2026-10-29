import { createHash } from 'node:crypto';
import {
  appendFile,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { COURSE_SOURCE_UPLOAD_LIMITS } from '@shared/courseSourceUpload';
import {
  SOURCE_PREPARATION_CANCELLED_MESSAGE,
  SOURCE_PREPARATION_CONFLICT_CODE,
  SOURCE_PREPARATION_CONFLICT_MESSAGE,
  type SourcePreparationProgress,
} from '@shared/sourcePreparation';
import { projectImportConfig } from './projectImportConfig.js';
import type { SourcePreparationJobContext } from './sourcePreparationContext.js';
import { assertSourceStagingAvailable } from './sourceStaging.js';
import type { ProjectSnapshot, SavedProjectMeta } from './types.js';

const IMPORT_ROOT_PREFIX = 'nous-project-imports-';
const IMPORT_ROOT_PROMISE = mkdtemp(join(tmpdir(), IMPORT_ROOT_PREFIX));
const IMPORT_UPLOAD_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

interface ProjectImportChunk {
  chunk: string | Uint8Array;
  sourceUpload?: boolean;
  projectId?: string;
  contentKey?: string;
  chunkCount: number;
  chunkIndex: number;
  expectedRevision?: number;
  uploadId: string;
  userId: string;
}

interface StoredChunk {
  bytes: number;
  digest: string;
}

interface CompletedImport {
  snapshot?: ProjectSnapshot;
  meta: SavedProjectMeta;
  projectId: string;
}

interface ProjectImportCompletionInput {
  userId: string;
  uploadId: string;
  importData?: (data: unknown, context: SourcePreparationJobContext) => Promise<CompletedImport>;
  importBinary?: (
    bytes: Uint8Array,
    expectedRevision: number | undefined,
    context: SourcePreparationJobContext
  ) => Promise<CompletedImport>;
  importFile?: (
    path: string,
    expectedRevision: number | undefined,
    context: SourcePreparationJobContext
  ) => Promise<CompletedImport>;
}

interface UploadSession {
  chunkCount: number;
  chunks: Map<number, StoredChunk>;
  completed?: CompletedImport;
  completion?: Promise<CompletedImport>;
  directory: string;
  expectedRevision?: number;
  format: 'binary' | 'text';
  sourceUpload: boolean;
  projectId?: string;
  contentKey?: string;
  sourceIds?: readonly string[];
  snapshot?: ProjectSnapshot;
  preparedSnapshot?: ProjectSnapshot;
  key: string;
  lock: Promise<void>;
  status: 'receiving' | 'finalizing' | 'completed' | 'failed';
  controller: AbortController;
  progress?: SourcePreparationProgress;
  failure?: unknown;
  totalBytes: number;
  updatedAt: number;
  uploadId: string;
  userId: string;
}

export class ProjectImportInputError extends Error {}
export class ProjectImportCapacityError extends Error {}
export class ProjectImportConflictError extends Error {
  readonly code = SOURCE_PREPARATION_CONFLICT_CODE;
  constructor() {
    super(SOURCE_PREPARATION_CONFLICT_MESSAGE);
  }
}
export class SourcePreparationCancelledError extends Error {
  constructor() {
    super(SOURCE_PREPARATION_CANCELLED_MESSAGE);
  }
}

const sessions = new Map<string, UploadSession>();
const pendingSessions = new Map<string, Promise<UploadSession>>();
let activeFinalizations = 0;
const pendingFinalizations: Array<() => void> = [];

const getUserHash = (userId: string): string =>
  createHash('sha256').update(userId).digest('hex').slice(0, 32);

const getSessionKey = (userId: string, uploadId: string): string =>
  `${getUserHash(userId)}-${uploadId}`;

const findPreparingSession = (userId: string, projectId: string) =>
  [...sessions.values()].find(
    session =>
      session.userId === userId &&
      session.projectId === projectId &&
      session.status === 'finalizing'
  );

const findMatchingPreparation = (userId: string, projectId: string, contentKey?: string) => {
  const running = findPreparingSession(userId, projectId);
  if (running && (!contentKey || running.contentKey !== contentKey))
    throw new ProjectImportConflictError();
  return running;
};

/** Running retries resolve before request/body capacity is reserved. */
export const getRunningProjectImport = ({
  userId,
  uploadId,
  projectId,
  contentKey,
}: {
  userId: string;
  uploadId?: string;
  projectId?: string;
  contentKey?: string;
}) => {
  const session =
    (uploadId ? sessions.get(getSessionKey(userId, uploadId)) : undefined) ??
    (projectId ? findMatchingPreparation(userId, projectId, contentKey) : undefined);
  if (session?.status !== 'finalizing') return undefined;
  return {
    success: true,
    complete: false,
    ready: true,
    receivedCount: session.chunks.size,
    uploadId: session.uploadId,
    uploadStatus: session.status,
  };
};

const safelyRemove = async (path: string): Promise<void> => {
  try {
    await rm(path, { recursive: true, force: true });
  } catch (error) {
    console.warn('[Projects] Failed to clean an import upload directory.', error);
  }
};

const cleanupOrphanedRoots = async (now: number): Promise<void> => {
  const currentRoot = await IMPORT_ROOT_PROMISE;
  const entries = await readdir(tmpdir(), { withFileTypes: true });
  await Promise.all(
    entries
      .filter(
        entry => entry.name.startsWith(IMPORT_ROOT_PREFIX) && entry.name !== basename(currentRoot)
      )
      .map(async entry => {
        const path = join(tmpdir(), entry.name);
        try {
          const stats = await lstat(path);
          if (now - stats.mtimeMs > projectImportConfig.receivingUploadTtlMs) {
            await safelyRemove(path);
          }
        } catch {
          // The directory may have disappeared between listing and inspection.
        }
      })
  );
};

const cleanupExpiredSessions = async (): Promise<void> => {
  const now = Date.now();
  const cleanupTasks: Promise<void>[] = [];
  for (const [key, session] of sessions) {
    const ttl =
      session.status === 'completed'
        ? projectImportConfig.completedUploadTtlMs
        : projectImportConfig.receivingUploadTtlMs;
    if (session.status !== 'finalizing' && now - session.updatedAt > ttl) {
      cleanupTasks.push(
        withSessionLock(session, async () => {
          const current = sessions.get(key);
          const currentTtl =
            session.status === 'completed'
              ? projectImportConfig.completedUploadTtlMs
              : projectImportConfig.receivingUploadTtlMs;
          if (
            current !== session ||
            session.status === 'finalizing' ||
            Date.now() - session.updatedAt <= currentTtl
          ) {
            return;
          }
          sessions.delete(key);
          await safelyRemove(session.directory);
        })
      );
    }
  }
  await Promise.all(cleanupTasks);
  await cleanupOrphanedRoots(now);
};

setInterval(() => {
  void cleanupExpiredSessions();
}, projectImportConfig.cleanupIntervalMs).unref();

const validateChunk = ({
  chunk,
  chunkCount,
  chunkIndex,
  uploadId,
  sourceUpload,
}: ProjectImportChunk): number => {
  if (sourceUpload && typeof chunk === 'string')
    throw new ProjectImportInputError('Le fonti richiedono un caricamento binario.');
  if (!IMPORT_UPLOAD_ID_PATTERN.test(uploadId)) {
    throw new ProjectImportInputError('Identificativo caricamento non valido.');
  }
  if (
    !Number.isSafeInteger(chunkCount) ||
    chunkCount < 1 ||
    chunkCount >
      (sourceUpload
        ? Math.ceil(COURSE_SOURCE_UPLOAD_LIMITS.maxTotalBytes / projectImportConfig.maxChunkBytes)
        : projectImportConfig.maxChunkCount)
  ) {
    throw new ProjectImportInputError('Numero di parti del backup non valido.');
  }
  if (!Number.isSafeInteger(chunkIndex) || chunkIndex < 0 || chunkIndex >= chunkCount) {
    throw new ProjectImportInputError('Indice della parte del backup non valido.');
  }
  const chunkBytes =
    typeof chunk === 'string' ? Buffer.byteLength(chunk, 'utf8') : chunk.byteLength;
  if (chunkBytes === 0 || chunkBytes > projectImportConfig.maxChunkBytes) {
    throw new ProjectImportInputError('Parte del backup non valida o troppo grande.');
  }
  return chunkBytes;
};

const withSessionLock = async <T>(
  session: UploadSession,
  operation: () => Promise<T>
): Promise<T> => {
  const previousLock = session.lock;
  let releaseLock = (): void => undefined;
  session.lock = new Promise<void>(resolve => {
    releaseLock = resolve;
  });
  await previousLock;
  try {
    return await operation();
  } finally {
    releaseLock();
  }
};

const runFinalization = async <T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> => {
  signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    if (activeFinalizations < projectImportConfig.finalizationsGlobal) {
      activeFinalizations += 1;
      resolve();
      return;
    }
    const enter = () => {
      signal.removeEventListener('abort', cancel);
      resolve();
    };
    const cancel = () => {
      pendingFinalizations.splice(pendingFinalizations.indexOf(enter), 1);
      reject(signal.reason);
    };
    pendingFinalizations.push(enter);
    signal.addEventListener('abort', cancel, { once: true });
  });
  try {
    return await operation();
  } finally {
    const next = pendingFinalizations.shift();
    if (next) next();
    else activeFinalizations -= 1;
  }
};

const countActiveUserSessions = (userId: string): number =>
  [...sessions.values()].filter(
    session =>
      session.userId === userId && session.status !== 'completed' && session.status !== 'failed'
  ).length;

const createSession = async (input: ProjectImportChunk): Promise<UploadSession> => {
  const root = await IMPORT_ROOT_PROMISE;
  const key = getSessionKey(input.userId, input.uploadId);
  const directory = join(root, key);
  await mkdir(directory, { mode: 0o700 });
  const session: UploadSession = {
    chunkCount: input.chunkCount,
    chunks: new Map(),
    directory,
    expectedRevision: input.expectedRevision,
    format: typeof input.chunk === 'string' ? 'text' : 'binary',
    sourceUpload: input.sourceUpload === true,
    projectId: input.projectId,
    contentKey: input.contentKey,
    key,
    lock: Promise.resolve(),
    status: 'receiving',
    controller: new AbortController(),
    totalBytes: 0,
    updatedAt: Date.now(),
    uploadId: input.uploadId,
    userId: input.userId,
  };
  sessions.set(key, session);
  return session;
};

const getOrCreateSession = async (input: ProjectImportChunk): Promise<UploadSession> => {
  const key = getSessionKey(input.userId, input.uploadId);
  const existing =
    sessions.get(key) ??
    (input.projectId
      ? findMatchingPreparation(input.userId, input.projectId, input.contentKey)
      : undefined);
  if (existing) {
    return existing;
  }
  const pending = pendingSessions.get(key);
  if (pending) {
    return pending;
  }
  const userKeyPrefix = `${getUserHash(input.userId)}-`;
  const pendingForUser = [...pendingSessions.keys()].filter(pendingKey =>
    pendingKey.startsWith(userKeyPrefix)
  ).length;
  const activeGlobal = [...sessions.values()].filter(
    session => session.status !== 'completed' && session.status !== 'failed'
  ).length;
  if (activeGlobal + pendingSessions.size >= projectImportConfig.activeUploadsGlobal) {
    throw new ProjectImportCapacityError(
      'Il server sta gia elaborando troppi backup. Riprova piu tardi.'
    );
  }
  if (
    countActiveUserSessions(input.userId) + pendingForUser >=
    projectImportConfig.activeUploadsPerUser
  ) {
    throw new ProjectImportCapacityError(
      'Ci sono gia troppi backup in caricamento. Riprova piu tardi.'
    );
  }
  const creation = createSession(input).finally(() => {
    pendingSessions.delete(key);
  });
  pendingSessions.set(key, creation);
  return creation;
};

export const storeProjectImportChunk = async (
  input: ProjectImportChunk
): Promise<{
  ready: boolean;
  receivedCount: number;
  uploadId?: string;
  uploadStatus?: UploadSession['status'];
}> => {
  const chunkBytes = validateChunk(input);
  if (input.sourceUpload) await assertSourceStagingAvailable();
  await cleanupExpiredSessions();
  const session = await getOrCreateSession(input);

  if (session.status === 'finalizing' && session.projectId && session.projectId === input.projectId)
    return {
      ready: true,
      receivedCount: session.chunks.size,
      uploadId: session.uploadId,
      uploadStatus: session.status,
    };
  return withSessionLock(session, async () => {
    if (session.status !== 'receiving') {
      throw new ProjectImportInputError('Questo backup è gia stato elaborato.');
    }
    if (session.chunkCount !== input.chunkCount) {
      throw new ProjectImportInputError('Il numero di parti del backup non è coerente.');
    }
    if (session.format !== (typeof input.chunk === 'string' ? 'text' : 'binary')) {
      throw new ProjectImportInputError('Il formato delle parti del backup non è coerente.');
    }
    if (session.expectedRevision !== input.expectedRevision) {
      throw new ProjectImportInputError('La revisione del progetto non è coerente.');
    }

    const digest = createHash('sha256').update(input.chunk).digest('hex');
    const existingChunk = session.chunks.get(input.chunkIndex);
    if (existingChunk) {
      if (existingChunk.bytes !== chunkBytes || existingChunk.digest !== digest) {
        throw new ProjectImportInputError('Una parte del backup è stata inviata con dati diversi.');
      }
      session.updatedAt = Date.now();
      return {
        ready: session.chunks.size === session.chunkCount,
        receivedCount: session.chunks.size,
      };
    }

    if (session.sourceUpload !== (input.sourceUpload === true)) {
      throw new ProjectImportInputError('Tipo di caricamento incoerente.');
    }
    const maxBytes = session.sourceUpload
      ? COURSE_SOURCE_UPLOAD_LIMITS.maxTotalBytes
      : projectImportConfig.maxSerializedBytes;
    if (session.totalBytes + chunkBytes > maxBytes) {
      sessions.delete(session.key);
      await safelyRemove(session.directory);
      throw new ProjectImportInputError('Il backup supera il limite massimo di importazione.');
    }

    await writeFile(join(session.directory, `${input.chunkIndex}.part`), input.chunk, {
      flag: 'wx',
      mode: 0o600,
    });
    session.chunks.set(input.chunkIndex, { bytes: chunkBytes, digest });
    session.totalBytes += chunkBytes;
    session.updatedAt = Date.now();
    return {
      ready: session.chunks.size === session.chunkCount,
      receivedCount: session.chunks.size,
    };
  });
};

export const cancelProjectImportUpload = async (
  userId: string,
  uploadId: string
): Promise<void> => {
  if (!IMPORT_UPLOAD_ID_PATTERN.test(uploadId)) {
    throw new ProjectImportInputError('Identificativo caricamento non valido.');
  }
  const session = sessions.get(getSessionKey(userId, uploadId));
  if (!session) return;
  if (session.status === 'completed') return;
  if (session.status === 'finalizing') {
    session.controller.abort();
    return;
  }
  await withSessionLock(session, async () => {
    if (session.status !== 'receiving' && session.status !== 'failed') {
      throw new ProjectImportInputError('Questo backup non puo piu essere annullato.');
    }
    sessions.delete(session.key);
    await safelyRemove(session.directory);
  });
};

export const getProjectImportUploadStatus = (
  userId: string,
  uploadId: string
):
  | {
      completed?: CompletedImport;
      status: UploadSession['status'];
      projectId?: string;
      contentKey?: string;
      progress?: SourcePreparationProgress;
      failure?: unknown;
    }
  | undefined => {
  if (!IMPORT_UPLOAD_ID_PATTERN.test(uploadId)) {
    throw new ProjectImportInputError('Identificativo caricamento non valido.');
  }
  const session = sessions.get(getSessionKey(userId, uploadId));
  if (!session) return undefined;
  return {
    projectId: session.projectId,
    completed: session.completed,
    status: session.status,
    progress: session.progress,
    failure: session.failure,
  };
};

/** Project identity belongs to the authenticated upload, independently of its HTTP connection. */
const sessionPreparation = (session?: UploadSession) => {
  if (
    !session ||
    session.controller.signal.aborted ||
    (session.status !== 'finalizing' && session.status !== 'failed')
  )
    return undefined;
  return { uploadId: session.uploadId, progress: session.progress, status: session.status };
};

export const getProjectSourcePreparation = (userId: string, projectId: string) =>
  sessionPreparation(
    [...sessions.values()]
      .reverse()
      .find(session => session.userId === userId && session.projectId === projectId)
  );

/** Keeps paid source preparation available when publication fails, within the upload lifetime. */
export const checkpointPreparedProjectSources = (
  userId: string,
  uploadId: string,
  snapshot: ProjectSnapshot
) => {
  const session = sessions.get(getSessionKey(userId, uploadId));
  if (session?.projectId !== snapshot.id)
    throw new ProjectImportInputError('Progetto del caricamento non valido.');
  session.controller.signal.throwIfAborted();
  session.preparedSnapshot = snapshot;
};

export const getPreparedProjectSources = (
  userId: string,
  uploadId: string
): ProjectSnapshot | undefined => sessions.get(getSessionKey(userId, uploadId))?.preparedSnapshot;

export const bindSourcePreparationProject = ({
  userId,
  uploadId,
  projectId,
  snapshot,
  sourceIds,
}: {
  userId: string;
  uploadId: string;
  projectId: string;
  snapshot?: ProjectSnapshot;
  sourceIds?: readonly string[];
}) => {
  const session = sessions.get(getSessionKey(userId, uploadId));
  if (!session || (session.projectId && session.projectId !== projectId))
    throw new ProjectImportInputError('Progetto del caricamento non valido.');
  for (const previous of sessions.values()) {
    if (
      previous !== session &&
      previous.userId === userId &&
      previous.projectId === projectId &&
      previous.status === 'failed'
    ) {
      session.preparedSnapshot ??= previous.preparedSnapshot;
      previous.preparedSnapshot = undefined;
      previous.projectId = undefined;
      previous.snapshot = undefined;
    }
  }
  session.projectId = projectId;
  session.sourceIds = sourceIds;
  session.snapshot = snapshot;
  session.controller.signal.throwIfAborted();
};

/** New projects stay discoverable while their originals are being prepared. */
export const listPreparingProjectSnapshots = (userId: string) => {
  const latest = new Map<string, UploadSession>();
  for (const session of sessions.values())
    if (session.userId === userId && session.projectId) latest.set(session.projectId, session);
  return [...latest.values()].flatMap(session => {
    const preparation = sessionPreparation(session);
    return session.snapshot && preparation
      ? [{ snapshot: session.snapshot, status: preparation.status }]
      : [];
  });
};

/** Explicit deletion/removal cancels paid work and waits for its capacity to be released. */
export const cancelProjectSourcePreparation = async (
  userId: string,
  projectId: string,
  retainedSourceIds?: readonly string[]
) => {
  const pending = [...sessions.values()].filter(
    session =>
      session.userId === userId &&
      session.projectId === projectId &&
      (session.status === 'receiving' || session.status === 'finalizing') &&
      (!retainedSourceIds ||
        !session.sourceIds ||
        session.sourceIds.some(id => !retainedSourceIds.includes(id)))
  );
  for (const session of pending) {
    await cancelProjectImportUpload(userId, session.uploadId);
    await session.completion?.catch(() => undefined);
  }
  for (const session of sessions.values()) {
    if (
      session.userId === userId &&
      session.projectId === projectId &&
      (!retainedSourceIds || session.sourceIds?.some(id => !retainedSourceIds.includes(id)))
    ) {
      session.projectId = undefined;
      session.snapshot = undefined;
      session.preparedSnapshot = undefined;
    }
  }
};

/** Reads only completed staged parts; preparation admission may inspect the bounded prefix. */
export const getProjectImportUploadPaths = (userId: string, uploadId: string): string[] => {
  const session = sessions.get(getSessionKey(userId, uploadId));
  if (!session || session.chunks.size !== session.chunkCount)
    throw new ProjectImportInputError('Non tutte le parti delle fonti sono state ricevute.');
  return Array.from({ length: session.chunkCount }, (_, index) =>
    join(session.directory, `${index}.part`)
  );
};

const assembleAndImport = async (
  session: UploadSession,
  { importData, importBinary, importFile }: ProjectImportCompletionInput
): Promise<CompletedImport> => {
  const context: SourcePreparationJobContext = {
    signal: session.controller.signal,
    reportProgress: progress => {
      session.progress = structuredClone(progress);
      session.updatedAt = Date.now();
    },
  };
  context.signal.throwIfAborted();
  const assembledPath = join(session.directory, 'assembled');
  await writeFile(assembledPath, '', { flag: 'wx', mode: 0o600 });
  for (let index = 0; index < session.chunkCount; index += 1) {
    context.signal.throwIfAborted();
    const chunkPath = join(session.directory, `${index}.part`);
    const chunk = await readFile(chunkPath);
    await appendFile(assembledPath, chunk);
    await unlink(chunkPath);
  }

  if ((session.sourceUpload && !importFile) || (importFile && session.format !== 'binary'))
    throw new ProjectImportInputError('Tipo di completamento del caricamento non valido.');
  if (session.format === 'binary') {
    if (importFile) return importFile(assembledPath, session.expectedRevision, context);
    if (!importBinary) throw new ProjectImportInputError('Formato del backup non valido.');
    const bytes = new Uint8Array(await readFile(assembledPath));
    await unlink(assembledPath);
    return importBinary(bytes, session.expectedRevision, context);
  }

  if (!importData) throw new ProjectImportInputError('Formato del backup non valido.');
  let serialized = await readFile(assembledPath, 'utf8');
  let data: unknown;
  try {
    data = JSON.parse(serialized) as unknown;
  } catch {
    throw new ProjectImportInputError('Il contenuto del backup non è un JSON valido.');
  } finally {
    serialized = '';
  }
  return importData(data, context);
};

export const completeProjectImportUpload = async ({
  importBinary,
  importFile,
  importData,
  uploadId,
  userId,
}: ProjectImportCompletionInput): Promise<CompletedImport> => {
  if (!IMPORT_UPLOAD_ID_PATTERN.test(uploadId)) {
    throw new ProjectImportInputError('Identificativo caricamento non valido.');
  }
  const session = sessions.get(getSessionKey(userId, uploadId));
  if (!session) {
    throw new ProjectImportInputError('Caricamento del backup non trovato o scaduto.');
  }
  if (session.completed) {
    session.updatedAt = Date.now();
    return session.completed;
  }
  if (session.completion) {
    return session.completion;
  }

  session.completion = withSessionLock(session, async () => {
    if (session.chunks.size !== session.chunkCount) {
      session.completion = undefined;
      throw new ProjectImportInputError('Non tutte le parti del backup sono state ricevute.');
    }
    session.status = 'finalizing';
    session.updatedAt = Date.now();
    try {
      const completed = await runFinalization(
        () =>
          assembleAndImport(session, { userId, uploadId, importData, importBinary, importFile }),
        session.controller.signal
      );
      // Persistence owns cancellation before commit; a successful callback is authoritative.
      session.completed = completed;
      session.status = 'completed';
      session.updatedAt = Date.now();
      if (session.controller.signal.aborted)
        console.info('[Projects] Import cancellation settled.', { uploadId, outcome: 'committed' });
      await safelyRemove(session.directory);
      return completed;
    } catch (error) {
      session.failure = session.controller.signal.aborted
        ? new SourcePreparationCancelledError()
        : error;
      session.status = 'failed';
      session.updatedAt = Date.now();
      if (session.controller.signal.aborted)
        console.info('[Projects] Import cancellation settled.', { uploadId, outcome: 'succeeded' });
      await safelyRemove(session.directory);
      throw error;
    }
  });
  return session.completion;
};

/** Accept source work without keeping an HTTP request open for preparation. */
export const startSourcePreparation = (input: ProjectImportCompletionInput): void => {
  const session = sessions.get(getSessionKey(input.userId, input.uploadId));
  if (!session) throw new ProjectImportInputError('Caricamento delle fonti non trovato o scaduto.');
  if (session.status === 'failed') throw session.failure;
  if (session.completion || session.completed || session.status === 'finalizing') return;
  if (session.chunks.size !== session.chunkCount)
    throw new ProjectImportInputError('Non tutte le parti delle fonti sono state ricevute.');
  session.status = 'finalizing';
  void completeProjectImportUpload(input).catch(() => {
    // The session retains the failure for authenticated status polling.
  });
};

/** Releases only this module's generated staging directories and operations in isolated tests. */
export const clearProjectImportUploadsForTesting = async (): Promise<void> => {
  const owned = [...sessions.values()];
  for (const session of owned) session.controller.abort();
  await Promise.allSettled(
    owned.flatMap(session => (session.completion ? [session.completion] : []))
  );
  for (const session of owned) {
    sessions.delete(session.key);
    await safelyRemove(session.directory);
  }
};
