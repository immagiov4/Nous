// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import AccountMenu from '../../../components/account/AccountMenu.tsx';
import { clearSupabaseSession, saveSupabaseSession } from '../../../services/auth/supabaseAuth.ts';

const fetchMock = vi.fn();

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

const accountResponse = (provider: string, displayName = 'Ada') => ({
  ok: true,
  json: async () => ({
    id: 'user-123',
    email: 'student@example.com',
    identities: [{ provider }],
    user_metadata: { display_name: displayName },
  }),
});

describe('AccountMenu', () => {
  beforeEach(() => {
    vi.stubEnv('VITE_AUTH_MODE', 'supabase');
    vi.stubEnv('VITE_SUPABASE_URL', 'https://supabase.test');
    vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'anon-key');
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset();
    clearSupabaseSession();
  });

  test('updates editable profile metadata through the authenticated provider flow', async () => {
    const user = userEvent.setup();
    saveAccountSession(['email']);
    fetchMock
      .mockResolvedValueOnce(accountResponse('email'))
      .mockResolvedValueOnce(accountResponse('email', 'Ada Lovelace'));

    render(<AccountMenu />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    await user.click(screen.getByRole('button', { name: /Apri menu account/ }));
    await user.click(screen.getByRole('menuitem', { name: 'Profilo' }));
    const displayNameInput = screen.getByRole('textbox', { name: 'Nome visualizzato' });
    fireEvent.change(displayNameInput, { target: { value: 'Ada Lovelace' } });
    await user.click(screen.getByRole('button', { name: 'Salva profilo' }));

    expect(await screen.findByRole('status')).toHaveTextContent('Profilo aggiornato.');
    expect(JSON.parse(fetchMock.mock.calls[1]?.[1]?.body as string)).toEqual({
      data: { avatar_url: null, display_name: 'Ada Lovelace' },
    });
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

    expect(screen.getByRole('textbox', { name: 'Nuovo indirizzo email' })).toBeInTheDocument();
    expect(screen.getByLabelText('Nuova password')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Invia email di recupero' })).toBeInTheDocument();

    await user.type(screen.getByLabelText('Nuova password'), 'password-nuova');
    await user.click(screen.getByRole('button', { name: 'Cambia password' }));

    expect(await screen.findByRole('status')).toHaveTextContent('Password aggiornata.');
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

    expect(screen.getByText('Account gestito da un provider esterno')).toBeInTheDocument();
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
});
