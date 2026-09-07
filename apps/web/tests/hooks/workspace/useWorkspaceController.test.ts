import assert from 'node:assert/strict';
import type { LessonWorkflowSnapshot } from '@shared/lessonWorkflowContract';
import JSZip from 'jszip';
import { afterEach, expect, test, vi } from 'vitest';
import type {
  WorkspaceControllerStateAdapter,
  WorkspaceGenerationKind,
} from '../../../hooks/workspace/controller/types.ts';
import {
  createWorkspaceController,
  type WorkspaceDomainControllerAdapter,
  type WorkspaceProjectLibraryAdapter,
} from '../../../hooks/workspace/useWorkspaceController.ts';
import { setRenderingLocaleOverride, translateUiMessage as t } from '../../../i18n/uiMessages.ts';
import * as feedbackDiagnostics from '../../../services/feedback/browserDiagnostics.ts';
import type { CourseInterviewSnapshot } from '../../../services/openrouter/courseInterviewClient.ts';
import {
  type DurableLessonRecovery,
  LESSON_SOURCE_UNAVAILABLE_MESSAGE,
  LessonGenerationBusyError,
  LessonSourceUnavailableError,
} from '../../../services/openrouter/lessonGenerationClient.ts';
import { createProjectArchiveBlob } from '../../../services/projects/projectArchive.ts';
import { ProjectStorageError } from '../../../services/projects/projectRepository.ts';
import { createProjectSnapshot } from '../../../services/projects/projectSnapshot.ts';
import { createProjectSourceFromFile } from '../../../services/projects/projectSource.ts';
import {
  createWorkspaceWorkflowState,
  invalidateWorkspaceWorkflows,
  WORKSPACE_WORKFLOW_IDS,
} from '../../../services/workspace/workflow.ts';
import {
  type ApplicationExerciseNode,
  AppState,
  type ExerciseFeedback,
  type FileData,
  type LearningPlan,
  type LearningSection,
  type LessonNode,
  type Message,
  type PdfTextIndex,
  type ProjectSnapshot,
  type SavedProjectMeta,
  type UserProfile,
} from '../../../types.ts';
import {
  findPathNodeById,
  flattenLessons,
  updateLessons,
} from '../../../utils/learning/pathNodes.ts';
import {
  buildTestLearningPlan,
  buildTestLesson,
  buildTestProjectMeta,
} from '../../helpers/learningPlan.ts';

afterEach(() => setRenderingLocaleOverride(null));

const pdfFile: FileData = {
  name: 'dispensa.pdf',
  mimeType: 'application/pdf',
  data: 'ZmFrZQ==',
};

const markdownFile: FileData = {
  name: 'notes.md',
  mimeType: 'text/markdown',
  data: 'IyBUaXRvbG8KCkNvbnRlbnV0bw==',
};

const interviewProfile: UserProfile = {
  context: 'Sviluppatore frontend',
  experienceLevel: 'Intermedio',
  goals: 'Costruire applicazioni robuste',
  language: 'Italiano',
  learningStyle: 'Pratico e progressivo',
  topic: 'TypeScript',
};

const createInterviewSnapshot = (
  overrides: Partial<CourseInterviewSnapshot> = {}
): CourseInterviewSnapshot => ({
  messages: [{ role: 'model', text: 'Domanda iniziale' }],
  projectId: 'interview-project',
  proposal: null,
  result: null,
  runId: 'interview-run',
  status: 'waiting',
  wait: {
    expiresAt: '2026-08-09T10:00:00.000Z',
    signalType: 'user-answer',
    waitId: 'answer-wait',
  },
  ...overrides,
});

const createProposalSnapshot = (projectId: string): CourseInterviewSnapshot =>
  createInterviewSnapshot({
    messages: [
      { role: 'user', text: 'Voglio imparare TypeScript' },
      { role: 'model', text: 'Confermi questa proposta?' },
    ],
    projectId,
    proposal: interviewProfile,
    wait: {
      expiresAt: '2026-08-09T10:00:00.000Z',
      signalType: 'course-decision',
      waitId: 'decision-wait',
    },
  });

type TestLearningPlanOverrides = Partial<Omit<LearningPlan, 'modules'>> & {
  sections?: LearningSection[];
};

const buildPlan = (overrides: TestLearningPlanOverrides = {}): LearningPlan => {
  const {
    sections = [
      buildTestLesson({
        id: 'lesson-1',
        title: 'Lezione 1',
        description: 'Intro',
      }),
      buildTestLesson({
        id: 'lesson-2',
        title: 'Lezione 2',
        description: 'Follow-up',
        content: 'Contenuto già pronto',
        quiz: [],
      }),
    ],
    ...planOverrides
  } = overrides;

  return buildTestLearningPlan(sections, {
    title: 'Percorso',
    summary: 'Sintesi',
    ...planOverrides,
  });
};

const getLessons = (plan: LearningPlan | null | undefined): LessonNode[] =>
  flattenLessons(plan?.modules);

const buildMeta = (id: string): SavedProjectMeta =>
  buildTestProjectMeta({
    id,
    title: 'Percorso',
    createdAt: '2026-03-20T10:00:00.000Z',
    updatedAt: '2026-03-20T10:00:00.000Z',
    lastOpenedAt: '2026-03-20T10:00:00.000Z',
    lessonCount: 1,
    completedCount: 0,
    coverLabel: 'PDF',
  });

const createReadyIndex = (): PdfTextIndex => ({
  kind: 'pdf-text-index',
  parsedAt: '2026-03-20T10:00:00.000Z',
  sourceHash: 'hash-1',
  chunks: [
    {
      id: 'chunk-001',
      text: 'Contenuto',
      headingPath: ['Intro'],
      sequence: 0,
      startOffset: 0,
      endOffset: 9,
    },
  ],
});

const buildLessonRecovery = (
  sectionId: string,
  overrides: Partial<DurableLessonRecovery> = {}
): DurableLessonRecovery =>
  ({
    job: {
      id: `run-${sectionId}`,
      projectId: 'project-1',
      retrying: false,
      sectionId,
      stage: 'drafting',
      status: 'running',
    },
    requestKey: `request-${sectionId}`,
    storageKey: `storage-${sectionId}`,
    ...overrides,
  }) as DurableLessonRecovery;

const createLargeReadyIndex = (): PdfTextIndex => ({
  kind: 'pdf-text-index',
  parsedAt: '2026-03-20T10:00:00.000Z',
  sourceHash: 'hash-2',
  chunks: Array.from({ length: 8 }, (_, index) => ({
    id: `chunk-00${index + 1}`,
    text: `Contenuto ${index + 1}`,
    headingPath: [`Intro ${index + 1}`],
    sequence: index,
    startOffset: index * 10,
    endOffset: index * 10 + 9,
  })),
});

const syncDomainDerived = (domain: WorkspaceDomainControllerAdapter) => {
  domain.activeSection =
    getLessons(domain.learningPlan).find(section => section.id === domain.activeSectionId) || null;
  domain.sectionContent = domain.activeSection?.content || '';
  domain.quiz = domain.activeSection?.quiz || [];
  domain.musicUrl = domain.learningPlan?.backgroundMusicUrl || '';
  domain.needsSourceFile = !domain.source && Boolean(domain.learningPlan) && !domain.isLearnMode;
};

const createDomainAdapter = (
  overrides: Partial<WorkspaceDomainControllerAdapter> = {}
): WorkspaceDomainControllerAdapter => {
  const domain: WorkspaceDomainControllerAdapter = {
    activeSection: null,
    activeSectionId: null,
    documentAssets: null,
    documentIndex: null,
    domainState: {
      source: null,
      learningPlan: null,
      documentAssets: null,
      documentIndex: null,
      isLearnMode: false,
      userProfile: null,
      syllabus: [],
      researchCoursePlan: null,
      researchDossiersBySectionId: {},
      activeSectionId: null,
    },
    file: null,
    generationNotes: '',
    getDomainState: () => domain.domainState,
    hydrateSnapshot: snapshot => {
      domain.source = snapshot.source;
      domain.learningPlan = snapshot.learningPlan;
      domain.documentAssets = snapshot.documentAssets ?? null;
      domain.documentIndex = snapshot.documentIndex ?? null;
      domain.isLearnMode = snapshot.isLearnMode;
      domain.userProfile = snapshot.userProfile;
      domain.syllabus = snapshot.syllabus;
      domain.researchCoursePlan = snapshot.researchCoursePlan ?? null;
      domain.researchDossiersBySectionId = snapshot.researchDossiersBySectionId ?? {};
      domain.activeSectionId = snapshot.activeSectionId;
      domain.domainState = {
        source: snapshot.source,
        learningPlan: snapshot.learningPlan,
        documentAssets: snapshot.documentAssets ?? null,
        documentIndex: snapshot.documentIndex ?? null,
        isLearnMode: snapshot.isLearnMode,
        userProfile: snapshot.userProfile,
        syllabus: snapshot.syllabus,
        researchCoursePlan: snapshot.researchCoursePlan ?? null,
        researchDossiersBySectionId: snapshot.researchDossiersBySectionId ?? {},
        activeSectionId: snapshot.activeSectionId,
      };
      domain.file = snapshot.source?.kind === 'pdf' ? snapshot.source.file : null;
      syncDomainDerived(domain);
    },
    isLearnMode: false,
    learningPlan: null,
    musicUrl: '',
    needsSourceFile: false,
    quiz: [],
    researchCoursePlan: null,
    researchDossiersBySectionId: {},
    resetDomain: () => {
      domain.source = null;
      domain.learningPlan = null;
      domain.documentAssets = null;
      domain.documentIndex = null;
      domain.isLearnMode = false;
      domain.userProfile = null;
      domain.syllabus = [];
      domain.researchCoursePlan = null;
      domain.researchDossiersBySectionId = {};
      domain.activeSectionId = null;
      domain.domainState = {
        source: null,
        learningPlan: null,
        documentAssets: null,
        documentIndex: null,
        isLearnMode: false,
        userProfile: null,
        syllabus: [],
        researchCoursePlan: null,
        researchDossiersBySectionId: {},
        activeSectionId: null,
      };
      domain.file = null;
      syncDomainDerived(domain);
    },
    sectionContent: '',
    setActiveSectionId: sectionId => {
      domain.activeSectionId = sectionId;
      domain.domainState.activeSectionId = sectionId;
      syncDomainDerived(domain);
    },
    setDocumentAssets: documentAssets => {
      domain.documentAssets = documentAssets;
      domain.domainState.documentAssets = documentAssets;
    },
    setDocumentIndex: documentIndex => {
      domain.documentIndex = documentIndex;
      domain.domainState.documentIndex = documentIndex;
    },
    setGenerationNotes: notes => {
      domain.generationNotes = notes;
    },
    setIsLearnMode: isLearnMode => {
      domain.isLearnMode = isLearnMode;
      domain.domainState.isLearnMode = isLearnMode;
      syncDomainDerived(domain);
    },
    setLearningPlan: learningPlan => {
      domain.learningPlan = learningPlan;
      domain.domainState.learningPlan = learningPlan;
      syncDomainDerived(domain);
    },
    setMusicUrl: musicUrl => {
      domain.musicUrl = musicUrl;
    },
    setResearchCoursePlan: researchCoursePlan => {
      domain.researchCoursePlan = researchCoursePlan;
      domain.domainState.researchCoursePlan = researchCoursePlan;
    },
    setResearchDossiers: researchDossiersBySectionId => {
      domain.researchDossiersBySectionId = researchDossiersBySectionId;
      domain.domainState.researchDossiersBySectionId = researchDossiersBySectionId;
    },
    setResearchLessonDossier: dossier => {
      domain.researchDossiersBySectionId = {
        ...domain.researchDossiersBySectionId,
        [dossier.sectionId]: dossier,
      };
      domain.domainState.researchDossiersBySectionId = domain.researchDossiersBySectionId;
    },
    setSource: source => {
      domain.source = source;
      domain.domainState.source = source;
      domain.file = source?.kind === 'pdf' ? source.file : null;
      syncDomainDerived(domain);
    },
    setSyllabus: syllabus => {
      domain.syllabus = syllabus;
      domain.domainState.syllabus = syllabus;
    },
    setUserProfile: userProfile => {
      domain.userProfile = userProfile;
      domain.domainState.userProfile = userProfile;
    },
    source: null,
    syllabus: [],
    updateActiveSectionContent: content => {
      if (!domain.learningPlan || !domain.activeSectionId) {
        return;
      }

      domain.learningPlan = {
        ...domain.learningPlan,
        modules: updateLessons(domain.learningPlan.modules, section =>
          section.id === domain.activeSectionId ? { ...section, content } : section
        ),
      };
      domain.domainState.learningPlan = domain.learningPlan;
      syncDomainDerived(domain);
    },
    updateSection: (sectionId, updater) => {
      if (!domain.learningPlan) {
        return;
      }

      domain.learningPlan = {
        ...domain.learningPlan,
        modules: updateLessons(domain.learningPlan.modules, section =>
          section.id === sectionId ? updater(section) : section
        ),
      };
      domain.domainState.learningPlan = domain.learningPlan;
      syncDomainDerived(domain);
    },
    userProfile: null,
  };

  Object.assign(domain, overrides);
  if (overrides.source) {
    domain.file = overrides.source.kind === 'pdf' ? overrides.source.file : null;
  }
  if (overrides.learningPlan !== undefined || overrides.activeSectionId !== undefined) {
    syncDomainDerived(domain);
  }
  if (overrides.source !== undefined) {
    domain.domainState.source = overrides.source;
  }
  if (overrides.learningPlan !== undefined) {
    domain.domainState.learningPlan = overrides.learningPlan;
  }
  if (overrides.documentAssets !== undefined) {
    domain.domainState.documentAssets = overrides.documentAssets;
  }
  if (overrides.documentIndex !== undefined) {
    domain.domainState.documentIndex = overrides.documentIndex;
  }
  if (overrides.isLearnMode !== undefined) {
    domain.domainState.isLearnMode = overrides.isLearnMode;
  }
  if (overrides.userProfile !== undefined) {
    domain.domainState.userProfile = overrides.userProfile;
  }
  if (overrides.syllabus !== undefined) {
    domain.domainState.syllabus = overrides.syllabus;
  }
  if (overrides.activeSectionId !== undefined) {
    domain.domainState.activeSectionId = overrides.activeSectionId;
  }
  if (overrides.researchCoursePlan !== undefined) {
    domain.domainState.researchCoursePlan = overrides.researchCoursePlan;
  }
  if (overrides.researchDossiersBySectionId !== undefined) {
    domain.domainState.researchDossiersBySectionId = overrides.researchDossiersBySectionId;
  }

  return domain;
};

const createProjectLibraryAdapter = (overrides: Partial<WorkspaceProjectLibraryAdapter> = {}) => {
  const persistedSnapshots: ProjectSnapshot[] = [];
  const savedOverrides: Array<Partial<ProjectSnapshot> | undefined> = [];
  const saveOptions: Array<{ archiveFile?: File; throwOnError?: boolean } | undefined> = [];
  const sectionLessonPatches: Array<{ sectionId: string; patch: Record<string, unknown> }> = [];
  const sectionProjectPatches: Array<Partial<ProjectSnapshot>> = [];
  const deletedProjectIds: string[] = [];
  const exportedProjectIds: Array<string | undefined> = [];
  const touchedProjectIds: string[] = [];
  const appliedProjectRevisions: Parameters<
    WorkspaceProjectLibraryAdapter['applyPersistedProjectRevision']
  >[0][] = [];
  const completedProjectHydrations: Parameters<
    WorkspaceProjectLibraryAdapter['completeProjectHydration']
  >[0][] = [];
  let loadedSnapshot: ProjectSnapshot | null = null;

  const adapter: WorkspaceProjectLibraryAdapter = {
    applyPersistedProjectRevision: async args => {
      appliedProjectRevisions.push(args);
      return true;
    },
    completeProjectHydration: project => {
      completedProjectHydrations.push(project);
      adapter.setProjectHydrated(true);
    },
    createFolder: async ({ name, parentFolderId }) => ({
      id: 'folder-1',
      name,
      parentFolderId: parentFolderId ?? null,
      createdAt: '2026-03-20T10:00:00.000Z',
      updatedAt: '2026-03-20T10:00:00.000Z',
      order: 1,
    }),
    currentProjectId: null,
    getCurrentActiveSectionId: () => null,
    getCurrentProjectId: () => adapter.currentProjectId,
    deleteStoredProject: async projectId => {
      deletedProjectIds.push(projectId);
    },
    deleteFolder: async () => {},
    downloadProject: async projectId => {
      exportedProjectIds.push(projectId);
    },
    importProjectArchive: async () => ({
      meta: buildMeta('imported-project'),
      snapshot: createProjectSnapshot({ id: 'imported-project' }),
    }),
    importProjectData: async () => ({
      meta: buildMeta('imported-project'),
      snapshot: createProjectSnapshot({ id: 'imported-project' }),
    }),
    isLibraryLoading: false,
    libraryFolders: [],
    libraryPlacements: [],
    libraryTree: {
      descendantProjectIdsByFolderId: {},
      folderById: {},
      placementByProjectId: {},
      rootNodes: [],
    },
    loadProjectsById: async ids =>
      ids.map(id =>
        createProjectSnapshot({
          id,
        })
      ),
    loadStoredProject: async () => loadedSnapshot,
    loadStoredProjectWithRevision: async projectId => {
      const snapshot = await adapter.loadStoredProject(projectId);
      return snapshot ? { revision: 1, snapshot } : null;
    },
    validateStoredProjectForOpen: projectId => adapter.loadStoredProjectWithRevision(projectId),
    loadStoredProjectSource: async () => null,
    loadStoredProjectSourceById: async () => null,
    loadStoredProjectSources: async () => [],
    moveFolder: async () => null,
    moveProjects: async () => [],
    persistSnapshot: async snapshot => {
      persistedSnapshots.push(snapshot);
      return {
        meta: buildMeta(snapshot.id),
        snapshot,
      };
    },
    refreshLibraryOrganization: async () => {},
    refreshLibraryState: async () => {},
    refreshSavedProjects: async () => {},
    renameFolder: async () => null,
    saveCurrentProject: async (overridesArg, options) => {
      savedOverrides.push(overridesArg);
      saveOptions.push(options);
      return adapter.currentProjectId
        ? {
            meta: buildMeta(adapter.currentProjectId),
            snapshot: createProjectSnapshot({ id: adapter.currentProjectId, ...overridesArg }),
          }
        : null;
    },
    patchCurrentProject: async overridesArg => {
      savedOverrides.push(overridesArg);
      return adapter.currentProjectId ? buildMeta(adapter.currentProjectId) : null;
    },
    patchSectionLessonContent: async (sectionId, sectionPatch, projectPatch = {}) => {
      sectionLessonPatches.push({ sectionId, patch: sectionPatch });
      const snapshotPatch = projectPatch as Partial<ProjectSnapshot>;
      sectionProjectPatches.push(snapshotPatch);
      savedOverrides.push(snapshotPatch);
      return true;
    },
    patchSectionAnnotations: async () => true,
    savedProjects: [],
    setCurrentProjectId: projectId => {
      adapter.currentProjectId = projectId;
    },
    setProjectHydrated: () => {},
    storageError: null,
    touchStoredProject: async projectId => {
      touchedProjectIds.push(projectId);
    },
  };

  Object.assign(adapter, overrides);

  return {
    appliedProjectRevisions,
    adapter,
    completedProjectHydrations,
    deletedProjectIds,
    exportedProjectIds,
    persistedSnapshots,
    saveOptions,
    sectionLessonPatches,
    savedOverrides,
    sectionProjectPatches,
    setLoadedSnapshot: (snapshot: ProjectSnapshot | null) => {
      loadedSnapshot = snapshot;
    },
    touchedProjectIds,
  };
};

const createStateAdapter = () => {
  const internalState = {
    assessmentMessages: [] as Message[],
    courseProposal: null as UserProfile | null,
    generationByProject: new Map<
      string | null,
      {
        kind: WorkspaceGenerationKind;
        onReattach?: () => boolean;
        parentSectionId?: string;
        sectionId: string | null;
        token: number;
      }
    >(),
    nextGenerationToken: 0,
    missingSourceProjects: new Set<string>(),
    nextOpenSectionRequestId: 0,
    openingProjectId: null as string | null,
    screenState: AppState.LIBRARY as AppState,
    workflowState: createWorkspaceWorkflowState(),
  };

  const adapter: WorkspaceControllerStateAdapter = {
    beginOpenSectionRequest: () => {
      internalState.nextOpenSectionRequestId += 1;
      return internalState.nextOpenSectionRequestId;
    },
    beginWorkflow: (workflowId, message) => {
      const nextRequestId = internalState.workflowState[workflowId].requestId + 1;
      internalState.workflowState = {
        ...internalState.workflowState,
        [workflowId]: {
          status: 'pending',
          message,
          error: undefined,
          requestId: nextRequestId,
        },
      };
      return nextRequestId;
    },
    failWorkflow: (workflowId, requestId, errorMessage) => {
      if (internalState.workflowState[workflowId].requestId !== requestId) {
        return;
      }

      internalState.workflowState = {
        ...internalState.workflowState,
        [workflowId]: {
          ...internalState.workflowState[workflowId],
          status: 'failed',
          error: errorMessage,
          message: undefined,
        },
      };
    },
    finishGeneration: (projectId, token) => {
      if (internalState.generationByProject.get(projectId)?.token === token) {
        internalState.generationByProject.delete(projectId);
      }
    },
    getAssessmentMessages: () => internalState.assessmentMessages,
    getCourseProposal: () => internalState.courseProposal,
    getGeneratingSectionId: projectId =>
      internalState.generationByProject.get(projectId)?.sectionId ?? null,
    hasMissingSource: projectId =>
      projectId !== null && internalState.missingSourceProjects.has(projectId),
    getOpeningProjectId: () => internalState.openingProjectId,
    getScreenState: () => internalState.screenState,
    getWorkflowState: () => internalState.workflowState,
    invalidateGeneration: projectId => {
      internalState.generationByProject.delete(projectId);
    },
    invalidateOpenSectionRequests: () => {
      internalState.nextOpenSectionRequestId += 1;
    },
    invalidateWorkflows: workflowIds => {
      internalState.workflowState = invalidateWorkspaceWorkflows(
        internalState.workflowState,
        workflowIds
      );
    },
    isGenerationActive: projectId => internalState.generationByProject.has(projectId),
    isGenerationCurrent: (projectId, token) =>
      internalState.generationByProject.get(projectId)?.token === token,
    isLessonGenerationActive: projectId =>
      internalState.generationByProject.get(projectId)?.kind === 'lesson',
    isOpenSectionRequestCurrent: requestId => internalState.nextOpenSectionRequestId === requestId,
    isWorkflowCurrent: (workflowId, requestId) =>
      internalState.workflowState[workflowId].requestId === requestId,
    reattachLessonGeneration: (projectId, sectionId) => {
      const activeGeneration = internalState.generationByProject.get(projectId);
      if (
        activeGeneration?.kind !== 'lesson' ||
        activeGeneration.sectionId !== sectionId ||
        !activeGeneration.onReattach
      ) {
        return false;
      }

      return activeGeneration.onReattach();
    },
    reattachSublessonGeneration: (projectId, parentSectionId) => {
      const activeGeneration = internalState.generationByProject.get(projectId);
      if (
        activeGeneration?.kind !== 'lesson' ||
        activeGeneration.parentSectionId !== parentSectionId ||
        !activeGeneration.onReattach
      ) {
        return false;
      }

      return activeGeneration.onReattach();
    },
    resetSessionState: () => {
      internalState.assessmentMessages = [];
      internalState.courseProposal = null;
      internalState.openingProjectId = null;
    },
    setAssessmentMessages: nextMessages => {
      internalState.assessmentMessages =
        typeof nextMessages === 'function'
          ? nextMessages(internalState.assessmentMessages)
          : nextMessages;
    },
    setCourseProposal: proposal => {
      internalState.courseProposal = proposal;
    },
    setGeneratingSectionId: (projectId, token, sectionId) => {
      const activeGeneration = internalState.generationByProject.get(projectId);
      if (activeGeneration?.token === token) {
        internalState.generationByProject.set(projectId, {
          ...activeGeneration,
          sectionId,
        });
      }
    },
    setLessonGenerationReattachHandler: (projectId, token, onReattach, parentSectionId) => {
      const activeGeneration = internalState.generationByProject.get(projectId);
      if (activeGeneration?.kind === 'lesson' && activeGeneration.token === token) {
        internalState.generationByProject.set(projectId, {
          ...activeGeneration,
          onReattach,
          parentSectionId,
        });
      }
    },
    setOpeningProjectId: projectId => {
      internalState.openingProjectId = projectId;
    },
    setProjectMissingSource: (projectId, missing) => {
      if (missing) internalState.missingSourceProjects.add(projectId);
      else internalState.missingSourceProjects.delete(projectId);
    },
    setScreenState: screenState => {
      internalState.screenState = screenState;
    },
    setWorkflowMessage: (workflowId, requestId, message) => {
      if (internalState.workflowState[workflowId].requestId !== requestId) {
        return;
      }

      internalState.workflowState = {
        ...internalState.workflowState,
        [workflowId]: {
          ...internalState.workflowState[workflowId],
          message,
        },
      };
    },
    setWorkflowReasoning: (workflowId, requestId, reasoning) => {
      if (internalState.workflowState[workflowId].requestId !== requestId) {
        return;
      }

      internalState.workflowState = {
        ...internalState.workflowState,
        [workflowId]: {
          ...internalState.workflowState[workflowId],
          reasoning,
        },
      };
    },
    setWorkflowProgress: (workflowId, requestId, progress) => {
      if (internalState.workflowState[workflowId].requestId !== requestId) {
        return;
      }

      internalState.workflowState = {
        ...internalState.workflowState,
        [workflowId]: {
          ...internalState.workflowState[workflowId],
          progress,
        },
      };
    },
    succeedWorkflow: (workflowId, requestId, message) => {
      if (internalState.workflowState[workflowId].requestId !== requestId) {
        return;
      }

      internalState.workflowState = {
        ...internalState.workflowState,
        [workflowId]: {
          ...internalState.workflowState[workflowId],
          status: 'succeeded',
          error: undefined,
          message,
        },
      };
    },
    tryBeginGeneration: (projectId, kind) => {
      if (internalState.generationByProject.has(projectId)) {
        return null;
      }

      internalState.nextGenerationToken += 1;
      const token = internalState.nextGenerationToken;
      internalState.generationByProject.set(projectId, { kind, sectionId: null, token });
      return token;
    },
  };
  return {
    adapter,
    internalState,
  };
};

const createOpenRouterMock = (
  overrides: Partial<typeof import('../../../services/openrouter/index.ts')> = {}
) =>
  ({
    askContextualQuestion: async () => 'Risposta',
    buildAssessmentDocumentContextFromSourceSet: (
      sources: Parameters<
        typeof import('../../../services/openrouter/index.ts').buildAssessmentDocumentContextFromSourceSet
      >[0]
    ) => ({
      content: sources.map(source => `${source.id}:${source.name}`).join('\n'),
      hasReliableSourceContext: true,
    }),
    buildAssessmentDocumentContextFromTextSource: (
      source: Parameters<
        typeof import('../../../services/openrouter/index.ts').buildAssessmentDocumentContextFromTextSource
      >[0]
    ) => ({
      content: `${source.name}\n${source.text}`,
      hasReliableSourceContext: Boolean(source.text.trim()),
    }),
    buildAssessmentDocumentPrompt: async (
      file: Parameters<
        typeof import('../../../services/openrouter/index.ts').buildAssessmentDocumentPrompt
      >[0]
    ) => ({
      content: `${file.name}\nMateriale sorgente`,
      hasReliableSourceContext: true,
    }),
    cancelCourseInterview: async () => {},
    clearDurableLessonForceRegenerationIntent: () => {},
    clearDurableLessonRequestsForProject: () => {},
    createGenerationProgressObserver: ({
      onUpdate,
      operation,
      subject,
    }: Parameters<
      typeof import('../../../services/openrouter/index.ts').createGenerationProgressObserver
    >[0]) => {
      onUpdate({
        operation,
        sections: [],
        stage: 'sources',
        startedAt: Date.now(),
        stepOffset: 0,
        subject,
      });
      return {
        complete: vi.fn(),
        dispose: vi.fn(),
        finish: vi.fn(async () => undefined),
        push: vi.fn(),
        setStage: vi.fn(),
        updateStatus: vi.fn(),
      };
    },
    generateApplicationExerciseFeedback: async () => ({
      caveats: [],
      evaluatedAt: '2026-03-20T10:00:00.000Z',
      improvements: ['Rendi piu esplicite le motivazioni'],
      qualitativeLabel: 'Obiettivo raggiunto',
      score: 81,
      strengths: ['Consegna coerente con la traccia'],
      summary: 'Buon lavoro pratico con alcuni margini di chiarimento.',
    }),
    generateDurableCourse: async ({
      onProgressStage,
      projectId,
    }: Parameters<
      typeof import('../../../services/openrouter/index.ts').generateDurableCourse
    >[0]) => {
      onProgressStage?.('structure');
      return { firstSectionId: 'lesson-1', projectId, projectRevision: 1 };
    },
    generateDurableLesson: async ({
      projectId,
      sectionId,
    }: Parameters<
      typeof import('../../../services/openrouter/index.ts').generateDurableLesson
    >[0]) => ({
      content: '# Lezione generata',
      contentBlocks: [{ markdown: '# Lezione generata', type: 'markdown' as const }],
      documentAssets: null,
      generatedVisuals: [],
      imageRefs: [],
      learningAids: [],
      projectId,
      quiz: [],
      sectionId,
      warnings: [],
      visualPlanningDecision: {
        initial: { outcome: 'none' as const, plans: [], rationale: 'Nessuna visuale utile.' },
        reviewed: { outcome: 'none' as const, plans: [], rationale: 'Decisione confermata.' },
        reviewedAt: '2026-07-17T12:00:00.000Z',
      },
    }),
    generateDurableSublesson: async ({
      projectId,
    }: Parameters<
      typeof import('../../../services/openrouter/index.ts').generateDurableSublesson
    >[0]) => ({
      content: '# Lezione generata',
      contentBlocks: [{ markdown: '# Lezione generata', type: 'markdown' as const }],
      documentAssets: null,
      generatedVisuals: [],
      imageRefs: [],
      learningAids: [],
      projectId,
      projectRevision: 2,
      quiz: [],
      sectionId: 'deep-1',
      warnings: [],
    }),
    hasDurableLessonRequest: () => false,
    hasDurableSublessonRequest: () => false,
    isDurableSublessonRequestForSection: async () => false,
    resolveDurableSublessonRequestForParent: async () => null,
    resolveDurableSublessonRequestForSection: async () => null,
    repairDurablePdfMapping: async ({
      projectId,
    }: Parameters<
      typeof import('../../../services/openrouter/index.ts').repairDurablePdfMapping
    >[0]) => ({
      projectId,
      projectRevision: 1,
      repaired: false,
    }),
    retainDurableLessonForceRegenerationIntent: () => {},
    getActiveCourseInterview: async () => null,
    resumeActiveDurableCourse: async () => null,
    sendCourseInterviewAnswer: async (
      input: Parameters<
        typeof import('../../../services/openrouter/index.ts').sendCourseInterviewAnswer
      >[0]
    ) =>
      createInterviewSnapshot({
        messages: [
          { role: 'user', text: input.text },
          { role: 'model', text: 'Domanda successiva' },
        ],
        projectId: input.projectId,
        runId: input.runId,
      }),
    sendCourseInterviewDecision: async (
      input: Parameters<
        typeof import('../../../services/openrouter/index.ts').sendCourseInterviewDecision
      >[0]
    ) =>
      input.decision.kind === 'cancel'
        ? createInterviewSnapshot({
            messages: [],
            projectId: input.projectId,
            result: { kind: 'cancelled', projectId: input.projectId },
            runId: input.runId,
            status: 'cancelled',
            wait: null,
          })
        : createProposalSnapshot(input.projectId),
    startCourseInterview: async (
      input: Parameters<
        typeof import('../../../services/openrouter/index.ts').startCourseInterview
      >[0]
    ) =>
      createInterviewSnapshot({
        messages: [
          ...(input.initialMessage ? [{ role: 'user' as const, text: input.initialMessage }] : []),
          { role: 'model', text: 'Domanda iniziale' },
        ],
        projectId: input.projectId,
      }),
    validatePdfTextSource: async () => ({
      averageCharsPerPage: 120,
      extractedCharacterCount: 1200,
      pageCount: 10,
      status: 'ok' as const,
      substantivePageCount: 10,
      substantivePageRatio: 1,
    }),
    ...overrides,
  }) as unknown as typeof import('../../../services/openrouter/index.ts');

const createControllerHarness = (args?: {
  domain?: Partial<WorkspaceDomainControllerAdapter>;
  openRouter?: Partial<typeof import('../../../services/openrouter/index.ts')>;
  loadedSnapshot?: ProjectSnapshot | null;
  projectLibrary?: Partial<WorkspaceProjectLibraryAdapter>;
}) => {
  const domain = createDomainAdapter(args?.domain);
  const state = createStateAdapter();
  const projectLibrary = createProjectLibraryAdapter(args?.projectLibrary);
  projectLibrary.adapter.getCurrentActiveSectionId = () => domain.activeSectionId;
  projectLibrary.setLoadedSnapshot(args?.loadedSnapshot ?? null);
  const stopAudioCalls: boolean[] = [];
  const openRouter = createOpenRouterMock(args?.openRouter);
  const recreateController = () =>
    createWorkspaceController({
      domain,
      openRouter,
      projectLibrary: projectLibrary.adapter,
      scheduleHydration: callback => {
        callback();
      },
      sleep: async () => {},
      state: state.adapter,
      stopAudio: (reset?: boolean) => {
        stopAudioCalls.push(Boolean(reset));
      },
    });

  const controller = recreateController();

  return {
    controller,
    domain,
    projectLibrary,
    recreateController,
    state,
    stopAudioCalls,
  };
};

test('openProject starts document assessment when a stored project has a source but no plan', async () => {
  const snapshot = createProjectSnapshot({
    id: 'project-doc',
    source: createProjectSourceFromFile(pdfFile),
    state: AppState.ASSESSMENT,
  });
  const { controller, projectLibrary, state } = createControllerHarness({
    loadedSnapshot: snapshot,
  });

  const result = await controller.openProject('project-doc');

  assert.equal(result.outcome, 'opened');
  assert.equal(projectLibrary.adapter.currentProjectId, 'project-doc');
  assert.equal(state.internalState.screenState, AppState.LIBRARY);
  assert.equal(state.internalState.assessmentMessages[0]?.text, 'Domanda iniziale');
});

test('openProject resumes an active durable course instead of restarting assessment', async () => {
  const snapshot = createProjectSnapshot({
    id: 'project-generating',
    source: createProjectSourceFromFile(pdfFile),
    state: AppState.PLANNING,
  });
  const resumeActiveDurableCourse = vi.fn(
    async (
      input: Parameters<
        typeof import('../../../services/openrouter/index.ts').resumeActiveDurableCourse
      >[0]
    ) => {
      input.onProgressStage?.('drafting');
      return {
        firstSectionId: 'lesson-1',
        projectId: input.projectId,
        projectRevision: 7,
      };
    }
  );
  const { controller, projectLibrary, state } = createControllerHarness({
    loadedSnapshot: snapshot,
    openRouter: { resumeActiveDurableCourse },
  });

  const result = await controller.openProject(snapshot.id);

  assert.equal(result.outcome, 'opened');
  assert.equal(resumeActiveDurableCourse.mock.calls.length, 1);
  assert.deepEqual(projectLibrary.appliedProjectRevisions, [
    { projectId: snapshot.id, revision: 7 },
  ]);
  assert.equal(state.internalState.screenState, AppState.READING);
  assert.deepEqual(state.internalState.assessmentMessages, []);
});

test('openProject hydrates the explicitly requested lesson from a library reference', async () => {
  const snapshot = createProjectSnapshot({
    activeSectionId: 'lesson-1',
    id: 'project-library-reference',
    learningPlan: buildPlan(),
    state: AppState.READING,
  });
  const { controller, domain, projectLibrary, state } = createControllerHarness({
    loadedSnapshot: snapshot,
  });
  const invalidateOpenSectionRequests = vi.spyOn(state.adapter, 'invalidateOpenSectionRequests');

  const result = await controller.openProject(snapshot.id, { activeSectionId: 'lesson-2' });

  expect(result.outcome).toBe('opened');
  expect(invalidateOpenSectionRequests).toHaveBeenCalledTimes(1);
  expect(domain.activeSectionId).toBe('lesson-2');
  expect(projectLibrary.savedOverrides.at(-1)?.activeSectionId).toBe('lesson-2');
});

test('openProject invalidates workflows owned by the previously selected project', async () => {
  const snapshot = createProjectSnapshot({
    id: 'project-b',
    learningPlan: buildPlan(),
    state: AppState.READING,
  });
  const { controller, projectLibrary, state } = createControllerHarness({
    loadedSnapshot: snapshot,
  });
  projectLibrary.adapter.setCurrentProjectId('project-a');
  const evaluationRequestId = state.adapter.beginWorkflow(
    'evaluateExercise',
    'Valutazione in corso'
  );

  const result = await controller.openProject(snapshot.id);

  expect(result.outcome).toBe('opened');
  expect(state.adapter.isWorkflowCurrent('evaluateExercise', evaluationRequestId)).toBe(false);
  expect(projectLibrary.adapter.currentProjectId).toBe(snapshot.id);
});

