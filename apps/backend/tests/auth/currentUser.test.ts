import { webcrypto } from 'node:crypto';
import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { getCurrentUser, resolveCurrentUser } from '../../src/auth/currentUser.js';
import { signSupabaseJwt } from '../helpers/auth.js';

const ORIGINAL_ENV = { ...process.env };
const ORIGINAL_FETCH = globalThis.fetch;

const base64UrlJson = (value: unknown): string =>
  Buffer.from(JSON.stringify(value)).toString('base64url');

const createPrivateApp = () => {
  const app = express();
  app.get('/private', resolveCurrentUser, (req, res) => {
    const currentUser = getCurrentUser(req);
    res.json({
      aiProvider: currentUser.aiProvider,
      userId: currentUser.id,
      role: currentUser.role,
    });
  });

  return app;
};

describe('resolveCurrentUser', () => {
  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    globalThis.fetch = ORIGINAL_FETCH;
    vi.restoreAllMocks();
  });

  test('rejects missing bearer tokens in Supabase auth mode', async () => {
    process.env.AUTH_MODE = 'supabase';
    process.env.SUPABASE_JWT_SECRET = 'test-secret';

    const response = await request(createPrivateApp()).get('/private');

    expect(response.status).toBe(401);
    expect(response.body).toEqual({
      success: false,
      error: 'Accesso richiesto.',
    });
  });

  test('accepts a valid Supabase HS256 access token', async () => {
    process.env.AUTH_MODE = 'supabase';
    process.env.SUPABASE_JWT_SECRET = 'test-secret';
    const token = signSupabaseJwt(
      {
        sub: 'user-123',
        exp: Math.floor(Date.now() / 1000) + 60,
        app_metadata: {
          ai_provider: 'codex',
          role: 'admin',
        },
      },
      'test-secret'
    );

    const response = await request(createPrivateApp())
      .get('/private')
      .set('Authorization', `Bearer ${token}`);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      aiProvider: 'codex',
      userId: 'user-123',
      role: 'admin',
    });
  });

  test('does not trust user-editable metadata for authorization', async () => {
    process.env.AUTH_MODE = 'supabase';
    process.env.SUPABASE_JWT_SECRET = 'test-secret';
    const token = signSupabaseJwt(
      {
        sub: 'user-123',
        exp: Math.floor(Date.now() / 1000) + 60,
        user_metadata: {
          role: 'admin',
        },
      },
      'test-secret'
    );

    const response = await request(createPrivateApp())
      .get('/private')
      .set('Authorization', `Bearer ${token}`);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ userId: 'user-123' });
  });

  test('accepts a valid Supabase ES256 access token from JWKS', async () => {
    process.env.AUTH_MODE = 'supabase';
    process.env.SUPABASE_URL = 'http://supabase.test';
    const keyPair = await webcrypto.subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-256' },
      true,
      ['sign', 'verify']
    );
    const publicJwk = await webcrypto.subtle.exportKey('jwk', keyPair.publicKey);
    const encodedHeader = base64UrlJson({ alg: 'ES256', kid: 'test-key', typ: 'JWT' });
    const encodedPayload = base64UrlJson({
      sub: 'user-es256',
      exp: Math.floor(Date.now() / 1000) + 60,
      email: 'utente@example.com',
      app_metadata: {
        role: 'admin',
      },
    });
    const signature = await webcrypto.subtle.sign(
      { name: 'ECDSA', hash: 'SHA-256' },
      keyPair.privateKey,
      Buffer.from(`${encodedHeader}.${encodedPayload}`)
    );
    const token = `${encodedHeader}.${encodedPayload}.${Buffer.from(signature).toString('base64url')}`;
    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          keys: [{ ...publicJwk, alg: 'ES256', kid: 'test-key', use: 'sig' }],
        }),
        { status: 200 }
      );
    });
    globalThis.fetch = fetchMock as typeof fetch;

    const response = await request(createPrivateApp())
      .get('/private')
      .set('Authorization', `Bearer ${token}`);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      userId: 'user-es256',
      role: 'admin',
    });
    expect(fetchMock).toHaveBeenCalledWith('http://supabase.test/auth/v1/.well-known/jwks.json');
  });

  test('rejects local bypass outside test or explicit dev profile', async () => {
    process.env.AUTH_MODE = 'local-bypass';
    process.env.LOCAL_AUTH_BYPASS = 'true';
    process.env.NODE_ENV = 'production';

    const response = await request(createPrivateApp()).get('/private');

    expect(response.status).toBe(401);
    expect(response.body).toEqual({
      success: false,
      error: 'Accesso richiesto.',
    });
  });

  test('accepts local bypass only in an explicit dev profile outside tests', async () => {
    process.env.AUTH_MODE = 'local-bypass';
    process.env.LOCAL_AUTH_BYPASS = 'true';
    process.env.LOCAL_DEV_PROFILE = 'true';
    process.env.NODE_ENV = 'production';

    const response = await request(createPrivateApp()).get('/private');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      userId: 'local-user',
    });
  });
});
