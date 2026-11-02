// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import SourceShelf from '../../../components/library/SourceShelf.tsx';
import { formatSourcePreparationProgress } from '../../../hooks/workspace/controller/controllerContext.ts';
import { setRenderingLocaleOverride } from '../../../i18n/uiMessages.ts';

const sources = [
  { key: 'a', name: 'Probabilità_concetti-di_base.pdf' },
  { key: 'b', name: 'Il_teorema-di_Bayes.v2.docx' },
  { key: 'c', name: 'Appunti' },
];

beforeEach(() => {
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('SourceShelf', () => {
  test('reuses the closed 3D source model before preparation without playing any video', () => {
    const { container } = render(<SourceShelf sources={sources} />);
    const books = screen.getAllByRole('listitem');
    expect(books.map(book => book.querySelector('img')?.getAttribute('src'))).toEqual([
      '/source-shelf/preparation-blue-closed.webp',
      '/source-shelf/preparation-copper-closed.webp',
      '/source-shelf/preparation-sage-closed.webp',
    ]);
    expect(container.querySelector('video')).toBeNull();
    for (const book of books) expect(book.querySelector('.source-book-caption')).toBeVisible();
  });

  test('keeps each source in one carousel while the previous source closes', () => {
    const progress = { step: 'extraction' as const, completed: 1, total: 3 };
    const preparing = sources.map((source, index) => ({
      ...source,
      state:
        index === 0 ? ('done' as const) : index === 1 ? ('reading' as const) : ('idle' as const),
    }));
    const { container, rerender } = render(
      <SourceShelf sources={preparing} preparationProgress={progress} />
    );
    const books = screen.getAllByRole('listitem');
    expect(container.querySelector('.source-preparation-stage')).toBeNull();
    expect(books.map(book => book.getAttribute('aria-label'))).toEqual(
      sources.map(source => source.name)
    );
    const video = books[1].querySelector('video');
    expect(video).toHaveAttribute('src', '/source-shelf/preparation-copper-reading.webm');
    if (!video) throw new Error('Missing player');
    fireEvent.playing(video);
    rerender(
      <SourceShelf
        sources={preparing.map(source => ({ ...source }))}
        preparationProgress={{ ...progress, documentName: 'updated page' }}
      />
    );
    expect(books[1].querySelector('video')).toBe(video);
    fireEvent.ended(video);
    expect(video).toHaveAttribute('loop');
    rerender(
      <SourceShelf
        sources={preparing.map((source, index) => ({
          ...source,
          state: index === 2 ? ('reading' as const) : ('done' as const),
        }))}
        preparationProgress={{ ...progress, completed: 2 }}
      />
    );
    expect(books[1].querySelector('video')).toBe(video);
    expect(video).toHaveAttribute('data-phase', 'search');
    expect(video).not.toHaveAttribute('loop');
    fireEvent.ended(video);
    expect(video).toHaveAttribute('src', '/source-shelf/preparation-copper-complete.webm');
    expect(video).not.toHaveAttribute('loop');
    expect(books[2].querySelector('video')).toHaveAttribute(
      'src',
      '/source-shelf/preparation-sage-reading.webm'
    );
    fireEvent.ended(video);
    expect(books[1].querySelector('video')).toBeNull();
    expect(books[1].querySelector('.source-book-done')).toBeVisible();
  });

  test('shows only the first concurrently reading source, then advances without losing real states', () => {
    const progress = { step: 'extraction' as const, completed: 0, total: 2 };
    const reading = [
      { ...sources[0], state: 'reading' as const },
      { ...sources[1], state: 'reading' as const },
    ];
    const { rerender } = render(<SourceShelf sources={reading} preparationProgress={progress} />);
    const first = screen.getByRole('listitem', { name: sources[0].name });
    const second = screen.getByRole('listitem', { name: sources[1].name });
    const video = first.querySelector('video');
    if (!video) throw new Error('Missing selected source player');
    expect(first).toHaveAttribute('aria-current', 'true');
    expect(second).not.toHaveAttribute('aria-current');
    expect(second).toHaveAttribute('data-state', 'reading');
    expect(second.querySelector('video')).toBeNull();
    expect(second.querySelector('img')).toHaveAttribute(
      'src',
      '/source-shelf/preparation-copper-reading.webp'
    );
    fireEvent.playing(video);
    fireEvent.ended(video);
    rerender(
      <SourceShelf
        sources={[{ ...reading[0], state: 'done' }, reading[1]]}
        preparationProgress={{ ...progress, completed: 1 }}
      />
    );
    expect(first.querySelector('video')).toBe(video);
    expect(video).toHaveAttribute('data-phase', 'search');
    expect(video).not.toHaveAttribute('loop');
    fireEvent.ended(video);
    expect(video).toHaveAttribute('data-phase', 'complete');
    expect(second).toHaveAttribute('aria-current', 'true');
    expect(second.querySelector('video')).toHaveAttribute('data-phase', 'reading');
  });

  test('announces the selected source ordinal when later sources finish first', () => {
    const progress = { step: 'extraction' as const, completed: 1, total: 2 };
    const firstReading = [
      { ...sources[0], state: 'reading' as const },
      { ...sources[1], state: 'done' as const },
    ];
    const { rerender } = render(
      <SourceShelf sources={firstReading} preparationProgress={progress} />
    );
    expect(screen.getByRole('listitem', { name: sources[0].name })).toHaveAttribute(
      'aria-current',
      'true'
    );
    expect(screen.getByRole('status')).toHaveTextContent('Lettura fonti 1 di 2');
    rerender(
      <SourceShelf
        sources={[{ ...firstReading[0], state: 'done' }, firstReading[1]]}
        preparationProgress={{ ...progress, completed: 2 }}
      />
    );
    expect(screen.getByRole('status')).toHaveTextContent('Lettura fonti 2 di 2');
  });

  test('finishes opening before closing a source that completed during the opening', () => {
    const progress = { step: 'extraction' as const, completed: 0, total: 2 };
    const { rerender } = render(
      <SourceShelf
        sources={[
          { ...sources[0], state: 'reading' },
          { ...sources[1], state: 'idle' },
        ]}
        preparationProgress={progress}
      />
    );
    const first = screen.getByRole('listitem', { name: sources[0].name });
    const video = first.querySelector('video');
    if (!video) throw new Error('Missing player');
    fireEvent.playing(video);
    rerender(
      <SourceShelf
        sources={[
          { ...sources[0], state: 'done' },
          { ...sources[1], state: 'reading' },
        ]}
        preparationProgress={{ ...progress, completed: 1 }}
      />
    );
    expect(first.querySelector('video')).toBe(video);
    expect(video).toHaveAttribute('src', '/source-shelf/preparation-blue-reading.webm');
    expect(video).not.toHaveAttribute('loop');
    fireEvent.ended(video);
    expect(video).toHaveAttribute('src', '/source-shelf/preparation-blue-complete.webm');
    expect(video).not.toHaveAttribute('loop');
    fireEvent.ended(video);
    expect(first.querySelector('video')).toBeNull();
  });

  test('plays the approved reading artwork only for the actual reading source and settles without delaying it', async () => {
    const pause = vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
    const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
    const progress = { step: 'extraction' as const, completed: 0, total: 3 };
    const preparing = sources.map((source, index) => ({
      ...source,
      state: index === 1 ? ('reading' as const) : ('idle' as const),
    }));
    const { rerender, unmount } = render(
      <SourceShelf sources={preparing} preparationProgress={progress} />
    );
    const active = screen.getByRole('listitem', { name: sources[1].name });
    const video = document.querySelector('.source-shelf-item[aria-current=true] video');
    expect(video).toBeInTheDocument();
    if (!video) throw new Error('Missing reading animation');
    expect(
      screen.getByRole('listitem', { name: sources[0].name }).querySelector('video')
    ).toBeNull();
    fireEvent.playing(video);
    fireEvent.ended(video);
    const loop = document.querySelector('.source-shelf-item[aria-current=true] video');
    expect(loop).toHaveAttribute('loop');
    expect(active).toHaveAttribute('data-state', 'reading');
    expect(active).not.toHaveAccessibleDescription('Fonte letta');
    rerender(
      <SourceShelf
        sources={preparing.map(source => ({ ...source, state: 'done' as const }))}
        preparationProgress={{ ...progress, completed: 3 }}
      />
    );
    expect(active).toHaveAccessibleDescription('Fonte letta');
    expect(active.querySelector('video')).not.toHaveAttribute('loop');
    expect(
      screen.getByRole('listitem', { name: sources[0].name }).querySelector('video')
    ).toBeNull();
    unmount();
    expect(pause).toHaveBeenCalled();
    play.mockRestore();
    pause.mockRestore();
  });

  test('uses a static readable poster when motion is reduced and preserves the full filename', () => {
    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() }))
    );
    const name = `${'Very_long_source_title_'.repeat(20)}.pdf`;
    try {
      render(
        <SourceShelf
          sources={[{ key: 'long', name, state: 'reading' }]}
          preparationProgress={{ step: 'extraction', completed: 0, total: 1 }}
        />
      );
      const book = screen.getByRole('listitem', { name });
      expect(document.querySelector('.source-shelf-item[aria-current=true] video')).toBeNull();
      expect(
        document.querySelector('.source-shelf-item[aria-current=true] img')
      ).toBeInTheDocument();
      expect(book).toHaveAttribute('title', name);
      expect(book).toHaveAttribute('aria-current', 'true');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  test('retains a poster and actual error state when animation playback is unavailable', async () => {
    const play = vi
      .spyOn(HTMLMediaElement.prototype, 'play')
      .mockRejectedValue(new DOMException('Blocked', 'NotAllowedError'));
    const pause = vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
    const { rerender } = render(
      <SourceShelf
        sources={[{ ...sources[0], state: 'reading' }]}
        preparationProgress={{ step: 'extraction', completed: 0, total: 1 }}
      />
    );
    const book = screen.getByRole('listitem', { name: sources[0].name });
    await act(async () => {});
    expect(document.querySelector('.source-shelf-item[aria-current=true] video')).toBeNull();
    expect(document.querySelector('.source-shelf-item[aria-current=true] img')).toBeInTheDocument();
    rerender(
      <SourceShelf
        sources={[{ ...sources[0], state: 'error' }]}
        preparationProgress={{ step: 'extraction', completed: 1, total: 1 }}
      />
    );
    expect(book).toHaveAccessibleDescription('Fonte non utilizzabile');
    expect(book.querySelector('.source-book-error')).toBeVisible();
    play.mockRestore();
    pause.mockRestore();
  });

  test.each([
    ['it', 'Fonte non utilizzabile'],
    ['en', 'Source unavailable'],
  ] as const)('distinguishes a failed source from an idle book in %s', (locale, description) => {
    setRenderingLocaleOverride(locale);
    try {
      render(
        <SourceShelf
          sources={[
            { key: 'failed', name: 'failed.pdf', state: 'error' },
            { key: 'waiting', name: 'waiting.pdf', state: 'idle' },
          ]}
        />
      );
      const failed = screen.getByRole('listitem', { name: 'failed.pdf' });
      expect(failed).toHaveAccessibleDescription(description);
      expect(failed.querySelector('.source-book-error')).toBeVisible();
      expect(screen.getByRole('listitem', { name: 'waiting.pdf' })).toHaveAccessibleDescription(
        'waiting.pdf'
      );
    } finally {
      setRenderingLocaleOverride(null);
    }
  });

  test('reveals a newly reading offscreen book once without changing keyboard focus', () => {
    const { rerender } = render(<SourceShelf sources={sources} />);
    const list = screen.getByRole('list', { name: 'Le tue fonti' });
    const books = screen.getAllByRole('listitem');
    list.getBoundingClientRect = () => new DOMRect(0, 0, 300, 200);
    books[2].getBoundingClientRect = () => new DOMRect(500, 0, 150, 200);
    let frame: FrameRequestCallback | undefined;
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frame = callback;
      return 1;
    });
    vi.spyOn(performance, 'now').mockReturnValue(0);
    books[2].scrollIntoView = vi.fn();
    act(() => books[0].focus());
    const reading = sources.map((source, index) => ({
      ...source,
      state: index === 2 ? ('reading' as const) : ('idle' as const),
    }));
    rerender(<SourceShelf sources={reading} />);
    expect(frame).toBeDefined();
    act(() => frame?.(850));
    expect(list.scrollLeft).toBe(425);
    frame = undefined;
    expect(books[0]).toHaveFocus();
    rerender(
      <SourceShelf sources={reading.map(source => ({ ...source }))} preparationStatus="next page" />
    );
    expect(frame).toBeUndefined();
    vi.unstubAllGlobals();
  });
  test('pauses hidden media and restarts a replacement source at its opening instead of the old loop', async () => {
    const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
    const pause = vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    const progress = { step: 'extraction' as const, completed: 0, total: 1 };
    const { rerender, unmount } = render(
      <SourceShelf sources={[{ ...sources[0], state: 'reading' }]} preparationProgress={progress} />
    );
    const video = document.querySelector('.source-shelf-item[aria-current=true] video');
    if (!video) throw new Error('Missing reading animation');
    fireEvent.playing(video);
    fireEvent.ended(video);
    visibility.mockReturnValue('hidden');
    const beforeHidden = pause.mock.calls.length;
    fireEvent(document, new Event('visibilitychange'));
    expect(pause.mock.calls.length).toBeGreaterThan(beforeHidden);
    visibility.mockReturnValue('visible');
    const beforeVisible = play.mock.calls.length;
    fireEvent(document, new Event('visibilitychange'));
    expect(play.mock.calls.length).toBeGreaterThan(beforeVisible);
    const beforeReplace = pause.mock.calls.length;
    rerender(
      <SourceShelf sources={[{ ...sources[1], state: 'reading' }]} preparationProgress={progress} />
    );
    expect(pause.mock.calls.length).toBeGreaterThan(beforeReplace);
    expect(
      document.querySelector('.source-shelf-item[aria-current=true] video')
    ).not.toHaveAttribute('loop');
    unmount();
  });

  test('resumes playback when a new transparent clip loads on the same player', () => {
    const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      drawImage: vi.fn(),
      getImageData: () => ({ data: new Uint8ClampedArray([0, 0, 0, 0]) }),
    } as unknown as CanvasRenderingContext2D);
    render(
      <SourceShelf
        sources={[{ ...sources[0], state: 'reading' }]}
        preparationProgress={{ step: 'extraction', completed: 0, total: 1 }}
      />
    );
    const video = screen.getByRole('listitem', { name: sources[0].name }).querySelector('video');
    if (!video) throw new Error('Missing player');
    const before = play.mock.calls.length;
    fireEvent.loadedData(video);
    expect(play.mock.calls).toHaveLength(before + 1);
  });

  test('uses the transparent poster if the browser decodes an opaque video frame', () => {
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      drawImage: vi.fn(),
      getImageData: () => ({ data: new Uint8ClampedArray([0, 0, 0, 255]) }),
    } as unknown as CanvasRenderingContext2D);
    render(
      <SourceShelf
        sources={[{ ...sources[0], state: 'reading' }]}
        preparationProgress={{ step: 'extraction', completed: 0, total: 1 }}
      />
    );
    const book = screen.getByRole('listitem', { name: sources[0].name });
    const video = document.querySelector('.source-shelf-item[aria-current=true] video');
    if (!video) throw new Error('Missing reading animation');
    fireEvent.loadedData(video);
    expect(document.querySelector('.source-shelf-item[aria-current=true] video')).toBeNull();
    expect(document.querySelector('.source-shelf-item[aria-current=true] img')).toBeInTheDocument();
    expect(book).toHaveAttribute('data-state', 'reading');
  });

  test('keeps PDF page progress and reduced-quality disclosure with the book counter', () => {
    const progress = {
      step: 'pdf-transcription' as const,
      completed: 165,
      total: 200,
      documentName: 'scan.pdf',
      reducedQuality: { from: 151, to: 200 },
    };
    const { rerender } = render(
      <SourceShelf
        sources={[{ key: 'scan', name: 'scan.pdf', state: 'reading' }]}
        preparationProgress={progress}
        preparationStatus={formatSourcePreparationProgress(progress)}
      />
    );
    expect(screen.getByRole('status')).toHaveTextContent('Lettura fonti 1 di 1');
    expect(screen.getByRole('status')).toHaveTextContent('165/200');
    expect(screen.getByRole('status')).toHaveTextContent(
      'Pagine 151–200 trascritte in qualità ridotta.'
    );
    const next = { ...progress, completed: 166, reducedQuality: undefined };
    rerender(
      <SourceShelf
        sources={[{ key: 'scan', name: 'scan.pdf', state: 'reading' }]}
        preparationProgress={next}
        preparationStatus={formatSourcePreparationProgress(next)}
      />
    );
    expect(screen.getByRole('status')).toHaveTextContent('166/200');
    expect(screen.getByRole('status')).not.toHaveTextContent('qualità ridotta');
  });

  test('keeps numeric filename content visible so year-based sources remain distinct', () => {
    const names = ['01_Probabilità.pdf', '2023_report.pdf', '2024_report.pdf'];
    render(<SourceShelf sources={names.map(name => ({ key: name, name }))} />);
    for (const [index, title] of ['01 Probabilità', '2023 report', '2024 report'].entries()) {
      expect(
        within(screen.getByRole('listitem', { name: names[index] })).getByText(title)
      ).toBeVisible();
    }
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

  test('renders ordered books with derived titles and accessible full filenames', () => {
    render(<SourceShelf sources={sources} />);
    const books = within(screen.getByRole('list', { name: 'Le tue fonti' })).getAllByRole(
      'listitem'
    );
    expect(books).toHaveLength(3);
    for (const [index, source] of sources.entries()) {
      expect(books[index]).toHaveAccessibleName(source.name);
      expect(books[index]).toHaveAttribute('title', source.name);
    }
    expect(within(books[0]).getByText('Probabilità concetti di base')).toBeVisible();
    expect(within(books[1]).getByText('Il teorema di Bayes.v2')).toBeVisible();
    expect(within(books[2]).getByText('Appunti')).toBeVisible();
  });

  test('does not add a second number to an already numbered filename', () => {
    render(<SourceShelf sources={[{ key: 'numbered', name: '03 Il teorema di Bayes.md' }]} />);
    const book = screen.getByRole('listitem', { name: '03 Il teorema di Bayes.md' });
    expect(within(book).getByText('03 Il teorema di Bayes')).toBeVisible();
    expect(within(book).queryByText('01')).not.toBeInTheDocument();
    expect(within(book).getByText('md')).toBeVisible();
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
    expect(new Set(books.map(book => book.getAttribute('data-palette'))).size).toBe(3);
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
