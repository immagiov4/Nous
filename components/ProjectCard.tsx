import { BookCopy, Clock3, Download, FileArchive, FileText, TriangleAlert, Trash2 } from 'lucide-react';
import type { SavedProjectMeta } from '../types';

interface ProjectCardProps {
  isOpening?: boolean;
  project: SavedProjectMeta;
  onDelete: (projectId: string) => void;
  onExport: (projectId: string) => void;
  onOpen: (projectId: string) => void;
}

const projectTypeLabel: Record<SavedProjectMeta['sourceKind'], string> = {
  'codebase': 'Codice',
  'document': 'Documento',
  'imported-json': 'Importato',
  'learn-mode': 'Percorso AI',
};

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
    <article className="group flex h-full flex-col justify-between rounded-[1.35rem] border border-gray-300/70 bg-white/95 p-4 transition-all duration-200 hover:border-gray-400 sm:rounded-[1.5rem] sm:p-5 sm:hover:-translate-y-1 dark:border-white/10 dark:bg-zinc-900/95 dark:hover:border-zinc-700">
      <div className="space-y-4 sm:space-y-5">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0 space-y-2.5 sm:space-y-3">
            <div className="flex flex-wrap items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.16em] sm:gap-2 sm:text-[11px] sm:tracking-[0.18em]">
              <span className="rounded-full border border-gray-200 bg-gray-50 px-2 py-1 text-gray-600 sm:px-2.5 dark:border-zinc-600/80 dark:bg-zinc-800 dark:text-zinc-300">
                {projectTypeLabel[project.sourceKind]}
              </span>
              <span
                className={`rounded-full border px-2 py-1 sm:px-2.5 ${
                  project.sourceKind === 'learn-mode'
                    ? 'border-orange-200 bg-orange-50 text-orange-700 dark:border-orange-900/60 dark:bg-orange-950/20 dark:text-orange-300'
                    : project.hasSourceFile
                    ? 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900/60 dark:bg-emerald-950/30 dark:text-emerald-300'
                    : 'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-300'
                }`}
              >
                {project.sourceKind === 'learn-mode' ? 'Senza fonte' : project.hasSourceFile ? 'Fonte collegata' : 'Fonte mancante'}
              </span>
            </div>

            <div>
              <h3 className="line-clamp-2 text-[1.35rem] leading-tight font-serif text-gray-900 sm:text-2xl dark:text-zinc-100">
                {project.title}
              </h3>
              <p className="mt-1.5 truncate text-[13px] leading-5 text-gray-600 sm:mt-2 sm:text-sm sm:leading-6 dark:text-zinc-400" title={project.coverLabel}>
                {project.coverLabel}
              </p>
            </div>
          </div>

          <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-xl bg-gray-100 text-gray-700 sm:h-11 sm:w-11 sm:rounded-2xl dark:bg-zinc-800 dark:text-zinc-300">
            <CoverIcon className="h-[1.125rem] w-[1.125rem] sm:h-5 sm:w-5" />
          </div>
        </div>

        <dl className="grid grid-cols-2 gap-2.5 sm:gap-3">
          <div className="rounded-xl border border-gray-200/80 bg-gray-50/80 p-2.5 sm:rounded-2xl sm:p-3 dark:border-zinc-700/80 dark:bg-zinc-950/70">
            <dt className="text-[10px] font-semibold uppercase tracking-[0.16em] text-gray-500 sm:text-[11px] sm:tracking-[0.18em] dark:text-zinc-500">
              Lezioni
            </dt>
            <dd className="mt-1.5 text-xl font-serif text-gray-900 sm:mt-2 sm:text-2xl dark:text-zinc-100">
              {project.lessonCount}
            </dd>
          </div>
          <div className="rounded-xl border border-gray-200/80 bg-gray-50/80 p-2.5 sm:rounded-2xl sm:p-3 dark:border-zinc-700/80 dark:bg-zinc-950/70">
            <dt className="text-[10px] font-semibold uppercase tracking-[0.16em] text-gray-500 sm:text-[11px] sm:tracking-[0.18em] dark:text-zinc-500">
              Completate
            </dt>
            <dd className="mt-1.5 text-xl font-serif text-gray-900 sm:mt-2 sm:text-2xl dark:text-zinc-100">
              {project.completedCount}
            </dd>
          </div>
        </dl>

        <div className="border-t border-gray-200/80 pt-3 text-[13px] text-gray-600 sm:pt-4 sm:text-sm dark:border-zinc-700/80 dark:text-zinc-400">
          <div className="flex items-center gap-2">
            <Clock3 className="h-4 w-4" />
            <span>Ultimo accesso {formatDate(project.lastOpenedAt)}</span>
          </div>

          {showSourceWarning ? (
            <div className="mt-2.5 flex items-start gap-2 rounded-xl border border-amber-200/70 bg-amber-50/70 px-3 py-2 text-[12px] leading-5 text-amber-800 sm:mt-3 sm:rounded-2xl sm:text-sm dark:border-amber-800/40 dark:bg-amber-950/20 dark:text-amber-300">
              <TriangleAlert className="mt-0.5 h-4 w-4 flex-shrink-0" />
              <span>Ricollega la fonte se vuoi generare nuove lezioni partendo dal materiale originale.</span>
            </div>
          ) : null}
        </div>
      </div>

      <div className="mt-5 space-y-2.5 sm:mt-8 sm:space-y-3">
        <button
          type="button"
          onClick={() => onOpen(project.id)}
          disabled={isOpening}
          className={`inline-flex w-full items-center justify-center rounded-full px-4 py-2.5 text-sm font-medium transition-colors sm:px-5 sm:py-3 ${
            isOpening
              ? 'cursor-wait bg-gray-300 text-gray-600 dark:bg-zinc-700 dark:text-zinc-300'
              : 'bg-gray-900 text-white hover:bg-black dark:bg-white dark:text-black dark:hover:bg-gray-200'
          }`}
        >
          {isOpening ? 'Apertura...' : 'Apri progetto'}
        </button>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => onExport(project.id)}
            className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-full border border-gray-300 bg-white px-3 py-2.5 text-[13px] text-gray-600 transition-colors hover:border-gray-400 hover:text-gray-900 sm:gap-2 sm:px-4 sm:text-sm dark:border-zinc-500/80 dark:bg-zinc-800 dark:text-zinc-300 dark:hover:border-zinc-400 dark:hover:text-white"
          >
            <Download className="h-4 w-4" />
            Esporta
          </button>
          <button
            type="button"
            onClick={() => onDelete(project.id)}
            className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-full border border-gray-300 bg-white px-3 py-2.5 text-[13px] text-gray-500 transition-colors hover:border-red-300 hover:bg-red-50 hover:text-red-700 sm:gap-2 sm:px-4 sm:text-sm dark:border-zinc-500/80 dark:bg-zinc-800 dark:text-zinc-400 dark:hover:border-red-900 dark:hover:bg-red-950/40 dark:hover:text-red-300"
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
