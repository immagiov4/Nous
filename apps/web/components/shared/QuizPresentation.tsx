import MarkdownRenderer from './MarkdownRenderer.tsx';

export const QUIZ_FRAME = 'rounded-[2rem] border px-5 py-5 shadow-sm transition-all sm:px-7';
export const QUIZ_UNANSWERED_FRAME =
  'border-orange-200/80 bg-white/95 dark:border-orange-700/60 dark:bg-zinc-900/85';
export const QUIZ_TOPIC =
  'rounded-full bg-orange-100 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-orange-700 dark:bg-orange-900/30 dark:text-orange-300';
export const QUIZ_OPTION =
  'relative block w-full overflow-hidden rounded-xl border p-4 text-left text-base transition-all';
export const QUIZ_UNANSWERED_OPTION =
  'border-gray-200 bg-white text-gray-600 hover:bg-gray-50 dark:border-zinc-600/80 dark:bg-zinc-800 dark:text-gray-300 dark:hover:bg-zinc-700';

/** The corner letter leaves the full option width available after the first line. */
export function QuizOptionContent({
  index,
  text,
  isDarkMode,
}: {
  readonly index: number;
  readonly text: string;
  readonly isDarkMode?: boolean;
}) {
  return (
    <>
      <span className="float-left -ml-4 -mt-4 mb-1 mr-2 flex size-8 items-center justify-center rounded-br-2xl bg-stone-100/80 text-xs font-semibold text-stone-500 dark:bg-zinc-700/70 dark:text-stone-400">
        {String.fromCodePoint(65 + index)}
      </span>
      <div className="min-w-0">
        <MarkdownRenderer
          content={text}
          isDarkMode={isDarkMode}
          className="prose-sm max-w-none [&_p]:!my-0"
        />
      </div>
    </>
  );
}
