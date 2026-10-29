/** @vitest-environment jsdom */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import CodexConnectionSettings from '../../../components/admin/CodexConnectionSettings.tsx';

const codexApiMocks = vi.hoisted(() => ({
  cancelCodexDeviceLogin: vi.fn(),
  loadCodexProviderStatus: vi.fn(),
  logoutCodexProvider: vi.fn(),
  startCodexDeviceLogin: vi.fn(),
}));

vi.mock('../../../services/ai/codexAccountApi.ts', () => codexApiMocks);

describe('CodexConnectionSettings', () => {
  beforeEach(() => {
    for (const mock of Object.values(codexApiMocks)) {
      mock.mockReset();
    }
    codexApiMocks.loadCodexProviderStatus.mockResolvedValue({
      account: null,
      enabled: true,
      models: [],
    });
  });

  test('starts the Codex device flow from the admin control', async () => {
    codexApiMocks.startCodexDeviceLogin.mockResolvedValue({
      type: 'chatgptDeviceCode',
      loginId: 'login-1',
      userCode: 'ABCD-1234',
      verificationUrl: 'https://auth.openai.com/codex/device',
    });
    render(<CodexConnectionSettings />);

    const connectButton = await screen.findByRole('button', { name: 'Collega Codex' });
    await waitFor(() => expect(connectButton).toBeEnabled());
    fireEvent.click(connectButton);

    expect(await screen.findByText('ABCD-1234')).toBeVisible();
    expect(screen.getByRole('link', { name: 'Apri accesso OpenAI' })).toHaveAttribute(
      'href',
      'https://auth.openai.com/codex/device'
    );
    expect(codexApiMocks.startCodexDeviceLogin).toHaveBeenCalledTimes(1);
  });

  test('disconnects the shared Codex session', async () => {
    codexApiMocks.loadCodexProviderStatus.mockResolvedValueOnce({
      account: { type: 'chatgpt', requiresOpenaiAuth: true },
      enabled: true,
      models: [{ model: 'gpt-test', supportedReasoningEfforts: [] }],
    });
    render(<CodexConnectionSettings />);

    fireEvent.click(await screen.findByRole('button', { name: 'Disconnetti Codex' }));

    await waitFor(() => expect(codexApiMocks.logoutCodexProvider).toHaveBeenCalledTimes(1));
    expect(await screen.findByRole('button', { name: 'Collega Codex' })).toBeInTheDocument();
  });

  test('shows a stable error when revocation fails', async () => {
    codexApiMocks.loadCodexProviderStatus.mockResolvedValue({
      account: { type: 'chatgpt', requiresOpenaiAuth: true },
      enabled: true,
      models: [],
    });
    codexApiMocks.logoutCodexProvider.mockRejectedValue(new Error('internal token detail'));
    render(<CodexConnectionSettings />);

    fireEvent.click(await screen.findByRole('button', { name: 'Disconnetti Codex' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Disconnessione da Codex non riuscita. Riprova.'
    );
    expect(screen.queryByText(/internal token detail/i)).toBeNull();
  });

  test('does not expose connection actions when app-server is unavailable', async () => {
    codexApiMocks.loadCodexProviderStatus.mockResolvedValue({
      account: null,
      enabled: false,
      models: [],
    });

    render(<CodexConnectionSettings />);

    expect(
      await screen.findByText(
        'Codex è disponibile solo quando il backend locale abilita app-server.'
      )
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Collega Codex' })).toBeNull();
  });
});

test('ignores a delayed poll after canceling login', async () => {
  codexApiMocks.loadCodexProviderStatus.mockResolvedValue({
    account: null,
    enabled: true,
    models: [],
  });
  codexApiMocks.startCodexDeviceLogin.mockResolvedValue({ loginId: 'old', userCode: 'OLD' });
  codexApiMocks.cancelCodexDeviceLogin.mockResolvedValue(undefined);
  render(<CodexConnectionSettings />);
  const connect = await screen.findByRole('button', { name: 'Collega Codex' });
  await waitFor(() => expect(connect).toBeEnabled());
  fireEvent.click(connect);
  await screen.findByText('OLD');
  let resolvePoll!: (status: unknown) => void;
  codexApiMocks.loadCodexProviderStatus.mockImplementationOnce(
    () =>
      new Promise(resolve => {
        resolvePoll = resolve;
      })
  );
  await waitFor(() => expect(resolvePoll).toBeDefined(), { timeout: 4000 });
  fireEvent.click(screen.getByRole('button', { name: 'Annulla' }));
  const reconnect = await screen.findByRole('button', { name: 'Collega Codex' });
  codexApiMocks.startCodexDeviceLogin.mockResolvedValue({ loginId: 'new', userCode: 'NEW' });
  fireEvent.click(reconnect);
  await screen.findByText('NEW');
  await act(async () =>
    resolvePoll({
      account: { type: 'chatgpt', email: 'stale@example.test' },
      enabled: true,
      models: [],
    })
  );
  expect(screen.queryByText('stale@example.test')).toBeNull();
  expect(screen.getByText('NEW')).toBeVisible();
});
