import type { SourcePreparationProgress } from '@shared/sourcePreparation';
import { Check, CircleAlert, Paperclip, X } from 'lucide-react';
import { type KeyboardEvent, useEffect, useId, useRef, useState } from 'react';
import { translateUiMessage as t } from '../../i18n/uiMessages.ts';
import { glideScrollBy } from '../../utils/motion/glideScroll.ts';
import { useShouldAnimate } from '../../utils/motion/index.ts';
import SourceBookPreparationArt, {
  PREPARATION_PALETTE,
  sourcePreparationPoster,
} from './SourceBookPreparationArt.tsx';
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

const SOURCE_STATE_DESCRIPTION: Partial<
  Record<NonNullable<ShelfSource['state']>, Parameters<typeof t>[0]>
> = {
  done: 'Fonte letta',
  error: 'Fonte non utilizzabile',
};

function useReadingBookReveal(sources: readonly ShelfSource[], readingKey: string | undefined) {
  const listRef = useRef<HTMLUListElement>(null);
  const previousKey = useRef<string | undefined>(undefined);
  const shouldAnimate = useShouldAnimate();
  useEffect(() => {
    const previous = previousKey.current;
    previousKey.current = readingKey;
    if (!readingKey || readingKey === previous) return;
    const list = listRef.current;
    if (!list) return;
    const index = sources.findIndex(source => source.key === readingKey);
    const bounds = list.children[index].getBoundingClientRect();
    const listBounds = list.getBoundingClientRect();
    const offset = bounds.left + bounds.width / 2 - (listBounds.left + listBounds.width / 2);
    if (offset === 0) return;
    if (shouldAnimate) glideScrollBy(list, offset);
    else list.scrollBy({ left: offset });
  }, [sources, readingKey, shouldAnimate]);
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

function SourcePreparationStatus({
  sources,
  preparationProgress,
  preparationStatus,
}: {
  readonly sources: readonly ShelfSource[];
  readonly preparationProgress: SourcePreparationProgress;
  readonly preparationStatus?: string;
}) {
  const completed = sources.filter(
    source => source.state === 'done' || source.state === 'error'
  ).length;
  const readingIndex = sources.findIndex(source => source.state === 'reading');
  const isReading =
    preparationProgress.step === 'extraction' || preparationProgress.step === 'pdf-transcription';
  return (
    <output className="mt-1 block text-xs">
      <span className={isReading ? 'sr-only' : undefined}>
        {isReading
          ? t('Lettura fonti {current} di {total}', {
              current: readingIndex >= 0 ? readingIndex + 1 : completed,
              total: sources.length,
            })
          : preparationStatus}
      </span>
      {preparationProgress.step === 'pdf-transcription' ? (
        <span className="block">{preparationStatus}</span>
      ) : null}
    </output>
  );
}

function SourceShelfHeader({
  sources,
  onClear,
  pending,
  preparationProgress,
  preparationStatus,
  headingId,
}: Omit<SourceShelfProps, 'warnings'> & { readonly headingId: string }) {
  return (
    <div className="source-shelf-header">
      <Paperclip className="source-shelf-icon" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <h3 id={headingId} className="source-shelf-heading">
          {t(preparationProgress ? 'Preparazione delle fonti' : 'Le tue fonti')}
        </h3>
        {sources.length > 0 && !preparationProgress ? (
          <p className="source-shelf-count">
            {sources.length === 1
              ? t('1 fonte selezionata')
              : t('{count} fonti selezionate', { count: sources.length })}
          </p>
        ) : null}
        {pending ? <output className="mt-1 block text-xs">{t('Verifica dei file…')}</output> : null}
        {preparationProgress ? (
          <SourcePreparationStatus
            sources={sources}
            preparationProgress={preparationProgress}
            preparationStatus={preparationStatus}
          />
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
  const readingKey = sources.find(source => source.state === 'reading')?.key;
  const bookListRef = useReadingBookReveal(sources, readingKey);
  const [focusedKey, setFocusedKey] = useState<string>();
  const activeKey = sources.find(source => source.key === focusedKey)?.key ?? sources[0]?.key;
  const hasContent = sources.length > 0 || warnings.length > 0;
  return (
    <section
      className={hasContent ? 'source-shelf' : undefined}
      data-preparing={preparationProgress ? 'true' : undefined}
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
                  aria-current={source.key === readingKey ? 'true' : undefined}
                  aria-description={description ? t(description) : undefined}
                  data-source-key={source.key}
                  data-palette={PREPARATION_PALETTE[index % PREPARATION_PALETTE.length]}
                  data-state={source.state ?? 'idle'}
                >
                  <div className="source-book" aria-hidden="true">
                    {preparationProgress ? (
                      <SourceBookPreparationArt
                        state={
                          source.state === 'reading' && source.key !== readingKey
                            ? 'idle'
                            : (source.state ?? 'idle')
                        }
                        color={PREPARATION_PALETTE[index % PREPARATION_PALETTE.length]}
                      />
                    ) : (
                      <div className="source-book-preparation">
                        <img
                          src={sourcePreparationPoster(
                            'idle',
                            PREPARATION_PALETTE[index % PREPARATION_PALETTE.length]
                          )}
                          alt=""
                        />
                      </div>
                    )}
                    <SourceBookStatus state={source.state} />
                  </div>
                  <div className="source-book-caption" aria-hidden="true">
                    {!preparationProgress ? (
                      <span className="source-book-meta">
                        <span>{source.name.match(/\.([^.]+)$/)?.[1]}</span>
                      </span>
                    ) : null}
                    <span className="source-book-title">{sourceTitle(source.name)}</span>
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
