import { COURSE_SOURCE_UPLOAD_LIMITS } from '@shared/courseSourceUpload';
import {
  LIBRARY_EXPORT_RETENTION_ERROR_CODE,
  type LibraryExportPhase,
  type LibraryExportProgress,
  type LibraryExportStatus,
} from '@shared/libraryExportContract';
import { PROJECT_API_ERROR_CODE } from '@shared/projectContract';
import { PROJECT_IMPORT_BINARY_KIND } from '@shared/projectImportContract';
import {
  type DecodedProjectSnapshotWire,
  decodeProjectSnapshotWire,
  type ProjectSnapshotWire,
} from '@shared/projectSnapshotWire';
import { isSourceArchivePdfWarningReason } from '@shared/sourceArchiveWarnings';
import {
  SOURCE_INGESTION_REQUIRED_CODE,
  SOURCE_INGESTION_REQUIRED_MESSAGE,
  SOURCE_PREPARATION_CANCELLED_CODE,
  SOURCE_PREPARATION_CANCELLED_MESSAGE,
  SOURCE_PREPARATION_FAILURE_MESSAGES,
  SOURCE_PREPARATION_INTERRUPTED_MESSAGE,
  SOURCE_PREPARATION_UNUSABLE_CODE,
  SOURCE_PREPARATION_UNUSABLE_MESSAGE,
  SOURCE_STAGING_UNAVAILABLE_CODE,
  SOURCE_STAGING_UNAVAILABLE_MESSAGE,
  type SourcePreparationProgress,
} from '@shared/sourcePreparation';
import { SOURCE_TRANSFER_LIMITS, type SourceTransferLimitModel } from '@shared/sourceTransfer';
import { translateUiMessage } from '../../i18n/uiMessages.ts';
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
import type {
  LibraryExportProgressListener,
  LibraryExportResult,
  ProjectRepository,
  ProjectSaveOptions,
  ProjectSaveResult,
} from './projectRepository';
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
import { createSourceIngestion, type SourceTransferFile } from './sourceIngestion';

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
  uploadStatus?: 'receiving' | 'finalizing' | 'completed' | 'failed';
  progress?: SourcePreparationProgress;
}

interface ProjectImportConfig {
  directMaxBytes: number;
  maxChunkBytes: number;
  maxChunkCount: number;
  maxSerializedBytes: number;
  requestTimeoutMs: number;
}

const PROJECT_SYNC_TIMEOUT_MESSAGE =
  'La sincronizzazione sta impiegando troppo tempo. Il backend è raggiungibile, ma non ha completato la richiesta.';
const PROJECT_REQUEST_TIMEOUT_MS = 15_000;
const PROJECT_ARCHIVE_SAVE_TIMEOUT_MS = 10 * 60_000;
const PROJECT_OPERATION_STATUS_POLL_MS = 1_000;
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
      'La dimensione configurata per le parti del backup è troppo piccola.',
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
  if (apiCode === SOURCE_PREPARATION_CANCELLED_CODE) return 'source-preparation-cancelled';
  if (apiCode === SOURCE_PREPARATION_UNUSABLE_CODE) return 'source-preparation-failed';
  if (apiCode === SOURCE_STAGING_UNAVAILABLE_CODE) return 'source-staging-unavailable';
  if (apiCode === SOURCE_INGESTION_REQUIRED_CODE) return 'source-ingestion-required';
  if (apiCode === PROJECT_API_ERROR_CODE.revisionConflict) return 'revision-conflict';
  if (apiCode === PROJECT_API_ERROR_CODE.coverRevisionConflict) return 'cover-revision-conflict';
  if (apiCode === PROJECT_API_ERROR_CODE.sourceArchiveBusy) return 'source-archive-busy';
  if (apiCode === PROJECT_API_ERROR_CODE.sourceArchiveChanged) return 'source-archive-changed';
  if (apiCode === PROJECT_API_ERROR_CODE.sourceArchiveInvalid) return 'source-archive-invalid';
  if (apiCode === PROJECT_API_ERROR_CODE.sourceArchiveUnusable) return 'source-archive-unusable';
  if (status === HTTP_STATUS_REQUEST_TOO_LARGE || status === 429) return 'quota-exceeded';
  return 'persistence-failed';
};

