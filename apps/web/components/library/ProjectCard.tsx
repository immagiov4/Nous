import {
  BookCopy,
  Clock3,
  Download,
  FileArchive,
  FileText,
  FolderInput,
  Loader2,
  MoreVertical,
  Trash2,
  TriangleAlert,
} from 'lucide-react';
import type { CSSProperties } from 'react';
import { createElement, useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  LIBRARY_MENU_EDGE_PADDING_PX,
  LIBRARY_MENU_GAP_PX,
  LIBRARY_PROJECT_MENU_ESTIMATED_HEIGHT_PX,
  LIBRARY_PROJECT_MENU_WIDTH_PX,
} from '../../constants/layout.ts';
import { getAppLocale, translateUiMessage as t } from '../../i18n/uiMessages.ts';
import type { SavedProjectMeta } from '../../types';
import { MotionPopover, Pressable } from '../../utils/motion/index.ts';

interface ProjectCardProps {
  className?: string;
  isExporting?: boolean;
  isOpening?: boolean;
  onMove?: (projectId: string) => void;
  project: SavedProjectMeta;
  onDelete: (projectId: string) => void;
  onExport: (projectId: string) => void;
  onOpen: (projectId: string) => void;
  style?: CSSProperties;
}

const formatDate = (value: string): string =>
  new Intl.DateTimeFormat(getAppLocale() === 'it' ? 'it-IT' : 'en-US', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  }).format(new Date(value));

const getProjectCoverIcon = (sourceKind: SavedProjectMeta['sourceKind']) => {
  if (sourceKind === 'codebase') {
    return FileArchive;
  }

  if (sourceKind === 'learn-mode') {
    return BookCopy;
  }

  return FileText;
};

