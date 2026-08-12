import { Check, ChevronDown, ChevronRight, FileUp, Folder, FolderOpen, X } from 'lucide-react';
import type { RefObject } from 'react';
import { useMemo } from 'react';
import { usePersistedLibraryFolderExpansion } from '../../hooks/library/usePersistedLibraryFolderExpansion.ts';
import { translateUiMessage as t } from '../../i18n/uiMessages.ts';
import type { LibraryContextRef, LibraryTree, LibraryTreeNode } from '../../types.ts';

type MenuAlign = 'start' | 'end';
type MenuVerticalPlacement = 'above' | 'below';

interface HomeChatLibraryContextPickerProps {
  readonly attachedContextRefs: LibraryContextRef[];
  readonly close: () => void;
  readonly isLibraryLoading: boolean;
  readonly isMobileViewport: boolean;
  readonly libraryTree: LibraryTree;
  readonly menuAlign: MenuAlign;
  readonly menuRef: RefObject<HTMLDivElement | null>;
  readonly menuVerticalPlacement: MenuVerticalPlacement;
  readonly onToggleContextRef: (reference: LibraryContextRef) => void;
  readonly onUploadSourceClick: () => void;
}

interface LibraryContextTreeNodeProps {
  readonly attachedContextRefs: LibraryContextRef[];
  readonly attachedProjectIds: ReadonlySet<string>;
  readonly depth?: number;
  readonly expandedFolderIds: ReadonlySet<string>;
  readonly node: LibraryTreeNode;
  readonly onToggleContextRef: (reference: LibraryContextRef) => void;
  readonly toggleFolderExpansion: (folderId: string) => void;
}

export const getAttachedContextProjectIds = (
  attachedContextRefs: LibraryContextRef[],
  libraryTree: LibraryTree
) => {
  const projectIds = new Set<string>();

  attachedContextRefs.forEach(reference => {
    if (reference.kind === 'project') {
      projectIds.add(reference.id);
      return;
    }

    libraryTree.descendantProjectIdsByFolderId[reference.id]?.forEach(projectId => {
      projectIds.add(projectId);
    });
  });

  return projectIds;
};

