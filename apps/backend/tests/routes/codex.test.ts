import request from 'supertest';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const codexMocks = vi.hoisted(() => ({
  cancelCodexLogin: vi.fn(),
  closeManagedCodexAccountClient: vi.fn(),
  getManagedCodexAccountClient: vi.fn(),
  isCodexAppServerEnabled: vi.fn(),
  listCodexModels: vi.fn(),
  logoutCodexAccount: vi.fn(),
  readCodexAccount: vi.fn(),
  startCodexDeviceLogin: vi.fn(),
}));
const ORIGINAL_ENV = { ...process.env };

vi.mock('../../src/services/codexAppServer.js', () => codexMocks);

const { createApp } = await import('../../src/index.js');

describe('Codex app-server account routes', () => {
  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV, CODEX_OWNER_USER_ID: 'local-user' };
    for (const mock of Object.values(codexMocks)) {
      mock.mockReset();
    }
    codexMocks.isCodexAppServerEnabled.mockReturnValue(true);
    codexMocks.getManagedCodexAccountClient.mockResolvedValue({ client: true });
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  test('reports a disabled local provider without starting a process', async () => {
    codexMocks.isCodexAppServerEnabled.mockReturnValue(false);

    const response = await request(createApp()).get('/api/codex/status');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ success: true, enabled: false, account: null, models: [] });
    expect(codexMocks.getManagedCodexAccountClient).not.toHaveBeenCalled();
  });

  test('returns the authenticated account contract and available models', async () => {
    codexMocks.readCodexAccount.mockResolvedValue({
      email: 'reader@example.test',
      planType: 'plus',
      requiresOpenaiAuth: true,
      type: 'chatgpt',
    });
    codexMocks.listCodexModels.mockResolvedValue([
      {
        model: 'gpt-test',
        defaultReasoningEffort: 'medium',
        supportedReasoningEfforts: ['low', 'medium'],
      },
    ]);

    const response = await request(createApp()).get('/api/codex/status');

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      success: true,
      enabled: true,
      account: { type: 'chatgpt', planType: 'plus' },
      models: [{ model: 'gpt-test', supportedReasoningEfforts: ['low', 'medium'] }],
    });
  });

  test('does not expose the machine Codex account to another Nous user', async () => {
    process.env.CODEX_OWNER_USER_ID = 'another-user';

    const response = await request(createApp()).get('/api/codex/status');

    expect(response.status).toBe(403);
    expect(response.body).toEqual({
      success: false,
      error: 'Codex non è disponibile per questo account.',
    });
    expect(codexMocks.getManagedCodexAccountClient).not.toHaveBeenCalled();
  });

  test('starts device login without returning provider credentials', async () => {
    codexMocks.startCodexDeviceLogin.mockResolvedValue({
      type: 'chatgptDeviceCode',
      loginId: 'login-1',
      userCode: 'ABCD-1234',
      verificationUrl: 'https://auth.openai.com/codex/device',
      accessToken: 'must-not-leak',
    });

    const response = await request(createApp()).post('/api/codex/login');

    expect(response.status).toBe(200);
    expect(response.body.login).toEqual({
      type: 'chatgptDeviceCode',
      loginId: 'login-1',
      userCode: 'ABCD-1234',
      verificationUrl: 'https://auth.openai.com/codex/device',
    });
    expect(JSON.stringify(response.body)).not.toContain('must-not-leak');
  });

  test('validates cancellation and delegates logout to the credential owner', async () => {
    const invalidResponse = await request(createApp()).post('/api/codex/login/cancel').send({});
    const cancelResponse = await request(createApp())
      .post('/api/codex/login/cancel')
      .send({ loginId: 'login-1' });
    const logoutResponse = await request(createApp()).post('/api/codex/logout');

    expect(invalidResponse.status).toBe(400);
    expect(cancelResponse.status).toBe(200);
    expect(codexMocks.cancelCodexLogin).toHaveBeenCalledWith('login-1');
    expect(logoutResponse.status).toBe(200);
    expect(codexMocks.logoutCodexAccount).toHaveBeenCalledTimes(1);
  });

  test('never exposes app-server process details in an HTTP failure', async () => {
    codexMocks.startCodexDeviceLogin.mockRejectedValue(
      new Error('C:\\Users\\reader\\.codex\\auth.json contained an invalid refresh token')
    );

    const response = await request(createApp()).post('/api/codex/login');

    expect(response.status).toBe(503);
    expect(response.body).toEqual({
      success: false,
      error: 'Codex non ha completato l’operazione. Riprova.',
    });
    expect(JSON.stringify(response.body)).not.toContain('.codex');
    expect(JSON.stringify(response.body)).not.toContain('refresh token');
  });
});
