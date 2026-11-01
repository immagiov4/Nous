import { beforeEach, expect, test, vi } from 'vitest';

const fetchMock = vi.hoisted(() => vi.fn());
vi.mock('../../../services/auth/supabaseAuth.ts', () => ({ fetchWithSupabaseAuth: fetchMock }));
vi.mock('../../../services/openrouter/config.ts', () => ({
  getBackendUrl: () => 'https://api.nous.test',
}));

const { createContextNoteDiagnostics } = await import(
  '../../../services/context/contextNoteDiagnostics.ts'
);

beforeEach(() => {
  fetchMock.mockReset().mockResolvedValue(new Response(null, { status: 204 }));
});

test('correlates proposal and save, deduplicates rerenders and records no provider or lesson content', async () => {
  const log = vi.spyOn(console, 'info').mockImplementation(() => {});
  const diagnostics = createContextNoteDiagnostics();
  const proposal = {
    phase: 'proposal' as const,
    outcome: 'accepted' as const,
    durationMs: 2,
    contextScope: 'selection' as const,
    candidateOutcomes: ['anchorable' as const],
  };
  await diagnostics.report('PRIVATE_PROVIDER_ID', proposal);
  await diagnostics.report('PRIVATE_PROVIDER_ID', proposal);
  await diagnostics.report('PRIVATE_PROVIDER_ID', {
    phase: 'save',
    outcome: 'saved',
    durationMs: 3,
    contextScope: 'selection',
  });
  expect(fetchMock).toHaveBeenCalledTimes(2);
  const sent = fetchMock.mock.calls.map(([, init]) => JSON.parse(init.body));
  expect(sent[0].operationId).toMatch(/^[\da-f-]{36}$/);
  expect(sent[1].operationId).toBe(sent[0].operationId);
  expect(JSON.stringify(sent)).not.toContain('PRIVATE_PROVIDER_ID');
  expect(log).toHaveBeenCalledWith(expect.stringContaining(sent[0].operationId));
});

test.each([
  'network',
  'http',
] as const)('a diagnostic %s failure settles without exposing its cause', async failure => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  if (failure === 'network') fetchMock.mockRejectedValue(new Error('PRIVATE_NOTE_TEXT'));
  else fetchMock.mockResolvedValue(new Response('PRIVATE_NOTE_TEXT', { status: 500 }));
  await expect(
    createContextNoteDiagnostics().report('private-id', {
      phase: 'proposal',
      outcome: 'validation_error',
      code: 'invalid_input',
      durationMs: 0,
      contextScope: 'lesson',
      candidateOutcomes: [],
    })
  ).resolves.toBeUndefined();
  expect(JSON.stringify(warn.mock.calls)).not.toContain('PRIVATE_NOTE_TEXT');
  expect(warn).toHaveBeenCalledWith(expect.stringContaining('delivery_failed'));
});

test('rejects arbitrary content before writing to logs or the network', async () => {
  const log = vi.spyOn(console, 'info').mockImplementation(() => {});
  const event = {
    phase: 'proposal' as const,
    outcome: 'accepted' as const,
    durationMs: 0,
    contextScope: 'selection' as const,
    candidateOutcomes: [],
    note: 'PRIVATE_NOTE_TEXT',
  };
  await createContextNoteDiagnostics().report('id', event);
  expect(fetchMock).not.toHaveBeenCalled();
  expect(log).not.toHaveBeenCalled();
});

test('reports opaque UUIDs on private-network HTTP without randomUUID', async () => {
  vi.stubGlobal('crypto', {
    getRandomValues: globalThis.crypto.getRandomValues.bind(globalThis.crypto),
  });
  try {
    await expect(
      createContextNoteDiagnostics().report('PRIVATE_PROVIDER_ID', {
        phase: 'proposal',
        outcome: 'accepted',
        durationMs: 0,
        contextScope: 'lesson',
        candidateOutcomes: [],
      })
    ).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const sent = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(sent.operationId).toMatch(
      /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/u
    );
    expect(JSON.stringify(sent)).not.toContain('PRIVATE_PROVIDER_ID');
  } finally {
    vi.unstubAllGlobals();
  }
});
