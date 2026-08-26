import request from 'supertest';
import { describe, expect, test, vi } from 'vitest';

import { createApp } from '../../src/index.js';
import type { LessonGenerationApi } from '../../src/workflows/lessonGenerationApi.js';
import { LessonGenerationTargetNotFoundError } from '../../src/workflows/lessonGenerationApi.js';
import { WorkflowRunRequestConflictError } from '../../src/workflows/workflowErrors.js';

const job = {
  createdAt: '2026-07-29T20:00:00.000Z',
  id: 'run-1',
  projectId: 'project-1',
  retrying: false,
  sectionId: 'lesson-1',
  stage: 'sources',
  status: 'queued',
  updatedAt: '2026-07-29T20:00:00.000Z',
} as const;

const createApi = (): LessonGenerationApi => ({
  get: vi.fn().mockResolvedValue(job),
  getByRequestKey: vi.fn().mockResolvedValue(job),
  start: vi.fn().mockResolvedValue({ busy: false, created: true, job }),
  startSublesson: vi.fn().mockResolvedValue({ busy: false, created: true, job }),
});

describe('lesson workflow routes', () => {
  test('starts a durable lesson with the authenticated provider configuration', async () => {
    const api = createApi();
    const response = await request(createApp({ lessonGenerationApi: api }))
      .post('/api/lesson-workflows/lessons')
      .send({
        forceRegenerate: true,
        projectId: 'project-1',
        requestKey: 'request-1',
        sectionId: 'lesson-1',
      });

    expect(response.status).toBe(202);
    expect(api.start).toHaveBeenCalledWith({
      aiProvider: undefined,
      aiProviderOverrides: undefined,
      forceRegenerate: true,
      projectId: 'project-1',
      requestKey: 'request-1',
      sectionId: 'lesson-1',
      userId: 'local-user',
    });
    expect(response.body).toEqual({ created: true, job, success: true });
  });

  test('returns a conflict with the existing public job when another lesson is active', async () => {
    const api = createApi();
    const activeJob = { ...job, sectionId: 'lesson-2', status: 'running' as const };
    vi.mocked(api.start).mockResolvedValue({ busy: true, created: false, job: activeJob });

    const response = await request(createApp({ lessonGenerationApi: api }))
      .post('/api/lesson-workflows/lessons')
      .send({ projectId: 'project-1', requestKey: 'request-2', sectionId: 'lesson-1' });

    expect(response.status).toBe(409);
    expect(response.body).toEqual({
      code: 'lesson_generation_busy',
      error: 'È già in corso la generazione di un’altra lezione di questo corso.',
      job: activeJob,
      success: false,
    });
  });

  test('starts a durable sublesson without accepting client-owned parent content or section ids', async () => {
    const api = createApi();
    const response = await request(createApp({ lessonGenerationApi: api }))
      .post('/api/lesson-workflows/sublessons')
      .send({
        annotationNote: 'Nota collegata',
        contextAfter: 'Dopo',
        contextBefore: 'Prima',
        instructions: 'Approfondisci',
        parentContent: 'Contenuto client da ignorare',
        parentSectionId: 'lesson-1',
        projectId: 'project-1',
        requestKey: 'request-sublesson-1',
        sectionId: 'client-owned-id',
        selectedText: 'orologio globale',
      });

    expect(response.status).toBe(400);
    expect(api.startSublesson).not.toHaveBeenCalled();

    const accepted = await request(createApp({ lessonGenerationApi: api }))
      .post('/api/lesson-workflows/sublessons')
      .send({
        annotationNote: 'Nota collegata',
        contextAfter: 'Dopo',
        contextBefore: 'Prima',
        instructions: 'Approfondisci',
        parentSectionId: 'lesson-1',
        projectId: 'project-1',
        requestKey: 'request-sublesson-1',
        selectedText: 'orologio globale',
      });

    expect(accepted.status).toBe(202);
    expect(api.startSublesson).toHaveBeenCalledWith({
      aiProvider: undefined,
      aiProviderOverrides: undefined,
      focus: {
        annotationNote: 'Nota collegata',
        contextAfter: 'Dopo',
        contextBefore: 'Prima',
        instructions: 'Approfondisci',
        selectedText: 'orologio globale',
      },
      parentSectionId: 'lesson-1',
      projectId: 'project-1',
      requestKey: 'request-sublesson-1',
      userId: 'local-user',
    });
  });

  test('rejects malformed input before it reaches the workflow API', async () => {
    const api = createApi();
    const response = await request(createApp({ lessonGenerationApi: api }))
      .post('/api/lesson-workflows/lessons')
      .send({ projectId: 'project-1', requestKey: '  ', sectionId: 'lesson-1', unknown: true });

    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      code: 'lesson_generation_request_invalid',
      error: 'Richiesta di generazione non valida.',
      success: false,
    });
    expect(api.start).not.toHaveBeenCalled();
  });

  test('maps a missing target and an unavailable runtime to stable public errors', async () => {
    const missingApi = createApi();
    vi.mocked(missingApi.start).mockRejectedValue(new LessonGenerationTargetNotFoundError());

    const missing = await request(createApp({ lessonGenerationApi: missingApi }))
      .post('/api/lesson-workflows/lessons')
      .send({ projectId: 'project-1', requestKey: 'request-1', sectionId: 'missing' });
    const unavailable = await request(createApp())
      .post('/api/lesson-workflows/lessons')
      .send({ projectId: 'project-1', requestKey: 'request-1', sectionId: 'lesson-1' });

    expect(missing.status).toBe(404);
    expect(missing.body).toEqual({
      code: 'lesson_generation_not_found',
      error: 'Lezione non trovata.',
      success: false,
    });
    expect(unavailable.status).toBe(503);
    expect(unavailable.body).toEqual({
      code: 'workflow_runtime_unavailable',
      error: 'Servizio workflow non disponibile.',
      success: false,
    });
  });

  test('maps lesson and sublesson request-key conflicts to one safe public response', async () => {
    const api = createApi();
    vi.mocked(api.start).mockRejectedValue(new WorkflowRunRequestConflictError());
    vi.mocked(api.startSublesson).mockRejectedValue(new WorkflowRunRequestConflictError());

    const lesson = await request(createApp({ lessonGenerationApi: api }))
      .post('/api/lesson-workflows/lessons')
      .send({ projectId: 'project-1', requestKey: 'request-1', sectionId: 'lesson-1' });
    const sublesson = await request(createApp({ lessonGenerationApi: api }))
      .post('/api/lesson-workflows/sublessons')
      .send({
        instructions: 'Approfondisci',
        parentSectionId: 'lesson-1',
        projectId: 'project-1',
        requestKey: 'request-sublesson-1',
        selectedText: 'orologio globale',
      });
    const expected = {
      code: 'workflow_run_request_conflict',
      error: 'Questa richiesta è già stata usata per un’altra operazione.',
      success: false,
    };

    expect(lesson.status).toBe(409);
    expect(sublesson.status).toBe(409);
    expect(lesson.body).toEqual(expected);
    expect(sublesson.body).toEqual(expected);
    expect(JSON.stringify([lesson.body, sublesson.body])).not.toContain('different request');
  });

  test('polls one short durable snapshot without exposing internal workflow state', async () => {
    const api = createApi();
    vi.mocked(api.get).mockResolvedValue({
      ...job,
      errorCode: 'provider_failed',
      status: 'failed',
    });

    const response = await request(createApp({ lessonGenerationApi: api })).get(
      '/api/lesson-workflows/runs/run-1'
    );

    expect(response.status).toBe(200);
    expect(response.headers['cache-control']).toBe('private, no-store');
    expect(api.get).toHaveBeenCalledWith({ runId: 'run-1', userId: 'local-user' });
    expect(response.body).toEqual({
      job: { ...job, errorCode: 'provider_failed', status: 'failed' },
      success: true,
    });
    expect(JSON.stringify(response.body)).not.toContain('nodes');
    expect(JSON.stringify(response.body)).not.toContain('details');
  });

  test('resolves a durable snapshot through its original request key', async () => {
    const api = createApi();
    vi.mocked(api.getByRequestKey).mockResolvedValue({ ...job, status: 'failed' });

    const response = await request(createApp({ lessonGenerationApi: api }))
      .post('/api/lesson-workflows/requests/resolve')
      .send({ requestKey: 'request-sublesson-1' });

    expect(response.status).toBe(200);
    expect(response.headers['cache-control']).toBe('private, no-store');
    expect(api.getByRequestKey).toHaveBeenCalledWith({
      requestKey: 'request-sublesson-1',
      userId: 'local-user',
    });
    expect(response.body).toEqual({ job: { ...job, status: 'failed' }, success: true });
  });

  test('returns not found for an unknown run', async () => {
    const api = createApi();
    vi.mocked(api.get).mockResolvedValue(null);

    const response = await request(createApp({ lessonGenerationApi: api })).get(
      '/api/lesson-workflows/runs/missing'
    );

    expect(response.status).toBe(404);
    expect(response.body).toEqual({
      code: 'lesson_generation_run_not_found',
      error: 'Generazione non trovata.',
      success: false,
    });
  });
});
