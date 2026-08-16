import { PROJECT_API_ERROR_CODE } from '@shared/projectContract';
import { PROJECT_IMPORT_BINARY_KIND } from '@shared/projectImportContract';
import {
  type DecodedProjectSnapshotWire,
  decodeProjectSnapshotWire,
  type ProjectSnapshotWire,
} from '@shared/projectSnapshotWire';
import { isSourceArchivePdfWarningReason } from '@shared/sourceArchiveWarnings';

import type {
  FileData,
  LibraryFolder,
  LibraryPlacement,
  ProjectId,
  ProjectPatch,
  ProjectRevisionEvent,
  ProjectSnapshot,
  ProjectSourceWarning,
  ProjectWriteOptions,
  SavedProjectMeta,
  StoredProjectSourceFile,
} from '../../types';
import { isRecord } from '../../utils/records.ts';
import { fetchWithSupabaseAuth } from '../auth/supabaseAuth.ts';
import { getBackendUrl } from '../openrouter/config.ts';
import { attachStoredSources, getCourseSourceDescriptors } from './courseSources.ts';
import type { ProjectRepository, ProjectSaveOptions, ProjectSaveResult } from './projectRepository';
import {
  PROJECT_COVER_REVISION_CONFLICT_MESSAGE,
  PROJECT_REQUEST_TOO_LARGE_MESSAGE,
  PROJECT_REVISION_CONFLICT_MESSAGE,
  PROJECT_SOURCE_ARCHIVE_CHANGED_MESSAGE,
  PROJECT_SYNC_ERROR_MESSAGE,
  ProjectStorageError,
  REMOTE_PROJECT_DELETED_MESSAGE,
} from './projectRepository';
import { subscribeToProjectRevisionStream } from './projectRevisionStream.ts';
import { exportProjectData, normalizeStoredProject } from './projectSnapshot.ts';

interface ApiResponse {
  code?: string;
  complete?: boolean;
  cover?: FileData | null;
  ready?: boolean;
  success: boolean;
  error?: string;
  data?: unknown;
  folder?: LibraryFolder | null;
  folders?: LibraryFolder[];
  meta?: SavedProjectMeta;
  placements?: LibraryPlacement[];
  project?: ProjectSnapshot | null;
  projects?: ProjectSnapshot[] | SavedProjectMeta[];
  source?: FileData | null;
  sourceWarnings?: unknown;
  sources?: StoredProjectSourceFile[];
  snapshot?: ProjectSnapshot;
  uploadStatus?: 'receiving' | 'finalizing' | 'completed';
}

interface ProjectImportConfig {
  directMaxBytes: number;
  maxChunkBytes: number;
  maxChunkCount: number;
  maxSerializedBytes: number;
  requestTimeoutMs: number;
}

const PROJECT_SYNC_TIMEOUT_MESSAGE =
  'La sincronizzazione sta impiegando troppo tempo. Il backend e raggiungibile, ma non ha completato la richiesta.';
const PROJECT_REQUEST_TIMEOUT_MS = 15_000;
const PROJECT_ARCHIVE_SAVE_TIMEOUT_MS = 10 * 60_000;
const PROJECT_ARCHIVE_DIRECT_MAX_BYTES = 16_000_000;
const PROJECT_IMPORT_STATUS_POLL_MS = 1_000;
const HTTP_STATUS_REQUEST_TOO_LARGE = 413;
const getUtf8Bytes = (value: string): number => new Blob([value]).size;

const getCodePointUtf8Bytes = (codePoint: number): number => {
  if (codePoint <= 0x7f) return 1;
  if (codePoint <= 0x7ff) return 2;
  if (codePoint <= 0xffff) return 3;
  return 4;
};

