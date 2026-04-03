import { CheckCircle2, ChevronRight, Download, LibraryBig, Minus, SidebarClose, X } from 'lucide-react';
import type { WorkspaceReaderSidebarModel } from './types.ts';

const getSectionStatusLabel = ({
  hasGeneratedContent,
  isActive,
  isCompleted,
}: {
  hasGeneratedContent: boolean;
  isActive: boolean;
  isCompleted: boolean;
}) => {
  if (isCompleted) {
    return 'Lezione completata';
  }

  if (isActive) {
    return 'Lezione attiva';
  }

  if (hasGeneratedContent) {
    return 'Lezione gia generata';
  }

  return 'Lezione non ancora generata';
};

const renderSectionStatus = ({
  hasGeneratedContent,
  isActive,
  isCompleted,
}: {
  hasGeneratedContent: boolean;
  isActive: boolean;
  isCompleted: boolean;
}) => {
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

export default function WorkspaceReaderSidebar({
  activeSectionId,
  expandedModuleId,
  isLoading,
  isMobileViewport,
  learningPlanTitle,
  onBackToLibrary,
  onExportProject,
  onModuleToggle,
  onSelectSection,
  onSetFocusMode,
  onSetIsMobileSidebarOpen,
  shouldShowSidebar,
  sidebarGroups,
}: WorkspaceReaderSidebarModel) {
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
        className={`fixed inset-y-0 left-0 z-[70] flex h-screen flex-col border-r border-gray-200/80 bg-white transition-transform duration-300 dark:border-zinc-700/80 dark:bg-zinc-800 ${
          shouldShowSidebar ? 'translate-x-0' : '-translate-x-full'
        }`}
        style={{ width: isMobileViewport ? 'min(92vw, 24rem)' : 384 }}
      >
        <div className="flex flex-col gap-4 border-b border-gray-200/80 px-5 py-5 dark:border-zinc-700/80 sm:px-6">
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

        <div className="flex-1 overflow-y-auto px-4 py-5">
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
                    <span className="min-w-0 flex-1 truncate text-[11px] font-semibold uppercase tracking-[0.18em]">
                      {group.title}
                    </span>
                  </button>

                  {isExpanded ? (
                    <div className="mt-2 ml-5 space-y-1 border-l border-gray-200 pl-4 dark:border-zinc-700/80">
                      {group.sections.map(section => {
                        const isActive = activeSectionId === section.id;
                        const depth = group.sectionDepthById[section.id] ?? 0;
                        const hasGeneratedContent = Boolean(section.content?.trim());

                        return (
                          <button
                            type="button"
                            key={section.id}
                            onClick={() => onSelectSection(section)}
                            disabled={isLoading}
                            style={{ paddingLeft: `${depth * 0.9}rem` }}
                            className={`flex w-full items-center gap-3 py-2 text-left transition-colors ${
                              isActive
                                ? 'text-gray-900 dark:text-gray-100'
                                : 'text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200'
                            } ${isLoading ? 'cursor-not-allowed opacity-50' : ''}`}
                          >
                            <div
                              className="flex h-4 w-4 flex-shrink-0 items-center justify-center"
                              title={getSectionStatusLabel({
                                hasGeneratedContent,
                                isActive,
                                isCompleted: section.isCompleted,
                              })}
                            >
                              {renderSectionStatus({
                                hasGeneratedContent,
                                isActive,
                                isCompleted: section.isCompleted,
                              })}
                            </div>
                            <div className="min-w-0 flex-1">
                              <div
                                className={`truncate text-sm ${isActive ? 'font-medium' : 'font-normal'}`}
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
      </aside>
    </>
  );
}
