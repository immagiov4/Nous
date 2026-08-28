import { useChat } from '@ai-sdk/react';
import {
  DefaultChatTransport,
  lastAssistantMessageIsCompleteWithToolCalls,
  type UIMessage,
} from 'ai';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  ChatArtifactActionRequest,
  ChatArtifactRegenerateRequest,
  ChatArtifactReplaceRequest,
} from '../../components/shared/ChatArtifactRenderer.tsx';
import { translateUiMessage as t } from '../../i18n/uiMessages.ts';
import { fetchWithSupabaseAuth } from '../../services/auth/supabaseAuth.ts';
import {
  executeLibraryAssistantTool,
  LIBRARY_ASSISTANT_TOOL_NAMES,
  type LibraryAssistantToolName,
} from '../../services/library/toolExecutor.ts';
import { generateLessonArtifactDraft } from '../../services/openrouter/artifactDrafts.ts';
import { getBackendUrl } from '../../services/openrouter/config.ts';
import type {
  HomeChatToolPreferences,
  LearningArtifactRenderPayload,
  LibraryContextRef,
  LibraryFolder,
  LibraryScopeSummary,
  LibraryTree,
  ProjectSnapshot,
  SavedProjectMeta,
  SectionAnnotationArtifactRef,
  StoredLessonVisual,
} from '../../types.ts';
import { flattenLessons } from '../../utils/learning/pathNodes.ts';
import { buildLibraryScopeSummary } from '../../utils/library/assistant.ts';
import { hasOnlySuccessfulToolOutputs } from '../../utils/uiChat.ts';
import {
  getStoredLessonVisualKind,
  isStoredLessonVisualKind,
} from '../../utils/visuals/storedLessonVisual.ts';

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
  startCourseAssessment: {
    input: unknown;
    output: unknown;
  };
}

type LibraryAssistantMessage = UIMessage<unknown, Record<string, never>, LibraryAssistantTools>;
type LibraryAssistantToolPart = Extract<
  LibraryAssistantMessage['parts'][number],
  { toolCallId: string }
>;

interface UseLibraryAssistantChatArgs {
  folders: LibraryFolder[];
  loadProjectsById: (ids: string[]) => Promise<ProjectSnapshot[]>;
  projects: SavedProjectMeta[];
  saveLessonArtifactNote?: (input: {
    artifactRefs?: SectionAnnotationArtifactRef[];
    generatedVisuals?: StoredLessonVisual[];
    lessonId: string;
    note: string;
    projectId: string;
  }) => Promise<{ annotationId?: string; error?: string; saved: boolean }>;
  replaceLessonGeneratedVisual?: (input: {
    artifactId: string;
    lessonId: string;
    projectId: string;
    visual: StoredLessonVisual;
  }) => Promise<{ error?: string; replaced: boolean }>;
  tree: LibraryTree;
}

interface GenerateLearningArtifactInput {
  lessonId: string;
  mode?: 'new' | 'replacement-draft';
  projectId: string;
  prompt: string;
  requestedVisualKind?: 'html' | 'image' | 'mermaid' | 'svg';
  revisionInstructions?: string;
  sourceArtifactId?: string;
}

interface RequestSaveLearningArtifactNoteInput {
  artifactIds: string[];
  lessonId: string;
  noteDraft: string;
  projectId: string;
  rationale: string;
}

interface StartCourseAssessmentInput {
  topic: string;
}

interface LibraryAssistantRequestState {
  attachedContextRefs: LibraryContextRef[];
  scopeSummary: LibraryScopeSummary;
  toolPreferences: HomeChatToolPreferences;
}

interface LibraryAssistantResponseState {
  canContinue: boolean;
  generation: number;
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
        mode: candidate.mode === 'replacement-draft' ? 'replacement-draft' : 'new',
        projectId: candidate.projectId,
        prompt: candidate.prompt.trim(),
        requestedVisualKind: isStoredLessonVisualKind(candidate.requestedVisualKind)
          ? candidate.requestedVisualKind
          : undefined,
        revisionInstructions:
          typeof candidate.revisionInstructions === 'string'
            ? candidate.revisionInstructions.trim()
            : undefined,
        sourceArtifactId:
          typeof candidate.sourceArtifactId === 'string' ? candidate.sourceArtifactId : undefined,
      }
    : null;
};

