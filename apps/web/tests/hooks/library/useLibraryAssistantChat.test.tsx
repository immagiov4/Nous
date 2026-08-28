// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import type { UIMessage } from 'ai';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const useChatMock = vi.fn();
const addToolOutputMock = vi.fn();
const generateLessonArtifactDraftMock = vi.fn();
const lastAssistantMessageIsCompleteWithToolCallsMock = vi.fn();
const stopMock = vi.fn();

class MockDefaultChatTransport<UI_MESSAGE extends UIMessage> {
  api: string;
  prepareSendMessagesRequest?: (options: {
    api: string;
    body: Record<string, unknown>;
    credentials?: RequestCredentials;
    headers?: HeadersInit;
    id: string;
    messageId?: string;
    messages: UI_MESSAGE[];
    requestMetadata?: unknown;
    trigger?: string;
  }) => Promise<unknown> | unknown;

  constructor({
    api,
    prepareSendMessagesRequest,
  }: {
    api: string;
    prepareSendMessagesRequest?: MockDefaultChatTransport<UI_MESSAGE>['prepareSendMessagesRequest'];
  }) {
    this.api = api;
    this.prepareSendMessagesRequest = prepareSendMessagesRequest;
  }
}

vi.mock('@ai-sdk/react', () => ({
  useChat: useChatMock,
}));

vi.mock('ai', () => ({
  DefaultChatTransport: MockDefaultChatTransport,
  lastAssistantMessageIsCompleteWithToolCalls: lastAssistantMessageIsCompleteWithToolCallsMock,
}));

vi.mock('../../../services/openrouter/config.ts', () => ({
  getBackendUrl: () => 'http://localhost:3301',
}));

vi.mock('../../../services/auth/supabaseAuth.ts', () => ({
  fetchWithSupabaseAuth: vi.fn(),
}));

vi.mock('../../../services/openrouter/artifactDrafts.ts', () => ({
  generateLessonArtifactDraft: generateLessonArtifactDraftMock,
}));

const { useLibraryAssistantChat } = await import(
  '../../../hooks/library/useLibraryAssistantChat.ts'
);

