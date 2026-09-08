import { type AccountPreferences, EMPTY_ACCOUNT_PREFERENCES } from '@shared/accountPreferences.js';
import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { AccountStore } from '../../src/account/accountStore.js';
import type { ModelPrice } from '../../src/account/accountUsage.js';
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
  const loadPrices = vi.fn<(signal: AbortSignal) => Promise<ModelPrice[]>>(async () => []);
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

  const unpricedGroup = {
    provider: 'openrouter',
    model: 'example/text',
    inputTokens: 100,
    outputTokens: 20,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    reportedCostUsd: null,
    calls: 1,
    firstRecordedAt: '2026-09-08T00:00:00Z',
    lastRecordedAt: '2026-09-08T00:00:00Z',
  };

  test('returns recorded totals without consulting prices and estimates only when requested', async () => {
    vi.mocked(store.readUsage).mockResolvedValueOnce([unpricedGroup]);
    const recorded = await request(app).get('/account/usage').set('authorization', auth('user-a'));
    expect(recorded.body).toMatchObject({
      tokens: 120,
      estimatedCostUsd: null,
      missingCostCalls: 1,
    });
    expect(loadPrices).not.toHaveBeenCalled();
    vi.mocked(store.readUsage).mockResolvedValueOnce([
      unpricedGroup,
      { ...unpricedGroup, reportedCostUsd: 0 },
    ]);
    loadPrices.mockResolvedValueOnce([
      {
        id: 'example/text',
        architecture: { output_modalities: ['text'] },
        pricing: { prompt: 0.001, completion: 0.002 },
      },
    ]);
    const estimated = await request(app)
      .get('/account/usage?estimate=true')
      .set('authorization', auth('user-b'));
    expect(store.readUsage).toHaveBeenLastCalledWith('user-b');
    expect(estimated.body).toMatchObject({
      tokens: 240,
      reportedCostUsd: 0,
      estimatedCostUsd: 0.14,
      missingCostCalls: 0,
    });
  });

  test('keeps recorded usage when optional pricing fails', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(store.readUsage).mockResolvedValueOnce([unpricedGroup]);
    loadPrices.mockRejectedValueOnce(new Error('offline'));
    try {
      const result = await request(app)
        .get('/account/usage?estimate=true')
        .set('authorization', auth('user-a'));
      expect(result.body).toMatchObject({
        tokens: 120,
        estimatedCostUsd: null,
        missingCostCalls: 1,
      });
    } finally {
      log.mockRestore();
    }
  });

  test.each([
    'codex',
    'openai',
  ])('does not advertise or fetch estimates for %s-only usage', async provider => {
    vi.mocked(store.readUsage).mockResolvedValueOnce([{ ...unpricedGroup, provider }]);
    const result = await request(app)
      .get('/account/usage?estimate=true')
      .set('authorization', auth('user-a'));
    expect(result.body).toMatchObject({
      tokens: 120,
      missingCostCalls: 1,
      hasCostEstimateCandidates: false,
    });
    expect(loadPrices).not.toHaveBeenCalled();
  });

  test('aborts an outstanding provider request when the client disconnects', async () => {
    let started!: () => void;
    let aborted!: () => void;
    const pricingStarted = new Promise<void>(resolve => {
      started = resolve;
    });
    const pricingAborted = new Promise<void>(resolve => {
      aborted = resolve;
    });
    vi.mocked(store.readUsage).mockResolvedValueOnce([unpricedGroup]);
    loadPrices.mockImplementationOnce(
      signal =>
        new Promise<ModelPrice[]>((_resolve, reject) => {
          signal.addEventListener(
            'abort',
            () => {
              aborted();
              reject(signal.reason);
            },
            { once: true }
          );
          started();
        })
    );
    const pending = request(app)
      .get('/account/usage?estimate=true')
      .set('authorization', auth('user-a'));
    pending.end(() => {});
    await pricingStarted;
    pending.abort();
    await pricingAborted;
  });

  test('requires a session before reading or changing preferences and usage', async () => {
    expect((await request(app).get('/account/preferences')).status).toBe(401);
    expect(
      (await request(app).put('/account/preferences').send(EMPTY_ACCOUNT_PREFERENCES)).status
    ).toBe(401);
    expect((await request(app).delete('/account/preferences')).status).toBe(401);
    expect((await request(app).get('/account/usage')).status).toBe(401);
    expect((await request(app).get('/account/usage?estimate=true')).status).toBe(401);
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

  test.each([
    ['contentLanguage', 100],
    ['teachingPreferences', 4_000],
  ] as const)('rejects oversized %s without writing and accepts the trimmed boundary', async (field, limit) => {
    const text = 'x'.repeat(limit);
    const rejected = await request(app)
      .put('/account/preferences')
      .set('authorization', auth('user-a'))
      .send({ ...EMPTY_ACCOUNT_PREFERENCES, [field]: `${text}x` });
    expect(rejected.status).toBe(400);
    expect(rejected.body.code).toBe('account_preferences_invalid');
    expect(store.savePreferences).not.toHaveBeenCalled();
    const accepted = await request(app)
      .put('/account/preferences')
      .set('authorization', auth('user-a'))
      .send({ ...EMPTY_ACCOUNT_PREFERENCES, [field]: ` ${text}\n` });
    expect(accepted.status).toBe(200);
    expect(preferences.get('user-a')?.[field]).toBe(text);
  });

  test('scopes consumption by session and does not fetch prices for an empty record set', async () => {
    const response = await request(app)
      .get('/account/usage?estimate=true&userId=user-b')
      .set('authorization', auth('user-a'));
    expect(response.status).toBe(200);
    expect(store.readUsage).toHaveBeenCalledWith('user-a');
    expect(response.body).toMatchObject({ recordedCalls: 0, tokens: null, reportedCostUsd: null });
    expect(loadPrices).not.toHaveBeenCalled();
  });
});
