import assert from 'node:assert/strict';
import { test } from 'vitest';
import { createProjectSnapshot } from '../services/projectSnapshot.ts';
import { createProjectSourceFromFile } from '../services/projectSource.ts';
import { getPdfProjectHydrationState } from '../utils/pdfProjectHydration.ts';
import {
  createWorkspaceWorkflowState,
  invalidateWorkspaceWorkflows,
} from '../services/workspaceWorkflow.ts';
import {
  AppState,
  type FileData,
  type LearningPlan,
  type Message,
  type PdfTextIndex,
  type ProjectSnapshot,
  type SavedProjectMeta,
  type SyllabusItem,
  type UserProfile,
} from '../types.ts';
import {
  createWorkspaceController,
  type WorkspaceChatSession,
  type WorkspaceDomainControllerAdapter,
  type WorkspaceProjectLibraryAdapter,
} from './useWorkspaceController.ts';

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

const buildPlan = (overrides: Partial<LearningPlan> = {}): LearningPlan => ({
  title: 'Percorso',
  summary: 'Sintesi',
  sections: [
    {
      id: 'lesson-1',
      title: 'Lezione 1',
      description: 'Intro',
      isCompleted: false,
      type: 'core',
    },
    {
      id: 'lesson-2',
      title: 'Lezione 2',
      description: 'Follow-up',
      isCompleted: false,
      type: 'core',
      content: 'Contenuto già pronto',
      quiz: [],
    },
  ],
  ...overrides,
});

