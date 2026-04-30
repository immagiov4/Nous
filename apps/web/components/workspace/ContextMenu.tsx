import { motion } from 'framer-motion';
import { ArrowUp, BookPlus, Highlighter, LoaderCircle, NotebookPen, X } from 'lucide-react';
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
import type { ContextMenuPlacement, HorizontalViewportBounds, SelectionRect } from '../../types';
import { normalizeMarkdownForRendering } from '../../utils/markdown/render.ts';
import { useShouldAnimate } from '../../utils/motion/useShouldAnimate.ts';
import MarkdownRenderer from '../shared/MarkdownRenderer.tsx';

interface ContextMenuProps {
  anchorX?: number;
  anchorY?: number;
  annotationNote?: string;
  containerRef?: RefObject<HTMLDivElement | null>;
  horizontalBounds?: HorizontalViewportBounds;
  isDarkMode?: boolean;
  isLoading: boolean;
  onAsk: (question: string) => void;
  onClose: () => void;
  onCreateLesson: (instructions: string) => void;
  onDeleteAnnotation: () => void;
  onHighlight: () => void;
  onSaveNote: (note: string) => void;
  placement: ContextMenuPlacement;
  selectionRect?: SelectionRect;
  selectedText: string;
  type: 'annotation' | 'selection';
}

