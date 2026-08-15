// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';

import type { AddressInfo } from 'node:net';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as React from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { createApp } from '../apps/backend/src/index.js';
import { setProjectStoreForTesting } from '../apps/backend/src/projects/projectStore.js';
import type { ProjectSnapshot } from '../apps/backend/src/projects/types.js';
import type { LessonGenerationApi } from '../apps/backend/src/workflows/lessonGenerationApi.js';
import { createSupabaseTestToken } from '../apps/backend/tests/helpers/auth.js';
import { InMemoryProjectStore } from '../apps/backend/tests/helpers/inMemoryProjectStore.js';
import { NewHomeView } from '../apps/web/components/newHome/NewHomeView.tsx';
import type { LibraryTree, SavedProjectMeta } from '../apps/web/types.ts';
import { writeFeatureMapObservation } from './feature-map-observation.ts';

const useChatMock = vi.hoisted(() => vi.fn());
const fetchWithSupabaseAuthMock = vi.hoisted(() => vi.fn());
const chatTransportConfigs: Array<{
  api?: string;
  prepareSendMessagesRequest?: (input: unknown) => unknown;
}> = [];

vi.mock('@ai-sdk/react', () => ({ useChat: useChatMock }));
vi.mock('ai', async importOriginal => ({
  ...(await importOriginal<typeof import('ai')>()),
  DefaultChatTransport: class DefaultChatTransport {
    constructor(config: {
      api?: string;
      prepareSendMessagesRequest?: (input: unknown) => unknown;
    }) {
      chatTransportConfigs.push(config);
    }
  },
  isTextUIPart: (part: { type?: string }) => part?.type === 'text',
  isToolUIPart: (part: { type?: string }) => part?.type?.startsWith('tool-') === true,
  lastAssistantMessageIsCompleteWithToolCalls: () => false,
}));
vi.mock('../apps/web/services/auth/supabaseAuth.ts', async importOriginal => ({
  ...(await importOriginal<typeof import('../apps/web/services/auth/supabaseAuth.ts')>()),
  fetchWithSupabaseAuth: fetchWithSupabaseAuthMock,
}));
vi.mock('../apps/web/services/openrouter/config.ts', () => ({
  getBackendUrl: () => 'http://localhost:3301',
}));
vi.mock('../apps/web/services/openrouter/artifactDrafts.ts', () => ({
  generateLessonArtifactDraft: vi.fn(),
}));
vi.mock('../apps/web/hooks/useMobileKeyboardOffset.ts', () => ({
  useMobileKeyboardOffset: () => ({ keyboardOffset: 0, viewportHeight: 844 }),
}));

const { generateDurableLesson } = await import(
  '../apps/web/services/openrouter/lessonGenerationClient.ts'
);
const { default: ContextAnswerPanel } = await import(
  '../apps/web/components/workspace/shell/ContextAnswerPanel.tsx'
);

const SEED_USER_ID = 'feature-map-user';
const SEED_PROJECT_ID = 'feature-map-project';
const SEED_LESSON_ID = 'feature-map-lesson';
const ORIGINAL_ENV = { ...process.env };

const authHeader = (): string => `Bearer ${createSupabaseTestToken({ userId: SEED_USER_ID })}`;

const requestJson = async ({
  app,
  body,
  method,
  requestPath,
}: {
  app: ReturnType<typeof createApp>;
  body?: unknown;
  method: 'GET' | 'POST';
  requestPath: string;
}): Promise<{ body: Record<string, unknown>; status: number }> => {
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const { port } = server.address() as AddressInfo;
  try {
    const response = await fetch(`http://127.0.0.1:${port}${requestPath}`, {
      body: body === undefined ? undefined : JSON.stringify(body),
      headers: {
        Authorization: authHeader(),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      method,
    });
    return {
      body: (await response.json()) as Record<string, unknown>,
      status: response.status,
    };
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close(error => (error ? reject(error) : resolve()))
    );
  }
};