const LibraryContextTreeNode = ({
  attachedContextRefs,
  attachedProjectIds,
  depth = 0,
  expandedFolderIds,
  node,
  onToggleContextRef,
  toggleFolderExpansion,
}: LibraryContextTreeNodeProps) => {
  const paddingLeft = 12 + depth * 18;

  if (node.kind === 'project') {
    const isSelected = attachedProjectIds.has(node.id);
    return (
      <label
        className="flex cursor-pointer items-start gap-3 rounded-2xl px-3 py-2 transition-colors hover:bg-gray-100/80 dark:hover:bg-stone-700/70"
        style={{ paddingLeft }}
      >
        <span className="relative mt-0.5 h-5 w-5 shrink-0 rounded-md has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-orange-400">
          <input
            type="checkbox"
            checked={isSelected}
            aria-label={node.project.title}
            onChange={() =>
              onToggleContextRef({ id: node.id, kind: 'project', label: node.project.title })
            }
            className="absolute inset-0 z-10 h-full w-full cursor-pointer opacity-0 focus-visible:outline-none"
          />
          <span
            aria-hidden="true"
            className={`flex h-full w-full items-center justify-center rounded-md border transition-colors ${
              isSelected
                ? 'border-[#b45c28] bg-[#b45c28] text-white dark:border-[#e4a477] dark:bg-[#e4a477] dark:text-stone-950'
                : 'border-stone-300 bg-white text-transparent dark:border-zinc-500 dark:bg-stone-800'
            }`}
          >
            <Check className="h-3.5 w-3.5" strokeWidth={2.5} />
          </span>
        </span>
        <span className="min-w-0">
          <span className="block truncate text-sm font-medium text-gray-900 dark:text-zinc-100">
            {node.project.title}
          </span>
          <span className="mt-1 block text-xs leading-5 text-gray-500 dark:text-zinc-400">
            {t('{completed}/{total} lezioni completate', {
              completed: node.project.completedCount,
              total: node.project.lessonCount,
            })}
          </span>
        </span>
      </label>
    );
  }

  const isExpanded = expandedFolderIds.has(node.id);
  const isSelected =
    attachedContextRefs.some(
      reference => reference.id === node.id && reference.kind === 'folder'
    ) ||
    (node.descendantProjectIds.length > 0 &&
      node.descendantProjectIds.every(projectId => attachedProjectIds.has(projectId)));

  return (
    <div>
      <div
        className="flex items-start rounded-2xl transition-colors hover:bg-gray-100/80 dark:hover:bg-stone-700/70"
        style={{ paddingLeft }}
      >
        <span className="relative my-2 mr-2 h-5 w-5 shrink-0 rounded-md has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-orange-400">
          <input
            type="checkbox"
            checked={isSelected}
            aria-label={node.folder.name}
            onChange={() =>
              onToggleContextRef({ id: node.id, kind: 'folder', label: node.folder.name })
            }
            className="absolute inset-0 z-10 h-full w-full cursor-pointer opacity-0 focus-visible:outline-none"
          />
          <span
            aria-hidden="true"
            className={`flex h-full w-full items-center justify-center rounded-md border transition-colors ${
              isSelected
                ? 'border-[#b45c28] bg-[#b45c28] text-white dark:border-[#e4a477] dark:bg-[#e4a477] dark:text-stone-950'
                : 'border-stone-300 bg-white text-transparent dark:border-zinc-500 dark:bg-stone-800'
            }`}
          >
            <Check className="h-3.5 w-3.5" strokeWidth={2.5} />
          </span>
        </span>
        <button
          type="button"
          className="flex min-w-0 flex-1 items-start gap-3 py-2 pr-2 text-left"
          onClick={() => toggleFolderExpansion(node.id)}
        >
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-2 text-sm font-medium text-gray-900 dark:text-zinc-100">
              {isExpanded ? (
                <FolderOpen className="h-4 w-4 shrink-0 text-amber-600 dark:text-amber-300" />
              ) : (
                <Folder className="h-4 w-4 shrink-0 text-amber-600 dark:text-amber-300" />
              )}
              <span className="truncate">{node.folder.name}</span>
            </span>
            <span className="mt-1 block text-xs leading-5 text-gray-500 dark:text-zinc-400">
              {t('{count} corsi inclusi', { count: node.descendantProjectIds.length })}
            </span>
          </span>
          {isExpanded ? (
            <ChevronDown className="mt-1 h-4 w-4 shrink-0 text-gray-400 dark:text-zinc-500" />
          ) : (
            <ChevronRight className="mt-1 h-4 w-4 shrink-0 text-gray-400 dark:text-zinc-500" />
          )}
        </button>
      </div>
      {isExpanded
        ? node.children.map(childNode => (
            <LibraryContextTreeNode
              key={`${childNode.kind}-${childNode.id}`}
              attachedContextRefs={attachedContextRefs}
              attachedProjectIds={attachedProjectIds}
              depth={depth + 1}
              expandedFolderIds={expandedFolderIds}
              node={childNode}
              onToggleContextRef={onToggleContextRef}
              toggleFolderExpansion={toggleFolderExpansion}
            />
          ))
        : null}
    </div>
  );
};

const LibraryContextTree = ({
  attachedContextRefs,
  attachedProjectIds,
  expandedFolderIds,
  isLibraryLoading,
  libraryTree,
  onToggleContextRef,
  toggleFolderExpansion,
}: Omit<LibraryContextTreeNodeProps, 'depth' | 'node'> & {
  readonly isLibraryLoading: boolean;
  readonly libraryTree: LibraryTree;
}) => {
  let content: string;
  if (isLibraryLoading) {
    content = t('Caricamento libreria...');
  } else if (libraryTree.rootNodes.length === 0) {
    content = t('Nessun corso disponibile da allegare.');
  } else {
    return (
      <div className="custom-scrollbar max-h-[22rem] overflow-y-auto pr-2 max-md:mr-1 max-md:max-h-[52vh] max-md:pr-3">
        {libraryTree.rootNodes.map(node => (
          <LibraryContextTreeNode
            key={`${node.kind}-${node.id}`}
            attachedContextRefs={attachedContextRefs}
            attachedProjectIds={attachedProjectIds}
            expandedFolderIds={expandedFolderIds}
            node={node}
            onToggleContextRef={onToggleContextRef}
            toggleFolderExpansion={toggleFolderExpansion}
          />
        ))}
      </div>
    );
  }
  return (
    <div className="custom-scrollbar max-h-[22rem] overflow-y-auto pr-2 max-md:mr-1 max-md:max-h-[52vh] max-md:pr-3">
      <div className="px-3 py-6 text-sm text-gray-500 max-md:px-1 dark:text-zinc-400">
        {content}
      </div>
    </div>
  );
};

