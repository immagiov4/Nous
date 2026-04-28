import {
  Archive,
  ChevronDown,
  ChevronRight,
  File,
  FileImage,
  FileText,
  FlaskConical,
  LoaderCircle,
  Plus,
  Sparkles,
  Trash2,
  Upload,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  LaboratoryAttachment,
  LaboratoryExercise,
  LaboratoryStateStatus,
} from '../../../types.ts';
import MarkdownRenderer from '../../shared/MarkdownRenderer.tsx';
import ThinkingStream from '../../shared/ThinkingStream.tsx';
import LaboratoryTextAttachmentEditor from './LaboratoryTextAttachmentEditor.tsx';

interface WorkspaceLaboratoryContentProps {
  activeExercise: LaboratoryExercise | null;
  activityMessage?: string;
  activityStreamText?: string;
  isDarkMode: boolean;
  isEvaluating: boolean;
  isGenerating: boolean;
  laboratoryErrorMessage?: string;
  laboratoryEvaluatedCount?: number;
  sourcePageRangeLabel?: string;
  laboratorySubmittedCount?: number;
  laboratoryStatus: LaboratoryStateStatus | null;
  laboratorySummary: string;
  laboratoryTitle: string;
  laboratoryTotalExerciseCount?: number;
  onAddTextAttachment: () => void;
  onAttachFiles: (files: FileList | null) => void;
  onEvaluate: () => void;
  onGenerate: () => void;
  onRemoveAttachment: (attachmentId: string) => void;
  onUpdateAttachmentMetadata: (
    attachmentId: string,
    updates: { description?: string; name?: string }
  ) => void;
  onUpdateTextAttachment: (
    attachmentId: string,
    updates: { content: string; name?: string }
  ) => void;
}

interface AttachmentCardProps {
  attachment: LaboratoryAttachment;
  onRemove: (attachmentId: string) => void;
  onUpdateMetadata: (
    attachmentId: string,
    updates: { description?: string; name?: string }
  ) => void;
}

const resolveAttachmentIcon = (attachment: LaboratoryAttachment) => {
  switch (attachment.kind) {
    case 'archive':
      return Archive;
    case 'image':
      return FileImage;
    case 'text':
      return FileText;
    default:
      return File;
  }
};

