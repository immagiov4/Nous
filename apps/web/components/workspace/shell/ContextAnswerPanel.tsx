import { useChat } from '@ai-sdk/react';
import {
  DefaultChatTransport,
  isToolUIPart,
  lastAssistantMessageIsCompleteWithToolCalls,
  type UIMessage,
} from 'ai';
import {
  Check,
  Globe,
  LoaderCircle,
  NotebookPen,
  Plus,
  Sparkles,
  StickyNote,
  X,
} from 'lucide-react';
import {
  type PointerEvent as ReactPointerEvent,
  type RefObject,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useMobileKeyboardOffset } from '../../../hooks/useMobileKeyboardOffset.ts';
import { fetchWithSupabaseAuth } from '../../../services/auth/supabaseAuth.ts';
import type { GeneratedLessonArtifactDraft } from '../../../services/openrouter/artifactDrafts.ts';
import { generateLessonArtifactDraft } from '../../../services/openrouter/artifactDrafts.ts';
import { getBackendUrl } from '../../../services/openrouter/config.ts';
import type {
  LearningArtifactRenderPayload,
  LearningSection,
  LessonGeneratedVisual,
} from '../../../types.ts';
import { buildConversationNoteSaveCandidates } from '../../../utils/context/conversationNote.ts';
import {
  filterLearningArtifactPayloads,
  summarizeLearningArtifacts,
} from '../../../utils/learning/artifacts.ts';
import {
  dedupeUiMessagesById,
  getUiMessageRenderableParts,
  getUiMessageText,
} from '../../../utils/uiChat.ts';
import type {
  ChatArtifactActionRequest,
  ChatArtifactRegenerateRequest,
  ChatArtifactReplaceRequest,
} from '../../shared/ChatArtifactRenderer.tsx';
import ChatArtifactRenderer from '../../shared/ChatArtifactRenderer.tsx';
import {
  appendSpeechTranscription,
  default as SpeechInputButton,
} from '../../shared/SpeechInputButton.tsx';
import StreamingMarkdownRenderer from '../../shared/StreamingMarkdownRenderer.tsx';
import ChatTextComposer from '../chat/ChatTextComposer.tsx';
import type {
  ContextAnswerSize,
  ContextAnswerState,
  ContextChatToolPreferences,
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

interface RequestAddToNotesOutput {
  approved: boolean;
  mode: RequestAddToNotesMode;
  saved: boolean;
  annotationId?: string;
  error?: string;
}

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

interface ContextRequestState {
  attachedAnnotationNote?: string;
  attachedAnnotationText?: string;
  contextAfter?: string;
  contextBefore?: string;
  contextScope?: ContextAnswerState['contextScope'];
  lessonContent?: string;
  lessonDescription?: string;
  lessonTitle?: string;
  selectedText: string;
  sourceKind?: ContextAnswerState['sourceKind'];
  sourceMaterial?: string;
  sourceName?: string;
  toolPreferences: ContextChatToolPreferences;
}

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
  contextAnswer: ContextAnswerState;
  contextAnswerPanelRef: RefObject<HTMLDivElement | null>;
  contextAnswerSize: ContextAnswerSize;
  handleContextAnswerResizeStart: (event: ReactPointerEvent<HTMLButtonElement>) => void;
  isDarkMode: boolean;
  isMobileViewport: boolean;
  currentLessonArtifactPayloads?: LearningArtifactRenderPayload[];
  onClose: () => void;
  onSaveConversationNote: (input: SaveConversationNoteInput) => Promise<SaveConversationNoteResult>;
  onUpdateConversationNote: (
    input: SaveConversationNoteInput
  ) => Promise<SaveConversationNoteResult>;
  /** Saves a generated visual artifact directly as a lesson-level annotation. */
  onSaveArtifactToLesson?: (
    visual: LessonGeneratedVisual,
    artifactRef: { artifactId: string; kind: 'generated-visual'; title: string }
  ) => Promise<void>;
  /** Replaces an already saved generated visual while preserving its artifact identity. */
  onReplaceArtifactInLesson?: (artifactId: string, visual: LessonGeneratedVisual) => Promise<void>;
}

