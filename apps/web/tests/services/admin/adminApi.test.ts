import { beforeEach, describe, expect, test, vi } from 'vitest';

const fetchWithSupabaseAuthMock = vi.hoisted(() => vi.fn());

vi.mock('../../../services/auth/supabaseAuth.ts', () => ({
  fetchWithSupabaseAuth: fetchWithSupabaseAuthMock,
}));

vi.mock('../../../services/openrouter/config.ts', () => ({
  getBackendUrl: () => 'http://localhost:3301',
}));

const {
  DEFAULT_ADMIN_MODEL_CONFIG,
  createAdminUser,
  listAdminFeedback,
  listAdminUsers,
  loadCourseCoverRegenerationStatus,
  loadAdminFeedbackScreenshot,
  retryAdminFeedback,
  runAdminYouTubeResearchLab,
  sendAdminAccessEmail,
  startCourseCoverRegeneration,
  syncAdminFeedback,
  updateAdminUser,
} = await import('../../../services/admin/adminApi.ts');

describe('admin user provider payloads', () => {
  beforeEach(() => {
    fetchWithSupabaseAuthMock.mockReset();
    fetchWithSupabaseAuthMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          user: {
            id: 'user-1',
            email: 'student@example.com',
            app_metadata: { role: 'user' },
          },
        }),
        { status: 200 }
      )
    );
  });

  test('defaults OpenAI research to its Chat Completions search model', () => {
    expect(DEFAULT_ADMIN_MODEL_CONFIG.openAiResearchModel).toBe('gpt-5-search-api');
  });

  test('includes an explicit provider when creating a user', async () => {
    await createAdminUser({
      aiProvider: 'openai',
      email: 'student@example.com',
      password: 'g1ovann1',
      role: 'user',
    });

    expect(fetchWithSupabaseAuthMock).toHaveBeenCalledWith(
      'http://localhost:3301/api/admin/users',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          aiProvider: 'openai',
          email: 'student@example.com',
          password: 'g1ovann1',
          role: 'user',
        }),
      })
    );
  });

  test('sends null to restore the global provider fallback', async () => {
    await updateAdminUser('user/1', { aiProvider: null });

    expect(fetchWithSupabaseAuthMock).toHaveBeenCalledWith(
      'http://localhost:3301/api/admin/users/user%2F1',
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({ aiProvider: null }),
      })
    );
  });

  test('returns the authoritative admin access-email delivery kind', async () => {
    fetchWithSupabaseAuthMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ delivery: 'invitation' }), { status: 200 })
    );

    await expect(sendAdminAccessEmail('new@example.com')).resolves.toBe('invitation');
    expect(fetchWithSupabaseAuthMock).toHaveBeenCalledWith(
      'http://localhost:3301/api/admin/users/access-email',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ email: 'new@example.com' }),
      })
    );
  });

  test('loads a server-paginated user page', async () => {
    fetchWithSupabaseAuthMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          hasMore: true,
          page: 2,
          pageSize: 8,
          users: [{ id: 'user-9', email: 'student9@example.com' }],
        }),
        { status: 200 }
      )
    );

    await expect(listAdminUsers(2, 8)).resolves.toMatchObject({
      hasMore: true,
      page: 2,
      users: [{ id: 'user-9' }],
    });
    expect(fetchWithSupabaseAuthMock).toHaveBeenCalledWith(
      'http://localhost:3301/api/admin/users?page=2&pageSize=8',
      expect.any(Object)
    );
  });

  test('loads a paginated feedback page through the authenticated admin endpoint', async () => {
    fetchWithSupabaseAuthMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ page: 2, pageSize: 10, reports: [], total: 14 }), {
        status: 200,
      })
    );

    await expect(listAdminFeedback(2, 10)).resolves.toEqual({
      page: 2,
      pageSize: 10,
      reports: [],
      total: 14,
    });
    expect(fetchWithSupabaseAuthMock).toHaveBeenCalledWith(
      'http://localhost:3301/api/feedback/admin?page=2&pageSize=10',
      expect.any(Object)
    );
  });

  test('fetches protected screenshots and retries GitHub delivery', async () => {
    fetchWithSupabaseAuthMock
      .mockResolvedValueOnce(new Response(new Blob(['image']), { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 202 }));

    await expect(loadAdminFeedbackScreenshot('feedback/1')).resolves.toBeInstanceOf(Blob);
    await retryAdminFeedback('feedback/1');

    expect(fetchWithSupabaseAuthMock).toHaveBeenNthCalledWith(
      1,
      'http://localhost:3301/api/feedback/admin/feedback%2F1/screenshot'
    );
    expect(fetchWithSupabaseAuthMock).toHaveBeenNthCalledWith(
      2,
      'http://localhost:3301/api/feedback/admin/feedback%2F1/retry',
      expect.objectContaining({ method: 'POST' })
    );
  });

  test('triggers the authenticated GitHub feedback synchronization', async () => {
    fetchWithSupabaseAuthMock.mockResolvedValueOnce(
      Response.json({ issueCount: 118, synchronizedAt: '2026-07-16T12:00:00.000Z' })
    );

    await expect(syncAdminFeedback()).resolves.toEqual({
      issueCount: 118,
      synchronizedAt: '2026-07-16T12:00:00.000Z',
    });
    expect(fetchWithSupabaseAuthMock).toHaveBeenCalledWith(
      'http://localhost:3301/api/feedback/admin/sync',
      expect.objectContaining({ method: 'POST' })
    );
  });

  test('uses separate authenticated endpoints for cover status and explicit start', async () => {
    const job = {
      id: 'course-cover-p2-job',
      promptVersion: 2,
      results: [],
      startedAt: '2026-07-17T00:00:00.000Z',
      status: 'running',
      summary: { failed: 0, pending: 1, regenerated: 0, skipped: 0, total: 1 },
      updatedAt: '2026-07-17T00:00:00.000Z',
    };
    fetchWithSupabaseAuthMock
      .mockResolvedValueOnce(Response.json({ job: null }))
      .mockResolvedValueOnce(Response.json({ job }));

    await expect(loadCourseCoverRegenerationStatus()).resolves.toBeNull();
    await expect(startCourseCoverRegeneration()).resolves.toEqual(job);

    expect(fetchWithSupabaseAuthMock).toHaveBeenNthCalledWith(
      1,
      'http://localhost:3301/api/projects/covers/regenerate/status',
      expect.any(Object)
    );
    expect(fetchWithSupabaseAuthMock).toHaveBeenNthCalledWith(
      2,
      'http://localhost:3301/api/projects/covers/regenerate',
      expect.any(Object)
    );
  });

  test('runs YouTube diagnostics through the authenticated admin endpoint', async () => {
    fetchWithSupabaseAuthMock.mockResolvedValueOnce(
      Response.json({
        diagnostic: { query: 'Bordi e curve Pixel art' },
        productionVideoClipsEnabled: false,
      })
    );

    await expect(
      runAdminYouTubeResearchLab({
        contextWindowTokens: 128_000,
        language: 'Italiano',
        nonYouTubePromptTokens: 8_000,
        query: 'Bordi e curve Pixel art',
        reservedOutputTokens: 32_000,
      })
    ).resolves.toMatchObject({ productionVideoClipsEnabled: false });
    expect(fetchWithSupabaseAuthMock).toHaveBeenCalledWith(
      'http://localhost:3301/api/youtube/admin/research-lab',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          contextWindowTokens: 128_000,
          language: 'Italiano',
          nonYouTubePromptTokens: 8_000,
          query: 'Bordi e curve Pixel art',
          reservedOutputTokens: 32_000,
        }),
      })
    );
  });
});
