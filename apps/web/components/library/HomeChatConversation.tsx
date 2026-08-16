import { isToolUIPart, type UIMessage } from 'ai';
import { Check, FileText, Loader2, Sparkles } from 'lucide-react';
import type { ReactNode, RefObject } from 'react';
import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import logoUrl from '@/assets/logo.svg';
import logoDarkModeUrl from '@/assets/logo_darkmode.svg';
import { translateUiMessage as t } from '../../i18n/uiMessages.ts';
import type { HomeChatMode, LearningArtifactRenderPayload, Message } from '../../types.ts';
import {
  dedupeUiMessagesById,
  getUiMessageRenderableParts,
  getUiMessageText,
} from '../../utils/uiChat.ts';
import type {
  ChatArtifactActionRequest,
  ChatArtifactRegenerateRequest,
  ChatArtifactReplaceRequest,
} from '../shared/ChatArtifactRenderer.tsx';
import ChatArtifactRenderer from '../shared/ChatArtifactRenderer.tsx';
import ChatToolActivityStrip from '../shared/ChatToolActivityStrip.tsx';
import MarkdownRenderer from '../shared/MarkdownRenderer.tsx';
import StreamingMarkdownRenderer from '../shared/StreamingMarkdownRenderer.tsx';

type LibraryToolPart = Extract<UIMessage['parts'][number], { type: `tool-${string}` }>;

interface HomeChatConversationProps {
  readonly assessmentComplete: boolean;
  readonly assessmentMessages: Message[];
  readonly compactWhenEmpty: boolean;
  readonly homeChatMode: HomeChatMode;
  readonly inputRef: RefObject<HTMLInputElement | null>;
  readonly isDarkMode: boolean;
  readonly isLibraryAwaitingFirstResponse: boolean;
  readonly isLoading: boolean;
  readonly isMobileViewport: boolean;
  readonly libraryArtifactPayloadsByToolCallId: Record<string, LearningArtifactRenderPayload[]>;
  readonly libraryArtifactPortalContainer?: HTMLElement | null;
  readonly libraryArtifactPreviewIdOverride?: string | null;
  readonly libraryErrorMessage: string | null;
  readonly libraryFloatingArtifactPayloads: LearningArtifactRenderPayload[];
  readonly newCourseLoadingStatus: string;
  readonly onConfirmGenerate: () => void;
  readonly onContinueAssessment?: () => void;
  readonly onLibraryArtifactNoteApprove: (
    toolCallId: string,
    input: RequestSaveLearningArtifactNoteInput
  ) => Promise<void>;
  readonly onLibraryArtifactNoteReject: (toolCallId: string) => void;
  readonly onLibraryArtifactDiscard?: (request: ChatArtifactActionRequest) => void;
  readonly onLibraryArtifactRegenerate: (
    request: ChatArtifactRegenerateRequest
  ) => Promise<boolean> | boolean;
  readonly onLibraryArtifactReplace: (request: ChatArtifactReplaceRequest) => Promise<void> | void;
  readonly reserveClearButtonSpace: boolean;
  readonly scrollProgressOverride?: number;
  readonly showChatAvatars: boolean;
  readonly visibleLibraryMessages: UIMessage[];
}

interface RequestSaveLearningArtifactNoteInput {
  artifactIds: string[];
  lessonId: string;
  noteDraft: string;
  projectId: string;
  rationale: string;
}

interface LibraryAssistantTurn {
  key: string;
  messages: UIMessage[];
  parts: UIMessage['parts'];
}

interface MergedAssistantText {
  isStreaming: boolean;
  text: string;
}

const isRequestSaveLearningArtifactNoteInput = (
  value: unknown
): value is RequestSaveLearningArtifactNoteInput => {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<RequestSaveLearningArtifactNoteInput>;
  return (
    Array.isArray(candidate.artifactIds) &&
    candidate.artifactIds.every(item => typeof item === 'string') &&
    typeof candidate.lessonId === 'string' &&
    typeof candidate.noteDraft === 'string' &&
    typeof candidate.projectId === 'string' &&
    typeof candidate.rationale === 'string'
  );
};