const seedSnapshot = (): ProjectSnapshot => ({
  activeSectionId: SEED_LESSON_ID,
  createdAt: '2026-08-15T10:00:00.000Z',
  id: SEED_PROJECT_ID,
  isLearnMode: false,
  lastOpenedAt: '2026-08-15T10:00:00.000Z',
  learningPlan: {
    applicationExercisePlanningStatus: 'not-run',
    modules: [
      {
        children: [
          {
            content: 'Contenuto seed leggibile.',
            contentBlocks: [{ markdown: 'Contenuto seed leggibile.', type: 'markdown' }],
            description: 'Lezione seed',
            generatedVisuals: [],
            id: SEED_LESSON_ID,
            imageRefs: [],
            isCompleted: true,
            kind: 'lesson',
            learningAids: [],
            quiz: [],
            title: 'Lezione seed',
            type: 'core',
          },
        ],
        id: 'feature-map-module',
        title: 'Modulo seed',
      },
    ],
    title: 'Corso feature map',
  },
  source: null,
  sourceKind: 'document',
  state: 'READING',
  syllabus: [],
  updatedAt: '2026-08-15T10:00:00.000Z',
  userProfile: null,
  version: '4.1',
});

const emptyTree = (project: SavedProjectMeta): LibraryTree => ({
  descendantProjectIdsByFolderId: {},
  folderById: {},
  placementByProjectId: {},
  rootNodes: [{ id: project.id, kind: 'project', order: 1, project }],
});

const homeChatProps = (tree: LibraryTree) => ({
  assessmentComplete: false,
  assessmentMessages: [],
  homeChatMode: 'library-query' as const,
  isDarkMode: false,
  isLibraryLoading: false,
  isLibraryModeLoading: false,
  isNewCourseLoading: false,
  libraryAttachedContextRefs: [],
  libraryErrorMessage: null,
  libraryGenerateArtifacts: false,
  libraryMessages: [],
  libraryTree: tree,
  libraryWebSearch: false,
  newCourseLoadingStatus: '',
  onClearPendingFile: vi.fn(),
  onConfirmGenerate: vi.fn(),
  onHomeChatModeChange: vi.fn(),
  onLibraryGenerateArtifactsChange: vi.fn(),
  onLibraryMessageSend: vi.fn(async () => {}),
  onLibraryWebSearchChange: vi.fn(),
  onSendAssessmentMessage: vi.fn(async () => {}),
  onToggleLibraryContextRef: vi.fn(),
  onUploadSourceClick: vi.fn(),
  pendingFileName: null,
});

beforeEach(() => {
  process.env = {
    ...ORIGINAL_ENV,
    AUTH_MODE: 'supabase',
    SUPABASE_JWT_SECRET: 'test-secret',
    SUPABASE_URL: 'https://example.supabase.co',
  };
  globalThis.history.replaceState({}, '', '/');
  globalThis.localStorage.clear();
  globalThis.sessionStorage.clear();
  fetchWithSupabaseAuthMock.mockReset();
  useChatMock.mockReset();
  chatTransportConfigs.length = 0;
});

afterEach(() => {
  cleanup();
  setProjectStoreForTesting(null);
  process.env = { ...ORIGINAL_ENV };
  vi.restoreAllMocks();
});

