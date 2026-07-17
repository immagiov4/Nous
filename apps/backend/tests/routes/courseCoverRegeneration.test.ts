import request from 'supertest';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const { getStatusMock, startOrResumeMock } = vi.hoisted(() => ({
  getStatusMock: vi.fn(),
  startOrResumeMock: vi.fn(),
}));

vi.mock('../../src/services/courseCoverRegeneration.js', () => ({
  getCourseCoverRegenerationStatus: getStatusMock,
  startOrResumeCourseCoverRegeneration: startOrResumeMock,
}));

import { createApp } from '../../src/index.js';

const originalEnv = { ...process.env };
const runningJob = {
  id: 'course-cover-p2-job',
  promptVersion: 2,
  results: [],
  startedAt: '2026-07-17T00:00:00.000Z',
  status: 'running' as const,
  summary: { failed: 0, pending: 1, regenerated: 0, skipped: 0, total: 1 },
  updatedAt: '2026-07-17T00:00:00.000Z',
};

describe('course cover regeneration routes', () => {
  beforeEach(() => {
    process.env.AUTH_MODE = 'local';
    process.env.LOCAL_USER_ID = 'cover-user';
    getStatusMock.mockReset();
    startOrResumeMock.mockReset();
    getStatusMock.mockReturnValue(null);
    startOrResumeMock.mockReturnValue(runningJob);
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  test('reads status without starting a job', async () => {
    const response = await request(createApp()).get('/api/projects/covers/regenerate/status');

    expect(response.status).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers.pragma).toBe('no-cache');
    expect(response.body).toEqual({ success: true, job: null });
    expect(getStatusMock).toHaveBeenCalledWith('cover-user');
    expect(startOrResumeMock).not.toHaveBeenCalled();
  });

  test('starts or resumes asynchronously for the current user', async () => {
    const response = await request(createApp()).get('/api/projects/covers/regenerate');

    expect(response.status).toBe(202);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body).toEqual({ success: true, job: runningJob });
    expect(startOrResumeMock).toHaveBeenCalledWith('cover-user', undefined);
  });

  test('returns a completed cooldown job without starting another batch', async () => {
    startOrResumeMock.mockReturnValue({
      ...runningJob,
      completedAt: '2026-07-17T00:01:00.000Z',
      status: 'completed',
      summary: { failed: 0, pending: 0, regenerated: 1, skipped: 0, total: 1 },
    });

    const response = await request(createApp()).get('/api/projects/covers/regenerate');

    expect(response.status).toBe(200);
    expect(response.body.job.status).toBe('completed');
  });

  test('keeps start and status failures distinct without exposing internal errors', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    getStatusMock.mockImplementationOnce(() => {
      throw new Error('private status detail');
    });
    startOrResumeMock.mockImplementationOnce(() => {
      throw new Error('private start detail');
    });

    const statusResponse = await request(createApp()).get('/api/projects/covers/regenerate/status');
    const startResponse = await request(createApp()).get('/api/projects/covers/regenerate');

    expect(statusResponse.status).toBe(500);
    expect(statusResponse.body.error).toBe('Unable to read course cover regeneration status.');
    expect(startResponse.status).toBe(500);
    expect(startResponse.body.error).toBe('Unable to start course cover regeneration.');
    consoleError.mockRestore();
  });
});