const isVisibleLibraryToolState = (state: LibraryToolPart['state']) =>
  state === 'input-streaming' ||
  state === 'input-available' ||
  state === 'approval-requested' ||
  state === 'approval-responded' ||
  state === 'output-available' ||
  state === 'output-error' ||
  state === 'output-denied';

const hasVisibleLibraryMessageContent = (message: UIMessage) =>
  getUiMessageRenderableParts(message).some(part => {
    if (part.kind === 'text') return true;
    return isToolUIPart(part.part) && isVisibleLibraryToolState(part.part.state);
  });

export const getActiveLibraryMessages = (messages: UIMessage[]) =>
  dedupeUiMessagesById(messages).filter(message =>
    message.role === 'user' ? true : hasVisibleLibraryMessageContent(message)
  );

const buildAssessmentMessageKeys = (messages: Message[]) => {
  const counts = new Map<string, number>();
  return messages.map(message => {
    const baseKey = `${message.role}:${message.text}`;
    const nextCount = (counts.get(baseKey) || 0) + 1;
    counts.set(baseKey, nextCount);
    return `${baseKey}:${nextCount}`;
  });
};

const groupLibraryAssistantTurns = (messages: UIMessage[]) => {
  const turns: Array<UIMessage | LibraryAssistantTurn> = [];
  let currentAssistantMessages: UIMessage[] = [];
  const flushAssistantTurn = () => {
    if (currentAssistantMessages.length === 0) return;
    turns.push({
      key: currentAssistantMessages.map(message => message.id || 'assistant').join('__'),
      messages: currentAssistantMessages,
      parts: currentAssistantMessages.flatMap(message => message.parts),
    });
    currentAssistantMessages = [];
  };

  messages.forEach(message => {
    if (message.role === 'assistant') {
      currentAssistantMessages.push(message);
      return;
    }
    flushAssistantTurn();
    turns.push(message);
  });
  flushAssistantTurn();
  return turns;
};

const isLibraryAssistantTurn = (
  turn: UIMessage | LibraryAssistantTurn
): turn is LibraryAssistantTurn => !('role' in turn);

const getMergedLibraryAssistantText = (messages: UIMessage[]): MergedAssistantText | null => {
  const textParts = messages.flatMap(message =>
    getUiMessageRenderableParts(message).filter(part => part.kind === 'text')
  );
  const text = textParts
    .map(part => part.text.trim())
    .filter(Boolean)
    .join('\n\n');
  return text ? { isStreaming: textParts.some(part => part.isStreaming), text } : null;
};

const NoteRequestResult = ({
  input,
  output,
  part,
  onApprove,
  onReject,
}: {
  readonly input: RequestSaveLearningArtifactNoteInput | null;
  readonly output: { approved?: boolean; error?: string; saved?: boolean } | null;
  readonly part: LibraryToolPart;
  readonly onApprove: (toolCallId: string, input: RequestSaveLearningArtifactNoteInput) => void;
  readonly onReject: (toolCallId: string) => void;
}) => {
  if (part.state === 'input-available' && input) {
    return (
      <div className="mt-3 flex flex-wrap justify-end gap-2">
        <button
          type="button"
          onClick={() => onReject(part.toolCallId)}
          className="rounded-full px-3 py-2 text-xs font-semibold text-stone-500 transition-colors hover:bg-stone-200/70 hover:text-stone-700 dark:text-stone-400 dark:hover:bg-stone-700 dark:hover:text-stone-100"
        >
          {t('No grazie')}
        </button>
        <button
          type="button"
          onClick={() => onApprove(part.toolCallId, input)}
          className="inline-flex items-center gap-1.5 rounded-full bg-stone-900 px-3 py-2 text-xs font-semibold text-stone-50 transition-colors hover:bg-stone-700 dark:bg-stone-100 dark:text-stone-900 dark:hover:bg-white"
        >
          <Check className="h-3.5 w-3.5" />
          {t('Salva nota')}
        </button>
      </div>
    );
  }
  if (output?.saved) {
    return (
      <div className="mt-3 inline-flex items-center gap-2 rounded-full bg-white/80 px-3 py-2 text-xs font-semibold text-stone-600 dark:bg-stone-900/50 dark:text-stone-200">
        <Check className="h-3.5 w-3.5" />
        <span>{t('Nota salvata.')}</span>
      </div>
    );
  }
  if (output?.approved === false) {
    return (
      <div className="mt-3 text-xs font-semibold text-stone-500 dark:text-stone-400">
        {t('Richiesta rifiutata.')}
      </div>
    );
  }
  if (output?.error) {
    return (
      <div className="mt-3 rounded-full bg-red-50 px-3 py-2 text-xs font-semibold text-red-700 dark:bg-red-950/30 dark:text-red-200">
        {output.error}
      </div>
    );
  }
  return null;
};

