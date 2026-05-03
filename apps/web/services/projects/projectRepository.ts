import type {
  LibraryFolder,
  LibraryPlacement,
  ProjectExportData,
  ProjectId,
  ProjectSnapshot,
  SavedProjectMeta,
} from '../../types';

export class ProjectStorageError extends Error {
  code: 'quota-exceeded' | 'persistence-failed' | 'unknown';

  constructor(message: string, code: ProjectStorageError['code'] = 'unknown') {
    super(message);
    this.name = 'ProjectStorageError';
    this.code = code;
  }
}

export interface ProjectRepository {
  createFolder: (args: { name: string; parentFolderId?: string | null }) => Promise<LibraryFolder>;
  deleteFolder: (folderId: string) => Promise<void>;
  listFolders: () => Promise<LibraryFolder[]>;
  listPlacements: () => Promise<LibraryPlacement[]>;
  listProjects: () => Promise<SavedProjectMeta[]>;
  loadProject: (id: ProjectId) => Promise<ProjectSnapshot | null>;
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
  saveProject: (snapshot: ProjectSnapshot) => Promise<SavedProjectMeta>;
  patchProject: (id: ProjectId, patch: Record<string, unknown>) => Promise<SavedProjectMeta>;
  deleteProject: (id: ProjectId) => Promise<void>;
  importProject: (data: unknown) => Promise<{ meta: SavedProjectMeta; snapshot: ProjectSnapshot }>;
  exportProject: (id: ProjectId) => Promise<ProjectExportData | null>;
  touchProject: (id: ProjectId) => Promise<void>;
}
