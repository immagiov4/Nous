import {
  ChevronDown,
  ChevronRight,
  Folder,
  FolderOpen,
  FolderPlus,
  GripVertical,
  MoreVertical,
  Pencil,
  Plus,
  Trash2,
  X,
} from 'lucide-react';
import { type DragEvent, type FormEvent, useEffect, useMemo, useRef, useState } from 'react';

import type { LibraryFolderNode, LibraryTree, LibraryTreeNode } from '../../types.ts';
import { subscribeToMediaQuery } from '../../utils/dom/mediaQuery.ts';
import { flattenLibraryTreeNodes } from '../../utils/library/tree.ts';
import ProjectCard from './ProjectCard.tsx';

interface LibraryTreeViewProps {
  createRootTrigger?: number;
  openingProjectId: string | null;
  onCreateFolder: (args: { name: string; parentFolderId?: string | null }) => Promise<unknown>;
  onDeleteFolder: (folderId: string) => Promise<void>;
  onDeleteProject: (projectId: string) => void;
  onExportProject: (projectId: string) => void;
  onMoveFolder: (
    folderId: string,
    parentFolderId: string | null,
    targetIndex?: number
  ) => Promise<unknown>;
  onMoveProjects: (
    projectIds: string[],
    folderId: string | null,
    targetIndex?: number
  ) => Promise<unknown>;
  onOpenProject: (projectId: string) => void;
  onRenameFolder: (folderId: string, name: string) => Promise<unknown>;
  tree: LibraryTree;
}

interface DraggedLibraryItem {
  id: string;
  kind: 'folder' | 'project';
}

interface DropTarget {
  index: number;
  parentFolderId: string | null;
  position: 'after' | 'before' | 'inside';
  targetId: string;
  targetKind: 'folder' | 'project' | 'root';
}

type FlattenedFolderNode = LibraryFolderNode & { depth: number };

const ROOT_CREATE_KEY = '__root__';

const isFolderNode = (node: LibraryTreeNode): node is LibraryFolderNode => node.kind === 'folder';

const isFlattenedFolderNode = (
  node: LibraryTreeNode & { depth: number }
): node is FlattenedFolderNode => node.kind === 'folder';

const collectFolderDescendantIds = (folderNode: LibraryFolderNode): Set<string> => {
  const descendantIds = new Set<string>();

  const walk = (node: LibraryTreeNode) => {
    if (!isFolderNode(node)) {
      return;
    }

    descendantIds.add(node.id);
    node.children.forEach(walk);
  };

  folderNode.children.forEach(walk);
  return descendantIds;
};

const resolveDestinationFolders = (tree: LibraryTree) =>
  flattenLibraryTreeNodes(tree.rootNodes, { includeProjects: false }).filter(isFlattenedFolderNode);

const clampIndex = (value: number, maxValue: number) =>
  Math.max(0, Math.min(maxValue, Math.trunc(value)));

const resolveDropTargetFromTouchPoint = (x: number, y: number): DropTarget | null => {
  const el = (document.elementFromPoint(x, y) as Element | null)?.closest('[data-drag-id]');
  if (!el) return null;

  const targetId = el.getAttribute('data-drag-id');
  const targetKind = el.getAttribute('data-drag-kind') as 'folder' | 'project' | null;
  const parentFolderId = el.getAttribute('data-drag-parent-id') || null;
  const siblingIndex = parseInt(el.getAttribute('data-drag-sibling-index') ?? '0', 10);
  const siblingCount = parseInt(el.getAttribute('data-drag-sibling-count') ?? '1', 10);

  if (!targetId || !targetKind) return null;

  const rect = el.getBoundingClientRect();
  const relativeY = y - rect.top;

  if (targetKind === 'project') {
    const position = relativeY < rect.height / 2 ? 'before' : 'after';
    return {
      index:
        position === 'before'
          ? clampIndex(siblingIndex, siblingCount)
          : clampIndex(siblingIndex + 1, siblingCount),
      parentFolderId,
      position,
      targetId,
      targetKind: 'project',
    };
  }

  const upperThreshold = rect.height * 0.28;
  const lowerThreshold = rect.height * 0.72;

  if (relativeY <= upperThreshold) {
    return {
      index: clampIndex(siblingIndex, siblingCount),
      parentFolderId,
      position: 'before',
      targetId,
      targetKind: 'folder',
    };
  }
  if (relativeY >= lowerThreshold) {
    return {
      index: clampIndex(siblingIndex + 1, siblingCount),
      parentFolderId,
      position: 'after',
      targetId,
      targetKind: 'folder',
    };
  }

  const childrenCount = parseInt(el.getAttribute('data-drag-children-count') ?? '0', 10);
  return {
    index: childrenCount,
    parentFolderId: targetId,
    position: 'inside',
    targetId,
    targetKind: 'folder',
  };
};