const LibraryArtifactTools = ({
  isDarkMode,
  libraryArtifactPayloadsByToolCallId,
  libraryArtifactPortalContainer,
  libraryArtifactPreviewIdOverride,
  onLibraryArtifactRegenerate,
  onLibraryArtifactReplace,
  parts,
}: Pick<
  HomeChatConversationProps,
  | 'isDarkMode'
  | 'libraryArtifactPayloadsByToolCallId'
  | 'libraryArtifactPortalContainer'
  | 'libraryArtifactPreviewIdOverride'
  | 'onLibraryArtifactRegenerate'
  | 'onLibraryArtifactReplace'
> & { readonly parts: UIMessage['parts'] }) => {
  const artifacts = parts
    .filter(isToolUIPart)
    .filter(
      part =>
        part.type === 'tool-getLearningArtifacts' || part.type === 'tool-generateLearningArtifact'
    )
    .flatMap(part => libraryArtifactPayloadsByToolCallId[part.toolCallId] || []);
  if (artifacts.length === 0) return null;
  return (
    <ChatArtifactRenderer
      artifacts={artifacts}
      isDarkMode={isDarkMode}
      openArtifactIdOverride={libraryArtifactPreviewIdOverride}
      portalContainer={libraryArtifactPortalContainer}
      onRegenerateArtifact={onLibraryArtifactRegenerate}
      onReplaceArtifact={onLibraryArtifactReplace}
    />
  );
};

const LibraryNoteRequests = ({
  messageId,
  onLibraryArtifactNoteApprove,
  onLibraryArtifactNoteReject,
  parts,
}: Pick<
  HomeChatConversationProps,
  'onLibraryArtifactNoteApprove' | 'onLibraryArtifactNoteReject'
> & { readonly messageId: string; readonly parts: UIMessage['parts'] }) => {
  const requests = parts
    .filter(isToolUIPart)
    .filter(part => part.type === 'tool-requestSaveLearningArtifactNote');
  if (requests.length === 0) return null;
  return (
    <div className="space-y-2">
      {requests.map(part => {
        const input = isRequestSaveLearningArtifactNoteInput(part.input) ? part.input : null;
        const output =
          part.output && typeof part.output === 'object'
            ? (part.output as { approved?: boolean; error?: string; saved?: boolean })
            : null;
        return (
          <div
            key={`${messageId}-${part.toolCallId}`}
            className="max-w-[88%] rounded-[1.2rem] border border-stone-200 bg-[#fbf7ef] px-4 py-3 text-sm text-stone-700 shadow-[0_12px_28px_-22px_rgba(46,34,16,0.55)] dark:border-stone-500/80 dark:bg-stone-800 dark:text-stone-200"
          >
            <div className="flex items-center gap-2 font-semibold text-stone-900 dark:text-stone-100">
              <FileText className="h-4 w-4" />
              <span>{t('Vuoi salvarlo nelle note della lezione?')}</span>
            </div>
            <p className="mt-2 text-xs leading-5 text-stone-500 dark:text-stone-400">
              {input?.rationale || t('Preparo la nota di lezione con gli artefatti allegati.')}
            </p>
            {input ? (
              <p className="mt-3 whitespace-pre-wrap rounded-[0.9rem] bg-white/70 px-3 py-2 text-sm leading-6 text-stone-700 dark:bg-stone-900/40 dark:text-stone-200">
                {input.noteDraft}
              </p>
            ) : null}
            <NoteRequestResult
              input={input}
              output={output}
              part={part as LibraryToolPart}
              onApprove={(toolCallId, requestInput) =>
                void onLibraryArtifactNoteApprove(toolCallId, requestInput)
              }
              onReject={onLibraryArtifactNoteReject}
            />
          </div>
        );
      })}
    </div>
  );
};

