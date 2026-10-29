import { webcrypto } from 'node:crypto';
import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import {
  getCurrentUser,
  resolveCurrentUser,
  resolveCurrentUserForPasswordSetup,
} from '../../src/auth/currentUser.js';
import { signSupabaseJwt } from '../helpers/auth.js';

const ORIGINAL_ENV = { ...process.env };
const ORIGINAL_FETCH = globalThis.fetch;

const base64UrlJson = (value: unknown): string =>
  Buffer.from(JSON.stringify(value)).toString('base64url');

const createAccessTokenPayload = (
  overrides: Record<string, unknown> = {}
): Record<string, unknown> => ({
  aud: 'authenticated',
  exp: Math.floor(Date.now() / 1000) + 60,
  iss: 'http://supabase.test/auth/v1',
  sub: 'user-123',
  ...overrides,
});

const signEs256Jwt = async (
  keyPair: CryptoKeyPair,
  keyId: string,
  payload: Record<string, unknown>
): Promise<string> => {
  const encodedHeader = base64UrlJson({ alg: 'ES256', kid: keyId, typ: 'JWT' });
  const encodedPayload = base64UrlJson(payload);
  const signature = await webcrypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    keyPair.privateKey,
    Buffer.from(`${encodedHeader}.${encodedPayload}`)
  );
  return `${encodedHeader}.${encodedPayload}.${Buffer.from(signature).toString('base64url')}`;
};

const createPrivateApp = () => {
  const app = express();
  app.get('/private', resolveCurrentUser, (req, res) => {
    const currentUser = getCurrentUser(req);
    res.json({
      aiProvider: currentUser.aiProvider,
      aiProviderOverrides: currentUser.aiProviderOverrides,
      userId: currentUser.id,
      role: currentUser.role,
    });
  });
  app.get('/password-setup', resolveCurrentUserForPasswordSetup, (req, res) => {
    res.json(getCurrentUser(req));
  });

  return app;
};

