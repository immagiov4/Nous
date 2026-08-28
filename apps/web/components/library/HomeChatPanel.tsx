import type { UIMessage } from 'ai';
import { motion } from 'framer-motion';
import { BookPlus, Folder, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useMobileKeyboardOffset } from '../../hooks/useMobileKeyboardOffset.ts';
import { translateUiMessage as t } from '../../i18n/uiMessages.ts';
import type {
  HomeChatMode,
  LearningArtifactRenderPayload,
  LibraryContextRef,
  LibraryTree,
  Message,
} from '../../types.ts';
import type {
  ChatArtifactActionRequest,
  ChatArtifactRegenerateRequest,
  ChatArtifactReplaceRequest,
} from '../shared/ChatArtifactRenderer.tsx';
import HomeChatComposer, {
  type HomeChatSurfaceState,
  type LibraryMessageSendHandler,
  type StopGenerationHandler,
} from './HomeChatComposer.tsx';
import HomeChatConversation, { getActiveLibraryMessages } from './HomeChatConversation.tsx';

interface HomeChatPanelProps {
  readonly assessmentComplete: boolean;
  readonly assessmentMessages: Message[];
  readonly homeChatMode: HomeChatMode;
  readonly isDarkMode: boolean;
  readonly isLibraryLoading: boolean;
  readonly isLibraryModeLoading: boolean;
  readonly isNewCourseLoading: boolean;
  readonly libraryAttachedContextRefs: LibraryContextRef[];
  readonly libraryArtifactPayloadsByToolCallId?: Record<string, LearningArtifactRenderPayload[]>;
  readonly libraryArtifactPreviewIdOverride?: string | null;
  readonly libraryArtifactPortalContainer?: HTMLElement | null;
  readonly libraryFloatingArtifactPayloads?: LearningArtifactRenderPayload[];
  readonly libraryErrorMessage: string | null;
  readonly libraryMessages: UIMessage[];
  readonly libraryTree: LibraryTree;
  readonly libraryWebSearch: boolean;
  readonly libraryGenerateArtifacts: boolean;
  readonly newCourseLoadingStatus: string;
  readonly pendingFileName: string | null;
  readonly pendingFileNames?: string[];
  readonly draftValueOverride?: string;
  readonly draftTemplate?: {
    id: string;
    mode?: HomeChatMode;
    selection?: { end: number; start: number };
    value: string;
  };
  readonly scrollProgressOverride?: number;
  readonly compactWhenEmpty?: boolean;
  readonly hideHeaderCopy?: boolean;
  readonly hideModeSelector?: boolean;
  readonly inputPlaceholder?: string;
  readonly showChatAvatars?: boolean;
  readonly onClearPendingFile: () => void;
  readonly onClearLibraryMessages?: () => void;
  readonly onCancelNewCourse?: StopGenerationHandler;
  readonly onContinueAssessment?: () => void;
  readonly onConfirmGenerate: () => void;
  readonly onHomeChatModeChange: (mode: HomeChatMode) => void;
  readonly onLibraryMessageSend: LibraryMessageSendHandler;
  readonly onLibraryArtifactNoteApprove?: (
    toolCallId: string,
    input: {
      artifactIds: string[];
      lessonId: string;
      noteDraft: string;
      projectId: string;
      rationale: string;
    }
  ) => Promise<void>;
  readonly onLibraryArtifactNoteReject?: (toolCallId: string) => void;
  readonly onLibraryArtifactDiscard?: (request: ChatArtifactActionRequest) => void;
  readonly onLibraryArtifactRegenerate?: (
    request: ChatArtifactRegenerateRequest
  ) => Promise<boolean> | boolean;
  readonly onLibraryArtifactReplace?: (request: ChatArtifactReplaceRequest) => Promise<void> | void;
  readonly onLibraryWebSearchChange: (value: boolean) => void;
  readonly onLibraryGenerateArtifactsChange: (value: boolean) => void;
  readonly onSendAssessmentMessage: (message: string) => Promise<void>;
  readonly onToggleLibraryContextRef: (reference: LibraryContextRef) => void;
  readonly onUploadSourceClick: () => void;
}

const MOBILE_ACTIVE_CHAT_VIEWPORT_RATIO = 0.75;
const readIsMobileViewport = () =>
  globalThis.window !== undefined ? globalThis.window.innerWidth < 768 : false;

