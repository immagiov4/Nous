// Project storage types shared across backend persistence modules.
export type {
  LibraryFolder,
  LibraryPlacement,
  ProjectId,
  ProjectPatch,
  ProjectSourceKind,
  ProjectSyncState,
  SavedProjectMeta,
  SectionPatch,
} from '@shared/projectContract';

import type {
  LibraryFolder,
  LibraryPlacement,
  ProjectId,
  ProjectPatch,
  ProjectSourceKind,
  SavedProjectMeta,
} from '@shared/projectContract';

export interface LearningPlanNodeSnapshot {
  id?: string;
  kind?: string;
  isCompleted?: boolean;
  [key: string]: unknown;
}

export interface LearningPlanModuleSnapshot {
  id?: string;
  title?: string;
  children?: LearningPlanNodeSnapshot[];
  [key: string]: unknown;
}

export interface LearningPlanSnapshot {
  title?: string;
  summary?: string;
  sections?: LearningPlanNodeSnapshot[];
  modules?: LearningPlanModuleSnapshot[];
  [key: string]: unknown;
}

// Wire/storage shape of a project. The frontend has its own strictly typed
// ProjectSnapshot in apps/web/types.ts that models the rich domain (LearningPlan,
// ProjectSource, PdfDocumentAssets). The backend treats the same payload as
// permissive JSON it shuttles to and from SQLite. The two intentionally diverge.
export interface ProjectSnapshot {
  id: ProjectId;
  version: string;
  sourceKind?: ProjectSourceKind;
  state?: string;
  source?: unknown;
  learningPlan?: LearningPlanSnapshot | null;
  isLearnMode?: boolean;
  userProfile?: {
    topic?: string;
  } | null;
  syllabus?: unknown[];
  researchCoursePlan?: unknown | null;
  researchDossiersBySectionId?: Record<string, unknown>;
  activeSectionId?: string | null;
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
