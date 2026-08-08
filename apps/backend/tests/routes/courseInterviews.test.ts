import request from 'supertest';
import { describe, expect, test, vi } from 'vitest';

import { createApp } from '../../src/index.js';
import {
  type CourseInterviewApi,
  CourseInterviewTargetNotFoundError,
} from '../../src/workflows/courseInterviewApi.js';

const run = {
  createdAt: '2026-08-08T10:00:00.000Z',
  id: 'run-1',
  projectId: 'project-1',
  status: 'waiting' as const,
  updatedAt: '2026-08-08T10:01:00.000Z',
};

const createApi = (): CourseInterviewApi => ({
  getActive: vi.fn().mockResolvedValue(run),
  start: vi.fn().mockResolvedValue({ created: true, run }),
});

const createTestApp = (courseInterviewApi: CourseInterviewApi) => createApp({ courseInterviewApi });

describe('course interview routes', () => {
  test('starts and reconnects one durable interview', async () => {
    const api = createApi();
    const body = {
      hasReliableSourceContext: false,
      mode: 'learn',
      projectId: 'project-1',
      requestKey: 'request-1',
    };
    const started = await request(createTestApp(api)).post('/api/course-interviews').send(body);
    const active = await request(createTestApp(api)).get('/api/course-interviews/project-1/active');

    expect(started.status).toBe(202);
    expect(started.body).toEqual({ created: true, run, success: true });
    expect(api.start).toHaveBeenCalledWith({
      ...body,
      aiProvider: undefined,
      aiProviderOverrides: undefined,
      userId: 'local-user',
    });
    expect(active.status).toBe(200);
    expect(active.headers['cache-control']).toBe('private, no-store');
    expect(active.body).toEqual({ run, success: true });
  });

  test('rejects invalid source context and maps a missing project', async () => {
    const api = createApi();
    const invalid = await request(createTestApp(api)).post('/api/course-interviews').send({
      hasReliableSourceContext: true,
      mode: 'learn',
      projectId: 'project-1',
      requestKey: 'request-1',
    });
    vi.mocked(api.start).mockRejectedValue(new CourseInterviewTargetNotFoundError());
    const missing = await request(createTestApp(api)).post('/api/course-interviews').send({
      hasReliableSourceContext: false,
      mode: 'learn',
      projectId: 'missing',
      requestKey: 'request-2',
    });

    expect(invalid.status).toBe(400);
    expect(api.start).toHaveBeenCalledTimes(1);
    expect(missing.status).toBe(404);
    expect(missing.body).toEqual({
      code: 'course_interview_not_found',
      error: 'Intervista non trovata.',
      success: false,
    });
  });
});
