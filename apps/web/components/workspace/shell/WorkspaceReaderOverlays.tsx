import { memo } from 'react';
import { translateUiMessage as t } from '../../../i18n/uiMessages.ts';
import ContextMenu from '../ContextMenu.tsx';
import ContextAnswerPanel from './ContextAnswerPanel.tsx';
import type { WorkspaceReaderOverlaysModel } from './types.ts';

function WorkspaceReaderOverlays({
  contextAnswerArtifactActionFeedbackOverride,
  contextAnswerArtifactPreviewIdOverride,
  contextAnswerArtifactPortalContainer,
  contextAnswerAutoScrollKey,
  contextAnswer,
  contextAnswerDisplayMessages,
  contextAnswerPanelRef,
  contextAnswerResizePreviewRef,
  contextAnswerSize,
  contextAnswerInputValue,
  contextAnswerMessagesScrollTopOverride,
  contextMenu,
  contextMenuAskInputValue,
  contextMenuArtifactPreviewIdOverride,
  contextMenuArtifactPortalContainer,
  contextMenuMotionProgressOverride,
  contextMenuNotePreviewScrollTopOverride,
  contextMenuRef,
  handleContextAnswerResizeStart,
  isContextLoading,
  isDarkMode,
  isMobileViewport,
  lessonCreationBlockReason,
  loadDocumentSourceFile,
  currentLessonArtifactPayloads,
  onAskContextQuestion,
  onAttachArtifactToAnnotation,
  onCloseContextAnswer,
  onCloseContextMenu,
  onCreateLesson,
  onDeleteAnnotation,
  onDetachArtifactFromAnnotation,
  onHighlight,
  onSaveConversationNote,
  onUpdateConversationNote,
  onSaveNote,
  onSaveArtifactToLesson,
  onReplaceArtifactInLesson,
}: WorkspaceReaderOverlaysModel) {
  return (
    <>
      {contextAnswer ? (
        <>
          {isMobileViewport ? (
            <button
              type="button"
              data-context-answer-backdrop="true"
              aria-label={t('Chiudi follow-up dallo sfondo')}
              className="absolute inset-0 z-40 bg-black/40"
              onClick={onCloseContextAnswer}
            />
          ) : null}
          <ContextAnswerPanel
            key={contextAnswer.id}
            artifactActionFeedbackOverride={contextAnswerArtifactActionFeedbackOverride}
            artifactPreviewIdOverride={contextAnswerArtifactPreviewIdOverride}
            artifactPortalContainer={contextAnswerArtifactPortalContainer}
            autoScrollKey={contextAnswerAutoScrollKey}
            contextAnswer={contextAnswer}
            displayMessages={contextAnswerDisplayMessages}
            contextAnswerPanelRef={contextAnswerPanelRef}
            contextAnswerSize={contextAnswerSize}
            handleContextAnswerResizeStart={handleContextAnswerResizeStart}
            currentLessonArtifactPayloads={currentLessonArtifactPayloads}
            isDarkMode={isDarkMode}
            inputValueOverride={contextAnswerInputValue}
            isMobileViewport={isMobileViewport}
            loadDocumentSourceFile={loadDocumentSourceFile}
            messagesScrollTopOverride={contextAnswerMessagesScrollTopOverride}
            onClose={onCloseContextAnswer}
            onSaveConversationNote={onSaveConversationNote}
            onUpdateConversationNote={onUpdateConversationNote}
            onSaveArtifactToLesson={onSaveArtifactToLesson}
            onReplaceArtifactInLesson={onReplaceArtifactInLesson}
          />
          {!isMobileViewport ? (
            <div
              ref={contextAnswerResizePreviewRef}
              aria-hidden="true"
              className="pointer-events-none fixed right-8 top-6 z-[60] hidden rounded-2xl border border-stone-300/80 bg-white/45 shadow-[0_14px_44px_-18px_rgba(15,23,42,0.22)] backdrop-blur-[1px] dark:border-stone-500/60 dark:bg-zinc-900/30"
            />
          ) : null}
        </>
      ) : null}

      {contextMenu.visible ? (
        <ContextMenu
          {...contextMenu}
          askInputValue={contextMenuAskInputValue}
          artifactPreviewIdOverride={contextMenuArtifactPreviewIdOverride}
          artifactPortalContainer={contextMenuArtifactPortalContainer}
          artifactPayloads={currentLessonArtifactPayloads}
          containerRef={contextMenuRef}
          isDarkMode={isDarkMode}
          motionProgressOverride={contextMenuMotionProgressOverride}
          notePreviewScrollTopOverride={contextMenuNotePreviewScrollTopOverride}
          onClose={onCloseContextMenu}
          onAttachArtifactToAnnotation={onAttachArtifactToAnnotation}
          onAsk={onAskContextQuestion}
          onCreateLesson={onCreateLesson}
          onDeleteAnnotation={onDeleteAnnotation}
          onDetachArtifactFromAnnotation={onDetachArtifactFromAnnotation}
          onHighlight={onHighlight}
          isLoading={isContextLoading}
          lessonCreationBlockReason={lessonCreationBlockReason}
          onSaveNote={onSaveNote}
        />
      ) : null}
    </>
  );
}

export default memo(WorkspaceReaderOverlays);
