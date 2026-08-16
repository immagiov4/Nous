import type { GenerationProgressSnapshot } from '../../../services/openrouter/generationProgress.ts';
import type {
  ProjectSaveResult,
  ProjectSnapshotWithRevision,
} from '../../../services/projects/projectRepository.ts';
import type {
  WorkspaceWorkflowId,
  WorkspaceWorkflowState,
} from '../../../services/workspace/workflow.ts';
import type {
  ApplicationExerciseNode,
  AppState,
  CourseSourceDescriptor,
  ExerciseAttachment,
  FileData,
  HomeChatToolPreferences,
  LearningPlan,
  LessonNode,
  LibraryFolder,
  LibraryPlacement,
  LibraryTree,
  Message,
  PdfDocumentAssets,
  PdfTextIndex,
  ProjectSnapshot,
  ProjectSource,
  ProjectSourceWarning,
  QuizQuestion,
  ResearchCoursePlan,
  ResearchDossiersBySectionId,
  ResearchLessonDossier,
  SavedProjectMeta,
  StoredProjectSourceFile,
  SyllabusItem,
  UserProfile,
  WorkspaceDomainState,
} from '../../../types.ts';

type OpenRouterServiceModule = typeof import('../../../services/openrouter/index.ts');

export interface TextSourceInput {
  name: string;
  text: string;
}

export interface AssessmentSourceInput {
  file?: FileData | null;
  sources?: CourseSourceDescriptor[];
  textSource?: TextSourceInput | null;
}

export type WorkspaceGenerationKind = 'exercise' | 'lesson';

export interface WorkspaceDomainControllerAdapter {
  activeSection: LessonNode | null;
  activeSectionId: string | null;
  documentAssets: PdfDocumentAssets | null;
  documentIndex: PdfTextIndex | null;
  domainState: WorkspaceDomainState;
  file: FileData | null;
  generationNotes: string;
  hydrateSnapshot: (snapshot: ProjectSnapshot) => void;
  isLearnMode: boolean;
  learningPlan: LearningPlan | null;
  musicUrl: string;
  needsSourceFile: boolean;
  quiz: QuizQuestion[];
  researchCoursePlan: ResearchCoursePlan | null;
  researchDossiersBySectionId: ResearchDossiersBySectionId;
  resetDomain: () => void;
  sectionContent: string;
  setActiveSectionId: (sectionId: string | null) => void;
  setDocumentAssets: (documentAssets: PdfDocumentAssets | null) => void;
  setDocumentIndex: (documentIndex: PdfTextIndex | null) => void;
  setGenerationNotes: (notes: string) => void;
  setIsLearnMode: (isLearnMode: boolean) => void;
  setLearningPlan: (learningPlan: LearningPlan | null) => void;
  setMusicUrl: (musicUrl: string) => void;
  setResearchCoursePlan: (researchCoursePlan: ResearchCoursePlan | null) => void;
  setResearchDossiers: (dossiers: ResearchDossiersBySectionId) => void;
  setResearchLessonDossier: (dossier: ResearchLessonDossier) => void;
  setSource: (source: ProjectSource | null) => void;
  setSyllabus: (syllabus: SyllabusItem[]) => void;
  setUserProfile: (userProfile: UserProfile | null) => void;
  source: ProjectSource | null;
  syllabus: SyllabusItem[];
  updateActiveSectionContent: (content: string) => void;
  updateSection: (sectionId: string, updater: (section: LessonNode) => LessonNode) => void;
  userProfile: UserProfile | null;
}

