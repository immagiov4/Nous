import {
  CheckCircle2,
  ChevronRight,
  Copy,
  Download,
  FlaskConical,
  LibraryBig,
  Loader2,
  Minus,
  SidebarClose,
  Sparkles,
  X,
} from 'lucide-react';
import type { MouseEvent as ReactMouseEvent } from 'react';
import { useEffect, useRef, useState } from 'react';
import { READER_SIDEBAR_WIDTH_PX } from '../../../constants/layout.ts';
import type { WorkspaceReaderSidebarModel } from './types.ts';

const LAB_CONTEXT_MENU_WIDTH = 272;
const LAB_CONTEXT_MENU_HEIGHT = 132;
const LAB_CONTEXT_MENU_VIEWPORT_PADDING = 12;
const LESSON_CONTEXT_MENU_WIDTH = 272;
const LESSON_CONTEXT_MENU_HEIGHT = 120;

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
    return 'Generazione lezione in corso…';
  }

  if (isCompleted) {
    return 'Lezione completata';
  }

  if (isActive) {
    return 'Lezione attiva';
  }

  if (hasGeneratedContent) {
    return 'Lezione già generata';
  }

  return 'Lezione non ancora generata';
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

const getLaboratoryExerciseStatusLabel = ({
  isActive,
  isCompleted,
}: {
  isActive: boolean;
  isCompleted: boolean;
}) => {
  if (isCompleted) {
    return 'Esercizio laboratorio completato';
  }

  if (isActive) {
    return 'Esercizio laboratorio attivo';
  }

  return 'Esercizio laboratorio già generato';
};

