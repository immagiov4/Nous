import { BookOpen } from 'lucide-react';
import { buildInlineQuizLayout } from '../../../utils/reader/inlineQuiz.ts';
import MarkdownRenderer from '../../shared/MarkdownRenderer.tsx';
import WorkspaceLaboratoryContent from '../laboratory/WorkspaceLaboratoryContent.tsx';
import type { WorkspaceReaderContentModel } from './types.ts';
import WorkspaceReaderInlineQuestion from './WorkspaceReaderInlineQuestion.tsx';
import WorkspaceReaderQuizFooter from './WorkspaceReaderQuizFooter.tsx';

export default function WorkspaceReaderContent({
  activeLaboratoryExercise,
  activeSectionAssetsById,
  activeSectionImageRefsById,
  contentRef,
  isDarkMode,
  isFocusMode,
  isLoading,
  isLaboratoryEvaluating,
  isLaboratoryGenerating,
  isLaboratoryView,
  isMobileViewport,
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
  laboratoryActivityMessage,
  laboratoryErrorMessage,
  laboratorySourcePageRangeLabel,
  laboratoryStatus,
  laboratorySummary,
  laboratoryTitle,
  sourcePageRangeLabel,
  onUpdateLaboratoryAttachmentMetadata,
  onUpdateLaboratoryTextAttachment,
}: WorkspaceReaderContentModel) {
  const readingShellClassName = isFocusMode
    ? 'max-w-[72rem] px-4 pb-36 pt-8 sm:px-8 lg:px-12 xl:px-16'
    : 'max-w-[90rem] px-4 pb-36 pt-8 sm:px-8 lg:px-14 xl:px-20 2xl:px-24';
  const readingColumnClassName = isFocusMode ? 'mx-auto max-w-[76ch]' : 'mx-auto max-w-[82ch]';
  const renderedSectionContent =
    sectionContent && sourcePageRangeLabel
      ? `${sectionContent.trim()}\n\n&nbsp;\n\n*Fonte originale: ${sourcePageRangeLabel}*`
      : sectionContent;
  const inlineQuizLayout = buildInlineQuizLayout(renderedSectionContent || '', quiz.length);
  const unansweredQuestionCount = quizAnswers.filter(answer => answer < 0).length;
  const canCompleteSection = quiz.length === 0 || unansweredQuestionCount === 0;

  return (
    <div
      ref={scrollContainerRef}
      className="relative flex-1 min-w-0 overflow-y-auto overflow-x-hidden overscroll-y-contain scroll-smooth"
      style={{ touchAction: 'pan-y' }}
    >
      {isLaboratoryView ? (
        <WorkspaceLaboratoryContent
          activeExercise={activeLaboratoryExercise}
          activityMessage={laboratoryActivityMessage}
          isDarkMode={isDarkMode}
          isEvaluating={isLaboratoryEvaluating}
          isGenerating={isLaboratoryGenerating}
          laboratoryErrorMessage={laboratoryErrorMessage}
          sourcePageRangeLabel={laboratorySourcePageRangeLabel}
          laboratoryStatus={laboratoryStatus}
          laboratorySummary={laboratorySummary}
          laboratoryTitle={laboratoryTitle}
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
              <div className={`${readingColumnClassName} space-y-2`}>
                {inlineQuizLayout.map(chunk => (
                  <div key={`${chunk.questionIndexes.join('-')}::${chunk.markdown.slice(0, 64)}`}>
                    <MarkdownRenderer
                      content={chunk.markdown}
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