const CONTEXT_MENU_DESKTOP_MAX_WIDTH = 460;
const CONTEXT_MENU_DESKTOP_MIN_WIDTH = 320;
const CONTEXT_MENU_DESKTOP_SAFE_HEIGHT = 120;
const CONTEXT_MENU_MOBILE_MAX_WIDTH = 384;
const CONTEXT_MENU_VIEWPORT_PADDING = 12;

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
  annotationNote = '',
  containerRef,
  horizontalBounds,
  isDarkMode = false,
  isLoading,
  onAsk,
  onClose,
  onCreateLesson,
  onDeleteAnnotation,
  onHighlight,
  onSaveNote,
  placement,
  selectionRect,
  selectedText,
  type,
}: ContextMenuProps) => {
  const [input, setInput] = useState('');
  const [noteInput, setNoteInput] = useState(annotationNote);
  const [isLessonConfirmOpen, setIsLessonConfirmOpen] = useState(false);
  const [isNoteEditorOpen, setIsNoteEditorOpen] = useState(
    type === 'annotation' ? annotationNote.trim().length === 0 : false
  );
  const askInteractionLockRef = useRef(false);
  const highlightInteractionLockRef = useRef(false);
  const previousMenuKeyRef = useRef(`${type}:${selectedText}:${annotationNote}`);
  const isMobileSheet = placement === 'mobile-sheet';
  const isAnnotationMode = type === 'annotation';
  const hasSavedAnnotationNote = annotationNote.trim().length > 0;
  const trimmedInput = input.trim();
  const trimmedNote = noteInput.trim();
  const isAnnotationPreviewMode = isAnnotationMode && hasSavedAnnotationNote && !isNoteEditorOpen;
  const isAnnotationEditingMode = isAnnotationMode && !isAnnotationPreviewMode;
  const canDeleteAnnotationFromCurrentState =
    isAnnotationMode && (isAnnotationPreviewMode || !hasSavedAnnotationNote);
  const lessonSelectionPreview = abbreviate(selectedText, 120);
  const lessonInstructionPreview = trimmedInput ? abbreviate(trimmedInput, 120) : null;
  const noteSelectionPreview = abbreviate(selectedText, 180);
  const normalizedNotePreview = useMemo(
    () => normalizeMarkdownForRendering(noteInput),
    [noteInput]
  );

  const handleContainerPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    event.stopPropagation();
  };

  const submitAsk = () => {
    if (!trimmedInput || isAnnotationMode) {
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
    if (highlightInteractionLockRef.current || isAnnotationMode) {
      return;
    }
    highlightInteractionLockRef.current = true;
    onHighlight();
    window.setTimeout(() => {
      highlightInteractionLockRef.current = false;
    }, 400);
  };

  const handleHighlightPointerDown = (event: PointerEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    if (highlightInteractionLockRef.current || isAnnotationMode) {
      return;
    }
    highlightInteractionLockRef.current = true;
    onHighlight();
    window.setTimeout(() => {
      highlightInteractionLockRef.current = false;
    }, 400);
  };

  const handleHighlightTouchStart = (event: TouchEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    if (highlightInteractionLockRef.current || isAnnotationMode) {
      return;
    }
    highlightInteractionLockRef.current = true;
    onHighlight();
    window.setTimeout(() => {
      highlightInteractionLockRef.current = false;
    }, 400);
  };

  const handleCreateIntent = (event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    setIsNoteEditorOpen(false);
    setIsLessonConfirmOpen(currentValue => !currentValue);
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
    onCreateLesson(input);
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

    if (!isAnnotationMode && !trimmedNote) {
      return;
    }

    onSaveNote(noteInput);
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

      onClose();
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [onClose]);

  useEffect(() => {
    const nextMenuKey = `${type}:${selectedText}:${annotationNote}`;
    if (previousMenuKeyRef.current === nextMenuKey) {
      return;
    }

    previousMenuKeyRef.current = nextMenuKey;
    setIsLessonConfirmOpen(false);
    setNoteInput(annotationNote);
    setIsNoteEditorOpen(type === 'annotation' ? annotationNote.trim().length === 0 : false);
  }, [annotationNote, selectedText, type]);

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
        maxHeight: 'min(78vh, calc(100vh - 1.5rem))',
        bottom: 'max(1rem, env(safe-area-inset-bottom, 0px))',
      }
    : shouldOpenAbove
      ? {
          bottom: clamp(
            viewportHeight - (anchorY ?? CONTEXT_MENU_VIEWPORT_PADDING) + 14,
            CONTEXT_MENU_VIEWPORT_PADDING,
            Math.max(
              CONTEXT_MENU_VIEWPORT_PADDING,
              viewportHeight - CONTEXT_MENU_DESKTOP_SAFE_HEIGHT
            )
          ),
          left: desktopLeft,
          width: desktopMenuWidth,
        }
      : {
          top: clamp(
            (anchorY ?? CONTEXT_MENU_VIEWPORT_PADDING) + 14,
            CONTEXT_MENU_VIEWPORT_PADDING,
            Math.max(
              CONTEXT_MENU_VIEWPORT_PADDING,
              viewportHeight - CONTEXT_MENU_DESKTOP_SAFE_HEIGHT
            )
          ),
          left: desktopLeft,
          width: desktopMenuWidth,
        };

  const highlightButtonClassName = isMobileSheet
    ? 'flex h-11 items-center justify-center gap-2 rounded-full border border-stone-200 bg-white px-4 text-sm font-semibold text-stone-700 shadow-[0_12px_30px_-14px_rgba(34,28,19,0.22),0_6px_14px_-10px_rgba(34,28,19,0.16)] transition-colors hover:bg-amber-50 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-0 dark:border-stone-400 dark:bg-stone-700 dark:text-stone-200 dark:hover:bg-stone-600'
    : 'flex h-[3.3rem] w-[3.3rem] shrink-0 items-center justify-center rounded-full border border-stone-300/95 bg-white text-stone-700 shadow-[0_16px_36px_-16px_rgba(34,28,19,0.28),0_8px_18px_-12px_rgba(34,28,19,0.2),0_0_0_1px_rgba(0,0,0,0.03)] transition-transform duration-200 hover:scale-[1.02] hover:bg-amber-50 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-0 dark:border-stone-400 dark:bg-stone-700 dark:text-stone-200 dark:hover:bg-stone-600';

  const askButtonClassName = isMobileSheet
    ? 'flex h-11 items-center justify-center gap-2 rounded-full bg-stone-900 px-4 text-sm font-semibold text-stone-50 transition-colors hover:bg-stone-700 disabled:bg-stone-200 disabled:text-stone-500 dark:bg-stone-100 dark:text-stone-900 dark:hover:bg-white dark:disabled:bg-stone-700 dark:disabled:text-stone-500'
    : 'flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-stone-300/95 bg-stone-900 text-stone-50 shadow-[0_22px_36px_-18px_rgba(34,28,19,0.54),0_8px_14px_-12px_rgba(34,28,19,0.26)] transition-colors hover:bg-stone-700 disabled:border-stone-200 disabled:bg-stone-200 disabled:text-stone-500 dark:border-stone-400/90 dark:bg-stone-100 dark:text-stone-900 dark:hover:bg-white dark:disabled:border-stone-600 dark:disabled:bg-stone-700 dark:disabled:text-stone-500';

  const lessonButtonClassName = isMobileSheet
    ? 'flex h-11 items-center justify-center gap-2 rounded-full border border-orange-200 bg-white px-3 text-sm font-semibold text-stone-700 transition-colors hover:bg-orange-50 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-0 dark:border-stone-400 dark:bg-stone-700 dark:text-stone-200 dark:hover:bg-stone-600'
    : 'group flex h-10 w-10 shrink-0 items-center justify-start gap-1 overflow-hidden rounded-full border border-stone-300/95 bg-white pl-[0.75rem] text-sm font-medium text-stone-700 shadow-[0_20px_34px_-18px_rgba(34,28,19,0.24),0_8px_14px_-12px_rgba(34,28,19,0.16)] transition-[width,padding,background-color,border-color] duration-200 hover:w-[7.4rem] hover:border-orange-300 hover:bg-orange-50/70 hover:pr-1.5 focus-visible:w-[7.4rem] focus-visible:border-orange-400 focus-visible:outline-none focus-visible:ring-0 focus-visible:pr-1.5 disabled:opacity-50 dark:border-stone-400 dark:bg-stone-700 dark:text-stone-200 dark:hover:border-orange-700 dark:hover:bg-stone-600';

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
        isNoteEditorOpen || isAnnotationMode
          ? `${isAnnotationMode ? 'mt-0 max-h-[25rem] translate-y-0 border-t-0 pt-0 opacity-100' : 'mt-3 max-h-[25rem] translate-y-0 border-t border-stone-200/80 pt-3 opacity-100 dark:border-stone-400/70'}`
          : 'max-h-0 translate-y-[-6px] border-t-0 pt-0 opacity-0'
      }`
    : `overflow-hidden rounded-[1.6rem] border border-stone-200/90 bg-[#fbf7ef] text-stone-700 shadow-[0_18px_40px_-30px_rgba(46,34,16,0.55)] ${isAnnotationMode ? '' : 'transition-all duration-200'} dark:border-stone-400/95 dark:bg-stone-700 dark:text-stone-300 ${
        isNoteEditorOpen || isAnnotationMode
          ? 'mt-2 max-h-[25rem] translate-y-0 opacity-100'
          : 'max-h-0 translate-y-[-6px] opacity-0'
      }`;

  const notePreviewClassName =
    'max-h-52 overflow-y-auto rounded-[1.4rem] border border-stone-200/80 bg-white px-4 py-3 text-sm leading-6 text-stone-800 dark:border-stone-400/95 dark:bg-stone-700/80 dark:text-stone-100';

  const renderRenderedNotePreview = () => (
    <div className={notePreviewClassName}>
      <MarkdownRenderer
        content={normalizedNotePreview}
        isDarkMode={isDarkMode}
        className="prose-sm text-stone-800 [&_p]:my-0 [&_p+p]:mt-3 [&_ul]:my-2 [&_ol]:my-2 [&_pre]:my-2 [&_table]:text-sm dark:text-stone-100"
      />
    </div>
  );

  const renderNoteEditor = () => (
    <div className={noteEditorClassName} aria-hidden={!isNoteEditorOpen && !isAnnotationMode}>
      <div className={isMobileSheet ? 'space-y-3 px-0 py-0' : 'space-y-3 px-4 py-3'}>
        <div className="space-y-1.5">
          <p className="text-sm font-semibold text-stone-900 dark:text-stone-100">
            {isAnnotationMode
              ? 'Nota associata al passaggio evidenziato'
              : 'Aggiungi una nota a questa selezione'}
          </p>
          <p className="text-xs leading-5 text-stone-500 dark:text-stone-400">
            "{noteSelectionPreview}"
          </p>
        </div>

        {isAnnotationPreviewMode ? (
          renderRenderedNotePreview()
        ) : (
          <textarea
            value={noteInput}
            onChange={event => setNoteInput(event.target.value)}
            placeholder={
              isAnnotationMode
                ? 'Scrivi, aggiorna o svuota la nota...'
                : 'Scrivi la nota che vuoi lasciare su questo passaggio...'
            }
            rows={4}
            className="w-full resize-none rounded-[1.4rem] border border-stone-200/80 bg-white px-4 py-3 text-sm leading-6 text-stone-800 outline-none transition-colors placeholder:text-stone-400 focus:border-stone-300 dark:border-stone-400/95 dark:bg-stone-700/80 dark:text-stone-100 dark:placeholder:text-stone-300 dark:focus:border-stone-400"
            disabled={isLoading}
          />
        )}

        <div className="flex flex-wrap items-center justify-end gap-2">
          {!isAnnotationMode ? (
            <button
              type="button"
              onClick={() => setIsNoteEditorOpen(false)}
              className="rounded-full px-3 py-2 text-xs font-semibold text-stone-500 transition-colors hover:bg-stone-200/70 hover:text-stone-700 dark:text-stone-400 dark:hover:bg-stone-700 dark:hover:text-stone-200"
            >
              Annulla
            </button>
          ) : null}

          {isAnnotationEditingMode && hasSavedAnnotationNote ? (
            <button
              type="button"
              onClick={handleCancelNoteEdit}
              className="rounded-full px-3 py-2 text-xs font-semibold text-stone-500 transition-colors hover:bg-stone-200/70 hover:text-stone-700 dark:text-stone-400 dark:hover:bg-stone-700 dark:hover:text-stone-200"
            >
              Annulla
            </button>
          ) : null}

          {canDeleteAnnotationFromCurrentState ? (
            <button
              type="button"
              onClick={handleDeleteAnnotationClick}
              disabled={isLoading}
              className="inline-flex items-center gap-1 rounded-full border border-stone-200 bg-white px-3 py-2 text-xs font-semibold text-stone-500 transition-colors hover:bg-stone-100 hover:text-stone-700 disabled:opacity-50 dark:border-stone-400/95 dark:bg-stone-700 dark:text-stone-300 dark:hover:bg-stone-600 dark:hover:text-stone-100"
            >
              <X className="h-3.5 w-3.5" />
              <span>Rimuovi evidenziazione</span>
            </button>
          ) : null}

          {isAnnotationPreviewMode ? (
            <button
              type="button"
              onClick={handleToggleNoteEditor}
              disabled={isLoading}
              className="rounded-full bg-stone-900 px-4 py-2 text-xs font-semibold text-stone-50 transition-colors hover:bg-stone-700 disabled:bg-stone-200 disabled:text-stone-500 dark:bg-stone-100 dark:text-stone-900 dark:hover:bg-white dark:disabled:bg-stone-700 dark:disabled:text-stone-500"
            >
              Modifica
            </button>
          ) : null}

          {!isAnnotationPreviewMode ? (
            <button
              type="button"
              onClick={handleSaveNote}
              disabled={isLoading || (!isAnnotationMode && !trimmedNote)}
              className="rounded-full bg-stone-900 px-4 py-2 text-xs font-semibold text-stone-50 transition-colors hover:bg-stone-700 disabled:bg-stone-200 disabled:text-stone-500 dark:bg-stone-100 dark:text-stone-900 dark:hover:bg-white dark:disabled:bg-stone-700 dark:disabled:text-stone-500"
            >
              {isAnnotationMode ? 'Salva' : 'Salva nota'}
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );

  const renderSelectionDesktop = () => (
    <div className="space-y-2">
      <div className="flex items-center gap-2.5">
        <button
          type="button"
          aria-label="Evidenzia selezione"
          disabled={isLoading}
          onClick={handleHighlightClick}
          className={highlightButtonClassName}
          title="Evidenzia il testo selezionato"
        >
          <Highlighter className="h-4 w-4 translate-x-px -translate-y-px text-amber-700 dark:text-amber-400" />
        </button>

        <form
          className="flex min-w-0 flex-1 items-center gap-1.5 rounded-[1.65rem] border border-stone-200/60 bg-white px-1.5 py-1.5 shadow-[0_8px_20px_-4px_rgba(0,0,0,0.1),0_24px_56px_-16px_rgba(0,0,0,0.18),0_0_0_1px_rgba(0,0,0,0.04)] outline-none focus-within:outline-none focus-within:ring-0 dark:border-stone-400/95 dark:bg-stone-700"
          onSubmit={handleAskSubmit}
        >
          <div className="min-w-0 flex-1">
            <input
              type="text"
              value={input}
              onChange={event => setInput(event.target.value)}
              placeholder="Chiedi a Nous o aggiungi istruzioni"
              className="h-10 w-full min-w-0 border-0 bg-transparent px-3.5 text-sm text-stone-800 placeholder:text-stone-400 outline-none ring-0 focus:outline-none focus:ring-0 focus-visible:outline-none focus-visible:ring-0 disabled:opacity-60 dark:text-stone-100 dark:placeholder:text-stone-300"
              disabled={isLoading}
            />
          </div>

          <button
            type="submit"
            aria-label={trimmedInput ? 'Invia domanda' : 'Inserisci una domanda'}
            disabled={!trimmedInput || isLoading}
            className={askButtonClassName}
            title={trimmedInput ? 'Invia domanda' : 'Inserisci una domanda'}
          >
            {isLoading ? (
              <LoaderCircle className="h-4 w-4 animate-spin" />
            ) : (
              <ArrowUp className="h-4 w-4" />
            )}
          </button>

          <button
            type="button"
            onClick={handleToggleNoteEditor}
            disabled={isLoading}
            className={noteButtonClassName}
            title="Aggiungi una nota a questo passaggio"
          >
            <NotebookPen className="h-4 w-4 shrink-0 text-stone-600 transition-none dark:text-stone-200" />
            <span className="max-w-0 overflow-hidden whitespace-nowrap text-left opacity-0 transition-[max-width,opacity] duration-200 group-hover:max-w-[2.45rem] group-hover:opacity-100 group-focus-visible:max-w-[2.45rem] group-focus-visible:opacity-100">
              Nota
            </span>
          </button>

          <button
            type="button"
            onClick={handleCreateIntent}
            disabled={isLoading}
            className={lessonButtonClassName}
            title="Crea una nuova lezione dedicata a questo punto nel menu a sinistra"
          >
            <BookPlus className="h-4 w-4 shrink-0 text-orange-600 transition-none" />
            <span className="max-w-0 overflow-hidden whitespace-nowrap text-left opacity-0 transition-[max-width,opacity] duration-200 group-hover:max-w-[5.8rem] group-hover:opacity-100 group-focus-visible:max-w-[5.8rem] group-focus-visible:opacity-100">
              Crea lezione
            </span>
          </button>
        </form>
      </div>

      <div className="pl-[3.375rem]">
        {renderNoteEditor()}

        <div className={lessonConfirmationClassName} aria-hidden={!isLessonConfirmOpen}>
          <div className="space-y-2 px-4 py-3">
            <p className="text-sm font-semibold text-stone-900 dark:text-stone-100">
              Vuoi creare una nuova lezione da questa selezione?
            </p>
            <p className="text-xs leading-5 text-stone-500 dark:text-stone-400">
              "{lessonSelectionPreview}"
            </p>
            {lessonInstructionPreview ? (
              <p className="text-xs leading-5 text-stone-500 dark:text-stone-400">
                Istruzioni: {lessonInstructionPreview}
              </p>
            ) : (
              <p className="text-xs leading-5 text-stone-500 dark:text-stone-400">
                Nessuna istruzione aggiuntiva: verrà usata solo la selezione corrente.
              </p>
            )}
            <div className="flex items-center justify-end gap-2 pt-1">
              <button
                type="button"
                onClick={handleCancelCreate}
                className="rounded-full px-3 py-2 text-xs font-semibold text-stone-500 transition-colors hover:bg-stone-200/70 hover:text-stone-700 dark:text-stone-400 dark:hover:bg-stone-700 dark:hover:text-stone-200"
              >
                Annulla
              </button>
              <button
                type="button"
                onClick={handleCreate}
                disabled={isLoading}
                className="rounded-full bg-orange-600 px-4 py-2 text-xs font-semibold text-white transition-colors hover:bg-orange-700 disabled:opacity-50 dark:bg-orange-500 dark:hover:bg-orange-600"
              >
                Procedi
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
        <input
          type="text"
          value={input}
          onChange={event => setInput(event.target.value)}
          placeholder="Chiedi a Nous o aggiungi istruzioni"
          className="h-11 w-full rounded-full border border-stone-200/80 bg-stone-50/60 px-4 text-sm text-stone-800 transition-all placeholder:text-stone-400 focus:border-stone-300 focus:bg-white focus:outline-none focus:ring-0 focus-visible:outline-none focus-visible:ring-0 disabled:opacity-60 dark:border-stone-400/95 dark:bg-stone-700/70 dark:text-stone-100 dark:placeholder:text-stone-300 dark:focus:border-stone-400/95 dark:focus:bg-stone-700"
          disabled={isLoading}
        />
        <div className="flex items-center gap-2">
          <button
            type="button"
            aria-label="Evidenzia selezione"
            disabled={isLoading}
            onClick={handleHighlightClick}
            onPointerDown={handleHighlightPointerDown}
            onTouchStart={handleHighlightTouchStart}
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full border border-stone-200 bg-white text-stone-700 shadow-sm transition-colors hover:bg-amber-50 disabled:opacity-50 dark:border-stone-400 dark:bg-stone-700 dark:text-stone-200 dark:hover:bg-stone-600"
            title="Evidenzia il testo selezionato"
          >
            <Highlighter className="h-4 w-4 text-amber-500 dark:text-amber-400" />
          </button>

          <button
            type="button"
            aria-label={trimmedInput ? 'Invia domanda' : 'Inserisci una domanda'}
            disabled={!trimmedInput || isLoading}
            onClick={handleAskClick}
            onPointerDown={handleAskPointerDown}
            onTouchStart={handleAskTouchStart}
            className="flex h-11 min-w-0 flex-1 items-center justify-center gap-2 rounded-full bg-stone-900 px-4 text-sm font-semibold text-stone-50 transition-colors hover:bg-stone-700 disabled:bg-stone-200 disabled:text-stone-500 dark:bg-stone-100 dark:text-stone-900 dark:hover:bg-white dark:disabled:bg-stone-700 dark:disabled:text-stone-500"
            title={trimmedInput ? 'Invia domanda' : 'Inserisci una domanda'}
          >
            {isLoading ? (
              <LoaderCircle className="h-4 w-4 animate-spin" />
            ) : (
              <ArrowUp className="h-4 w-4" />
            )}
            <span>Chiedi</span>
          </button>

          <button
            type="button"
            onClick={handleToggleNoteEditor}
            disabled={isLoading}
            className="flex h-11 shrink-0 items-center justify-center gap-2 rounded-full border border-stone-200 bg-white px-3 text-sm font-semibold text-stone-700 transition-colors hover:bg-stone-100 disabled:opacity-50 dark:border-stone-400 dark:bg-stone-700 dark:text-stone-200 dark:hover:bg-stone-600"
            title="Aggiungi una nota a questo passaggio"
          >
            <NotebookPen className="h-4 w-4 shrink-0 text-stone-600 dark:text-stone-200" />
            <span className="hidden min-[390px]:inline">Nota</span>
          </button>

          <button
            type="button"
            onClick={handleCreateIntent}
            disabled={isLoading}
            className="flex h-11 shrink-0 items-center justify-center gap-2 rounded-full border border-orange-200 bg-white px-3 text-sm font-semibold text-stone-700 transition-colors hover:bg-orange-50 disabled:opacity-50 dark:border-stone-400 dark:bg-stone-700 dark:text-stone-200 dark:hover:bg-stone-600"
            title="Crea una nuova lezione dedicata a questo punto"
          >
            <BookPlus className="h-4 w-4 shrink-0 text-orange-600" />
            <span className="hidden min-[420px]:inline">Lezione</span>
          </button>
        </div>
      </form>

      {renderNoteEditor()}

      <div className={lessonConfirmationClassName} aria-hidden={!isLessonConfirmOpen}>
        <div className="space-y-2 px-4 py-3">
          <p className="text-sm font-semibold text-stone-900 dark:text-stone-100">
            Vuoi creare una nuova lezione da questa selezione?
          </p>
          <p className="text-xs leading-5 text-stone-500 dark:text-stone-400">
            "{lessonSelectionPreview}"
          </p>
          {lessonInstructionPreview ? (
            <p className="text-xs leading-5 text-stone-500 dark:text-stone-400">
              Istruzioni: {lessonInstructionPreview}
            </p>
          ) : (
            <p className="text-xs leading-5 text-stone-500 dark:text-stone-400">
              Nessuna istruzione aggiuntiva: verrà usata solo la selezione corrente.
            </p>
          )}
          <div className="flex items-center justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={handleCancelCreate}
              className="rounded-full px-3 py-2 text-xs font-semibold text-stone-500 transition-colors hover:bg-stone-200/70 hover:text-stone-700 dark:text-stone-400 dark:hover:bg-stone-700 dark:hover:text-stone-200"
            >
              Annulla
            </button>
            <button
              type="button"
              onClick={handleCreate}
              disabled={isLoading}
              className="rounded-full bg-orange-600 px-4 py-2 text-xs font-semibold text-white transition-colors hover:bg-orange-700 disabled:opacity-50 dark:bg-orange-500 dark:hover:bg-orange-600"
            >
              Procedi
            </button>
          </div>
        </div>
      </div>
    </>
  );

  const renderAnnotationBody = () => <div className="space-y-2">{renderNoteEditor()}</div>;

  const shouldAnimate = useShouldAnimate();

  // Origin for the pop-in morph. On desktop we morph from the cursor's
  // click point; on the mobile sheet we slide up from the bottom center.
  const transformOrigin: string = isMobileSheet
    ? 'bottom center'
    : (() => {
        const left = typeof menuStyle.left === 'number' ? menuStyle.left : Number.NaN;
        const originX = Number.isFinite(left) && anchorX !== undefined ? anchorX - left : 0;
        const originY =
          'top' in menuStyle && typeof menuStyle.top === 'number'
            ? 0
            : 'bottom' in menuStyle
              ? '100%'
              : 0;
        return `${originX}px ${typeof originY === 'number' ? `${originY}px` : originY}`;
      })();

  return (
    <motion.div
      ref={containerRef}
      className={`fixed z-50 ${
        isMobileSheet
          ? 'left-1/2 rounded-[2rem] border border-stone-200/60 bg-white p-3.5 pb-4 shadow-[0_8px_20px_-4px_rgba(0,0,0,0.12),0_24px_56px_-16px_rgba(0,0,0,0.18),0_0_0_1px_rgba(0,0,0,0.04)] dark:border-stone-400/95 dark:bg-stone-700'
          : ''
      }`}
      style={{
        ...menuStyle,
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
      {isAnnotationMode
        ? renderAnnotationBody()
        : isMobileSheet
          ? renderSelectionMobile()
          : renderSelectionDesktop()}
    </motion.div>
  );
};

export default ContextMenu;