test('openProject supersedes a source reattach before loading another project', async () => {
  const originalSource = createProjectSourceFromFile(markdownFile);
  const targetSnapshot = createProjectSnapshot({
    id: 'project-b',
    learningPlan: buildPlan(),
    state: AppState.READING,
  });
  let resolveSave:
    | ((result: { meta: SavedProjectMeta; snapshot: ProjectSnapshot }) => void)
    | undefined;
  let markSaveStarted: (() => void) | undefined;
  const saveResult = new Promise<{ meta: SavedProjectMeta; snapshot: ProjectSnapshot }>(resolve => {
    resolveSave = resolve;
  });
  const saveStarted = new Promise<void>(resolve => {
    markSaveStarted = resolve;
  });
  let resolveLoad: ((snapshot: ProjectSnapshot) => void) | undefined;
  let markLoadStarted: (() => void) | undefined;
  const loadResult = new Promise<ProjectSnapshot>(resolve => {
    resolveLoad = resolve;
  });
  const loadStarted = new Promise<void>(resolve => {
    markLoadStarted = resolve;
  });
  const { controller, domain, projectLibrary } = createControllerHarness({
    domain: { source: originalSource },
    projectLibrary: {
      currentProjectId: 'project-a',
      loadStoredProject: async () => {
        markLoadStarted?.();
        return loadResult;
      },
      saveCurrentProject: async () => {
        markSaveStarted?.();
        return saveResult;
      },
    },
  });

  const reattachment = controller.handleSourceUpload(
    new File(['nuova fonte'], 'nuova-fonte.md', { type: 'text/markdown' }),
    { mode: 'reattach-source' }
  );
  await saveStarted;
  const replacementSource = domain.source;
  expect(replacementSource).not.toBeNull();

  const opening = controller.openProject(targetSnapshot.id);
  await loadStarted;
  resolveSave?.({
    meta: buildMeta('project-a'),
    snapshot: createProjectSnapshot({ id: 'project-a', source: replacementSource }),
  });

  expect(await reattachment).toEqual({ outcome: 'failed' });
  resolveLoad?.(targetSnapshot);
  expect(await opening).toEqual({ outcome: 'opened' });
  expect(projectLibrary.adapter.currentProjectId).toBe(targetSnapshot.id);
});

test('cancelProjectOpen prevents a superseded project from hydrating', async () => {
  const targetSnapshot = createProjectSnapshot({
    id: 'project-b',
    learningPlan: buildPlan(),
    state: AppState.READING,
  });
  let resolveLoad: ((snapshot: ProjectSnapshot) => void) | undefined;
  let markLoadStarted: (() => void) | undefined;
  const loadResult = new Promise<ProjectSnapshot>(resolve => {
    resolveLoad = resolve;
  });
  const loadStarted = new Promise<void>(resolve => {
    markLoadStarted = resolve;
  });
  const { controller, projectLibrary } = createControllerHarness({
    projectLibrary: {
      currentProjectId: 'project-a',
      loadStoredProject: async () => {
        markLoadStarted?.();
        return loadResult;
      },
    },
  });

  const opening = controller.openProject(targetSnapshot.id);
  await loadStarted;
  controller.cancelProjectOpen();
  resolveLoad?.(targetSnapshot);

  expect(await opening).toEqual({ outcome: 'stale' });
  expect(projectLibrary.adapter.currentProjectId).toBe('project-a');
});

test('openProject resolves an explicitly requested lesson after migrating a legacy plan', async () => {
  const snapshot = {
    ...createProjectSnapshot({
      activeSectionId: 'legacy-lesson',
      id: 'project-legacy-library-reference',
      state: AppState.READING,
    }),
    learningPlan: {
      title: 'Percorso legacy',
      summary: 'Sintesi',
      sections: [
        buildTestLesson({
          content: '# Contenuto pronto',
          id: 'legacy-lesson',
          title: 'Lezione legacy',
        }),
      ],
    },
  } as unknown as ProjectSnapshot;
  const { controller, domain } = createControllerHarness({ loadedSnapshot: snapshot });

  const result = await controller.openProject(snapshot.id, {
    activeSectionId: 'legacy-lesson',
  });

  expect(result.outcome).toBe('opened');
  expect(domain.activeSectionId).toBe('legacy-lesson');
});

test('openProject remains opened when requested lesson generation fails after hydration', async () => {
  const snapshot = createProjectSnapshot({
    activeSectionId: 'lesson-1',
    id: 'project-library-generation-failure',
    learningPlan: buildPlan({
      sections: [
        buildTestLesson({ content: '# Pronta', id: 'lesson-1' }),
        buildTestLesson({ content: '', id: 'lesson-2' }),
      ],
    }),
    state: AppState.READING,
  });
  const { controller, domain, projectLibrary } = createControllerHarness({
    loadedSnapshot: snapshot,
    openRouter: {
      generateDurableLesson: async () => {
        throw new Error('generation unavailable');
      },
    },
  });

  const result = await controller.openProject(snapshot.id, { activeSectionId: 'lesson-2' });
  await Promise.resolve();

  expect(result.outcome).toBe('opened');
  expect(projectLibrary.adapter.currentProjectId).toBe(snapshot.id);
  expect(domain.activeSectionId).toBe('lesson-2');
});

test('openProject rejects a stale lesson reference before replacing the current workspace', async () => {
  const snapshot = createProjectSnapshot({
    activeSectionId: 'lesson-1',
    id: 'project-stale-library-reference',
    learningPlan: buildPlan(),
    state: AppState.READING,
  });
  const { controller, domain } = createControllerHarness({ loadedSnapshot: snapshot });

  const result = await controller.openProject(snapshot.id, {
    activeSectionId: 'lesson-deleted',
  });

  expect(result).toEqual({
    errorMessage: t('Non sono riuscito ad aprire il materiale recuperato. Riprova.'),
    outcome: 'failed',
  });
  expect(domain.activeSectionId).toBeNull();
});

test('openProject preserves authoritative durable course progress while resuming', async () => {
  const snapshot = createProjectSnapshot({
    id: 'project-progress',
    source: createProjectSourceFromFile(pdfFile),
    state: AppState.PLANNING,
  });
  let finishResume: (() => void) | undefined;
  let markResumeStarted: (() => void) | undefined;
  const resumeGate = new Promise<void>(resolve => {
    finishResume = resolve;
  });
  const resumeStarted = new Promise<void>(resolve => {
    markResumeStarted = resolve;
  });
  const { controller, state } = createControllerHarness({
    loadedSnapshot: snapshot,
    openRouter: {
      resumeActiveDurableCourse: async input => {
        input.onWorkflowSnapshot?.({
          createdAt: '2026-07-29T20:00:00.000Z',
          id: 'course-run-1',
          mode: 'document',
          projectId: input.projectId,
          retrying: false,
          stage: 'sources',
          status: 'queued',
          updatedAt: '2026-07-29T20:00:00.000Z',
        });
        input.onWorkflowSnapshot?.({
          attempt: 2,
          createdAt: '2026-07-29T20:00:00.000Z',
          id: 'course-run-1',
          mode: 'document',
          projectId: input.projectId,
          retrying: true,
          stage: 'drafting',
          startedAt: '2026-07-29T20:01:00.000Z',
          status: 'running',
          updatedAt: '2026-07-29T20:02:00.000Z',
        });
        input.onProgressStage?.('drafting');
        markResumeStarted?.();
        await resumeGate;
        return {
          firstSectionId: 'lesson-1',
          projectId: input.projectId,
          projectRevision: 7,
        };
      },
    },
  });

  const opening = controller.openProject(snapshot.id);
  await resumeStarted;

  assert.equal(
    state.internalState.workflowState.generatePlan.progress?.startedAt,
    Date.parse('2026-07-29T20:00:00.000Z')
  );
  assert.equal(state.internalState.workflowState.generatePlan.progress?.attempt, 2);
  assert.equal(state.internalState.workflowState.generatePlan.progress?.retrying, true);

  finishResume?.();
  assert.equal((await opening).outcome, 'opened');
});

test('openProject reloads a course completed while the active-run lookup returned not found', async () => {
  const pendingSnapshot = createProjectSnapshot({
    id: 'project-race',
    source: createProjectSourceFromFile(pdfFile),
    state: AppState.PLANNING,
  });
  const completedSnapshot = createProjectSnapshot({
    ...pendingSnapshot,
    activeSectionId: 'lesson-1',
    learningPlan: buildPlan({
      sections: [buildTestLesson({ id: 'lesson-1', content: '# Pronta' })],
    }),
    state: AppState.READING,
  });
  let loads = 0;
  const { controller, domain, state } = createControllerHarness({
    projectLibrary: {
      loadStoredProject: async () => {
        loads += 1;
        return loads === 1 ? pendingSnapshot : completedSnapshot;
      },
    },
  });

  const result = await controller.openProject(pendingSnapshot.id);

  assert.equal(result.outcome, 'opened');
  assert.equal(loads, 2);
  assert.equal(domain.learningPlan?.title, completedSnapshot.learningPlan?.title);
  assert.equal(state.internalState.screenState, AppState.READING);
  assert.deepEqual(state.internalState.assessmentMessages, []);
});

test('openProject aborts before hydration when the course disappears during opening', async () => {
  const snapshot = createProjectSnapshot({
    id: 'project-deleted-during-open',
    learningPlan: buildPlan(),
    state: AppState.READING,
  });
  const validateStoredProjectForOpen = vi.fn(async (_projectId: string) => null);
  const { controller, domain, projectLibrary, state } = createControllerHarness({
    loadedSnapshot: snapshot,
    projectLibrary: { validateStoredProjectForOpen },
  });

  const result = await controller.openProject(snapshot.id);

  assert.deepEqual(result, { outcome: 'missing' });
  assert.equal(validateStoredProjectForOpen.mock.calls[0]?.[0], snapshot.id);
  assert.equal(projectLibrary.adapter.currentProjectId, null);
  assert.equal(projectLibrary.completedProjectHydrations.length, 0);
  assert.equal(domain.learningPlan, null);
  assert.equal(state.internalState.screenState, AppState.LIBRARY);
});

test('openProject does not persist unchanged modern snapshots with reordered plan keys', async () => {
  const originalPlan = buildPlan({
    title: 'Reti',
    summary: 'Fondamenti',
    sections: [
      buildTestLesson({
        id: 'lesson-stable',
        content: '# Contenuto pronto',
      }),
    ],
  });
  const reorderedPlan: LearningPlan = {
    title: originalPlan.title,
    modules: originalPlan.modules,
    summary: originalPlan.summary,
    generationNotes: 'Usa esempi concreti.',
    applicationExercisePlanningStatus: originalPlan.applicationExercisePlanningStatus,
  };
  const snapshot = createProjectSnapshot({
    id: 'project-stable',
    learningPlan: reorderedPlan,
    state: AppState.READING,
    activeSectionId: 'lesson-stable',
  });
  const { controller, projectLibrary } = createControllerHarness({
    loadedSnapshot: snapshot,
  });

  const result = await controller.openProject('project-stable');

  assert.equal(result.outcome, 'opened');
  assert.equal(projectLibrary.persistedSnapshots.length, 0);
});

test('openProject does not wait for a real hydration migration to be persisted', async () => {
  const snapshot = {
    ...createProjectSnapshot({
      id: 'project-legacy-plan',
      state: AppState.READING,
    }),
    learningPlan: {
      title: 'Reti',
      summary: 'Fondamenti',
      sections: [
        {
          id: 'legacy-lesson',
          title: 'Comunicazione',
          description: 'Introduzione',
          isCompleted: false,
          type: 'core',
          content: '# Contenuto pronto',
        },
      ],
    },
  } as unknown as ProjectSnapshot;
  let releasePersistence: (() => void) | undefined;
  let notifyPersistenceStarted: (() => void) | undefined;
  const persistenceGate = new Promise<void>(resolve => {
    releasePersistence = resolve;
  });
  const persistenceStarted = new Promise<void>(resolve => {
    notifyPersistenceStarted = resolve;
  });
  const { controller, state } = createControllerHarness({
    loadedSnapshot: snapshot,
    projectLibrary: {
      persistSnapshot: async persistedSnapshot => {
        notifyPersistenceStarted?.();
        await persistenceGate;
        return {
          meta: buildMeta(persistedSnapshot.id),
          snapshot: persistedSnapshot,
        };
      },
    },
  });

  const outcome = (await controller.openProject('project-legacy-plan')).outcome;

  assert.equal(outcome, 'opened');
  assert.equal(state.internalState.workflowState.openProject.status, 'succeeded');
  await persistenceStarted;
  releasePersistence?.();
});

test('openProject reloads an authoritative PDF repair before hydrating the stored plan', async () => {
  const staleSnapshot = createProjectSnapshot({
    activeSectionId: 'lesson-1',
    id: 'project-pdf-missing-index',
    learningPlan: buildPlan({
      sections: [buildTestLesson({ content: '# Già pronta', id: 'lesson-1' })],
    }),
    source: createProjectSourceFromFile(pdfFile),
    state: AppState.READING,
  });
  const repairedSnapshot = createProjectSnapshot({
    ...staleSnapshot,
    documentIndex: createReadyIndex(),
    learningPlan: buildPlan({
      sections: [
        buildTestLesson({
          content: '# Già pronta',
          id: 'lesson-1',
          primaryChunkIds: ['chunk-001'],
          primaryChunkMappingSource: 'mapped',
        }),
      ],
    }),
  });
  const repairDurablePdfMapping = vi.fn(async () => ({
    projectId: staleSnapshot.id,
    projectRevision: 3,
    repaired: true,
  }));
  let loadCount = 0;
  const { controller, domain, projectLibrary } = createControllerHarness({
    openRouter: { repairDurablePdfMapping },
    projectLibrary: {
      loadStoredProject: async () => {
        loadCount += 1;
        return staleSnapshot;
      },
      loadStoredProjectWithRevision: async () => {
        loadCount += 1;
        return { revision: 3, snapshot: repairedSnapshot };
      },
    },
  });

  const result = await controller.openProject(staleSnapshot.id);

  assert.equal(result.outcome, 'opened');
  assert.equal(loadCount, 2);
  assert.equal(repairDurablePdfMapping.mock.calls.length, 1);
  assert.equal(domain.documentIndex?.chunks[0]?.id, 'chunk-001');
  assert.deepEqual(getLessons(domain.learningPlan)[0]?.primaryChunkIds, ['chunk-001']);
  assert.deepEqual(projectLibrary.completedProjectHydrations, [
    { revision: 3, snapshot: repairedSnapshot },
  ]);
  assert.equal(projectLibrary.appliedProjectRevisions.length, 0);
});

test('openProject requests a backend remap for legacy repeated PDF assignments', async () => {
  const staleIndex = createLargeReadyIndex();
  const stalePlan = buildPlan({
    sections: Array.from({ length: 5 }, (_, index) =>
      buildTestLesson({
        id: `lesson-${index + 1}`,
        primaryChunkIds: ['chunk-001', 'chunk-002'],
      })
    ),
  });
  const staleSnapshot = createProjectSnapshot({
    activeSectionId: 'lesson-1',
    documentIndex: staleIndex,
    id: 'project-pdf-legacy-mapping',
    learningPlan: stalePlan,
    source: createProjectSourceFromFile(pdfFile),
    state: AppState.READING,
  });
  let lessonIndex = 0;
  const repairedPlan = {
    ...stalePlan,
    modules: updateLessons(stalePlan.modules, lesson => {
      const chunkNumber = lessonIndex + 3;
      lessonIndex += 1;
      return {
        ...lesson,
        primaryChunkIds: [`chunk-00${chunkNumber}`],
        primaryChunkMappingSource: 'mapped' as const,
      };
    }),
  };
  const repairedSnapshot = createProjectSnapshot({
    ...staleSnapshot,
    learningPlan: repairedPlan,
  });
  const repairDurablePdfMapping = vi.fn(async () => ({
    projectId: staleSnapshot.id,
    projectRevision: 4,
    repaired: true,
  }));
  let loadCount = 0;
  const { controller, domain } = createControllerHarness({
    openRouter: { repairDurablePdfMapping },
    projectLibrary: {
      loadStoredProject: async () => {
        loadCount += 1;
        return staleSnapshot;
      },
      loadStoredProjectWithRevision: async () => {
        loadCount += 1;
        return { revision: 4, snapshot: repairedSnapshot };
      },
    },
  });

  const result = await controller.openProject(staleSnapshot.id);

  assert.equal(result.outcome, 'opened');
  assert.equal(loadCount, 2);
  assert.equal(repairDurablePdfMapping.mock.calls.length, 1);
  assert.deepEqual(getLessons(domain.learningPlan)[0]?.primaryChunkIds, ['chunk-003']);
});

test('openProject reloads an already-repaired PDF when the server revision is newer', async () => {
  const staleSnapshot = createProjectSnapshot({
    activeSectionId: 'lesson-1',
    id: 'project-pdf-repaired-elsewhere',
    learningPlan: buildPlan({
      sections: [buildTestLesson({ content: '# Vecchia', id: 'lesson-1' })],
    }),
    source: createProjectSourceFromFile(pdfFile),
    state: AppState.READING,
  });
  const repairedSnapshot = createProjectSnapshot({
    ...staleSnapshot,
    documentIndex: createReadyIndex(),
    learningPlan: buildPlan({
      sections: [
        buildTestLesson({
          content: '# Aggiornata',
          id: 'lesson-1',
          primaryChunkIds: ['chunk-001'],
          primaryChunkMappingSource: 'mapped',
        }),
      ],
    }),
  });
  let loadCount = 0;
  const repairDurablePdfMapping = vi.fn(async () => ({
    projectId: staleSnapshot.id,
    projectRevision: 5,
    repaired: false,
  }));
  const { controller, domain, projectLibrary } = createControllerHarness({
    openRouter: { repairDurablePdfMapping },
    projectLibrary: {
      loadStoredProject: async () => {
        loadCount += 1;
        return staleSnapshot;
      },
      loadStoredProjectWithRevision: async () => {
        loadCount += 1;
        return { revision: 5, snapshot: repairedSnapshot };
      },
      savedProjects: [{ ...buildMeta(staleSnapshot.id), revision: 4 }],
    },
  });

  const result = await controller.openProject(staleSnapshot.id);

  assert.equal(result.outcome, 'opened');
  assert.equal(loadCount, 2);
  assert.equal(repairDurablePdfMapping.mock.calls.length, 1);
  assert.equal(getLessons(domain.learningPlan)[0]?.content, '# Aggiornata');
  assert.deepEqual(projectLibrary.completedProjectHydrations, [
    { revision: 5, snapshot: repairedSnapshot },
  ]);
  assert.equal(projectLibrary.appliedProjectRevisions.length, 0);
});

test('openProject does not retry PDF mapping after recovery is marked exhausted', async () => {
  const plan = buildPlan({
    sections: [
      buildTestLesson({
        content: '# Già pronta',
        id: 'lesson-1',
        primaryChunkIds: ['chunk-001'],
        primaryChunkMappingSource: 'fallback',
      }),
    ],
  });
  const snapshot = createProjectSnapshot({
    activeSectionId: 'lesson-1',
    documentIndex: {
      ...createReadyIndex(),
      mappingRecovery: {
        status: 'exhausted',
        updatedAt: '2026-08-01T08:00:00.000Z',
      },
    },
    id: 'project-pdf-exhausted',
    learningPlan: plan,
    source: createProjectSourceFromFile(pdfFile),
    state: AppState.READING,
  });
  const repairDurablePdfMapping = vi.fn();
  const { controller } = createControllerHarness({
    loadedSnapshot: snapshot,
    openRouter: { repairDurablePdfMapping },
  });

  const result = await controller.openProject(snapshot.id);

  assert.equal(result.outcome, 'opened');
  assert.equal(repairDurablePdfMapping.mock.calls.length, 0);
});

test('openProject falls back to the stored PDF snapshot when backend repair times out', async () => {
  vi.useFakeTimers();
  try {
    const snapshot = createProjectSnapshot({
      activeSectionId: 'lesson-1',
      id: 'project-pdf-timeout',
      learningPlan: buildPlan({
        sections: [buildTestLesson({ content: '# Già pronta', id: 'lesson-1' })],
      }),
      source: createProjectSourceFromFile(pdfFile),
      state: AppState.READING,
    });
    const { controller, domain } = createControllerHarness({
      loadedSnapshot: snapshot,
      openRouter: {
        repairDurablePdfMapping: async () => await new Promise(() => {}),
      },
    });

    const opening = controller.openProject(snapshot.id);
    await vi.advanceTimersByTimeAsync(20_000);
    const result = await opening;

    assert.equal(result.outcome, 'opened');
    assert.equal(getLessons(domain.learningPlan)[0]?.content, '# Già pronta');
  } finally {
    vi.useRealTimers();
  }
});

test('openProject does not start lesson generation while a timed-out PDF repair continues', async () => {
  vi.useFakeTimers();
  try {
    const snapshot = createProjectSnapshot({
      activeSectionId: 'lesson-1',
      id: 'project-pdf-repair-still-running',
      learningPlan: buildPlan({
        sections: [buildTestLesson({ id: 'lesson-1' })],
      }),
      source: createProjectSourceFromFile(pdfFile),
      state: AppState.READING,
    });
    const generateDurableLesson = vi.fn(
      async (
        _input: Parameters<
          typeof import('../../../services/openrouter/index.ts').generateDurableLesson
        >[0]
      ) =>
        await new Promise<
          Awaited<
            ReturnType<typeof import('../../../services/openrouter/index.ts').generateDurableLesson>
          >
        >(() => {})
    );
    const { controller } = createControllerHarness({
      loadedSnapshot: snapshot,
      openRouter: {
        generateDurableLesson,
        repairDurablePdfMapping: async () => await new Promise(() => {}),
      },
    });

    const opening = controller.openProject(snapshot.id);
    await vi.advanceTimersByTimeAsync(20_000);
    const result = await opening;
    await Promise.resolve();

    assert.equal(result.outcome, 'opened');
    assert.equal(generateDurableLesson.mock.calls.length, 0);
  } finally {
    vi.useRealTimers();
  }
});

test('openProject keeps the stored PDF snapshot when backend repair fails', async () => {
  const snapshot = createProjectSnapshot({
    activeSectionId: 'lesson-1',
    id: 'project-pdf-repair-error',
    learningPlan: buildPlan({
      sections: [buildTestLesson({ id: 'lesson-1' })],
    }),
    source: createProjectSourceFromFile(pdfFile),
    state: AppState.READING,
  });
  const generateDurableLesson = vi.fn();
  const { controller, domain, state } = createControllerHarness({
    loadedSnapshot: snapshot,
    openRouter: {
      generateDurableLesson,
      repairDurablePdfMapping: async () => {
        throw new Error('repair failed');
      },
    },
  });

  const result = await controller.openProject(snapshot.id);
  await Promise.resolve();

  assert.equal(result.outcome, 'opened');
  assert.equal(state.internalState.workflowState.openProject.status, 'succeeded');
  assert.equal(getLessons(domain.learningPlan)[0]?.id, 'lesson-1');
  assert.equal(generateDurableLesson.mock.calls.length, 0);
});

test('openProject skips PDF repair for text document sources', async () => {
  const snapshot = createProjectSnapshot({
    activeSectionId: 'lesson-1',
    id: 'project-text-ready',
    learningPlan: buildPlan({
      sections: [buildTestLesson({ content: '# Già pronta', id: 'lesson-1' })],
    }),
    source: createProjectSourceFromFile(markdownFile),
    state: AppState.READING,
  });
  const repairDurablePdfMapping = vi.fn();
  const { controller } = createControllerHarness({
    loadedSnapshot: snapshot,
    openRouter: { repairDurablePdfMapping },
  });

  const result = await controller.openProject(snapshot.id);

  assert.equal(result.outcome, 'opened');
  assert.equal(repairDurablePdfMapping.mock.calls.length, 0);
});

test('openProject resolves immediately while loading an empty stored section in background', async () => {
  const snapshot = createProjectSnapshot({
    id: 'project-empty-section',
    source: createProjectSourceFromFile(pdfFile),
    learningPlan: buildPlan({
      sections: [
        {
          id: 'lesson-empty',
          title: 'Lezione vuota',
          description: 'Da generare',
          isCompleted: false,
          type: 'core',
        },
      ],
    }),
    documentIndex: createReadyIndex(),
    state: AppState.READING,
    activeSectionId: 'lesson-empty',
  });

  const { controller, domain } = createControllerHarness({
    loadedSnapshot: snapshot,
    openRouter: {
      generateDurableLesson: async () => await new Promise(() => {}),
    },
  });

  const outcome = (await controller.openProject('project-empty-section')).outcome;

  assert.equal(outcome, 'opened');
  assert.equal(domain.activeSectionId, 'lesson-empty');
});

test('openProject resumes a retained regeneration for a populated active lesson', async () => {
  const snapshot = createProjectSnapshot({
    activeSectionId: 'lesson-1',
    id: 'project-retained-regeneration',
    learningPlan: buildPlan({
      sections: [buildTestLesson({ content: '# Versione precedente', id: 'lesson-1' })],
    }),
    source: createProjectSourceFromFile(markdownFile),
    state: AppState.READING,
  });
  const generateDurableLesson = vi.fn(async () => ({
    content: '# Versione rigenerata',
    contentBlocks: [],
    generatedVisuals: [],
    imageRefs: [],
    learningAids: [],
    projectId: snapshot.id,
    quiz: [],
    sectionId: 'lesson-1',
    warnings: [],
  }));
  const { controller, domain } = createControllerHarness({
    loadedSnapshot: snapshot,
    openRouter: {
      generateDurableLesson,
      hasDurableLessonRequest: (projectId, sectionId) =>
        projectId === snapshot.id && sectionId === 'lesson-1',
    },
  });

  assert.equal((await controller.openProject(snapshot.id)).outcome, 'opened');
  await vi.waitFor(() => expect(generateDurableLesson).toHaveBeenCalledOnce());
  await vi.waitFor(() =>
    expect(getLessons(domain.learningPlan)[0]?.content).toBe('# Versione rigenerata')
  );
});

test('openProject resumes a retained sublesson request for a populated active lesson', async () => {
  const deepLesson = buildTestLesson({
    content: '# Versione provvisoria',
    id: 'deep-1',
    parentId: 'lesson-1',
    title: 'Approfondimento',
    type: 'deep-dive',
  });
  const snapshot = createProjectSnapshot({
    activeSectionId: deepLesson.id,
    id: 'project-retained-sublesson',
    learningPlan: buildPlan({ sections: [buildTestLesson({ id: 'lesson-1' }), deepLesson] }),
    source: createProjectSourceFromFile(markdownFile),
    state: AppState.READING,
  });
  const recovery = buildLessonRecovery(deepLesson.id);
  const generateDurableLesson = vi.fn(async () => ({
    content: '# Approfondimento completato',
    contentBlocks: [],
    generatedVisuals: [],
    imageRefs: [],
    learningAids: [],
    projectId: snapshot.id,
    quiz: [],
    sectionId: deepLesson.id,
    warnings: [],
  }));
  const { controller } = createControllerHarness({
    loadedSnapshot: snapshot,
    openRouter: {
      generateDurableLesson,
      hasDurableSublessonRequest: (projectId, parentSectionId) =>
        projectId === snapshot.id && parentSectionId === 'lesson-1',
      resolveDurableSublessonRequestForSection: async () => recovery,
    },
  });

  expect((await controller.openProject(snapshot.id)).outcome).toBe('opened');
  await vi.waitFor(() =>
    expect(generateDurableLesson).toHaveBeenCalledWith(
      expect.objectContaining({
        parentSectionId: 'lesson-1',
        projectId: snapshot.id,
        recovery,
        sectionId: deepLesson.id,
      })
    )
  );
});

test.each([
  { label: 'the persisted active section', openExplicitSection: false },
  { label: 'an explicitly requested section', openExplicitSection: true },
])('openProject resumes a retained sublesson before its child is persisted from $label', async ({
  openExplicitSection,
}) => {
  const rootLesson = buildTestLesson({ content: '# Radice', id: 'lesson-root' });
  const parentLesson = buildTestLesson({
    content: '# Approfondimento padre',
    id: 'deep-parent',
    parentId: rootLesson.id,
    type: 'deep-dive',
  });
  const readyLesson = buildTestLesson({ content: '# Pronta', id: 'lesson-2' });
  const deepLesson = buildTestLesson({
    content: '# Approfondimento',
    id: 'deep-1',
    parentId: parentLesson.id,
    title: 'Approfondimento',
    type: 'deep-dive',
  });
  const snapshot = createProjectSnapshot({
    activeSectionId: parentLesson.id,
    id: 'project-retained-parent-sublesson',
    learningPlan: buildPlan({ sections: [rootLesson, parentLesson, readyLesson] }),
    source: createProjectSourceFromFile(markdownFile),
    state: AppState.READING,
  });
  const completedSnapshot = createProjectSnapshot({
    ...snapshot,
    activeSectionId: deepLesson.id,
    learningPlan: buildPlan({ sections: [rootLesson, parentLesson, readyLesson, deepLesson] }),
  });
  const recovery = buildLessonRecovery(deepLesson.id, {
    job: {
      ...buildLessonRecovery(deepLesson.id).job,
      projectId: snapshot.id,
    },
  });
  const generateDurableLesson = vi.fn(async () => ({
    content: deepLesson.content || '',
    contentBlocks: [],
    generatedVisuals: [],
    imageRefs: [],
    learningAids: [],
    projectId: snapshot.id,
    projectRevision: 2,
    quiz: [],
    sectionId: deepLesson.id,
    warnings: [],
  }));
  const generateDurableSublesson = vi.fn();
  let resolveRecovery: ((value: DurableLessonRecovery) => void) | undefined;
  const recoveryGate = new Promise<DurableLessonRecovery>(resolve => {
    resolveRecovery = resolve;
  });
  const resolveDurableSublessonRequestForParent = vi.fn(async () => recoveryGate);
  let harness!: ReturnType<typeof createControllerHarness>;
  harness = createControllerHarness({
    loadedSnapshot: snapshot,
    openRouter: {
      generateDurableLesson,
      generateDurableSublesson,
      hasDurableSublessonRequest: (projectId, parentSectionId) =>
        projectId === snapshot.id && parentSectionId === parentLesson.id,
      resolveDurableSublessonRequestForParent,
    },
    projectLibrary: {
      applyPersistedProjectRevision: async () => {
        harness.domain.hydrateSnapshot(completedSnapshot);
        return true;
      },
    },
  });

  expect(
    (
      await harness.controller.openProject(
        snapshot.id,
        openExplicitSection ? { activeSectionId: parentLesson.id } : undefined
      )
    ).outcome
  ).toBe('opened');
  await vi.waitFor(() => expect(resolveDurableSublessonRequestForParent).toHaveBeenCalledOnce());
  expect(await harness.controller.openSection(readyLesson)).toBe('reused-cached');
  resolveRecovery?.(recovery);
  await vi.waitFor(() => expect(generateDurableLesson).toHaveBeenCalledOnce());
  await vi.waitFor(() =>
    expect(findPathNodeById(harness.domain.learningPlan?.modules, deepLesson.id)).toBeTruthy()
  );

  expect(generateDurableLesson).toHaveBeenCalledWith(
    expect.objectContaining({
      parentSectionId: parentLesson.id,
      projectId: snapshot.id,
      recovery,
      sectionId: deepLesson.id,
    })
  );
  expect(generateDurableSublesson).not.toHaveBeenCalled();
  expect(harness.domain.activeSectionId).toBe(readyLesson.id);
  expect(harness.state.adapter.isGenerationActive(snapshot.id)).toBe(false);
});

test('openProject uses the synchronously hydrated domain when its React closure is stale', async () => {
  const snapshot = createProjectSnapshot({
    activeSectionId: 'lesson-1',
    id: 'project-stale-domain-closure',
    learningPlan: buildPlan({
      sections: [buildTestLesson({ content: '# Versione precedente', id: 'lesson-1' })],
    }),
    source: createProjectSourceFromFile(markdownFile),
    state: AppState.READING,
  });
  const generateDurableLesson = vi.fn(async () => ({
    content: '# Versione rigenerata',
    contentBlocks: [],
    generatedVisuals: [],
    imageRefs: [],
    learningAids: [],
    projectId: snapshot.id,
    quiz: [],
    sectionId: 'lesson-1',
    warnings: [],
  }));
  const harness = createControllerHarness({
    loadedSnapshot: snapshot,
    openRouter: {
      generateDurableLesson,
      hasDurableLessonRequest: (projectId, sectionId) =>
        projectId === snapshot.id && sectionId === 'lesson-1',
    },
  });
  const staleDomain = harness.domain;
  staleDomain.hydrateSnapshot = hydratedSnapshot => {
    staleDomain.domainState = {
      source: hydratedSnapshot.source,
      learningPlan: hydratedSnapshot.learningPlan,
      documentAssets: hydratedSnapshot.documentAssets ?? null,
      documentIndex: hydratedSnapshot.documentIndex ?? null,
      isLearnMode: hydratedSnapshot.isLearnMode,
      userProfile: hydratedSnapshot.userProfile,
      syllabus: hydratedSnapshot.syllabus,
      researchCoursePlan: hydratedSnapshot.researchCoursePlan ?? null,
      researchDossiersBySectionId: hydratedSnapshot.researchDossiersBySectionId ?? {},
      activeSectionId: hydratedSnapshot.activeSectionId,
    };
  };

  expect(staleDomain.learningPlan).toBeNull();
  expect((await harness.controller.openProject(snapshot.id)).outcome).toBe('opened');
  await vi.waitFor(() => expect(generateDurableLesson).toHaveBeenCalledOnce());
});

test('openProject does not download detached PDF bytes when the active lesson is cached', async () => {
  const snapshot = createProjectSnapshot({
    id: 'project-detached-cached',
    source: {
      kind: 'pdf',
      file: {
        name: pdfFile.name,
        mimeType: pdfFile.mimeType,
        data: '',
      },
      ref: {
        id: 'source-123',
        hash: 'hash-123',
        byteSize: 4,
        name: pdfFile.name,
        mimeType: pdfFile.mimeType,
        objectPath: 'users/user/projects/project/source-123/original',
      },
    },
    learningPlan: buildPlan({
      sections: [
        {
          id: 'lesson-cached',
          title: 'Lezione pronta',
          description: 'Già generata',
          isCompleted: false,
          type: 'core',
          content: '# Contenuto pronto',
        },
      ],
    }),
    documentIndex: createReadyIndex(),
    state: AppState.READING,
    activeSectionId: 'lesson-cached',
  });
  let sourceLoadCalls = 0;
  const { controller } = createControllerHarness({
    loadedSnapshot: snapshot,
    projectLibrary: {
      loadStoredProjectSource: async () => {
        sourceLoadCalls += 1;
        return pdfFile;
      },
    },
  });

  const result = await controller.openProject(snapshot.id);

  assert.equal(result.outcome, 'opened');
  assert.equal(sourceLoadCalls, 0);
});

test('openProject starts assessment from stored text sources without rebuilding a file payload', async () => {
  const snapshot = createProjectSnapshot({
    id: 'project-md-direct',
    source: createProjectSourceFromFile(markdownFile),
    state: AppState.ASSESSMENT,
  });
  let textAssessmentCalls = 0;
  let fileAssessmentCalls = 0;

  const { controller, state } = createControllerHarness({
    openRouter: {
      buildAssessmentDocumentPrompt: async () => {
        fileAssessmentCalls += 1;
        return { content: 'Non dovrebbe partire', hasReliableSourceContext: true };
      },
      buildAssessmentDocumentContextFromTextSource: source => {
        textAssessmentCalls += 1;
        assert.equal(source.name, 'notes.md');
        assert.equal(source.text.includes('Titolo'), true);
        return { content: source.text, hasReliableSourceContext: true };
      },
    },
    loadedSnapshot: snapshot,
  });

  const result = await controller.openProject('project-md-direct');

  assert.equal(result.outcome, 'opened');
  assert.equal(textAssessmentCalls, 1);
  assert.equal(fileAssessmentCalls, 0);
  assert.equal(state.internalState.assessmentMessages[0]?.text, 'Domanda iniziale');
});

test('openProject settles its own workflow before starting assessment follow-up', async () => {
  const snapshot = createProjectSnapshot({
    id: 'project-md-follow-up',
    source: createProjectSourceFromFile(markdownFile),
    state: AppState.ASSESSMENT,
  });

  const { controller, state } = createControllerHarness({
    openRouter: {
      startCourseInterview: async input => {
        assert.equal(state.internalState.workflowState.openProject.status, 'succeeded');
        return createInterviewSnapshot({ projectId: input.projectId });
      },
    },
    loadedSnapshot: snapshot,
  });

  const result = await controller.openProject('project-md-follow-up');

  assert.equal(result.outcome, 'opened');
  assert.equal(state.internalState.workflowState.openProject.status, 'succeeded');
});

test('openProject does not wait for library metadata refresh before continuing', async () => {
  const snapshot = createProjectSnapshot({
    id: 'project-md-refresh',
    source: createProjectSourceFromFile(markdownFile),
    state: AppState.ASSESSMENT,
  });
  let refreshStarted = false;
  let releaseTouch: (() => void) | undefined;
  let releaseRefresh: (() => void) | undefined;
  let notifyAssessmentStarted: (() => void) | null = null;

  const touchGate = new Promise<void>(resolve => {
    releaseTouch = resolve;
  });
  const refreshGate = new Promise<void>(resolve => {
    releaseRefresh = resolve;
  });
  const assessmentStarted = new Promise<void>(resolve => {
    notifyAssessmentStarted = resolve;
  });

  const { controller, state } = createControllerHarness({
    openRouter: {
      startCourseInterview: async input => {
        notifyAssessmentStarted?.();
        return createInterviewSnapshot({ projectId: input.projectId });
      },
    },
    loadedSnapshot: snapshot,
    projectLibrary: {
      refreshSavedProjects: async () => {
        refreshStarted = true;
        await refreshGate;
      },
      touchStoredProject: async _projectId => {
        await touchGate;
      },
    },
  });

  const openProjectPromise = controller.openProject('project-md-refresh');
  await assessmentStarted;

  assert.equal(state.internalState.workflowState.openProject.status, 'succeeded');
  assert.equal(refreshStarted, false);

  const result = await openProjectPromise;

  assert.equal(result.outcome, 'opened');

  releaseTouch?.();
  await Promise.resolve();
  releaseRefresh?.();
});

test('handleSourceUpload creates a fresh project and lands in assessment for document sources', async () => {
  const { controller, domain, projectLibrary, state } = createControllerHarness();
  const uploadedFile = new File(['fake pdf'], 'dispensa.pdf', {
    type: 'application/pdf',
  });

  const result = await controller.handleSourceUpload(uploadedFile, {
    mode: 'new-project',
  });

  assert.equal(result.outcome, 'started-assessment');
  assert.equal(state.internalState.screenState, AppState.LIBRARY);
  assert.equal(domain.source?.kind, 'pdf');
  assert.equal(projectLibrary.persistedSnapshots.length, 1);
  assert.equal(projectLibrary.persistedSnapshots[0]?.state, AppState.ASSESSMENT);
  assert.equal(state.internalState.assessmentMessages[0]?.text, 'Domanda iniziale');
});

