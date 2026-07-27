import request from 'supertest';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { createApp } from '../../src/index.js';
import {
  FeedbackService,
  setFeedbackServiceForTesting,
} from '../../src/services/feedbackService.js';
import {
  FeedbackRateLimitError,
  type StoredFeedbackReport,
} from '../../src/services/feedbackStore.js';
import { signSupabaseJwt } from '../helpers/auth.js';

const ORIGINAL_ENV = { ...process.env };
const USER_ID = 'c70e858f-73d3-4ca7-8f48-1cd31ab04a5c';
const FEEDBACK_ID = 'cc49c9bd-c90e-449a-b12d-7117d7f16d49';

const createToken = (role = 'user'): string =>
  signSupabaseJwt(
    {
      app_metadata: { role },
      email: 'student@example.com',
      exp: Math.floor(Date.now() / 1000) + 60,
      sub: USER_ID,
    },
    'test-secret'
  );

const createPendingReport = (): StoredFeedbackReport => ({
  attemptCount: 0,
  category: 'bug',
  createdAt: '2026-07-16T10:00:00.000Z',
  description: 'La pagina resta bloccata.',
  diagnostics: {},
  githubLabels: [],
  hasScreenshot: false,
  id: FEEDBACK_ID,
  source: 'app',
  status: 'pending',
  updatedAt: '2026-07-16T10:00:00.000Z',
  userId: USER_ID,
});

const createService = ({
  create = vi.fn(async () => ({ created: true, report: createPendingReport() })),
  publisherConfigured = false,
}: {
  create?: ReturnType<typeof vi.fn>;
  publisherConfigured?: boolean;
} = {}) => {
  const store = {
    claimForDelivery: vi.fn(async () => ({ ...createPendingReport(), attemptCount: 1 })),
    create,
    getScreenshot: vi.fn(async () => null),
    list: vi.fn(async () => ({ reports: [], total: 0 })),
    markDeliveryFailed: vi.fn(async () => undefined),
    markSubmitted: vi.fn(async () => undefined),
    retry: vi.fn(async () => true),
    upsertGithubIssues: vi.fn(async issues => issues.length),
  };
  const publisher = {
    isConfigured: vi.fn(() => publisherConfigured),
    listIssues: vi.fn(async () => []),
    publish: vi.fn(async () => ({ number: 64, url: 'https://github.com/example/repo/issues/64' })),
  };
  const service = new FeedbackService(store as never, publisher);
  return { publisher, service, store };
};

