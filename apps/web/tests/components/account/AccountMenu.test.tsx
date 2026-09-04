// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import AccountMenu from '../../../components/account/AccountMenu.tsx';
import { clearSupabaseSession, saveSupabaseSession } from '../../../services/auth/supabaseAuth.ts';
import { LibraryArchiveError } from '../../../services/projects/libraryArchive.ts';
import type { LibraryExportProgressListener } from '../../../services/projects/projectRepository.ts';

const fetchMock = vi.fn();

afterEach(cleanup);

const saveAccountSession = (providers: string[]) => {
  saveSupabaseSession({
    accessToken: 'access-token',
    user: {
      email: 'student@example.com',
      id: 'user-123',
      providers,
    },
  });
};

const accountResponse = (provider: string) => ({
  ok: true,
  json: async () => ({
    id: 'user-123',
    email: 'student@example.com',
    identities: [{ provider }],
    user_metadata: { display_name: 'Ignored provider metadata' },
  }),
});

describe('AccountMenu', () => {
  beforeEach(() => {
    vi.spyOn(globalThis.navigator, 'languages', 'get').mockReturnValue(['it']);
    vi.stubEnv('VITE_AUTH_MODE', 'supabase');
    vi.stubEnv('VITE_SUPABASE_URL', 'https://supabase.test');
    vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'anon-key');
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset();
    clearSupabaseSession();
  });

  test('offers the combined account menu from the settings row', async () => {
    const user = userEvent.setup();
    saveAccountSession(['email']);
    fetchMock.mockResolvedValueOnce(accountResponse('email'));

    render(<AccountMenu triggerVariant="settings" />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    await user.click(screen.getByRole('button', { name: /Apri menu account/ }));
    expect(screen.getByRole('menuitem', { name: 'Account e sicurezza' })).toBeInTheDocument();
    expect(screen.getByText('student@example.com')).toBeInTheDocument();
  });

  test('toggles the optional dark theme control inside the account menu', async () => {
    const user = userEvent.setup();
    const onToggle = vi.fn();
    saveAccountSession(['email']);
    fetchMock.mockResolvedValueOnce(accountResponse('email'));

    const { rerender } = render(<AccountMenu themeToggle={{ isDarkMode: false, onToggle }} />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await user.click(screen.getByRole('button', { name: /Apri menu account/ }));

    const themeToggle = screen.getByRole('menuitemcheckbox', { name: 'Tema scuro' });
    expect(themeToggle).toHaveAttribute('aria-checked', 'false');

    await user.click(themeToggle);

    expect(onToggle).toHaveBeenCalledTimes(1);

    rerender(<AccountMenu themeToggle={{ isDarkMode: true, onToggle }} />);
    expect(screen.getByRole('menuitemcheckbox', { name: 'Tema scuro' })).toHaveAttribute(
      'aria-checked',
      'true'
    );
  });

  test('opens authenticated in-app feedback directly above account settings', async () => {
    const user = userEvent.setup();
    saveAccountSession(['email']);
    fetchMock.mockResolvedValueOnce(accountResponse('email'));

    render(<AccountMenu triggerVariant="settings" />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await user.click(screen.getByRole('button', { name: 'Segnala problema' }));

    const feedbackDialog = screen.getByRole('dialog', { name: 'Segnala un problema' });
    expect(feedbackDialog).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Problema' })).toHaveAttribute(
      'aria-pressed',
      'true'
    );

    await user.click(within(feedbackDialog).getByRole('button', { name: 'Chiudi segnalazione' }));
    await user.click(screen.getByRole('button', { name: /Apri menu account/ }));
    expect(screen.queryByRole('menuitem', { name: 'Segnala un problema' })).toBeNull();
  });

  test('keeps unused profile metadata out of the account UI', async () => {
    const user = userEvent.setup();
    saveAccountSession(['email']);
    fetchMock.mockResolvedValueOnce(accountResponse('email'));

    render(<AccountMenu />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    await user.click(screen.getByRole('button', { name: /Apri menu account/ }));
    expect(screen.queryByRole('menuitem', { name: 'Profilo' })).toBeNull();
    expect(screen.queryByRole('textbox', { name: 'Nome visualizzato' })).toBeNull();
    expect(screen.queryByRole('textbox', { name: 'URL avatar' })).toBeNull();
    expect(screen.getByRole('menuitem', { name: 'Account e sicurezza' })).not.toBeNull();
  });

  test('shows credential controls only for accounts with an email identity', async () => {
    const user = userEvent.setup();
    saveAccountSession(['email']);
    fetchMock
      .mockResolvedValueOnce(accountResponse('email'))
      .mockResolvedValueOnce(accountResponse('email'));

    render(<AccountMenu />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await user.click(screen.getByRole('button', { name: /Apri menu account/ }));
    await user.click(screen.getByRole('menuitem', { name: 'Account e sicurezza' }));

    expect(screen.getByRole('textbox', { name: 'Nuovo indirizzo email' })).not.toBeNull();
    expect(screen.getByLabelText('Nuova password')).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Invia email di recupero' })).not.toBeNull();

    await user.type(screen.getByLabelText('Nuova password'), 'password-nuova');
    await user.click(screen.getByRole('button', { name: 'Cambia password' }));

    expect((await screen.findByRole('status')).textContent).toContain('Password aggiornata.');
    expect(JSON.parse(fetchMock.mock.calls[1]?.[1]?.body as string)).toEqual({
      password: 'password-nuova',
    });
  });

  test('hides password and email changes for OAuth-only accounts', async () => {
    const user = userEvent.setup();
    saveAccountSession(['google']);
    fetchMock.mockResolvedValueOnce(accountResponse('google'));

    render(<AccountMenu />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await user.click(screen.getByRole('button', { name: /Apri menu account/ }));
    await user.click(screen.getByRole('menuitem', { name: 'Account e sicurezza' }));

    expect(screen.getByText('Account gestito da un provider esterno')).not.toBeNull();
    expect(screen.queryByRole('textbox', { name: 'Nuovo indirizzo email' })).toBeNull();
    expect(screen.queryByLabelText('Nuova password')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Invia email di recupero' })).toBeNull();
  });

  test('keeps AI provider controls out of the end-user account menu', async () => {
    const user = userEvent.setup();
    saveAccountSession(['email']);
    fetchMock.mockResolvedValueOnce(accountResponse('email'));

    render(<AccountMenu />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await user.click(screen.getByRole('button', { name: /Apri menu account/ }));

    expect(screen.queryByRole('menuitem', { name: 'Provider AI' })).toBeNull();
  });

  test('exports and imports the complete course backup from the account menu', async () => {
    const user = userEvent.setup();
    let finishExport!: () => void;
    const onExportLibraryBackup = vi.fn(
      (onProgress?: LibraryExportProgressListener) =>
        new Promise<number>(resolve => {
          onProgress?.({
            bytesWritten: 321,
            completedProjectCount: 1,
            correlationId: '98de2539-25d9-497a-b612-49fa7813cb50',
            currentProjectId: 'course-2',
            phase: 'project-archive',
            projectCount: 2,
            runId: '3207883a-862a-447f-b9ed-6148effeb8ea',
            status: 'running',
          });
          finishExport = () => resolve(2);
        })
    );
    const onImportLibraryBackup = vi.fn().mockResolvedValue(2);
    saveAccountSession(['email']);
    fetchMock.mockResolvedValueOnce(accountResponse('email'));

    render(
      <AccountMenu
        onExportLibraryBackup={onExportLibraryBackup}
        onImportLibraryBackup={onImportLibraryBackup}
      />
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    await user.click(screen.getByRole('button', { name: /Apri menu account/ }));
    await user.click(screen.getByRole('menuitem', { name: 'Dati e backup' }));
    await user.click(screen.getByRole('button', { name: 'Esporta tutti i corsi' }));

    expect(onExportLibraryBackup).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Esportazione 1 di 2...' })).toBeDisabled();
    expect(screen.getByText('321 byte elaborati dal server.')).not.toBeNull();
    finishExport();
    await waitFor(() =>
      expect(screen.getByRole('status').textContent).toContain(
        'Download del backup di 2 corsi avviato.'
      )
    );

    const backup = new File(['backup'], 'courses.nous-library.zip', {
      type: 'application/zip',
    });
    await user.upload(screen.getByLabelText('Seleziona backup completo Nous'), backup);

    expect(onImportLibraryBackup).toHaveBeenCalledWith(backup);
    expect((await screen.findByRole('status')).textContent).toContain('2 corsi importati.');
  });

  test('shows partial import context and reports only sanitized diagnostics', async () => {
    const user = userEvent.setup();
    const onImportLibraryBackup = vi
      .fn()
      .mockRejectedValue(
        new LibraryArchiveError(
          'Importazione del corso 2 di 11 non riuscita.',
          'LIBRARY_ARCHIVE_PROJECT_IMPORT_FAILED',
          'project-import',
          2,
          11
        )
      );
    saveAccountSession(['email']);
    fetchMock
      .mockResolvedValueOnce(accountResponse('email'))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));

    render(
      <AccountMenu
        onExportLibraryBackup={vi.fn().mockResolvedValue(0)}
        onImportLibraryBackup={onImportLibraryBackup}
      />
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await user.click(screen.getByRole('button', { name: /Apri menu account/ }));
    await user.click(screen.getByRole('menuitem', { name: 'Dati e backup' }));
    const backup = new File(['invalid'], 'courses.nous-library.zip', {
      type: 'application/zip',
    });
    await user.upload(screen.getByLabelText('Seleziona backup completo Nous'), backup);

    expect((await screen.findByRole('alert')).textContent).toMatch(
      /Importazione del corso 2 di 11 non riuscita\. Codice assistenza:/
    );
    const diagnosticRequest = fetchMock.mock.calls[1];
    expect(diagnosticRequest?.[0]).toBe('http://localhost:3301/api/projects/import-diagnostics');
    expect(JSON.parse(diagnosticRequest?.[1]?.body as string)).toMatchObject({
      code: 'LIBRARY_ARCHIVE_PROJECT_IMPORT_FAILED',
      stage: 'project-import',
      fileBytes: backup.size,
      projectIndex: 2,
      projectCount: 11,
    });
  });
});
