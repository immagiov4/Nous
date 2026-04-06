// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import type { UIMessage } from 'ai';

const useChatMock = vi.fn();

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
  lastAssistantMessageIsCompleteWithToolCalls: () => false,
}));

vi.mock('../../../services/openrouter/config.ts', () => ({
  getBackendUrl: () => 'http://localhost:3001',
}));

const { useLibraryAssistantChat } = await import('../../../hooks/library/useLibraryAssistantChat.ts');

describe('useLibraryAssistantChat', () => {
  beforeEach(() => {
    useChatMock.mockReset();
    useChatMock.mockReturnValue({
      addToolOutput: vi.fn(),
      error: undefined,
      messages: [],
      sendMessage: vi.fn(),
      status: 'ready',
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
    hasSourceFile: true,
    coverLabel: 'PDF',
    syncState: 'local-only' as const,
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

  test('sends the latest web-search preference through the initial transport instance', async () => {
    const stableFolders = [folder];
    const stableProjects = [project];
    const loadProjectsById = vi.fn(async () => []);

    const { result } = renderHook(() =>
      useLibraryAssistantChat({
        folders: stableFolders,
        loadProjectsById,
        preferredContextModel: 'openai/gpt-5.4-mini',
        projects: stableProjects,
        tree: loadedTree,
      })
    );

    const initialTransport = useChatMock.mock.calls[0]?.[0]?.transport as MockDefaultChatTransport<UIMessage>;
    expect(initialTransport).toBeDefined();

    await act(async () => {
      result.current.setWebSearch(true);
    });

    expect(useChatMock.mock.calls.at(-1)?.[0]?.transport).toBe(initialTransport);

    const preparedRequest = await initialTransport.prepareSendMessagesRequest?.({
      api: 'http://localhost:3001/api/chat/library',
      body: {},
      credentials: undefined,
      headers: {},
      id: 'chat-1',
      messageId: undefined,
      messages: [],
      requestMetadata: undefined,
      trigger: 'submit-message',
    });

    expect(preparedRequest).toMatchObject({
      body: {
        modelOverride: 'openai/gpt-5.4-mini',
        toolPreferences: expect.objectContaining({
          webSearch: true,
        }),
      },
    });
  });

  test('uses the latest whole-library scope after library hydration on the initial transport instance', async () => {
    const loadProjectsById = vi.fn(async () => []);

    const { rerender } = renderHook(
      ({ folders, projects, tree }) =>
        useLibraryAssistantChat({
          folders,
          loadProjectsById,
          preferredContextModel: 'openai/gpt-5.4-mini',
          projects,
          tree,
        }),
      {
        initialProps: {
          folders: [] as typeof folder[],
          projects: [] as typeof project[],
          tree: emptyTree,
        },
      }
    );

    const initialTransport = useChatMock.mock.calls[0]?.[0]?.transport as MockDefaultChatTransport<UIMessage>;
    expect(initialTransport).toBeDefined();

    rerender({
      folders: [folder],
      projects: [project],
      tree: loadedTree,
    });

    const preparedRequest = await initialTransport.prepareSendMessagesRequest?.({
      api: 'http://localhost:3001/api/chat/library',
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
          scopeSummary: 'Intera libreria locale (1 corsi disponibili).',
        }),
      },
    });
  });

  test('uses the latest preferred context model after rerender on the initial transport instance', async () => {
    const loadProjectsById = vi.fn(async () => []);
    const stableFolders = [folder];
    const stableProjects = [project];

    const { rerender } = renderHook(
      ({ preferredContextModel }) =>
        useLibraryAssistantChat({
          folders: stableFolders,
          loadProjectsById,
          preferredContextModel,
          projects: stableProjects,
          tree: loadedTree,
        }),
      {
        initialProps: {
          preferredContextModel: '',
        },
      }
    );

    const initialTransport = useChatMock.mock.calls[0]?.[0]?.transport as MockDefaultChatTransport<UIMessage>;
    expect(initialTransport).toBeDefined();

    rerender({ preferredContextModel: 'openai/gpt-5.4-nano' });

    expect(useChatMock.mock.calls.at(-1)?.[0]?.transport).toBe(initialTransport);

    const preparedRequest = await initialTransport.prepareSendMessagesRequest?.({
      api: 'http://localhost:3001/api/chat/library',
      body: {},
      credentials: undefined,
      headers: {},
      id: 'chat-3',
      messageId: undefined,
      messages: [],
      requestMetadata: undefined,
      trigger: 'submit-message',
    });

    expect(preparedRequest).toMatchObject({
      body: {
        modelOverride: 'openai/gpt-5.4-nano',
      },
    });
  });
});
