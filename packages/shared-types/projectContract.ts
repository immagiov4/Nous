import type { LessonInstructionPackId } from './lessonInstructionPacks';

// Contract types shared between the frontend (apps/web) and the backend
// (apps/backend). These shapes travel over the network and through the
// repository / store interfaces. They are intentionally permissive where the
// rich domain model lives only on the frontend.
//
// What is shared:
//   - Identifier and enum aliases (ProjectId, ProjectSourceKind)
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
  isFavorite?: boolean;
  /** Monotonic server-side version used for optimistic concurrency and cross-session sync. */
  revision?: number;
}

export interface ProjectRevisionEvent {
  deleted?: boolean;
  projectId: ProjectId;
  revision: number;
}

export const PROJECT_REVISION_RESYNC_EVENT = 'project-revision-resync';

export const PROJECT_API_ERROR_CODE = {
  coverRevisionConflict: 'project_cover_revision_conflict',
  revisionConflict: 'project_revision_conflict',
  sourceArchiveChanged: 'project_source_archive_changed',
  sourceArchiveUnusable: 'project_source_archive_unusable',
} as const;

export const PROJECT_PATCH_REBASE_MODE = {
  navigation: 'navigation',
} as const;

export type ProjectPatchRebaseMode =
  (typeof PROJECT_PATCH_REBASE_MODE)[keyof typeof PROJECT_PATCH_REBASE_MODE];

export interface ProjectWriteOptions {
  expectedRevision?: number;
  rebaseMode?: ProjectPatchRebaseMode;
}

export interface SectionPatch {
  sectionId: string;
  annotations?: unknown[];
  content?: string | null;
  contentBlocks?: unknown[] | null;
  generationWarnings?: unknown[] | null;
  generatedVisuals?: unknown[] | null;
  imageRefs?: unknown[] | null;
  isCompleted?: boolean;
  instructionPacks?: LessonInstructionPackId[];
  learningAids?: unknown[] | null;
  lastGenerationRunId?: string | null;
  quiz?: unknown[] | null;
  visualPlanningDecision?: unknown;
}

export interface ProjectPatch {
  title?: string;
  activeSectionId?: string | null;
  state?: string;
  isLearnMode?: boolean;
  learningPlan?: Record<string, unknown> | null;
  userProfile?: Record<string, unknown> | null;
  syllabus?: unknown[];
  researchCoursePlan?: Record<string, unknown> | null;
  researchDossiersBySectionId?: Record<string, unknown>;
  /** Internal ownership marker for an atomic course-generation commit. */
  lastCourseGenerationRunId?: string | null;
  documentAssets?: Record<string, unknown> | null;
  documentIndex?: Record<string, unknown> | null;
  section?: SectionPatch;
  updatedAt?: string;
}
