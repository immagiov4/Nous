import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
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
  const selectionMenuTimeoutRef = useRef<number | null>(null);
  const contextAnswerResizeRef = useRef<ContextAnswerResizeState | null>(null);

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
    (event: ReactMouseEvent<HTMLButtonElement>) => {
      event.preventDefault();
      event.stopPropagation();
      contextAnswerResizeRef.current = {
        startX: event.clientX,
        startY: event.clientY,
        startWidth: contextAnswerSize.width,
        startHeight: contextAnswerSize.height,
      };
      document.body.style.setProperty('user-select', 'none');
      document.body.style.setProperty('cursor', 'nesw-resize');
    },
    [contextAnswerSize.height, contextAnswerSize.width]
  );

  const handleContextAnswerResizeMove = useCallback((event: PointerEvent) => {
    const resizeState = contextAnswerResizeRef.current;
    if (!resizeState) {
      return;
    }

    const nextWidth = resizeState.startWidth + (resizeState.startX - event.clientX);
    const nextHeight = resizeState.startHeight + (resizeState.startY - event.clientY);
    setContextAnswerSize(
      clampContextAnswerSize({
        width: nextWidth,
        height: nextHeight,
      })
    );
  }, [clampContextAnswerSize]);

  const handleContextAnswerResizeEnd = useCallback(() => {
    if (!contextAnswerResizeRef.current) {
      return;
    }

    contextAnswerResizeRef.current = null;
    resetContextAnswerResizeStyles();
  }, [resetContextAnswerResizeStyles]);

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
      setContextAnswerSize(currentSize => clampContextAnswerSize(currentSize));
    };

    window.addEventListener('resize', handleResize);
    return () => {
      window.removeEventListener('resize', handleResize);
    };
  }, [clampContextAnswerSize]);

  useEffect(() => {
    window.addEventListener('pointermove', handleContextAnswerResizeMove);
    window.addEventListener('pointerup', handleContextAnswerResizeEnd);
    return () => {
      window.removeEventListener('pointermove', handleContextAnswerResizeMove);
      window.removeEventListener('pointerup', handleContextAnswerResizeEnd);
      contextAnswerResizeRef.current = null;
      resetContextAnswerResizeStyles();
    };
  }, [
    handleContextAnswerResizeEnd,
    handleContextAnswerResizeMove,
    resetContextAnswerResizeStyles,
  ]);

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
      contextAnswerSize,
      contextMenu,
      handleContentContextMenu,
      handleContextAnswerResizeStart,
      openContextAnswer,
      openContextMenuFromSelection,
    ]
  );
};