describe('useLibraryAssistantChat', () => {
  beforeEach(() => {
    useChatMock.mockReset();
    addToolOutputMock.mockReset();
    generateLessonArtifactDraftMock.mockReset();
    lastAssistantMessageIsCompleteWithToolCallsMock.mockReset();
    lastAssistantMessageIsCompleteWithToolCallsMock.mockReturnValue(false);
    stopMock.mockReset();
    useChatMock.mockReturnValue({
      addToolOutput: addToolOutputMock,
      error: undefined,
      messages: [],
      sendMessage: vi.fn(),
      status: 'ready',
      stop: stopMock,
    });
  });

  const folder = {
    id: 'folder-1',
    name: 'Frontend',
    parentFolderId: null,
    createdAt: '2026-04-01T10:00:00.000Z',
    updatedAt: '2026-04-01T10:00:00.000Z',
    order: 1,
  };

  const project = {
    id: 'project-1',
    title: 'Corso TypeScript',
    sourceKind: 'document' as const,
    createdAt: '2026-04-01T10:00:00.000Z',
    updatedAt: '2026-04-01T10:00:00.000Z',
    lastOpenedAt: '2026-04-01T10:00:00.000Z',
    lessonCount: 1,
    completedCount: 0,
    exerciseCount: 0,
    completedExercises: 0,
    hasSourceFile: true,
    coverLabel: 'PDF',
  };

  const secondProject = {
    ...project,
    id: 'project-2',
    title: 'Corso React',
  };

  const emptyTree = {
    descendantProjectIdsByFolderId: {},
    folderById: {},
    placementByProjectId: {},
    rootNodes: [],
  };

  const loadedTree = {
    descendantProjectIdsByFolderId: {
      [folder.id]: [project.id],
    },
    folderById: {
      [folder.id]: folder,
    },
    placementByProjectId: {},
    rootNodes: [],
  };

  test('exposes the active AI SDK cancellation through the library message sender', () => {
    const { result } = renderHook(() =>
      useLibraryAssistantChat({
        folders: [],
        loadProjectsById: vi.fn(async () => []),
        projects: [],
        tree: emptyTree,
      })
    );

    act(() => result.current.sendLibraryMessage.stop?.());

    expect(stopMock).toHaveBeenCalledOnce();
  });

  test('does not revive a stopped client tool when a new library message starts', async () => {
    lastAssistantMessageIsCompleteWithToolCallsMock.mockReturnValue(true);
    let resolveProjects: (projects: never[]) => void = () => {};
    const projectsRequest = new Promise<never[]>(resolve => {
      resolveProjects = resolve;
    });
    const sendMessage = vi.fn();
    useChatMock.mockReturnValue({
      addToolOutput: addToolOutputMock,
      error: undefined,
      messages: [
        {
          id: 'assistant-deferred-tool',
          role: 'assistant',
          parts: [{ type: 'text', text: 'Risposta parziale', state: 'streaming' }],
        },
      ],
      sendMessage,
      status: 'streaming',
      stop: stopMock,
    });
    const { result } = renderHook(() =>
      useLibraryAssistantChat({
        folders: [],
        loadProjectsById: vi.fn(() => projectsRequest),
        projects: [],
        tree: emptyTree,
      })
    );
    const chatOptions = useChatMock.mock.calls[0]?.[0];
    let toolCallRequest: Promise<void> | undefined;

    act(() => {
      toolCallRequest = chatOptions.onToolCall({
        toolCall: {
          dynamic: false,
          input: {
            lessonId: 'lesson-1',
            projectId: 'project-1',
            prompt: 'Crea uno schema.',
          },
          toolCallId: 'deferred-artifact',
          toolName: 'generateLearningArtifact',
        },
      });
    });
    expect(chatOptions.sendAutomaticallyWhen({ messages: [] })).toBe(true);
    act(() => result.current.sendLibraryMessage.stop?.());
    expect(chatOptions.sendAutomaticallyWhen({ messages: [] })).toBe(false);
    expect(addToolOutputMock).toHaveBeenCalledWith(
      expect.objectContaining({
        state: 'output-error',
        toolCallId: 'deferred-artifact',
      })
    );
    act(() => {
      void result.current.sendLibraryMessage('Nuova domanda');
    });
    expect(sendMessage).toHaveBeenCalledWith({ text: 'Nuova domanda' });
    expect(chatOptions.sendAutomaticallyWhen({ messages: [] })).toBe(true);
    await act(async () => {
      resolveProjects([]);
      await toolCallRequest;
    });

    expect(addToolOutputMock).toHaveBeenCalledOnce();
    expect(addToolOutputMock).toHaveBeenCalledWith({
      tool: 'generateLearningArtifact',
      toolCallId: 'deferred-artifact',
      state: 'output-error',
      errorText: expect.stringMatching(/^(Cancelled|Annullato)$/),
    });
  });

  test('terminalizes only pending tools from the active library turn', () => {
    useChatMock.mockReturnValue({
      addToolOutput: addToolOutputMock,
      error: undefined,
      messages: [
        {
          id: 'assistant-old-note',
          role: 'assistant',
          parts: [
            {
              input: { noteDraft: 'Nota precedente' },
              state: 'input-available',
              toolCallId: 'old-note-request',
              type: 'tool-requestSaveLearningArtifactNote',
            },
          ],
        },
        {
          id: 'assistant-active',
          role: 'assistant',
          parts: [
            {
              input: { query: 'domanda corrente' },
              state: 'input-available',
              toolCallId: 'active-search',
              type: 'tool-searchLibrary',
            },
          ],
        },
      ],
      sendMessage: vi.fn(),
      status: 'streaming',
      stop: stopMock,
    });
    const { result } = renderHook(() =>
      useLibraryAssistantChat({
        folders: [],
        loadProjectsById: vi.fn(async () => []),
        projects: [],
        tree: emptyTree,
      })
    );

    act(() => result.current.sendLibraryMessage.stop?.());

    expect(addToolOutputMock).toHaveBeenCalledOnce();
    expect(addToolOutputMock).toHaveBeenCalledWith(
      expect.objectContaining({ toolCallId: 'active-search' })
    );
    expect(addToolOutputMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ toolCallId: 'old-note-request' })
    );
  });

  test('preserves a prior note decision when Stop precedes the new assistant reply', () => {
    useChatMock.mockReturnValue({
      addToolOutput: addToolOutputMock,
      error: undefined,
      messages: [
        {
          id: 'assistant-old-note',
          role: 'assistant',
          parts: [
            {
              input: { noteDraft: 'Nota precedente' },
              state: 'input-available',
              toolCallId: 'old-note-request',
              type: 'tool-requestSaveLearningArtifactNote',
            },
          ],
        },
        {
          id: 'user-new-question',
          role: 'user',
          parts: [{ type: 'text', text: 'Nuova domanda' }],
        },
      ],
      sendMessage: vi.fn(),
      status: 'submitted',
      stop: stopMock,
    });
    const { result } = renderHook(() =>
      useLibraryAssistantChat({
        folders: [],
        loadProjectsById: vi.fn(async () => []),
        projects: [],
        tree: emptyTree,
      })
    );

    act(() => result.current.sendLibraryMessage.stop?.());

    expect(stopMock).toHaveBeenCalledOnce();
    expect(addToolOutputMock).not.toHaveBeenCalled();
  });

  test('sends the latest web-search preference through the initial transport instance', async () => {
    const stableFolders = [folder];
    const stableProjects = [project];
    const loadProjectsById = vi.fn(async () => []);

    const { result } = renderHook(() =>
      useLibraryAssistantChat({
        folders: stableFolders,
        loadProjectsById,
        projects: stableProjects,
        tree: loadedTree,
      })
    );

    const initialTransport = useChatMock.mock.calls[0]?.[0]
      ?.transport as MockDefaultChatTransport<UIMessage>;
    expect(initialTransport).toBeDefined();

    await act(async () => {
      result.current.setWebSearch(true);
    });

    expect(useChatMock.mock.calls.at(-1)?.[0]?.transport).toBe(initialTransport);

    const preparedRequest = await initialTransport.prepareSendMessagesRequest?.({
      api: 'http://localhost:3301/api/chat/library',
      body: {},
      credentials: undefined,
      headers: { 'X-Existing-Header': 'kept' },
      id: 'chat-1',
      messageId: undefined,
      messages: [],
      requestMetadata: undefined,
      trigger: 'submit-message',
    });

    expect(preparedRequest).toMatchObject({
      body: {
        toolPreferences: expect.objectContaining({
          webSearch: true,
        }),
      },
    });
    expect(
      (preparedRequest as { body?: Record<string, unknown> }).body?.modelOverride
    ).toBeUndefined();
    expect((preparedRequest as { headers?: Record<string, string> }).headers).toEqual({
      'X-Existing-Header': 'kept',
    });
  });

  test('uses the latest whole-library scope after library hydration on the initial transport instance', async () => {
    const loadProjectsById = vi.fn(async () => []);

    const { rerender } = renderHook(
      ({ folders, projects, tree }) =>
        useLibraryAssistantChat({
          folders,
          loadProjectsById,
          projects,
          tree,
        }),
      {
        initialProps: {
          folders: [] as (typeof folder)[],
          projects: [] as (typeof project)[],
          tree: emptyTree,
        },
      }
    );

    const initialTransport = useChatMock.mock.calls[0]?.[0]
      ?.transport as MockDefaultChatTransport<UIMessage>;
    expect(initialTransport).toBeDefined();

    rerender({
      folders: [folder],
      projects: [project],
      tree: loadedTree,
    });

    const preparedRequest = await initialTransport.prepareSendMessagesRequest?.({
      api: 'http://localhost:3301/api/chat/library',
      body: {},
      credentials: undefined,
      headers: {},
      id: 'chat-2',
      messageId: undefined,
      messages: [],
      requestMetadata: undefined,
      trigger: 'submit-message',
    });

    expect(preparedRequest).toMatchObject({
      body: {
        resolvedScopeSummary: expect.objectContaining({
          isWholeLibraryScope: true,
          scopeProjectIds: [project.id],
          scopeSummary: 'Intero archivio server (1 corsi disponibili).',
        }),
      },
    });
  });

  test('folder selection replaces descendant refs and deselection clears the whole subtree', () => {
    const treeWithTwoProjects = {
      ...loadedTree,
      descendantProjectIdsByFolderId: {
        [folder.id]: [project.id, secondProject.id],
      },
    };
    const { result } = renderHook(() =>
      useLibraryAssistantChat({
        folders: [folder],
        loadProjectsById: vi.fn(async () => []),
        projects: [project, secondProject],
        tree: treeWithTwoProjects,
      })
    );

    act(() => {
      result.current.toggleAttachedContextRef({
        id: project.id,
        kind: 'project',
        label: project.title,
      });
      result.current.toggleAttachedContextRef({
        id: folder.id,
        kind: 'folder',
        label: folder.name,
      });
    });

    expect(result.current.attachedContextRefs).toEqual([
      {
        id: folder.id,
        kind: 'folder',
        label: folder.name,
      },
    ]);
    expect(result.current.scopeSummary.scopeProjectIds).toEqual([project.id, secondProject.id]);

    act(() => {
      result.current.toggleAttachedContextRef({
        id: project.id,
        kind: 'project',
        label: project.title,
      });
      result.current.toggleAttachedContextRef({
        id: folder.id,
        kind: 'folder',
        label: folder.name,
      });
    });

    expect(result.current.attachedContextRefs).toEqual([]);
  });

  test('exposes a semantic new-course handoff requested by the library model', async () => {
    lastAssistantMessageIsCompleteWithToolCallsMock.mockReturnValue(true);
    const { result } = renderHook(() =>
      useLibraryAssistantChat({
        folders: [folder],
        loadProjectsById: vi.fn(async () => []),
        projects: [project],
        tree: loadedTree,
      })
    );
    const onToolCall = useChatMock.mock.calls[0]?.[0]?.onToolCall;
    const sendAutomaticallyWhen = useChatMock.mock.calls[0]?.[0]?.sendAutomaticallyWhen;

    await act(async () => {
      await onToolCall({
        toolCall: {
          dynamic: false,
          input: { topic: 'pixel art' },
          toolCallId: 'course-assessment-1',
          toolName: 'startCourseAssessment',
        },
      });
    });

    expect(result.current.courseAssessmentRequest).toEqual({ topic: 'pixel art' });
    expect(stopMock).toHaveBeenCalledOnce();
    expect(sendAutomaticallyWhen({ messages: [] })).toBe(false);
    expect(addToolOutputMock).toHaveBeenCalledWith({
      tool: 'startCourseAssessment',
      toolCallId: 'course-assessment-1',
      output: {
        handoffRequested: true,
        topic: 'pixel art',
      },
    });

    act(() => {
      result.current.consumeCourseAssessmentRequest();
    });

    expect(result.current.courseAssessmentRequest).toBeNull();
  });

  test('terminalizes a parallel client tool when the library hands off to a new course', async () => {
    lastAssistantMessageIsCompleteWithToolCallsMock.mockReturnValue(true);
    let resolveProjects: (projects: never[]) => void = () => {};
    const projectsRequest = new Promise<never[]>(resolve => {
      resolveProjects = resolve;
    });
    const { result } = renderHook(() =>
      useLibraryAssistantChat({
        folders: [],
        loadProjectsById: vi.fn(() => projectsRequest),
        projects: [],
        tree: emptyTree,
      })
    );
    const onToolCall = useChatMock.mock.calls[0]?.[0]?.onToolCall;
    let deferredToolCall: Promise<void> | undefined;

    act(() => {
      deferredToolCall = onToolCall({
        toolCall: {
          dynamic: false,
          input: {
            lessonId: 'lesson-1',
            projectId: 'project-1',
            prompt: 'Crea uno schema.',
          },
          toolCallId: 'parallel-artifact',
          toolName: 'generateLearningArtifact',
        },
      });
    });
    await act(async () => {
      await onToolCall({
        toolCall: {
          dynamic: false,
          input: { topic: 'pixel art' },
          toolCallId: 'course-assessment-1',
          toolName: 'startCourseAssessment',
        },
      });
    });

    expect(result.current.courseAssessmentRequest).toEqual({ topic: 'pixel art' });
    expect(stopMock).toHaveBeenCalledOnce();
    expect(addToolOutputMock).toHaveBeenCalledWith({
      tool: 'generateLearningArtifact',
      toolCallId: 'parallel-artifact',
      state: 'output-error',
      errorText: expect.stringMatching(/^(Cancelled|Annullato)$/),
    });
    expect(addToolOutputMock).toHaveBeenCalledWith({
      tool: 'startCourseAssessment',
      toolCallId: 'course-assessment-1',
      output: { handoffRequested: true, topic: 'pixel art' },
    });

    await act(async () => {
      resolveProjects([]);
      await deferredToolCall;
    });
    expect(addToolOutputMock).toHaveBeenCalledTimes(2);
  });

  test('reuses the source artifact identity across explicit regeneration attempts', async () => {
    const sourceArtifact = {
      summary: {
        id: 'project-1:lesson-1:generated-visual:visual-1',
        kind: 'generated-visual' as const,
        lessonId: 'lesson-1',
        lessonTitle: 'Titolo',
        previewMode: 'thumbnail' as const,
        projectId: 'project-1',
        projectTitle: 'Corso TypeScript',
        title: 'Mappa concettuale',
      },
      visual: {
        code: '<svg viewBox="0 0 680 120"></svg>',
        createdAt: '2026-08-01T10:00:00.000Z',
        id: 'visual-1',
        kind: 'svg' as const,
        title: 'Mappa concettuale',
      },
    };
    const replacementArtifact = {
      summary: {
        ...sourceArtifact.summary,
        id: 'project-1:lesson-1:generated-visual:visual-2',
        replacementOfArtifactId: sourceArtifact.summary.id,
      },
      visual: {
        ...sourceArtifact.visual,
        id: 'visual-2',
      },
    };
    generateLessonArtifactDraftMock
      .mockResolvedValueOnce({
        artifactId: sourceArtifact.summary.id,
        payload: sourceArtifact,
        visual: sourceArtifact.visual,
      })
      .mockResolvedValue({
        artifactId: replacementArtifact.summary.id,
        payload: replacementArtifact,
        visual: replacementArtifact.visual,
      });
    const snapshot = {
      id: 'project-1',
      learningPlan: {
        applicationExercisePlanningStatus: 'not-run',
        modules: [
          {
            children: [
              {
                content: 'Contenuto della lezione.',
                description: 'Descrizione',
                id: 'lesson-1',
                isCompleted: false,
                kind: 'lesson',
                title: 'Titolo',
                type: 'core',
              },
            ],
            id: 'module-1',
            title: 'Modulo',
          },
        ],
        summary: 'Sintesi',
        title: 'Corso TypeScript',
      },
    };
    const loadProjectsById = vi.fn(async () => [snapshot as never]);
    const { result } = renderHook(() =>
      useLibraryAssistantChat({
        folders: [folder],
        loadProjectsById,
        projects: [project],
        tree: loadedTree,
      })
    );
    const onToolCall = useChatMock.mock.calls[0]?.[0]?.onToolCall;

    await act(async () => {
      await onToolCall({
        toolCall: {
          dynamic: false,
          input: {
            lessonId: 'lesson-1',
            projectId: 'project-1',
            prompt: 'Crea una mappa concettuale.',
          },
          toolCallId: 'initial-artifact',
          toolName: 'generateLearningArtifact',
        },
      });
    });
    await act(async () => {
      await result.current.regenerateLearningArtifact({
        artifactId: sourceArtifact.summary.id,
        instructions: 'Rendila più leggibile.',
      });
    });
    await act(async () => {
      await result.current.regenerateLearningArtifact({
        artifactId: sourceArtifact.summary.id,
        instructions: 'Rendila più leggibile.',
      });
    });

    expect(
      generateLessonArtifactDraftMock.mock.calls.slice(1).map(([input]) => input.requestKey)
    ).toEqual([
      `library-replacement-${sourceArtifact.summary.id}`,
      `library-replacement-${sourceArtifact.summary.id}`,
    ]);
  });
});
