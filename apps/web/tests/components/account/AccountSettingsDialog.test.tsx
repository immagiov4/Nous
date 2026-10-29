// @vitest-environment jsdom
import { EMPTY_ACCOUNT_PREFERENCES } from '@shared/accountPreferences';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, test, vi } from 'vitest';
import AccountSettingsDialog from '../../../components/account/AccountSettingsDialog.tsx';
import { setAccountLocale } from '../../../i18n/uiMessages.ts';

vi.mock('../../../services/preferences/accountPreferences.ts', () => ({
  loadAccountPreferences: vi.fn(async () => ({ ...EMPTY_ACCOUNT_PREFERENCES })),
}));

afterEach(() => setAccountLocale(null));

test.each([
  ['it', 1, '1 corso importato.', 'Richiesta di scaricamento del backup di 1 corso inviata.'],
  ['it', 2, '2 corsi importati.', 'Richiesta di scaricamento del backup di 2 corsi inviata.'],
  ['en', 1, '1 course imported.', 'Download request for the backup of 1 course sent.'],
  ['en', 2, '2 courses imported.', 'Download request for the backup of 2 courses sent.'],
] as const)('reports %s backup counts for %i', async (locale, count, imported, exported) => {
  setAccountLocale(locale);
  const onImport = vi.fn(async () => ({ importedProjectCount: count, refreshFailed: false }));
  const onExport = vi.fn(async () => count);
  render(
    <AccountSettingsDialog
      account={{ id: 'account' }}
      initialSection="data"
      onAccountChange={vi.fn()}
      onClose={vi.fn()}
      onExportLibraryBackup={onExport}
      onImportLibraryBackup={onImport}
    />
  );
  await userEvent.setup().click(
    screen.getByRole('button', {
      name: locale === 'it' ? 'Esporta tutti i corsi' : 'Export all courses',
    })
  );
  expect(await screen.findByText(exported)).toBeInTheDocument();
  const file = new File(['archive'], 'courses.zip', { type: 'application/zip' });
  fireEvent.change(
    screen.getByLabelText(
      locale === 'it' ? 'Seleziona backup completo Nous' : 'Select a complete Nous backup'
    ),
    { target: { files: [file] } }
  );
  expect(await screen.findByText(imported)).toBeInTheDocument();
  expect(onExport).toHaveBeenCalledOnce();
  expect(onImport).toHaveBeenCalledWith(file);
});

test('reports committed courses with a refresh warning instead of inviting another import', async () => {
  setAccountLocale('en');
  render(
    <AccountSettingsDialog
      account={{ id: 'account' }}
      initialSection="data"
      onAccountChange={vi.fn()}
      onClose={vi.fn()}
      onImportLibraryBackup={vi.fn(async () => ({ importedProjectCount: 2, refreshFailed: true }))}
    />
  );
  fireEvent.change(screen.getByLabelText('Select a complete Nous backup'), {
    target: { files: [new File(['archive'], 'courses.zip')] },
  });
  expect(await screen.findByText('2 courses imported.')).toBeInTheDocument();
  expect(screen.getByRole('alert')).toHaveTextContent(
    'Your courses were imported. Reload the library to see them.'
  );
  expect(screen.queryByText(/Check the file and try again/)).toBeNull();
});
