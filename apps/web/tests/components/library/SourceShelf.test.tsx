// @vitest-environment jsdom
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, test, vi } from 'vitest';
import SourceShelf from '../../../components/library/SourceShelf.tsx';
import { setRenderingLocaleOverride } from '../../../i18n/uiMessages.ts';

const sources = [
  { key: 'a', name: 'Probabilità_concetti-di_base.pdf' },
  { key: 'b', name: 'Il_teorema-di_Bayes.v2.docx' },
  { key: 'c', name: 'Appunti' },
];

describe('SourceShelf', () => {
  test('shows a filename title once after removing its numeric ordering prefix', () => {
    render(
      <SourceShelf sources={[{ key: 'numbered', name: '01_Probabilità_concetti_di_base.pdf' }]} />
    );
    const book = screen.getByRole('listitem', { name: '01_Probabilità_concetti_di_base.pdf' });
    expect(within(book).getByText('Probabilità concetti di base')).toBeVisible();
    expect(within(book).getByText('01')).toBeVisible();
  });

  test('renders pending attachments in English without losing status or removal', () => {
    setRenderingLocaleOverride('en');
    try {
      render(<SourceShelf sources={sources} pending onClear={vi.fn()} />);
      expect(screen.getByRole('status')).toHaveTextContent('Checking files…');
      expect(screen.getByRole('button', { name: 'Remove attachment' })).toBeVisible();
      expect(screen.getAllByRole('listitem')).toHaveLength(sources.length);
    } finally {
      setRenderingLocaleOverride(null);
    }
  });

  test('keeps the warning announcer mounted before rejected files arrive and groups identical warnings', () => {
    const { container, rerender } = render(<SourceShelf sources={[]} />);
    const announcer = container.querySelector('[aria-live="polite"]');
    expect(announcer).toBeInTheDocument();
    rerender(<SourceShelf sources={[]} warnings={['Unsupported file', 'Unsupported file']} />);
    expect(container.querySelector('[aria-live="polite"]')).toBe(announcer);
    expect(screen.getAllByText('Unsupported file')).toHaveLength(1);
  });

  test('keeps extension-only names readable and distinguishes matching stems by file type', () => {
    render(
      <SourceShelf sources={['.pdf', 'notes.pdf', 'notes.md'].map(name => ({ key: name, name }))} />
    );
    expect(within(screen.getByRole('listitem', { name: '.pdf' })).getByText('.pdf')).toBeVisible();
    expect(
      within(screen.getByRole('listitem', { name: 'notes.pdf' })).getByText('pdf')
    ).toBeVisible();
    expect(
      within(screen.getByRole('listitem', { name: 'notes.md' })).getByText('md')
    ).toBeVisible();
  });

  test('renders ordered books with derived titles, indices and accessible full filenames', () => {
    render(<SourceShelf sources={sources} />);
    const books = within(screen.getByRole('list', { name: 'Le tue fonti' })).getAllByRole(
      'listitem'
    );
    expect(books).toHaveLength(3);
    for (const [index, source] of sources.entries()) {
      expect(books[index]).toHaveAccessibleName(source.name);
      expect(books[index]).toHaveAttribute('title', source.name);
      expect(within(books[index]).getByText(String(index + 1).padStart(2, '0'))).toBeVisible();
    }
    expect(within(books[0]).getByText('Probabilità concetti di base')).toBeVisible();
    expect(within(books[1]).getByText('Il teorema di Bayes.v2')).toBeVisible();
    expect(within(books[2]).getByText('Appunti')).toBeVisible();
  });

  test('keeps all 32 sources and gives adjacent covers different palette colours', () => {
    render(
      <SourceShelf
        sources={Array.from({ length: 32 }, (_, index) => ({
          key: String(index),
          name: `Source_${index}.pdf`,
        }))}
      />
    );
    const books = screen.getAllByRole('listitem');
    expect(books).toHaveLength(32);
    for (let index = 1; index < books.length; index += 1) {
      expect(books[index].getAttribute('data-palette')).not.toBe(
        books[index - 1].getAttribute('data-palette')
      );
    }
    expect(new Set(books.map(book => book.getAttribute('data-palette'))).size).toBe(6);
  });

  test('preserves remove, pending and warnings and removes the action when interview starts', async () => {
    const clear = vi.fn();
    const { rerender } = render(
      <SourceShelf sources={sources} pending warnings={['File non utilizzabile']} onClear={clear} />
    );
    expect(screen.getByRole('status')).toHaveTextContent('Verifica dei file…');
    expect(screen.getByText('File non utilizzabile')).toBeVisible();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Rimuovi allegato' }));
    expect(clear).toHaveBeenCalledOnce();
    rerender(<SourceShelf sources={sources} />);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  test('renders one source as a book and preserves duplicate names as separate books', () => {
    const { rerender } = render(<SourceShelf sources={[sources[0]]} />);
    expect(screen.getByText('1 fonte selezionata')).toBeVisible();
    expect(screen.getAllByRole('listitem')).toHaveLength(1);
    rerender(<SourceShelf sources={[sources[0], { ...sources[0], key: 'duplicate' }]} />);
    expect(screen.getAllByRole('listitem', { name: sources[0].name })).toHaveLength(2);
  });

  test('keeps keyboard access and accepts per-book state without changing attachment order', async () => {
    render(
      <SourceShelf
        sources={sources.map((source, index) => ({
          ...source,
          state: index === 0 ? 'done' : index === 1 ? 'reading' : 'idle',
        }))}
      />
    );
    const books = screen.getAllByRole('listitem');
    const user = userEvent.setup();
    await user.tab();
    expect(books[0]).toHaveFocus();
    await user.keyboard('{ArrowRight}');
    expect(books[1]).toHaveFocus();
    expect(books.map(book => book.dataset.state)).toEqual(['done', 'reading', 'idle']);
    expect(books.map(book => book.tabIndex)).toEqual([-1, 0, -1]);
    await user.keyboard('{End}');
    expect(books[2]).toHaveFocus();
    await user.keyboard('{Home}');
    expect(books[0]).toHaveFocus();
    await user.tab();
    expect(books).not.toContain(document.activeElement);
  });

  test('retains warning-only notices, hides empty shelves and translates new labels', () => {
    const { rerender } = render(<SourceShelf sources={[]} warnings={['Formato non supportato']} />);
    expect(screen.getByText('Formato non supportato')).toBeVisible();
    expect(screen.queryByRole('list', { name: 'Le tue fonti' })).not.toBeInTheDocument();
    rerender(<SourceShelf sources={[]} />);
    expect(screen.queryByRole('heading')).not.toBeInTheDocument();
    setRenderingLocaleOverride('en');
    try {
      rerender(<SourceShelf sources={[sources[0]]} />);
      expect(screen.getByRole('heading', { name: 'Your sources' })).toBeVisible();
      expect(screen.getByText('1 source selected')).toBeVisible();
    } finally {
      setRenderingLocaleOverride(null);
    }
  });
});
