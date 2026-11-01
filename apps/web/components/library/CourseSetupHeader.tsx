import { motion } from 'framer-motion';
import { ArrowLeft, BookOpen } from 'lucide-react';
import { translateUiMessage as t } from '../../i18n/uiMessages.ts';
import { useShouldAnimate } from '../../utils/motion/index.ts';
import { SPRING_TAP } from '../../utils/motion/tokens.ts';
import { type CourseSetupPhase, getCourseSetupPhases } from './courseSetupPhase.ts';
import type { StopGenerationHandler } from './HomeChatComposer.tsx';

const phaseLabel = (phase: CourseSetupPhase): string =>
  ({
    sources: t('Fonti'),
    goal: t('Obiettivo'),
    preferences: t('Preferenze'),
    knowledge: t('Conoscenze'),
    plan: t('Piano'),
  })[phase];

export default function CourseSetupHeader({
  phase,
  sourceCount,
  hasPreferences,
  hasDiagnostic,
  isLoading,
  onAbandon,
}: {
  readonly phase: CourseSetupPhase;
  readonly sourceCount: number;
  readonly hasPreferences: boolean;
  readonly hasDiagnostic: boolean;
  readonly isLoading: boolean;
  readonly onAbandon?: StopGenerationHandler;
}) {
  const shouldAnimate = useShouldAnimate();
  const phases = getCourseSetupPhases({ sourceCount, hasPreferences, hasDiagnostic });
  const currentIndex = phases.indexOf(phase);
  return (
    <header className="flex shrink-0 flex-wrap items-start gap-3 border-b border-stone-200/60 px-4 py-5 sm:gap-4 sm:px-6 dark:border-white/10">
      {onAbandon && (
        <button
          type="button"
          onClick={onAbandon}
          disabled={isLoading}
          aria-label={t('Annulla creazione corso')}
          title={t('Annulla creazione corso')}
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-stone-700 transition-colors hover:bg-stone-200/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500 disabled:opacity-50 dark:text-stone-200 dark:hover:bg-white/10"
        >
          <ArrowLeft className="h-5 w-5" aria-hidden="true" />
        </button>
      )}
      <div className="min-w-0 flex-1">
        <h2 className="font-serif text-2xl tracking-tight text-stone-950 sm:text-3xl dark:text-stone-50">
          {t('Prepariamo il tuo corso')}
        </h2>
        <p className="mt-1 text-sm leading-6 text-stone-500 dark:text-stone-400">
          {t('Ti faccio alcune domande per creare un percorso su misura per te.')}
        </p>
      </div>
      <div className="flex w-full flex-wrap items-center justify-between gap-3 pl-[3.25rem] lg:w-auto lg:flex-col lg:items-end lg:pl-0">
        {sourceCount > 0 && (
          <span className="inline-flex items-center gap-2 rounded-full border border-stone-200 bg-white/80 px-3 py-1 text-xs text-stone-600 dark:border-white/10 dark:bg-white/5 dark:text-stone-300">
            <BookOpen className="h-3.5 w-3.5" aria-hidden="true" />
            {t(sourceCount === 1 ? '{sourceCount} fonte' : '{sourceCount} fonti', { sourceCount })}
          </span>
        )}
        <motion.ol
          key={phase}
          initial={shouldAnimate ? { opacity: 0 } : false}
          animate={{ opacity: 1 }}
          transition={SPRING_TAP}
          aria-label={t('Fasi di preparazione del corso')}
          className="flex items-center gap-0"
        >
          {phases.map((candidate, index) => {
            let state = 'upcoming';
            if (index < currentIndex) state = 'done';
            if (candidate === phase) state = 'current';
            return (
              <li
                key={candidate}
                aria-label={phaseLabel(candidate)}
                aria-current={candidate === phase ? 'step' : undefined}
                data-setup-phase={candidate}
                data-state={state}
                title={phaseLabel(candidate)}
                className="flex items-center"
              >
                {index > 0 && (
                  <span
                    aria-hidden="true"
                    className={`h-px w-5 transition-colors motion-reduce:transition-none sm:w-7 ${index <= currentIndex ? 'bg-orange-600 dark:bg-orange-400' : 'bg-stone-300 dark:bg-stone-600'}`}
                  />
                )}
                <span
                  aria-hidden="true"
                  className={`h-3 w-3 rounded-full border-2 transition-[background-color,box-shadow] motion-reduce:transition-none ${state === 'upcoming' ? 'border-stone-300 bg-white dark:border-stone-600 dark:bg-stone-800' : 'border-orange-600 bg-orange-600 dark:border-orange-400 dark:bg-orange-400'} ${state === 'current' ? 'ring-4 ring-orange-600/15 dark:ring-orange-400/20' : ''}`}
                />
              </li>
            );
          })}
        </motion.ol>
        <output className="sr-only">{phaseLabel(phase)}</output>
      </div>
    </header>
  );
}
