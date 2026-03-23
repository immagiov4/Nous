import { X } from 'lucide-react';
import ContextMenu from '../ContextMenu.tsx';
import MarkdownRenderer from '../MarkdownRenderer.tsx';
import type { WorkspaceReaderOverlaysModel } from './types.ts';

export default function WorkspaceReaderOverlays({
  contextAnswer,
  contextAnswerPanelRef,
  contextAnswerResizePreviewRef,
  contextAnswerSize,
  contextMenu,
  contextMenuRef,
  handleContextAnswerResizeStart,
  isContextLoading,
  isDarkMode,
  isMobileViewport,
  onAskContextQuestion,
  onCloseContextAnswer,
  onCloseContextMenu,
  onCreateLesson,
  onHighlight,
}: WorkspaceReaderOverlaysModel) {
  return (
    <>
      {contextAnswer ? (
        <>
          <div
            ref={contextAnswerPanelRef}
            className={`fixed z-50 flex flex-col overflow-hidden rounded-2xl border border-orange-100 bg-white px-6 pb-6 pt-5 shadow-[0_10px_40px_-10px_rgba(0,0,0,0.2)] animate-in slide-in-from-bottom-10 duration-500 dark:border-orange-900/30 dark:bg-zinc-800 ${
              isMobileViewport ? 'inset-x-3 bottom-24 top-24' : 'top-6 right-8'
            }`}
            style={isMobileViewport ? undefined : contextAnswerSize}
          >
            <button
              type="button"
              onClick={onCloseContextAnswer}
              className="absolute right-4 top-4 rounded-full bg-gray-50 p-1 text-gray-400 hover:text-gray-600 dark:bg-zinc-800 dark:hover:text-gray-300"
            >
              <X className="h-4 w-4" />
            </button>
            <p className="mb-3 shrink-0 border-l-2 border-orange-500 pl-3 pr-12 font-serif text-base font-bold text-gray-900 dark:text-gray-100">
              "{contextAnswer.q}"
            </p>
            <div className="custom-scrollbar min-h-0 flex-1 overflow-auto pr-2 text-sm leading-relaxed text-gray-600 dark:text-gray-300">
              <MarkdownRenderer
                content={contextAnswer.a}
                isDarkMode={isDarkMode}
                className="prose-sm prose-p:text-gray-600 dark:prose-p:text-gray-300"
              />
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
                  <path
                    d="M1 1L15 15"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                  />
                  <path
                    d="M1 5L11 15"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                  />
                  <path
                    d="M1 9L7 15"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                  />
                </svg>
              </button>
            ) : null}
          </div>
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
          containerRef={contextMenuRef}
          onClose={onCloseContextMenu}
          onAsk={onAskContextQuestion}
          onCreateLesson={onCreateLesson}
          onHighlight={onHighlight}
          isLoading={isContextLoading}
        />
      ) : null}
    </>
  );
}
