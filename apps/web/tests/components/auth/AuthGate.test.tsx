// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { StrictMode } from 'react';
import { beforeEach, expect, test, vi } from 'vitest';

import AuthGate from '../../../components/auth/AuthGate.tsx';
import { clearSupabaseSession, saveSupabaseSession } from '../../../services/auth/supabaseAuth.ts';

const fetchMock = vi.fn();

beforeEach(() => {
  window.history.replaceState({}, '', '/');
  vi.stubEnv('VITE_AUTH_MODE', 'supabase');
  vi.stubEnv('VITE_SUPABASE_URL', 'https://supabase.test');
  vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'anon-key');
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
  clearSupabaseSession();
});

test('keeps the public landing available to signed-in testers at /landing', () => {
  saveSupabaseSession({
    accessToken: 'access-token',
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
    refreshToken: 'refresh-token',
  });
  window.history.replaceState({}, '', '/landing');

  render(
    <AuthGate>
      <p>Area autenticata</p>
    </AuthGate>
  );

  expect(
    screen.getByRole('heading', {
      level: 1,
      name: 'Un corso intero. Un passo alla volta.',
    })
  ).toBeInTheDocument();
  expect(screen.queryByText('Area autenticata')).toBeNull();
});

test('AuthGate refreshes an expired stored session without requiring another login', async () => {
  saveSupabaseSession({
    accessToken: 'expired-token',
    expiresAt: Math.floor(Date.now() / 1000) - 60,
    refreshToken: 'refresh-token',
  });
  fetchMock.mockResolvedValueOnce({
    ok: true,
    json: async () => ({
      access_token: 'access-token-new',
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      refresh_token: 'refresh-token-new',
    }),
  });

  render(
    <AuthGate>
      <p>Area autenticata</p>
    </AuthGate>
  );

  await waitFor(() => expect(screen.getByText('Area autenticata')).toBeInTheDocument());
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

test('AuthGate reacts when the current tab clears the session', async () => {
  saveSupabaseSession({
    accessToken: 'access-token',
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
    refreshToken: 'refresh-token',
  });

  render(
    <AuthGate>
      <p>Area autenticata</p>
    </AuthGate>
  );
  expect(screen.getByText('Area autenticata')).toBeInTheDocument();
  expect(fetchMock).not.toHaveBeenCalled();

  act(() => clearSupabaseSession());

  await waitFor(() => expect(screen.getByRole('button', { name: 'Accedi' })).toBeInTheDocument());
});

test('AuthGate synchronizes logout events received from another tab', async () => {
  saveSupabaseSession({
    accessToken: 'access-token',
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
    refreshToken: 'refresh-token',
  });
  render(
    <AuthGate>
      <p>Area autenticata</p>
    </AuthGate>
  );
  expect(screen.getByText('Area autenticata')).toBeInTheDocument();

  act(() => {
    window.localStorage.removeItem('nousSupabaseSession');
    window.dispatchEvent(new StorageEvent('storage', { key: 'nousSupabaseSession' }));
  });

  await waitFor(() => expect(screen.getByRole('button', { name: 'Accedi' })).toBeInTheDocument());
});

test('an invalid callback never renders the stored account and shows a stable error', async () => {
  saveSupabaseSession({
    accessToken: 'old-account-token',
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
  });
  window.history.replaceState(
    {},
    '',
    '/#error=access_denied&error_code=otp_expired&error_description=expired'
  );

  render(
    <StrictMode>
      <AuthGate>
        <p>Area autenticata</p>
      </AuthGate>
    </StrictMode>
  );

  expect(screen.queryByText('Area autenticata')).toBeNull();
  expect(screen.getByRole('alert')).toHaveTextContent(
    'Il link non è valido o è scaduto. Richiedine uno nuovo.'
  );
  await waitFor(() => expect(window.location.hash).toBe(''));
  expect(screen.queryByText('Area autenticata')).toBeNull();
  expect(fetchMock).not.toHaveBeenCalled();
});

test('an invite callback forces matching password confirmation before opening the app', async () => {
  window.history.replaceState(
    {},
    '',
    '/#access_token=invite-token&refresh_token=refresh-token&expires_in=3600&type=invite'
  );
  fetchMock.mockResolvedValueOnce({
    ok: true,
    json: async () => ({
      id: 'invited-user',
      email: 'invited@example.com',
      identities: [{ provider: 'email' }],
    }),
  });

  render(
    <AuthGate>
      <p>Area autenticata</p>
    </AuthGate>
  );

  expect(screen.getByRole('heading', { name: 'Completa il tuo account' })).toBeInTheDocument();
  expect(screen.queryByText('Area autenticata')).toBeNull();
  await waitFor(() => expect(window.location.hash).toBe(''));
  fireEvent.change(screen.getByLabelText('Nuova password'), {
    target: { value: 'password-one' },
  });
  fireEvent.change(screen.getByLabelText('Conferma password'), {
    target: { value: 'password-two' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Imposta password ed entra' }));

  expect(screen.getByRole('alert')).toHaveTextContent('Le password non coincidono.');
  expect(fetchMock).not.toHaveBeenCalled();

  fireEvent.change(screen.getByLabelText('Conferma password'), {
    target: { value: 'password-one' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Imposta password ed entra' }));

  await waitFor(() => expect(screen.getByText('Area autenticata')).toBeInTheDocument());
  expect(JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string)).toEqual({
    password: 'password-one',
  });
});

test('a magic-link callback opens the app without asking for a password', async () => {
  window.history.replaceState(
    {},
    '',
    '/#access_token=magic-token&refresh_token=refresh-token&expires_in=3600&type=magiclink'
  );

  render(
    <AuthGate>
      <p>Area autenticata</p>
    </AuthGate>
  );

  expect(screen.getByText('Area autenticata')).toBeInTheDocument();
  expect(screen.queryByLabelText('Nuova password')).toBeNull();
  await waitFor(() => expect(window.location.hash).toBe(''));
  expect(screen.getByText('Area autenticata')).toBeInTheDocument();
  expect(fetchMock).not.toHaveBeenCalled();
});

test('a recovery callback keeps the app gated until the new password succeeds', async () => {
  window.history.replaceState(
    {},
    '',
    '/#access_token=recovery-token&refresh_token=refresh-token&expires_in=3600&type=recovery'
  );
  fetchMock.mockResolvedValueOnce({
    ok: false,
    status: 401,
  });

  render(
    <AuthGate>
      <p>Area autenticata</p>
    </AuthGate>
  );

  expect(screen.getByRole('heading', { name: 'Scegli una nuova password' })).toBeInTheDocument();
  expect(screen.queryByText('Area autenticata')).toBeNull();
  await waitFor(() => expect(window.location.hash).toBe(''));
  fireEvent.change(screen.getByLabelText('Nuova password'), {
    target: { value: 'password-one' },
  });
  fireEvent.change(screen.getByLabelText('Conferma password'), {
    target: { value: 'password-one' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Salva la nuova password' }));

  expect(await screen.findByRole('alert')).toHaveTextContent(
    'Non è stato possibile salvare la password. Riprova; se il link è scaduto, richiedine uno nuovo.'
  );
  expect(screen.queryByText('Area autenticata')).toBeNull();

  fetchMock.mockResolvedValueOnce({
    ok: true,
    json: async () => ({
      id: 'recovered-user',
      email: 'recovered@example.com',
      identities: [{ provider: 'email' }],
    }),
  });

  fireEvent.click(screen.getByRole('button', { name: 'Salva la nuova password' }));

  await waitFor(() => expect(screen.getByText('Area autenticata')).toBeInTheDocument());
});

test('forgot password always shows the same account-neutral confirmation', async () => {
  fetchMock.mockResolvedValueOnce({ ok: true });
  render(
    <AuthGate>
      <p>Area autenticata</p>
    </AuthGate>
  );

  fireEvent.click(screen.getByRole('button', { name: 'Accedi' }));
  fireEvent.change(screen.getByLabelText('Email'), {
    target: { value: 'unknown@example.com' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Password dimenticata?' }));

  expect(
    await screen.findByText(
      'Se esiste un account per questa email, riceverai un link per scegliere una nuova password.'
    )
  ).toBeInTheDocument();
  expect(fetchMock).toHaveBeenCalledWith(
    'https://supabase.test/auth/v1/recover',
    expect.objectContaining({ method: 'POST' })
  );
});
