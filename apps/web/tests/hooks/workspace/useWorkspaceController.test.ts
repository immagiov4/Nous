import assert from 'node:assert/strict';
import JSZip from 'jszip';
import { test, vi } from 'vitest';
import type {
  WorkspaceControllerStateAdapter,
  WorkspaceGenerationKind,
} from '../../../hooks/workspace/controller/types.ts';
import {
  createWorkspaceController,
  type WorkspaceChatSession,
  type WorkspaceDomainControllerAdapter,
  type WorkspaceProjectLibraryAdapter,
} from '../../../hooks/workspace/useWorkspaceController.ts';
import { LessonGenerationBusyError } from '../../../services/openrouter/lessonGenerationClient.ts';
import { createProjectArchiveBlob } from '../../../services/projects/projectArchive.ts';
import {
  createProjectSnapshot,
  normalizeImportedProject,
} from '../../../services/projects/projectSnapshot.ts';
import { createProjectSourceFromFile } from '../../../services/projects/projectSource.ts';
import {
  createWorkspaceWorkflowState,
  invalidateWorkspaceWorkflows,
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
  type ResearchCoursePlan,
  type SavedProjectMeta,
  type SyllabusItem,
  type UserProfile,
} from '../../../types.ts';
import {
  findPathNodeById,
  flattenLessons,
  updateLessons,
} from '../../../utils/learning/pathNodes.ts';
import { getPdfProjectHydrationState } from '../../../utils/pdf/projectHydration.ts';
import {
  buildTestLearningPlan,
  buildTestLesson,
  buildTestProjectMeta,
} from '../../helpers/learningPlan.ts';

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
  let loadedSnapshot: ProjectSnapshot | null = null;

  const adapter: WorkspaceProjectLibraryAdapter = {
    applyPersistedProjectRevision: async args => {
      appliedProjectRevisions.push(args);
      return true;
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
    getCurrentProjectId: () => adapter.currentProjectId,
    deleteStoredProject: async projectId => {
      deletedProjectIds.push(projectId);
    },
    deleteFolder: async () => {},
    downloadProject: async projectId => {
      exportedProjectIds.push(projectId);
    },
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
    loadStoredProjectSource: async () => null,
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
      return adapter.currentProjectId ? buildMeta(adapter.currentProjectId) : null;
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
    patchSectionAnnotations: async () => {},
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
    chatSession: null as WorkspaceChatSession | null,
    generationByProject: new Map<
      string | null,
      { kind: WorkspaceGenerationKind; sectionId: string | null; token: number }
    >(),
    nextGenerationToken: 0,
    missingSourceProjectId: null as string | null,
    openingProjectId: null as string | null,
    screenState: AppState.LIBRARY as AppState,
    workflowState: createWorkspaceWorkflowState(),
  };

  const adapter: WorkspaceControllerStateAdapter = {
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
    getChatSession: () => internalState.chatSession,
    getGeneratingSectionId: projectId =>
      internalState.generationByProject.get(projectId)?.sectionId ?? null,
    getOpeningProjectId: () => internalState.openingProjectId,
    getWorkflowState: () => internalState.workflowState,
    invalidateWorkflows: workflowIds => {
      internalState.workflowState = invalidateWorkspaceWorkflows(
        internalState.workflowState,
        workflowIds
      );
    },
    isGenerationActive: projectId => internalState.generationByProject.has(projectId),
    isLessonGenerationActive: projectId =>
      internalState.generationByProject.get(projectId)?.kind === 'lesson',
    isWorkflowCurrent: (workflowId, requestId) =>
      internalState.workflowState[workflowId].requestId === requestId,
    resetSessionState: () => {
      internalState.assessmentMessages = [];
      internalState.chatSession = null;
      internalState.openingProjectId = null;
      internalState.missingSourceProjectId = null;
    },
    setAssessmentMessages: nextMessages => {
      internalState.assessmentMessages =
        typeof nextMessages === 'function'
          ? nextMessages(internalState.assessmentMessages)
          : nextMessages;
    },
    setChatSession: chatSession => {
      internalState.chatSession = chatSession;
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
    setOpeningProjectId: projectId => {
      internalState.openingProjectId = projectId;
    },
    setMissingSourceProjectId: projectId => {
      internalState.missingSourceProjectId = projectId;
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
    createAssessmentChat: async () => ({
      getHistory: () => [
        { role: 'system', content: 'System prompt' },
        { role: 'user', content: 'Source content' },
        { role: 'assistant', content: 'Domanda iniziale' },
      ],
      sendMessage: async () => ({ text: 'Domanda iniziale' }),
    }),
    createAssessmentChatFromTextSource: async () => ({
      getHistory: () => [
        { role: 'system', content: 'System prompt' },
        { role: 'user', content: 'Source content' },
        { role: 'assistant', content: 'Domanda iniziale' },
      ],
      sendMessage: async () => ({ text: 'Domanda iniziale' }),
    }),
    createEmbeddedAssessmentChat: async () => ({
      sendMessage: async () => ({ text: 'Domanda iniziale' }),
    }),
    createEmbeddedAssessmentChatFromTextSource: async () => ({
      sendMessage: async () => ({ text: 'Domanda iniziale' }),
    }),
    createEmbeddedLearnAssessmentChat: () => ({
      sendMessage: async () => ({ text: 'Profilazione' }),
    }),
    createLearnAssessmentChat: () => ({
      sendMessage: async () => ({ text: 'Profilazione' }),
    }),
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
        finish: vi.fn(async () => undefined),
        push: vi.fn(),
        updateStatus: vi.fn(),
      };
    },
    createArchiveSubChapterMetadata: async () => ({
      id: 'deep-archive',
      title: 'Approfondimento archivio',
      description: 'Dettaglio',
      isCompleted: false,
      type: 'deep-dive',
      parentId: 'lesson-1',
      sourceArchiveSelectors: [],
    }),
    createLearnSubChapterMetadata: async () => ({
      id: 'deep-learn',
      title: 'Approfondimento AI',
      description: 'Dettaglio',
      isCompleted: false,
      type: 'deep-dive',
      parentId: 'lesson-1',
    }),
    createSubChapterMetadata: async () => ({
      id: 'deep-1',
      title: 'Approfondimento',
      description: 'Dettaglio',
      isCompleted: false,
      type: 'deep-dive',
      parentId: 'lesson-1',
    }),
    generateApplicationExerciseFeedback: async () => ({
      caveats: [],
      evaluatedAt: '2026-03-20T10:00:00.000Z',
      improvements: ['Rendi piu esplicite le motivazioni'],
      qualitativeLabel: 'Obiettivo raggiunto',
      score: 81,
      strengths: ['Consegna coerente con la traccia'],
      summary: 'Buon lavoro pratico con alcuni margini di chiarimento.',
    }),
    generateResearchCoursePlan: async (
      profile: UserProfile,
      _onStatusUpdate: (message: string) => void,
      _onStructureUpdate: (items: SyllabusItem[]) => void
    ) => {
      const syllabus = [
        {
          id: 'mod-1',
          title: 'Modulo 1',
          description: 'Base',
          type: 'module' as const,
          status: 'ready' as const,
          children: [
            {
              id: 'lesson-1',
              title: 'Lezione 1',
              description: 'Intro',
              type: 'lesson' as const,
              status: 'pending' as const,
              contextPrompt: 'Spiega il concetto',
            },
          ],
        },
      ];

      return {
        researchCoursePlan: {
          generatedAt: '2026-03-20T10:00:00.000Z',
          lessonCountReason: 'Percorso breve per test.',
          title: profile.topic,
          summary: profile.context,
          lessons: [
            {
              id: 'lesson-1',
              title: 'Lezione 1',
              description: 'Intro',
              moduleId: 'mod-1',
              moduleTitle: 'Modulo 1',
              prerequisites: [],
              keyConcepts: ['Concetto'],
              guidingQuestions: ['Domanda?'],
              miniLab: 'Prova',
              simplificationRisks: [],
              sourceHints: [{ title: 'Fonte base', url: 'https://example.com' }],
            },
          ],
        },
        syllabus,
      };
    },
    buildLearningPlanFromResearchCourse: (
      profile: UserProfile,
      researchCoursePlan: ResearchCoursePlan,
      syllabus: SyllabusItem[]
    ) =>
      buildPlan({
        title: researchCoursePlan.title || profile.topic,
        summary: researchCoursePlan.summary || profile.context,
        sections: syllabus.flatMap(module =>
          (module.children || []).map(lesson => ({
            id: lesson.id,
            title: lesson.title,
            description: lesson.description,
            isCompleted: false,
            type: 'core' as const,
            parentId: module.id,
            contextPrompt: lesson.contextPrompt,
          }))
        ),
      }),
    generateLearningPlan: async () => buildPlan(),
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
      visualPlanningDecision: {
        initial: { outcome: 'none' as const, plans: [], rationale: 'Nessuna visuale utile.' },
        reviewed: { outcome: 'none' as const, plans: [], rationale: 'Decisione confermata.' },
        reviewedAt: '2026-07-17T12:00:00.000Z',
      },
    }),
    planLessonInstructionPacks: async () => [],
    getPdfLessonMappingState: () => 'idle' as const,
    preparePdfLessonMappings: async (
      _file: FileData,
      plan: LearningPlan,
      existingIndex?: PdfTextIndex | null
    ) => ({
      learningPlan: plan,
      documentIndex: existingIndex ?? createReadyIndex(),
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
  assert.equal(state.internalState.screenState, AppState.ASSESSMENT);
  assert.equal(state.internalState.assessmentMessages[0]?.text, 'Domanda iniziale');
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

test('openProject hydrates pdf mappings before applying a stored plan', async () => {
  const snapshot = createProjectSnapshot({
    id: 'project-pdf',
    source: createProjectSourceFromFile(pdfFile),
    learningPlan: buildPlan({
      sections: [
        {
          id: 'lesson-1',
          title: 'Lezione 1',
          description: 'Intro',
          isCompleted: false,
          type: 'core',
          content: '# Già pronta',
          primaryChunkIds: ['chunk-001'],
        },
      ],
    }),
    state: AppState.READING,
  });
  const readyIndex = createReadyIndex();
  const { controller, domain, projectLibrary } = createControllerHarness({
    openRouter: {
      getPdfLessonMappingState: () => 'missing-document-index',
      preparePdfLessonMappings: async () => ({
        learningPlan: snapshot.learningPlan as LearningPlan,
        documentIndex: readyIndex,
      }),
    },
    loadedSnapshot: snapshot,
  });

  const result = await controller.openProject('project-pdf');

  assert.equal(result.outcome, 'opened');
  assert.equal(projectLibrary.persistedSnapshots.length, 2);
  assert.equal(projectLibrary.persistedSnapshots[1]?.documentIndex?.chunks[0]?.id, 'chunk-001');
  assert.equal(domain.documentIndex?.chunks[0]?.id, 'chunk-001');
});

test('openProject remaps legacy fallback chunk assignments for old pdf projects', async () => {
  const staleIndex = createLargeReadyIndex();
  const stalePlan = buildPlan({
    sections: Array.from({ length: 5 }, (_, index) => ({
      id: `lesson-${index + 1}`,
      title: `Lezione ${index + 1}`,
      description: 'Intro',
      isCompleted: false,
      type: 'core' as const,
      primaryChunkIds: ['chunk-001', 'chunk-002'],
    })),
  });
  const snapshot = createProjectSnapshot({
    id: 'project-pdf-stale',
    source: createProjectSourceFromFile(pdfFile),
    learningPlan: stalePlan,
    documentIndex: staleIndex,
    state: AppState.READING,
  });
  let prepareCalls = 0;

  const { controller, projectLibrary } = createControllerHarness({
    openRouter: {
      getPdfLessonMappingState: (file, plan, documentIndex) =>
        getPdfProjectHydrationState(file, plan, documentIndex),
      preparePdfLessonMappings: async () => {
        prepareCalls += 1;
        let lessonIndex = 0;
        return {
          learningPlan: {
            ...stalePlan,
            modules: updateLessons(stalePlan.modules, section => {
              const chunkNumber = lessonIndex + 3;
              lessonIndex += 1;
              return {
                ...section,
                primaryChunkIds: [`chunk-00${chunkNumber}`],
              };
            }),
          },
          documentIndex: staleIndex,
        };
      },
    },
    loadedSnapshot: snapshot,
  });

  const result = await controller.openProject('project-pdf-stale');

  assert.equal(result.outcome, 'opened');
  assert.equal(prepareCalls, 1);
  assert.equal(projectLibrary.persistedSnapshots.length, 2);
  assert.deepEqual(
    getLessons(projectLibrary.persistedSnapshots[1]?.learningPlan)[0]?.primaryChunkIds,
    ['chunk-003']
  );
});

test('openProject does not retry pdf mapping after automatic recovery was exhausted', async () => {
  const exhaustedIndex: PdfTextIndex = {
    ...createReadyIndex(),
    mappingRecovery: {
      status: 'exhausted',
      updatedAt: '2026-03-20T10:05:00.000Z',
    },
  };
  const fallbackPlan = buildPlan({
    sections: [
      {
        id: 'lesson-1',
        title: 'Lezione 1',
        description: 'Intro',
        isCompleted: false,
        type: 'core',
        content: '# Già pronta',
        primaryChunkIds: ['chunk-001'],
        primaryChunkMappingSource: 'fallback',
      },
    ],
  });
  const snapshot = createProjectSnapshot({
    id: 'project-pdf-exhausted',
    source: createProjectSourceFromFile(pdfFile),
    learningPlan: fallbackPlan,
    documentIndex: exhaustedIndex,
    state: AppState.READING,
  });
  let prepareCalls = 0;
  const { controller, domain } = createControllerHarness({
    openRouter: {
      getPdfLessonMappingState: (file, plan, documentIndex) =>
        getPdfProjectHydrationState(file, plan, documentIndex),
      preparePdfLessonMappings: async () => {
        prepareCalls += 1;
        return {
          learningPlan: fallbackPlan,
          documentIndex: exhaustedIndex,
        };
      },
    },
    loadedSnapshot: snapshot,
  });

  const result = await controller.openProject('project-pdf-exhausted');

  assert.equal(result.outcome, 'opened');
  assert.equal(prepareCalls, 0);
  assert.equal(domain.documentIndex?.mappingRecovery?.status, 'exhausted');
});

test('openProject falls back to the stored snapshot when pdf hydration stalls', async () => {
  vi.useFakeTimers();

  try {
    const snapshot = createProjectSnapshot({
      id: 'project-pdf-timeout',
      source: createProjectSourceFromFile(pdfFile),
      learningPlan: buildPlan({
        sections: [
          {
            id: 'lesson-1',
            title: 'Lezione 1',
            description: 'Intro',
            isCompleted: false,
            type: 'core',
            content: '# Già pronta',
          },
        ],
      }),
      state: AppState.READING,
    });

    const { controller, domain, projectLibrary, state } = createControllerHarness({
      openRouter: {
        getPdfLessonMappingState: () => 'missing-document-index',
        preparePdfLessonMappings: async () => await new Promise(() => {}),
      },
      loadedSnapshot: snapshot,
    });

    const resultPromise = controller.openProject('project-pdf-timeout');
    await vi.advanceTimersByTimeAsync(20_001);
    const result = await resultPromise;

    assert.equal(result.outcome, 'opened');
    assert.equal(state.internalState.workflowState.openProject.status, 'succeeded');
    assert.equal(projectLibrary.persistedSnapshots.length, 1);
    assert.equal(projectLibrary.persistedSnapshots[0]?.documentIndex, null);
    assert.equal(getLessons(domain.learningPlan)[0]?.content, '# Già pronta');
    assert.equal(domain.documentIndex, null);
  } finally {
    vi.useRealTimers();
  }
});

test('openProject keeps the stored snapshot when pdf hydration repair throws', async () => {
  const snapshot = createProjectSnapshot({
    id: 'project-pdf-error',
    source: createProjectSourceFromFile(pdfFile),
    learningPlan: buildPlan({
      sections: [
        {
          id: 'lesson-1',
          title: 'Lezione 1',
          description: 'Intro',
          isCompleted: false,
          type: 'core',
          content: '# Già pronta',
        },
      ],
    }),
    state: AppState.READING,
  });

  const { controller, domain, state } = createControllerHarness({
    openRouter: {
      getPdfLessonMappingState: () => 'missing-primary-chunk-mappings',
      preparePdfLessonMappings: async () => {
        throw new Error('repair failed');
      },
    },
    loadedSnapshot: snapshot,
  });

  const result = await controller.openProject('project-pdf-error');

  assert.equal(result.outcome, 'opened');
  assert.equal(state.internalState.workflowState.openProject.status, 'succeeded');
  assert.equal(getLessons(domain.learningPlan)[0]?.content, '# Già pronta');
  assert.equal(domain.activeSectionId, 'lesson-1');
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

test('openProject skips pdf hydration checks for text document sources', async () => {
  const snapshot = createProjectSnapshot({
    id: 'project-md',
    source: createProjectSourceFromFile(markdownFile),
    state: AppState.ASSESSMENT,
  });
  let hydrationFileArg: FileData | null | undefined;

  const { controller } = createControllerHarness({
    openRouter: {
      getPdfLessonMappingState: fileArg => {
        hydrationFileArg = fileArg;
        return 'idle';
      },
    },
    loadedSnapshot: snapshot,
  });

  const result = await controller.openProject('project-md');

  assert.equal(result.outcome, 'opened');
  assert.equal(hydrationFileArg, null);
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
      createAssessmentChat: async () => {
        fileAssessmentCalls += 1;
        return {
          getHistory: () => [],
          sendMessage: async () => ({ text: 'Non dovrebbe partire' }),
        };
      },
      createAssessmentChatFromTextSource: async source => {
        textAssessmentCalls += 1;
        assert.equal(source.name, 'notes.md');
        assert.equal(source.text.includes('Titolo'), true);
        return {
          getHistory: () => [{ role: 'assistant', content: 'Domanda iniziale' }],
          sendMessage: async () => ({ text: 'Domanda iniziale' }),
        };
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
      createAssessmentChatFromTextSource: async () => {
        assert.equal(state.internalState.workflowState.openProject.status, 'succeeded');
        return {
          getHistory: () => [{ role: 'assistant', content: 'Domanda iniziale' }],
          sendMessage: async () => ({ text: 'Domanda iniziale' }),
        };
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
      createAssessmentChatFromTextSource: async () => {
        notifyAssessmentStarted?.();
        return {
          getHistory: () => [{ role: 'assistant', content: 'Domanda iniziale' }],
          sendMessage: async () => ({ text: 'Domanda iniziale' }),
        };
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
  assert.equal(state.internalState.screenState, AppState.ASSESSMENT);
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
      createAssessmentChatFromTextSource: async source => {
        assessmentText = source.text;
        return {
          getHistory: () => [{ role: 'assistant', content: 'Domanda iniziale' }],
          sendMessage: async () => ({ text: 'Domanda iniziale' }),
        };
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
  state.internalState.chatSession = {
    sendMessage: async () => ({ text: 'unused' }),
  };
  state.internalState.openingProjectId = 'project-opening';
  state.internalState.missingSourceProjectId = 'project-reattach';
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
  assert.equal(state.internalState.chatSession, null);
  assert.equal(state.internalState.openingProjectId, null);
  assert.equal(state.internalState.missingSourceProjectId, null);
  assert.equal(state.internalState.workflowState.loadSection.status, 'idle');
  assert.equal(state.adapter.isWorkflowCurrent('loadSection', staleLoadSectionRequestId), false);
  assert.equal(state.internalState.workflowState.attachSource.status, 'succeeded');
});

test('handleSourceUpload reattach preserves the active source and session when persistence fails', async () => {
  const existingSource = createProjectSourceFromFile(markdownFile);
  const existingChatSession = {
    sendMessage: async () => ({ text: 'Sessione esistente' }),
  };
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
  state.internalState.chatSession = existingChatSession;
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
  assert.equal(state.internalState.chatSession, existingChatSession);
  assert.equal(state.adapter.isWorkflowCurrent('loadSection', activeLoadRequestId), true);
  assert.equal(state.internalState.workflowState.attachSource.status, 'failed');
  assert.deepEqual(hydrationStates, [false, true]);
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
  const { controller, projectLibrary } = createControllerHarness({
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
  assert.equal(projectLibrary.savedOverrides[0]?.source?.kind, 'archive');
  assert.equal(projectLibrary.savedOverrides[0]?.source?.file.sourceId, existingSourceId);
  assert.deepEqual(projectLibrary.saveOptions, [{ archiveFile: uploadedFile, throwOnError: true }]);
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
      createAssessmentChatFromTextSource: async source => {
        assessmentText = source.text;
        return {
          getHistory: () => [{ role: 'assistant', content: 'Domanda iniziale' }],
          sendMessage: async () => ({ text: 'Domanda iniziale' }),
        };
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
      createAssessmentChat: async () => {
        fileAssessmentCalls += 1;
        return {
          getHistory: () => [],
          sendMessage: async () => ({ text: 'Non dovrebbe partire' }),
        };
      },
      createAssessmentChatFromTextSource: async source => {
        textAssessmentCalls += 1;
        assert.equal(source.name, 'notes.md');
        assert.equal(source.text.includes('Titolo'), true);
        return {
          getHistory: () => [{ role: 'assistant', content: 'Domanda iniziale' }],
          sendMessage: async () => ({ text: 'Domanda iniziale' }),
        };
      },
    },
  });
  const uploadedFile = new File(['# Titolo\n\nContenuto'], 'notes.md');

  const result = await controller.handleSourceUpload(uploadedFile, {
    mode: 'new-project',
  });

  assert.equal(result.outcome, 'started-assessment');
  assert.equal(result.errorMessage, undefined);
  assert.equal(state.internalState.screenState, AppState.ASSESSMENT);
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
  const { controller, domain, projectLibrary, state } = createControllerHarness({
    projectLibrary: {
      importProjectData: async data => {
        const snapshot = normalizeImportedProject(data);
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
  assert.equal(projectLibrary.adapter.currentProjectId, 'backup-project');
  assert.equal(state.internalState.screenState, AppState.READING);
  assert.equal(domain.source?.kind, 'pdf');
  assert.equal(domain.learningPlan?.title, archivedSnapshot.learningPlan?.title);
  assert.deepEqual(state.internalState.assessmentMessages, []);
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

test('startLearnJourney resets the workspace and lands in learn assessment', async () => {
  const existingPlan = buildPlan();
  const { controller, domain, projectLibrary, state } = createControllerHarness({
    domain: {
      activeSectionId: 'lesson-1',
      isLearnMode: false,
      learningPlan: existingPlan,
      source: createProjectSourceFromFile(pdfFile),
      domainState: {
        source: createProjectSourceFromFile(pdfFile),
        learningPlan: existingPlan,
        documentAssets: null,
        documentIndex: null,
        isLearnMode: false,
        userProfile: null,
        syllabus: [],
        activeSectionId: 'lesson-1',
      },
    },
  });

  const result = await controller.startLearnJourney();

  assert.equal(result.outcome, 'started');
  assert.equal(state.internalState.screenState, AppState.ASSESSMENT);
  assert.equal(domain.isLearnMode, true);
  assert.equal(domain.learningPlan, null);
  assert.equal(projectLibrary.persistedSnapshots.length, 1);
  assert.equal(projectLibrary.persistedSnapshots[0]?.isLearnMode, true);
  assert.equal(state.internalState.assessmentMessages[0]?.text.includes('Architect'), true);
});

test('startHomeChat passes the Nuovo corso preference to the model without altering the visible user message', async () => {
  let sentMessage = '';
  const { controller, state } = createControllerHarness({
    openRouter: {
      createEmbeddedLearnAssessmentChat: () => ({
        sendMessage: async ({ message }) => {
          sentMessage = message;
          return { text: 'Profilazione' };
        },
      }),
    },
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
  assert.equal(sentMessage.includes('[Preferenza utente attiva: Nuovo corso]'), true);
  assert.equal(sentMessage.includes('Vorrei capire meglio come studiare'), true);
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
      createEmbeddedAssessmentChatFromTextSource: async source => {
        assessmentText = source.text;
        return {
          sendMessage: async () => ({ text: 'Continuiamo.' }),
        };
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

test('startHomeChat reports each unusable source while continuing with valid material', async () => {
  const { controller } = createControllerHarness({
    openRouter: {
      validatePdfTextSource: async file => {
        if (file.name === 'scansione.pdf') {
          throw new Error('internal PDF extraction detail');
        }
        return null;
      },
      createEmbeddedAssessmentChatFromSourceSet: async () => ({
        sendMessage: async () => ({ text: 'Continuiamo con la fonte valida.' }),
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

test('submitAssessment in learn mode finalizes the profile and generates the first lesson', async () => {
  const profileArgs = {
    topic: 'TypeScript',
    experienceLevel: 'Intermediate',
    learningStyle: 'Practical',
    goals: 'Ship features',
    context: 'Frontend developer',
  };
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
      currentProjectId: 'learn-project',
    },
  });

  state.adapter.setChatSession({
    sendMessage: async () => ({
      text: '',
      functionCalls: [{ name: 'finalizeProfile', args: profileArgs }],
    }),
  });

  const result = await controller.submitAssessment('Fammi imparare TypeScript');

  assert.equal(result.outcome, 'planned');
  assert.equal(domain.userProfile?.topic, 'TypeScript');
  assert.equal(getLessons(domain.learningPlan).length, 1);
  assert.equal(domain.activeSectionId, 'lesson-1');
  assert.equal(state.internalState.screenState, AppState.READING);
  assert.equal(projectLibrary.savedOverrides[0]?.userProfile?.topic, 'TypeScript');
});

test('submitAssessment forwards the Nuovo corso preference to the active chat session', async () => {
  let sentMessage = '';
  const { controller, state } = createControllerHarness({
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
  });

  state.adapter.setChatSession({
    sendMessage: async ({ message }) => {
      sentMessage = message;
      return { text: 'Profilazione' };
    },
  });

  const result = await controller.submitAssessment('Fammi una domanda utile', {
    mode: 'new-course',
    newCourse: true,
  });

  assert.equal(result.outcome, 'continued');
  assert.equal(sentMessage.includes('[Preferenza utente attiva: Nuovo corso]'), true);
  assert.equal(sentMessage.includes('Fammi una domanda utile'), true);
  assert.equal(state.internalState.assessmentMessages.at(-1)?.text, 'Profilazione');
});

test('submitAssessment lets the assessment agent abandon an accidental course flow', async () => {
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
  });
  state.adapter.setAssessmentMessages([{ role: 'model', text: 'Prima domanda' }]);
  state.adapter.setChatSession({
    sendMessage: async () => ({
      text: '',
      functionCalls: [{ name: 'abandonAssessment', args: {} }],
    }),
  });

  const result = await controller.submitAssessment('Sono entrato qui per sbaglio');

  assert.equal(result.outcome, 'abandoned');
  assert.deepEqual(state.internalState.assessmentMessages, []);
  assert.equal(state.internalState.screenState, AppState.LIBRARY);
  assert.equal(projectLibrary.adapter.currentProjectId, null);
  assert.equal(domain.isLearnMode, false);
});

test('submitAssessment in document mode generates the plan after the minimum number of turns', async () => {
  const { controller, domain, state } = createControllerHarness({
    domain: {
      file: pdfFile,
      source: createProjectSourceFromFile(pdfFile),
      domainState: {
        source: createProjectSourceFromFile(pdfFile),
        learningPlan: null,
        documentAssets: null,
        documentIndex: null,
        isLearnMode: false,
        userProfile: null,
        syllabus: [],
        activeSectionId: null,
      },
    },
    openRouter: {
      generateLearningPlan: async () =>
        buildPlan({
          sections: [
            {
              id: 'lesson-1',
              title: 'Lezione 1',
              description: 'Intro',
              isCompleted: false,
              type: 'core',
              content: '# Già pronta',
              quiz: [],
            },
          ],
        }),
    },
  });

  state.adapter.setChatSession({
    sendMessage: async () => ({ text: '[ASSESSMENT_COMPLETE]' }),
  });
  state.adapter.setAssessmentMessages([
    { role: 'user', text: 'Uno' },
    { role: 'model', text: 'Due' },
    { role: 'user', text: 'Tre' },
    { role: 'model', text: 'Quattro' },
  ]);

  const assessmentResult = await controller.submitAssessment('Quinta risposta');
  const result = await controller.confirmPlanGeneration();

  assert.equal(assessmentResult.outcome, 'assessment-complete');
  assert.equal(result.outcome, 'planned');
  assert.equal(state.internalState.screenState, AppState.READING);
  assert.equal(getLessons(domain.learningPlan)[0]?.title, 'Lezione 1');
});

test('submitAssessment in document mode can generate a plan for text-backed sources', async () => {
  const markdownSource = createProjectSourceFromFile(markdownFile);
  let planFileArg: FileData | undefined;
  const { controller, domain, state } = createControllerHarness({
    domain: {
      file: null,
      source: markdownSource,
      domainState: {
        source: markdownSource,
        learningPlan: null,
        documentAssets: null,
        documentIndex: null,
        isLearnMode: false,
        userProfile: null,
        syllabus: [],
        activeSectionId: null,
      },
    },
    openRouter: {
      generateLearningPlan: async file => {
        planFileArg = file;
        return buildPlan({
          sections: [
            {
              id: 'lesson-1',
              title: 'Lezione 1',
              description: 'Intro',
              isCompleted: false,
              type: 'core',
              content: '# Già pronta',
              quiz: [],
            },
          ],
        });
      },
    },
  });

  state.adapter.setChatSession({
    sendMessage: async () => ({ text: '[ASSESSMENT_COMPLETE]' }),
  });
  state.adapter.setAssessmentMessages([
    { role: 'user', text: 'Uno' },
    { role: 'model', text: 'Due' },
    { role: 'user', text: 'Tre' },
    { role: 'model', text: 'Quattro' },
  ]);

  const assessmentResult = await controller.submitAssessment('Quinta risposta');
  const result = await controller.confirmPlanGeneration();

  assert.equal(assessmentResult.outcome, 'assessment-complete');
  assert.equal(result.outcome, 'planned');
  assert.equal(planFileArg?.name, 'notes.md');
  assert.equal(planFileArg?.mimeType, 'text/markdown');
  assert.equal(state.internalState.screenState, AppState.READING);
  assert.equal(getLessons(domain.learningPlan)[0]?.title, 'Lezione 1');
});

test('submitAssessment plans a reopened archive without downloading the ZIP', async () => {
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
  let archivePlanningCalls = 0;
  let sourceDownloadCalls = 0;
  const { controller, state } = createControllerHarness({
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
      generateLearningPlan: async () => {
        throw new Error('Archive planning must use the archive tool flow.');
      },
      generateLearningPlanFromSourceArchive: async () => {
        archivePlanningCalls += 1;
        return buildPlan();
      },
    },
  });
  state.adapter.setChatSession({
    sendMessage: async () => ({ text: '[ASSESSMENT_COMPLETE]' }),
  });
  state.adapter.setAssessmentMessages([
    { role: 'user', text: 'Uno' },
    { role: 'model', text: 'Due' },
    { role: 'user', text: 'Tre' },
    { role: 'model', text: 'Quattro' },
  ]);

  await controller.submitAssessment('Quinta risposta');
  const result = await controller.confirmPlanGeneration();

  assert.equal(result.outcome, 'planned');
  assert.equal(archivePlanningCalls, 1);
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
  const generateDurableLesson = vi.fn(async () => ({
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
  }));
  const { controller, domain, projectLibrary } = createControllerHarness({
    domain: { learningPlan: plan },
    projectLibrary: { currentProjectId: 'project-1' },
    openRouter: { generateDurableLesson },
  });

  const outcome = await controller.openSection(getLessons(plan)[0]);

  assert.equal(outcome, 'loaded');
  assert.equal(getLessons(domain.learningPlan)[0]?.content, '# Lezione durevole');
  assert.equal(
    domain.researchDossiersBySectionId['lesson-1']?.factualSummary,
    'Dossier salvato dal backend.'
  );
  assert.equal(projectLibrary.sectionLessonPatches.length, 0);
  assert.deepEqual(projectLibrary.appliedProjectRevisions, [
    { projectId: 'project-1', revision: 7 },
  ]);
  assert.deepEqual(generateDurableLesson.mock.calls, [
    [
      {
        forceRegenerate: false,
        projectId: 'project-1',
        sectionId: 'lesson-1',
      },
    ],
  ]);
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
  const { controller, state } = createControllerHarness({
    domain: { learningPlan: plan },
    projectLibrary: { currentProjectId: 'project-1' },
    openRouter: {
      generateDurableLesson: vi.fn(async () => {
        throw busyError;
      }),
    },
  });

  await assert.rejects(controller.openSection(getLessons(plan)[0]), busyError);
  assert.equal(state.internalState.workflowState.loadSection.status, 'failed');
  assert.equal(state.internalState.workflowState.loadSection.error, busyError.message);
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

test('lesson generation discards an invalidated sublesson and rejects competing commands until it settles', async () => {
  const plan = buildPlan({
    sections: [
      buildTestLesson({ id: 'lesson-1', title: 'Lezione 1' }),
      buildTestLesson({ id: 'lesson-2', title: 'Lezione 2' }),
    ],
  });
  let metadataCalls = 0;
  let generationCalls = 0;
  let releaseMetadata: (() => void) | undefined;
  let markMetadataStarted: (() => void) | undefined;
  const metadataGate = new Promise<void>(resolve => {
    releaseMetadata = resolve;
  });
  const metadataStarted = new Promise<void>(resolve => {
    markMetadataStarted = resolve;
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
      createSubChapterMetadata: async () => {
        metadataCalls += 1;
        markMetadataStarted?.();
        await metadataGate;
        return {
          id: `deep-${metadataCalls}`,
          title: 'Approfondimento',
          description: 'Dettaglio',
          isCompleted: false,
          type: 'deep-dive' as const,
          parentId: 'lesson-1',
        };
      },
      generateDurableLesson: async () => {
        generationCalls += 1;
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
        };
      },
    },
  });

  const firstSublesson = controller.createLessonFromSelection({
    instructions: 'Approfondisci',
    selectedText: 'testo',
  });
  await metadataStarted;
  state.adapter.invalidateWorkflows(['createLesson']);
  const recreatedController = recreateController();

  const duplicateSublesson = recreatedController.createLessonFromSelection({
    instructions: 'Approfondisci ancora',
    selectedText: 'testo',
  });
  const competingLesson = recreatedController.openSection(getLessons(plan)[1]);
  releaseMetadata?.();

  const [firstResult, duplicateResult, competingResult] = await Promise.all([
    firstSublesson,
    duplicateSublesson,
    competingLesson,
  ]);

  assert.equal(firstResult.outcome, 'ignored-busy');
  assert.equal(duplicateResult.outcome, 'failed');
  assert.ok(duplicateResult.errorMessage);
  assert.equal(competingResult, 'ignored-busy');
  assert.equal(metadataCalls, 1);
  assert.equal(generationCalls, 0);

  const afterSuccess = await controller.openSection(getLessons(plan)[1]);
  assert.equal(afterSuccess, 'loaded');
  assert.equal(generationCalls, 1);
});

test('sublesson generation releases its gate after an error', async () => {
  const plan = buildPlan();
  let metadataCalls = 0;
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
      createSubChapterMetadata: async () => {
        metadataCalls += 1;
        if (metadataCalls === 1) {
          throw new Error('Metadata non disponibili');
        }
        return {
          id: 'deep-after-error',
          title: 'Approfondimento',
          description: 'Dettaglio',
          isCompleted: false,
          type: 'deep-dive' as const,
          parentId: 'lesson-1',
        };
      },
    },
  });

  const failed = await controller.createLessonFromSelection({
    instructions: 'Approfondisci',
    selectedText: 'testo',
  });
  const retried = await controller.createLessonFromSelection({
    instructions: 'Riprova',
    selectedText: 'testo',
  });

  assert.equal(failed.outcome, 'failed');
  assert.equal(retried.outcome, 'created');
  assert.equal(metadataCalls, 2);
});

test('lesson generation keeps its gate after workflow invalidation until the provider call settles', async () => {
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
  const { controller, state } = createControllerHarness({
    domain: {
      file: pdfFile,
      learningPlan: plan,
      source: createProjectSourceFromFile(pdfFile),
    },
    projectLibrary: { currentProjectId: 'project-1' },
    openRouter: {
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
        };
      },
    },
  });

  const invalidatedGeneration = controller.openSection(getLessons(plan)[0]);
  await generationStarted;
  state.adapter.invalidateWorkflows(['loadSection']);

  const whileInvalidatedRequestSettles = await controller.openSection(getLessons(plan)[0]);
  assert.equal(whileInvalidatedRequestSettles, 'ignored-busy');
  assert.equal(generationCalls, 1);
  assert.equal(state.adapter.isLessonGenerationActive('project-1'), true);
  assert.equal(state.adapter.getGeneratingSectionId('project-1'), 'lesson-1');

  releaseGeneration?.();

  assert.equal(await invalidatedGeneration, 'ignored-busy');
  assert.equal(state.adapter.isLessonGenerationActive('project-1'), false);
  assert.equal(state.adapter.getGeneratingSectionId('project-1'), null);

  const retried = await controller.openSection(getLessons(plan)[0]);
  assert.equal(retried, 'loaded');
  assert.equal(generationCalls, 2);
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
  assert.equal(await lessonGeneration, 'ignored-busy');
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
  const createSubChapterMetadata = vi.fn(async () => ({
    id: 'deep-during-repair',
    title: 'Approfondimento',
    description: 'Dettaglio',
    isCompleted: false,
    type: 'deep-dive' as const,
    parentId: 'lesson-1',
  }));
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
      createSubChapterMetadata,
      generateApplicationExerciseBrief,
      generateApplicationExercisePlacements,
      generateDurableLesson,
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
  assert.equal(createSubChapterMetadata.mock.calls.length, 0);
  assert.equal(generateDurableLesson.mock.calls.length, 0);
  assert.equal(generateApplicationExerciseBrief.mock.calls.length, 0);

  resolvePlacement?.({ plan, placedCount: 0 });
  assert.deepEqual(await repair, { outcome: 'repaired' });
});

test('createLessonFromSelection rolls back when nested lesson opening is ignored', async () => {
  const plan = buildPlan();
  let stateAdapter: WorkspaceControllerStateAdapter | undefined;
  const generateDurableLesson = vi.fn();
  const harness = createControllerHarness({
    domain: {
      activeSectionId: 'lesson-1',
      isLearnMode: true,
      learningPlan: plan,
    },
    projectLibrary: { currentProjectId: 'project-1' },
    openRouter: {
      createLearnSubChapterMetadata: async () => {
        stateAdapter?.beginWorkflow('loadSection', 'Operazione concorrente');
        return {
          id: 'deep-ignored-open',
          title: 'Approfondimento',
          description: 'Dettaglio',
          isCompleted: false,
          type: 'deep-dive' as const,
          parentId: 'lesson-1',
        };
      },
      generateDurableLesson,
    },
  });
  stateAdapter = harness.state.adapter;

  const result = await harness.controller.createLessonFromSelection({
    instructions: 'Approfondisci',
    selectedText: 'testo',
  });

  assert.equal(result.outcome, 'failed');
  assert.equal(generateDurableLesson.mock.calls.length, 0);
  assert.deepEqual(
    getLessons(harness.domain.learningPlan).map(lesson => lesson.id),
    ['lesson-1', 'lesson-2']
  );
  assert.equal(harness.domain.activeSectionId, 'lesson-1');
});

test('createLessonFromSelection stops after persistence when another project is opened', async () => {
  const firstPlan = buildPlan();
  const secondPlan = buildPlan({
    sections: [buildTestLesson({ id: 'project-2-lesson', title: 'Secondo progetto' })],
  });
  let releasePersist: ((value: SavedProjectMeta | null) => void) | undefined;
  let markPersistStarted: (() => void) | undefined;
  const persistResult = new Promise<SavedProjectMeta | null>(resolve => {
    releasePersist = resolve;
  });
  const persistStarted = new Promise<void>(resolve => {
    markPersistStarted = resolve;
  });
  const generateDurableLesson = vi.fn();
  const harness = createControllerHarness({
    domain: {
      activeSectionId: 'lesson-1',
      isLearnMode: true,
      learningPlan: firstPlan,
    },
    projectLibrary: {
      currentProjectId: 'project-1',
      patchCurrentProject: async () => {
        markPersistStarted?.();
        return persistResult;
      },
    },
    openRouter: { generateDurableLesson },
  });

  const creation = harness.controller.createLessonFromSelection({
    instructions: 'Approfondisci',
    selectedText: 'testo',
  });
  await persistStarted;

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
  releasePersist?.(buildMeta('project-1'));

  assert.deepEqual(await creation, { outcome: 'ignored-busy' });
  assert.equal(harness.domain.activeSectionId, 'project-2-lesson');
  assert.equal(harness.domain.learningPlan?.modules[0]?.children[0]?.id, 'project-2-lesson');
  assert.equal(generateDurableLesson.mock.calls.length, 0);
});

test('createLessonFromSelection inserts the deep dive after the parent subtree and opens it', async () => {
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
  const { controller, domain } = createControllerHarness({
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
    projectLibrary: { currentProjectId: 'project-1' },
  });

  const result = await controller.createLessonFromSelection({
    instructions: 'Approfondisci',
    selectedText: 'testo',
  });

  assert.equal(result.outcome, 'created');
  assert.equal(getLessons(domain.learningPlan)[2]?.id, 'deep-1');
  assert.equal(domain.activeSectionId, 'deep-1');
  assert.equal(getLessons(domain.learningPlan)[2]?.content, '# Lezione generata');
});

test('createLessonFromSelection nests a child of child before the next sibling branch', async () => {
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
        id: 'lesson-1-deep',
        title: 'Approfondimento esistente',
        description: 'Figlia diretta',
        isCompleted: false,
        type: 'deep-dive',
        parentId: 'lesson-1',
      },
      {
        id: 'lesson-1-deep-sibling',
        title: 'Seconda figlia',
        description: 'Ramo fratello',
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
  const { controller, domain } = createControllerHarness({
    domain: {
      activeSectionId: 'lesson-1-deep',
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
        activeSectionId: 'lesson-1-deep',
      },
    },
    openRouter: {
      createSubChapterMetadata: async () => ({
        id: 'deep-1-nested',
        title: 'Approfondimento annidato',
        description: 'Dettaglio ricorsivo',
        isCompleted: false,
        type: 'deep-dive',
        parentId: 'lesson-1-deep',
      }),
    },
    projectLibrary: { currentProjectId: 'project-1' },
  });

  const result = await controller.createLessonFromSelection({
    instructions: 'Scendi di un livello',
    selectedText: 'testo',
  });

  assert.equal(result.outcome, 'created');
  assert.deepEqual(
    getLessons(domain.learningPlan).map(section => section.id),
    ['lesson-1', 'lesson-1-deep', 'deep-1-nested', 'lesson-1-deep-sibling', 'lesson-2']
  );
  assert.equal(domain.activeSectionId, 'deep-1-nested');
  assert.equal(getLessons(domain.learningPlan)[2]?.content, '# Lezione generata');
});

test('createLessonFromSelection rolls back the inserted lesson when generation fails', async () => {
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
      generateDurableLesson: async () => {
        throw new Error('Risposta troncata');
      },
    },
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
  assert.equal(projectLibrary.savedOverrides.at(-1)?.activeSectionId, 'lesson-1');
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
