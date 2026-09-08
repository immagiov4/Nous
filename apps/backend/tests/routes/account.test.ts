import { type AccountPreferences, EMPTY_ACCOUNT_PREFERENCES } from '@shared/accountPreferences.js';
import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { AccountStore } from '../../src/account/accountStore.js';
import { resolveCurrentUser } from '../../src/auth/currentUser.js';
import { createAccountRouter } from '../../src/routes/account.js';
import { createSupabaseTestToken } from '../helpers/auth.js';

describe('account routes', () => {
  const preferences = new Map<string, AccountPreferences>();
  const store: AccountStore = {
    readPreferences: vi.fn(
      async userId => preferences.get(userId) ?? { ...EMPTY_ACCOUNT_PREFERENCES }
    ),
    savePreferences: vi.fn(async (userId, value) => {
      preferences.set(userId, value);
      return value;
    }),
    clearPreferences: vi.fn(async userId => {
      preferences.delete(userId);
    }),
    readUsage: vi.fn(async () => []),
  };
  const loadPrices = vi.fn(async () => []);
  const app = express()
    .use(express.json())
    .use(
      '/account',
      resolveCurrentUser,
      createAccountRouter(() => store, loadPrices)
    );
  const auth = (id: string) => `Bearer ${createSupabaseTestToken({ userId: id })}`;
  beforeEach(() => {
    vi.stubEnv('AUTH_MODE', 'supabase');
    vi.stubEnv('SUPABASE_JWT_SECRET', 'test-secret');
    vi.stubEnv('SUPABASE_URL', 'https://supabase.test');
    preferences.clear();
    vi.clearAllMocks();
  });
  afterEach(() => vi.unstubAllEnvs());

  test('requires a session before reading or changing preferences and usage', async () => {
    expect((await request(app).get('/account/preferences')).status).toBe(401);
    expect(
      (await request(app).put('/account/preferences').send(EMPTY_ACCOUNT_PREFERENCES)).status
    ).toBe(401);
    expect((await request(app).delete('/account/preferences')).status).toBe(401);
    expect((await request(app).get('/account/usage')).status).toBe(401);
    expect(store.readPreferences).not.toHaveBeenCalled();
    expect(store.savePreferences).not.toHaveBeenCalled();
  });

  test('saves, reloads and clears only the authenticated account', async () => {
    const saved = {
      interfaceLocale: 'it',
      contentLanguage: '日本語',
      teachingPreferences: 'One step at a time.',
    };
    expect(
      (
        await request(app)
          .put('/account/preferences')
          .set('authorization', auth('user-a'))
          .send(saved)
      ).status
    ).toBe(200);
    const own = await request(app).get('/account/preferences').set('authorization', auth('user-a'));
    expect(own.body).toEqual({ preferences: saved });
    expect(own.headers['cache-control']).toBe('private, no-store');
    expect(
      (await request(app).get('/account/preferences').set('authorization', auth('user-b'))).body
    ).toEqual({ preferences: EMPTY_ACCOUNT_PREFERENCES });
    await request(app).delete('/account/preferences').set('authorization', auth('user-b'));
    expect(preferences.get('user-a')).toEqual(saved);
    await request(app).delete('/account/preferences').set('authorization', auth('user-a'));
    expect(
      (await request(app).get('/account/preferences').set('authorization', auth('user-a'))).body
    ).toEqual({ preferences: EMPTY_ACCOUNT_PREFERENCES });
  });

  test('rejects a body containing another account identity', async () => {
    const response = await request(app)
      .put('/account/preferences')
      .set('authorization', auth('user-a'))
      .send({ ...EMPTY_ACCOUNT_PREFERENCES, userId: 'user-b' });
    expect(response.status).toBe(400);
    expect(store.savePreferences).not.toHaveBeenCalled();
  });

  test('scopes consumption by session and does not fetch prices for an empty record set', async () => {
    const response = await request(app)
      .get('/account/usage?userId=user-b')
      .set('authorization', auth('user-a'));
    expect(response.status).toBe(200);
    expect(store.readUsage).toHaveBeenCalledWith('user-a');
    expect(response.body).toMatchObject({ recordedCalls: 0, tokens: null, reportedCostUsd: null });
    expect(loadPrices).not.toHaveBeenCalled();
  });
});
