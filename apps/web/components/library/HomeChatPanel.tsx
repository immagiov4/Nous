import type { UIMessage } from 'ai';
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
  type LibraryMessageSendHandler,
  type StopGenerationHandler,
} from './HomeChatComposer.tsx';
import HomeChatConversation from './HomeChatConversation.tsx';
import HomeChatPanelFrame from './HomeChatPanelFrame.tsx';
import { useHomeChatPanelState } from './useHomeChatPanelState.ts';

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
  const {
    activeSurface,
    hasActiveChat,
    inputRef,
    isCompactSurface,
    isLibraryAwaitingFirstResponse,
    isLoading,
    isMobileViewport,
    onModeChange,
    onStopGeneration,
    setActiveSurface,
    showClearChat,
    viewportHeight,
    visibleLibraryMessages,
  } = useHomeChatPanelState({
    assessmentComplete,
    assessmentMessages,
    compactWhenEmpty,
    homeChatMode,
    isLibraryModeLoading,
    isNewCourseLoading,
    libraryMessages,
    onCancelNewCourse,
    onClearLibraryMessages,
    onHomeChatModeChange,
    onLibraryMessageSend,
  });
  const reserveClearButtonSpace = showClearChat && hideHeaderCopy && hideModeSelector;

  return (
    <HomeChatPanelFrame
      hasActiveChat={hasActiveChat}
      hideHeaderCopy={hideHeaderCopy}
      hideModeSelector={hideModeSelector}
      homeChatMode={homeChatMode}
      isAnyChatLoading={isLibraryModeLoading || isNewCourseLoading}
      isCompactSurface={isCompactSurface}
      isLoading={isLoading}
      isMobileViewport={isMobileViewport}
      onCancelNewCourse={onCancelNewCourse}
      onClearLibraryMessages={onClearLibraryMessages}
      onModeChange={onModeChange}
      showClearChat={showClearChat}
      viewportHeight={viewportHeight}
    >
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
    </HomeChatPanelFrame>
  );
}
