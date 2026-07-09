// @vitest-environment jsdom
import { act, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';

import AuthGate from '../../../components/auth/AuthGate.tsx';
import { clearSupabaseSession, saveSupabaseSession } from '../../../services/auth/supabaseAuth.ts';

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubEnv('VITE_AUTH_MODE', 'supabase');
  vi.stubEnv('VITE_SUPABASE_URL', 'https://supabase.test');
  vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'anon-key');
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
  clearSupabaseSession();
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