const AssessmentConversation = ({
  assistantAvatar,
  assessmentMessageKeys,
  assessmentMessages,
  isDarkMode,
  userAvatar,
}: {
  readonly assistantAvatar: ReactNode;
  readonly assessmentMessageKeys: string[];
  readonly assessmentMessages: Message[];
  readonly isDarkMode: boolean;
  readonly userAvatar: ReactNode;
}) => (
  <>
    {assessmentMessages.map((message, index) => (
      <div key={assessmentMessageKeys[index]} className="flex items-start justify-start gap-2.5">
        {message.role === 'model' ? assistantAvatar : userAvatar}
        <div
          className={`max-w-[min(82%,76ch)] rounded-2xl px-4 py-3 text-sm leading-6 ${
            message.role === 'user'
              ? 'user-chat-bubble rounded-tl-md bg-stone-900 text-white dark:bg-stone-100 dark:text-stone-900'
              : 'rounded-tl-md border border-stone-200/80 bg-white/80 text-gray-800 shadow-sm dark:border-white/10 dark:bg-white/[0.055] dark:text-zinc-100'
          }`}
        >
          <MarkdownRenderer
            content={message.text}
            isDarkMode={isDarkMode}
            className={
              message.role === 'user'
                ? 'prose-sm prose-invert max-w-none'
                : 'prose-sm max-w-none dark:prose-invert'
            }
          />
        </div>
      </div>
    ))}
  </>
);

const LibraryConversation = ({
  assistantAvatar,
  isDarkMode,
  isMobileViewport,
  libraryArtifactPayloadsByToolCallId,
  libraryArtifactPortalContainer,
  libraryArtifactPreviewIdOverride,
  onLibraryArtifactNoteApprove,
  onLibraryArtifactNoteReject,
  onLibraryArtifactRegenerate,
  onLibraryArtifactReplace,
  userAvatar,
  visibleLibraryTurns,
}: Pick<
  HomeChatConversationProps,
  | 'isDarkMode'
  | 'isMobileViewport'
  | 'libraryArtifactPayloadsByToolCallId'
  | 'libraryArtifactPortalContainer'
  | 'libraryArtifactPreviewIdOverride'
  | 'onLibraryArtifactNoteApprove'
  | 'onLibraryArtifactNoteReject'
  | 'onLibraryArtifactRegenerate'
  | 'onLibraryArtifactReplace'
> & {
  readonly assistantAvatar: ReactNode;
  readonly userAvatar: ReactNode;
  readonly visibleLibraryTurns: Array<UIMessage | LibraryAssistantTurn>;
}) => (
  <>
    {visibleLibraryTurns.map(turn => {
      if (!isLibraryAssistantTurn(turn)) {
        return (
          <div key={turn.id} className="flex items-start justify-start gap-2.5">
            {userAvatar}
            <div className="user-chat-bubble max-w-[min(82%,76ch)] rounded-2xl rounded-tl-md bg-stone-900 px-4 py-3 text-sm leading-6 text-white dark:bg-stone-100 dark:text-stone-900">
              <MarkdownRenderer
                content={getUiMessageText(turn)}
                isDarkMode={isDarkMode}
                className="prose-sm prose-invert max-w-none"
              />
            </div>
          </div>
        );
      }
      const mergedText = getMergedLibraryAssistantText(turn.messages);
      return (
        <div key={turn.key} className="!mt-5 flex items-start gap-2.5">
          {assistantAvatar}
          <div className="min-w-0 flex-1 space-y-2.5">
            <ChatToolActivityStrip
              isMobileViewport={isMobileViewport}
              messageId={turn.key}
              parts={turn.parts}
            />
            {mergedText ? (
              <div
                data-testid="library-assistant-turn-bubble"
                className="max-w-[min(86%,82ch)] rounded-2xl rounded-tl-md border border-stone-200/80 bg-white/80 px-4 py-3 text-sm leading-7 text-gray-800 shadow-sm dark:border-white/10 dark:bg-white/[0.055] dark:text-zinc-100"
              >
                <StreamingMarkdownRenderer
                  content={mergedText.text}
                  isStreaming={mergedText.isStreaming}
                  isDarkMode={isDarkMode}
                  className="prose-sm max-w-none dark:prose-invert"
                />
              </div>
            ) : null}
            <LibraryArtifactTools
              isDarkMode={isDarkMode}
              libraryArtifactPayloadsByToolCallId={libraryArtifactPayloadsByToolCallId}
              libraryArtifactPortalContainer={libraryArtifactPortalContainer}
              libraryArtifactPreviewIdOverride={libraryArtifactPreviewIdOverride}
              onLibraryArtifactRegenerate={onLibraryArtifactRegenerate}
              onLibraryArtifactReplace={onLibraryArtifactReplace}
              parts={turn.parts}
            />
            <LibraryNoteRequests
              messageId={turn.key}
              onLibraryArtifactNoteApprove={onLibraryArtifactNoteApprove}
              onLibraryArtifactNoteReject={onLibraryArtifactNoteReject}
              parts={turn.parts}
            />
          </div>
        </div>
      );
    })}
  </>
);