const getMobileChatStyle = (
  isMobileViewport: boolean,
  viewportHeight: number | null,
  hasActiveChat: boolean
) => {
  if (!isMobileViewport || viewportHeight == null) return undefined;
  if (hasActiveChat) {
    return { height: `${Math.floor(viewportHeight * MOBILE_ACTIVE_CHAT_VIEWPORT_RATIO)}px` };
  }
  return { maxHeight: `${viewportHeight}px` };
};

const HomeChatModeSelector = ({
  homeChatMode,
  onChange,
}: {
  readonly homeChatMode: HomeChatMode;
  readonly onChange: (mode: HomeChatMode) => void;
}) => (
  <div
    className="relative inline-flex rounded-full border border-gray-300/80 bg-white p-1 shadow-[0_1px_2px_rgba(24,24,27,0.04)] dark:border-white/10 dark:bg-stone-900/80"
    role="tablist"
    aria-label={t('Modalità home chat')}
  >
    {(
      [
        { icon: BookPlus, label: t('Nuovo corso'), mode: 'new-course' },
        { icon: Folder, label: t('Consulta libreria'), mode: 'library-query' },
      ] as const
    ).map(option => {
      const Icon = option.icon;
      const isActive = homeChatMode === option.mode;
      return (
        <button
          key={option.mode}
          type="button"
          role="tab"
          aria-selected={isActive}
          onClick={() => onChange(option.mode)}
          className={`relative inline-flex items-center gap-1.5 rounded-full px-4 py-2 text-xs font-medium transition-colors sm:gap-2 sm:px-5 sm:py-2.5 sm:text-sm ${
            isActive
              ? 'text-white dark:text-stone-900'
              : 'text-gray-500 hover:text-gray-800 dark:text-zinc-400 dark:hover:text-zinc-100'
          }`}
        >
          {isActive ? (
            <motion.span
              layoutId="home-chat-mode-pill"
              className="absolute inset-0 rounded-full bg-stone-900 dark:bg-stone-100"
              transition={{ duration: 0.15, ease: [0.2, 0.85, 0.25, 1] }}
              aria-hidden="true"
            />
          ) : null}
          <span className="relative z-10 inline-flex items-center gap-1.5 sm:gap-2">
            <Icon className="h-4 w-4" />
            {option.label}
          </span>
        </button>
      );
    })}
  </div>
);

const HomeChatHeader = ({
  hideHeaderCopy,
  hideModeSelector,
  homeChatMode,
  onModeChange,
}: {
  readonly hideHeaderCopy: boolean;
  readonly hideModeSelector: boolean;
  readonly homeChatMode: HomeChatMode;
  readonly onModeChange: (mode: HomeChatMode) => void;
}) => {
  if (hideHeaderCopy && hideModeSelector) return null;
  const title =
    homeChatMode === 'new-course' ? t('Imposta un nuovo corso') : t('Consulta la tua libreria');
  const description =
    homeChatMode === 'new-course'
      ? t('Bastano poche righe: obiettivo, livello di partenza, scadenza e materiale disponibile.')
      : t('Interroga corsi, lezioni, note e highlight della libreria.');
  return (
    <div className="rounded-t-[2rem] border-b border-gray-200/55 py-4 pl-5 pr-16 dark:border-zinc-700/40 sm:pl-6 sm:pr-20">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        {hideHeaderCopy ? (
          <div />
        ) : (
          <div data-testid="home-chat-mode-copy" className="min-h-[6rem] sm:min-h-[4.5rem]">
            <div className="flex flex-wrap items-center gap-3">
              <h2 className="font-serif text-2xl text-gray-900 dark:text-zinc-100">{title}</h2>
            </div>
            <p className="mt-1.5 max-w-2xl text-sm leading-6 text-gray-600 dark:text-zinc-400">
              {description}
            </p>
          </div>
        )}
        <div className="flex self-start items-center gap-2">
          {hideModeSelector ? null : (
            <HomeChatModeSelector homeChatMode={homeChatMode} onChange={onModeChange} />
          )}
        </div>
      </div>
    </div>
  );
};

