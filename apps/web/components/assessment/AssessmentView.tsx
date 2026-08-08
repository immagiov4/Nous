import { ArrowLeft, BrainCircuit, Sparkles } from 'lucide-react';
import type { FormEvent, RefObject } from 'react';
import { translateUiMessage as t } from '../../i18n/uiMessages.ts';
import type { Message } from '../../types';
import MarkdownRenderer from '../shared/MarkdownRenderer';

interface AssessmentViewProps {
  readonly assessmentInputId: string;
  readonly assessmentInputRef: RefObject<HTMLInputElement | null>;
  readonly currentAssessmentInput: string;
  readonly hasCourseProposal: boolean;
  readonly isDarkMode: boolean;
  readonly isLoading: boolean;
  readonly loadingStatus: string;
  readonly messages: Message[];
  readonly messagesEndRef: RefObject<HTMLDivElement | null>;
  readonly onBackToLibrary: () => void;
  readonly onCancelAssessment: () => void;
  readonly onConfirmGenerate: () => void;
  readonly onInputChange: (value: string) => void;
  readonly onSubmit: (event: FormEvent) => void;
}

const AssessmentView = ({
  assessmentInputId,
  assessmentInputRef,
  currentAssessmentInput,
  hasCourseProposal,
  isDarkMode,
  isLoading,
  loadingStatus,
  messages,
  messagesEndRef,
  onBackToLibrary,
  onCancelAssessment,
  onConfirmGenerate,
  onInputChange,
  onSubmit,
}: AssessmentViewProps) => {
  const showTips = messages.length <= 1;
  const messageKeyCounts = new Map<string, number>();
  const tips = [
    t('Parla del tuo livello reale, non di quello ideale.'),
    t('Scrivi cosa vuoi saper fare alla fine del percorso.'),
    t('Se vuoi esempi, codice o analogie, dillo subito.'),
  ];

  return (
    <div className="flex min-h-screen flex-col bg-paper-light font-sans transition-colors duration-300 dark:bg-paper-dark">
      {/* Compact top bar */}
      <header className="border-b border-gray-200/80 bg-white/90 px-4 py-3 backdrop-blur-sm dark:border-zinc-700/80 dark:bg-paper-surface/90 sm:px-6">
        <div className="mx-auto flex max-w-3xl items-center gap-4">
          <button
            type="button"
            onClick={onBackToLibrary}
            className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-xs font-medium text-gray-600 transition-colors hover:border-gray-300 hover:text-gray-900 dark:border-zinc-600/80 dark:bg-paper-surface dark:text-zinc-400 dark:hover:border-zinc-500 dark:hover:text-white"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            {t('Libreria')}
          </button>

          <div className="flex flex-1 items-center gap-3">
            <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-orange-600 text-white">
              <BrainCircuit className="h-3.5 w-3.5" />
            </div>
            <span className="text-sm font-medium text-gray-900 dark:text-zinc-100">
              {t('Calibrazione')}
            </span>
          </div>

          <div className="rounded-full border border-orange-200 bg-orange-50 px-2.5 py-1 text-[11px] font-semibold text-orange-700 dark:border-orange-900/60 dark:bg-orange-950/30 dark:text-orange-300">
            {hasCourseProposal ? t('Proposta pronta') : t('Intervista in corso')}
          </div>
          <button
            type="button"
            onClick={onCancelAssessment}
            className="text-xs font-medium text-gray-500 transition-colors hover:text-red-600 dark:text-zinc-400 dark:hover:text-red-400"
          >
            {t('Annulla creazione corso')}
          </button>
        </div>
      </header>

      {/* Chat area */}
      <div className="flex-1 overflow-y-auto px-4 py-6 sm:px-6">
        <div className="mx-auto max-w-3xl space-y-5">
          {/* Inline tips — shown only at the start */}
          {showTips ? (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-xl border border-gray-200 bg-gray-50 px-4 py-3 text-xs text-gray-600 dark:border-zinc-700/80 dark:bg-paper-surface dark:text-zinc-400">
              <Sparkles className="h-3.5 w-3.5 text-orange-400" />
              {tips.map((tip, i) => (
                <span key={tip} className="inline-flex items-center gap-1.5">
                  {i > 0 ? (
                    <span className="text-gray-300 dark:text-zinc-700">&middot;</span>
                  ) : null}
                  {tip}
                </span>
              ))}
            </div>
          ) : null}

          {messages.map(message => {
            const displayContent = message.text;
            const messageSignature = `${message.role}:${displayContent}`;
            const occurrenceCount = (messageKeyCounts.get(messageSignature) ?? 0) + 1;

            messageKeyCounts.set(messageSignature, occurrenceCount);

            return (
              <div
                key={`${messageSignature}:${occurrenceCount}`}
                className={`flex ${message.role === 'user' ? 'justify-end' : 'justify-start'}`}
              >
                <div
                  className={`max-w-[85%] rounded-2xl px-5 py-4 text-sm leading-relaxed ${
                    message.role === 'user'
                      ? 'rounded-br-md bg-orange-600 text-white'
                      : 'rounded-bl-md border border-gray-200 bg-white text-gray-800 dark:border-zinc-700/80 dark:bg-paper-surface dark:text-gray-200'
                  }`}
                >
                  <MarkdownRenderer
                    content={displayContent}
                    isDarkMode={isDarkMode}
                    className={`prose-sm ${
                      message.role === 'user'
                        ? 'prose-invert marker:text-white/70 prose-p:text-white prose-headings:text-white prose-strong:text-white prose-a:text-white prose-code:text-white'
                        : 'dark:prose-invert prose-p:text-gray-800 dark:prose-p:text-gray-200 prose-headings:text-gray-900 dark:prose-headings:text-white prose-strong:text-orange-700 dark:prose-strong:text-orange-400'
                    }`}
                  />
                </div>
              </div>
            );
          })}

          {isLoading ? (
            <div className="flex justify-start">
              <div className="flex items-center gap-2 rounded-2xl border border-gray-200 bg-white px-4 py-3 text-sm text-gray-600 dark:border-zinc-700/80 dark:bg-paper-surface dark:text-zinc-400">
                <div
                  className="h-1.5 w-1.5 animate-bounce rounded-full bg-orange-400"
                  style={{ animationDelay: '0ms' }}
                />
                <div
                  className="h-1.5 w-1.5 animate-bounce rounded-full bg-orange-400"
                  style={{ animationDelay: '150ms' }}
                />
                <div
                  className="h-1.5 w-1.5 animate-bounce rounded-full bg-orange-400"
                  style={{ animationDelay: '300ms' }}
                />
                <span className="ml-1">{loadingStatus}</span>
              </div>
            </div>
          ) : null}
          <div ref={messagesEndRef} />
        </div>
      </div>

      {/* Input pinned to bottom */}
      <div className="border-t border-gray-200/80 bg-white/96 px-4 py-3 backdrop-blur-sm dark:border-zinc-700/80 dark:bg-paper-surface/95 sm:px-6">
        {hasCourseProposal && !isLoading ? (
          <div className="mx-auto mb-3 flex max-w-3xl flex-col items-center gap-3 rounded-2xl border border-amber-200/80 bg-amber-50/60 px-5 py-4 dark:border-amber-700/40 dark:bg-amber-950/20">
            <p className="text-center text-sm font-medium text-amber-800 dark:text-amber-200">
              {t('Ho raccolto tutte le informazioni necessarie. Vuoi generare il corso?')}
            </p>
            <button
              type="button"
              onClick={onConfirmGenerate}
              className="inline-flex items-center gap-2 rounded-xl bg-amber-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-amber-700 dark:bg-amber-500 dark:hover:bg-amber-600"
            >
              <Sparkles className="h-4 w-4" />
              {t('Sì, genera il corso')}
            </button>
          </div>
        ) : null}
        <form onSubmit={onSubmit} className="mx-auto flex max-w-3xl gap-3">
          <input
            id={assessmentInputId}
            ref={assessmentInputRef}
            type="text"
            value={currentAssessmentInput}
            onChange={event => onInputChange(event.target.value)}
            placeholder={
              hasCourseProposal
                ? t('Aggiungi altri dettagli…')
                : t('Descrivi obiettivi, livello e come preferisci imparare…')
            }
            className="flex-1 rounded-xl border border-gray-200 bg-[#fcfaf6] px-4 py-3 text-sm text-gray-900 outline-none transition-colors focus:border-orange-300 dark:border-zinc-600/80 dark:bg-paper-surface dark:text-white dark:focus:border-orange-800"
            disabled={isLoading}
          />
          <button
            type="submit"
            disabled={isLoading || !currentAssessmentInput.trim()}
            className="rounded-xl bg-orange-600 px-5 py-3 text-sm font-medium text-white transition-colors hover:bg-orange-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {hasCourseProposal ? t('Aggiungi dettagli') : t('Invia')}
          </button>
        </form>
      </div>
    </div>
  );
};

export default AssessmentView;