function LaboratoryAttachmentCard({ attachment, onRemove, onUpdateMetadata }: AttachmentCardProps) {
  const [draftName, setDraftName] = useState(attachment.name);
  const [draftDescription, setDraftDescription] = useState(attachment.description || '');
  const previewUrl = useMemo(
    () =>
      attachment.kind === 'image' ? `data:${attachment.mimeType};base64,${attachment.data}` : null,
    [attachment]
  );
  const Icon = resolveAttachmentIcon(attachment);

  useEffect(() => {
    setDraftName(attachment.name);
  }, [attachment.name]);

  useEffect(() => {
    setDraftDescription(attachment.description || '');
  }, [attachment.description]);

  useEffect(() => {
    const normalizedName = draftName.trim() || attachment.name;
    if (normalizedName === attachment.name && draftDescription === (attachment.description || '')) {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      onUpdateMetadata(attachment.id, {
        description: draftDescription,
        name: normalizedName,
      });
    }, 300);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [
    attachment.description,
    attachment.id,
    attachment.name,
    draftDescription,
    draftName,
    onUpdateMetadata,
  ]);

  return (
    <article className="overflow-hidden rounded-xl border border-gray-200/80 bg-white/90 shadow-sm dark:border-zinc-700/80 dark:bg-zinc-900/85">
      <header className="flex items-start justify-between gap-3 border-b border-gray-200/80 px-4 py-4 dark:border-zinc-700/80">
        <div className="flex min-w-0 flex-1 items-start gap-3">
          <div className="mt-1 rounded-full border border-gray-200/80 bg-gray-50 p-2 text-gray-600 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-300">
            <Icon className="h-4 w-4" />
          </div>
          <div className="min-w-0 flex-1 space-y-2">
            <input
              type="text"
              value={draftName}
              onChange={event => setDraftName(event.target.value)}
              className="w-full rounded-xl border border-gray-200 bg-gray-50 px-3 py-2 text-sm font-semibold text-gray-900 outline-none transition-colors focus:border-gray-400 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100 dark:focus:border-zinc-500"
            />
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

      <div className="space-y-4 px-4 py-4">
        {previewUrl ? (
          <div className="overflow-hidden rounded-xl border border-gray-200/80 bg-gray-50/60 dark:border-zinc-700 dark:bg-zinc-950/60">
            <img
              src={previewUrl}
              alt={attachment.name}
              className="block max-h-[24rem] w-full object-contain"
            />
          </div>
        ) : null}

        <label className="block space-y-2">
          <span className="text-xs font-semibold uppercase tracking-[0.14em] text-gray-500 dark:text-zinc-400">
            Descrizione utile al valutatore
          </span>
          <textarea
            value={draftDescription}
            onChange={event => setDraftDescription(event.target.value)}
            className="min-h-[7rem] w-full rounded-xl border border-gray-200 bg-gray-50/80 px-4 py-3 text-sm leading-6 text-gray-800 outline-none transition-colors focus:border-gray-400 dark:border-zinc-700 dark:bg-zinc-950/80 dark:text-zinc-100 dark:focus:border-zinc-500"
            placeholder={
              attachment.kind === 'image'
                ? "Spiega cosa mostra l'immagine, cosa vuoi far notare e come va interpretata."
                : 'Aggiungi contesto utile se il file non e autoesplicativo.'
            }
          />
        </label>

        {!previewUrl ? (
          <div className="rounded-xl border border-dashed border-gray-200/80 bg-gray-50/60 px-4 py-4 text-sm text-gray-600 dark:border-zinc-700 dark:bg-zinc-950/60 dark:text-zinc-300">
            {attachment.kind === 'archive'
              ? "Archivio pronto per la valutazione. Se contiene file importanti, aggiungi una breve descrizione del contenuto o dell'obiettivo."
              : 'Questo file verrà usato come allegato di supporto. Aggiungi una descrizione se il contenuto non è immediatamente leggibile.'}
          </div>
        ) : null}
      </div>
    </article>
  );
}

const evaluationBadgeClassName =
  'inline-flex items-center gap-2 rounded-full border border-emerald-200/80 bg-emerald-50 px-3 py-2 text-xs font-semibold uppercase tracking-[0.14em] text-emerald-700 dark:border-emerald-900/60 dark:bg-emerald-950/40 dark:text-emerald-300';

const evaluationSectionClassNameByTone = {
  neutral:
    'border-gray-200/70 bg-gray-50/70 text-gray-700 dark:border-zinc-700 dark:bg-zinc-950/50 dark:text-zinc-300',
  warning:
    'border-amber-200/70 bg-amber-50/70 text-amber-900 dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-200',
};