test('handleSourceUpload persists opaque ZIP bytes once and assesses the canonical server index', async () => {
  const canonicalEntry = {
    byteSize: 21,
    contentKind: 'text' as const,
    kind: 'file' as const,
    path: 'src/server-entry.ts',
    preview: 'export const server = 1;',
  };
  let persistedWrites = 0;
  let assessmentText = '';
  const persistenceOrder: string[] = [];
  const { controller, domain } = createControllerHarness({
    openRouter: {
      buildAssessmentDocumentContextFromTextSource: source => {
        assessmentText = source.text;
        return { content: source.text, hasReliableSourceContext: true };
      },
    },
    projectLibrary: {
      persistSnapshot: async (snapshot, options) => {
        persistenceOrder.push('persist');
        persistedWrites += 1;
        assert.equal(options?.archiveFile, uploadedFile);
        assert.equal(snapshot.source?.kind, 'archive');
        if (snapshot.source?.kind !== 'archive') {
          throw new Error('Expected archive source');
        }
        assert.deepEqual(snapshot.source.index.entries, []);
        assert.equal(snapshot.source.file.data, '');
        return {
          meta: buildMeta(snapshot.id),
          snapshot: {
            ...snapshot,
            source: {
              ...snapshot.source,
              file: { ...snapshot.source.file, data: '' },
              index: { entries: [canonicalEntry] },
            },
          },
        };
      },
      setProjectHydrated: value => {
        persistenceOrder.push(`hydrated:${value}`);
      },
    },
  });
  const uploadedFile = new File(['opaque bytes that are never decompressed'], 'engine.zip', {
    type: 'application/zip',
  });
  const readArchiveBytes = vi.spyOn(uploadedFile, 'arrayBuffer');

  const result = await controller.handleSourceUpload(uploadedFile, {
    mode: 'new-project',
  });

  assert.equal(result.outcome, 'started-assessment');
  assert.equal(result.errorMessage, undefined);
  assert.equal(persistedWrites, 1);
  assert.equal(readArchiveBytes.mock.calls.length, 0);
  assert.deepEqual(persistenceOrder, ['hydrated:false', 'persist', 'hydrated:true']);
  assert.equal(domain.source?.kind, 'archive');
  assert.deepEqual(domain.source?.kind === 'archive' ? domain.source.index.entries : [], [
    canonicalEntry,
  ]);
  assert.equal(assessmentText.includes('src/server-entry.ts'), true);
});

test('handleSourceUpload reattach clears transient session state and invalidates stale workflows', async () => {
  const { controller, domain, projectLibrary, state } = createControllerHarness({
    domain: {
      learningPlan: buildPlan(),
      activeSectionId: 'lesson-1',
    },
    projectLibrary: {
      currentProjectId: 'project-reattach',
    },
  });
  const uploadedFile = new File(['fake pdf'], 'dispensa.pdf', {
    type: 'application/pdf',
  });

  state.internalState.assessmentMessages = [{ role: 'model', text: 'Vecchia chat' }];
  state.internalState.openingProjectId = 'project-opening';
  state.internalState.missingSourceProjects.add('project-reattach');
  const staleLoadSectionRequestId = state.adapter.beginWorkflow(
    'loadSection',
    'Analisi contenuti...'
  );

  const result = await controller.handleSourceUpload(uploadedFile, {
    mode: 'reattach-source',
  });

  assert.equal(result.outcome, 'reattached');
  assert.equal(domain.source?.kind, 'pdf');
  assert.equal(projectLibrary.savedOverrides.length, 1);
  assert.equal(projectLibrary.savedOverrides[0]?.source?.kind, 'pdf');
  assert.deepEqual(state.internalState.assessmentMessages, []);
  assert.equal(state.internalState.openingProjectId, null);
  assert.equal(state.internalState.missingSourceProjects.has('project-reattach'), false);
  assert.equal(state.internalState.workflowState.loadSection.status, 'idle');
  assert.equal(state.adapter.isWorkflowCurrent('loadSection', staleLoadSectionRequestId), false);
  assert.equal(state.internalState.workflowState.attachSource.status, 'succeeded');
});

test('handleSourceUpload reattach preserves the active source and messages when persistence fails', async () => {
  const existingSource = createProjectSourceFromFile(markdownFile);
  const hydrationStates: boolean[] = [];
  const { controller, domain, state } = createControllerHarness({
    domain: {
      source: existingSource,
    },
    projectLibrary: {
      currentProjectId: 'project-reattach-failure',
      saveCurrentProject: async () => null,
      setProjectHydrated: value => {
        hydrationStates.push(value);
      },
    },
  });
  state.internalState.assessmentMessages = [{ role: 'model', text: 'Chat esistente' }];
  const activeLoadRequestId = state.adapter.beginWorkflow('loadSection', 'Caricamento esistente');

  const result = await controller.handleSourceUpload(
    new File(['nuovo contenuto'], 'nuova-fonte.md', { type: 'text/markdown' }),
    { mode: 'reattach-source' }
  );

  assert.equal(result.outcome, 'failed');
  assert.equal(result.errorMessage, 'La sorgente del progetto non è stata salvata.');
  assert.equal(domain.source, existingSource);
  assert.deepEqual(state.internalState.assessmentMessages, [
    { role: 'model', text: 'Chat esistente' },
  ]);
  assert.equal(state.adapter.isWorkflowCurrent('loadSection', activeLoadRequestId), true);
  assert.equal(state.internalState.workflowState.attachSource.status, 'failed');
  assert.deepEqual(hydrationStates, [false, true]);
});

test('handleSourceUpload cleans up a new project rejected during archive preparation', async () => {
  const sourceWarnings = [
    {
      message: 'Questa fonte non contiene testo PDF utilizzabile.',
      name: 'scans/manual.pdf',
      reason: 'no-usable-text' as const,
    },
  ];
  const hydrationStates: boolean[] = [];
  const { controller, domain, projectLibrary } = createControllerHarness({
    projectLibrary: {
      persistSnapshot: async () => {
        throw new ProjectStorageError(
          'L’archivio non contiene alcun testo utilizzabile.',
          'source-archive-unusable',
          { sourceWarnings }
        );
      },
      setProjectHydrated: value => hydrationStates.push(value),
    },
  });

  const result = await controller.handleSourceUpload(
    new File(['opaque archive'], 'scans.zip', { type: 'application/zip' }),
    { mode: 'new-project' }
  );

  expect(result).toMatchObject({
    errorMessage: 'L’archivio non contiene alcun testo utilizzabile.',
    outcome: 'started-assessment',
    sourceWarnings,
  });
  expect(projectLibrary.deletedProjectIds).toHaveLength(1);
  expect(projectLibrary.adapter.currentProjectId).toBeNull();
  expect(domain.source).toBeNull();
  expect(hydrationStates).toEqual([false, true]);
});

test('handleSourceUpload resets a new project after a definitive archive preparation failure', async () => {
  const hydrationStates: boolean[] = [];
  const { controller, domain, projectLibrary } = createControllerHarness({
    projectLibrary: {
      persistSnapshot: async () => {
        throw new ProjectStorageError(
          'Non è stato possibile preparare l’archivio ZIP.',
          'source-archive-invalid'
        );
      },
      setProjectHydrated: value => hydrationStates.push(value),
    },
  });

  const result = await controller.handleSourceUpload(
    new File(['opaque archive'], 'slow.zip', { type: 'application/zip' }),
    { mode: 'new-project' }
  );

  expect(result).toMatchObject({
    errorMessage: 'Non è stato possibile preparare l’archivio ZIP.',
    outcome: 'started-assessment',
  });
  expect(projectLibrary.deletedProjectIds).toHaveLength(1);
  expect(projectLibrary.adapter.currentProjectId).toBeNull();
  expect(domain.source).toBeNull();
  expect(hydrationStates).toEqual([false, true]);
});

test('handleSourceUpload does not restore a stale source after switching projects', async () => {
  const originalSource = createProjectSourceFromFile(markdownFile);
  const nextProjectSource = createProjectSourceFromFile(pdfFile);
  const hydrationStates: boolean[] = [];
  let rejectSave: ((reason?: unknown) => void) | undefined;
  let markSaveStarted: (() => void) | undefined;
  const saveResult = new Promise<null>((_resolve, reject) => {
    rejectSave = reject;
  });
  const saveStarted = new Promise<void>(resolve => {
    markSaveStarted = resolve;
  });
  const { controller, domain, projectLibrary, state } = createControllerHarness({
    domain: { source: originalSource },
    projectLibrary: {
      currentProjectId: 'project-a',
      saveCurrentProject: async () => {
        markSaveStarted?.();
        return saveResult;
      },
      setProjectHydrated: value => hydrationStates.push(value),
    },
  });

  const reattachment = controller.handleSourceUpload(
    new File(['nuova fonte'], 'nuova-fonte.md', { type: 'text/markdown' }),
    { mode: 'reattach-source' }
  );
  await saveStarted;
  projectLibrary.adapter.setCurrentProjectId('project-b');
  domain.setSource(nextProjectSource);
  state.adapter.invalidateWorkflows(['attachSource']);
  rejectSave?.(new Error('Salvataggio A fallito'));

  expect(await reattachment).toEqual({ outcome: 'failed' });
  expect(domain.source).toBe(nextProjectSource);
  expect(hydrationStates).toEqual([false]);
});

test('handleSourceUpload restores hydration and source after a stale reattach failure', async () => {
  const originalSource = createProjectSourceFromFile(markdownFile);
  const hydrationStates: boolean[] = [];
  let rejectSave: ((reason?: unknown) => void) | undefined;
  let markSaveStarted: (() => void) | undefined;
  const saveResult = new Promise<null>((_resolve, reject) => {
    rejectSave = reject;
  });
  const saveStarted = new Promise<void>(resolve => {
    markSaveStarted = resolve;
  });
  const { controller, domain, state } = createControllerHarness({
    domain: { source: originalSource },
    projectLibrary: {
      currentProjectId: 'project-a',
      saveCurrentProject: async () => {
        markSaveStarted?.();
        return saveResult;
      },
      setProjectHydrated: value => hydrationStates.push(value),
    },
  });

  const reattachment = controller.handleSourceUpload(
    new File(['nuova fonte'], 'nuova-fonte.md', { type: 'text/markdown' }),
    { mode: 'reattach-source' }
  );
  await saveStarted;
  state.adapter.invalidateWorkflows(['attachSource']);
  rejectSave?.(new Error('Salvataggio obsoleto fallito'));

  expect(await reattachment).toEqual({ outcome: 'failed' });
  expect(domain.source).toBe(originalSource);
  expect(hydrationStates).toEqual([false, true]);
});

test('handleSourceUpload leaves a newer same-project reattach source in control', async () => {
  const originalSource = createProjectSourceFromFile(markdownFile);
  const newerSource = createProjectSourceFromFile(pdfFile);
  const hydrationStates: boolean[] = [];
  let rejectSave: ((reason?: unknown) => void) | undefined;
  let markSaveStarted: (() => void) | undefined;
  const saveResult = new Promise<null>((_resolve, reject) => {
    rejectSave = reject;
  });
  const saveStarted = new Promise<void>(resolve => {
    markSaveStarted = resolve;
  });
  const { controller, domain, state } = createControllerHarness({
    domain: { source: originalSource },
    projectLibrary: {
      currentProjectId: 'project-a',
      saveCurrentProject: async () => {
        markSaveStarted?.();
        return saveResult;
      },
      setProjectHydrated: value => hydrationStates.push(value),
    },
  });

  const reattachment = controller.handleSourceUpload(
    new File(['prima fonte'], 'prima-fonte.md', { type: 'text/markdown' }),
    { mode: 'reattach-source' }
  );
  await saveStarted;
  domain.setSource(newerSource);
  state.adapter.invalidateWorkflows(['attachSource']);
  rejectSave?.(new Error('Prima richiesta fallita'));

  expect(await reattachment).toEqual({ outcome: 'failed' });
  expect(domain.source).toBe(newerSource);
  expect(hydrationStates).toEqual([false]);
});

test('handleSourceUpload restores hydration after a stale reattach succeeds', async () => {
  const originalSource = createProjectSourceFromFile(markdownFile);
  const hydrationStates: boolean[] = [];
  let resolveSave:
    | ((result: { meta: SavedProjectMeta; snapshot: ProjectSnapshot }) => void)
    | undefined;
  let markSaveStarted: (() => void) | undefined;
  const saveResult = new Promise<{ meta: SavedProjectMeta; snapshot: ProjectSnapshot }>(resolve => {
    resolveSave = resolve;
  });
  const saveStarted = new Promise<void>(resolve => {
    markSaveStarted = resolve;
  });
  const { controller, domain, state } = createControllerHarness({
    domain: { source: originalSource },
    projectLibrary: {
      currentProjectId: 'project-a',
      saveCurrentProject: async () => {
        markSaveStarted?.();
        return saveResult;
      },
      setProjectHydrated: value => hydrationStates.push(value),
    },
  });

  const reattachment = controller.handleSourceUpload(
    new File(['nuova fonte'], 'nuova-fonte.md', { type: 'text/markdown' }),
    { mode: 'reattach-source' }
  );
  await saveStarted;
  state.adapter.invalidateWorkflows(['attachSource']);
  const replacementSource = domain.source;
  expect(replacementSource).not.toBeNull();
  resolveSave?.({
    meta: buildMeta('project-a'),
    snapshot: createProjectSnapshot({ id: 'project-a', source: replacementSource }),
  });

  expect(await reattachment).toEqual({ outcome: 'failed' });
  expect(domain.source).toBe(replacementSource);
  expect(hydrationStates).toEqual([false, true]);
});

test('handleSourceUpload preserves archive identity when reattaching changed ZIP bytes', async () => {
  const existingSourceId = 'source-existing-archive';
  const existingSource = {
    file: {
      data: '',
      mimeType: 'application/zip',
      name: 'old-engine.zip',
    },
    index: { entries: [] },
    kind: 'archive' as const,
    name: 'old-engine.zip',
    ref: {
      byteSize: 128,
      hash: 'a'.repeat(64),
      id: existingSourceId,
      mimeType: 'application/zip',
      name: 'old-engine.zip',
      objectPath: `users/user/projects/project/${existingSourceId}/${'a'.repeat(64)}/original`,
    },
  };
  const persistedSnapshot = createProjectSnapshot({
    id: 'archive-project',
    source: {
      ...existingSource,
      file: {
        data: '',
        mimeType: 'application/zip',
        name: 'new-engine.zip',
        sourceId: existingSourceId,
      },
      index: {
        entries: [
          {
            byteSize: 28,
            contentKind: 'text',
            kind: 'file',
            path: 'src/main.ts',
            preview: 'export const changed = true;',
          },
          {
            byteSize: 96,
            contentKind: 'binary',
            kind: 'file',
            path: 'scansioni/allegato.pdf',
          },
        ],
      },
      name: 'new-engine.zip',
    },
  });
  const saveCurrentProject = vi.fn(async () => ({
    meta: buildMeta('archive-project'),
    snapshot: persistedSnapshot,
  }));
  const { controller } = createControllerHarness({
    domain: {
      source: existingSource,
      domainState: {
        source: existingSource,
        learningPlan: null,
        documentAssets: null,
        documentIndex: null,
        isLearnMode: false,
        userProfile: null,
        syllabus: [],
        activeSectionId: null,
      },
    },
    projectLibrary: {
      currentProjectId: 'archive-project',
      saveCurrentProject,
    },
  });
  const archive = new JSZip();
  archive.file('src/main.ts', 'export const changed = true;');
  const archiveBytes = await archive.generateAsync({ type: 'uint8array' });
  const uploadedFile = new File([archiveBytes.buffer as ArrayBuffer], 'new-engine.zip', {
    type: 'application/zip',
  });

  const result = await controller.handleSourceUpload(uploadedFile, {
    mode: 'reattach-source',
  });

  assert.equal(result.outcome, 'reattached');
  expect(saveCurrentProject).toHaveBeenCalledWith(
    expect.objectContaining({
      source: expect.objectContaining({
        file: expect.objectContaining({ sourceId: existingSourceId }),
        kind: 'archive',
      }),
    }),
    { archiveFile: uploadedFile, throwOnError: true }
  );
  assert.deepEqual(result.sourceWarnings, [
    {
      message: 'Questa fonte non contiene testo PDF utilizzabile.',
      name: 'scansioni/allegato.pdf',
      reason: 'no-usable-text',
    },
  ]);
});

test('handleSourceUpload bounds previews for a 20k-file archive before starting assessment', async () => {
  const previewMarker = '§';
  const canonicalEntries = Array.from({ length: 20_000 }, (_, index) => ({
    byteSize: 8_000,
    contentKind: 'text' as const,
    kind: 'file' as const,
    path: `src/file-${index.toString().padStart(5, '0')}.ts`,
    preview: previewMarker.repeat(100),
  }));
  let assessmentText = '';
  const { controller } = createControllerHarness({
    openRouter: {
      buildAssessmentDocumentContextFromTextSource: source => {
        assessmentText = source.text;
        return { content: source.text, hasReliableSourceContext: true };
      },
    },
    projectLibrary: {
      persistSnapshot: async snapshot => {
        assert.equal(snapshot.source?.kind, 'archive');
        if (snapshot.source?.kind !== 'archive') {
          throw new Error('Expected archive source');
        }
        return {
          meta: buildMeta(snapshot.id),
          snapshot: {
            ...snapshot,
            source: {
              ...snapshot.source,
              file: { ...snapshot.source.file, data: '' },
              index: { entries: canonicalEntries },
            },
          },
        };
      },
    },
  });

  const result = await controller.handleSourceUpload(
    new File(['opaque archive'], 'engine.zip', { type: 'application/zip' }),
    { mode: 'new-project' }
  );

  assert.equal(result.errorMessage, undefined);
  assert.equal(assessmentText.split(previewMarker).length - 1, 20_000);
  assert.equal(assessmentText.includes('src/file-19999.ts'), true);
});

test('handleSourceUpload accepts markdown sources with missing mime and stores them as document projects', async () => {
  let textAssessmentCalls = 0;
  let fileAssessmentCalls = 0;
  const { controller, domain, projectLibrary, state } = createControllerHarness({
    openRouter: {
      buildAssessmentDocumentPrompt: async () => {
        fileAssessmentCalls += 1;
        return { content: 'Non dovrebbe partire', hasReliableSourceContext: true };
      },
      buildAssessmentDocumentContextFromTextSource: source => {
        textAssessmentCalls += 1;
        assert.equal(source.name, 'notes.md');
        assert.equal(source.text.includes('Titolo'), true);
        return { content: source.text, hasReliableSourceContext: true };
      },
    },
  });
  const uploadedFile = new File(['# Titolo\n\nContenuto'], 'notes.md');

  const result = await controller.handleSourceUpload(uploadedFile, {
    mode: 'new-project',
  });

  assert.equal(result.outcome, 'started-assessment');
  assert.equal(result.errorMessage, undefined);
  assert.equal(state.internalState.screenState, AppState.LIBRARY);
  assert.equal(domain.source?.kind, 'document');
  assert.equal(projectLibrary.persistedSnapshots[0]?.sourceKind, 'document');
  assert.equal(projectLibrary.persistedSnapshots[0]?.source?.kind, 'document');
  assert.equal(textAssessmentCalls, 1);
  assert.equal(fileAssessmentCalls, 0);
  assert.equal(state.internalState.assessmentMessages[0]?.text, 'Domanda iniziale');
});

test('handleSourceUpload imports Nous backup zips instead of treating them as codebase bundles', async () => {
  const archivedSnapshot = createProjectSnapshot({
    id: 'backup-project',
    source: createProjectSourceFromFile(pdfFile),
    learningPlan: buildPlan(),
    state: AppState.READING,
  });
  const archive = await createProjectArchiveBlob(archivedSnapshot);
  const archiveFile = new File([await archive.arrayBuffer()], 'nous-backup.nous.zip', {
    type: 'application/zip',
  });
  let importedProjectId = '';
  const { controller, domain, projectLibrary, state } = createControllerHarness({
    projectLibrary: {
      importProjectArchive: async (_archive, targetProjectId) => {
        importedProjectId = targetProjectId;
        const snapshot = { ...archivedSnapshot, id: targetProjectId };
        return {
          meta: buildMeta(snapshot.id),
          snapshot,
        };
      },
    },
  });

  const result = await controller.handleSourceUpload(archiveFile, {
    mode: 'new-project',
  });

  assert.equal(result.outcome, 'imported');
  assert.notEqual(importedProjectId, archivedSnapshot.id);
  assert.equal(projectLibrary.adapter.currentProjectId, importedProjectId);
  assert.equal(state.internalState.screenState, AppState.READING);
  assert.equal(domain.source?.kind, 'pdf');
  assert.equal(domain.learningPlan?.title, archivedSnapshot.learningPlan?.title);
  assert.deepEqual(state.internalState.assessmentMessages, []);
});

test('handleSourceUpload removes a restored project when post-import hydration fails', async () => {
  const previousSnapshot = createProjectSnapshot({
    id: 'previous-project',
    learningPlan: buildPlan({ title: 'Corso precedente' }),
    source: createProjectSourceFromFile(markdownFile),
    state: AppState.READING,
  });
  const archivedSnapshot = createProjectSnapshot({
    id: 'backup-project',
    source: createProjectSourceFromFile(pdfFile),
    learningPlan: buildPlan(),
    state: AppState.READING,
  });
  const archive = await createProjectArchiveBlob(archivedSnapshot);
  const archiveFile = new File([await archive.arrayBuffer()], 'nous-backup.nous.zip', {
    type: 'application/zip',
  });
  let importedProjectId = '';
  const { controller, domain, projectLibrary, state } = createControllerHarness({
    loadedSnapshot: previousSnapshot,
    projectLibrary: {
      importProjectArchive: async (_archive, targetProjectId) => {
        importedProjectId = targetProjectId;
        return {
          meta: buildMeta(targetProjectId),
          snapshot: { ...archivedSnapshot, id: targetProjectId },
        };
      },
      touchStoredProject: async () => {
        throw new Error('touch failed');
      },
    },
  });
  projectLibrary.adapter.setCurrentProjectId(previousSnapshot.id);
  domain.hydrateSnapshot(previousSnapshot);

  const result = await controller.handleSourceUpload(archiveFile, { mode: 'new-project' });

  assert.equal(result.outcome, 'started-assessment');
  assert.equal(result.errorMessage, 'touch failed');
  assert.notEqual(importedProjectId, '');
  assert.deepEqual(projectLibrary.deletedProjectIds, [importedProjectId]);
  assert.equal(projectLibrary.adapter.currentProjectId, previousSnapshot.id);
  assert.equal(domain.learningPlan?.title, 'Corso precedente');
  assert.equal(domain.source?.kind, 'document');
  assert.equal(state.internalState.screenState, AppState.LIBRARY);
});

test('handleSourceUpload rejects unsupported binary sources with a clear error', async () => {
  const { controller, domain, projectLibrary, state } = createControllerHarness();
  const uploadedFile = new File(
    [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 255])],
    'diagram.bin'
  );

  const result = await controller.handleSourceUpload(uploadedFile, {
    mode: 'new-project',
  });

  assert.equal(result.outcome, 'started-assessment');
  assert.equal(result.errorMessage, 'Sono supportati PDF, ZIP o file di testo.');
  assert.equal(state.internalState.screenState, AppState.LIBRARY);
  assert.equal(domain.source, null);
  assert.equal(projectLibrary.persistedSnapshots.length, 0);
});

test('startHomeChat persists the uploaded source before React state propagates', async () => {
  const { controller, projectLibrary } = createControllerHarness({
    domain: { setSource: () => {} },
  });

  const result = await controller.startHomeChat({
    input: 'Crea un corso da questo PDF',
    selectedFile: new File(['pdf'], 'source.pdf', { type: 'application/pdf' }),
  });

  expect(result.outcome).toBe('continued');
  expect(projectLibrary.persistedSnapshots[0]?.source?.kind).toBe('pdf');
});

test('cancelAssessment invalidates source preparation before startHomeChat persists a draft', async () => {
  let resolveSourcePreparation: (
    value: Awaited<
      ReturnType<
        typeof import('../../../services/openrouter/index.ts').buildAssessmentDocumentPrompt
      >
    >
  ) => void = () => {};
  let markSourcePreparationStarted: () => void = () => {};
  const sourcePreparationStarted = new Promise<void>(resolve => {
    markSourcePreparationStarted = resolve;
  });
  const sourcePreparation = new Promise<
    Awaited<
      ReturnType<
        typeof import('../../../services/openrouter/index.ts').buildAssessmentDocumentPrompt
      >
    >
  >(resolve => {
    resolveSourcePreparation = resolve;
  });
  const startCourseInterview = vi.fn();
  const { controller, projectLibrary, state } = createControllerHarness({
    openRouter: {
      buildAssessmentDocumentPrompt: async () => {
        markSourcePreparationStarted();
        return sourcePreparation;
      },
      startCourseInterview,
    },
  });

  const startPromise = controller.startHomeChat({
    input: 'Crea un corso da questo PDF',
    selectedFile: new File(['pdf'], 'source.pdf', { type: 'application/pdf' }),
  });
  await sourcePreparationStarted;

  const cancellation = controller.cancelAssessment();
  resolveSourcePreparation({
    content: 'source.pdf\nMateriale sorgente',
    hasReliableSourceContext: true,
  });
  await cancellation;
  const result = await startPromise;

  expect(result.outcome).toBe('abandoned');
  assert.equal(projectLibrary.persistedSnapshots.length, 0);
  assert.equal(startCourseInterview.mock.calls.length, 0);
  assert.deepEqual(state.internalState.assessmentMessages, []);
});

test('cancelAssessment does not create an interview after the aborted lookup recovers no run', async () => {
  let markActiveLookupPending: () => void = () => {};
  const activeLookupPending = new Promise<void>(resolve => {
    markActiveLookupPending = resolve;
  });
  let activeLookupCalls = 0;
  const startCourseInterview = vi.fn();
  const { controller } = createControllerHarness({
    openRouter: {
      getActiveCourseInterview: async (_projectId, options) => {
        activeLookupCalls += 1;
        if (activeLookupCalls !== 1) return null;
        markActiveLookupPending();
        const signal = options?.signal;
        if (!signal) throw new Error('Expected an abort signal for the active interview lookup.');
        return new Promise((_resolve, reject) => {
          signal.addEventListener(
            'abort',
            () => reject(new DOMException('Aborted', 'AbortError')),
            { once: true }
          );
        });
      },
      startCourseInterview,
    },
  });

  const startPromise = controller.startHomeChat({ input: 'Voglio imparare database' });
  await activeLookupPending;
  await controller.cancelAssessment();

  assert.equal((await startPromise).outcome, 'abandoned');
  expect(startCourseInterview).not.toHaveBeenCalled();
});

test('cancelAssessment aborts and cancels an interview started by source upload', async () => {
  let markInterviewStartPending: () => void = () => {};
  const interviewStartPending = new Promise<void>(resolve => {
    markInterviewStartPending = resolve;
  });
  let observedPollingSignal: AbortSignal | undefined;
  let observedStartSignal: AbortSignal | undefined;
  const cancelCourseInterview = vi.fn(async () => {});
  const getActiveCourseInterview = vi.fn(async () => null);
  const { controller } = createControllerHarness({
    openRouter: {
      cancelCourseInterview,
      getActiveCourseInterview,
      startCourseInterview: (_input, options) => {
        const pollingSignal = options?.signal;
        const startSignal = options?.startSignal;
        if (!pollingSignal || !startSignal) {
          throw new Error('Expected polling and startup abort signals.');
        }
        observedPollingSignal = pollingSignal;
        observedStartSignal = startSignal;
        options?.onRunStarted?.('source-upload-run');
        markInterviewStartPending();
        return new Promise((_resolve, reject) => {
          pollingSignal.addEventListener(
            'abort',
            () => reject(new DOMException('Aborted', 'AbortError')),
            { once: true }
          );
        });
      },
    },
  });

  const uploadPromise = controller.handleSourceUpload(
    new File(['fake pdf'], 'dispensa.pdf', { type: 'application/pdf' }),
    { mode: 'new-project' }
  );
  await interviewStartPending;
  const cancellation = controller.cancelAssessment();
  await Promise.resolve();
  assert.equal(observedStartSignal?.aborted, true);
  await cancellation;

  assert.equal(observedPollingSignal?.aborted, true);
  expect(cancelCourseInterview).toHaveBeenCalledWith({
    projectId: expect.any(String),
    runId: 'source-upload-run',
  });
  expect(getActiveCourseInterview).toHaveBeenCalledOnce();
  assert.equal((await uploadPromise).outcome, 'started-assessment');
});

test('cancelAssessment prevents delayed PDF preparation from recreating a project', async () => {
  let finishSourcePreparation: () => void = () => {};
  let markSourcePreparationStarted: () => void = () => {};
  const sourcePreparationStarted = new Promise<void>(resolve => {
    markSourcePreparationStarted = resolve;
  });
  const sourcePreparationCanFinish = new Promise<void>(resolve => {
    finishSourcePreparation = resolve;
  });
  const { controller, projectLibrary } = createControllerHarness({
    openRouter: {
      buildAssessmentDocumentPrompt: async () => {
        markSourcePreparationStarted();
        await sourcePreparationCanFinish;
        return { content: 'Materiale PDF', hasReliableSourceContext: true };
      },
    },
  });

  const uploadPromise = controller.handleSourceUpload(
    new File(['fake pdf'], 'dispensa.pdf', { type: 'application/pdf' }),
    { mode: 'new-project' }
  );
  await sourcePreparationStarted;
  expect(projectLibrary.persistedSnapshots).toHaveLength(1);

  await controller.cancelAssessment();
  finishSourcePreparation();
  assert.equal((await uploadPromise).outcome, 'started-assessment');

  assert.equal(projectLibrary.persistedSnapshots.length, 1);
  assert.equal(projectLibrary.adapter.currentProjectId, null);
});

test('cancelAssessment aborts interview startup and cancels its recovered durable run', async () => {
  let markInterviewStartPending: () => void = () => {};
  const interviewStartPending = new Promise<void>(resolve => {
    markInterviewStartPending = resolve;
  });
  let observedPollingSignal: AbortSignal | undefined;
  let observedStartSignal: AbortSignal | undefined;
  const cancelCourseInterview = vi.fn(async () => {});
  const { controller } = createControllerHarness({
    openRouter: {
      cancelCourseInterview,
      getActiveCourseInterview: async () => null,
      startCourseInterview: (_input, options) => {
        const pollingSignal = options?.signal;
        const startSignal = options?.startSignal;
        if (!pollingSignal || !startSignal) {
          throw new Error('Expected polling and startup abort signals.');
        }
        observedPollingSignal = pollingSignal;
        observedStartSignal = startSignal;
        markInterviewStartPending();
        return new Promise((_resolve, reject) => {
          startSignal.addEventListener('abort', () => options?.onRunStarted?.('interview-run'), {
            once: true,
          });
          pollingSignal.addEventListener(
            'abort',
            () => reject(new DOMException('Aborted', 'AbortError')),
            { once: true }
          );
        });
      },
    },
  });

  const startPromise = controller.startHomeChat({ input: 'Voglio imparare sistemi operativi' });
  await interviewStartPending;
  const cancellation = controller.cancelAssessment();
  await Promise.resolve();
  assert.equal(observedStartSignal?.aborted, true);
  await cancellation;

  assert.equal(observedPollingSignal?.aborted, true);
  expect(cancelCourseInterview).toHaveBeenCalledWith({
    projectId: expect.any(String),
    runId: 'interview-run',
  });
  assert.equal((await startPromise).outcome, 'abandoned');
});

test('cancelAssessment keeps an abort-aware Home run available after cancellation fails', async () => {
  let observedPollingSignal: AbortSignal | undefined;
  let cancellationAttempts = 0;
  const { controller, projectLibrary } = createControllerHarness({
    openRouter: {
      cancelCourseInterview: async () => {
        cancellationAttempts += 1;
        if (cancellationAttempts === 1) throw new Error('network unavailable');
      },
      getActiveCourseInterview: async () => null,
      startCourseInterview: (_input, options) => {
        const pollingSignal = options?.signal;
        if (!pollingSignal) throw new Error('Expected a polling abort signal.');
        observedPollingSignal = pollingSignal;
        options?.onRunStarted?.('interview-run');
        return new Promise((_resolve, reject) => {
          pollingSignal.addEventListener(
            'abort',
            () => reject(new DOMException('Aborted', 'AbortError')),
            { once: true }
          );
        });
      },
    },
  });

  const startPromise = controller.startHomeChat({ input: 'Voglio imparare reti' });
  await vi.waitFor(() => expect(observedPollingSignal).toBeDefined());
  const draftProjectId = projectLibrary.adapter.currentProjectId;

  await expect(controller.cancelAssessment()).rejects.toThrow(
    t('Operazione non riuscita. Riprova.')
  );
  assert.equal(observedPollingSignal?.aborted, false);
  assert.equal(projectLibrary.adapter.currentProjectId, draftProjectId);

  await controller.cancelAssessment();
  assert.equal(observedPollingSignal?.aborted, true);
  assert.equal((await startPromise).outcome, 'abandoned');
  assert.equal(cancellationAttempts, 2);
});

test('cancelAssessment reports canceled-draft cleanup failure and retries it', async () => {
  let resolveInterview: (snapshot: CourseInterviewSnapshot) => void = () => {};
  let markInterviewStarted: () => void = () => {};
  const interviewStarted = new Promise<void>(resolve => {
    markInterviewStarted = resolve;
  });
  const interview = new Promise<CourseInterviewSnapshot>(resolve => {
    resolveInterview = resolve;
  });
  let cleanupAttempts = 0;
  const { controller, projectLibrary, state } = createControllerHarness({
    openRouter: {
      cancelCourseInterview: async () => {},
      getActiveCourseInterview: async () => null,
      startCourseInterview: async (_input, options) => {
        options?.onRunStarted?.('interview-run');
        markInterviewStarted();
        return interview;
      },
    },
    projectLibrary: {
      deleteStoredProject: async () => {
        cleanupAttempts += 1;
        if (cleanupAttempts === 1) throw new Error('storage unavailable');
      },
    },
  });

  const startPromise = controller.startHomeChat({ input: 'Voglio imparare database' });
  await interviewStarted;
  const draftProjectId = projectLibrary.adapter.currentProjectId;
  assert.ok(draftProjectId);
  const cancellation = controller.cancelAssessment();
  resolveInterview(
    createInterviewSnapshot({
      projectId: draftProjectId,
      result: { kind: 'cancelled', projectId: draftProjectId },
      status: 'completed',
    })
  );

  await expect(cancellation).rejects.toThrow(t('Operazione non riuscita. Riprova.'));
  assert.equal((await startPromise).outcome, 'failed');
  assert.equal(projectLibrary.adapter.currentProjectId, draftProjectId);
  assert.equal(state.internalState.workflowState.assessment.status, 'pending');

  await controller.cancelAssessment();
  assert.equal(cleanupAttempts, 2);
  assert.equal(projectLibrary.adapter.currentProjectId, null);
});

test('cancelAssessment deletes the cancelled draft after a different project opens', async () => {
  let resolveInterview: (snapshot: CourseInterviewSnapshot) => void = () => {};
  let markInterviewStarted: () => void = () => {};
  const interviewStarted = new Promise<void>(resolve => {
    markInterviewStarted = resolve;
  });
  const interview = new Promise<CourseInterviewSnapshot>(resolve => {
    resolveInterview = resolve;
  });
  let cleanupAttempts = 0;
  const successfullyDeletedProjectIds: string[] = [];
  const openedProject = createProjectSnapshot({
    id: 'project-opened-after-cleanup-failure',
    learningPlan: buildPlan(),
    state: AppState.READING,
  });
  const { controller, projectLibrary, state } = createControllerHarness({
    openRouter: {
      cancelCourseInterview: async () => {},
      getActiveCourseInterview: async () => null,
      startCourseInterview: async (_input, options) => {
        options?.onRunStarted?.('interview-run');
        markInterviewStarted();
        return interview;
      },
    },
    projectLibrary: {
      deleteStoredProject: async projectId => {
        cleanupAttempts += 1;
        if (cleanupAttempts === 1) throw new Error('storage unavailable');
        successfullyDeletedProjectIds.push(projectId);
      },
      loadStoredProject: async projectId => (projectId === openedProject.id ? openedProject : null),
    },
  });

  const startPromise = controller.startHomeChat({ input: 'Voglio imparare database' });
  await interviewStarted;
  const cancelledDraftProjectId = projectLibrary.adapter.currentProjectId;
  assert.ok(cancelledDraftProjectId);
  const firstCancellation = controller.cancelAssessment();
  resolveInterview(
    createInterviewSnapshot({
      projectId: cancelledDraftProjectId,
      result: { kind: 'cancelled', projectId: cancelledDraftProjectId },
      status: 'completed',
    })
  );

  await expect(firstCancellation).rejects.toThrow(t('Operazione non riuscita. Riprova.'));
  assert.equal((await startPromise).outcome, 'failed');
  assert.equal((await controller.openProject(openedProject.id)).outcome, 'opened');

  await controller.cancelAssessment();

  assert.deepEqual(successfullyDeletedProjectIds, [cancelledDraftProjectId]);
  assert.equal(projectLibrary.adapter.currentProjectId, openedProject.id);
  assert.equal(state.internalState.screenState, AppState.READING);
});

