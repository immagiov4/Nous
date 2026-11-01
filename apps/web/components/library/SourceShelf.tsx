import { Paperclip, X } from 'lucide-react';
import { useId } from 'react';
import { translateUiMessage as t } from '../../i18n/uiMessages.ts';
import './sourceShelf.css';

interface ShelfSource {
  readonly key: string;
  readonly name: string;
  readonly state?: 'idle' | 'reading' | 'done';
}

interface SourceShelfProps {
  readonly sources: readonly ShelfSource[];
  readonly onClear?: () => void;
  readonly pending?: boolean;
  readonly warnings?: readonly string[];
}

const COVER_PALETTE = ['cream', 'terracotta', 'sage', 'blue', 'brown', 'mauve'] as const;

const sourceTitle = (name: string) => name.replace(/\.[^.]+$/, '').replaceAll(/[_-]+/g, ' ');

/** Presentation only: source selection and preparation remain owned by the caller. */
export default function SourceShelf({
  sources,
  onClear,
  pending = false,
  warnings = [],
}: SourceShelfProps) {
  const headingId = useId();
  if (sources.length === 0 && warnings.length === 0) return null;
  return (
    <section className="source-shelf" aria-labelledby={headingId}>
      <div className="source-shelf-header">
        <Paperclip className="source-shelf-icon" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <h3 id={headingId} className="source-shelf-heading">
            {t('Le tue fonti')}
          </h3>
          {sources.length > 0 ? (
            <p className="source-shelf-count">
              {sources.length === 1
                ? t('1 fonte selezionata')
                : t('{count} fonti selezionate', { count: sources.length })}
            </p>
          ) : null}
          {pending ? (
            <output className="mt-1 block text-xs">{t('Verifica dei file…')}</output>
          ) : null}
        </div>
        {onClear ? (
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
      {sources.length > 0 ? (
        <div className="source-shelf-edges">
          <ul className="source-shelf-books" aria-labelledby={headingId}>
            {sources.map((source, index) => (
              // Focus exposes the full name and lets native keyboard navigation scroll each book into view.
              <li
                key={source.key}
                className="source-shelf-item"
                // biome-ignore lint/a11y/noNoninteractiveTabindex: Focus exposes the full filename and scrolls this book into view.
                tabIndex={0}
                title={source.name}
                aria-label={source.name}
                data-palette={COVER_PALETTE[index % COVER_PALETTE.length]}
                data-state={source.state ?? 'idle'}
              >
                <div className="source-book" aria-hidden="true">
                  <div className="source-book-back" />
                  <div className="source-book-pages" />
                  <div className="source-book-top" />
                  <div className="source-book-spine" />
                  <div className="source-book-cover">
                    <span className="source-book-index">{String(index + 1).padStart(2, '0')}</span>
                    <span className="source-book-title">{sourceTitle(source.name)}</span>
                    <span className="source-book-rule" />
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {warnings.length > 0 ? (
        <ul aria-live="polite" className="source-shelf-warnings">
          {warnings.map(warning => (
            <li key={warning}>{warning}</li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
