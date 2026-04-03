import { ArrowUp, BookPlus, Check, Loader2, Paperclip, Plus, Sparkles, X } from 'lucide-react';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { HomeChatToolPreferences, Message } from '../../types';
import MarkdownRenderer from '../shared/MarkdownRenderer';

interface HomeChatPanelProps {
  assessmentComplete: boolean;
  isDarkMode: boolean;
  isLoading: boolean;
  loadingStatus: string;
  messages: Message[];
  pendingFileName: string | null;
  onClearPendingFile: () => void;
  onConfirmGenerate: () => void;
  onSendMessage: (
    message: string,
    options?: { toolPreferences?: HomeChatToolPreferences }
  ) => Promise<void>;
  onUploadSourceClick: () => void;
}

const HomeChatPanel = ({
  assessmentComplete,
  isDarkMode,
  isLoading,
  loadingStatus,
  messages,
  pendingFileName,
  onClearPendingFile,
  onConfirmGenerate,
  onSendMessage,
  onUploadSourceClick,
}: HomeChatPanelProps) => {
  const [input, setInput] = useState('');
  const [isToolMenuOpen, setIsToolMenuOpen] = useState(false);
  const [toolPreferences, setToolPreferences] = useState<HomeChatToolPreferences>({
    newCourse: false,
  });
  const inputRef = useRef<HTMLInputElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const toolMenuRef = useRef<HTMLDivElement>(null);
  const lastMessage = messages[messages.length - 1] || null;

  useEffect(() => {
    if (!lastMessage && !isLoading && !assessmentComplete) {
      return;
    }

    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [assessmentComplete, isLoading, lastMessage]);

  useEffect(() => {
    if (!isToolMenuOpen) {
      return;
    }

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node) || toolMenuRef.current?.contains(target)) {
        return;
      }

      setIsToolMenuOpen(false);
    };

    document.addEventListener('pointerdown', handlePointerDown, true);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown, true);
    };
  }, [isToolMenuOpen]);

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    const submittedInput = input.trim();
    if (!submittedInput) {
      return;
    }

    setInput('');
    setIsToolMenuOpen(false);
    await onSendMessage(submittedInput, { toolPreferences });
  };

  const toggleNewCoursePreference = () => {
    setToolPreferences(currentPreferences => ({
      ...currentPreferences,
      newCourse: !currentPreferences.newCourse,
    }));
  };

  const hasMessages = messages.length > 0;

  return (
    <section className="overflow-hidden rounded-3xl border border-gray-300/70 bg-white dark:border-zinc-600/50 dark:bg-stone-800">
      <div className="max-h-[26rem] overflow-y-auto px-4 py-4 sm:px-5">
        <div className="space-y-4">
          {!hasMessages ? (
            <div className="flex min-h-[10rem] flex-col items-center justify-center px-4 py-6 text-center sm:min-h-[12rem]">
              <p className="font-serif text-xl text-gray-400 dark:text-zinc-500 sm:text-2xl">
                Cosa vorresti imparare?
              </p>
              <p className="mt-2 max-w-xl text-sm text-gray-500 dark:text-zinc-400">
                Allega materiale se vuoi, poi scrivi il tuo obiettivo e invia tutto nello stesso messaggio.
              </p>
            </div>
          ) : null}

          {messages.map((message, index) => (
            <div
              key={`${message.role}-${index}`}
              className={`flex ${message.role === 'user' ? 'justify-end' : 'justify-start'}`}
            >
              <div
                className={`max-w-[85%] rounded-2xl px-4 py-3 text-sm leading-relaxed ${
                  message.role === 'user'
                    ? 'rounded-br-md bg-stone-900 text-white dark:bg-stone-100 dark:text-stone-900'
                    : 'rounded-bl-md border border-gray-200 bg-gray-50/80 text-gray-800 dark:border-zinc-600/50 dark:bg-stone-700 dark:text-zinc-100'
                }`}
              >
                <MarkdownRenderer
                  content={message.text.replace('[ASSESSMENT_COMPLETE]', '')}
                  isDarkMode={isDarkMode}
                  className={message.role === 'user' ? 'prose-sm prose-invert max-w-none' : 'prose-sm max-w-none dark:prose-invert'}
                />
              </div>
            </div>
          ))}

          {isLoading ? (
            <div className="flex justify-start">
              <div className="flex items-center gap-2 rounded-2xl border border-gray-200 bg-gray-50/80 px-4 py-3 text-sm text-gray-600 dark:border-zinc-600/50 dark:bg-stone-700 dark:text-zinc-300">
                <Loader2 className="h-4 w-4 animate-spin text-orange-500" />
                {loadingStatus}
              </div>
            </div>
          ) : null}

          {assessmentComplete && !isLoading ? (
            <div className="flex flex-col items-center gap-3 rounded-2xl border border-amber-200/80 bg-amber-50/60 px-5 py-4 dark:border-amber-700/40 dark:bg-amber-950/20">
              <p className="text-center text-sm font-medium text-amber-800 dark:text-amber-200">
                Ho raccolto tutte le informazioni necessarie. Vuoi generare il corso?
              </p>
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={onConfirmGenerate}
                  className="inline-flex items-center gap-2 rounded-xl bg-amber-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-amber-700 dark:bg-amber-500 dark:hover:bg-amber-600"
                >
                  <Sparkles className="h-4 w-4" />
                  Sì, genera il corso
                </button>
                <button
                  type="button"
                  onClick={() => inputRef.current?.focus()}
                  className="rounded-xl border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 transition-colors hover:border-gray-400 hover:bg-gray-50 dark:border-zinc-600 dark:bg-stone-700 dark:text-zinc-200 dark:hover:border-zinc-500 dark:hover:bg-stone-600"
                >
                  No, voglio aggiungere...
                </button>
              </div>
            </div>
          ) : null}

          <div ref={messagesEndRef} />
        </div>
      </div>

      <div className="border-t border-gray-100 px-4 pb-4 pt-3 dark:border-zinc-700/50">
        {pendingFileName ? (
          <div className="mb-3 flex items-center justify-between gap-3 rounded-2xl border border-gray-200 bg-gray-50/80 px-3 py-2 text-sm text-gray-600 dark:border-zinc-600/50 dark:bg-stone-700 dark:text-zinc-300">
            <div className="flex min-w-0 items-center gap-2">
              <Paperclip className="h-4 w-4 shrink-0" />
              <span className="truncate">{pendingFileName}</span>
            </div>
            {!hasMessages ? (
              <button
                type="button"
                onClick={onClearPendingFile}
                className="flex h-7 w-7 items-center justify-center rounded-full text-gray-400 transition-colors hover:bg-gray-200 hover:text-gray-600 dark:hover:bg-stone-600 dark:hover:text-zinc-100"
                title="Rimuovi allegato"
              >
                <X className="h-4 w-4" />
              </button>
            ) : null}
          </div>
        ) : null}

        <form
          onSubmit={handleSubmit}
          className="flex items-center gap-1.5 rounded-2xl border border-gray-200 bg-gray-50/50 px-2 py-1.5 transition-colors focus-within:border-gray-300 focus-within:bg-white dark:border-zinc-600/40 dark:bg-stone-700/40 dark:focus-within:border-zinc-500 dark:focus-within:bg-stone-700"
        >
          <button
            type="button"
            onClick={onUploadSourceClick}
            disabled={hasMessages}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl text-gray-400 transition-colors hover:bg-gray-200/60 hover:text-gray-600 disabled:cursor-not-allowed disabled:opacity-45 dark:text-zinc-500 dark:hover:bg-zinc-600/60 dark:hover:text-zinc-300"
            title="Allega un file sorgente (PDF, ZIP, testo)"
          >
            <Paperclip className="h-[1.1rem] w-[1.1rem]" />
          </button>

          <div ref={toolMenuRef} className="relative flex shrink-0 items-center">
            <button
              type="button"
              onClick={() => setIsToolMenuOpen(currentValue => !currentValue)}
              className={`flex h-8 w-8 items-center justify-center rounded-xl transition-colors ${
                toolPreferences.newCourse
                  ? 'bg-orange-100 text-orange-700 hover:bg-orange-200 dark:bg-orange-500/15 dark:text-orange-200 dark:hover:bg-orange-500/25'
                  : 'text-gray-400 hover:bg-gray-200/60 hover:text-gray-600 dark:text-zinc-500 dark:hover:bg-zinc-600/60 dark:hover:text-zinc-300'
              }`}
              title="Apri strumenti conversazione"
              aria-expanded={isToolMenuOpen}
              aria-haspopup="menu"
            >
              <Plus className="h-[1.1rem] w-[1.1rem]" />
            </button>

            {isToolMenuOpen ? (
              <div
                className="absolute bottom-[calc(100%+0.55rem)] left-0 z-20 w-[min(18rem,calc(100vw-3rem))] overflow-hidden rounded-2xl border border-gray-200/90 bg-white/95 p-2 shadow-[0_18px_50px_-24px_rgba(24,24,27,0.4)] dark:border-zinc-600/80 dark:bg-stone-800/95"
                role="menu"
              >
                <button
                  type="button"
                  onClick={toggleNewCoursePreference}
                  className="flex w-full items-start gap-3 rounded-xl px-3 py-2.5 text-left transition-colors hover:bg-gray-100/80 dark:hover:bg-stone-700/80"
                  role="menuitemcheckbox"
                  aria-checked={toolPreferences.newCourse}
                >
                  <span
                    className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-md border ${
                      toolPreferences.newCourse
                        ? 'border-orange-500 bg-orange-500 text-white dark:border-orange-400 dark:bg-orange-400 dark:text-stone-900'
                        : 'border-gray-300 text-transparent dark:border-zinc-500'
                    }`}
                  >
                    <Check className="h-3.5 w-3.5" />
                  </span>
                  <span className="min-w-0">
                    <span className="flex items-center gap-2 text-sm font-medium text-gray-800 dark:text-zinc-100">
                      <BookPlus className="h-4 w-4 shrink-0 text-orange-600 dark:text-orange-300" />
                      Nuovo corso
                    </span>
                    <span className="mt-1 block text-xs leading-5 text-gray-500 dark:text-zinc-400">
                      Segnala al modello che questa conversazione serve a impostare un nuovo corso.
                    </span>
                  </span>
                </button>
              </div>
            ) : null}
          </div>

          <input
            ref={inputRef}
            type="text"
            value={input}
            onChange={event => setInput(event.target.value)}
            placeholder={assessmentComplete ? 'Aggiungi dettagli o requisiti...' : 'Descrivi un argomento o allega un file...'}
            className="min-w-0 flex-1 bg-transparent px-1 py-1.5 text-sm text-gray-800 outline-none placeholder:text-gray-400 dark:text-zinc-100 dark:placeholder:text-zinc-500"
            disabled={isLoading}
          />

          <button
            type="submit"
            disabled={isLoading || !input.trim()}
            className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-xl transition-colors ${
              isLoading
                ? 'bg-orange-500 text-white'
                : 'bg-gray-900 text-white hover:bg-black disabled:bg-gray-200 disabled:text-gray-400 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-white dark:disabled:bg-zinc-700 dark:disabled:text-zinc-500'
            }`}
            title="Inizia"
          >
            {isLoading ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <ArrowUp className="h-4 w-4" />
            )}
          </button>
        </form>

        {toolPreferences.newCourse ? (
          <div className="mt-2 flex flex-wrap gap-2">
            <span className="inline-flex items-center gap-2 rounded-full border border-orange-200 bg-orange-50/80 px-3 py-1.5 text-xs font-medium text-orange-700 dark:border-orange-500/40 dark:bg-orange-500/10 dark:text-orange-200">
              <BookPlus className="h-3.5 w-3.5" />
              Nuovo corso attivo
            </span>
          </div>
        ) : null}
      </div>
    </section>
  );
};

export default HomeChatPanel;