const toolCardClassName =
  'rounded-[1.4rem] border border-stone-200/90 bg-[#fbf7ef] px-4 py-3 text-sm text-stone-700 shadow-[0_12px_28px_-22px_rgba(46,34,16,0.55)] dark:border-stone-400/95 dark:bg-stone-700/90 dark:text-stone-200';
const autoSubmittedInitialQuestionIds = new Set<string>();

// If a requestAddToNotes tool stays in input-available without valid input,
// show fallback buttons after this many ms and auto-reject after HARD_TIMEOUT_MS.
const STUCK_TOOL_GRACE_MS = 2_000;
const STUCK_TOOL_HARD_TIMEOUT_MS = 15_000;
const REPLACEMENT_DRAFT_TOOL_CALL_PREFIX = 'replacement-draft';
const contextRequestStateStore = new Map<symbol, ContextRequestState>();

export default function ContextAnswerPanel({ ...props }: ContextAnswerPanelProps) {
  return <ContextAnswerPanelSession key={props.contextAnswer.id} {...props} />;
}

function ContextAnswerPanelSession({
  contextAnswer,
  contextAnswerPanelRef,
  contextAnswerSize,
  handleContextAnswerResizeStart,
  isDarkMode,
  isMobileViewport,
  currentLessonArtifactPayloads = [],
  onClose,
  onSaveConversationNote,
  onUpdateConversationNote,
  onSaveArtifactToLesson,
  onReplaceArtifactInLesson,
}: ContextAnswerPanelProps) {
  const [input, setInput] = useState('');
  const [isToolMenuOpen, setIsToolMenuOpen] = useState(false);
  const [, setIsChatScrolled] = useState(false);
  const [isChatNotAtBottom, setIsChatNotAtBottom] = useState(false);
  const handleChatScroll = () => {
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
    Record<string, LessonGeneratedVisual>
  >({});
  const [generatingArtifactToolCallIds, setGeneratingArtifactToolCallIds] = useState<Set<string>>(
    new Set()
  );
  const hasSubmittedInitialQuestionRef = useRef(false);
  const toolMenuRef = useRef<HTMLDivElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const selectionAnchorRef = useRef<ConversationSelectionAnchor>({
    contextAfter: contextAnswer.contextAfter,
    contextBefore: contextAnswer.contextBefore,
    selectedText: contextAnswer.selectedText,
  });

  // Tracks when each requestAddToNotes part entered input-available without
  // valid input, so we can show fallback buttons after GRACE and auto-reject
  // after HARD_TIMEOUT.
  const stuckToolTimestampsRef = useRef<Map<string, number>>(new Map());
  const latestGeneratedArtifactIdRef = useRef<string | null>(null);
  const [expiredGraceTools, setExpiredGraceTools] = useState<Set<string>>(new Set());
  const [processingNoteToolCallIds, setProcessingNoteToolCallIds] = useState<Set<string>>(
    new Set()
  );

  const { keyboardOffset } = useMobileKeyboardOffset();

  useEffect(() => {
    selectionAnchorRef.current = {
      contextAfter: contextAnswer.contextAfter,
      contextBefore: contextAnswer.contextBefore,
      selectedText: contextAnswer.selectedText,
    };
  }, [contextAnswer.contextAfter, contextAnswer.contextBefore, contextAnswer.selectedText]);

  const requestStateKey = useMemo(() => Symbol('context-request-state'), []);

  useEffect(() => {
    contextRequestStateStore.set(requestStateKey, {
      attachedAnnotationNote: contextAnswer.attachedAnnotationNote,
      attachedAnnotationText: contextAnswer.attachedAnnotationText,
      contextAfter: contextAnswer.contextAfter,
      contextBefore: contextAnswer.contextBefore,
      contextScope: contextAnswer.contextScope,
      lessonContent: contextAnswer.lessonContent,
      lessonDescription: contextAnswer.lessonDescription,
      lessonTitle: contextAnswer.lessonTitle,
      selectedText: contextAnswer.selectedText,
      sourceKind: contextAnswer.sourceKind,
      sourceMaterial: contextAnswer.sourceMaterial,
      sourceName: contextAnswer.sourceName,
      toolPreferences,
    });

    return () => {
      contextRequestStateStore.delete(requestStateKey);
    };
  }, [
    contextAnswer.attachedAnnotationNote,
    contextAnswer.attachedAnnotationText,
    contextAnswer.contextAfter,
    contextAnswer.contextBefore,
    contextAnswer.contextScope,
    contextAnswer.lessonContent,
    contextAnswer.lessonDescription,
    contextAnswer.lessonTitle,
    contextAnswer.selectedText,
    contextAnswer.sourceKind,
    contextAnswer.sourceMaterial,
    contextAnswer.sourceName,
    requestStateKey,
    toolPreferences,
  ]);

  const transport = useMemo(
    () =>
      new DefaultChatTransport<ContextChatMessage>({
        api: `${getBackendUrl()}/api/chat/context`,
        fetch: fetchWithSupabaseAuth,
        // `useChat` keeps the initial transport instance, so request data must come from a ref.
        prepareSendMessagesRequest: ({ headers, id, messages }) => {
          const currentRequestState = contextRequestStateStore.get(requestStateKey);
          if (!currentRequestState) {
            throw new Error('Context request state is not initialized.');
          }

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
              selectedText: currentRequestState.selectedText,
              sourceKind: currentRequestState.sourceKind,
              sourceMaterial: currentRequestState.sourceMaterial,
              sourceName: currentRequestState.sourceName,
              attachedAnnotationNote: currentRequestState.attachedAnnotationNote,
              attachedAnnotationText: currentRequestState.attachedAnnotationText,
              toolPreferences: currentRequestState.toolPreferences,
            },
          };
        },
      }),
    [requestStateKey]
  );

  const { addToolOutput, error, messages, sendMessage, status } = useChat<ContextChatMessage>({
    id: contextAnswer.id,
    messages: [],
    transport,
    experimental_throttle: 96,
    sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithToolCalls,
    onToolCall: async ({ toolCall }) => {
      if (toolCall.dynamic) {
        return;
      }

      if (toolCall.toolName === 'getCurrentLessonArtifacts') {
        const artifactInput = readCurrentLessonArtifactsToolInput(toolCall.input);
        const matchingPayloads = filterLearningArtifactPayloads(currentLessonArtifactPayloads, {
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
        const currentState = contextRequestStateStore.get(requestStateKey);
        const draftLesson = buildContextDraftLesson(contextAnswer, currentState);
        const allArtifactPayloads = [
          ...currentLessonArtifactPayloads,
          ...Object.values(artifactPayloadsByToolCallId).flat(),
        ];
        const sourceArtifactId =
          artifactInput?.sourceArtifactId ||
          (artifactInput?.mode === 'replacement-draft'
            ? latestGeneratedArtifactIdRef.current || undefined
            : undefined);
        const sourceArtifact = sourceArtifactId
          ? allArtifactPayloads.find(
              payload =>
                payload.summary.id === sourceArtifactId &&
                payload.summary.kind === 'generated-visual' &&
                'visual' in payload
            )
          : undefined;

        if (!artifactInput || !contextAnswer.projectId || !draftLesson || !currentState) {
          void addToolOutput({
            tool: 'generateCurrentLessonArtifact',
            toolCallId: toolCall.toolCallId,
            output: {
              artifact: null,
              error: 'Non ho abbastanza contesto per generare un artefatto su questa lezione.',
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
              error: 'Non ho trovato un artefatto generato modificabile da usare come sorgente.',
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
          draft = await generateLessonArtifactDraft({
            contextAfter: currentState.contextAfter,
            contextBefore: currentState.contextBefore,
            generationNotes: undefined,
            lesson: draftLesson,
            mode: artifactInput.mode,
            projectId: contextAnswer.projectId,
            projectTitle: contextAnswer.projectTitle || 'Corso',
            prompt: artifactInput.prompt,
            revisionInstructions: artifactInput.revisionInstructions,
            selectedText: currentState.selectedText,
            sourceArtifact,
            sourceArtifactId,
          });
        } finally {
          setGeneratingArtifactToolCallIds(prev => {
            if (!prev.has(toolCall.toolCallId)) return prev;
            const next = new Set(prev);
            next.delete(toolCall.toolCallId);
            return next;
          });
        }

        if (!draft) {
          void addToolOutput({
            tool: 'generateCurrentLessonArtifact',
            toolCallId: toolCall.toolCallId,
            output: {
              artifact: null,
              error:
                'Non sono riuscito a generare un artefatto visuale utile per questa richiesta.',
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
    },
  });

  const artifactPayloadsById = useMemo(() => {
    const payloads = [
      ...currentLessonArtifactPayloads,
      ...Object.values(artifactPayloadsByToolCallId).flat(),
    ];
    return new Map(payloads.map(payload => [payload.summary.id, payload]));
  }, [artifactPayloadsByToolCallId, currentLessonArtifactPayloads]);
  const replacementDraftPayloads = useMemo(
    () =>
      Object.entries(artifactPayloadsByToolCallId).flatMap(([toolCallId, payloads]) =>
        toolCallId.startsWith(REPLACEMENT_DRAFT_TOOL_CALL_PREFIX) ? payloads : []
      ),
    [artifactPayloadsByToolCallId]
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

    const currentState = contextRequestStateStore.get(requestStateKey);
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

      const noteArtifactIds =
        inputValue.artifactIds && inputValue.artifactIds.length > 0
          ? inputValue.artifactIds
          : latestGeneratedArtifactIdRef.current
            ? [latestGeneratedArtifactIdRef.current]
            : [];
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
            const visual = generatedVisualsByArtifactId[artifactId];
            return visual ? [visual] : [];
          }),
          note: inputValue.noteDraft,
          selectedText: inputValue.selectedTextDraft,
        },
      });

      for (const candidate of candidates) {
        const result = await runMutation(candidate);
        lastResult = result;
        if (result.saved) {
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
              ? 'Non sono riuscito ad aggiornare la nota.'
              : 'Non sono riuscito a salvare la nota.'),
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

  const handleSaveGeneratedArtifact = async ({
    artifactId,
  }: ChatArtifactActionRequest): Promise<void> => {
    const payload = artifactPayloadsById.get(artifactId);
    if (!payload || !('visual' in payload)) return;

    const visual = generatedVisualsByArtifactId[artifactId];
    if (!visual) return;

    const artifactRef = {
      artifactId,
      kind: 'generated-visual',
      title: payload.summary.title,
    } as const;
    const currentState = contextRequestStateStore.get(requestStateKey);
    const hasExistingNote = Boolean(currentState?.attachedAnnotationNote?.trim());
    const runMutation = hasExistingNote ? onUpdateConversationNote : onSaveConversationNote;
    const candidates = buildConversationNoteSaveCandidates({
      anchor: selectionAnchorRef.current,
      toolInput: {
        artifactRefs: [artifactRef],
        generatedVisuals: [visual],
        note: currentState?.attachedAnnotationNote || '',
        selectedText: selectionAnchorRef.current.selectedText,
      },
    });

    for (const candidate of candidates) {
      const result = await runMutation(candidate);
      if (result.saved) {
        return;
      }
    }

    if (onSaveArtifactToLesson) {
      await onSaveArtifactToLesson(visual, artifactRef);
    }
  };

  const handleRegenerateArtifact = async ({
    artifactId,
    instructions,
  }: ChatArtifactRegenerateRequest): Promise<boolean> => {
    const payload = artifactPayloadsById.get(artifactId);
    const currentState = contextRequestStateStore.get(requestStateKey);
    const draftLesson = buildContextDraftLesson(contextAnswer, currentState);
    if (!payload || !('visual' in payload) || !contextAnswer.projectId || !draftLesson)
      return false;

    const draft = await generateLessonArtifactDraft({
      contextAfter: currentState?.contextAfter,
      contextBefore: currentState?.contextBefore,
      lesson: draftLesson,
      mode: 'replacement-draft',
      projectId: contextAnswer.projectId,
      projectTitle: contextAnswer.projectTitle || 'Corso',
      prompt: `Modifica l artefatto "${payload.summary.title}".`,
      revisionInstructions: instructions,
      selectedText: currentState?.selectedText,
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
  }: ChatArtifactReplaceRequest): Promise<void> => {
    const payload = artifactPayloadsById.get(artifactId);
    const visual = generatedVisualsByArtifactId[artifactId];
    if (!payload || !('visual' in payload) || !visual || !onReplaceArtifactInLesson) {
      return;
    }

    await onReplaceArtifactInLesson(replacementOfArtifactId, visual);
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
  const isWaitingForNoteDecision = hasPendingAddToNotesRequest(messages);
  const isComposerDisabled = status === 'submitted' || isWaitingForNoteDecision;
  const hasActiveToolPreference =
    toolPreferences.annotate || toolPreferences.generateArtifacts || toolPreferences.webSearch;

  // biome-ignore lint/correctness/useExhaustiveDependencies: messages.length triggers scroll on new arrival
  useEffect(() => {
    if (!messagesContainerRef.current) return;
    messagesContainerRef.current.scrollTop = messagesContainerRef.current.scrollHeight;
  }, [messages.length]);

  const handleSubmit = () => {
    if (isComposerDisabled) {
      return;
    }

    const trimmedInput = input.trim();
    if (!trimmedInput) {
      return;
    }

    setInput('');
    setIsToolMenuOpen(false);
    void sendMessage({ text: trimmedInput });
  };

  const handleSpeechTranscription = (transcription: string) => {
    setInput(currentInput => appendSpeechTranscription(currentInput, transcription));
  };

  const visibleMessages = dedupeUiMessagesById(messages).filter(message => {
    if (message.role === 'user') {
      return true;
    }

    return getUiMessageRenderableParts(message).length > 0;
  });

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
      const cardTitle = hasExistingNote
        ? 'Vuoi aggiornare la nota collegata?'
        : 'Vuoi aggiungerlo alle note?';
      const approveLabel = hasExistingNote ? 'Aggiorna nota' : 'Aggiungi alle note';

      const renderResultPill = () => {
        if (!outputValue) {
          return null;
        }

        if (!outputValue.approved) {
          return (
            <div className="mt-3 inline-flex items-center gap-2 rounded-full bg-white/80 px-3 py-2 text-xs font-semibold text-stone-600 dark:bg-stone-800/60 dark:text-stone-200">
              <Check className="h-3.5 w-3.5" />
              <span>Richiesta rifiutata, la conversazione continua senza salvare.</span>
            </div>
          );
        }

        if (outputValue.saved) {
          return (
            <div className="mt-3 inline-flex items-center gap-2 rounded-full bg-white/80 px-3 py-2 text-xs font-semibold text-stone-600 dark:bg-stone-800/60 dark:text-stone-200">
              <Check className="h-3.5 w-3.5" />
              <span>{outputValue.mode === 'update' ? 'Nota aggiornata.' : 'Nota salvata.'}</span>
            </div>
          );
        }

        return (
          <div className="mt-3 rounded-full bg-red-50 px-3 py-2 text-xs font-semibold text-red-700 dark:bg-red-950/30 dark:text-red-200">
            {outputValue.error ||
              (outputValue.mode === 'update'
                ? 'Non sono riuscito ad aggiornare la nota.'
                : 'Non sono riuscito a salvare la nota.')}
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
            {inputValue?.rationale || 'Sto preparando il suggerimento da salvare nelle note.'}
          </p>

          {inputValue ? (
            <div className="mt-3 space-y-2 rounded-[1rem] bg-white/70 px-3 py-2 dark:bg-stone-800/50">
              <p className="text-[0.7rem] font-semibold uppercase tracking-[0.16em] text-stone-400 dark:text-stone-500">
                Passaggio proposto
              </p>
              <p className="text-sm leading-6 text-stone-700 dark:text-stone-200">
                "{inputValue.selectedTextDraft}"
              </p>
              <p className="text-[0.7rem] font-semibold uppercase tracking-[0.16em] text-stone-400 dark:text-stone-500">
                {hasExistingNote ? 'Nuova versione della nota' : 'Nota proposta'}
              </p>
              <p className="whitespace-pre-wrap text-sm leading-6 text-stone-700 dark:text-stone-200">
                {inputValue.noteDraft}
              </p>
              {noteArtifactPayloads.length > 0 ? (
                <div className="pt-1">
                  <ChatArtifactRenderer artifacts={noteArtifactPayloads} isDarkMode={isDarkMode} />
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
                  No grazie
                </button>
                <button
                  type="button"
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
                Suggerimento non disponibile. Puoi riprovare.
              </div>
              <div className="flex flex-wrap justify-end gap-2">
                <button
                  type="button"
                  onClick={() => handleRejectNoteRequest(part.toolCallId)}
                  className="rounded-full px-3 py-2 text-xs font-semibold text-stone-500 transition-colors hover:bg-stone-200/70 hover:text-stone-700 dark:text-stone-400 dark:hover:bg-stone-600 dark:hover:text-stone-100"
                >
                  No grazie
                </button>
              </div>
            </div>
          ) : part.state === 'input-available' ? (
            <div className="mt-3 inline-flex items-center gap-2 rounded-full bg-white/80 px-3 py-2 text-xs font-semibold text-stone-600 dark:bg-stone-800/60 dark:text-stone-200">
              <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
              <span>Sto caricando i dettagli della nota proposta...</span>
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
          ? currentLessonArtifactPayloads.filter(artifact =>
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
      return (
        <ChatArtifactRenderer
          key={`${messageId}-${part.toolCallId}`}
          artifacts={artifactPayloads}
          isDarkMode={isDarkMode}
          isLoading={(isGenerating || isAwaitingArtifactOutput) && artifactPayloads.length === 0}
          onDiscardArtifact={handleDiscardArtifact}
          onRegenerateArtifact={handleRegenerateArtifact}
          onReplaceArtifact={handleReplaceArtifact}
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
    <div
      ref={contextAnswerPanelRef}
      className={`fixed z-50 flex flex-col overflow-hidden rounded-2xl border border-stone-200 bg-white px-6 pb-5 pt-5 shadow-[0_10px_40px_-10px_rgba(0,0,0,0.2)] animate-in slide-in-from-bottom-10 duration-500 dark:border-zinc-700/60 dark:bg-zinc-800 ${
        isMobileViewport ? 'inset-x-3 top-24' : 'top-6 right-8'
      }`}
      style={
        isMobileViewport
          ? {
              bottom: `calc(6rem + ${keyboardOffset}px)`,
              maxHeight: `calc(100dvh - 6rem - ${keyboardOffset}px)`,
            }
          : contextAnswerSize
      }
    >
      <button
        type="button"
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
          onScroll={handleChatScroll}
          className="custom-scrollbar absolute inset-0 overflow-y-auto overflow-x-hidden pr-2"
        >
          <div className="space-y-6 pb-5">
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
              />
            ) : null}

            {isLoading ? (
              <div className="text-sm text-stone-400 dark:text-stone-500">
                Sto continuando a rispondere...
              </div>
            ) : null}

            {error ? (
              <div className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900/50 dark:bg-red-950/30 dark:text-red-200">
                {error.message}
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
          value={input}
          onChange={setInput}
          onSubmit={handleSubmit}
          placeholder={
            isWaitingForNoteDecision
              ? 'Accetta o rifiuta la nota proposta per continuare...'
              : 'Chiedi un follow-up su questa risposta...'
          }
          disabled={isComposerDisabled}
          isLoading={isLoading}
          className="flex items-center gap-2"
          trailingContent={
            <SpeechInputButton
              disabled={isComposerDisabled}
              onTranscription={handleSpeechTranscription}
            />
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
                title="Apri strumenti conversazione"
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
                        Annota
                      </span>
                      <span className="mt-1 block text-xs leading-5 text-stone-500 dark:text-zinc-400">
                        Segnala con forza che vuoi trasformare il chiarimento in una nota o
                        aggiornare quella già collegata al passaggio.
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
                        Cerca sul web
                      </span>
                      <span className="mt-1 block text-xs leading-5 text-stone-500 dark:text-zinc-400">
                        Dai priorita a grounding e verifica con fonti esterne quando servono
                        informazioni aggiornate o non presenti nel testo.
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
                        Genera artefatti visuali
                      </span>
                      <span className="mt-1 block text-xs leading-5 text-stone-500 dark:text-zinc-400">
                        Crea automaticamente mappe, grafici, diagrammi e widget per visualizzare i
                        concetti del follow-up.
                      </span>
                    </span>
                  </button>
                </div>
              ) : null}
            </div>
          }
          inputShellClassName="min-w-0 flex-1 rounded-full border border-stone-200/80 bg-stone-50/80 px-3 py-1.5 transition-colors focus-within:border-stone-300 focus-within:bg-white dark:border-stone-500/80 dark:bg-stone-700/70 dark:focus-within:border-stone-400 dark:focus-within:bg-stone-700"
          inputClassName="h-10 w-full min-w-0 border-0 bg-transparent px-2 text-sm text-stone-800 outline-none placeholder:text-stone-400 dark:text-stone-100 dark:placeholder:text-stone-400"
          submitButtonClassName="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-stone-900 text-stone-50 transition-colors hover:bg-stone-700 disabled:bg-stone-200 disabled:text-stone-500 dark:bg-stone-100 dark:text-stone-900 dark:hover:bg-white dark:disabled:bg-stone-700 dark:disabled:text-stone-500"
        />

        {hasActiveToolPreference ? (
          <div className="mt-2 flex flex-wrap gap-2">
            {toolPreferences.annotate ? (
              <span className="inline-flex items-center gap-2 rounded-full border border-orange-200 bg-orange-50/80 px-3 py-1.5 text-xs font-medium text-orange-700 dark:border-orange-500/40 dark:bg-orange-500/10 dark:text-orange-200">
                <NotebookPen className="h-3.5 w-3.5" />
                Annota attivo
              </span>
            ) : null}
            {toolPreferences.generateArtifacts ? (
              <span className="inline-flex items-center gap-2 rounded-full border border-orange-200 bg-orange-50/80 px-3 py-1.5 text-xs font-medium text-orange-700 dark:border-orange-500/40 dark:bg-orange-500/10 dark:text-orange-200">
                <Sparkles className="h-3.5 w-3.5" />
                Artefatti visuali attivi
              </span>
            ) : null}
            {toolPreferences.webSearch ? (
              <span className="inline-flex items-center gap-2 rounded-full border border-orange-200 bg-orange-50/80 px-3 py-1.5 text-xs font-medium text-orange-700 dark:border-orange-500/40 dark:bg-orange-500/10 dark:text-orange-200">
                <Globe className="h-3.5 w-3.5" />
                Cerca sul web attivo
              </span>
            ) : null}
          </div>
        ) : null}
      </div>

      {!isMobileViewport ? (
        <button
          type="button"
          aria-label="Ridimensiona pannello risposta"
          onPointerDown={handleContextAnswerResizeStart}
          className="absolute bottom-3 left-3 flex h-6 w-6 cursor-nesw-resize touch-none items-end justify-start rounded-md text-stone-300 transition-colors hover:bg-stone-100 hover:text-stone-500 dark:text-stone-500 dark:hover:bg-zinc-700 dark:hover:text-stone-300"
        >
          <svg viewBox="0 0 16 16" fill="none" className="h-4 w-4">
            <title>Ridimensiona pannello risposta</title>
            <path d="M1 1L15 15" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            <path d="M1 5L11 15" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            <path d="M1 9L7 15" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        </button>
      ) : null}
    </div>
  );
}
