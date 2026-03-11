import { useEffect, useRef, useState, type CSSProperties, type FormEvent, type MouseEvent, type PointerEvent } from 'react';
import { Sparkles, X, ArrowRight, BookPlus, Highlighter } from 'lucide-react';

interface ContextMenuProps {
  x: number;
  y: number;
  selectedText: string;
  onClose: () => void;
  onAsk: (question: string) => void;
  onCreateLesson: (instructions: string) => void;
  onHighlight: () => void;
  isLoading: boolean;
}

const ContextMenu = ({ x, y, selectedText, onClose, onAsk, onCreateLesson, onHighlight, isLoading }: ContextMenuProps) => {
  const [input, setInput] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  // Prevent clicks inside the menu from propagating to the global click listener
  const handleContainerPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    e.stopPropagation();
  };

  const handleAsk = (e: FormEvent) => {
    e.preventDefault();
    if ('stopPropagation' in e) {
      e.stopPropagation();
    }
    if (input.trim()) onAsk(input);
  };

  const handleCreate = (e: MouseEvent<HTMLButtonElement>) => {
    e.preventDefault();
    e.stopPropagation();
    onCreateLesson(input);
  };
  
  const handleHighlightClick = (e: MouseEvent<HTMLButtonElement>) => {
    e.preventDefault();
    e.stopPropagation();
    onHighlight();
  };

  // Calculate position to keep it on screen
  const menuStyle: CSSProperties = {
    top: Math.min(y + 10, window.innerHeight - 250),
    left: Math.min(x, window.innerWidth - 350),
  };

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  return (
    <div 
      className="fixed z-50 bg-white dark:bg-zinc-900 rounded-xl shadow-xl border border-gray-200 dark:border-zinc-700 p-4 w-[360px] animate-in fade-in zoom-in-95 duration-200"
      style={menuStyle}
      onPointerDown={handleContainerPointerDown}
    >
      <div className="flex justify-between items-center mb-3">
        <div className="flex items-center gap-2 text-gray-800 dark:text-gray-200 font-bold text-sm tracking-wide">
          <Sparkles className="w-4 h-4 text-orange-500 fill-orange-100" />
          <span>Lumina AI Assistant</span>
        </div>
        <button 
          type="button"
          onClick={(e) => { e.stopPropagation(); onClose(); }} 
          className="text-gray-400 hover:text-gray-700 dark:hover:text-gray-300 hover:bg-gray-100 dark:hover:bg-zinc-800 rounded-full p-1 transition-colors"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      <div className="bg-orange-50/50 dark:bg-orange-900/10 p-3 rounded-lg border border-orange-100/50 dark:border-orange-900/20 mb-4 max-h-24 overflow-y-auto custom-scrollbar">
        <p className="text-xs font-serif italic text-gray-600 dark:text-gray-400 border-l-2 border-orange-300 dark:border-orange-700 pl-2">
          "{selectedText}"
        </p>
      </div>

      <div className="relative group space-y-3">
        <input
          ref={inputRef}
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Istruzioni o Domanda..."
          className="w-full px-3 py-3 bg-white dark:bg-zinc-800 border border-gray-300 dark:border-zinc-700 rounded-lg text-sm text-gray-900 dark:text-white placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-orange-500/20 focus:border-orange-500 shadow-sm transition-all"
          disabled={isLoading}
        />
        
        <div className="grid grid-cols-2 gap-2 pt-1">
          <button 
            type="button"
            onClick={handleAsk}
            disabled={!input.trim() || isLoading}
            className="col-span-2 flex items-center justify-center gap-2 px-3 py-2 bg-gray-100 dark:bg-zinc-800 text-gray-700 dark:text-gray-300 text-xs font-semibold rounded-lg hover:bg-gray-200 dark:hover:bg-zinc-700 disabled:opacity-50 transition-colors"
          >
            <ArrowRight className="w-3.5 h-3.5" />
            Chiedi Spiegazione
          </button>
          
          <button 
            type="button"
            onClick={handleHighlightClick}
            disabled={isLoading}
            className="flex items-center justify-center gap-2 px-3 py-2 bg-yellow-100 dark:bg-yellow-900/30 text-yellow-700 dark:text-yellow-400 text-xs font-semibold rounded-lg hover:bg-yellow-200 dark:hover:bg-yellow-900/50 disabled:opacity-50 transition-colors"
            title="Evidenzia il testo selezionato"
          >
            <Highlighter className="w-3.5 h-3.5" />
            Evidenzia
          </button>

          <button 
            type="button"
            onClick={handleCreate}
            disabled={isLoading}
            className="flex items-center justify-center gap-2 px-3 py-2 bg-orange-600 text-white text-xs font-semibold rounded-lg hover:bg-orange-700 disabled:opacity-50 shadow-sm hover:shadow transition-all"
            title="Crea una nuova lezione dedicata a questo punto nel menu a sinistra"
          >
            <BookPlus className="w-3.5 h-3.5" />
            Crea Lezione
          </button>
        </div>
      </div>
      
      {isLoading && (
        <div className="mt-3 flex items-center gap-2 text-xs text-orange-600 dark:text-orange-400 animate-pulse font-medium justify-center">
          <div className="w-1.5 h-1.5 rounded-full bg-orange-600 dark:bg-orange-400 animate-bounce"></div>
          <div className="w-1.5 h-1.5 rounded-full bg-orange-600 dark:bg-orange-400 animate-bounce delay-75"></div>
          <div className="w-1.5 h-1.5 rounded-full bg-orange-600 dark:bg-orange-400 animate-bounce delay-150"></div>
          Elaborazione richiesta...
        </div>
      )}
    </div>
  );
};

export default ContextMenu;
