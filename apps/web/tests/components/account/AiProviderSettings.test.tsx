/** @vitest-environment jsdom */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import AiProviderSettings from '../../../components/account/AiProviderSettings.tsx';

const codexApiMocks = vi.hoisted(() => ({
  cancelCodexDeviceLogin: vi.fn(),
  loadCodexProviderStatus: vi.fn(),
  logoutCodexProvider: vi.fn(),
  startCodexDeviceLogin: vi.fn(),
}));

vi.mock('../../../services/ai/codexAccountApi.ts', () => codexApiMocks);

describe('AiProviderSettings', () => {
  beforeEach(() => {
    window.localStorage.removeItem('nous.ai-provider');
    for (const mock of Object.values(codexApiMocks)) {
      mock.mockReset();
    }
    codexApiMocks.loadCodexProviderStatus.mockResolvedValue({
      account: null,
      enabled: true,
      models: [],
    });
  });

  test('persists the user provider choice and starts the Codex device flow', async () => {
    codexApiMocks.startCodexDeviceLogin.mockResolvedValue({
      type: 'chatgptDeviceCode',
      loginId: 'login-1',
      userCode: 'ABCD-1234',
      verificationUrl: 'https://auth.openai.com/codex/device',
    });
    render(<AiProviderSettings />);

    const providerSelect = await screen.findByLabelText('Provider AI per le attività testuali');
    fireEvent.change(providerSelect, { target: { value: 'codex' } });
    expect(window.localStorage.getItem('nous.ai-provider')).toBe('codex');

    fireEvent.click(await screen.findByRole('button', { name: 'Collega Codex' }));

    expect(await screen.findByText('ABCD-1234')).toBeVisible();
    expect(screen.getByRole('link', { name: 'Apri accesso OpenAI' })).toHaveAttribute(
      'href',
      'https://auth.openai.com/codex/device'
    );
    expect(codexApiMocks.startCodexDeviceLogin).toHaveBeenCalledTimes(1);
  });

  test('disconnects the Codex-owned session and falls back to the service provider', async () => {
    window.localStorage.setItem('nous.ai-provider', 'codex');
    codexApiMocks.loadCodexProviderStatus.mockResolvedValueOnce({
      account: { type: 'chatgpt', planType: 'plus', requiresOpenaiAuth: true },
      enabled: true,
      models: [{ model: 'gpt-test', supportedReasoningEfforts: [] }],
    });
    render(<AiProviderSettings />);

    fireEvent.click(await screen.findByRole('button', { name: 'Disconnetti Codex' }));

    await waitFor(() => expect(codexApiMocks.logoutCodexProvider).toHaveBeenCalledTimes(1));
    expect(window.localStorage.getItem('nous.ai-provider')).toBeNull();
    expect(screen.getByLabelText('Provider AI per le attività testuali')).toHaveValue('default');
    expect(codexApiMocks.loadCodexProviderStatus).toHaveBeenCalledTimes(1);
  });

  test('keeps the selected provider and shows a stable error when revocation fails', async () => {
    window.localStorage.setItem('nous.ai-provider', 'codex');
    codexApiMocks.loadCodexProviderStatus.mockResolvedValue({
      account: { type: 'chatgpt', planType: 'plus', requiresOpenaiAuth: true },
      enabled: true,
      models: [],
    });
    codexApiMocks.logoutCodexProvider.mockRejectedValue(new Error('internal token detail'));
    render(<AiProviderSettings />);

    fireEvent.click(await screen.findByRole('button', { name: 'Disconnetti Codex' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Disconnessione da Codex non riuscita. Riprova.'
    );
    expect(window.localStorage.getItem('nous.ai-provider')).toBe('codex');
    expect(screen.queryByText(/internal token detail/i)).toBeNull();
  });

  test('drops a stale Codex preference when app-server is unavailable', async () => {
    window.localStorage.setItem('nous.ai-provider', 'codex');
    codexApiMocks.loadCodexProviderStatus.mockResolvedValue({
      account: null,
      enabled: false,
      models: [],
    });

    render(<AiProviderSettings />);

    await waitFor(() =>
      expect(screen.getByLabelText('Provider AI per le attività testuali')).toHaveValue('default')
    );
    expect(window.localStorage.getItem('nous.ai-provider')).toBeNull();
    expect(screen.getByRole('option', { name: 'Codex' })).toBeDisabled();
  });

  test('hides a stale Codex connection choice when this user is not the configured local owner', async () => {
    window.localStorage.setItem('nous.ai-provider', 'codex');
    codexApiMocks.loadCodexProviderStatus.mockRejectedValue(
      Object.assign(new Error('Codex non disponibile.'), { status: 403 })
    );

    render(<AiProviderSettings />);

    await waitFor(() => expect(screen.getByRole('option', { name: 'Codex' })).toBeDisabled());
    expect(window.localStorage.getItem('nous.ai-provider')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
