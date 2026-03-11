import type { FormEvent, RefObject } from 'react';
import { BrainCircuit } from 'lucide-react';
import { ASSESSMENT_MIN_TURNS } from '../constants';
import type { Message } from '../types';
import MarkdownRenderer from './MarkdownRenderer';

interface AssessmentViewProps {
  assessmentInputId: string;
  assessmentInputRef: RefObject<HTMLInputElement | null>;
  currentAssessmentInput: string;
  isDarkMode: boolean;
  isLoading: boolean;
  loadingStatus: string;
  messages: Message[];
  messagesEndRef: RefObject<HTMLDivElement | null>;
  onBackToLibrary: () => void;
  onInputChange: (value: string) => void;
  onSubmit: (event: FormEvent) => void;
}

const AssessmentView = ({
  assessmentInputId,
  assessmentInputRef,
  currentAssessmentInput,
  isDarkMode,
  isLoading,
  loadingStatus,
  messages,
  messagesEndRef,
  onBackToLibrary,
  onInputChange,
  onSubmit,
}: AssessmentViewProps) => (
  <div className="min-h-screen w-full flex flex-col items-center justify-center bg-paper-light dark:bg-paper-dark p-4 font-sans transition-colors duration-300">
    <div className="max-w-3xl w-full bg-white dark:bg-zinc-900 rounded-2xl shadow-xl border border-gray-100 dark:border-zinc-800 overflow-hidden flex flex-col h-[80vh]">
      <div className="p-6 border-b border-gray-100 dark:border-zinc-800 bg-orange-50 dark:bg-zinc-900 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <BrainCircuit className="w-6 h-6 text-orange-600" />
          <div>
            <h2 className="text-lg font-semibold text-gray-800 dark:text-gray-200">Calibrazione Conoscenze</h2>
            <p className="text-xs text-gray-500 dark:text-gray-400">Analisi approfondita per contenuti densi</p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <div className="text-xs font-mono text-orange-600 bg-orange-100 dark:bg-orange-900/30 px-2 py-1 rounded">
            Turno {messages.filter(message => message.role === 'user').length + 1} / {ASSESSMENT_MIN_TURNS}
          </div>
          <button
            type="button"
            onClick={onBackToLibrary}
            className="inline-flex items-center justify-center rounded-full border border-gray-200 bg-white px-3 py-1.5 text-xs font-semibold uppercase tracking-[0.16em] text-gray-600 transition-colors hover:border-gray-300 hover:text-gray-900 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:border-zinc-600 dark:hover:text-white"
          >
            Libreria
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-6 space-y-6">
        {messages.map((message) => {
          const displayContent = message.text.replace('[ASSESSMENT_COMPLETE]', '');

          return (
            <div key={`${message.role}-${displayContent.slice(0, 48)}`} className={`flex ${message.role === 'user' ? 'justify-end' : 'justify-start'}`}>
              <div
                className={`max-w-[85%] p-5 rounded-2xl text-sm leading-relaxed shadow-sm ${
                  message.role === 'user'
                    ? 'bg-orange-600 text-white rounded-br-none'
                    : 'bg-white dark:bg-zinc-800 border border-gray-100 dark:border-zinc-700 text-gray-800 dark:text-gray-200 rounded-bl-none'
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
            <div className="bg-white dark:bg-zinc-800 border border-gray-100 dark:border-zinc-700 p-4 rounded-2xl rounded-bl-none w-auto flex gap-2 items-center text-sm text-gray-500 dark:text-gray-400 shadow-sm">
              <div className="w-2 h-2 bg-orange-400 rounded-full animate-bounce" style={{ animationDelay: '0ms' }}></div>
              <div className="w-2 h-2 bg-orange-400 rounded-full animate-bounce" style={{ animationDelay: '150ms' }}></div>
              <div className="w-2 h-2 bg-orange-400 rounded-full animate-bounce" style={{ animationDelay: '300ms' }}></div>
              <span>{loadingStatus}</span>
            </div>
          </div>
        ) : null}
        <div ref={messagesEndRef} />
      </div>

      <form onSubmit={onSubmit} className="p-4 border-t border-gray-100 dark:border-zinc-800 bg-white dark:bg-zinc-900">
        <div className="flex gap-2">
          <input
            id={assessmentInputId}
            ref={assessmentInputRef}
            type="text"
            value={currentAssessmentInput}
            onChange={(event) => onInputChange(event.target.value)}
            placeholder="Scrivi la tua risposta dettagliata..."
            className="flex-1 p-4 border border-gray-200 dark:border-zinc-700 rounded-xl focus:outline-none focus:ring-2 focus:ring-orange-200 dark:focus:ring-orange-900 bg-gray-50 dark:bg-zinc-800 text-gray-900 dark:text-white placeholder-gray-400 transition-all focus:bg-white dark:focus:bg-zinc-800"
            disabled={isLoading}
          />
          <button
            type="submit"
            disabled={isLoading || !currentAssessmentInput.trim()}
            className="bg-orange-600 text-white px-8 py-3 rounded-xl font-medium hover:bg-orange-700 disabled:opacity-50 transition-all shadow-md hover:shadow-lg disabled:shadow-none"
          >
            Invia
          </button>
        </div>
      </form>
    </div>
  </div>
);

export default AssessmentView;
