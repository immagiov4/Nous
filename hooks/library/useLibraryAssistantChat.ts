import { useChat } from '@ai-sdk/react';
import {
  DefaultChatTransport,
  lastAssistantMessageIsCompleteWithToolCalls,
  type UIMessage,
} from 'ai';
import { useEffect, useMemo, useRef, useState } from 'react';

import {
  executeLibraryAssistantTool,
  LIBRARY_ASSISTANT_TOOL_NAMES,
  type LibraryAssistantToolName,
} from '../../services/library/toolExecutor.ts';
import { getBackendUrl } from '../../services/openrouter/config.ts';
import type {
  HomeChatToolPreferences,
  LibraryContextRef,
  LibraryFolder,
  LibraryScopeSummary,
  LibraryTree,
  ProjectSnapshot,
  SavedProjectMeta,
} from '../../types.ts';
import { buildLibraryScopeSummary } from '../../utils/library/assistant.ts';

interface LibraryAssistantTools {
  [key: string]: {
    input: unknown;
    output: unknown | undefined;
  };
  getLessonDetails: {
    input: unknown;
    output: unknown;
  };
  getProjectOverviews: {
    input: unknown;
    output: unknown;
  };
  getProjectStructures: {
    input: unknown;
    output: unknown;
  };
  listLibraryTree: {
    input: unknown;
    output: unknown;
  };
  searchLibrary: {
    input: unknown;
    output: unknown;
  };
  searchWeb: {
    input: unknown;
    output: unknown;
  };
}

type LibraryAssistantMessage = UIMessage<unknown, Record<string, never>, LibraryAssistantTools>;

interface UseLibraryAssistantChatArgs {
  folders: LibraryFolder[];
  loadProjectsById: (ids: string[]) => Promise<ProjectSnapshot[]>;
  preferredContextModel: string;
  projects: SavedProjectMeta[];
  tree: LibraryTree;
}

const resolveContextRefLabel = ({
  folders,
  projects,
  reference,
}: {
  folders: LibraryFolder[];
  projects: SavedProjectMeta[];
  reference: Pick<LibraryContextRef, 'id' | 'kind' | 'label'>;
}) => {
  if (reference.kind === 'folder') {
    return folders.find(folder => folder.id === reference.id)?.name || reference.label;
  }

  return projects.find(project => project.id === reference.id)?.title || reference.label;
};

export const useLibraryAssistantChat = ({
  folders,
  loadProjectsById,
  preferredContextModel,
  projects,
  tree,
}: UseLibraryAssistantChatArgs) => {
  const [attachedContextRefs, setAttachedContextRefs] = useState<LibraryContextRef[]>([]);
  const [webSearch, setWebSearch] = useState(false);

  useEffect(() => {
    setAttachedContextRefs(currentRefs =>
      currentRefs
        .filter(reference =>
          reference.kind === 'folder'
            ? folders.some(folder => folder.id === reference.id)
            : projects.some(project => project.id === reference.id)
        )
        .map(reference => ({
          ...reference,
          label: resolveContextRefLabel({ folders, projects, reference }),
        }))
    );
  }, [folders, projects]);

  const scopeSummary = useMemo<LibraryScopeSummary>(
    () =>
      buildLibraryScopeSummary({
        attachedContextRefs,
        folders,
        projects,
        tree,
      }),
    [attachedContextRefs, folders, projects, tree]
  );

  const toolPreferences = useMemo<HomeChatToolPreferences>(
    () => ({
      attachedContextRefs,
      mode: 'library-query',
      newCourse: false,
      webSearch,
    }),
    [attachedContextRefs, webSearch]
  );

  const latestRequestStateRef = useRef({
    attachedContextRefs,
    preferredContextModel,
    scopeSummary,
    toolPreferences,
  });

  latestRequestStateRef.current = {
    attachedContextRefs,
    preferredContextModel,
    scopeSummary,
    toolPreferences,
  };

  const transport = useMemo(
    () =>
      new DefaultChatTransport<LibraryAssistantMessage>({
        api: `${getBackendUrl()}/api/chat/library`,
        // `useChat` keeps the initial transport instance, so request data must come from a ref.
        prepareSendMessagesRequest: ({ id, messages }) => {
          const {
            attachedContextRefs: currentAttachedContextRefs,
            preferredContextModel: currentPreferredContextModel,
            scopeSummary: currentScopeSummary,
            toolPreferences: currentToolPreferences,
          } = latestRequestStateRef.current;

          return {
            body: {
              attachedContextRefs: currentAttachedContextRefs,
              id,
              messages,
              modelOverride: currentPreferredContextModel.trim() || undefined,
              resolvedScopeSummary: currentScopeSummary,
              toolPreferences: currentToolPreferences,
            },
          };
        },
      }),
    []
  );

  const { addToolOutput, error, messages, sendMessage, status } =
    useChat<LibraryAssistantMessage>({
      id: 'home-library-assistant',
      messages: [],
      transport,
      experimental_throttle: 96,
      sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithToolCalls,
      onToolCall: async ({ toolCall }) => {
        if (toolCall.dynamic) {
          return;
        }

        const toolName = toolCall.toolName as LibraryAssistantToolName;
        if (
          !LIBRARY_ASSISTANT_TOOL_NAMES.includes(
            toolName as (typeof LIBRARY_ASSISTANT_TOOL_NAMES)[number]
          )
        ) {
          return;
        }

        const result = await executeLibraryAssistantTool({
          dataSource: {
            attachedContextRefs,
            folders,
            loadProjectsById,
            projects,
            scopeSummary,
            tree,
          },
          input: toolCall.input,
          toolName,
        });

        if (result.outputError) {
          void addToolOutput({
            tool: toolName,
            toolCallId: toolCall.toolCallId,
            state: 'output-error',
            errorText: result.outputError,
          });
          return;
        }

        void addToolOutput({
          tool: toolName,
          toolCallId: toolCall.toolCallId,
          output: result.output || {},
        });
      },
    });

  return {
    attachedContextRefs,
    error,
    isLoading: status === 'submitted' || status === 'streaming',
    messages,
    removeAttachedContextRef: (reference: LibraryContextRef) => {
      setAttachedContextRefs(currentRefs =>
        currentRefs.filter(
          currentReference =>
            !(
              currentReference.id === reference.id &&
              currentReference.kind === reference.kind
            )
        )
      );
    },
    scopeSummary,
    sendLibraryMessage: (text: string) => sendMessage({ text }),
    setWebSearch,
    status,
    toggleAttachedContextRef: (reference: LibraryContextRef) => {
      setAttachedContextRefs(currentRefs => {
        const existingRef = currentRefs.find(
          currentReference =>
            currentReference.id === reference.id &&
            currentReference.kind === reference.kind
        );

        if (existingRef) {
          return currentRefs.filter(
            currentReference =>
              !(
                currentReference.id === reference.id &&
                currentReference.kind === reference.kind
              )
          );
        }

        return [
          ...currentRefs,
          {
            ...reference,
            label: resolveContextRefLabel({ folders, projects, reference }),
          },
        ];
      });
    },
    toolPreferences,
    webSearch,
  };
};
