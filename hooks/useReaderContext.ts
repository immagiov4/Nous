import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from 'react';
import type { ContextMenuPlacement, ContextMenuState } from '../types.ts';
import {
  CONTEXT_ANSWER_DEFAULT_SIZE,
  clampContextAnswerPanelSize,
  type ContextAnswerSize,
} from '../utils/readerChrome.ts';
import {
  createClosedContextMenuState,
  resolveContextMenuSelection,
  resolveMobileContextMenuSyncAction,
} from '../utils/contextMenuSelection';

const CONTEXT_MENU_MOBILE_DEBOUNCE_MS = 160;

interface ContextAnswerState {
  q: string;
  a: string;
}

interface ContextAnswerResizeState {
  pointerId: number;
  startX: number;
  startY: number;
  startWidth: number;
  startHeight: number;
}

interface UseReaderContextArgs {
  activeSectionId: string | null;
  contentRef: RefObject<HTMLDivElement | null>;
  isMobileViewport: boolean;
}

export const useReaderContext = ({
  activeSectionId,
  contentRef,
  isMobileViewport,
}: UseReaderContextArgs) => {
  const [contextMenu, setContextMenu] = useState<ContextMenuState>(createClosedContextMenuState);
  const [contextAnswer, setContextAnswer] = useState<ContextAnswerState | null>(null);
  const [contextAnswerSize, setContextAnswerSize] = useState<ContextAnswerSize>(
    CONTEXT_ANSWER_DEFAULT_SIZE
  );

  const contextMenuRef = useRef<HTMLDivElement>(null);
  const contextAnswerPanelRef = useRef<HTMLDivElement>(null);
  const contextAnswerResizePreviewRef = useRef<HTMLDivElement>(null);
  const selectionMenuTimeoutRef = useRef<number | null>(null);
  const contextAnswerResizeRef = useRef<ContextAnswerResizeState | null>(null);
  const contextAnswerDraftSizeRef = useRef<ContextAnswerSize>(CONTEXT_ANSWER_DEFAULT_SIZE);

  const clearSelectionMenuTimeout = useCallback(() => {
    if (selectionMenuTimeoutRef.current === null) {
      return;
    }

    window.clearTimeout(selectionMenuTimeoutRef.current);
    selectionMenuTimeoutRef.current = null;
  }, []);

  const resetContextAnswerResizeStyles = useCallback(() => {
    document.body.style.removeProperty('user-select');
    document.body.style.removeProperty('cursor');
  }, []);

  const clampContextAnswerSize = useCallback((size: ContextAnswerSize): ContextAnswerSize => {
    if (typeof window === 'undefined') {
      return clampContextAnswerPanelSize(size, {
        width: CONTEXT_ANSWER_DEFAULT_SIZE.width + 32,
        height: CONTEXT_ANSWER_DEFAULT_SIZE.height + 32,
      });
    }

    return clampContextAnswerPanelSize(size, {
      width: window.innerWidth,
      height: window.innerHeight,
    });
  }, []);

  const applyContextAnswerPanelSize = useCallback(
    (size: ContextAnswerSize) => {
      contextAnswerDraftSizeRef.current = size;

      if (!contextAnswerPanelRef.current) {
        return;
      }

      if (isMobileViewport) {
        contextAnswerPanelRef.current.style.removeProperty('width');
        contextAnswerPanelRef.current.style.removeProperty('height');
        contextAnswerPanelRef.current.style.removeProperty('will-change');
        contextAnswerPanelRef.current.style.removeProperty('contain');
        contextAnswerPanelRef.current.style.removeProperty('transform');
        contextAnswerPanelRef.current.style.removeProperty('backface-visibility');
        contextAnswerPanelRef.current.style.removeProperty('animation');
        return;
      }

      contextAnswerPanelRef.current.style.willChange = 'width, height';
      contextAnswerPanelRef.current.style.width = `${size.width}px`;
      contextAnswerPanelRef.current.style.height = `${size.height}px`;
    },
    [isMobileViewport]
  );

  const applyContextAnswerResizePreview = useCallback(
    (size: ContextAnswerSize | null) => {
      if (!contextAnswerResizePreviewRef.current) {
        return;
      }

      if (isMobileViewport || !size) {
        contextAnswerResizePreviewRef.current.style.display = 'none';
        contextAnswerResizePreviewRef.current.style.removeProperty('width');
        contextAnswerResizePreviewRef.current.style.removeProperty('height');
        return;
      }

      contextAnswerResizePreviewRef.current.style.display = 'block';
      contextAnswerResizePreviewRef.current.style.width = `${size.width}px`;
      contextAnswerResizePreviewRef.current.style.height = `${size.height}px`;
    },
    [isMobileViewport]
  );

  const closeContextMenu = useCallback(() => {
    setContextMenu(currentMenu => {
      if (!currentMenu.visible) {
        return currentMenu;
      }

      return createClosedContextMenuState();
    });
  }, []);

  const closeContextAnswer = useCallback(() => {
    setContextAnswer(null);
  }, []);

  const openContextAnswer = useCallback((question: string, answer: string) => {
    setContextAnswer({ q: question, a: answer });
  }, []);

  const openContextMenuFromSelection = useCallback(
    (
      selection: Selection,
      placement: ContextMenuPlacement,
      fallbackAnchorX?: number,
      fallbackAnchorY?: number
    ) => {
      if (!contentRef.current) {
        return false;
      }

      const nextMenu = resolveContextMenuSelection({
        container: contentRef.current,
        fallbackAnchorX,
        fallbackAnchorY,
        placement,
        selection,
      });

      if (!nextMenu) {
        return false;
      }

      setContextMenu(currentMenu => {
        if (
          currentMenu.visible &&
          currentMenu.placement === nextMenu.placement &&
          currentMenu.selectedText === nextMenu.selectedText &&
          currentMenu.contextBefore === nextMenu.contextBefore &&
          currentMenu.contextAfter === nextMenu.contextAfter
        ) {
          return currentMenu;
        }

        return nextMenu;
      });

      return true;
    },
    [contentRef]
  );

  const handleContentContextMenu = useCallback(
    (event: ReactMouseEvent<HTMLElement>) => {
      if (isMobileViewport) {
        return;
      }

      const selection = window.getSelection();
      if (!selection) {
        return;
      }

      const didOpen = openContextMenuFromSelection(
        selection,
        'desktop-floating',
        event.clientX,
        event.clientY
      );

      if (didOpen) {
        event.preventDefault();
      }
    },
    [isMobileViewport, openContextMenuFromSelection]
  );

  const handleContextAnswerResizeStart = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>) => {
      event.preventDefault();
      event.stopPropagation();
      event.currentTarget.setPointerCapture(event.pointerId);

      contextAnswerResizeRef.current = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        startWidth: contextAnswerDraftSizeRef.current.width,
        startHeight: contextAnswerDraftSizeRef.current.height,
      };

      if (contextAnswerPanelRef.current) {
        contextAnswerPanelRef.current.style.animation = 'none';
        contextAnswerPanelRef.current.style.opacity = '0.78';
      }
      applyContextAnswerResizePreview(contextAnswerDraftSizeRef.current);

      document.body.style.setProperty('user-select', 'none');
      document.body.style.setProperty('cursor', 'nwse-resize');
    },
    [applyContextAnswerResizePreview]
  );

  const handleContextAnswerResizeMove = useCallback(
    (event: PointerEvent) => {
      const resizeState = contextAnswerResizeRef.current;
      if (!resizeState || event.pointerId !== resizeState.pointerId) {
        return;
      }

      const nextSize = clampContextAnswerSize({
        width: resizeState.startWidth + (resizeState.startX - event.clientX),
        height: resizeState.startHeight + (event.clientY - resizeState.startY),
      });

      contextAnswerDraftSizeRef.current = nextSize;
      applyContextAnswerResizePreview(nextSize);
    },
    [applyContextAnswerResizePreview, clampContextAnswerSize]
  );

  const handleContextAnswerResizeEnd = useCallback((event?: PointerEvent) => {
    const resizeState = contextAnswerResizeRef.current;
    if (!resizeState || (event && event.pointerId !== resizeState.pointerId)) {
      return;
    }

    contextAnswerResizeRef.current = null;
    const nextSize = clampContextAnswerSize(contextAnswerDraftSizeRef.current);
    applyContextAnswerPanelSize(nextSize);
    applyContextAnswerResizePreview(null);
    if (contextAnswerPanelRef.current) {
      contextAnswerPanelRef.current.style.removeProperty('will-change');
      contextAnswerPanelRef.current.style.removeProperty('animation');
      contextAnswerPanelRef.current.style.removeProperty('opacity');
    }
    setContextAnswerSize(currentSize =>
      currentSize.width === nextSize.width && currentSize.height === nextSize.height
        ? currentSize
        : nextSize
    );
    resetContextAnswerResizeStyles();
  }, [
    applyContextAnswerPanelSize,
    applyContextAnswerResizePreview,
    clampContextAnswerSize,
    resetContextAnswerResizeStyles,
  ]);

  const syncMobileContextMenu = useCallback(() => {
    if (!isMobileViewport) {
      return;
    }

    clearSelectionMenuTimeout();
    selectionMenuTimeoutRef.current = window.setTimeout(() => {
      selectionMenuTimeoutRef.current = null;

      const selection = window.getSelection();
      const syncAction = resolveMobileContextMenuSyncAction({
        hasSelection: Boolean(selection?.toString().trim() && selection.rangeCount > 0),
        isMenuFocused: Boolean(contextMenuRef.current?.contains(document.activeElement)),
        isMenuVisible: contextMenu.visible,
      });

      if (
        selection &&
        syncAction === 'open-from-selection' &&
        openContextMenuFromSelection(selection, 'mobile-sheet')
      ) {
        return;
      }

      if (syncAction === 'keep-existing-menu') {
        return;
      }

      closeContextMenu();
    }, CONTEXT_MENU_MOBILE_DEBOUNCE_MS);
  }, [
    clearSelectionMenuTimeout,
    closeContextMenu,
    contextMenu.visible,
    isMobileViewport,
    openContextMenuFromSelection,
  ]);

  useEffect(() => {
    const handleResize = () => {
      setContextAnswerSize(currentSize => {
        const nextSize = clampContextAnswerSize(currentSize);
        applyContextAnswerPanelSize(nextSize);
        return nextSize;
      });
    };

    window.addEventListener('resize', handleResize);
    return () => {
      window.removeEventListener('resize', handleResize);
    };
  }, [applyContextAnswerPanelSize, clampContextAnswerSize]);

  useEffect(() => {
    window.addEventListener('pointermove', handleContextAnswerResizeMove);
    window.addEventListener('pointerup', handleContextAnswerResizeEnd);
    window.addEventListener('pointercancel', handleContextAnswerResizeEnd);
    return () => {
      window.removeEventListener('pointermove', handleContextAnswerResizeMove);
      window.removeEventListener('pointerup', handleContextAnswerResizeEnd);
      window.removeEventListener('pointercancel', handleContextAnswerResizeEnd);
      contextAnswerResizeRef.current = null;
      if (contextAnswerPanelRef.current) {
        contextAnswerPanelRef.current.style.removeProperty('will-change');
        contextAnswerPanelRef.current.style.removeProperty('animation');
        contextAnswerPanelRef.current.style.removeProperty('opacity');
      }
      applyContextAnswerResizePreview(null);
      resetContextAnswerResizeStyles();
    };
  }, [
    applyContextAnswerResizePreview,
    handleContextAnswerResizeEnd,
    handleContextAnswerResizeMove,
    resetContextAnswerResizeStyles,
  ]);

  useEffect(() => {
    const nextSize = clampContextAnswerSize(contextAnswerSize);
    applyContextAnswerPanelSize(nextSize);
    contextAnswerDraftSizeRef.current = nextSize;
  }, [applyContextAnswerPanelSize, clampContextAnswerSize, contextAnswerSize]);

  useEffect(() => {
    if (!contextMenu.visible) {
      return;
    }

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) {
        return;
      }

      if (contextMenuRef.current?.contains(target)) {
        return;
      }

      if (isMobileViewport) {
        return;
      }

      closeContextMenu();
    };

    document.addEventListener('pointerdown', handlePointerDown, true);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown, true);
    };
  }, [closeContextMenu, contextMenu.visible, isMobileViewport]);

  useEffect(() => {
    if (!isMobileViewport) {
      clearSelectionMenuTimeout();
      return;
    }

    const handleSelectionEvent = () => {
      syncMobileContextMenu();
    };

    document.addEventListener('selectionchange', handleSelectionEvent);
    window.addEventListener('pointerup', handleSelectionEvent);
    window.addEventListener('touchend', handleSelectionEvent);
    return () => {
      document.removeEventListener('selectionchange', handleSelectionEvent);
      window.removeEventListener('pointerup', handleSelectionEvent);
      window.removeEventListener('touchend', handleSelectionEvent);

      clearSelectionMenuTimeout();
    };
  }, [clearSelectionMenuTimeout, isMobileViewport, syncMobileContextMenu]);

  useEffect(() => {
    if (activeSectionId === null || activeSectionId.length > 0) {
      closeContextMenu();
    }
    closeContextAnswer();
  }, [activeSectionId, closeContextAnswer, closeContextMenu]);

  return useMemo(
    () => ({
      closeContextAnswer,
      closeContextMenu,
      contextAnswer,
      contextAnswerPanelRef,
      contextAnswerResizePreviewRef,
      contextAnswerSize,
      contextMenu,
      contextMenuRef,
      handleContentContextMenu,
      handleContextAnswerResizeStart,
      openContextAnswer,
      openContextMenuFromSelection,
    }),
    [
      closeContextAnswer,
      closeContextMenu,
      contextAnswer,
      contextAnswerPanelRef,
      contextAnswerResizePreviewRef,
      contextAnswerSize,
      contextMenu,
      handleContentContextMenu,
      handleContextAnswerResizeStart,
      openContextAnswer,
      openContextMenuFromSelection,
    ]
  );
};
