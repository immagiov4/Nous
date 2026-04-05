import {
  BookCopy,
  Clock3,
  Download,
  FileArchive,
  FileText,
  FolderInput,
  Loader2,
  MoreVertical,
  TriangleAlert,
  Trash2,
} from 'lucide-react';
import type { CSSProperties } from 'react';
import { useState } from 'react';
import type { SavedProjectMeta } from '../../types';

interface ProjectCardProps {
  className?: string;
  isOpening?: boolean;
  onMove?: (projectId: string) => void;
  project: SavedProjectMeta;
  onDelete: (projectId: string) => void;
  onExport: (projectId: string) => void;
  onOpen: (projectId: string) => void;
  style?: CSSProperties;
}

const formatDate = (value: string): string =>
  new Intl.DateTimeFormat('it-IT', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  }).format(new Date(value));

const ProjectCard = ({
  className,
  isOpening = false,
  onDelete,
  onExport,
  onMove,
  onOpen,
  project,
  style,
}: ProjectCardProps) => {
  const [menuOpen, setMenuOpen] = useState(false);
  const CoverIcon = project.sourceKind === 'codebase' ? FileArchive : project.sourceKind === 'learn-mode' ? BookCopy : FileText;
  const showSourceWarning = !project.hasSourceFile && project.sourceKind !== 'learn-mode';

  return (
    <article
      className={`group flex items-center gap-3 rounded-xl border border-gray-300 bg-white px-3.5 py-3 transition-colors hover:border-gray-400 sm:gap-4 sm:rounded-2xl sm:px-4 sm:py-3.5 dark:border-white/10 dark:bg-paper-surface dark:hover:border-zinc-600 ${className || ''}`}
      style={style}
    >
      {/* Icon */}
      <button
        type="button"
        onClick={() => onOpen(project.id)}
        disabled={isOpening}
        className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg bg-gray-100 text-gray-500 transition-colors hover:bg-gray-200 hover:text-gray-700 sm:h-10 sm:w-10 sm:rounded-xl dark:bg-paper-dark dark:text-zinc-300 dark:hover:bg-zinc-700/50"
        title="Apri progetto"
      >
        {isOpening ? (
          <Loader2 className="h-4 w-4 animate-spin sm:h-[1.125rem] sm:w-[1.125rem]" />
        ) : (
          <CoverIcon className="h-4 w-4 sm:h-[1.125rem] sm:w-[1.125rem]" />
        )}
      </button>

      {/* Main info — clickable */}
      <button
        type="button"
        onClick={() => onOpen(project.id)}
        disabled={isOpening}
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
          <span className="flex-shrink-0 font-semibold text-gray-700 dark:text-zinc-300">{project.lessonCount} lezioni</span>
          <span className="flex-shrink-0 text-gray-400 dark:text-zinc-700">&middot;</span>
          <span className="truncate" title={project.coverLabel}>{project.coverLabel}</span>
          <span className="flex-shrink-0 text-gray-400 dark:text-zinc-700">&middot;</span>
          <span className="hidden flex-shrink-0 items-center gap-1 sm:inline-flex">
            <Clock3 className="h-3 w-3" />
            {formatDate(project.lastOpenedAt)}
          </span>
        </div>
      </button>

      {/* Actions */}
      <div className="relative flex-shrink-0">
        {menuOpen ? (
          <div
            className="fixed inset-0 z-40"
            onClick={() => setMenuOpen(false)}
            onKeyDown={e => { if (e.key === 'Escape') setMenuOpen(false); }}
          />
        ) : null}
        <button
          type="button"
          onClick={e => { e.stopPropagation(); setMenuOpen(v => !v); }}
          className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-800 dark:text-zinc-500 dark:hover:bg-paper-dark dark:hover:text-zinc-200"
          title="Azioni"
        >
          <MoreVertical className="h-4 w-4" />
        </button>
        {menuOpen ? (
          <div className="absolute right-0 top-9 z-50 min-w-[10rem] overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-lg dark:border-zinc-700 dark:bg-zinc-800">
            {onMove ? (
              <button
                type="button"
                onClick={() => { setMenuOpen(false); onMove(project.id); }}
                className="flex w-full items-center gap-2.5 px-4 py-2.5 text-sm text-gray-700 hover:bg-gray-50 dark:text-zinc-200 dark:hover:bg-zinc-700"
              >
                <FolderInput className="h-4 w-4 shrink-0" />
                Sposta
              </button>
            ) : null}
            <button
              type="button"
              onClick={() => { setMenuOpen(false); onExport(project.id); }}
              className="flex w-full items-center gap-2.5 px-4 py-2.5 text-sm text-gray-700 hover:bg-gray-50 dark:text-zinc-200 dark:hover:bg-zinc-700"
            >
              <Download className="h-4 w-4 shrink-0" />
              Esporta
            </button>
            <div className="border-t border-gray-100 dark:border-zinc-700" />
            <button
              type="button"
              onClick={() => { setMenuOpen(false); onDelete(project.id); }}
              className="flex w-full items-center gap-2.5 px-4 py-2.5 text-sm text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950/40"
            >
              <Trash2 className="h-4 w-4 shrink-0" />
              Elimina
            </button>
          </div>
        ) : null}
      </div>
    </article>
  );
};

export default ProjectCard;