export interface WorkspaceProjectLibraryAdapter {
  applyPersistedProjectRevision: (args: {
    projectId: string;
    revision: number;
  }) => Promise<boolean>;
  completeProjectHydration: (project: ProjectSnapshotWithRevision) => void;
  createFolder: (args: { name: string; parentFolderId?: string | null }) => Promise<LibraryFolder>;
  currentProjectId: string | null;
  getCurrentProjectId: () => string | null;
  deleteStoredProject: (projectId: string) => Promise<void>;
  deleteFolder: (folderId: string) => Promise<void>;
  downloadProject: (projectId?: string) => Promise<void>;
  importProjectData: (
    data: unknown
  ) => Promise<{ meta: SavedProjectMeta; snapshot: ProjectSnapshot }>;
  importProjectArchive: (
    archive: Blob,
    targetProjectId: string
  ) => Promise<{ meta: SavedProjectMeta; snapshot: ProjectSnapshot }>;
  isLibraryLoading: boolean;
  libraryFolders: LibraryFolder[];
  libraryPlacements: LibraryPlacement[];
  libraryTree: LibraryTree;
  loadProjectsById: (ids: string[]) => Promise<ProjectSnapshot[]>;
  loadStoredProject: (projectId: string) => Promise<ProjectSnapshot | null>;
  loadStoredProjectWithRevision: (projectId: string) => Promise<ProjectSnapshotWithRevision | null>;
  validateStoredProjectForOpen: (projectId: string) => Promise<ProjectSnapshotWithRevision | null>;
  loadStoredProjectSource: (projectId: string) => Promise<FileData | null>;
  loadStoredProjectSourceById: (projectId: string, sourceId: string) => Promise<FileData | null>;
  loadStoredProjectSources: (projectId: string) => Promise<StoredProjectSourceFile[]>;
  moveFolder: (
    folderId: string,
    parentFolderId: string | null,
    targetIndex?: number
  ) => Promise<LibraryFolder | null>;
  moveProjects: (
    projectIds: string[],
    folderId: string | null,
    targetIndex?: number
  ) => Promise<LibraryPlacement[]>;
  persistSnapshot: (
    snapshot: ProjectSnapshot,
    options?: { archiveFile?: File; throwOnError?: boolean }
  ) => Promise<ProjectSaveResult | null>;
  refreshLibraryOrganization: () => Promise<void>;
  refreshLibraryState: () => Promise<void>;
  refreshSavedProjects: () => Promise<void>;
  renameFolder: (folderId: string, name: string) => Promise<LibraryFolder | null>;
  saveCurrentProject: (
    overrides?: Partial<ProjectSnapshot>,
    options?: { archiveFile?: File; throwOnError?: boolean }
  ) => Promise<ProjectSaveResult | null>;
  patchCurrentProject: (
    overrides?: Partial<ProjectSnapshot>,
    originatingProjectId?: string | null
  ) => Promise<SavedProjectMeta | null>;
  patchSectionAnnotations: (
    sectionId: string,
    annotations: unknown,
    content?: string,
    generatedVisuals?: LessonNode['generatedVisuals']
  ) => Promise<boolean>;
  patchSectionLessonContent: (
    sectionId: string,
    patch: Partial<
      Pick<
        LessonNode,
        | 'content'
        | 'contentBlocks'
        | 'generationWarnings'
        | 'generatedVisuals'
        | 'imageRefs'
        | 'learningAids'
        | 'quiz'
        | 'visualPlanningDecision'
      >
    >,
    projectPatch?: Partial<ProjectSnapshot>
  ) => Promise<boolean>;
  savedProjects: SavedProjectMeta[];
  setCurrentProjectId: (projectId: string | null) => void;
  setProjectHydrated: (value: boolean) => void;
  storageError: string | null;
  touchStoredProject: (projectId: string) => Promise<void>;
}

export interface WorkspaceControllerStateAdapter {
  beginWorkflow: (workflowId: WorkspaceWorkflowId, message?: string) => number;
  failWorkflow: (workflowId: WorkspaceWorkflowId, requestId: number, errorMessage: string) => void;
  finishGeneration: (projectId: string | null, token: number) => void;
  getAssessmentMessages: () => Message[];
  getCourseProposal: () => UserProfile | null;
  getGeneratingSectionId: (projectId: string | null) => string | null;
  getOpeningProjectId: () => string | null;
  getScreenState: () => AppState;
  getWorkflowState: () => WorkspaceWorkflowState;
  invalidateWorkflows: (workflowIds: WorkspaceWorkflowId[]) => void;
  isGenerationActive: (projectId: string | null) => boolean;
  isLessonGenerationActive: (projectId: string | null) => boolean;
  isWorkflowCurrent: (workflowId: WorkspaceWorkflowId, requestId: number) => boolean;
  resetSessionState: () => void;
  setAssessmentMessages: (
    nextMessages: Message[] | ((previousMessages: Message[]) => Message[])
  ) => void;
  setCourseProposal: (proposal: UserProfile | null) => void;
  setOpeningProjectId: (projectId: string | null) => void;
  setScreenState: (screenState: AppState) => void;
  setGeneratingSectionId: (projectId: string | null, token: number, sectionId: string) => void;
  setMissingSourceProjectId: (projectId: string | null) => void;
  setWorkflowMessage: (workflowId: WorkspaceWorkflowId, requestId: number, message: string) => void;
  setWorkflowReasoning: (
    workflowId: WorkspaceWorkflowId,
    requestId: number,
    reasoning: string
  ) => void;
  setWorkflowProgress: (
    workflowId: WorkspaceWorkflowId,
    requestId: number,
    progress: GenerationProgressSnapshot
  ) => void;
  succeedWorkflow: (workflowId: WorkspaceWorkflowId, requestId: number, message?: string) => void;
  tryBeginGeneration: (projectId: string | null, kind: WorkspaceGenerationKind) => number | null;
}

export interface CreateWorkspaceControllerArgs {
  domain: WorkspaceDomainControllerAdapter;
  openRouter?: OpenRouterServiceModule;
  projectLibrary: WorkspaceProjectLibraryAdapter;
  scheduleHydration?: (callback: () => void) => void;
  sleep?: (ms: number) => Promise<void>;
  state: WorkspaceControllerStateAdapter;
  stopAudio: (reset?: boolean) => void;
}

