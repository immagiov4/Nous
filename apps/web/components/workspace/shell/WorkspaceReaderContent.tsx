import { BookOpen, LoaderCircle, MousePointerClick, X } from 'lucide-react';
import { memo, useEffect, useMemo, useState } from 'react';
import type {
  LearningArtifactRenderPayload,
  LessonGeneratedVisual,
  SectionAnnotation,
} from '../../../types.ts';
import { buildInlineQuizLayout } from '../../../utils/reader/inlineQuiz.ts';
import ChatArtifactRenderer from '../../shared/ChatArtifactRenderer.tsx';
import MarkdownRenderer from '../../shared/MarkdownRenderer.tsx';
import ThinkingStream from '../../shared/ThinkingStream.tsx';
import type { WorkspaceReaderContentModel } from './types.ts';
import WorkspaceReaderInlineQuestion from './WorkspaceReaderInlineQuestion.tsx';
import WorkspaceReaderQuizFooter from './WorkspaceReaderQuizFooter.tsx';

const CONTEXT_MENU_HINT_STORAGE_KEY = 'nous-context-menu-hint-dismissed';

const createFallbackVisualArtifactPayload = ({
  activeSectionTitle,
  artifactId,
  title,
  visual,
}: {
  activeSectionTitle?: string | null;
  artifactId: string;
  title?: string;
  visual: LessonGeneratedVisual;
}): LearningArtifactRenderPayload => ({
  searchText: '',
  summary: {
    createdAt: visual.createdAt,
    id: artifactId,
    kind: 'generated-visual',
    lessonId: '',
    lessonTitle: activeSectionTitle || '',
    previewMode: visual.kind === 'html' ? 'chip-only' : 'thumbnail',
    projectId: '',
    projectTitle: '',
    sourceLabel: visual.kind === 'html' ? 'Interattivo' : 'Visuale',
    title: title || visual.title?.replace(/[_-]+/g, ' ').trim() || 'Esempio visuale',
  },
  visual,
});

const resolveAnnotationArtifactPayloads = ({
  activeSectionGeneratedVisualsById,
  activeSectionTitle,
  annotation,
  artifactPayloadById,
}: {
  activeSectionGeneratedVisualsById: WorkspaceReaderContentModel['activeSectionGeneratedVisualsById'];
  activeSectionTitle?: string | null;
  annotation: SectionAnnotation;
  artifactPayloadById: Map<string, LearningArtifactRenderPayload>;
}): LearningArtifactRenderPayload[] =>
  (annotation.artifactRefs || []).flatMap(ref => {
    const payload = artifactPayloadById.get(ref.artifactId);
    if (payload) {
      return [payload];
    }

    if (ref.kind !== 'generated-visual') {
      return [];
    }

    const visualId = ref.artifactId.split(':').pop() || '';
    const visual = activeSectionGeneratedVisualsById?.[visualId];
    return visual
      ? [
          createFallbackVisualArtifactPayload({
            activeSectionTitle,
            artifactId: ref.artifactId,
            title: ref.title,
            visual,
          }),
        ]
      : [];
  });

const dedupeArtifactPayloads = (
  payloads: LearningArtifactRenderPayload[]
): LearningArtifactRenderPayload[] => {
  const seenIds = new Set<string>();
  return payloads.filter(payload => {
    if (seenIds.has(payload.summary.id)) {
      return false;
    }
    seenIds.add(payload.summary.id);
    return true;
  });
};

const isSavedGeneratedVisualPayload = (payload: LearningArtifactRenderPayload) =>
  payload.summary.kind === 'generated-visual' &&
  'visual' in payload &&
  payload.visual.id.startsWith('visual-draft-');

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

