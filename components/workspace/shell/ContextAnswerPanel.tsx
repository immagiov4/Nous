import {
  DefaultChatTransport,
  isToolUIPart,
  lastAssistantMessageIsCompleteWithToolCalls,
  type UIMessage,
} from 'ai';
import { useChat } from '@ai-sdk/react';
import { Check, Globe, LoaderCircle, NotebookPen, Plus, StickyNote, X } from 'lucide-react';
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from 'react';

import StreamingMarkdownRenderer from '../../shared/StreamingMarkdownRenderer.tsx';
import ChatTextComposer from '../chat/ChatTextComposer.tsx';
import { getBackendUrl } from '../../../services/openrouter/config.ts';
import { buildConversationNoteSaveCandidates } from '../../../utils/context/conversationNote.ts';
import {
  dedupeUiMessagesById,
  getUiMessageRenderableParts,
  getUiMessageText,
} from '../../../utils/uiChat.ts';
import type {
  ConversationSelectionAnchor,
  ContextChatToolPreferences,
  ContextAnswerSize,
  ContextAnswerState,
  SaveConversationNoteInput,
  SaveConversationNoteResult,
  SaveConversationNoteToolInput,
} from './types.ts';

interface RequestAddToNotesInput {
  noteDraft: string;
  rationale: string;
  selectedTextDraft: string;
}

interface RequestAddToNotesOutput {
  approved: boolean;
}

const isRequestAddToNotesInput = (value: unknown): value is RequestAddToNotesInput => {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const candidate = value as Partial<RequestAddToNotesInput>;
  return (
    typeof candidate.noteDraft === 'string' &&
    typeof candidate.rationale === 'string' &&
    typeof candidate.selectedTextDraft === 'string'
  );
};

const isRequestAddToNotesOutput = (value: unknown): value is RequestAddToNotesOutput => {
  if (!value || typeof value !== 'object') {
    return false;
  }

  return typeof (value as Partial<RequestAddToNotesOutput>).approved === 'boolean';
};

const isSaveConversationNoteResult = (value: unknown): value is SaveConversationNoteResult => {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const candidate = value as Partial<SaveConversationNoteResult>;
  return typeof candidate.saved === 'boolean' && typeof candidate.merged === 'boolean';
};

const isSaveConversationNoteToolInput = (value: unknown): value is SaveConversationNoteToolInput => {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const candidate = value as Partial<SaveConversationNoteToolInput>;
  return (
    typeof candidate.note === 'string' &&
    candidate.note.trim().length > 0 &&
    typeof candidate.selectedText === 'string' &&
    candidate.selectedText.trim().length > 0
  );
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
  saveConversationNote: {
    input: SaveConversationNoteToolInput;
    output: SaveConversationNoteResult;
  };
  updateConversationNote: {
    input: SaveConversationNoteToolInput;
    output: SaveConversationNoteResult;
  };
}

type ContextChatMessage = UIMessage<unknown, Record<string, never>, ContextChatTools>;

interface ContextAnswerPanelProps {
  contextAnswer: ContextAnswerState;
  contextAnswerPanelRef: RefObject<HTMLDivElement | null>;
  contextAnswerSize: ContextAnswerSize;
  handleContextAnswerResizeStart: (event: ReactPointerEvent<HTMLButtonElement>) => void;
  isDarkMode: boolean;
  isMobileViewport: boolean;
  onClose: () => void;
  onSaveConversationNote: (
    input: SaveConversationNoteInput
  ) => Promise<SaveConversationNoteResult>;
  onUpdateConversationNote: (
    input: SaveConversationNoteInput
  ) => Promise<SaveConversationNoteResult>;
}

const toolCardClassName =
  'rounded-[1.4rem] border border-stone-200/90 bg-[#fbf7ef] px-4 py-3 text-sm text-stone-700 shadow-[0_12px_28px_-22px_rgba(46,34,16,0.55)] dark:border-stone-400/95 dark:bg-stone-700/90 dark:text-stone-200';
const autoSubmittedInitialQuestionIds = new Set<string>();

