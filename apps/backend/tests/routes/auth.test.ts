// Verifies the server-owned password setup boundary and its stable error contract.
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { createApp } from '../../src/index.js';
import { createSupabaseTestToken } from '../helpers/auth.js';

const ORIGINAL_ENV = { ...process.env };
const authHeader = (token: string) => `Bearer ${token}`;

describe('/api/auth/password-setup', () => {
  beforeEach(() => {
    process.env = {
      ...ORIGINAL_ENV,
      AUTH_MODE: 'supabase',
      OPENROUTER_API_KEY: 'test-openrouter-key',
      SUPABASE_JWT_SECRET: 'test-secret',
      SUPABASE_SERVICE_ROLE_KEY: 'service-role-key',
      SUPABASE_URL: 'https://example.supabase.co',
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    process.env = { ...ORIGINAL_ENV };
  });

  test('atomically sets the password and removes the pending marker', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: 'pending-user' })));
    vi.stubGlobal('fetch', fetchMock);
    const token = createSupabaseTestToken({
      passwordSetupRequired: true,
      userId: 'pending-user',
    });

    const response = await request(createApp())
      .put('/api/auth/password-setup')
      .set('Authorization', authHeader(token))
      .send({ password: 'correct horse battery staple' });

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://example.supabase.co/auth/v1/admin/users/pending-user',
      expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({
          password: 'correct horse battery staple',
          app_metadata: { password_setup_required: null },
        }),
      })
    );
  });

  test('does not expose service-role password changes to completed accounts', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const token = createSupabaseTestToken({ userId: 'completed-user' });

    const response = await request(createApp())
      .put('/api/auth/password-setup')
      .set('Authorization', authHeader(token))
      .send({ password: 'new-password' });

    expect(response.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('maps weak passwords without exposing the provider response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              code: 422,
              error_code: 'weak_password',
              msg: 'provider detail',
              weak_password: { reasons: ['length'] },
            }),
            { status: 422 }
          )
      )
    );
    const token = createSupabaseTestToken({ passwordSetupRequired: true });

    const response = await request(createApp())
      .put('/api/auth/password-setup')
      .set('Authorization', authHeader(token))
      .send({ password: 'weak' });

    expect(response.status).toBe(422);
    expect(response.body).toEqual({
      success: false,
      code: 'weak_password',
      error: 'La password è troppo debole. Scegline una più lunga e difficile.',
    });
    expect(JSON.stringify(response.body)).not.toContain('provider detail');
  });

  test('keeps provider outages retryable without clearing the marker', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('provider detail', { status: 503 }))
    );
    const token = createSupabaseTestToken({ passwordSetupRequired: true });

    const response = await request(createApp())
      .put('/api/auth/password-setup')
      .set('Authorization', authHeader(token))
      .send({ password: 'strong-password' });

    expect(response.status).toBe(502);
    expect(response.body).toEqual({
      success: false,
      code: 'password_setup_unavailable',
      error: 'Salvataggio della password non riuscito. Riprova.',
    });
  });

  test('does not mislabel an unrelated 422 as a weak password', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () => new Response(JSON.stringify({ code: 'validation_failed' }), { status: 422 })
      )
    );
    const token = createSupabaseTestToken({ passwordSetupRequired: true });

    const response = await request(createApp())
      .put('/api/auth/password-setup')
      .set('Authorization', authHeader(token))
      .send({ password: 'strong-password' });

    expect(response.status).toBe(502);
    expect(response.body.code).toBe('password_setup_unavailable');
  });
});