const findChunkEnd = (serialized: string, start: number, maxBytes: number): number => {
  let high = Math.min(serialized.length, start + maxBytes);
  if (getUtf8Bytes(serialized.slice(start, high)) <= maxBytes) {
    const lastCodeUnit = serialized.charCodeAt(high - 1);
    if (high < serialized.length && lastCodeUnit >= 0xd800 && lastCodeUnit <= 0xdbff) high -= 1;
    return high;
  }

  let bytes = 0;
  let end = start;
  while (end < high) {
    const codePoint = serialized.codePointAt(end);
    if (codePoint === undefined) break;
    const codePointBytes = getCodePointUtf8Bytes(codePoint);
    if (bytes + codePointBytes > maxBytes) break;
    bytes += codePointBytes;
    end += codePoint > 0xffff ? 2 : 1;
  }
  if (end <= start) {
    throw new ProjectStorageError(
      'La dimensione configurata per le parti del backup e troppo piccola.',
      'persistence-failed'
    );
  }
  return end;
};

const splitProjectImport = (serialized: string, maxChunkBytes: number): string[] => {
  const chunks: string[] = [];
  let start = 0;
  while (start < serialized.length) {
    const end = findChunkEnd(serialized, start, maxChunkBytes);
    chunks.push(serialized.slice(start, end));
    start = end;
  }
  return chunks;
};

const createProjectSyncError = (error: unknown): ProjectStorageError => {
  console.warn('[Nous] Server project sync failed', error);
  if (error instanceof ProjectStorageError) {
    return new ProjectStorageError(
      error.httpStatus === HTTP_STATUS_REQUEST_TOO_LARGE
        ? PROJECT_REQUEST_TOO_LARGE_MESSAGE
        : responseErrorMessage(error.code),
      error.code,
      {
        contentType: error.responseContentType,
        sourceWarnings: error.sourceWarnings,
        status: error.httpStatus,
      }
    );
  }
  if (error instanceof Error && error.name === 'AbortError') {
    return new ProjectStorageError(PROJECT_SYNC_TIMEOUT_MESSAGE, 'persistence-failed');
  }

  return new ProjectStorageError(PROJECT_SYNC_ERROR_MESSAGE, 'persistence-failed');
};

const responseErrorCode = (status: number, apiCode?: string): ProjectStorageError['code'] => {
  if (status === 404) return 'project-deleted';
  if (apiCode === PROJECT_API_ERROR_CODE.revisionConflict) return 'revision-conflict';
  if (apiCode === PROJECT_API_ERROR_CODE.coverRevisionConflict) return 'cover-revision-conflict';
  if (apiCode === PROJECT_API_ERROR_CODE.sourceArchiveBusy) return 'source-archive-busy';
  if (apiCode === PROJECT_API_ERROR_CODE.sourceArchiveChanged) return 'source-archive-changed';
  if (apiCode === PROJECT_API_ERROR_CODE.sourceArchiveUnusable) return 'source-archive-unusable';
  if (status === HTTP_STATUS_REQUEST_TOO_LARGE || status === 429) return 'quota-exceeded';
  return 'persistence-failed';
};

function responseErrorMessage(code: ProjectStorageError['code']): string {
  if (code === 'project-deleted') return REMOTE_PROJECT_DELETED_MESSAGE;
  if (code === 'revision-conflict') return PROJECT_REVISION_CONFLICT_MESSAGE;
  if (code === 'cover-revision-conflict') return PROJECT_COVER_REVISION_CONFLICT_MESSAGE;
  if (code === 'source-archive-busy') {
    return 'È già in corso la preparazione di un archivio ZIP. Riprova tra poco.';
  }
  if (code === 'source-archive-changed') return PROJECT_SOURCE_ARCHIVE_CHANGED_MESSAGE;
  if (code === 'source-archive-unusable') {
    return 'L’archivio non contiene alcun testo utilizzabile.';
  }
  return PROJECT_SYNC_ERROR_MESSAGE;
}

const readSourceWarnings = (value: unknown): ProjectSourceWarning[] | undefined => {
  if (!Array.isArray(value)) return undefined;
  const warnings = value.flatMap(warning =>
    isRecord(warning) &&
    typeof warning.path === 'string' &&
    isSourceArchivePdfWarningReason(warning.reason)
      ? [
          {
            message: 'Questa fonte non contiene testo PDF utilizzabile.',
            name: warning.path,
            reason: warning.reason,
          },
        ]
      : []
  );
  return warnings.length > 0 ? warnings : undefined;
};

