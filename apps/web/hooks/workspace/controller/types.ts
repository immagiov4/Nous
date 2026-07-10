import type { ProjectRepositoryMode } from '../../../services/projects/projectRepositoryFactory.ts';
import type {
  WorkspaceWorkflowId,
  WorkspaceWorkflowState,
} from '../../../services/workspace/workflow.ts';
import type {
  ApplicationExerciseNode,
  AppState,
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
  QuizQuestion,
  ResearchCoursePlan,
  ResearchDossiersBySectionId,
  ResearchLessonDossier,
  SavedProjectMeta,
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
  textSource?: TextSourceInput | null;
}

export interface WorkspaceChatSession {
  sendMessage: (params: { message: string }) => Promise<{
    text: string;
    functionCalls?: Array<{ name: string; args: unknown }>;
  }>;
}

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
  createFolder: (args: { name: string; parentFolderId?: string | null }) => Promise<LibraryFolder>;
  currentProjectId: string | null;
  deleteStoredProject: (projectId: string) => Promise<void>;
  deleteFolder: (folderId: string) => Promise<void>;
  downloadProject: (projectId?: string) => Promise<void>;
  importProjectData: (
    data: unknown
  ) => Promise<{ meta: SavedProjectMeta; snapshot: ProjectSnapshot }>;
  isLibraryLoading: boolean;
  libraryFolders: LibraryFolder[];
  libraryPlacements: LibraryPlacement[];
  libraryTree: LibraryTree;
  loadProjectsById: (ids: string[]) => Promise<ProjectSnapshot[]>;
  loadStoredProject: (projectId: string) => Promise<ProjectSnapshot | null>;
  loadStoredProjectSource: (projectId: string) => Promise<FileData | null>;
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
  projectRepositoryMode: ProjectRepositoryMode;
  persistSnapshot: (snapshot: ProjectSnapshot) => Promise<SavedProjectMeta | null>;
  refreshLibraryOrganization: () => Promise<void>;
  refreshLibraryState: () => Promise<void>;
  refreshSavedProjects: () => Promise<void>;
  renameFolder: (folderId: string, name: string) => Promise<LibraryFolder | null>;
  saveCurrentProject: (overrides?: Partial<ProjectSnapshot>) => Promise<SavedProjectMeta | null>;
  patchCurrentProject: (overrides?: Partial<ProjectSnapshot>) => Promise<SavedProjectMeta | null>;
  patchSectionAnnotations: (
    sectionId: string,
    annotations: unknown,
    content?: string,
    generatedVisuals?: LessonNode['generatedVisuals']
  ) => Promise<void>;
  patchSectionLessonContent: (
    sectionId: string,
    patch: Partial<
      Pick<LessonNode, 'content' | 'generatedVisuals' | 'imageRefs' | 'learningAids' | 'quiz'>
    >
  ) => Promise<void>;
  savedProjects: SavedProjectMeta[];
  setCurrentProjectId: (projectId: string | null) => void;
  setProjectHydrated: (value: boolean) => void;
  storageError: string | null;
  touchStoredProject: (projectId: string) => Promise<void>;
}