export default function WorkspaceReaderSidebar({
  activeLaboratoryExerciseId,
  activeSectionId,
  expandedModuleId,
  generatingSectionId,
  isLoading,
  isMobileViewport,
  laboratoryExercises,
  laboratoryStatus,
  laboratoryTitle,
  learningPlanTitle,
  onBackToLibrary,
  onExportProject,
  onGenerateLaboratory,
  onRegenerateLaboratoryIndex,
  onModuleToggle,
  onSelectLaboratoryExercise,
  onSelectSection,
  onSetFocusMode,
  onSetIsMobileSidebarOpen,
  shouldShowSidebar,
  sidebarGroups,
}: WorkspaceReaderSidebarModel) {
  const [isLaboratoryExpanded, setIsLaboratoryExpanded] = useState(true);
  const [laboratoryContextMenuPosition, setLaboratoryContextMenuPosition] = useState<null | {
    x: number;
    y: number;
  }>(null);
  const [lessonContextMenu, setLessonContextMenu] = useState<null | {
    copied: boolean;
    section: WorkspaceReaderSidebarModel['sidebarGroups'][number]['sections'][number];
    x: number;
    y: number;
  }>(null);
  const laboratoryContextMenuRef = useRef<HTMLDivElement>(null);
  const lessonContextMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!laboratoryContextMenuPosition && !lessonContextMenu) {
      return;
    }

    const handlePointerDown = (event: PointerEvent) => {
      if (
        !(event.target instanceof Node) ||
        laboratoryContextMenuRef.current?.contains(event.target) ||
        lessonContextMenuRef.current?.contains(event.target)
      ) {
        return;
      }

      setLaboratoryContextMenuPosition(null);
      setLessonContextMenu(null);
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setLaboratoryContextMenuPosition(null);
        setLessonContextMenu(null);
      }
    };

    window.addEventListener('pointerdown', handlePointerDown);
    window.addEventListener('keydown', handleKeyDown);

    return () => {
      window.removeEventListener('pointerdown', handlePointerDown);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [laboratoryContextMenuPosition, lessonContextMenu]);

  const canOpenLaboratoryContextMenu = Boolean(
    onRegenerateLaboratoryIndex && laboratoryStatus === 'ready'
  );
  const handleLaboratoryContextMenu = (event: ReactMouseEvent<HTMLButtonElement>) => {
    if (!canOpenLaboratoryContextMenu) {
      return;
    }

    event.preventDefault();
    setLaboratoryContextMenuPosition({ x: event.clientX, y: event.clientY });
  };

  const handleRegenerateLaboratoryIndex = () => {
    setLaboratoryContextMenuPosition(null);
    onRegenerateLaboratoryIndex?.();
  };

  const handleLessonContextMenu = (
    event: ReactMouseEvent<HTMLButtonElement>,
    section: WorkspaceReaderSidebarModel['sidebarGroups'][number]['sections'][number]
  ) => {
    event.preventDefault();
    setLaboratoryContextMenuPosition(null);
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

  const laboratoryContextMenuStyle = (() => {
    if (!laboratoryContextMenuPosition) {
      return undefined;
    }

    const viewportWidth = typeof window === 'undefined' ? 0 : window.innerWidth;
    const viewportHeight = typeof window === 'undefined' ? 0 : window.innerHeight;

    return {
      left: Math.max(
        LAB_CONTEXT_MENU_VIEWPORT_PADDING,
        Math.min(
          laboratoryContextMenuPosition.x,
          viewportWidth - LAB_CONTEXT_MENU_WIDTH - LAB_CONTEXT_MENU_VIEWPORT_PADDING
        )
      ),
      top: Math.max(
        LAB_CONTEXT_MENU_VIEWPORT_PADDING,
        Math.min(
          laboratoryContextMenuPosition.y,
          viewportHeight - LAB_CONTEXT_MENU_HEIGHT - LAB_CONTEXT_MENU_VIEWPORT_PADDING
        )
      ),
    };
  })();

  const lessonContextMenuStyle = (() => {
    if (!lessonContextMenu) {
      return undefined;
    }

    const viewportWidth = typeof window === 'undefined' ? 0 : window.innerWidth;
    const viewportHeight = typeof window === 'undefined' ? 0 : window.innerHeight;

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

  const renderLaboratoryExerciseStatus = (
    exercise: WorkspaceReaderSidebarModel['laboratoryExercises'][number]
  ) => {
    if (exercise.evaluation) {
      return <CheckCircle2 className="h-4 w-4 text-gray-600 dark:text-zinc-300" />;
    }

    if (activeLaboratoryExerciseId === exercise.id) {
      return <span className="h-2.5 w-2.5 rounded-full bg-gray-600 dark:bg-zinc-300" />;
    }

    return (
      <span className="h-3 w-3 rounded-full border border-gray-500/80 dark:border-zinc-300/80" />
    );
  };

  return (
    <>
      {isMobileViewport && shouldShowSidebar ? (
        <button
          type="button"
          aria-label="Chiudi elenco lezioni"
          className="fixed inset-0 z-[60] bg-black/40 backdrop-blur-[1px]"
          onClick={() => onSetIsMobileSidebarOpen(false)}
        />
      ) : null}

      <aside
        className={`fixed inset-y-0 left-0 z-[70] flex min-h-0 flex-col overflow-hidden border-r border-gray-200/80 bg-white transition-transform duration-300 dark:border-zinc-700/80 dark:bg-zinc-800 ${
          shouldShowSidebar ? 'translate-x-0' : '-translate-x-full'
        }`}
        style={{
          width: isMobileViewport ? 'min(92vw, 24rem)' : READER_SIDEBAR_WIDTH_PX,
          height: '100dvh',
          maxHeight: '100dvh',
        }}
      >
        <div className="shrink-0 flex flex-col gap-4 border-b border-gray-200/80 px-5 py-5 dark:border-zinc-700/80 sm:px-6">
          <div className="flex items-start justify-between gap-4">
            <h1 className="font-serif text-xl font-bold leading-tight text-gray-900 dark:text-white">
              {learningPlanTitle || 'Percorso di Studio'}
            </h1>
            {isMobileViewport ? (
              <button
                type="button"
                onClick={() => onSetIsMobileSidebarOpen(false)}
                className="rounded-md p-1 text-gray-400 transition-colors hover:bg-gray-100/80 hover:text-gray-700 dark:hover:bg-zinc-800 dark:hover:text-gray-300"
                title="Chiudi elenco lezioni"
              >
                <X className="h-5 w-5" />
              </button>
            ) : (
              <button
                type="button"
                onClick={() => onSetFocusMode(true)}
                className="rounded-md p-1 text-gray-400 transition-colors hover:bg-gray-100/80 hover:text-gray-700 dark:hover:bg-zinc-800 dark:hover:text-gray-300"
                title="Nascondi Menu (Focus Mode)"
              >
                <SidebarClose className="h-5 w-5" />
              </button>
            )}
          </div>

          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={onBackToLibrary}
              className="flex w-full items-center justify-center gap-2 rounded-lg border border-gray-200 bg-gray-50/80 py-2.5 text-xs font-semibold uppercase tracking-wider text-gray-700 transition-colors hover:bg-gray-100 dark:border-zinc-600/50 dark:bg-zinc-700/80 dark:text-gray-200 dark:hover:bg-zinc-600"
            >
              <LibraryBig className="h-4 w-4" /> Libreria
            </button>
            <button
              type="button"
              onClick={onExportProject}
              disabled={isLoading}
              className={`flex w-full items-center justify-center gap-2 rounded-lg border border-gray-200 bg-gray-50/80 py-2.5 text-xs font-semibold uppercase tracking-wider text-gray-700 transition-colors hover:bg-gray-100 dark:border-zinc-600/50 dark:bg-zinc-700/80 dark:text-gray-200 dark:hover:bg-zinc-600 ${
                isLoading ? 'cursor-not-allowed opacity-50' : ''
              }`}
            >
              <Download className="h-4 w-4" /> Esporta
            </button>
          </div>
        </div>

        <div
          className={`reader-sidebar-scroll min-h-0 flex-1 overflow-y-auto overflow-x-hidden overscroll-y-contain px-4 py-5 ${
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
                        {group.sections.map(section => {
                          const isActive = activeSectionId === section.id;
                          const depth = group.sectionDepthById[section.id] ?? 0;
                          const hasGeneratedContent = Boolean(section.content?.trim());
                          const isGenerating = generatingSectionId === section.id;
                          // Disabled only when a different section is being
                          // generated — otherwise all sections are clickable
                          // (to start generation or navigate).
                          const isDisabled =
                            generatingSectionId !== null && !hasGeneratedContent && !isGenerating;

                          return (
                            <button
                              type="button"
                              key={section.id}
                              onClick={() => onSelectSection(section)}
                              onContextMenu={event => handleLessonContextMenu(event, section)}
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
                                title={getSectionStatusLabel({
                                  hasGeneratedContent,
                                  isActive,
                                  isCompleted: section.isCompleted,
                                  isGenerating,
                                })}
                              >
                                {renderSectionStatus({
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

            <section className="border-t border-gray-200/70 pt-4 dark:border-zinc-700/80">
              <button
                type="button"
                onClick={() => setIsLaboratoryExpanded(currentValue => !currentValue)}
                onContextMenu={handleLaboratoryContextMenu}
                className={`flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left transition-colors ${
                  isLaboratoryExpanded
                    ? 'text-gray-900 dark:text-gray-100'
                    : 'text-gray-500 hover:bg-gray-100/70 hover:text-gray-700 dark:text-gray-400 dark:hover:bg-zinc-800/70 dark:hover:text-gray-200'
                }`}
              >
                <ChevronRight
                  className={`h-4 w-4 flex-shrink-0 transition-transform duration-300 ${
                    isLaboratoryExpanded ? 'rotate-90' : ''
                  }`}
                />
                <FlaskConical className="h-4 w-4 flex-shrink-0" />
                <span className="min-w-0 flex-1 truncate text-[11px] font-semibold uppercase tracking-[0.18em]">
                  {laboratoryTitle || 'Laboratorio'}
                </span>
                {laboratoryStatus === 'pending' ? (
                  <Sparkles className="h-4 w-4 animate-pulse text-gray-600 dark:text-zinc-300" />
                ) : null}
              </button>

              {isLaboratoryExpanded ? (
                <div className="mt-2 ml-5 space-y-1 border-l border-gray-200 pl-4 dark:border-zinc-700/80">
                  {laboratoryExercises.length > 0 ? (
                    laboratoryExercises.map(exercise => {
                      const isActive = activeLaboratoryExerciseId === exercise.id;
                      return (
                        <button
                          type="button"
                          key={exercise.id}
                          onClick={() => onSelectLaboratoryExercise(exercise.id)}
                          disabled={isLoading}
                          className={`flex w-full items-center gap-3 py-2 text-left transition-colors ${
                            isActive
                              ? 'text-gray-900 dark:text-gray-100'
                              : 'text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200'
                          } ${isLoading ? 'cursor-not-allowed opacity-50' : ''}`}
                        >
                          <div
                            className="flex h-4 w-4 flex-shrink-0 items-center justify-center"
                            title={getLaboratoryExerciseStatusLabel({
                              isActive,
                              isCompleted: Boolean(exercise.evaluation),
                            })}
                          >
                            {renderLaboratoryExerciseStatus(exercise)}
                          </div>
                          <div className="min-w-0 flex-1">
                            <div
                              className={`truncate text-sm ${isActive ? 'font-medium' : 'font-normal'}`}
                              title={exercise.title}
                            >
                              {exercise.title}
                            </div>
                          </div>
                        </button>
                      );
                    })
                  ) : (
                    <button
                      type="button"
                      onClick={onGenerateLaboratory}
                      disabled={isLoading || laboratoryStatus === 'pending'}
                      className={`flex w-full items-center gap-2 rounded-lg border border-gray-200 bg-gray-50/80 py-2.5 text-xs font-semibold uppercase tracking-wider text-gray-700 transition-colors hover:bg-gray-100 dark:border-zinc-600/50 dark:bg-zinc-700/80 dark:text-gray-200 dark:hover:bg-zinc-600 ${
                        isLoading || laboratoryStatus === 'pending'
                          ? 'cursor-not-allowed opacity-60'
                          : ''
                      }`}
                    >
                      <Sparkles className="ml-3 h-3.5 w-3.5" />
                      {laboratoryStatus === 'pending'
                        ? 'Generazione in corso...'
                        : 'Genera laboratorio'}
                    </button>
                  )}
                </div>
              ) : null}
            </section>
          </div>
        </div>
      </aside>

      {/* TODO: Remove this temporary full-laboratory regeneration entry point after manual QA no longer needs lab-wide reindexing. */}
      {laboratoryContextMenuPosition && onRegenerateLaboratoryIndex ? (
        <div
          ref={laboratoryContextMenuRef}
          role="menu"
          aria-label="Azioni laboratorio"
          className="fixed z-[90] w-[17rem] rounded-2xl border border-gray-200 bg-white p-2 shadow-[0_18px_36px_-24px_rgba(15,23,42,0.28)] dark:border-zinc-600/80 dark:bg-stone-800"
          style={laboratoryContextMenuStyle}
        >
          <button
            type="button"
            role="menuitem"
            onClick={handleRegenerateLaboratoryIndex}
            disabled={isLoading || laboratoryStatus === 'pending'}
            className={`flex w-full items-center rounded-xl px-3 py-2 text-left text-sm font-medium text-gray-800 transition-colors hover:bg-gray-100 dark:text-zinc-100 dark:hover:bg-stone-700 ${
              isLoading || laboratoryStatus === 'pending' ? 'cursor-not-allowed opacity-60' : ''
            }`}
          >
            Rigenera intero laboratorio
          </button>
          <p className="px-3 pb-2 pt-1 text-xs leading-5 text-gray-500 dark:text-zinc-400">
            Temporaneo per QA del laboratorio. Va rimosso quando non servirà più rigenerare l'intero
            indice separatamente dal corso.
          </p>
        </div>
      ) : null}

      {/* TODO: Remove this temporary lesson markdown debug copy action after renderer QA is complete. */}
      {lessonContextMenu ? (
        <div
          ref={lessonContextMenuRef}
          role="menu"
          aria-label="Azioni debug lezione"
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
            {lessonContextMenu.copied ? 'Markdown copiato' : 'Copia markdown lezione'}
          </button>
          <p className="px-3 pb-2 pt-1 text-xs leading-5 text-gray-500 dark:text-zinc-400">
            Debug temporaneo: copia il markdown salvato prima del rendering.
          </p>
        </div>
      ) : null}
    </>
  );
}
