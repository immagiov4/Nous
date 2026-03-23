import { MessageSquare, X } from 'lucide-react';
import ContextMenu from '../ContextMenu.tsx';
import MarkdownRenderer from '../MarkdownRenderer.tsx';
import type { WorkspaceReaderOverlaysModel } from './types.ts';

export default function WorkspaceReaderOverlays({
  contextAnswer,
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
        <div
          className={`fixed z-50 flex flex-col overflow-hidden rounded-2xl border border-orange-100 bg-white p-6 shadow-[0_10px_40px_-10px_rgba(0,0,0,0.2)] animate-in slide-in-from-bottom-10 duration-500 dark:border-orange-900/30 dark:bg-zinc-900 ${
            isMobileViewport ? 'inset-x-3 bottom-24 top-24' : 'bottom-24 right-8'
          }`}
          style={isMobileViewport ? undefined : contextAnswerSize}
        >
          <div className="mb-4 flex items-start justify-between gap-3">
            <div className="flex items-center gap-2 rounded-full bg-orange-50 px-3 py-1 text-xs font-bold uppercase tracking-wider text-orange-600 dark:bg-orange-900/20 dark:text-orange-400">
              <MessageSquare className="h-3 w-3" /> Risposta AI
            </div>
            <button
              type="button"
              onClick={onCloseContextAnswer}
              className="rounded-full bg-gray-50 p-1 text-gray-400 hover:text-gray-600 dark:bg-zinc-800 dark:hover:text-gray-300"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
          <p className="mb-3 shrink-0 border-l-2 border-orange-500 pl-3 font-serif text-base font-bold text-gray-900 dark:text-gray-100">
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
              onMouseDown={handleContextAnswerResizeStart}
              className="absolute bottom-3 left-3 flex h-5 w-5 cursor-nesw-resize items-end justify-start rounded-sm text-orange-300 transition-colors hover:text-orange-500 dark:text-orange-700 dark:hover:text-orange-400"
            >
              <svg viewBox="0 0 16 16" fill="none" className="h-4 w-4">
                <title>Ridimensiona pannello risposta</title>
                <path
                  d="M1 15L15 1"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                />
                <path
                  d="M1 11L11 1"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                />
                <path
                  d="M1 7L7 1"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                />
              </svg>
            </button>
          ) : null}
        </div>
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
