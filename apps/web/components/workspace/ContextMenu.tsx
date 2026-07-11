import { motion } from 'framer-motion';
import {
  ArrowUp,
  BookPlus,
  Eraser,
  Highlighter,
  LoaderCircle,
  MoreVertical,
  NotebookPen,
  Paperclip,
  X,
} from 'lucide-react';
import {
  type CSSProperties,
  type FormEvent,
  type MouseEvent,
  type PointerEvent,
  type RefObject,
  type TouchEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import { useMobileKeyboardOffset } from '../../hooks/useMobileKeyboardOffset.ts';
import { translateUiMessage as t } from '../../i18n/uiMessages.ts';
import type {
  ContextMenuPlacement,
  HorizontalViewportBounds,
  LearningArtifactRenderPayload,
  SectionAnnotationArtifactRef,
  SelectionRect,
} from '../../types';
import { normalizeMarkdownForRendering } from '../../utils/markdown/render.ts';
import { useShouldAnimate } from '../../utils/motion/useShouldAnimate.ts';
import ChatArtifactRenderer from '../shared/ChatArtifactRenderer.tsx';
import MarkdownRenderer from '../shared/MarkdownRenderer.tsx';
import SpeechInputButton, { appendSpeechTranscription } from '../shared/SpeechInputButton.tsx';

interface ContextMenuProps {
  anchorX?: number;
  anchorY?: number;
  askInputValue?: string;
  annotationArtifactRefs?: SectionAnnotationArtifactRef[];
  annotationNote?: string;
  artifactPayloads?: LearningArtifactRenderPayload[];
  artifactPreviewIdOverride?: string | null;
  artifactPortalContainer?: HTMLElement | null;
  containerRef?: RefObject<HTMLDivElement | null>;
  horizontalBounds?: HorizontalViewportBounds;
  isDarkMode?: boolean;
  isLoading: boolean;
  notePreviewScrollTopOverride?: number;
  onAttachArtifactToAnnotation?: (artifactRef: SectionAnnotationArtifactRef) => void;
  onAsk: (question: string) => void;
  onClose: () => void;
  onCreateLesson: (instructions: string) => void;
  onDeleteAnnotation: () => void;
  onDetachArtifactFromAnnotation?: (artifactId: string) => void;
  onHighlight: () => void;
  onSaveNote: (note: string, artifactRefs?: SectionAnnotationArtifactRef[]) => void;
  placement: ContextMenuPlacement;
  selectionRect?: SelectionRect;
  selectedText: string;
  type: 'annotation' | 'lesson' | 'selection';
}

const CONTEXT_MENU_DESKTOP_MAX_WIDTH = 460;
const CONTEXT_MENU_DESKTOP_MIN_WIDTH = 320;
const CONTEXT_MENU_DESKTOP_CHROME_HEIGHT = 76;
const CONTEXT_MENU_MOBILE_MAX_WIDTH = 384;
const CONTEXT_MENU_VIEWPORT_PADDING = 12;
const MORE_ACTIONS_MENU_WIDTH = 208;
const MORE_ACTIONS_MENU_HEIGHT = 52;
const MORE_ACTIONS_MENU_GAP = 8;

const clamp = (value: number, min: number, max: number) => {
  return Math.min(Math.max(value, min), max);
};

const abbreviate = (value: string, maxLength: number) => {
  const normalizedValue = value.trim().replace(/\s+/g, ' ');
  if (normalizedValue.length <= maxLength) {
    return normalizedValue;
  }

  return `${normalizedValue.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
};

const ContextMenu = ({
  anchorX,
  anchorY,
  askInputValue,
  annotationArtifactRefs = [],
  annotationNote = '',
  artifactPayloads = [],
  artifactPreviewIdOverride,
  artifactPortalContainer,
  containerRef,
  horizontalBounds,
  isDarkMode = false,
  isLoading,
  notePreviewScrollTopOverride,
  onAttachArtifactToAnnotation,
  onAsk,
  onClose,
  onCreateLesson,
  onDeleteAnnotation,
  onDetachArtifactFromAnnotation,
  onHighlight,
  onSaveNote,
  placement,
  selectionRect,
  selectedText,
  type,
}: ContextMenuProps) => {
  const [input, setInput] = useState('');
  const [noteInput, setNoteInput] = useState(annotationNote);
  const [localAnnotationArtifactRefs, setLocalAnnotationArtifactRefs] =
    useState(annotationArtifactRefs);
  const [isLessonConfirmOpen, setIsLessonConfirmOpen] = useState(false);
  const [isAttachmentPickerOpen, setIsAttachmentPickerOpen] = useState(false);
  const [isMoreActionsOpen, setIsMoreActionsOpen] = useState(false);
  const [moreActionsMenuStyle, setMoreActionsMenuStyle] = useState<CSSProperties | null>(null);
  const [isNoteEditorOpen, setIsNoteEditorOpen] = useState(false);
  const [isNotePreviewScrolled, setIsNotePreviewScrolled] = useState(false);
  const askInteractionLockRef = useRef(false);
  const highlightInteractionLockRef = useRef(false);
  const previousMenuKeyRef = useRef(
    `${type}:${selectedText}:${annotationNote}:${annotationArtifactRefs
      .map(ref => ref.artifactId)
      .join('|')}`
  );
  const notePreviewRef = useRef<HTMLDivElement>(null);
  const moreActionsButtonRef = useRef<HTMLButtonElement>(null);
  const moreActionsMenuRef = useRef<HTMLDivElement>(null);
  const moreActionsMenuItemRef = useRef<HTMLButtonElement>(null);
  const lessonCancelButtonRef = useRef<HTMLButtonElement>(null);
  const isMobileSheet = placement === 'mobile-sheet';
  const { keyboardOffset } = useMobileKeyboardOffset();
  const isAnnotationMode = type === 'annotation';
  const isLessonMode = type === 'lesson';
  const activeAnnotationArtifactRefs = isLessonMode
    ? annotationArtifactRefs
    : localAnnotationArtifactRefs;
  const annotationArtifactPayloads = useMemo(() => {
    if (!activeAnnotationArtifactRefs.length || !artifactPayloads.length) {
      return [];
    }

    const payloadsById = new Map(
      artifactPayloads.map(payload => [payload.summary.id, payload] as const)
    );
    return activeAnnotationArtifactRefs.flatMap(ref => {
      const payload = payloadsById.get(ref.artifactId);
      return payload ? [payload] : [];
    });
  }, [activeAnnotationArtifactRefs, artifactPayloads]);
  const attachableArtifactPayloads = useMemo(() => {
    const attachedArtifactIds = new Set(activeAnnotationArtifactRefs.map(ref => ref.artifactId));
    return artifactPayloads.filter(
      payload =>
        !attachedArtifactIds.has(payload.summary.id) &&
        (payload.summary.kind !== 'generated-visual' ||
          !('visual' in payload) ||
          payload.visual.id.startsWith('visual-draft-'))
    );
  }, [activeAnnotationArtifactRefs, artifactPayloads]);
  const hasSavedAnnotationNote = annotationNote.trim().length > 0;
  const hasSavedAnnotationContent = hasSavedAnnotationNote || annotationArtifactPayloads.length > 0;
  const displayedInput = askInputValue ?? input;
  const trimmedInput = displayedInput.trim();
  const trimmedNote = noteInput.trim();
  const isAnnotationPreviewMode =
    isAnnotationMode && hasSavedAnnotationContent && !isNoteEditorOpen;
  const isAnnotationEditingMode = isAnnotationMode && !isAnnotationPreviewMode;
  const canEditNoteAttachments = !isLessonMode && !isAnnotationPreviewMode;
  const isNotePanelVisible = isNoteEditorOpen || isAnnotationPreviewMode;
  const canDeleteAnnotationFromCurrentState =
    !isLessonMode && isAnnotationMode && hasSavedAnnotationContent;
  const shouldShowToolbarNoteButton =
    !isLessonMode && (!isAnnotationMode || !hasSavedAnnotationContent);
  const askInputPlaceholder = t(
    isLessonMode ? 'Chiedi su tutta la lezione' : 'Chiedi a Nous o aggiungi istruzioni'
  );
  const notePanelTitle =
    isAnnotationMode && hasSavedAnnotationContent
      ? t('Nota associata al passaggio')
      : t('Aggiungi una nota alla lezione');
  const lessonSelectionPreview = abbreviate(selectedText, 120);
  const lessonInstructionPreview = trimmedInput ? abbreviate(trimmedInput, 120) : null;
  const normalizedNotePreview = useMemo(
    () => normalizeMarkdownForRendering(noteInput),
    [noteInput]
  );
  const moreActionsPortalTarget =
    artifactPortalContainer ?? (typeof document === 'undefined' ? null : document.body);

  const handleContainerPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    event.stopPropagation();
  };

  const submitAsk = () => {
    if (!trimmedInput) {
      return;
    }

    if (isMobileSheet) {
      onClose();
      window.requestAnimationFrame(() => {
        onAsk(trimmedInput);
      });
      return;
    }

    onAsk(trimmedInput);
  };

  const handleAskSubmit = (event: FormEvent) => {
    event.preventDefault();
    if ('stopPropagation' in event) {
      event.stopPropagation();
    }
    submitAsk();
  };

  const handleAskClick = (event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    if (askInteractionLockRef.current) {
      return;
    }
    askInteractionLockRef.current = true;
    submitAsk();
    window.setTimeout(() => {
      askInteractionLockRef.current = false;
    }, 400);
  };

  const handleAskPointerDown = (event: PointerEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    if (askInteractionLockRef.current) {
      return;
    }
    askInteractionLockRef.current = true;
    submitAsk();
    window.setTimeout(() => {
      askInteractionLockRef.current = false;
    }, 400);
  };

  const handleAskTouchStart = (event: TouchEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    if (askInteractionLockRef.current) {
      return;
    }
    askInteractionLockRef.current = true;
    submitAsk();
    window.setTimeout(() => {
      askInteractionLockRef.current = false;
    }, 400);
  };

  const handleHighlightClick = (event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    if (highlightInteractionLockRef.current) {
      return;
    }
    highlightInteractionLockRef.current = true;
    if (isAnnotationMode) {
      onDeleteAnnotation();
    } else {
      onHighlight();
    }
    window.setTimeout(() => {
      highlightInteractionLockRef.current = false;
    }, 400);
  };

  const handleHighlightPointerDown = (event: PointerEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    if (highlightInteractionLockRef.current) {
      return;
    }
    highlightInteractionLockRef.current = true;
    if (isAnnotationMode) {
      onDeleteAnnotation();
    } else {
      onHighlight();
    }
    window.setTimeout(() => {
      highlightInteractionLockRef.current = false;
    }, 400);
  };

  const handleHighlightTouchStart = (event: TouchEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    if (highlightInteractionLockRef.current) {
      return;
    }
    highlightInteractionLockRef.current = true;
    if (isAnnotationMode) {
      onDeleteAnnotation();
    } else {
      onHighlight();
    }
    window.setTimeout(() => {
      highlightInteractionLockRef.current = false;
    }, 400);
  };

  const handleToggleMoreActions = (event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    if (isMoreActionsOpen) {
      setIsMoreActionsOpen(false);
      return;
    }

    const triggerRect = moreActionsButtonRef.current?.getBoundingClientRect();
    if (!triggerRect || typeof window === 'undefined') {
      return;
    }

    const left = clamp(
      triggerRect.right - MORE_ACTIONS_MENU_WIDTH,
      CONTEXT_MENU_VIEWPORT_PADDING,
      Math.max(
        CONTEXT_MENU_VIEWPORT_PADDING,
        window.innerWidth - MORE_ACTIONS_MENU_WIDTH - CONTEXT_MENU_VIEWPORT_PADDING
      )
    );
    setMoreActionsMenuStyle(
      triggerRect.top >= MORE_ACTIONS_MENU_HEIGHT + MORE_ACTIONS_MENU_GAP
        ? {
            bottom: window.innerHeight - triggerRect.top + MORE_ACTIONS_MENU_GAP,
            left,
          }
        : { left, top: triggerRect.bottom + MORE_ACTIONS_MENU_GAP }
    );
    setIsNoteEditorOpen(false);
    setIsLessonConfirmOpen(false);
    setIsMoreActionsOpen(true);
  };

  const handleCreateIntent = (event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    setIsMoreActionsOpen(false);
    setIsLessonConfirmOpen(true);
    window.requestAnimationFrame(() => lessonCancelButtonRef.current?.focus());
  };

  const handleCancelCreate = (event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    setIsLessonConfirmOpen(false);
  };

  const handleCreate = (event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    setIsLessonConfirmOpen(false);
    onCreateLesson(displayedInput);
  };

  const handleToggleNoteEditor = (event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    setIsLessonConfirmOpen(false);
    setIsNoteEditorOpen(currentValue => !currentValue);
  };

  const handleSaveNote = (event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();

    if (!isAnnotationMode && !trimmedNote && localAnnotationArtifactRefs.length === 0) {
      return;
    }

    onSaveNote(noteInput, localAnnotationArtifactRefs);
  };

  const handleCancelNoteEdit = (event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    setNoteInput(annotationNote);
    setIsNoteEditorOpen(false);
  };

  const handleDeleteAnnotationClick = (event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    onDeleteAnnotation();
  };

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') {
        return;
      }

      if (isMoreActionsOpen) {
        event.preventDefault();
        setIsMoreActionsOpen(false);
        window.requestAnimationFrame(() => moreActionsButtonRef.current?.focus());
        return;
      }

      onClose();
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [isMoreActionsOpen, onClose]);

  useEffect(() => {
    if (!isMoreActionsOpen) {
      return;
    }

    const frameId = window.requestAnimationFrame(() => moreActionsMenuItemRef.current?.focus());
    const handlePointerDown = (event: globalThis.PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) {
        return;
      }

      if (
        moreActionsButtonRef.current?.contains(target) ||
        moreActionsMenuRef.current?.contains(target)
      ) {
        return;
      }

      setIsMoreActionsOpen(false);
    };

    document.addEventListener('pointerdown', handlePointerDown, true);
    return () => {
      window.cancelAnimationFrame(frameId);
      document.removeEventListener('pointerdown', handlePointerDown, true);
    };
  }, [isMoreActionsOpen]);

  useEffect(() => {
    const nextMenuKey = `${type}:${selectedText}:${annotationNote}:${annotationArtifactRefs
      .map(ref => ref.artifactId)
      .join('|')}`;
    if (previousMenuKeyRef.current === nextMenuKey) {
      return;
    }

    previousMenuKeyRef.current = nextMenuKey;
    setIsLessonConfirmOpen(false);
    setIsAttachmentPickerOpen(false);
    setIsMoreActionsOpen(false);
    setLocalAnnotationArtifactRefs(annotationArtifactRefs);
    setNoteInput(annotationNote);
    setIsNoteEditorOpen(false);
  }, [annotationArtifactRefs, annotationNote, selectedText, type]);

  const viewportHeight = typeof window === 'undefined' ? 0 : window.innerHeight;
  const viewportWidth = typeof window === 'undefined' ? 0 : window.innerWidth;
  const desktopBoundaryLeft = horizontalBounds ? clamp(horizontalBounds.left, 0, viewportWidth) : 0;
  const desktopBoundaryRight = horizontalBounds
    ? clamp(horizontalBounds.right, desktopBoundaryLeft, viewportWidth)
    : viewportWidth;
  const desktopAvailableWidth = Math.max(
    0,
    desktopBoundaryRight - desktopBoundaryLeft - CONTEXT_MENU_VIEWPORT_PADDING * 2
  );
  const shouldOpenAbove =
    !isMobileSheet &&
    (selectionRect?.top ?? anchorY ?? CONTEXT_MENU_VIEWPORT_PADDING) > viewportHeight / 3;
  const desktopMenuWidth =
    viewportWidth > 0
      ? Math.min(
          CONTEXT_MENU_DESKTOP_MAX_WIDTH,
          Math.max(
            Math.min(CONTEXT_MENU_DESKTOP_MIN_WIDTH, desktopAvailableWidth),
            desktopAvailableWidth
          )
        )
      : CONTEXT_MENU_DESKTOP_MAX_WIDTH;
  const desktopMinLeft = Math.max(
    CONTEXT_MENU_VIEWPORT_PADDING,
    desktopBoundaryLeft + CONTEXT_MENU_VIEWPORT_PADDING
  );
  const desktopMaxLeft = Math.max(
    desktopMinLeft,
    Math.min(
      viewportWidth - desktopMenuWidth - CONTEXT_MENU_VIEWPORT_PADDING,
      desktopBoundaryRight - desktopMenuWidth - CONTEXT_MENU_VIEWPORT_PADDING
    )
  );
  const desktopLeft = clamp(
    (anchorX ?? CONTEXT_MENU_VIEWPORT_PADDING) - desktopMenuWidth / 2,
    desktopMinLeft,
    desktopMaxLeft
  );

  const menuStyle: CSSProperties = isMobileSheet
    ? {
        width: 'min(92vw, 24rem)',
        maxWidth: CONTEXT_MENU_MOBILE_MAX_WIDTH,
        maxHeight: `min(78vh, calc(100vh - 1.5rem - ${keyboardOffset}px))`,
        bottom: `calc(max(1rem, env(safe-area-inset-bottom, 0px)) + ${keyboardOffset}px)`,
      }
    : shouldOpenAbove
      ? {
          bottom: clamp(
            viewportHeight - (anchorY ?? CONTEXT_MENU_VIEWPORT_PADDING) + 14,
            CONTEXT_MENU_VIEWPORT_PADDING,
            Math.max(CONTEXT_MENU_VIEWPORT_PADDING, viewportHeight - CONTEXT_MENU_VIEWPORT_PADDING)
          ),
          left: desktopLeft,
          width: desktopMenuWidth,
        }
      : {
          top: clamp(
            (anchorY ?? CONTEXT_MENU_VIEWPORT_PADDING) + 14,
            CONTEXT_MENU_VIEWPORT_PADDING,
            Math.max(CONTEXT_MENU_VIEWPORT_PADDING, viewportHeight - CONTEXT_MENU_VIEWPORT_PADDING)
          ),
          left: desktopLeft,
          width: desktopMenuWidth,
        };
  const desktopMenuOffset = shouldOpenAbove
    ? typeof menuStyle.bottom === 'number'
      ? menuStyle.bottom
      : CONTEXT_MENU_VIEWPORT_PADDING
    : typeof menuStyle.top === 'number'
      ? menuStyle.top
      : CONTEXT_MENU_VIEWPORT_PADDING;
  const desktopNoteMaxHeight = Math.max(
    0,
    viewportHeight -
      desktopMenuOffset -
      CONTEXT_MENU_VIEWPORT_PADDING -
      CONTEXT_MENU_DESKTOP_CHROME_HEIGHT
  );

  const [transformOrigin] = useState(() => {
    if (isMobileSheet) {
      return 'bottom center';
    }

    const left = typeof menuStyle.left === 'number' ? menuStyle.left : Number.NaN;
    const originX = Number.isFinite(left) && anchorX !== undefined ? anchorX - left : 0;
    const originY =
      'top' in menuStyle && typeof menuStyle.top === 'number'
        ? 0
        : 'bottom' in menuStyle
          ? '100%'
          : 0;

    return `${originX}px ${typeof originY === 'number' ? `${originY}px` : originY}`;
  });

  const highlightButtonClassName = isMobileSheet
    ? 'flex h-11 items-center justify-center gap-2 rounded-full border border-stone-200 bg-white px-4 text-sm font-semibold text-stone-700 shadow-[0_12px_30px_-14px_rgba(34,28,19,0.22),0_6px_14px_-10px_rgba(34,28,19,0.16)] transition-colors hover:bg-amber-50 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-0 dark:border-stone-400 dark:bg-stone-700 dark:text-stone-200 dark:hover:bg-stone-600'
    : 'flex h-[3.3rem] w-[3.3rem] shrink-0 items-center justify-center rounded-full border border-stone-300/95 bg-white text-stone-700 shadow-[0_16px_36px_-16px_rgba(34,28,19,0.28),0_8px_18px_-12px_rgba(34,28,19,0.2),0_0_0_1px_rgba(0,0,0,0.03)] transition-transform duration-200 hover:scale-[1.02] hover:bg-amber-50 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-0 dark:border-stone-400 dark:bg-stone-700 dark:text-stone-200 dark:hover:bg-stone-600';

  const askButtonClassName = isMobileSheet
    ? 'flex h-11 min-w-0 flex-1 items-center justify-center gap-2 rounded-full bg-stone-900 px-4 text-sm font-semibold text-stone-50 transition-colors hover:bg-stone-700 disabled:bg-stone-200 disabled:text-stone-500 dark:bg-stone-100 dark:text-stone-900 dark:hover:bg-white dark:disabled:bg-stone-600 dark:disabled:text-stone-300'
    : 'flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-stone-300/95 bg-stone-900 text-stone-50 shadow-[0_22px_36px_-18px_rgba(34,28,19,0.54),0_8px_14px_-12px_rgba(34,28,19,0.26)] transition-colors hover:bg-stone-700 disabled:border-stone-200 disabled:bg-stone-200 disabled:text-stone-500 dark:border-stone-400/90 dark:bg-stone-100 dark:text-stone-900 dark:hover:bg-white dark:disabled:border-stone-500 dark:disabled:bg-stone-600 dark:disabled:text-stone-300';

  const moreActionsButtonClassName = isMobileSheet
    ? 'flex h-11 items-center justify-center gap-2 rounded-full border border-orange-200 bg-white px-3 text-sm font-semibold text-stone-700 transition-colors hover:bg-orange-50 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-0 dark:border-stone-400 dark:bg-stone-700 dark:text-stone-200 dark:hover:bg-stone-600'
    : 'flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-stone-300/95 bg-white text-stone-700 shadow-[0_20px_34px_-18px_rgba(34,28,19,0.24),0_8px_14px_-12px_rgba(34,28,19,0.16)] transition-colors hover:border-orange-300 hover:bg-orange-50/70 focus-visible:border-orange-400 focus-visible:outline-none focus-visible:ring-0 disabled:opacity-50 dark:border-stone-400 dark:bg-stone-700 dark:text-stone-200 dark:hover:border-orange-700 dark:hover:bg-stone-600';

  const noteButtonClassName = isMobileSheet
    ? 'flex h-11 items-center justify-center gap-2 rounded-full border border-stone-200 bg-white px-3 text-sm font-semibold text-stone-700 transition-colors hover:bg-stone-100 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-0 dark:border-stone-400 dark:bg-stone-700 dark:text-stone-200 dark:hover:bg-stone-600'
    : 'group flex h-10 w-10 shrink-0 items-center justify-start gap-0.5 overflow-hidden rounded-full border border-stone-300/95 bg-white pl-[0.75rem] text-sm font-medium text-stone-700 shadow-[0_20px_34px_-18px_rgba(34,28,19,0.24),0_8px_14px_-12px_rgba(34,28,19,0.16)] transition-[width,padding,background-color,border-color] duration-200 hover:w-[4.65rem] hover:border-stone-400 hover:bg-stone-100/80 hover:pr-0.5 focus-visible:w-[4.65rem] focus-visible:border-stone-400 focus-visible:outline-none focus-visible:ring-0 focus-visible:pr-0.5 disabled:opacity-50 dark:border-stone-400 dark:bg-stone-700 dark:text-stone-200 dark:hover:bg-stone-600';

  const lessonConfirmationClassName = `overflow-hidden rounded-[1.6rem] border border-stone-200/90 bg-[#fbf7ef] text-stone-700 shadow-[0_18px_40px_-30px_rgba(46,34,16,0.55)] transition-all duration-200 dark:border-stone-400/95 dark:bg-stone-700 dark:text-stone-300 ${
    isLessonConfirmOpen
      ? 'mt-2 max-h-56 translate-y-0 opacity-100'
      : 'max-h-0 translate-y-[-6px] opacity-0'
  }`;

  const noteEditorClassName = isMobileSheet
    ? `overflow-hidden text-stone-700 ${isAnnotationMode ? '' : 'transition-all duration-200'} dark:text-stone-300 ${
        isNotePanelVisible
          ? '-mx-[0.9375rem] -mb-[1.0625rem] mt-5 max-h-[min(34rem,calc(100dvh-2rem))] translate-y-0 rounded-[2rem] border border-stone-200/80 bg-stone-50 opacity-100 dark:border-stone-500/70 dark:bg-stone-800'
          : 'max-h-0 translate-y-[-6px] border-t-0 pt-0 opacity-0'
      }`
    : `overflow-hidden rounded-[1.6rem] border border-stone-200/90 bg-stone-50 text-stone-700 shadow-[0_18px_40px_-30px_rgba(46,34,16,0.55)] ${isAnnotationMode ? '' : 'transition-all duration-200'} dark:border-stone-500/80 dark:bg-stone-800 dark:text-stone-300 ${
        isNotePanelVisible
          ? 'mt-3 max-h-[min(34rem,var(--context-menu-note-max-height))] translate-y-0 opacity-100'
          : 'max-h-0 translate-y-[-6px] opacity-0'
      }`;

  const notePreviewClassName = `custom-scrollbar max-h-52 overflow-y-auto ${
    isMobileSheet ? 'px-0 pb-16 pt-3' : 'px-4 pb-16 pt-3'
  } text-sm leading-6 text-stone-800 dark:text-stone-100`;
  const notePreviewFadeColor = isDarkMode ? '#292524' : '#fafaf9';

  const handleNotePreviewScroll = () => {
    const el = notePreviewRef.current;
    if (!el) {
      return;
    }
    setIsNotePreviewScrolled(el.scrollTop > 0);
  };

  useEffect(() => {
    if (notePreviewScrollTopOverride === undefined || !notePreviewRef.current) {
      return;
    }

    notePreviewRef.current.scrollTop = notePreviewScrollTopOverride;
    setIsNotePreviewScrolled(notePreviewScrollTopOverride > 0);
  }, [notePreviewScrollTopOverride]);

  const handleAttachArtifact = (artifact: LearningArtifactRenderPayload) => {
    const artifactRef: SectionAnnotationArtifactRef = {
      artifactId: artifact.summary.id,
      kind: artifact.summary.kind,
      title: artifact.summary.title,
    };
    setLocalAnnotationArtifactRefs(currentRefs =>
      currentRefs.some(ref => ref.artifactId === artifactRef.artifactId)
        ? currentRefs
        : [...currentRefs, artifactRef]
    );
    if (isAnnotationMode) {
      onAttachArtifactToAnnotation?.(artifactRef);
    }
    setIsAttachmentPickerOpen(false);
  };

  const handleDetachArtifact = (artifactId: string) => {
    setLocalAnnotationArtifactRefs(currentRefs =>
      currentRefs.filter(ref => ref.artifactId !== artifactId)
    );
    onDetachArtifactFromAnnotation?.(artifactId);
  };

  const renderAttachedAnnotationArtifacts = () => {
    if (isLessonMode) {
      return null;
    }

    const hasAttachedArtifacts = annotationArtifactPayloads.length > 0;
    if (!hasAttachedArtifacts) {
      return null;
    }

    return (
      <div className="grid gap-2 sm:grid-cols-2">
        {annotationArtifactPayloads.map(artifact => (
          <ChatArtifactRenderer
            key={artifact.summary.id}
            artifacts={[artifact]}
            className="grid gap-2"
            isDarkMode={isDarkMode}
            openArtifactIdOverride={artifactPreviewIdOverride}
            portalContainer={artifactPortalContainer}
            onRemoveArtifact={() => handleDetachArtifact(artifact.summary.id)}
          />
        ))}
      </div>
    );
  };

  const renderAnnotationAttachmentPicker = () => {
    if (isLessonMode || !isAttachmentPickerOpen || attachableArtifactPayloads.length === 0) {
      return null;
    }

    return (
      <div
        className="absolute bottom-[calc(100%+0.5rem)] right-0 z-30 w-[19rem] overflow-hidden rounded-[1.4rem] border border-stone-200 bg-white/95 p-2 shadow-[0_28px_80px_-40px_rgba(24,24,27,0.42)] backdrop-blur dark:border-stone-500 dark:bg-stone-800/95"
        role="menu"
      >
        <div className="max-h-56 overflow-y-auto">
          {attachableArtifactPayloads.map(artifact => (
            <button
              key={artifact.summary.id}
              type="button"
              onClick={() => handleAttachArtifact(artifact)}
              className="flex w-full min-w-0 items-center gap-2 rounded-[1rem] px-3 py-2.5 text-left transition-colors hover:bg-orange-50/80 dark:hover:bg-stone-700/70"
              title={artifact.summary.title}
              aria-label={t('Allega {artifactTitle} alla nota', {
                artifactTitle: artifact.summary.title,
              })}
              role="menuitem"
            >
              <Paperclip className="h-4 w-4 shrink-0 text-orange-600 dark:text-orange-300" />
              <span className="min-w-0 flex-1 truncate text-sm font-medium text-stone-800 dark:text-stone-100">
                {artifact.summary.title}
              </span>
            </button>
          ))}
        </div>
      </div>
    );
  };

  const renderRenderedNotePreview = () => (
    <div className="relative" data-context-menu-target="note-preview">
      <div ref={notePreviewRef} onScroll={handleNotePreviewScroll} className={notePreviewClassName}>
        <div
          style={
            notePreviewScrollTopOverride === undefined
              ? undefined
              : { position: 'relative', top: -notePreviewScrollTopOverride }
          }
        >
          {normalizedNotePreview.trim() ? (
            <MarkdownRenderer
              content={normalizedNotePreview}
              isDarkMode={isDarkMode}
              className="prose-sm text-stone-800 [&_p]:my-0 [&_p+p]:mt-3 [&_ul]:my-2 [&_ol]:my-2 [&_pre]:my-2 [&_table]:text-sm dark:text-stone-100 dark:[&_p]:text-stone-100 dark:[&_li]:text-stone-100 [&_strong]:dark:text-amber-50 [&_code]:dark:text-amber-50 [&_h1]:dark:text-amber-50 [&_h2]:dark:text-amber-50 [&_h3]:dark:text-amber-50 [&_a]:dark:text-orange-400 [&_a]:dark:decoration-orange-400/40"
            />
          ) : null}
          {renderAttachedAnnotationArtifacts()}
        </div>
      </div>
      <div
        className="pointer-events-none absolute left-0 right-0 top-0 h-6 transition-opacity duration-200"
        style={{
          opacity: isNotePreviewScrolled ? 1 : 0,
          background: `linear-gradient(to bottom, ${notePreviewFadeColor}, transparent)`,
        }}
      />
    </div>
  );

  const renderNoteEditor = () => {
    if (isLessonMode) {
      return null;
    }

    if (isAnnotationMode && !isNoteEditorOpen && !hasSavedAnnotationContent) {
      return null;
    }

    return (
      <div className={noteEditorClassName} aria-hidden={!isNoteEditorOpen && !isAnnotationMode}>
        <div
          className={
            isMobileSheet
              ? 'custom-scrollbar m-2 max-h-[calc(min(34rem,calc(100dvh-2rem))-1rem)] space-y-3 overflow-y-auto px-4 py-4'
              : 'custom-scrollbar m-2 max-h-[calc(min(34rem,var(--context-menu-note-max-height))-1rem)] space-y-3 overflow-y-auto px-4 py-3'
          }
        >
          <div className="space-y-1">
            <p className="text-sm font-semibold text-stone-900 text-center dark:text-stone-100">
              {notePanelTitle}
            </p>
          </div>

          {isAnnotationPreviewMode ? (
            renderRenderedNotePreview()
          ) : (
            <div className="rounded-[1.4rem] border border-stone-200/80 p-1.5 transition-colors focus-within:border-stone-300 dark:border-stone-400/95 dark:focus-within:border-stone-400">
              <textarea
                value={noteInput}
                onChange={event => setNoteInput(event.target.value)}
                onFocus={event => {
                  if (!isMobileSheet) return;
                  const target = event.currentTarget;
                  window.setTimeout(() => {
                    target.scrollIntoView({ block: 'center', behavior: 'smooth' });
                  }, 250);
                }}
                placeholder={
                  isAnnotationMode
                    ? t('Scrivi, aggiorna o svuota la nota...')
                    : t('Scrivi la nota che vuoi lasciare su questo passaggio...')
                }
                rows={5}
                className="custom-scrollbar w-full resize-none rounded-[1.4rem] bg-transparent px-4 py-3 text-sm leading-6 text-stone-800 outline-none placeholder:text-stone-400 dark:text-stone-100 dark:placeholder:text-stone-300"
                disabled={isLoading}
              />
            </div>
          )}

          {!isAnnotationPreviewMode ? renderAttachedAnnotationArtifacts() : null}

          <div
            className={`relative flex flex-wrap items-center justify-end gap-2 ${
              isAnnotationPreviewMode
                ? 'sticky bottom-0 z-10 -mx-1 bg-stone-50 px-1 py-1 dark:bg-stone-800'
                : ''
            }`}
          >
            {renderAnnotationAttachmentPicker()}

            {canEditNoteAttachments && attachableArtifactPayloads.length > 0 ? (
              <button
                type="button"
                onClick={() => setIsAttachmentPickerOpen(currentValue => !currentValue)}
                disabled={isLoading}
                className="inline-flex h-9 w-9 items-center justify-center rounded-xl text-stone-500 transition-colors hover:bg-stone-200/60 hover:text-stone-700 disabled:cursor-not-allowed disabled:opacity-45 dark:text-stone-300 dark:hover:bg-stone-600/70 dark:hover:text-stone-100"
                aria-label={t('Allega dagli artefatti')}
                title={t('Allega dagli artefatti')}
              >
                <Paperclip className="h-4 w-4" />
              </button>
            ) : null}

            {!isAnnotationMode || isAnnotationEditingMode ? (
              <button
                type="button"
                onClick={handleCancelNoteEdit}
                className="rounded-full px-3 py-2 text-xs font-semibold text-stone-500 transition-colors hover:bg-stone-200/70 hover:text-stone-700 dark:text-stone-400 dark:hover:bg-stone-700 dark:hover:text-stone-200"
              >
                {t('Annulla')}
              </button>
            ) : null}

            {canDeleteAnnotationFromCurrentState ? (
              <button
                type="button"
                aria-label={t('Rimuovi evidenziazione')}
                onClick={handleDeleteAnnotationClick}
                disabled={isLoading}
                className="inline-flex items-center gap-1 rounded-full border border-stone-200 bg-white px-3 py-2 text-xs font-semibold text-stone-500 transition-colors hover:bg-stone-100 hover:text-stone-700 disabled:opacity-50 dark:border-stone-400/95 dark:bg-stone-700 dark:text-stone-300 dark:hover:bg-stone-600 dark:hover:text-stone-100"
              >
                <X className="h-3.5 w-3.5" />
                <span>{t('Rimuovi')}</span>
              </button>
            ) : null}

            {isAnnotationPreviewMode ? (
              <button
                type="button"
                onClick={handleToggleNoteEditor}
                disabled={isLoading}
                className="rounded-full bg-stone-900 px-4 py-2 text-xs font-semibold text-stone-50 transition-colors hover:bg-stone-700 disabled:bg-stone-200 disabled:text-stone-500 dark:bg-stone-100 dark:text-stone-900 dark:hover:bg-white dark:disabled:bg-stone-700 dark:disabled:text-stone-500"
              >
                {t('Modifica')}
              </button>
            ) : null}

            {!isAnnotationPreviewMode ? (
              <button
                type="button"
                onClick={handleSaveNote}
                disabled={
                  isLoading ||
                  (!isAnnotationMode && !trimmedNote && localAnnotationArtifactRefs.length === 0)
                }
                className="rounded-full bg-stone-900 px-4 py-2 text-xs font-semibold text-stone-50 transition-colors hover:bg-stone-700 disabled:bg-stone-200 disabled:text-stone-500 dark:bg-stone-100 dark:text-stone-900 dark:hover:bg-white dark:disabled:bg-stone-700 dark:disabled:text-stone-500"
              >
                {t(isAnnotationMode ? 'Salva' : 'Salva nota')}
              </button>
            ) : null}
          </div>
        </div>
      </div>
    );
  };

  const renderMoreActionsButton = () =>
    !isLessonMode ? (
      <button
        ref={moreActionsButtonRef}
        type="button"
        onClick={handleToggleMoreActions}
        disabled={isLoading}
        aria-expanded={isMoreActionsOpen}
        aria-haspopup="menu"
        aria-label={t('Apri menu')}
        className={moreActionsButtonClassName}
        title={t('Apri menu')}
      >
        <MoreVertical className="h-4 w-4 shrink-0 text-orange-600" />
      </button>
    ) : null;

  const renderMoreActionsPortal = () => {
    if (!isMoreActionsOpen || !moreActionsMenuStyle || !moreActionsPortalTarget) {
      return null;
    }

    return createPortal(
      <div
        ref={moreActionsMenuRef}
        data-nous-context-menu-portal
        role="menu"
        aria-label={t('Apri menu')}
        className="fixed z-[70] w-52 rounded-2xl border border-stone-200 bg-white p-1.5 shadow-[0_24px_64px_-24px_rgba(28,25,23,0.45)] dark:border-stone-500 dark:bg-stone-800"
        style={moreActionsMenuStyle}
      >
        <button
          ref={moreActionsMenuItemRef}
          type="button"
          role="menuitem"
          onClick={handleCreateIntent}
          className="flex w-full items-center gap-2 rounded-xl px-3 py-2.5 text-left text-sm font-medium text-stone-700 transition-colors hover:bg-orange-50 focus-visible:bg-orange-50 focus-visible:outline-none dark:text-stone-100 dark:hover:bg-stone-700 dark:focus-visible:bg-stone-700"
        >
          <BookPlus className="h-4 w-4 shrink-0 text-orange-600 dark:text-orange-300" />
          <span>{t('Crea lezione')}</span>
        </button>
      </div>,
      moreActionsPortalTarget
    );
  };

  const handleSpeechTranscription = (transcription: string) => {
    setInput(appendSpeechTranscription(displayedInput, transcription));
  };

  const renderSelectionDesktop = () => (
    <div className="space-y-2">
      <div className="flex items-center gap-2.5">
        {!isLessonMode ? (
          <button
            type="button"
            aria-label={t(isAnnotationMode ? 'Rimuovi evidenziazione' : 'Evidenzia selezione')}
            disabled={isLoading}
            onClick={handleHighlightClick}
            className={highlightButtonClassName}
            title={t(
              isAnnotationMode ? 'Rimuovi evidenziazione' : 'Evidenzia il testo selezionato'
            )}
          >
            {isAnnotationMode ? (
              <Eraser className="h-4 w-4 text-stone-600 dark:text-stone-200" />
            ) : (
              <Highlighter className="h-4 w-4 translate-x-px -translate-y-px text-amber-700 dark:text-amber-400" />
            )}
          </button>
        ) : null}

        <form
          className="flex min-w-0 flex-1 items-center gap-1.5 rounded-[1.65rem] border border-stone-200/60 bg-white px-1.5 py-1.5 shadow-[0_8px_20px_-4px_rgba(0,0,0,0.1),0_24px_56px_-16px_rgba(0,0,0,0.18),0_0_0_1px_rgba(0,0,0,0.04)] outline-none focus-within:outline-none focus-within:ring-0 dark:border-stone-400/95 dark:bg-stone-700"
          onSubmit={handleAskSubmit}
        >
          <div className="min-w-0 flex-1">
            <input
              type="text"
              data-context-menu-target="input"
              value={displayedInput}
              onChange={event => setInput(event.target.value)}
              placeholder={askInputPlaceholder}
              className="h-10 w-full min-w-0 border-0 bg-transparent px-3.5 text-sm text-stone-800 placeholder:text-stone-400 outline-none ring-0 focus:outline-none focus:ring-0 focus-visible:outline-none focus-visible:ring-0 disabled:opacity-60 dark:text-stone-100 dark:placeholder:text-stone-300"
              disabled={isLoading}
            />
          </div>

          <SpeechInputButton
            disabled={isLoading}
            onTranscription={handleSpeechTranscription}
            variant="compact"
          />

          <button
            type="submit"
            data-context-menu-target="submit"
            aria-label={t(trimmedInput ? 'Invia domanda' : 'Inserisci una domanda')}
            disabled={!trimmedInput || isLoading}
            className={askButtonClassName}
            title={t(trimmedInput ? 'Invia domanda' : 'Inserisci una domanda')}
          >
            {isLoading ? (
              <LoaderCircle className="h-4 w-4 animate-spin" />
            ) : (
              <ArrowUp className="h-4 w-4" />
            )}
          </button>

          {shouldShowToolbarNoteButton ? (
            <button
              type="button"
              onClick={handleToggleNoteEditor}
              disabled={isLoading}
              className={noteButtonClassName}
              title={
                isAnnotationMode
                  ? t('Aggiungi o modifica una nota su questo passaggio')
                  : t('Aggiungi una nota a questo passaggio')
              }
            >
              <NotebookPen className="h-4 w-4 shrink-0 text-stone-600 transition-none dark:text-stone-200" />
              <span className="max-w-0 overflow-hidden whitespace-nowrap text-left opacity-0 transition-[max-width,opacity] duration-200 group-hover:max-w-[2.45rem] group-hover:opacity-100 group-focus-visible:max-w-[2.45rem] group-focus-visible:opacity-100">
                {t('Nota')}
              </span>
            </button>
          ) : null}

          {renderMoreActionsButton()}
        </form>
      </div>

      <div className={isNotePanelVisible ? 'w-full' : 'pl-[3.375rem]'}>
        {renderNoteEditor()}

        <div className={lessonConfirmationClassName} aria-hidden={!isLessonConfirmOpen}>
          <div className="space-y-2 px-4 py-3">
            <p className="text-sm font-semibold text-stone-900 dark:text-stone-100">
              {t('Vuoi creare una nuova lezione da questa selezione?')}
            </p>
            <p className="text-xs leading-5 text-stone-500 dark:text-stone-400">
              "{lessonSelectionPreview}"
            </p>
            {lessonInstructionPreview ? (
              <p className="text-xs leading-5 text-stone-500 dark:text-stone-400">
                {t('Istruzioni')}: {lessonInstructionPreview}
              </p>
            ) : (
              <p className="text-xs leading-5 text-stone-500 dark:text-stone-400">
                {t('Nessuna istruzione aggiuntiva: verrà usata solo la selezione corrente.')}
              </p>
            )}
            <div className="flex items-center justify-end gap-2 pt-1">
              <button
                ref={lessonCancelButtonRef}
                type="button"
                onClick={handleCancelCreate}
                className="rounded-full px-3 py-2 text-xs font-semibold text-stone-500 transition-colors hover:bg-stone-200/70 hover:text-stone-700 dark:text-stone-400 dark:hover:bg-stone-700 dark:hover:text-stone-200"
              >
                {t('Annulla')}
              </button>
              <button
                type="button"
                onClick={handleCreate}
                disabled={isLoading}
                className="rounded-full bg-orange-600 px-4 py-2 text-xs font-semibold text-white transition-colors hover:bg-orange-700 disabled:opacity-50 dark:bg-orange-500 dark:hover:bg-orange-600"
              >
                {t('Procedi')}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );

  const renderSelectionMobile = () => (
    <>
      <form className="space-y-3" onSubmit={handleAskSubmit}>
        <div className="flex items-center gap-1 rounded-full border border-stone-200/80 bg-stone-50/60 px-1.5 transition-colors focus-within:border-stone-300 focus-within:bg-white dark:border-stone-400/95 dark:bg-stone-700/70 dark:focus-within:bg-stone-700">
          <input
            type="text"
            data-context-menu-target="input"
            value={displayedInput}
            onChange={event => setInput(event.target.value)}
            onFocus={event => {
              const target = event.currentTarget;
              window.setTimeout(() => {
                target.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
              }, 250);
            }}
            placeholder={askInputPlaceholder}
            className="h-11 min-w-0 flex-1 border-0 bg-transparent px-2.5 text-sm text-stone-800 placeholder:text-stone-400 focus:outline-none focus:ring-0 focus-visible:outline-none focus-visible:ring-0 disabled:opacity-60 dark:text-stone-100 dark:placeholder:text-stone-300"
            disabled={isLoading}
          />
          <SpeechInputButton
            disabled={isLoading}
            onTranscription={handleSpeechTranscription}
            variant="compact"
          />
        </div>
        <div className="flex items-center gap-2">
          {!isLessonMode ? (
            <button
              type="button"
              aria-label={t(isAnnotationMode ? 'Rimuovi evidenziazione' : 'Evidenzia selezione')}
              disabled={isLoading}
              onClick={handleHighlightClick}
              onPointerDown={handleHighlightPointerDown}
              onTouchStart={handleHighlightTouchStart}
              className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full border border-stone-200 bg-white text-stone-700 shadow-sm transition-colors hover:bg-amber-50 disabled:opacity-50 dark:border-stone-400 dark:bg-stone-700 dark:text-stone-200 dark:hover:bg-stone-600"
              title={t(
                isAnnotationMode ? 'Rimuovi evidenziazione' : 'Evidenzia il testo selezionato'
              )}
            >
              {isAnnotationMode ? (
                <Eraser className="h-4 w-4 text-stone-600 dark:text-stone-200" />
              ) : (
                <Highlighter className="h-4 w-4 text-amber-500 dark:text-amber-400" />
              )}
            </button>
          ) : null}

          <button
            type="button"
            data-context-menu-target="submit"
            aria-label={t(trimmedInput ? 'Invia domanda' : 'Inserisci una domanda')}
            disabled={!trimmedInput || isLoading}
            onClick={handleAskClick}
            onPointerDown={handleAskPointerDown}
            onTouchStart={handleAskTouchStart}
            className={askButtonClassName}
            title={t(trimmedInput ? 'Invia domanda' : 'Inserisci una domanda')}
          >
            {isLoading ? (
              <LoaderCircle className="h-4 w-4 animate-spin" />
            ) : (
              <ArrowUp className="h-4 w-4" />
            )}
            <span>{t('Chiedi')}</span>
          </button>

          {shouldShowToolbarNoteButton ? (
            <button
              type="button"
              onClick={handleToggleNoteEditor}
              disabled={isLoading}
              className="flex h-11 shrink-0 items-center justify-center gap-2 rounded-full border border-stone-200 bg-white px-3 text-sm font-semibold text-stone-700 transition-colors hover:bg-stone-100 disabled:opacity-50 dark:border-stone-400 dark:bg-stone-700 dark:text-stone-200 dark:hover:bg-stone-600"
              title={
                isAnnotationMode
                  ? t('Aggiungi o modifica una nota su questo passaggio')
                  : t('Aggiungi una nota a questo passaggio')
              }
            >
              <NotebookPen className="h-4 w-4 shrink-0 text-stone-600 dark:text-stone-200" />
              <span className="hidden min-[390px]:inline">{t('Nota')}</span>
            </button>
          ) : null}

          {renderMoreActionsButton()}
        </div>
      </form>

      {renderNoteEditor()}

      <div className={lessonConfirmationClassName} aria-hidden={!isLessonConfirmOpen}>
        <div className="space-y-2 px-4 py-3">
          <p className="text-sm font-semibold text-stone-900 dark:text-stone-100">
            {t('Vuoi creare una nuova lezione da questa selezione?')}
          </p>
          <p className="text-xs leading-5 text-stone-500 dark:text-stone-400">
            "{lessonSelectionPreview}"
          </p>
          {lessonInstructionPreview ? (
            <p className="text-xs leading-5 text-stone-500 dark:text-stone-400">
              {t('Istruzioni')}: {lessonInstructionPreview}
            </p>
          ) : (
            <p className="text-xs leading-5 text-stone-500 dark:text-stone-400">
              {t('Nessuna istruzione aggiuntiva: verrà usata solo la selezione corrente.')}
            </p>
          )}
          <div className="flex items-center justify-end gap-2 pt-1">
            <button
              ref={lessonCancelButtonRef}
              type="button"
              onClick={handleCancelCreate}
              className="rounded-full px-3 py-2 text-xs font-semibold text-stone-500 transition-colors hover:bg-stone-200/70 hover:text-stone-700 dark:text-stone-400 dark:hover:bg-stone-700 dark:hover:text-stone-200"
            >
              {t('Annulla')}
            </button>
            <button
              type="button"
              onClick={handleCreate}
              disabled={isLoading}
              className="rounded-full bg-orange-600 px-4 py-2 text-xs font-semibold text-white transition-colors hover:bg-orange-700 disabled:opacity-50 dark:bg-orange-500 dark:hover:bg-orange-600"
            >
              {t('Procedi')}
            </button>
          </div>
        </div>
      </div>
    </>
  );

  const shouldAnimate = useShouldAnimate();

  return (
    <>
      <motion.div
        ref={containerRef}
        className={`fixed z-50 ${
          isMobileSheet
            ? 'left-1/2 overflow-hidden rounded-[2rem] border border-stone-200/60 bg-white p-3.5 pb-4 shadow-[0_8px_20px_-4px_rgba(0,0,0,0.12),0_24px_56px_-16px_rgba(0,0,0,0.18),0_0_0_1px_rgba(0,0,0,0.04)] dark:border-stone-400/95 dark:bg-stone-700'
            : ''
        }`}
        style={{
          ...menuStyle,
          ...(!isMobileSheet
            ? ({
                '--context-menu-note-max-height': `${desktopNoteMaxHeight}px`,
              } as CSSProperties)
            : null),
          transformOrigin,
          willChange: 'transform, opacity',
          ...(isMobileSheet ? { x: '-50%' } : null),
        }}
        initial={
          shouldAnimate
            ? isMobileSheet
              ? { opacity: 0, y: 12 }
              : { opacity: 0, scale: 0.94 }
            : false
        }
        animate={isMobileSheet ? { opacity: 1, y: 0 } : { opacity: 1, scale: 1 }}
        transition={
          isMobileSheet
            ? { duration: 0.15, ease: [0.2, 0.85, 0.25, 1] }
            : {
                opacity: { duration: 0.1, ease: [0.2, 0.85, 0.25, 1] },
                scale: { duration: 0.12, ease: [0.2, 0.85, 0.25, 1] },
              }
        }
        onPointerDown={handleContainerPointerDown}
      >
        {isMobileSheet ? renderSelectionMobile() : renderSelectionDesktop()}
      </motion.div>
      {renderMoreActionsPortal()}
    </>
  );
};

export default ContextMenu;