function renderEvaluationSection({
  items,
  title,
  tone = 'neutral',
}: {
  items: string[];
  title: string;
  tone?: keyof typeof evaluationSectionClassNameByTone;
}) {
  if (items.length === 0) {
    return null;
  }

  return (
    <div className={`rounded-xl border px-4 py-4 ${evaluationSectionClassNameByTone[tone]}`}>
      <p className="text-xs font-semibold uppercase tracking-[0.14em] opacity-75">{title}</p>
      <ul className="mt-3 list-disc space-y-2 pl-5">
        {items.map(item => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    </div>
  );
}

export default function WorkspaceLaboratoryContent({
  activeExercise,
  activityMessage,
  activityStreamText,
  isDarkMode,
  isEvaluating,
  isGenerating,
  laboratoryErrorMessage,
  laboratoryEvaluatedCount = 0,
  sourcePageRangeLabel,
  laboratorySubmittedCount = 0,
  laboratoryStatus,
  laboratorySummary,
  laboratoryTitle,
  laboratoryTotalExerciseCount = 0,
  onAddTextAttachment,
  onAttachFiles,
  onEvaluate,
  onGenerate,
  onRemoveAttachment,
  onUpdateAttachmentMetadata,
  onUpdateTextAttachment,
}: WorkspaceLaboratoryContentProps) {
  const uploadInputRef = useRef<HTMLInputElement>(null);
  const [isExampleOpen, setIsExampleOpen] = useState(false);
  const previousActiveExerciseIdRef = useRef(activeExercise?.id ?? null);
  const canGenerateLaboratory = laboratoryStatus !== 'ready';
  const progressSummary =
    laboratoryTotalExerciseCount > 0
      ? `${laboratorySubmittedCount}/${laboratoryTotalExerciseCount} consegnati - ${laboratoryEvaluatedCount}/${laboratoryTotalExerciseCount} valutati`
      : null;
  const readyStateHint =
    laboratoryStatus === 'ready'
      ? "Apri una traccia del laboratorio dalla sidebar. Se vuoi rifarla, apri quella traccia e usa Rigenera nell'header."
      : null;
  const emptyStateMessage =
    laboratoryStatus === 'ready'
      ? activityMessage ||
        laboratorySummary ||
        'Il laboratorio e pronto. Apri una traccia dalla sidebar per lavorarci.'
      : laboratoryErrorMessage ||
        activityMessage ||
        laboratorySummary ||
        'Genera una fase pratica separata dal corso e apri il primo esercizio.';

  useEffect(() => {
    const activeExerciseId = activeExercise?.id ?? null;
    if (previousActiveExerciseIdRef.current === activeExerciseId) {
      return;
    }

    previousActiveExerciseIdRef.current = activeExerciseId;
    setIsExampleOpen(false);
  }, [activeExercise?.id]);

  if (!activeExercise) {
    return (
      <div className="mx-auto flex w-full max-w-[72rem] flex-1 items-center px-4 pb-24 pt-10 sm:px-8 lg:px-12">
        <section className="mx-auto w-full max-w-3xl rounded-[2rem] border border-gray-200/80 bg-white/90 px-6 py-8 text-center shadow-sm dark:border-zinc-700/80 dark:bg-zinc-900/90 sm:px-8 sm:py-10">
          <div className="mx-auto mb-5 flex h-16 w-16 items-center justify-center rounded-full border border-gray-200/80 bg-gray-50 text-gray-700 dark:border-zinc-700/60 dark:bg-zinc-900/60 dark:text-zinc-300">
            {isGenerating || laboratoryStatus === 'pending' ? (
              <LoaderCircle className="h-7 w-7 animate-spin" />
            ) : (
              <FlaskConical className="h-7 w-7" />
            )}
          </div>
          <h2 className="font-serif text-2xl text-gray-900 dark:text-gray-100">
            {laboratoryTitle || 'Laboratorio'}
          </h2>
          <p className="mt-3 text-sm leading-7 text-gray-600 dark:text-zinc-300">
            {emptyStateMessage}
          </p>
          <ThinkingStream
            className="mx-auto mt-6 max-h-[18rem] max-w-2xl overflow-hidden text-left"
            isDarkMode={isDarkMode}
            text={activityStreamText}
          />
          {readyStateHint ? (
            <p className="mt-3 text-sm leading-7 text-gray-500 dark:text-zinc-400">
              {readyStateHint}
            </p>
          ) : null}
          {canGenerateLaboratory ? (
            <div className="mt-6 flex justify-center">
              <button
                type="button"
                onClick={onGenerate}
                disabled={isGenerating || laboratoryStatus === 'pending'}
                className="inline-flex items-center gap-2 rounded-full bg-gray-900 px-5 py-3 text-sm font-semibold text-gray-50 transition-colors hover:bg-gray-700 disabled:cursor-not-allowed disabled:opacity-60 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-white"
              >
                {isGenerating || laboratoryStatus === 'pending' ? (
                  <LoaderCircle className="h-4 w-4 animate-spin" />
                ) : (
                  <Sparkles className="h-4 w-4" />
                )}
                Genera laboratorio
              </button>
            </div>
          ) : null}
        </section>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-[90rem] px-4 pb-36 pt-8 sm:px-8 lg:px-14 xl:px-20 2xl:px-24">
      <div className="mx-auto max-w-[82ch] space-y-8">
        <header>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <h2 className="font-serif text-3xl leading-tight text-gray-900 dark:text-gray-100">
              {activeExercise.title}
            </h2>
            {progressSummary ? (
              <span className="rounded-full border border-gray-200 bg-white px-3 py-1.5 text-xs font-semibold uppercase tracking-[0.12em] text-gray-600 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300">
                {progressSummary}
              </span>
            ) : null}
          </div>
          <p className="mt-3 text-base leading-7 text-gray-600 dark:text-zinc-300">
            {activeExercise.brief}
          </p>
          {sourcePageRangeLabel ? (
            <p
              data-testid="laboratory-source-page-range"
              className="mt-4 inline-flex rounded-full border border-gray-300 bg-white px-3 py-1.5 text-xs font-semibold uppercase tracking-[0.12em] text-gray-600 dark:border-zinc-500/80 dark:bg-zinc-700/60 dark:text-zinc-200"
            >
              Fonte originale: {sourcePageRangeLabel}
            </p>
          ) : null}
        </header>

        <section className="border-t border-gray-300 pt-6 dark:border-zinc-600">
          <p className="mb-4 text-xs font-semibold uppercase tracking-[0.18em] text-gray-500 dark:text-zinc-400">
            Traccia
          </p>
          <MarkdownRenderer
            content={activeExercise.instructionsMarkdown}
            isDarkMode={isDarkMode}
            className={
              isDarkMode ? 'prose-invert prose-base sm:prose-lg' : 'prose-base sm:prose-lg'
            }
          />
        </section>

        <section className="border-t border-gray-300 pt-6 dark:border-zinc-600">
          <p className="mb-4 text-xs font-semibold uppercase tracking-[0.18em] text-gray-500 dark:text-zinc-400">
            Come affrontarlo
          </p>
          <MarkdownRenderer
            content={activeExercise.approachMarkdown}
            isDarkMode={isDarkMode}
            className={
              isDarkMode ? 'prose-invert prose-base sm:prose-lg' : 'prose-base sm:prose-lg'
            }
          />
        </section>

        {activeExercise.exampleMarkdown.trim().length > 0 ? (
          <section className="border-t border-gray-300 pt-6 dark:border-zinc-600">
            <button
              type="button"
              onClick={() => setIsExampleOpen(currentValue => !currentValue)}
              aria-expanded={isExampleOpen}
              className="flex w-full items-center justify-between gap-4 rounded-2xl border border-gray-200/80 bg-gray-50/70 px-4 py-3 text-left transition-colors hover:border-gray-300 hover:bg-gray-50 dark:border-zinc-700 dark:bg-zinc-950/40 dark:hover:border-zinc-600 dark:hover:bg-zinc-950/70"
            >
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.18em] text-gray-500 dark:text-zinc-400">
                  Esempio guidato o indizi
                </p>
                <p className="mt-1 text-sm text-gray-600 dark:text-zinc-300">
                  {isExampleOpen
                    ? 'Nascondi gli aiuti per lavorare in autonomia.'
                    : 'Apri questa sezione solo se vuoi un aiuto iniziale.'}
                </p>
              </div>
              <span className="inline-flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full border border-gray-200 bg-white text-gray-500 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300">
                {isExampleOpen ? (
                  <ChevronDown className="h-4 w-4" />
                ) : (
                  <ChevronRight className="h-4 w-4" />
                )}
              </span>
            </button>

            {isExampleOpen ? (
              <div className="mt-4">
                <MarkdownRenderer
                  content={activeExercise.exampleMarkdown}
                  isDarkMode={isDarkMode}
                  className={
                    isDarkMode ? 'prose-invert prose-base sm:prose-lg' : 'prose-base sm:prose-lg'
                  }
                />
              </div>
            ) : null}
          </section>
        ) : null}

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
                <Upload className="h-4 w-4" /> Carica file
              </button>
              <button
                type="button"
                onClick={onAddTextAttachment}
                className="inline-flex items-center gap-2 rounded-full border border-gray-200/80 bg-white px-4 py-2 text-xs font-semibold uppercase tracking-[0.12em] text-gray-700 transition-colors hover:border-gray-300 hover:text-gray-900 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:border-zinc-500 dark:hover:text-white"
              >
                <Plus className="h-4 w-4" /> Nuova nota
              </button>
              <button
                type="button"
                onClick={onEvaluate}
                disabled={isEvaluating || activeExercise.attachments.length === 0}
                className="inline-flex items-center gap-2 rounded-full bg-gray-900 px-4 py-2 text-xs font-semibold uppercase tracking-[0.12em] text-gray-50 transition-colors hover:bg-gray-700 disabled:cursor-not-allowed disabled:opacity-60 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-white"
              >
                {isEvaluating ? (
                  <LoaderCircle className="h-4 w-4 animate-spin" />
                ) : (
                  <Sparkles className="h-4 w-4" />
                )}
                Valuta consegna
              </button>
            </div>
          </div>

          <input
            ref={uploadInputRef}
            type="file"
            multiple
            className="hidden"
            onChange={event => {
              onAttachFiles(event.target.files);
              event.target.value = '';
            }}
          />

          {activityMessage && (isEvaluating || isGenerating) ? (
            <div className="rounded-xl border border-gray-200/70 bg-gray-50/70 px-4 py-3 text-sm text-gray-700 dark:border-zinc-700/50 dark:bg-zinc-900/50 dark:text-zinc-300">
              {activityMessage}
            </div>
          ) : null}
          <ThinkingStream
            className="max-h-[18rem] overflow-hidden"
            isDarkMode={isDarkMode}
            text={activityStreamText}
          />

          {activeExercise.attachments.length === 0 ? (
            <div className="rounded-xl border border-dashed border-gray-200/80 bg-gray-50/80 px-5 py-8 text-center text-sm leading-7 text-gray-500 dark:border-zinc-700 dark:bg-zinc-950/60 dark:text-zinc-400">
              Carica file, immagini, archivi oppure crea una nota Markdown. Tutto cio che produci
              qui resta un allegato persistente e viene usato nella valutazione.
            </div>
          ) : (
            <div className="space-y-4">
              {activeExercise.attachments.map(attachment =>
                attachment.kind === 'text' ? (
                  <LaboratoryTextAttachmentEditor
                    key={attachment.id}
                    attachment={attachment}
                    isDarkMode={isDarkMode}
                    onRemove={onRemoveAttachment}
                    onUpdate={onUpdateTextAttachment}
                  />
                ) : (
                  <LaboratoryAttachmentCard
                    key={attachment.id}
                    attachment={attachment}
                    onRemove={onRemoveAttachment}
                    onUpdateMetadata={onUpdateAttachmentMetadata}
                  />
                )
              )}
            </div>
          )}
        </section>

        <section className="border-t border-gray-300 pt-6 dark:border-zinc-600">
          <div className="mb-4 flex items-center justify-between gap-3">
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-gray-500 dark:text-zinc-400">
              Correzione AI
            </p>
            {activeExercise.evaluation ? (
              <span className={evaluationBadgeClassName}>
                Score {activeExercise.evaluation.score}/100
              </span>
            ) : null}
          </div>

          {activeExercise.evaluation ? (
            <div className="space-y-4 text-sm leading-6 text-gray-700 dark:text-zinc-300">
              <div className="rounded-xl border border-emerald-200/70 bg-emerald-50/70 px-4 py-4 dark:border-emerald-900/50 dark:bg-emerald-950/30">
                <p className="font-semibold text-emerald-900 dark:text-emerald-200">
                  {activeExercise.evaluation.summary}
                </p>
                <p className="mt-2 text-emerald-800 dark:text-emerald-300">
                  Confidenza {activeExercise.evaluation.confidenceScore}/100:{' '}
                  {activeExercise.evaluation.confidenceSummary}
                </p>
              </div>

              {renderEvaluationSection({
                items: activeExercise.evaluation.strengths,
                title: 'Punti forti',
              })}

              {renderEvaluationSection({
                items: activeExercise.evaluation.improvements,
                title: 'Da migliorare',
              })}

              {renderEvaluationSection({
                items: activeExercise.evaluation.caveats,
                title: 'Limiti della valutazione',
                tone: 'warning',
              })}
            </div>
          ) : (
            <p className="text-sm text-gray-400 dark:text-zinc-500">
              Nessuna valutazione disponibile. Aggiungi almeno un allegato e avvia la correzione.
            </p>
          )}
        </section>
      </div>
    </div>
  );
}
