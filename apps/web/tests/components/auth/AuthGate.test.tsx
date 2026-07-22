// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { StrictMode } from 'react';
import { beforeEach, expect, test, vi } from 'vitest';

import AuthGate from '../../../components/auth/AuthGate.tsx';
import { clearSupabaseSession, saveSupabaseSession } from '../../../services/auth/supabaseAuth.ts';

const fetchMock = vi.fn();

const createAccessToken = ({
  passwordSetupRequired = false,
  userId = 'user-123',
}: {
  passwordSetupRequired?: boolean;
  userId?: string;
} = {}): string => {
  const encode = (value: unknown) =>
    btoa(JSON.stringify(value)).replaceAll(/\+/g, '-').replaceAll(/\//g, '_').replaceAll(/=/g, '');
  return `${encode({ alg: 'none' })}.${encode({
    sub: userId,
    email: `${userId}@example.com`,
    app_metadata: {
      provider: 'email',
      providers: ['email'],
      ...(passwordSetupRequired ? { password_setup_required: true } : {}),
    },
  })}.signature`;
};

beforeEach(() => {
  globalThis.history.replaceState({}, '', '/');
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
  globalThis.history.replaceState({}, '', '/landing');

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
    globalThis.localStorage.removeItem('nousSupabaseSession');
    globalThis.dispatchEvent(new StorageEvent('storage', { key: 'nousSupabaseSession' }));
  });

  await waitFor(() => expect(screen.getByRole('button', { name: 'Accedi' })).toBeInTheDocument());
});

test('an invalid callback never renders the stored account and shows a stable error', async () => {
  saveSupabaseSession({
    accessToken: 'old-account-token',
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
  });
  globalThis.history.replaceState(
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
  await waitFor(() => expect(globalThis.location.hash).toBe(''));
  expect(screen.queryByText('Area autenticata')).toBeNull();
  expect(fetchMock).not.toHaveBeenCalled();
});

test('a pre-marked magic-link callback forces password setup before opening the app', async () => {
  const inviteToken = createAccessToken({ passwordSetupRequired: true, userId: 'invited-user' });
  const completedToken = createAccessToken({ userId: 'invited-user' });
  globalThis.history.replaceState(
    {},
    '',
    `/#access_token=${inviteToken}&refresh_token=refresh-token&expires_in=3600&type=magiclink`
  );
  fetchMock
    .mockResolvedValueOnce(new Response(JSON.stringify({ success: true }), { status: 200 }))
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({ access_token: completedToken, refresh_token: 'new-refresh-token' }),
        { status: 200 }
      )
    );

  render(
    <AuthGate>
      <p>Area autenticata</p>
    </AuthGate>
  );

  expect(screen.getByRole('heading', { name: 'Completa il tuo account' })).toBeInTheDocument();
  expect(screen.queryByText('Area autenticata')).toBeNull();
  await waitFor(() => expect(globalThis.location.hash).toBe(''));
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
  expect(fetchMock.mock.calls[0]?.[0]).toBe('http://localhost:3301/api/auth/password-setup');
  expect(JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string)).toEqual({
    password: 'password-one',
  });
});

test('a magic-link callback opens the app without asking for a password', async () => {
  const magicToken = createAccessToken();
  globalThis.history.replaceState(
    {},
    '',
    `/#access_token=${magicToken}&refresh_token=refresh-token&expires_in=3600&type=magiclink`
  );

  render(
    <AuthGate>
      <p>Area autenticata</p>
    </AuthGate>
  );

  expect(screen.getByText('Area autenticata')).toBeInTheDocument();
  expect(screen.queryByLabelText('Nuova password')).toBeNull();
  await waitFor(() => expect(globalThis.location.hash).toBe(''));
  expect(screen.getByText('Area autenticata')).toBeInTheDocument();
  expect(fetchMock).not.toHaveBeenCalled();
});

test('a final recovery 401 clears the session and returns to an expired-link login', async () => {
  const recoveryToken = createAccessToken({ userId: 'recovered-user' });
  globalThis.history.replaceState(
    {},
    '',
    `/#access_token=${recoveryToken}&expires_in=3600&type=recovery`
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
  await waitFor(() => expect(globalThis.location.hash).toBe(''));
  fireEvent.change(screen.getByLabelText('Nuova password'), {
    target: { value: 'password-one' },
  });
  fireEvent.change(screen.getByLabelText('Conferma password'), {
    target: { value: 'password-one' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Salva la nuova password' }));

  expect(await screen.findByRole('alert')).toHaveTextContent(
    'Il link non è valido o è scaduto. Richiedine uno nuovo.'
  );
  expect(screen.queryByText('Area autenticata')).toBeNull();
  expect(screen.queryByLabelText('Nuova password')).toBeNull();
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

test.each([
  {
    body: { error_code: 'weak_password' },
    expectedMessage: 'La password è troppo debole. Scegline una più lunga e difficile.',
    status: 422,
  },
  {
    body: null,
    expectedMessage: 'Non è stato possibile salvare la password. Riprova tra poco.',
    status: 503,
  },
])('keeps the recovery gate retryable after a $status response', async ({
  body,
  expectedMessage,
  status,
}) => {
  const recoveryToken = createAccessToken({ userId: 'recovered-user' });
  globalThis.history.replaceState(
    {},
    '',
    `/#access_token=${recoveryToken}&expires_in=3600&type=recovery`
  );
  fetchMock.mockResolvedValueOnce(new Response(body ? JSON.stringify(body) : '', { status }));

  render(
    <AuthGate>
      <p>Area autenticata</p>
    </AuthGate>
  );

  await waitFor(() => expect(globalThis.location.hash).toBe(''));
  fireEvent.change(screen.getByLabelText('Nuova password'), {
    target: { value: 'password-one' },
  });
  fireEvent.change(screen.getByLabelText('Conferma password'), {
    target: { value: 'password-one' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Salva la nuova password' }));

  expect(await screen.findByRole('alert')).toHaveTextContent(expectedMessage);
  expect(screen.getByRole('heading', { name: 'Scegli una nuova password' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Salva la nuova password' })).toBeEnabled();
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

test('announces public email delivery while the request is pending', async () => {
  let resolveRequest: ((response: Response) => void) | undefined;
  fetchMock.mockReturnValueOnce(
    new Promise<Response>(resolve => {
      resolveRequest = resolve;
    })
  );
  render(
    <AuthGate>
      <p>Area autenticata</p>
    </AuthGate>
  );

  fireEvent.click(screen.getByRole('button', { name: 'Accedi' }));
  const emailInput = screen.getByLabelText('Email');
  fireEvent.change(emailInput, { target: { value: 'student@example.com' } });
  fireEvent.click(screen.getByRole('button', { name: 'Magic link' }));

  expect(emailInput.closest('form')).toHaveAttribute('aria-busy', 'true');
  expect(screen.getByRole('status')).toHaveTextContent('Operazione in corso…');

  act(() => resolveRequest?.(new Response('', { status: 200 })));
  expect(
    await screen.findByText('Se esiste un account per questa email, riceverai un link di accesso.')
  ).toBeInTheDocument();
});
