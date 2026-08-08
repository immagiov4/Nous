import request from 'supertest';
import { describe, expect, test, vi } from 'vitest';

import { createApp } from '../../src/index.js';
import {
  type CourseGenerationApi,
  CourseGenerationTargetNotFoundError,
} from '../../src/workflows/courseGenerationApi.js';
import type { PdfMappingRepairApi } from '../../src/workflows/pdfMappingRepairApi.js';
import { WorkflowRunRequestConflictError } from '../../src/workflows/workflowErrors.js';

const job = {
  createdAt: '2026-07-30T08:00:00.000Z',
  id: 'run-1',
  mode: 'learn',
  projectId: 'project-1',
  retrying: false,
  stage: 'sources',
  status: 'queued',
  updatedAt: '2026-07-30T08:00:00.000Z',
} as const;

const createApi = (): CourseGenerationApi => ({
  get: vi.fn().mockResolvedValue(job),
  getActive: vi.fn().mockResolvedValue(job),
  start: vi.fn().mockResolvedValue({ created: true, job }),
});

const repairJob = {
  createdAt: '2026-08-01T08:00:00.000Z',
  id: 'repair-run-1',
  projectId: 'project-1',
  stage: 'preparing',
  status: 'queued',
  updatedAt: '2026-08-01T08:00:00.000Z',
} as const;

const createRepairApi = (): PdfMappingRepairApi => ({
  get: vi.fn().mockResolvedValue(repairJob),
  start: vi.fn().mockResolvedValue({ created: true, job: repairJob }),
});

const requestBody = {
  assessmentHistory: [{ role: 'user', text: 'Spiegami i sistemi distribuiti.' }],
  mode: 'learn',
  projectId: 'project-1',
  requestKey: 'request-1',
};

describe('course workflow routes', () => {
  test('starts a durable course with the authenticated provider configuration', async () => {
    const api = createApi();
    const response = await request(createApp({ courseGenerationApi: api }))
      .post('/api/course-workflows/courses')
      .send(requestBody);

    expect(response.status).toBe(202);
    expect(api.start).toHaveBeenCalledWith({
      ...requestBody,
      aiProvider: undefined,
      aiProviderOverrides: undefined,
      userId: 'local-user',
    });
    expect(response.body).toEqual({ created: true, job, success: true });
  });

  test('starts a durable PDF mapping repair without accepting project data from the client', async () => {
    const pdfMappingRepairApi = createRepairApi();
    const body = { projectId: 'project-1', requestKey: 'repair-request-1' };

    const response = await request(createApp({ pdfMappingRepairApi }))
      .post('/api/course-workflows/pdf-mapping-repairs')
      .send(body);

    expect(response.status).toBe(202);
    expect(pdfMappingRepairApi.start).toHaveBeenCalledWith({
      ...body,
      aiProvider: undefined,
      aiProviderOverrides: undefined,
      userId: 'local-user',
    });
    expect(response.body).toEqual({ created: true, job: repairJob, success: true });
  });

  test('returns the current project revision when PDF mappings do not need repair', async () => {
    const pdfMappingRepairApi = createRepairApi();
    const result = { projectId: 'project-1', projectRevision: 6, repaired: false } as const;
    vi.mocked(pdfMappingRepairApi.start).mockResolvedValue({ result });

    const response = await request(createApp({ pdfMappingRepairApi }))
      .post('/api/course-workflows/pdf-mapping-repairs')
      .send({ projectId: 'project-1', requestKey: 'repair-request-ready' });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ result, success: true });
  });

  test('rejects malformed input before it reaches the workflow API', async () => {
    const api = createApi();
    const response = await request(createApp({ courseGenerationApi: api }))
      .post('/api/course-workflows/courses')
      .send({ ...requestBody, assessmentHistory: [{ role: 'assistant', text: 'no' }] });

    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      code: 'course_generation_request_invalid',
      error: 'Richiesta di generazione non valida.',
      success: false,
    });
    expect(api.start).not.toHaveBeenCalled();
  });

  test('maps a missing project and unavailable runtime to stable public errors', async () => {
    const missingApi = createApi();
    vi.mocked(missingApi.start).mockRejectedValue(new CourseGenerationTargetNotFoundError());

    const missing = await request(createApp({ courseGenerationApi: missingApi }))
      .post('/api/course-workflows/courses')
      .send(requestBody);
    const unavailable = await request(createApp())
      .post('/api/course-workflows/courses')
      .send(requestBody);

    expect(missing.status).toBe(404);
    expect(missing.body).toEqual({
      code: 'course_generation_not_found',
      error: 'Corso non trovato.',
      success: false,
    });
    expect(unavailable.status).toBe(503);
    expect(unavailable.body).toEqual({
      code: 'workflow_runtime_unavailable',
      error: 'Servizio workflow non disponibile.',
      success: false,
    });
  });

  test('maps course and PDF repair request-key conflicts to one safe public response', async () => {
    const api = createApi();
    const pdfMappingRepairApi = createRepairApi();
    vi.mocked(api.start).mockRejectedValue(new WorkflowRunRequestConflictError());
    vi.mocked(pdfMappingRepairApi.start).mockRejectedValue(new WorkflowRunRequestConflictError());

    const course = await request(createApp({ courseGenerationApi: api }))
      .post('/api/course-workflows/courses')
      .send(requestBody);
    const repair = await request(createApp({ pdfMappingRepairApi }))
      .post('/api/course-workflows/pdf-mapping-repairs')
      .send({ projectId: 'project-1', requestKey: 'repair-request-1' });
    const expected = {
      code: 'workflow_run_request_conflict',
      error: 'Questa richiesta è già stata usata per un’altra operazione.',
      success: false,
    };

    expect(course.status).toBe(409);
    expect(repair.status).toBe(409);
    expect(course.body).toEqual(expected);
    expect(repair.body).toEqual(expected);
    expect(JSON.stringify([course.body, repair.body])).not.toContain('different request');
  });

  test('polls one short durable snapshot without exposing internal workflow state', async () => {
    const api = createApi();
    vi.mocked(api.get).mockResolvedValue({
      ...job,
      errorCode: 'provider_failed',
      status: 'failed',
    });

    const response = await request(createApp({ courseGenerationApi: api })).get(
      '/api/course-workflows/runs/run-1'
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

  test('returns not found for an unknown run', async () => {
    const api = createApi();
    vi.mocked(api.get).mockResolvedValue(null);

    const response = await request(createApp({ courseGenerationApi: api })).get(
      '/api/course-workflows/runs/missing'
    );

    expect(response.status).toBe(404);
    expect(response.body).toEqual({
      code: 'course_generation_run_not_found',
      error: 'Generazione non trovata.',
      success: false,
    });
  });

  test('finds the active run used to reconnect a planning project', async () => {
    const api = createApi();

    const response = await request(createApp({ courseGenerationApi: api })).get(
      '/api/course-workflows/courses/project-1/active'
    );

    expect(response.status).toBe(200);
    expect(response.headers['cache-control']).toBe('private, no-store');
    expect(api.getActive).toHaveBeenCalledWith({ projectId: 'project-1', userId: 'local-user' });
    expect(response.body).toEqual({ job, success: true });
  });
});