const getConversationScrollClassName = (
  compactWhenEmpty: boolean,
  hasMessages: boolean,
  isLoading: boolean,
  reserveClearButtonSpace: boolean
) => {
  if (compactWhenEmpty && !hasMessages && !isLoading) {
    return 'home-chat-scrollbar overflow-y-auto px-4 sm:px-5 max-md:min-h-0 max-md:flex-1 hidden h-0 py-0';
  }
  const spacing = reserveClearButtonSpace ? 'pb-4 pt-16' : 'py-4';
  return `home-chat-scrollbar overflow-y-auto px-4 sm:px-5 max-md:min-h-0 max-md:flex-1 h-[14rem] md:h-[24rem] ${spacing}`;
};

const AssistantAvatar = ({ isDarkMode, show }: { isDarkMode: boolean; show: boolean }) => {
  if (!show) return null;
  const source = isDarkMode ? logoDarkModeUrl : logoUrl;
  return (
    <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-stone-200 bg-white dark:border-white/10 dark:bg-stone-900">
      <img src={source} alt="Assistente Nous" className="h-5 w-5 object-contain" />
    </span>
  );
};

const UserAvatar = ({ show }: { show: boolean }) => {
  if (!show) return null;
  return (
    <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-stone-200 text-xs font-semibold text-stone-700 dark:bg-stone-700 dark:text-stone-100">
      G
    </span>
  );
};

const EmptyConversationState = ({
  hasMessages,
  homeChatMode,
}: {
  hasMessages: boolean;
  homeChatMode: HomeChatMode;
}) => {
  if (hasMessages) return null;
  const isNewCourse = homeChatMode === 'new-course';
  const title = isNewCourse ? t('Cosa vorresti imparare?') : t('Interroga la tua libreria');
  const description = isNewCourse
    ? t(
        "Descrivi l'obiettivo del corso oppure allega un materiale sorgente e dimmi dove vuoi arrivare."
      )
    : t('Chiedi riassunti, progresso, note, highlight o confronti tra corsi.');
  const descriptionWidth = isNewCourse ? 'max-w-xl' : 'max-w-2xl';
  return (
    <div className="flex h-full flex-col items-center justify-center px-4 py-6 text-center">
      <p className="font-serif text-xl text-gray-400 dark:text-zinc-500 sm:text-2xl">{title}</p>
      <p className={`mt-2 text-sm text-gray-500 dark:text-zinc-400 ${descriptionWidth}`}>
        {description}
      </p>
    </div>
  );
};