const WorkspaceReaderContent = memo(function WorkspaceReaderContent({
  activeSectionTitle,
  activeSectionAssetsById,
  activeSectionGeneratedVisualsById = {},
  activeSectionImageRefsById,
  contentRef,
  currentLessonArtifactPayloads = [],
  isDarkMode,
  isFocusMode,
  isLoading,
  isMobileViewport,
  onCompleteSection,
  onContentClick,
  onContentContextMenu,
  onContentPointerDownCapture,
  onSelectQuizAnswer,
  quiz,
  quizAnswers,
  scrollContainerRef,
  sectionAnnotations,
  sectionContent,
  sectionReasoningText,
  sourcePageRangeLabel,
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
  const lessonAnnotations = useMemo(
    () => (sectionAnnotations || []).filter(annotation => annotation.anchor?.kind === 'lesson'),
    [sectionAnnotations]
  );
  const artifactPayloadById = useMemo(
    () => new Map(currentLessonArtifactPayloads.map(payload => [payload.summary.id, payload])),
    [currentLessonArtifactPayloads]
  );
  const lessonAnnotationArtifactIds = useMemo(
    () =>
      new Set(
        lessonAnnotations.flatMap(annotation =>
          resolveAnnotationArtifactPayloads({
            activeSectionGeneratedVisualsById,
            activeSectionTitle,
            annotation,
            artifactPayloadById,
          }).map(payload => payload.summary.id)
        )
      ),
    [activeSectionGeneratedVisualsById, activeSectionTitle, artifactPayloadById, lessonAnnotations]
  );
  const sectionArtifactPayloads = useMemo(
    () =>
      dedupeArtifactPayloads([
        ...currentLessonArtifactPayloads
          .filter(isSavedGeneratedVisualPayload)
          .filter(payload => !lessonAnnotationArtifactIds.has(payload.summary.id)),
        ...(sectionAnnotations || [])
          .filter(annotation => annotation.anchor?.kind !== 'lesson')
          .flatMap(annotation =>
            resolveAnnotationArtifactPayloads({
              activeSectionGeneratedVisualsById,
              activeSectionTitle,
              annotation,
              artifactPayloadById,
            })
          ),
      ]),
    [
      activeSectionGeneratedVisualsById,
      activeSectionTitle,
      artifactPayloadById,
      currentLessonArtifactPayloads,
      lessonAnnotationArtifactIds,
      sectionAnnotations,
    ]
  );
  const unansweredQuestionCount = useMemo(
    () => quizAnswers.filter(answer => answer < 0).length,
    [quizAnswers]
  );
  const canCompleteSection = quiz.length === 0 || unansweredQuestionCount === 0;
  const shouldShowLessonSkeleton = isLoading || Boolean(activeSectionTitle && !sectionContent);

  useEffect(() => {
    if (typeof window === 'undefined' || !sectionContent) {
      return;
    }

    setIsContextHintVisible(window.localStorage.getItem(CONTEXT_MENU_HINT_STORAGE_KEY) !== 'true');
  }, [sectionContent]);

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

              {sectionArtifactPayloads.length > 0 ? (
                <section className="mt-10 space-y-3 border-t border-stone-200/80 pt-6 dark:border-stone-700">
                  <h2 className="font-serif text-2xl font-normal text-gray-900 dark:text-white">
                    Artefatti
                  </h2>
                  <ChatArtifactRenderer
                    artifacts={sectionArtifactPayloads}
                    className="grid gap-2 sm:grid-cols-2"
                    isDarkMode={isDarkMode}
                  />
                </section>
              ) : null}

              {lessonAnnotations.length > 0 ? (
                <section className="mt-10 space-y-3 border-t border-stone-200/80 pt-6 dark:border-stone-700">
                  <h2 className="font-serif text-2xl font-normal text-gray-900 dark:text-white">
                    Artefatti della lezione
                  </h2>
                  {lessonAnnotations.map(annotation => {
                    const annotationArtifacts = resolveAnnotationArtifactPayloads({
                      activeSectionGeneratedVisualsById,
                      activeSectionTitle,
                      annotation,
                      artifactPayloadById,
                    });
                    const hasNoteText = annotation.note?.trim().length > 0;

                    return (
                      <article key={annotation.id}>
                        {hasNoteText ? (
                          <div className="rounded-[1.2rem] border border-stone-200/80 bg-white/80 px-4 py-4 shadow-[0_12px_34px_-30px_rgba(46,34,16,0.45)] dark:border-stone-700 dark:bg-stone-900/35">
                            <MarkdownRenderer
                              content={annotation.note}
                              isDarkMode={isDarkMode}
                              className={`prose-sm max-w-none leading-6 text-stone-800 dark:text-stone-100 ${
                                isDarkMode ? 'prose-invert' : ''
                              }`}
                            />
                          </div>
                        ) : null}
                        {annotationArtifacts.length > 0 ? (
                          <div className={hasNoteText ? 'mt-3' : ''}>
                            <ChatArtifactRenderer
                              artifacts={annotationArtifacts}
                              className="grid gap-2 sm:grid-cols-2"
                              isDarkMode={isDarkMode}
                            />
                          </div>
                        ) : null}
                      </article>
                    );
                  })}
                </section>
              ) : null}

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
    </div>
  );
});

export default WorkspaceReaderContent;
