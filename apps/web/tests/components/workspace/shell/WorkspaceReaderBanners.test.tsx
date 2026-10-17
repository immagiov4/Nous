// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import WorkspaceReaderBanners from '../../../../components/workspace/shell/WorkspaceReaderBanners.tsx';
import { setAccountLocale } from '../../../../i18n/uiMessages.ts';

afterEach(() => {
  cleanup();
  setAccountLocale(null);
});

test('offers source reconnection only while an imported project needs its source', () => {
  setAccountLocale('it');
  const onAttachSourceFile = vi.fn();
  const props = {
    needsSourceFile: true,
    onAttachSourceFile,
    onBackToLibrary: vi.fn(),
    onExportProject: vi.fn(),
    pdfMappingWarning: null,
    storageError: null,
  };
  const { rerender } = render(<WorkspaceReaderBanners {...props} />);
  expect(
    screen.getByText(
      'Questo progetto è stato importato senza file sorgente. Ricollega il PDF o lo ZIP per generare nuove lezioni.'
    )
  ).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: 'Ricollega sorgente' }));
  expect(onAttachSourceFile).toHaveBeenCalledOnce();

  setAccountLocale('en');
  rerender(<WorkspaceReaderBanners {...props} />);
  expect(
    screen.getByText(
      'This project was imported without its source file. Reconnect the PDF or ZIP to generate new lessons.'
    )
  ).toBeVisible();
  expect(screen.getByRole('button', { name: 'Reconnect source' })).toBeVisible();

  rerender(<WorkspaceReaderBanners {...props} needsSourceFile={false} />);
  expect(screen.queryByRole('button')).not.toBeInTheDocument();
});