const readStartCourseAssessmentInput = (value: unknown): StartCourseAssessmentInput | null => {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const topic = (value as Partial<StartCourseAssessmentInput>).topic;
  return typeof topic === 'string' && topic.trim() ? { topic: topic.trim() } : null;
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
const libraryAssistantRequestStateStore = new Map<symbol, LibraryAssistantRequestState>();
const libraryAssistantResponseStateStore = new Map<symbol, LibraryAssistantResponseState>();
const libraryAssistantActiveToolCallStore = new Map<symbol, Map<string, string>>();
const LIBRARY_REPLACEMENT_DRAFT_PREFIX = 'library-replacement-draft';

const shouldContinueLibraryResponse = (
  requestStateKey: symbol,
  responseGeneration?: number
): boolean => {
  const responseState = libraryAssistantResponseStateStore.get(requestStateKey);
  return (
    responseState?.canContinue === true &&
    (responseGeneration === undefined || responseState.generation === responseGeneration)
  );
};

const isPendingLibraryToolPart = (
  part: LibraryAssistantMessage['parts'][number]
): part is LibraryAssistantToolPart =>
  'toolCallId' in part && (part.state === 'input-streaming' || part.state === 'input-available');

const getLibraryToolPartName = (part: LibraryAssistantToolPart): string =>
  'toolName' in part && typeof part.toolName === 'string'
    ? part.toolName
    : part.type.slice('tool-'.length);

const terminalizePendingLibraryToolCalls = ({
  completedToolCallId,
  messages = [],
  requestStateKey,
  writeCancelledOutput,
}: {
  completedToolCallId?: string;
  messages?: LibraryAssistantMessage[];
  requestStateKey: symbol;
  writeCancelledOutput: (toolCallId: string, tool: string) => void;
}): void => {
  const activeToolCalls = libraryAssistantActiveToolCallStore.get(requestStateKey);
  const pendingToolCalls = new Map(activeToolCalls);
  const latestUserMessageIndex = messages.map(message => message.role).lastIndexOf('user');
  const activeResponseMessage = [...messages.slice(latestUserMessageIndex + 1)]
    .reverse()
    .find(message => message.role === 'assistant');
  for (const part of activeResponseMessage?.parts.filter(isPendingLibraryToolPart) ?? []) {
    pendingToolCalls.set(part.toolCallId, getLibraryToolPartName(part));
  }
  activeToolCalls?.clear();
  for (const [toolCallId, tool] of pendingToolCalls) {
    if (toolCallId !== completedToolCallId) writeCancelledOutput(toolCallId, tool);
  }
};

export const useLibraryAssistantChat = ({
  folders,
  loadProjectsById,
  projects,
  replaceLessonGeneratedVisual,
  saveLessonArtifactNote,
  tree,
}: UseLibraryAssistantChatArgs) => {
  const [selectedContextRefs, setSelectedContextRefs] = useState<LibraryContextRef[]>([]);
  const [artifactPayloadsByToolCallId, setArtifactPayloadsByToolCallId] = useState<
    Record<string, LearningArtifactRenderPayload[]>
  >({});
  const [generatedVisualsByArtifactId, setGeneratedVisualsByArtifactId] = useState<
    Record<string, StoredLessonVisual>
  >({});
  const [webSearch, setWebSearch] = useState(false);
  const [generateArtifacts, setGenerateArtifacts] = useState(false);
  const [courseAssessmentRequest, setCourseAssessmentRequest] =
    useState<StartCourseAssessmentInput | null>(null);
  const consumeCourseAssessmentRequest = useCallback(() => setCourseAssessmentRequest(null), []);
  const attachedContextRefs = useMemo(
    () =>
      selectedContextRefs
        .filter(reference =>
          reference.kind === 'folder'
            ? folders.some(folder => folder.id === reference.id)
            : projects.some(project => project.id === reference.id)
        )
        .map(reference => ({
          ...reference,
          label: resolveContextRefLabel({ folders, projects, reference }),
        })),
    [folders, projects, selectedContextRefs]
  );

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
      generateArtifacts,
      mode: 'library-query',
      newCourse: false,
      webSearch,
    }),
    [attachedContextRefs, generateArtifacts, webSearch]
  );

  const requestStateKey = useMemo(() => Symbol('library-assistant-request-state'), []);

  useEffect(() => {
    libraryAssistantResponseStateStore.set(requestStateKey, {
      canContinue: true,
      generation: 0,
    });
    libraryAssistantActiveToolCallStore.set(requestStateKey, new Map());
    return () => {
      libraryAssistantResponseStateStore.delete(requestStateKey);
      libraryAssistantActiveToolCallStore.delete(requestStateKey);
    };
  }, [requestStateKey]);

  useEffect(() => {
    libraryAssistantRequestStateStore.set(requestStateKey, {
      attachedContextRefs,
      scopeSummary,
      toolPreferences,
    });

    return () => {
      libraryAssistantRequestStateStore.delete(requestStateKey);
    };
  }, [attachedContextRefs, requestStateKey, scopeSummary, toolPreferences]);

  const transport = useMemo(
    () =>
      new DefaultChatTransport<LibraryAssistantMessage>({
        api: `${getBackendUrl()}/api/chat/library`,
        fetch: fetchWithSupabaseAuth,
        // `useChat` keeps the initial transport instance, so request data must come from a ref.
        prepareSendMessagesRequest: ({ headers, id, messages }) => {
          const requestState = libraryAssistantRequestStateStore.get(requestStateKey);
          if (!requestState) {
            throw new Error('Library assistant request state is not initialized.');
          }

          const {
            attachedContextRefs: currentAttachedContextRefs,
            scopeSummary: currentScopeSummary,
            toolPreferences: currentToolPreferences,
          } = requestState;

          return {
            headers,
            body: {
              attachedContextRefs: currentAttachedContextRefs,
              id,
              messages,
              resolvedScopeSummary: currentScopeSummary,
              toolPreferences: currentToolPreferences,
            },
          };
        },
      }),
    [requestStateKey]
  );

  const { addToolOutput, error, messages, sendMessage, setMessages, status, stop } =
    useChat<LibraryAssistantMessage>({
      id: 'home-library-assistant',
      messages: [],
      transport,
      experimental_throttle: 96,
      sendAutomaticallyWhen: options =>
        shouldContinueLibraryResponse(requestStateKey) &&
        !hasOnlySuccessfulToolOutputs(options.messages, 'tool-generateLearningArtifact') &&
        lastAssistantMessageIsCompleteWithToolCalls(options),
      onToolCall: async ({ toolCall }) => {
        if (toolCall.dynamic) {
          return;
        }

        const responseGeneration =
          libraryAssistantResponseStateStore.get(requestStateKey)?.generation;
        if (responseGeneration === undefined) return;

        if (!shouldContinueLibraryResponse(requestStateKey, responseGeneration)) {
          void addToolOutput({
            tool: toolCall.toolName,
            toolCallId: toolCall.toolCallId,
            state: 'output-error',
            errorText: t('Annullato'),
          });
          return;
        }

        const awaitTrackedToolCall = async <Result>(request: () => Promise<Result>) => {
          const activeToolCalls = libraryAssistantActiveToolCallStore.get(requestStateKey);
          activeToolCalls?.set(toolCall.toolCallId, toolCall.toolName);
          try {
            return await request();
          } finally {
            activeToolCalls?.delete(toolCall.toolCallId);
          }
        };

        if (toolCall.toolName === 'generateLearningArtifact') {
          const input = readGenerateLearningArtifactInput(toolCall.input);
          if (!input) {
            void addToolOutput({
              tool: 'generateLearningArtifact',
              toolCallId: toolCall.toolCallId,
              output: { artifact: null, error: t('Target lezione o richiesta non validi.') },
            });
            return;
          }

          const [snapshot] = await awaitTrackedToolCall(() => loadProjectsById([input.projectId]));
          if (!shouldContinueLibraryResponse(requestStateKey, responseGeneration)) return;
          const lesson = flattenLessons(snapshot?.learningPlan?.modules).find(
            section => section.id === input.lessonId
          );
          if (!snapshot?.learningPlan || !lesson) {
            void addToolOutput({
              tool: 'generateLearningArtifact',
              toolCallId: toolCall.toolCallId,
              output: { artifact: null, error: t('Non ho trovato la lezione target.') },
            });
            return;
          }
          const learningPlan = snapshot.learningPlan;

          const sourceArtifact = input.sourceArtifactId
            ? Object.values(artifactPayloadsByToolCallId)
                .flat()
                .find(
                  payload =>
                    payload.summary.id === input.sourceArtifactId &&
                    payload.summary.kind === 'generated-visual' &&
                    'visual' in payload
                )
            : undefined;
          if (input.mode === 'replacement-draft' && !sourceArtifact) {
            void addToolOutput({
              tool: 'generateLearningArtifact',
              toolCallId: toolCall.toolCallId,
              output: {
                artifact: null,
                error: t(
                  'Non ho trovato un artefatto generato modificabile da usare come sorgente.'
                ),
              },
            });
            return;
          }

          const draft = await awaitTrackedToolCall(() =>
            generateLessonArtifactDraft({
              lesson,
              mode: input.mode,
              projectId: snapshot.id,
              projectTitle: learningPlan.title,
              prompt: input.prompt,
              requestedVisualKind: input.requestedVisualKind,
              requestKey: toolCall.toolCallId,
              revisionInstructions: input.revisionInstructions,
              sourceArtifact,
              sourceArtifactId: input.sourceArtifactId,
            })
          );
          if (!shouldContinueLibraryResponse(requestStateKey, responseGeneration)) return;
          if (!draft) {
            void addToolOutput({
              tool: 'generateLearningArtifact',
              toolCallId: toolCall.toolCallId,
              output: {
                artifact: null,
                error: t('Non sono riuscito a generare un artefatto visuale utile.'),
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

        if (toolCall.toolName === 'startCourseAssessment') {
          const input = readStartCourseAssessmentInput(toolCall.input);
          if (!input) {
            void addToolOutput({
              tool: 'startCourseAssessment',
              toolCallId: toolCall.toolCallId,
              output: {
                handoffRequested: false,
                error: t('Argomento del nuovo corso non valido.'),
              },
            });
            return;
          }

          const responseState = libraryAssistantResponseStateStore.get(requestStateKey);
          if (responseState) responseState.canContinue = false;
          setCourseAssessmentRequest(input);
          void addToolOutput({
            tool: 'startCourseAssessment',
            toolCallId: toolCall.toolCallId,
            output: { handoffRequested: true, topic: input.topic },
          });
          stop();
          terminalizePendingLibraryToolCalls({
            completedToolCallId: toolCall.toolCallId,
            messages,
            requestStateKey,
            writeCancelledOutput: (toolCallId, tool) => {
              void addToolOutput({
                tool,
                toolCallId,
                state: 'output-error',
                errorText: t('Annullato'),
              });
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

        const result = await awaitTrackedToolCall(() =>
          executeLibraryAssistantTool({
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
          })
        );
        if (!shouldContinueLibraryResponse(requestStateKey, responseGeneration)) return;

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

  const artifactPayloadsById = useMemo(() => {
    const payloads = Object.values(artifactPayloadsByToolCallId).flat();
    return new Map(payloads.map(payload => [payload.summary.id, payload]));
  }, [artifactPayloadsByToolCallId]);

  const replacementDraftPayloads = useMemo(
    () =>
      Object.entries(artifactPayloadsByToolCallId).flatMap(([toolCallId, payloads]) =>
        toolCallId.startsWith(LIBRARY_REPLACEMENT_DRAFT_PREFIX) ? payloads : []
      ),
    [artifactPayloadsByToolCallId]
  );

  const sendLibraryMessage = useCallback(
    (text: string) => {
      const responseState = libraryAssistantResponseStateStore.get(requestStateKey);
      if (responseState) {
        responseState.canContinue = true;
        responseState.generation += 1;
      }
      return sendMessage({ text });
    },
    [requestStateKey, sendMessage]
  );
  const stopLibraryMessage = useCallback(() => {
    const responseState = libraryAssistantResponseStateStore.get(requestStateKey);
    if (responseState) responseState.canContinue = false;
    stop();
    terminalizePendingLibraryToolCalls({
      messages,
      requestStateKey,
      writeCancelledOutput: (toolCallId, tool) => {
        void addToolOutput({
          tool,
          toolCallId,
          state: 'output-error',
          errorText: t('Annullato'),
        });
      },
    });
    return undefined;
  }, [addToolOutput, messages, requestStateKey, stop]);
  const libraryMessageSender = useMemo(
    () => Object.assign(sendLibraryMessage, { stop: stopLibraryMessage }),
    [sendLibraryMessage, stopLibraryMessage]
  );

  const discardLearningArtifact = ({ artifactId }: ChatArtifactActionRequest) => {
    setArtifactPayloadsByToolCallId(currentPayloads => {
      const next = { ...currentPayloads };
      for (const [key, payloads] of Object.entries(next)) {
        next[key] = payloads.filter(payload => payload.summary.id !== artifactId);
        if (next[key].length === 0) {
          delete next[key];
        }
      }
      return next;
    });
    setGeneratedVisualsByArtifactId(currentVisuals => {
      const next = { ...currentVisuals };
      delete next[artifactId];
      return next;
    });
  };

  const regenerateLearningArtifact = async ({
    artifactId,
    instructions,
  }: ChatArtifactRegenerateRequest) => {
    const payload = artifactPayloadsById.get(artifactId);
    if (!payload || !('visual' in payload)) {
      return false;
    }

    const [snapshot] = await loadProjectsById([payload.summary.projectId]);
    const lesson = flattenLessons(snapshot?.learningPlan?.modules).find(
      section => section.id === payload.summary.lessonId
    );
    if (!snapshot?.learningPlan || !lesson) {
      return false;
    }

    const draft = await generateLessonArtifactDraft({
      lesson,
      mode: 'replacement-draft',
      projectId: snapshot.id,
      projectTitle: snapshot.learningPlan.title,
      prompt: t('Modifica l artefatto "{artifactTitle}".', {
        artifactTitle: payload.summary.title,
      }),
      requestKey: `library-replacement-${artifactId}`,
      requestedVisualKind: getStoredLessonVisualKind(payload.visual),
      revisionInstructions: instructions,
      sourceArtifact: payload,
      sourceArtifactId: artifactId,
    });
    if (!draft) {
      return false;
    }

    setGeneratedVisualsByArtifactId(currentVisuals => ({
      ...currentVisuals,
      [draft.artifactId]: draft.visual,
    }));
    setArtifactPayloadsByToolCallId(currentPayloads => ({
      ...currentPayloads,
      [`${LIBRARY_REPLACEMENT_DRAFT_PREFIX}-${artifactId}-${Date.now()}`]: [draft.payload],
    }));
    return true;
  };

  const replaceLearningArtifact = async ({
    artifactId,
    replacementOfArtifactId,
  }: ChatArtifactReplaceRequest) => {
    const payload = artifactPayloadsById.get(artifactId);
    const visual = generatedVisualsByArtifactId[artifactId];
    if (!payload || !('visual' in payload) || !visual || !replaceLessonGeneratedVisual) {
      return;
    }

    const result = await replaceLessonGeneratedVisual({
      artifactId: replacementOfArtifactId,
      lessonId: payload.summary.lessonId,
      projectId: payload.summary.projectId,
      visual,
    });
    if (result.replaced) {
      discardLearningArtifact({ artifactId });
    }
  };

  return {
    attachedContextRefs,
    artifactPayloadsByToolCallId,
    courseAssessmentRequest,
    replacementDraftPayloads,
    error,
    isLoading: status === 'submitted' || status === 'streaming',
    messages,
    clearLibraryMessages: () => {
      setArtifactPayloadsByToolCallId({});
      setGeneratedVisualsByArtifactId({});
      setMessages([]);
    },
    consumeCourseAssessmentRequest,
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
            error: t('Il salvataggio delle note non e disponibile in questo contesto.'),
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
    discardLearningArtifact,
    regenerateLearningArtifact,
    replaceLearningArtifact,
    removeAttachedContextRef: (reference: LibraryContextRef) => {
      setSelectedContextRefs(currentRefs =>
        currentRefs.filter(
          currentReference =>
            !(currentReference.id === reference.id && currentReference.kind === reference.kind)
        )
      );
    },
    scopeSummary,
    sendLibraryMessage: libraryMessageSender,
    setWebSearch,
    status,
    toggleAttachedContextRef: (reference: LibraryContextRef) => {
      setSelectedContextRefs(currentRefs => {
        const existingRef = currentRefs.find(
          currentReference =>
            currentReference.id === reference.id && currentReference.kind === reference.kind
        );

        if (reference.kind === 'folder') {
          const descendantProjectIds = new Set(
            tree.descendantProjectIdsByFolderId[reference.id] || []
          );
          const refsOutsideFolder = currentRefs.filter(currentReference => {
            if (currentReference.kind === 'project') {
              return !descendantProjectIds.has(currentReference.id);
            }

            if (currentReference.id === reference.id) {
              return false;
            }

            const nestedProjectIds = tree.descendantProjectIdsByFolderId[currentReference.id] || [];
            return (
              nestedProjectIds.length === 0 ||
              !nestedProjectIds.every(projectId => descendantProjectIds.has(projectId))
            );
          });

          return existingRef
            ? refsOutsideFolder
            : [
                ...refsOutsideFolder,
                {
                  ...reference,
                  label: resolveContextRefLabel({ folders, projects, reference }),
                },
              ];
        }

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