function responseErrorMessage(code: ProjectStorageError['code']): string {
  if (code === 'source-preparation-cancelled')
    return translateUiMessage(SOURCE_PREPARATION_CANCELLED_MESSAGE);
  if (code === 'source-preparation-interrupted')
    return translateUiMessage(SOURCE_PREPARATION_INTERRUPTED_MESSAGE);
  if (code === 'source-preparation-failed')
    return translateUiMessage(SOURCE_PREPARATION_UNUSABLE_MESSAGE);
  if (code === 'source-staging-unavailable')
    return translateUiMessage(SOURCE_STAGING_UNAVAILABLE_MESSAGE);
  if (code === 'source-ingestion-required')
    return translateUiMessage(SOURCE_INGESTION_REQUIRED_MESSAGE);
  if (code === 'project-deleted') return REMOTE_PROJECT_DELETED_MESSAGE;
  if (code === 'revision-conflict') return PROJECT_REVISION_CONFLICT_MESSAGE;
  if (code === 'cover-revision-conflict') return PROJECT_COVER_REVISION_CONFLICT_MESSAGE;
  if (code === 'source-archive-busy') {
    return translateUiMessage(
      'È già in corso la preparazione di un archivio ZIP. Riprova tra poco.'
    );
  }
  if (code === 'source-archive-changed') return PROJECT_SOURCE_ARCHIVE_CHANGED_MESSAGE;
  if (code === 'source-archive-invalid') {
    return translateUiMessage('Non è stato possibile preparare l’archivio ZIP.');
  }
  if (code === 'source-archive-unusable') {
    return translateUiMessage('L’archivio non contiene alcun testo utilizzabile.');
  }
  return PROJECT_SYNC_ERROR_MESSAGE;
}

const readSourceWarnings = (value: unknown): ProjectSourceWarning[] | undefined => {
  if (!Array.isArray(value)) return undefined;
  const warnings = value.flatMap(warning =>
    isRecord(warning) &&
    (typeof warning.name === 'string' || typeof warning.path === 'string') &&
    isSourceArchivePdfWarningReason(warning.reason)
      ? [
          {
            message: translateUiMessage(SOURCE_PREPARATION_FAILURE_MESSAGES[warning.reason]),
            name: (warning.name ?? warning.path) as string,
            reason: warning.reason,
          },
        ]
      : []
  );
  return warnings.length > 0 ? warnings : undefined;
};

const LIBRARY_EXPORT_PHASES = new Set<LibraryExportPhase>([
  'preparing',
  'project-archive',
  'library-archive',
  'integrity-check',
  'ready',
  'failed',
]);
const LIBRARY_EXPORT_STATUSES = new Set<LibraryExportStatus>([
  'cancelled',
  'completed',
  'downloaded',
  'failed',
  'running',
]);