const ProjectCard = ({
  className,
  isExporting = false,
  isOpening = false,
  onDelete,
  onExport,
  onMove,
  onOpen,
  project,
  style,
}: ProjectCardProps) => {
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuPosition, setMenuPosition] = useState({
    bottom: null as number | null,
    left: 0,
    maxHeight: LIBRARY_MENU_EDGE_PADDING_PX,
    top: null as number | null,
  });
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const wasExportingRef = useRef(isExporting);
  const coverIcon = getProjectCoverIcon(project.sourceKind);
  const showSourceWarning = !project.hasSourceFile && project.sourceKind !== 'learn-mode';

  const openMenu = () => {
    const buttonRect = menuButtonRef.current?.getBoundingClientRect();
    if (!buttonRect) {
      setMenuPosition({ bottom: null, left: 0, maxHeight: window.innerHeight, top: 0 });
      setMenuOpen(true);
      return;
    }

    const spaceBelow = window.innerHeight - buttonRect.bottom;
    const spaceAbove = buttonRect.top;
    const shouldOpenAbove =
      spaceBelow < LIBRARY_PROJECT_MENU_ESTIMATED_HEIGHT_PX && spaceAbove > spaceBelow;
    const nextTop = buttonRect.bottom + LIBRARY_MENU_GAP_PX;
    const nextBottom = window.innerHeight - buttonRect.top + LIBRARY_MENU_GAP_PX;
    const nextLeft = Math.max(
      LIBRARY_MENU_EDGE_PADDING_PX,
      Math.min(
        window.innerWidth - LIBRARY_PROJECT_MENU_WIDTH_PX - LIBRARY_MENU_EDGE_PADDING_PX,
        buttonRect.right - LIBRARY_PROJECT_MENU_WIDTH_PX
      )
    );
    const nextMaxHeight = shouldOpenAbove
      ? Math.max(
          LIBRARY_MENU_EDGE_PADDING_PX,
          spaceAbove - LIBRARY_MENU_GAP_PX - LIBRARY_MENU_EDGE_PADDING_PX
        )
      : Math.max(
          LIBRARY_MENU_EDGE_PADDING_PX,
          window.innerHeight - nextTop - LIBRARY_MENU_EDGE_PADDING_PX
        );

    setMenuPosition({
      bottom: shouldOpenAbove ? nextBottom : null,
      left: nextLeft,
      maxHeight: nextMaxHeight,
      top: shouldOpenAbove ? null : nextTop,
    });
    setMenuOpen(true);
  };

  const closeMenu = useCallback(() => {
    setMenuOpen(false);
    queueMicrotask(() => menuButtonRef.current?.focus());
  }, []);

  useEffect(() => {
    if (!menuOpen) {
      return;
    }

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeMenu();
      }
    };

    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [closeMenu, menuOpen]);

  useEffect(() => {
    if (wasExportingRef.current && !isExporting) {
      closeMenu();
    }
    wasExportingRef.current = isExporting;
  }, [closeMenu, isExporting]);

  const renderMenu = () => {
    if (!menuOpen) {
      return null;
    }

    return createPortal(
      <>
        <button
          type="button"
          aria-label={t('Chiudi menu progetto')}
          className="fixed inset-0 z-40"
          onClick={closeMenu}
        />
        <MotionPopover
          isOpen={menuOpen}
          originX={menuPosition.bottom === null ? 'top right' : 'bottom right'}
          className="fixed z-50 min-w-[10rem] overflow-x-hidden overflow-y-auto rounded-2xl border border-gray-200 bg-white shadow-lg dark:border-zinc-700 dark:bg-zinc-800"
          style={{
            bottom: menuPosition.bottom === null ? undefined : `${menuPosition.bottom}px`,
            left: `${menuPosition.left}px`,
            maxHeight: `${menuPosition.maxHeight}px`,
            top: menuPosition.top === null ? undefined : `${menuPosition.top}px`,
            width: `${LIBRARY_PROJECT_MENU_WIDTH_PX}px`,
          }}
        >
          {onMove ? (
            <button
              type="button"
              onClick={() => {
                setMenuOpen(false);
                menuButtonRef.current?.focus();
                onMove(project.id);
              }}
              className="flex w-full items-center gap-2.5 px-4 py-2.5 text-sm text-gray-700 hover:bg-gray-50 dark:text-zinc-200 dark:hover:bg-zinc-700"
            >
              <FolderInput className="h-4 w-4 shrink-0" />
              {t('Sposta')}
            </button>
          ) : null}
          <button
            type="button"
            aria-busy={isExporting}
            disabled={isExporting}
            onClick={() => {
              onExport(project.id);
            }}
            className="flex w-full items-center gap-2.5 px-4 py-2.5 text-sm text-gray-700 hover:bg-gray-50 disabled:cursor-wait disabled:opacity-60 dark:text-zinc-200 dark:hover:bg-zinc-700"
          >
            {isExporting ? (
              <Loader2 className="h-4 w-4 shrink-0 animate-spin" />
            ) : (
              <Download className="h-4 w-4 shrink-0" />
            )}
            {isExporting ? t('Esportazione...') : t('Esporta')}
          </button>
          <div className="border-t border-gray-100 dark:border-zinc-700" />
          <button
            type="button"
            onClick={() => {
              setMenuOpen(false);
              onDelete(project.id);
            }}
            className="flex w-full items-center gap-2.5 px-4 py-2.5 text-sm text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950/40"
          >
            <Trash2 className="h-4 w-4 shrink-0" />
            {t('Elimina')}
          </button>
        </MotionPopover>
      </>,
      document.body
    );
  };

  return (
    <article
      className={`group flex items-center gap-3 rounded-xl border border-gray-300 bg-white px-3.5 py-3 transition-colors hover:border-gray-400 sm:gap-4 sm:rounded-2xl sm:px-4 sm:py-3.5 dark:border-white/10 dark:bg-paper-surface dark:hover:border-zinc-600 ${className || ''}`}
      style={style}
    >
      {/* Icon */}
      <Pressable
        onClick={() => onOpen(project.id)}
        aria-busy={isOpening}
        className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg bg-gray-100 text-gray-500 transition-colors hover:bg-gray-200 hover:text-gray-700 sm:h-10 sm:w-10 sm:rounded-xl dark:bg-paper-dark dark:text-zinc-300 dark:hover:bg-zinc-700/50"
        title={t('Apri progetto')}
      >
        {isOpening ? (
          <Loader2 className="h-4 w-4 animate-spin sm:h-[1.125rem] sm:w-[1.125rem]" />
        ) : (
          createElement(coverIcon, { className: 'h-4 w-4 sm:h-[1.125rem] sm:w-[1.125rem]' })
        )}
      </Pressable>

      {/* Main info — clickable */}
      <button
        type="button"
        onClick={() => onOpen(project.id)}
        aria-busy={isOpening}
        className="flex min-w-0 flex-1 flex-col items-start gap-1 text-left"
      >
        <div className="flex w-full items-center gap-2">
          <h3 className="truncate text-sm font-medium text-gray-900 sm:text-[0.938rem] dark:text-zinc-100">
            {project.title}
          </h3>
          {showSourceWarning ? (
            <TriangleAlert className="h-3.5 w-3.5 flex-shrink-0 text-amber-500 dark:text-amber-400" />
          ) : null}
        </div>
        <div className="flex w-full items-center gap-2 text-[11px] text-gray-500 sm:text-xs dark:text-zinc-500">
          <span className="flex-shrink-0 font-semibold text-gray-700 dark:text-zinc-300">
            {project.lessonCount} {t('lezioni')}
          </span>
          <span className="flex-shrink-0 text-gray-400 dark:text-zinc-700">&middot;</span>
          <span className="truncate" title={project.coverLabel}>
            {project.coverLabel}
          </span>
          <span className="flex-shrink-0 text-gray-400 dark:text-zinc-700">&middot;</span>
          <span className="hidden flex-shrink-0 items-center gap-1 sm:inline-flex">
            <Clock3 className="h-3 w-3" />
            {formatDate(project.lastOpenedAt)}
          </span>
        </div>
      </button>

      {/* Actions */}
      <div className="relative flex-shrink-0">
        <Pressable
          ref={menuButtonRef}
          onClick={e => {
            e.stopPropagation();
            if (menuOpen) {
              closeMenu();
              return;
            }

            openMenu();
          }}
          aria-label={t('Azioni corso {projectTitle}', { projectTitle: project.title })}
          className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-800 dark:text-zinc-500 dark:hover:bg-paper-dark dark:hover:text-zinc-200"
          title={t('Azioni')}
        >
          <MoreVertical className="h-4 w-4" />
        </Pressable>
        {renderMenu()}
      </div>
    </article>
  );
};

export default ProjectCard;
