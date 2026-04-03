import { BookOpen } from 'lucide-react';
import MarkdownRenderer from '../../shared/MarkdownRenderer.tsx';
import WorkspaceReaderQuiz from './WorkspaceReaderQuiz.tsx';
import type { WorkspaceReaderContentModel } from './types.ts';

export default function WorkspaceReaderContent({
  activeSectionAssetsById,
  activeSectionImageRefsById,
  contentRef,
  isDarkMode,
  isFocusMode,
  isLoading,
  isMobileViewport,
  isQuizSubmitted,
  onCompleteSection,
  onContentClick,
  onContentContextMenu,
  onContentPointerDownCapture,
  onSelectQuizAnswer,
  onSetIsQuizSubmitted,
  quiz,
  quizAnswers,
  scrollContainerRef,
  sectionAnnotations,
  sectionContent,
}: WorkspaceReaderContentModel) {
  const readingShellClassName = isFocusMode
    ? 'max-w-[72rem] px-4 pb-36 pt-8 sm:px-8 lg:px-12 xl:px-16'
    : 'max-w-[90rem] px-4 pb-36 pt-8 sm:px-8 lg:px-14 xl:px-20 2xl:px-24';
  const readingColumnClassName = isFocusMode
    ? 'mx-auto max-w-[76ch]'
    : 'mx-auto max-w-[82ch]';

  return (
    <div
      ref={scrollContainerRef}
      className="relative flex-1 min-w-0 overflow-y-auto overflow-x-hidden scroll-smooth"
    >
      <div
        className={`mx-auto w-full min-w-0 transition-all duration-500 ${readingShellClassName}`}
      >
        <section
          ref={contentRef}
          className="mb-16 min-h-[50vh] min-w-0"
          onPointerDownCapture={onContentPointerDownCapture}
        >
          {isLoading ? (
            <div className="mx-auto mt-8 max-w-3xl animate-pulse space-y-8">
              <div className="mb-12 h-8 w-3/4 rounded bg-gray-200 dark:bg-zinc-800" />
              <div className="space-y-3">
                <div className="h-4 w-full rounded bg-gray-200 dark:bg-zinc-800" />
                <div className="h-4 w-full rounded bg-gray-200 dark:bg-zinc-800" />
                <div className="h-4 w-5/6 rounded bg-gray-200 dark:bg-zinc-800" />
              </div>
            </div>
          ) : sectionContent ? (
            <MarkdownRenderer
              content={sectionContent}
              isDarkMode={isDarkMode}
              lessonAssetsById={activeSectionAssetsById}
              lessonImageRefsById={activeSectionImageRefsById}
              onClick={onContentClick}
              onContextMenu={onContentContextMenu}
              sectionAnnotations={sectionAnnotations}
              className={`prose-lg leading-7 sm:prose-xl sm:leading-loose
                ${readingColumnClassName}
                prose-p:text-gray-800 dark:prose-p:text-gray-200
                prose-headings:font-serif prose-headings:font-normal
                prose-headings:text-gray-900 dark:prose-headings:text-white
                prose-strong:font-semibold
                prose-strong:text-orange-800 dark:prose-strong:text-orange-400
                ${isDarkMode ? 'prose-invert' : ''}
              `}
            />
          ) : (
            <div className="mt-16 flex flex-col items-center text-center text-gray-400 sm:mt-20">
              <BookOpen className="mb-4 h-16 w-16 opacity-20" />
              <p>
                {isMobileViewport
                  ? 'Apri il menu lezioni per scegliere cosa leggere.'
                  : 'Seleziona una sezione dal piano di studi per iniziare.'}
              </p>
            </div>
          )}
        </section>

        {quiz.length > 0 && sectionContent ? (
          <div
            data-testid="reader-quiz-column"
            className={`${readingColumnClassName} w-full`}
          >
            <WorkspaceReaderQuiz
              isQuizSubmitted={isQuizSubmitted}
              onCompleteSection={onCompleteSection}
              onSelectQuizAnswer={onSelectQuizAnswer}
              onSetIsQuizSubmitted={onSetIsQuizSubmitted}
              quiz={quiz}
              quizAnswers={quizAnswers}
            />
          </div>
        ) : null}
      </div>
    </div>
  );
}