describe('generated feature-map journey observations', () => {
  test('observes authenticated Home to Reader through a seeded project', async () => {
    const store = new InMemoryProjectStore();
    setProjectStoreForTesting(store);
    await store.saveProject(SEED_USER_ID, seedSnapshot());

    const response = await requestJson({
      app: createApp(),
      method: 'GET',
      requestPath: '/api/projects/projects',
    });
    expect(response.status).toBe(200);
    const project = (response.body.projects as SavedProjectMeta[])[0];
    const tree = emptyTree(project);
    const onOpenProject = vi.fn();
    const user = userEvent.setup();
    const { container } = render(
      <NewHomeView
        chatProps={homeChatProps(tree)}
        isDarkMode={false}
        isLibraryLoading={false}
        libraryFolders={[]}
        libraryTree={tree}
        loadProjectCover={vi.fn(async () => null)}
        loadProjectSource={vi.fn(async () => null)}
        loadProjectsById={vi.fn(async () => [seedSnapshot()])}
        onCreateFolder={vi.fn(async () => {})}
        onOpenProject={onOpenProject}
        onToggleDarkMode={vi.fn()}
        openingProjectId={null}
        projects={[project]}
        saveProjectCover={vi.fn(async () => {})}
      />
    );
    const courses = within(container.querySelector('#courses') as HTMLElement);
    await user.click(courses.getByRole('button', { name: 'Corso feature map' }));
    expect(onOpenProject).toHaveBeenCalledWith(SEED_PROJECT_ID);

    await writeFeatureMapObservation({
      auth: { kind: 'supabase-test-jwt', seedUserId: SEED_USER_ID },
      browser: {
        assertions: [
          'Seeded course rendered in NewHomeView.',
          'Course action selected the seeded reader project.',
        ],
        environment: 'jsdom',
        viewport: 'desktop',
      },
      id: 'home-to-reader',
      limitations: [
        'Real Chromium navigation and a real Supabase database are not exercised in this thin slice.',
      ],
      modules: [
        'apps/web/components/newHome/NewHomeView.tsx',
        'apps/web/components/library/LibraryScreenContainer.tsx',
        'apps/web/components/workspace/ReadingScreenContainer.tsx',
      ],
      network: [{ method: 'GET', path: '/api/projects/projects', status: response.status }],
      persistence: [
        {
          entity: `project:${SEED_PROJECT_ID}`,
          kind: 'in-memory-project-store',
          proof: 'Authenticated list returned the seeded project before the UI opened it.',
        },
      ],
      title: 'Home → Reader',
      workflows: [],
    });
  });

  test('observes lesson generation across the frontend client and authenticated workflow route', async () => {
    const completedResult = {
      content: 'Lezione generata dalla fixture.',
      contentBlocks: [{ markdown: 'Lezione generata dalla fixture.', type: 'markdown' }],
      generatedVisuals: [],
      imageRefs: [],
      learningAids: [],
      projectId: SEED_PROJECT_ID,
      projectRevision: 2,
      quiz: [],
      sectionId: SEED_LESSON_ID,
      warnings: [],
    };
    const job = {
      createdAt: '2026-08-15T10:01:00.000Z',
      id: 'feature-map-run',
      projectId: SEED_PROJECT_ID,
      result: completedResult,
      retrying: false,
      sectionId: SEED_LESSON_ID,
      stage: 'verification' as const,
      status: 'completed' as const,
      updatedAt: '2026-08-15T10:02:00.000Z',
    };
    const api: LessonGenerationApi = {
      get: vi.fn(async () => job),
      start: vi.fn(async () => ({ busy: false, created: false, job })),
      startSublesson: vi.fn(async () => ({ busy: false, created: false, job })),
    };
    const response = await requestJson({
      app: createApp({ lessonGenerationApi: api }),
      body: {
        projectId: SEED_PROJECT_ID,
        requestKey: 'feature-map-request',
        sectionId: SEED_LESSON_ID,
      },
      method: 'POST',
      requestPath: '/api/lesson-workflows/lessons',
    });
    expect(response.status).toBe(200);
    fetchWithSupabaseAuthMock.mockResolvedValue(
      new Response(JSON.stringify(response.body), { status: response.status })
    );
    await expect(
      generateDurableLesson({ projectId: SEED_PROJECT_ID, sectionId: SEED_LESSON_ID })
    ).resolves.toMatchObject(completedResult);

    await writeFeatureMapObservation({
      auth: { kind: 'supabase-test-jwt', seedUserId: SEED_USER_ID },
      browser: {
        assertions: ['Frontend durable lesson client accepted the terminal workflow snapshot.'],
        environment: 'jsdom',
        viewport: 'desktop',
      },
      id: 'lesson-generation',
      limitations: [
        'The workflow API is deterministic and injected; worker execution and PostgreSQL persistence remain unresolved.',
      ],
      modules: [
        'apps/web/services/openrouter/lessonGenerationClient.ts',
        'apps/backend/src/routes/lessonWorkflows.ts',
        'apps/backend/src/workflows/lessonGenerationApi.ts',
      ],
      network: [{ method: 'POST', path: '/api/lesson-workflows/lessons', status: response.status }],
      persistence: [
        {
          entity: `lesson:${SEED_LESSON_ID}`,
          kind: 'not-applicable',
          proof: 'Injected API returned revision 2; no database write was claimed.',
        },
      ],
      title: 'Lesson generation',
      workflows: [{ event: 'terminal-snapshot', runId: job.id, status: job.status }],
    });
  });

  test('observes the contextual chat mobile composer and authenticated route boundary', async () => {
    const sendMessage = vi.fn(async () => {});
    useChatMock.mockReturnValue({
      addToolOutput: vi.fn(),
      error: undefined,
      messages: [],
      sendMessage,
      status: 'ready',
    });
    const user = userEvent.setup();
    const { container } = render(
      <ContextAnswerPanel
        contextAnswer={{
          id: 'feature-map-context',
          initialQuestion: 'Spiega la selezione',
          lessonContent: 'Contenuto lezione',
          lessonDescription: 'Descrizione',
          lessonId: SEED_LESSON_ID,
          lessonTitle: 'Lezione seed',
          projectId: SEED_PROJECT_ID,
          projectTitle: 'Corso feature map',
          selectedText: 'testo selezionato',
        }}
        contextAnswerPanelRef={React.createRef<HTMLDivElement>()}
        contextAnswerSize={{ height: 640, width: 360 }}
        currentLessonArtifactPayloads={[]}
        handleContextAnswerResizeStart={vi.fn()}
        isDarkMode={false}
        isMobileViewport={true}
        onClose={vi.fn()}
        onSaveConversationNote={vi.fn()}
        onUpdateConversationNote={vi.fn()}
      />
    );
    const panel = container.querySelector('[data-context-answer-panel="true"]');
    expect(panel).toHaveClass('h-[80dvh]');
    const textbox = screen.getByRole('textbox');
    await user.type(textbox, 'Un esempio');
    await user.click(screen.getByRole('button', { name: /Invia|Send/i }));
    expect(sendMessage).toHaveBeenCalledWith({ text: 'Un esempio' });
    expect(chatTransportConfigs[0]?.api).toBe('http://localhost:3301/api/chat/context');

    const rejectedBoundary = await requestJson({
      app: createApp(),
      body: {},
      method: 'POST',
      requestPath: '/api/chat/context',
    });
    expect(rejectedBoundary.status).toBe(400);

    await writeFeatureMapObservation({
      auth: { kind: 'supabase-test-jwt', seedUserId: SEED_USER_ID },
      browser: {
        assertions: [
          'Mobile 80dvh panel rendered.',
          'Composer submitted a follow-up through the configured chat transport.',
        ],
        environment: 'jsdom',
        viewport: 'mobile',
      },
      id: 'contextual-chat-mobile',
      limitations: [
        'The authenticated backend boundary is verified only through request validation; a deterministic streaming provider adapter is not injectable in createApp.',
      ],
      modules: [
        'apps/web/components/workspace/shell/ContextAnswerPanel.tsx',
        'apps/web/components/workspace/shell/WorkspaceReaderOverlays.tsx',
        'apps/backend/src/routes/chat.ts',
      ],
      network: [{ method: 'POST', path: '/api/chat/context', status: rejectedBoundary.status }],
      persistence: [
        {
          entity: 'context-chat',
          kind: 'not-applicable',
          proof: 'The route streams an answer and owns no project persistence contract.',
        },
      ],
      title: 'Contextual chat mobile',
      workflows: [],
    });
  });
});
