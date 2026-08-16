// Project storage types shared across backend persistence modules.
export type {
  LibraryFolder,
  LibraryPlacement,
  ProjectId,
  ProjectPatch,
  ProjectRevisionEvent,
  ProjectSourceKind,
  ProjectWriteOptions,
  SavedProjectMeta,
  SectionPatch,
} from '@shared/projectContract';

import type { ProjectAssetRef } from '@shared/projectAsset';
import type {
  LibraryFolder,
  LibraryPlacement,
  ProjectId,
  ProjectPatch,
  ProjectSourceKind,
  ProjectWriteOptions,
  SavedProjectMeta,
} from '@shared/projectContract';
import type { ProjectSnapshotFormatVersion } from '@shared/projectSnapshotWire';
import type { SourceArchivePdfWarningReason } from '@shared/sourceArchiveWarnings';

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
// permissive JSON persisted by the store. The two intentionally diverge.
export interface ProjectSnapshot {
  id: ProjectId;
  projectFormatVersion?: ProjectSnapshotFormatVersion;
  version: string;
  title?: string;
  sourceKind?: ProjectSourceKind;
  state?: string;
  source?: unknown;
  learningPlan?: LearningPlanSnapshot | null;
  musicUrl?: string;
  isLearnMode?: boolean;
  userProfile?: {
    language?: string;
    topic?: string;
  } | null;
  syllabus?: unknown[];
  researchCoursePlan?: unknown | null;
  researchDossiersBySectionId?: Record<string, unknown>;
  lastCourseGenerationRunId?: string | null;
  activeSectionId?: string | null;
  createdAt: string;
  updatedAt: string;
  lastOpenedAt: string;
  legacyUnmappedFields?: Record<string, unknown>;
  documentAssets?: unknown;
  documentIndex?: unknown;
  extensions?: Record<string, unknown>;
}

export interface ProjectSourceFile {
  data: string;
  mimeType: string;
  name: string;
  sourceId?: string;
}

export type ProjectCoverFile = ProjectSourceFile;

export interface ProjectCoverWriteOptions {
  expectedRevision?: number;
}

export interface ProjectSourceRef {
  byteSize: number;
  hash: string;
  id: string;
  mimeType: string;
  name: string;
  objectPath: string;
}

export interface ProjectSourceUpload {
  file: ProjectSourceFile;
  id: string;
  position: number;
}

export interface StoredProjectSourceFile {
  file: ProjectSourceFile;
  ref: ProjectSourceRef;
}

export interface ProjectSourceArchiveDirectoryEntry {
  kind: 'directory';
  path: string;
}

export interface ProjectSourceArchiveFileEntry {
  byteSize: number;
  contentKind: 'binary' | 'text';
  hash: string;
  kind: 'file';
  path: string;
  preview?: string;
  warningReason?: SourceArchivePdfWarningReason;
}

export type ProjectSourceArchiveEntry =
  | ProjectSourceArchiveDirectoryEntry
  | ProjectSourceArchiveFileEntry;

export interface ProjectSourceArchiveVersion {
  representationHash: string;
  sourceHash: string;
  sourceId: string;
}

export interface ProjectSourceArchiveIndex {
  entries: ProjectSourceArchiveEntry[];
  version: ProjectSourceArchiveVersion;
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
  importedAssets?: readonly ImportedProjectAssetDescriptor[];
  importedCover?: ProjectCoverFile;
  sourceFile?: {
    bytes: Uint8Array;
    mimeType: string;
    name: string;
  };
}

export interface ImportedProjectAssetDescriptor extends ProjectAssetRef {
  idempotencyKey: string;
  objectPath: string;
}

export interface ProjectImportDiagnosticInput {
  code: string;
  correlationId: string;
  fileBytes?: number;
  limitBytes?: number;
  projectCount?: number;
  projectIndex?: number;
  stage: string;
}

export interface ProjectImportDiagnostic extends ProjectImportDiagnosticInput {
  createdAt: string;
  id: number;
  userId: string;
}

export interface ProjectStore {
  createFolder: (
    userId: string,
    args: { name: string; parentFolderId?: string | null }
  ) => Promise<LibraryFolder>;
  deleteFolder: (userId: string, folderId: string) => Promise<void>;
  deleteProject: (userId: string, id: ProjectId) => Promise<void>;
  exportProject: (userId: string, id: ProjectId) => Promise<ProjectSnapshot | null>;
  importProject: (
    userId: string,
    data: unknown
  ) => Promise<{ meta: SavedProjectMeta; snapshot: ProjectSnapshot }>;
  importProjectArchive: (
    userId: string,
    bytes: Uint8Array,
    targetProjectId: ProjectId
  ) => Promise<{ meta: SavedProjectMeta; snapshot: ProjectSnapshot }>;
  listFolders: (userId: string) => Promise<LibraryFolder[]>;
  listPlacements: (userId: string) => Promise<LibraryPlacement[]>;
  listProjects: (userId: string) => Promise<SavedProjectMeta[]>;
  listProjectImportDiagnostics: (correlationId?: string) => Promise<ProjectImportDiagnostic[]>;
  loadProject: (userId: string, id: ProjectId) => Promise<ProjectSnapshot | null>;
  loadProjectWithRevision: (
    userId: string,
    id: ProjectId
  ) => Promise<ProjectSnapshotWithRevision | null>;
  loadProjectCover: (userId: string, id: ProjectId) => Promise<ProjectCoverFile | null>;
  loadProjectSource: (userId: string, id: ProjectId) => Promise<ProjectSourceFile | null>;
  loadProjectSourceById: (
    userId: string,
    id: ProjectId,
    sourceId: string
  ) => Promise<ProjectSourceFile | null>;
  loadProjectSources: (userId: string, id: ProjectId) => Promise<StoredProjectSourceFile[]>;
  loadProjectSourceArchiveEntry: (
    userId: string,
    id: ProjectId,
    path: string,
    version: ProjectSourceArchiveVersion
  ) => Promise<Uint8Array | null>;
  loadProjectSourceArchiveEntryRange: (
    userId: string,
    id: ProjectId,
    path: string,
    version: ProjectSourceArchiveVersion,
    start: number,
    endExclusive: number
  ) => Promise<Uint8Array | null>;
  loadProjectSourceArchiveIndex: (
    userId: string,
    id: ProjectId
  ) => Promise<ProjectSourceArchiveIndex | null>;
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
  recordProjectImportDiagnostic: (
    userId: string,
    diagnostic: ProjectImportDiagnosticInput
  ) => Promise<void>;
  saveProject: (
    userId: string,
    snapshot: ProjectSnapshot,
    options?: ProjectSaveOptions
  ) => Promise<ProjectSaveResult>;
  saveProjectCover: (
    userId: string,
    id: ProjectId,
    cover: ProjectCoverFile,
    options?: ProjectCoverWriteOptions
  ) => Promise<boolean>;
  patchProject: (
    userId: string,
    id: ProjectId,
    patch: ProjectPatch,
    options?: ProjectWriteOptions
  ) => Promise<SavedProjectMeta>;
  setProjectFavorite: (
    userId: string,
    id: ProjectId,
    isFavorite: boolean
  ) => Promise<SavedProjectMeta>;
  touchProject: (userId: string, id: ProjectId) => Promise<void>;
}