test('cancelAssessment preserves a cancelled draft reopened before a later Stop', async () => {
  const interviewResolvers: Array<(snapshot: CourseInterviewSnapshot) => void> = [];
  let cleanupAttempts = 0;
  const successfullyDeletedProjectIds: string[] = [];
  const startCourseInterview = vi.fn(
    async (
      _input: Parameters<
        typeof import('../../../services/openrouter/index.ts').startCourseInterview
      >[0],
      options?: Parameters<
        typeof import('../../../services/openrouter/index.ts').startCourseInterview
      >[1]
    ) => {
      options?.onRunStarted?.(`interview-run-${interviewResolvers.length + 1}`);
      return new Promise<CourseInterviewSnapshot>(resolve => {
        interviewResolvers.push(resolve);
      });
    }
  );
  const { controller, projectLibrary } = createControllerHarness({
    openRouter: {
      cancelCourseInterview: async () => {},
      getActiveCourseInterview: async () => null,
      startCourseInterview,
    },
    projectLibrary: {
      deleteStoredProject: async projectId => {
        cleanupAttempts += 1;
        if (cleanupAttempts === 1) throw new Error('storage unavailable');
        successfullyDeletedProjectIds.push(projectId);
      },
      loadStoredProject: async projectId =>
        createProjectSnapshot({
          id: projectId,
          learningPlan: buildPlan(),
          state: AppState.READING,
        }),
    },
  });

  const firstStart = controller.startHomeChat({ input: 'Voglio imparare database' });
  await vi.waitFor(() => expect(interviewResolvers).toHaveLength(1));
  const reopenedDraftProjectId = projectLibrary.adapter.currentProjectId;
  assert.ok(reopenedDraftProjectId);
  const firstCancellation = controller.cancelAssessment();
  interviewResolvers[0]?.(
    createInterviewSnapshot({
      projectId: reopenedDraftProjectId,
      result: { kind: 'cancelled', projectId: reopenedDraftProjectId },
      status: 'completed',
    })
  );

  await expect(firstCancellation).rejects.toThrow(t('Operazione non riuscita. Riprova.'));
  assert.equal((await firstStart).outcome, 'failed');
  assert.equal((await controller.openProject(reopenedDraftProjectId)).outcome, 'opened');

  const secondStart = controller.startHomeChat({ input: 'Voglio imparare Rust' });
  await vi.waitFor(() => expect(interviewResolvers).toHaveLength(2));
  const secondDraftProjectId = projectLibrary.adapter.currentProjectId;
  assert.ok(secondDraftProjectId);
  assert.notEqual(secondDraftProjectId, reopenedDraftProjectId);
  const secondCancellation = controller.cancelAssessment();
  interviewResolvers[1]?.(
    createInterviewSnapshot({
      projectId: secondDraftProjectId,
      result: { kind: 'cancelled', projectId: secondDraftProjectId },
      status: 'completed',
    })
  );

  await secondCancellation;
  assert.equal((await secondStart).outcome, 'abandoned');
  assert.deepEqual(successfullyDeletedProjectIds, [secondDraftProjectId]);
});

test('a draft reopen waits for an in-flight cancelled-draft cleanup retry', async () => {
  let resolveInterview: (snapshot: CourseInterviewSnapshot) => void = () => {};
  let markInterviewStarted: () => void = () => {};
  let finishCleanupRetry: () => void = () => {};
  const interviewStarted = new Promise<void>(resolve => {
    markInterviewStarted = resolve;
  });
  const interview = new Promise<CourseInterviewSnapshot>(resolve => {
    resolveInterview = resolve;
  });
  const cleanupRetryCanFinish = new Promise<void>(resolve => {
    finishCleanupRetry = resolve;
  });
  const operations: string[] = [];
  let cleanupAttempts = 0;
  let wasDraftDeleted = false;
  const { controller, projectLibrary } = createControllerHarness({
    openRouter: {
      cancelCourseInterview: async () => {},
      getActiveCourseInterview: async () => null,
      startCourseInterview: async (_input, options) => {
        options?.onRunStarted?.('interview-run');
        markInterviewStarted();
        return interview;
      },
    },
    projectLibrary: {
      deleteStoredProject: async () => {
        cleanupAttempts += 1;
        if (cleanupAttempts === 1) throw new Error('storage unavailable');
        operations.push('delete-started');
        await cleanupRetryCanFinish;
        wasDraftDeleted = true;
        operations.push('delete-finished');
      },
      loadStoredProject: async projectId => {
        operations.push('load-project');
        return wasDraftDeleted
          ? null
          : createProjectSnapshot({
              id: projectId,
              learningPlan: buildPlan(),
              state: AppState.READING,
            });
      },
    },
  });

  const startPromise = controller.startHomeChat({ input: 'Voglio imparare database' });
  await interviewStarted;
  const draftProjectId = projectLibrary.adapter.currentProjectId;
  assert.ok(draftProjectId);
  const firstCancellation = controller.cancelAssessment();
  resolveInterview(
    createInterviewSnapshot({
      projectId: draftProjectId,
      result: { kind: 'cancelled', projectId: draftProjectId },
      status: 'completed',
    })
  );
  await expect(firstCancellation).rejects.toThrow(t('Operazione non riuscita. Riprova.'));
  assert.equal((await startPromise).outcome, 'failed');

  const cleanupRetry = controller.cancelAssessment();
  await vi.waitFor(() => expect(operations).toEqual(['delete-started']));
  const reopen = controller.openProject(draftProjectId);
  await Promise.resolve();
  assert.deepEqual(operations, ['delete-started']);

  finishCleanupRetry();
  const [, reopenResult] = await Promise.all([cleanupRetry, reopen]);

  assert.equal(reopenResult.outcome, 'missing');
  assert.deepEqual(operations, ['delete-started', 'delete-finished', 'load-project']);
});

test('a failed cleanup retry settles a concurrent draft reopen before the next Stop', async () => {
  let resolveInterview: (snapshot: CourseInterviewSnapshot) => void = () => {};
  let markInterviewStarted: () => void = () => {};
  let failCleanupRetry: () => void = () => {};
  const interviewStarted = new Promise<void>(resolve => {
    markInterviewStarted = resolve;
  });
  const interview = new Promise<CourseInterviewSnapshot>(resolve => {
    resolveInterview = resolve;
  });
  const cleanupRetryFailure = new Promise<void>((_resolve, reject) => {
    failCleanupRetry = () => reject(new Error('storage still unavailable'));
  });
  let cleanupAttempts = 0;
  const loadStoredProject = vi.fn();
  const { controller, projectLibrary } = createControllerHarness({
    openRouter: {
      cancelCourseInterview: async () => {},
      getActiveCourseInterview: async () => null,
      startCourseInterview: async (_input, options) => {
        options?.onRunStarted?.('interview-run');
        markInterviewStarted();
        return interview;
      },
    },
    projectLibrary: {
      deleteStoredProject: async () => {
        cleanupAttempts += 1;
        if (cleanupAttempts === 1) throw new Error('storage unavailable');
        if (cleanupAttempts === 2) await cleanupRetryFailure;
      },
      loadStoredProject,
    },
  });

  const startPromise = controller.startHomeChat({ input: 'Voglio imparare database' });
  await interviewStarted;
  const draftProjectId = projectLibrary.adapter.currentProjectId;
  assert.ok(draftProjectId);
  const firstCancellation = controller.cancelAssessment();
  resolveInterview(
    createInterviewSnapshot({
      projectId: draftProjectId,
      result: { kind: 'cancelled', projectId: draftProjectId },
      status: 'completed',
    })
  );
  await expect(firstCancellation).rejects.toThrow(t('Operazione non riuscita. Riprova.'));
  assert.equal((await startPromise).outcome, 'failed');

  const cleanupRetry = controller.cancelAssessment();
  await vi.waitFor(() => expect(cleanupAttempts).toBe(2));
  const reopen = controller.openProject(draftProjectId);
  failCleanupRetry();

  await expect(cleanupRetry).rejects.toThrow(t('Operazione non riuscita. Riprova.'));
  assert.equal((await reopen).outcome, 'failed');
  expect(loadStoredProject).not.toHaveBeenCalled();

  await controller.cancelAssessment();
  assert.equal(cleanupAttempts, 3);
});

test('a cancelled startHomeChat cannot clear a newer completed request', async () => {
  let resolveSourcePreparation: (
    value: Awaited<
      ReturnType<
        typeof import('../../../services/openrouter/index.ts').buildAssessmentDocumentPrompt
      >
    >
  ) => void = () => {};
  let markSourcePreparationStarted: () => void = () => {};
  const sourcePreparationStarted = new Promise<void>(resolve => {
    markSourcePreparationStarted = resolve;
  });
  const sourcePreparation = new Promise<
    Awaited<
      ReturnType<
        typeof import('../../../services/openrouter/index.ts').buildAssessmentDocumentPrompt
      >
    >
  >(resolve => {
    resolveSourcePreparation = resolve;
  });
  const { controller, projectLibrary, state } = createControllerHarness({
    openRouter: {
      buildAssessmentDocumentPrompt: async () => {
        markSourcePreparationStarted();
        return sourcePreparation;
      },
    },
  });

  const cancelledStart = controller.startHomeChat({
    input: 'Crea un corso da questo PDF',
    selectedFile: new File(['pdf'], 'source.pdf', { type: 'application/pdf' }),
  });
  await sourcePreparationStarted;
  const cancellation = controller.cancelAssessment();
  resolveSourcePreparation({
    content: 'source.pdf\nMateriale sorgente',
    hasReliableSourceContext: true,
  });
  await cancellation;
  const cancelledResult = await cancelledStart;
  const newerResult = await controller.startHomeChat({ input: 'Voglio imparare Rust' });
  const newerProjectId = projectLibrary.adapter.currentProjectId;

  expect(newerResult.outcome).toBe('continued');
  assert.equal(cancelledResult.outcome, 'abandoned');
  assert.ok(newerProjectId);
  assert.equal(projectLibrary.adapter.currentProjectId, newerProjectId);
  assert.equal(state.internalState.assessmentMessages[0]?.text, 'Voglio imparare Rust');
});

test('a cancelled source preparation cannot clear a project opened afterward', async () => {
  let resolveSourcePreparation: (
    value: Awaited<
      ReturnType<
        typeof import('../../../services/openrouter/index.ts').buildAssessmentDocumentPrompt
      >
    >
  ) => void = () => {};
  let markSourcePreparationStarted: () => void = () => {};
  const sourcePreparationStarted = new Promise<void>(resolve => {
    markSourcePreparationStarted = resolve;
  });
  const sourcePreparation = new Promise<
    Awaited<
      ReturnType<
        typeof import('../../../services/openrouter/index.ts').buildAssessmentDocumentPrompt
      >
    >
  >(resolve => {
    resolveSourcePreparation = resolve;
  });
  const openedProject = createProjectSnapshot({
    id: 'opened-project',
    learningPlan: buildPlan(),
    state: AppState.READING,
  });
  const { controller, domain, projectLibrary, state } = createControllerHarness({
    loadedSnapshot: openedProject,
    openRouter: {
      buildAssessmentDocumentPrompt: async () => {
        markSourcePreparationStarted();
        return sourcePreparation;
      },
    },
  });

  const cancelledStart = controller.startHomeChat({
    input: 'Crea un corso da questo PDF',
    selectedFile: new File(['pdf'], 'source.pdf', { type: 'application/pdf' }),
  });
  await sourcePreparationStarted;
  const cancellation = controller.cancelAssessment();
  resolveSourcePreparation({
    content: 'source.pdf\nMateriale sorgente',
    hasReliableSourceContext: true,
  });
  await cancellation;
  const cancelledResult = await cancelledStart;
  const openResult = await controller.openProject(openedProject.id);

  expect(openResult.outcome).toBe('opened');
  assert.equal(cancelledResult.outcome, 'abandoned');
  assert.equal(projectLibrary.adapter.currentProjectId, openedProject.id);
  assert.equal(state.internalState.screenState, AppState.READING);
  assert.equal(domain.learningPlan?.title, openedProject.learningPlan?.title);
});

test('cancelled draft cleanup cannot clear a project opened while deletion is pending', async () => {
  const operationOrder: string[] = [];
  let resolveInterview: (snapshot: CourseInterviewSnapshot) => void = () => {};
  let markInterviewStarted: () => void = () => {};
  let markDeleteStarted: () => void = () => {};
  let finishDelete: () => void = () => {};
  const interviewStarted = new Promise<void>(resolve => {
    markInterviewStarted = resolve;
  });
  const interview = new Promise<CourseInterviewSnapshot>(resolve => {
    resolveInterview = resolve;
  });
  const deleteStarted = new Promise<void>(resolve => {
    markDeleteStarted = resolve;
  });
  const deleteCanFinish = new Promise<void>(resolve => {
    finishDelete = resolve;
  });
  const openedProject = createProjectSnapshot({
    id: 'project-opened-during-cleanup',
    learningPlan: buildPlan(),
    state: AppState.READING,
  });
  const loadStoredProject = vi.fn(async () => {
    operationOrder.push('load-project');
    return openedProject;
  });
  const { controller, domain, projectLibrary, state } = createControllerHarness({
    loadedSnapshot: openedProject,
    openRouter: {
      getActiveCourseInterview: async () => null,
      startCourseInterview: async (_input, options) => {
        options?.onRunStarted?.('interview-run');
        markInterviewStarted();
        return interview;
      },
    },
    projectLibrary: {
      deleteStoredProject: async () => {
        operationOrder.push('delete-started');
        markDeleteStarted();
        await deleteCanFinish;
        operationOrder.push('delete-finished');
      },
      loadStoredProject,
    },
  });

  const cancelledStart = controller.startHomeChat({ input: 'Voglio imparare crittografia' });
  await interviewStarted;
  const draftProjectId = projectLibrary.persistedSnapshots[0]?.id;
  assert.ok(draftProjectId);
  const cancellation = controller.cancelAssessment();
  resolveInterview(
    createInterviewSnapshot({
      projectId: draftProjectId,
      result: { kind: 'cancelled', projectId: draftProjectId },
      status: 'completed',
    })
  );
  await deleteStarted;

  const opening = controller.openProject(openedProject.id);
  finishDelete();
  const openResult = await opening;
  const [cancelledResult] = await Promise.all([cancelledStart, cancellation]);

  expect(openResult.outcome).toBe('opened');
  assert.deepEqual(operationOrder.slice(0, 3), [
    'delete-started',
    'delete-finished',
    'load-project',
  ]);
  assert.equal(cancelledResult.outcome, 'abandoned');
  assert.equal(projectLibrary.adapter.currentProjectId, openedProject.id);
  assert.equal(state.internalState.screenState, AppState.READING);
  assert.equal(domain.learningPlan?.title, openedProject.learningPlan?.title);
});

test('overlapping Home starts release every ownership waiting on the same project open', async () => {
  let finishProjectOpen: () => void = () => {};
  let markProjectOpenStarted: () => void = () => {};
  let finishSourcePreparation: () => void = () => {};
  const projectOpenStarted = new Promise<void>(resolve => {
    markProjectOpenStarted = resolve;
  });
  const projectOpenCanFinish = new Promise<void>(resolve => {
    finishProjectOpen = resolve;
  });
  const sourcePreparationCanFinish = new Promise<void>(resolve => {
    finishSourcePreparation = resolve;
  });
  const openedProject = createProjectSnapshot({
    id: 'project-opened-across-home-starts',
    learningPlan: buildPlan(),
    state: AppState.READING,
  });
  const { controller } = createControllerHarness({
    loadedSnapshot: openedProject,
    openRouter: {
      buildAssessmentDocumentPrompt: async () => {
        await sourcePreparationCanFinish;
        return { content: 'Materiale sorgente', hasReliableSourceContext: true };
      },
    },
    projectLibrary: {
      loadStoredProject: async () => {
        markProjectOpenStarted();
        await projectOpenCanFinish;
        return openedProject;
      },
    },
  });

  const opening = controller.openProject(openedProject.id);
  await projectOpenStarted;
  const firstStart = controller.startHomeChat({
    input: 'Primo corso',
    selectedFile: new File(['one'], 'one.md', { type: 'text/markdown' }),
  });
  const secondStart = controller.startHomeChat({
    input: 'Secondo corso',
    selectedFile: new File(['two'], 'two.md', { type: 'text/markdown' }),
  });
  const cancellation = controller.cancelAssessment();
  finishSourcePreparation();
  finishProjectOpen();
  await cancellation;

  expect((await opening).outcome).toBe('opened');
  assert.equal((await firstStart).outcome, 'abandoned');
  assert.equal((await secondStart).outcome, 'abandoned');
});

test('cancelAssessment rolls back a backup import that finishes after Stop', async () => {
  const archivedSnapshot = createProjectSnapshot({
    id: 'backup-project',
    learningPlan: buildPlan(),
    source: createProjectSourceFromFile(pdfFile),
    state: AppState.READING,
  });
  const archive = await createProjectArchiveBlob(archivedSnapshot);
  const archiveFile = new File([await archive.arrayBuffer()], 'nous-backup.nous.zip', {
    type: 'application/zip',
  });
  let importedProjectId = '';
  let finishTouch: () => void = () => {};
  let markTouchStarted: () => void = () => {};
  const touchStarted = new Promise<void>(resolve => {
    markTouchStarted = resolve;
  });
  const touchCanFinish = new Promise<void>(resolve => {
    finishTouch = resolve;
  });
  const { controller, projectLibrary, state } = createControllerHarness({
    projectLibrary: {
      importProjectArchive: async (_archive, targetProjectId) => {
        importedProjectId = targetProjectId;
        return {
          meta: buildMeta(targetProjectId),
          snapshot: { ...archivedSnapshot, id: targetProjectId },
        };
      },
      touchStoredProject: async () => {
        markTouchStarted();
        await touchCanFinish;
      },
    },
  });

  const startPromise = controller.startHomeChat({
    input: 'Importa questo corso',
    selectedFile: archiveFile,
  });
  await touchStarted;

  const cancellation = controller.cancelAssessment();
  finishTouch();
  await cancellation;
  const result = await startPromise;

  expect(result.outcome).toBe('abandoned');
  assert.notEqual(importedProjectId, '');
  assert.deepEqual(projectLibrary.deletedProjectIds, [importedProjectId]);
  assert.deepEqual(state.internalState.assessmentMessages, []);
  assert.equal(projectLibrary.adapter.currentProjectId, null);
});

test('cancelAssessment waits for a pre-project backup rollback failure', async () => {
  const archivedSnapshot = createProjectSnapshot({
    id: 'backup-project',
    learningPlan: buildPlan(),
    source: createProjectSourceFromFile(pdfFile),
    state: AppState.READING,
  });
  const archive = await createProjectArchiveBlob(archivedSnapshot);
  const archiveFile = new File([await archive.arrayBuffer()], 'nous-backup.nous.zip', {
    type: 'application/zip',
  });
  let finishImport: () => void = () => {};
  let markImportStarted: () => void = () => {};
  const importStarted = new Promise<void>(resolve => {
    markImportStarted = resolve;
  });
  const importCanFinish = new Promise<void>(resolve => {
    finishImport = resolve;
  });
  let cleanupAttempts = 0;
  const { controller } = createControllerHarness({
    projectLibrary: {
      deleteStoredProject: async () => {
        cleanupAttempts += 1;
        if (cleanupAttempts === 1) throw new Error('storage unavailable');
      },
      importProjectArchive: async (_archive, targetProjectId) => {
        markImportStarted();
        await importCanFinish;
        return {
          meta: buildMeta(targetProjectId),
          snapshot: { ...archivedSnapshot, id: targetProjectId },
        };
      },
    },
  });

  const startPromise = controller.startHomeChat({
    input: 'Importa questo corso',
    selectedFile: archiveFile,
  });
  await importStarted;
  let hasCancellationSettled = false;
  const cancellation = controller.cancelAssessment();
  void cancellation.then(
    () => {
      hasCancellationSettled = true;
    },
    () => {
      hasCancellationSettled = true;
    }
  );
  await Promise.resolve();
  assert.equal(hasCancellationSettled, false);

  finishImport();
  await expect(cancellation).rejects.toThrow(t('Operazione non riuscita. Riprova.'));
  assert.equal((await startPromise).outcome, 'failed');
  assert.equal(cleanupAttempts, 1);

  await controller.cancelAssessment();
  assert.equal(cleanupAttempts, 2);
});

test('a canceled backup import cannot hydrate over a project opened after Stop', async () => {
  const archivedSnapshot = createProjectSnapshot({
    id: 'backup-project',
    learningPlan: buildPlan({ title: 'Backup obsoleto' }),
    source: createProjectSourceFromFile(pdfFile),
    state: AppState.READING,
  });
  const openedProject = createProjectSnapshot({
    id: 'newer-opened-project',
    learningPlan: buildPlan({ title: 'Progetto più recente' }),
    state: AppState.READING,
  });
  const archive = await createProjectArchiveBlob(archivedSnapshot);
  const archiveFile = new File([await archive.arrayBuffer()], 'nous-backup.nous.zip', {
    type: 'application/zip',
  });
  let importedProjectId = '';
  let finishImport: () => void = () => {};
  let markImportStarted: () => void = () => {};
  const importStarted = new Promise<void>(resolve => {
    markImportStarted = resolve;
  });
  const importCanFinish = new Promise<void>(resolve => {
    finishImport = resolve;
  });
  const { controller, domain, projectLibrary } = createControllerHarness({
    loadedSnapshot: openedProject,
    projectLibrary: {
      importProjectArchive: async (_archive, targetProjectId) => {
        importedProjectId = targetProjectId;
        markImportStarted();
        await importCanFinish;
        return {
          meta: buildMeta(targetProjectId),
          snapshot: { ...archivedSnapshot, id: targetProjectId },
        };
      },
    },
  });

  const startPromise = controller.startHomeChat({
    input: 'Importa questo corso',
    selectedFile: archiveFile,
  });
  await importStarted;
  const cancellation = controller.cancelAssessment();
  finishImport();
  await cancellation;
  expect((await controller.openProject(openedProject.id)).outcome).toBe('opened');

  assert.equal((await startPromise).outcome, 'abandoned');
  assert.deepEqual(projectLibrary.deletedProjectIds, [importedProjectId]);
  assert.equal(projectLibrary.adapter.currentProjectId, openedProject.id);
  assert.equal(domain.learningPlan?.title, 'Progetto più recente');
});

test('cancelAssessment suppresses and cancels a late startHomeChat interview snapshot', async () => {
  let resolveInterview: (snapshot: CourseInterviewSnapshot) => void = () => {};
  let markInterviewStarted: () => void = () => {};
  const interviewStarted = new Promise<void>(resolve => {
    markInterviewStarted = resolve;
  });
  const interview = new Promise<CourseInterviewSnapshot>(resolve => {
    resolveInterview = resolve;
  });
  const cancelCourseInterview = vi.fn(
    async (
      _input: Parameters<
        typeof import('../../../services/openrouter/index.ts').cancelCourseInterview
      >[0]
    ) => {}
  );
  const { controller, projectLibrary, state } = createControllerHarness({
    openRouter: {
      cancelCourseInterview,
      getActiveCourseInterview: async () => null,
      startCourseInterview: async (_input, options) => {
        options?.onRunStarted?.('interview-run');
        markInterviewStarted();
        return interview;
      },
    },
  });

  const startPromise = controller.startHomeChat({ input: 'Voglio imparare crittografia' });
  await interviewStarted;

  const cancellation = controller.cancelAssessment();
  const projectId = projectLibrary.persistedSnapshots[0]?.id;
  assert.ok(projectId);
  await vi.waitFor(() => {
    assert.equal(cancelCourseInterview.mock.calls.length, 1);
  });
  resolveInterview(createInterviewSnapshot({ projectId }));
  await cancellation;
  const result = await startPromise;

  expect(result.outcome).toBe('abandoned');
  assert.deepEqual(cancelCourseInterview.mock.calls[0]?.[0], {
    projectId,
    runId: 'interview-run',
  });
  assert.equal(cancelCourseInterview.mock.calls.length, 1);
  assert.deepEqual(projectLibrary.deletedProjectIds, [projectId]);
  assert.deepEqual(state.internalState.assessmentMessages, []);
  assert.equal(projectLibrary.adapter.currentProjectId, null);
});

test('startHomeChat retains its draft for cleanup after a late cancellation failure', async () => {
  let resolveInterview: (snapshot: CourseInterviewSnapshot) => void = () => {};
  let markInterviewStarted: () => void = () => {};
  const interviewStarted = new Promise<void>(resolve => {
    markInterviewStarted = resolve;
  });
  const interview = new Promise<CourseInterviewSnapshot>(resolve => {
    resolveInterview = resolve;
  });
  let shouldExposeActiveInterview = false;
  let retryProjectId: string | null = null;
  let interviewStartCount = 0;
  const cancelCourseInterview = vi.fn(async () => {
    if (!shouldExposeActiveInterview) {
      shouldExposeActiveInterview = true;
      throw new Error('network unavailable');
    }
  });
  const { controller, projectLibrary, state } = createControllerHarness({
    openRouter: {
      cancelCourseInterview,
      getActiveCourseInterview: async projectId =>
        shouldExposeActiveInterview && retryProjectId === projectId
          ? createInterviewSnapshot({ projectId: retryProjectId })
          : null,
      startCourseInterview: async (input, options) => {
        interviewStartCount += 1;
        if (interviewStartCount > 1) {
          return createInterviewSnapshot({
            projectId: input.projectId,
            result: { kind: 'cancelled', projectId: input.projectId },
            status: 'completed',
          });
        }
        options?.onRunStarted?.('interview-run');
        markInterviewStarted();
        return interview;
      },
    },
  });

  const startPromise = controller.startHomeChat({ input: 'Voglio imparare crittografia' });
  await interviewStarted;
  const cancellation = controller.cancelAssessment();
  const projectId = projectLibrary.persistedSnapshots[0]?.id;
  assert.ok(projectId);
  retryProjectId = projectId;
  const cancellationFailure = expect(cancellation).rejects.toThrow(
    t('Operazione non riuscita. Riprova.')
  );
  resolveInterview(createInterviewSnapshot({ projectId }));
  const result = await startPromise;
  await cancellationFailure;

  assert.equal(result.outcome, 'failed');
  assert.equal(result.errorMessage, undefined);
  assert.deepEqual(projectLibrary.deletedProjectIds, []);
  assert.deepEqual(state.internalState.assessmentMessages, []);
  assert.equal(projectLibrary.adapter.currentProjectId, projectId);
  assert.equal(state.internalState.workflowState.assessment.status, 'pending');
  assert.equal(cancelCourseInterview.mock.calls.length, 1);

  projectLibrary.adapter.setCurrentProjectId('other-project');
  const nextStart = await controller.startHomeChat({ input: 'Voglio imparare algebra' });

  assert.equal(cancelCourseInterview.mock.calls.length, 2);
  expect(cancelCourseInterview).toHaveBeenLastCalledWith({
    projectId,
    runId: 'interview-run',
  });
  assert.equal(
    projectLibrary.deletedProjectIds.some(deletedId => deletedId === projectId),
    true
  );
  assert.equal(nextStart.outcome, 'abandoned');
  assert.equal(interviewStartCount, 2);
  assert.equal(projectLibrary.adapter.currentProjectId, null);
  assert.equal(state.internalState.workflowState.assessment.status, 'succeeded');
});

test('cancelAssessment accepts a terminal late start after idempotent cancellation', async () => {
  let resolveInterview: (snapshot: CourseInterviewSnapshot) => void = () => {};
  let markInterviewStarted: () => void = () => {};
  const interviewStarted = new Promise<void>(resolve => {
    markInterviewStarted = resolve;
  });
  const interview = new Promise<CourseInterviewSnapshot>(resolve => {
    resolveInterview = resolve;
  });
  const cancelCourseInterview = vi.fn(async () => {});
  const { controller, projectLibrary, state } = createControllerHarness({
    openRouter: {
      cancelCourseInterview,
      getActiveCourseInterview: async () => null,
      startCourseInterview: async (_input, options) => {
        options?.onRunStarted?.('interview-run');
        markInterviewStarted();
        return interview;
      },
    },
  });

  const startPromise = controller.startHomeChat({ input: 'Voglio imparare crittografia' });
  await interviewStarted;
  const cancellation = controller.cancelAssessment();
  const projectId = projectLibrary.persistedSnapshots[0]?.id;
  assert.ok(projectId);
  resolveInterview(
    createInterviewSnapshot({
      projectId,
      result: { kind: 'cancelled', projectId },
      status: 'completed',
    })
  );

  await cancellation;
  const result = await startPromise;

  expect(result.outcome).toBe('abandoned');
  assert.equal(cancelCourseInterview.mock.calls.length, 1);
  assert.deepEqual(projectLibrary.deletedProjectIds, [projectId]);
  assert.equal(state.internalState.workflowState.assessment.status, 'idle');
  assert.equal(projectLibrary.adapter.currentProjectId, null);
});

test.each([
  'failed',
  'missing',
] as const)('cancelAssessment clears a Home chat draft after a %s reopen attempt', async openOutcome => {
  let resolveInterview: (snapshot: CourseInterviewSnapshot) => void = () => {};
  let markInterviewStarted: () => void = () => {};
  const interviewStarted = new Promise<void>(resolve => {
    markInterviewStarted = resolve;
  });
  const interview = new Promise<CourseInterviewSnapshot>(resolve => {
    resolveInterview = resolve;
  });
  const cancelCourseInterview = vi.fn(async () => {});
  const { controller, projectLibrary, state } = createControllerHarness({
    openRouter: {
      cancelCourseInterview,
      getActiveCourseInterview: async () => null,
      startCourseInterview: async (_input, options) => {
        options?.onRunStarted?.('interview-run');
        markInterviewStarted();
        return interview;
      },
    },
    projectLibrary: {
      loadStoredProject: async () => {
        if (openOutcome === 'failed') throw new Error('open failed');
        return null;
      },
    },
  });

  const startPromise = controller.startHomeChat({ input: 'Voglio imparare crittografia' });
  await interviewStarted;
  const draftProjectId = projectLibrary.persistedSnapshots[0]?.id;
  assert.ok(draftProjectId);
  state.adapter.setAssessmentMessages([{ role: 'model', text: 'Domanda in corso' }]);

  const openResult = await controller.openProject(draftProjectId);
  const cancellation = controller.cancelAssessment();
  await vi.waitFor(() => expect(cancelCourseInterview).toHaveBeenCalledOnce());
  resolveInterview(
    createInterviewSnapshot({
      projectId: draftProjectId,
      result: { kind: 'cancelled', projectId: draftProjectId },
      status: 'cancelled',
      wait: null,
    })
  );
  const [startResult] = await Promise.all([startPromise, cancellation]);

  assert.equal(openResult.outcome, openOutcome);
  assert.equal(startResult.outcome, 'abandoned');
  assert.equal(state.internalState.workflowState.assessment.status, 'idle');
  assert.deepEqual(state.internalState.assessmentMessages, []);
  assert.equal(projectLibrary.adapter.currentProjectId, null);
  assert.equal(projectLibrary.deletedProjectIds.includes(draftProjectId), true);
});

test.each([
  'failed',
  'missing',
] as const)('cancelAssessment clears Home chat when a post-Stop open finishes %s', async openOutcome => {
  let resolveInterview: (snapshot: CourseInterviewSnapshot) => void = () => {};
  let markInterviewStarted: () => void = () => {};
  let resolveProjectOpen: (snapshot: null) => void = () => {};
  let rejectProjectOpen: (error: Error) => void = () => {};
  const interviewStarted = new Promise<void>(resolve => {
    markInterviewStarted = resolve;
  });
  const interview = new Promise<CourseInterviewSnapshot>(resolve => {
    resolveInterview = resolve;
  });
  const projectOpen = new Promise<null>((resolve, reject) => {
    resolveProjectOpen = resolve;
    rejectProjectOpen = reject;
  });
  const cancelCourseInterview = vi.fn(async () => {});
  const loadStoredProject = vi.fn(async () => projectOpen);
  const { controller, projectLibrary, state } = createControllerHarness({
    openRouter: {
      cancelCourseInterview,
      getActiveCourseInterview: async () => null,
      startCourseInterview: async (_input, options) => {
        options?.onRunStarted?.('interview-run');
        markInterviewStarted();
        return interview;
      },
    },
    projectLibrary: { loadStoredProject },
  });

  const startPromise = controller.startHomeChat({ input: 'Voglio imparare crittografia' });
  await interviewStarted;
  const draftProjectId = projectLibrary.persistedSnapshots[0]?.id;
  assert.ok(draftProjectId);
  state.adapter.setAssessmentMessages([{ role: 'model', text: 'Domanda in corso' }]);

  const cancellation = controller.cancelAssessment();
  const opening = controller.openProject('other-project');
  await vi.waitFor(() => expect(loadStoredProject).toHaveBeenCalledOnce());
  if (openOutcome === 'failed') rejectProjectOpen(new Error('open failed'));
  else resolveProjectOpen(null);
  assert.equal((await opening).outcome, openOutcome);
  resolveInterview(
    createInterviewSnapshot({
      projectId: draftProjectId,
      result: { kind: 'cancelled', projectId: draftProjectId },
      status: 'cancelled',
      wait: null,
    })
  );
  const [startResult] = await Promise.all([startPromise, cancellation]);

  assert.equal(startResult.outcome, 'abandoned');
  assert.equal(state.internalState.workflowState.assessment.status, 'idle');
  assert.deepEqual(state.internalState.assessmentMessages, []);
  assert.equal(projectLibrary.adapter.currentProjectId, null);
  assert.equal(projectLibrary.deletedProjectIds.includes(draftProjectId), true);
});

test.each([
  { expectedDraftDeletion: false, target: 'draft' },
  { expectedDraftDeletion: true, target: 'other-project' },
] as const)('cancelAssessment preserves a successful $target open after Stop', async scenario => {
  let resolveInterview: (snapshot: CourseInterviewSnapshot) => void = () => {};
  let markInterviewStarted: () => void = () => {};
  let resolveProjectOpen: (snapshot: ProjectSnapshot) => void = () => {};
  let markProjectOpenStarted: () => void = () => {};
  const interviewStarted = new Promise<void>(resolve => {
    markInterviewStarted = resolve;
  });
  const interview = new Promise<CourseInterviewSnapshot>(resolve => {
    resolveInterview = resolve;
  });
  const projectOpenStarted = new Promise<void>(resolve => {
    markProjectOpenStarted = resolve;
  });
  const projectOpen = new Promise<ProjectSnapshot>(resolve => {
    resolveProjectOpen = resolve;
  });
  const reopenedPlan = buildPlan({
    sections: [
      buildTestLesson({
        content: 'Contenuto pronto',
        description: 'Intro',
        id: 'lesson-reopened-after-stop',
        title: 'Lezione riaperta',
      }),
    ],
  });
  const cancelCourseInterview = vi.fn(async () => {});
  const { controller, projectLibrary, state } = createControllerHarness({
    openRouter: {
      cancelCourseInterview,
      getActiveCourseInterview: async () => null,
      startCourseInterview: async (_input, options) => {
        options?.onRunStarted?.('interview-run');
        markInterviewStarted();
        return interview;
      },
    },
    projectLibrary: {
      loadStoredProject: async () => {
        markProjectOpenStarted();
        return projectOpen;
      },
    },
  });

  const startPromise = controller.startHomeChat({ input: 'Voglio imparare crittografia' });
  await interviewStarted;
  const draftProjectId = projectLibrary.persistedSnapshots[0]?.id;
  assert.ok(draftProjectId);
  const targetProjectId = scenario.target === 'draft' ? draftProjectId : scenario.target;

  const opening = controller.openProject(targetProjectId);
  await projectOpenStarted;
  const cancellation = controller.cancelAssessment();
  await vi.waitFor(() => expect(cancelCourseInterview).toHaveBeenCalledOnce());
  assert.equal(projectLibrary.deletedProjectIds.includes(draftProjectId), false);
  resolveProjectOpen(
    createProjectSnapshot({
      id: targetProjectId,
      learningPlan: reopenedPlan,
      state: AppState.READING,
    })
  );
  const openResult = await opening;
  resolveInterview(
    createInterviewSnapshot({
      projectId: draftProjectId,
      result: { kind: 'cancelled', projectId: draftProjectId },
      status: 'cancelled',
      wait: null,
    })
  );
  const [startResult] = await Promise.all([startPromise, cancellation]);

  assert.equal(openResult.outcome, 'opened');
  assert.equal(startResult.outcome, 'abandoned');
  assert.equal(
    projectLibrary.deletedProjectIds.includes(draftProjectId),
    scenario.expectedDraftDeletion
  );
  assert.equal(projectLibrary.adapter.currentProjectId, targetProjectId);
  assert.equal(state.internalState.screenState, AppState.READING);
});

test('cancelAssessment preserves the successful reopen when draft opens overlap', async () => {
  let resolveInterview: (snapshot: CourseInterviewSnapshot) => void = () => {};
  let markInterviewStarted: () => void = () => {};
  let resolveFirstOpen: (snapshot: ProjectSnapshot) => void = () => {};
  let resolveSecondOpen: (snapshot: ProjectSnapshot) => void = () => {};
  const interviewStarted = new Promise<void>(resolve => {
    markInterviewStarted = resolve;
  });
  const interview = new Promise<CourseInterviewSnapshot>(resolve => {
    resolveInterview = resolve;
  });
  const firstOpen = new Promise<ProjectSnapshot>(resolve => {
    resolveFirstOpen = resolve;
  });
  const secondOpen = new Promise<ProjectSnapshot>(resolve => {
    resolveSecondOpen = resolve;
  });
  const reopenedPlan = buildPlan({
    sections: [
      buildTestLesson({
        content: 'Contenuto pronto',
        description: 'Intro',
        id: 'lesson-overlapping-reopen',
        title: 'Lezione riaperta',
      }),
    ],
  });
  const cancelCourseInterview = vi.fn(async () => {});
  const loadStoredProject = vi
    .fn<WorkspaceProjectLibraryAdapter['loadStoredProject']>()
    .mockImplementationOnce(async () => firstOpen)
    .mockImplementationOnce(async () => secondOpen);
  const { controller, projectLibrary } = createControllerHarness({
    openRouter: {
      cancelCourseInterview,
      getActiveCourseInterview: async () => null,
      startCourseInterview: async (_input, options) => {
        options?.onRunStarted?.('interview-run');
        markInterviewStarted();
        return interview;
      },
    },
    projectLibrary: {
      loadStoredProject,
      validateStoredProjectForOpen: async projectId => ({
        revision: 1,
        snapshot: createProjectSnapshot({
          id: projectId,
          learningPlan: reopenedPlan,
          state: AppState.READING,
        }),
      }),
    },
  });

  const startPromise = controller.startHomeChat({ input: 'Voglio imparare crittografia' });
  await interviewStarted;
  const draftProjectId = projectLibrary.persistedSnapshots[0]?.id;
  assert.ok(draftProjectId);

  const firstOpening = controller.openProject(draftProjectId);
  await vi.waitFor(() => expect(loadStoredProject).toHaveBeenCalledTimes(1));
  const secondOpening = controller.openProject(draftProjectId);
  await vi.waitFor(() => expect(loadStoredProject).toHaveBeenCalledTimes(2));
  const cancellation = controller.cancelAssessment();
  await vi.waitFor(() => expect(cancelCourseInterview).toHaveBeenCalledOnce());

  const reopenedSnapshot = createProjectSnapshot({
    id: draftProjectId,
    learningPlan: reopenedPlan,
    state: AppState.READING,
  });
  resolveFirstOpen(reopenedSnapshot);
  assert.equal((await firstOpening).outcome, 'stale');
  resolveSecondOpen(reopenedSnapshot);
  assert.equal((await secondOpening).outcome, 'opened');
  resolveInterview(
    createInterviewSnapshot({
      projectId: draftProjectId,
      result: { kind: 'cancelled', projectId: draftProjectId },
      status: 'cancelled',
      wait: null,
    })
  );
  const [startResult] = await Promise.all([startPromise, cancellation]);

  assert.equal(startResult.outcome, 'abandoned');
  assert.equal(projectLibrary.deletedProjectIds.includes(draftProjectId), false);
  assert.equal(projectLibrary.adapter.currentProjectId, draftProjectId);
});

