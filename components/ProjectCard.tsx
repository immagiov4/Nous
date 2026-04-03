import { BookCopy, Clock3, Download, FileArchive, FileText, TriangleAlert, Trash2 } from 'lucide-react';
import type { SavedProjectMeta } from '../types';

interface ProjectCardProps {
  isOpening?: boolean;
  project: SavedProjectMeta;
  onDelete: (projectId: string) => void;
  onExport: (projectId: string) => void;
  onOpen: (projectId: string) => void;
}

const formatDate = (value: string): string =>
  new Intl.DateTimeFormat('it-IT', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  }).format(new Date(value));

const ProjectCard = ({ isOpening = false, project, onDelete, onExport, onOpen }: ProjectCardProps) => {
  const CoverIcon = project.sourceKind === 'codebase' ? FileArchive : project.sourceKind === 'learn-mode' ? BookCopy : FileText;
  const showSourceWarning = !project.hasSourceFile && project.sourceKind !== 'learn-mode';

  return (
    <article
      className="group flex items-center gap-3 rounded-xl border border-gray-300 bg-white px-3.5 py-3 transition-colors hover:border-gray-400 sm:gap-4 sm:rounded-2xl sm:px-4 sm:py-3.5 dark:border-white/10 dark:bg-paper-surface dark:hover:border-zinc-600"
    >
      {/* Icon */}
      <button
        type="button"
        onClick={() => onOpen(project.id)}
        disabled={isOpening}
        className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg bg-gray-100 text-gray-500 transition-colors hover:bg-gray-200 hover:text-gray-700 sm:h-10 sm:w-10 sm:rounded-xl dark:bg-paper-dark dark:text-zinc-300 dark:hover:bg-zinc-700/50"
        title="Apri progetto"
      >
        <CoverIcon className="h-4 w-4 sm:h-[1.125rem] sm:w-[1.125rem]" />
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
      <div className="flex flex-shrink-0 items-center gap-1">
        <button
          type="button"
          onClick={() => onExport(project.id)}
          className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-800 dark:text-zinc-500 dark:hover:bg-paper-dark dark:hover:text-zinc-200"
          title="Esporta"
        >
          <Download className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          onClick={() => onDelete(project.id)}
          className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-gray-400 transition-colors hover:bg-red-50 hover:text-red-700 dark:text-zinc-500 dark:hover:bg-red-950/40 dark:hover:text-red-400"
          title="Elimina"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>
    </article>
  );
};

export default ProjectCard;
