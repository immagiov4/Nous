import { useChat } from '@ai-sdk/react';
import type { ContextSourceReference } from '@shared/lessonSourceContext';
import { sanitizeContextSourceDisplayName } from '@shared/lessonSourceContext';
import {
  DefaultChatTransport,
  isTextUIPart,
  isToolUIPart,
  lastAssistantMessageIsCompleteWithToolCalls,
  type UIMessage,
} from 'ai';
import { motion } from 'framer-motion';
import {
  Check,
  Globe,
  LoaderCircle,
  NotebookPen,
  Plus,
  Sparkles,
  Square,
  StickyNote,
  X,
} from 'lucide-react';
import {
  type PointerEvent as ReactPointerEvent,
  type RefObject,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useMobileKeyboardOffset } from '../../../hooks/useMobileKeyboardOffset.ts';
import { translateUiMessage as t } from '../../../i18n/uiMessages.ts';
import { fetchWithSupabaseAuth } from '../../../services/auth/supabaseAuth.ts';
import {
  executeLibraryAssistantTool,
  isLibraryAssistantToolName,
  type LibraryAssistantDataSource,
} from '../../../services/library/toolExecutor.ts';
import type { GeneratedLessonArtifactDraft } from '../../../services/openrouter/artifactDrafts.ts';
import { generateLessonArtifactDraft } from '../../../services/openrouter/artifactDrafts.ts';
import { getBackendUrl } from '../../../services/openrouter/config.ts';
import type {
  LearningArtifactRenderPayload,
  LearningSection,
  StoredLessonVisual,
} from '../../../types.ts';
import {
  buildConversationNoteSaveCandidates,
  hasAnchorableConversationNoteCandidate,
} from '../../../utils/context/conversationNote.ts';
import {
  buildGeneratedVisualLearningArtifactPayload,
  filterLearningArtifactPayloads,
  summarizeLearningArtifacts,
} from '../../../utils/learning/artifacts.ts';
import {
  dedupeUiMessagesById,
  getUiMessageRenderableParts,
  getUiMessageText,
  hasOnlySuccessfulToolOutputs,
} from '../../../utils/uiChat.ts';
import {
  getStoredLessonVisualKind,
  isStoredLessonVisualKind,
} from '../../../utils/visuals/storedLessonVisual.ts';
import type {
  ChatArtifactActionRequest,
  ChatArtifactRegenerateRequest,
  ChatArtifactRegenerationLifecycle,
  ChatArtifactRegenerationStates,
  ChatArtifactReplaceRequest,
} from '../../shared/ChatArtifactRenderer.tsx';
import ChatArtifactRenderer from '../../shared/ChatArtifactRenderer.tsx';
import ChatToolActivityStrip from '../../shared/ChatToolActivityStrip.tsx';
import LibraryToolReferences, {
  type LibraryNavigationTarget,
} from '../../shared/LibraryToolReferences.tsx';
import {
  appendSpeechTranscription,
  default as SpeechInputButton,
} from '../../shared/SpeechInputButton.tsx';
import StreamingMarkdownRenderer from '../../shared/StreamingMarkdownRenderer.tsx';
import ChatTextComposer from '../chat/ChatTextComposer.tsx';
import type {
  ContextAnswerSize,
  ContextAnswerState,
  ContextArtifactMutationResult,
  ContextChatToolPreferences,
  ContextLessonMutationTarget,
  ConversationSelectionAnchor,
  SaveConversationNoteInput,
  SaveConversationNoteResult,
} from './types.ts';

interface RequestAddToNotesInput {
  artifactIds?: string[];
  noteDraft: string;
  rationale: string;
  selectedTextDraft: string;
}

type RequestAddToNotesMode = 'new' | 'update' | 'none';

const CONTEXT_ANSWER_INPUT_TARGET = 'context-answer-input';
const CONTEXT_ANSWER_SUBMIT_TARGET = 'context-answer-submit';

interface RequestAddToNotesOutput {
  approved: boolean;
  mode: RequestAddToNotesMode;
  saved: boolean;
  annotationId?: string;
  error?: string;
}

const resolveRequestedNoteArtifactIds = (
  requestedArtifactIds: string[] | undefined,
  latestGeneratedArtifactId: string | null
): string[] => {
  if (requestedArtifactIds?.length) {
    return requestedArtifactIds;
  }
  return latestGeneratedArtifactId ? [latestGeneratedArtifactId] : [];
};

interface CurrentLessonArtifactsToolInput {
  artifactIds?: string[];
  kinds?: LearningArtifactRenderPayload['summary']['kind'][];
  maxResults?: number;
  query?: string;
  renderMode?: 'attachments' | 'metadata-only';
}

interface GenerateCurrentLessonArtifactInput {
  mode?: 'new' | 'replacement-draft';
  prompt: string;
  requestedVisualKind?: 'html' | 'image' | 'mermaid' | 'svg';
  revisionInstructions?: string;
  sourceArtifactId?: string;
}

const isRequestAddToNotesInput = (value: unknown): value is RequestAddToNotesInput => {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const candidate = value as Partial<RequestAddToNotesInput>;
  return (
    typeof candidate.noteDraft === 'string' &&
    typeof candidate.rationale === 'string' &&
    typeof candidate.selectedTextDraft === 'string' &&
    (candidate.artifactIds === undefined ||
      (Array.isArray(candidate.artifactIds) &&
        candidate.artifactIds.every(item => typeof item === 'string')))
  );
};

const isRequestAddToNotesOutput = (value: unknown): value is RequestAddToNotesOutput => {
  if (!value || typeof value !== 'object') {
    return false;
  }

  return typeof (value as Partial<RequestAddToNotesOutput>).approved === 'boolean';
};

const hasPendingAddToNotesRequest = (messages: ContextChatMessage[]): boolean =>
  messages.some(message =>
    message.parts.some(
      part =>
        isToolUIPart(part) &&
        part.type === 'tool-requestAddToNotes' &&
        part.state === 'input-available'
    )
  );

const shouldContinueContextResponse = (messages: ContextChatMessage[]): boolean =>
  !hasOnlySuccessfulToolOutputs(messages, 'tool-generateCurrentLessonArtifact') &&
  lastAssistantMessageIsCompleteWithToolCalls({ messages });

const hasPendingResponsePart = (message: ContextChatMessage): boolean =>
  message.parts.some(part => {
    if (isTextUIPart(part)) {
      return part.state === 'streaming';
    }
    if (!isToolUIPart(part)) {
      return false;
    }
    return (
      part.state !== 'output-available' &&
      part.state !== 'output-error' &&
      part.state !== 'output-denied'
    );
  });

const readArtifactId = (artifact: unknown): string | null => {
  if (!artifact || typeof artifact !== 'object' || !('id' in artifact)) return null;
  return typeof artifact.id === 'string' ? artifact.id : null;
};

const readArtifactIds = (output: unknown): string[] => {
  if (!output || typeof output !== 'object') return [];
  const artifacts = (output as { artifacts?: unknown }).artifacts;
  return Array.isArray(artifacts)
    ? artifacts.flatMap(artifact => {
        const artifactId = readArtifactId(artifact);
        return artifactId ? [artifactId] : [];
      })
    : [];
};

const getRetrievedArtifactIds = (messages: ContextChatMessage[]): Set<string> =>
  new Set(
    messages.flatMap(message =>
      message.parts.flatMap(part =>
        isToolUIPart(part) &&
        part.type === 'tool-getLearningArtifacts' &&
        part.state === 'output-available'
          ? readArtifactIds(part.output)
          : []
      )
    )
  );

const readCurrentLessonArtifactsToolInput = (value: unknown): CurrentLessonArtifactsToolInput => {
  if (!value || typeof value !== 'object') {
    return {};
  }

  const candidate = value as Partial<CurrentLessonArtifactsToolInput>;
  return {
    artifactIds: Array.isArray(candidate.artifactIds)
      ? candidate.artifactIds.filter((item): item is string => typeof item === 'string')
      : undefined,
    kinds: Array.isArray(candidate.kinds)
      ? candidate.kinds.filter(
          (kind): kind is LearningArtifactRenderPayload['summary']['kind'] =>
            kind === 'generated-visual' || kind === 'pdf-image' || kind === 'future-asset'
        )
      : undefined,
    maxResults: typeof candidate.maxResults === 'number' ? candidate.maxResults : undefined,
    query: typeof candidate.query === 'string' ? candidate.query : undefined,
    renderMode: candidate.renderMode === 'attachments' ? 'attachments' : 'metadata-only',
  };
};

