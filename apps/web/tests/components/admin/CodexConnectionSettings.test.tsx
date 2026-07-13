/** @vitest-environment jsdom */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
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

    fireEvent.click(await screen.findByRole('button', { name: 'Collega Codex' }));

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
