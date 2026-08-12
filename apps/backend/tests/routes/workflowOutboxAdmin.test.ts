import request from 'supertest';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { createApp } from '../../src/index.js';
import type { WorkflowOutboxAdmin } from '../../src/routes/workflowOutboxAdmin.js';
import { createSupabaseTestToken } from '../helpers/auth.js';

const authHeader = (role: 'admin' | 'user'): string =>
  `Bearer ${createSupabaseTestToken({ role })}`;
const ORIGINAL_ENV = { ...process.env };

const makeOutbox = (overrides: Partial<WorkflowOutboxAdmin> = {}): WorkflowOutboxAdmin => ({
  listDeadLetters: overrides.listDeadLetters ?? vi.fn(async () => []),
  retryDeadLetter: overrides.retryDeadLetter ?? vi.fn(async () => true),
});

describe('/api/admin/workflow-outbox', () => {
  beforeEach(() => {
    process.env = {
      ...ORIGINAL_ENV,
      AUTH_MODE: 'supabase',
      SUPABASE_JWT_SECRET: 'test-secret',
      SUPABASE_URL: 'https://example.supabase.co',
    };
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  test('rejects non-admin users before reading dead letters', async () => {
    const outbox = makeOutbox();
    const response = await request(createApp({ workflowOutboxAdmin: outbox }))
      .get('/api/admin/workflow-outbox/dead-letters')
      .set('Authorization', authHeader('user'));

    expect(response.status).toBe(403);
    expect(outbox.listDeadLetters).not.toHaveBeenCalled();
  });

  test('lets an admin inspect dead letters without hiding their diagnostics', async () => {
    const deadLetter = {
      attemptCount: 3,
      createdAt: '2026-08-10T12:00:00.000Z',
      deadLetteredAt: '2026-08-10T12:03:00.000Z',
      eventType: 'project-revision',
      failure: { code: 'notification_unsupported', kind: 'permanent', message: 'Unsupported.' },
      id: '11111111-1111-4111-8111-111111111111',
      payload: { projectId: 'project-1' },
      runId: '22222222-2222-4222-8222-222222222222',
      schemaVersion: 2,
      sequence: '7',
      userId: '33333333-3333-4333-8333-333333333333',
    } as const;
    const outbox = makeOutbox({ listDeadLetters: vi.fn(async () => [deadLetter]) });
    const response = await request(createApp({ workflowOutboxAdmin: outbox }))
      .get('/api/admin/workflow-outbox/dead-letters')
      .set('Authorization', authHeader('admin'));

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ deadLetters: [deadLetter], success: true });
  });

  test('requeues a dead letter with the authenticated admin identity', async () => {
    const retryDeadLetter = vi.fn(async () => true);
    const outbox = makeOutbox({ retryDeadLetter });
    const token = createSupabaseTestToken({ role: 'admin' });
    const response = await request(createApp({ workflowOutboxAdmin: outbox }))
      .post('/api/admin/workflow-outbox/dead-letters/11111111-1111-4111-8111-111111111111/retry')
      .set('Authorization', `Bearer ${token}`);

    expect(response.status).toBe(200);
    expect(retryDeadLetter).toHaveBeenCalledWith({
      id: '11111111-1111-4111-8111-111111111111',
      requestedBy: expect.any(String),
    });
  });

  test('rejects invalid ids and reports missing dead letters', async () => {
    const retryDeadLetter = vi.fn(async () => false);
    const app = createApp({ workflowOutboxAdmin: makeOutbox({ retryDeadLetter }) });
    const authorization = authHeader('admin');

    const invalid = await request(app)
      .post('/api/admin/workflow-outbox/dead-letters/not-a-uuid/retry')
      .set('Authorization', authorization);
    const missing = await request(app)
      .post('/api/admin/workflow-outbox/dead-letters/11111111-1111-4111-8111-111111111111/retry')
      .set('Authorization', authorization);

    expect(invalid.status).toBe(400);
    expect(missing.status).toBe(404);
    expect(retryDeadLetter).toHaveBeenCalledOnce();
  });
});
