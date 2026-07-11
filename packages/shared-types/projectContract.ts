// Contract types shared between the frontend (apps/web) and the backend
// (apps/backend). These shapes travel over the network and through the
// repository / store interfaces. They are intentionally permissive where the
// rich domain model lives only on the frontend.
//
// What is shared:
//   - Identifier and enum aliases (ProjectId, ProjectSourceKind, ProjectSyncState)
//   - Library tree wire shapes (LibraryFolder, LibraryPlacement)
//   - Project listing wire shape (SavedProjectMeta)
//   - The PATCH contract used by the repository / store (ProjectPatch, SectionPatch)
//
// What is NOT shared:
//   - ProjectSnapshot. The frontend models it strictly with rich domain types
//     (LearningPlan, ProjectSource, PdfDocumentAssets, …). The backend treats
//     it as a wire/JSON shape with permissive fields. The two definitions
//     diverge by design; sharing them would either force the backend to
//     depend on frontend domain types or weaken the frontend domain model.

export type ProjectId = string;

export type ProjectSourceKind = 'document' | 'codebase' | 'learn-mode' | 'imported-json';

export type ProjectSyncState = 'local-only' | 'sync-ready' | 'sync-error';

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

export interface SavedProjectMeta {
  id: ProjectId;
  title: string;
  sourceKind: ProjectSourceKind;
  createdAt: string;
  updatedAt: string;
  lastOpenedAt: string;
  lessonCount: number;
  completedCount: number;
  exerciseCount: number;
  completedExercises: number;
  hasSourceFile: boolean;
  coverLabel: string;
  /** Monotonic server-side version used for optimistic concurrency and cross-session sync. */
  revision?: number;
  syncState: ProjectSyncState;
}

export interface ProjectRevisionEvent {
  deleted?: boolean;
  projectId: ProjectId;
  revision: number;
}

export interface ProjectWriteOptions {
  expectedRevision?: number;
}

export interface SectionPatch {
  sectionId: string;
  annotations?: unknown[];
  content?: string;
  generatedVisuals?: unknown[];
  imageRefs?: unknown[];
  isCompleted?: boolean;
  learningAids?: unknown[];
  quiz?: unknown[];
}

export interface ProjectPatch {
  activeSectionId?: string | null;
  state?: string;
  isLearnMode?: boolean;
  learningPlan?: Record<string, unknown> | null;
  userProfile?: Record<string, unknown> | null;
  syllabus?: unknown[];
  researchCoursePlan?: Record<string, unknown> | null;
  researchDossiersBySectionId?: Record<string, unknown>;
  documentAssets?: Record<string, unknown> | null;
  documentIndex?: Record<string, unknown> | null;
  source?: unknown;
  section?: SectionPatch;
  updatedAt?: string;
}
