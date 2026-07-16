import { beforeEach, describe, expect, test, vi } from 'vitest';

const fetchWithSupabaseAuthMock = vi.hoisted(() => vi.fn());

vi.mock('../../../services/auth/supabaseAuth.ts', () => ({
  fetchWithSupabaseAuth: fetchWithSupabaseAuthMock,
}));

vi.mock('../../../services/openrouter/config.ts', () => ({
  getBackendUrl: () => 'http://localhost:3301',
}));

const { createAdminUser, sendAdminAccessEmail, updateAdminUser } = await import(
  '../../../services/admin/adminApi.ts'
);

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
});