describe('/api/feedback', () => {
  beforeEach(() => {
    process.env = {
      ...ORIGINAL_ENV,
      AUTH_MODE: 'supabase',
      SUPABASE_JWT_SECRET: 'test-secret',
    };
  });

  afterEach(() => {
    setFeedbackServiceForTesting(null);
    process.env = { ...ORIGINAL_ENV };
  });

  test('requires authentication before accepting feedback', async () => {
    const response = await request(createApp()).post('/api/feedback').send({
      category: 'bug',
      description: 'Non funziona.',
    });

    expect(response.status).toBe(401);
    expect(response.body).toEqual({ success: false, error: 'Accesso richiesto.' });
  });

  test('persists sanitized diagnostics before asynchronous GitHub delivery', async () => {
    const events: string[] = [];
    const create = vi.fn(async () => {
      events.push('persist');
      return { created: true, report: createPendingReport() };
    });
    const { service, store } = createService({ create });
    setFeedbackServiceForTesting(service);

    const webpBytes = Buffer.alloc(30);
    webpBytes.write('RIFF', 0, 'ascii');
    webpBytes.writeUInt32LE(22, 4);
    webpBytes.write('WEBP', 8, 'ascii');
    webpBytes.write('VP8X', 12, 'ascii');
    webpBytes.writeUInt32LE(10, 16);
    const response = await request(createApp())
      .post('/api/feedback')
      .set('Authorization', `Bearer ${createToken()}`)
      .set('User-Agent', 'Nous test browser')
      .send({
        category: 'bug',
        description:
          '  La pagina resta bloccata per student@example.com su https://nous.example/course/42?access_token=secret#section.  ',
        diagnostics: {
          consoleEntries: [
            {
              level: 'error',
              message: 'Authorization: Bearer secret-token',
              timestamp: '2026-07-16T10:00:00Z',
            },
          ],
          correlationIds: ['job-123', 'job-123'],
          pageUrl: 'https://nous.example/course/42?access_token=secret#section',
        },
        screenshot: { dataUrl: `data:image/webp;base64,${webpBytes.toString('base64')}` },
      });

    expect(response.status).toBe(201);
    expect(response.body).toEqual({
      success: true,
      feedback: {
        id: FEEDBACK_ID,
        status: 'pending',
      },
    });
    expect(events).toEqual(['persist']);
    const storedInput = create.mock.calls[0]?.[0];
    expect(storedInput).toMatchObject({
      category: 'bug',
      description:
        'La pagina resta bloccata per [EMAIL REDACTED] su https://nous.example/course/42',
      reporterEmail: 'student@example.com',
      userId: USER_ID,
      diagnostics: {
        consoleEntries: [
          {
            level: 'error',
            message: 'Authorization: [REDACTED]',
            timestamp: '2026-07-16T10:00:00.000Z',
          },
        ],
        correlationIds: ['job-123'],
        pageUrl: 'https://nous.example/course/[ID]',
        userAgent: 'Nous test browser',
      },
      screenshot: { bytes: webpBytes, mimeType: 'image/webp' },
    });
    expect(storedInput.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(store.markSubmitted).not.toHaveBeenCalled();
  });

  test('rejects invalid categories and oversized screenshots before persistence', async () => {
    const { service, store } = createService();
    setFeedbackServiceForTesting(service);
    const token = createToken();

    const invalidCategory = await request(createApp())
      .post('/api/feedback')
      .set('Authorization', `Bearer ${token}`)
      .send({ category: 'other', description: 'Test' });
    const oversizedScreenshot = await request(createApp())
      .post('/api/feedback')
      .set('Authorization', `Bearer ${token}`)
      .send({
        category: 'bug',
        description: 'Test',
        screenshot: {
          dataUrl: `data:image/webp;base64,${Buffer.alloc(768 * 1024 + 1).toString('base64')}`,
        },
      });
    const oversizedDimensions = Buffer.alloc(30);
    oversizedDimensions.write('RIFF', 0, 'ascii');
    oversizedDimensions.writeUInt32LE(22, 4);
    oversizedDimensions.write('WEBP', 8, 'ascii');
    oversizedDimensions.write('VP8X', 12, 'ascii');
    oversizedDimensions.writeUInt32LE(10, 16);
    oversizedDimensions.writeUIntLE(1_999, 24, 3);
    const oversizedDimensionsScreenshot = await request(createApp())
      .post('/api/feedback')
      .set('Authorization', `Bearer ${token}`)
      .send({
        category: 'bug',
        description: 'Test',
        screenshot: {
          dataUrl: `data:image/webp;base64,${oversizedDimensions.toString('base64')}`,
        },
      });

    expect(invalidCategory.status).toBe(400);
    expect(oversizedScreenshot.status).toBe(400);
    expect(oversizedDimensionsScreenshot.status).toBe(400);
    expect(store.create).not.toHaveBeenCalled();
  });

  test('returns a stable rate-limit error without exposing internals', async () => {
    const create = vi.fn(async () => {
      throw new FeedbackRateLimitError();
    });
    const { service } = createService({ create });
    setFeedbackServiceForTesting(service);

    const response = await request(createApp())
      .post('/api/feedback')
      .set('Authorization', `Bearer ${createToken()}`)
      .send({ category: 'enhancement', description: 'Aggiungere una scorciatoia.' });

    expect(response.status).toBe(429);
    expect(response.body).toEqual({
      success: false,
      error: 'Hai inviato troppe segnalazioni. Riprova più tardi.',
    });
  });

  test('discards diagnostics and screenshots from suggestions at the backend boundary', async () => {
    const { service, store } = createService();
    setFeedbackServiceForTesting(service);

    const response = await request(createApp())
      .post('/api/feedback')
      .set('Authorization', `Bearer ${createToken()}`)
      .send({
        category: 'enhancement',
        description: 'Aggiungere una scorciatoia.',
        diagnostics: { consoleEntries: [{ level: 'error', message: 'password=secret' }] },
        screenshot: { dataUrl: 'data:image/webp;base64,not-an-image' },
      });

    expect(response.status).toBe(201);
    const storedInput = store.create.mock.calls[0]?.[0];
    expect(storedInput).toMatchObject({ diagnostics: {} });
    expect(storedInput).not.toHaveProperty('screenshot');
  });

  test('keeps a persisted report pending when asynchronous GitHub delivery fails', async () => {
    const { publisher, service, store } = createService({ publisherConfigured: true });
    publisher.publish.mockRejectedValue(new Error('network secret'));
    store.claimForDelivery.mockResolvedValue({ ...createPendingReport(), attemptCount: 1 });

    await expect(service.dispatchNextPending()).resolves.toBe(true);
    expect(store.markDeliveryFailed).toHaveBeenCalledWith(
      FEEDBACK_ID,
      'github_unknown_error',
      expect.any(Date)
    );
  });

  test('does not republish a deduplicated report', async () => {
    const report = {
      ...createPendingReport(),
      githubIssueUrl: 'https://github.com/example/repo/issues/64',
      status: 'submitted' as const,
    };
    const create = vi.fn(async () => ({ created: false, report }));
    const { publisher, service } = createService({ create, publisherConfigured: true });
    setFeedbackServiceForTesting(service);

    const response = await request(createApp())
      .post('/api/feedback')
      .set('Authorization', `Bearer ${createToken()}`)
      .send({ category: 'bug', description: 'La pagina resta bloccata.' });

    expect(response.status).toBe(200);
    expect(response.body.feedback).toEqual({
      id: FEEDBACK_ID,
      status: 'submitted',
    });
    expect(publisher.publish).not.toHaveBeenCalled();
  });

  test('keeps report administration restricted to administrators', async () => {
    const { service, store } = createService();
    store.list.mockResolvedValue({ reports: [createPendingReport()], total: 1 });
    setFeedbackServiceForTesting(service);

    const forbidden = await request(createApp())
      .get('/api/feedback/admin')
      .set('Authorization', `Bearer ${createToken('user')}`);
    const allowed = await request(createApp())
      .get('/api/feedback/admin?page=2&pageSize=10')
      .set('Authorization', `Bearer ${createToken('admin')}`);

    expect(forbidden.status).toBe(403);
    expect(allowed.status).toBe(200);
    expect(allowed.body).toMatchObject({ page: 2, pageSize: 10, success: true, total: 1 });
    expect(store.list).toHaveBeenCalledWith(2, 10);
  });

  test('lets administrators synchronize the complete GitHub mirror', async () => {
    const { publisher, service, store } = createService({ publisherConfigured: true });
    publisher.listIssues.mockResolvedValue([
      {
        body: 'GitHub body',
        createdAt: '2026-07-16T10:00:00.000Z',
        labels: ['bug'],
        number: 118,
        state: 'closed',
        title: 'GitHub title',
        updatedAt: '2026-07-16T11:00:00.000Z',
        url: 'https://github.com/example/repo/issues/118',
      },
    ]);
    setFeedbackServiceForTesting(service);

    const response = await request(createApp())
      .post('/api/feedback/admin/sync')
      .set('Authorization', `Bearer ${createToken('admin')}`);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ issueCount: 1, success: true });
    expect(response.body.synchronizedAt).toEqual(expect.any(String));
    expect(store.upsertGithubIssues).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ number: 118, state: 'closed' })])
    );
  });
});