const readGenerateCurrentLessonArtifactInput = (
  value: unknown
): GenerateCurrentLessonArtifactInput | null => {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const candidate = value as Partial<GenerateCurrentLessonArtifactInput>;
  return typeof candidate.prompt === 'string' && candidate.prompt.trim()
    ? {
        mode: candidate.mode === 'replacement-draft' ? 'replacement-draft' : 'new',
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

interface ContextChatTools {
  [key: string]: {
    input: unknown;
    output: unknown | undefined;
  };
  requestAddToNotes: {
    input: RequestAddToNotesInput;
    output: RequestAddToNotesOutput;
  };
  getCurrentLessonArtifacts: {
    input: unknown;
    output: unknown;
  };
  generateCurrentLessonArtifact: {
    input: unknown;
    output: unknown;
  };
}

type ContextChatMessage = UIMessage<unknown, Record<string, never>, ContextChatTools>;
type ContextChatToolPart = Extract<ContextChatMessage['parts'][number], { toolCallId: string }>;

const isPendingContextToolPart = (
  part: ContextChatMessage['parts'][number]
): part is ContextChatToolPart =>
  'toolCallId' in part && (part.state === 'input-streaming' || part.state === 'input-available');

const getContextToolPartName = (part: ContextChatToolPart): string =>
  'toolName' in part && typeof part.toolName === 'string'
    ? part.toolName
    : part.type.slice('tool-'.length);

interface ContextRequestState {
  attachedAnnotationNote?: string;
  attachedAnnotationText?: string;
  contextAfter?: string;
  contextBefore?: string;
  contextScope?: ContextAnswerState['contextScope'];
  lessonContent?: string;
  lessonDescription?: string;
  lessonTitle?: string;
  projectId?: string;
  projectTitle?: string;
  selectedText: string;
  selectedTextStart?: number;
  sourceKind?: ContextAnswerState['sourceKind'];
  sourceMaterial?: string;
  sourceName?: string;
  sourceReferences?: ContextSourceReference[];
  toolPreferences: ContextChatToolPreferences;
}

interface ContextResponseState {
  canContinue: boolean;
  generation: number;
}

const serializeContextSourceReferences = (
  references: ContextAnswerState['documentSourceReferences']
): ContextSourceReference[] | undefined =>
  references?.map(
    ({ archiveSelectors, archiveVersion, chunkIds, name, pageEnd, pageStart, sourceId }) => ({
      ...(archiveSelectors ? { archiveSelectors } : {}),
      ...(archiveVersion ? { archiveVersion } : {}),
      chunkIds,
      name,
      pageEnd,
      pageStart,
      sourceId,
    })
  );

const buildLegacySourceName = (
  references: ContextAnswerState['documentSourceReferences']
): string | undefined => {
  if (!references?.length) {
    return undefined;
  }
  const names = references.map(reference => sanitizeContextSourceDisplayName(reference.name));
  return names.length === 1 ? names[0] : `${names.length} fonti originali: ${names.join(' | ')}`;
};

const createContextRequestStateStore = (initialState: ContextRequestState) => {
  let currentState = initialState;
  return {
    read: () => currentState,
    write: (nextState: ContextRequestState) => {
      currentState = nextState;
    },
  };
};

const buildContextDraftLesson = (
  contextAnswer: ContextAnswerState,
  requestState: ContextRequestState | undefined
): LearningSection | null => {
  if (!contextAnswer.lessonId || !requestState?.lessonTitle) {
    return null;
  }

  return {
    id: contextAnswer.lessonId,
    title: requestState.lessonTitle,
    description: requestState.lessonDescription || '',
    isCompleted: false,
    type: 'core',
    content: requestState.lessonContent || '',
  };
};

interface ContextAnswerPanelProps {
  readonly artifactActionFeedbackOverride?: 'saved';
  readonly artifactPreviewIdOverride?: string | null;
  readonly artifactPortalContainer?: HTMLElement | null;
  readonly autoScrollKey?: string;
  readonly contextAnswer: ContextAnswerState;
  readonly contextAnswerPanelRef: RefObject<HTMLDivElement | null>;
  readonly contextAnswerSize: ContextAnswerSize;
  readonly displayMessages?: UIMessage[];
  readonly handleContextAnswerResizeStart: (event: ReactPointerEvent<HTMLButtonElement>) => void;
  readonly isDarkMode: boolean;
  readonly inputValueOverride?: string;
  readonly isMobileViewport: boolean;
  readonly libraryAssistantDataSource: LibraryAssistantDataSource;
  readonly messagesScrollTopOverride?: number;
  readonly currentLessonArtifactPayloads?: LearningArtifactRenderPayload[];
  readonly onClose: () => void;
  readonly onOpenLibraryReference: (reference: LibraryNavigationTarget) => void;
  readonly onSaveConversationNote: (
    target: ContextLessonMutationTarget,
    input: SaveConversationNoteInput
  ) => Promise<SaveConversationNoteResult>;
  readonly onUpdateConversationNote: (
    target: ContextLessonMutationTarget,
    input: SaveConversationNoteInput
  ) => Promise<SaveConversationNoteResult>;
  /** Saves a generated visual artifact directly as a lesson-level annotation. */
  readonly onSaveArtifactToLesson?: (
    target: ContextLessonMutationTarget,
    visual: StoredLessonVisual,
    artifactRef: { artifactId: string; kind: 'generated-visual'; title: string }
  ) => Promise<ContextArtifactMutationResult>;
  /** Replaces an already saved generated visual while preserving its artifact identity. */
  readonly onReplaceArtifactInLesson?: (
    target: ContextLessonMutationTarget,
    artifactId: string,
    visual: StoredLessonVisual
  ) => Promise<ContextArtifactMutationResult>;
}

const toolCardClassName =
  'rounded-[1.4rem] border border-stone-200/90 bg-[#fbf7ef] px-4 py-3 text-sm text-stone-700 shadow-[0_12px_28px_-22px_rgba(46,34,16,0.55)] dark:border-stone-400/95 dark:bg-stone-700/90 dark:text-stone-200';
const autoSubmittedInitialQuestionIds = new Set<string>();

// If a requestAddToNotes tool stays in input-available without valid input,
// show fallback buttons after this many ms and auto-reject after HARD_TIMEOUT_MS.
const STUCK_TOOL_GRACE_MS = 2_000;
const STUCK_TOOL_HARD_TIMEOUT_MS = 15_000;
const REPLACEMENT_DRAFT_TOOL_CALL_PREFIX = 'replacement-draft';

const upsertLearningArtifactPayload = (
  payloads: LearningArtifactRenderPayload[],
  payload: LearningArtifactRenderPayload
) => {
  const existingIndex = payloads.findIndex(
    currentPayload => currentPayload.summary.id === payload.summary.id
  );
  if (existingIndex < 0) {
    return [...payloads, payload];
  }

  const nextPayloads = [...payloads];
  nextPayloads[existingIndex] = payload;
  return nextPayloads;
};

export default function ContextAnswerPanel({ ...props }: ContextAnswerPanelProps) {
  return <ContextAnswerPanelSession key={props.contextAnswer.id} {...props} />;
}

function ContextAnswerPanelSession({
  artifactActionFeedbackOverride,
  artifactPreviewIdOverride,
  artifactPortalContainer,
  autoScrollKey,
  contextAnswer,
  contextAnswerPanelRef,
  contextAnswerSize,
  displayMessages,
  handleContextAnswerResizeStart,
  isDarkMode,
  inputValueOverride,
  isMobileViewport,
  libraryAssistantDataSource,
  messagesScrollTopOverride,
  currentLessonArtifactPayloads = [],
  onClose,
  onOpenLibraryReference,
  onSaveConversationNote,
  onUpdateConversationNote,
  onSaveArtifactToLesson,
  onReplaceArtifactInLesson,
}: ContextAnswerPanelProps) {
  const [originLessonArtifactPayloads, setOriginLessonArtifactPayloads] = useState(
    () => currentLessonArtifactPayloads
  );
  const [input, setInput] = useState('');
  const [hasRequestedResponseStop, setHasRequestedResponseStop] = useState(false);
  const mutationTarget: ContextLessonMutationTarget = {
    lessonId: contextAnswer.lessonId,
    projectId: contextAnswer.projectId,
  };
  const displayedInput = inputValueOverride ?? input;
  const [isToolMenuOpen, setIsToolMenuOpen] = useState(false);
  const [, setIsChatScrolled] = useState(false);
  const [isChatNotAtBottom, setIsChatNotAtBottom] = useState(false);
  const handleChatScroll = () => {
    if (messagesScrollTopOverride !== undefined) return;
    const el = messagesContainerRef.current;
    if (!el) return;
    const scrolled = el.scrollTop > 0;
    const notAtBottom = el.scrollHeight - el.scrollTop - el.clientHeight > 1;
    setIsChatScrolled(scrolled);
    setIsChatNotAtBottom(notAtBottom);
  };
  const [toolPreferences, setToolPreferences] = useState<ContextChatToolPreferences>({
    annotate: false,
    generateArtifacts: false,
    webSearch: false,
  });
  const [artifactPayloadsByToolCallId, setArtifactPayloadsByToolCallId] = useState<
    Record<string, LearningArtifactRenderPayload[]>
  >({});
  const [generatedVisualsByArtifactId, setGeneratedVisualsByArtifactId] = useState<
    Record<string, StoredLessonVisual>
  >({});
  const [artifactRegenerationStates, setArtifactRegenerationStates] =
    useState<ChatArtifactRegenerationStates>({});
  const [generatingArtifactToolCallIds, setGeneratingArtifactToolCallIds] = useState<Set<string>>(
    new Set()
  );
  const hasSubmittedInitialQuestionRef = useRef(false);
  const activeResponseStateRef = useRef<ContextResponseState>({
    canContinue: true,
    generation: 0,
  });
  const activeContextToolCallsRef = useRef(new Map<string, string>());
  const contextStopButtonRef = useRef<HTMLButtonElement>(null);
  const focusStopAfterSubmitRef = useRef(false);
  const toolMenuRef = useRef<HTMLDivElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const selectionAnchorRef = useRef<ConversationSelectionAnchor>({
    contextAfter: contextAnswer.contextAfter,
    contextBefore: contextAnswer.contextBefore,
    selectedText: contextAnswer.selectedText,
    selectedTextStart: contextAnswer.selectedTextStart,
  });

  useEffect(() => {
    const responseState = activeResponseStateRef.current;
    const activeToolCalls = activeContextToolCallsRef.current;
    responseState.canContinue = true;
    return () => {
      responseState.canContinue = false;
      responseState.generation += 1;
      activeToolCalls.clear();
    };
  }, []);

  // Tracks when each requestAddToNotes part entered input-available without
  // valid input, so we can show fallback buttons after GRACE and auto-reject
  // after HARD_TIMEOUT.
  const stuckToolTimestampsRef = useRef<Map<string, number>>(new Map());
  const latestGeneratedArtifactIdRef = useRef<string | null>(null);
  const [expiredGraceTools, setExpiredGraceTools] = useState<Set<string>>(new Set());
  const [processingNoteToolCallIds, setProcessingNoteToolCallIds] = useState<Set<string>>(
    new Set()
  );

  const { keyboardOffset, viewportHeight } = useMobileKeyboardOffset();

  useEffect(() => {
    selectionAnchorRef.current = {
      contextAfter: contextAnswer.contextAfter,
      contextBefore: contextAnswer.contextBefore,
      selectedText: contextAnswer.selectedText,
      selectedTextStart: contextAnswer.selectedTextStart,
    };
  }, [
    contextAnswer.contextAfter,
    contextAnswer.contextBefore,
    contextAnswer.selectedText,
    contextAnswer.selectedTextStart,
  ]);

  const currentContextRequestState = useMemo<ContextRequestState>(
    () => ({
      attachedAnnotationNote: contextAnswer.attachedAnnotationNote,
      attachedAnnotationText: contextAnswer.attachedAnnotationText,
      contextAfter: contextAnswer.contextAfter,
      contextBefore: contextAnswer.contextBefore,
      contextScope: contextAnswer.contextScope,
      sourceReferences: serializeContextSourceReferences(contextAnswer.documentSourceReferences),
      sourceName: buildLegacySourceName(contextAnswer.documentSourceReferences),
      lessonContent: contextAnswer.lessonContent,
      lessonDescription: contextAnswer.lessonDescription,
      lessonTitle: contextAnswer.lessonTitle,
      projectId: contextAnswer.projectId,
      projectTitle: contextAnswer.projectTitle,
      selectedText: contextAnswer.selectedText,
      selectedTextStart: contextAnswer.selectedTextStart,
      sourceKind: contextAnswer.sourceKind,
      sourceMaterial: contextAnswer.sourceMaterial,
      toolPreferences,
    }),
    [
      contextAnswer.attachedAnnotationNote,
      contextAnswer.attachedAnnotationText,
      contextAnswer.contextAfter,
      contextAnswer.contextBefore,
      contextAnswer.contextScope,
      contextAnswer.documentSourceReferences,
      contextAnswer.lessonContent,
      contextAnswer.lessonDescription,
      contextAnswer.lessonTitle,
      contextAnswer.projectId,
      contextAnswer.projectTitle,
      contextAnswer.selectedText,
      contextAnswer.selectedTextStart,
      contextAnswer.sourceKind,
      contextAnswer.sourceMaterial,
      toolPreferences,
    ]
  );
  const [contextRequestStateStore] = useState(() =>
    createContextRequestStateStore(currentContextRequestState)
  );

  useEffect(() => {
    contextRequestStateStore.write(currentContextRequestState);
  }, [contextRequestStateStore, currentContextRequestState]);

  const transport = useMemo(
    () =>
      new DefaultChatTransport<ContextChatMessage>({
        api: `${getBackendUrl()}/api/chat/context`,
        fetch: fetchWithSupabaseAuth,
        // `useChat` keeps the initial transport instance, so request data comes from its stable store.
        prepareSendMessagesRequest: ({ headers, id, messages }) => {
          const currentRequestState = contextRequestStateStore.read();

          return {
            headers,
            body: {
              id,
              messages,
              contextAfter: currentRequestState.contextAfter,
              contextBefore: currentRequestState.contextBefore,
              contextScope: currentRequestState.contextScope || 'selection',
              lessonContent: currentRequestState.lessonContent,
              lessonDescription: currentRequestState.lessonDescription,
              lessonTitle: currentRequestState.lessonTitle,
              projectId: currentRequestState.projectId,
              projectTitle: currentRequestState.projectTitle,
              selectedText: currentRequestState.selectedText,
              sourceKind: currentRequestState.sourceKind,
              sourceMaterial: currentRequestState.sourceMaterial,
              sourceName: currentRequestState.sourceName,
              sourceReferences: currentRequestState.sourceReferences,
              attachedAnnotationNote: currentRequestState.attachedAnnotationNote,
              attachedAnnotationText: currentRequestState.attachedAnnotationText,
              toolPreferences: currentRequestState.toolPreferences,
            },
          };
        },
      }),
    [contextRequestStateStore]
  );

  const contextChat = useChat<ContextChatMessage>({
    id: contextAnswer.id,
    transport,
    experimental_throttle: 96,
    sendAutomaticallyWhen: ({ messages }) =>
      activeResponseStateRef.current.canContinue && shouldContinueContextResponse(messages),
    onToolCall: async ({ toolCall }) => {
      if (toolCall.dynamic) {
        return;
      }
      const responseGeneration = activeResponseStateRef.current.generation;
      const shouldContinueToolCall = () => {
        const responseState = activeResponseStateRef.current;
        return responseState.canContinue && responseState.generation === responseGeneration;
      };
      if (!shouldContinueToolCall()) {
        void addToolOutput({
          tool: toolCall.toolName,
          toolCallId: toolCall.toolCallId,
          state: 'output-error',
          errorText: t('Annullato'),
        });
        return;
      }
      const awaitTrackedToolCall = async <Result,>(request: () => Promise<Result>) => {
        activeContextToolCallsRef.current.set(toolCall.toolCallId, toolCall.toolName);
        try {
          return await request();
        } finally {
          activeContextToolCallsRef.current.delete(toolCall.toolCallId);
        }
      };
      if (toolCall.toolName === 'requestAddToNotes') {
        const noteInput = isRequestAddToNotesInput(toolCall.input) ? toolCall.input : null;
        const currentState = contextRequestStateStore.read();
        const primaryCandidate = noteInput
          ? buildConversationNoteSaveCandidates({
              anchor: selectionAnchorRef.current,
              toolInput: {
                note: noteInput.noteDraft,
                selectedText: noteInput.selectedTextDraft,
              },
            })[0]
          : null;

        const hasAnchorableProposal = Boolean(
          primaryCandidate &&
            hasAnchorableConversationNoteCandidate(
              currentState.lessonContent || '',
              primaryCandidate
            )
        );

        if (noteInput && !hasAnchorableProposal) {
          void addToolOutput({
            tool: 'requestAddToNotes',
            toolCallId: toolCall.toolCallId,
            output: { approved: false, mode: 'none', saved: false },
          });
        }
        return;
      }
      if (toolCall.toolName === 'getCurrentLessonArtifacts') {
        const artifactInput = readCurrentLessonArtifactsToolInput(toolCall.input);
        const matchingPayloads = filterLearningArtifactPayloads(originLessonArtifactPayloads, {
          artifactIds: artifactInput.artifactIds,
          kinds: artifactInput.kinds,
          maxResults: artifactInput.maxResults,
          query: artifactInput.query,
        });
        const renderPayloads = artifactInput.renderMode === 'attachments' ? matchingPayloads : [];
        setArtifactPayloadsByToolCallId(currentPayloads => ({
          ...currentPayloads,
          [toolCall.toolCallId]: renderPayloads,
        }));
        void addToolOutput({
          tool: 'getCurrentLessonArtifacts',
          toolCallId: toolCall.toolCallId,
          output: {
            artifactCount: matchingPayloads.length,
            artifacts: summarizeLearningArtifacts(matchingPayloads),
            renderMode: artifactInput.renderMode,
            renderedArtifactCount: renderPayloads.length,
          },
        });
      }

      if (toolCall.toolName === 'generateCurrentLessonArtifact') {
        const artifactInput = readGenerateCurrentLessonArtifactInput(toolCall.input);
        const projectId = contextAnswer.projectId;
        const currentState = contextRequestStateStore.read();
        const draftLesson = buildContextDraftLesson(contextAnswer, currentState);
        const allArtifactPayloads = [
          ...originLessonArtifactPayloads,
          ...Object.values(artifactPayloadsByToolCallId).flat(),
        ];
        const sourceArtifactId = artifactInput?.sourceArtifactId;
        const sourceArtifact = sourceArtifactId
          ? allArtifactPayloads.find(
              payload =>
                payload.summary.id === sourceArtifactId &&
                payload.summary.kind === 'generated-visual' &&
                'visual' in payload
            )
          : undefined;

        if (!artifactInput || !projectId || !draftLesson || !currentState) {
          void addToolOutput({
            tool: 'generateCurrentLessonArtifact',
            toolCallId: toolCall.toolCallId,
            output: {
              artifact: null,
              error: t('Non ho abbastanza contesto per generare un artefatto su questa lezione.'),
            },
          });
          return;
        }

        if (artifactInput.mode === 'replacement-draft' && !sourceArtifact) {
          void addToolOutput({
            tool: 'generateCurrentLessonArtifact',
            toolCallId: toolCall.toolCallId,
            output: {
              artifact: null,
              error: t('Non ho trovato un artefatto generato modificabile da usare come sorgente.'),
            },
          });
          return;
        }

        setGeneratingArtifactToolCallIds(prev => {
          const next = new Set(prev);
          next.add(toolCall.toolCallId);
          return next;
        });

        let draft: GeneratedLessonArtifactDraft | null = null;
        try {
          draft = await awaitTrackedToolCall(() =>
            generateLessonArtifactDraft({
              contextAfter: currentState.contextAfter,
              contextBefore: currentState.contextBefore,
              generationNotes: undefined,
              lesson: draftLesson,
              mode: artifactInput.mode,
              projectId,
              projectTitle: contextAnswer.projectTitle || t('Corso'),
              prompt: artifactInput.prompt,
              requestKey: toolCall.toolCallId,
              requestedVisualKind: artifactInput.requestedVisualKind,
              revisionInstructions: artifactInput.revisionInstructions,
              selectedText: currentState.selectedText,
              sourceArtifact,
              sourceArtifactId,
            })
          );
        } catch (generationError) {
          if (shouldContinueToolCall()) {
            console.error('[Nous][Context artifact] Generation failed.', generationError);
          }
        } finally {
          if (shouldContinueToolCall()) {
            setGeneratingArtifactToolCallIds(prev => {
              if (!prev.has(toolCall.toolCallId)) return prev;
              const next = new Set(prev);
              next.delete(toolCall.toolCallId);
              return next;
            });
          }
        }
        if (!shouldContinueToolCall()) return;

        if (!draft) {
          void addToolOutput({
            tool: 'generateCurrentLessonArtifact',
            toolCallId: toolCall.toolCallId,
            output: {
              artifact: null,
              error: t(
                'Non sono riuscito a generare un artefatto visuale utile per questa richiesta.'
              ),
            },
          });
          return;
        }

        setGeneratedVisualsByArtifactId(currentVisuals => ({
          ...currentVisuals,
          [draft.artifactId]: draft.visual,
        }));
        latestGeneratedArtifactIdRef.current = draft.artifactId;
        setArtifactPayloadsByToolCallId(currentPayloads => ({
          ...currentPayloads,
          [toolCall.toolCallId]: [draft.payload],
        }));
        void addToolOutput({
          tool: 'generateCurrentLessonArtifact',
          toolCallId: toolCall.toolCallId,
          output: {
            artifact: draft.payload.summary,
            artifactId: draft.artifactId,
            renderedArtifactCount: 1,
          },
        });
      }

      if (isLibraryAssistantToolName(toolCall.toolName)) {
        const toolName = toolCall.toolName;
        let result: Awaited<ReturnType<typeof executeLibraryAssistantTool>>;
        try {
          result = await awaitTrackedToolCall(() =>
            executeLibraryAssistantTool({
              dataSource: libraryAssistantDataSource,
              input: toolCall.input,
              toolName,
            })
          );
        } catch (toolError) {
          if (!shouldContinueToolCall()) return;
          console.error('[Nous][Context library] Tool execution failed.', toolError);
          void addToolOutput({
            tool: toolCall.toolName,
            toolCallId: toolCall.toolCallId,
            state: 'output-error',
            errorText: t('Non sono riuscito a recuperare i dati della libreria.'),
          });
          return;
        }
        if (!shouldContinueToolCall()) return;

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
      }
    },
  });
  const { addToolOutput, error, messages, sendMessage, status, stop } = contextChat;

  const artifactPayloadsById = useMemo(() => {
    const payloads = [
      ...originLessonArtifactPayloads,
      ...Object.values(artifactPayloadsByToolCallId).flat(),
    ];
    return new Map(payloads.map(payload => [payload.summary.id, payload]));
  }, [artifactPayloadsByToolCallId, originLessonArtifactPayloads]);
  const retrievedArtifactIds = useMemo(() => getRetrievedArtifactIds(messages), [messages]);
  const replacementDraftPayloads = useMemo(
    () =>
      Object.entries(artifactPayloadsByToolCallId).flatMap(([toolCallId, payloads]) =>
        toolCallId.startsWith(REPLACEMENT_DRAFT_TOOL_CALL_PREFIX) ? payloads : []
      ),
    [artifactPayloadsByToolCallId]
  );
  const artifactRegenerationLifecycle = useMemo<ChatArtifactRegenerationLifecycle>(
    () => ({
      replacementSourceArtifactIds: new Set(
        replacementDraftPayloads.flatMap(payload =>
          payload.summary.kind === 'generated-visual' && payload.summary.replacementOfArtifactId
            ? [payload.summary.replacementOfArtifactId]
            : []
        )
      ),
      setStates: setArtifactRegenerationStates,
      states: artifactRegenerationStates,
    }),
    [artifactRegenerationStates, replacementDraftPayloads]
  );

  useEffect(() => {
    const initialQuestion = contextAnswer.initialQuestion.trim();
    if (
      hasSubmittedInitialQuestionRef.current ||
      !initialQuestion ||
      messages.length > 0 ||
      autoSubmittedInitialQuestionIds.has(contextAnswer.id)
    ) {
      return;
    }

    hasSubmittedInitialQuestionRef.current = true;
    autoSubmittedInitialQuestionIds.add(contextAnswer.id);
    void sendMessage({ text: initialQuestion });
  }, [contextAnswer.id, contextAnswer.initialQuestion, messages.length, sendMessage]);

  useEffect(() => {
    if (!isToolMenuOpen) {
      return;
    }

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node) || toolMenuRef.current?.contains(target)) {
        return;
      }

      setIsToolMenuOpen(false);
    };

    document.addEventListener('pointerdown', handlePointerDown, true);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown, true);
    };
  }, [isToolMenuOpen]);

  const handleRejectNoteRequest = (toolCallId: string) => {
    void addToolOutput({
      tool: 'requestAddToNotes',
      toolCallId,
      output: { approved: false, mode: 'none', saved: false },
    });
  };

  const handleApproveNoteRequest = async (
    toolCallId: string,
    inputValue: RequestAddToNotesInput
  ) => {
    if (processingNoteToolCallIds.has(toolCallId)) {
      return;
    }

    const currentState = contextRequestStateStore.read();
    const hasExistingNote = Boolean(currentState?.attachedAnnotationNote?.trim());
    const mode: 'new' | 'update' = hasExistingNote ? 'update' : 'new';
    const runMutation = mode === 'update' ? onUpdateConversationNote : onSaveConversationNote;

    setProcessingNoteToolCallIds(previous => {
      const next = new Set(previous);
      next.add(toolCallId);
      return next;
    });

    try {
      let lastResult: SaveConversationNoteResult | null = null;

      const noteArtifactIds = resolveRequestedNoteArtifactIds(
        inputValue.artifactIds,
        latestGeneratedArtifactIdRef.current
      );
      const hasUnsavableArtifact = noteArtifactIds.some(artifactId => {
        const payload = artifactPayloadsById.get(artifactId);
        if (!payload) return retrievedArtifactIds.has(artifactId);
        return (
          payload.summary.kind !== 'generated-visual' &&
          (payload.summary.projectId !== contextAnswer.projectId ||
            payload.summary.lessonId !== contextAnswer.lessonId)
        );
      });
      if (hasUnsavableArtifact) {
        void addToolOutput({
          tool: 'requestAddToNotes',
          toolCallId,
          output: {
            approved: true,
            mode,
            saved: false,
            error: t('Non sono riuscito a salvare la nota.'),
          },
        });
        return;
      }
      const candidates = buildConversationNoteSaveCandidates({
        anchor: selectionAnchorRef.current,
        toolInput: {
          artifactRefs: noteArtifactIds.flatMap(artifactId => {
            const payload = artifactPayloadsById.get(artifactId);
            return payload
              ? [
                  {
                    artifactId,
                    kind: payload.summary.kind,
                    title: payload.summary.title,
                  },
                ]
              : [];
          }),
          generatedVisuals: noteArtifactIds.flatMap(artifactId => {
            const generatedVisual = generatedVisualsByArtifactId[artifactId];
            if (generatedVisual) return [generatedVisual];

            const retrievedPayload = artifactPayloadsById.get(artifactId);
            return retrievedPayload?.summary.kind === 'generated-visual' &&
              'visual' in retrievedPayload
              ? [retrievedPayload.visual]
              : [];
          }),
          note: inputValue.noteDraft,
          selectedText: inputValue.selectedTextDraft,
        },
      });

      for (const candidate of candidates) {
        const result = await runMutation(mutationTarget, candidate);
        lastResult = result;
        if (result.saved) {
          const originLesson = buildContextDraftLesson(contextAnswer, currentState);
          const originProjectId = contextAnswer.projectId;
          const savedVisuals = candidate.generatedVisuals;
          if (originLesson && originProjectId && savedVisuals?.length) {
            setOriginLessonArtifactPayloads(currentPayloads =>
              savedVisuals.reduce(
                (nextPayloads, visual) =>
                  upsertLearningArtifactPayload(
                    nextPayloads,
                    buildGeneratedVisualLearningArtifactPayload({
                      lesson: originLesson,
                      projectId: originProjectId,
                      projectTitle: contextAnswer.projectTitle || t('Corso'),
                      visual,
                    })
                  ),
                currentPayloads
              )
            );
          }
          void addToolOutput({
            tool: 'requestAddToNotes',
            toolCallId,
            output: {
              approved: true,
              mode,
              saved: true,
              annotationId: result.annotationId,
            },
          });
          return;
        }
      }

      void addToolOutput({
        tool: 'requestAddToNotes',
        toolCallId,
        output: {
          approved: true,
          mode,
          saved: false,
          error:
            lastResult?.error ||
            (mode === 'update'
              ? t('Non sono riuscito ad aggiornare la nota.')
              : t('Non sono riuscito a salvare la nota.')),
        },
      });
    } finally {
      setProcessingNoteToolCallIds(previous => {
        if (!previous.has(toolCallId)) {
          return previous;
        }
        const next = new Set(previous);
        next.delete(toolCallId);
        return next;
      });
    }
  };

  const handleSaveGeneratedArtifact = async ({ artifactId }: ChatArtifactActionRequest) => {
    const payload = artifactPayloadsById.get(artifactId);
    if (!payload || !('visual' in payload)) {
      return { error: t("Non ho trovato l'artefatto da salvare."), succeeded: false };
    }

    const visual = generatedVisualsByArtifactId[artifactId];
    if (!visual) {
      return { error: t("Non ho trovato l'artefatto da salvare."), succeeded: false };
    }

    const artifactRef = {
      artifactId,
      kind: 'generated-visual',
      title: payload.summary.title,
    } as const;
    if (onSaveArtifactToLesson) {
      const result = await onSaveArtifactToLesson(mutationTarget, visual, artifactRef);
      if (result.succeeded) {
        setOriginLessonArtifactPayloads(currentPayloads =>
          upsertLearningArtifactPayload(currentPayloads, { ...payload, visual })
        );
      }
      return result;
    }
    return { error: t("Non sono riuscito a salvare l'artefatto."), succeeded: false };
  };

  const handleRegenerateArtifact = async ({
    artifactId,
    instructions,
  }: ChatArtifactRegenerateRequest): Promise<boolean> => {
    const payload = artifactPayloadsById.get(artifactId);
    const currentState = contextRequestStateStore.read();
    const draftLesson = buildContextDraftLesson(contextAnswer, currentState);
    if (!payload || !('visual' in payload) || !contextAnswer.projectId || !draftLesson)
      return false;

    let draft: GeneratedLessonArtifactDraft | null;
    try {
      draft = await generateLessonArtifactDraft({
        contextAfter: currentState?.contextAfter,
        contextBefore: currentState?.contextBefore,
        lesson: draftLesson,
        mode: 'replacement-draft',
        projectId: contextAnswer.projectId,
        projectTitle: contextAnswer.projectTitle || t('Corso'),
        prompt: t('Modifica l artefatto "{artifactTitle}".', {
          artifactTitle: payload.summary.title,
        }),
        requestKey: `context-replacement-${artifactId}`,
        requestedVisualKind: getStoredLessonVisualKind(payload.visual),
        revisionInstructions: instructions,
        selectedText: currentState?.selectedText,
        sourceArtifact: payload,
        sourceArtifactId: artifactId,
      });
    } catch (error) {
      console.error('[Nous][Context artifact] Regeneration failed.', error);
      return false;
    }
    if (!draft) {
      return false;
    }

    setGeneratedVisualsByArtifactId(currentVisuals => ({
      ...currentVisuals,
      [draft.artifactId]: draft.visual,
    }));
    latestGeneratedArtifactIdRef.current = draft.artifactId;
    setArtifactPayloadsByToolCallId(currentPayloads => ({
      ...currentPayloads,
      [`${REPLACEMENT_DRAFT_TOOL_CALL_PREFIX}-${artifactId}-${Date.now()}`]: [draft.payload],
    }));
    return true;
  };

  const handleReplaceArtifact = async ({
    artifactId,
    replacementOfArtifactId,
  }: ChatArtifactReplaceRequest) => {
    const payload = artifactPayloadsById.get(artifactId);
    const sourcePayload = artifactPayloadsById.get(replacementOfArtifactId);
    const visual = generatedVisualsByArtifactId[artifactId];
    const originLesson = buildContextDraftLesson(contextAnswer, contextRequestStateStore.read());
    if (
      !payload ||
      !('visual' in payload) ||
      !sourcePayload ||
      !('visual' in sourcePayload) ||
      !visual ||
      !originLesson ||
      !contextAnswer.projectId ||
      !onReplaceArtifactInLesson
    ) {
      return { error: t("Non ho trovato l'artefatto da sostituire."), succeeded: false };
    }

    const result = await onReplaceArtifactInLesson(mutationTarget, replacementOfArtifactId, visual);
    if (!result.succeeded) {
      return result;
    }
    const persistedPayload = buildGeneratedVisualLearningArtifactPayload({
      lesson: originLesson,
      projectId: contextAnswer.projectId,
      projectTitle: contextAnswer.projectTitle || t('Corso'),
      visual: { ...visual, id: sourcePayload.visual.id },
    });
    setOriginLessonArtifactPayloads(currentPayloads =>
      upsertLearningArtifactPayload(currentPayloads, persistedPayload)
    );
    setArtifactPayloadsByToolCallId(currentPayloads => {
      const next = { ...currentPayloads };
      for (const [key, payloads] of Object.entries(next)) {
        next[key] = payloads.filter(p => p.summary.id !== artifactId);
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
    if (latestGeneratedArtifactIdRef.current === artifactId) {
      latestGeneratedArtifactIdRef.current = replacementOfArtifactId;
    }
    return result;
  };

  const handleDiscardArtifact = ({ artifactId }: ChatArtifactActionRequest) => {
    setArtifactPayloadsByToolCallId(currentPayloads => {
      const next = { ...currentPayloads };
      for (const [key, payloads] of Object.entries(next)) {
        next[key] = payloads.filter(p => p.summary.id !== artifactId);
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
    if (latestGeneratedArtifactIdRef.current === artifactId) {
      latestGeneratedArtifactIdRef.current = null;
    }
  };

  // Detect stuck requestAddToNotes parts (input-available without valid input)
  // and schedule grace/hard fallback timers via a 1s polling interval.
  useEffect(() => {
    const intervalId = setInterval(() => {
      const stuckTimestamps = stuckToolTimestampsRef.current;
      const now = Date.now();

      // Track new stuck parts from current messages
      for (const message of messages) {
        if (message.role !== 'assistant') {
          continue;
        }
        for (const part of message.parts ?? []) {
          if (
            !isToolUIPart(part) ||
            part.type !== 'tool-requestAddToNotes' ||
            part.state !== 'input-available' ||
            isRequestAddToNotesInput(part.input)
          ) {
            continue;
          }

          if (!stuckTimestamps.has(part.toolCallId)) {
            stuckTimestamps.set(part.toolCallId, now);
          }
        }
      }

      // Identify active stuck parts
      const activeStuckIds = new Set<string>();
      for (const message of messages) {
        if (message.role !== 'assistant') {
          continue;
        }
        for (const part of message.parts ?? []) {
          if (
            !isToolUIPart(part) ||
            part.type !== 'tool-requestAddToNotes' ||
            part.state !== 'input-available' ||
            isRequestAddToNotesInput(part.input)
          ) {
            continue;
          }
          activeStuckIds.add(part.toolCallId);
        }
      }

      // Clean up resolved parts
      for (const id of stuckTimestamps.keys()) {
        if (!activeStuckIds.has(id)) {
          stuckTimestamps.delete(id);
        }
      }

      if (activeStuckIds.size === 0) {
        return;
      }

      const graceIds = new Set<string>();
      const hardIds = new Set<string>();

      for (const [id, timestamp] of stuckTimestamps) {
        const elapsed = now - timestamp;
        if (elapsed >= STUCK_TOOL_HARD_TIMEOUT_MS) {
          hardIds.add(id);
        } else if (elapsed >= STUCK_TOOL_GRACE_MS) {
          graceIds.add(id);
        }
      }

      // Hard timeout: auto-reject
      for (const id of hardIds) {
        stuckTimestamps.delete(id);
        addToolOutput({
          tool: 'requestAddToNotes',
          toolCallId: id,
          output: { approved: false, mode: 'none', saved: false },
        });
      }

      // Grace period: show fallback buttons (avoid set identity no-op)
      if (graceIds.size > 0) {
        setExpiredGraceTools(prev => {
          const changed = Array.from(graceIds).some(id => !prev.has(id));
          if (!changed) {
            return prev;
          }
          const next = new Set(prev);
          for (const id of graceIds) {
            next.add(id);
          }
          return next;
        });
      }
    }, 1_000);

    return () => clearInterval(intervalId);
  }, [messages, addToolOutput]);

  const isLoading = status === 'submitted' || status === 'streaming';
  const isStoppingResponse = isLoading && hasRequestedResponseStop;
  const isWaitingForNoteDecision = hasPendingAddToNotesRequest(messages);
  const isComposerDisabled =
    status === 'submitted' || isStoppingResponse || isWaitingForNoteDecision;
  const hasActiveToolPreference =
    toolPreferences.annotate || toolPreferences.generateArtifacts || toolPreferences.webSearch;

  useEffect(() => {
    if (!isLoading || !focusStopAfterSubmitRef.current) return;
    focusStopAfterSubmitRef.current = false;
    contextStopButtonRef.current?.focus();
  }, [isLoading]);

  useEffect(() => {
    if (isLoading || !hasRequestedResponseStop) return;
    document
      .querySelector<HTMLElement>(`[data-chat-composer-target="${CONTEXT_ANSWER_INPUT_TARGET}"]`)
      ?.focus();
  }, [hasRequestedResponseStop, isLoading]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: messages.length triggers scroll on new arrival
  useLayoutEffect(() => {
    if (!messagesContainerRef.current) return;
    messagesContainerRef.current.scrollTop =
      messagesScrollTopOverride === undefined ? messagesContainerRef.current.scrollHeight : 0;
  }, [autoScrollKey, messages.length, messagesScrollTopOverride]);

  const handleSubmit = () => {
    if (isComposerDisabled) {
      return;
    }

    const trimmedInput = displayedInput.trim();
    if (!trimmedInput) {
      return;
    }

    if (isMobileViewport && document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }

    focusStopAfterSubmitRef.current =
      !isMobileViewport &&
      document.activeElement instanceof HTMLElement &&
      document.activeElement.dataset.chatComposerTarget === CONTEXT_ANSWER_SUBMIT_TARGET;

    activeResponseStateRef.current.canContinue = true;
    activeResponseStateRef.current.generation += 1;
    setHasRequestedResponseStop(false);
    setInput('');
    setIsToolMenuOpen(false);
    void sendMessage({ text: trimmedInput });
  };

  const handleStopResponse = () => {
    if (!isLoading || isStoppingResponse) return;
    activeResponseStateRef.current.canContinue = false;
    setHasRequestedResponseStop(true);
    setIsToolMenuOpen(false);
    setGeneratingArtifactToolCallIds(new Set());
    stop();
    const pendingToolCalls = new Map(activeContextToolCallsRef.current);
    for (const part of messages
      .flatMap(message => message.parts)
      .filter(isPendingContextToolPart)) {
      pendingToolCalls.set(part.toolCallId, getContextToolPartName(part));
    }
    activeContextToolCallsRef.current.clear();
    for (const [toolCallId, tool] of pendingToolCalls) {
      void addToolOutput({
        tool,
        toolCallId,
        state: 'output-error',
        errorText: t('Annullato'),
      });
    }
  };

  const handleSpeechTranscription = (transcription: string) => {
    setInput(currentInput => appendSpeechTranscription(currentInput, transcription));
  };

  const renderedMessages = (displayMessages as ContextChatMessage[] | undefined) ?? messages;
  const visibleMessages = dedupeUiMessagesById(renderedMessages).filter(message => {
    if (message.role === 'user') {
      return true;
    }

    return getUiMessageRenderableParts(message).length > 0;
  });
  const latestVisibleMessage = visibleMessages.at(-1);
  const activeResponseMessageId =
    latestVisibleMessage?.role === 'assistant' &&
    (status === 'submitted' ||
      status === 'streaming' ||
      status === 'error' ||
      shouldContinueContextResponse(messages) ||
      hasPendingResponsePart(latestVisibleMessage))
      ? latestVisibleMessage.id
      : null;

  const renderToolPart = (part: ContextChatMessage['parts'][number], messageId: string) => {
    if (!isToolUIPart(part)) {
      return null;
    }

    if (part.type === 'tool-requestAddToNotes') {
      const inputValue = isRequestAddToNotesInput(part.input) ? part.input : null;
      const outputValue = isRequestAddToNotesOutput(part.output) ? part.output : undefined;
      const isProcessing = processingNoteToolCallIds.has(part.toolCallId);
      const hasExistingNote = Boolean(contextAnswer.attachedAnnotationNote?.trim());
      const noteArtifactPayloads =
        inputValue?.artifactIds?.flatMap(artifactId => {
          const payload = artifactPayloadsById.get(artifactId);
          return payload ? [payload] : [];
        }) || [];
      const cardTitle = t(
        hasExistingNote ? 'Vuoi aggiornare la nota collegata?' : 'Vuoi aggiungerlo alle note?'
      );
      const approveLabel = t(hasExistingNote ? 'Aggiorna nota' : 'Aggiungi alle note');

      const renderResultPill = () => {
        if (!outputValue) {
          return null;
        }

        if (!outputValue.approved) {
          return (
            <div className="mt-3 inline-flex items-center gap-2 rounded-full bg-white/80 px-3 py-2 text-xs font-semibold text-stone-600 dark:bg-stone-800/60 dark:text-stone-200">
              <Check className="h-3.5 w-3.5" />
              <span>{t('Richiesta rifiutata, la conversazione continua senza salvare.')}</span>
            </div>
          );
        }

        if (outputValue.saved) {
          return (
            <div className="mt-3 inline-flex items-center gap-2 rounded-full bg-white/80 px-3 py-2 text-xs font-semibold text-stone-600 dark:bg-stone-800/60 dark:text-stone-200">
              <Check className="h-3.5 w-3.5" />
              <span>{t(outputValue.mode === 'update' ? 'Nota aggiornata.' : 'Nota salvata.')}</span>
            </div>
          );
        }

        return (
          <div className="mt-3 rounded-full bg-red-50 px-3 py-2 text-xs font-semibold text-red-700 dark:bg-red-950/30 dark:text-red-200">
            {outputValue.error ||
              (outputValue.mode === 'update'
                ? t('Non sono riuscito ad aggiornare la nota.')
                : t('Non sono riuscito a salvare la nota.'))}
          </div>
        );
      };

      return (
        <div key={`${messageId}-${part.toolCallId}`} className={toolCardClassName}>
          <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-stone-900 dark:text-stone-100">
            <StickyNote className="h-4 w-4" />
            <span>{cardTitle}</span>
          </div>

          <p className="text-xs leading-5 text-stone-500 dark:text-stone-400">
            {inputValue?.rationale || t('Sto preparando il suggerimento da salvare nelle note.')}
          </p>

          {inputValue ? (
            <div className="mt-3 space-y-2 rounded-[1rem] bg-white/70 px-3 py-2 dark:bg-stone-800/50">
              <p className="text-[0.7rem] font-semibold uppercase tracking-[0.16em] text-stone-400 dark:text-stone-500">
                {t('Passaggio proposto')}
              </p>
              <p className="text-sm leading-6 text-stone-700 dark:text-stone-200">
                "{inputValue.selectedTextDraft}"
              </p>
              <p className="text-[0.7rem] font-semibold uppercase tracking-[0.16em] text-stone-400 dark:text-stone-500">
                {t(hasExistingNote ? 'Nuova versione della nota' : 'Nota proposta')}
              </p>
              <p className="whitespace-pre-wrap text-sm leading-6 text-stone-700 dark:text-stone-200">
                {inputValue.noteDraft}
              </p>
              {noteArtifactPayloads.length > 0 ? (
                <div className="pt-1">
                  <ChatArtifactRenderer
                    artifacts={noteArtifactPayloads}
                    isDarkMode={isDarkMode}
                    regenerationLifecycle={artifactRegenerationLifecycle}
                  />
                </div>
              ) : null}
            </div>
          ) : null}

          {part.state === 'input-available' && inputValue ? (
            isProcessing ? null : (
              <div className="mt-3 flex flex-wrap justify-end gap-2">
                <button
                  type="button"
                  onClick={() => handleRejectNoteRequest(part.toolCallId)}
                  className="rounded-full px-3 py-2 text-xs font-semibold text-stone-500 transition-colors hover:bg-stone-200/70 hover:text-stone-700 dark:text-stone-400 dark:hover:bg-stone-600 dark:hover:text-stone-100"
                >
                  {t('No grazie')}
                </button>
                <button
                  type="button"
                  data-context-answer-target="note-approve"
                  onClick={() => void handleApproveNoteRequest(part.toolCallId, inputValue)}
                  className="rounded-full bg-stone-900 px-4 py-2 text-xs font-semibold text-stone-50 transition-colors hover:bg-stone-700 dark:bg-stone-100 dark:text-stone-900 dark:hover:bg-white"
                >
                  {approveLabel}
                </button>
              </div>
            )
          ) : part.state === 'input-available' && expiredGraceTools.has(part.toolCallId) ? (
            <div className="mt-3 space-y-2">
              <div className="rounded-full bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-700 dark:bg-amber-950/30 dark:text-amber-200">
                {t('Suggerimento non disponibile. Puoi riprovare.')}
              </div>
              <div className="flex flex-wrap justify-end gap-2">
                <button
                  type="button"
                  onClick={() => handleRejectNoteRequest(part.toolCallId)}
                  className="rounded-full px-3 py-2 text-xs font-semibold text-stone-500 transition-colors hover:bg-stone-200/70 hover:text-stone-700 dark:text-stone-400 dark:hover:bg-stone-600 dark:hover:text-stone-100"
                >
                  {t('No grazie')}
                </button>
              </div>
            </div>
          ) : part.state === 'input-available' ? (
            <div className="mt-3 inline-flex items-center gap-2 rounded-full bg-white/80 px-3 py-2 text-xs font-semibold text-stone-600 dark:bg-stone-800/60 dark:text-stone-200">
              <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
              <span>{t('Sto caricando i dettagli della nota proposta...')}</span>
            </div>
          ) : part.state === 'output-available' ? (
            renderResultPill()
          ) : part.state === 'output-error' ? (
            <div className="mt-3 rounded-full bg-red-50 px-3 py-2 text-xs font-semibold text-red-700 dark:bg-red-950/30 dark:text-red-200">
              {part.errorText}
            </div>
          ) : null}
        </div>
      );
    }

    if (
      part.type === 'tool-getCurrentLessonArtifacts' ||
      part.type === 'tool-getLearningArtifacts' ||
      part.type === 'tool-generateCurrentLessonArtifact'
    ) {
      const shouldRenderAttachments =
        part.type === 'tool-generateCurrentLessonArtifact' ||
        (part.output &&
          typeof part.output === 'object' &&
          (part.output as { renderMode?: unknown }).renderMode === 'attachments');
      if (!shouldRenderAttachments) {
        return null;
      }

      const outputArtifacts =
        part.output &&
        typeof part.output === 'object' &&
        Array.isArray((part.output as { artifacts?: unknown }).artifacts)
          ? (part.output as { artifacts: Array<{ id?: unknown }> }).artifacts || []
          : [];
      const outputArtifactIds = new Set(
        outputArtifacts
          .map(artifact => (typeof artifact.id === 'string' ? artifact.id : ''))
          .filter(Boolean)
      );
      const isGenerating = generatingArtifactToolCallIds.has(part.toolCallId);
      const artifactPayloads =
        artifactPayloadsByToolCallId[part.toolCallId] ||
        (outputArtifactIds.size > 0
          ? originLessonArtifactPayloads.filter(artifact =>
              outputArtifactIds.has(artifact.summary.id)
            )
          : []);
      // For generateCurrentLessonArtifact, treat any "tool waiting for output"
      // state as loading too — the React batching after onToolCall can otherwise
      // delay the skeleton until the slow draft call completes, leaving the user
      // staring at an empty chat for several seconds.
      const isAwaitingArtifactOutput =
        part.type === 'tool-generateCurrentLessonArtifact' &&
        (part.state === 'input-streaming' || part.state === 'input-available');
      const canMutateArtifacts = part.type !== 'tool-getLearningArtifacts';
      return (
        <ChatArtifactRenderer
          key={`${messageId}-${part.toolCallId}`}
          actionFeedbackOverride={artifactActionFeedbackOverride}
          artifacts={artifactPayloads}
          isDarkMode={isDarkMode}
          isLoading={(isGenerating || isAwaitingArtifactOutput) && artifactPayloads.length === 0}
          openArtifactIdOverride={artifactPreviewIdOverride}
          portalContainer={artifactPortalContainer}
          regenerationLifecycle={artifactRegenerationLifecycle}
          onDiscardArtifact={canMutateArtifacts ? handleDiscardArtifact : undefined}
          onRegenerateArtifact={canMutateArtifacts ? handleRegenerateArtifact : undefined}
          onReplaceArtifact={canMutateArtifacts ? handleReplaceArtifact : undefined}
          onSaveArtifact={
            part.type === 'tool-generateCurrentLessonArtifact'
              ? handleSaveGeneratedArtifact
              : undefined
          }
        />
      );
    }

    return null;
  };

  return (
    <motion.div
      ref={contextAnswerPanelRef}
      data-context-answer-panel="true"
      className={`fixed z-50 flex flex-col overflow-hidden border border-stone-200 bg-white px-6 pb-5 pt-5 shadow-[0_10px_40px_-10px_rgba(0,0,0,0.2)] dark:border-zinc-700/60 dark:bg-zinc-800 ${
        isMobileViewport
          ? 'inset-x-0 h-[80dvh] rounded-t-[2rem] rounded-b-none border-x-0 border-b-0'
          : 'right-8 top-6 rounded-2xl animate-in slide-in-from-bottom-10 duration-500'
      }`}
      style={
        isMobileViewport
          ? {
              bottom: `${keyboardOffset}px`,
              maxHeight:
                viewportHeight === null
                  ? `calc(100dvh - ${keyboardOffset}px)`
                  : `${viewportHeight}px`,
            }
          : contextAnswerSize
      }
      initial={isMobileViewport ? { opacity: 0, transform: 'translate3d(0, 100%, 0)' } : false}
      animate={isMobileViewport ? { opacity: 1, transform: 'translate3d(0, 0, 0)' } : undefined}
      transition={isMobileViewport ? { duration: 0.15, ease: [0.2, 0.85, 0.25, 1] } : undefined}
    >
      <button
        type="button"
        data-context-answer-target="close"
        aria-label={t('Chiudi')}
        onClick={onClose}
        className="absolute right-4 top-4 rounded-full bg-gray-50 p-1 text-gray-400 hover:text-gray-600 dark:bg-zinc-700 dark:hover:text-gray-200"
      >
        <X className="h-4 w-4" />
      </button>

      <div className="mb-5 shrink-0 border-b border-stone-100/90 pb-4 pr-12 dark:border-zinc-700/60">
        <p className="mb-1.5 text-[0.7rem] font-semibold uppercase tracking-[0.18em] text-stone-400 dark:text-stone-500">
          Follow-up
        </p>
        <p className="line-clamp-2 text-sm leading-6 text-stone-500 dark:text-stone-400">
          {contextAnswer.selectedText}
        </p>
      </div>

      <div className="relative min-h-0 flex-1">
        <div
          ref={messagesContainerRef}
          data-context-answer-target="messages-scroll"
          onScroll={handleChatScroll}
          className="custom-scrollbar absolute inset-0 overflow-y-auto overflow-x-hidden pr-2"
          style={messagesScrollTopOverride === undefined ? undefined : { overflowY: 'hidden' }}
        >
          <div
            className="space-y-6 pb-5"
            style={
              messagesScrollTopOverride === undefined
                ? undefined
                : { transform: `translateY(-${Math.round(messagesScrollTopOverride)}px)` }
            }
          >
            {visibleMessages.map(message => {
              if (message.role === 'user') {
                return (
                  <div key={message.id} className="pt-2">
                    <div className="relative py-2 pl-4 font-serif text-base font-bold leading-[1.35] text-gray-900 dark:text-gray-100">
                      <span className="absolute bottom-2 left-0 top-2 w-0.5 rounded-full bg-orange-500" />
                      "{getUiMessageText(message)}"
                    </div>
                  </div>
                );
              }

              const renderableParts = getUiMessageRenderableParts(message);

              return (
                <div key={message.id} className="space-y-4">
                  <ChatToolActivityStrip
                    isMobileViewport={isMobileViewport}
                    messageId={message.id}
                    parts={message.parts}
                  />
                  {renderableParts.map(part =>
                    part.kind === 'text' ? (
                      <StreamingMarkdownRenderer
                        key={`${message.id}-${part.key}`}
                        content={part.text}
                        isStreaming={part.isStreaming}
                        isDarkMode={isDarkMode}
                        className="prose-sm prose-p:text-gray-600 dark:prose-p:text-gray-300"
                      />
                    ) : (
                      renderToolPart(part.part, `${message.id}-${part.key}`)
                    )
                  )}
                  <LibraryToolReferences
                    isResponseComplete={message.id !== activeResponseMessageId}
                    parts={message.parts}
                    onOpen={onOpenLibraryReference}
                  />
                </div>
              );
            })}

            {replacementDraftPayloads.length > 0 ? (
              <ChatArtifactRenderer
                artifacts={replacementDraftPayloads}
                isDarkMode={isDarkMode}
                onDiscardArtifact={handleDiscardArtifact}
                onRegenerateArtifact={handleRegenerateArtifact}
                onReplaceArtifact={handleReplaceArtifact}
                regenerationLifecycle={artifactRegenerationLifecycle}
              />
            ) : null}

            {isLoading ? (
              <div className="text-sm text-stone-400 dark:text-stone-500">
                {t('Sto continuando a rispondere...')}
              </div>
            ) : null}

            {error ? (
              <div
                role="alert"
                className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900/50 dark:bg-red-950/30 dark:text-red-200"
              >
                {t('Non è stato possibile ottenere una risposta. Riprova tra poco.')}
              </div>
            ) : null}
          </div>
        </div>
      </div>

      <div className="relative mt-5 shrink-0 border-t border-stone-100 pt-4 dark:border-zinc-700/60">
        <div
          className="pointer-events-none absolute -top-12 left-0 right-0 z-10 h-12 bg-gradient-to-b from-transparent to-white transition-opacity duration-200 dark:to-zinc-800"
          style={{ opacity: isChatNotAtBottom ? 1 : 0 }}
        />
        <ChatTextComposer
          value={displayedInput}
          onChange={setInput}
          onSubmit={handleSubmit}
          placeholder={
            isWaitingForNoteDecision
              ? t('Accetta o rifiuta la nota proposta per continuare...')
              : t('Chiedi un follow-up su questa risposta...')
          }
          disabled={isComposerDisabled}
          inputDataTarget={CONTEXT_ANSWER_INPUT_TARGET}
          isLoading={isLoading}
          className="flex items-center gap-2"
          trailingContent={
            isLoading ? (
              <button
                ref={contextStopButtonRef}
                type="button"
                onClick={handleStopResponse}
                disabled={isStoppingResponse}
                aria-busy={isStoppingResponse || undefined}
                aria-label={t('Annulla')}
                title={t('Annulla')}
                className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-orange-500 text-white transition-colors hover:bg-orange-600 disabled:cursor-not-allowed disabled:opacity-70 dark:bg-orange-400 dark:text-stone-950 dark:hover:bg-orange-300"
              >
                {isStoppingResponse ? (
                  <LoaderCircle className="h-4 w-4 motion-safe:animate-spin" />
                ) : (
                  <Square className="h-4 w-4 fill-current" />
                )}
              </button>
            ) : (
              <SpeechInputButton
                disabled={isComposerDisabled}
                onTranscription={handleSpeechTranscription}
              />
            )
          }
          leadingContent={
            <div ref={toolMenuRef} className="relative flex shrink-0 items-center">
              <button
                type="button"
                onClick={() => setIsToolMenuOpen(currentValue => !currentValue)}
                disabled={isComposerDisabled}
                className={`flex h-10 w-10 items-center justify-center rounded-full transition-colors ${
                  hasActiveToolPreference
                    ? 'bg-orange-100 text-orange-700 hover:bg-orange-200 dark:bg-orange-500/15 dark:text-orange-200 dark:hover:bg-orange-500/25'
                    : 'text-stone-400 hover:bg-stone-100 hover:text-stone-600 dark:text-stone-500 dark:hover:bg-zinc-700 dark:hover:text-stone-300'
                }`}
                title={t('Apri strumenti conversazione')}
                aria-expanded={isToolMenuOpen}
                aria-haspopup="menu"
              >
                <Plus className="h-4 w-4" />
              </button>

              {isToolMenuOpen ? (
                <div
                  className="absolute bottom-[calc(100%+0.55rem)] left-0 z-20 w-[min(18.5rem,calc(100vw-5rem))] overflow-hidden rounded-2xl border border-stone-200/90 bg-white p-2 shadow-[0_18px_50px_-24px_rgba(24,24,27,0.4)] dark:border-zinc-600/80 dark:bg-stone-800"
                  role="menu"
                >
                  <button
                    type="button"
                    onClick={() =>
                      setToolPreferences(currentPreferences => ({
                        ...currentPreferences,
                        annotate: !currentPreferences.annotate,
                      }))
                    }
                    className="flex w-full items-start gap-3 rounded-xl px-3 py-2.5 text-left transition-colors hover:bg-stone-100/80 dark:hover:bg-stone-700/80"
                    role="menuitemcheckbox"
                    aria-checked={toolPreferences.annotate}
                  >
                    <span
                      className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-md border ${
                        toolPreferences.annotate
                          ? 'border-orange-500 bg-orange-500 text-white dark:border-orange-400 dark:bg-orange-400 dark:text-stone-900'
                          : 'border-stone-300 text-transparent dark:border-zinc-500'
                      }`}
                    >
                      <Check className="h-3.5 w-3.5" />
                    </span>
                    <span className="min-w-0">
                      <span className="flex items-center gap-2 text-sm font-medium text-stone-800 dark:text-zinc-100">
                        <NotebookPen className="h-4 w-4 shrink-0 text-orange-600 dark:text-orange-300" />
                        {t('Annota')}
                      </span>
                      <span className="mt-1 block text-xs leading-5 text-stone-500 dark:text-zinc-400">
                        {t(
                          'Segnala con forza che vuoi trasformare il chiarimento in una nota o aggiornare quella già collegata al passaggio.'
                        )}
                      </span>
                    </span>
                  </button>

                  <button
                    type="button"
                    onClick={() =>
                      setToolPreferences(currentPreferences => ({
                        ...currentPreferences,
                        webSearch: !currentPreferences.webSearch,
                      }))
                    }
                    className="flex w-full items-start gap-3 rounded-xl px-3 py-2.5 text-left transition-colors hover:bg-stone-100/80 dark:hover:bg-stone-700/80"
                    role="menuitemcheckbox"
                    aria-checked={toolPreferences.webSearch}
                  >
                    <span
                      className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-md border ${
                        toolPreferences.webSearch
                          ? 'border-orange-500 bg-orange-500 text-white dark:border-orange-400 dark:bg-orange-400 dark:text-stone-900'
                          : 'border-stone-300 text-transparent dark:border-zinc-500'
                      }`}
                    >
                      <Check className="h-3.5 w-3.5" />
                    </span>
                    <span className="min-w-0">
                      <span className="flex items-center gap-2 text-sm font-medium text-stone-800 dark:text-zinc-100">
                        <Globe className="h-4 w-4 shrink-0 text-orange-600 dark:text-orange-300" />
                        {t('Cerca sul web')}
                      </span>
                      <span className="mt-1 block text-xs leading-5 text-stone-500 dark:text-zinc-400">
                        {t(
                          'Dai priorita a grounding e verifica con fonti esterne quando servono informazioni aggiornate o non presenti nel testo.'
                        )}
                      </span>
                    </span>
                  </button>

                  <button
                    type="button"
                    onClick={() =>
                      setToolPreferences(currentPreferences => ({
                        ...currentPreferences,
                        generateArtifacts: !currentPreferences.generateArtifacts,
                      }))
                    }
                    className="flex w-full items-start gap-3 rounded-xl px-3 py-2.5 text-left transition-colors hover:bg-stone-100/80 dark:hover:bg-stone-700/80"
                    role="menuitemcheckbox"
                    aria-checked={toolPreferences.generateArtifacts}
                  >
                    <span
                      className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-md border ${
                        toolPreferences.generateArtifacts
                          ? 'border-orange-500 bg-orange-500 text-white dark:border-orange-400 dark:bg-orange-400 dark:text-stone-900'
                          : 'border-stone-300 text-transparent dark:border-zinc-500'
                      }`}
                    >
                      <Check className="h-3.5 w-3.5" />
                    </span>
                    <span className="min-w-0">
                      <span className="flex items-center gap-2 text-sm font-medium text-stone-800 dark:text-zinc-100">
                        <Sparkles className="h-4 w-4 shrink-0 text-orange-600 dark:text-orange-300" />
                        {t('Genera artefatti visuali')}
                      </span>
                      <span className="mt-1 block text-xs leading-5 text-stone-500 dark:text-zinc-400">
                        {t(
                          'Crea automaticamente mappe, grafici, diagrammi e widget per visualizzare i concetti del follow-up.'
                        )}
                      </span>
                    </span>
                  </button>
                </div>
              ) : null}
            </div>
          }
          inputShellClassName="min-w-0 flex-1 rounded-full border border-stone-200/80 bg-stone-50/80 px-3 py-1.5 transition-colors focus-within:border-stone-300 focus-within:bg-white dark:border-stone-500/80 dark:bg-stone-700/70 dark:focus-within:border-stone-400 dark:focus-within:bg-stone-700"
          inputClassName="h-10 w-full min-w-0 border-0 bg-transparent px-2 text-sm text-stone-800 outline-none placeholder:text-stone-400 dark:text-stone-100 dark:placeholder:text-stone-400"
          submitButtonClassName={`${isLoading ? 'hidden' : 'flex'} h-10 w-10 shrink-0 items-center justify-center rounded-full bg-stone-900 text-stone-50 transition-colors hover:bg-stone-700 disabled:bg-stone-200 disabled:text-stone-500 dark:bg-stone-100 dark:text-stone-900 dark:hover:bg-white dark:disabled:bg-stone-700 dark:disabled:text-stone-500`}
          submitDataTarget={CONTEXT_ANSWER_SUBMIT_TARGET}
        />

        {hasActiveToolPreference ? (
          <div className="mt-2 flex flex-wrap gap-2">
            {toolPreferences.annotate ? (
              <span className="inline-flex items-center gap-2 rounded-full border border-orange-200 bg-orange-50/80 px-3 py-1.5 text-xs font-medium text-orange-700 dark:border-orange-500/40 dark:bg-orange-500/10 dark:text-orange-200">
                <NotebookPen className="h-3.5 w-3.5" />
                {t('Annota attivo')}
              </span>
            ) : null}
            {toolPreferences.generateArtifacts ? (
              <span className="inline-flex items-center gap-2 rounded-full border border-orange-200 bg-orange-50/80 px-3 py-1.5 text-xs font-medium text-orange-700 dark:border-orange-500/40 dark:bg-orange-500/10 dark:text-orange-200">
                <Sparkles className="h-3.5 w-3.5" />
                {t('Artefatti visuali attivi')}
              </span>
            ) : null}
            {toolPreferences.webSearch ? (
              <span className="inline-flex items-center gap-2 rounded-full border border-orange-200 bg-orange-50/80 px-3 py-1.5 text-xs font-medium text-orange-700 dark:border-orange-500/40 dark:bg-orange-500/10 dark:text-orange-200">
                <Globe className="h-3.5 w-3.5" />
                {t('Cerca sul web attivo')}
              </span>
            ) : null}
          </div>
        ) : null}
      </div>

      {!isMobileViewport ? (
        <button
          type="button"
          aria-label={t('Ridimensiona pannello risposta')}
          onPointerDown={handleContextAnswerResizeStart}
          className="absolute bottom-3 left-3 flex h-6 w-6 cursor-nesw-resize touch-none items-end justify-start rounded-md text-stone-300 transition-colors hover:bg-stone-100 hover:text-stone-500 dark:text-stone-500 dark:hover:bg-zinc-700 dark:hover:text-stone-300"
        >
          <svg viewBox="0 0 16 16" fill="none" className="h-4 w-4">
            <title>{t('Ridimensiona pannello risposta')}</title>
            <path d="M1 1L15 15" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            <path d="M1 5L11 15" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            <path d="M1 9L7 15" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        </button>
      ) : null}
    </motion.div>
  );
}