const buildMeta = (id: string): SavedProjectMeta => ({
  id,
  title: 'Percorso',
  sourceKind: 'document',
  createdAt: '2026-03-20T10:00:00.000Z',
  updatedAt: '2026-03-20T10:00:00.000Z',
  lastOpenedAt: '2026-03-20T10:00:00.000Z',
  lessonCount: 1,
  completedCount: 0,
  hasSourceFile: true,
  coverLabel: 'PDF',
  syncState: 'local-only',
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
    domain.learningPlan?.sections.find(section => section.id === domain.activeSectionId) || null;
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
      activeSectionId: null,
    },
    file: null,
    hydrateSnapshot: snapshot => {
      domain.source = snapshot.source;
      domain.learningPlan = snapshot.learningPlan;
      domain.documentAssets = snapshot.documentAssets ?? null;
      domain.documentIndex = snapshot.documentIndex ?? null;
      domain.isLearnMode = snapshot.isLearnMode;
      domain.userProfile = snapshot.userProfile;
      domain.syllabus = snapshot.syllabus;
      domain.activeSectionId = snapshot.activeSectionId;
      domain.domainState = {
        source: snapshot.source,
        learningPlan: snapshot.learningPlan,
        documentAssets: snapshot.documentAssets ?? null,
        documentIndex: snapshot.documentIndex ?? null,
        isLearnMode: snapshot.isLearnMode,
        userProfile: snapshot.userProfile,
        syllabus: snapshot.syllabus,
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
    resetDomain: () => {
      domain.source = null;
      domain.learningPlan = null;
      domain.documentAssets = null;
      domain.documentIndex = null;
      domain.isLearnMode = false;
      domain.userProfile = null;
      domain.syllabus = [];
      domain.activeSectionId = null;
      domain.domainState = {
        source: null,
        learningPlan: null,
        documentAssets: null,
        documentIndex: null,
        isLearnMode: false,
        userProfile: null,
        syllabus: [],
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
        sections: domain.learningPlan.sections.map(section =>
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
        sections: domain.learningPlan.sections.map(section =>
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

  return domain;
};

const createProjectLibraryAdapter = (overrides: Partial<WorkspaceProjectLibraryAdapter> = {}) => {
  const persistedSnapshots: ProjectSnapshot[] = [];
  const savedOverrides: Array<Partial<ProjectSnapshot> | undefined> = [];
  const deletedProjectIds: string[] = [];
  const exportedProjectIds: Array<string | undefined> = [];
  const touchedProjectIds: string[] = [];
  let loadedSnapshot: ProjectSnapshot | null = null;

  const adapter: WorkspaceProjectLibraryAdapter = {
    currentProjectId: null,
    deleteStoredProject: async projectId => {
      deletedProjectIds.push(projectId);
    },
    downloadProject: async projectId => {
      exportedProjectIds.push(projectId);
    },
    importProjectData: async () => ({
      meta: buildMeta('imported-project'),
      snapshot: createProjectSnapshot({ id: 'imported-project' }),
    }),
    isLibraryLoading: false,
    loadStoredProject: async () => loadedSnapshot,
    persistSnapshot: async snapshot => {
      persistedSnapshots.push(snapshot);
      return buildMeta(snapshot.id);
    },
    refreshSavedProjects: async () => {},
    saveCurrentProject: async overridesArg => {
      savedOverrides.push(overridesArg);
      return adapter.currentProjectId ? buildMeta(adapter.currentProjectId) : null;
    },
    savedProjects: [],
    setCurrentProjectId: projectId => {
      adapter.currentProjectId = projectId;
    },
    setProjectHydrated: () => {},
    storageError: null,
    touchStoredProject: async projectId => {
      touchedProjectIds.push(projectId);
      return buildMeta(projectId);
    },
  };

  Object.assign(adapter, overrides);

  return {
    adapter,
    deletedProjectIds,
    exportedProjectIds,
    persistedSnapshots,
    savedOverrides,
    setLoadedSnapshot: (snapshot: ProjectSnapshot | null) => {
      loadedSnapshot = snapshot;
    },
    touchedProjectIds,
  };
};

const createStateAdapter = () => {
  const runtime = {
    assessmentMessages: [] as Message[],
    chatSession: null as WorkspaceChatSession | null,
    openingProjectId: null as string | null,
    screenState: AppState.LIBRARY,
    workflowState: createWorkspaceWorkflowState(),
  };

  return {
    adapter: {
      beginWorkflow: (workflowId, message) => {
        const nextRequestId = runtime.workflowState[workflowId].requestId + 1;
        runtime.workflowState = {
          ...runtime.workflowState,
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
        if (runtime.workflowState[workflowId].requestId !== requestId) {
          return;
        }

        runtime.workflowState = {
          ...runtime.workflowState,
          [workflowId]: {
            ...runtime.workflowState[workflowId],
            status: 'failed',
            error: errorMessage,
            message: undefined,
          },
        };
      },
      getAssessmentMessages: () => runtime.assessmentMessages,
      getChatSession: () => runtime.chatSession,
      getWorkflowState: () => runtime.workflowState,
      invalidateWorkflows: workflowIds => {
        runtime.workflowState = invalidateWorkspaceWorkflows(runtime.workflowState, workflowIds);
      },
      isWorkflowCurrent: (workflowId, requestId) =>
        runtime.workflowState[workflowId].requestId === requestId,
      resetRuntimeState: () => {
        runtime.assessmentMessages = [];
        runtime.chatSession = null;
        runtime.openingProjectId = null;
      },
      setAssessmentMessages: nextMessages => {
        runtime.assessmentMessages =
          typeof nextMessages === 'function'
            ? nextMessages(runtime.assessmentMessages)
            : nextMessages;
      },
      setChatSession: chatSession => {
        runtime.chatSession = chatSession;
      },
      setOpeningProjectId: projectId => {
        runtime.openingProjectId = projectId;
      },
      setScreenState: screenState => {
        runtime.screenState = screenState;
      },
      setWorkflowMessage: (workflowId, requestId, message) => {
        if (runtime.workflowState[workflowId].requestId !== requestId) {
          return;
        }

        runtime.workflowState = {
          ...runtime.workflowState,
          [workflowId]: {
            ...runtime.workflowState[workflowId],
            message,
          },
        };
      },
      succeedWorkflow: (workflowId, requestId, message) => {
        if (runtime.workflowState[workflowId].requestId !== requestId) {
          return;
        }

        runtime.workflowState = {
          ...runtime.workflowState,
          [workflowId]: {
            ...runtime.workflowState[workflowId],
            status: 'succeeded',
            error: undefined,
            message,
          },
        };
      },
    },
    runtime,
  };
};

const createGeminiMock = (overrides: Partial<typeof import('../services/geminiService.ts')> = {}) =>
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
    generateFullCurriculum: async (
      _profile: UserProfile,
      _onStatusUpdate: (message: string) => void,
      _onStructureUpdate: (items: SyllabusItem[]) => void,
      _onRevisionStart: () => void
    ) => [
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
    ],
    generateLearningPlan: async () => buildPlan(),
    generateLearnLessonContent: async () => '# Lezione generata',
    generateSectionContent: async () => ({
      content: '# Lezione dal documento',
      quiz: [],
      imageRefs: [],
      documentAssets: null,
    }),
    getPdfLessonMappingState: () => 'idle' as const,
    preparePdfLessonMappings: async (
      _file: FileData,
      plan: LearningPlan,
      existingIndex?: PdfTextIndex | null
    ) => ({
      learningPlan: plan,
      documentIndex: existingIndex ?? createReadyIndex(),
    }),
    ...overrides,
  }) as unknown as typeof import('../services/geminiService.ts');

const createControllerHarness = (args?: {
  domain?: Partial<WorkspaceDomainControllerAdapter>;
  gemini?: Partial<typeof import('../services/geminiService.ts')>;
  loadedSnapshot?: ProjectSnapshot | null;
  projectLibrary?: Partial<WorkspaceProjectLibraryAdapter>;
}) => {
  const domain = createDomainAdapter(args?.domain);
  const state = createStateAdapter();
  const projectLibrary = createProjectLibraryAdapter(args?.projectLibrary);
  projectLibrary.setLoadedSnapshot(args?.loadedSnapshot ?? null);
  const stopAudioCalls: boolean[] = [];

  const controller = createWorkspaceController({
    domain,
    gemini: createGeminiMock(args?.gemini),
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

  return {
    controller,
    domain,
    projectLibrary,
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
  assert.equal(state.runtime.screenState, AppState.ASSESSMENT);
  assert.equal(state.runtime.assessmentMessages[0]?.text, 'Domanda iniziale');
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
    gemini: {
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
    gemini: {
      getPdfLessonMappingState: (file, plan, documentIndex) =>
        getPdfProjectHydrationState(file, plan, documentIndex),
      preparePdfLessonMappings: async () => {
        prepareCalls += 1;
        return {
          learningPlan: {
            ...stalePlan,
            sections: stalePlan.sections.map((section, index) => ({
              ...section,
              primaryChunkIds: [`chunk-00${index + 3}`],
            })),
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
    projectLibrary.persistedSnapshots[1]?.learningPlan?.sections[0]?.primaryChunkIds,
    ['chunk-003']
  );
});

test('openProject skips pdf hydration checks for text document sources', async () => {
  const snapshot = createProjectSnapshot({
    id: 'project-md',
    source: createProjectSourceFromFile(markdownFile),
    state: AppState.ASSESSMENT,
  });
  let hydrationFileArg: FileData | null | undefined;

  const { controller } = createControllerHarness({
    gemini: {
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
    gemini: {
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
  assert.equal(state.runtime.assessmentMessages[0]?.text, 'Domanda iniziale');
});

test('openProject settles its own workflow before starting assessment follow-up', async () => {
  const snapshot = createProjectSnapshot({
    id: 'project-md-follow-up',
    source: createProjectSourceFromFile(markdownFile),
    state: AppState.ASSESSMENT,
  });

  const { controller, state } = createControllerHarness({
    gemini: {
      createAssessmentChatFromTextSource: async () => {
        assert.equal(state.runtime.workflowState.openProject.status, 'succeeded');
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
  assert.equal(state.runtime.workflowState.openProject.status, 'succeeded');
});

test('openProject does not wait for library metadata refresh before continuing', async () => {
  const snapshot = createProjectSnapshot({
    id: 'project-md-refresh',
    source: createProjectSourceFromFile(markdownFile),
    state: AppState.ASSESSMENT,
  });
  let refreshStarted = false;
  let releaseTouch: (() => void) | null = null;
  let releaseRefresh: (() => void) | null = null;
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
    gemini: {
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
      touchStoredProject: async projectId => {
        await touchGate;
        return buildMeta(projectId);
      },
    },
  });

  const openProjectPromise = controller.openProject('project-md-refresh');
  await assessmentStarted;

  assert.equal(state.runtime.workflowState.openProject.status, 'succeeded');
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
  assert.equal(state.runtime.screenState, AppState.ASSESSMENT);
  assert.equal(domain.source?.kind, 'pdf');
  assert.equal(projectLibrary.persistedSnapshots.length, 1);
  assert.equal(projectLibrary.persistedSnapshots[0]?.state, AppState.ASSESSMENT);
  assert.equal(state.runtime.assessmentMessages[0]?.text, 'Domanda iniziale');
});

test('handleSourceUpload reattach clears transient runtime state and invalidates stale workflows', async () => {
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

  state.runtime.assessmentMessages = [{ role: 'model', text: 'Vecchia chat' }];
  state.runtime.chatSession = {
    sendMessage: async () => ({ text: 'unused' }),
  };
  state.runtime.openingProjectId = 'project-opening';
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
  assert.deepEqual(state.runtime.assessmentMessages, []);
  assert.equal(state.runtime.chatSession, null);
  assert.equal(state.runtime.openingProjectId, null);
  assert.equal(state.runtime.workflowState.loadSection.status, 'idle');
  assert.equal(state.adapter.isWorkflowCurrent('loadSection', staleLoadSectionRequestId), false);
  assert.equal(state.runtime.workflowState.attachSource.status, 'succeeded');
});

test('handleSourceUpload accepts markdown sources with missing mime and stores them as document projects', async () => {
  let textAssessmentCalls = 0;
  let fileAssessmentCalls = 0;
  const { controller, domain, projectLibrary, state } = createControllerHarness({
    gemini: {
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
  assert.equal(state.runtime.screenState, AppState.ASSESSMENT);
  assert.equal(domain.source?.kind, 'codebase-bundle');
  assert.equal(projectLibrary.persistedSnapshots[0]?.sourceKind, 'document');
  assert.equal(projectLibrary.persistedSnapshots[0]?.source?.kind, 'codebase-bundle');
  assert.equal(textAssessmentCalls, 1);
  assert.equal(fileAssessmentCalls, 0);
  assert.equal(state.runtime.assessmentMessages[0]?.text, 'Domanda iniziale');
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
  assert.equal(state.runtime.screenState, AppState.LIBRARY);
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
  assert.equal(state.runtime.screenState, AppState.ASSESSMENT);
  assert.equal(domain.isLearnMode, true);
  assert.equal(domain.learningPlan, null);
  assert.equal(projectLibrary.persistedSnapshots.length, 1);
  assert.equal(projectLibrary.persistedSnapshots[0]?.isLearnMode, true);
  assert.equal(state.runtime.assessmentMessages[0]?.text.includes('Architect'), true);
});

test('startHomeChat passes the Nuovo corso preference to the model without altering the visible user message', async () => {
  let sentMessage = '';
  const { controller, state } = createControllerHarness({
    gemini: {
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
    toolPreferences: { newCourse: true },
  });

  assert.equal(result.outcome, 'continued');
  assert.equal(state.runtime.assessmentMessages[0]?.text, 'Vorrei capire meglio come studiare');
  assert.equal(sentMessage.includes('[Preferenza utente attiva: Nuovo corso]'), true);
  assert.equal(sentMessage.includes('Vorrei capire meglio come studiare'), true);
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
  assert.equal(domain.learningPlan?.sections.length, 1);
  assert.equal(domain.activeSectionId, 'lesson-1');
  assert.equal(state.runtime.screenState, AppState.READING);
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
    newCourse: true,
  });

  assert.equal(result.outcome, 'continued');
  assert.equal(sentMessage.includes('[Preferenza utente attiva: Nuovo corso]'), true);
  assert.equal(sentMessage.includes('Fammi una domanda utile'), true);
  assert.equal(state.runtime.assessmentMessages.at(-1)?.text, 'Profilazione');
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
    gemini: {
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
  assert.equal(state.runtime.screenState, AppState.READING);
  assert.equal(domain.learningPlan?.sections[0]?.title, 'Lezione 1');
});

test('submitAssessment in document mode can generate a plan for text-backed sources', async () => {
  const markdownSource = createProjectSourceFromFile(markdownFile);
  let planFileArg: FileData | null = null;
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
    gemini: {
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
  assert.equal(state.runtime.screenState, AppState.READING);
  assert.equal(domain.learningPlan?.sections[0]?.title, 'Lezione 1');
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
    gemini: {
      generateSectionContent: async () => {
        generateSectionCalls += 1;
        return {
          content: '# Generata',
          quiz: [],
          imageRefs: [],
          documentAssets: null,
        };
      },
    },
  });

  const cachedOutcome = await controller.openSection(cachedPlan.sections[0]);
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

  const loadedOutcome = await controller.openSection(uncachedPlan.sections[0]);
  assert.equal(loadedOutcome, 'loaded');
  assert.equal(generateSectionCalls, 1);
  assert.equal(domain.learningPlan?.sections[0]?.content, '# Generata');
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
  const result = await controller.openSection(uncachedPlan.sections[0]);

  assert.equal(result, 'ignored-busy');
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
  });

  const result = await controller.createLessonFromSelection({
    instructions: 'Approfondisci',
    selectedText: 'testo',
  });

  assert.equal(result.outcome, 'created');
  assert.equal(domain.learningPlan?.sections[2]?.id, 'deep-1');
  assert.equal(domain.activeSectionId, 'deep-1');
  assert.equal(domain.learningPlan?.sections[2]?.content, '# Lezione dal documento');
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
    gemini: {
      createSubChapterMetadata: async () => ({
        id: 'deep-1-nested',
        title: 'Approfondimento annidato',
        description: 'Dettaglio ricorsivo',
        isCompleted: false,
        type: 'deep-dive',
        parentId: 'lesson-1-deep',
      }),
    },
  });

  const result = await controller.createLessonFromSelection({
    instructions: 'Scendi di un livello',
    selectedText: 'testo',
  });

  assert.equal(result.outcome, 'created');
  assert.deepEqual(
    domain.learningPlan?.sections.map(section => section.id),
    ['lesson-1', 'lesson-1-deep', 'deep-1-nested', 'lesson-1-deep-sibling', 'lesson-2']
  );
  assert.equal(domain.activeSectionId, 'deep-1-nested');
  assert.equal(domain.learningPlan?.sections[2]?.content, '# Lezione dal documento');
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
  assert.equal(domain.learningPlan?.sections[0]?.isCompleted, true);
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
  assert.equal(domain.learningPlan?.sections[0]?.isCompleted, true);
});

test('goToLibrary returns the UX to library and stops active audio playback', async () => {
  const { controller, state, stopAudioCalls } = createControllerHarness();

  state.adapter.setScreenState(AppState.READING);
  await controller.goToLibrary();

  assert.equal(state.runtime.screenState, AppState.LIBRARY);
  assert.deepEqual(stopAudioCalls, [true]);
});
