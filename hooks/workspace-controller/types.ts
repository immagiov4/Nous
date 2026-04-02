import type {
  AppState,
  FileData,
  HomeChatToolPreferences,
  LearningPlan,
  LearningSection,
  Message,
  PdfDocumentAssets,
  PdfTextIndex,
  ProjectSnapshot,
  ProjectSource,
  QuizQuestion,
  SavedProjectMeta,
  SyllabusItem,
  UserProfile,
  WorkspaceDomainState,
} from '../../types.ts';
import type {
  WorkspaceWorkflowId,
  WorkspaceWorkflowState,
} from '../../services/workspaceWorkflow.ts';

type GeminiServiceModule = typeof import('../../services/geminiService.ts');

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
  activeSection: LearningSection | null;
  activeSectionId: string | null;
  documentAssets: PdfDocumentAssets | null;
  documentIndex: PdfTextIndex | null;
  domainState: WorkspaceDomainState;
  file: FileData | null;
  hydrateSnapshot: (snapshot: ProjectSnapshot) => void;
  isLearnMode: boolean;
  learningPlan: LearningPlan | null;
  musicUrl: string;
  needsSourceFile: boolean;
  quiz: QuizQuestion[];
  resetDomain: () => void;
  sectionContent: string;
  setActiveSectionId: (sectionId: string | null) => void;
  setDocumentAssets: (documentAssets: PdfDocumentAssets | null) => void;
  setDocumentIndex: (documentIndex: PdfTextIndex | null) => void;
  setIsLearnMode: (isLearnMode: boolean) => void;
  setLearningPlan: (learningPlan: LearningPlan | null) => void;
  setMusicUrl: (musicUrl: string) => void;
  setSource: (source: ProjectSource | null) => void;
  setSyllabus: (syllabus: SyllabusItem[]) => void;
  setUserProfile: (userProfile: UserProfile | null) => void;
  source: ProjectSource | null;
  syllabus: SyllabusItem[];
  updateActiveSectionContent: (content: string) => void;
  updateSection: (
    sectionId: string,
    updater: (section: LearningSection) => LearningSection
  ) => void;
  userProfile: UserProfile | null;
}

export interface WorkspaceProjectLibraryAdapter {
  currentProjectId: string | null;
  deleteStoredProject: (projectId: string) => Promise<void>;
  downloadProject: (projectId?: string) => Promise<void>;
  importProjectData: (data: unknown) => Promise<{ meta: SavedProjectMeta; snapshot: ProjectSnapshot }>;
  isLibraryLoading: boolean;
  loadStoredProject: (projectId: string) => Promise<ProjectSnapshot | null>;
  persistSnapshot: (snapshot: ProjectSnapshot) => Promise<SavedProjectMeta | null>;
  refreshSavedProjects: () => Promise<void>;
  saveCurrentProject: (overrides?: Partial<ProjectSnapshot>) => Promise<SavedProjectMeta | null>;
  savedProjects: SavedProjectMeta[];
  setCurrentProjectId: (projectId: string | null) => void;
  setProjectHydrated: (value: boolean) => void;
  storageError: string | null;
  touchStoredProject: (projectId: string) => Promise<SavedProjectMeta | null>;
}

export interface WorkspaceControllerStateAdapter {
  beginWorkflow: (workflowId: WorkspaceWorkflowId, message?: string) => number;
  failWorkflow: (workflowId: WorkspaceWorkflowId, requestId: number, errorMessage: string) => void;
  getAssessmentMessages: () => Message[];
  getChatSession: () => WorkspaceChatSession | null;
  getWorkflowState: () => WorkspaceWorkflowState;
  invalidateWorkflows: (workflowIds: WorkspaceWorkflowId[]) => void;
  isWorkflowCurrent: (workflowId: WorkspaceWorkflowId, requestId: number) => boolean;
  resetRuntimeState: () => void;
  setAssessmentMessages: (
    nextMessages: Message[] | ((previousMessages: Message[]) => Message[])
  ) => void;
  setChatSession: (chatSession: WorkspaceChatSession | null) => void;
  setOpeningProjectId: (projectId: string | null) => void;
  setScreenState: (screenState: AppState) => void;
  setWorkflowMessage: (
    workflowId: WorkspaceWorkflowId,
    requestId: number,
    message: string
  ) => void;
  succeedWorkflow: (
    workflowId: WorkspaceWorkflowId,
    requestId: number,
    message?: string
  ) => void;
}

export interface CreateWorkspaceControllerArgs {
  domain: WorkspaceDomainControllerAdapter;
  gemini?: GeminiServiceModule;
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

export interface OpenSectionOptions {
  allowWhileBlocking?: boolean;
  currentDocumentAssets?: PdfDocumentAssets | null;
  currentDocumentIndex?: PdfTextIndex | null;
  currentPlan?: LearningPlan | null;
  currentSourceFile?: FileData | null;
  currentSyllabus?: SyllabusItem[];
  currentUserProfile?: UserProfile | null;
  forceRegenerate?: boolean;
  isLearnMode?: boolean;
}

export interface WorkspaceControllerContext {
  domain: WorkspaceDomainControllerAdapter;
  gemini: GeminiServiceModule;
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
  ) => Promise<{ errorMessage?: string; outcome: 'started-assessment' | 'reattached' }>;
  importProjectFile: (
    selectedFile: File
  ) => Promise<{ errorMessage?: string; outcome: 'failed' | 'imported' }>;
  openProject: (
    projectId: string
  ) => Promise<{ errorMessage?: string; outcome: 'failed' | 'missing' | 'opened' | 'stale' }>;
  openSection: (section: LearningSection, options?: OpenSectionOptions) => Promise<OpenSectionOutcome>;
  regenerateActiveSection: () => Promise<OpenSectionOutcome>;
  confirmPlanGeneration: () => Promise<{ errorMessage?: string; outcome: 'failed' | 'planned' }>;
  startHomeChat: (args: {
    input: string;
    selectedFile?: File | null;
    toolPreferences?: HomeChatToolPreferences;
  }) => Promise<{ errorMessage?: string; outcome: 'assessment-complete' | 'continued' | 'failed' | 'noop' | 'planned' }>;
  startLearnJourney: () => Promise<{ errorMessage?: string; outcome: 'failed' | 'started' }>;
  submitAssessment: (
    input: string,
    toolPreferences?: HomeChatToolPreferences
  ) => Promise<{ errorMessage?: string; outcome: 'assessment-complete' | 'continued' | 'failed' | 'noop' | 'planned' }>;
}

export interface UseWorkspaceControllerArgs {
  domain: WorkspaceDomainControllerAdapter;
  gemini?: GeminiServiceModule;
  projectLibrary: WorkspaceProjectLibraryAdapter;
  stopAudio: (reset?: boolean) => void;
}
