import request from 'supertest';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { createApp } from '../../src/index.js';
import type { JsonValue } from '../../src/workflows/types.js';
import {
  WorkflowReplicaOutdatedError,
  WorkflowSignalError,
} from '../../src/workflows/workflowErrors.js';
import type { WorkflowRuntimeApi } from '../../src/workflows/workflowRuntimeApi.js';

const RUN_ID = '9de19290-0dab-470d-a554-9a214073283e';
const WAIT_ID = 'f58eeb9b-7abd-4d0f-a589-e54192284062';

const createState = () => ({
  publishedEvents: [
    {
      createdAt: '2026-07-29T10:00:04.000Z',
      eventType: 'lesson.ready',
      payload: { sectionId: 'section-1' } satisfies JsonValue,
      schemaVersion: 1,
      sequence: '1',
    },
  ],
  nodes: [
    {
      attemptCount: 1,
      availableAt: '2026-07-29T10:00:00.000Z',
      createdAt: '2026-07-29T10:00:00.000Z',
      definitionId: 'draft',
      error: {
        code: 'provider_failed',
        details: { privateTrace: 'do-not-expose' },
        kind: 'operational' as const,
        message: 'Provider returned a private diagnostic.',
      },
      instanceId: 'root/draft',
      kind: 'step' as const,
      maxAttempts: 3,
      status: 'retrying' as const,
      updatedAt: '2026-07-29T10:00:03.000Z',
    },
  ],
  run: {
    cancellationRequested: false,
    cleanupStatus: 'not-required' as const,
    createdAt: '2026-07-29T10:00:00.000Z',
    definitionHash: 'definition-hash',
    definitionHashVersion: 1,
    error: {
      code: 'run_failed',
      kind: 'permanent' as const,
      message: 'Private run diagnostic.',
    },
    id: RUN_ID,
    projectId: 'project-1',
    requestKey: 'lesson:project-1:section-1',
    status: 'waiting' as const,
    updatedAt: '2026-07-29T10:00:04.000Z',
    workflowId: 'lesson-generation',
  },
  waits: [
    {
      createdAt: '2026-07-29T10:00:04.000Z',
      expiresAt: '2026-07-30T10:00:04.000Z',
      nodeInstanceId: 'root/approval',
      schemaVersion: 2,
      signalType: 'lesson.approved',
      waitId: WAIT_ID,
    },
  ],
});

const createApi = (): WorkflowRuntimeApi => ({
  getRunState: vi.fn().mockResolvedValue(createState()),
  requestCancellation: vi.fn().mockResolvedValue({
    runStatus: 'running',
    status: 'requested',
  }),
  receiveSignal: vi.fn().mockResolvedValue({ runId: RUN_ID, status: 'consumed' }),
});