export default function LibraryTreeView({
  createRootTrigger,
  openingProjectId,
  onCreateFolder,
  onDeleteFolder,
  onDeleteProject,
  onExportProject,
  onMoveFolder,
  onMoveProjects,
  onOpenProject,
  onRenameFolder,
  tree,
}: LibraryTreeViewProps) {
  const [createTargetId, setCreateTargetId] = useState<string | null>(null);
  const [editingFolderId, setEditingFolderId] = useState<string | null>(null);
  const [folderDraftName, setFolderDraftName] = useState('');
  const [expandedFolderIds, setExpandedFolderIds] = useState<Set<string>>(new Set());
  const [draggedItem, setDraggedItem] = useState<DraggedLibraryItem | null>(null);
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null);
  const [moveTarget, setMoveTarget] = useState<DraggedLibraryItem | null>(null);
  const [isMobileViewport, setIsMobileViewport] = useState(false);
  const [openFolderMenuId, setOpenFolderMenuId] = useState<string | null>(null);

  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) {
      return;
    }

    const mediaQuery = window.matchMedia('(max-width: 767px)');
    const updateViewport = () => {
      setIsMobileViewport(mediaQuery.matches);
    };

    updateViewport();
    return subscribeToMediaQuery(mediaQuery, updateViewport);
  }, []);

  useEffect(() => {
    setExpandedFolderIds(currentIds => {
      const nextIds = new Set(currentIds);
      Object.keys(tree.folderById).forEach(folderId => {
        if (!currentIds.has(folderId)) {
          nextIds.add(folderId);
        }
      });
      return nextIds;
    });
  }, [tree.folderById]);

  useEffect(() => {
    if (!createRootTrigger) return;
    setCreateTargetId(ROOT_CREATE_KEY);
    setEditingFolderId(null);
    setFolderDraftName('');
  }, [createRootTrigger]);

  const touchDragRef = useRef<{ itemId: string; itemKind: 'folder' | 'project' } | null>(null);
  const touchDropTargetRef = useRef<DropTarget | null>(null);
  const touchHoldTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const touchStartPointRef = useRef<{ x: number; y: number } | null>(null);
  const liveRef = useRef({
    draggedFolderDisabledIds: new Set<string>(),
    onMoveFolder,
    onMoveProjects,
  });

  const TOUCH_HOLD_MS = 300;
  const TOUCH_SLOP_PX = 8;

  const cancelTouchHold = () => {
    if (touchHoldTimerRef.current !== null) {
      clearTimeout(touchHoldTimerRef.current);
      touchHoldTimerRef.current = null;
    }
    touchDragRef.current = null;
    touchStartPointRef.current = null;
  };

  useEffect(() => {
    const handleTouchMove = (e: TouchEvent) => {
      const touch = e.touches[0];
      // If hold hasn't fired yet, check if the finger moved past the slop threshold
      if (!touchDragRef.current) {
        const start = touchStartPointRef.current;
        if (!start) return;
        const dx = touch.clientX - start.x;
        const dy = touch.clientY - start.y;
        if (Math.sqrt(dx * dx + dy * dy) > TOUCH_SLOP_PX) {
          // Moved too far before hold – cancel and let the browser scroll
          cancelTouchHold();
        }
        return;
      }
      e.preventDefault();
      setDraggedItem({ id: touchDragRef.current.itemId, kind: touchDragRef.current.itemKind });
      const resolved = resolveDropTargetFromTouchPoint(touch.clientX, touch.clientY);
      if (!resolved) {
        touchDropTargetRef.current = null;
        setDropTarget(null);
        return;
      }
      if (touchDragRef.current.itemKind === 'folder') {
        const disabledIds = liveRef.current.draggedFolderDisabledIds;
        const blocked =
          resolved.position === 'inside'
            ? disabledIds.has(resolved.targetId)
            : resolved.parentFolderId !== null && disabledIds.has(resolved.parentFolderId);
        if (blocked) {
          touchDropTargetRef.current = null;
          setDropTarget(null);
          return;
        }
      }
      touchDropTargetRef.current = resolved;
      setDropTarget(resolved);
    };

    const handleTouchEnd = () => {
      cancelTouchHold();
      const current = touchDragRef.current;
      const target = touchDropTargetRef.current;
      touchDragRef.current = null;
      touchDropTargetRef.current = null;
      setDraggedItem(null);
      setDropTarget(null);
      if (current && target) {
        const { onMoveFolder: moveFolder, onMoveProjects: moveProjects } = liveRef.current;
        if (current.itemKind === 'folder') {
          void moveFolder(current.itemId, target.parentFolderId ?? null, target.index);
        } else {
          void moveProjects([current.itemId], target.parentFolderId ?? null, target.index);
        }
      }
    };

    document.addEventListener('touchmove', handleTouchMove, { passive: false });
    document.addEventListener('touchend', handleTouchEnd);
    document.addEventListener('touchcancel', handleTouchEnd);
    return () => {
      document.removeEventListener('touchmove', handleTouchMove);
      document.removeEventListener('touchend', handleTouchEnd);
      document.removeEventListener('touchcancel', handleTouchEnd);
    };
  }, []);

  const destinationFolders = useMemo(() => resolveDestinationFolders(tree), [tree]);

  const submitFolderForm = async (
    event: FormEvent,
    args: { folderId?: string | null; mode: 'create' | 'rename' }
  ) => {
    event.preventDefault();
    const trimmedName = folderDraftName.trim();
    if (!trimmedName) {
      return;
    }

    if (args.mode === 'create') {
      await onCreateFolder({
        name: trimmedName,
        parentFolderId: args.folderId === ROOT_CREATE_KEY ? null : (args.folderId ?? null),
      });
      if (args.folderId && args.folderId !== ROOT_CREATE_KEY) {
        setExpandedFolderIds(currentIds => new Set(currentIds).add(args.folderId as string));
      }
      setCreateTargetId(null);
    } else if (args.folderId) {
      await onRenameFolder(args.folderId, trimmedName);
      setEditingFolderId(null);
    }

    setFolderDraftName('');
  };

  const cancelFolderEditing = () => {
    setCreateTargetId(null);
    setEditingFolderId(null);
    setFolderDraftName('');
  };

  const resolveDisabledFolderIds = (item: DraggedLibraryItem | null) => {
    if (item?.kind !== 'folder') {
      return new Set<string>();
    }

    const targetNode = destinationFolders.find(folderNode => folderNode.id === item.id);
    if (!targetNode) {
      return new Set<string>();
    }

    const disabledIds = collectFolderDescendantIds(targetNode);
    disabledIds.add(targetNode.id);
    return disabledIds;
  };

  const draggedFolderDisabledIds = useMemo(
    () => resolveDisabledFolderIds(draggedItem),
    [destinationFolders, draggedItem]
  );
  liveRef.current = { draggedFolderDisabledIds, onMoveFolder, onMoveProjects };

  const moveTargetDisabledFolderIds = useMemo(
    () => resolveDisabledFolderIds(moveTarget),
    [destinationFolders, moveTarget]
  );

  const handleMoveDroppedItem = async (
    destinationFolderId: string | null,
    item = draggedItem,
    targetIndex?: number
  ) => {
    if (!item) {
      return;
    }

    if (item.kind === 'folder') {
      await onMoveFolder(item.id, destinationFolderId, targetIndex);
    } else {
      await onMoveProjects([item.id], destinationFolderId, targetIndex);
    }

    setDraggedItem(null);
    setDropTarget(null);
    setMoveTarget(null);
  };

  const handleDrop = async (
    event: DragEvent<HTMLElement>,
    currentDropTarget: DropTarget | null
  ) => {
    event.preventDefault();
    event.stopPropagation();
    if (isMobileViewport) {
      return;
    }

    await handleMoveDroppedItem(
      currentDropTarget?.parentFolderId ?? null,
      draggedItem,
      currentDropTarget?.index
    );
  };

  const renderFolderForm = (folderId: string | null, mode: 'create' | 'rename') => (
    <form
      onSubmit={event => submitFolderForm(event, { folderId, mode })}
      className="mt-2 flex items-center gap-2 rounded-2xl border border-dashed border-gray-300 bg-white/85 px-3 py-2 dark:border-zinc-700/80 dark:bg-[#1b1614]"
    >
      <input
        ref={el => el?.focus()}
        type="text"
        value={folderDraftName}
        onChange={event => setFolderDraftName(event.target.value)}
        placeholder={mode === 'create' ? 'Nome cartella...' : 'Rinomina cartella...'}
        className="min-w-0 flex-1 bg-transparent text-sm text-gray-800 outline-none placeholder:text-gray-400 dark:text-zinc-100 dark:placeholder:text-zinc-500"
      />
      <button
        type="submit"
        className="rounded-full bg-stone-900 px-3 py-1.5 text-xs font-semibold text-white dark:bg-stone-100 dark:text-stone-900"
      >
        Salva
      </button>
      <button
        type="button"
        onClick={cancelFolderEditing}
        className="rounded-full px-2 py-1.5 text-xs font-semibold text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-800 dark:text-zinc-400 dark:hover:bg-zinc-700 dark:hover:text-zinc-100"
      >
        Annulla
      </button>
    </form>
  );

  const isDropTargetBlocked = (candidateTarget: DropTarget) => {
    if (draggedItem?.kind !== 'folder') {
      return false;
    }

    if (candidateTarget.position === 'inside') {
      return draggedFolderDisabledIds.has(candidateTarget.targetId);
    }

    return (
      candidateTarget.parentFolderId !== null &&
      draggedFolderDisabledIds.has(candidateTarget.parentFolderId)
    );
  };

  const resolveProjectDropTarget = ({
    event,
    node,
    parentFolderId,
    siblingIndex,
    siblingCount,
  }: {
    event: DragEvent<HTMLElement>;
    node: Extract<LibraryTreeNode, { kind: 'project' }>;
    parentFolderId: string | null;
    siblingIndex: number;
    siblingCount: number;
  }): DropTarget => {
    const rect = event.currentTarget.getBoundingClientRect();
    const relativeY = event.clientY - rect.top;
    const position = relativeY < rect.height / 2 ? 'before' : 'after';

    return {
      index:
        position === 'before'
          ? clampIndex(siblingIndex, siblingCount)
          : clampIndex(siblingIndex + 1, siblingCount),
      parentFolderId,
      position,
      targetId: node.id,
      targetKind: 'project',
    };
  };

  const resolveFolderDropTarget = ({
    event,
    node,
    parentFolderId,
    siblingIndex,
    siblingCount,
  }: {
    event: DragEvent<HTMLElement>;
    node: LibraryFolderNode;
    parentFolderId: string | null;
    siblingIndex: number;
    siblingCount: number;
  }): DropTarget => {
    const rect = event.currentTarget.getBoundingClientRect();
    const relativeY = event.clientY - rect.top;
    const upperThreshold = rect.height * 0.28;
    const lowerThreshold = rect.height * 0.72;

    if (relativeY <= upperThreshold) {
      return {
        index: clampIndex(siblingIndex, siblingCount),
        parentFolderId,
        position: 'before',
        targetId: node.id,
        targetKind: 'folder',
      };
    }

    if (relativeY >= lowerThreshold) {
      return {
        index: clampIndex(siblingIndex + 1, siblingCount),
        parentFolderId,
        position: 'after',
        targetId: node.id,
        targetKind: 'folder',
      };
    }

    return {
      index: node.children.length,
      parentFolderId: node.id,
      position: 'inside',
      targetId: node.id,
      targetKind: 'folder',
    };
  };

  const isDropBefore = (nodeId: string, kind: 'folder' | 'project') =>
    dropTarget?.targetId === nodeId &&
    dropTarget.targetKind === kind &&
    dropTarget.position === 'before';

  const isDropAfter = (nodeId: string, kind: 'folder' | 'project') =>
    dropTarget?.targetId === nodeId &&
    dropTarget.targetKind === kind &&
    dropTarget.position === 'after';

  const isDropInside = (nodeId: string) =>
    dropTarget?.targetId === nodeId &&
    dropTarget.targetKind === 'folder' &&
    dropTarget.position === 'inside';

  const DropLine = () => (
    <div className="pointer-events-none flex items-center gap-1.5">
      <div className="h-2 w-2 shrink-0 rounded-full bg-amber-500 dark:bg-amber-400" />
      <div className="h-0.5 flex-1 rounded-full bg-amber-500 dark:bg-amber-400" />
    </div>
  );

  const renderNode = (
    node: LibraryTreeNode,
    depth = 0,
    parentFolderId: string | null = null,
    siblingIndex = 0,
    siblingCount = 1
  ) => {
    const paddingLeft = depth * 28;

    if (!isFolderNode(node)) {
      return (
        <div
          key={node.id}
          data-drag-id={node.id}
          data-drag-kind="project"
          data-drag-parent-id={parentFolderId ?? ''}
          data-drag-sibling-index={siblingIndex}
          data-drag-sibling-count={siblingCount}
          draggable={!isMobileViewport}
          onDragStart={() => setDraggedItem({ id: node.id, kind: 'project' })}
          onDragEnd={() => {
            setDraggedItem(null);
            setDropTarget(null);
          }}
          onTouchStart={e => {
            e.stopPropagation();
            cancelTouchHold();
            touchStartPointRef.current = { x: e.touches[0].clientX, y: e.touches[0].clientY };
            touchDropTargetRef.current = null;
            touchHoldTimerRef.current = setTimeout(() => {
              touchHoldTimerRef.current = null;
              touchDragRef.current = { itemId: node.id, itemKind: 'project' };
            }, TOUCH_HOLD_MS);
          }}
          onDragOver={event => {
            if (isMobileViewport) {
              return;
            }

            const nextDropTarget = resolveProjectDropTarget({
              event,
              node,
              parentFolderId,
              siblingCount,
              siblingIndex,
            });
            if (isDropTargetBlocked(nextDropTarget)) {
              return;
            }

            event.preventDefault();
            event.stopPropagation();
            setDropTarget(nextDropTarget);
          }}
          onDrop={event => {
            const nextDropTarget = resolveProjectDropTarget({
              event,
              node,
              parentFolderId,
              siblingCount,
              siblingIndex,
            });
            if (isDropTargetBlocked(nextDropTarget)) {
              return;
            }

            void handleDrop(event, nextDropTarget);
          }}
          className={`relative mt-2 ${isDropBefore(node.id, 'project') || isDropAfter(node.id, 'project') ? 'z-10' : ''}`}
          style={{ paddingLeft }}
        >
          {isDropBefore(node.id, 'project') ? (
            <div className="absolute -top-px right-0 z-20" style={{ left: paddingLeft }}>
              <DropLine />
            </div>
          ) : null}
          <ProjectCard
            isOpening={openingProjectId === node.id}
            project={node.project}
            onDelete={onDeleteProject}
            onExport={onExportProject}
            onMove={projectId => setMoveTarget({ id: projectId, kind: 'project' })}
            onOpen={onOpenProject}
          />
          {isDropAfter(node.id, 'project') ? (
            <div className="absolute -bottom-px right-0 z-20" style={{ left: paddingLeft }}>
              <DropLine />
            </div>
          ) : null}
        </div>
      );
    }

    const isExpanded = expandedFolderIds.has(node.id);
    const isMoveTargetDisabled = moveTargetDisabledFolderIds.has(node.id);

    return (
      <div
        key={node.id}
        data-drag-id={node.id}
        data-drag-kind="folder"
        data-drag-parent-id={parentFolderId ?? ''}
        data-drag-sibling-index={siblingIndex}
        data-drag-sibling-count={siblingCount}
        data-drag-children-count={node.children.length}
        className={`relative mt-2 ${isDropBefore(node.id, 'folder') || isDropAfter(node.id, 'folder') ? 'z-10' : ''}`}
        style={{ paddingLeft }}
        onDragOver={event => {
          if (isMobileViewport) {
            return;
          }

          const nextDropTarget = resolveFolderDropTarget({
            event,
            node,
            parentFolderId,
            siblingCount,
            siblingIndex,
          });
          if (isDropTargetBlocked(nextDropTarget)) {
            return;
          }

          event.preventDefault();
          event.stopPropagation();
          setDropTarget(nextDropTarget);
        }}
        onDrop={event => {
          const nextDropTarget = resolveFolderDropTarget({
            event,
            node,
            parentFolderId,
            siblingCount,
            siblingIndex,
          });
          if (isDropTargetBlocked(nextDropTarget)) {
            return;
          }

          void handleDrop(event, nextDropTarget);
        }}
      >
        {isDropBefore(node.id, 'folder') ? (
          <div className="absolute -top-px right-0 z-20" style={{ left: paddingLeft }}>
            <DropLine />
          </div>
        ) : null}
        <div
          draggable={!isMobileViewport}
          onDragStart={() => setDraggedItem({ id: node.id, kind: 'folder' })}
          onDragEnd={() => {
            setDraggedItem(null);
            setDropTarget(null);
          }}
          onTouchStart={e => {
            e.stopPropagation();
            cancelTouchHold();
            touchStartPointRef.current = { x: e.touches[0].clientX, y: e.touches[0].clientY };
            touchDropTargetRef.current = null;
            touchHoldTimerRef.current = setTimeout(() => {
              touchHoldTimerRef.current = null;
              touchDragRef.current = { itemId: node.id, itemKind: 'folder' };
            }, TOUCH_HOLD_MS);
          }}
          className={`group flex items-center gap-2 rounded-2xl border px-3 py-3 transition-colors ${
            isMoveTargetDisabled
              ? 'border-gray-200 bg-gray-50/60 dark:border-zinc-700/80 dark:bg-[#161210]'
              : isDropInside(node.id)
                ? 'border-amber-400 bg-amber-50/40 dark:border-amber-400/60 dark:bg-amber-500/5'
                : 'border-gray-300 bg-white dark:border-zinc-700/80 dark:bg-[#1b1614]'
          }`}
        >
          <button
            type="button"
            onClick={() =>
              setExpandedFolderIds(currentIds => {
                const nextIds = new Set(currentIds);
                if (nextIds.has(node.id)) {
                  nextIds.delete(node.id);
                } else {
                  nextIds.add(node.id);
                }
                return nextIds;
              })
            }
            className="inline-flex h-8 w-8 items-center justify-center rounded-full text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-800 dark:text-zinc-400 dark:hover:bg-zinc-700 dark:hover:text-zinc-100"
            title={isExpanded ? 'Chiudi cartella' : 'Apri cartella'}
          >
            {isExpanded ? (
              <ChevronDown className="h-4 w-4" />
            ) : (
              <ChevronRight className="h-4 w-4" />
            )}
          </button>

          <div className="inline-flex h-10 w-10 items-center justify-center rounded-2xl bg-amber-100 text-amber-700 dark:bg-amber-500/10 dark:text-amber-200">
            {isExpanded ? <FolderOpen className="h-5 w-5" /> : <Folder className="h-5 w-5" />}
          </div>

          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <p className="truncate text-sm font-semibold text-gray-900 dark:text-zinc-100">
                {node.folder.name}
              </p>
              <span className="hidden sm:inline rounded-full border border-amber-200 bg-amber-50/80 px-2 py-0.5 text-[11px] font-medium text-amber-700 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200">
                {node.descendantProjectIds.length} corsi
              </span>
            </div>
          </div>

          <div className="relative z-50">
            <button
              type="button"
              onClick={e => {
                e.stopPropagation();
                setOpenFolderMenuId(openFolderMenuId === node.id ? null : node.id);
              }}
              className="inline-flex h-8 w-8 items-center justify-center rounded-full text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-800 dark:text-zinc-500 dark:hover:bg-zinc-700 dark:hover:text-zinc-100"
              title="Azioni cartella"
            >
              <MoreVertical className="h-4 w-4" />
            </button>
            {openFolderMenuId === node.id ? (
              <div className="absolute right-0 top-9 z-50 min-w-[11rem] overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-lg dark:border-zinc-700 dark:bg-zinc-800">
                <button
                  type="button"
                  onClick={() => {
                    setOpenFolderMenuId(null);
                    setCreateTargetId(node.id);
                    setEditingFolderId(null);
                    setFolderDraftName('');
                  }}
                  className="flex w-full items-center gap-2.5 px-4 py-2.5 text-sm text-gray-700 hover:bg-gray-50 dark:text-zinc-200 dark:hover:bg-zinc-700"
                >
                  <FolderPlus className="h-4 w-4 shrink-0" />
                  <span className="whitespace-nowrap">Nuova sottocartella</span>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setOpenFolderMenuId(null);
                    setEditingFolderId(node.id);
                    setCreateTargetId(null);
                    setFolderDraftName(node.folder.name);
                  }}
                  className="flex w-full items-center gap-2.5 px-4 py-2.5 text-sm text-gray-700 hover:bg-gray-50 dark:text-zinc-200 dark:hover:bg-zinc-700"
                >
                  <Pencil className="h-4 w-4 shrink-0" />
                  Rinomina
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setOpenFolderMenuId(null);
                    setMoveTarget({ id: node.id, kind: 'folder' });
                  }}
                  className="flex w-full items-center gap-2.5 px-4 py-2.5 text-sm text-gray-700 hover:bg-gray-50 dark:text-zinc-200 dark:hover:bg-zinc-700"
                >
                  <GripVertical className="h-4 w-4 shrink-0" />
                  Sposta
                </button>
                <div className="border-t border-gray-100 dark:border-zinc-700" />
                <button
                  type="button"
                  onClick={() => {
                    setOpenFolderMenuId(null);
                    const shouldDelete = window.confirm(
                      `Eliminare la cartella "${node.folder.name}"? I corsi e le sottocartelle verranno riportati al livello superiore.`
                    );
                    if (!shouldDelete) {
                      return;
                    }
                    void onDeleteFolder(node.id);
                  }}
                  className="flex w-full items-center gap-2.5 px-4 py-2.5 text-sm text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950/40"
                >
                  <Trash2 className="h-4 w-4 shrink-0" />
                  Elimina
                </button>
              </div>
            ) : null}
          </div>
        </div>

        {editingFolderId === node.id ? renderFolderForm(node.id, 'rename') : null}
        {createTargetId === node.id ? renderFolderForm(node.id, 'create') : null}

        {isExpanded
          ? node.children.map((childNode, childIndex, children) =>
              renderNode(childNode, depth + 1, node.id, childIndex, children.length)
            )
          : null}
        {isDropAfter(node.id, 'folder') ? (
          <div className="absolute -bottom-px right-0 z-20" style={{ left: paddingLeft }}>
            <DropLine />
          </div>
        ) : null}
      </div>
    );
  };

  return (
    <div>
      {openFolderMenuId ? (
        <div
          className="fixed inset-0 z-40"
          onClick={() => setOpenFolderMenuId(null)}
          onKeyDown={e => {
            if (e.key === 'Escape') setOpenFolderMenuId(null);
          }}
        />
      ) : null}

      {createTargetId === ROOT_CREATE_KEY ? renderFolderForm(ROOT_CREATE_KEY, 'create') : null}

      <div
        className={`space-y-3 rounded-[1.4rem] transition-colors ${
          dropTarget?.targetKind === 'root' ? 'bg-amber-50/50 dark:bg-amber-500/8' : ''
        }`}
        onDragOver={event => {
          if (isMobileViewport || !(event.target === event.currentTarget)) {
            return;
          }

          event.preventDefault();
          setDropTarget({
            index: tree.rootNodes.length,
            parentFolderId: null,
            position: 'after',
            targetId: 'root',
            targetKind: 'root',
          });
        }}
        onDrop={event => {
          if (isMobileViewport || !(event.target === event.currentTarget)) {
            return;
          }

          void handleDrop(event, {
            index: tree.rootNodes.length,
            parentFolderId: null,
            position: 'after',
            targetId: 'root',
            targetKind: 'root',
          });
        }}
      >
        {tree.rootNodes.length > 0 ? (
          tree.rootNodes.map((node, index, nodes) =>
            renderNode(
              node,
              0,
              node.kind === 'folder'
                ? node.folder.parentFolderId || null
                : (tree.placementByProjectId[node.id]?.folderId ?? null),
              index,
              nodes.length
            )
          )
        ) : (
          <div className="rounded-2xl border border-dashed border-gray-300 bg-gray-50/70 px-4 py-8 text-sm text-gray-500 dark:border-zinc-700/80 dark:bg-[#1b1614] dark:text-zinc-400">
            Nessun corso salvato da organizzare.
          </div>
        )}
      </div>

      {moveTarget ? (
        <div className="fixed inset-0 z-40 flex items-end bg-black/30 p-3 md:items-center md:justify-center">
          <div className="w-full max-w-lg rounded-[1.8rem] border border-gray-200 bg-white p-5 shadow-2xl dark:border-zinc-700 dark:bg-zinc-900">
            <div className="mb-4 flex items-center justify-between gap-3">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.18em] text-gray-400 dark:text-zinc-500">
                  Sposta elemento
                </p>
                <h4 className="mt-1 text-lg font-semibold text-gray-900 dark:text-zinc-100">
                  Scegli la destinazione
                </h4>
              </div>
              <button
                type="button"
                onClick={() => setMoveTarget(null)}
                className="inline-flex h-9 w-9 items-center justify-center rounded-full text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-800 dark:text-zinc-500 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="space-y-2">
              <button
                type="button"
                onClick={() => void handleMoveDroppedItem(null, moveTarget)}
                className="flex w-full items-center justify-between rounded-2xl border border-gray-200 px-4 py-3 text-left transition-colors hover:border-gray-300 hover:bg-gray-50 dark:border-zinc-700 dark:hover:border-zinc-600 dark:hover:bg-zinc-800"
              >
                <span className="font-medium text-gray-900 dark:text-zinc-100">
                  Radice libreria
                </span>
                <span className="text-xs text-gray-500 dark:text-zinc-400">Senza cartella</span>
              </button>

              {destinationFolders.map(folderNode => {
                const isDisabled =
                  moveTarget.kind === 'folder' && moveTargetDisabledFolderIds.has(folderNode.id);

                return (
                  <button
                    key={folderNode.id}
                    type="button"
                    disabled={isDisabled}
                    onClick={() => void handleMoveDroppedItem(folderNode.id, moveTarget)}
                    className="flex w-full items-center justify-between rounded-2xl border border-gray-200 px-4 py-3 text-left transition-colors hover:border-gray-300 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-45 dark:border-zinc-700 dark:hover:border-zinc-600 dark:hover:bg-zinc-800"
                    style={{ paddingLeft: 16 + folderNode.depth * 18 }}
                  >
                    <span className="font-medium text-gray-900 dark:text-zinc-100">
                      {folderNode.folder.name}
                    </span>
                    <span className="text-xs text-gray-500 dark:text-zinc-400">
                      {folderNode.descendantProjectIds.length} corsi
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
