import type { DecodedProjectSnapshotWire } from '@shared/projectSnapshotWire';

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

export const PROJECT_SYNC_ERROR_MESSAGE =
  'Sincronizzazione server non disponibile. Verifica che il backend sia acceso e raggiungibile.';
export const PROJECT_REVISION_CONFLICT_MESSAGE =
  "Il progetto è stato modificato in un'altra sessione. Ricaricalo prima di salvare.";
export const PROJECT_COVER_REVISION_CONFLICT_MESSAGE =
  'Il corso è cambiato prima del salvataggio della cover.';
export const PROJECT_SOURCE_ARCHIVE_CHANGED_MESSAGE =
  'L’archivio sorgente è cambiato. Ricarica il progetto e riprova.';
export const PROJECT_REQUEST_TOO_LARGE_MESSAGE =
  'La richiesta supera il limite di dimensione del server (HTTP 413).';
export const REMOTE_PROJECT_DELETED_MESSAGE = 'Questo corso è stato cancellato';

export class ProjectStorageError extends Error {
  code:
    | 'persistence-failed'
    | 'project-deleted'
    | 'cover-revision-conflict'
    | 'quota-exceeded'
    | 'revision-conflict'
    | 'source-archive-changed'
    | 'source-archive-unusable'
    | 'unknown';
  readonly httpStatus?: number;
  readonly responseContentType?: string;
  readonly sourceWarnings?: ProjectSourceWarning[];

  constructor(
    message: string,
    code: ProjectStorageError['code'] = 'unknown',
    response?: {
      contentType?: string;
      sourceWarnings?: ProjectSourceWarning[];
      status?: number;
    }
  ) {
    super(message);
    this.name = 'ProjectStorageError';
    this.code = code;
    this.httpStatus = response?.status;
    this.responseContentType = response?.contentType;
    this.sourceWarnings = response?.sourceWarnings;
  }
}

export interface ProjectSaveResult {
  meta: SavedProjectMeta;
  snapshot: ProjectSnapshot;
}

export interface ProjectSnapshotWithRevision {
  revision: number;
  snapshot: ProjectSnapshot;
}

export interface ProjectSaveOptions extends ProjectWriteOptions {
  archiveFile?: File;
}

export interface ProjectRepository {
  createFolder: (args: { name: string; parentFolderId?: string | null }) => Promise<LibraryFolder>;
  deleteFolder: (folderId: string) => Promise<void>;
  listFolders: () => Promise<LibraryFolder[]>;
  listPlacements: () => Promise<LibraryPlacement[]>;
  listProjects: () => Promise<SavedProjectMeta[]>;
  loadProject: (id: ProjectId) => Promise<ProjectSnapshot | null>;
  loadProjectWithRevision: (id: ProjectId) => Promise<ProjectSnapshotWithRevision | null>;
  loadProjectCover: (id: ProjectId) => Promise<FileData | null>;
  loadProjectSource: (id: ProjectId) => Promise<FileData | null>;
  loadProjectSourceById: (id: ProjectId, sourceId: string) => Promise<FileData | null>;
  loadProjectSources: (id: ProjectId) => Promise<StoredProjectSourceFile[]>;
  loadProjectsById: (ids: ProjectId[]) => Promise<ProjectSnapshot[]>;
  moveFolder: (
    folderId: string,
    parentFolderId: string | null,
    targetIndex?: number
  ) => Promise<LibraryFolder | null>;
  moveProjects: (
    projectIds: ProjectId[],
    folderId: string | null,
    targetIndex?: number
  ) => Promise<LibraryPlacement[]>;
  renameFolder: (folderId: string, name: string) => Promise<LibraryFolder | null>;
  saveProject: (
    snapshot: ProjectSnapshot,
    options?: ProjectSaveOptions
  ) => Promise<ProjectSaveResult>;
  saveProjectCover: (id: ProjectId, cover: FileData) => Promise<void>;
  setProjectFavorite: (id: ProjectId, isFavorite: boolean) => Promise<SavedProjectMeta>;
  patchProject: (
    id: ProjectId,
    patch: ProjectPatch,
    options?: ProjectWriteOptions
  ) => Promise<SavedProjectMeta>;
  subscribeToProjectRevisions: (
    listener: (event: ProjectRevisionEvent) => void,
    requestCatchUp: () => void
  ) => () => void;
  deleteProject: (id: ProjectId) => Promise<void>;
  importProject: (data: unknown) => Promise<{ meta: SavedProjectMeta; snapshot: ProjectSnapshot }>;
  importProjectArchive: (
    archive: Blob,
    targetProjectId: ProjectId
  ) => Promise<{ meta: SavedProjectMeta; snapshot: ProjectSnapshot }>;
  exportProject: (id: ProjectId) => Promise<DecodedProjectSnapshotWire | null>;
  touchProject: (id: ProjectId) => Promise<void>;
}
