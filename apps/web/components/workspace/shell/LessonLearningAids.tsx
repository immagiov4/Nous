import {
  BookOpen,
  ChevronLeft,
  ChevronRight,
  Code2,
  Heading2,
  MousePointerClick,
  X,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { translateUiMessage as t } from '../../../i18n/uiMessages.ts';
import type { LessonLearningAid, LessonLearningAidKind } from '../../../types.ts';
import MarkdownRenderer from '../../shared/MarkdownRenderer.tsx';

interface LessonLearningAidsProps {
  isDarkMode: boolean;
  isMobileViewport: boolean;
  learningAids: LessonLearningAid[];
  onDismissLearningAid: (learningAidId: string) => void;
}

const getLearningAidKindLabel = (kind: LessonLearningAidKind): string => {
  switch (kind) {
    case 'definition':
      return t('Definizione');
    case 'formula':
      return t('Formula');
    case 'symbol':
      return t('Simbolo');
    case 'analogy':
      return t('Analogia');
  }
};

const getLearningAidIcon = (kind: LessonLearningAidKind) => {
  switch (kind) {
    case 'definition':
      return BookOpen;
    case 'formula':
      return Code2;
    case 'symbol':
      return Heading2;
    case 'analogy':
      return MousePointerClick;
  }
};

function LearningAidList({
  isDarkMode,
  learningAids,
  onDismissLearningAid,
}: Pick<LessonLearningAidsProps, 'isDarkMode' | 'learningAids' | 'onDismissLearningAid'>) {
  return (
    <ol className="divide-y divide-gray-200 dark:divide-zinc-700">
      {learningAids.map(learningAid => {
        const KindIcon = getLearningAidIcon(learningAid.kind);

        return (
          <li key={learningAid.id} className="py-3 first:pt-0 last:pb-0">
            <div className="flex items-start gap-2.5">
              <KindIcon className="mt-0.5 h-4 w-4 shrink-0 text-gray-400 dark:text-zinc-500" />
              <div className="min-w-0 flex-1">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-gray-500 dark:text-zinc-400">
                      {getLearningAidKindLabel(learningAid.kind)}
                    </p>
                    <h3 className="mt-0.5 text-sm font-semibold leading-5 text-gray-900 dark:text-zinc-100">
                      {learningAid.title}
                    </h3>
                  </div>
                  <button
                    type="button"
                    aria-label={t('Rimuovi {learningAidTitle}', {
                      learningAidTitle: learningAid.title,
                    })}
                    className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-gray-400 transition-colors hover:bg-red-50 hover:text-red-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gray-400 dark:text-zinc-500 dark:hover:bg-red-950/30 dark:hover:text-red-300"
                    onClick={() => onDismissLearningAid(learningAid.id)}
                    title={t('Rimuovi {learningAidTitle}', {
                      learningAidTitle: learningAid.title,
                    })}
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
                <MarkdownRenderer
                  className={`prose-sm mt-1 max-w-none leading-5 text-gray-600 dark:text-zinc-300 [&_p]:my-0 ${
                    isDarkMode ? 'prose-invert' : ''
                  }`}
                  content={learningAid.content}
                  isDarkMode={isDarkMode}
                />
                {learningAid.anchorHeading ? (
                  <p className="mt-1.5 text-xs text-gray-400 dark:text-zinc-500">
                    {t('Vicino a {heading}', { heading: learningAid.anchorHeading })}
                  </p>
                ) : null}
              </div>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

function DesktopLearningAids({
  isDarkMode,
  learningAids,
  onDismissLearningAid,
}: Pick<LessonLearningAidsProps, 'isDarkMode' | 'learningAids' | 'onDismissLearningAid'>) {
  const [isExpanded, setIsExpanded] = useState(true);

  if (!isExpanded) {
    return (
      <aside
        aria-label={t('Concetti chiave')}
        className="sticky top-6 w-11 border-l border-gray-200 pl-3 dark:border-zinc-700"
      >
        <button
          type="button"
          aria-label={t('Espandi concetti chiave')}
          className="inline-flex h-9 w-9 items-center justify-center rounded-full text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gray-400 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-white"
          onClick={() => setIsExpanded(true)}
          title={t('Espandi concetti chiave')}
        >
          <ChevronLeft className="h-4 w-4" />
        </button>
      </aside>
    );
  }

  return (
    <aside
      aria-label={t('Concetti chiave')}
      className="sticky top-6 w-64 border-l border-gray-200 pl-4 dark:border-zinc-700"
    >
      <div className="mb-4 flex items-center justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold text-gray-900 dark:text-zinc-100">
            {t('Concetti chiave')}
          </h2>
          <p className="mt-0.5 text-xs text-gray-500 dark:text-zinc-400">
            {t('Supporti contestuali della lezione')}
          </p>
        </div>
        <button
          type="button"
          aria-label={t('Comprimi concetti chiave')}
          className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gray-400 dark:text-zinc-500 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
          onClick={() => setIsExpanded(false)}
          title={t('Comprimi concetti chiave')}
        >
          <ChevronRight className="h-4 w-4" />
        </button>
      </div>
      <LearningAidList
        isDarkMode={isDarkMode}
        learningAids={learningAids}
        onDismissLearningAid={onDismissLearningAid}
      />
    </aside>
  );
}

function MobileLearningAids({
  isDarkMode,
  learningAids,
  onDismissLearningAid,
}: Pick<LessonLearningAidsProps, 'isDarkMode' | 'learningAids' | 'onDismissLearningAid'>) {
  const [isOpen, setIsOpen] = useState(false);
  const itemCountLabel =
    learningAids.length === 1
      ? t('1 elemento')
      : t('{count} elementi', { count: learningAids.length });
  const portalContainer = typeof document === 'undefined' ? null : document.body;

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setIsOpen(false);
      }
    };
    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [isOpen]);

  return (
    <>
      <button
        type="button"
        aria-label={t('Apri concetti chiave, {itemCount}', { itemCount: itemCountLabel })}
        className="mb-5 flex w-full items-center justify-between gap-3 border-y border-gray-200 py-3 text-left text-sm text-gray-700 transition-colors hover:text-gray-950 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gray-400 dark:border-zinc-700 dark:text-zinc-300 dark:hover:text-white"
        onClick={() => setIsOpen(true)}
      >
        <span className="flex min-w-0 items-center gap-2.5">
          <BookOpen className="h-4 w-4 shrink-0 text-gray-400 dark:text-zinc-500" />
          <span className="font-medium">{t('Concetti chiave')}</span>
        </span>
        <span className="flex shrink-0 items-center gap-1.5 text-xs text-gray-500 dark:text-zinc-400">
          {itemCountLabel}
          <ChevronRight className="h-4 w-4" />
        </span>
      </button>

      {isOpen && portalContainer
        ? createPortal(
            <div className="fixed inset-0 z-[100] flex items-end p-3">
              <button
                type="button"
                aria-label={t('Chiudi concetti chiave dallo sfondo')}
                className="absolute inset-0 bg-black/40"
                onClick={() => setIsOpen(false)}
              />
              <section
                role="dialog"
                aria-modal="true"
                aria-label={t('Concetti chiave')}
                className="relative max-h-[min(75dvh,40rem)] w-full overflow-hidden rounded-[1.8rem] border border-gray-200 bg-white shadow-2xl dark:border-zinc-700 dark:bg-zinc-900"
              >
                <header className="flex items-center justify-between gap-3 border-b border-gray-200 px-5 py-4 dark:border-zinc-700">
                  <div>
                    <h2 className="text-base font-semibold text-gray-900 dark:text-zinc-100">
                      {t('Concetti chiave')}
                    </h2>
                    <p className="mt-0.5 text-xs text-gray-500 dark:text-zinc-400">
                      {itemCountLabel}
                    </p>
                  </div>
                  <button
                    type="button"
                    aria-label={t('Chiudi concetti chiave')}
                    className="inline-flex h-9 w-9 items-center justify-center rounded-full text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gray-400 dark:text-zinc-500 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
                    onClick={() => setIsOpen(false)}
                  >
                    <X className="h-4 w-4" />
                  </button>
                </header>
                <div className="max-h-[calc(min(75dvh,40rem)-5rem)] overflow-y-auto px-5 py-4 overscroll-contain">
                  <LearningAidList
                    isDarkMode={isDarkMode}
                    learningAids={learningAids}
                    onDismissLearningAid={onDismissLearningAid}
                  />
                </div>
              </section>
            </div>,
            portalContainer
          )
        : null}
    </>
  );
}

export default function LessonLearningAids(props: LessonLearningAidsProps) {
  if (props.learningAids.length === 0) {
    return null;
  }

  return props.isMobileViewport ? (
    <MobileLearningAids {...props} />
  ) : (
    <DesktopLearningAids {...props} />
  );
}
