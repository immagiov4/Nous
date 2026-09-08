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

  test('applies the locale on a successful read, including a settings-panel retry', async () => {
    fetchMock.mockResolvedValueOnce(response());
    await loadAccountPreferences();
    expect(getAppLocale()).toBe('it');
  });

  test.each([
    'before',
    'during',
  ])('does not let a read started %s a mutation undo its completed locale', async timing => {
    let finishRead!: (response: Response) => void;
    let finishSave!: (response: Response) => void;
    fetchMock.mockImplementation(
      (_url, init) =>
        new Promise<Response>(resolve => {
          if (init.method === 'GET') finishRead = resolve;
          else finishSave = resolve;
        })
    );
    let read: Promise<unknown>;
    let save: Promise<unknown>;
    if (timing === 'before') {
      read = loadAccountPreferences();
      save = saveAccountPreferences(saved);
    } else {
      save = saveAccountPreferences(saved);
      read = loadAccountPreferences();
    }
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    finishSave(response());
    await save;
    finishRead(Response.json({ preferences: { ...saved, interfaceLocale: 'en' } }));
    await read;
    expect(getAppLocale()).toBe('it');
  });

  test('does not apply account A locale after the active identity changes to B', async () => {
    fetchMock.mockImplementationOnce(async () => {
      accountSession('account-b');
      return response();
    });
    await saveAccountPreferences(saved);
    expect(getAppLocale()).toBe('en');
  });

  test('does not let a late A mutation invalidate B preference loading', async () => {
    let finishSave!: (response: Response) => void;
    let finishRead!: (response: Response) => void;
    fetchMock.mockImplementationOnce(
      () =>
        new Promise<Response>(resolve => {
          finishSave = resolve;
        })
    );
    const save = saveAccountPreferences({ ...saved, interfaceLocale: 'en' });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    accountSession('account-b');
    fetchMock.mockImplementationOnce(
      () =>
        new Promise<Response>(resolve => {
          finishRead = resolve;
        })
    );
    const read = loadAccountPreferences();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    finishSave(Response.json({ preferences: { ...saved, interfaceLocale: 'en' } }));
    await save;
    finishRead(response());
    await read;
    expect(getAppLocale()).toBe('it');
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
