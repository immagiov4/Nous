import {
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { ContextAnswerState } from '../../components/workspace/shell/types.ts';
import { createProjectId } from '../../services/projects/projectSnapshot.ts';
import type { ContextMenuPlacement, ContextMenuState, SectionAnnotation } from '../../types.ts';
import {
  createAnnotationContextMenuState,
  createClosedContextMenuState,
  createLessonContextMenuState,
  resolveContextMenuSelection,
  resolveMobileContextMenuSyncAction,
} from '../../utils/context/menuSelection';
import {
  findActiveSectionAnnotationHighlightHit,
  getSectionAnnotationHighlightHit,
} from '../../utils/learning/sectionAnnotationHighlights.ts';
import { getSectionAnnotationText } from '../../utils/learning/sectionAnnotations.ts';
import {
  CONTEXT_ANSWER_DEFAULT_SIZE,
  type ContextAnswerSize,
  clampContextAnswerPanelSize,
} from '../../utils/reader/chrome.ts';

const CONTEXT_MENU_MOBILE_DEBOUNCE_MS = 100;
const SELECTION_MENU_REOPEN_SUPPRESSION_MS = 260;
const ANNOTATION_MARK_SELECTOR = 'mark[data-nous-annotation-id], mark[data-lumina-annotation-id]';
const LESSON_CONTEXT_SURFACE_SELECTOR = '[data-nous-lesson-context-surface]';
const LESSON_CONTEXT_INTERACTIVE_SELECTOR =
  'a,button,input,textarea,select,option,summary,[role="button"],[role="link"],[role="menuitem"],[contenteditable="true"],[data-nous-native-context-menu]';

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
  scrollContainerRef?: RefObject<HTMLElement | null>;
  sectionAnnotations?: SectionAnnotation[];
  sectionContent: string;
}

type OpenSelectionMenuOutcome = 'opened' | 'closed' | 'ignored';

interface OpenSelectionMenuOptions {
  allowToggleClose?: boolean;
}

interface SelectionMenuIdentity {
  contextAfter?: string;
  contextBefore?: string;
  placement: ContextMenuPlacement;
  selectedText: string;
  selectedTextStart?: number;
}

const getSelectionMenuKey = ({
  contextAfter,
  contextBefore,
  placement,
  selectedText,
  selectedTextStart,
}: SelectionMenuIdentity) => {
  return `${placement}::${selectedText}::${selectedTextStart ?? ''}::${contextBefore || ''}::${contextAfter || ''}`;
};

const canOpenLessonContextMenu = (target: EventTarget | null, contentElement: HTMLElement) => {
  if (!(target instanceof Node)) {
    return false;
  }

  const targetElement = target instanceof Element ? target : target.parentElement;
  if (
    !targetElement ||
    (!contentElement.contains(targetElement) &&
      !targetElement.closest(LESSON_CONTEXT_SURFACE_SELECTOR))
  ) {
    return false;
  }

  return !targetElement.closest(LESSON_CONTEXT_INTERACTIVE_SELECTOR);
};

