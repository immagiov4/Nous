import {
  CheckCircle2,
  ChevronRight,
  ClipboardCheck,
  Copy,
  LibraryBig,
  Loader2,
  MessageSquareWarning,
  Minus,
  SidebarClose,
  X,
} from 'lucide-react';
import type { MouseEvent as ReactMouseEvent } from 'react';
import { memo, useEffect, useRef, useState } from 'react';
import { READER_SIDEBAR_WIDTH_PX } from '../../../constants/layout.ts';
import { translateUiMessage as t } from '../../../i18n/uiMessages.ts';
import type { ApplicationExerciseNode, LessonNode, PathNode } from '../../../types.ts';
import FeedbackDialog from '../../feedback/FeedbackDialog.tsx';
import type { WorkspaceReaderSidebarModel } from './types.ts';

const LAB_CONTEXT_MENU_VIEWPORT_PADDING = 12;
const LESSON_CONTEXT_MENU_WIDTH = 272;
const LESSON_CONTEXT_MENU_HEIGHT = 120;
const MOBILE_SIDEBAR_MOTION_CLASS_NAME =
  'max-sm:duration-150 max-sm:ease-[cubic-bezier(0.2,0.85,0.25,1)] max-sm:motion-reduce:transition-none';

const getSectionStatusLabel = ({
  hasGeneratedContent,
  isActive,
  isCompleted,
  isGenerating,
}: {
  hasGeneratedContent: boolean;
  isActive: boolean;
  isCompleted: boolean;
  isGenerating: boolean;
}) => {
  if (isGenerating) {
    return t('Generazione lezione in corso…');
  }

  if (isCompleted) {
    return t('Lezione completata');
  }

  if (isActive) {
    return t('Lezione attiva');
  }

  if (hasGeneratedContent) {
    return t('Lezione già generata');
  }

  return t('Lezione non ancora generata');
};

const getExerciseStatusLabel = (exercise: ApplicationExerciseNode, isActive: boolean) => {
  if (exercise.isCompleted) {
    return exercise.bestScore !== undefined
      ? t('Esercizio completato: {score}/100', { score: exercise.bestScore })
      : t('Esercizio completato');
  }

  if (exercise.feedbackStale) {
    return t('Esercizio con feedback da aggiornare');
  }

  if (exercise.currentFeedback) {
    return `${exercise.currentFeedback.qualitativeLabel}: ${exercise.currentFeedback.score}/100`;
  }

  if (isActive) {
    return t('Esercizio applicativo attivo');
  }

  if (exercise.brief?.trim()) {
    return t('Esercizio applicativo pronto');
  }

  return t('Esercizio applicativo pianificato');
};

const renderExerciseStatus = (exercise: ApplicationExerciseNode, isActive: boolean) => {
  if (exercise.isCompleted) {
    return <CheckCircle2 className="h-4 w-4 text-emerald-700 dark:text-emerald-300" />;
  }

  if (exercise.currentFeedback) {
    return (
      <span className="h-3 w-3 rounded-full border-2 border-orange-500 bg-orange-100 dark:bg-orange-950/60" />
    );
  }

  if (isActive) {
    return <span className="h-2.5 w-2.5 rounded-full bg-orange-600 dark:bg-orange-300" />;
  }

  return <ClipboardCheck className="h-3.5 w-3.5 text-orange-600/80 dark:text-orange-300/80" />;
};

const renderSectionStatus = ({
  hasGeneratedContent,
  isActive,
  isCompleted,
  isGenerating,
}: {
  hasGeneratedContent: boolean;
  isActive: boolean;
  isCompleted: boolean;
  isGenerating: boolean;
}) => {
  if (isGenerating) {
    return <Loader2 className="h-3.5 w-3.5 animate-spin text-orange-500" strokeWidth={2} />;
  }

  if (isCompleted) {
    return <CheckCircle2 className="h-4 w-4 text-gray-600 dark:text-zinc-300" />;
  }

  if (isActive) {
    return <span className="h-2.5 w-2.5 rounded-full bg-gray-600 dark:bg-zinc-300" />;
  }

  if (hasGeneratedContent) {
    return (
      <span className="h-3 w-3 rounded-full border border-gray-500/80 dark:border-zinc-300/80" />
    );
  }

  return (
    <Minus
      className="h-3.5 w-3.5 text-gray-500/75 dark:text-zinc-300/75"
      strokeWidth={1.8}
      absoluteStrokeWidth
    />
  );
};

