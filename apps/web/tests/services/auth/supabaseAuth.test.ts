import { beforeEach, describe, expect, test } from 'vitest';

import {
  clearSupabaseSession,
  getSupabaseAuthHeaders,
  mergeSupabaseAuthHeaders,
  readSupabaseSession,
  saveSupabaseSession,
} from '../../../services/auth/supabaseAuth.ts';

describe('Supabase auth session storage', () => {
  beforeEach(() => {
    clearSupabaseSession();
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

  test('drops expired sessions before building backend Authorization headers', () => {
    saveSupabaseSession({
      accessToken: 'expired-token',
      expiresAt: Math.floor(Date.now() / 1000) - 60,
    });

    expect(readSupabaseSession()).toBeNull();
    expect(getSupabaseAuthHeaders()).toEqual({});
  });
});
