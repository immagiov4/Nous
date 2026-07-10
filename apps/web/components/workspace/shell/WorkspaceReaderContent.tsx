import {
  Archive,
  Bold,
  BookOpen,
  ClipboardCheck,
  Code2,
  Eye,
  EyeOff,
  FileText,
  Heading2,
  List,
  LoaderCircle,
  MousePointerClick,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import { memo, useEffect, useMemo, useRef, useState } from 'react';
import type {
  ApplicationExerciseNode,
  LearningArtifactRenderPayload,
  LessonGeneratedVisual,
  SectionAnnotation,
} from '../../../types.ts';
import { getGeneratedVisualSourceLabel } from '../../../utils/learning/artifacts.ts';
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
    sourceLabel: getGeneratedVisualSourceLabel(visual),
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

const TOOLBAR_BUTTON_CLASS_NAME =
  'inline-flex h-9 w-9 items-center justify-center rounded-full border border-gray-200/80 bg-white text-gray-600 transition-colors hover:border-gray-300 hover:text-gray-900 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:border-zinc-500 dark:hover:text-white';

const EXERCISE_OBJECTIVE_HEADING_REGEX = /^(?:#{1,6}\s*)?obiettivo(?:\s+operativo)?\s*:?$/i;
const EXERCISE_BRIEF_SECTION_HEADING_REGEX =
  /^(?:#{1,6}\s*)?(?:scenario|traccia|consegna|attivit[aà]|cosa consegnare|output|vincoli|criteri(?:\s+di\s+verifica)?)\s*:?$/i;

const stripExerciseObjectiveSection = (brief: string): string => {
  const visibleLines: string[] = [];
  let isSkippingObjectiveSection = false;

  for (const line of brief.split(/\r?\n/)) {
    const trimmedLine = line.trim();

    if (EXERCISE_OBJECTIVE_HEADING_REGEX.test(trimmedLine)) {
      isSkippingObjectiveSection = true;
      continue;
    }

    if (isSkippingObjectiveSection) {
      if (!EXERCISE_BRIEF_SECTION_HEADING_REGEX.test(trimmedLine)) {
        continue;
      }
      isSkippingObjectiveSection = false;
    }

    visibleLines.push(line);
  }

  return visibleLines
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
};

const applySelectionTransform = (
  textarea: HTMLTextAreaElement,
  currentValue: string,
  transform: (
    selectedText: string,
    start: number,
    end: number
  ) => {
    nextSelectionEnd: number;
    nextSelectionStart: number;
    nextText: string;
  }
) => {
  const selectionStart = textarea.selectionStart;
  const selectionEnd = textarea.selectionEnd;
  const selectedText = currentValue.slice(selectionStart, selectionEnd);
  return transform(selectedText, selectionStart, selectionEnd);
};

function ExerciseInternalTextEditor({
  exercise,
  internalText,
  isDarkMode,
  onChange,
  onCommit,
}: {
  exercise: ApplicationExerciseNode;
  internalText: string;
  isDarkMode: boolean;
  onChange: (value: string) => void;
  onCommit: () => void;
}) {
  const [isPreviewOpen, setIsPreviewOpen] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (internalText === (exercise.internalText || '')) {
      return;
    }

    const timeoutId = window.setTimeout(onCommit, 300);
    return () => window.clearTimeout(timeoutId);
  }, [exercise.internalText, internalText, onCommit]);

  const withTextareaTransform = (
    transform: (
      selectedText: string,
      start: number,
      end: number
    ) => {
      nextSelectionEnd: number;
      nextSelectionStart: number;
      nextText: string;
    }
  ) => {
    const textarea = textareaRef.current;
    if (!textarea) {
      return;
    }

    const result = applySelectionTransform(textarea, internalText, transform);
    onChange(result.nextText);
    requestAnimationFrame(() => {
      textarea.focus();
      textarea.setSelectionRange(result.nextSelectionStart, result.nextSelectionEnd);
    });
  };

  return (
    <article className="overflow-hidden rounded-xl border border-gray-200/80 bg-white/90 shadow-sm dark:border-zinc-700/80 dark:bg-zinc-900/85">
      <header className="space-y-2 border-b border-gray-200/80 px-4 py-4 dark:border-zinc-700/80">
        <div className="flex items-center gap-3">
          <div className="min-w-0 flex-1 rounded-xl border border-gray-200 bg-gray-50 px-3 py-2 text-sm font-semibold text-gray-900 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100">
            Risposta per {exercise.title}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            className={TOOLBAR_BUTTON_CLASS_NAME}
            onClick={() =>
              withTextareaTransform((selectedText, start, end) => {
                const replacement = `## ${selectedText || 'Titolo sezione'}`;
                const nextSelectionStart = start + replacement.length;
                return {
                  nextText: `${internalText.slice(0, start)}${replacement}${internalText.slice(end)}`,
                  nextSelectionEnd: nextSelectionStart,
                  nextSelectionStart,
                };
              })
            }
            title="Inserisci heading"
          >
            <Heading2 className="h-4 w-4" />
          </button>
          <button
            type="button"
            className={TOOLBAR_BUTTON_CLASS_NAME}
            onClick={() =>
              withTextareaTransform((selectedText, start, end) => {
                const replacement = `**${selectedText || 'testo'}**`;
                return {
                  nextText: `${internalText.slice(0, start)}${replacement}${internalText.slice(end)}`,
                  nextSelectionStart: start + 2,
                  nextSelectionEnd: start + replacement.length - 2,
                };
              })
            }
            title="Grassetto"
          >
            <Bold className="h-4 w-4" />
          </button>
          <button
            type="button"
            className={TOOLBAR_BUTTON_CLASS_NAME}
            onClick={() =>
              withTextareaTransform((selectedText, start, end) => {
                const replacement = (selectedText || 'voce lista')
                  .split(/\n/)
                  .map(line => `- ${line}`)
                  .join('\n');
                return {
                  nextText: `${internalText.slice(0, start)}${replacement}${internalText.slice(end)}`,
                  nextSelectionStart: start,
                  nextSelectionEnd: start + replacement.length,
                };
              })
            }
            title="Lista"
          >
            <List className="h-4 w-4" />
          </button>
          <button
            type="button"
            className={TOOLBAR_BUTTON_CLASS_NAME}
            onClick={() =>
              withTextareaTransform((selectedText, start, end) => {
                const replacement = `\n\`\`\`\n${selectedText || 'codice'}\n\`\`\`\n`;
                return {
                  nextText: `${internalText.slice(0, start)}${replacement}${internalText.slice(end)}`,
                  nextSelectionStart: start + 5,
                  nextSelectionEnd: start + replacement.length - 5,
                };
              })
            }
            title="Blocco codice"
          >
            <Code2 className="h-4 w-4" />
          </button>
          <button
            type="button"
            className={TOOLBAR_BUTTON_CLASS_NAME}
            onClick={() => setIsPreviewOpen(currentValue => !currentValue)}
            title={isPreviewOpen ? 'Chiudi anteprima' : 'Apri anteprima'}
          >
            {isPreviewOpen ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
          </button>
          <span className="ml-auto text-xs font-medium text-gray-500 dark:text-zinc-400">
            Salvataggio automatico
          </span>
        </div>
      </header>

      <div className="px-4 py-4">
        {isPreviewOpen ? (
          <div className="rounded-xl border border-gray-200/80 bg-gray-50/80 px-5 py-5 dark:border-zinc-700 dark:bg-zinc-950/70">
            <MarkdownRenderer
              content={internalText || '_Anteprima vuota_'}
              isDarkMode={isDarkMode}
              className={
                isDarkMode ? 'prose-invert prose-sm sm:prose-base' : 'prose-sm sm:prose-base'
              }
            />
          </div>
        ) : (
          <textarea
            ref={textareaRef}
            value={internalText}
            onChange={event => onChange(event.target.value)}
            onBlur={onCommit}
            spellCheck={false}
            className="min-h-[17rem] w-full rounded-xl border border-gray-200 bg-gray-50/80 px-4 py-4 font-mono text-sm leading-6 text-gray-900 outline-none transition-colors focus:border-gray-400 dark:border-zinc-700 dark:bg-zinc-950/80 dark:text-zinc-100 dark:focus:border-zinc-500"
            placeholder="Scrivi qui la tua consegna in Markdown o testo libero."
          />
        )}
      </div>
    </article>
  );
}

function ExerciseAttachmentCard({
  attachment,
  onRemove,
}: {
  attachment: ApplicationExerciseNode['attachments'][number];
  onRemove: (attachmentId: string) => void;
}) {
  const Icon = attachment.kind === 'archive' ? Archive : FileText;

  return (
    <article className="overflow-hidden rounded-xl border border-gray-200/80 bg-white/90 shadow-sm dark:border-zinc-700/80 dark:bg-zinc-900/85">
      <header className="flex items-start justify-between gap-3 border-b border-gray-200/80 px-4 py-4 dark:border-zinc-700/80">
        <div className="flex min-w-0 flex-1 items-start gap-3">
          <div className="mt-1 rounded-full border border-gray-200/80 bg-gray-50 p-2 text-gray-600 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-300">
            <Icon className="h-4 w-4" />
          </div>
          <div className="min-w-0 flex-1 space-y-2">
            <p className="truncate rounded-xl border border-gray-200 bg-gray-50 px-3 py-2 text-sm font-semibold text-gray-900 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100">
              {attachment.name}
            </p>
            <p className="text-xs uppercase tracking-[0.14em] text-gray-500 dark:text-zinc-400">
              {attachment.mimeType || 'application/octet-stream'}
            </p>
          </div>
        </div>

        <button
          type="button"
          onClick={() => onRemove(attachment.id)}
          title="Rimuovi allegato"
          className="inline-flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full text-red-500 transition-colors hover:bg-red-50 hover:text-red-700 dark:text-red-400 dark:hover:bg-red-950/40 dark:hover:text-red-300"
        >
          <Trash2 className="h-4 w-4" />
        </button>
      </header>

      <div className="space-y-3 px-4 py-4">
        <div className="rounded-xl border border-dashed border-gray-200/80 bg-gray-50/60 px-4 py-4 text-sm text-gray-600 dark:border-zinc-700 dark:bg-zinc-950/60 dark:text-zinc-300">
          {attachment.kind === 'archive'
            ? attachment.description ||
              'Archivio pronto per la valutazione. Il sistema leggerà solo file testuali supportati.'
            : 'File testuale pronto per la valutazione.'}
        </div>
        {attachment.truncatedReason ? (
          <p className="text-xs leading-5 text-amber-700 dark:text-amber-300">
            {attachment.truncatedReason}
          </p>
        ) : null}
      </div>
    </article>
  );
}

function ApplicationExerciseViewer({
  exercisePrerequisiteGaps,
  exercise,
  isDarkMode,
  isLoading,
  onAttachFiles,
  onRemoveAttachment,
  onUpdateInternalText,
}: {
  exercisePrerequisiteGaps: Array<{ id: string; title: string }>;
  exercise: ApplicationExerciseNode;
  isDarkMode: boolean;
  isLoading: boolean;
  onAttachFiles: (exerciseId: string, files: FileList | null) => void;
  onRemoveAttachment: (exerciseId: string, attachmentId: string) => void;
  onUpdateInternalText: (exerciseId: string, text: string) => void;
}) {
  const uploadInputRef = useRef<HTMLInputElement>(null);
  const [internalText, setInternalText] = useState(exercise.internalText || '');
  const brief = exercise.brief?.trim();
  const visibleBrief = brief ? stripExerciseObjectiveSection(brief) : '';
  const hasDeliverable = internalText.trim().length > 0 || exercise.attachments.length > 0;

  return (
    <div className="mx-auto max-w-[90rem] px-0 pb-20 pt-0">
      <article className="mx-auto max-w-[82ch] space-y-8">
        <header>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <div className="mb-3 flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.18em] text-gray-500 dark:text-zinc-400">
                <ClipboardCheck className="h-4 w-4" />
                Esercizio applicativo
              </div>
              <h2 className="font-serif text-3xl leading-tight text-gray-900 dark:text-gray-100">
                {exercise.title}
              </h2>
            </div>
          </div>
          <p className="mt-3 text-base leading-7 text-gray-600 dark:text-zinc-300">
            {exercise.description}
          </p>
        </header>

        {!brief && exercisePrerequisiteGaps.length > 0 ? (
          <section className="rounded-xl border border-amber-200/80 bg-amber-50/85 px-5 py-5 text-amber-950 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-100">
            <h2 className="font-serif text-xl font-normal">Prima genera le lezioni precedenti</h2>
            <p className="mt-2 text-sm leading-6">
              La consegna del laboratorio usa le lezioni gia scritte. Mancano ancora:
            </p>
            <ul className="mt-3 list-disc space-y-1 pl-5 text-sm">
              {exercisePrerequisiteGaps.map(gap => (
                <li key={gap.id}>{gap.title}</li>
              ))}
            </ul>
          </section>
        ) : null}

        {!brief && exercisePrerequisiteGaps.length === 0 ? (
          <section className="rounded-xl border border-gray-200/80 bg-white/90 px-5 py-8 text-center shadow-sm dark:border-zinc-700/80 dark:bg-zinc-900/85">
            {isLoading ? (
              <div className="flex items-center justify-center gap-3 text-sm font-semibold text-gray-600 dark:text-zinc-300">
                <LoaderCircle className="h-4 w-4 animate-spin text-orange-600 dark:text-orange-300" />
                Generazione consegna...
              </div>
            ) : (
              <div className="text-sm leading-6 text-gray-600 dark:text-zinc-300">
                Questo laboratorio è pianificato. Aprilo di nuovo per generare la consegna.
              </div>
            )}
          </section>
        ) : null}

        {brief ? (
          <>
            <section className="border-t border-gray-300 pt-6 dark:border-zinc-600">
              <p className="mb-4 text-xs font-semibold uppercase tracking-[0.18em] text-gray-500 dark:text-zinc-400">
                Traccia
              </p>
              <MarkdownRenderer
                content={visibleBrief}
                isDarkMode={isDarkMode}
                className={
                  isDarkMode ? 'prose-invert prose-base sm:prose-lg' : 'prose-base sm:prose-lg'
                }
              />
            </section>

            <section className="space-y-4 border-t border-gray-300 pt-6 dark:border-zinc-600">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <p className="text-xs font-semibold uppercase tracking-[0.18em] text-gray-500 dark:text-zinc-400">
                  Consegna
                </p>

                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={() => uploadInputRef.current?.click()}
                    className="inline-flex items-center gap-2 rounded-full border border-gray-200/80 bg-white px-4 py-2 text-xs font-semibold uppercase tracking-[0.12em] text-gray-700 transition-colors hover:border-gray-300 hover:text-gray-900 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:border-zinc-500 dark:hover:text-white"
                  >
                    <Upload className="h-4 w-4" />
                    Carica file
                  </button>
                  <button
                    type="button"
                    disabled={!hasDeliverable}
                    className="inline-flex items-center gap-2 rounded-full bg-gray-900 px-4 py-2 text-xs font-semibold uppercase tracking-[0.12em] text-gray-50 transition-colors hover:bg-gray-700 disabled:cursor-not-allowed disabled:opacity-60 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-white"
                  >
                    {exercise.feedbackStale ? 'Aggiorna riscontro' : 'Richiedi riscontro'}
                  </button>
                </div>
              </div>

              <input
                ref={uploadInputRef}
                type="file"
                multiple
                accept=".md,.txt,.json,.yaml,.yml,.toml,.csv,.tsv,.ts,.tsx,.js,.jsx,.py,.rs,.go,.java,.c,.cpp,.h,.css,.scss,.html,.zip"
                className="hidden"
                onChange={event => {
                  onAttachFiles(exercise.id, event.target.files);
                  event.target.value = '';
                }}
              />

              <ExerciseInternalTextEditor
                exercise={exercise}
                internalText={internalText}
                isDarkMode={isDarkMode}
                onChange={setInternalText}
                onCommit={() => {
                  if (internalText !== (exercise.internalText || '')) {
                    onUpdateInternalText(exercise.id, internalText);
                  }
                }}
              />

              {exercise.attachments.length === 0 && internalText.trim().length === 0 ? (
                <div className="rounded-xl border border-dashed border-gray-200/80 bg-gray-50/80 px-5 py-8 text-center text-sm leading-7 text-gray-500 dark:border-zinc-700 dark:bg-zinc-950/60 dark:text-zinc-400">
                  Scrivi una nota Markdown oppure carica file testuali o archivi ZIP. Tutto cio che
                  produci qui resta una consegna persistente e verra usato nella valutazione.
                </div>
              ) : (
                <div className="space-y-4">
                  {exercise.attachments.map(attachment => (
                    <ExerciseAttachmentCard
                      key={attachment.id}
                      attachment={attachment}
                      onRemove={attachmentId => onRemoveAttachment(exercise.id, attachmentId)}
                    />
                  ))}
                </div>
              )}
            </section>

            <section className="border-t border-gray-300 pt-6 dark:border-zinc-600">
              <div className="mb-4 flex items-center justify-between gap-3">
                <p className="text-xs font-semibold uppercase tracking-[0.18em] text-gray-500 dark:text-zinc-400">
                  Correzione AI
                </p>
                {exercise.currentFeedback ? (
                  <span className="inline-flex items-center gap-2 rounded-full border border-emerald-200/80 bg-emerald-50 px-3 py-2 text-xs font-semibold uppercase tracking-[0.14em] text-emerald-700 dark:border-emerald-900/60 dark:bg-emerald-950/40 dark:text-emerald-300">
                    Score {exercise.currentFeedback.score}/100
                  </span>
                ) : null}
              </div>
              {exercise.currentFeedback ? (
                <div className="space-y-4 text-sm leading-6 text-gray-700 dark:text-zinc-300">
                  <div className="rounded-xl border border-emerald-200/70 bg-emerald-50/70 px-4 py-4 dark:border-emerald-900/50 dark:bg-emerald-950/30">
                    <p className="font-semibold text-emerald-900 dark:text-emerald-200">
                      {exercise.currentFeedback.qualitativeLabel}
                    </p>
                    <p className="mt-2 text-emerald-800 dark:text-emerald-300">
                      {exercise.currentFeedback.summary}
                    </p>
                  </div>
                  {exercise.feedbackStale ? (
                    <p className="text-sm text-amber-600 dark:text-amber-300">Riscontro datato.</p>
                  ) : null}
                </div>
              ) : (
                <p className="text-sm text-gray-400 dark:text-zinc-500">
                  Nessuna valutazione disponibile. Aggiungi una consegna e richiedi un riscontro.
                </p>
              )}
            </section>
          </>
        ) : null}
      </article>
    </div>
  );
}

const WorkspaceReaderContent = memo(function WorkspaceReaderContent({
  activeExercise,
  exercisePrerequisiteGaps = [],
  activeSectionTitle,
  activeSectionAssetsById,
  activeSectionGeneratedVisualsById = {},
  activeSectionImageRefsById,
  hasNextSection,
  contentRef,
  currentLessonArtifactPayloads = [],
  isDarkMode,
  isFocusMode,
  isLoading,
  isMobileViewport,
  onAdvanceSection,
  onAttachExerciseFiles,
  onCompleteSection,
  onContentClick,
  onContentContextMenu,
  onContentPointerDownCapture,
  onSelectQuizAnswer,
  onRemoveExerciseAttachment,
  quiz,
  quizAnswers,
  scrollContainerRef,
  sectionAnnotations,
  sectionContent,
  sectionReasoningText,
  onUpdateExerciseInternalText,
  sourcePageRangeLabel,
  ttsTextPicker,
}: WorkspaceReaderContentModel) {
  const [hasDismissedContextHint, setHasDismissedContextHint] = useState(() => {
    if (typeof window === 'undefined') {
      return false;
    }
    return window.localStorage.getItem(CONTEXT_MENU_HINT_STORAGE_KEY) === 'true';
  });
  const readingShellClassName = isFocusMode
    ? 'max-w-[72rem] px-4 pb-36 pt-4 sm:px-8 sm:pt-8 lg:px-12 xl:px-16'
    : 'max-w-[90rem] px-4 pb-36 pt-4 sm:px-8 sm:pt-8 lg:px-14 xl:px-20 2xl:px-24';
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
  const shouldShowLessonSkeleton =
    !activeExercise && (isLoading || Boolean(activeSectionTitle && !sectionContent));
  const isContextHintVisible = Boolean(sectionContent) && !hasDismissedContextHint;

  const dismissContextHint = () => {
    setHasDismissedContextHint(true);
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
      {ttsTextPicker.isActive ? (
        <p className="sr-only" aria-live="polite">
          {ttsTextPicker.hoveredChunkIndex === null
            ? 'Selezione dal testo attiva. Passa su una parte e fai clic per sceglierla.'
            : `Parte ${ttsTextPicker.hoveredChunkIndex + 1} evidenziata. Fai clic per sceglierla.`}
        </p>
      ) : null}
      {ttsTextPicker.overlayRects.map((rect, index) => (
        <div
          key={`${rect.top}:${rect.left}:${rect.width}:${rect.height}`}
          data-testid="tts-text-picker-overlay"
          className="pointer-events-none fixed z-40 rounded-md border border-orange-500/80 bg-orange-300/20 shadow-[0_0_0_2px_rgba(249,115,22,0.12)] transition-[top,height] duration-75 dark:border-orange-400/90 dark:bg-orange-400/15"
          style={rect}
        >
          {index === 0 && ttsTextPicker.hoveredChunkIndex !== null ? (
            <span className="absolute -top-7 left-0 rounded-full bg-orange-600 px-2 py-1 text-[10px] font-semibold text-white shadow-sm dark:bg-orange-500 dark:text-stone-950">
              Parte {ttsTextPicker.hoveredChunkIndex + 1}
            </span>
          ) : null}
        </div>
      ))}
      <div
        className={`mx-auto w-full min-w-0 transition-all duration-500 ${readingShellClassName}`}
      >
        <section
          ref={contentRef}
          aria-label="Area di lettura"
          className="mb-8 min-h-[50vh] min-w-0"
          onContextMenu={onContentContextMenu}
          onPointerDownCapture={onContentPointerDownCapture}
        >
          {activeExercise ? (
            <ApplicationExerciseViewer
              key={`${activeExercise.id}:${activeExercise.updatedAt}`}
              exercise={activeExercise}
              exercisePrerequisiteGaps={exercisePrerequisiteGaps}
              isDarkMode={isDarkMode}
              isLoading={isLoading}
              onAttachFiles={onAttachExerciseFiles}
              onRemoveAttachment={onRemoveExerciseAttachment}
              onUpdateInternalText={onUpdateExerciseInternalText}
            />
          ) : shouldShowLessonSkeleton ? (
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
                hasNextSection={hasNextSection}
                onAdvanceSection={onAdvanceSection}
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
