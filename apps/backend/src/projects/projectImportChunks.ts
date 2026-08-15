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
import { projectImportConfig } from './projectImportConfig.js';
import type { SavedProjectMeta } from './types.js';

const IMPORT_ROOT_PREFIX = 'nous-project-imports-';
const IMPORT_ROOT_PROMISE = mkdtemp(join(tmpdir(), IMPORT_ROOT_PREFIX));
const IMPORT_UPLOAD_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

interface ProjectImportChunk {
  chunk: string | Uint8Array;
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
  meta: SavedProjectMeta;
  projectId: string;
}

interface UploadSession {
  chunkCount: number;
  chunks: Map<number, StoredChunk>;
  completed?: CompletedImport;
  completion?: Promise<CompletedImport>;
  directory: string;
  expectedRevision?: number;
  format: 'binary' | 'text';
  key: string;
  lock: Promise<void>;
  status: 'receiving' | 'finalizing' | 'completed';
  totalBytes: number;
  updatedAt: number;
  uploadId: string;
  userId: string;
}

export class ProjectImportInputError extends Error {}
export class ProjectImportCapacityError extends Error {}

const sessions = new Map<string, UploadSession>();
const pendingSessions = new Map<string, Promise<UploadSession>>();
let activeFinalizations = 0;
const pendingFinalizations: Array<() => void> = [];

const getUserHash = (userId: string): string =>
  createHash('sha256').update(userId).digest('hex').slice(0, 32);

const getSessionKey = (userId: string, uploadId: string): string =>
  `${getUserHash(userId)}-${uploadId}`;

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

const validateChunk = ({ chunk, chunkCount, chunkIndex, uploadId }: ProjectImportChunk): number => {
  if (!IMPORT_UPLOAD_ID_PATTERN.test(uploadId)) {
    throw new ProjectImportInputError('Identificativo caricamento non valido.');
  }
  if (
    !Number.isSafeInteger(chunkCount) ||
    chunkCount < 1 ||
    chunkCount > projectImportConfig.maxChunkCount
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

const runFinalization = async <T>(operation: () => Promise<T>): Promise<T> => {
  await new Promise<void>(resolve => {
    if (activeFinalizations < projectImportConfig.finalizationsGlobal) {
      activeFinalizations += 1;
      resolve();
      return;
    }
    pendingFinalizations.push(resolve);
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
    session => session.userId === userId && session.status !== 'completed'
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
    key,
    lock: Promise.resolve(),
    status: 'receiving',
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
  const existing = sessions.get(key);
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
    session => session.status !== 'completed'
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
): Promise<{ ready: boolean; receivedCount: number }> => {
  const chunkBytes = validateChunk(input);
  await cleanupExpiredSessions();
  const session = await getOrCreateSession(input);

  return withSessionLock(session, async () => {
    if (session.status !== 'receiving') {
      throw new ProjectImportInputError('Questo backup e gia stato elaborato.');
    }
    if (session.chunkCount !== input.chunkCount) {
      throw new ProjectImportInputError('Il numero di parti del backup non e coerente.');
    }
    if (session.format !== (typeof input.chunk === 'string' ? 'text' : 'binary')) {
      throw new ProjectImportInputError('Il formato delle parti del backup non e coerente.');
    }
    if (session.expectedRevision !== input.expectedRevision) {
      throw new ProjectImportInputError('La revisione del progetto non e coerente.');
    }

    const digest = createHash('sha256').update(input.chunk).digest('hex');
    const existingChunk = session.chunks.get(input.chunkIndex);
    if (existingChunk) {
      if (existingChunk.bytes !== chunkBytes || existingChunk.digest !== digest) {
        throw new ProjectImportInputError('Una parte del backup e stata inviata con dati diversi.');
      }
      session.updatedAt = Date.now();
      return {
        ready: session.chunks.size === session.chunkCount,
        receivedCount: session.chunks.size,
      };
    }

    if (session.totalBytes + chunkBytes > projectImportConfig.maxSerializedBytes) {
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
  await withSessionLock(session, async () => {
    if (session.status !== 'receiving') {
      throw new ProjectImportInputError('Questo backup non puo piu essere annullato.');
    }
    sessions.delete(session.key);
    await safelyRemove(session.directory);
  });
};

export const getProjectImportUploadStatus = (
  userId: string,
  uploadId: string
): { completed?: CompletedImport; status: UploadSession['status'] } | undefined => {
  if (!IMPORT_UPLOAD_ID_PATTERN.test(uploadId)) {
    throw new ProjectImportInputError('Identificativo caricamento non valido.');
  }
  const session = sessions.get(getSessionKey(userId, uploadId));
  if (!session) return undefined;
  return { completed: session.completed, status: session.status };
};

const assembleAndImport = async (
  session: UploadSession,
  importData?: (data: unknown) => Promise<CompletedImport>,
  importBinary?: (bytes: Uint8Array, expectedRevision?: number) => Promise<CompletedImport>
): Promise<CompletedImport> => {
  const assembledPath = join(session.directory, 'assembled');
  await writeFile(assembledPath, '', { flag: 'wx', mode: 0o600 });
  for (let index = 0; index < session.chunkCount; index += 1) {
    const chunkPath = join(session.directory, `${index}.part`);
    const chunk = await readFile(chunkPath);
    await appendFile(assembledPath, chunk);
    await unlink(chunkPath);
  }

  if (session.format === 'binary') {
    if (!importBinary) throw new ProjectImportInputError('Formato del backup non valido.');
    return importBinary(new Uint8Array(await readFile(assembledPath)), session.expectedRevision);
  }

  if (!importData) throw new ProjectImportInputError('Formato del backup non valido.');
  let serialized = await readFile(assembledPath, 'utf8');
  let data: unknown;
  try {
    data = JSON.parse(serialized) as unknown;
  } catch {
    throw new ProjectImportInputError('Il contenuto del backup non e un JSON valido.');
  } finally {
    serialized = '';
  }
  return importData(data);
};

export const completeProjectImportUpload = async ({
  importBinary,
  importData,
  uploadId,
  userId,
}: {
  importBinary?: (bytes: Uint8Array, expectedRevision?: number) => Promise<CompletedImport>;
  importData?: (data: unknown) => Promise<CompletedImport>;
  uploadId: string;
  userId: string;
}): Promise<CompletedImport> => {
  if (!IMPORT_UPLOAD_ID_PATTERN.test(uploadId)) {
    throw new ProjectImportInputError('Identificativo caricamento non valido.');
  }
  await cleanupExpiredSessions();
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
      const completed = await runFinalization(() =>
        assembleAndImport(session, importData, importBinary)
      );
      session.completed = completed;
      session.status = 'completed';
      session.updatedAt = Date.now();
      await safelyRemove(session.directory);
      return completed;
    } catch (error) {
      sessions.delete(session.key);
      await safelyRemove(session.directory);
      throw error;
    }
  });
  return session.completion;
};