export type OpenSectionOutcome =
  | 'loaded'
  | 'reopened-generating'
  | 'reused-cached'
  | 'blocked-missing-source'
  | 'ignored-busy';

export type CreateLessonOutcome = 'created' | 'blocked-missing-source' | 'failed' | 'ignored-busy';
export type CompleteSectionOutcome = 'opened-next' | 'journey-complete' | 'noop';
export type AdvanceSectionOutcome = 'opened-next' | 'journey-complete' | 'noop';

export interface OpenSectionOptions {
  allowWhileBlocking?: boolean;
  forceRegenerate?: boolean;
}

export interface OpenProjectOptions {
  activeSectionId?: string;
}

export interface WorkspaceControllerContext {
  domain: WorkspaceDomainControllerAdapter;
  openRouter: OpenRouterServiceModule;
  persistHydratedSnapshot: (snapshot: ProjectSnapshot, revision?: number) => void;
  projectLibrary: WorkspaceProjectLibraryAdapter;
  scheduleHydration: (callback: () => void) => void;
  sleep: (ms: number) => Promise<void>;
  state: WorkspaceControllerStateAdapter;
  stopAudio: (reset?: boolean) => void;
}

export interface WorkspaceControllerCommands {
  cancelAssessment: () => Promise<void>;
  cancelProjectOpen: () => void;
  askContextQuestion: (args: {
    contextAfter?: string;
    contextBefore?: string;
    question: string;
    selectedText: string;
  }) => Promise<{ answer?: string; errorMessage?: string }>;
  advanceActiveSection: () => Promise<AdvanceSectionOutcome>;
  completeActiveSection: () => Promise<CompleteSectionOutcome>;
  createLessonFromSelection: (args: {
    annotationNote?: string;
    contextAfter?: string;
    contextBefore?: string;
    instructions: string;
    selectedText: string;
  }) => Promise<{ errorMessage?: string; outcome: CreateLessonOutcome }>;
  deleteProject: (projectId: string) => Promise<void>;
  exportProject: (projectId?: string) => Promise<void>;
  goToLibrary: () => Promise<void>;
  handleRemoteProjectDeleted: (projectId: string) => void;
  handleSourceUpload: (
    selectedFiles: File | File[],
    options?: { mode?: 'new-project' | 'reattach-source' }
  ) => Promise<{
    errorMessage?: string;
    outcome: 'failed' | 'imported' | 'started-assessment' | 'reattached';
    sourceWarnings?: ProjectSourceWarning[];
  }>;
  importProjectFile: (
    selectedFile: File
  ) => Promise<{ errorMessage?: string; outcome: 'failed' | 'imported' }>;
  openProject: (
    projectId: string,
    options?: OpenProjectOptions
  ) => Promise<{ errorMessage?: string; outcome: 'failed' | 'missing' | 'opened' | 'stale' }>;
  attachExerciseFiles: (exerciseId: string, attachments: ExerciseAttachment[]) => Promise<void>;
  evaluateApplicationExercise: (
    exerciseId: string,
    internalText: string
  ) => Promise<{ errorMessage?: string; outcome: 'evaluated' | 'failed' | 'noop' }>;
  openExercise: (exercise: ApplicationExerciseNode) => Promise<void>;
  openSection: (section: LessonNode, options?: OpenSectionOptions) => Promise<OpenSectionOutcome>;
  repairApplicationExercises: () => Promise<{ outcome: 'noop' | 'repaired' }>;
  regenerateActiveSection: () => Promise<OpenSectionOutcome>;
  confirmPlanGeneration: () => Promise<{ errorMessage?: string; outcome: 'failed' | 'planned' }>;
  startHomeChat: (args: {
    input: string;
    selectedFile?: File | null;
    selectedFiles?: File[];
    toolPreferences?: HomeChatToolPreferences;
  }) => Promise<{
    errorMessage?: string;
    outcome:
      | 'abandoned'
      | 'assessment-complete'
      | 'continued'
      | 'failed'
      | 'imported'
      | 'noop'
      | 'planned';
    sourceWarnings?: ProjectSourceWarning[];
  }>;
  submitAssessment: (
    input: string,
    toolPreferences?: HomeChatToolPreferences
  ) => Promise<{
    errorMessage?: string;
    outcome: 'abandoned' | 'assessment-complete' | 'continued' | 'failed' | 'noop' | 'planned';
    sourceWarnings?: ProjectSourceWarning[];
  }>;
  updateApplicationExercise: (
    exerciseId: string,
    updater: (exercise: ApplicationExerciseNode) => ApplicationExerciseNode
  ) => Promise<void>;
}

export interface UseWorkspaceControllerArgs {
  domain: WorkspaceDomainControllerAdapter;
  openRouter?: OpenRouterServiceModule;
  projectLibrary: WorkspaceProjectLibraryAdapter;
  stopAudio: (reset?: boolean) => void;
}