describe('resolveCurrentUser', () => {
  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    process.env.SUPABASE_URL = 'http://supabase.test';
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
      createAccessTokenPayload({
        app_metadata: {
          ai_provider: 'codex',
          role: 'admin',
        },
      }),
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

  test('reads valid per-function provider overrides from app metadata', async () => {
    process.env.AUTH_MODE = 'supabase';
    process.env.SUPABASE_JWT_SECRET = 'test-secret';
    const token = signSupabaseJwt(
      createAccessTokenPayload({
        sub: 'mixed-provider-user',
        app_metadata: {
          ai_provider: 'codex',
          ai_provider_overrides: {
            context: 'openrouter',
            lesson: 'codex',
            unknown: 'openai',
          },
          role: 'user',
        },
      }),
      'test-secret'
    );

    const response = await request(createPrivateApp())
      .get('/private')
      .set('Authorization', `Bearer ${token}`);

    expect(response.status).toBe(200);
    expect(response.body.aiProviderOverrides).toEqual({
      context: 'openrouter',
      lesson: 'codex',
    });
  });

  test('does not trust user-editable metadata for authorization', async () => {
    process.env.AUTH_MODE = 'supabase';
    process.env.SUPABASE_JWT_SECRET = 'test-secret';
    const token = signSupabaseJwt(
      createAccessTokenPayload({
        user_metadata: {
          role: 'admin',
        },
      }),
      'test-secret'
    );

    const response = await request(createPrivateApp())
      .get('/private')
      .set('Authorization', `Bearer ${token}`);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ userId: 'user-123' });
  });

  test('allows a pending account only through the password-setup resolver', async () => {
    process.env.AUTH_MODE = 'supabase';
    process.env.SUPABASE_JWT_SECRET = 'test-secret';
    const token = signSupabaseJwt(
      createAccessTokenPayload({
        sub: 'pending-user',
        app_metadata: { password_setup_required: true, role: 'user' },
      }),
      'test-secret'
    );

    const protectedResponse = await request(createPrivateApp())
      .get('/private')
      .set('Authorization', `Bearer ${token}`);
    expect(protectedResponse.status).toBe(403);
    expect(protectedResponse.body).toEqual({
      success: false,
      code: 'password_setup_required',
      error: 'Completa la configurazione della password.',
    });

    const setupResponse = await request(createPrivateApp())
      .get('/password-setup')
      .set('Authorization', `Bearer ${token}`);
    expect(setupResponse.status).toBe(200);
    expect(setupResponse.body).toMatchObject({
      id: 'pending-user',
      passwordSetupRequired: true,
    });
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
    const token = await signEs256Jwt(
      keyPair,
      'test-key',
      createAccessTokenPayload({
        sub: 'user-es256',
        email: 'utente@example.com',
        app_metadata: {
          role: 'admin',
        },
      })
    );
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

  test('refreshes JWKS once when a token uses a newly rotated key', async () => {
    process.env.AUTH_MODE = 'supabase';
    process.env.SUPABASE_URL = 'http://rotation.test';
    const oldKeyPair = await webcrypto.subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-256' },
      true,
      ['sign', 'verify']
    );
    const newKeyPair = await webcrypto.subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-256' },
      true,
      ['sign', 'verify']
    );
    const oldPublicJwk = await webcrypto.subtle.exportKey('jwk', oldKeyPair.publicKey);
    const newPublicJwk = await webcrypto.subtle.exportKey('jwk', newKeyPair.publicKey);
    const token = await signEs256Jwt(
      newKeyPair,
      'new-key',
      createAccessTokenPayload({ iss: 'http://rotation.test/auth/v1', sub: 'rotated-user' })
    );
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ keys: [{ ...oldPublicJwk, kid: 'old-key' }] }), {
          status: 200,
        })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ keys: [{ ...newPublicJwk, kid: 'new-key' }] }), {
          status: 200,
        })
      );
    globalThis.fetch = fetchMock as typeof fetch;

    const response = await request(createPrivateApp())
      .get('/private')
      .set('Authorization', `Bearer ${token}`);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ userId: 'rotated-user' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test('rejects an unknown JWKS key after exactly one refresh', async () => {
    process.env.AUTH_MODE = 'supabase';
    process.env.SUPABASE_URL = 'http://unknown-key.test';
    const keyPair = await webcrypto.subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-256' },
      true,
      ['sign', 'verify']
    );
    const publicJwk = await webcrypto.subtle.exportKey('jwk', keyPair.publicKey);
    const token = await signEs256Jwt(
      keyPair,
      'unknown-key',
      createAccessTokenPayload({ iss: 'http://unknown-key.test/auth/v1' })
    );
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ keys: [{ ...publicJwk, kid: 'different-key' }] }), {
          status: 200,
        })
    );
    globalThis.fetch = fetchMock as typeof fetch;

    const response = await request(createPrivateApp())
      .get('/private')
      .set('Authorization', `Bearer ${token}`);

    expect(response.status).toBe(401);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test.each([
    200, 503,
  ])('bounds repeated unknown-key refreshes after a %s response and accepts rotation after cooldown', async refreshStatus => {
    process.env.AUTH_MODE = 'supabase';
    process.env.SUPABASE_URL = `http://cooldown-${refreshStatus}.test`;
    let now = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    let keyPair = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
      'sign',
      'verify',
    ]);
    let publicJwk = await webcrypto.subtle.exportKey('jwk', keyPair.publicKey);
    let publishedKeyId = 'old-key';
    const fetchMock = vi.fn(async () => {
      const status = fetchMock.mock.calls.length === 2 ? refreshStatus : 200;
      return new Response(JSON.stringify({ keys: [{ ...publicJwk, kid: publishedKeyId }] }), {
        status,
      });
    });
    globalThis.fetch = fetchMock as typeof fetch;
    const app = createPrivateApp();
    const authenticate = async (keyId: string) => {
      const token = await signEs256Jwt(
        keyPair,
        keyId,
        createAccessTokenPayload({ iss: `${process.env.SUPABASE_URL}/auth/v1` })
      );
      return request(app).get('/private').set('Authorization', `Bearer ${token}`);
    };

    expect((await authenticate('old-key')).status).toBe(200);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect((await authenticate(`unknown-${attempt}`)).status).toBe(401);
    }
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect((await authenticate('old-key')).status).toBe(200);

    publishedKeyId = 'rotated-key';
    keyPair = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
      'sign',
      'verify',
    ]);
    publicJwk = await webcrypto.subtle.exportKey('jwk', keyPair.publicKey);
    now += 29_999;
    expect((await authenticate('rotated-key')).status).toBe(401);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    now += 1;
    expect((await authenticate('rotated-key')).status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  test('shares one in-flight JWKS refresh across concurrent unknown keys', async () => {
    process.env.AUTH_MODE = 'supabase';
    process.env.SUPABASE_URL = 'http://concurrent-jwks.test';
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const keyPair = await webcrypto.subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-256' },
      true,
      ['sign', 'verify']
    );
    const publicJwk = await webcrypto.subtle.exportKey('jwk', keyPair.publicKey);
    let releaseRefresh!: () => void;
    const refreshBlocked = new Promise<void>(resolve => {
      releaseRefresh = resolve;
    });
    const fetchMock = vi.fn(async () => {
      if (fetchMock.mock.calls.length > 1) await refreshBlocked;
      return new Response(JSON.stringify({ keys: [{ ...publicJwk, kid: 'known-key' }] }));
    });
    globalThis.fetch = fetchMock as typeof fetch;
    const app = createPrivateApp();
    const knownToken = await signEs256Jwt(
      keyPair,
      'known-key',
      createAccessTokenPayload({ iss: `${process.env.SUPABASE_URL}/auth/v1` })
    );
    expect(
      (await request(app).get('/private').set('Authorization', `Bearer ${knownToken}`)).status
    ).toBe(200);
    const tokens = await Promise.all(
      Array.from({ length: 5 }, (_, index) =>
        signEs256Jwt(
          keyPair,
          `unknown-${index}`,
          createAccessTokenPayload({ iss: `${process.env.SUPABASE_URL}/auth/v1` })
        )
      )
    );
    const responses = Promise.all(
      tokens.map(token => request(app).get('/private').set('Authorization', `Bearer ${token}`))
    );
    try {
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
      // A known key still authenticates while the refresh is blocked.
      expect(
        (await request(app).get('/private').set('Authorization', `Bearer ${knownToken}`)).status
      ).toBe(200);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      releaseRefresh();
    }
    expect((await responses).map(response => response.status)).toEqual(Array(5).fill(401));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test.each([
    ['without expiration', { exp: undefined }],
    ['from a different issuer', { iss: 'https://attacker.example/auth/v1' }],
    ['for a different audience', { aud: 'anon' }],
    ['before its not-before time', { nbf: Math.floor(Date.now() / 1000) + 60 }],
  ])('rejects a signed token %s', async (_label, overrides) => {
    process.env.AUTH_MODE = 'supabase';
    process.env.SUPABASE_JWT_SECRET = 'test-secret';
    const token = signSupabaseJwt(createAccessTokenPayload(overrides), 'test-secret');

    const response = await request(createPrivateApp())
      .get('/private')
      .set('Authorization', `Bearer ${token}`);

    expect(response.status).toBe(401);
    expect(response.body).toEqual({
      success: false,
      error: 'Sessione non valida. Accedi di nuovo.',
    });
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