const readLibraryExportProgress = (value: unknown): LibraryExportProgress => {
  if (
    !isRecord(value) ||
    typeof value.runId !== 'string' ||
    typeof value.correlationId !== 'string' ||
    typeof value.status !== 'string' ||
    !LIBRARY_EXPORT_STATUSES.has(value.status as LibraryExportStatus) ||
    typeof value.phase !== 'string' ||
    !LIBRARY_EXPORT_PHASES.has(value.phase as LibraryExportPhase) ||
    !Number.isSafeInteger(value.projectCount) ||
    (value.projectCount as number) < 0 ||
    !Number.isSafeInteger(value.completedProjectCount) ||
    (value.completedProjectCount as number) < 0 ||
    (value.completedProjectCount as number) > (value.projectCount as number) ||
    !Number.isSafeInteger(value.bytesWritten) ||
    (value.bytesWritten as number) < 0 ||
    (value.archiveBytes !== undefined &&
      (!Number.isSafeInteger(value.archiveBytes) || (value.archiveBytes as number) < 0)) ||
    (value.currentProjectId !== undefined && typeof value.currentProjectId !== 'string') ||
    (value.errorCode !== undefined && typeof value.errorCode !== 'string') ||
    (value.errorPhase !== undefined &&
      (typeof value.errorPhase !== 'string' ||
        !LIBRARY_EXPORT_PHASES.has(value.errorPhase as LibraryExportPhase)))
  ) {
    throw new ProjectStorageError('Stato del backup completo non valido.', 'persistence-failed');
  }
  return value as unknown as LibraryExportProgress;
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

const NATIVE_DOWNLOAD_FRAME_NAME = 'nous-native-download-frame';

const getNativeDownloadFrame = (): HTMLIFrameElement => {
  const existingFrame = document.getElementById(NATIVE_DOWNLOAD_FRAME_NAME);
  if (existingFrame instanceof HTMLIFrameElement) return existingFrame;
  const frame = document.createElement('iframe');
  frame.id = NATIVE_DOWNLOAD_FRAME_NAME;
  frame.name = NATIVE_DOWNLOAD_FRAME_NAME;
  frame.hidden = true;
  frame.title = 'Download del backup';
  document.body.appendChild(frame);
  return frame;
};

const startNativeDownload = (url: string, downloadToken: string): void => {
  getNativeDownloadFrame();
  const form = document.createElement('form');
  form.action = url;
  form.enctype = 'application/x-www-form-urlencoded';
  form.hidden = true;
  form.method = 'post';
  form.target = NATIVE_DOWNLOAD_FRAME_NAME;
  const tokenInput = document.createElement('input');
  tokenInput.name = 'downloadToken';
  tokenInput.type = 'hidden';
  tokenInput.value = downloadToken;
  form.appendChild(tokenInput);
  document.body.appendChild(form);
  try {
    form.submit();
  } finally {
    form.remove();
  }
};

export class HttpProjectRepository implements ProjectRepository {
  private readonly baseUrl: string;
  private projectImportConfigPromise?: Promise<ProjectImportConfig>;

  constructor(
    baseUrl = getBackendUrl(),
    private readonly sourceTransferLimits: Readonly<SourceTransferLimitModel> = SOURCE_TRANSFER_LIMITS
  ) {
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
    return assertValue(response.folder, 'La cartella sincronizzata non è stata creata.');
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
    { archiveFile, sourceFiles, signal, onSourceProgress, ...options }: ProjectSaveOptions = {}
  ): Promise<ProjectSaveResult> {
    let snapshotToSave = snapshot;
    const source = snapshot.source;
    if (source?.kind === 'archive' && source.file.data) {
      throw new ProjectStorageError(
        'Gli archivi devono essere caricati come file binari.',
        'persistence-failed'
      );
    }
    if (!sourceFiles && source?.kind !== 'archive' && source?.sources?.length) {
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
                `La sorgente ${descriptor.name} non è disponibile.`
              )
        );
        snapshotToSave = {
          ...snapshot,
          source: attachStoredSources(source, completeFiles),
        };
      }
    }
    if (sourceFiles?.length || archiveFile) {
      const ingestSources = createSourceIngestion({
        publish: (destination, files, progressOptions) =>
          this.publishSourceSet(destination.snapshot, files, {
            ...destination.options,
            signal: progressOptions.signal,
            onSourceProgress: progressOptions.onProgress,
          }),
      });
      return (
        await ingestSources({
          inputs: sourceFiles?.length
            ? sourceFiles
            : [assertValue(archiveFile, 'La sorgente archivio non è disponibile.')],
          destination: { snapshot, options },
          signal,
          onProgress: onSourceProgress,
        })
      ).result;
    }
    const projectPayload = omitDuplicatedPrimarySourceBytes(
      exportProjectData(snapshotToSave, {
        externalArchiveBytesAvailable: false,
        externalSourceFilesAvailable: false,
      })
    );
    const response = await this.request<{
      meta?: SavedProjectMeta;
      snapshot?: ProjectSnapshot;
    }>(
      `/api/projects/projects/${encodeURIComponent(snapshot.id)}`,
      {
        method: 'PUT',
        body: JSON.stringify({ snapshot: projectPayload, ...options }),
      },
      source?.kind === 'archive' ? PROJECT_ARCHIVE_SAVE_TIMEOUT_MS : PROJECT_REQUEST_TIMEOUT_MS
    );
    return {
      meta: assertValue(response.meta, 'Il progetto sincronizzato non è stato salvato.'),
      snapshot: normalizeStoredProject(
        assertValue(response.snapshot, 'La fonte sincronizzata non è stata restituita.')
      ),
    };
  }

  private async publishSourceSet(
    snapshot: ProjectSnapshot,
    inputs: readonly SourceTransferFile[],
    {
      signal,
      onSourceProgress,
      ...options
    }: Pick<ProjectSaveOptions, 'signal' | 'onSourceProgress'> & ProjectWriteOptions
  ): Promise<ProjectSaveResult> {
    const payload = omitDuplicatedPrimarySourceBytes(
      exportProjectData(snapshot, { externalSourceFilesAvailable: true })
    );
    const files = inputs.map(({ file, sourceId }) => ({
      id: sourceId,
      name: file.name,
      mimeType: file.type,
      byteSize: file.size,
    }));
    const prefix = new Blob([JSON.stringify({ snapshot: payload, sourceFiles: files })]);
    const uploadId = await this.uploadBinaryProjectImport(
      new Blob([prefix, ...inputs.map(input => input.file)]),
      await this.getProjectImportConfig(),
      options.expectedRevision,
      { signal, onSourceProgress }
    );
    return this.completeSourceProjectUpload(
      uploadId,
      { ...options, payloadKind: PROJECT_IMPORT_BINARY_KIND.sourceSet, metadataBytes: prefix.size },
      { signal, onSourceProgress }
    );
  }

  private async readSourcePreparationStatus(
    uploadId: string,
    signal?: AbortSignal
  ): Promise<ApiResponse> {
    try {
      return await this.request<ApiResponse>(
        `/api/projects/import/chunks/${encodeURIComponent(uploadId)}`,
        { signal }
      );
    } catch (error) {
      if (error instanceof ProjectStorageError && error.httpStatus === 404)
        throw new ProjectStorageError(
          translateUiMessage(SOURCE_PREPARATION_INTERRUPTED_MESSAGE),
          'source-preparation-interrupted'
        );
      throw error;
    }
  }

  private async beginSourcePreparation(
    uploadId: string,
    body: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<ApiResponse> {
    try {
      return await this.request<ApiResponse>(
        `/api/projects/import/chunks/${encodeURIComponent(uploadId)}/complete`,
        { body: JSON.stringify(body), method: 'POST', signal }
      );
    } catch (error) {
      if (
        signal?.aborted ||
        !(error instanceof ProjectStorageError) ||
        error.httpStatus !== undefined
      )
        throw error;
      return this.readSourcePreparationStatus(uploadId, signal);
    }
  }

  private async completeSourceProjectUpload(
    uploadId: string,
    body: Record<string, unknown>,
    options: Pick<ProjectSaveOptions, 'signal' | 'onSourceProgress'> = {}
  ): Promise<ProjectSaveResult> {
    try {
      let response = await this.beginSourcePreparation(uploadId, body, options.signal);
      while (!response.complete && !(response.meta && response.snapshot)) {
        options.signal?.throwIfAborted();
        if (response.progress) options.onSourceProgress?.(response.progress);
        response = await this.readSourcePreparationStatus(uploadId, options.signal);
        if (response.complete) break;
        if (response.uploadStatus !== 'finalizing')
          throw new ProjectStorageError(
            translateUiMessage(SOURCE_PREPARATION_INTERRUPTED_MESSAGE),
            'source-preparation-interrupted'
          );
        await new Promise(resolve =>
          globalThis.setTimeout(resolve, PROJECT_OPERATION_STATUS_POLL_MS)
        );
      }
      return {
        meta: assertValue(response.meta, 'Il progetto sincronizzato non è stato salvato.'),
        snapshot: normalizeStoredProject(
          assertValue(response.snapshot, 'La fonte sincronizzata non è stata restituita.')
        ),
      };
    } catch (error) {
      if (
        options.signal?.aborted ||
        (error instanceof ProjectStorageError && error.code === 'quota-exceeded')
      )
        await this.cancelProjectImportUpload(uploadId, PROJECT_REQUEST_TIMEOUT_MS);
      throw error;
    }
  }

  async saveProjectCover(
    id: ProjectId,
    cover: FileData,
    options: ProjectWriteOptions = {}
  ): Promise<SavedProjectMeta> {
    const response = await this.request<{ meta?: SavedProjectMeta }>(
      `/api/projects/projects/${encodeURIComponent(id)}/cover`,
      {
        method: 'POST',
        body: JSON.stringify({ cover, expectedRevision: options.expectedRevision }),
      }
    );
    return assertValue(response.meta, 'Il progetto sincronizzato non è stato salvato.');
  }

  async setProjectFavorite(
    id: ProjectId,
    isFavorite: boolean,
    options: ProjectWriteOptions = {}
  ): Promise<SavedProjectMeta> {
    const response = await this.request<{ meta?: SavedProjectMeta }>(
      `/api/projects/projects/${encodeURIComponent(id)}/favorite`,
      {
        method: 'PATCH',
        body: JSON.stringify({ isFavorite, expectedRevision: options.expectedRevision }),
      }
    );
    return assertValue(response.meta, 'Il preferito sincronizzato non è stato aggiornato.');
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
    return assertValue(response.meta, 'Il progetto sincronizzato non è stato aggiornato.');
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
      throw new ProjectStorageError('Il progetto da importare non è valido.', 'persistence-failed');
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
      response = await this.importTextProjectInChunks(serializedData, importConfig);
    }
    return {
      meta: assertValue(response.meta, 'Il progetto sincronizzato non è stato importato.'),
      snapshot: assertValue(response.snapshot, 'Il progetto sincronizzato non è stato importato.'),
    };
  }

  private async importTextProjectInChunks(
    serializedData: string,
    importConfig: ProjectImportConfig
  ): Promise<ApiResponse> {
    let response: ApiResponse;

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

    return response;
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
      meta: assertValue(response.meta, 'Il progetto sincronizzato non è stato importato.'),
      snapshot: normalizeStoredProject(
        assertValue(response.snapshot, 'Il progetto sincronizzato non è stato importato.')
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

  async exportLibraryBackup(
    onProgress?: LibraryExportProgressListener
  ): Promise<LibraryExportResult> {
    let response = await this.request<{ run?: unknown }>('/api/projects/library-exports', {
      method: 'POST',
    });
    let run = readLibraryExportProgress(
      assertValue(response.run, 'Stato del backup completo non disponibile.')
    );
    onProgress?.(run);
    while (run.status === 'running') {
      await new Promise(resolve =>
        globalThis.setTimeout(resolve, PROJECT_OPERATION_STATUS_POLL_MS)
      );
      response = await this.request<{ run?: unknown }>(
        `/api/projects/library-exports/${encodeURIComponent(run.runId)}`
      );
      run = readLibraryExportProgress(
        assertValue(response.run, 'Stato del backup completo non disponibile.')
      );
      onProgress?.(run);
    }
    if (run.status !== 'completed') {
      throw new ProjectStorageError(
        run.errorCode === LIBRARY_EXPORT_RETENTION_ERROR_CODE
          ? 'Il backup completo è scaduto. Avvia una nuova esportazione.'
          : 'La creazione del backup completo non è riuscita. Riprova.',
        'persistence-failed'
      );
    }

    const encodedRunId = encodeURIComponent(run.runId);
    const downloadAccess = await this.request<{ downloadToken?: unknown }>(
      `/api/projects/library-exports/${encodedRunId}/download-access`,
      { method: 'POST' }
    );
    if (typeof downloadAccess.downloadToken !== 'string' || !downloadAccess.downloadToken.trim()) {
      throw new ProjectStorageError(
        'Il backup completo non è disponibile per il download.',
        'persistence-failed'
      );
    }
    startNativeDownload(
      `${this.baseUrl}/api/projects/library-exports/${encodedRunId}/download`,
      downloadAccess.downloadToken
    );
    return { projectCount: run.projectCount };
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
    expectedRevision?: number,
    sourceUpload?: Pick<ProjectSaveOptions, 'signal' | 'onSourceProgress'>
  ): Promise<string> {
    const partBytes = sourceUpload
      ? Math.min(
          config.maxChunkBytes,
          this.sourceTransferLimits.maxPartBytes,
          this.sourceTransferLimits.maxRequestBytes
        )
      : config.maxChunkBytes;
    const requestTimeoutMs = sourceUpload
      ? Math.min(config.requestTimeoutMs, this.sourceTransferLimits.requestTimeoutMs)
      : config.requestTimeoutMs;
    const chunkCount = Math.ceil(archive.size / partBytes);
    const maxBytes = sourceUpload
      ? COURSE_SOURCE_UPLOAD_LIMITS.maxTotalBytes
      : config.maxSerializedBytes;
    const maxChunks = sourceUpload ? Math.ceil(maxBytes / partBytes) : config.maxChunkCount;
    if (chunkCount > maxChunks || archive.size > maxBytes) {
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
        sourceUpload?.signal?.throwIfAborted();
        await this.requestImportUpload(
          `/api/projects/import/chunks/${encodeURIComponent(uploadId)}/${chunkIndex}?chunkCount=${chunkCount}${expectedRevisionQuery}${sourceUpload ? '&sourceUpload=true' : ''}`,
          {
            body: archive.slice(
              chunkIndex * partBytes,
              Math.min(archive.size, (chunkIndex + 1) * partBytes)
            ),
            signal: sourceUpload?.signal,
            headers: { 'Content-Type': 'application/octet-stream' },
            method: 'PUT',
          },
          requestTimeoutMs
        );
        sourceUpload?.onSourceProgress?.({
          step: 'upload',
          completed: Math.min(archive.size, (chunkIndex + 1) * partBytes),
          total: archive.size,
        });
      }
      return uploadId;
    } catch (error) {
      await this.cancelProjectImportUpload(uploadId, config.requestTimeoutMs);
      throw error;
    }
  }

  private async cancelProjectImportUpload(uploadId: string, timeoutMs: number): Promise<void> {
    try {
      const cancellation = await this.request<ApiResponse>(
        `/api/projects/import/chunks/${encodeURIComponent(uploadId)}`,
        {
          method: 'DELETE',
          signal: AbortSignal.timeout(timeoutMs),
        }
      );
      if (cancellation.uploadStatus === 'finalizing')
        await this.waitForSourceCancellation(uploadId);
    } catch (error) {
      console.warn('[Nous] Failed to cancel an incomplete project import.', error);
    }
  }

  private async waitForSourceCancellation(uploadId: string): Promise<void> {
    for (;;) {
      try {
        const status = await this.readSourcePreparationStatus(uploadId);
        if (status.complete || status.uploadStatus !== 'finalizing') return;
      } catch (error) {
        if (
          error instanceof ProjectStorageError &&
          (error.code === 'source-preparation-cancelled' ||
            error.code === 'source-preparation-interrupted')
        )
          return;
        throw error;
      }
      await new Promise(resolve =>
        globalThis.setTimeout(resolve, PROJECT_OPERATION_STATUS_POLL_MS)
      );
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
      } catch (error) {
        if (error instanceof ProjectStorageError && error.httpStatus === 404) return undefined;
      }
      await new Promise(resolve =>
        globalThis.setTimeout(resolve, PROJECT_OPERATION_STATUS_POLL_MS)
      );
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
        init.signal?.throwIfAborted();
        return await this.request<T>(
          path,
          {
            ...init,
            signal: init.signal
              ? AbortSignal.any([init.signal, AbortSignal.timeout(timeoutMs)])
              : AbortSignal.timeout(timeoutMs),
          },
          timeoutMs
        );
      } catch (error) {
        if (init.signal?.aborted) throw error;
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
        signal: init.signal
          ? AbortSignal.any([init.signal, timeoutController.signal])
          : timeoutController.signal,
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
