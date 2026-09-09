// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { AccountSetupGate } from '../../../components/account/setup/AccountSetupPage.tsx';

const api = vi.hoisted(() => ({
  accountId: 'new-user',
  listeners: new Set<() => void>(),
  load: vi.fn(),
}));
vi.mock('../../../services/auth/supabaseAuth.ts', () => ({
  readSupabaseSession: () => ({ user: { id: api.accountId } }),
  subscribeToSupabaseSession: (listener: () => void) => {
    api.listeners.add(listener);
    return () => api.listeners.delete(listener);
  },
}));
vi.mock('../../../services/preferences/accountSetup.ts', () => ({
  ACCOUNT_SETUP_PATH: '/preferences/setup',
  loadAccountSetupStatus: api.load,
  finishAccountSetup: vi.fn(),
}));
vi.mock('../../../components/account/setup/AccountSetupFlow.tsx', () => ({
  default: () => <p>Initial preferences</p>,
}));

describe('account enrollment gate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.accountId = 'new-user';
    history.replaceState({}, '', '/');
  });
  afterEach(cleanup);
  test.each([
    'not-required',
    'completed',
    'skipped',
  ])('does not interrupt %s accounts', async status => {
    api.load.mockResolvedValue(status);
    render(
      <AccountSetupGate>
        <p>Main app</p>
      </AccountSetupGate>
    );
    await screen.findByText('Main app');
    expect(screen.queryByText('Initial preferences')).not.toBeInTheDocument();
  });
  test('shows pending setup before mounting the app and resets on account change', async () => {
    api.load.mockResolvedValueOnce('pending').mockResolvedValueOnce('not-required');
    render(
      <AccountSetupGate>
        <p>Main app</p>
      </AccountSetupGate>
    );
    await screen.findByText('Initial preferences');
    expect(screen.queryByText('Main app')).not.toBeInTheDocument();
    await act(async () => {
      api.accountId = 'existing-user';
      for (const listener of api.listeners) listener();
    });
    await screen.findByText('Main app');
    expect(api.load).toHaveBeenCalledTimes(2);
  });
  test('allows existing users to open setup explicitly without an automatic enrollment check', () => {
    history.replaceState({}, '', '/preferences/setup');
    render(
      <AccountSetupGate>
        <p>Main app</p>
      </AccountSetupGate>
    );
    expect(screen.getByText('Initial preferences')).toBeInTheDocument();
    expect(api.load).not.toHaveBeenCalled();
  });
});