const readApiResponse = async <T>(response: Response): Promise<ApiResponse & T> => {
  try {
    return (await response.json()) as ApiResponse & T;
  } catch (error) {
    if (response.ok) throw error;
    return {
      success: false,
      error: response.statusText || 'Risposta backend non valida.',
    } as ApiResponse & T;
  }
};

const omitDuplicatedPrimarySourceBytes = (snapshot: ProjectSnapshotWire): ProjectSnapshotWire => {
  const source = snapshot.source;
  if (
    !source ||
    source.kind === 'archive' ||
    !isRecord(source.file) ||
    !Array.isArray(source.sources) ||
    typeof source.file.sourceId !== 'string' ||
    !source.file.data
  ) {
    return snapshot;
  }
  const primarySourceId = source.file.sourceId;
  const primarySource = source.sources.find(
    descriptor => isRecord(descriptor) && descriptor.id === primarySourceId
  );
  if (
    !isRecord(primarySource) ||
    !isRecord(primarySource.file) ||
    primarySource.file.sourceId !== primarySourceId ||
    primarySource.file.data !== source.file.data
  ) {
    return snapshot;
  }
  return {
    ...snapshot,
    source: {
      ...source,
      file: { ...source.file, data: '' },
    },
  };
};

const assertValue = <T>(value: T | undefined, message: string): T => {
  if (value === undefined) {
    throw new ProjectStorageError(message, 'persistence-failed');
  }

  return value;
};

export class HttpProjectRepository implements ProjectRepository {
  private readonly baseUrl: string;
  private projectImportConfigPromise?: Promise<ProjectImportConfig>;

