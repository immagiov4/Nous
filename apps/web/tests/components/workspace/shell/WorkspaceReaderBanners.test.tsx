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

test('keeps lesson failure actionable until the next generation clears it', () => {
  setAccountLocale('it');
  const onRetryLesson = vi.fn();
  const props = {
    needsSourceFile: false,
    onAttachSourceFile: vi.fn(),
    onBackToLibrary: vi.fn(),
    onExportProject: vi.fn(),
    onRetryLesson,
    pdfMappingWarning: null,
    storageError: null,
    lessonError:
      'Non è stato possibile verificare che tutti i contenuti della nuova lezione siano supportati dalle fonti. Puoi riprovare a generarla.',
  };
  const { rerender } = render(<WorkspaceReaderBanners {...props} />);
  expect(screen.getByRole('alert')).toHaveTextContent(props.lessonError);
  fireEvent.click(screen.getByRole('button', { name: 'Riprova' }));
  expect(onRetryLesson).toHaveBeenCalledOnce();
  rerender(<WorkspaceReaderBanners {...props} storageError="Salvataggio in attesa" />);
  expect(screen.getByRole('alert')).toHaveTextContent(props.lessonError);
  rerender(<WorkspaceReaderBanners {...props} lessonError={null} />);
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Riprova' })).not.toBeInTheDocument();
});