test('cancelAssessment preserves a project whose open predates Home chat', async () => {
  let resolveInterview: (snapshot: CourseInterviewSnapshot) => void = () => {};
  let markInterviewStarted: () => void = () => {};
  let resolveProjectOpen: (snapshot: ProjectSnapshot) => void = () => {};
  let markProjectOpenStarted: () => void = () => {};
  const interviewStarted = new Promise<void>(resolve => {
    markInterviewStarted = resolve;
  });
  const interview = new Promise<CourseInterviewSnapshot>(resolve => {
    resolveInterview = resolve;
  });
  const projectOpenStarted = new Promise<void>(resolve => {
    markProjectOpenStarted = resolve;
  });
  const projectOpen = new Promise<ProjectSnapshot>(resolve => {
    resolveProjectOpen = resolve;
  });
  const targetProject = createProjectSnapshot({
    id: 'project-opening-before-home',
    learningPlan: buildPlan(),
    state: AppState.READING,
  });
  const cancelCourseInterview = vi.fn(async () => {});
  const { controller, projectLibrary, state } = createControllerHarness({
    openRouter: {
      cancelCourseInterview,
      getActiveCourseInterview: async () => null,
      startCourseInterview: async (_input, options) => {
        options?.onRunStarted?.('interview-run');
        markInterviewStarted();
        return interview;
      },
    },
    projectLibrary: {
      loadStoredProject: async () => {
        markProjectOpenStarted();
        return projectOpen;
      },
    },
  });

  const opening = controller.openProject(targetProject.id);
  await projectOpenStarted;
  const startPromise = controller.startHomeChat({ input: 'Voglio imparare crittografia' });
  await interviewStarted;
  const draftProjectId = projectLibrary.persistedSnapshots[0]?.id;
  assert.ok(draftProjectId);
  resolveProjectOpen(targetProject);
  assert.equal((await opening).outcome, 'opened');

  const cancellation = controller.cancelAssessment();
  await vi.waitFor(() => expect(cancelCourseInterview).toHaveBeenCalledOnce());
  resolveInterview(
    createInterviewSnapshot({
      messages: [{ role: 'model', text: 'Risposta fantasma' }],
      projectId: draftProjectId,
      result: { kind: 'cancelled', projectId: draftProjectId },
      status: 'cancelled',
      wait: null,
    })
  );
  const [startResult] = await Promise.all([startPromise, cancellation]);

  assert.equal(startResult.outcome, 'abandoned');
  assert.equal(projectLibrary.deletedProjectIds.includes(draftProjectId), true);
  assert.equal(projectLibrary.adapter.currentProjectId, targetProject.id);
  assert.equal(state.internalState.screenState, AppState.READING);
  assert.equal(
    state.internalState.assessmentMessages.some(message => message.text === 'Risposta fantasma'),
    false
  );
});

test('cancelAssessment preserves a draft reopened while cancellation is settling', async () => {
  let resolveInterview: (snapshot: CourseInterviewSnapshot) => void = () => {};
  let markInterviewStarted: () => void = () => {};
  let finishCancellation: () => void = () => {};
  const interviewStarted = new Promise<void>(resolve => {
    markInterviewStarted = resolve;
  });
  const interview = new Promise<CourseInterviewSnapshot>(resolve => {
    resolveInterview = resolve;
  });
  const cancellationCanFinish = new Promise<void>(resolve => {
    finishCancellation = resolve;
  });
  const reopenedPlan = buildPlan({
    sections: [
      buildTestLesson({
        content: 'Contenuto pronto',
        description: 'Intro',
        id: 'lesson-reopened',
        title: 'Lezione riaperta',
      }),
    ],
  });
  const cancelCourseInterview = vi.fn(async () => cancellationCanFinish);
  const { controller, projectLibrary, state } = createControllerHarness({
    openRouter: {
      cancelCourseInterview,
      getActiveCourseInterview: async () => null,
      startCourseInterview: async (_input, options) => {
        options?.onRunStarted?.('interview-run');
        markInterviewStarted();
        return interview;
      },
    },
    projectLibrary: {
      loadStoredProject: async projectId =>
        createProjectSnapshot({
          id: projectId,
          learningPlan: reopenedPlan,
          state: AppState.READING,
        }),
    },
  });

  const startPromise = controller.startHomeChat({ input: 'Voglio imparare crittografia' });
  await interviewStarted;
  const draftProjectId = projectLibrary.persistedSnapshots[0]?.id;
  assert.ok(draftProjectId);

  const cancellation = controller.cancelAssessment();
  await vi.waitFor(() => expect(cancelCourseInterview).toHaveBeenCalledOnce());
  const openResult = await controller.openProject(draftProjectId);
  finishCancellation();
  resolveInterview(
    createInterviewSnapshot({
      projectId: draftProjectId,
      result: { kind: 'cancelled', projectId: draftProjectId },
      status: 'completed',
    })
  );
  const [startResult] = await Promise.all([startPromise, cancellation]);

  assert.equal(openResult.outcome, 'opened');
  assert.equal(startResult.outcome, 'abandoned');
  assert.equal(projectLibrary.adapter.currentProjectId, draftProjectId);
  assert.equal(state.internalState.screenState, AppState.READING);
  assert.equal(projectLibrary.deletedProjectIds.includes(draftProjectId), false);
});

test('cancelAssessment preserves a draft reopened before Stop settles the original start', async () => {
  let resolveInterview: (snapshot: CourseInterviewSnapshot) => void = () => {};
  let markInterviewStarted: () => void = () => {};
  const interviewStarted = new Promise<void>(resolve => {
    markInterviewStarted = resolve;
  });
  const interview = new Promise<CourseInterviewSnapshot>(resolve => {
    resolveInterview = resolve;
  });
  const reopenedPlan = buildPlan({
    sections: [
      buildTestLesson({
        content: 'Contenuto pronto',
        description: 'Intro',
        id: 'lesson-reopened-before-stop',
        title: 'Lezione riaperta',
      }),
    ],
  });
  const cancelCourseInterview = vi.fn(async () => {});
  const { controller, projectLibrary, state } = createControllerHarness({
    openRouter: {
      cancelCourseInterview,
      getActiveCourseInterview: async () => null,
      startCourseInterview: async (_input, options) => {
        options?.onRunStarted?.('interview-run');
        markInterviewStarted();
        return interview;
      },
    },
    projectLibrary: {
      loadStoredProject: async projectId =>
        createProjectSnapshot({
          id: projectId,
          learningPlan: reopenedPlan,
          state: AppState.READING,
        }),
    },
  });

  const startPromise = controller.startHomeChat({ input: 'Voglio imparare crittografia' });
  await interviewStarted;
  const draftProjectId = projectLibrary.persistedSnapshots[0]?.id;
  assert.ok(draftProjectId);

  const openResult = await controller.openProject(draftProjectId);
  const cancellation = controller.cancelAssessment();
  await vi.waitFor(() => expect(cancelCourseInterview).toHaveBeenCalledOnce());
  resolveInterview(
    createInterviewSnapshot({
      projectId: draftProjectId,
      result: { kind: 'cancelled', projectId: draftProjectId },
      status: 'completed',
    })
  );
  const [startResult] = await Promise.all([startPromise, cancellation]);

  assert.equal(openResult.outcome, 'opened');
  assert.equal(startResult.outcome, 'abandoned');
  assert.equal(projectLibrary.adapter.currentProjectId, draftProjectId);
  assert.equal(state.internalState.screenState, AppState.READING);
  assert.equal(projectLibrary.deletedProjectIds.includes(draftProjectId), false);
});

test('startHomeChat starts a durable interview with the visible user message', async () => {
  const startCourseInterview = vi.fn(
    async (
      input: Parameters<
        typeof import('../../../services/openrouter/index.ts').startCourseInterview
      >[0]
    ) =>
      createInterviewSnapshot({
        messages: [
          { role: 'user', text: input.initialMessage || '' },
          { role: 'model', text: 'Profilazione' },
        ],
        projectId: input.projectId,
      })
  );
  const { controller, state } = createControllerHarness({
    openRouter: { startCourseInterview },
  });

  const result = await controller.startHomeChat({
    input: 'Vorrei capire meglio come studiare',
    toolPreferences: { mode: 'new-course', newCourse: true },
  });

  assert.equal(result.outcome, 'continued');
  assert.equal(
    state.internalState.assessmentMessages[0]?.text,
    'Vorrei capire meglio come studiare'
  );
  const startInput = startCourseInterview.mock.calls[0]?.[0];
  assert.equal(startInput?.initialMessage, 'Vorrei capire meglio come studiare');
  assert.equal(startInput?.mode, 'learn');
  assert.equal(startInput?.hasReliableSourceContext, false);
});

test('startHomeChat resumes the authoritative active interview instead of starting another', async () => {
  const startCourseInterview = vi.fn();
  const active = createInterviewSnapshot({
    messages: [{ role: 'model', text: 'Intervista ripresa' }],
    projectId: 'active-project',
  });
  const { controller, state } = createControllerHarness({
    openRouter: {
      getActiveCourseInterview: async projectId => ({ ...active, projectId }),
      startCourseInterview,
    },
  });

  const result = await controller.startHomeChat({ input: 'Continuiamo' });

  assert.equal(result.outcome, 'continued');
  assert.deepEqual(state.internalState.assessmentMessages, active.messages);
  assert.equal(startCourseInterview.mock.calls.length, 0);
});

test('startHomeChat removes a new draft when interview creation is definitively rejected', async () => {
  const { controller, projectLibrary, state } = createControllerHarness({
    openRouter: {
      getActiveCourseInterview: async () => null,
      startCourseInterview: async () => {
        throw new Error('runtime unavailable');
      },
    },
  });

  const result = await controller.startHomeChat({ input: 'Voglio imparare crittografia' });

  assert.equal(result.outcome, 'failed');
  assert.equal(projectLibrary.deletedProjectIds.length, 1);
  assert.equal(projectLibrary.adapter.currentProjectId, null);
  assert.equal(state.internalState.screenState, AppState.LIBRARY);
});

test('startHomeChat preserves a recoverable draft when interview ownership is uncertain', async () => {
  let activeLookupCount = 0;
  const { controller, projectLibrary } = createControllerHarness({
    openRouter: {
      getActiveCourseInterview: async () => {
        activeLookupCount += 1;
        if (activeLookupCount === 1) return null;
        throw new Error('network unavailable');
      },
      startCourseInterview: async () => {
        throw new Error('poll interrupted');
      },
    },
  });

  const result = await controller.startHomeChat({ input: 'Voglio imparare crittografia' });

  assert.equal(result.outcome, 'failed');
  assert.deepEqual(projectLibrary.deletedProjectIds, []);
});

test('startHomeChat clears client state after semantic cancellation by the model', async () => {
  const { controller, domain, projectLibrary, state } = createControllerHarness({
    openRouter: {
      startCourseInterview: async input =>
        createInterviewSnapshot({
          messages: [{ role: 'model', text: 'Intervista annullata.' }],
          projectId: input.projectId,
          result: { kind: 'cancelled', projectId: input.projectId },
          status: 'completed',
          wait: null,
        }),
    },
  });

  const result = await controller.startHomeChat({ input: 'Ho aperto questo flusso per errore' });

  assert.equal(result.outcome, 'abandoned');
  assert.equal(projectLibrary.adapter.currentProjectId, null);
  assert.equal(domain.userProfile, null);
  assert.deepEqual(state.internalState.assessmentMessages, []);
});

test('startHomeChat saves a ZIP before assessment and uses only the server index', async () => {
  const canonicalEntry = {
    byteSize: 18,
    contentKind: 'text' as const,
    kind: 'file' as const,
    path: 'docs/server.md',
    preview: '# Server index',
  };
  let persistedWrites = 0;
  let assessmentText = '';
  const { controller, domain } = createControllerHarness({
    openRouter: {
      buildAssessmentDocumentContextFromTextSource: source => {
        assessmentText = source.text;
        return { content: source.text, hasReliableSourceContext: true };
      },
    },
    projectLibrary: {
      persistSnapshot: async (snapshot, options) => {
        persistedWrites += 1;
        assert.deepEqual(options, { archiveFile: uploadedFile, throwOnError: true });
        assert.equal(snapshot.source?.kind, 'archive');
        assert.deepEqual(
          snapshot.source?.kind === 'archive' ? snapshot.source.index.entries : [],
          []
        );
        if (snapshot.source?.kind !== 'archive') {
          throw new Error('Expected archive source');
        }
        return {
          meta: buildMeta(snapshot.id),
          snapshot: {
            ...snapshot,
            source: {
              ...snapshot.source,
              file: { ...snapshot.source.file, data: '' },
              index: { entries: [canonicalEntry] },
            },
          },
        };
      },
    },
  });

  const uploadedFile = new File(['opaque source archive'], 'engine.zip', {
    type: 'application/zip',
  });
  const result = await controller.startHomeChat({
    input: 'Voglio studiare questo motore',
    selectedFile: uploadedFile,
  });

  assert.equal(result.outcome, 'continued');
  assert.equal(result.errorMessage, undefined);
  assert.equal(persistedWrites, 1);
  assert.deepEqual(domain.source?.kind === 'archive' ? domain.source.index.entries : [], [
    canonicalEntry,
  ]);
  assert.equal(assessmentText.includes('docs/server.md'), true);
});

test('startHomeChat assesses extracted ZIP PDFs and reports each unusable PDF entry', async () => {
  const canonicalEntries = [
    {
      byteSize: 24,
      contentKind: 'text' as const,
      kind: 'file' as const,
      path: 'docs/dispensa.pdf',
      preview: 'Testo estratto dalla dispensa',
    },
    {
      byteSize: 128,
      contentKind: 'binary' as const,
      kind: 'file' as const,
      path: 'scansioni/allegato.pdf',
    },
    {
      byteSize: 64,
      contentKind: 'binary' as const,
      kind: 'file' as const,
      path: 'corrotti/non-leggibile.PDF',
    },
    {
      byteSize: 16,
      contentKind: 'text' as const,
      kind: 'file' as const,
      path: 'note.txt',
      preview: 'Note valide',
    },
  ];
  let assessmentText = '';
  const { controller } = createControllerHarness({
    openRouter: {
      buildAssessmentDocumentContextFromTextSource: source => {
        assessmentText = source.text;
        return { content: source.text, hasReliableSourceContext: true };
      },
    },
    projectLibrary: {
      persistSnapshot: async snapshot => {
        if (snapshot.source?.kind !== 'archive') {
          throw new Error('Expected archive source');
        }
        return {
          meta: buildMeta(snapshot.id),
          snapshot: {
            ...snapshot,
            source: {
              ...snapshot.source,
              index: { entries: canonicalEntries },
            },
          },
        };
      },
    },
  });

  const result = await controller.startHomeChat({
    input: 'Preparami un corso da questo archivio',
    selectedFile: new File(['opaque archive'], 'materiali.zip', { type: 'application/zip' }),
  });

  expect(result.outcome).toBe('continued');
  expect(result.sourceWarnings).toEqual([
    {
      message: 'Questa fonte non contiene testo PDF utilizzabile.',
      name: 'scansioni/allegato.pdf',
      reason: 'no-usable-text',
    },
    {
      message: 'Questa fonte non contiene testo PDF utilizzabile.',
      name: 'corrotti/non-leggibile.PDF',
      reason: 'no-usable-text',
    },
  ]);
  expect(assessmentText).toContain('docs/dispensa.pdf');
  expect(assessmentText).toContain('Testo estratto dalla dispensa');
  expect(assessmentText).toContain('scansioni/allegato.pdf');
  expect(assessmentText).toContain('note.txt');
});

test('startHomeChat rejects a ZIP when every PDF entry is unusable', async () => {
  const sourceWarnings = [
    {
      message: 'Questa fonte non contiene testo PDF utilizzabile.',
      name: 'scansioni/allegato.pdf',
      reason: 'no-usable-text' as const,
    },
    {
      message: 'Questa fonte non contiene testo PDF utilizzabile.',
      name: 'corrotti/non-leggibile.PDF',
      reason: 'no-usable-text' as const,
    },
  ];
  const buildAssessmentContext = vi.fn();
  const { controller, projectLibrary } = createControllerHarness({
    openRouter: {
      buildAssessmentDocumentContextFromTextSource: buildAssessmentContext,
    },
    projectLibrary: {
      persistSnapshot: async () => {
        throw new ProjectStorageError(
          'L’archivio non contiene alcun testo utilizzabile.',
          'source-archive-unusable',
          { sourceWarnings }
        );
      },
    },
  });

  const result = await controller.startHomeChat({
    input: 'Preparami un corso da questo archivio',
    selectedFile: new File(['opaque archive'], 'scansioni.zip', { type: 'application/zip' }),
  });

  expect(result.outcome).toBe('failed');
  expect(result.errorMessage).toBe('L’archivio non contiene alcun testo utilizzabile.');
  expect(result.sourceWarnings).toEqual(sourceWarnings);
  expect(buildAssessmentContext).not.toHaveBeenCalled();
  expect(projectLibrary.deletedProjectIds).toHaveLength(1);
  expect(projectLibrary.adapter.currentProjectId).toBeNull();
});

test('startHomeChat removes a new draft when ZIP preparation capacity is busy', async () => {
  const buildAssessmentContext = vi.fn();
  const { controller, domain, projectLibrary } = createControllerHarness({
    openRouter: {
      buildAssessmentDocumentContextFromTextSource: buildAssessmentContext,
    },
    projectLibrary: {
      persistSnapshot: async () => {
        throw new ProjectStorageError(
          'È già in corso la preparazione di un archivio ZIP. Riprova tra poco.',
          'source-archive-busy'
        );
      },
    },
  });

  const result = await controller.startHomeChat({
    input: 'Preparami un corso da questo archivio',
    selectedFile: new File(['opaque archive'], 'materiali.zip', { type: 'application/zip' }),
  });

  expect(result.outcome).toBe('failed');
  expect(result.errorMessage).toBe(
    'È già in corso la preparazione di un archivio ZIP. Riprova tra poco.'
  );
  expect(buildAssessmentContext).not.toHaveBeenCalled();
  expect(projectLibrary.deletedProjectIds).toHaveLength(1);
  expect(projectLibrary.adapter.currentProjectId).toBeNull();
  expect(domain.source).toBeNull();
});

test('startHomeChat reports each unusable source while continuing with valid material', async () => {
  const { controller } = createControllerHarness({
    openRouter: {
      validatePdfTextSource: async file => {
        if (file.name === 'scansione.pdf') {
          throw new Error('internal PDF extraction detail');
        }
        return null;
      },
      buildAssessmentDocumentContextFromSourceSet: sources => ({
        content: sources.map(source => source.name).join('\n'),
        hasReliableSourceContext: true,
      }),
    },
  });

  const result = await controller.startHomeChat({
    input: 'Preparami un corso combinando queste fonti',
    selectedFiles: [
      new File(['%PDF-1.4\n'], 'scansione.pdf', { type: 'application/pdf' }),
      new File(['# Materiale valido'], 'appunti.md', { type: 'text/markdown' }),
    ],
  });

  assert.equal(result.outcome, 'continued');
  assert.deepEqual(result.sourceWarnings, [
    {
      message: 'Questa fonte non contiene testo PDF utilizzabile.',
      name: 'scansione.pdf',
    },
  ]);
});

test('submitAssessment sends the durable user-answer signal and applies the proposal', async () => {
  vi.stubGlobal('location', new URL('https://nous.test/'));
  feedbackDiagnostics.clearFeedbackDiagnostics();
  try {
    feedbackDiagnostics.setFeedbackProductContext({
      project: { id: 'learn-project' },
      surface: 'assessment',
    });
    const sendCourseInterviewAnswer = vi.fn(
      async (
        _input: Parameters<
          typeof import('../../../services/openrouter/index.ts').sendCourseInterviewAnswer
        >[0]
      ) => createProposalSnapshot('learn-project')
    );
    const { controller, domain, state } = createControllerHarness({
      projectLibrary: {
        currentProjectId: 'learn-project',
      },
      openRouter: {
        getActiveCourseInterview: async () =>
          createInterviewSnapshot({ projectId: 'learn-project' }),
        sendCourseInterviewAnswer,
      },
    });

    const result = await controller.submitAssessment('Fammi imparare TypeScript');

    assert.equal(result.outcome, 'assessment-complete');
    assert.equal(state.internalState.courseProposal?.topic, 'TypeScript');
    assert.equal(domain.userProfile, null);
    assert.deepEqual(sendCourseInterviewAnswer.mock.calls[0]?.[0], {
      projectId: 'learn-project',
      runId: 'interview-run',
      text: 'Fammi imparare TypeScript',
      waitId: 'answer-wait',
    });
    assert.deepEqual(
      feedbackDiagnostics.getFeedbackDiagnosticsSnapshot().productContext?.workflow,
      {
        operation: 'assessment-interview',
        runId: 'interview-run',
        status: 'waiting',
      }
    );
  } finally {
    feedbackDiagnostics.clearFeedbackDiagnostics();
    vi.unstubAllGlobals();
  }
});

test('submitAssessment sends add-details when the durable proposal awaits a decision', async () => {
  const sendCourseInterviewDecision = vi.fn(
    async (
      _input: Parameters<
        typeof import('../../../services/openrouter/index.ts').sendCourseInterviewDecision
      >[0]
    ) => createProposalSnapshot('learn-project')
  );
  const { controller } = createControllerHarness({
    projectLibrary: { currentProjectId: 'learn-project' },
    openRouter: {
      getActiveCourseInterview: async () => createProposalSnapshot('learn-project'),
      sendCourseInterviewDecision,
    },
  });

  const result = await controller.submitAssessment('Aggiungi più esercizi pratici');

  assert.equal(result.outcome, 'assessment-complete');
  assert.deepEqual(sendCourseInterviewDecision.mock.calls[0]?.[0], {
    decision: { details: 'Aggiungi più esercizi pratici', kind: 'add-details' },
    projectId: 'learn-project',
    runId: 'interview-run',
    waitId: 'decision-wait',
  });
});

test('submitAssessment clears the old proposal when add-details opens another question', async () => {
  const { controller, domain, state } = createControllerHarness({
    projectLibrary: { currentProjectId: 'learn-project' },
    openRouter: {
      getActiveCourseInterview: async () => createProposalSnapshot('learn-project'),
      sendCourseInterviewDecision: async input =>
        createInterviewSnapshot({
          messages: [{ role: 'model', text: 'Quale tipo di esercizi preferisci?' }],
          projectId: input.projectId,
          wait: {
            expiresAt: '2026-08-09T10:00:00.000Z',
            signalType: 'user-answer',
            waitId: 'answer-wait-2',
          },
        }),
    },
  });
  state.adapter.setCourseProposal(createProposalSnapshot('learn-project').proposal);

  const result = await controller.submitAssessment('Aggiungi più esercizi pratici');

  assert.equal(result.outcome, 'continued');
  assert.equal(state.internalState.courseProposal, null);
  assert.equal(domain.userProfile, null);
});

test('cancelAssessment suppresses a late submitAssessment snapshot', async () => {
  let resolveInterview: (snapshot: CourseInterviewSnapshot) => void = () => {};
  let markRunDiscovered: () => void = () => {};
  const runDiscovered = new Promise<void>(resolve => {
    markRunDiscovered = resolve;
  });
  const interview = new Promise<CourseInterviewSnapshot>(resolve => {
    resolveInterview = resolve;
  });
  const getActiveCourseInterview = vi.fn(
    async (
      _projectId: string,
      options?: Parameters<
        typeof import('../../../services/openrouter/index.ts').getActiveCourseInterview
      >[1]
    ) => {
      options?.onRunStarted?.('interview-run');
      markRunDiscovered();
      return interview;
    }
  );
  const cancelCourseInterview = vi.fn(async () => {});
  const { controller, projectLibrary, state } = createControllerHarness({
    projectLibrary: { currentProjectId: 'learn-project' },
    openRouter: {
      cancelCourseInterview,
      getActiveCourseInterview,
    },
  });
  state.adapter.setAssessmentMessages([{ role: 'model', text: 'Prima domanda' }]);

  const submitPromise = controller.submitAssessment('Fammi imparare TypeScript');
  await runDiscovered;
  await controller.cancelAssessment();
  expect(cancelCourseInterview).toHaveBeenCalledWith({
    projectId: 'learn-project',
    runId: 'interview-run',
  });
  expect(getActiveCourseInterview).toHaveBeenCalledOnce();
  resolveInterview(
    createInterviewSnapshot({
      projectId: 'learn-project',
      result: { kind: 'cancelled', projectId: 'learn-project' },
      status: 'cancelled',
      wait: null,
    })
  );
  const result = await submitPromise;

  assert.equal(result.outcome, 'abandoned');
  assert.deepEqual(state.internalState.assessmentMessages, []);
  assert.equal(state.internalState.courseProposal, null);
  assert.equal(projectLibrary.adapter.currentProjectId, null);
});

