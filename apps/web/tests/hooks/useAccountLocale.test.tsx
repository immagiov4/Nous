// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { useAccountLocale } from '../../hooks/useAccountLocale.ts';
import { setAccountLocale } from '../../i18n/uiMessages.ts';

const { load, subscribe, session } = vi.hoisted(() => ({
  load: vi.fn(),
  subscribe: vi.fn(),
  session: vi.fn(),
}));
vi.mock('../../services/preferences/accountPreferences.ts', () => ({
  loadAccountPreferences: load,
}));
vi.mock('../../services/auth/supabaseAuth.ts', () => ({
  isSupabaseAuthEnabled: () => true,
  readSupabaseSession: session,
  subscribeToSupabaseSession: subscribe,
}));
beforeEach(() => {
  load.mockReset();
  subscribe.mockReset();
  session.mockReturnValue({ user: { id: 'account-a' } });
  subscribe.mockReturnValue(vi.fn());
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  setAccountLocale(null);
  vi.restoreAllMocks();
});

test('retries after a failed preference read without duplicating a pending or completed synchronization', async () => {
  let finish!: () => void;
  load.mockRejectedValueOnce(new Error('offline')).mockImplementationOnce(
    () =>
      new Promise<void>(resolve => {
        finish = resolve;
      })
  );
  renderHook(useAccountLocale);
  await waitFor(() => expect(console.error).toHaveBeenCalled());
  const notify = subscribe.mock.calls[0][0];
  await act(async () => notify());
  expect(load).toHaveBeenCalledTimes(2);
  await act(async () => notify());
  expect(load).toHaveBeenCalledTimes(2);
  await act(async () => finish());
  await act(async () => notify());
  expect(load).toHaveBeenCalledTimes(2);
});
