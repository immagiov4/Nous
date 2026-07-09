import { beforeEach, describe, expect, test, vi } from 'vitest';

import {
  clearSupabaseSession,
  fetchWithSupabaseAuth,
  getSupabaseAuthHeaders,
  getValidSupabaseSession,
  mergeSupabaseAuthHeaders,
  readSupabaseSession,
  saveSupabaseSession,
  scheduleSupabaseSessionRefresh,
} from '../../../services/auth/supabaseAuth.ts';

describe('Supabase auth session storage', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
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
});