test.each([
  'user-answer',
  'add-details',
] as const)('cancelAssessment aborts an in-flight %s follow-up request', async followUpKind => {
  let markSignalRequestStarted: () => void = () => {};
  const signalRequestStarted = new Promise<void>(resolve => {
    markSignalRequestStarted = resolve;
  });
  const sendSignal = vi.fn(
    (
      _input: unknown,
      options?: Parameters<
        typeof import('../../../services/openrouter/index.ts').sendCourseInterviewAnswer
      >[1]
    ): Promise<CourseInterviewSnapshot> => {
      const signal = options?.signal;
      if (!signal) return Promise.reject(new Error('Missing follow-up cancellation signal.'));
      markSignalRequestStarted();
      return new Promise((_resolve, reject) => {
        const rejectAbort = () => reject(new Error('Follow-up request aborted.'));
        if (signal.aborted) {
          rejectAbort();
          return;
        }
        signal.addEventListener('abort', rejectAbort, { once: true });
      });
    }
  );
  const getActiveCourseInterview = vi.fn(
    async (
      _projectId: string,
      options?: Parameters<
        typeof import('../../../services/openrouter/index.ts').getActiveCourseInterview
      >[1]
    ) => {
      options?.onRunStarted?.('interview-run');
      return followUpKind === 'user-answer'
        ? createInterviewSnapshot({ projectId: 'learn-project' })
        : createProposalSnapshot('learn-project');
    }
  );
  const cancelCourseInterview = vi.fn(async () => {});
  const sendCourseInterviewAnswer = vi.fn(
    (
      input: Parameters<
        typeof import('../../../services/openrouter/index.ts').sendCourseInterviewAnswer
      >[0],
      options?: Parameters<
        typeof import('../../../services/openrouter/index.ts').sendCourseInterviewAnswer
      >[1]
    ) => sendSignal(input, options)
  );
  const sendCourseInterviewDecision = vi.fn(
    (
      input: Parameters<
        typeof import('../../../services/openrouter/index.ts').sendCourseInterviewDecision
      >[0],
      options?: Parameters<
        typeof import('../../../services/openrouter/index.ts').sendCourseInterviewDecision
      >[1]
    ) => sendSignal(input, options)
  );
  const { controller } = createControllerHarness({
    projectLibrary: { currentProjectId: 'learn-project' },
    openRouter: {
      cancelCourseInterview,
      getActiveCourseInterview,
      sendCourseInterviewAnswer,
      sendCourseInterviewDecision,
    },
  });

  const submitPromise = controller.submitAssessment('Continua con questi dettagli');
  await signalRequestStarted;
  await controller.cancelAssessment();
  const result = await submitPromise;

  const expectedSender =
    followUpKind === 'user-answer' ? sendCourseInterviewAnswer : sendCourseInterviewDecision;
  const unexpectedSender =
    followUpKind === 'user-answer' ? sendCourseInterviewDecision : sendCourseInterviewAnswer;
  expect(expectedSender).toHaveBeenCalledOnce();
  expect(unexpectedSender).not.toHaveBeenCalled();
  expect(sendSignal.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  expect(getActiveCourseInterview.mock.calls[0]?.[1]?.signal).toBe(
    sendSignal.mock.calls[0]?.[1]?.signal
  );
  expect(cancelCourseInterview).toHaveBeenCalledWith({
    projectId: 'learn-project',
    runId: 'interview-run',
  });
  expect(result.outcome).toBe('abandoned');
});

test.each([
  'while-opening',
  'after-opened',
] as const)('cancelAssessment preserves a project %s during a pending Home follow-up', async stopTiming => {
  let resolveInterview: (snapshot: CourseInterviewSnapshot) => void = () => {};
  let markRunDiscovered: () => void = () => {};
  let resolveProjectOpen: (snapshot: ProjectSnapshot) => void = () => {};
  let markProjectOpenStarted: () => void = () => {};
  const runDiscovered = new Promise<void>(resolve => {
    markRunDiscovered = resolve;
  });
  const interview = new Promise<CourseInterviewSnapshot>(resolve => {
    resolveInterview = resolve;
  });
  const projectOpenStarted = new Promise<void>(resolve => {
    markProjectOpenStarted = resolve;
  });
  const projectOpen = new Promise<ProjectSnapshot>(resolve => {
    resolveProjectOpen = resolve;
  });
  const getActiveCourseInterview = vi.fn(
    async (
      _projectId: string,
      options?: Parameters<
        typeof import('../../../services/openrouter/index.ts').getActiveCourseInterview
      >[1]
    ) => {
      options?.onRunStarted?.('interview-run');
      markRunDiscovered();
      return interview;
    }
  );
  const cancelCourseInterview = vi.fn(async () => {});
  const targetProject = createProjectSnapshot({
    id: 'other-project',
    learningPlan: buildPlan(),
    state: AppState.READING,
  });
  const { controller, projectLibrary, state } = createControllerHarness({
    projectLibrary: {
      currentProjectId: 'learn-project',
      loadStoredProject: async () => {
        markProjectOpenStarted();
        return projectOpen;
      },
    },
    openRouter: {
      cancelCourseInterview,
      getActiveCourseInterview,
    },
  });
  state.adapter.setAssessmentMessages([{ role: 'model', text: 'Prima domanda' }]);

  const submitPromise = controller.submitAssessment('Fammi imparare TypeScript');
  await runDiscovered;
  const opening = controller.openProject(targetProject.id);
  await projectOpenStarted;
  let cancellation: Promise<void>;
  if (stopTiming === 'while-opening') {
    cancellation = controller.cancelAssessment();
    resolveProjectOpen(targetProject);
    assert.equal((await opening).outcome, 'opened');
  } else {
    resolveProjectOpen(targetProject);
    assert.equal((await opening).outcome, 'opened');
    cancellation = controller.cancelAssessment();
  }
  await vi.waitFor(() => expect(cancelCourseInterview).toHaveBeenCalledOnce());
  expect(cancelCourseInterview).toHaveBeenCalledWith({
    projectId: 'learn-project',
    runId: 'interview-run',
  });
  resolveInterview(
    createInterviewSnapshot({
      messages: [{ role: 'model', text: 'Risposta fantasma' }],
      projectId: 'learn-project',
      result: { kind: 'cancelled', projectId: 'learn-project' },
      status: 'cancelled',
      wait: null,
    })
  );
  const [submitResult] = await Promise.all([submitPromise, cancellation]);

  assert.equal(submitResult.outcome, 'abandoned');
  assert.equal(projectLibrary.adapter.currentProjectId, targetProject.id);
  assert.equal(state.internalState.screenState, AppState.READING);
  assert.equal(
    state.internalState.assessmentMessages.some(message => message.text === 'Risposta fantasma'),
    false
  );
});

test('cancelAssessment cancels a durable interview that is waiting for an answer', async () => {
  const cancelCourseInterview = vi.fn(
    async (
      _input: Parameters<
        typeof import('../../../services/openrouter/index.ts').cancelCourseInterview
      >[0]
    ) => {}
  );
  const { controller, domain, projectLibrary, state } = createControllerHarness({
    domain: {
      isLearnMode: true,
      domainState: {
        source: null,
        learningPlan: null,
        documentAssets: null,
        documentIndex: null,
        isLearnMode: true,
        userProfile: null,
        syllabus: [],
        activeSectionId: null,
      },
    },
    projectLibrary: {
      currentProjectId: 'accidental-course',
    },
    openRouter: {
      cancelCourseInterview,
      getActiveCourseInterview: async () =>
        createInterviewSnapshot({ projectId: 'accidental-course' }),
    },
  });
  state.adapter.setAssessmentMessages([{ role: 'model', text: 'Prima domanda' }]);

  await controller.cancelAssessment();

  assert.deepEqual(cancelCourseInterview.mock.calls[0]?.[0], {
    projectId: 'accidental-course',
    runId: 'interview-run',
  });
  assert.deepEqual(state.internalState.assessmentMessages, []);
  assert.equal(state.internalState.screenState, AppState.LIBRARY);
  assert.equal(projectLibrary.adapter.currentProjectId, null);
  assert.equal(domain.isLearnMode, false);
});

test('cancelAssessment preserves active state for a retry when cancellation fails', async () => {
  let cancellationAttempts = 0;
  const { controller, projectLibrary, state } = createControllerHarness({
    projectLibrary: { currentProjectId: 'accidental-course' },
    openRouter: {
      cancelCourseInterview: async () => {
        cancellationAttempts += 1;
        if (cancellationAttempts === 1) throw new Error('network unavailable');
      },
      getActiveCourseInterview: async () =>
        createInterviewSnapshot({ projectId: 'accidental-course' }),
    },
  });
  state.adapter.beginWorkflow('assessment', 'Valutazione risposta...');
  state.adapter.setAssessmentMessages([{ role: 'model', text: 'Prima domanda' }]);

  await expect(controller.cancelAssessment()).rejects.toThrow(
    t('Operazione non riuscita. Riprova.')
  );

  assert.equal(state.internalState.workflowState.assessment.status, 'pending');
  assert.deepEqual(state.internalState.assessmentMessages, [
    { role: 'model', text: 'Prima domanda' },
  ]);
  assert.equal(projectLibrary.adapter.currentProjectId, 'accidental-course');

  await controller.cancelAssessment();

  assert.equal(cancellationAttempts, 2);
  assert.deepEqual(state.internalState.assessmentMessages, []);
  assert.equal(projectLibrary.adapter.currentProjectId, null);
});

test('cancelAssessment coalesces duplicate cancellation requests', async () => {
  let finishCancellation: () => void = () => {};
  const cancellationCanFinish = new Promise<void>(resolve => {
    finishCancellation = resolve;
  });
  const cancelCourseInterview = vi.fn(async () => cancellationCanFinish);
  const { controller, state } = createControllerHarness({
    projectLibrary: { currentProjectId: 'accidental-course' },
    openRouter: {
      cancelCourseInterview,
      getActiveCourseInterview: async () =>
        createInterviewSnapshot({ projectId: 'accidental-course' }),
    },
  });

  const firstCancellation = controller.cancelAssessment();
  const duplicateCancellation = controller.cancelAssessment();

  assert.equal(duplicateCancellation, firstCancellation);
  assert.equal(state.internalState.workflowState.assessment.status, 'pending');
  await vi.waitFor(() => expect(cancelCourseInterview).toHaveBeenCalledOnce());
  finishCancellation();
  await Promise.all([firstCancellation, duplicateCancellation]);
  assert.equal(cancelCourseInterview.mock.calls.length, 1);
  assert.equal(state.internalState.workflowState.assessment.status, 'idle');
});

test('cancelAssessment sends the semantic cancel decision when a proposal is ready', async () => {
  const cancelCourseInterview = vi.fn();
  const sendCourseInterviewDecision = vi.fn(
    async (
      _input: Parameters<
        typeof import('../../../services/openrouter/index.ts').sendCourseInterviewDecision
      >[0]
    ) =>
      createInterviewSnapshot({
        messages: [],
        projectId: 'proposal-project',
        result: { kind: 'cancelled', projectId: 'proposal-project' },
        status: 'completed',
        wait: null,
      })
  );
  const { controller } = createControllerHarness({
    projectLibrary: { currentProjectId: 'proposal-project' },
    openRouter: {
      cancelCourseInterview,
      getActiveCourseInterview: async () => createProposalSnapshot('proposal-project'),
      sendCourseInterviewDecision,
    },
  });

  await controller.cancelAssessment();

  assert.deepEqual(sendCourseInterviewDecision.mock.calls[0]?.[0], {
    decision: { kind: 'cancel' },
    projectId: 'proposal-project',
    runId: 'interview-run',
    waitId: 'decision-wait',
  });
  assert.equal(cancelCourseInterview.mock.calls.length, 0);
});

test('submitAssessment exposes exhausted durable interviews as a controlled failure', async () => {
  const { controller } = createControllerHarness({
    projectLibrary: { currentProjectId: 'exhausted-project' },
    openRouter: {
      getActiveCourseInterview: async () =>
        createInterviewSnapshot({ projectId: 'exhausted-project' }),
      sendCourseInterviewAnswer: async () =>
        createInterviewSnapshot({
          messages: [],
          projectId: 'exhausted-project',
          result: { kind: 'exhausted', projectId: 'exhausted-project' },
          status: 'completed',
          wait: null,
        }),
    },
  });

  const result = await controller.submitAssessment('Un altro dettaglio');

  assert.equal(result.outcome, 'failed');
  assert.equal(result.errorMessage, 'L’intervista ha raggiunto il limite di sicurezza. Riprova.');
});

test('confirmPlanGeneration approves the durable proposal and resumes its course run', async () => {
  let completeDecision: (() => void) | undefined;
  const decisionGate = new Promise<void>(resolve => {
    completeDecision = resolve;
  });
  const resumeActiveDurableCourse = vi.fn(
    async (
      input: Parameters<
        typeof import('../../../services/openrouter/index.ts').resumeActiveDurableCourse
      >[0]
    ) => ({ firstSectionId: 'lesson-1', projectId: input.projectId, projectRevision: 4 })
  );
  const sendCourseInterviewDecision = vi.fn(
    async (
      _input: Parameters<
        typeof import('../../../services/openrouter/index.ts').sendCourseInterviewDecision
      >[0]
    ) => {
      await decisionGate;
      return createInterviewSnapshot({
        generationRunId: 'course-run-1',
        messages: [{ role: 'model', text: 'Proposta approvata' }],
        projectId: 'document-project',
        result: {
          generationRunId: 'course-run-1',
          kind: 'approved',
          projectId: 'document-project',
        },
        status: 'completed',
        wait: null,
      });
    }
  );
  const { controller, projectLibrary, state } = createControllerHarness({
    domain: {
      file: pdfFile,
      source: createProjectSourceFromFile(pdfFile),
      userProfile: interviewProfile,
    },
    projectLibrary: { currentProjectId: 'document-project' },
    openRouter: {
      getActiveCourseInterview: async () => createProposalSnapshot('document-project'),
      resumeActiveDurableCourse,
      sendCourseInterviewDecision,
    },
  });

  const generation = controller.confirmPlanGeneration();
  await vi.waitFor(() => assert.equal(sendCourseInterviewDecision.mock.calls.length, 1));

  assert.equal(state.internalState.screenState, AppState.PLANNING);
  assert.equal(state.internalState.workflowState.generatePlan.progress?.operation, 'plan');
  assert.equal(state.internalState.workflowState.generatePlan.progress?.stage, 'sources');

  completeDecision?.();
  const result = await generation;

  assert.equal(result.outcome, 'planned');
  assert.equal(state.internalState.screenState, AppState.READING);
  assert.deepEqual(sendCourseInterviewDecision.mock.calls[0]?.[0], {
    decision: { kind: 'approve' },
    projectId: 'document-project',
    runId: 'interview-run',
    waitId: 'decision-wait',
  });
  assert.equal(resumeActiveDurableCourse.mock.calls[0]?.[0].projectId, 'document-project');
  assert.deepEqual(state.internalState.assessmentMessages, [
    { role: 'model', text: 'Proposta approvata' },
  ]);
  assert.deepEqual(projectLibrary.appliedProjectRevisions, [
    { projectId: 'document-project', revision: 4 },
  ]);
});

test('confirmPlanGeneration resumes a reopened archive without downloading the ZIP', async () => {
  const archiveSource = {
    file: {
      data: '',
      mimeType: 'application/zip',
      name: 'engine.zip',
    },
    index: {
      entries: [
        {
          byteSize: 24,
          contentKind: 'text' as const,
          kind: 'file' as const,
          path: 'src/main.ts',
          preview: 'export function main() {}',
        },
      ],
    },
    kind: 'archive' as const,
    name: 'engine.zip',
    ref: {
      byteSize: 128,
      hash: 'a'.repeat(64),
      id: 'source-archive',
      mimeType: 'application/zip',
      name: 'engine.zip',
      objectPath: `users/user/projects/project/source-archive/${'a'.repeat(64)}/original`,
    },
  };
  let sourceDownloadCalls = 0;
  const resumeActiveDurableCourse = vi.fn(
    async (
      input: Parameters<
        typeof import('../../../services/openrouter/index.ts').resumeActiveDurableCourse
      >[0]
    ) => ({ firstSectionId: 'lesson-1', projectId: input.projectId, projectRevision: 5 })
  );
  const { controller } = createControllerHarness({
    domain: {
      file: null,
      source: archiveSource,
      domainState: {
        source: archiveSource,
        learningPlan: null,
        documentAssets: null,
        documentIndex: null,
        isLearnMode: false,
        userProfile: null,
        syllabus: [],
        activeSectionId: null,
      },
    },
    projectLibrary: {
      currentProjectId: 'archive-project',
      loadStoredProjectSource: async () => {
        sourceDownloadCalls += 1;
        return null;
      },
    },
    openRouter: {
      getActiveCourseInterview: async () => createProposalSnapshot('archive-project'),
      resumeActiveDurableCourse,
    },
  });

  const result = await controller.confirmPlanGeneration();

  assert.equal(result.outcome, 'planned');
  assert.equal(resumeActiveDurableCourse.mock.calls[0]?.[0].projectId, 'archive-project');
  assert.equal(sourceDownloadCalls, 0);
});

test('openSection reuses cached lessons and only generates when content is missing', async () => {
  const cachedPlan = buildPlan({
    sections: [
      {
        id: 'lesson-1',
        title: 'Lezione 1',
        description: 'Intro',
        isCompleted: false,
        type: 'core',
        content: 'Contenuto cached',
        quiz: [{ question: 'Q', options: ['A', 'B', 'C', 'D'], correctIndex: 0 }],
      },
    ],
  });
  let generateSectionCalls = 0;
  const { controller, domain, projectLibrary, stopAudioCalls } = createControllerHarness({
    domain: {
      file: pdfFile,
      learningPlan: cachedPlan,
      source: createProjectSourceFromFile(pdfFile),
      domainState: {
        source: createProjectSourceFromFile(pdfFile),
        learningPlan: cachedPlan,
        documentAssets: null,
        documentIndex: null,
        isLearnMode: false,
        userProfile: null,
        syllabus: [],
        activeSectionId: null,
      },
    },
    openRouter: {
      generateDurableLesson: async () => {
        generateSectionCalls += 1;
        return {
          content: '# Generata',
          contentBlocks: [],
          documentAssets: null,
          generatedVisuals: [],
          imageRefs: [],
          learningAids: [],
          projectId: 'project-1',
          quiz: [],
          sectionId: 'lesson-1',
          warnings: [],
        };
      },
    },
    projectLibrary: { currentProjectId: 'project-1' },
  });

  const cachedOutcome = await controller.openSection(getLessons(cachedPlan)[0]);
  assert.equal(cachedOutcome, 'reused-cached');
  assert.equal(generateSectionCalls, 0);
  assert.equal(stopAudioCalls.length, 1);
  assert.equal(projectLibrary.savedOverrides[0]?.activeSectionId, 'lesson-1');

  const uncachedPlan = buildPlan({
    sections: [
      {
        id: 'lesson-1',
        title: 'Lezione 1',
        description: 'Intro',
        isCompleted: false,
        type: 'core',
      },
    ],
  });
  domain.setLearningPlan(uncachedPlan);
  domain.setSource(createProjectSourceFromFile(pdfFile));
  domain.file = pdfFile;

  const loadedOutcome = await controller.openSection(getLessons(uncachedPlan)[0]);
  assert.equal(loadedOutcome, 'loaded');
  assert.equal(generateSectionCalls, 1);
  assert.equal(getLessons(domain.learningPlan)[0]?.content, '# Generata');
});

test('openSection resumes a persisted lesson request instead of reusing stale cached content', async () => {
  const plan = buildPlan({
    sections: [
      buildTestLesson({
        content: '# Versione precedente',
        id: 'lesson-1',
        title: 'Lezione 1',
      }),
    ],
  });
  const generateDurableLesson = vi.fn(async () => ({
    content: '# Versione rigenerata',
    contentBlocks: [{ markdown: '# Versione rigenerata', type: 'markdown' as const }],
    documentAssets: null,
    generatedVisuals: [],
    imageRefs: [],
    learningAids: [],
    projectId: 'project-1',
    quiz: [],
    sectionId: 'lesson-1',
    warnings: [],
  }));
  const hasDurableLessonRequest = vi.fn(() => true);
  const { controller, domain } = createControllerHarness({
    domain: { learningPlan: plan },
    openRouter: { generateDurableLesson, hasDurableLessonRequest },
    projectLibrary: { currentProjectId: 'project-1' },
  });

  const outcome = await controller.openSection(getLessons(plan)[0]);

  expect(outcome).toBe('loaded');
  expect(hasDurableLessonRequest).toHaveBeenCalledWith('project-1', 'lesson-1');
  expect(generateDurableLesson).toHaveBeenCalledTimes(1);
  expect(getLessons(domain.learningPlan)[0]?.content).toBe('# Versione rigenerata');
});

test('openSection transfers a persisted sublesson request to its recoverable section', async () => {
  const deepLesson = buildTestLesson({
    content: '# Versione provvisoria',
    id: 'deep-1',
    parentId: 'lesson-1',
    title: 'Approfondimento',
    type: 'deep-dive',
  });
  const plan = buildPlan({ sections: [buildTestLesson({ id: 'lesson-1' }), deepLesson] });
  const generateDurableLesson = vi.fn(async () => ({
    content: '# Approfondimento',
    contentBlocks: [{ markdown: '# Approfondimento', type: 'markdown' as const }],
    documentAssets: null,
    generatedVisuals: [],
    imageRefs: [],
    learningAids: [],
    projectId: 'project-1',
    quiz: [],
    sectionId: 'deep-1',
    warnings: [],
  }));
  const recovery = buildLessonRecovery('deep-1');
  const resolveDurableSublessonRequestForSection = vi.fn(async () => recovery);
  const { controller } = createControllerHarness({
    domain: { learningPlan: plan },
    openRouter: { generateDurableLesson, resolveDurableSublessonRequestForSection },
    projectLibrary: { currentProjectId: 'project-1' },
  });

  const outcome = await controller.openSection(deepLesson);

  expect(outcome).toBe('loaded');
  expect(resolveDurableSublessonRequestForSection).toHaveBeenCalledWith(
    'project-1',
    'lesson-1',
    'deep-1'
  );
  expect(generateDurableLesson).toHaveBeenCalledWith(
    expect.objectContaining({
      parentSectionId: 'lesson-1',
      projectId: 'project-1',
      recovery,
      sectionId: 'deep-1',
    })
  );
});

test('openSection reuses a cached sibling of the retained sublesson request', async () => {
  const retainedDeepLesson = buildTestLesson({
    content: '# Approfondimento A',
    id: 'deep-1',
    parentId: 'lesson-1',
    title: 'Approfondimento A',
    type: 'deep-dive',
  });
  const cachedSibling = buildTestLesson({
    content: '# Approfondimento B',
    id: 'deep-2',
    parentId: 'lesson-1',
    title: 'Approfondimento B',
    type: 'deep-dive',
  });
  const plan = buildPlan({
    sections: [buildTestLesson({ id: 'lesson-1' }), retainedDeepLesson, cachedSibling],
  });
  const generateDurableLesson = vi.fn();
  const resolveDurableSublessonRequestForSection = vi.fn(async () => null);
  const { controller } = createControllerHarness({
    domain: { learningPlan: plan },
    openRouter: { generateDurableLesson, resolveDurableSublessonRequestForSection },
    projectLibrary: { currentProjectId: 'project-1' },
  });

  const outcome = await controller.openSection(cachedSibling);

  expect(outcome).toBe('reused-cached');
  expect(resolveDurableSublessonRequestForSection).toHaveBeenCalledWith(
    'project-1',
    'lesson-1',
    'deep-2'
  );
  expect(generateDurableLesson).not.toHaveBeenCalled();
});

test('openSection still opens a cached sibling when the optional recovery lookup fails', async () => {
  const cachedSibling = buildTestLesson({
    content: '# Approfondimento disponibile',
    id: 'deep-2',
    parentId: 'lesson-1',
    title: 'Approfondimento B',
    type: 'deep-dive',
  });
  const plan = buildPlan({ sections: [buildTestLesson({ id: 'lesson-1' }), cachedSibling] });
  const lookupError = new Error('Recovery service unavailable');
  const resolveDurableSublessonRequestForSection = vi.fn(async () => {
    throw lookupError;
  });
  const generateDurableLesson = vi.fn();
  const { controller } = createControllerHarness({
    domain: { learningPlan: plan },
    openRouter: { generateDurableLesson, resolveDurableSublessonRequestForSection },
    projectLibrary: { currentProjectId: 'project-1' },
  });

  await expect(controller.openSection(cachedSibling)).resolves.toBe('reused-cached');
  expect(generateDurableLesson).not.toHaveBeenCalled();

  const uncachedSibling = { ...cachedSibling, content: undefined, id: 'deep-3' };
  await expect(controller.openSection(uncachedSibling)).rejects.toBe(lookupError);
});

test('openSection ignores a retained-request lookup superseded by newer navigation', async () => {
  const deepLesson = buildTestLesson({
    content: '# Approfondimento',
    id: 'deep-1',
    parentId: 'lesson-1',
    title: 'Approfondimento',
    type: 'deep-dive',
  });
  const cachedLesson = buildTestLesson({
    content: '# Lezione 2',
    id: 'lesson-2',
    title: 'Lezione 2',
  });
  const plan = buildPlan({
    sections: [buildTestLesson({ id: 'lesson-1' }), deepLesson, cachedLesson],
  });
  let resolveRetainedLookup: ((recovery: DurableLessonRecovery | null) => void) | undefined;
  const resolveDurableSublessonRequestForSection = vi.fn(
    () =>
      new Promise<DurableLessonRecovery | null>(resolve => {
        resolveRetainedLookup = resolve;
      })
  );
  const generateDurableLesson = vi.fn();
  const { controller, domain, projectLibrary, recreateController } = createControllerHarness({
    domain: { learningPlan: plan },
    openRouter: { generateDurableLesson, resolveDurableSublessonRequestForSection },
    projectLibrary: { currentProjectId: 'project-1' },
  });

  const staleNavigation = controller.openSection(deepLesson);
  await vi.waitFor(() => expect(resolveRetainedLookup).toBeTypeOf('function'));
  await expect(recreateController().openSection(cachedLesson)).resolves.toBe('reused-cached');
  resolveRetainedLookup?.(buildLessonRecovery('deep-1'));

  await expect(staleNavigation).resolves.toBe('ignored-busy');
  expect(domain.activeSectionId).toBe('lesson-2');
  expect(projectLibrary.savedOverrides.at(-1)).toMatchObject({ activeSectionId: 'lesson-2' });
  expect(generateDurableLesson).not.toHaveBeenCalled();
});

test('openSection rechecks blocking workflows after a retained-request lookup', async () => {
  const deepLesson = buildTestLesson({
    content: '# Approfondimento',
    id: 'deep-1',
    parentId: 'lesson-1',
    title: 'Approfondimento',
    type: 'deep-dive',
  });
  const plan = buildPlan({ sections: [buildTestLesson({ id: 'lesson-1' }), deepLesson] });
  let resolveRetainedLookup: ((recovery: DurableLessonRecovery | null) => void) | undefined;
  const resolveDurableSublessonRequestForSection = vi.fn(
    () =>
      new Promise<DurableLessonRecovery | null>(resolve => {
        resolveRetainedLookup = resolve;
      })
  );
  const generateDurableLesson = vi.fn();
  const { controller, state } = createControllerHarness({
    domain: { learningPlan: plan },
    openRouter: { generateDurableLesson, resolveDurableSublessonRequestForSection },
    projectLibrary: { currentProjectId: 'project-1' },
  });

  const navigation = controller.openSection(deepLesson);
  await vi.waitFor(() => expect(resolveRetainedLookup).toBeTypeOf('function'));
  state.adapter.beginWorkflow('generateExercise');
  resolveRetainedLookup?.(buildLessonRecovery('deep-1'));

  await expect(navigation).resolves.toBe('ignored-busy');
  expect(generateDurableLesson).not.toHaveBeenCalled();
  expect(state.adapter.isGenerationActive('project-1')).toBe(false);
});

test('openExercise supersedes an in-flight retained sublesson lookup', async () => {
  const deepLesson = buildTestLesson({
    content: '# Approfondimento',
    id: 'deep-1',
    parentId: 'lesson-1',
    title: 'Approfondimento',
    type: 'deep-dive',
  });
  const exercise: ApplicationExerciseNode = {
    assessedObjective: 'Applicare il metodo.',
    attachments: [],
    brief: '# Consegna',
    currentFeedback: null,
    description: 'Applica il metodo.',
    feedbackStale: false,
    id: 'exercise-1',
    internalText: '',
    isCompleted: false,
    kind: 'exercise',
    title: 'Laboratorio',
    updatedAt: '2026-03-20T10:00:00.000Z',
  };
  const plan = buildPlan({ sections: [buildTestLesson({ id: 'lesson-1' }), deepLesson] });
  plan.modules[0]?.children.push(exercise);
  let resolveRetainedLookup: ((recovery: DurableLessonRecovery | null) => void) | undefined;
  const resolveDurableSublessonRequestForSection = vi.fn(
    () =>
      new Promise<DurableLessonRecovery | null>(resolve => {
        resolveRetainedLookup = resolve;
      })
  );
  const generateDurableLesson = vi.fn();
  const { controller, domain, projectLibrary } = createControllerHarness({
    domain: { learningPlan: plan },
    openRouter: { generateDurableLesson, resolveDurableSublessonRequestForSection },
    projectLibrary: { currentProjectId: 'project-1' },
  });

  const staleNavigation = controller.openSection(deepLesson);
  await vi.waitFor(() => expect(resolveRetainedLookup).toBeTypeOf('function'));
  await controller.openExercise(exercise);
  resolveRetainedLookup?.(buildLessonRecovery('deep-1'));

  await expect(staleNavigation).resolves.toBe('ignored-busy');
  expect(domain.activeSectionId).toBe(exercise.id);
  expect(projectLibrary.savedOverrides.at(-1)).toMatchObject({ activeSectionId: exercise.id });
  expect(generateDurableLesson).not.toHaveBeenCalled();
});

test('goToLibrary supersedes an in-flight retained sublesson lookup', async () => {
  const deepLesson = buildTestLesson({
    content: '# Approfondimento',
    id: 'deep-1',
    parentId: 'lesson-1',
    title: 'Approfondimento',
    type: 'deep-dive',
  });
  const plan = buildPlan({ sections: [buildTestLesson({ id: 'lesson-1' }), deepLesson] });
  let resolveRetainedLookup: ((recovery: DurableLessonRecovery | null) => void) | undefined;
  const resolveDurableSublessonRequestForSection = vi.fn(
    () =>
      new Promise<DurableLessonRecovery | null>(resolve => {
        resolveRetainedLookup = resolve;
      })
  );
  const generateDurableLesson = vi.fn();
  const { controller, domain, state } = createControllerHarness({
    domain: { learningPlan: plan },
    openRouter: { generateDurableLesson, resolveDurableSublessonRequestForSection },
    projectLibrary: { currentProjectId: 'project-1' },
  });

  const staleNavigation = controller.openSection(deepLesson);
  await vi.waitFor(() => expect(resolveRetainedLookup).toBeTypeOf('function'));
  await controller.goToLibrary();
  resolveRetainedLookup?.(buildLessonRecovery('deep-1'));

  await expect(staleNavigation).resolves.toBe('ignored-busy');
  expect(state.internalState.screenState).toBe(AppState.LIBRARY);
  expect(domain.activeSectionId).toBeNull();
  expect(generateDurableLesson).not.toHaveBeenCalled();
});

test('openSection stays stale after project navigation returns to the origin project', async () => {
  const deepLesson = buildTestLesson({
    content: '# Approfondimento',
    id: 'deep-1',
    parentId: 'lesson-1',
    title: 'Approfondimento',
    type: 'deep-dive',
  });
  const plan = buildPlan({ sections: [buildTestLesson({ id: 'lesson-1' }), deepLesson] });
  let resolveRetainedLookup: ((recovery: DurableLessonRecovery | null) => void) | undefined;
  const resolveDurableSublessonRequestForSection = vi.fn(
    () =>
      new Promise<DurableLessonRecovery | null>(resolve => {
        resolveRetainedLookup = resolve;
      })
  );
  const generateDurableLesson = vi.fn();
  const { controller, domain, projectLibrary, state } = createControllerHarness({
    domain: { learningPlan: plan },
    openRouter: { generateDurableLesson, resolveDurableSublessonRequestForSection },
    projectLibrary: { currentProjectId: 'project-1' },
  });

  const staleNavigation = controller.openSection(deepLesson);
  await vi.waitFor(() => expect(resolveRetainedLookup).toBeTypeOf('function'));
  state.adapter.invalidateOpenSectionRequests();
  projectLibrary.adapter.setCurrentProjectId('project-2');
  projectLibrary.adapter.setCurrentProjectId('project-1');
  domain.setActiveSectionId('lesson-1');
  resolveRetainedLookup?.(buildLessonRecovery('deep-1'));

  await expect(staleNavigation).resolves.toBe('ignored-busy');
  expect(domain.activeSectionId).toBe('lesson-1');
  expect(projectLibrary.savedOverrides).toHaveLength(0);
  expect(generateDurableLesson).not.toHaveBeenCalled();
});

test('openSection delegates production lesson work to the durable backend job', async () => {
  const plan = buildPlan({
    sections: [
      {
        id: 'lesson-1',
        title: 'Fotosintesi',
        description: 'Energia luminosa',
        isCompleted: false,
        type: 'core',
      },
    ],
  });
  const generateDurableLesson = vi.fn(
    async (
      _input: Parameters<
        typeof import('../../../services/openrouter/index.ts').generateDurableLesson
      >[0]
    ) => ({
      content: '# Lezione durevole',
      contentBlocks: [{ markdown: '# Lezione durevole', type: 'markdown' as const }],
      generatedVisuals: [],
      imageRefs: [],
      learningAids: [],
      projectId: 'project-1',
      projectRevision: 7,
      quiz: [],
      researchDossier: {
        avoidOversimplifying: [],
        controversies: [],
        difficultSteps: [],
        factualSummary: 'Dossier salvato dal backend.',
        generatedAt: '2026-07-26T12:00:00.000Z',
        keyExamples: [],
        recentDevelopments: [],
        sectionId: 'lesson-1',
        sources: [],
        title: 'Fotosintesi',
      },
      sectionId: 'lesson-1',
      warnings: [
        {
          code: 'lesson_pdf_image_extraction_incomplete' as const,
          pageNumber: 4,
          sourceId: 'source-1',
          stage: 'sources' as const,
        },
      ],
    })
  );
  const { controller, domain, projectLibrary } = createControllerHarness({
    domain: { learningPlan: plan },
    projectLibrary: { currentProjectId: 'project-1' },
    openRouter: { generateDurableLesson },
  });

  const outcome = await controller.openSection(getLessons(plan)[0]);

  assert.equal(outcome, 'loaded');
  assert.equal(getLessons(domain.learningPlan)[0]?.content, '# Lezione durevole');
  assert.deepEqual(getLessons(domain.learningPlan)[0]?.generationWarnings, [
    {
      code: 'lesson_pdf_image_extraction_incomplete',
      pageNumber: 4,
      sourceId: 'source-1',
      stage: 'sources',
    },
  ]);
  assert.equal(
    domain.researchDossiersBySectionId['lesson-1']?.factualSummary,
    'Dossier salvato dal backend.'
  );
  assert.equal(projectLibrary.sectionLessonPatches.length, 0);
  assert.deepEqual(projectLibrary.appliedProjectRevisions, [
    { projectId: 'project-1', revision: 7 },
  ]);
  const generationRequest = generateDurableLesson.mock.calls[0]?.[0];
  assert.equal(typeof generationRequest?.onProgressStage, 'function');
  assert.equal(typeof generationRequest?.onWorkflowSnapshot, 'function');
  assert.deepEqual(generateDurableLesson.mock.calls, [
    [
      {
        forceRegenerate: false,
        onProgressStage: generationRequest?.onProgressStage,
        onWorkflowSnapshot: generationRequest?.onWorkflowSnapshot,
        projectId: 'project-1',
        sectionId: 'lesson-1',
      },
    ],
  ]);
});

test('openSection persists its generation target before starting durable work', async () => {
  const lesson = buildTestLesson({ id: 'lesson-1' });
  const plan = buildPlan({ sections: [lesson] });
  let finishPersistence: ((value: SavedProjectMeta | null) => void) | undefined;
  const patchCurrentProject = vi.fn(
    () =>
      new Promise<SavedProjectMeta | null>(resolve => {
        finishPersistence = resolve;
      })
  );
  const generateDurableLesson = vi.fn(async () => ({
    content: '# Lezione durevole',
    contentBlocks: [],
    generatedVisuals: [],
    imageRefs: [],
    learningAids: [],
    projectId: 'project-1',
    quiz: [],
    sectionId: lesson.id,
    warnings: [],
  }));
  const harness = createControllerHarness({
    domain: { learningPlan: plan },
    openRouter: { generateDurableLesson },
    projectLibrary: { currentProjectId: 'project-1', patchCurrentProject },
  });

  const opening = harness.controller.openSection(lesson);
  await vi.waitFor(() => expect(patchCurrentProject).toHaveBeenCalledTimes(1));
  expect(generateDurableLesson).not.toHaveBeenCalled();

  finishPersistence?.(buildMeta('project-1'));
  await expect(opening).resolves.toBe('loaded');
  expect(generateDurableLesson).toHaveBeenCalledTimes(1);
});

test('force regeneration retains its durable intent before sublesson recovery lookup', async () => {
  const lesson = buildTestLesson({ content: '# Esistente', id: 'deep-1', parentId: 'lesson-1' });
  let finishRecovery: ((value: null) => void) | undefined;
  const resolveDurableSublessonRequestForSection = vi.fn(
    () =>
      new Promise<null>(resolve => {
        finishRecovery = resolve;
      })
  );
  const retainDurableLessonForceRegenerationIntent = vi.fn();
  const clearDurableLessonForceRegenerationIntent = vi.fn();
  const generateDurableLesson = vi.fn(async () => ({
    content: '# Rigenerata',
    contentBlocks: [],
    generatedVisuals: [],
    imageRefs: [],
    learningAids: [],
    projectId: 'project-1',
    quiz: [],
    sectionId: lesson.id,
    warnings: [],
  }));
  const harness = createControllerHarness({
    domain: { activeSectionId: lesson.id, learningPlan: buildPlan({ sections: [lesson] }) },
    openRouter: {
      clearDurableLessonForceRegenerationIntent,
      generateDurableLesson,
      resolveDurableSublessonRequestForSection,
      retainDurableLessonForceRegenerationIntent,
    },
    projectLibrary: { currentProjectId: 'project-1' },
  });

  const regeneration = harness.controller.regenerateActiveSection();
  expect(retainDurableLessonForceRegenerationIntent).toHaveBeenCalledWith('project-1', lesson.id);
  expect(generateDurableLesson).not.toHaveBeenCalled();
  await expect(harness.controller.regenerateActiveSection()).resolves.toBe('ignored-busy');
  expect(retainDurableLessonForceRegenerationIntent).toHaveBeenCalledTimes(1);
  expect(clearDurableLessonForceRegenerationIntent).not.toHaveBeenCalled();

  finishRecovery?.(null);
  await expect(regeneration).resolves.toBe('loaded');
  expect(clearDurableLessonForceRegenerationIntent).not.toHaveBeenCalled();
});

test('a superseded generation target does not reclaim the visible lesson after persistence', async () => {
  const generatingLesson = buildTestLesson({ id: 'lesson-1' });
  const readyLesson = buildTestLesson({ content: '# Pronta', id: 'lesson-2' });
  let finishPersistence: ((value: SavedProjectMeta | null) => void) | undefined;
  const patchCurrentProject = vi.fn((overrides?: Partial<ProjectSnapshot>) =>
    overrides?.activeSectionId === generatingLesson.id
      ? new Promise<SavedProjectMeta | null>(resolve => {
          finishPersistence = resolve;
        })
      : Promise.resolve(buildMeta('project-1'))
  );
  const generateDurableLesson = vi.fn(async () => ({
    content: '# Generata',
    contentBlocks: [],
    generatedVisuals: [],
    imageRefs: [],
    learningAids: [],
    projectId: 'project-1',
    quiz: [],
    sectionId: generatingLesson.id,
    warnings: [],
  }));
  const harness = createControllerHarness({
    domain: { learningPlan: buildPlan({ sections: [generatingLesson, readyLesson] }) },
    openRouter: { generateDurableLesson },
    projectLibrary: { currentProjectId: 'project-1', patchCurrentProject },
  });

  const opening = harness.controller.openSection(generatingLesson);
  await vi.waitFor(() => expect(patchCurrentProject).toHaveBeenCalledOnce());
  expect(await harness.controller.openSection(generatingLesson)).toBe('ignored-busy');
  expect(harness.domain.activeSectionId).toBeNull();
  expect(await harness.controller.openSection(readyLesson)).toBe('reused-cached');
  finishPersistence?.(buildMeta('project-1'));

  await expect(opening).resolves.toBe('loaded');
  expect(generateDurableLesson).toHaveBeenCalledOnce();
  expect(harness.domain.activeSectionId).toBe(readyLesson.id);
});

test('a repeated click keeps the pending generation target current until persistence finishes', async () => {
  const lesson = buildTestLesson({ id: 'lesson-1' });
  let finishPersistence: ((value: SavedProjectMeta | null) => void) | undefined;
  const patchCurrentProject = vi.fn(
    () =>
      new Promise<SavedProjectMeta | null>(resolve => {
        finishPersistence = resolve;
      })
  );
  const generateDurableLesson = vi.fn(async () => ({
    content: '# Generata',
    contentBlocks: [],
    generatedVisuals: [],
    imageRefs: [],
    learningAids: [],
    projectId: 'project-1',
    quiz: [],
    sectionId: lesson.id,
    warnings: [],
  }));
  const harness = createControllerHarness({
    domain: { learningPlan: buildPlan({ sections: [lesson] }) },
    openRouter: { generateDurableLesson },
    projectLibrary: { currentProjectId: 'project-1', patchCurrentProject },
  });

  const opening = harness.controller.openSection(lesson);
  await vi.waitFor(() => expect(patchCurrentProject).toHaveBeenCalledOnce());
  expect(await harness.controller.openSection(lesson)).toBe('ignored-busy');
  expect(harness.domain.activeSectionId).toBeNull();

  finishPersistence?.(buildMeta('project-1'));
  await expect(opening).resolves.toBe('loaded');
  expect(generateDurableLesson).toHaveBeenCalledOnce();
  expect(harness.domain.activeSectionId).toBe(lesson.id);
  expect(harness.state.adapter.isGenerationActive('project-1')).toBe(false);
});

test('a superseded persistence failure is not reported over the visible lesson', async () => {
  const generatingLesson = buildTestLesson({ id: 'lesson-1' });
  const readyLesson = buildTestLesson({ content: '# Pronta', id: 'lesson-2' });
  let finishPersistence: ((value: SavedProjectMeta | null) => void) | undefined;
  const patchCurrentProject = vi.fn((overrides?: Partial<ProjectSnapshot>) =>
    overrides?.activeSectionId === generatingLesson.id
      ? new Promise<SavedProjectMeta | null>(resolve => {
          finishPersistence = resolve;
        })
      : Promise.resolve(buildMeta('project-1'))
  );
  const generateDurableLesson = vi.fn();
  const harness = createControllerHarness({
    domain: { learningPlan: buildPlan({ sections: [generatingLesson, readyLesson] }) },
    openRouter: { generateDurableLesson },
    projectLibrary: { currentProjectId: 'project-1', patchCurrentProject },
  });

  const opening = harness.controller.openSection(generatingLesson);
  await vi.waitFor(() => expect(patchCurrentProject).toHaveBeenCalledOnce());
  expect(await harness.controller.openSection(readyLesson)).toBe('reused-cached');
  finishPersistence?.(null);

  await expect(opening).resolves.toBe('ignored-busy');
  expect(generateDurableLesson).not.toHaveBeenCalled();
  expect(harness.domain.activeSectionId).toBe(readyLesson.id);
  expect(harness.state.internalState.workflowState.loadSection.status).toBe('idle');
});

test('openSection does not start durable work when its generation target was not saved', async () => {
  setRenderingLocaleOverride('en');
  const lesson = buildTestLesson({ id: 'lesson-1' });
  const generateDurableLesson = vi.fn();
  const harness = createControllerHarness({
    domain: { learningPlan: buildPlan({ sections: [lesson] }) },
    openRouter: { generateDurableLesson },
    projectLibrary: {
      currentProjectId: 'project-1',
      patchCurrentProject: async () => null,
    },
  });

  await expect(harness.controller.openSection(lesson)).rejects.toThrow(
    t('Non sono riuscito a salvare la lezione da generare. Riprova.')
  );
  expect(generateDurableLesson).not.toHaveBeenCalled();
  expect(harness.domain.activeSectionId).toBeNull();
  expect(harness.state.internalState.workflowState.loadSection.status).toBe('failed');
});

test('force regeneration clears its retained intent when target persistence fails', async () => {
  setRenderingLocaleOverride('en');
  const lesson = buildTestLesson({ content: '# Esistente', id: 'lesson-1' });
  const retainDurableLessonForceRegenerationIntent = vi.fn();
  const clearDurableLessonForceRegenerationIntent = vi.fn();
  const generateDurableLesson = vi.fn();
  const harness = createControllerHarness({
    domain: { activeSectionId: lesson.id, learningPlan: buildPlan({ sections: [lesson] }) },
    openRouter: {
      clearDurableLessonForceRegenerationIntent,
      generateDurableLesson,
      retainDurableLessonForceRegenerationIntent,
    },
    projectLibrary: {
      currentProjectId: 'project-1',
      patchCurrentProject: async () => null,
    },
  });

  await expect(harness.controller.regenerateActiveSection()).rejects.toThrow(
    t('Non sono riuscito a salvare la lezione da generare. Riprova.')
  );
  expect(retainDurableLessonForceRegenerationIntent).toHaveBeenCalledWith('project-1', lesson.id);
  expect(clearDurableLessonForceRegenerationIntent).toHaveBeenCalledWith('project-1', lesson.id);
  expect(generateDurableLesson).not.toHaveBeenCalled();
});

test('a completed lesson request cannot report over a newer active lesson', async () => {
  const generatingLesson = buildTestLesson({ id: 'lesson-1' });
  const readyLesson = buildTestLesson({ content: '# Pronta', id: 'lesson-2' });
  const plan = buildPlan({ sections: [generatingLesson, readyLesson] });
  let rejectGeneration: ((error: Error) => void) | undefined;
  const generateDurableLesson = vi.fn(
    () =>
      new Promise<never>((_resolve, reject) => {
        rejectGeneration = reject;
      })
  );
  const harness = createControllerHarness({
    domain: { learningPlan: plan },
    openRouter: { generateDurableLesson },
    projectLibrary: {
      currentProjectId: 'project-1',
      getCurrentActiveSectionId: () => generatingLesson.id,
    },
  });

  const generation = harness.controller.openSection(generatingLesson);
  await vi.waitFor(() => expect(generateDurableLesson).toHaveBeenCalledTimes(1));
  await expect(harness.controller.openSection(readyLesson)).resolves.toBe('reused-cached');

  rejectGeneration?.(new Error('late failure'));
  await expect(generation).resolves.toBe('ignored-busy');
  expect(harness.domain.activeSectionId).toBe(readyLesson.id);
  expect(harness.state.internalState.workflowState.loadSection.status).toBe('idle');
});

test('openSection exposes a durable busy error instead of silently ignoring it', async () => {
  const plan = buildPlan({
    sections: [
      {
        id: 'lesson-1',
        title: 'Fotosintesi',
        description: 'Energia luminosa',
        isCompleted: false,
        type: 'core',
      },
    ],
  });
  const busyError = new LessonGenerationBusyError('lesson-2');
  const disposeProgressObserver = vi.fn();
  const { controller, state } = createControllerHarness({
    domain: { learningPlan: plan },
    projectLibrary: { currentProjectId: 'project-1' },
    openRouter: {
      createGenerationProgressObserver: vi.fn(() => ({
        complete: vi.fn(),
        dispose: disposeProgressObserver,
        finish: vi.fn(async () => undefined),
        push: vi.fn(),
        setStage: vi.fn(),
        updateStatus: vi.fn(),
      })),
      generateDurableLesson: vi.fn(async () => {
        throw busyError;
      }),
    },
  });

  await assert.rejects(controller.openSection(getLessons(plan)[0]), busyError);
  assert.equal(state.internalState.workflowState.loadSection.status, 'failed');
  assert.equal(state.internalState.workflowState.loadSection.error, busyError.message);
  assert.equal(disposeProgressObserver.mock.calls.length, 1);
});

test('openSection marks a missing durable source for reattachment', async () => {
  const plan = buildPlan({
    sections: [
      {
        id: 'lesson-1',
        title: 'Fotosintesi',
        description: 'Energia luminosa',
        isCompleted: false,
        type: 'core',
      },
    ],
  });
  const sourceError = new LessonSourceUnavailableError();
  const { controller, state } = createControllerHarness({
    domain: { learningPlan: plan },
    projectLibrary: { currentProjectId: 'project-1' },
    openRouter: {
      generateDurableLesson: vi.fn(async () => {
        throw sourceError;
      }),
    },
  });

  await assert.rejects(controller.openSection(getLessons(plan)[0]), sourceError);
  assert.equal(state.internalState.missingSourceProjects.has('project-1'), true);
  assert.equal(state.internalState.workflowState.loadSection.status, 'failed');
  assert.equal(
    state.internalState.workflowState.loadSection.error,
    t(LESSON_SOURCE_UNAVAILABLE_MESSAGE)
  );
});

test('openSection ignores a durable result older than the known project revision', async () => {
  const plan = buildPlan({
    sections: [
      {
        id: 'lesson-1',
        title: 'Fotosintesi',
        description: 'Energia luminosa',
        isCompleted: false,
        type: 'core',
      },
    ],
  });
  const applyPersistedProjectRevision = vi.fn(async () => false);
  const { controller, domain, state } = createControllerHarness({
    domain: { learningPlan: plan },
    projectLibrary: { applyPersistedProjectRevision, currentProjectId: 'project-1' },
    openRouter: {
      generateDurableLesson: vi.fn(async () => ({
        content: '# Risultato stantio',
        contentBlocks: [{ markdown: '# Risultato stantio', type: 'markdown' as const }],
        generatedVisuals: [],
        imageRefs: [],
        learningAids: [],
        projectId: 'project-1',
        projectRevision: 5,
        quiz: [],
        sectionId: 'lesson-1',
        warnings: [],
      })),
    },
  });

  assert.equal(await controller.openSection(getLessons(plan)[0]), 'loaded');
  assert.equal(getLessons(domain.learningPlan)[0]?.content, undefined);
  assert.deepEqual(applyPersistedProjectRevision.mock.calls, [
    [{ projectId: 'project-1', revision: 5 }],
  ]);
  assert.equal(state.internalState.workflowState.loadSection.status, 'succeeded');
});

test('openSection ignores user navigation while another blocking workflow is pending', async () => {
  const uncachedPlan = buildPlan({
    sections: [
      {
        id: 'lesson-1',
        title: 'Lezione 1',
        description: 'Intro',
        isCompleted: false,
        type: 'core',
      },
    ],
  });
  const { controller, state } = createControllerHarness({
    domain: {
      file: pdfFile,
      learningPlan: uncachedPlan,
      source: createProjectSourceFromFile(pdfFile),
      domainState: {
        source: createProjectSourceFromFile(pdfFile),
        learningPlan: uncachedPlan,
        documentAssets: null,
        documentIndex: null,
        isLearnMode: false,
        userProfile: null,
        syllabus: [],
        activeSectionId: null,
      },
    },
  });

  state.adapter.beginWorkflow('generatePlan', 'Creazione Piano Studi...');
  const result = await controller.openSection(getLessons(uncachedPlan)[0]);

  assert.equal(result, 'ignored-busy');
});

test('openSection never starts a second lesson generation', async () => {
  const uncachedPlan = buildPlan({
    sections: [
      {
        id: 'lesson-1',
        title: 'Lezione 1',
        description: 'Intro',
        isCompleted: false,
        type: 'core',
      },
    ],
  });
  let generationCalls = 0;
  const { controller, state } = createControllerHarness({
    domain: {
      file: pdfFile,
      learningPlan: uncachedPlan,
      source: createProjectSourceFromFile(pdfFile),
    },
    openRouter: {
      generateDurableLesson: async () => {
        generationCalls += 1;
        throw new Error('A concurrent generation must not start');
      },
    },
  });

  state.adapter.beginWorkflow('loadSection', 'Generazione lezione...');
  const result = await controller.openSection(getLessons(uncachedPlan)[0], {
    allowWhileBlocking: true,
  });

  assert.equal(result, 'ignored-busy');
  assert.equal(generationCalls, 0);
});

test('openSection reopens the lesson already generating without resetting its authoritative timer', async () => {
  const plan = buildPlan({
    sections: [
      buildTestLesson({ id: 'lesson-1', title: 'Lezione in generazione' }),
      buildTestLesson({
        content: '# Lezione pronta',
        id: 'lesson-2',
        title: 'Lezione pronta',
      }),
    ],
  });
  let finishGeneration: (() => void) | undefined;
  const generationGate = new Promise<void>(resolve => {
    finishGeneration = resolve;
  });
  const generateDurableLesson = vi.fn(
    async (
      input: Parameters<
        typeof import('../../../services/openrouter/index.ts').generateDurableLesson
      >[0]
    ) => {
      input.onWorkflowSnapshot?.({
        createdAt: '2026-07-29T20:00:00.000Z',
        id: 'run-1',
        projectId: 'project-1',
        retrying: false,
        sectionId: 'lesson-1',
        stage: 'sources',
        status: 'queued',
        updatedAt: '2026-07-29T20:00:00.000Z',
      });
      input.onWorkflowSnapshot?.({
        attempt: 2,
        createdAt: '2026-07-29T20:00:00.000Z',
        failure: { code: 'lesson_provider_unavailable', kind: 'operational' },
        id: 'run-1',
        projectId: 'project-1',
        retrying: true,
        sectionId: 'lesson-1',
        stage: 'structure',
        startedAt: '2026-07-29T20:01:00.000Z',
        status: 'running',
        updatedAt: '2026-07-29T20:02:00.000Z',
      });
      input.onProgressStage?.('structure');
      await generationGate;
      return {
        content: '# Lezione generata',
        contentBlocks: [],
        generatedVisuals: [],
        imageRefs: [],
        learningAids: [],
        projectId: 'project-1',
        quiz: [],
        sectionId: 'lesson-1',
        warnings: [],
      };
    }
  );
  const { controller, domain, state } = createControllerHarness({
    domain: { learningPlan: plan },
    projectLibrary: { currentProjectId: 'project-1' },
    openRouter: {
      createGenerationProgressObserver: ({
        onUpdate,
        operation,
        subject,
      }: Parameters<
        typeof import('../../../services/openrouter/index.ts').createGenerationProgressObserver
      >[0]) => {
        const clientStartedAt = Date.parse('2026-07-29T20:10:00.000Z');
        const emit = (stage: 'sources' | 'structure') =>
          onUpdate({
            operation,
            sections: [],
            stage,
            startedAt: clientStartedAt,
            stepOffset: 0,
            subject,
          });
        emit('sources');
        return {
          complete: vi.fn(),
          dispose: vi.fn(),
          finish: vi.fn(async () => undefined),
          push: vi.fn(),
          setStage: vi.fn(stage => emit(stage as 'sources' | 'structure')),
          updateStatus: vi.fn(),
        };
      },
      generateDurableLesson,
    },
  });
  const [generatingLesson, readyLesson] = getLessons(plan);

  const generation = controller.openSection(generatingLesson);
  await Promise.resolve();
  const authoritativeStartedAt = Date.parse('2026-07-29T20:00:00.000Z');
  assert.equal(
    state.internalState.workflowState.loadSection.progress?.startedAt,
    authoritativeStartedAt
  );
  assert.equal(state.internalState.workflowState.loadSection.progress?.attempt, 2);
  assert.equal(state.internalState.workflowState.loadSection.progress?.retrying, true);
  assert.deepEqual(state.internalState.workflowState.loadSection.progress?.failure, {
    code: 'lesson_provider_unavailable',
    kind: 'operational',
  });
  assert.equal(await controller.openSection(readyLesson), 'reused-cached');
  assert.equal(domain.activeSectionId, 'lesson-2');

  const reopened = await controller.openSection(generatingLesson);

  assert.equal(reopened, 'reopened-generating');
  assert.equal(domain.activeSectionId, 'lesson-1');
  assert.equal(generateDurableLesson.mock.calls.length, 1);
  assert.equal(
    state.internalState.workflowState.loadSection.progress?.startedAt,
    authoritativeStartedAt
  );

  finishGeneration?.();
  assert.equal(await generation, 'loaded');
});

test('lesson generation discards an invalidated sublesson and rejects competing commands until it settles', async () => {
  const plan = buildPlan({
    sections: [
      buildTestLesson({ id: 'lesson-1', title: 'Lezione 1' }),
      buildTestLesson({ id: 'lesson-2', title: 'Lezione 2' }),
    ],
  });
  let sublessonCalls = 0;
  let lessonCalls = 0;
  let releaseSublesson: (() => void) | undefined;
  let markSublessonStarted: (() => void) | undefined;
  const sublessonGate = new Promise<void>(resolve => {
    releaseSublesson = resolve;
  });
  const sublessonStarted = new Promise<void>(resolve => {
    markSublessonStarted = resolve;
  });
  const { controller, recreateController, state } = createControllerHarness({
    domain: {
      activeSectionId: 'lesson-1',
      documentIndex: createReadyIndex(),
      file: pdfFile,
      learningPlan: plan,
      source: createProjectSourceFromFile(pdfFile),
    },
    projectLibrary: { currentProjectId: 'project-1' },
    openRouter: {
      generateDurableSublesson: async input => {
        sublessonCalls += 1;
        markSublessonStarted?.();
        input.onWorkflowSnapshot?.({
          createdAt: '2026-07-30T18:00:00.000Z',
          id: 'run-sublesson',
          projectId: input.projectId,
          retrying: false,
          sectionId: 'deep-ignored',
          stage: 'structure',
          status: 'running',
          updatedAt: '2026-07-30T18:00:01.000Z',
        });
        await sublessonGate;
        return {
          content: '# Approfondimento',
          contentBlocks: [],
          generatedVisuals: [],
          imageRefs: [],
          learningAids: [],
          projectId: input.projectId,
          projectRevision: 2,
          quiz: [],
          sectionId: 'deep-ignored',
          warnings: [],
        };
      },
      generateDurableLesson: async () => {
        lessonCalls += 1;
        return {
          content: '# Lezione generata',
          contentBlocks: [],
          documentAssets: null,
          generatedVisuals: [],
          imageRefs: [],
          learningAids: [],
          projectId: 'project-1',
          quiz: [],
          sectionId: 'lesson-1',
          warnings: [],
        };
      },
    },
  });

  const firstSublesson = controller.createLessonFromSelection({
    instructions: 'Approfondisci',
    selectedText: 'testo',
  });
  await sublessonStarted;
  state.adapter.invalidateWorkflows(['createLesson']);
  const recreatedController = recreateController();

  const duplicateSublesson = recreatedController.createLessonFromSelection({
    instructions: 'Approfondisci ancora',
    selectedText: 'testo',
  });
  const competingLesson = recreatedController.openSection(getLessons(plan)[1]);
  releaseSublesson?.();

  const [firstResult, duplicateResult, competingResult] = await Promise.all([
    firstSublesson,
    duplicateSublesson,
    competingLesson,
  ]);

  assert.equal(firstResult.outcome, 'ignored-busy');
  assert.equal(duplicateResult.outcome, 'failed');
  assert.ok(duplicateResult.errorMessage);
  assert.equal(competingResult, 'ignored-busy');
  assert.equal(sublessonCalls, 1);
  assert.equal(lessonCalls, 0);

  const afterSuccess = await controller.openSection(getLessons(plan)[1]);
  assert.equal(afterSuccess, 'loaded');
  assert.equal(lessonCalls, 1);
});

test('sublesson generation releases its gate after an error', async () => {
  const plan = buildPlan();
  const generatedPlan = buildPlan({
    sections: [
      buildTestLesson({ id: 'lesson-1', title: 'Lezione 1' }),
      buildTestLesson({
        id: 'deep-after-error',
        title: 'Approfondimento',
        type: 'deep-dive',
        parentId: 'lesson-1',
        content: '# Approfondimento',
      }),
      buildTestLesson({ id: 'lesson-2', title: 'Lezione 2' }),
    ],
  });
  let sublessonCalls = 0;
  const harness = createControllerHarness({
    domain: {
      activeSectionId: 'lesson-1',
      documentIndex: createReadyIndex(),
      file: pdfFile,
      learningPlan: plan,
      source: createProjectSourceFromFile(pdfFile),
    },
    projectLibrary: { currentProjectId: 'project-1' },
    openRouter: {
      generateDurableSublesson: async input => {
        sublessonCalls += 1;
        if (sublessonCalls === 1) {
          throw new Error('Metadata non disponibili');
        }
        return {
          content: '# Approfondimento',
          contentBlocks: [],
          generatedVisuals: [],
          imageRefs: [],
          learningAids: [],
          projectId: input.projectId,
          projectRevision: 2,
          quiz: [],
          sectionId: 'deep-after-error',
          warnings: [],
        };
      },
    },
  });
  harness.projectLibrary.adapter.applyPersistedProjectRevision = async args => {
    harness.projectLibrary.appliedProjectRevisions.push(args);
    harness.domain.hydrateSnapshot(
      createProjectSnapshot({
        activeSectionId: 'deep-after-error',
        id: 'project-1',
        learningPlan: generatedPlan,
        state: AppState.READING,
      })
    );
    return true;
  };

  const failed = await harness.controller.createLessonFromSelection({
    instructions: 'Approfondisci',
    selectedText: 'testo',
  });
  const retried = await harness.controller.createLessonFromSelection({
    instructions: 'Riprova',
    selectedText: 'testo',
  });

  assert.equal(failed.outcome, 'failed');
  assert.equal(retried.outcome, 'created');
  assert.equal(sublessonCalls, 2);
});

test.each([
  { error: null, expectedOutcome: 'created', expectedStatus: 'succeeded' },
  {
    error: new Error('Approfondimento interrotto'),
    expectedOutcome: 'failed',
    expectedStatus: 'failed',
  },
] as const)('sublesson re-entry restores progress and terminal $expectedStatus state', async ({
  error,
  expectedOutcome,
  expectedStatus,
}) => {
  const plan = buildPlan();
  const generatedSection = buildTestLesson({
    content: '# Approfondimento',
    id: 'deep-reattach',
    parentId: 'lesson-1',
    title: 'Approfondimento',
    type: 'deep-dive',
  });
  const generatedPlan = buildPlan({
    sections: [buildTestLesson({ id: 'lesson-1' }), generatedSection],
  });
  let settleGeneration: (() => void) | undefined;
  let markStarted: (() => void) | undefined;
  const generationGate = new Promise<void>(resolve => {
    settleGeneration = resolve;
  });
  const started = new Promise<void>(resolve => {
    markStarted = resolve;
  });
  const harness = createControllerHarness({
    domain: {
      activeSectionId: 'lesson-1',
      learningPlan: plan,
      source: createProjectSourceFromFile(pdfFile),
    },
    projectLibrary: { currentProjectId: 'project-1' },
    openRouter: {
      generateDurableSublesson: async input => {
        input.onWorkflowSnapshot?.({
          createdAt: '2026-08-26T00:00:00.000Z',
          id: 'sublesson-run',
          projectId: input.projectId,
          retrying: false,
          sectionId: generatedSection.id,
          stage: 'drafting',
          status: 'running',
          updatedAt: '2026-08-26T00:00:01.000Z',
        });
        markStarted?.();
        await generationGate;
        if (error) throw error;
        return {
          content: generatedSection.content ?? '',
          contentBlocks: [],
          generatedVisuals: [],
          imageRefs: [],
          learningAids: [],
          projectId: input.projectId,
          projectRevision: 2,
          quiz: [],
          sectionId: generatedSection.id,
          warnings: [],
        };
      },
    },
  });
  // Hydration updates the next React render, while this command retains the previous domain snapshot.
  harness.projectLibrary.adapter.applyPersistedProjectRevision = async () => {
    return false;
  };
  harness.projectLibrary.adapter.loadStoredProjectWithRevision = async () => ({
    // Re-entry must accept the section from a newer authoritative revision.
    revision: 3,
    snapshot: createProjectSnapshot({
      activeSectionId: generatedSection.id,
      id: 'project-1',
      learningPlan: generatedPlan,
      state: AppState.READING,
    }),
  });

  const creation = harness.controller.createLessonFromSelection({
    instructions: 'Approfondisci',
    selectedText: 'testo',
  });
  await started;
  harness.state.adapter.invalidateWorkflows(['createLesson']);

  expect(await harness.controller.openSection(generatedSection)).toBe('reopened-generating');
  expect(harness.state.internalState.workflowState.createLesson.status).toBe('pending');
  settleGeneration?.();

  expect((await creation).outcome).toBe(expectedOutcome);
  expect(harness.state.internalState.workflowState.createLesson.status).toBe(expectedStatus);
  if (!error) {
    expect(
      getLessons(harness.domain.learningPlan).some(section => section.id === generatedSection.id)
    ).toBe(true);
  }
});

test('openSection resumes retained sublesson work when its parent is selected later', async () => {
  const parentLesson = buildTestLesson({ content: '# Lezione', id: 'lesson-1' });
  const otherLesson = buildTestLesson({ content: '# Altra', id: 'lesson-2' });
  const generatedSection = buildTestLesson({
    content: '# Approfondimento',
    id: 'deep-retained',
    parentId: parentLesson.id,
    title: 'Approfondimento',
    type: 'deep-dive',
  });
  const plan = buildPlan({ sections: [parentLesson, otherLesson] });
  const generatedPlan = buildPlan({ sections: [parentLesson, generatedSection, otherLesson] });
  let releaseGeneration: (() => void) | undefined;
  let markGenerationStarted: (() => void) | undefined;
  const generationGate = new Promise<void>(resolve => {
    releaseGeneration = resolve;
  });
  const generationStarted = new Promise<void>(resolve => {
    markGenerationStarted = resolve;
  });
  const generateDurableLesson = vi.fn(async () => {
    markGenerationStarted?.();
    await generationGate;
    return {
      content: generatedSection.content ?? '',
      contentBlocks: [],
      generatedVisuals: [],
      imageRefs: [],
      learningAids: [],
      projectId: 'project-1',
      projectRevision: 2,
      quiz: [],
      sectionId: generatedSection.id,
      warnings: [],
    };
  });
  const harness = createControllerHarness({
    domain: { activeSectionId: otherLesson.id, learningPlan: plan },
    openRouter: {
      generateDurableLesson,
      hasDurableSublessonRequest: (projectId, parentSectionId) =>
        projectId === 'project-1' && parentSectionId === parentLesson.id,
      resolveDurableSublessonRequestForParent: async () => buildLessonRecovery(generatedSection.id),
    },
    projectLibrary: { currentProjectId: 'project-1' },
  });
  harness.projectLibrary.adapter.applyPersistedProjectRevision = async () => {
    harness.domain.hydrateSnapshot(
      createProjectSnapshot({
        activeSectionId: generatedSection.id,
        id: 'project-1',
        learningPlan: generatedPlan,
        state: AppState.READING,
      })
    );
    return true;
  };

  expect(await harness.controller.openSection(parentLesson)).toBe('reopened-generating');
  await generationStarted;
  expect(harness.domain.activeSectionId).toBe(parentLesson.id);
  expect(harness.state.internalState.workflowState.createLesson.status).toBe('pending');
  expect(generateDurableLesson).toHaveBeenCalledOnce();
  releaseGeneration?.();

  await vi.waitFor(() =>
    expect(harness.state.internalState.workflowState.createLesson.status).toBe('succeeded')
  );
  expect(harness.domain.activeSectionId).toBe(generatedSection.id);
});

test('sublesson completion reuses a newer revision already hydrated by the project library', async () => {
  const parentLesson = buildTestLesson({ content: '# Lezione', id: 'lesson-1' });
  const generatedSection = buildTestLesson({
    content: '# Approfondimento',
    id: 'deep-newer',
    parentId: parentLesson.id,
    title: 'Approfondimento',
    type: 'deep-dive',
  });
  const generatedPlan = buildPlan({ sections: [parentLesson, generatedSection] });
  const loadStoredProjectWithRevision = vi.fn();
  const harness = createControllerHarness({
    domain: {
      activeSectionId: parentLesson.id,
      learningPlan: buildPlan({ sections: [parentLesson] }),
    },
    openRouter: {
      generateDurableSublesson: async () => ({
        content: generatedSection.content ?? '',
        contentBlocks: [],
        generatedVisuals: [],
        imageRefs: [],
        learningAids: [],
        projectId: 'project-1',
        projectRevision: 2,
        quiz: [],
        sectionId: generatedSection.id,
        warnings: [],
      }),
    },
    projectLibrary: { currentProjectId: 'project-1', loadStoredProjectWithRevision },
  });
  harness.projectLibrary.adapter.applyPersistedProjectRevision = async () => {
    harness.domain.hydrateSnapshot(
      createProjectSnapshot({
        activeSectionId: generatedSection.id,
        id: 'project-1',
        learningPlan: generatedPlan,
        state: AppState.READING,
      })
    );
    return false;
  };

  await expect(
    harness.controller.createLessonFromSelection({
      instructions: 'Approfondisci',
      selectedText: 'testo',
    })
  ).resolves.toEqual({ outcome: 'created' });
  expect(loadStoredProjectWithRevision).not.toHaveBeenCalled();
  expect(harness.domain.activeSectionId).toBe(generatedSection.id);
});

test('force regeneration re-entry reattaches before reusing populated lesson content', async () => {
  const lesson = buildTestLesson({ content: '# Contenuto precedente', id: 'lesson-1' });
  const plan = buildPlan({ sections: [lesson] });
  let releaseGeneration: (() => void) | undefined;
  let markStarted: (() => void) | undefined;
  const generationGate = new Promise<void>(resolve => {
    releaseGeneration = resolve;
  });
  const started = new Promise<void>(resolve => {
    markStarted = resolve;
  });
  const generateDurableLesson = vi.fn(async () => {
    markStarted?.();
    await generationGate;
    return {
      content: '# Contenuto rigenerato',
      contentBlocks: [],
      generatedVisuals: [],
      imageRefs: [],
      learningAids: [],
      projectId: 'project-1',
      quiz: [],
      sectionId: lesson.id,
      warnings: [],
    };
  });
  const harness = createControllerHarness({
    domain: { learningPlan: plan },
    openRouter: { generateDurableLesson },
    projectLibrary: { currentProjectId: 'project-1' },
  });

  const regeneration = harness.controller.openSection(lesson, { forceRegenerate: true });
  await started;
  harness.state.adapter.invalidateWorkflows(['loadSection']);

  expect(await harness.controller.openSection(lesson, { forceRegenerate: true })).toBe(
    'reopened-generating'
  );
  expect(generateDurableLesson).toHaveBeenCalledTimes(1);
  releaseGeneration?.();
  expect(await regeneration).toBe('loaded');
  expect(harness.state.internalState.workflowState.loadSection.status).toBe('succeeded');
});

test('lesson generation remains navigable after workflow invalidation until the provider call settles', async () => {
  const plan = buildPlan({ sections: [buildTestLesson({ id: 'lesson-1' })] });
  let generationCalls = 0;
  let releaseGeneration: (() => void) | undefined;
  let markGenerationStarted: (() => void) | undefined;
  const generationGate = new Promise<void>(resolve => {
    releaseGeneration = resolve;
  });
  const generationStarted = new Promise<void>(resolve => {
    markGenerationStarted = resolve;
  });
  const disposeProgressObserver = vi.fn();
  const { controller, state } = createControllerHarness({
    domain: {
      file: pdfFile,
      learningPlan: plan,
      source: createProjectSourceFromFile(pdfFile),
    },
    projectLibrary: { currentProjectId: 'project-1' },
    openRouter: {
      createGenerationProgressObserver: vi.fn(() => ({
        complete: vi.fn(),
        dispose: disposeProgressObserver,
        finish: vi.fn(async () => undefined),
        push: vi.fn(),
        setStage: vi.fn(),
        updateStatus: vi.fn(),
      })),
      generateDurableLesson: async () => {
        generationCalls += 1;
        if (generationCalls === 1) {
          markGenerationStarted?.();
          await generationGate;
        }
        return {
          content: '# Lezione generata',
          contentBlocks: [],
          documentAssets: null,
          generatedVisuals: [],
          imageRefs: [],
          learningAids: [],
          projectId: 'project-1',
          quiz: [],
          sectionId: 'lesson-1',
          warnings: [],
        };
      },
    },
  });

  const invalidatedGeneration = controller.openSection(getLessons(plan)[0]);
  await generationStarted;
  state.adapter.invalidateWorkflows(['loadSection']);

  const whileInvalidatedRequestSettles = await controller.openSection(getLessons(plan)[0]);
  expect(whileInvalidatedRequestSettles).toBe('reopened-generating');
  expect(generationCalls).toBe(1);
  expect(state.adapter.isLessonGenerationActive('project-1')).toBe(true);
  expect(state.adapter.getGeneratingSectionId('project-1')).toBe('lesson-1');

  releaseGeneration?.();

  expect(await invalidatedGeneration).toBe('loaded');
  expect(disposeProgressObserver).toHaveBeenCalledTimes(1);
  expect(state.internalState.workflowState.loadSection.status).toBe('succeeded');
  expect(state.adapter.isLessonGenerationActive('project-1')).toBe(false);
  expect(state.adapter.getGeneratingSectionId('project-1')).toBeNull();

  const retried = await controller.openSection(getLessons(plan)[0]);
  expect(retried).toBe('loaded');
  expect(generationCalls).toBe(2);
});

test('lesson generation reports a terminal failure after workflow invalidation and re-entry', async () => {
  const plan = buildPlan({ sections: [buildTestLesson({ id: 'lesson-1' })] });
  let rejectGeneration: ((error: Error) => void) | undefined;
  let markGenerationStarted: (() => void) | undefined;
  const generationGate = new Promise<never>((_, reject) => {
    rejectGeneration = reject;
  });
  const generationStarted = new Promise<void>(resolve => {
    markGenerationStarted = resolve;
  });
  const generateDurableLesson = vi.fn(async () => {
    markGenerationStarted?.();
    return generationGate;
  });
  const { controller, state } = createControllerHarness({
    domain: {
      file: pdfFile,
      learningPlan: plan,
      source: createProjectSourceFromFile(pdfFile),
    },
    projectLibrary: { currentProjectId: 'project-1' },
    openRouter: { generateDurableLesson },
  });

  const invalidatedGeneration = controller.openSection(getLessons(plan)[0]);
  await generationStarted;
  state.adapter.invalidateWorkflows(['loadSection']);

  expect(await controller.openSection(getLessons(plan)[0])).toBe('reopened-generating');
  rejectGeneration?.(new Error('Generazione interrotta'));

  await expect(invalidatedGeneration).rejects.toThrow('Generazione interrotta');
  expect(generateDurableLesson).toHaveBeenCalledTimes(1);
  expect(state.internalState.workflowState.loadSection.status).toBe('failed');
  expect(state.internalState.workflowState.loadSection.error).toBe('Generazione interrotta');
});

test('detached lesson failure does not notify the project that remains visible', async () => {
  const plan = buildPlan({ sections: [buildTestLesson({ id: 'lesson-1' })] });
  let rejectGeneration: ((error: Error) => void) | undefined;
  const generationGate = new Promise<never>((_, reject) => {
    rejectGeneration = reject;
  });
  const notify = vi.fn();
  const harness = createControllerHarness({
    domain: { learningPlan: plan },
    projectLibrary: { currentProjectId: 'project-a' },
    openRouter: {
      generateDurableLesson: async () => generationGate,
    },
  });

  const selection = harness.controller.openSection(getLessons(plan)[0]).catch(error => {
    notify(String(error));
    return 'notified' as const;
  });
  harness.projectLibrary.adapter.setCurrentProjectId('project-b');
  harness.state.adapter.invalidateWorkflows(['loadSection']);
  rejectGeneration?.(new Error('Generazione A interrotta'));

  expect(await selection).toBe('ignored-busy');
  expect(notify).not.toHaveBeenCalled();
  expect(harness.state.adapter.isGenerationActive('project-a')).toBe(false);
  expect(harness.projectLibrary.adapter.currentProjectId).toBe('project-b');
});

test('lesson generation failure stays detached after returning to the library', async () => {
  const plan = buildPlan({ sections: [buildTestLesson({ id: 'lesson-1' })] });
  let rejectGeneration: ((error: Error) => void) | undefined;
  let markGenerationStarted: (() => void) | undefined;
  const generationStarted = new Promise<void>(resolve => {
    markGenerationStarted = resolve;
  });
  const generationGate = new Promise<never>((_, reject) => {
    rejectGeneration = reject;
  });
  const notify = vi.fn();
  const harness = createControllerHarness({
    domain: { learningPlan: plan },
    openRouter: {
      generateDurableLesson: async () => {
        markGenerationStarted?.();
        return generationGate;
      },
    },
    projectLibrary: { currentProjectId: 'project-1' },
  });

  const selection = harness.controller.openSection(getLessons(plan)[0]).catch(error => {
    notify(String(error));
    return 'notified' as const;
  });
  await generationStarted;
  await harness.controller.goToLibrary();
  rejectGeneration?.(new Error('Generazione interrotta'));

  expect(await selection).toBe('ignored-busy');
  expect(notify).not.toHaveBeenCalled();
  expect(harness.state.internalState.screenState).toBe(AppState.LIBRARY);
  expect(harness.state.internalState.workflowState.loadSection.status).toBe('idle');
});

test('opening a ready lesson detaches the previous lesson generation view', async () => {
  const generatingLesson = buildTestLesson({ id: 'lesson-a' });
  const readyLesson = buildTestLesson({ content: '# Pronta', id: 'lesson-b' });
  const plan = buildPlan({ sections: [generatingLesson, readyLesson] });
  let rejectGeneration: ((error: Error) => void) | undefined;
  const generationGate = new Promise<never>((_, reject) => {
    rejectGeneration = reject;
  });
  const harness = createControllerHarness({
    domain: { learningPlan: plan },
    projectLibrary: { currentProjectId: 'project-1' },
    openRouter: { generateDurableLesson: async () => generationGate },
  });

  const generation = harness.controller.openSection(generatingLesson);
  await Promise.resolve();
  expect(await harness.controller.openSection(readyLesson)).toBe('reused-cached');
  rejectGeneration?.(new Error('Generazione interrotta'));

  expect(await generation).toBe('ignored-busy');
  expect(harness.domain.activeSectionId).toBe(readyLesson.id);
  expect(harness.state.internalState.workflowState.loadSection.status).toBe('idle');
});

test('detached lesson completion releases the pending workflow', async () => {
  const generatingLesson = buildTestLesson({ id: 'lesson-a' });
  const readyLesson = buildTestLesson({ content: '# Pronta', id: 'lesson-b' });
  const plan = buildPlan({ sections: [generatingLesson, readyLesson] });
  let releaseGeneration: (() => void) | undefined;
  const generationGate = new Promise<void>(resolve => {
    releaseGeneration = resolve;
  });
  const harness = createControllerHarness({
    domain: { learningPlan: plan },
    projectLibrary: { currentProjectId: 'project-1' },
    openRouter: {
      generateDurableLesson: async () => {
        await generationGate;
        return {
          content: '# Generata',
          contentBlocks: [],
          generatedVisuals: [],
          imageRefs: [],
          learningAids: [],
          projectId: 'project-1',
          quiz: [],
          sectionId: generatingLesson.id,
          warnings: [],
        };
      },
    },
  });

  const generation = harness.controller.openSection(generatingLesson);
  await Promise.resolve();
  expect(await harness.controller.openSection(readyLesson)).toBe('reused-cached');
  releaseGeneration?.();

  expect(await generation).toBe('loaded');
  expect(harness.state.internalState.workflowState.loadSection.status).toBe('idle');
});

test('lesson generation reattaches while another project owns the pending workflow', async () => {
  const plan = buildPlan({ sections: [buildTestLesson({ id: 'lesson-1' })] });
  let rejectProjectA: ((error: Error) => void) | undefined;
  let resolveProjectB: (() => void) | undefined;
  const projectAGate = new Promise<never>((_, reject) => {
    rejectProjectA = reject;
  });
  const projectBGate = new Promise<void>(resolve => {
    resolveProjectB = resolve;
  });
  const generateDurableLesson = vi.fn(async ({ projectId }: { projectId: string }) => {
    if (projectId === 'project-a') return projectAGate;
    await projectBGate;
    return {
      content: '# Lezione generata',
      contentBlocks: [],
      generatedVisuals: [],
      imageRefs: [],
      learningAids: [],
      projectId,
      quiz: [],
      sectionId: 'lesson-1',
      warnings: [],
    };
  });
  const harness = createControllerHarness({
    domain: { learningPlan: plan },
    projectLibrary: { currentProjectId: 'project-a' },
    openRouter: { generateDurableLesson },
  });
  const lesson = getLessons(plan)[0];

  const projectAGeneration = harness.controller.openSection(lesson);
  await Promise.resolve();
  harness.state.adapter.invalidateWorkflows(['loadSection']);
  harness.projectLibrary.adapter.setCurrentProjectId('project-b');
  const projectBGeneration = harness.controller.openSection(lesson);
  await Promise.resolve();

  harness.projectLibrary.adapter.setCurrentProjectId('project-a');
  expect(await harness.controller.openSection(lesson)).toBe('reopened-generating');
  rejectProjectA?.(new Error('Generazione A interrotta'));

  await expect(projectAGeneration).rejects.toThrow('Generazione A interrotta');
  expect(harness.state.internalState.workflowState.loadSection.status).toBe('failed');
  expect(harness.state.internalState.workflowState.loadSection.error).toBe(
    'Generazione A interrotta'
  );

  harness.projectLibrary.adapter.setCurrentProjectId('project-b');
  expect(await harness.controller.openSection(lesson)).toBe('reopened-generating');
  resolveProjectB?.();
  expect(await projectBGeneration).toBe('loaded');
  expect(generateDurableLesson).toHaveBeenCalledTimes(2);
  expect(harness.state.internalState.workflowState.loadSection.status).toBe('succeeded');
});

test('overlapping project generations keep their terminal results when they resolve out of order', async () => {
  const plan = buildPlan({ sections: [buildTestLesson({ id: 'lesson-1' })] });
  const generationResolvers = new Map<string, () => void>();
  const generateDurableLesson = vi.fn(async ({ projectId }: { projectId: string }) => {
    await new Promise<void>(resolve => {
      generationResolvers.set(projectId, resolve);
    });
    return {
      content: `# Lezione ${projectId}`,
      contentBlocks: [],
      generatedVisuals: [],
      imageRefs: [],
      learningAids: [],
      projectId,
      quiz: [],
      sectionId: 'lesson-1',
      warnings: [],
    };
  });
  const harness = createControllerHarness({
    domain: { learningPlan: plan },
    projectLibrary: { currentProjectId: 'project-a' },
    openRouter: { generateDurableLesson },
  });
  const lesson = getLessons(plan)[0];

  const projectAGeneration = harness.controller.openSection(lesson);
  await vi.waitFor(() => expect(generationResolvers.has('project-a')).toBe(true));
  harness.state.adapter.invalidateWorkflows(['loadSection']);
  harness.projectLibrary.adapter.setCurrentProjectId('project-b');
  const projectBGeneration = harness.controller.openSection(lesson);
  await vi.waitFor(() => expect(generationResolvers.has('project-b')).toBe(true));

  harness.projectLibrary.adapter.setCurrentProjectId('project-a');
  expect(await harness.controller.openSection(lesson)).toBe('reopened-generating');
  harness.projectLibrary.adapter.setCurrentProjectId('project-b');
  expect(await harness.controller.openSection(lesson)).toBe('reopened-generating');

  generationResolvers.get('project-a')?.();
  expect(await projectAGeneration).toBe('loaded');
  generationResolvers.get('project-b')?.();
  expect(await projectBGeneration).toBe('loaded');
  expect(generateDurableLesson).toHaveBeenCalledTimes(2);
});

test('out-of-order detached missing-source failures retain every affected project', async () => {
  const lesson = buildTestLesson({ id: 'lesson-1' });
  const plan = buildPlan({ sections: [lesson] });
  const rejectGenerationByProject = new Map<string, (error: Error) => void>();
  const harness = createControllerHarness({
    domain: { learningPlan: plan },
    projectLibrary: { currentProjectId: 'project-a' },
    openRouter: {
      generateDurableLesson: input =>
        new Promise((_, reject) => {
          rejectGenerationByProject.set(input.projectId, reject);
        }),
    },
  });

  const projectAGeneration = harness.controller.openSection(lesson);
  await Promise.resolve();
  harness.projectLibrary.adapter.setCurrentProjectId('project-b');
  harness.state.adapter.invalidateWorkflows(['loadSection']);
  const projectBGeneration = harness.controller.openSection(lesson);
  await Promise.resolve();

  rejectGenerationByProject.get('project-b')?.(new LessonSourceUnavailableError());
  await expect(projectBGeneration).rejects.toBeInstanceOf(LessonSourceUnavailableError);
  rejectGenerationByProject.get('project-a')?.(new LessonSourceUnavailableError());
  expect(await projectAGeneration).toBe('ignored-busy');

  expect(harness.state.adapter.hasMissingSource('project-a')).toBe(true);
  expect(harness.state.adapter.hasMissingSource('project-b')).toBe(true);
});

test('an active lesson generation blocks exercise brief and placement generation after workflow invalidation', async () => {
  const exercise: ApplicationExerciseNode = {
    kind: 'exercise',
    id: 'exercise-1',
    title: 'Laboratorio',
    description: 'Applica il metodo.',
    assessedObjective: 'Applicare il metodo correttamente.',
    attachments: [],
    currentFeedback: null,
    feedbackStale: false,
    internalText: '',
    isCompleted: false,
    updatedAt: '2026-03-20T10:00:00.000Z',
  };
  const plan = buildPlan();
  plan.modules[0]?.children.unshift(exercise);
  let releaseLesson: (() => void) | undefined;
  let markLessonStarted: (() => void) | undefined;
  const lessonGate = new Promise<void>(resolve => {
    releaseLesson = resolve;
  });
  const lessonStarted = new Promise<void>(resolve => {
    markLessonStarted = resolve;
  });
  const generateApplicationExerciseBrief = vi.fn(async () => ({
    brief: '# Consegna',
    groundingSources: [],
  }));
  const generateApplicationExercisePlacements = vi.fn(async () => ({
    plan,
    placedCount: 0,
  }));
  const { controller, state } = createControllerHarness({
    domain: {
      file: pdfFile,
      learningPlan: plan,
      source: createProjectSourceFromFile(pdfFile),
    },
    projectLibrary: { currentProjectId: 'project-1' },
    openRouter: {
      generateApplicationExerciseBrief,
      generateApplicationExercisePlacements,
      getExercisePrerequisiteGaps: () => [],
      generateDurableLesson: async () => {
        markLessonStarted?.();
        await lessonGate;
        return {
          content: '# Lezione generata',
          contentBlocks: [],
          documentAssets: null,
          generatedVisuals: [],
          imageRefs: [],
          learningAids: [],
          projectId: 'project-1',
          quiz: [],
          sectionId: 'lesson-1',
          warnings: [],
        };
      },
    },
  });

  const lessonGeneration = controller.openSection(getLessons(plan)[0]);
  await lessonStarted;
  state.adapter.invalidateWorkflows(['loadSection']);

  await controller.openExercise(exercise);
  const repairResult = await controller.repairApplicationExercises();

  assert.equal(generateApplicationExerciseBrief.mock.calls.length, 0);
  assert.equal(generateApplicationExercisePlacements.mock.calls.length, 0);
  assert.deepEqual(repairResult, { outcome: 'noop' });

  releaseLesson?.();
  assert.equal(await lessonGeneration, 'loaded');
});

test('exercise brief generation keeps its gate after workflow invalidation until the provider call settles', async () => {
  const exercise: ApplicationExerciseNode = {
    kind: 'exercise',
    id: 'exercise-1',
    title: 'Laboratorio',
    description: 'Applica il metodo.',
    assessedObjective: 'Applicare il metodo correttamente.',
    attachments: [],
    currentFeedback: null,
    feedbackStale: false,
    internalText: '',
    isCompleted: false,
    updatedAt: '2026-03-20T10:00:00.000Z',
  };
  const plan = buildPlan();
  plan.modules[0]?.children.unshift(exercise);
  let releaseBrief: (() => void) | undefined;
  let markBriefStarted: (() => void) | undefined;
  const briefGate = new Promise<void>(resolve => {
    releaseBrief = resolve;
  });
  const briefStarted = new Promise<void>(resolve => {
    markBriefStarted = resolve;
  });
  const generateDurableLesson = vi.fn(async () => ({
    content: '# Lezione generata',
    contentBlocks: [],
    documentAssets: null,
    generatedVisuals: [],
    imageRefs: [],
    learningAids: [],
    projectId: 'project-1',
    quiz: [],
    sectionId: 'lesson-1',
    warnings: [],
  }));
  const { controller, state } = createControllerHarness({
    domain: {
      file: pdfFile,
      learningPlan: plan,
      source: createProjectSourceFromFile(pdfFile),
    },
    projectLibrary: { currentProjectId: 'project-1' },
    openRouter: {
      generateApplicationExerciseBrief: async () => {
        markBriefStarted?.();
        await briefGate;
        return { brief: '# Consegna', groundingSources: [] };
      },
      generateDurableLesson,
      getExercisePrerequisiteGaps: () => [],
    },
  });

  const briefGeneration = controller.openExercise(exercise);
  await briefStarted;
  state.adapter.invalidateWorkflows(['loadSection']);

  const lessonResult = await controller.openSection(getLessons(plan)[0]);

  assert.equal(lessonResult, 'ignored-busy');
  assert.equal(generateDurableLesson.mock.calls.length, 0);

  releaseBrief?.();
  await briefGeneration;
});

test('exercise brief generation does not update a project opened while the provider settles', async () => {
  const exercise: ApplicationExerciseNode = {
    kind: 'exercise',
    id: 'exercise-1',
    title: 'Laboratorio',
    description: 'Applica il metodo.',
    assessedObjective: 'Applicare il metodo correttamente.',
    attachments: [],
    currentFeedback: null,
    feedbackStale: false,
    internalText: '',
    isCompleted: false,
    updatedAt: '2026-03-20T10:00:00.000Z',
  };
  const plan = buildPlan();
  plan.modules[0]?.children.unshift(exercise);
  const replacementPlan = buildPlan({
    sections: [buildTestLesson({ id: 'lesson-b', content: '# Lezione B' })],
  });
  const replacementSource = createProjectSourceFromFile({
    ...pdfFile,
    name: 'replacement.pdf',
  });
  let resolveBrief: ((value: { brief: string; groundingSources: [] }) => void) | undefined;
  let markBriefStarted: (() => void) | undefined;
  const briefResult = new Promise<{ brief: string; groundingSources: [] }>(resolve => {
    resolveBrief = resolve;
  });
  const briefStarted = new Promise<void>(resolve => {
    markBriefStarted = resolve;
  });
  const { controller, domain, projectLibrary } = createControllerHarness({
    domain: {
      file: pdfFile,
      learningPlan: plan,
      source: createProjectSourceFromFile(pdfFile),
    },
    loadedSnapshot: createProjectSnapshot({
      id: 'project-b',
      source: replacementSource,
      learningPlan: replacementPlan,
      activeSectionId: 'lesson-b',
      state: AppState.READING,
    }),
    projectLibrary: { currentProjectId: 'project-a' },
    openRouter: {
      generateApplicationExerciseBrief: () => {
        markBriefStarted?.();
        return briefResult;
      },
      getExercisePrerequisiteGaps: () => [],
    },
  });

  const briefGeneration = controller.openExercise(exercise);
  await briefStarted;
  await controller.goToLibrary();
  assert.deepEqual(await controller.openProject('project-b'), { outcome: 'opened' });
  const saveCountBeforeBriefSettles = projectLibrary.savedOverrides.length;
  resolveBrief?.({ brief: '# Consegna tardiva', groundingSources: [] });
  await briefGeneration;

  assert.equal(domain.source, replacementSource);
  assert.equal(domain.learningPlan, replacementPlan);
  assert.equal(projectLibrary.savedOverrides.length, saveCountBeforeBriefSettles);
});

test('exercise placement repair keeps its gate after workflow invalidation until the provider call settles', async () => {
  const plan = buildPlan();
  let resolvePlacement: ((value: { plan: LearningPlan; placedCount: number }) => void) | undefined;
  let markPlacementStarted: (() => void) | undefined;
  const placementResult = new Promise<{ plan: LearningPlan; placedCount: number }>(resolve => {
    resolvePlacement = resolve;
  });
  const placementStarted = new Promise<void>(resolve => {
    markPlacementStarted = resolve;
  });
  const generateDurableLesson = vi.fn(async () => ({
    content: '# Lezione generata',
    contentBlocks: [],
    documentAssets: null,
    generatedVisuals: [],
    imageRefs: [],
    learningAids: [],
    projectId: 'project-1',
    quiz: [],
    sectionId: 'lesson-1',
    warnings: [],
  }));
  const { controller, state } = createControllerHarness({
    domain: {
      file: pdfFile,
      learningPlan: plan,
      source: createProjectSourceFromFile(pdfFile),
    },
    projectLibrary: { currentProjectId: 'project-1' },
    openRouter: {
      generateApplicationExercisePlacements: () => {
        markPlacementStarted?.();
        return placementResult;
      },
      generateDurableLesson,
    },
  });

  const repair = controller.repairApplicationExercises();
  await placementStarted;
  state.adapter.invalidateWorkflows(['generateExercise']);

  const lessonResult = await controller.openSection(getLessons(plan)[0]);

  assert.equal(lessonResult, 'ignored-busy');
  assert.equal(generateDurableLesson.mock.calls.length, 0);

  resolvePlacement?.({ plan, placedCount: 0 });
  assert.deepEqual(await repair, { outcome: 'noop' });
});

test('exercise placement repair ignores a stale provider failure after workflow invalidation', async () => {
  const plan = buildPlan();
  let rejectPlacement: ((error: Error) => void) | undefined;
  let markPlacementStarted: (() => void) | undefined;
  const placementResult = new Promise<{ plan: LearningPlan; placedCount: number }>((_, reject) => {
    rejectPlacement = reject;
  });
  const placementStarted = new Promise<void>(resolve => {
    markPlacementStarted = resolve;
  });
  const { controller, domain, projectLibrary, state } = createControllerHarness({
    domain: {
      file: pdfFile,
      learningPlan: plan,
      source: createProjectSourceFromFile(pdfFile),
    },
    projectLibrary: { currentProjectId: 'project-1' },
    openRouter: {
      generateApplicationExercisePlacements: () => {
        markPlacementStarted?.();
        return placementResult;
      },
    },
  });

  const repair = controller.repairApplicationExercises();
  await placementStarted;
  state.adapter.invalidateWorkflows(['generateExercise']);

  rejectPlacement?.(new Error('Errore tardivo'));

  assert.deepEqual(await repair, { outcome: 'noop' });
  assert.equal(domain.learningPlan, plan);
  assert.equal(projectLibrary.savedOverrides.length, 0);
  assert.equal(state.internalState.workflowState.generateExercise.status, 'idle');
});

test('exercise placement generation blocks lesson, sublesson, and exercise brief generation', async () => {
  const exercise: ApplicationExerciseNode = {
    kind: 'exercise',
    id: 'exercise-1',
    title: 'Laboratorio',
    description: 'Applica il metodo.',
    assessedObjective: 'Applicare il metodo correttamente.',
    attachments: [],
    currentFeedback: null,
    feedbackStale: false,
    internalText: '',
    isCompleted: false,
    updatedAt: '2026-03-20T10:00:00.000Z',
  };
  const plan = buildPlan();
  plan.modules[0]?.children.unshift(exercise);
  let resolvePlacement: ((value: { plan: LearningPlan; placedCount: number }) => void) | undefined;
  let markPlacementStarted: (() => void) | undefined;
  const placementResult = new Promise<{ plan: LearningPlan; placedCount: number }>(resolve => {
    resolvePlacement = resolve;
  });
  const placementStarted = new Promise<void>(resolve => {
    markPlacementStarted = resolve;
  });
  const generateApplicationExercisePlacements = vi.fn(() => {
    markPlacementStarted?.();
    return placementResult;
  });
  const generateApplicationExerciseBrief = vi.fn(async () => ({
    brief: '# Consegna',
    groundingSources: [],
  }));
  const generateDurableSublesson = vi.fn();
  const generateDurableLesson = vi.fn(async () => ({
    content: '# Lezione generata',
    contentBlocks: [],
    documentAssets: null,
    generatedVisuals: [],
    imageRefs: [],
    learningAids: [],
    projectId: 'project-1',
    quiz: [],
    sectionId: 'lesson-1',
    warnings: [],
  }));
  const { controller } = createControllerHarness({
    domain: {
      activeSectionId: 'lesson-1',
      documentIndex: createReadyIndex(),
      file: pdfFile,
      learningPlan: plan,
      source: createProjectSourceFromFile(pdfFile),
    },
    projectLibrary: { currentProjectId: 'project-1' },
    openRouter: {
      generateApplicationExerciseBrief,
      generateApplicationExercisePlacements,
      generateDurableLesson,
      generateDurableSublesson,
      getExercisePrerequisiteGaps: () => [],
    },
  });

  const repair = controller.repairApplicationExercises();
  await placementStarted;

  const sublessonResult = await controller.createLessonFromSelection({
    instructions: 'Approfondisci',
    selectedText: 'testo',
  });
  const lessonResult = await controller.openSection(getLessons(plan)[0]);
  await controller.openExercise(exercise);

  assert.equal(sublessonResult.outcome, 'failed');
  assert.equal(lessonResult, 'ignored-busy');
  assert.equal(generateDurableSublesson.mock.calls.length, 0);
  assert.equal(generateDurableLesson.mock.calls.length, 0);
  assert.equal(generateApplicationExerciseBrief.mock.calls.length, 0);

  resolvePlacement?.({ plan, placedCount: 0 });
  assert.deepEqual(await repair, { outcome: 'repaired' });
});

test('createLessonFromSelection applies detached durable completion without changing the open project', async () => {
  const firstPlan = buildPlan();
  const secondPlan = buildPlan({
    sections: [buildTestLesson({ id: 'project-2-lesson', title: 'Secondo progetto' })],
  });
  let releaseGeneration: (() => void) | undefined;
  let markGenerationStarted: (() => void) | undefined;
  const generationGate = new Promise<void>(resolve => {
    releaseGeneration = resolve;
  });
  const generationStarted = new Promise<void>(resolve => {
    markGenerationStarted = resolve;
  });
  const applyPersistedProjectRevision = vi.fn(async () => true);
  const harness = createControllerHarness({
    domain: {
      activeSectionId: 'lesson-1',
      isLearnMode: true,
      learningPlan: firstPlan,
    },
    projectLibrary: {
      applyPersistedProjectRevision,
      currentProjectId: 'project-1',
    },
    openRouter: {
      generateDurableSublesson: async input => {
        markGenerationStarted?.();
        await generationGate;
        return {
          content: '# Approfondimento',
          contentBlocks: [],
          generatedVisuals: [],
          imageRefs: [],
          learningAids: [],
          projectId: input.projectId,
          projectRevision: 2,
          quiz: [],
          sectionId: 'deep-project-1',
          warnings: [],
        };
      },
    },
  });

  const creation = harness.controller.createLessonFromSelection({
    instructions: 'Approfondisci',
    selectedText: 'testo',
  });
  await generationStarted;

  harness.projectLibrary.adapter.setCurrentProjectId('project-2');
  harness.state.adapter.invalidateWorkflows(['createLesson']);
  harness.domain.hydrateSnapshot(
    createProjectSnapshot({
      activeSectionId: 'project-2-lesson',
      id: 'project-2',
      isLearnMode: true,
      learningPlan: secondPlan,
    })
  );
  releaseGeneration?.();

  expect(await creation).toEqual({ outcome: 'ignored-busy' });
  expect(harness.domain.activeSectionId).toBe('project-2-lesson');
  expect(harness.domain.learningPlan?.modules[0]?.children[0]?.id).toBe('project-2-lesson');
  expect(applyPersistedProjectRevision.mock.calls).toEqual([
    [{ projectId: 'project-1', revision: 2 }],
  ]);
});

test('openProject reattaches an in-memory sublesson before its child is persisted', async () => {
  const parentLesson = buildTestLesson({ content: '# Lezione', id: 'lesson-1' });
  const plan = buildPlan({ sections: [parentLesson] });
  const snapshot = createProjectSnapshot({
    activeSectionId: parentLesson.id,
    id: 'project-1',
    learningPlan: plan,
    source: createProjectSourceFromFile(markdownFile),
    state: AppState.READING,
  });
  let releaseGeneration: (() => void) | undefined;
  let markGenerationStarted: (() => void) | undefined;
  const generationGate = new Promise<void>(resolve => {
    releaseGeneration = resolve;
  });
  const generationStarted = new Promise<void>(resolve => {
    markGenerationStarted = resolve;
  });
  const resolveDurableSublessonRequestForParent = vi.fn();
  const generateDurableSublesson = vi.fn(async input => {
    input.onWorkflowSnapshot?.(buildLessonRecovery('deep-1').job);
    markGenerationStarted?.();
    await generationGate;
    return {
      content: '# Approfondimento',
      contentBlocks: [],
      generatedVisuals: [],
      imageRefs: [],
      learningAids: [],
      projectId: 'project-1',
      projectRevision: 2,
      quiz: [],
      sectionId: 'deep-1',
      warnings: [],
    };
  });
  const harness = createControllerHarness({
    domain: { activeSectionId: parentLesson.id, learningPlan: plan },
    loadedSnapshot: snapshot,
    projectLibrary: {
      applyPersistedProjectRevision: async () => true,
      currentProjectId: 'project-1',
    },
    openRouter: {
      generateDurableSublesson,
      hasDurableSublessonRequest: (projectId, parentSectionId) =>
        projectId === snapshot.id && parentSectionId === parentLesson.id,
      resolveDurableSublessonRequestForParent,
    },
  });

  const creation = harness.controller.createLessonFromSelection({
    instructions: 'Approfondisci',
    selectedText: 'testo',
  });
  await generationStarted;
  await harness.controller.goToLibrary();
  expect((await harness.controller.openProject(snapshot.id)).outcome).toBe('opened');
  await vi.waitFor(() =>
    expect(harness.state.internalState.workflowState.createLesson.status).toBe('pending')
  );

  expect(generateDurableSublesson).toHaveBeenCalledOnce();
  expect(resolveDurableSublessonRequestForParent).not.toHaveBeenCalled();
  expect(harness.state.adapter.getGeneratingSectionId(snapshot.id)).toBe('deep-1');
  releaseGeneration?.();

  expect(await creation).toEqual({ outcome: 'created' });
  expect(harness.state.adapter.isGenerationActive(snapshot.id)).toBe(false);
});

test('does not attach a sublesson workflow after navigating to another section', async () => {
  const parentLesson = buildTestLesson({ id: 'lesson-1' });
  const readyLesson = buildTestLesson({ content: '# Pronta', id: 'lesson-2' });
  const plan = buildPlan({ sections: [parentLesson, readyLesson] });
  let rejectGeneration: ((error: Error) => void) | undefined;
  let markGenerationStarted: (() => void) | undefined;
  let onWorkflowSnapshot: ((snapshot: LessonWorkflowSnapshot) => void) | undefined;
  const generationStarted = new Promise<void>(resolve => {
    markGenerationStarted = resolve;
  });
  const generationGate = new Promise<never>((_, reject) => {
    rejectGeneration = reject;
  });
  const harness = createControllerHarness({
    domain: { activeSectionId: parentLesson.id, learningPlan: plan },
    projectLibrary: { currentProjectId: 'project-1' },
    openRouter: {
      generateDurableSublesson: async input => {
        onWorkflowSnapshot = input.onWorkflowSnapshot;
        markGenerationStarted?.();
        return generationGate;
      },
    },
  });
  const recordWorkflowSnapshot = vi.spyOn(feedbackDiagnostics, 'recordFeedbackWorkflowSnapshot');

  try {
    const creation = harness.controller.createLessonFromSelection({
      instructions: 'Approfondisci',
      selectedText: 'testo',
    });
    await generationStarted;
    expect(await harness.controller.openSection(readyLesson)).toBe('reused-cached');
    onWorkflowSnapshot?.({
      createdAt: '2026-08-28T00:00:00.000Z',
      id: 'sublesson-run',
      projectId: 'project-1',
      retrying: false,
      sectionId: 'deep-1',
      stage: 'sources',
      status: 'running',
      updatedAt: '2026-08-28T00:00:00.000Z',
    });

    expect(recordWorkflowSnapshot).not.toHaveBeenCalled();
    rejectGeneration?.(new Error('Generazione interrotta'));
    expect(await creation).toEqual({ outcome: 'ignored-busy' });
  } finally {
    recordWorkflowSnapshot.mockRestore();
  }
});

test('sublesson failure follows synchronous section navigation when the library getter lags', async () => {
  const parentLesson = buildTestLesson({ id: 'lesson-1' });
  const readyLesson = buildTestLesson({ content: '# Pronta', id: 'lesson-2' });
  const plan = buildPlan({ sections: [parentLesson, readyLesson] });
  let rejectGeneration: ((error: Error) => void) | undefined;
  let markGenerationStarted: (() => void) | undefined;
  const generationStarted = new Promise<void>(resolve => {
    markGenerationStarted = resolve;
  });
  const generationGate = new Promise<never>((_, reject) => {
    rejectGeneration = reject;
  });
  const harness = createControllerHarness({
    domain: { activeSectionId: parentLesson.id, learningPlan: plan },
    projectLibrary: { currentProjectId: 'project-1' },
    openRouter: {
      generateDurableSublesson: async () => {
        markGenerationStarted?.();
        return generationGate;
      },
    },
  });
  harness.projectLibrary.adapter.getCurrentActiveSectionId = () => parentLesson.id;

  const creation = harness.controller.createLessonFromSelection({
    instructions: 'Approfondisci',
    selectedText: 'testo',
  });
  await generationStarted;
  expect(await harness.controller.openSection(readyLesson)).toBe('reused-cached');
  rejectGeneration?.(new Error('Generazione interrotta'));

  expect(await creation).toEqual({ outcome: 'ignored-busy' });
  expect(harness.domain.activeSectionId).toBe(readyLesson.id);
  expect(harness.state.internalState.workflowState.createLesson.status).toBe('idle');
});

test('createLessonFromSelection persists its parent before starting durable work', async () => {
  const parentLesson = buildTestLesson({ content: '# Lezione', id: 'lesson-1' });
  let finishPersistence: ((value: SavedProjectMeta | null) => void) | undefined;
  const patchCurrentProject = vi.fn(
    () =>
      new Promise<SavedProjectMeta | null>(resolve => {
        finishPersistence = resolve;
      })
  );
  const generateDurableSublesson = vi.fn(async () => ({
    content: '# Approfondimento',
    contentBlocks: [],
    generatedVisuals: [],
    imageRefs: [],
    learningAids: [],
    projectId: 'project-1',
    projectRevision: 2,
    quiz: [],
    sectionId: 'deep-1',
    warnings: [],
  }));
  const harness = createControllerHarness({
    domain: {
      activeSectionId: parentLesson.id,
      learningPlan: buildPlan({ sections: [parentLesson] }),
    },
    openRouter: { generateDurableSublesson },
    projectLibrary: { currentProjectId: 'project-1', patchCurrentProject },
  });

  const creation = harness.controller.createLessonFromSelection({
    instructions: 'Approfondisci',
    selectedText: 'testo',
  });
  await vi.waitFor(() => expect(patchCurrentProject).toHaveBeenCalledOnce());
  expect(generateDurableSublesson).not.toHaveBeenCalled();

  finishPersistence?.(buildMeta('project-1'));
  await expect(creation).resolves.toEqual({ outcome: 'created' });
  expect(generateDurableSublesson).toHaveBeenCalledOnce();
});

test('createLessonFromSelection does not start when its parent selection was not saved', async () => {
  setRenderingLocaleOverride('en');
  const parentLesson = buildTestLesson({ content: '# Lezione', id: 'lesson-1' });
  const generateDurableSublesson = vi.fn();
  const harness = createControllerHarness({
    domain: {
      activeSectionId: parentLesson.id,
      learningPlan: buildPlan({ sections: [parentLesson] }),
    },
    openRouter: { generateDurableSublesson },
    projectLibrary: {
      currentProjectId: 'project-1',
      patchCurrentProject: async () => null,
    },
  });

  const result = await harness.controller.createLessonFromSelection({
    instructions: 'Approfondisci',
    selectedText: 'testo',
  });

  expect(result).toEqual({
    errorMessage: t('Non sono riuscito a salvare la lezione da generare. Riprova.'),
    outcome: 'failed',
  });
  expect(generateDurableSublesson).not.toHaveBeenCalled();
  expect(harness.state.adapter.isGenerationActive('project-1')).toBe(false);
});

test('createLessonFromSelection hydrates and opens the authoritative durable sublesson', async () => {
  const basePlan = buildPlan({
    sections: [
      {
        id: 'lesson-1',
        title: 'Lezione 1',
        description: 'Intro',
        isCompleted: false,
        type: 'core',
      },
      {
        id: 'lesson-1-deep-existing',
        title: 'Approfondimento esistente',
        description: 'Gia presente',
        isCompleted: false,
        type: 'deep-dive',
        parentId: 'lesson-1',
      },
      {
        id: 'lesson-2',
        title: 'Lezione 2',
        description: 'Follow-up',
        isCompleted: false,
        type: 'core',
      },
    ],
  });
  const generatedPlan = buildPlan({
    sections: [
      ...getLessons(basePlan).slice(0, 2),
      buildTestLesson({
        id: 'deep-server',
        title: 'Approfondimento generato',
        type: 'deep-dive',
        parentId: 'lesson-1',
        content: '# Lezione generata',
      }),
      ...getLessons(basePlan).slice(2),
    ],
  });
  const generateDurableSublesson = vi.fn(
    async (
      _input: Parameters<
        typeof import('../../../services/openrouter/index.ts').generateDurableSublesson
      >[0]
    ) => ({
      content: '# Lezione generata',
      contentBlocks: [],
      generatedVisuals: [],
      imageRefs: [],
      learningAids: [],
      projectId: 'project-1',
      projectRevision: 8,
      quiz: [],
      sectionId: 'deep-server',
      warnings: [],
    })
  );
  const harness = createControllerHarness({
    domain: {
      activeSectionId: 'lesson-1',
      documentIndex: createReadyIndex(),
      file: pdfFile,
      learningPlan: basePlan,
      source: createProjectSourceFromFile(pdfFile),
      domainState: {
        source: createProjectSourceFromFile(pdfFile),
        learningPlan: basePlan,
        documentAssets: null,
        documentIndex: createReadyIndex(),
        isLearnMode: false,
        userProfile: null,
        syllabus: [],
        activeSectionId: 'lesson-1',
      },
    },
    openRouter: { generateDurableSublesson },
    projectLibrary: { currentProjectId: 'project-1' },
  });
  harness.projectLibrary.adapter.applyPersistedProjectRevision = async args => {
    harness.projectLibrary.appliedProjectRevisions.push(args);
    harness.domain.hydrateSnapshot(
      createProjectSnapshot({
        activeSectionId: 'deep-server',
        documentIndex: createReadyIndex(),
        id: 'project-1',
        learningPlan: generatedPlan,
        source: createProjectSourceFromFile(pdfFile),
        state: AppState.READING,
      })
    );
    return true;
  };

  const result = await harness.controller.createLessonFromSelection({
    annotationNote: 'Nota',
    contextAfter: 'Dopo',
    contextBefore: 'Prima',
    instructions: 'Approfondisci',
    selectedText: 'testo',
  });

  assert.equal(result.outcome, 'created');
  assert.equal(harness.domain.activeSectionId, 'deep-server');
  assert.equal(getLessons(harness.domain.learningPlan)[2]?.content, '# Lezione generata');
  assert.deepEqual(harness.projectLibrary.appliedProjectRevisions, [
    { projectId: 'project-1', revision: 8 },
  ]);
  const request = generateDurableSublesson.mock.calls[0]?.[0];
  assert.equal(request?.parentSectionId, 'lesson-1');
  assert.equal(request?.selectedText, 'testo');
  assert.equal(request?.annotationNote, 'Nota');
  assert.equal('parentContent' in (request ?? {}), false);
});

test('createLessonFromSelection leaves local state untouched when durable generation fails', async () => {
  const basePlan = buildPlan({
    sections: [
      {
        id: 'lesson-1',
        title: 'Lezione 1',
        description: 'Intro',
        isCompleted: false,
        type: 'core',
        content: '# Lezione 1',
        quiz: [],
      },
      {
        id: 'lesson-2',
        title: 'Lezione 2',
        description: 'Follow-up',
        isCompleted: false,
        type: 'core',
        content: '# Lezione 2',
        quiz: [],
      },
    ],
  });

  const { controller, domain, projectLibrary, state } = createControllerHarness({
    domain: {
      activeSectionId: 'lesson-1',
      documentIndex: createReadyIndex(),
      file: pdfFile,
      learningPlan: basePlan,
      source: createProjectSourceFromFile(pdfFile),
      domainState: {
        source: createProjectSourceFromFile(pdfFile),
        learningPlan: basePlan,
        documentAssets: null,
        documentIndex: createReadyIndex(),
        isLearnMode: false,
        userProfile: null,
        syllabus: [],
        activeSectionId: 'lesson-1',
      },
    },
    openRouter: {
      generateDurableSublesson: async () => {
        throw new Error('Risposta troncata');
      },
    },
    projectLibrary: { currentProjectId: 'project-1' },
  });

  const result = await controller.createLessonFromSelection({
    instructions: 'Approfondisci',
    selectedText: 'testo',
  });

  assert.equal(result.outcome, 'failed');
  assert.equal(domain.activeSectionId, 'lesson-1');
  assert.deepEqual(
    getLessons(domain.learningPlan).map(section => section.id),
    ['lesson-1', 'lesson-2']
  );
  assert.deepEqual(projectLibrary.savedOverrides, [
    { activeSectionId: 'lesson-1', state: AppState.READING },
  ]);
  assert.equal(state.internalState.workflowState.createLesson.status, 'failed');
});

test('evaluateApplicationExercise ignores a duplicate request and persists feedback for the current draft', async () => {
  const exercise: ApplicationExerciseNode = {
    kind: 'exercise',
    id: 'exercise-1',
    title: 'Laboratorio pratico',
    description: 'Applica il metodo a un caso concreto.',
    assessedObjective: 'Motivare una diagnosi con prove osservabili.',
    brief: 'Consegna una diagnosi motivata.',
    internalText: 'Bozza salvata in precedenza',
    attachments: [],
    currentFeedback: null,
    isCompleted: false,
    feedbackStale: false,
    updatedAt: '2026-03-20T10:00:00.000Z',
  };
  const plan = buildPlan();
  plan.modules[0]?.children.push(exercise);

  const feedback: ExerciseFeedback = {
    evaluatedAt: '2026-03-20T10:05:00.000Z',
    score: 84,
    qualitativeLabel: 'Obiettivo raggiunto',
    summary: 'La diagnosi collega correttamente prove e conclusioni.',
    strengths: ['Prove osservabili'],
    improvements: ['Esplicita un limite'],
    caveats: [],
  };
  let resolveFeedback: ((value: ExerciseFeedback) => void) | undefined;
  let markFeedbackStarted: (() => void) | undefined;
  const feedbackResult = new Promise<ExerciseFeedback>(resolve => {
    resolveFeedback = resolve;
  });
  const feedbackStarted = new Promise<void>(resolve => {
    markFeedbackStarted = resolve;
  });
  const generateApplicationExerciseFeedback = vi.fn(
    (
      _args: Parameters<
        typeof import('../../../services/openrouter/index.ts').generateApplicationExerciseFeedback
      >[0]
    ) => {
      markFeedbackStarted?.();
      return feedbackResult;
    }
  );
  const { controller, domain, projectLibrary, state } = createControllerHarness({
    domain: {
      activeSectionId: exercise.id,
      learningPlan: plan,
    },
    openRouter: { generateApplicationExerciseFeedback },
    projectLibrary: { currentProjectId: 'project-1' },
  });
  const currentDraft = 'Bozza corrente inviata subito';

  const firstRequest = controller.evaluateApplicationExercise(exercise.id, currentDraft);
  await feedbackStarted;
  const duplicateRequest = controller.evaluateApplicationExercise(exercise.id, currentDraft);
  await new Promise(resolve => setTimeout(resolve, 0));
  const requestCount = generateApplicationExerciseFeedback.mock.calls.length;
  resolveFeedback?.(feedback);

  assert.deepEqual(await Promise.all([firstRequest, duplicateRequest]), [
    { outcome: 'evaluated' },
    { outcome: 'noop' },
  ]);
  assert.equal(requestCount, 1);
  assert.equal(
    generateApplicationExerciseFeedback.mock.calls[0]?.[0].deliverable.entries.some(entry =>
      entry.text.includes(currentDraft)
    ),
    true
  );

  const persistedExercise = findPathNodeById(
    projectLibrary.savedOverrides[0]?.learningPlan?.modules,
    exercise.id
  );
  assert.equal(persistedExercise?.kind, 'exercise');
  assert.deepEqual(
    persistedExercise?.kind === 'exercise' ? persistedExercise.currentFeedback : null,
    feedback
  );
  const domainExercise = findPathNodeById(domain.learningPlan?.modules, exercise.id);
  assert.deepEqual(
    domainExercise?.kind === 'exercise' ? domainExercise.currentFeedback : null,
    feedback
  );
  assert.equal(state.internalState.workflowState.evaluateExercise.status, 'succeeded');
});

test('evaluateApplicationExercise does not apply feedback after switching projects', async () => {
  const exercise: ApplicationExerciseNode = {
    kind: 'exercise',
    id: 'exercise-project-a',
    title: 'Laboratorio pratico',
    description: 'Applica il metodo.',
    assessedObjective: 'Motivare una diagnosi.',
    brief: 'Consegna una diagnosi motivata.',
    internalText: 'Bozza A',
    attachments: [],
    currentFeedback: null,
    isCompleted: false,
    feedbackStale: false,
    updatedAt: '2026-03-20T10:00:00.000Z',
  };
  const projectAPlan = buildPlan();
  projectAPlan.modules[0]?.children.push(exercise);
  const projectBPlan = buildPlan({ title: 'Progetto B' });
  const feedback: ExerciseFeedback = {
    evaluatedAt: '2026-03-20T10:05:00.000Z',
    score: 84,
    qualitativeLabel: 'Obiettivo raggiunto',
    summary: 'Feedback progetto A.',
    strengths: ['Prove osservabili'],
    improvements: ['Esplicita un limite'],
    caveats: [],
  };
  let resolveSave: (() => void) | undefined;
  let markSaveStarted: (() => void) | undefined;
  const saveResult = new Promise<void>(resolve => {
    resolveSave = resolve;
  });
  const saveStarted = new Promise<void>(resolve => {
    markSaveStarted = resolve;
  });
  const { controller, domain, projectLibrary, state } = createControllerHarness({
    domain: {
      activeSectionId: exercise.id,
      learningPlan: projectAPlan,
    },
    openRouter: {
      generateApplicationExerciseFeedback: async () => feedback,
    },
    projectLibrary: {
      currentProjectId: 'project-a',
      patchCurrentProject: async () => {
        markSaveStarted?.();
        await saveResult;
        return buildMeta('project-a');
      },
    },
  });

  const evaluation = controller.evaluateApplicationExercise(exercise.id, 'Bozza aggiornata A');
  await saveStarted;
  projectLibrary.adapter.setCurrentProjectId('project-b');
  domain.setLearningPlan(projectBPlan);
  state.adapter.invalidateWorkflows(['evaluateExercise']);
  resolveSave?.();

  expect(await evaluation).toEqual({ outcome: 'noop' });
  expect(domain.learningPlan).toBe(projectBPlan);
});

test('completeActiveSection marks progress and opens the next lesson, then reports journey completion on the last one', async () => {
  const plan = buildPlan();
  const { controller, domain } = createControllerHarness({
    domain: {
      activeSectionId: 'lesson-1',
      learningPlan: plan,
      domainState: {
        source: null,
        learningPlan: plan,
        documentAssets: null,
        documentIndex: null,
        isLearnMode: false,
        userProfile: null,
        syllabus: [],
        activeSectionId: 'lesson-1',
      },
    },
  });

  const firstResult = await controller.completeActiveSection();
  assert.equal(firstResult, 'opened-next');
  assert.equal(getLessons(domain.learningPlan)[0]?.isCompleted, true);
  assert.equal(domain.activeSectionId, 'lesson-2');

  const singleLessonPlan = buildPlan({
    sections: [
      {
        id: 'lesson-finale',
        title: 'Finale',
        description: 'Ultima',
        isCompleted: false,
        type: 'summary',
        content: 'Finito',
      },
    ],
  });
  domain.setLearningPlan(singleLessonPlan);
  domain.setActiveSectionId('lesson-finale');

  const finalResult = await controller.completeActiveSection();
  assert.equal(finalResult, 'journey-complete');
  assert.equal(getLessons(domain.learningPlan)[0]?.isCompleted, true);
});

test('goToLibrary returns the UX to library and stops active audio playback', async () => {
  const { controller, state, stopAudioCalls } = createControllerHarness();

  state.adapter.setScreenState(AppState.READING);
  const lessonRequestId = state.adapter.beginWorkflow('loadSection');
  const questionRequestId = state.adapter.beginWorkflow('contextQuestion');
  await controller.goToLibrary();

  assert.equal(state.internalState.screenState, AppState.LIBRARY);
  assert.deepEqual(stopAudioCalls, [true]);
  assert.equal(state.adapter.isWorkflowCurrent('loadSection', lessonRequestId), true);
  assert.equal(state.adapter.isWorkflowCurrent('contextQuestion', questionRequestId), false);
});

test('local deletion clears the deleted project missing-source state', async () => {
  const clearDurableLessonRequestsForProject = vi.fn();
  const { controller, state } = createControllerHarness({
    openRouter: { clearDurableLessonRequestsForProject },
  });
  state.adapter.setProjectMissingSource('project-deleted', true);
  state.adapter.tryBeginGeneration('project-deleted', 'lesson');

  await controller.deleteProject('project-deleted');

  expect(state.adapter.hasMissingSource('project-deleted')).toBe(false);
  expect(state.adapter.isGenerationActive('project-deleted')).toBe(false);
  expect(clearDurableLessonRequestsForProject).toHaveBeenCalledWith('project-deleted');
});

test('remote deletion leaves the deleted course and invalidates every active workflow', () => {
  const plan = buildPlan();
  const clearDurableLessonRequestsForProject = vi.fn();
  const { controller, domain, projectLibrary, state, stopAudioCalls } = createControllerHarness({
    domain: {
      activeSectionId: 'lesson-1',
      learningPlan: plan,
      source: createProjectSourceFromFile(pdfFile),
    },
    openRouter: { clearDurableLessonRequestsForProject },
    projectLibrary: { currentProjectId: 'project-deleted' },
  });
  state.adapter.setScreenState(AppState.READING);
  state.adapter.setProjectMissingSource('project-deleted', true);
  state.adapter.tryBeginGeneration('project-deleted', 'lesson');
  const activeRequests = Object.fromEntries(
    WORKSPACE_WORKFLOW_IDS.map(workflowId => [workflowId, state.adapter.beginWorkflow(workflowId)])
  );

  controller.handleRemoteProjectDeleted('project-deleted', true);

  assert.equal(projectLibrary.adapter.currentProjectId, null);
  assert.equal(domain.learningPlan, null);
  assert.equal(domain.source, null);
  assert.equal(state.internalState.screenState, AppState.LIBRARY);
  assert.equal(state.adapter.hasMissingSource('project-deleted'), false);
  assert.equal(state.adapter.isGenerationActive('project-deleted'), false);
  expect(clearDurableLessonRequestsForProject).toHaveBeenCalledWith('project-deleted');
  assert.deepEqual(stopAudioCalls, [true]);
  for (const workflowId of WORKSPACE_WORKFLOW_IDS) {
    assert.equal(
      state.adapter.isWorkflowCurrent(workflowId, activeRequests[workflowId]),
      false,
      `${workflowId} should have been invalidated`
    );
  }
});

test('remote deletion clears retained state without leaving the active course', () => {
  const clearDurableLessonRequestsForProject = vi.fn();
  const { controller, domain, projectLibrary, state, stopAudioCalls } = createControllerHarness({
    domain: {
      activeSectionId: 'lesson-1',
      learningPlan: buildPlan(),
      source: createProjectSourceFromFile(pdfFile),
    },
    openRouter: { clearDurableLessonRequestsForProject },
    projectLibrary: { currentProjectId: 'project-active' },
  });
  state.adapter.setScreenState(AppState.READING);
  state.adapter.setProjectMissingSource('project-deleted', true);

  controller.handleRemoteProjectDeleted('project-deleted', false);

  expect(clearDurableLessonRequestsForProject).toHaveBeenCalledWith('project-deleted');
  assert.equal(state.adapter.hasMissingSource('project-deleted'), false);
  assert.equal(projectLibrary.adapter.currentProjectId, 'project-active');
  assert.notEqual(domain.learningPlan, null);
  assert.notEqual(domain.source, null);
  assert.equal(state.internalState.screenState, AppState.READING);
  assert.deepEqual(stopAudioCalls, []);
});
