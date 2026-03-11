import { BookCopy, Download, FileArchive, FileText, Trash2 } from 'lucide-react';
import type { SavedProjectMeta } from '../types';

interface ProjectCardProps {
  project: SavedProjectMeta;
  onDelete: (projectId: string) => void;
  onExport: (projectId: string) => void;
  onOpen: (projectId: string) => void;
}

const projectTypeLabel: Record<SavedProjectMeta['sourceKind'], string> = {
  'codebase': 'Codice',
  'document': 'Documento',
  'imported-json': 'Importato',
  'learn-mode': 'AI native',
};

const formatDate = (value: string): string =>
  new Intl.DateTimeFormat('it-IT', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  }).format(new Date(value));

const ProjectCard = ({ project, onDelete, onExport, onOpen }: ProjectCardProps) => {
  const CoverIcon = project.sourceKind === 'codebase' ? FileArchive : project.sourceKind === 'learn-mode' ? BookCopy : FileText;

  return (
    <article className="group flex h-full flex-col justify-between rounded-[2rem] border border-gray-200/80 bg-white/95 p-6 shadow-[0_24px_80px_-36px_rgba(30,41,59,0.24)] transition-all duration-300 hover:-translate-y-1 hover:border-gray-300 dark:border-zinc-800 dark:bg-zinc-900/95 dark:hover:border-zinc-700">
      <div className="space-y-5">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-gray-400 dark:text-zinc-500">
              {projectTypeLabel[project.sourceKind]}
            </p>
            <h3 className="mt-3 line-clamp-2 text-2xl font-serif text-gray-900 dark:text-zinc-100">
              {project.title}
            </h3>
          </div>
          <div className="flex h-12 w-12 flex-shrink-0 items-center justify-center rounded-2xl bg-gray-100 text-gray-600 dark:bg-zinc-800 dark:text-zinc-300">
            <CoverIcon className="h-5 w-5" />
          </div>
        </div>

        <div className="space-y-3 text-sm text-gray-500 dark:text-zinc-400">
          <p className="truncate">{project.coverLabel}</p>
          <div className="flex items-center justify-between gap-4">
            <span>{project.lessonCount} lezioni</span>
            <span>{project.completedCount} completate</span>
          </div>
          <div className="flex items-center justify-between gap-4">
            <span>{project.hasSourceFile ? 'Sorgente presente' : 'Sorgente mancante'}</span>
            <span>Ultimo accesso {formatDate(project.lastOpenedAt)}</span>
          </div>
        </div>
      </div>

      <div className="mt-8 space-y-3">
        <button
          type="button"
          onClick={() => onOpen(project.id)}
          className="inline-flex w-full items-center justify-center rounded-full bg-gray-900 px-5 py-3 text-sm font-medium text-white transition-colors hover:bg-black dark:bg-white dark:text-black dark:hover:bg-gray-200"
        >
          Apri progetto
        </button>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => onExport(project.id)}
            className="inline-flex flex-1 items-center justify-center gap-2 rounded-full border border-gray-200 px-4 py-2.5 text-sm text-gray-600 transition-colors hover:border-gray-300 hover:text-gray-900 dark:border-zinc-700 dark:text-zinc-300 dark:hover:border-zinc-600 dark:hover:text-white"
          >
            <Download className="h-4 w-4" />
            Esporta
          </button>
          <button
            type="button"
            onClick={() => onDelete(project.id)}
            className="inline-flex flex-1 items-center justify-center gap-2 rounded-full border border-gray-200 px-4 py-2.5 text-sm text-gray-500 transition-colors hover:border-red-200 hover:bg-red-50 hover:text-red-700 dark:border-zinc-700 dark:text-zinc-400 dark:hover:border-red-900 dark:hover:bg-red-950/40 dark:hover:text-red-300"
          >
            <Trash2 className="h-4 w-4" />
            Elimina
          </button>
        </div>
      </div>
    </article>
  );
};

export default ProjectCard;