export default function HomeChatConversation({
  assessmentComplete,
  assessmentMessages,
  compactWhenEmpty,
  homeChatMode,
  inputRef,
  isDarkMode,
  isLibraryAwaitingFirstResponse,
  isLoading,
  isMobileViewport,
  libraryArtifactPayloadsByToolCallId,
  libraryArtifactPortalContainer,
  libraryArtifactPreviewIdOverride,
  libraryErrorMessage,
  libraryFloatingArtifactPayloads,
  newCourseLoadingStatus,
  onConfirmGenerate,
  onContinueAssessment,
  onLibraryArtifactNoteApprove,
  onLibraryArtifactNoteReject,
  onLibraryArtifactDiscard,
  onLibraryArtifactRegenerate,
  onLibraryArtifactReplace,
  reserveClearButtonSpace,
  scrollProgressOverride,
  showChatAvatars,
  visibleLibraryMessages,
}: HomeChatConversationProps) {
  const messagesScrollRef = useRef<HTMLDivElement>(null);
  const [scrollOffsetOverride, setScrollOffsetOverride] = useState(0);
  const assessmentMessageKeys = useMemo(
    () => buildAssessmentMessageKeys(assessmentMessages),
    [assessmentMessages]
  );
  const visibleLibraryTurns = useMemo(
    () => groupLibraryAssistantTurns(visibleLibraryMessages),
    [visibleLibraryMessages]
  );
  const activeMessages =
    homeChatMode === 'new-course' ? assessmentMessages : visibleLibraryMessages;
  const hasMessages = activeMessages.length > 0;
  const activeContentLength =
    homeChatMode === 'new-course'
      ? assessmentMessages.reduce((total, message) => total + message.text.length, 0)
      : visibleLibraryMessages.reduce(
          (total, message) => total + getUiMessageText(message).length,
          0
        );
  const scrollMeasurementKey = `${activeMessages.length}:${activeContentLength}:${assessmentComplete}:${isLoading}`;
  const assistantAvatar = <AssistantAvatar isDarkMode={isDarkMode} show={showChatAvatars} />;
  const userAvatar = <UserAvatar show={showChatAvatars} />;

  useLayoutEffect(() => {
    if (
      !scrollMeasurementKey ||
      scrollProgressOverride === undefined ||
      !messagesScrollRef.current
    ) {
      return;
    }
    const maxScrollTop = Math.max(
      0,
      messagesScrollRef.current.scrollHeight - messagesScrollRef.current.clientHeight
    );
    const nextOffset = Math.round(maxScrollTop * Math.min(1, Math.max(0, scrollProgressOverride)));
    setScrollOffsetOverride(current => (current === nextOffset ? current : nextOffset));
  }, [scrollMeasurementKey, scrollProgressOverride]);

  useLayoutEffect(() => {
    if (scrollProgressOverride !== undefined) return;
    if (!activeMessages.at(-1) && !assessmentComplete && !isLoading) return;
    const messagesScroll = messagesScrollRef.current;
    if (messagesScroll) messagesScroll.scrollTop = messagesScroll.scrollHeight;
  }, [activeMessages, assessmentComplete, isLoading, scrollProgressOverride]);

  return (
    <div
      ref={messagesScrollRef}
      className={getConversationScrollClassName(
        compactWhenEmpty,
        hasMessages,
        isLoading,
        reserveClearButtonSpace
      )}
      style={scrollProgressOverride === undefined ? undefined : { overflowY: 'hidden' }}
    >
      <div
        className={`space-y-3.5 ${scrollProgressOverride === undefined ? '' : 'pb-20'}`}
        style={
          scrollProgressOverride === undefined
            ? undefined
            : { transform: `translateY(-${scrollOffsetOverride}px)` }
        }
      >
        <EmptyConversationState hasMessages={hasMessages} homeChatMode={homeChatMode} />

        {homeChatMode === 'new-course' ? (
          <AssessmentConversation
            assistantAvatar={assistantAvatar}
            assessmentMessageKeys={assessmentMessageKeys}
            assessmentMessages={assessmentMessages}
            isDarkMode={isDarkMode}
            userAvatar={userAvatar}
          />
        ) : (
          <LibraryConversation
            assistantAvatar={assistantAvatar}
            isDarkMode={isDarkMode}
            isMobileViewport={isMobileViewport}
            libraryArtifactPayloadsByToolCallId={libraryArtifactPayloadsByToolCallId}
            libraryArtifactPortalContainer={libraryArtifactPortalContainer}
            libraryArtifactPreviewIdOverride={libraryArtifactPreviewIdOverride}
            onLibraryArtifactNoteApprove={onLibraryArtifactNoteApprove}
            onLibraryArtifactNoteReject={onLibraryArtifactNoteReject}
            onLibraryArtifactRegenerate={onLibraryArtifactRegenerate}
            onLibraryArtifactReplace={onLibraryArtifactReplace}
            userAvatar={userAvatar}
            visibleLibraryTurns={visibleLibraryTurns}
          />
        )}

        {homeChatMode === 'library-query' && libraryFloatingArtifactPayloads.length ? (
          <ChatArtifactRenderer
            artifacts={libraryFloatingArtifactPayloads}
            isDarkMode={isDarkMode}
            onDiscardArtifact={onLibraryArtifactDiscard}
            onRegenerateArtifact={onLibraryArtifactRegenerate}
            onReplaceArtifact={onLibraryArtifactReplace}
          />
        ) : null}
        {homeChatMode === 'new-course' && isLoading ? (
          <div className="flex justify-start">
            <div className="flex items-center gap-2 rounded-2xl border border-gray-200 bg-gray-50/80 px-4 py-3 text-sm text-gray-600 dark:border-zinc-600/50 dark:bg-stone-700 dark:text-zinc-300">
              <Loader2 className="h-4 w-4 animate-spin text-orange-500" />
              {newCourseLoadingStatus}
            </div>
          </div>
        ) : null}
        {isLibraryAwaitingFirstResponse ? (
          <div className="flex justify-start">
            <div className="flex items-center gap-1.5 border-l border-stone-300/80 pl-3.5 py-2 text-xs text-gray-400 dark:border-stone-600/80 dark:text-zinc-500">
              <span className="inline-block h-1 w-1 animate-pulse rounded-full bg-gray-400 dark:bg-zinc-500" />
              <span className="inline-block h-1 w-1 animate-pulse rounded-full bg-gray-400 [animation-delay:150ms] dark:bg-zinc-500" />
              <span className="inline-block h-1 w-1 animate-pulse rounded-full bg-gray-400 [animation-delay:300ms] dark:bg-zinc-500" />
            </div>
          </div>
        ) : null}
        {homeChatMode === 'library-query' && libraryErrorMessage ? (
          <div className="rounded-2xl border border-red-200 bg-red-50/90 px-4 py-3 text-sm text-red-700 dark:border-red-900/60 dark:bg-red-950/30 dark:text-red-200">
            {libraryErrorMessage}
          </div>
        ) : null}
        {homeChatMode === 'new-course' && assessmentComplete && !isLoading ? (
          <div className="flex flex-col items-center gap-3 rounded-2xl border border-amber-200/80 bg-amber-50/60 px-5 py-4 dark:border-amber-700/40 dark:bg-amber-950/20">
            <p className="text-center text-sm font-medium text-amber-800 dark:text-amber-200">
              {t('Ho raccolto tutte le informazioni necessarie. Vuoi generare il corso?')}
            </p>
            <div className="flex items-center gap-3">
              <button
                data-home-chat-target="confirm-generate"
                type="button"
                onClick={onConfirmGenerate}
                className="inline-flex items-center gap-2 rounded-xl bg-amber-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-amber-700 dark:bg-amber-500 dark:hover:bg-amber-600"
              >
                <Sparkles className="h-4 w-4" />
                {t('Sì, genera il corso')}
              </button>
              <button
                type="button"
                onClick={() => {
                  onContinueAssessment?.();
                  inputRef.current?.focus();
                }}
                className="rounded-xl border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 transition-colors hover:border-gray-400 hover:bg-gray-50 dark:border-zinc-600 dark:bg-stone-700 dark:text-zinc-200 dark:hover:border-zinc-500 dark:hover:bg-stone-600"
              >
                {t('No, voglio aggiungere...')}
              </button>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
