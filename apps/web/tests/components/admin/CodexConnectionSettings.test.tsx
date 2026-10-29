/** @vitest-environment jsdom */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { StrictMode } from 'react';
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

describe('Codex login recovery', () => {
  beforeEach(() => {
    for (const mock of Object.values(codexApiMocks)) mock.mockReset();
    codexApiMocks.loadCodexProviderStatus.mockResolvedValue({
      account: null,
      enabled: true,
      models: [],
    });
    codexApiMocks.startCodexDeviceLogin.mockResolvedValue({
      loginId: 'attempt',
      userCode: 'RETRY',
    });
  });

  test.each([403, 500])('reports initial status failure %s safely', async status => {
    codexApiMocks.loadCodexProviderStatus.mockRejectedValue(
      Object.assign(new Error('private diagnostic'), { status })
    );
    render(<CodexConnectionSettings />);
    if (status === 403) {
      expect(
        await screen.findByText(
          'Codex è disponibile solo quando il backend locale abilita app-server.'
        )
      ).toBeVisible();
    } else {
      expect(await screen.findByRole('alert')).toHaveTextContent(
        'Stato del provider AI non disponibile. Riprova.'
      );
    }
    expect(screen.queryByText('private diagnostic')).toBeNull();
  });

  test.each([
    'resolve',
    'reject',
  ])('preserves the current account when an earlier effect settles: %s', async outcome => {
    let resolve!: (value: unknown) => void;
    let reject!: (error: Error) => void;
    codexApiMocks.loadCodexProviderStatus.mockImplementationOnce(
      () =>
        new Promise((yes, no) => {
          resolve = yes;
          reject = no;
        })
    );
    codexApiMocks.loadCodexProviderStatus.mockResolvedValue({
      account: { type: 'chatgpt', email: 'current@example.test' },
      enabled: true,
      models: [],
    });
    render(
      <StrictMode>
        <CodexConnectionSettings />
      </StrictMode>
    );
    await screen.findByText('current@example.test');
    await act(async () => {
      if (outcome === 'resolve')
        resolve({
          account: { type: 'chatgpt', email: 'old@example.test' },
          enabled: true,
          models: [],
        });
      else reject(new Error('obsolete status failure'));
    });
    expect(screen.getByText('current@example.test')).toBeVisible();
    expect(screen.queryByText('old@example.test')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  test('resumes polling after cancellation fails and ignores an old poll after disconnect', async () => {
    const view = render(<CodexConnectionSettings />);
    const connect = await screen.findByRole('button', { name: 'Collega Codex' });
    await waitFor(() => expect(connect).toBeEnabled());
    fireEvent.click(connect);
    await screen.findByText('RETRY');
    codexApiMocks.cancelCodexDeviceLogin.mockRejectedValueOnce(new Error('cancel failed'));
    fireEvent.click(screen.getByRole('button', { name: 'Annulla' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Annullamento della connessione non riuscito. Riprova.'
    );
    let resolveLate!: (value: unknown) => void;
    codexApiMocks.loadCodexProviderStatus.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          resolveLate = resolve;
        })
    );
    codexApiMocks.loadCodexProviderStatus.mockResolvedValue({
      account: { type: 'chatgpt', email: 'current@example.test' },
      enabled: true,
      models: [],
    });
    await waitFor(() => expect(resolveLate).toBeDefined(), { timeout: 4000 });
    expect(await screen.findByText('current@example.test', {}, { timeout: 4000 })).toBeVisible();
    codexApiMocks.logoutCodexProvider.mockResolvedValue(undefined);
    fireEvent.click(screen.getByRole('button', { name: 'Disconnetti Codex' }));
    await screen.findByRole('button', { name: 'Collega Codex' });
    await act(async () =>
      resolveLate({
        account: { type: 'chatgpt', email: 'old@example.test' },
        enabled: true,
        models: [],
      })
    );
    expect(screen.queryByText('old@example.test')).toBeNull();
    expect(screen.getByRole('button', { name: 'Collega Codex' })).toBeEnabled();
    view.unmount();
  });
});
