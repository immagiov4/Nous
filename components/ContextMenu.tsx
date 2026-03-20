import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
  type MouseEvent,
  type PointerEvent,
  type RefObject,
} from 'react';
import { Sparkles, X, ArrowRight, BookPlus, Highlighter } from 'lucide-react';
import type { ContextMenuPlacement } from '../types';

interface ContextMenuProps {
  anchorX?: number;
  anchorY?: number;
  containerRef?: RefObject<HTMLDivElement | null>;
  isLoading: boolean;
  onAsk: (question: string) => void;
  onClose: () => void;
  onCreateLesson: (instructions: string) => void;
  onHighlight: () => void;
  placement: ContextMenuPlacement;
  selectedText: string;
}

const CONTEXT_MENU_DESKTOP_WIDTH = 360;
const CONTEXT_MENU_MOBILE_MAX_WIDTH = 384;
const CONTEXT_MENU_VIEWPORT_PADDING = 12;

const clamp = (value: number, min: number, max: number) => {
  return Math.min(Math.max(value, min), max);
};

const ContextMenu = ({
  anchorX,
  anchorY,
  containerRef,
  isLoading,
  onAsk,
  onClose,
  onCreateLesson,
  onHighlight,
  placement,
  selectedText,
}: ContextMenuProps) => {
  const [input, setInput] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const isMobileSheet = placement === 'mobile-sheet';

  const handleContainerPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    event.stopPropagation();
  };

  const submitAsk = () => {
    const nextQuestion = input.trim();
    if (nextQuestion) {
      onAsk(nextQuestion);
    }
  };

  const handleAskSubmit = (event: FormEvent) => {
    event.preventDefault();
    if ('stopPropagation' in event) {
      event.stopPropagation();
    }
    submitAsk();
  };

  const handleHighlightClick = (event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    onHighlight();
  };

  const handleCreate = (event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    onCreateLesson(input);
  };

  const menuStyle: CSSProperties = isMobileSheet
    ? {
        width: 'min(92vw, 24rem)',
        maxWidth: CONTEXT_MENU_MOBILE_MAX_WIDTH,
        maxHeight: 'min(78vh, calc(100vh - 1.5rem))',
        bottom: 'max(1rem, env(safe-area-inset-bottom, 0px))',
      }
    : {
        top: clamp(
          (anchorY ?? CONTEXT_MENU_VIEWPORT_PADDING) + 10,
          CONTEXT_MENU_VIEWPORT_PADDING,
          window.innerHeight - 250
        ),
        left: clamp(
          anchorX ?? CONTEXT_MENU_VIEWPORT_PADDING,
          CONTEXT_MENU_VIEWPORT_PADDING,
          window.innerWidth - CONTEXT_MENU_DESKTOP_WIDTH - CONTEXT_MENU_VIEWPORT_PADDING
        ),
        width: CONTEXT_MENU_DESKTOP_WIDTH,
      };

  useEffect(() => {
    if (!isMobileSheet) {
      inputRef.current?.focus();
    }
  }, [isMobileSheet]);

  return (
    <div
      ref={containerRef}
      className={`fixed z-50 overflow-hidden border border-gray-200 bg-white shadow-xl animate-in duration-200 dark:border-zinc-700 dark:bg-zinc-900 ${
        isMobileSheet
          ? 'left-1/2 rounded-3xl p-4 pb-5 -translate-x-1/2 slide-in-from-bottom-10'
          : 'rounded-xl p-4 fade-in zoom-in-95'
      }`}
      style={menuStyle}
      onPointerDown={handleContainerPointerDown}
    >
      <div className="flex items-center justify-between gap-3 mb-3">
        <div className="flex items-center gap-2 text-sm font-bold tracking-wide text-gray-800 dark:text-gray-200">
          <Sparkles className="h-4 w-4 fill-orange-100 text-orange-500" />
          <span>Lumina AI Assistant</span>
        </div>
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            onClose();
          }}
          className="rounded-full p-1 text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-700 dark:hover:bg-zinc-800 dark:hover:text-gray-300"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="mb-4 max-h-28 overflow-y-auto rounded-lg border border-orange-100/50 bg-orange-50/50 p-3 dark:border-orange-900/20 dark:bg-orange-900/10">
        <p className="border-l-2 border-orange-300 pl-2 font-serif text-xs italic text-gray-600 dark:border-orange-700 dark:text-gray-400">
          "{selectedText}"
        </p>
      </div>

      <form className="relative space-y-3" onSubmit={handleAskSubmit}>
        <input
          ref={inputRef}
          type="text"
          value={input}
          onChange={(event) => setInput(event.target.value)}
          placeholder="Istruzioni o Domanda..."
          className="w-full rounded-lg border border-gray-300 bg-white px-3 py-3 text-sm text-gray-900 shadow-sm transition-all placeholder:text-gray-400 focus:border-orange-500 focus:outline-none focus:ring-2 focus:ring-orange-500/20 disabled:opacity-60 dark:border-zinc-700 dark:bg-zinc-800 dark:text-white"
          disabled={isLoading}
        />

        <div className="grid grid-cols-2 gap-2 pt-1">
          <button
            type="submit"
            disabled={!input.trim() || isLoading}
            className="col-span-2 flex items-center justify-center gap-2 rounded-lg bg-gray-100 px-3 py-2 text-xs font-semibold text-gray-700 transition-colors hover:bg-gray-200 disabled:opacity-50 dark:bg-zinc-800 dark:text-gray-300 dark:hover:bg-zinc-700"
          >
            <ArrowRight className="h-3.5 w-3.5" />
            Chiedi Spiegazione
          </button>

          <button
            type="button"
            onClick={handleHighlightClick}
            disabled={isLoading}
            className="flex items-center justify-center gap-2 rounded-lg bg-yellow-100 px-3 py-2 text-xs font-semibold text-yellow-700 transition-colors hover:bg-yellow-200 disabled:opacity-50 dark:bg-yellow-900/30 dark:text-yellow-400 dark:hover:bg-yellow-900/50"
            title="Evidenzia il testo selezionato"
          >
            <Highlighter className="h-3.5 w-3.5" />
            Evidenzia
          </button>

          <button
            type="button"
            onClick={handleCreate}
            disabled={isLoading}
            className="flex items-center justify-center gap-2 rounded-lg bg-orange-600 px-3 py-2 text-xs font-semibold text-white shadow-sm transition-all hover:bg-orange-700 hover:shadow disabled:opacity-50"
            title="Crea una nuova lezione dedicata a questo punto nel menu a sinistra"
          >
            <BookPlus className="h-3.5 w-3.5" />
            Crea Lezione
          </button>
        </div>
      </form>

      {isLoading ? (
        <div className="mt-3 flex items-center justify-center gap-2 text-xs font-medium text-orange-600 animate-pulse dark:text-orange-400">
          <div className="h-1.5 w-1.5 animate-bounce rounded-full bg-orange-600 dark:bg-orange-400"></div>
          <div className="h-1.5 w-1.5 animate-bounce rounded-full bg-orange-600 delay-75 dark:bg-orange-400"></div>
          <div className="h-1.5 w-1.5 animate-bounce rounded-full bg-orange-600 delay-150 dark:bg-orange-400"></div>
          Elaborazione richiesta...
        </div>
      ) : null}
    </div>
  );
};

export default ContextMenu;
