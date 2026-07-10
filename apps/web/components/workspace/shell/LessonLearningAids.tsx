import { BookOpen, Braces, ChevronDown, Lightbulb, Sigma, X } from 'lucide-react';
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
      return Sigma;
    case 'symbol':
      return Braces;
    case 'analogy':
      return Lightbulb;
  }
};

function LearningAidList({
  isDarkMode,
  learningAids,
  onDismissLearningAid,
}: Pick<LessonLearningAidsProps, 'isDarkMode' | 'learningAids' | 'onDismissLearningAid'>) {
  const [expandedAidIds, setExpandedAidIds] = useState<Set<string>>(() => new Set());

  const toggleAid = (learningAidId: string) => {
    setExpandedAidIds(currentIds => {
      const nextIds = new Set(currentIds);
      if (nextIds.has(learningAidId)) {
        nextIds.delete(learningAidId);
      } else {
        nextIds.add(learningAidId);
      }
      return nextIds;
    });
  };

  return (
    <ol className="grid gap-2">
      {learningAids.map(learningAid => {
        const KindIcon = getLearningAidIcon(learningAid.kind);
        const isExpanded = expandedAidIds.has(learningAid.id);
        const disclosureLabel = t(
          isExpanded ? 'Comprimi {learningAidTitle}' : 'Espandi {learningAidTitle}',
          { learningAidTitle: learningAid.title }
        );

        return (
          <li
            key={learningAid.id}
            className="overflow-hidden rounded-xl border border-gray-200 bg-white/95 dark:border-zinc-700 dark:bg-zinc-900/80"
          >
            <div className="flex items-center gap-1 px-2 py-1.5">
              <button
                type="button"
                aria-expanded={isExpanded}
                aria-label={disclosureLabel}
                className="flex min-w-0 flex-1 items-center gap-2 rounded-lg px-1.5 py-1.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gray-400"
                onClick={() => toggleAid(learningAid.id)}
                title={disclosureLabel}
              >
                <KindIcon className="h-4 w-4 shrink-0 text-gray-400 dark:text-zinc-500" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[10px] font-semibold uppercase tracking-[0.12em] text-gray-500 dark:text-zinc-400">
                    {getLearningAidKindLabel(learningAid.kind)}
                  </span>
                  <span className="block truncate text-sm font-medium leading-5 text-gray-900 dark:text-zinc-100">
                    {learningAid.title}
                  </span>
                </span>
                <ChevronDown
                  className={`h-4 w-4 shrink-0 text-gray-400 transition-transform duration-200 dark:text-zinc-500 ${
                    isExpanded ? 'rotate-180' : ''
                  }`}
                />
              </button>
              <button
                type="button"
                aria-label={t('Rimuovi {learningAidTitle}', {
                  learningAidTitle: learningAid.title,
                })}
                className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-gray-400 transition-colors hover:bg-red-50 hover:text-red-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gray-400 dark:text-zinc-500 dark:hover:bg-red-950/30 dark:hover:text-red-300"
                onClick={() => onDismissLearningAid(learningAid.id)}
                title={t('Rimuovi {learningAidTitle}', {
                  learningAidTitle: learningAid.title,
                })}
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
            {isExpanded ? (
              <div className="border-t border-gray-100 px-4 pb-3 pt-2.5 dark:border-zinc-800">
                <MarkdownRenderer
                  className={`prose-sm max-w-none text-sm leading-5 text-gray-600 dark:text-zinc-300 [&_p]:my-0 ${
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
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}

export function HeaderLearningAids({
  isDarkMode,
  learningAids,
  onDismissLearningAid,
}: Pick<LessonLearningAidsProps, 'isDarkMode' | 'learningAids' | 'onDismissLearningAid'>) {
  const [isOpen, setIsOpen] = useState(false);

  if (learningAids.length === 0) {
    return null;
  }

  return (
    <div className="relative">
      <button
        type="button"
        aria-expanded={isOpen}
        aria-label={t(isOpen ? 'Chiudi concetti chiave' : 'Apri concetti chiave')}
        className={`inline-flex h-10 items-center justify-center gap-2 rounded-full border px-3 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gray-400 ${
          isOpen
            ? 'border-gray-300 bg-gray-100 text-gray-700 dark:border-zinc-600 dark:bg-zinc-800 dark:text-zinc-100'
            : 'border-gray-300 bg-transparent text-gray-500 shadow-none hover:border-gray-400 hover:text-gray-800 dark:border-zinc-600 dark:text-zinc-400 dark:hover:border-zinc-500 dark:hover:text-zinc-100'
        }`}
        onClick={() => setIsOpen(current => !current)}
        title={t('Concetti chiave')}
      >
        <BookOpen className="h-4 w-4" />
        <span className="hidden xl:inline">{t('Concetti chiave')}</span>
        <ChevronDown
          className={`h-3.5 w-3.5 transition-transform duration-200 ${isOpen ? 'rotate-180' : ''}`}
        />
      </button>

      {isOpen ? (
        <aside
          aria-label={t('Concetti chiave')}
          className="absolute right-0 top-[calc(100%+0.75rem)] z-50 w-72 rounded-2xl border border-gray-200 bg-white p-3 shadow-[0_16px_40px_rgba(15,23,42,0.12)] dark:border-zinc-700 dark:bg-zinc-900"
        >
          <div className="mb-3 flex items-center justify-between gap-2 px-1">
            <h2 className="text-sm font-semibold text-gray-900 dark:text-zinc-100">
              {t('Concetti chiave')}
            </h2>
            <button
              type="button"
              aria-label={t('Chiudi concetti chiave')}
              className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-gray-400 hover:bg-gray-100 hover:text-gray-800 dark:text-zinc-500 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
              onClick={() => setIsOpen(false)}
            >
              <X className="h-4 w-4" />
            </button>
          </div>
          <LearningAidList
            isDarkMode={isDarkMode}
            learningAids={learningAids}
            onDismissLearningAid={onDismissLearningAid}
          />
        </aside>
      ) : null}
    </div>
  );
}

function MobileLearningAids({
  isDarkMode,
  learningAids,
  onDismissLearningAid,
}: Pick<LessonLearningAidsProps, 'isDarkMode' | 'learningAids' | 'onDismissLearningAid'>) {
  const [isOpen, setIsOpen] = useState(false);
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
        aria-label={t('Apri concetti chiave')}
        className="mb-5 flex w-full items-center justify-between gap-3 border-y border-gray-200 py-3 text-left text-sm text-gray-700 transition-colors hover:text-gray-950 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gray-400 dark:border-zinc-700 dark:text-zinc-300 dark:hover:text-white"
        onClick={() => setIsOpen(true)}
      >
        <span className="flex min-w-0 items-center gap-2.5">
          <BookOpen className="h-4 w-4 shrink-0 text-gray-400 dark:text-zinc-500" />
          <span className="font-medium">{t('Concetti chiave')}</span>
        </span>
        <ChevronDown className="h-4 w-4 -rotate-90 text-gray-500 dark:text-zinc-400" />
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
                  <h2 className="text-base font-semibold text-gray-900 dark:text-zinc-100">
                    {t('Concetti chiave')}
                  </h2>
                  <button
                    type="button"
                    aria-label={t('Chiudi concetti chiave')}
                    className="inline-flex h-9 w-9 items-center justify-center rounded-full text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gray-400 dark:text-zinc-500 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
                    onClick={() => setIsOpen(false)}
                  >
                    <X className="h-4 w-4" />
                  </button>
                </header>
                <div className="max-h-[calc(min(75dvh,40rem)-5rem)] overflow-y-auto px-4 py-4 overscroll-contain">
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

/*
 * Mobile keeps the entry point in the reading flow. Desktop owns the same content from the
 * sticky header so the reading column never moves sideways to make room for contextual aids.
 */
export default function LessonLearningAids(props: LessonLearningAidsProps) {
  if (props.learningAids.length === 0 || !props.isMobileViewport) {
    return null;
  }

  return <MobileLearningAids {...props} />;
}
