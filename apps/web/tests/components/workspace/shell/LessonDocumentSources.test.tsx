// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import LessonDocumentSources from '../../../../components/workspace/shell/LessonDocumentSources.tsx';

afterEach(() => {
  vi.restoreAllMocks();
});

test('opens the cited page in the original PDF without exposing internal identifiers', async () => {
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:nous-source');
  const revokeObjectUrl = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  const viewerWindow = {
    close: vi.fn(),
    location: { href: 'about:blank' },
    opener: window,
  };
  vi.spyOn(window, 'open').mockReturnValue(viewerWindow as unknown as Window);
  const { unmount } = render(
    <LessonDocumentSources
      sources={[
        {
          chunkIds: ['source-049:chunk-a', 'source-049:chunk-b'],
          file: {
            data: 'JVBERi0xLjQ=',
            mimeType: 'application/pdf',
            name: '049.pdf',
            sourceId: 'source-049',
          },
          kind: 'pdf',
          name: '049.pdf',
          pageEnd: 12,
          pageStart: 11,
          sourceId: 'source-049',
        },
      ]}
    />
  );

  fireEvent.click(screen.getByRole('button', { name: '049.pdf' }));
  await waitFor(() => {
    expect(viewerWindow.location.href).toBe('blob:nous-source#page=11');
  });
  expect(screen.getByText(/Pages 11-12|Pagine 11-12/)).toBeInTheDocument();
  expect(screen.queryByText(/source-049/)).not.toBeInTheDocument();
  expect(screen.queryByText(/Passaggi usati|Passages used/)).not.toBeInTheDocument();
  expect(screen.queryByText(/merged/i)).toBeNull();

  unmount();
  expect(revokeObjectUrl).toHaveBeenCalledWith('blob:nous-source');
});

test('loads a detached cited PDF on demand and opens the cited page', async () => {
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:detached-source');
  const revokeObjectUrl = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  const viewerWindow = {
    close: vi.fn(),
    location: { href: 'about:blank' },
    opener: window,
  };
  vi.spyOn(window, 'open').mockReturnValue(viewerWindow as unknown as Window);
  const loadSourceFile = vi.fn().mockResolvedValue({
    data: 'JVBERi0xLjQ=',
    mimeType: 'application/pdf',
    name: 'stored.pdf',
    sourceId: 'source-stored',
  });

  const { unmount } = render(
    <LessonDocumentSources
      loadSourceFile={loadSourceFile}
      sources={[
        {
          chunkIds: ['source-stored:chunk-a'],
          file: {
            data: '',
            mimeType: 'application/pdf',
            name: 'stored.pdf',
            sourceId: 'source-stored',
          },
          kind: 'pdf',
          name: 'stored.pdf',
          pageStart: 7,
          sourceId: 'source-stored',
        },
      ]}
    />
  );

  fireEvent.click(screen.getByRole('button', { name: 'stored.pdf' }));

  await waitFor(() => {
    expect(viewerWindow.location.href).toBe('blob:detached-source#page=7');
  });
  expect(loadSourceFile).toHaveBeenCalledWith('source-stored');
  expect(viewerWindow.opener).toBeNull();

  unmount();
  expect(revokeObjectUrl).toHaveBeenCalledWith('blob:detached-source');
});

test('shows the original archive and exact code paths used by a legacy lesson', () => {
  render(
    <LessonDocumentSources
      sources={[
        {
          archiveSelectors: [
            { kind: 'file', path: 'luanti/README.md' },
            { kind: 'directory', path: 'luanti/src/client' },
          ],
          chunkIds: [],
          file: {
            data: '',
            mimeType: 'application/zip',
            name: 'src.zip',
            sourceId: 'source-archive',
          },
          kind: 'archive',
          name: 'src.zip',
          sourceId: 'source-archive',
        },
      ]}
    />
  );

  expect(screen.getByText('src.zip')).toBeInTheDocument();
  expect(screen.getByText('luanti/README.md')).toBeInTheDocument();
  expect(screen.getByText('luanti/src/client')).toBeInTheDocument();
  expect(screen.queryByText('source-archive')).not.toBeInTheDocument();
});

test('keeps a long original document title on one line while preserving its full name', () => {
  const longName =
    'advanced-context-engineering-for-coding-agents_wsff.md at main - humanlayer_advanced-context-engineering-for-coding-agents - GitHub.pdf';

  render(
    <LessonDocumentSources
      sources={[
        {
          chunkIds: ['source-long:chunk-a'],
          file: {
            data: '',
            mimeType: 'application/pdf',
            name: longName,
            sourceId: 'source-long',
          },
          kind: 'pdf',
          name: longName,
          sourceId: 'source-long',
        },
      ]}
    />
  );

  const sourceTitle = screen.getByText(longName);
  expect(sourceTitle).toHaveAttribute('title', longName);
  expect(sourceTitle).toHaveClass('truncate');
});