const HomeChatClearButton = ({
  homeChatMode,
  isLoading,
  onCancelNewCourse,
  onClearLibraryMessages,
}: {
  readonly homeChatMode: HomeChatMode;
  readonly isLoading: boolean;
  readonly onCancelNewCourse?: StopGenerationHandler;
  readonly onClearLibraryMessages?: () => void;
}) => {
  const label =
    homeChatMode === 'new-course' ? t('Annulla creazione corso') : t('Pulisci questa chat');
  return (
    <button
      type="button"
      onClick={homeChatMode === 'new-course' ? onCancelNewCourse : onClearLibraryMessages}
      disabled={isLoading}
      className="absolute right-3 top-3 z-10 inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-gray-300/80 bg-white text-gray-500 shadow-[0_1px_2px_rgba(24,24,27,0.04)] transition-colors hover:border-gray-400 hover:text-gray-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-stone-500 disabled:cursor-not-allowed disabled:opacity-50 sm:right-4 sm:top-4 dark:border-white/10 dark:bg-stone-900/80 dark:text-zinc-400 dark:hover:border-zinc-500 dark:hover:text-zinc-100 dark:focus-visible:ring-stone-300"
      title={label}
      aria-label={label}
    >
      <Trash2 className="h-4 w-4" />
    </button>
  );
};

