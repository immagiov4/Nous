import { BookOpen, LoaderCircle, MousePointerClick, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { buildInlineQuizLayout } from '../../../utils/reader/inlineQuiz.ts';
import MarkdownRenderer from '../../shared/MarkdownRenderer.tsx';
import ThinkingStream from '../../shared/ThinkingStream.tsx';
import WorkspaceLaboratoryContent from '../laboratory/WorkspaceLaboratoryContent.tsx';
import type { WorkspaceReaderContentModel } from './types.ts';
import WorkspaceReaderInlineQuestion from './WorkspaceReaderInlineQuestion.tsx';
import WorkspaceReaderQuizFooter from './WorkspaceReaderQuizFooter.tsx';

const CONTEXT_MENU_HINT_STORAGE_KEY = 'nous-context-menu-hint-dismissed';

function LessonGenerationSkeleton({
  isDarkMode,
  isMobileViewport,
  lessonTitle,
  reasoningText,
}: {
  isDarkMode: boolean;
  isMobileViewport: boolean;
  lessonTitle?: string | null;
  reasoningText?: string;
}) {
  const hasReasoningText = Boolean(reasoningText?.trim());

  return (
    <output className="mx-auto mt-8 block max-w-3xl space-y-8" aria-live="polite">
      <div className="flex items-center gap-3 text-sm font-semibold text-gray-500 dark:text-zinc-400">
        <LoaderCircle className="h-4 w-4 animate-spin text-orange-600 dark:text-orange-300" />
        <span>Generazione lezione...</span>
        {lessonTitle && !isMobileViewport ? (
          <span className="min-w-0 truncate text-gray-400 dark:text-zinc-500">{lessonTitle}</span>
        ) : null}
      </div>
      <ThinkingStream
        className="min-h-[14rem] h-[58dvh] max-h-[36rem] sm:h-[68vh] sm:max-h-[48rem]"
        isDarkMode={isDarkMode}
        text={reasoningText}
      />
      <div className={`${hasReasoningText ? 'opacity-25' : ''} animate-pulse space-y-8`}>
        <div className="mb-12 h-8 w-3/4 rounded bg-gray-200 dark:bg-zinc-800" />
        <div className="space-y-3">
          <div className="h-4 w-full rounded bg-gray-200 dark:bg-zinc-800" />
          <div className="h-4 w-full rounded bg-gray-200 dark:bg-zinc-800" />
          <div className="h-4 w-5/6 rounded bg-gray-200 dark:bg-zinc-800" />
        </div>
      </div>
    </output>
  );
}

export default function WorkspaceReaderContent({
  activeLaboratoryExercise,
  activeSectionTitle,
  activeSectionAssetsById,
  activeSectionGeneratedVisualsById = {},
  activeSectionImageRefsById,
  contentRef,
  isDarkMode,
  isFocusMode,
  isLoading,
  isLaboratoryEvaluating,
  isLaboratoryGenerating,
  isLaboratoryView,
  isMobileViewport,
  laboratoryReasoningText,
  onCompleteSection,
  onAddLaboratoryTextAttachment,
  onAttachLaboratoryFiles,
  onContentClick,
  onContentContextMenu,
  onContentPointerDownCapture,
  onEvaluateActiveLaboratoryExercise,
  onGenerateLaboratory,
  onRemoveLaboratoryAttachment,
  onSelectQuizAnswer,
  quiz,
  quizAnswers,
  scrollContainerRef,
  sectionAnnotations,
  sectionContent,
  sectionReasoningText,
  laboratoryActivityMessage,
  laboratoryEvaluatedCount = 0,
  laboratoryErrorMessage,
  laboratorySourcePageRangeLabel,
  laboratorySubmittedCount = 0,
  laboratoryStatus,
  laboratorySummary,
  laboratoryTitle,
  laboratoryTotalExerciseCount = 0,
  sourcePageRangeLabel,
  onUpdateLaboratoryAttachmentMetadata,
  onUpdateLaboratoryTextAttachment,
}: WorkspaceReaderContentModel) {
  const [isContextHintVisible, setIsContextHintVisible] = useState(false);
  const readingShellClassName = isFocusMode
    ? 'max-w-[72rem] px-4 pb-36 pt-8 sm:px-8 lg:px-12 xl:px-16'
    : 'max-w-[90rem] px-4 pb-36 pt-8 sm:px-8 lg:px-14 xl:px-20 2xl:px-24';
  const readingColumnClassName = isFocusMode ? 'mx-auto max-w-[76ch]' : 'mx-auto max-w-[82ch]';
  const renderedSectionContent = useMemo(
    () =>
      sectionContent && sourcePageRangeLabel
        ? `${sectionContent.trim()}\n\n&nbsp;\n\n*Fonte originale: ${sourcePageRangeLabel}*`
        : sectionContent,
    [sectionContent, sourcePageRangeLabel]
  );
  const inlineQuizLayout = useMemo(
    () => buildInlineQuizLayout(renderedSectionContent || '', quiz.length),
    [quiz.length, renderedSectionContent]
  );
  const unansweredQuestionCount = useMemo(
    () => quizAnswers.filter(answer => answer < 0).length,
    [quizAnswers]
  );
  const canCompleteSection = quiz.length === 0 || unansweredQuestionCount === 0;
  const shouldShowLessonSkeleton = isLoading || Boolean(activeSectionTitle && !sectionContent);

  useEffect(() => {
    if (typeof window === 'undefined' || isLaboratoryView || !sectionContent) {
      return;
    }

    setIsContextHintVisible(window.localStorage.getItem(CONTEXT_MENU_HINT_STORAGE_KEY) !== 'true');
  }, [isLaboratoryView, sectionContent]);

  const dismissContextHint = () => {
    setIsContextHintVisible(false);
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(CONTEXT_MENU_HINT_STORAGE_KEY, 'true');
    }
  };

  // Reset scroll when entering skeleton mode — the container uses
  // overflow-hidden while generating, so a stale scroll offset would
  // clip the thinking-stream header and spinner.
  useEffect(() => {
    if (shouldShowLessonSkeleton && scrollContainerRef.current) {
      scrollContainerRef.current.scrollTop = 0;
    }
  }, [shouldShowLessonSkeleton, scrollContainerRef]);

  const scrollContainerClassName = shouldShowLessonSkeleton
    ? 'relative flex-1 min-w-0 overflow-hidden overscroll-none'
    : 'relative flex-1 min-w-0 overflow-y-auto overflow-x-hidden overscroll-y-contain scroll-smooth';

  return (
    <div
      ref={scrollContainerRef}
      className={scrollContainerClassName}
      style={{ touchAction: shouldShowLessonSkeleton ? 'none' : 'pan-y' }}
    >
      {isLaboratoryView ? (
        <WorkspaceLaboratoryContent
          activeExercise={activeLaboratoryExercise}
          activityMessage={laboratoryActivityMessage}
          activityStreamText={laboratoryReasoningText}
          isDarkMode={isDarkMode}
          isEvaluating={isLaboratoryEvaluating}
          isGenerating={isLaboratoryGenerating}
          laboratoryEvaluatedCount={laboratoryEvaluatedCount}
          laboratoryErrorMessage={laboratoryErrorMessage}
          laboratorySubmittedCount={laboratorySubmittedCount}
          sourcePageRangeLabel={laboratorySourcePageRangeLabel}
          laboratoryStatus={laboratoryStatus}
          laboratorySummary={laboratorySummary}
          laboratoryTitle={laboratoryTitle}
          laboratoryTotalExerciseCount={laboratoryTotalExerciseCount}
          onAddTextAttachment={onAddLaboratoryTextAttachment}
          onAttachFiles={onAttachLaboratoryFiles}
          onEvaluate={onEvaluateActiveLaboratoryExercise}
          onGenerate={onGenerateLaboratory}
          onRemoveAttachment={onRemoveLaboratoryAttachment}
          onUpdateAttachmentMetadata={onUpdateLaboratoryAttachmentMetadata}
          onUpdateTextAttachment={onUpdateLaboratoryTextAttachment}
        />
      ) : (
        <div
          className={`mx-auto w-full min-w-0 transition-all duration-500 ${readingShellClassName}`}
        >
          <section
            ref={contentRef}
            className="mb-8 min-h-[50vh] min-w-0"
            onPointerDownCapture={onContentPointerDownCapture}
          >
            {shouldShowLessonSkeleton ? (
              <LessonGenerationSkeleton
                isDarkMode={isDarkMode}
                isMobileViewport={isMobileViewport}
                lessonTitle={activeSectionTitle}
                reasoningText={sectionReasoningText}
              />
            ) : sectionContent ? (
              <div className={`${readingColumnClassName} space-y-2`}>
                {isContextHintVisible ? (
                  <div className="mb-6 flex items-start gap-3 rounded-2xl border border-orange-200/80 bg-orange-50/80 px-4 py-3 text-sm leading-6 text-orange-900 dark:border-orange-900/50 dark:bg-orange-950/25 dark:text-orange-100">
                    <MousePointerClick className="mt-0.5 h-4 w-4 shrink-0 text-orange-600 dark:text-orange-300" />
                    <p className="min-w-0 flex-1">
                      Seleziona un passaggio e fai click destro per chiedere spiegazioni, aggiungere
                      una nota o creare una lezione di approfondimento.
                    </p>
                    <button
                      type="button"
                      onClick={dismissContextHint}
                      className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-orange-600 transition-colors hover:bg-orange-100 hover:text-orange-800 dark:text-orange-200 dark:hover:bg-orange-900/40"
                      aria-label="Nascondi suggerimento selezione testo"
                    >
                      <X className="h-4 w-4" />
                    </button>
                  </div>
                ) : null}
                {inlineQuizLayout.map(chunk => (
                  <div key={`${chunk.questionIndexes.join('-')}::${chunk.markdown.slice(0, 64)}`}>
                    <MarkdownRenderer
                      content={chunk.markdown}
                      generatedVisualsById={activeSectionGeneratedVisualsById}
                      isDarkMode={isDarkMode}
                      lessonAssetsById={activeSectionAssetsById}
                      lessonImageRefsById={activeSectionImageRefsById}
                      onClick={onContentClick}
                      onContextMenu={onContentContextMenu}
                      sectionAnnotations={sectionAnnotations}
                      className={`prose-lg leading-7 sm:prose-xl sm:leading-loose
                      prose-p:text-gray-800 dark:prose-p:text-gray-200
                      prose-headings:font-serif prose-headings:font-normal
                      prose-headings:text-gray-900 dark:prose-headings:text-white
                      prose-strong:font-semibold
                      prose-strong:text-orange-800 dark:prose-strong:text-orange-400
                      ${isDarkMode ? 'prose-invert' : ''}
                    `}
                    />

                    {chunk.questionIndexes.map(questionIndex => {
                      const question = quiz[questionIndex];
                      if (!question) {
                        return null;
                      }

                      return (
                        <WorkspaceReaderInlineQuestion
                          key={`${question.question}-${questionIndex}`}
                          isDarkMode={isDarkMode}
                          onSelectQuizAnswer={onSelectQuizAnswer}
                          question={question}
                          questionIndex={questionIndex}
                          selectedIndex={quizAnswers[questionIndex] ?? -1}
                        />
                      );
                    })}
                  </div>
                ))}

                <WorkspaceReaderQuizFooter
                  canComplete={canCompleteSection}
                  onCompleteSection={onCompleteSection}
                  remainingQuestionCount={unansweredQuestionCount}
                />
              </div>
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
        </div>
      )}
    </div>
  );
}