export default function ContextAnswerPanel({
  contextAnswer,
  contextAnswerPanelRef,
  contextAnswerSize,
  handleContextAnswerResizeStart,
  isDarkMode,
  isMobileViewport,
  onClose,
  onSaveConversationNote,
  onUpdateConversationNote,
}: ContextAnswerPanelProps) {
  const [input, setInput] = useState('');
  const [isToolMenuOpen, setIsToolMenuOpen] = useState(false);
  const [toolPreferences, setToolPreferences] = useState<ContextChatToolPreferences>({
    annotate: false,
    webSearch: false,
  });
  const hasSubmittedInitialQuestionRef = useRef(false);
  const toolMenuRef = useRef<HTMLDivElement>(null);
  const selectionAnchorRef = useRef<ConversationSelectionAnchor>({
    contextAfter: contextAnswer.contextAfter,
    contextBefore: contextAnswer.contextBefore,
    selectedText: contextAnswer.selectedText,
  });

  useEffect(() => {
    selectionAnchorRef.current = {
      contextAfter: contextAnswer.contextAfter,
      contextBefore: contextAnswer.contextBefore,
      selectedText: contextAnswer.selectedText,
    };
  }, [
    contextAnswer.contextAfter,
    contextAnswer.contextBefore,
    contextAnswer.id,
    contextAnswer.selectedText,
  ]);

  const transport = useMemo(
    () =>
      new DefaultChatTransport<ContextChatMessage>({
        api: `${getBackendUrl()}/api/chat/context`,
        prepareSendMessagesRequest: ({ id, messages }) => ({
          body: {
            id,
            messages,
            contextAfter: contextAnswer.contextAfter,
            contextBefore: contextAnswer.contextBefore,
            lessonContent: contextAnswer.lessonContent,
            lessonDescription: contextAnswer.lessonDescription,
            lessonTitle: contextAnswer.lessonTitle,
            selectedText: contextAnswer.selectedText,
            sourceKind: contextAnswer.sourceKind,
            sourceMaterial: contextAnswer.sourceMaterial,
            sourceName: contextAnswer.sourceName,
            attachedAnnotationNote: contextAnswer.attachedAnnotationNote,
            attachedAnnotationText: contextAnswer.attachedAnnotationText,
            toolPreferences,
          },
        }),
      }),
    [
      contextAnswer.contextAfter,
      contextAnswer.contextBefore,
      contextAnswer.lessonContent,
      contextAnswer.lessonDescription,
      contextAnswer.lessonTitle,
      contextAnswer.attachedAnnotationNote,
      contextAnswer.attachedAnnotationText,
      contextAnswer.selectedText,
      contextAnswer.sourceKind,
      contextAnswer.sourceMaterial,
      contextAnswer.sourceName,
      toolPreferences,
    ]
  );

  const { addToolOutput, error, messages, sendMessage, status } = useChat<ContextChatMessage>({
    id: contextAnswer.id,
    messages: [],
    transport,
    experimental_throttle: 96,
    sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithToolCalls,
    onToolCall: async ({ toolCall }) => {
      if (
        toolCall.dynamic ||
        (toolCall.toolName !== 'saveConversationNote' &&
          toolCall.toolName !== 'updateConversationNote')
      ) {
        return;
      }

      const requestedTool =
        toolCall.toolName === 'updateConversationNote'
          ? 'updateConversationNote'
          : 'saveConversationNote';
      const runNoteMutation =
        requestedTool === 'updateConversationNote'
          ? onUpdateConversationNote
          : onSaveConversationNote;

      if (!isSaveConversationNoteToolInput(toolCall.input)) {
        void addToolOutput({
          tool: requestedTool,
          toolCallId: toolCall.toolCallId,
          state: 'output-error',
          errorText:
            requestedTool === 'updateConversationNote'
              ? "La richiesta di aggiornamento della nota e arrivata incompleta."
              : 'La richiesta di salvataggio nota e arrivata incompleta.',
        });
        return;
      }

      let lastResult: SaveConversationNoteResult | null = null;

      for (const candidate of buildConversationNoteSaveCandidates({
        anchor: selectionAnchorRef.current,
        toolInput: toolCall.input,
      })) {
        const result = await runNoteMutation(candidate);
        if (result.saved) {
          void addToolOutput({
            tool: requestedTool,
            toolCallId: toolCall.toolCallId,
            output: result,
          });
          return;
        }

        lastResult = result;
      }

      void addToolOutput({
        tool: requestedTool,
        toolCallId: toolCall.toolCallId,
        state: 'output-error',
        errorText:
          lastResult?.error ||
          (requestedTool === 'updateConversationNote'
            ? 'Non sono riuscito ad aggiornare la nota.'
            : 'Non sono riuscito a salvare la nota.'),
      });
    },
  });

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

  useEffect(() => {
    hasSubmittedInitialQuestionRef.current = false;
    setIsToolMenuOpen(false);
    setToolPreferences({
      annotate: false,
      webSearch: false,
    });
  }, [contextAnswer.id]);

  const isLoading = status === 'submitted' || status === 'streaming';
  const hasActiveToolPreference = toolPreferences.annotate || toolPreferences.webSearch;

  const handleSubmit = () => {
    const trimmedInput = input.trim();
    if (!trimmedInput) {
      return;
    }

    setInput('');
    setIsToolMenuOpen(false);
    void sendMessage({ text: trimmedInput });
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

      return (
        <div key={`${messageId}-${part.toolCallId}`} className={toolCardClassName}>
          <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-stone-900 dark:text-stone-100">
            <StickyNote className="h-4 w-4" />
            <span>Vuoi aggiungerlo alle note?</span>
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
                Nota proposta
              </p>
              <p className="whitespace-pre-wrap text-sm leading-6 text-stone-700 dark:text-stone-200">
                {inputValue.noteDraft}
              </p>
            </div>
          ) : null}

          {part.state === 'input-available' && inputValue ? (
            <div className="mt-3 flex flex-wrap justify-end gap-2">
              <button
                type="button"
                onClick={() =>
                  void addToolOutput({
                    tool: 'requestAddToNotes',
                    toolCallId: part.toolCallId,
                    output: { approved: false },
                  })
                }
                className="rounded-full px-3 py-2 text-xs font-semibold text-stone-500 transition-colors hover:bg-stone-200/70 hover:text-stone-700 dark:text-stone-400 dark:hover:bg-stone-600 dark:hover:text-stone-100"
              >
                No grazie
              </button>
              <button
                type="button"
                onClick={() =>
                  void addToolOutput({
                    tool: 'requestAddToNotes',
                    toolCallId: part.toolCallId,
                    output: { approved: true },
                  })
                }
                className="rounded-full bg-stone-900 px-4 py-2 text-xs font-semibold text-stone-50 transition-colors hover:bg-stone-700 dark:bg-stone-100 dark:text-stone-900 dark:hover:bg-white"
              >
                Aggiungi alle note
              </button>
            </div>
          ) : part.state === 'input-available' ? (
            <div className="mt-3 inline-flex items-center gap-2 rounded-full bg-white/80 px-3 py-2 text-xs font-semibold text-stone-600 dark:bg-stone-800/60 dark:text-stone-200">
              <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
              <span>Sto caricando i dettagli della nota proposta...</span>
            </div>
          ) : part.state === 'output-available' ? (
            <div className="mt-3 inline-flex items-center gap-2 rounded-full bg-white/80 px-3 py-2 text-xs font-semibold text-stone-600 dark:bg-stone-800/60 dark:text-stone-200">
              <Check className="h-3.5 w-3.5" />
              <span>
                {outputValue?.approved
                  ? 'Richiesta approvata, sto salvando la nota.'
                  : 'Richiesta rifiutata, la conversazione continua senza salvare.'}
              </span>
            </div>
          ) : part.state === 'output-error' ? (
            <div className="mt-3 rounded-full bg-red-50 px-3 py-2 text-xs font-semibold text-red-700 dark:bg-red-950/30 dark:text-red-200">
              {part.errorText}
            </div>
          ) : null}
        </div>
      );
    }

    if (
      part.type === 'tool-saveConversationNote' ||
      part.type === 'tool-updateConversationNote'
    ) {
      const outputValue = isSaveConversationNoteResult(part.output) ? part.output : undefined;
      const isUpdateTool = part.type === 'tool-updateConversationNote';

      return (
        <div key={`${messageId}-${part.toolCallId}`} className={toolCardClassName}>
          <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-stone-900 dark:text-stone-100">
            <StickyNote className="h-4 w-4" />
            <span>{isUpdateTool ? 'Aggiornamento nota' : 'Salvataggio nota'}</span>
          </div>

          {part.state === 'input-available' ? (
            <div className="inline-flex items-center gap-2 rounded-full bg-white/80 px-3 py-2 text-xs font-semibold text-stone-600 dark:bg-stone-800/60 dark:text-stone-200">
              <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
              <span>
                {isUpdateTool
                  ? 'Sto aggiornando la nota del passaggio corrente...'
                  : 'Sto aggiungendo la nota alla lezione corrente...'}
              </span>
            </div>
          ) : null}

          {part.state === 'output-available' ? (
            <div className="space-y-2">
              <div className="inline-flex items-center gap-2 rounded-full bg-white/80 px-3 py-2 text-xs font-semibold text-stone-600 dark:bg-stone-800/60 dark:text-stone-200">
                <Check className="h-3.5 w-3.5" />
                <span>
                  {isUpdateTool
                    ? 'Nota aggiornata.'
                    : `Nota salvata${outputValue?.merged ? " con unione dell'evidenziazione esistente." : '.'}`}
                </span>
              </div>
              {outputValue?.resolvedText ? (
                <p className="text-xs leading-5 text-stone-500 dark:text-stone-400">
                  Passaggio annotato: "{outputValue.resolvedText}"
                </p>
              ) : null}
            </div>
          ) : null}

          {part.state === 'output-error' ? (
            <div className="rounded-full bg-red-50 px-3 py-2 text-xs font-semibold text-red-700 dark:bg-red-950/30 dark:text-red-200">
              {part.errorText}
            </div>
          ) : null}
        </div>
      );
    }

    return null;
  };

  return (
    <div
      ref={contextAnswerPanelRef}
      className={`fixed z-50 flex flex-col overflow-hidden rounded-2xl border border-orange-100 bg-white px-6 pb-5 pt-5 shadow-[0_10px_40px_-10px_rgba(0,0,0,0.2)] animate-in slide-in-from-bottom-10 duration-500 dark:border-orange-900/30 dark:bg-zinc-800 ${
        isMobileViewport ? 'inset-x-3 bottom-24 top-24' : 'top-6 right-8'
      }`}
      style={isMobileViewport ? undefined : contextAnswerSize}
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

      <div className="custom-scrollbar min-h-0 flex-1 overflow-auto pr-2">
        <div className="space-y-6 pb-5">
          {visibleMessages.map(message => {
            if (message.role === 'user') {
              return (
                <div key={message.id} className="pt-2">
                  <div className="border-l-2 border-orange-500 pl-3 font-serif text-base font-bold leading-[1.35] text-gray-900 dark:text-gray-100">
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

          {isLoading ? (
            <div className="text-sm text-stone-400 dark:text-stone-500">Sto continuando a rispondere...</div>
          ) : null}

          {error ? (
            <div className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900/50 dark:bg-red-950/30 dark:text-red-200">
              {error.message}
            </div>
          ) : null}
        </div>
      </div>

      <div className="mt-5 shrink-0 border-t border-stone-100 pt-4 dark:border-zinc-700/60">
        <ChatTextComposer
          value={input}
          onChange={setInput}
          onSubmit={handleSubmit}
          placeholder="Chiedi un follow-up su questa risposta..."
          disabled={status === 'submitted'}
          isLoading={isLoading}
          className="flex items-center gap-2"
          leadingContent={
            <div ref={toolMenuRef} className="relative flex shrink-0 items-center">
              <button
                type="button"
                onClick={() => setIsToolMenuOpen(currentValue => !currentValue)}
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
                        Segnala con forza che vuoi trasformare il chiarimento in una nota o aggiornare quella gia collegata al passaggio.
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
                        Dai priorita a grounding e verifica con fonti esterne quando servono informazioni aggiornate o non presenti nel testo.
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