export default function HomeChatLibraryContextPicker({
  attachedContextRefs,
  close,
  isLibraryLoading,
  isMobileViewport,
  libraryTree,
  menuAlign,
  menuRef,
  menuVerticalPlacement,
  onToggleContextRef,
  onUploadSourceClick,
}: HomeChatLibraryContextPickerProps) {
  const { expandedFolderIds, toggleFolderExpansion } =
    usePersistedLibraryFolderExpansion(libraryTree);
  const attachedProjectIds = useMemo(
    () => getAttachedContextProjectIds(attachedContextRefs, libraryTree),
    [attachedContextRefs, libraryTree]
  );

  const uploadAction = (
    <button
      type="button"
      onClick={() => {
        close();
        onUploadSourceClick();
      }}
      className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition-colors hover:bg-orange-50 active:bg-orange-100 dark:hover:bg-orange-500/10 dark:active:bg-orange-500/15"
    >
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-orange-100 text-orange-700 dark:bg-orange-500/15 dark:text-orange-200">
        <FileUp className="h-4 w-4" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium text-gray-900 dark:text-zinc-100">
          {t('Allega file per un nuovo corso')}
        </span>
        <span className="block text-xs text-gray-500 dark:text-zinc-400">
          {t('Allega un file sorgente (PDF, ZIP, testo)')}
        </span>
      </span>
      <ChevronRight className="h-4 w-4 shrink-0 text-gray-400 dark:text-zinc-500" />
    </button>
  );

  const tree = (
    <LibraryContextTree
      attachedContextRefs={attachedContextRefs}
      attachedProjectIds={attachedProjectIds}
      expandedFolderIds={expandedFolderIds}
      isLibraryLoading={isLibraryLoading}
      libraryTree={libraryTree}
      onToggleContextRef={onToggleContextRef}
      toggleFolderExpansion={toggleFolderExpansion}
    />
  );

  if (isMobileViewport) {
    return (
      <dialog
        open
        aria-modal="true"
        className="fixed inset-0 z-[55] m-0 flex h-full max-h-none w-full max-w-none items-end border-0 bg-black/30 p-3 md:hidden"
      >
        <button
          type="button"
          className="absolute inset-0"
          aria-label={t('Chiudi selettore contesto')}
          onClick={close}
        />
        <div className="relative z-10 w-full rounded-[1.8rem] border border-gray-200 bg-white p-5 shadow-2xl dark:border-zinc-700 dark:bg-zinc-900">
          <div className="mb-4 flex items-center justify-between gap-3">
            <div>
              <p className="text-[0.7rem] font-semibold uppercase tracking-[0.18em] text-gray-400 dark:text-zinc-500">
                {t('Allega contesto')}
              </p>
              <h4 className="mt-1 text-lg font-semibold text-gray-900 dark:text-zinc-100">
                {t('Contesto libreria')}
              </h4>
            </div>
            <button
              type="button"
              onClick={close}
              className="inline-flex h-9 w-9 items-center justify-center rounded-full text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-800 dark:text-zinc-500 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
          <div className="mb-4 rounded-2xl border border-orange-200 bg-orange-50/70 p-1 dark:border-orange-500/25 dark:bg-orange-500/10">
            {uploadAction}
          </div>
          {tree}
        </div>
      </dialog>
    );
  }

  return (
    <div
      ref={menuRef}
      className={`absolute z-30 hidden w-[22rem] overflow-hidden rounded-[1.4rem] border border-gray-200 bg-white/95 shadow-[0_28px_80px_-40px_rgba(24,24,27,0.42)] backdrop-blur md:block dark:border-zinc-600 dark:bg-stone-800/95 ${
        menuVerticalPlacement === 'above'
          ? 'bottom-[calc(100%+0.75rem)]'
          : 'top-[calc(100%+0.75rem)]'
      } ${menuAlign === 'end' ? 'right-0' : 'left-0'}`}
      role="menu"
    >
      <div className="flex items-center justify-between gap-3 border-b border-gray-100 px-4 py-3 dark:border-zinc-700/70">
        <div>
          <p className="text-sm font-semibold text-gray-900 dark:text-zinc-100">
            {t('Contesto libreria')}
          </p>
          <p className="text-xs text-gray-500 dark:text-zinc-400">
            {t('Seleziona cartelle e corsi da allegare.')}
          </p>
        </div>
        <button
          type="button"
          onClick={close}
          className="inline-flex h-8 w-8 items-center justify-center rounded-full text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-800 dark:text-zinc-500 dark:hover:bg-zinc-700 dark:hover:text-zinc-100"
          title={t('Chiudi selettore contesto')}
        >
          <X className="h-4 w-4" />
        </button>
      </div>
      <div className="border-b border-gray-100 p-2 dark:border-zinc-700/70">{uploadAction}</div>
      <div className="p-2 pr-1.5">{tree}</div>
    </div>
  );
}
