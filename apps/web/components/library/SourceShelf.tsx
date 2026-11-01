import type { SourcePreparationProgress } from '@shared/sourcePreparation';
import { Check, CircleAlert, Paperclip, X } from 'lucide-react';
import { type KeyboardEvent, useEffect, useId, useRef, useState } from 'react';
import { translateUiMessage as t } from '../../i18n/uiMessages.ts';
import { useShouldAnimate } from '../../utils/motion/index.ts';
import './sourceShelf.css';

interface ShelfSource {
  readonly key: string;
  readonly name: string;
  readonly state?: 'idle' | 'reading' | 'done' | 'error';
}

interface SourceShelfProps {
  readonly sources: readonly ShelfSource[];
  readonly onClear?: () => void;
  readonly pending?: boolean;
  readonly warnings?: readonly string[];
  readonly preparationProgress?: SourcePreparationProgress;
  readonly preparationStatus?: string;
}

const COVER_PALETTE = ['cream', 'terracotta', 'sage', 'blue', 'brown', 'mauve'] as const;
const SOURCE_STATE_DESCRIPTION: Partial<
  Record<NonNullable<ShelfSource['state']>, Parameters<typeof t>[0]>
> = {
  done: 'Fonte letta',
  error: 'Fonte non utilizzabile',
};

function useReadingBookReveal(sources: readonly ShelfSource[]) {
  const listRef = useRef<HTMLUListElement>(null);
  const readingKeys = useRef(new Set<string>());
  const shouldAnimate = useShouldAnimate();
  useEffect(() => {
    const previous = readingKeys.current;
    readingKeys.current = new Set(
      sources.filter(source => source.state === 'reading').map(source => source.key)
    );
    const list = listRef.current;
    if (!list) return;
    const listBounds = list.getBoundingClientRect();
    for (const [index, source] of sources.entries()) {
      if (source.state !== 'reading' || previous.has(source.key)) continue;
      const book = list.children[index];
      const bounds = book.getBoundingClientRect();
      if (bounds.left < listBounds.left || bounds.right > listBounds.right)
        book.scrollIntoView({
          block: 'nearest',
          inline: 'nearest',
          behavior: shouldAnimate ? 'smooth' : 'auto',
        });
    }
  }, [sources, shouldAnimate]);
  return listRef;
}

function SourceBookStatus({ state }: { readonly state: ShelfSource['state'] }) {
  if (state !== 'done' && state !== 'error') return null;
  return (
    <span className={state === 'error' ? 'source-book-error' : 'source-book-done'}>
      {state === 'error' ? <CircleAlert /> : <Check />}
    </span>
  );
}

const sourceTitle = (name: string) =>
  name
    .replace(/\.[^.]+$/, '')
    .replaceAll(/[_-]+/g, ' ')
    .trim() || name;

const titleSize = (title: string) => {
  if (title.length > 70) return 'long';
  if (title.length > 36) return 'medium';
  return 'short';
};

function navigateBooks(event: KeyboardEvent<HTMLLIElement>) {
  const book = event.currentTarget;
  const destinations: Record<string, Element | null | undefined> = {
    ArrowRight: book.nextElementSibling,
    ArrowLeft: book.previousElementSibling,
    Home: book.parentElement?.firstElementChild,
    End: book.parentElement?.lastElementChild,
  };
  if (!(event.key in destinations)) return;
  event.preventDefault();
  (destinations[event.key] as HTMLElement | null | undefined)?.focus();
}

