import {
  BookOpen,
  Check,
  FileText,
  ListTree,
  PencilLine,
  ShieldCheck,
  Sparkles,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { translateUiMessage as t } from '../../i18n/uiMessages.ts';
import type {
  GenerationProgressSnapshot,
  GenerationStage,
} from '../../services/openrouter/generationProgress.ts';

interface GenerationProgressProps {
  displayMode?: 'embedded' | 'page';
  progress: GenerationProgressSnapshot;
}

type StageLabel = 'Fonti' | 'Pronta' | 'Pronto' | 'Quiz' | 'Stesura' | 'Struttura' | 'Verifica';

const STAGES: ReadonlyArray<{
  id: GenerationStage;
  icon: typeof FileText;
  label: StageLabel;
}> = [
  { id: 'sources', icon: FileText, label: 'Fonti' },
  { id: 'structure', icon: ListTree, label: 'Struttura' },
  { id: 'drafting', icon: PencilLine, label: 'Stesura' },
  { id: 'quiz', icon: Sparkles, label: 'Quiz' },
  { id: 'verification', icon: ShieldCheck, label: 'Verifica' },
  { id: 'ready', icon: BookOpen, label: 'Pronta' },
];
const SCROLLING_STEP_OPACITY = [0.7, 0.84, 1] as const;

const formatElapsedTime = (elapsedSeconds: number) => {
  const minutes = Math.floor(elapsedSeconds / 60);
  const seconds = String(elapsedSeconds % 60).padStart(2, '0');
  return `${minutes}:${seconds}`;
};

const PreviewSections = ({ progress }: { progress: GenerationProgressSnapshot }) => {
  const isScrollingWindow = progress.stepOffset > 0 && progress.sections.length === 3;

  return (
    <div className="mt-3 divide-y divide-stone-200/80 sm:mt-6 dark:divide-zinc-700">
      {progress.sections.map((section, index) => {
        const stepNumber = progress.stepOffset + index + 1;
        const isCurrent = index === progress.sections.length - 1;
        return (
          <div
            key={`${stepNumber}-${section}`}
            className={`relative py-3 text-left transition-opacity duration-300 ease-[cubic-bezier(0.23,1,0.32,1)] sm:px-1 sm:py-4 ${isCurrent ? 'generation-progress-step-current pl-4 sm:pl-5' : ''}`}
            style={{ opacity: isScrollingWindow ? SCROLLING_STEP_OPACITY[index] : 1 }}
          >
            {isCurrent ? (
              <span
                aria-hidden="true"
                className="absolute inset-y-3 left-0 w-0.5 rounded-full bg-amber-500 sm:inset-y-4"
              />
            ) : null}
            <p className="font-serif text-base text-stone-900 sm:text-lg dark:text-zinc-100">
              {stepNumber}. {section}
            </p>
          </div>
        );
      })}
    </div>
  );
};

export default function GenerationProgress({
  displayMode = 'page',
  progress,
}: GenerationProgressProps) {
  const [elapsedSeconds, setElapsedSeconds] = useState(() =>
    Math.max(0, Math.floor((Date.now() - progress.startedAt) / 1_000))
  );
  const activeStageIndex = STAGES.findIndex(stage => stage.id === progress.stage);
  const isCourseGeneration = progress.operation === 'plan';

  useEffect(() => {
    const updateElapsedTime = () => {
      setElapsedSeconds(Math.max(0, Math.floor((Date.now() - progress.startedAt) / 1_000)));
    };
    updateElapsedTime();
    const intervalId = window.setInterval(updateElapsedTime, 1_000);
    return () => window.clearInterval(intervalId);
  }, [progress.startedAt]);

  return (
    <output
      aria-live="polite"
      className={`mx-auto flex w-full max-w-5xl flex-col items-center py-2 text-center ${displayMode === 'page' ? 'my-auto' : ''}`}
    >
      <h2 className="whitespace-nowrap font-serif text-xl tracking-tight text-stone-950 sm:text-5xl dark:text-zinc-50">
        {t(isCourseGeneration ? 'Corso in preparazione...' : 'Lezione in cottura...')}
      </h2>

      <ol className="relative mt-5 grid w-full grid-cols-3 gap-x-2 gap-y-4 sm:mt-10 sm:grid-cols-6 sm:gap-0">
        <span
          aria-hidden="true"
          className="absolute left-[8.33%] right-[8.33%] top-5 hidden border-t border-stone-300 sm:block dark:border-zinc-700"
        />
        {STAGES.map(({ id, icon: Icon, label }, index) => {
          const isComplete = index < activeStageIndex;
          const isActive = index === activeStageIndex;
          const visibleLabel = isCourseGeneration && id === 'ready' ? 'Pronto' : label;
          return (
            <li key={id} className="relative z-10 flex min-w-0 flex-col items-center">
              <span
                className={`flex h-10 w-10 items-center justify-center rounded-full border bg-white transition-colors dark:bg-zinc-950 ${
                  isActive
                    ? 'border-amber-500 bg-amber-500 text-white shadow-[0_0_0_7px_rgba(245,158,11,0.12)] dark:bg-amber-600'
                    : isComplete
                      ? 'border-amber-300 text-stone-900 dark:border-amber-700 dark:text-zinc-100'
                      : 'border-stone-300 text-stone-400 dark:border-zinc-700 dark:text-zinc-500'
                }`}
              >
                {isComplete ? <Check className="h-4 w-4" /> : <Icon className="h-4 w-4" />}
              </span>
              <span
                className={`mt-2 truncate font-serif text-sm sm:text-base ${isActive ? 'text-stone-950 dark:text-white' : 'text-stone-500 dark:text-zinc-400'}`}
              >
                {t(visibleLabel)}
              </span>
            </li>
          );
        })}
      </ol>

      <section className="mt-5 w-full rounded-xl border border-stone-200/90 bg-white/55 px-5 py-4 shadow-sm backdrop-blur-sm sm:mt-9 sm:px-12 sm:py-8 dark:border-zinc-700 dark:bg-zinc-900/55">
        <h3 className="text-left font-serif text-2xl text-stone-950 sm:text-3xl dark:text-zinc-50">
          {progress.subject}
        </h3>
        <PreviewSections progress={progress} />
      </section>

      <p className="mt-3 flex items-center gap-2 text-xs text-stone-500 sm:mt-5 sm:text-sm dark:text-zinc-400">
        <span aria-hidden="true" className="h-1.5 w-1.5 animate-pulse rounded-full bg-amber-500" />
        {t('Elaborazione in corso')} · {t('Tempo trascorso')}: {formatElapsedTime(elapsedSeconds)}
      </p>
    </output>
  );
}
