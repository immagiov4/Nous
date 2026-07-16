// @vitest-environment jsdom
import { beforeEach, describe, expect, test, vi } from 'vitest';

import {
  clearSupabaseSession,
  consumeSupabaseAuthCallbackFromUrl,
  fetchWithSupabaseAuth,
  getFrontendAuthMode,
  getSupabaseAuthHeaders,
  getValidSupabaseSession,
  loadSupabaseAccount,
  mergeSupabaseAuthHeaders,
  readSupabaseAuthCallbackFromUrl,
  readSupabaseSession,
  requestSupabaseEmailChange,
  resolveBrowserReachableSupabaseUrl,
  saveSupabaseSession,
  scheduleSupabaseSessionRefresh,
  sendMagicLink,
  sendPasswordRecovery,
  signInWithPassword,
  signOutSupabase,
  updateSupabasePassword,
} from '../../../services/auth/supabaseAuth.ts';

describe('Supabase auth session storage', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    window.history.replaceState({}, '', '/');
    clearSupabaseSession();
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
    vi.stubEnv('VITE_SUPABASE_URL', 'https://supabase.test');
    vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'anon-key');
  });

  test('persists access tokens and exposes backend Authorization headers', () => {
    saveSupabaseSession({
      accessToken: 'access-token-123',
      user: {
        id: 'user-123',
        email: 'student@example.com',
      },
    });

    expect(readSupabaseSession()).toMatchObject({
      accessToken: 'access-token-123',
      user: {
        id: 'user-123',
      },
    });
    expect(getSupabaseAuthHeaders()).toEqual({
      Authorization: 'Bearer access-token-123',
    });
    expect(mergeSupabaseAuthHeaders({ 'X-Existing-Header': 'kept' })).toEqual({
      Authorization: 'Bearer access-token-123',
      'x-existing-header': 'kept',
    });
  });

  test('loads only account data used by the product into the current session', async () => {
    saveSupabaseSession({ accessToken: 'access-token', user: { id: 'user-123' } });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        id: 'user-123',
        email: 'student@example.com',
        identities: [{ provider: 'email' }],
        user_metadata: {
          avatar_url: 'https://images.example/avatar.png',
          display_name: 'Ada',
        },
      }),
    });

    const account = await loadSupabaseAccount();

    expect(account).toEqual({
      email: 'student@example.com',
      id: 'user-123',
      providers: ['email'],
    });
    expect(readSupabaseSession()?.user).toEqual(account);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://supabase.test/auth/v1/user',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer access-token' }),
        method: 'GET',
      })
    );
  });

  test('uses an authenticated Supabase update for verified email changes', async () => {
    saveSupabaseSession({
      accessToken: 'access-token',
      user: { email: 'old@example.com', id: 'user-123', providers: ['email'] },
    });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        id: 'user-123',
        email: 'old@example.com',
        identities: [{ provider: 'email' }],
        user_metadata: { avatar_url: 'https://images.example/ada.png', display_name: 'Ada' },
      }),
    });
    await requestSupabaseEmailChange('new@example.com');

    expect(JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string)).toEqual({
      email: 'new@example.com',
    });
    expect(fetchMock.mock.calls.map(call => call[1]?.method)).toEqual(['PUT']);
  });

  test('revokes the current Supabase session before clearing local credentials', async () => {
    saveSupabaseSession({ accessToken: 'access-token', user: { id: 'user-123' } });
    fetchMock.mockResolvedValueOnce({ ok: true, status: 204 });

    await signOutSupabase();

    expect(fetchMock).toHaveBeenCalledWith(
      'https://supabase.test/auth/v1/logout?scope=local',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer access-token' }),
        method: 'POST',
      })
    );
    expect(readSupabaseSession()).toBeNull();
  });

  test('uses the device-visible host for a loopback Supabase URL', () => {
    expect(
      resolveBrowserReachableSupabaseUrl('http://127.0.0.1:54321', {
        hostname: '192.168.1.126',
      })
    ).toBe('http://192.168.1.126:54321');
    expect(
      resolveBrowserReachableSupabaseUrl('https://cloud.supabase.co', {
        hostname: '192.168.1.126',
      })
    ).toBe('https://cloud.supabase.co');
  });

  test('uses runtime deployment config for Supabase sign-in', async () => {
    vi.stubGlobal('__NOUS_RUNTIME_CONFIG__', {
      authMode: 'supabase',
      supabaseAnonKey: 'runtime-key',
      supabaseUrl: 'https://runtime.supabase.test',
    });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ access_token: 'runtime-access-token', user: { id: 'runtime-user' } }),
    });

    expect(getFrontendAuthMode()).toBe('supabase');
    await signInWithPassword({ email: 'student@example.com', password: 'password' });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://runtime.supabase.test/auth/v1/token?grant_type=password',
      expect.objectContaining({ headers: expect.objectContaining({ apikey: 'runtime-key' }) })
    );
  });

  test('falls back to memory when the runtime exposes incomplete localStorage', () => {
    vi.stubGlobal('localStorage', {});

    saveSupabaseSession({
      accessToken: 'memory-access-token',
      user: { id: 'memory-user' },
    });

    expect(readSupabaseSession()).toMatchObject({ accessToken: 'memory-access-token' });
    expect(getSupabaseAuthHeaders()).toEqual({ Authorization: 'Bearer memory-access-token' });
  });

  test('drops expired sessions without refresh credentials', async () => {
    saveSupabaseSession({
      accessToken: 'expired-token',
      expiresAt: Math.floor(Date.now() / 1000) - 60,
    });

    expect(await getValidSupabaseSession()).toBeNull();
    expect(readSupabaseSession()).toBeNull();
    expect(getSupabaseAuthHeaders()).toEqual({});
  });

  test('refreshes an expired session and persists rotated credentials', async () => {
    saveSupabaseSession({
      accessToken: 'expired-token',
      expiresAt: Math.floor(Date.now() / 1000) - 60,
      refreshToken: 'refresh-token-old',
      user: { id: 'user-123', email: 'student@example.com' },
    });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        access_token: 'access-token-new',
        expires_at: Math.floor(Date.now() / 1000) + 3600,
        refresh_token: 'refresh-token-new',
        user: { id: 'user-123', email: 'student@example.com' },
      }),
    });

    const session = await getValidSupabaseSession();

    expect(session).toMatchObject({
      accessToken: 'access-token-new',
      refreshToken: 'refresh-token-new',
    });
    expect(readSupabaseSession()).toMatchObject({
      accessToken: 'access-token-new',
      refreshToken: 'refresh-token-new',
    });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://supabase.test/auth/v1/token?grant_type=refresh_token',
      expect.objectContaining({
        body: JSON.stringify({ refresh_token: 'refresh-token-old' }),
      })
    );
  });

  test('coalesces concurrent session refreshes into one request', async () => {
    saveSupabaseSession({
      accessToken: 'expired-token',
      expiresAt: Math.floor(Date.now() / 1000) - 60,
      refreshToken: 'refresh-token',
    });
    let releaseRefresh: ((response: unknown) => void) | undefined;
    fetchMock.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          releaseRefresh = resolve;
        })
    );

    const sessionsPromise = Promise.all([
      getValidSupabaseSession(),
      getValidSupabaseSession(),
      getValidSupabaseSession(),
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    releaseRefresh?.({
      ok: true,
      json: async () => ({
        access_token: 'access-token-new',
        expires_at: Math.floor(Date.now() / 1000) + 3600,
        refresh_token: 'refresh-token-new',
      }),
    });
    const sessions = await sessionsPromise;

    expect(sessions.map(session => session?.accessToken)).toEqual([
      'access-token-new',
      'access-token-new',
      'access-token-new',
    ]);
  });

  test('retries one unauthorized backend request after refreshing the session', async () => {
    saveSupabaseSession({
      accessToken: 'access-token-old',
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
      refreshToken: 'refresh-token-old',
    });
    fetchMock
      .mockResolvedValueOnce({ ok: false, status: 401 })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          access_token: 'access-token-new',
          expires_at: Math.floor(Date.now() / 1000) + 3600,
          refresh_token: 'refresh-token-new',
        }),
      })
      .mockResolvedValueOnce({ ok: true, status: 200 });

    const response = await fetchWithSupabaseAuth('https://backend.test/api/projects');

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[2]?.[1]?.headers).toMatchObject({
      Authorization: 'Bearer access-token-new',
    });
  });

  test('does not retry again when the refreshed token also receives a 401', async () => {
    saveSupabaseSession({
      accessToken: 'access-token-old',
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
      refreshToken: 'refresh-token-old',
    });
    fetchMock
      .mockResolvedValueOnce({ ok: false, status: 401 })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          access_token: 'access-token-new',
          expires_at: Math.floor(Date.now() / 1000) + 3600,
          refresh_token: 'refresh-token-new',
        }),
      })
      .mockResolvedValueOnce({ ok: false, status: 401 });

    const response = await fetchWithSupabaseAuth('https://backend.test/api/projects');

    expect(response.status).toBe(401);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(readSupabaseSession()).toBeNull();
  });

  test('clears an invalid refresh session instead of retrying indefinitely', async () => {
    saveSupabaseSession({
      accessToken: 'expired-token',
      expiresAt: Math.floor(Date.now() / 1000) - 60,
      refreshToken: 'invalid-refresh-token',
    });
    fetchMock.mockResolvedValueOnce({ ok: false, status: 400 });

    expect(await getValidSupabaseSession()).toBeNull();
    expect(readSupabaseSession()).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('keeps refresh credentials after a temporary Supabase failure', async () => {
    saveSupabaseSession({
      accessToken: 'expired-token',
      expiresAt: Math.floor(Date.now() / 1000) - 60,
      refreshToken: 'refresh-token',
    });
    fetchMock.mockResolvedValueOnce({ ok: false, status: 503 });

    await expect(getValidSupabaseSession()).rejects.toThrow(
      'Aggiornamento sessione temporaneamente non disponibile.'
    );
    expect(readSupabaseSession()?.refreshToken).toBe('refresh-token');
  });

  test('never writes session credentials to console logs', async () => {
    const warningSpy = vi.spyOn(console, 'warn');
    const errorSpy = vi.spyOn(console, 'error');
    saveSupabaseSession({
      accessToken: 'secret-access-token',
      expiresAt: Math.floor(Date.now() / 1000) - 60,
      refreshToken: 'secret-refresh-token',
    });
    fetchMock.mockResolvedValueOnce({ ok: false, status: 400 });

    await getValidSupabaseSession();

    const loggedOutput = JSON.stringify([...warningSpy.mock.calls, ...errorSpy.mock.calls]);
    expect(loggedOutput).not.toContain('secret-access-token');
    expect(loggedOutput).not.toContain('secret-refresh-token');
  });

  test('schedules proactive refresh before the access token expires', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-09T20:00:00.000Z'));
    const refresh = vi.fn();
    const cancel = scheduleSupabaseSessionRefresh(
      {
        accessToken: 'access-token',
        expiresAt: Math.floor(Date.now() / 1000) + 120,
        refreshToken: 'refresh-token',
      },
      refresh
    );

    vi.advanceTimersByTime(89_999);
    expect(refresh).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(refresh).toHaveBeenCalledTimes(1);
    cancel();
  });

  test('preserves an invite callback action and derives expiry before scrubbing the URL', () => {
    vi.setSystemTime(new Date('2026-07-16T18:00:00.000Z'));
    window.history.replaceState(
      {},
      '',
      '/#access_token=invite-token&refresh_token=refresh-token&expires_in=3600&type=invite'
    );

    expect(readSupabaseAuthCallbackFromUrl()).toEqual({
      status: 'success',
      session: {
        accessToken: 'invite-token',
        authAction: 'invite',
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
        refreshToken: 'refresh-token',
      },
    });
    expect(window.location.hash).toContain('type=invite');
    expect(readSupabaseSession()).toBeNull();

    expect(consumeSupabaseAuthCallbackFromUrl().status).toBe('success');
    expect(window.location.hash).toBe('');
    expect(readSupabaseSession()).toMatchObject({
      accessToken: 'invite-token',
      authAction: 'invite',
    });
  });

  test('an invalid callback clears a stored account instead of falling back to it', () => {
    saveSupabaseSession({ accessToken: 'old-account-token' });
    window.history.replaceState(
      {},
      '',
      '/#error=access_denied&error_code=otp_expired&error_description=expired'
    );

    expect(readSupabaseAuthCallbackFromUrl()).toEqual({ status: 'error', session: null });
    expect(readSupabaseSession()?.accessToken).toBe('old-account-token');

    expect(consumeSupabaseAuthCallbackFromUrl()).toEqual({ status: 'error', session: null });
    expect(readSupabaseSession()).toBeNull();
    expect(window.location.hash).toBe('');
  });

  test('completes invite or recovery only after the authenticated password update succeeds', async () => {
    saveSupabaseSession({
      accessToken: 'recovery-token',
      authAction: 'recovery',
      user: { id: 'user-123', email: 'student@example.com' },
    });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        id: 'user-123',
        email: 'student@example.com',
        identities: [{ provider: 'email' }],
      }),
    });

    await updateSupabasePassword('new-password');

    expect(JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string)).toEqual({
      password: 'new-password',
    });
    expect(readSupabaseSession()).toMatchObject({
      accessToken: 'recovery-token',
      user: { id: 'user-123' },
    });
    expect(readSupabaseSession()?.authAction).toBeUndefined();
  });

  test('keeps the password gate active when the authenticated update fails', async () => {
    saveSupabaseSession({
      accessToken: 'invite-token',
      authAction: 'invite',
      user: { id: 'invited-user' },
    });
    fetchMock.mockResolvedValueOnce({ ok: false, status: 401 });

    await expect(updateSupabasePassword('rejected-password')).rejects.toThrow(
      'Account update failed.'
    );

    expect(readSupabaseSession()).toMatchObject({
      accessToken: 'invite-token',
      authAction: 'invite',
    });
  });

  test('sends password recovery to the native endpoint with a root redirect', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true });

    await sendPasswordRecovery(' student@example.com ');

    expect(fetchMock).toHaveBeenCalledWith(
      'https://supabase.test/auth/v1/recover',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          email: 'student@example.com',
          redirect_to: `${window.location.origin}/`,
        }),
      })
    );
  });

  test('keeps public magic-link responses generic when Auth reports an unknown account', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 422,
      json: async () => ({ error_code: 'otp_disabled' }),
    });

    await expect(sendMagicLink(' unknown@example.com ')).resolves.toBeUndefined();
    expect(JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string)).toEqual({
      create_user: false,
      email: 'unknown@example.com',
      type: 'magiclink',
      redirect_to: `${window.location.origin}/`,
    });
  });
});
