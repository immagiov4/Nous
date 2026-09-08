// @vitest-environment jsdom
import { EMPTY_ACCOUNT_PREFERENCES } from '@shared/accountPreferences';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { getAppLocale, setAccountLocale } from '../../../i18n/uiMessages.ts';
import { clearSupabaseSession, saveSupabaseSession } from '../../../services/auth/supabaseAuth.ts';
import {
  clearAccountPreferences,
  loadAccountPreferences,
  saveAccountPreferences,
} from '../../../services/preferences/accountPreferences.ts';

const fetchMock = vi.fn();
const accountSession = (id: string) =>
  saveSupabaseSession({
    accessToken: `token-${id}`,
    refreshToken: `refresh-${id}`,
    user: { id, email: `${id}@example.test` },
  });
const saved = { ...EMPTY_ACCOUNT_PREFERENCES, interfaceLocale: 'it' as const };
const response = () => Response.json({ preferences: saved });

describe('account preference request ownership', () => {
  beforeEach(() => {
    vi.spyOn(navigator, 'languages', 'get').mockReturnValue(['en']);
    vi.stubEnv('VITE_AUTH_MODE', 'supabase');
    vi.stubEnv('VITE_SUPABASE_URL', 'https://supabase.test');
    vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'anon');
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset();
    clearSupabaseSession();
    setAccountLocale(null);
    accountSession('account-a');
  });
  afterEach(() => {
    clearSupabaseSession();
    setAccountLocale(null);
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  test('applies a completed save independently of any mounted settings component', async () => {
    fetchMock.mockResolvedValueOnce(response());
    expect(await saveAccountPreferences(saved)).toEqual(saved);
    expect(getAppLocale()).toBe('it');
    expect(new Headers(fetchMock.mock.calls[0][1].headers).get('Authorization')).toBe(
      'Bearer token-account-a'
    );
  });

  test('does not apply account A locale after the active identity changes to B', async () => {
    fetchMock.mockImplementationOnce(async () => {
      accountSession('account-b');
      return response();
    });
    await saveAccountPreferences(saved);
    expect(getAppLocale()).toBe('en');
  });

  test.each([
    saveAccountPreferences,
    clearAccountPreferences,
  ])('does not replay a mutation under another account after a 401', async mutate => {
    fetchMock.mockImplementationOnce(async () => {
      accountSession('account-b');
      return new Response('', { status: 401 });
    });
    await expect(mutate(saved)).rejects.toThrow('account changed');
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  test('rejects preference requests without a signed-in account', async () => {
    clearSupabaseSession();
    await expect(loadAccountPreferences()).rejects.toThrow('account is required');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
