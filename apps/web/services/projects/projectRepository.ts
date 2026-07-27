import type {
  FileData,
  LibraryFolder,
  LibraryPlacement,
  ProjectExportData,
  ProjectId,
  ProjectPatch,
  ProjectRevisionEvent,
  ProjectSnapshot,
  ProjectWriteOptions,
  SavedProjectMeta,
  StoredProjectSourceFile,
} from '../../types';

export class ProjectStorageError extends Error {
  code: 'persistence-failed' | 'quota-exceeded' | 'revision-conflict' | 'unknown';

  constructor(message: string, code: ProjectStorageError['code'] = 'unknown') {
    super(message);
    this.name = 'ProjectStorageError';
    this.code = code;
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
    onReconnect: () => void
  ) => () => void;
  deleteProject: (id: ProjectId) => Promise<void>;
  importProject: (data: unknown) => Promise<{ meta: SavedProjectMeta; snapshot: ProjectSnapshot }>;
  exportProject: (id: ProjectId) => Promise<ProjectExportData | null>;
  touchProject: (id: ProjectId) => Promise<void>;
}
