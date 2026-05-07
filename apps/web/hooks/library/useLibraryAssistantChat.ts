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
import { generateLessonArtifactDraft } from '../../services/openrouter/artifactDrafts.ts';
import { getBackendUrl } from '../../services/openrouter/config.ts';
import type { ProjectRepositoryMode } from '../../services/projects/projectRepositoryFactory.ts';
import type {
  HomeChatToolPreferences,
  LearningArtifactRenderPayload,
  LessonGeneratedVisual,
  LibraryContextRef,
  LibraryFolder,
  LibraryScopeSummary,
  LibraryTree,
  ProjectSnapshot,
  SavedProjectMeta,
  SectionAnnotationArtifactRef,
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
  getLearningArtifacts: {
    input: unknown;
    output: unknown;
  };
  generateLearningArtifact: {
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
  requestSaveLearningArtifactNote: {
    input: unknown;
    output: unknown;
  };
}

type LibraryAssistantMessage = UIMessage<unknown, Record<string, never>, LibraryAssistantTools>;

interface UseLibraryAssistantChatArgs {
  folders: LibraryFolder[];
  loadProjectsById: (ids: string[]) => Promise<ProjectSnapshot[]>;
  preferredContextModel: string;
  projectRepositoryMode: ProjectRepositoryMode;
  projects: SavedProjectMeta[];
  saveLessonArtifactNote?: (input: {
    artifactRefs?: SectionAnnotationArtifactRef[];
    generatedVisuals?: LessonGeneratedVisual[];
    lessonId: string;
    note: string;
    projectId: string;
  }) => Promise<{ annotationId?: string; error?: string; saved: boolean }>;
  tree: LibraryTree;
}

interface GenerateLearningArtifactInput {
  lessonId: string;
  projectId: string;
  prompt: string;
}

interface RequestSaveLearningArtifactNoteInput {
  artifactIds: string[];
  lessonId: string;
  noteDraft: string;
  projectId: string;
  rationale: string;
}

const readGenerateLearningArtifactInput = (
  value: unknown
): GenerateLearningArtifactInput | null => {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const candidate = value as Partial<GenerateLearningArtifactInput>;
  return typeof candidate.projectId === 'string' &&
    typeof candidate.lessonId === 'string' &&
    typeof candidate.prompt === 'string' &&
    candidate.prompt.trim()
    ? {
        lessonId: candidate.lessonId,
        projectId: candidate.projectId,
        prompt: candidate.prompt.trim(),
      }
    : null;
};

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
  projectRepositoryMode,
  projects,
  saveLessonArtifactNote,
  tree,
}: UseLibraryAssistantChatArgs) => {
  const [attachedContextRefs, setAttachedContextRefs] = useState<LibraryContextRef[]>([]);
  const [artifactPayloadsByToolCallId, setArtifactPayloadsByToolCallId] = useState<
    Record<string, LearningArtifactRenderPayload[]>
  >({});
  const [generatedVisualsByArtifactId, setGeneratedVisualsByArtifactId] = useState<
    Record<string, LessonGeneratedVisual>
  >({});
  const [webSearch, setWebSearch] = useState(false);
  const [generateArtifacts, setGenerateArtifacts] = useState(false);

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
        projectRepositoryMode,
        projects,
        tree,
      }),
    [attachedContextRefs, folders, projectRepositoryMode, projects, tree]
  );

  const toolPreferences = useMemo<HomeChatToolPreferences>(
    () => ({
      attachedContextRefs,
      generateArtifacts,
      mode: 'library-query',
      newCourse: false,
      webSearch,
    }),
    [attachedContextRefs, generateArtifacts, webSearch]
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

  const { addToolOutput, error, messages, sendMessage, setMessages, status } =
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

        if (toolCall.toolName === 'generateLearningArtifact') {
          const input = readGenerateLearningArtifactInput(toolCall.input);
          if (!input) {
            void addToolOutput({
              tool: 'generateLearningArtifact',
              toolCallId: toolCall.toolCallId,
              output: { artifact: null, error: 'Target lezione o richiesta non validi.' },
            });
            return;
          }

          const [snapshot] = await loadProjectsById([input.projectId]);
          const lesson = snapshot?.learningPlan?.sections.find(
            section => section.id === input.lessonId
          );
          if (!snapshot?.learningPlan || !lesson) {
            void addToolOutput({
              tool: 'generateLearningArtifact',
              toolCallId: toolCall.toolCallId,
              output: { artifact: null, error: 'Non ho trovato la lezione target.' },
            });
            return;
          }

          const draft = await generateLessonArtifactDraft({
            lesson,
            projectId: snapshot.id,
            projectTitle: snapshot.learningPlan.title,
            prompt: input.prompt,
          });
          if (!draft) {
            void addToolOutput({
              tool: 'generateLearningArtifact',
              toolCallId: toolCall.toolCallId,
              output: {
                artifact: null,
                error: 'Non sono riuscito a generare un artefatto visuale utile.',
              },
            });
            return;
          }

          setGeneratedVisualsByArtifactId(currentVisuals => ({
            ...currentVisuals,
            [draft.artifactId]: draft.visual,
          }));
          setArtifactPayloadsByToolCallId(currentPayloads => ({
            ...currentPayloads,
            [toolCall.toolCallId]: [draft.payload],
          }));
          void addToolOutput({
            tool: 'generateLearningArtifact',
            toolCallId: toolCall.toolCallId,
            output: {
              artifact: draft.payload.summary,
              artifactId: draft.artifactId,
              renderedArtifactCount: 1,
            },
          });
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
            projectRepositoryMode,
            projects,
            scopeSummary,
            tree,
          },
          input: toolCall.input,
          toolName,
        });

        if (toolName === 'getLearningArtifacts') {
          setArtifactPayloadsByToolCallId(currentPayloads => ({
            ...currentPayloads,
            [toolCall.toolCallId]: result.renderPayloads ?? [],
          }));
        }

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
    artifactPayloadsByToolCallId,
    error,
    isLoading: status === 'submitted' || status === 'streaming',
    messages,
    clearLibraryMessages: () => {
      setArtifactPayloadsByToolCallId({});
      setGeneratedVisualsByArtifactId({});
      setMessages([]);
    },
    approveLearningArtifactNoteSave: async (
      toolCallId: string,
      input: RequestSaveLearningArtifactNoteInput
    ) => {
      const allPayloads = Object.values(artifactPayloadsByToolCallId).flat();
      const payloadById = new Map(allPayloads.map(payload => [payload.summary.id, payload]));
      const artifactRefs = input.artifactIds.flatMap(artifactId => {
        const payload = payloadById.get(artifactId);
        return payload
          ? [
              {
                artifactId,
                kind: payload.summary.kind,
                title: payload.summary.title,
              },
            ]
          : [];
      });
      const generatedVisuals = input.artifactIds.flatMap(artifactId => {
        const visual = generatedVisualsByArtifactId[artifactId];
        return visual ? [visual] : [];
      });
      const result = saveLessonArtifactNote
        ? await saveLessonArtifactNote({
            artifactRefs,
            generatedVisuals,
            lessonId: input.lessonId,
            note: input.noteDraft,
            projectId: input.projectId,
          })
        : {
            error: 'Il salvataggio delle note non e disponibile in questo contesto.',
            saved: false,
          };
      void addToolOutput({
        tool: 'requestSaveLearningArtifactNote',
        toolCallId,
        output: {
          approved: true,
          annotationId: result.annotationId,
          error: result.error,
          saved: result.saved,
        },
      });
    },
    rejectLearningArtifactNoteSave: (toolCallId: string) => {
      void addToolOutput({
        tool: 'requestSaveLearningArtifactNote',
        toolCallId,
        output: { approved: false, saved: false },
      });
    },
    removeAttachedContextRef: (reference: LibraryContextRef) => {
      setAttachedContextRefs(currentRefs =>
        currentRefs.filter(
          currentReference =>
            !(currentReference.id === reference.id && currentReference.kind === reference.kind)
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
            currentReference.id === reference.id && currentReference.kind === reference.kind
        );

        if (existingRef) {
          return currentRefs.filter(
            currentReference =>
              !(currentReference.id === reference.id && currentReference.kind === reference.kind)
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
    generateArtifacts,
    setGenerateArtifacts,
  };
};
