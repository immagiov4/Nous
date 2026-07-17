import { AnimatePresence, motion, useIsPresent } from 'framer-motion';
import {
  ChevronDown,
  ChevronRight,
  Folder,
  FolderOpen,
  FolderPlus,
  GripVertical,
  MoreVertical,
  Pencil,
  Trash2,
  X,
} from 'lucide-react';
import {
  type DragEvent,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { LIBRARY_FOLDER_MENU_ESTIMATED_HEIGHT_PX } from '../../constants/layout.ts';
import { usePersistedLibraryFolderExpansion } from '../../hooks/library/usePersistedLibraryFolderExpansion.ts';
import { translateUiMessage as t } from '../../i18n/uiMessages.ts';
import type { LibraryFolderNode, LibraryTree, LibraryTreeNode } from '../../types.ts';
import { flattenLibraryTreeNodes } from '../../utils/library/tree.ts';
import { subscribeToMediaQuery } from '../../utils/mediaQuery.ts';
import { MotionPopover, Pressable } from '../../utils/motion/index.ts';
import ProjectCard from './ProjectCard.tsx';

interface LibraryTreeViewProps {
  createRootTrigger?: number;
  isExportingProject?: boolean;
  openingProjectId: string | null;
  onCreateFolder: (args: { name: string; parentFolderId?: string | null }) => Promise<unknown>;
  onConfirmDeleteFolder: (folderName: string) => Promise<boolean>;
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
  onRenameProject?: (projectId: string, title: string) => Promise<unknown>;
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

interface AnimatedFolderChildrenProps {
  children: ReactNode;
  folderId: string;
  folderName: string;
}

const DropLineIndicator = () => (
  <div className="pointer-events-none flex items-center gap-1.5">
    <div className="h-2 w-2 shrink-0 rounded-full bg-amber-500 dark:bg-amber-400" />
    <div className="h-0.5 flex-1 rounded-full bg-amber-500 dark:bg-amber-400" />
  </div>
);

const ROOT_CREATE_KEY = '__root__';
const FOLDER_COLLAPSE_DURATION_MS = 340;
const ACTION_STATUS_DISMISS_MS = 3_500;

const isFolderNode = (node: LibraryTreeNode): node is LibraryFolderNode => node.kind === 'folder';

const isFlattenedFolderNode = (
  node: LibraryTreeNode & { depth: number }
): node is FlattenedFolderNode => node.kind === 'folder';

const AnimatedFolderChildren = ({
  children,
  folderId,
  folderName,
}: AnimatedFolderChildrenProps) => {
  const isPresent = useIsPresent();

  return (
    <motion.div
      data-folder-children-id={folderId}
      data-folder-children-exiting={isPresent ? undefined : 'true'}
      aria-hidden={isPresent ? undefined : true}
      inert={isPresent ? undefined : true}
      initial={{ height: 0, opacity: 0 }}
      animate={{ height: 'auto', opacity: 1 }}
      exit={{ height: 0, opacity: 0 }}
      transition={{
        height: { duration: 0.34, ease: [0.32, 0.72, 0.2, 1] },
        opacity: { duration: 0.22, ease: [0.32, 0.72, 0.2, 1] },
      }}
      style={{ overflow: 'hidden', overflowAnchor: 'none', willChange: 'height, opacity' }}
    >
      <ul className="space-y-3" aria-label={t('Contenuto cartella {folderName}', { folderName })}>
        {children}
      </ul>
    </motion.div>
  );
};

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

const getVerticalScrollContainer = (element: HTMLElement | null): HTMLElement | Window => {
  if (typeof window === 'undefined' || !element) {
    return window;
  }

  let current: HTMLElement | null = element.parentElement;

  while (current) {
    const { overflowY } = window.getComputedStyle(current);
    const isScrollable =
      (overflowY === 'auto' || overflowY === 'scroll' || overflowY === 'overlay') &&
      current.scrollHeight > current.clientHeight + 1;

    if (isScrollable) {
      return current;
    }

    current = current.parentElement;
  }

  return window;
};

const getScrollOffsetTop = (scrollContainer: HTMLElement | Window) =>
  'scrollY' in scrollContainer ? scrollContainer.scrollY : scrollContainer.scrollTop;

const setScrollOffsetTop = (scrollContainer: HTMLElement | Window, nextY: number) => {
  if ('scrollY' in scrollContainer) {
    scrollContainer.scrollTo({ top: nextY, left: scrollContainer.scrollX, behavior: 'auto' });
    return;
  }

  scrollContainer.scrollTop = nextY;
};

const getScrollViewportTop = (scrollContainer: HTMLElement | Window): number =>
  'scrollY' in scrollContainer ? 0 : scrollContainer.getBoundingClientRect().top;

const resolveDropTargetFromTouchPoint = (x: number, y: number): DropTarget | null => {
  const el = (document.elementFromPoint(x, y) as Element | null)?.closest<HTMLElement>(
    '[data-drag-id]'
  );
  if (!el) return null;

  const targetId = el.dataset.dragId;
  const targetKind = el.dataset.dragKind as 'folder' | 'project' | undefined;
  const parentFolderId = el.dataset.dragParentId || null;
  const siblingIndex = parseInt(el.dataset.dragSiblingIndex ?? '0', 10);
  const siblingCount = parseInt(el.dataset.dragSiblingCount ?? '1', 10);

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

  const childrenCount = parseInt(el.dataset.dragChildrenCount ?? '0', 10);
  return {
    index: childrenCount,
    parentFolderId: targetId,
    position: 'inside',
    targetId,
    targetKind: 'folder',
  };
};

const getFolderRowClassName = ({
  isDropInside,
  isMoveTargetDisabled,
}: {
  isDropInside: boolean;
  isMoveTargetDisabled: boolean;
}): string => {
  const baseClassName =
    'group flex items-center gap-2 rounded-2xl border px-3 py-3 transition-colors';

  if (isMoveTargetDisabled) {
    return `${baseClassName} border-gray-200 bg-gray-50/60 dark:border-zinc-700/80 dark:bg-[#161210]`;
  }

  if (isDropInside) {
    return `${baseClassName} border-amber-400 bg-amber-50/40 dark:border-amber-400/60 dark:bg-amber-500/5`;
  }

  return `${baseClassName} border-gray-300 bg-white dark:border-zinc-700/80 dark:bg-[#1b1614]`;
};

export default function LibraryTreeView({
  createRootTrigger,
  isExportingProject = false,
  openingProjectId,
  onCreateFolder,
  onConfirmDeleteFolder,
  onDeleteFolder,
  onDeleteProject,
  onExportProject,
  onMoveFolder,
  onMoveProjects,
  onOpenProject,
  onRenameFolder,
  onRenameProject,
  tree,
}: LibraryTreeViewProps) {
  const [createTargetId, setCreateTargetId] = useState<string | null>(null);
  const [editingFolderId, setEditingFolderId] = useState<string | null>(null);
  const [folderDraftName, setFolderDraftName] = useState('');
  const { expandedFolderIds, setExpandedFolderIds, toggleFolderExpansion } =
    usePersistedLibraryFolderExpansion(tree);
  const [draggedItem, setDraggedItem] = useState<DraggedLibraryItem | null>(null);
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null);
  const [moveTarget, setMoveTarget] = useState<DraggedLibraryItem | null>(null);
  const [isMobileViewport, setIsMobileViewport] = useState(false);
  const [openFolderMenuId, setOpenFolderMenuId] = useState<string | null>(null);
  const [folderMenuPlacement, setFolderMenuPlacement] = useState<'below' | 'above'>('below');
  const [pendingAction, setPendingAction] = useState<'folder-save' | 'move' | null>(null);
  const [actionError, setActionError] = useState('');
  const [actionMessage, setActionMessage] = useState('');
  const collapseScrollFrameRef = useRef<number | null>(null);
  const folderMenuTriggerRef = useRef<HTMLButtonElement | null>(null);
  const moveDialogTitleRef = useRef<HTMLHeadingElement | null>(null);
  const movePendingRef = useRef(false);

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
    if (!createRootTrigger) {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      setCreateTargetId(ROOT_CREATE_KEY);
      setEditingFolderId(null);
      setFolderDraftName('');
    }, 0);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [createRootTrigger]);

  useEffect(() => {
    return () => {
      if (collapseScrollFrameRef.current !== null) {
        cancelAnimationFrame(collapseScrollFrameRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (!actionMessage) {
      return;
    }

    const timeoutId = window.setTimeout(() => setActionMessage(''), ACTION_STATUS_DISMISS_MS);
    return () => window.clearTimeout(timeoutId);
  }, [actionMessage]);

  useEffect(() => {
    if (moveTarget) {
      moveDialogTitleRef.current?.focus();
    }
  }, [moveTarget]);

  const touchDragRef = useRef<{ itemId: string; itemKind: 'folder' | 'project' } | null>(null);
  const touchDropTargetRef = useRef<DropTarget | null>(null);
  const touchHoldTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const touchStartPointRef = useRef<{ x: number; y: number } | null>(null);
  const liveRef = useRef({
    draggedFolderDisabledIds: new Set<string>(),
    moveItem: async (
      _destinationFolderId: string | null,
      _item: DraggedLibraryItem,
      _targetIndex?: number
    ) => {},
  });

  const TOUCH_HOLD_MS = 300;
  const TOUCH_SLOP_PX = 8;

  const cancelTouchHold = useCallback(() => {
    if (touchHoldTimerRef.current !== null) {
      clearTimeout(touchHoldTimerRef.current);
      touchHoldTimerRef.current = null;
    }
    touchDragRef.current = null;
    touchStartPointRef.current = null;
  }, []);

  const animateCollapseScrollCompensation = useCallback(
    (scrollContainer: HTMLElement | Window, startY: number, endY: number) => {
      if (typeof window === 'undefined' || endY >= startY) {
        return;
      }

      if (collapseScrollFrameRef.current !== null) {
        cancelAnimationFrame(collapseScrollFrameRef.current);
      }

      const easeOutCubic = (progress: number) => 1 - (1 - progress) ** 3;
      const startedAt = window.performance.now();

      const tick = (now: number) => {
        const progress = Math.min(1, (now - startedAt) / FOLDER_COLLAPSE_DURATION_MS);
        const eased = easeOutCubic(progress);
        const nextY = startY + (endY - startY) * eased;

        setScrollOffsetTop(scrollContainer, nextY);

        if (progress < 1) {
          collapseScrollFrameRef.current = window.requestAnimationFrame(tick);
          return;
        }

        collapseScrollFrameRef.current = null;
      };

      collapseScrollFrameRef.current = window.requestAnimationFrame(tick);
    },
    []
  );

  const handleFolderExpansionToggle = useCallback(
    (folderId: string, isExpanded: boolean) => {
      if (isExpanded && typeof window !== 'undefined') {
        const childrenContainer = document.querySelector<HTMLElement>(
          `[data-folder-children-id="${folderId}"]`
        );

        if (childrenContainer) {
          const collapseHeight = childrenContainer.getBoundingClientRect().height;
          const scrollContainer = getVerticalScrollContainer(childrenContainer);
          const hiddenAboveViewport = Math.max(
            0,
            getScrollViewportTop(scrollContainer) - childrenContainer.getBoundingClientRect().top
          );
          const compensatedHeight = Math.min(collapseHeight, hiddenAboveViewport);
          const startScrollY = getScrollOffsetTop(scrollContainer);
          const endScrollY = Math.max(0, startScrollY - compensatedHeight);

          if (startScrollY > endScrollY + 1) {
            animateCollapseScrollCompensation(scrollContainer, startScrollY, endScrollY);
          }
        }
      }

      toggleFolderExpansion(folderId);
    },
    [animateCollapseScrollCompensation, toggleFolderExpansion]
  );

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
      const current = touchDragRef.current;
      const target = touchDropTargetRef.current;
      cancelTouchHold();
      touchDragRef.current = null;
      touchDropTargetRef.current = null;
      setDraggedItem(null);
      setDropTarget(null);
      if (current && target) {
        void liveRef.current.moveItem(
          target.parentFolderId ?? null,
          { id: current.itemId, kind: current.itemKind },
          target.index
        );
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
  }, [cancelTouchHold]);

  const destinationFolders = useMemo(() => resolveDestinationFolders(tree), [tree]);

  const submitFolderForm = async (
    event: FormEvent,
    args: { folderId?: string | null; mode: 'create' | 'rename' }
  ) => {
    event.preventDefault();
    const trimmedName = folderDraftName.trim();
    if (!trimmedName || pendingAction === 'folder-save') {
      return;
    }
    if (
      args.mode === 'rename' &&
      args.folderId &&
      tree.folderById[args.folderId]?.name.trim() === trimmedName
    ) {
      setEditingFolderId(null);
      setFolderDraftName('');
      return;
    }

    setPendingAction('folder-save');
    setActionError('');
    setActionMessage('');
    try {
      if (args.mode === 'create') {
        await onCreateFolder({
          name: trimmedName,
          parentFolderId: args.folderId === ROOT_CREATE_KEY ? null : (args.folderId ?? null),
        });
        if (args.folderId && args.folderId !== ROOT_CREATE_KEY) {
          setExpandedFolderIds(currentIds => new Set(currentIds).add(args.folderId as string));
        }
        setCreateTargetId(null);
        setActionMessage(t('Cartella creata.'));
      } else if (args.folderId) {
        await onRenameFolder(args.folderId, trimmedName);
        setEditingFolderId(null);
        setActionMessage(t('Cartella rinominata.'));
      }

      setFolderDraftName('');
    } catch (error) {
      console.error('[Nous][Library] Folder save failed.', error);
      setActionError(t('Operazione non riuscita. Riprova.'));
    } finally {
      setPendingAction(null);
    }
  };

  const cancelFolderEditing = () => {
    setCreateTargetId(null);
    setEditingFolderId(null);
    setFolderDraftName('');
  };

  const handleFolderInputKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape' && pendingAction !== 'folder-save') {
      event.preventDefault();
      cancelFolderEditing();
    }
  };

  const startFolderRenaming = (folderId: string, name: string) => {
    setOpenFolderMenuId(null);
    setEditingFolderId(folderId);
    setCreateTargetId(null);
    setFolderDraftName(name);
  };

  const restoreFolderActionFocus = useCallback(() => {
    queueMicrotask(() => folderMenuTriggerRef.current?.focus());
  }, []);

  const closeFolderMenu = useCallback(() => {
    setOpenFolderMenuId(null);
    restoreFolderActionFocus();
  }, [restoreFolderActionFocus]);

  const closeMoveDialog = useCallback(() => {
    setMoveTarget(null);
    restoreFolderActionFocus();
  }, [restoreFolderActionFocus]);

  const handleMoveDroppedItem = useCallback(
    async (destinationFolderId: string | null, item = draggedItem, targetIndex?: number) => {
      if (!item || movePendingRef.current) {
        return;
      }

      movePendingRef.current = true;
      setPendingAction('move');
      setActionError('');
      setActionMessage('');
      try {
        if (item.kind === 'folder') {
          await onMoveFolder(item.id, destinationFolderId, targetIndex);
        } else {
          await onMoveProjects([item.id], destinationFolderId, targetIndex);
        }

        setDraggedItem(null);
        setDropTarget(null);
        setMoveTarget(null);
        setActionMessage(t('Elemento spostato.'));
        restoreFolderActionFocus();
      } catch (error) {
        console.error('[Nous][Library] Move failed.', error);
        setActionError(t('Operazione non riuscita. Riprova.'));
      } finally {
        movePendingRef.current = false;
        setPendingAction(null);
      }
    },
    [draggedItem, onMoveFolder, onMoveProjects, restoreFolderActionFocus]
  );

  useEffect(() => {
    if (!openFolderMenuId && !moveTarget) {
      return;
    }

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') {
        return;
      }

      event.preventDefault();
      if (moveTarget) {
        closeMoveDialog();
      } else {
        closeFolderMenu();
      }
    };

    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [closeFolderMenu, closeMoveDialog, moveTarget, openFolderMenuId]);

  const resolveDisabledFolderIds = useCallback(
    (item: DraggedLibraryItem | null) => {
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
    },
    [destinationFolders]
  );

  const draggedFolderDisabledIds = useMemo(
    () => resolveDisabledFolderIds(draggedItem),
    [draggedItem, resolveDisabledFolderIds]
  );

  useEffect(() => {
    liveRef.current = { draggedFolderDisabledIds, moveItem: handleMoveDroppedItem };
  }, [draggedFolderDisabledIds, handleMoveDroppedItem]);

  const moveTargetDisabledFolderIds = useMemo(
    () => resolveDisabledFolderIds(moveTarget),
    [moveTarget, resolveDisabledFolderIds]
  );

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
        onKeyDown={handleFolderInputKeyDown}
        placeholder={mode === 'create' ? t('Nome cartella...') : t('Rinomina cartella...')}
        className="min-w-0 flex-1 bg-transparent text-sm text-gray-800 outline-none placeholder:text-gray-400 dark:text-zinc-100 dark:placeholder:text-zinc-500"
      />
      <button
        type="submit"
        aria-busy={pendingAction === 'folder-save'}
        disabled={pendingAction === 'folder-save'}
        className="rounded-full bg-stone-900 px-3 py-1.5 text-xs font-semibold text-white disabled:cursor-wait disabled:opacity-60 dark:bg-stone-100 dark:text-stone-900"
      >
        {pendingAction === 'folder-save' ? t('Salvataggio in corso...') : t('Salva')}
      </button>
      <button
        type="button"
        onClick={cancelFolderEditing}
        className="rounded-full px-2 py-1.5 text-xs font-semibold text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-800 dark:text-zinc-400 dark:hover:bg-zinc-700 dark:hover:text-zinc-100"
      >
        {t('Annulla')}
      </button>
    </form>
  );

  const renderFolderInlineRenameForm = (folderId: string) => (
    <form
      onSubmit={event => submitFolderForm(event, { folderId, mode: 'rename' })}
      className="flex flex-1 items-center gap-2"
    >
      <input
        ref={el => el?.focus()}
        type="text"
        value={folderDraftName}
        onChange={event => setFolderDraftName(event.target.value)}
        onKeyDown={handleFolderInputKeyDown}
        placeholder={t('Rinomina cartella...')}
        className="min-w-0 flex-1 rounded-xl border border-gray-300 bg-white/90 px-3 py-2 text-sm text-gray-800 outline-none transition-colors focus:border-gray-400 dark:border-zinc-600 dark:bg-zinc-800 dark:text-zinc-100"
      />
      <button
        type="submit"
        aria-busy={pendingAction === 'folder-save'}
        disabled={pendingAction === 'folder-save'}
        className="rounded-full bg-stone-900 px-2.5 py-1.5 text-xs font-semibold text-white disabled:cursor-wait disabled:opacity-60 dark:bg-stone-100 dark:text-stone-900"
      >
        {pendingAction === 'folder-save' ? t('Salvataggio in corso...') : t('Salva')}
      </button>
      <button
        type="button"
        onClick={cancelFolderEditing}
        className="rounded-full px-2 py-1.5 text-xs font-semibold text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-800 dark:text-zinc-400 dark:hover:bg-zinc-700 dark:hover:text-zinc-100"
      >
        {t('Annulla')}
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

  const rootDropTarget: DropTarget = {
    index: tree.rootNodes.length,
    parentFolderId: null,
    position: 'after',
    targetId: 'root',
    targetKind: 'root',
  };

  const isRootDragSurface = (eventTarget: EventTarget | null) =>
    !(eventTarget as Element | null)?.closest('[data-drag-id]');

  const renderNode = (
    node: LibraryTreeNode,
    depth = 0,
    parentFolderId: string | null = null,
    siblingIndex = 0,
    siblingCount = 1
  ) => {
    const indentLeft = depth * 28;
    const paddingLeft = indentLeft + 12;
    const formOffsetStyle = indentLeft > 0 ? { marginLeft: indentLeft } : undefined;

    if (!isFolderNode(node)) {
      return (
        <li
          key={node.id}
          aria-label={t('Corso {projectTitle}', { projectTitle: node.project.title })}
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
              <DropLineIndicator />
            </div>
          ) : null}
          <ProjectCard
            isExporting={isExportingProject}
            isOpening={openingProjectId === node.id}
            project={node.project}
            onDelete={onDeleteProject}
            onExport={onExportProject}
            onMove={projectId => {
              folderMenuTriggerRef.current =
                document.activeElement instanceof HTMLButtonElement ? document.activeElement : null;
              setMoveTarget({ id: projectId, kind: 'project' });
            }}
            onOpen={onOpenProject}
            onRename={onRenameProject}
          />
          {isDropAfter(node.id, 'project') ? (
            <div className="absolute -bottom-px right-0 z-20" style={{ left: paddingLeft }}>
              <DropLineIndicator />
            </div>
          ) : null}
        </li>
      );
    }

    const isExpanded = expandedFolderIds.has(node.id);
    const isMoveTargetDisabled = moveTargetDisabledFolderIds.has(node.id);

    return (
      <li
        key={node.id}
        aria-label={t('Cartella {folderName}', { folderName: node.folder.name })}
        className={`relative mt-2 ${isDropBefore(node.id, 'folder') || isDropAfter(node.id, 'folder') ? 'z-10' : ''}`}
      >
        {isDropBefore(node.id, 'folder') ? (
          <div className="absolute -top-px right-0 z-20" style={{ left: paddingLeft }}>
            <DropLineIndicator />
          </div>
        ) : null}
        {/* biome-ignore lint/a11y/noStaticElementInteractions: folder rows need pointer drag/drop while nested controls keep button semantics. */}
        <div
          data-drag-id={node.id}
          data-drag-kind="folder"
          data-drag-parent-id={parentFolderId ?? ''}
          data-drag-sibling-index={siblingIndex}
          data-drag-sibling-count={siblingCount}
          data-drag-children-count={node.children.length}
          draggable={!isMobileViewport}
          className={getFolderRowClassName({
            isDropInside: isDropInside(node.id),
            isMoveTargetDisabled,
          })}
          style={{ paddingLeft }}
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
          <button
            type="button"
            onClick={() => handleFolderExpansionToggle(node.id, isExpanded)}
            aria-label={t(
              isExpanded ? 'Chiudi cartella {folderName}' : 'Apri cartella {folderName}',
              {
                folderName: node.folder.name,
              }
            )}
            className="inline-flex h-8 w-8 items-center justify-center rounded-full text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-800 dark:text-zinc-400 dark:hover:bg-zinc-700 dark:hover:text-zinc-100"
            title={isExpanded ? t('Chiudi cartella') : t('Apri cartella')}
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
            {editingFolderId === node.id ? (
              renderFolderInlineRenameForm(node.id)
            ) : (
              <div className="flex items-center gap-2">
                <p
                  onDoubleClick={event => {
                    event.stopPropagation();
                    startFolderRenaming(node.id, node.folder.name);
                  }}
                  className="truncate text-sm font-semibold text-gray-900 dark:text-zinc-100"
                >
                  {node.folder.name}
                </p>
                <span className="hidden sm:inline rounded-full border border-amber-200 bg-amber-50/80 px-2 py-0.5 text-[11px] font-medium text-amber-700 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200">
                  {node.descendantProjectIds.length} {t('corsi')}
                </span>
              </div>
            )}
          </div>

          <div className="relative z-50">
            <Pressable
              onClick={e => {
                e.stopPropagation();
                if (openFolderMenuId === node.id) {
                  closeFolderMenu();
                  return;
                }
                folderMenuTriggerRef.current = e.currentTarget;
                const rect = e.currentTarget.getBoundingClientRect();
                const estimatedMenuHeight = LIBRARY_FOLDER_MENU_ESTIMATED_HEIGHT_PX;
                const spaceBelow = window.innerHeight - rect.bottom;
                const spaceAbove = rect.top;
                const shouldFlipUp = spaceBelow < estimatedMenuHeight && spaceAbove > spaceBelow;
                setFolderMenuPlacement(shouldFlipUp ? 'above' : 'below');
                setOpenFolderMenuId(node.id);
              }}
              aria-label={t('Azioni cartella {folderName}', { folderName: node.folder.name })}
              className="inline-flex h-8 w-8 items-center justify-center rounded-full text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-800 dark:text-zinc-500 dark:hover:bg-zinc-700 dark:hover:text-zinc-100"
              title={t('Azioni cartella')}
            >
              <MoreVertical className="h-4 w-4" />
            </Pressable>
            <MotionPopover
              isOpen={openFolderMenuId === node.id}
              originX={folderMenuPlacement === 'above' ? 'bottom right' : 'top right'}
              className={`absolute right-0 z-50 min-w-[11rem] overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-lg dark:border-zinc-700 dark:bg-zinc-800 ${
                folderMenuPlacement === 'above' ? 'bottom-9' : 'top-9'
              }`}
            >
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
                <span className="whitespace-nowrap">{t('Nuova sottocartella')}</span>
              </button>
              <button
                type="button"
                onClick={() => {
                  startFolderRenaming(node.id, node.folder.name);
                }}
                className="flex w-full items-center gap-2.5 px-4 py-2.5 text-sm text-gray-700 hover:bg-gray-50 dark:text-zinc-200 dark:hover:bg-zinc-700"
              >
                <Pencil className="h-4 w-4 shrink-0" />
                {t('Rinomina')}
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
                {t('Sposta')}
              </button>
              <div className="border-t border-gray-100 dark:border-zinc-700" />
              <button
                type="button"
                onClick={() => {
                  setOpenFolderMenuId(null);
                  void (async () => {
                    const shouldDelete = await onConfirmDeleteFolder(node.folder.name);
                    if (!shouldDelete) {
                      return;
                    }
                    await onDeleteFolder(node.id);
                  })();
                }}
                className="flex w-full items-center gap-2.5 px-4 py-2.5 text-sm text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950/40"
              >
                <Trash2 className="h-4 w-4 shrink-0" />
                {t('Elimina')}
              </button>
            </MotionPopover>
          </div>
        </div>

        {createTargetId === node.id ? (
          <div style={formOffsetStyle}>{renderFolderForm(node.id, 'create')}</div>
        ) : null}

        <AnimatePresence initial={false}>
          {isExpanded && node.children.length > 0 ? (
            <AnimatedFolderChildren
              key={`folder-children-${node.id}`}
              folderId={node.id}
              folderName={node.folder.name}
            >
              {node.children.map((childNode, childIndex, children) =>
                renderNode(childNode, depth + 1, node.id, childIndex, children.length)
              )}
            </AnimatedFolderChildren>
          ) : null}
        </AnimatePresence>
        {isDropAfter(node.id, 'folder') ? (
          <div className="absolute -bottom-px right-0 z-20" style={{ left: paddingLeft }}>
            <DropLineIndicator />
          </div>
        ) : null}
      </li>
    );
  };

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: the tree container catches native drag/drop over empty library space; keyboard movement is handled by the explicit move dialog.
    <div
      onDragOver={event => {
        if (isMobileViewport || !draggedItem || !isRootDragSurface(event.target)) {
          return;
        }

        event.preventDefault();
        setDropTarget(rootDropTarget);
      }}
      onDrop={event => {
        if (isMobileViewport || !draggedItem || !isRootDragSurface(event.target)) {
          return;
        }

        void handleDrop(event, rootDropTarget);
      }}
    >
      {openFolderMenuId ? (
        <button
          type="button"
          aria-label={t('Chiudi menu cartella')}
          className="fixed inset-0 z-[55]"
          onClick={closeFolderMenu}
        />
      ) : null}

      {createTargetId === ROOT_CREATE_KEY ? renderFolderForm(ROOT_CREATE_KEY, 'create') : null}

      {actionMessage ? (
        <output className="mb-3 rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800 dark:border-emerald-900/70 dark:bg-emerald-950/50 dark:text-emerald-200">
          {actionMessage}
        </output>
      ) : null}
      {actionError && !moveTarget ? (
        <p
          role="alert"
          className="mb-3 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900/70 dark:bg-red-950/40 dark:text-red-200"
        >
          {actionError}
        </p>
      ) : null}

      <ul
        aria-label={t('Albero corsi')}
        className={`space-y-3 rounded-[1.4rem] transition-colors ${
          dropTarget?.targetKind === 'root' ? 'bg-amber-50/50 dark:bg-amber-500/8' : ''
        }`}
        onDragOver={event => {
          if (isMobileViewport || !(event.target === event.currentTarget)) {
            return;
          }

          event.preventDefault();
          setDropTarget(rootDropTarget);
        }}
        onDrop={event => {
          if (isMobileViewport || !(event.target === event.currentTarget)) {
            return;
          }

          void handleDrop(event, rootDropTarget);
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
          <li className="list-none rounded-2xl border border-dashed border-gray-300 bg-gray-50/70 px-4 py-8 text-sm text-gray-500 dark:border-zinc-700/80 dark:bg-[#1b1614] dark:text-zinc-400">
            {t('Nessun corso salvato da organizzare.')}
          </li>
        )}
        {draggedItem ? (
          <li
            aria-label={t('Sposta nella radice libreria')}
            className={`list-none rounded-2xl border border-dashed px-4 py-3 transition-colors ${
              dropTarget?.targetKind === 'root'
                ? 'border-amber-400 bg-amber-50/70 dark:border-amber-400/60 dark:bg-amber-500/10'
                : 'border-gray-300 bg-white/40 dark:border-zinc-700/80 dark:bg-[#1b1614]/50'
            }`}
            onDragOver={event => {
              if (isMobileViewport) {
                return;
              }

              event.preventDefault();
              event.stopPropagation();
              setDropTarget(rootDropTarget);
            }}
            onDrop={event => {
              void handleDrop(event, rootDropTarget);
            }}
          >
            {dropTarget?.targetKind === 'root' ? (
              <DropLineIndicator />
            ) : (
              <span className="block text-center text-xs font-medium text-gray-500 dark:text-zinc-400">
                {t('Radice libreria')}
              </span>
            )}
          </li>
        ) : null}
      </ul>

      {moveTarget ? (
        <div className="fixed inset-0 z-[55] flex items-end p-3 md:items-center md:justify-center">
          <button
            type="button"
            aria-label={t('Chiudi spostamento')}
            className="absolute inset-0 bg-black/30"
            onClick={closeMoveDialog}
          />
          <div
            role="dialog"
            aria-modal="true"
            aria-busy={pendingAction === 'move'}
            aria-labelledby="library-move-dialog-title"
            className="relative w-full max-w-lg rounded-[1.8rem] border border-gray-200 bg-white p-5 shadow-2xl dark:border-zinc-700 dark:bg-zinc-900"
          >
            <div className="mb-4 flex items-center justify-between gap-3">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.18em] text-gray-400 dark:text-zinc-500">
                  {t('Sposta elemento')}
                </p>
                <h4
                  ref={moveDialogTitleRef}
                  id="library-move-dialog-title"
                  tabIndex={-1}
                  className="mt-1 text-lg font-semibold text-gray-900 dark:text-zinc-100"
                >
                  {t('Scegli la destinazione')}
                </h4>
              </div>
              <button
                type="button"
                aria-label={t('Chiudi spostamento')}
                disabled={pendingAction === 'move'}
                onClick={closeMoveDialog}
                className="inline-flex h-9 w-9 items-center justify-center rounded-full text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-800 dark:text-zinc-500 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            {actionError ? (
              <p
                role="alert"
                className="mb-3 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900/70 dark:bg-red-950/40 dark:text-red-200"
              >
                {actionError}
              </p>
            ) : null}
            {pendingAction === 'move' ? (
              <output className="mb-3 text-sm text-gray-500 dark:text-zinc-400">
                {t('Spostamento in corso...')}
              </output>
            ) : null}

            <div className="space-y-2">
              <button
                type="button"
                disabled={pendingAction === 'move'}
                onClick={() => void handleMoveDroppedItem(null, moveTarget)}
                className="flex w-full items-center justify-between rounded-2xl border border-gray-200 px-4 py-3 text-left transition-colors hover:border-gray-300 hover:bg-gray-50 disabled:cursor-wait disabled:opacity-60 dark:border-zinc-700 dark:hover:border-zinc-600 dark:hover:bg-zinc-800"
              >
                <span className="font-medium text-gray-900 dark:text-zinc-100">
                  {t('Radice libreria')}
                </span>
                <span className="text-xs text-gray-500 dark:text-zinc-400">
                  {t('Senza cartella')}
                </span>
              </button>

              {destinationFolders.map(folderNode => {
                const isDisabled =
                  moveTarget.kind === 'folder' && moveTargetDisabledFolderIds.has(folderNode.id);

                return (
                  <button
                    key={folderNode.id}
                    type="button"
                    disabled={isDisabled || pendingAction === 'move'}
                    onClick={() => void handleMoveDroppedItem(folderNode.id, moveTarget)}
                    className="flex w-full items-center justify-between rounded-2xl border border-gray-200 px-4 py-3 text-left transition-colors hover:border-gray-300 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-45 dark:border-zinc-700 dark:hover:border-zinc-600 dark:hover:bg-zinc-800"
                    style={{ paddingLeft: 16 + folderNode.depth * 18 }}
                  >
                    <span className="font-medium text-gray-900 dark:text-zinc-100">
                      {folderNode.folder.name}
                    </span>
                    <span className="text-xs text-gray-500 dark:text-zinc-400">
                      {folderNode.descendantProjectIds.length} {t('corsi')}
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
