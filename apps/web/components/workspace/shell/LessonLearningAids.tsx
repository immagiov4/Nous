import {
  BookOpen,
  Braces,
  Check,
  ChevronDown,
  Lightbulb,
  Pencil,
  Plus,
  Sigma,
  Trash2,
  X,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { translateUiMessage as t } from '../../../i18n/uiMessages.ts';
import type { LessonLearningAid, LessonLearningAidKind } from '../../../types.ts';
import { createEntityId } from '../../../utils/ids.ts';
import { MotionPopover } from '../../../utils/motion/index.ts';
import MarkdownRenderer from '../../shared/MarkdownRenderer.tsx';

interface LearningAidsProps {
  readonly isDarkMode: boolean;
  readonly learningAids: LessonLearningAid[];
  readonly onSaveLearningAids: (learningAids: LessonLearningAid[]) => Promise<boolean>;
}

type MobileLearningAidsProps = Pick<
  LearningAidsProps,
  'isDarkMode' | 'learningAids' | 'onSaveLearningAids'
> & {
  readonly isOpen: boolean;
  readonly onOpenChange: (isOpen: boolean) => void;
};

const LEARNING_AID_TITLE_MAX_LENGTH = 64;
const LEARNING_AID_CONTENT_MAX_LENGTH = 500;

const LEARNING_AID_KIND_OPTIONS: ReadonlyArray<LessonLearningAidKind> = [
  'definition',
  'formula',
  'analogy',
];

interface LearningAidDraft {
  anchorHeading?: string;
  id?: string;
  kind: LessonLearningAidKind;
  title: string;
  content: string;
}

interface LearningAidEditorProps {
  readonly draft: LearningAidDraft;
  readonly isInline: boolean;
  readonly isSaving: boolean;
  readonly onCancel: () => void;
  readonly onChange: (draft: LearningAidDraft) => void;
  readonly onSave: () => void;
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

function LearningAidEditor({
  draft,
  isInline,
  isSaving,
  onCancel,
  onChange,
  onSave,
}: LearningAidEditorProps) {
  return (
    <fieldset
      aria-label={t(draft.id ? 'Modifica concetto chiave' : 'Nuovo concetto chiave')}
      className={`space-y-3 bg-gray-50 p-3 dark:bg-zinc-800/70 ${
        isInline ? '' : 'rounded-xl border border-gray-200 dark:border-zinc-700'
      }`}
    >
      <div className="grid grid-cols-[minmax(0,0.35fr)_minmax(0,0.65fr)] gap-3">
        <label className="block">
          <span className="text-xs font-semibold text-gray-600 dark:text-zinc-300">
            {t('Tipo')}
          </span>
          <select
            aria-label={t('Tipo concetto chiave')}
            value={draft.kind}
            onChange={event =>
              onChange({ ...draft, kind: event.target.value as LessonLearningAidKind })
            }
            className="mt-1 min-h-10 w-full rounded-lg border border-gray-300 bg-white px-3 text-sm text-gray-900 dark:border-zinc-600 dark:bg-zinc-800 dark:text-zinc-100"
          >
            {LEARNING_AID_KIND_OPTIONS.map(kind => (
              <option key={kind} value={kind}>
                {getLearningAidKindLabel(kind)}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="text-xs font-semibold text-gray-600 dark:text-zinc-300">
            {t('Titolo')}
          </span>
          <input
            value={draft.title}
            maxLength={LEARNING_AID_TITLE_MAX_LENGTH}
            onChange={event => onChange({ ...draft, title: event.target.value })}
            className="mt-1 min-h-10 w-full rounded-lg border border-gray-300 bg-white px-3 text-sm text-gray-900 dark:border-zinc-600 dark:bg-zinc-800 dark:text-zinc-100"
          />
        </label>
      </div>
      <label className="block">
        <span className="text-xs font-semibold text-gray-600 dark:text-zinc-300">
          {t('Contenuto')}
        </span>
        <textarea
          value={draft.content}
          maxLength={LEARNING_AID_CONTENT_MAX_LENGTH}
          rows={4}
          onChange={event => onChange({ ...draft, content: event.target.value })}
          className="mt-1 w-full resize-y rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm leading-5 text-gray-900 dark:border-zinc-600 dark:bg-zinc-800 dark:text-zinc-100"
        />
      </label>
      <div className="flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          disabled={isSaving}
          className="min-h-9 rounded-full px-3 py-1.5 text-xs font-semibold text-gray-500 hover:bg-white/80 hover:text-gray-800 disabled:opacity-50 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
        >
          {t('Annulla')}
        </button>
        <button
          type="button"
          onClick={onSave}
          disabled={isSaving || !draft.title.trim() || !draft.content.trim()}
          className="inline-flex min-h-9 items-center gap-2 rounded-full bg-gray-950 px-4 py-1.5 text-xs font-semibold text-white hover:bg-gray-800 disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-white"
        >
          <Check className="h-3.5 w-3.5" />
          {t(isSaving ? 'Salvataggio in corso...' : 'Salva')}
        </button>
      </div>
    </fieldset>
  );
}

function LearningAidList({
  isDarkMode,
  learningAids,
  onSaveLearningAids,
}: Pick<LearningAidsProps, 'isDarkMode' | 'learningAids' | 'onSaveLearningAids'>) {
  const [expandedAidIds, setExpandedAidIds] = useState<Set<string>>(() => new Set());
  const [draft, setDraft] = useState<LearningAidDraft | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState('');

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

  const beginCreate = () => {
    setSaveError('');
    setDraft({ kind: 'definition', title: '', content: '' });
  };

  const beginEdit = (learningAid: LessonLearningAid) => {
    setSaveError('');
    setDraft({ ...learningAid });
  };

  const cancelDraft = () => {
    setDraft(null);
    setSaveError('');
  };

  const saveDraft = async () => {
    if (!draft) {
      return;
    }

    const title = draft.title.trim();
    const content = draft.content.trim();
    if (!title || !content) {
      setSaveError(t('Titolo e contenuto sono obbligatori.'));
      return;
    }

    const nextAid: LessonLearningAid = {
      id:
        draft.id || createEntityId({ fallbackPrefix: 'learning-aid', uuidPrefix: 'learning-aid' }),
      kind: draft.kind,
      title,
      content,
      ...(draft.anchorHeading ? { anchorHeading: draft.anchorHeading } : {}),
    };
    const nextLearningAids = draft.id
      ? learningAids.map(learningAid => (learningAid.id === draft.id ? nextAid : learningAid))
      : [...learningAids, nextAid];

    setIsSaving(true);
    setSaveError('');
    const didSave = await onSaveLearningAids(nextLearningAids);
    setIsSaving(false);
    if (didSave) {
      setDraft(null);
      setExpandedAidIds(currentIds => new Set(currentIds).add(nextAid.id));
      return;
    }

    setSaveError(t('Non sono riuscito a salvare i concetti chiave. Riprova.'));
  };

  const removeAid = async (learningAidId: string) => {
    setIsSaving(true);
    setSaveError('');
    const didSave = await onSaveLearningAids(
      learningAids.filter(learningAid => learningAid.id !== learningAidId)
    );
    setIsSaving(false);
    if (!didSave) {
      setSaveError(t('Non sono riuscito a salvare i concetti chiave. Riprova.'));
    }
  };

  return (
    <div className="space-y-3" aria-busy={isSaving}>
      {saveError ? (
        <p role="alert" className="text-xs leading-5 text-red-600 dark:text-red-300">
          {saveError}
        </p>
      ) : null}

      <ol className="grid gap-2">
        {learningAids.map(learningAid => {
          const isEditing = draft?.id === learningAid.id;
          if (isEditing) {
            return (
              <li
                key={learningAid.id}
                className="overflow-hidden rounded-xl border border-gray-200 dark:border-zinc-700"
              >
                <LearningAidEditor
                  draft={draft}
                  isInline
                  isSaving={isSaving}
                  onCancel={cancelDraft}
                  onChange={setDraft}
                  onSave={() => void saveDraft()}
                />
              </li>
            );
          }

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
                    <span className="block text-pretty text-sm font-medium leading-5 text-gray-900 dark:text-zinc-100">
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
                  aria-label={t('Modifica {learningAidTitle}', {
                    learningAidTitle: learningAid.title,
                  })}
                  disabled={isSaving || draft !== null}
                  className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-gray-400 transition-colors hover:bg-red-50 hover:text-red-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gray-400 dark:text-zinc-500 dark:hover:bg-red-950/30 dark:hover:text-red-300"
                  onClick={() => beginEdit(learningAid)}
                  title={t('Modifica {learningAidTitle}', {
                    learningAidTitle: learningAid.title,
                  })}
                >
                  <Pencil className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  aria-label={t('Rimuovi {learningAidTitle}', {
                    learningAidTitle: learningAid.title,
                  })}
                  disabled={isSaving || draft !== null}
                  className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-gray-400 transition-colors hover:bg-red-50 hover:text-red-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gray-400 disabled:opacity-50 dark:text-zinc-500 dark:hover:bg-red-950/30 dark:hover:text-red-300"
                  onClick={() => void removeAid(learningAid.id)}
                  title={t('Rimuovi {learningAidTitle}', {
                    learningAidTitle: learningAid.title,
                  })}
                >
                  <Trash2 className="h-3.5 w-3.5" />
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

      {!draft ? (
        <button
          type="button"
          onClick={beginCreate}
          disabled={isSaving}
          aria-label={t('Aggiungi concetto chiave')}
          className="flex min-h-12 w-full items-center justify-center gap-2 rounded-xl border border-dashed border-gray-300 px-3 py-3 text-center text-sm text-gray-500 transition-colors hover:border-gray-400 hover:bg-gray-50 hover:text-gray-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gray-400 disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-400 dark:hover:border-zinc-600 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
        >
          <Plus className="h-4 w-4" />
          {learningAids.length === 0
            ? t('Aggiungi quello che vuoi ricordare')
            : t('Aggiungi un concetto chiave')}
        </button>
      ) : null}

      {draft && !draft.id ? (
        <LearningAidEditor
          draft={draft}
          isInline={false}
          isSaving={isSaving}
          onCancel={cancelDraft}
          onChange={setDraft}
          onSave={() => void saveDraft()}
        />
      ) : null}
    </div>
  );
}

export function HeaderLearningAids({
  isDarkMode,
  learningAids,
  onSaveLearningAids,
}: Pick<LearningAidsProps, 'isDarkMode' | 'learningAids' | 'onSaveLearningAids'>) {
  const [isOpen, setIsOpen] = useState(false);

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
          className="absolute right-0 top-[calc(100%+0.75rem)] z-50 w-96 rounded-2xl border border-gray-200 bg-white p-3 shadow-[0_16px_40px_rgba(15,23,42,0.12)] dark:border-zinc-700 dark:bg-zinc-900"
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
            onSaveLearningAids={onSaveLearningAids}
          />
        </aside>
      ) : null}
    </div>
  );
}

export function MobileLearningAids({
  isDarkMode,
  learningAids,
  onSaveLearningAids,
  isOpen,
  onOpenChange,
}: MobileLearningAidsProps) {
  const portalContainer = typeof document === 'undefined' ? null : document.body;
  const panelRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onOpenChange(false);
      }
    };
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (
        !(target instanceof Node) ||
        panelRef.current?.contains(target) ||
        triggerRef.current?.contains(target)
      ) {
        return;
      }

      onOpenChange(false);
    };

    document.addEventListener('keydown', handleEscape);
    document.addEventListener('pointerdown', handlePointerDown);
    return () => {
      document.removeEventListener('keydown', handleEscape);
      document.removeEventListener('pointerdown', handlePointerDown);
    };
  }, [isOpen, onOpenChange]);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        aria-expanded={isOpen}
        aria-label={t(isOpen ? 'Chiudi concetti chiave' : 'Apri concetti chiave')}
        className={`inline-flex h-9 w-9 items-center justify-center rounded-full border-0 bg-transparent p-2 text-gray-400 transition-colors hover:bg-black/5 hover:text-gray-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gray-400 dark:text-zinc-400 dark:hover:bg-white/10 dark:hover:text-zinc-200 ${isOpen ? 'bg-gray-100 text-gray-500 dark:bg-zinc-700/50 dark:text-zinc-300' : ''}`}
        onClick={() => onOpenChange(!isOpen)}
        title={t('Concetti chiave')}
      >
        <BookOpen className="reader-mobile-control-icon" />
      </button>

      {portalContainer && isOpen
        ? createPortal(
            <div ref={panelRef}>
              <MotionPopover
                aria-label={t('Concetti chiave')}
                className="fixed right-3 top-[5.75rem] z-[60] max-h-[min(70dvh,36rem)] w-[min(24rem,calc(100vw-1.5rem))] overflow-y-auto overscroll-contain rounded-[1.75rem] border border-gray-200 bg-white p-3 shadow-[0_18px_45px_rgba(15,23,42,0.16)] dark:border-zinc-700 dark:bg-zinc-900 dark:shadow-[0_18px_45px_rgba(0,0,0,0.4)]"
                isOpen={isOpen}
                originX="top center"
                role="complementary"
              >
                <div className="mb-3 flex items-center justify-between gap-2 px-1">
                  <h2 className="text-sm font-semibold text-gray-900 dark:text-zinc-100">
                    {t('Concetti chiave')}
                  </h2>
                  <button
                    type="button"
                    aria-label={t('Chiudi concetti chiave')}
                    className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-gray-400 hover:bg-gray-100 hover:text-gray-800 dark:text-zinc-500 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
                    onClick={() => onOpenChange(false)}
                  >
                    <X className="h-4 w-4" />
                  </button>
                </div>
                <LearningAidList
                  isDarkMode={isDarkMode}
                  learningAids={learningAids}
                  onSaveLearningAids={onSaveLearningAids}
                />
              </MotionPopover>
            </div>,
            portalContainer
          )
        : null}
    </>
  );
}