describe('/api/workflows', () => {
  let api: WorkflowRuntimeApi;

  beforeEach(() => {
    api = createApi();
  });

  test('reports a stable unavailable response for an explicitly uncomposed app factory', async () => {
    const response = await request(createApp()).get(`/api/workflows/runs/${RUN_ID}`);

    expect(response.status).toBe(503);
    expect(response.body).toEqual({
      code: 'workflow_runtime_unavailable',
      error: 'Servizio workflow non disponibile.',
      success: false,
    });
  });

  test('returns owner-scoped public state without private workflow data or raw failures', async () => {
    const response = await request(createApp({ workflowRuntimeApi: api })).get(
      `/api/workflows/runs/${RUN_ID}`
    );

    expect(response.status).toBe(200);
    expect(response.headers['cache-control']).toBe('private, no-store');
    expect(api.getRunState).toHaveBeenCalledWith({ runId: RUN_ID, userId: 'local-user' });
    expect(response.body).toEqual({
      success: true,
      state: {
        ...createState(),
        nodes: [
          { ...createState().nodes[0], error: { code: 'provider_failed', kind: 'operational' } },
        ],
        run: {
          ...createState().run,
          error: { code: 'run_failed', kind: 'permanent' },
        },
      },
    });
    expect(JSON.stringify(response.body)).not.toContain('privateTrace');
    expect(JSON.stringify(response.body)).not.toContain('diagnostic');
    expect(response.body.state.run).not.toHaveProperty('input');
    expect(response.body.state.run).not.toHaveProperty('output');
    expect(response.body.state.run).not.toHaveProperty('resolvedConfig');
    expect(response.body.state.run).not.toHaveProperty('userId');
    expect(response.body.state).not.toHaveProperty('events');
  });

  test('returns a stable not-found response without revealing another owner', async () => {
    vi.mocked(api.getRunState).mockResolvedValue(null);

    const response = await request(createApp({ workflowRuntimeApi: api })).get(
      `/api/workflows/runs/${RUN_ID}`
    );

    expect(response.status).toBe(404);
    expect(response.body).toEqual({
      code: 'workflow_run_not_found',
      error: 'Esecuzione non trovata.',
      success: false,
    });
  });

  test('requests cancellation for the authenticated owner and preserves idempotent outcomes', async () => {
    const response = await request(createApp({ workflowRuntimeApi: api })).post(
      `/api/workflows/runs/${RUN_ID}/cancellation`
    );

    expect(response.status).toBe(200);
    expect(api.requestCancellation).toHaveBeenCalledWith({ runId: RUN_ID, userId: 'local-user' });
    expect(response.body).toEqual({
      cancellation: { runStatus: 'running', status: 'requested' },
      success: true,
    });
  });

  test('delivers a typed signal to one explicit run wait without returning its payload', async () => {
    const payload = { approved: true, privateComment: 'keep this out of the response' };
    const response = await request(createApp({ workflowRuntimeApi: api }))
      .post(`/api/workflows/runs/${RUN_ID}/waits/${WAIT_ID}/signals`)
      .send({ payload, requestKey: 'approval-click-1', signalType: 'lesson.approved' });

    expect(response.status).toBe(200);
    expect(api.receiveSignal).toHaveBeenCalledWith({
      payload,
      requestKey: 'approval-click-1',
      runId: RUN_ID,
      signalType: 'lesson.approved',
      userId: 'local-user',
      waitId: WAIT_ID,
    });
    expect(response.body).toEqual({
      signal: { runId: RUN_ID, status: 'consumed' },
      success: true,
    });
    expect(JSON.stringify(response.body)).not.toContain('privateComment');
  });

  test.each([
    ['/api/workflows/runs/not-a-uuid', 'get', undefined],
    [`/api/workflows/runs/${RUN_ID}/cancellation`, 'post', { unexpected: true }],
    [
      `/api/workflows/runs/${RUN_ID}/waits/not-a-uuid/signals`,
      'post',
      { payload: {}, requestKey: 'request-1', signalType: 'lesson.approved' },
    ],
    [
      `/api/workflows/runs/${RUN_ID}/waits/${WAIT_ID}/signals`,
      'post',
      { payload: {}, requestKey: '   ', signalType: 'lesson.approved' },
    ],
    [
      `/api/workflows/runs/${RUN_ID}/waits/${WAIT_ID}/signals`,
      'post',
      { requestKey: 'request-1', signalType: 'lesson.approved' },
    ],
  ])('rejects malformed requests before calling the runtime: %s', async (path, method, body) => {
    const pending = request(createApp({ workflowRuntimeApi: api }))[method as 'get' | 'post'](path);
    const response = body === undefined ? await pending : await pending.send(body);

    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      code: 'workflow_request_invalid',
      error: 'Richiesta workflow non valida.',
      success: false,
    });
    expect(api.getRunState).not.toHaveBeenCalled();
    expect(api.requestCancellation).not.toHaveBeenCalled();
    expect(api.receiveSignal).not.toHaveBeenCalled();
  });

  test('does not expose internal signal errors', async () => {
    vi.mocked(api.receiveSignal).mockRejectedValue(
      new WorkflowSignalError('workflow_wait_expired', 'Private wait diagnostics')
    );

    const response = await request(createApp({ workflowRuntimeApi: api }))
      .post(`/api/workflows/runs/${RUN_ID}/waits/${WAIT_ID}/signals`)
      .send({
        payload: { approved: true },
        requestKey: 'request-1',
        signalType: 'lesson.approved',
      });

    expect(response.status).toBe(410);
    expect(response.body).toEqual({
      code: 'workflow_wait_expired',
      error: 'La richiesta di conferma è scaduta.',
      success: false,
    });
    expect(JSON.stringify(response.body)).not.toContain('Private wait diagnostics');
  });

  test('asks the client to retry when a stale replica receives a new signal', async () => {
    vi.mocked(api.receiveSignal).mockRejectedValue(new WorkflowReplicaOutdatedError());

    const response = await request(createApp({ workflowRuntimeApi: api }))
      .post(`/api/workflows/runs/${RUN_ID}/waits/${WAIT_ID}/signals`)
      .send({
        payload: { approved: true },
        requestKey: 'request-1',
        signalType: 'lesson.approved',
      });

    expect(response.status).toBe(503);
    expect(response.body).toEqual({
      code: 'workflow_runtime_unavailable',
      error: 'Servizio workflow non disponibile.',
      success: false,
    });
  });

  test('does not expose a foreign wait through the forbidden signal error', async () => {
    vi.mocked(api.receiveSignal).mockRejectedValue(
      new WorkflowSignalError('workflow_signal_forbidden', 'The wait belongs to someone else.')
    );

    const response = await request(createApp({ workflowRuntimeApi: api }))
      .post(`/api/workflows/runs/${RUN_ID}/waits/${WAIT_ID}/signals`)
      .send({ payload: null, requestKey: 'request-1', signalType: 'lesson.approved' });

    expect(response.status).toBe(404);
    expect(response.body).toEqual({
      code: 'workflow_wait_not_found',
      error: 'Richiesta di conferma non trovata.',
      success: false,
    });
  });
});
