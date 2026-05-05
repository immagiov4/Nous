export type ProjectId = string;
export type ProjectSourceKind = 'document' | 'codebase' | 'learn-mode' | 'imported-json';
export type ProjectSyncState = 'local-only' | 'sync-ready' | 'sync-error';

export interface SavedProjectMeta {
  id: ProjectId;
  title: string;
  sourceKind: ProjectSourceKind;
  createdAt: string;
  updatedAt: string;
  lastOpenedAt: string;
  lessonCount: number;
  completedCount: number;
  hasSourceFile: boolean;
  coverLabel: string;
  syncState: ProjectSyncState;
}

export interface LibraryFolder {
  id: string;
  name: string;
  parentFolderId: string | null;
  createdAt: string;
  updatedAt: string;
  order: number;
}

export interface LibraryPlacement {
  projectId: ProjectId;
  folderId: string | null;
  order: number;
  updatedAt: string;
}

export interface ProjectSnapshot {
  id: ProjectId;
  version: string;
  sourceKind?: ProjectSourceKind;
  state?: string;
  source?: unknown;
  learningPlan?: {
    title?: string;
    sections?: Array<{
      isCompleted?: boolean;
    }>;
  } | null;
  laboratory?: {
    title?: string;
    exercises?: unknown[];
  } | null;
  isLearnMode?: boolean;
  userProfile?: {
    topic?: string;
  } | null;
  syllabus?: unknown[];
  activeSectionId?: string | null;
  activeLaboratoryExerciseId?: string | null;
  createdAt: string;
  updatedAt: string;
  lastOpenedAt: string;
  documentAssets?: unknown;
  documentIndex?: unknown;
}

export interface ProjectExportData extends ProjectSnapshot {
  musicUrl?: string;
}

export interface ProjectStore {
  createFolder: (
    userId: string,
    args: { name: string; parentFolderId?: string | null }
  ) => Promise<LibraryFolder>;
  deleteFolder: (userId: string, folderId: string) => Promise<void>;
  deleteProject: (userId: string, id: ProjectId) => Promise<void>;
  exportProject: (userId: string, id: ProjectId) => Promise<ProjectExportData | null>;
  getConfig: () => { driver: 'sqlite'; isLanSyncEnabled: boolean };
  importProject: (
    userId: string,
    data: unknown
  ) => Promise<{ meta: SavedProjectMeta; snapshot: ProjectSnapshot }>;
  listFolders: (userId: string) => Promise<LibraryFolder[]>;
  listPlacements: (userId: string) => Promise<LibraryPlacement[]>;
  listProjects: (userId: string) => Promise<SavedProjectMeta[]>;
  loadProject: (userId: string, id: ProjectId) => Promise<ProjectSnapshot | null>;
  loadProjectsById: (userId: string, ids: ProjectId[]) => Promise<ProjectSnapshot[]>;
  moveFolder: (
    userId: string,
    folderId: string,
    parentFolderId: string | null,
    targetIndex?: number
  ) => Promise<LibraryFolder | null>;
  moveProjects: (
    userId: string,
    projectIds: ProjectId[],
    folderId: string | null,
    targetIndex?: number
  ) => Promise<LibraryPlacement[]>;
  renameFolder: (userId: string, folderId: string, name: string) => Promise<LibraryFolder | null>;
  saveProject: (userId: string, snapshot: ProjectSnapshot) => Promise<SavedProjectMeta>;
  patchProject: (userId: string, id: ProjectId, patch: ProjectPatch) => Promise<SavedProjectMeta>;
  touchProject: (userId: string, id: ProjectId) => Promise<void>;
}

export interface SectionPatch {
  sectionId: string;
  annotations?: unknown[];
  content?: string;
  generatedVisuals?: unknown[];
  imageRefs?: unknown[];
  isCompleted?: boolean;
  quiz?: unknown[];
}

export interface ProjectPatch {
  activeSectionId?: string | null;
  activeLaboratoryExerciseId?: string | null;
  state?: string;
  isLearnMode?: boolean;
  learningPlan?: Record<string, unknown> | null;
  laboratory?: Record<string, unknown> | null;
  userProfile?: Record<string, unknown> | null;
  syllabus?: unknown[];
  documentAssets?: Record<string, unknown> | null;
  documentIndex?: Record<string, unknown> | null;
  source?: unknown;
  section?: SectionPatch;
  updatedAt?: string;
}
