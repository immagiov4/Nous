// @vitest-environment jsdom
import { beforeEach, describe, expect, test, vi } from 'vitest';
import {
  clearSupabaseSession,
  completeSupabasePasswordSetup,
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
import { TransientRequestError } from '../../../services/core/errorMessage.ts';

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

describe('Supabase auth session storage', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    globalThis.history.replaceState({}, '', '/');
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

  test('derives the pending setup marker from the access token on every read', () => {
    const accessToken = createAccessToken({ passwordSetupRequired: true, userId: 'pending-user' });
    saveSupabaseSession({
      accessToken,
      user: { id: 'pending-user', passwordSetupRequired: false },
    });

    expect(readSupabaseSession()?.user).toMatchObject({
      id: 'pending-user',
      passwordSetupRequired: true,
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

  test('password sign-in leaves the public landing for the app root', async () => {
    globalThis.history.replaceState({}, '', '/landing');
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ access_token: createAccessToken(), user: { id: 'user-123' } }),
    });

    await signInWithPassword({ email: 'student@example.com', password: 'password' });

    expect(globalThis.location.pathname).toBe('/');
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

  test('records the backend correlation code for a terminal request failure', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    fetchMock.mockResolvedValueOnce({
      headers: new Headers({ 'x-request-id': '123e4567-e89b-12d3-a456-426614174000' }),
      ok: false,
      status: 503,
    });

    await fetchWithSupabaseAuth('https://backend.test/api/projects');

    expect(warn).toHaveBeenCalledWith(
      '[Nous][API] Codice assistenza: 123e4567-e89b-12d3-a456-426614174000'
    );
    warn.mockRestore();
  });

  test('does not record a backend correlation code for an expected response status', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    fetchMock.mockResolvedValueOnce({
      headers: new Headers({ 'x-request-id': '123e4567-e89b-12d3-a456-426614174000' }),
      ok: false,
      status: 404,
    });

    await fetchWithSupabaseAuth(
      'https://backend.test/api/course-workflows/courses/project-1/active',
      {},
      { expectedStatuses: [404] }
    );

    expect(warn).not.toHaveBeenCalled();
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

    const refresh = getValidSupabaseSession();
    await expect(refresh).rejects.toBeInstanceOf(TransientRequestError);
    await expect(refresh).rejects.toThrow(
      'Aggiornamento sessione temporaneamente non disponibile.'
    );
    expect(readSupabaseSession()?.refreshToken).toBe('refresh-token');
  });

  test('keeps refresh credentials when reading a successful refresh body is interrupted', async () => {
    saveSupabaseSession({
      accessToken: 'expired-token',
      expiresAt: Math.floor(Date.now() / 1000) - 60,
      refreshToken: 'refresh-token',
    });
    fetchMock.mockResolvedValueOnce({
      json: vi.fn().mockRejectedValue(new TypeError('response stream interrupted')),
      ok: true,
      status: 200,
    });

    await expect(getValidSupabaseSession()).rejects.toBeInstanceOf(TransientRequestError);
    expect(readSupabaseSession()?.refreshToken).toBe('refresh-token');
  });

  test('keeps refresh credentials when a successful refresh body contains malformed JSON', async () => {
    saveSupabaseSession({
      accessToken: 'expired-token',
      expiresAt: Math.floor(Date.now() / 1000) - 60,
      refreshToken: 'refresh-token',
    });
    fetchMock.mockResolvedValueOnce({
      json: vi.fn().mockRejectedValue(new SyntaxError('Unexpected end of JSON input')),
      ok: true,
      status: 200,
    });

    await expect(getValidSupabaseSession()).rejects.toBeInstanceOf(TransientRequestError);
    expect(readSupabaseSession()?.refreshToken).toBe('refresh-token');
  });

  test('keeps refresh credentials when a successful refresh body violates the session contract', async () => {
    saveSupabaseSession({
      accessToken: 'expired-token',
      expiresAt: Math.floor(Date.now() / 1000) - 60,
      refreshToken: 'refresh-token',
    });
    fetchMock.mockResolvedValueOnce({
      json: vi.fn().mockResolvedValue({ success: true }),
      ok: true,
      status: 200,
    });

    await expect(getValidSupabaseSession()).rejects.toBeInstanceOf(TransientRequestError);
    expect(readSupabaseSession()?.refreshToken).toBe('refresh-token');
  });

  test('does not restore a session when its in-flight refresh completes after sign out', async () => {
    saveSupabaseSession({
      accessToken: 'expired-token',
      expiresAt: Math.floor(Date.now() / 1000) - 60,
      refreshToken: 'refresh-token-old',
      user: { id: 'old-user' },
    });
    let finishRefresh: ((response: unknown) => void) | undefined;
    fetchMock
      .mockImplementationOnce(
        () =>
          new Promise(resolve => {
            finishRefresh = resolve;
          })
      )
      .mockResolvedValueOnce({ ok: true, status: 204 });

    const refresh = getValidSupabaseSession();
    await signOutSupabase();
    finishRefresh?.({
      json: async () => ({
        access_token: 'access-token-refreshed',
        expires_at: Math.floor(Date.now() / 1000) + 3600,
        refresh_token: 'refresh-token-refreshed',
        user: { id: 'old-user' },
      }),
      ok: true,
      status: 200,
    });

    await expect(refresh).resolves.toBeNull();
    expect(readSupabaseSession()).toBeNull();
  });

  test('does not overwrite a newer account when an older refresh completes', async () => {
    saveSupabaseSession({
      accessToken: 'expired-token',
      expiresAt: Math.floor(Date.now() / 1000) - 60,
      refreshToken: 'refresh-token-old',
      user: { id: 'old-user' },
    });
    let finishRefresh: ((response: unknown) => void) | undefined;
    fetchMock
      .mockImplementationOnce(
        () =>
          new Promise(resolve => {
            finishRefresh = resolve;
          })
      )
      .mockResolvedValueOnce({
        json: async () => ({
          access_token: createAccessToken({ userId: 'new-user' }),
          expires_at: Math.floor(Date.now() / 1000) + 3600,
          refresh_token: 'refresh-token-new',
          user: { id: 'new-user' },
        }),
        ok: true,
        status: 200,
      });

    const refresh = getValidSupabaseSession();
    const newSession = await signInWithPassword({
      email: 'new-user@example.com',
      password: 'password',
    });
    finishRefresh?.({
      json: async () => ({
        access_token: 'access-token-refreshed-old-user',
        expires_at: Math.floor(Date.now() / 1000) + 3600,
        refresh_token: 'refresh-token-refreshed-old-user',
        user: { id: 'old-user' },
      }),
      ok: true,
      status: 200,
    });

    await expect(refresh).resolves.toMatchObject({ accessToken: newSession.accessToken });
    expect(readSupabaseSession()).toMatchObject({
      accessToken: newSession.accessToken,
      refreshToken: 'refresh-token-new',
      user: { id: 'new-user' },
    });
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
    const inviteToken = createAccessToken({
      passwordSetupRequired: true,
      userId: 'invited-user',
    });
    globalThis.history.replaceState(
      {},
      '',
      `/landing#access_token=${inviteToken}&refresh_token=refresh-token&expires_in=3600&type=invite`
    );

    expect(readSupabaseAuthCallbackFromUrl()).toEqual({
      status: 'success',
      session: {
        accessToken: inviteToken,
        authAction: 'invite',
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
        refreshToken: 'refresh-token',
        user: {
          email: 'invited-user@example.com',
          id: 'invited-user',
          passwordSetupRequired: true,
          providers: ['email'],
        },
      },
    });
    expect(globalThis.location.hash).toContain('type=invite');
    expect(readSupabaseSession()).toBeNull();

    expect(consumeSupabaseAuthCallbackFromUrl().status).toBe('success');
    expect(globalThis.location.hash).toBe('');
    expect(globalThis.location.pathname).toBe('/');
    expect(readSupabaseSession()).toMatchObject({
      accessToken: inviteToken,
      authAction: 'invite',
      user: { passwordSetupRequired: true },
    });
  });

  test('scrubs a callback without moving a non-landing route', () => {
    const accessToken = createAccessToken();
    globalThis.history.replaceState({}, '', `/reader?course=one#access_token=${accessToken}`);

    expect(consumeSupabaseAuthCallbackFromUrl().status).toBe('success');

    expect(globalThis.location.pathname).toBe('/reader');
    expect(globalThis.location.search).toBe('?course=one');
    expect(globalThis.location.hash).toBe('');
  });

  test('an invalid callback clears a stored account instead of falling back to it', () => {
    saveSupabaseSession({ accessToken: 'old-account-token' });
    globalThis.history.replaceState(
      {},
      '',
      '/#error=access_denied&error_code=otp_expired&error_description=expired'
    );

    expect(readSupabaseAuthCallbackFromUrl()).toEqual({ status: 'error', session: null });
    expect(readSupabaseSession()?.accessToken).toBe('old-account-token');

    expect(consumeSupabaseAuthCallbackFromUrl()).toEqual({ status: 'error', session: null });
    expect(readSupabaseSession()).toBeNull();
    expect(globalThis.location.hash).toBe('');
  });

  test('keeps ordinary account password changes on the user-scoped endpoint', async () => {
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
    expect(readSupabaseSession()?.authAction).toBe('recovery');
  });

  test('completes recovery for a non-pending account through the user-scoped endpoint', async () => {
    const accessToken = createAccessToken({ userId: 'recovered-user' });
    saveSupabaseSession({ accessToken, authAction: 'recovery' });
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          id: 'recovered-user',
          email: 'recovered-user@example.com',
          app_metadata: { provider: 'email', providers: ['email'] },
        }),
        { status: 200 }
      )
    );

    await completeSupabasePasswordSetup('new-password');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://supabase.test/auth/v1/user',
      expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({ password: 'new-password' }),
      })
    );
    expect(readSupabaseSession()?.authAction).toBeUndefined();
  });

  test.each([
    { code: 'weak_password', reason: 'weak-password' },
    { code: 'validation_failed', reason: 'retryable' },
  ] as const)('classifies recovery 422 code $code precisely', async ({ code, reason }) => {
    const accessToken = createAccessToken({ userId: 'recovered-user' });
    saveSupabaseSession({ accessToken, authAction: 'recovery' });
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error_code: code }), { status: 422 })
    );

    await expect(completeSupabasePasswordSetup('new-password')).rejects.toMatchObject({ reason });
    expect(readSupabaseSession()?.authAction).toBe('recovery');
  });

  test('clears the password gate only after atomic pending setup and a password grant', async () => {
    const pendingToken = createAccessToken({
      passwordSetupRequired: true,
      userId: 'invited-user',
    });
    const completedToken = createAccessToken({ userId: 'invited-user' });
    saveSupabaseSession({
      accessToken: pendingToken,
      authAction: 'invite',
      refreshToken: 'refresh-token',
    });
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({ success: true }), { status: 200 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            access_token: completedToken,
            refresh_token: 'rotated-refresh-token',
          }),
          { status: 200 }
        )
      );

    await completeSupabasePasswordSetup('new-password');

    expect(fetchMock.mock.calls[0]?.[0]).toBe('http://localhost:3301/api/auth/password-setup');
    expect(JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string)).toEqual({
      password: 'new-password',
    });
    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      'https://supabase.test/auth/v1/token?grant_type=password'
    );
    expect(JSON.parse(fetchMock.mock.calls[1]?.[1]?.body as string)).toEqual({
      email: 'invited-user@example.com',
      password: 'new-password',
    });
    expect(readSupabaseSession()).toMatchObject({
      accessToken: completedToken,
      user: { id: 'invited-user', passwordSetupRequired: false },
    });
    expect(readSupabaseSession()?.authAction).toBeUndefined();
  });

  test('a final setup 401 clears the session instead of retrying the same token', async () => {
    const firstToken = createAccessToken({ passwordSetupRequired: true });
    const refreshedToken = createAccessToken({ passwordSetupRequired: true });
    saveSupabaseSession({
      accessToken: firstToken,
      authAction: 'invite',
      refreshToken: 'refresh-token',
    });
    fetchMock
      .mockResolvedValueOnce(new Response('', { status: 401 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ access_token: refreshedToken, refresh_token: 'rotated-refresh-token' }),
          { status: 200 }
        )
      )
      .mockResolvedValueOnce(new Response('', { status: 401 }));

    await expect(completeSupabasePasswordSetup('new-password')).rejects.toMatchObject({
      reason: 'expired',
    });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(readSupabaseSession()).toBeNull();
  });

  test.each([
    { body: { code: 'weak_password' }, status: 422, reason: 'weak-password' },
    { body: { code: 'validation_failed' }, status: 422, reason: 'retryable' },
    { body: null, status: 503, reason: 'retryable' },
  ] as const)('preserves a pending gate after a $status setup response', async ({
    body,
    reason,
    status,
  }) => {
    const accessToken = createAccessToken({ passwordSetupRequired: true });
    saveSupabaseSession({ accessToken, authAction: 'invite' });
    fetchMock.mockResolvedValueOnce(new Response(body ? JSON.stringify(body) : '', { status }));

    await expect(completeSupabasePasswordSetup('new-password')).rejects.toMatchObject({ reason });

    expect(readSupabaseSession()).toMatchObject({
      accessToken,
      authAction: 'invite',
      user: { passwordSetupRequired: true },
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
          redirect_to: `${globalThis.location.origin}/`,
        }),
      })
    );
  });

  test('normalizes only account-absence rejections for public email requests', async () => {
    const warningSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    fetchMock
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error_code: 'user_not_found', message: 'private detail' }), {
          status: 404,
        })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error_code: 'otp_disabled' }), { status: 422 })
      );

    await expect(sendPasswordRecovery('unknown@example.com')).resolves.toBeUndefined();
    await expect(sendMagicLink('unknown@example.com')).resolves.toBeUndefined();

    expect(warningSpy).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(warningSpy.mock.calls)).not.toContain('private detail');
  });

  test('reports provider HTTP failures without exposing their raw message', async () => {
    const warningSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error_code: 'provider_failure', message: 'private detail' }), {
        status: 503,
      })
    );

    await expect(sendMagicLink('student@example.com')).rejects.toThrow(
      'Invio magic link non riuscito.'
    );
    expect(JSON.stringify(warningSpy.mock.calls)).not.toContain('private detail');
  });

  test('reports recovery rate limits as retryable failures', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error_code: 'over_request_rate_limit' }), { status: 429 })
    );

    await expect(sendPasswordRecovery('student@example.com')).rejects.toThrow(
      'Password recovery failed.'
    );
  });

  test('still reports network failures for public email requests', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('offline'));

    await expect(sendMagicLink('student@example.com')).rejects.toThrow('offline');
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
      redirect_to: `${globalThis.location.origin}/`,
    });
  });
});