const WorkspaceReaderSidebar = memo(function WorkspaceReaderSidebar({
  activeSectionId,
  canRepairApplicationExercises,
  expandedModuleId,
  generatingSectionId,
  isRepairingApplicationExercises,
  isLoading,
  isMobileViewport,
  learningPlanTitle,
  placement = 'viewport',
  repairApplicationExercisesLabel,
  onBackToLibrary,
  onModuleToggle,
  onRepairApplicationExercises,
  onSelectExercise,
  onSelectSection,
  onSetFocusMode,
  onSetIsMobileSidebarOpen,
  shouldShowSidebar,
  sidebarGroups,
}: WorkspaceReaderSidebarModel) {
  const [lessonContextMenu, setLessonContextMenu] = useState<null | {
    copied: boolean;
    section: LessonNode;
    x: number;
    y: number;
  }>(null);
  const [isFeedbackOpen, setIsFeedbackOpen] = useState(false);
  const lessonContextMenuRef = useRef<HTMLDivElement>(null);
  const feedbackTriggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!lessonContextMenu) {
      return;
    }

    const handlePointerDown = (event: PointerEvent) => {
      if (!(event.target instanceof Node) || lessonContextMenuRef.current?.contains(event.target)) {
        return;
      }

      setLessonContextMenu(null);
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setLessonContextMenu(null);
      }
    };

    globalThis.window.addEventListener('pointerdown', handlePointerDown);
    globalThis.window.addEventListener('keydown', handleKeyDown);

    return () => {
      globalThis.window.removeEventListener('pointerdown', handlePointerDown);
      globalThis.window.removeEventListener('keydown', handleKeyDown);
    };
  }, [lessonContextMenu]);

  const handleLessonContextMenu = (
    event: ReactMouseEvent<HTMLButtonElement>,
    section: LessonNode
  ) => {
    event.preventDefault();
    setLessonContextMenu({ copied: false, section, x: event.clientX, y: event.clientY });
  };

  const handleCopyLessonMarkdown = async () => {
    const markdown = lessonContextMenu?.section.content?.trim();
    if (!markdown) {
      return;
    }

    try {
      await navigator.clipboard.writeText(markdown);
      setLessonContextMenu(currentValue =>
        currentValue ? { ...currentValue, copied: true } : currentValue
      );
    } catch (error) {
      console.error('[Nous][Debug] Failed to copy lesson markdown.', error);
    }
  };

  const closeFeedback = () => {
    setIsFeedbackOpen(false);
    if (isMobileViewport) onSetIsMobileSidebarOpen(true);
    queueMicrotask(() => feedbackTriggerRef.current?.focus());
  };

  const lessonContextMenuStyle = (() => {
    if (!lessonContextMenu) {
      return undefined;
    }

    const viewportWidth =
      typeof globalThis.window === 'undefined' ? 0 : globalThis.window.innerWidth;
    const viewportHeight =
      typeof globalThis.window === 'undefined' ? 0 : globalThis.window.innerHeight;

    return {
      left: Math.max(
        LAB_CONTEXT_MENU_VIEWPORT_PADDING,
        Math.min(
          lessonContextMenu.x,
          viewportWidth - LESSON_CONTEXT_MENU_WIDTH - LAB_CONTEXT_MENU_VIEWPORT_PADDING
        )
      ),
      top: Math.max(
        LAB_CONTEXT_MENU_VIEWPORT_PADDING,
        Math.min(
          lessonContextMenu.y,
          viewportHeight - LESSON_CONTEXT_MENU_HEIGHT - LAB_CONTEXT_MENU_VIEWPORT_PADDING
        )
      ),
    };
  })();
  const isContainerPlaced = placement === 'container';
  const viewportPositionClassName = isContainerPlaced ? 'absolute' : 'fixed';
  const sidebarHeight = isContainerPlaced ? '100%' : '100dvh';
  const sidebarTransformClassName = shouldShowSidebar
    ? 'translate-x-0 max-sm:[transform:translate3d(0,0,0)]'
    : '-translate-x-full max-sm:[transform:translate3d(-100%,0,0)]';

  return (
    <>
      {isMobileViewport ? (
        <button
          type="button"
          aria-label={t('Chiudi elenco lezioni')}
          aria-hidden={!shouldShowSidebar}
          disabled={!shouldShowSidebar}
          tabIndex={shouldShowSidebar ? 0 : -1}
          className={`${viewportPositionClassName} inset-0 z-[60] bg-black/40 backdrop-blur-[1px] transition-none max-sm:backdrop-blur-none max-sm:transition-opacity max-sm:will-change-[opacity] ${MOBILE_SIDEBAR_MOTION_CLASS_NAME} ${
            shouldShowSidebar ? 'pointer-events-auto opacity-100' : 'pointer-events-none opacity-0'
          }`}
          onClick={() => onSetIsMobileSidebarOpen(false)}
        />
      ) : null}

      <aside
        className={`${viewportPositionClassName} inset-y-0 left-0 z-[70] flex min-h-0 flex-col overflow-hidden rounded-r-[2rem] border-r border-gray-200/80 bg-white transition-transform duration-300 max-sm:will-change-transform dark:border-zinc-700/80 dark:bg-zinc-800 ${MOBILE_SIDEBAR_MOTION_CLASS_NAME} ${sidebarTransformClassName}`}
        style={{
          width: isMobileViewport ? 'min(92vw, 24rem)' : READER_SIDEBAR_WIDTH_PX,
          height: sidebarHeight,
          maxHeight: sidebarHeight,
        }}
      >
        <div className="shrink-0 flex flex-col gap-4 border-b border-gray-200/80 px-5 py-5 dark:border-zinc-700/80 sm:px-6">
          <div className="flex items-start justify-between gap-4">
            <h1 className="font-serif text-xl font-bold leading-tight text-gray-900 dark:text-white">
              {learningPlanTitle || t('Percorso di Studio')}
            </h1>
            {isMobileViewport ? (
              <button
                type="button"
                onClick={() => onSetIsMobileSidebarOpen(false)}
                className="rounded-md p-1 text-gray-400 transition-colors hover:bg-gray-100/80 hover:text-gray-700 dark:hover:bg-zinc-800 dark:hover:text-gray-300"
                title={t('Chiudi elenco lezioni')}
              >
                <X className="h-5 w-5" />
              </button>
            ) : (
              <button
                type="button"
                onClick={() => onSetFocusMode(true)}
                className="rounded-md p-1 text-gray-400 transition-colors hover:bg-gray-100/80 hover:text-gray-700 dark:hover:bg-zinc-800 dark:hover:text-gray-300"
                title={t('Nascondi Menu (Focus Mode)')}
              >
                <SidebarClose className="h-5 w-5" />
              </button>
            )}
          </div>

          <div className="grid grid-cols-[0.82fr_1.18fr] gap-2">
            <button
              type="button"
              onClick={onBackToLibrary}
              className="flex w-full items-center justify-center gap-2 rounded-lg border border-gray-200 bg-gray-50/80 py-2.5 text-xs font-semibold uppercase tracking-wider text-gray-700 transition-colors hover:bg-gray-100 dark:border-zinc-600/50 dark:bg-zinc-700/80 dark:text-gray-200 dark:hover:bg-zinc-600"
            >
              <LibraryBig className="h-4 w-4" /> {t('Libreria')}
            </button>
            <button
              ref={feedbackTriggerRef}
              type="button"
              onClick={() => {
                setIsFeedbackOpen(true);
                if (isMobileViewport) onSetIsMobileSidebarOpen(false);
              }}
              className="flex w-full items-center justify-center gap-2 rounded-lg border border-gray-200 bg-gray-50/80 py-2.5 text-xs font-semibold uppercase tracking-wider text-gray-700 transition-colors hover:bg-gray-100 dark:border-zinc-600/50 dark:bg-zinc-700/80 dark:text-gray-200 dark:hover:bg-zinc-600"
            >
              <MessageSquareWarning className="h-4 w-4 shrink-0" />
              <span className="whitespace-nowrap">{t('Segnala problema')}</span>
            </button>
          </div>

          {canRepairApplicationExercises || isRepairingApplicationExercises ? (
            <button
              type="button"
              onClick={onRepairApplicationExercises}
              disabled={isLoading || isRepairingApplicationExercises}
              className={`flex w-full items-center justify-center gap-2 rounded-lg border border-orange-200 bg-orange-50/80 py-2.5 text-xs font-semibold uppercase tracking-wider text-orange-800 transition-colors hover:bg-orange-100 dark:border-orange-900/50 dark:bg-orange-950/25 dark:text-orange-200 dark:hover:bg-orange-900/35 ${
                isLoading || isRepairingApplicationExercises ? 'cursor-not-allowed opacity-50' : ''
              }`}
            >
              {isRepairingApplicationExercises ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" /> {t('Pianificazione esercizi...')}
                </>
              ) : (
                <>
                  <ClipboardCheck className="h-4 w-4" /> {repairApplicationExercisesLabel}
                </>
              )}
            </button>
          ) : null}
        </div>

        <div
          className={`reader-sidebar-scroll custom-scrollbar mr-2 mb-2 min-h-0 flex-1 overflow-y-auto overflow-x-hidden overscroll-y-contain px-4 py-5 ${
            isMobileViewport ? 'reader-sidebar-scroll-mobile' : ''
          }`}
        >
          <div className="space-y-6">
            <div className="space-y-3">
              {sidebarGroups.map(group => {
                const isExpanded = expandedModuleId === group.id;

                return (
                  <section
                    key={group.id}
                    className="border-b border-gray-200/70 pb-3 last:border-b-0 last:pb-0 dark:border-zinc-700/80"
                  >
                    <button
                      type="button"
                      onClick={() => onModuleToggle(group.id)}
                      className={`flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left transition-colors ${
                        isExpanded
                          ? 'text-gray-900 dark:text-gray-100'
                          : 'text-gray-500 hover:bg-gray-100/70 hover:text-gray-700 dark:text-gray-400 dark:hover:bg-zinc-800/70 dark:hover:text-gray-200'
                      }`}
                    >
                      <ChevronRight
                        className={`h-4 w-4 flex-shrink-0 transition-transform duration-300 ${
                          isExpanded ? 'rotate-90' : ''
                        }`}
                      />
                      <span
                        className="min-w-0 flex-1 truncate text-[11px] font-semibold uppercase tracking-[0.18em]"
                        title={group.title}
                      >
                        {group.title}
                      </span>
                    </button>

                    {isExpanded ? (
                      <div className="mt-2 ml-5 space-y-1 border-l border-gray-200 pl-4 dark:border-zinc-700/80">
                        {group.sections.map((section: PathNode) => {
                          const isActive = activeSectionId === section.id;
                          const depth = group.sectionDepthById[section.id] ?? 0;
                          const hasGeneratedContent =
                            section.kind === 'lesson' && Boolean(section.content?.trim());
                          const isGenerating =
                            section.kind === 'lesson' && generatingSectionId === section.id;
                          // Disabled only when a different section is being
                          // generated — otherwise all sections are clickable
                          // (to start generation or navigate).
                          const isDisabled =
                            generatingSectionId !== null && !hasGeneratedContent && !isGenerating;
                          const statusLabel =
                            section.kind === 'exercise'
                              ? getExerciseStatusLabel(section, isActive)
                              : getSectionStatusLabel({
                                  hasGeneratedContent,
                                  isActive,
                                  isCompleted: section.isCompleted,
                                  isGenerating,
                                });

                          return (
                            <button
                              type="button"
                              key={section.id}
                              onClick={() =>
                                section.kind === 'exercise'
                                  ? onSelectExercise(section)
                                  : onSelectSection(section)
                              }
                              onContextMenu={
                                section.kind === 'lesson'
                                  ? event => handleLessonContextMenu(event, section)
                                  : undefined
                              }
                              disabled={isDisabled}
                              style={{ paddingLeft: `${depth * 0.9}rem` }}
                              className={`flex w-full items-center gap-3 py-2 text-left transition-colors ${
                                isActive
                                  ? 'text-gray-900 dark:text-gray-100'
                                  : 'text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200'
                              } ${isDisabled ? 'cursor-not-allowed opacity-40' : ''}`}
                            >
                              <div
                                className="flex h-4 w-4 flex-shrink-0 items-center justify-center"
                                title={statusLabel}
                              >
                                {section.kind === 'exercise'
                                  ? renderExerciseStatus(section, isActive)
                                  : renderSectionStatus({
                                      hasGeneratedContent,
                                      isActive,
                                      isCompleted: section.isCompleted,
                                      isGenerating,
                                    })}
                              </div>
                              <div className="min-w-0 flex-1">
                                <div
                                  className={`truncate text-sm ${isActive ? 'font-medium' : 'font-normal'}`}
                                  title={section.title}
                                >
                                  {section.title}
                                </div>
                              </div>
                            </button>
                          );
                        })}
                      </div>
                    ) : null}
                  </section>
                );
              })}
            </div>
          </div>
        </div>
      </aside>

      {lessonContextMenu ? (
        <div
          ref={lessonContextMenuRef}
          role="menu"
          aria-label={t('Azioni lezione')}
          className="fixed z-[90] w-[17rem] rounded-2xl border border-gray-200 bg-white p-2 shadow-[0_18px_36px_-24px_rgba(15,23,42,0.28)] dark:border-zinc-600/80 dark:bg-stone-800"
          style={lessonContextMenuStyle}
        >
          <button
            type="button"
            role="menuitem"
            onClick={handleCopyLessonMarkdown}
            disabled={!lessonContextMenu.section.content?.trim()}
            className={`flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left text-sm font-medium text-gray-800 transition-colors hover:bg-gray-100 dark:text-zinc-100 dark:hover:bg-stone-700 ${
              !lessonContextMenu.section.content?.trim() ? 'cursor-not-allowed opacity-60' : ''
            }`}
          >
            <Copy className="h-4 w-4 shrink-0" />
            {t(lessonContextMenu.copied ? 'Markdown copiato' : 'Copia markdown lezione')}
          </button>
        </div>
      ) : null}

      {isFeedbackOpen ? <FeedbackDialog onClose={closeFeedback} /> : null}
    </>
  );
});

export default WorkspaceReaderSidebar;