export const useReaderContext = ({
  activeSectionId,
  contentRef,
  isMobileViewport,
  scrollContainerRef,
  sectionAnnotations,
  sectionContent,
}: UseReaderContextArgs) => {
  const [contextMenu, setContextMenu] = useState<ContextMenuState>(createClosedContextMenuState);
  const [contextAnswer, setContextAnswer] = useState<ContextAnswerState | null>(null);
  const [contextMenuOwnerSectionId, setContextMenuOwnerSectionId] = useState<string | null>(null);
  const [contextAnswerOwnerSectionId, setContextAnswerOwnerSectionId] = useState<string | null>(
    null
  );
  const [contextAnswerSize, setContextAnswerSize] = useState<ContextAnswerSize>(
    CONTEXT_ANSWER_DEFAULT_SIZE
  );
  const visibleContextAnswer =
    contextAnswerOwnerSectionId === activeSectionId ? contextAnswer : null;
  const visibleContextMenu =
    visibleContextAnswer || contextMenuOwnerSectionId !== activeSectionId
      ? createClosedContextMenuState()
      : contextMenu;

  const contextMenuRef = useRef<HTMLDivElement>(null);
  const contextAnswerPanelRef = useRef<HTMLDivElement>(null);
  const contextAnswerResizePreviewRef = useRef<HTMLDivElement>(null);
  const selectionMenuTimeoutRef = useRef<number | null>(null);
  const contextMenuScrollTopRef = useRef<number | null>(null);
  const lastAnnotationMenuTransitionRef = useRef<{
    at: number;
    sectionId: string | null;
  } | null>(null);
  const suppressedSelectionMenuRef = useRef<{ key: string; until: number } | null>(null);
  const pendingDesktopSelectionContextMenuRef = useRef<{ x: number; y: number } | null>(null);
  const contextAnswerResizeRef = useRef<ContextAnswerResizeState | null>(null);
  const contextAnswerDraftSizeRef = useRef<ContextAnswerSize>(CONTEXT_ANSWER_DEFAULT_SIZE);
  // Mirror of contextMenu state consumed from callbacks that must keep a stable
  // identity. Reading contextMenu directly from those callbacks would force
  // them to list it in their deps, which in turn would invalidate every
  // handler passed down to memoized descendants (notably MarkdownRenderer)
  // each time the menu opens or closes, causing a full react-markdown
  // reparse of the reader content right before the menu appears.
  const contextMenuStateRef = useRef<ContextMenuState>(contextMenu);
  useEffect(() => {
    contextMenuStateRef.current = visibleContextMenu;
  }, [visibleContextMenu]);

  // Mirror of sectionContent so that handleContentClick can read the latest
  // value without listing it as a useCallback dependency. sectionContent
  // changes on every annotation toggle; keeping it out of the deps prevents
  // the onClick prop on MarkdownRenderer from being recreated each time,
  // which would defeat memo() and trigger a full react-markdown reparse.
  const sectionContentRef = useRef(sectionContent);
  useEffect(() => {
    sectionContentRef.current = sectionContent;
  }, [sectionContent]);

  const clearSelectionMenuTimeout = useCallback(() => {
    if (selectionMenuTimeoutRef.current === null) {
      return;
    }

    globalThis.clearTimeout(selectionMenuTimeoutRef.current);
    selectionMenuTimeoutRef.current = null;
  }, []);

  const captureContextMenuScrollTop = useCallback(() => {
    contextMenuScrollTopRef.current = scrollContainerRef?.current?.scrollTop ?? null;
  }, [scrollContainerRef]);

  const resetContextAnswerResizeStyles = useCallback(() => {
    document.body.style.removeProperty('user-select');
    document.body.style.removeProperty('cursor');
  }, []);

  const clampContextAnswerSize = useCallback((size: ContextAnswerSize): ContextAnswerSize => {
    if (typeof globalThis.window === 'undefined') {
      return clampContextAnswerPanelSize(size, {
        width: CONTEXT_ANSWER_DEFAULT_SIZE.width + 32,
        height: CONTEXT_ANSWER_DEFAULT_SIZE.height + 32,
      });
    }

    return clampContextAnswerPanelSize(size, {
      width: globalThis.innerWidth,
      height: globalThis.innerHeight,
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
    clearSelectionMenuTimeout();
    setContextMenuOwnerSectionId(null);
    contextMenuStateRef.current = createClosedContextMenuState();
    setContextMenu(currentMenu => {
      if (!currentMenu.visible) {
        return currentMenu;
      }

      return createClosedContextMenuState();
    });
  }, [clearSelectionMenuTimeout]);

  const closeContextAnswer = useCallback(() => {
    setContextAnswerOwnerSectionId(null);
    setContextAnswer(null);
  }, []);

  const openContextAnswer = useCallback(
    ({
      attachedAnnotationNote,
      attachedAnnotationText,
      contextAfter,
      contextBefore,
      contextScope,
      initialQuestion,
      lessonContent,
      lessonDescription,
      lessonId,
      lessonTitle,
      projectId,
      projectTitle,
      selectedText,
      selectedTextStart,
      sourceKind,
      sourceMaterial,
      sourceName,
    }: Omit<ContextAnswerState, 'id'>) => {
      closeContextMenu();
      setContextAnswerOwnerSectionId(activeSectionId);
      setContextAnswer({
        attachedAnnotationNote,
        attachedAnnotationText,
        contextAfter,
        contextBefore,
        contextScope,
        id: createProjectId(),
        initialQuestion,
        lessonContent,
        lessonDescription,
        lessonId,
        lessonTitle,
        projectId,
        projectTitle,
        selectedText,
        selectedTextStart,
        sourceKind,
        sourceMaterial,
        sourceName,
      });
    },
    [activeSectionId, closeContextMenu]
  );

  const openContextMenuFromLesson = useCallback(
    (
      placement: ContextMenuPlacement,
      anchorX: number,
      anchorY: number,
      target: EventTarget | null
    ): OpenSelectionMenuOutcome => {
      const contentElement = contentRef.current;
      if (
        !contentElement ||
        !sectionContentRef.current.trim() ||
        !canOpenLessonContextMenu(target, contentElement)
      ) {
        return 'ignored';
      }

      const contentRect = contentElement.getBoundingClientRect();
      const nextMenu = createLessonContextMenuState({
        anchorX,
        anchorY,
        horizontalBounds: {
          left: contentRect.left,
          right: contentRect.right,
        },
        placement,
      });

      captureContextMenuScrollTop();
      setContextMenuOwnerSectionId(activeSectionId);
      contextMenuStateRef.current = nextMenu;
      setContextMenu(currentMenu => {
        if (
          currentMenu.visible &&
          currentMenu.type === 'lesson' &&
          currentMenu.placement === nextMenu.placement &&
          currentMenu.anchorX === nextMenu.anchorX &&
          currentMenu.anchorY === nextMenu.anchorY
        ) {
          return currentMenu;
        }

        return nextMenu;
      });

      return 'opened';
    },
    [activeSectionId, captureContextMenuScrollTop, contentRef]
  );

  const openContextMenuFromSelection = useCallback(
    (
      selection: Selection,
      placement: ContextMenuPlacement,
      fallbackAnchorX?: number,
      fallbackAnchorY?: number,
      options?: OpenSelectionMenuOptions
    ): OpenSelectionMenuOutcome => {
      if (!contentRef.current) {
        return 'ignored';
      }

      const nextMenu = resolveContextMenuSelection({
        content: sectionContentRef.current,
        container: contentRef.current,
        fallbackAnchorX,
        fallbackAnchorY,
        placement,
        selection,
      });

      if (!nextMenu) {
        return 'ignored';
      }

      const nextMenuKey = getSelectionMenuKey(nextMenu);
      const suppressedSelection = suppressedSelectionMenuRef.current;
      if (
        suppressedSelection &&
        suppressedSelection.key === nextMenuKey &&
        suppressedSelection.until > Date.now()
      ) {
        return 'ignored';
      }

      if (
        options?.allowToggleClose !== false &&
        contextMenuStateRef.current.visible &&
        contextMenuStateRef.current.type === 'selection' &&
        getSelectionMenuKey(contextMenuStateRef.current) === nextMenuKey
      ) {
        suppressedSelectionMenuRef.current = {
          key: nextMenuKey,
          until: Date.now() + SELECTION_MENU_REOPEN_SUPPRESSION_MS,
        };
        closeContextMenu();
        return 'closed';
      }

      captureContextMenuScrollTop();
      setContextMenuOwnerSectionId(activeSectionId);
      contextMenuStateRef.current = nextMenu;
      setContextMenu(currentMenu => {
        if (
          currentMenu.visible &&
          currentMenu.type === 'selection' &&
          currentMenu.placement === nextMenu.placement &&
          currentMenu.selectedText === nextMenu.selectedText &&
          currentMenu.selectedTextStart === nextMenu.selectedTextStart &&
          currentMenu.contextBefore === nextMenu.contextBefore &&
          currentMenu.contextAfter === nextMenu.contextAfter
        ) {
          return currentMenu;
        }

        return nextMenu;
      });

      return 'opened';
    },
    [activeSectionId, captureContextMenuScrollTop, closeContextMenu, contentRef]
  );

  const handleContentContextMenu = useCallback(
    (event: ReactMouseEvent<HTMLElement>) => {
      if (isMobileViewport) {
        return;
      }

      const pendingSelectionMenu = pendingDesktopSelectionContextMenuRef.current;
      pendingDesktopSelectionContextMenuRef.current = null;
      if (pendingSelectionMenu?.x === event.clientX && pendingSelectionMenu.y === event.clientY) {
        event.preventDefault();
        return;
      }

      const selection = globalThis.getSelection();
      if (selection) {
        const selectionMenuOutcome = openContextMenuFromSelection(
          selection,
          'desktop-floating',
          event.clientX,
          event.clientY,
          { allowToggleClose: false }
        );

        if (selectionMenuOutcome !== 'ignored') {
          event.preventDefault();
          return;
        }
      }

      const lessonMenuOutcome = openContextMenuFromLesson(
        'desktop-floating',
        event.clientX,
        event.clientY,
        event.target
      );
      if (lessonMenuOutcome !== 'ignored') {
        event.preventDefault();
      }
    },
    [isMobileViewport, openContextMenuFromLesson, openContextMenuFromSelection]
  );

  const handleContentPointerDownCapture = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      pendingDesktopSelectionContextMenuRef.current = null;
      if (isMobileViewport || event.button !== 2) {
        return;
      }

      const selection = globalThis.getSelection();
      if (!selection || selection.rangeCount === 0 || !selection.toString().trim()) {
        return;
      }

      const selectionMenuOutcome = openContextMenuFromSelection(
        selection,
        'desktop-floating',
        event.clientX,
        event.clientY,
        { allowToggleClose: false }
      );

      if (selectionMenuOutcome !== 'ignored') {
        pendingDesktopSelectionContextMenuRef.current = {
          x: event.clientX,
          y: event.clientY,
        };
        event.preventDefault();
      }
    },
    [isMobileViewport, openContextMenuFromSelection]
  );

  const handleContentClick = useCallback(
    (event: ReactMouseEvent<HTMLElement>) => {
      const target = event.target;
      if (!(target instanceof Element) || !contentRef.current) {
        return;
      }

      const annotationElement = target.closest(ANNOTATION_MARK_SELECTOR);
      const nativeHighlightHit = getSectionAnnotationHighlightHit(event.nativeEvent);
      const hasLegacyAnnotationElement =
        annotationElement instanceof HTMLElement && contentRef.current.contains(annotationElement);
      if (!nativeHighlightHit && !hasLegacyAnnotationElement) {
        return;
      }

      const selection = globalThis.getSelection();
      if (selection && !selection.isCollapsed && selection.toString().trim()) {
        return;
      }

      const annotationData =
        annotationElement instanceof HTMLElement ? annotationElement.dataset : undefined;
      const annotationId =
        nativeHighlightHit?.annotationId ||
        annotationData?.nousAnnotationId ||
        annotationData?.luminaAnnotationId;
      if (!annotationId) {
        return;
      }

      if (isMobileViewport) {
        const now = Date.now();
        const lastTransition = lastAnnotationMenuTransitionRef.current;
        if (
          lastTransition?.sectionId === activeSectionId &&
          now - lastTransition.at < CONTEXT_MENU_MOBILE_DEBOUNCE_MS
        ) {
          return;
        }
        lastAnnotationMenuTransitionRef.current = { at: now, sectionId: activeSectionId };
      }

      const rect =
        nativeHighlightHit?.rect || (annotationElement as HTMLElement).getBoundingClientRect();
      const contentRect = contentRef.current.getBoundingClientRect();
      const selectedText =
        nativeHighlightHit?.selectedText ||
        getSectionAnnotationText(sectionContentRef.current, annotationId, sectionAnnotations) ||
        (annotationElement instanceof HTMLElement ? annotationElement.innerText.trim() : '') ||
        annotationElement?.textContent?.trim() ||
        '';

      if (!selectedText) {
        return;
      }

      const annotation = sectionAnnotations?.find(candidate => candidate.id === annotationId);
      const annotationNote = annotation?.note || '';

      const currentMenu = contextMenuStateRef.current;
      if (isMobileViewport && currentMenu.visible) {
        closeContextMenu();
        return;
      }

      if (
        currentMenu.visible &&
        currentMenu.type === 'annotation' &&
        currentMenu.annotationId === annotationId
      ) {
        closeContextMenu();
        return;
      }

      const nextMenu = createAnnotationContextMenuState({
        annotationId,
        annotationArtifactRefs: annotation?.artifactRefs,
        annotationNote,
        anchorX: rect.left + rect.width / 2,
        anchorY: rect.bottom,
        horizontalBounds: {
          left: contentRect.left,
          right: contentRect.right,
        },
        placement: isMobileViewport ? 'mobile-sheet' : 'desktop-floating',
        selectedText,
        selectionRect: {
          top: rect.top,
          left: rect.left,
          width: rect.width,
          height: rect.height,
        },
      });

      captureContextMenuScrollTop();
      setContextMenuOwnerSectionId(activeSectionId);
      contextMenuStateRef.current = nextMenu;
      setContextMenu(nextMenu);
    },
    [
      activeSectionId,
      captureContextMenuScrollTop,
      closeContextMenu,
      contentRef,
      isMobileViewport,
      sectionAnnotations,
    ]
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

  const handleContextAnswerResizeEnd = useCallback(
    (event?: PointerEvent) => {
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
    },
    [
      applyContextAnswerPanelSize,
      applyContextAnswerResizePreview,
      clampContextAnswerSize,
      resetContextAnswerResizeStyles,
    ]
  );

  const syncMobileContextMenu = useCallback(
    (interactionTarget?: EventTarget | null) => {
      if (!isMobileViewport) {
        return;
      }

      const currentMenu = contextMenuStateRef.current;
      if (currentMenu.visible && currentMenu.type === 'annotation') {
        return;
      }

      clearSelectionMenuTimeout();
      selectionMenuTimeoutRef.current = globalThis.window.setTimeout(() => {
        selectionMenuTimeoutRef.current = null;

        if (
          contextMenuStateRef.current.visible &&
          contextMenuStateRef.current.type === 'annotation'
        ) {
          return;
        }

        const selection = globalThis.getSelection();
        const isInteractingWithinMenu =
          interactionTarget instanceof Node &&
          Boolean(contextMenuRef.current?.contains(interactionTarget));
        const syncAction = resolveMobileContextMenuSyncAction({
          hasSelection: Boolean(selection?.toString().trim() && selection.rangeCount > 0),
          isInteractingWithinMenu,
          isMenuFocused: Boolean(contextMenuRef.current?.contains(document.activeElement)),
          isMenuVisible: contextMenuStateRef.current.visible,
        });

        if (selection && syncAction === 'open-from-selection') {
          const selectionMenuOutcome = openContextMenuFromSelection(
            selection,
            'mobile-sheet',
            undefined,
            undefined,
            { allowToggleClose: false }
          );
          if (selectionMenuOutcome === 'opened' || selectionMenuOutcome === 'closed') {
            return;
          }
        }

        if (syncAction === 'keep-existing-menu') {
          return;
        }

        closeContextMenu();
      }, CONTEXT_MENU_MOBILE_DEBOUNCE_MS);
    },
    [clearSelectionMenuTimeout, closeContextMenu, isMobileViewport, openContextMenuFromSelection]
  );

  useEffect(() => {
    const handleResize = () => {
      setContextAnswerSize(currentSize => {
        const nextSize = clampContextAnswerSize(currentSize);
        applyContextAnswerPanelSize(nextSize);
        return nextSize;
      });
    };

    globalThis.addEventListener('resize', handleResize);
    return () => {
      globalThis.removeEventListener('resize', handleResize);
    };
  }, [applyContextAnswerPanelSize, clampContextAnswerSize]);

  useEffect(() => {
    const contextAnswerPanelElement = contextAnswerPanelRef.current;
    globalThis.addEventListener('pointermove', handleContextAnswerResizeMove);
    globalThis.addEventListener('pointerup', handleContextAnswerResizeEnd);
    globalThis.addEventListener('pointercancel', handleContextAnswerResizeEnd);
    return () => {
      globalThis.removeEventListener('pointermove', handleContextAnswerResizeMove);
      globalThis.removeEventListener('pointerup', handleContextAnswerResizeEnd);
      globalThis.removeEventListener('pointercancel', handleContextAnswerResizeEnd);
      contextAnswerResizeRef.current = null;
      if (contextAnswerPanelElement) {
        contextAnswerPanelElement.style.removeProperty('will-change');
        contextAnswerPanelElement.style.removeProperty('animation');
        contextAnswerPanelElement.style.removeProperty('opacity');
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

      const contentElement = contentRef.current;
      const nativeHighlightHit = findActiveSectionAnnotationHighlightHit(
        event.clientX,
        event.clientY
      );
      if (
        contentElement?.contains(target) &&
        ((target instanceof Element && target.closest(ANNOTATION_MARK_SELECTOR)) ||
          nativeHighlightHit)
      ) {
        return;
      }

      if (contextMenuRef.current?.contains(target)) {
        return;
      }

      if (target instanceof Element && target.closest('[data-nous-context-menu-portal]')) {
        return;
      }

      closeContextMenu();
    };

    document.addEventListener('pointerdown', handlePointerDown, true);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown, true);
    };
  }, [closeContextMenu, contentRef, contextMenu.visible]);

  useEffect(() => {
    if (!isMobileViewport) {
      clearSelectionMenuTimeout();
      return;
    }

    const handleSelectionEvent = (event?: Event) => {
      const target = event?.target;
      const contentElement = contentRef.current;
      const nativeHighlightHit =
        typeof PointerEvent !== 'undefined' && event instanceof PointerEvent
          ? findActiveSectionAnnotationHighlightHit(event.clientX, event.clientY)
          : null;
      if (
        target instanceof Node &&
        contentElement?.contains(target) &&
        ((target instanceof Element && target.closest(ANNOTATION_MARK_SELECTOR)) ||
          nativeHighlightHit)
      ) {
        clearSelectionMenuTimeout();
        return;
      }

      syncMobileContextMenu(event?.target);
    };

    document.addEventListener('selectionchange', handleSelectionEvent);
    globalThis.addEventListener('pointerup', handleSelectionEvent);
    globalThis.addEventListener('touchend', handleSelectionEvent);
    return () => {
      document.removeEventListener('selectionchange', handleSelectionEvent);
      globalThis.removeEventListener('pointerup', handleSelectionEvent);
      globalThis.removeEventListener('touchend', handleSelectionEvent);

      clearSelectionMenuTimeout();
    };
  }, [clearSelectionMenuTimeout, contentRef, isMobileViewport, syncMobileContextMenu]);

  return useMemo(
    () => ({
      closeContextAnswer,
      closeContextMenu,
      contextAnswer: visibleContextAnswer,
      contextAnswerPanelRef,
      contextAnswerResizePreviewRef,
      contextAnswerSize,
      contextMenu: visibleContextMenu,
      contextMenuRef,
      contextMenuScrollTopRef,
      handleContentClick,
      handleContentContextMenu,
      handleContentPointerDownCapture,
      handleContextAnswerResizeStart,
      openContextAnswer,
      openContextMenuFromSelection,
    }),
    [
      closeContextAnswer,
      closeContextMenu,
      visibleContextAnswer,
      contextAnswerSize,
      visibleContextMenu,
      handleContentContextMenu,
      handleContentClick,
      handleContentPointerDownCapture,
      handleContextAnswerResizeStart,
      openContextAnswer,
      openContextMenuFromSelection,
    ]
  );
};