export default function HomeChatPanel({
  assessmentComplete,
  assessmentMessages,
  homeChatMode,
  isDarkMode,
  isLibraryLoading,
  isLibraryModeLoading,
  isNewCourseLoading,
  libraryAttachedContextRefs,
  libraryArtifactPayloadsByToolCallId = {},
  libraryArtifactPreviewIdOverride,
  libraryArtifactPortalContainer,
  libraryFloatingArtifactPayloads = [],
  libraryErrorMessage,
  libraryMessages,
  libraryTree,
  libraryWebSearch,
  libraryGenerateArtifacts,
  newCourseLoadingStatus,
  pendingFileName,
  pendingFileNames,
  draftValueOverride,
  draftTemplate,
  scrollProgressOverride,
  compactWhenEmpty = false,
  hideHeaderCopy = false,
  hideModeSelector = false,
  inputPlaceholder,
  showChatAvatars = false,
  onClearPendingFile,
  onClearLibraryMessages,
  onCancelNewCourse,
  onContinueAssessment,
  onConfirmGenerate,
  onHomeChatModeChange,
  onLibraryMessageSend,
  onLibraryArtifactNoteApprove = async () => {},
  onLibraryArtifactNoteReject = () => {},
  onLibraryArtifactDiscard,
  onLibraryArtifactRegenerate = () => false,
  onLibraryArtifactReplace = () => {},
  onLibraryWebSearchChange,
  onLibraryGenerateArtifactsChange,
  onSendAssessmentMessage,
  onToggleLibraryContextRef,
  onUploadSourceClick,
}: HomeChatPanelProps) {
  const [isMobileViewport, setIsMobileViewport] = useState(readIsMobileViewport);
  const [activeSurface, setActiveSurface] = useState<HomeChatSurfaceState>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const { viewportHeight } = useMobileKeyboardOffset();
  const visibleLibraryMessages = useMemo(
    () => getActiveLibraryMessages(libraryMessages),
    [libraryMessages]
  );
  const activeMessages =
    homeChatMode === 'new-course' ? assessmentMessages : visibleLibraryMessages;
  const isLoading = homeChatMode === 'new-course' ? isNewCourseLoading : isLibraryModeLoading;
  const hasActiveChat = activeMessages.length > 0 || isLoading || assessmentComplete;
  const isLibraryAwaitingFirstResponse =
    homeChatMode === 'library-query' &&
    isLoading &&
    !visibleLibraryMessages.some(message => message.role === 'assistant');
  const showClearChat =
    (homeChatMode === 'library-query' &&
      visibleLibraryMessages.length > 0 &&
      Boolean(onClearLibraryMessages)) ||
    (homeChatMode === 'new-course' && assessmentMessages.length > 0 && Boolean(onCancelNewCourse));
  const reserveClearButtonSpace = showClearChat && hideHeaderCopy && hideModeSelector;
  const mobileChatStyle = getMobileChatStyle(isMobileViewport, viewportHeight, hasActiveChat);
  const isCompactSurface = compactWhenEmpty && !hasActiveChat;
  const onStopGeneration =
    homeChatMode === 'new-course' ? onCancelNewCourse : onLibraryMessageSend.stop;

  useEffect(() => {
    if (globalThis.window === undefined) return;
    const updateViewport = () => setIsMobileViewport(readIsMobileViewport());
    updateViewport();
    globalThis.window.addEventListener('resize', updateViewport);
    return () => globalThis.window.removeEventListener('resize', updateViewport);
  }, []);

  return (
    <section
      className={`relative max-md:flex max-md:flex-col ${
        isCompactSurface
          ? 'rounded-none bg-transparent shadow-none dark:bg-transparent dark:shadow-none'
          : 'rounded-[2rem] bg-[rgba(248,245,240,0.96)] shadow-[inset_0_1px_3px_rgba(24,24,27,0.05),inset_0_0_0_1px_rgba(88,64,32,0.04)] dark:bg-[rgba(46,40,36,0.94)] dark:shadow-[inset_0_0_0_1px_rgba(255,255,255,0.06)]'
      } ${hasActiveChat ? 'max-md:h-[75dvh] max-md:overflow-hidden' : ''}`}
      style={mobileChatStyle}
    >
      {showClearChat ? (
        <HomeChatClearButton
          homeChatMode={homeChatMode}
          isLoading={isLoading}
          onCancelNewCourse={onCancelNewCourse}
          onClearLibraryMessages={onClearLibraryMessages}
        />
      ) : null}

      <HomeChatHeader
        hideHeaderCopy={hideHeaderCopy}
        hideModeSelector={hideModeSelector}
        homeChatMode={homeChatMode}
        onModeChange={mode => {
          setActiveSurface(null);
          onHomeChatModeChange(mode);
        }}
      />

      <HomeChatConversation
        assessmentComplete={assessmentComplete}
        assessmentMessages={assessmentMessages}
        compactWhenEmpty={compactWhenEmpty}
        homeChatMode={homeChatMode}
        inputRef={inputRef}
        isDarkMode={isDarkMode}
        isLibraryAwaitingFirstResponse={isLibraryAwaitingFirstResponse}
        isLoading={isLoading}
        isMobileViewport={isMobileViewport}
        libraryArtifactPayloadsByToolCallId={libraryArtifactPayloadsByToolCallId}
        libraryArtifactPortalContainer={libraryArtifactPortalContainer}
        libraryArtifactPreviewIdOverride={libraryArtifactPreviewIdOverride}
        libraryErrorMessage={libraryErrorMessage}
        libraryFloatingArtifactPayloads={libraryFloatingArtifactPayloads}
        newCourseLoadingStatus={newCourseLoadingStatus}
        onConfirmGenerate={onConfirmGenerate}
        onContinueAssessment={onContinueAssessment}
        onLibraryArtifactNoteApprove={onLibraryArtifactNoteApprove}
        onLibraryArtifactNoteReject={onLibraryArtifactNoteReject}
        onLibraryArtifactDiscard={onLibraryArtifactDiscard}
        onLibraryArtifactRegenerate={onLibraryArtifactRegenerate}
        onLibraryArtifactReplace={onLibraryArtifactReplace}
        reserveClearButtonSpace={reserveClearButtonSpace}
        scrollProgressOverride={scrollProgressOverride}
        showChatAvatars={showChatAvatars}
        visibleLibraryMessages={visibleLibraryMessages}
      />

      <HomeChatComposer
        activeSurface={activeSurface}
        assessmentComplete={assessmentComplete}
        assessmentMessages={assessmentMessages}
        compactSurface={isCompactSurface}
        draftTemplate={draftTemplate}
        draftValueOverride={draftValueOverride}
        homeChatMode={homeChatMode}
        inputPlaceholder={inputPlaceholder}
        inputRef={inputRef}
        isLibraryLoading={isLibraryLoading}
        isLoading={isLoading}
        isMobileViewport={isMobileViewport}
        libraryAttachedContextRefs={libraryAttachedContextRefs}
        libraryGenerateArtifacts={libraryGenerateArtifacts}
        libraryTree={libraryTree}
        libraryWebSearch={libraryWebSearch}
        onClearPendingFile={onClearPendingFile}
        onActiveSurfaceChange={setActiveSurface}
        onLibraryGenerateArtifactsChange={onLibraryGenerateArtifactsChange}
        onLibraryMessageSend={onLibraryMessageSend}
        onLibraryWebSearchChange={onLibraryWebSearchChange}
        onSendAssessmentMessage={onSendAssessmentMessage}
        onStopGeneration={onStopGeneration}
        onToggleLibraryContextRef={onToggleLibraryContextRef}
        onUploadSourceClick={onUploadSourceClick}
        pendingFileName={pendingFileName}
        pendingFileNames={pendingFileNames}
        viewportHeight={viewportHeight}
      />
    </section>
  );
}