  constructor(baseUrl = getBackendUrl()) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
  }

  async createFolder(args: {
    name: string;
    parentFolderId?: string | null;
  }): Promise<LibraryFolder> {
    const response = await this.request<{ folder?: LibraryFolder }>('/api/projects/folders', {
      method: 'POST',
      body: JSON.stringify(args),
    });
    return assertValue(response.folder, 'La cartella sincronizzata non e stata creata.');
  }

  async deleteFolder(folderId: string): Promise<void> {
    await this.request(`/api/projects/folders/${encodeURIComponent(folderId)}`, {
      method: 'DELETE',
    });
  }

  async listFolders(): Promise<LibraryFolder[]> {
    const response = await this.request<{ folders?: LibraryFolder[] }>('/api/projects/folders');
    return response.folders || [];
  }

  async listPlacements(): Promise<LibraryPlacement[]> {
    const response = await this.request<{ placements?: LibraryPlacement[] }>(
      '/api/projects/placements'
    );
    return response.placements || [];
  }

  async listProjects(): Promise<SavedProjectMeta[]> {
    const response = await this.request<{ projects?: SavedProjectMeta[] }>(
      '/api/projects/projects'
    );
    return response.projects || [];
  }

  async loadProject(id: ProjectId): Promise<ProjectSnapshot | null> {
    return (await this.loadProjectWithRevision(id))?.snapshot || null;
  }

  async loadProjectWithRevision(id: ProjectId): Promise<{
    revision: number;
    snapshot: ProjectSnapshot;
  } | null> {
    const response = await this.request<{
      project?: ProjectSnapshot | null;
      revision?: number;
    }>(`/api/projects/projects/${encodeURIComponent(id)}`);
    if (!response.project) return null;
    const revision = response.revision;
    if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 1) {
      throw new ProjectStorageError(
        'La revisione del progetto sincronizzato non è valida.',
        'persistence-failed'
      );
    }
    return {
      revision,
      snapshot: normalizeStoredProject(response.project),
    };
  }

  async loadProjectCover(id: ProjectId): Promise<FileData | null> {
    const response = await this.request<{ cover?: FileData | null }>(
      `/api/projects/projects/${encodeURIComponent(id)}/cover`
    );
    return response.cover || null;
  }

  async loadProjectSource(id: ProjectId): Promise<FileData | null> {
    const response = await this.request<{ source?: FileData | null }>(
      `/api/projects/projects/${encodeURIComponent(id)}/source`
    );
    return response.source || null;
  }

  async loadProjectSourceById(id: ProjectId, sourceId: string): Promise<FileData | null> {
    const response = await this.request<{ source?: FileData | null }>(
      `/api/projects/projects/${encodeURIComponent(id)}/sources/${encodeURIComponent(sourceId)}`
    );
    return response.source || null;
  }

  async loadProjectSources(id: ProjectId): Promise<StoredProjectSourceFile[]> {
    const response = await this.request<{ sources?: StoredProjectSourceFile[] }>(
      `/api/projects/projects/${encodeURIComponent(id)}/sources`
    );
    return response.sources || [];
  }

  async loadProjectsById(ids: ProjectId[]): Promise<ProjectSnapshot[]> {
    const response = await this.request<{ projects?: ProjectSnapshot[] }>(
      '/api/projects/projects/by-id',
      {
        method: 'POST',
        body: JSON.stringify({ ids }),
      }
    );
    return (response.projects || []).map(normalizeStoredProject);
  }

  async moveFolder(
    folderId: string,
    parentFolderId: string | null,
    targetIndex?: number
  ): Promise<LibraryFolder | null> {
    const response = await this.request<{ folder?: LibraryFolder | null }>(
      `/api/projects/folders/${encodeURIComponent(folderId)}/move`,
      {
        method: 'POST',
        body: JSON.stringify({ parentFolderId, targetIndex }),
      }
    );
    return response.folder || null;
  }

  async moveProjects(
    projectIds: ProjectId[],
    folderId: string | null,
    targetIndex?: number
  ): Promise<LibraryPlacement[]> {
    const response = await this.request<{ placements?: LibraryPlacement[] }>(
      '/api/projects/placements/move',
      {
        method: 'POST',
        body: JSON.stringify({ projectIds, folderId, targetIndex }),
      }
    );
    return response.placements || [];
  }

  async renameFolder(folderId: string, name: string): Promise<LibraryFolder | null> {
    const response = await this.request<{ folder?: LibraryFolder | null }>(
      `/api/projects/folders/${encodeURIComponent(folderId)}`,
      {
        method: 'PATCH',
        body: JSON.stringify({ name }),
      }
    );
    return response.folder || null;
  }

  async saveProject(
    snapshot: ProjectSnapshot,
    { archiveFile, ...options }: ProjectSaveOptions = {}
  ): Promise<ProjectSaveResult> {
    let snapshotToSave = snapshot;
    const source = snapshot.source;
    if (source?.kind === 'archive' && source.file.data) {
      throw new ProjectStorageError(
        'Gli archivi devono essere caricati come file binari.',
        'persistence-failed'
      );
    }
    if (source?.kind !== 'archive' && source?.sources?.length) {
      const descriptors = getCourseSourceDescriptors(source);
      if (
        descriptors.some(descriptor => descriptor.file.data) &&
        descriptors.some(descriptor => !descriptor.file.data)
      ) {
        const storedFilesById = new Map(
          (await this.loadProjectSources(snapshot.id)).map(stored => [stored.ref.id, stored.file])
        );
        const completeFiles = descriptors.map(descriptor =>
          descriptor.file.data
            ? descriptor.file
            : assertValue(
                storedFilesById.get(descriptor.id),
                `La sorgente ${descriptor.name} non e disponibile.`
              )
        );
        snapshotToSave = {
          ...snapshot,
          source: attachStoredSources(source, completeFiles),
        };
      }
    }
    const projectPayload = omitDuplicatedPrimarySourceBytes(
      exportProjectData(snapshotToSave, {
        externalArchiveBytesAvailable: Boolean(archiveFile?.size),
      })
    );
    if (archiveFile && archiveFile.size > PROJECT_ARCHIVE_DIRECT_MAX_BYTES) {
      const importConfig = await this.getProjectImportConfig();
      return this.saveArchiveProjectInChunks(projectPayload, archiveFile, importConfig, options);
    }
    const body = archiveFile
      ? this.createArchiveSaveBody(projectPayload, archiveFile, options)
      : JSON.stringify({ snapshot: projectPayload, ...options });
    const response = await this.request<{
      meta?: SavedProjectMeta;
      snapshot?: ProjectSnapshot;
    }>(
      `/api/projects/projects/${encodeURIComponent(snapshot.id)}`,
      {
        method: 'PUT',
        body,
      },
      source?.kind === 'archive' ? PROJECT_ARCHIVE_SAVE_TIMEOUT_MS : PROJECT_REQUEST_TIMEOUT_MS
    );
    return {
      meta: assertValue(response.meta, 'Il progetto sincronizzato non e stato salvato.'),
      snapshot: normalizeStoredProject(
        assertValue(response.snapshot, 'La fonte sincronizzata non e stata restituita.')
      ),
    };
  }

  private createArchiveSaveBody(
    snapshot: ProjectSnapshotWire,
    archiveFile: File,
    options: ProjectWriteOptions
  ): FormData {
    if (snapshot.source?.kind !== 'archive') {
      throw new ProjectStorageError(
        'Il file archivio richiede una sorgente ZIP.',
        'persistence-failed'
      );
    }
    const body = new FormData();
    body.append('snapshot', JSON.stringify(snapshot));
    if (options.expectedRevision !== undefined) {
      body.append('expectedRevision', String(options.expectedRevision));
    }
    body.append('archive', archiveFile);
    return body;
  }

  private async saveArchiveProjectInChunks(
    snapshot: ProjectSnapshotWire,
    archiveFile: File,
    config: ProjectImportConfig,
    options: ProjectWriteOptions
  ): Promise<ProjectSaveResult> {
    if (snapshot.source?.kind !== 'archive') {
      throw new ProjectStorageError(
        'Il file archivio richiede una sorgente ZIP.',
        'persistence-failed'
      );
    }
    const sourceFile = snapshot.source.file;
    if (
      !isRecord(sourceFile) ||
      typeof sourceFile.name !== 'string' ||
      typeof sourceFile.mimeType !== 'string'
    ) {
      throw new ProjectStorageError(
        'Il file archivio richiede metadati validi.',
        'persistence-failed'
      );
    }
    const uploadId = await this.uploadBinaryProjectImport(
      archiveFile,
      config,
      options.expectedRevision
    );
    try {
      const response = await this.request<{
        meta?: SavedProjectMeta;
        snapshot?: ProjectSnapshot;
      }>(
        `/api/projects/import/chunks/${encodeURIComponent(uploadId)}/complete`,
        {
          body: JSON.stringify({
            ...options,
            payloadKind: PROJECT_IMPORT_BINARY_KIND.sourceArchive,
            snapshot,
            sourceFile: { name: sourceFile.name, mimeType: sourceFile.mimeType },
          }),
          method: 'POST',
        },
        PROJECT_ARCHIVE_SAVE_TIMEOUT_MS
      );
      return {
        meta: assertValue(response.meta, 'Il progetto sincronizzato non e stato salvato.'),
        snapshot: normalizeStoredProject(
          assertValue(response.snapshot, 'La fonte sincronizzata non e stata restituita.')
        ),
      };
    } catch (error) {
      const status = await this.waitForCompletedProjectImport(
        uploadId,
        PROJECT_ARCHIVE_SAVE_TIMEOUT_MS
      );
      if (!status?.complete) throw error;
      return {
        meta: assertValue(status.meta, 'Il progetto sincronizzato non e stato salvato.'),
        snapshot: normalizeStoredProject(
          assertValue(status.snapshot, 'La fonte sincronizzata non e stata restituita.')
        ),
      };
    }
  }

  async saveProjectCover(id: ProjectId, cover: FileData): Promise<void> {
    await this.request(`/api/projects/projects/${encodeURIComponent(id)}/cover`, {
      method: 'POST',
      body: JSON.stringify({ cover }),
    });
  }

  async setProjectFavorite(id: ProjectId, isFavorite: boolean): Promise<SavedProjectMeta> {
    const response = await this.request<{ meta?: SavedProjectMeta }>(
      `/api/projects/projects/${encodeURIComponent(id)}/favorite`,
      {
        method: 'PATCH',
        body: JSON.stringify({ isFavorite }),
      }
    );
    return assertValue(response.meta, 'Il preferito sincronizzato non e stato aggiornato.');
  }

  async patchProject(
    id: ProjectId,
    patch: ProjectPatch,
    options: ProjectWriteOptions = {}
  ): Promise<SavedProjectMeta> {
    const response = await this.request<{ meta?: SavedProjectMeta }>(
      `/api/projects/projects/${encodeURIComponent(id)}`,
      {
        method: 'PATCH',
        body: JSON.stringify({ patch, ...options }),
      }
    );
    return assertValue(response.meta, 'Il progetto sincronizzato non e stato aggiornato.');
  }

  subscribeToProjectRevisions(
    listener: (event: ProjectRevisionEvent) => void,
    requestCatchUp: () => void
  ): () => void {
    return subscribeToProjectRevisionStream({
      listener,
      onCatchUp: requestCatchUp,
      url: `${this.baseUrl}/api/projects/events`,
    });
  }

  async deleteProject(id: ProjectId): Promise<void> {
    await this.request(`/api/projects/projects/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
  }

  async importProject(
    data: unknown
  ): Promise<{ meta: SavedProjectMeta; snapshot: ProjectSnapshot }> {
    const serializedData = JSON.stringify(data);
    if (serializedData === undefined) {
      throw new ProjectStorageError('Il progetto da importare non e valido.', 'persistence-failed');
    }
    const importConfig = await this.getProjectImportConfig();
    const serializedBytes = getUtf8Bytes(serializedData);
    if (serializedBytes > importConfig.maxSerializedBytes) {
      throw new ProjectStorageError(
        'Il backup supera il limite massimo di importazione configurato sul server.',
        'quota-exceeded'
      );
    }
    let response: ApiResponse & {
      meta?: SavedProjectMeta;
      snapshot?: ProjectSnapshot;
    };
    if (serializedBytes <= importConfig.directMaxBytes) {
      response = await this.request('/api/projects/import', {
        method: 'POST',
        body: `{"data":${serializedData}}`,
      });
    } else {
      const uploadId = globalThis.crypto.randomUUID();
      const chunks = splitProjectImport(serializedData, importConfig.maxChunkBytes);
      const chunkCount = chunks.length;
      if (chunkCount > importConfig.maxChunkCount) {
        throw new ProjectStorageError(
          'Il backup richiede piu parti di quante il server ne accetti.',
          'quota-exceeded'
        );
      }
      try {
        for (let chunkIndex = 0; chunkIndex < chunkCount; chunkIndex += 1) {
          const chunkResponse = await this.requestImportUpload<ApiResponse>(
            `/api/projects/import/chunks/${encodeURIComponent(uploadId)}/${chunkIndex}?chunkCount=${chunkCount}`,
            {
              body: chunks[chunkIndex],
              headers: { 'Content-Type': 'text/plain' },
              method: 'PUT',
            },
            importConfig.requestTimeoutMs
          );
          if (
            chunkResponse.complete !== false ||
            (chunkIndex === chunkCount - 1 && !chunkResponse.ready)
          ) {
            throw new ProjectStorageError(
              'Il backend non ha confermato tutte le parti del backup.',
              'persistence-failed'
            );
          }
        }
      } catch (error) {
        await this.cancelProjectImportUpload(uploadId, importConfig.requestTimeoutMs);
        throw error;
      }
      try {
        response = await this.requestImportUpload(
          `/api/projects/import/chunks/${encodeURIComponent(uploadId)}/complete`,
          {
            method: 'POST',
          },
          importConfig.requestTimeoutMs
        );
      } catch (error) {
        const status = await this.waitForCompletedProjectImport(
          uploadId,
          importConfig.requestTimeoutMs
        );
        if (!status?.complete) throw error;
        response = status;
      }
    }
    return {
      meta: assertValue(response.meta, 'Il progetto sincronizzato non e stato importato.'),
      snapshot: assertValue(response.snapshot, 'Il progetto sincronizzato non e stato importato.'),
    };
  }

  async importProjectArchive(
    archive: Blob,
    targetProjectId: ProjectId
  ): Promise<{ meta: SavedProjectMeta; snapshot: ProjectSnapshot }> {
    const importConfig = await this.getProjectImportConfig();
    if (archive.size === 0) {
      throw new ProjectStorageError(
        'Il backup supera il limite massimo di importazione configurato sul server.',
        'quota-exceeded'
      );
    }
    const uploadId = await this.uploadBinaryProjectImport(archive, importConfig);

    let response: ApiResponse & { meta?: SavedProjectMeta; snapshot?: ProjectSnapshot };
    try {
      response = await this.requestImportUpload(
        `/api/projects/import/chunks/${encodeURIComponent(uploadId)}/complete`,
        {
          body: JSON.stringify({
            payloadKind: PROJECT_IMPORT_BINARY_KIND.backup,
            targetProjectId,
          }),
          method: 'POST',
        },
        importConfig.requestTimeoutMs
      );
    } catch (error) {
      const status = await this.waitForCompletedProjectImport(
        uploadId,
        importConfig.requestTimeoutMs
      );
      if (!status?.complete) throw error;
      response = status;
    }
    return {
      meta: assertValue(response.meta, 'Il progetto sincronizzato non e stato importato.'),
      snapshot: normalizeStoredProject(
        assertValue(response.snapshot, 'Il progetto sincronizzato non e stato importato.')
      ),
    };
  }

  async exportProject(id: ProjectId): Promise<DecodedProjectSnapshotWire | null> {
    const response = await this.request<{ data?: unknown }>(
      `/api/projects/projects/${encodeURIComponent(id)}/export`,
      {
        method: 'POST',
      }
    );
    if (response.data == null) return null;
    try {
      return decodeProjectSnapshotWire(response.data);
    } catch (error) {
      throw createProjectSyncError(error);
    }
  }

  async touchProject(id: ProjectId): Promise<void> {
    await this.request(`/api/projects/projects/${encodeURIComponent(id)}/touch`, {
      method: 'POST',
    });
  }

  private getProjectImportConfig(): Promise<ProjectImportConfig> {
    this.projectImportConfigPromise ??= this.request<{
      config?: { import?: ProjectImportConfig };
    }>('/api/projects/config')
      .then(response =>
        assertValue(response.config?.import, 'Configurazione importazione non disponibile.')
      )
      .catch(error => {
        this.projectImportConfigPromise = undefined;
        throw error;
      });
    return this.projectImportConfigPromise;
  }

  private async uploadBinaryProjectImport(
    archive: Blob,
    config: ProjectImportConfig,
    expectedRevision?: number
  ): Promise<string> {
    const chunkCount = Math.ceil(archive.size / config.maxChunkBytes);
    if (chunkCount > config.maxChunkCount || archive.size > config.maxSerializedBytes) {
      throw new ProjectStorageError(
        'Il backup supera il limite massimo di importazione configurato sul server.',
        'quota-exceeded'
      );
    }
    const uploadId = globalThis.crypto.randomUUID();
    const expectedRevisionQuery =
      expectedRevision === undefined ? '' : `&expectedRevision=${expectedRevision}`;
    try {
      for (let chunkIndex = 0; chunkIndex < chunkCount; chunkIndex += 1) {
        await this.requestImportUpload(
          `/api/projects/import/chunks/${encodeURIComponent(uploadId)}/${chunkIndex}?chunkCount=${chunkCount}${expectedRevisionQuery}`,
          {
            body: archive.slice(
              chunkIndex * config.maxChunkBytes,
              Math.min(archive.size, (chunkIndex + 1) * config.maxChunkBytes)
            ),
            headers: { 'Content-Type': 'application/octet-stream' },
            method: 'PUT',
          },
          config.requestTimeoutMs
        );
      }
      return uploadId;
    } catch (error) {
      await this.cancelProjectImportUpload(uploadId, config.requestTimeoutMs);
      throw error;
    }
  }

  private async cancelProjectImportUpload(uploadId: string, timeoutMs: number): Promise<void> {
    try {
      await this.request(`/api/projects/import/chunks/${encodeURIComponent(uploadId)}`, {
        method: 'DELETE',
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      console.warn('[Nous] Failed to cancel an incomplete project import.', error);
    }
  }

  private async waitForCompletedProjectImport(
    uploadId: string,
    timeoutMs: number
  ): Promise<(ApiResponse & { meta?: SavedProjectMeta; snapshot?: ProjectSnapshot }) | undefined> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const status = await this.request<
          ApiResponse & { meta?: SavedProjectMeta; snapshot?: ProjectSnapshot }
        >(`/api/projects/import/chunks/${encodeURIComponent(uploadId)}`, {
          signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())),
        });
        if (status.complete) return status;
        if (status.uploadStatus !== 'finalizing') {
          await this.cancelProjectImportUpload(uploadId, Math.max(1, deadline - Date.now()));
          return undefined;
        }
      } catch {
        return undefined;
      }
      await new Promise(resolve => globalThis.setTimeout(resolve, PROJECT_IMPORT_STATUS_POLL_MS));
    }
    return undefined;
  }

  private async requestImportUpload<T>(
    path: string,
    init: RequestInit,
    timeoutMs: number
  ): Promise<T> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return await this.request<T>(path, {
          ...init,
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        const isAmbiguousNetworkFailure =
          error instanceof ProjectStorageError &&
          (error.message === PROJECT_SYNC_ERROR_MESSAGE ||
            error.message === PROJECT_SYNC_TIMEOUT_MESSAGE ||
            (error.code === 'quota-exceeded' &&
              error.httpStatus !== HTTP_STATUS_REQUEST_TOO_LARGE));
        if (!isAmbiguousNetworkFailure || attempt === 2) throw error;
        await new Promise(resolve => globalThis.setTimeout(resolve, 1_000 * (attempt + 1)));
      }
    }
    throw new ProjectStorageError(PROJECT_SYNC_ERROR_MESSAGE, 'persistence-failed');
  }

  private async request<T>(
    path: string,
    init: RequestInit = {},
    timeoutMs = PROJECT_REQUEST_TIMEOUT_MS
  ): Promise<T> {
    const requestUrl = `${this.baseUrl}${path}`;
    const timeoutController = new AbortController();
    const timeoutId = globalThis.setTimeout(() => {
      timeoutController.abort();
    }, timeoutMs);

    try {
      const response = await fetchWithSupabaseAuth(requestUrl, {
        ...init,
        cache: init.cache || 'no-store',
        headers:
          init.body instanceof FormData
            ? init.headers
            : {
                'Content-Type': 'application/json',
                ...init.headers,
              },
        signal: init.signal || timeoutController.signal,
      });
      const data = await readApiResponse<T>(response);

      if (!response.ok || data.success === false) {
        const errorCode = responseErrorCode(response.status, data.code);
        throw new ProjectStorageError(
          data.error || response.statusText || 'Richiesta server non riuscita.',
          errorCode,
          {
            contentType: response.headers?.get('content-type') || undefined,
            sourceWarnings: readSourceWarnings(data.sourceWarnings),
            status: response.status,
          }
        );
      }

      return data;
    } catch (error) {
      throw createProjectSyncError(error);
    } finally {
      globalThis.clearTimeout(timeoutId);
    }
  }
}