function SourceShelfHeader({
  sources,
  onClear,
  pending,
  preparationProgress,
  preparationStatus,
  headingId,
}: Omit<SourceShelfProps, 'warnings'> & { readonly headingId: string }) {
  const completed = sources.filter(
    source => source.state === 'done' || source.state === 'error'
  ).length;
  const reading = sources.some(source => source.state === 'reading');
  const isReading =
    preparationProgress?.step === 'extraction' || preparationProgress?.step === 'pdf-transcription';
  return (
    <div className="source-shelf-header">
      <Paperclip className="source-shelf-icon" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <h3 id={headingId} className="source-shelf-heading">
          {t(preparationProgress ? 'Preparazione delle fonti' : 'Le tue fonti')}
        </h3>
        {sources.length > 0 ? (
          <p className="source-shelf-count">
            {sources.length === 1
              ? t('1 fonte selezionata')
              : t('{count} fonti selezionate', { count: sources.length })}
          </p>
        ) : null}
        {pending ? <output className="mt-1 block text-xs">{t('Verifica dei file…')}</output> : null}
        {preparationProgress ? (
          <output className="mt-1 block text-xs">
            {isReading
              ? t('Lettura fonti {current} di {total}', {
                  current: completed + (reading ? 1 : 0),
                  total: sources.length,
                })
              : preparationStatus}
            {preparationProgress.step === 'pdf-transcription' ? (
              <span className="block">{preparationStatus}</span>
            ) : null}
          </output>
        ) : null}
      </div>
      {onClear && !preparationProgress ? (
        <button
          type="button"
          onClick={onClear}
          className="source-shelf-clear"
          title={t('Rimuovi allegato')}
          aria-label={t('Rimuovi allegato')}
        >
          <X className="h-4 w-4" aria-hidden="true" />
        </button>
      ) : null}
    </div>
  );
}

/** Presentation only: source selection and preparation remain owned by the caller. */
export default function SourceShelf({
  sources,
  onClear,
  pending = false,
  warnings = [],
  preparationProgress,
  preparationStatus,
}: SourceShelfProps) {
  const headingId = useId();
  const bookListRef = useReadingBookReveal(sources);
  const [focusedKey, setFocusedKey] = useState<string>();
  const activeKey = sources.find(source => source.key === focusedKey)?.key ?? sources[0]?.key;
  const hasContent = sources.length > 0 || warnings.length > 0;
  return (
    <section
      className={hasContent ? 'source-shelf' : undefined}
      aria-labelledby={hasContent ? headingId : undefined}
    >
      {hasContent ? (
        <SourceShelfHeader
          sources={sources}
          onClear={onClear}
          pending={pending}
          preparationProgress={preparationProgress}
          preparationStatus={preparationStatus}
          headingId={headingId}
        />
      ) : null}
      {sources.length > 0 ? (
        <div className="source-shelf-edges">
          <ul ref={bookListRef} className="source-shelf-books" aria-labelledby={headingId}>
            {sources.map((source, index) => {
              const description = SOURCE_STATE_DESCRIPTION[source.state ?? 'idle'];
              return (
                // One tab stop; arrow keys browse filenames without delaying access to the composer.
                <li
                  key={source.key}
                  className="source-shelf-item"
                  tabIndex={source.key === activeKey ? 0 : -1}
                  onFocus={() => setFocusedKey(source.key)}
                  onKeyDown={navigateBooks}
                  title={source.name}
                  aria-label={source.name}
                  aria-current={source.state === 'reading' ? 'true' : undefined}
                  aria-description={description ? t(description) : undefined}
                  data-palette={COVER_PALETTE[index % COVER_PALETTE.length]}
                  data-state={source.state ?? 'idle'}
                >
                  <div className="source-book" aria-hidden="true">
                    <div className="source-book-art">
                      <div className="source-book-tint" />
                    </div>
                    <div className="source-book-cover" lang="it">
                      <span className="source-book-index">
                        {String(index + 1).padStart(2, '0')}
                      </span>
                      <span
                        className="source-book-title"
                        data-length={titleSize(sourceTitle(source.name))}
                      >
                        {sourceTitle(source.name)}
                      </span>
                      <span className="source-book-rule" />
                      <span className="source-book-type">
                        {source.name.match(/\.([^.]+)$/)?.[1]}
                      </span>
                    </div>
                    <SourceBookStatus state={source.state} />
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}
      <ul aria-live="polite" className="source-shelf-warnings">
        {Array.from(new Set(warnings)).map(warning => (
          <li key={warning}>{warning}</li>
        ))}
      </ul>
    </section>
  );
}