export interface WorkspaceControllerStateAdapter {
  beginWorkflow: (workflowId: WorkspaceWorkflowId, message?: string) => number;
  failWorkflow: (workflowId: WorkspaceWorkflowId, requestId: number, errorMessage: string) => void;
  getAssessmentMessages: () => Message[];
  getChatSession: () => WorkspaceChatSession | null;
  getOpeningProjectId: () => string | null;
  getWorkflowState: () => WorkspaceWorkflowState;
  invalidateWorkflows: (workflowIds: WorkspaceWorkflowId[]) => void;
  isWorkflowCurrent: (workflowId: WorkspaceWorkflowId, requestId: number) => boolean;
  resetSessionState: () => void;
  setAssessmentMessages: (
    nextMessages: Message[] | ((previousMessages: Message[]) => Message[])
  ) => void;
  setChatSession: (chatSession: WorkspaceChatSession | null) => void;
  setOpeningProjectId: (projectId: string | null) => void;
  setScreenState: (screenState: AppState) => void;
  setGeneratingSectionId: (sectionId: string | null) => void;
  setWorkflowMessage: (workflowId: WorkspaceWorkflowId, requestId: number, message: string) => void;
  setWorkflowReasoning: (
    workflowId: WorkspaceWorkflowId,
    requestId: number,
    reasoning: string
  ) => void;
  succeedWorkflow: (workflowId: WorkspaceWorkflowId, requestId: number, message?: string) => void;
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
  | 'reused-cached'
  | 'blocked-missing-source'
  | 'ignored-busy';

export type CreateLessonOutcome = 'created' | 'blocked-missing-source' | 'failed';
export type CompleteSectionOutcome = 'opened-next' | 'journey-complete' | 'noop';
export type AdvanceSectionOutcome = 'opened-next' | 'journey-complete' | 'noop';

export interface OpenSectionOptions {
  allowWhileBlocking?: boolean;
  currentDocumentAssets?: PdfDocumentAssets | null;
  currentDocumentIndex?: PdfTextIndex | null;
  currentPlan?: LearningPlan | null;
  currentResearchCoursePlan?: ResearchCoursePlan | null;
  currentResearchDossiersBySectionId?: ResearchDossiersBySectionId;
  currentSourceFile?: FileData | null;
  currentSyllabus?: SyllabusItem[];
  currentUserProfile?: UserProfile | null;
  forceRegenerate?: boolean;
  isLearnMode?: boolean;
}

export interface WorkspaceControllerContext {
  domain: WorkspaceDomainControllerAdapter;
  openRouter: OpenRouterServiceModule;
  persistHydratedSnapshot: (snapshot: ProjectSnapshot) => void;
  preparePdfLessonPlan: (
    sourceFile: FileData | null,
    plan: LearningPlan,
    existingIndex?: PdfTextIndex | null,
    sectionIds?: string[]
  ) => Promise<{ learningPlan: LearningPlan; documentIndex: PdfTextIndex | null }>;
  projectLibrary: WorkspaceProjectLibraryAdapter;
  scheduleHydration: (callback: () => void) => void;
  sleep: (ms: number) => Promise<void>;
  state: WorkspaceControllerStateAdapter;
  stopAudio: (reset?: boolean) => void;
}

export interface WorkspaceControllerCommands {
  askContextQuestion: (args: {
    contextAfter?: string;
    contextBefore?: string;
    question: string;
    selectedText: string;
  }) => Promise<{ answer?: string; errorMessage?: string }>;
  advanceActiveSection: () => Promise<AdvanceSectionOutcome>;
  completeActiveSection: () => Promise<CompleteSectionOutcome>;
  createLessonFromSelection: (args: {
    instructions: string;
    selectedText: string;
  }) => Promise<{ errorMessage?: string; outcome: CreateLessonOutcome }>;
  deleteProject: (projectId: string) => Promise<void>;
  exportProject: (projectId?: string) => Promise<void>;
  goToLibrary: () => Promise<void>;
  handleSourceUpload: (
    selectedFile: File,
    options?: { mode?: 'new-project' | 'reattach-source' }
  ) => Promise<{
    errorMessage?: string;
    outcome: 'imported' | 'started-assessment' | 'reattached';
  }>;
  importProjectFile: (
    selectedFile: File
  ) => Promise<{ errorMessage?: string; outcome: 'failed' | 'imported' }>;
  openProject: (
    projectId: string
  ) => Promise<{ errorMessage?: string; outcome: 'failed' | 'missing' | 'opened' | 'stale' }>;
  attachExerciseFiles: (exerciseId: string, attachments: ExerciseAttachment[]) => Promise<void>;
  openExercise: (exercise: ApplicationExerciseNode) => Promise<void>;
  openSection: (section: LessonNode, options?: OpenSectionOptions) => Promise<OpenSectionOutcome>;
  repairApplicationExercises: () => Promise<{ outcome: 'noop' | 'repaired' }>;
  regenerateActiveSection: () => Promise<OpenSectionOutcome>;
  confirmPlanGeneration: () => Promise<{ errorMessage?: string; outcome: 'failed' | 'planned' }>;
  startHomeChat: (args: {
    input: string;
    selectedFile?: File | null;
    toolPreferences?: HomeChatToolPreferences;
  }) => Promise<{
    errorMessage?: string;
    outcome: 'assessment-complete' | 'continued' | 'failed' | 'imported' | 'noop' | 'planned';
  }>;
  startLearnJourney: () => Promise<{ errorMessage?: string; outcome: 'failed' | 'started' }>;
  submitAssessment: (
    input: string,
    toolPreferences?: HomeChatToolPreferences
  ) => Promise<{
    errorMessage?: string;
    outcome: 'assessment-complete' | 'continued' | 'failed' | 'noop' | 'planned';
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
