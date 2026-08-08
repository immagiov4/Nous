import request from 'supertest';
import { describe, expect, test, vi } from 'vitest';

import { createApp } from '../../src/index.js';
import {
  type ArtifactDraftApi,
  ArtifactDraftTargetNotFoundError,
} from '../../src/workflows/artifactDraftApi.js';
import { WorkflowRunRequestConflictError } from '../../src/workflows/workflowErrors.js';

const job = {
  createdAt: '2026-07-30T10:00:00.000Z',
  id: 'run-1',
  projectId: 'project-1',
  retrying: false,
  sectionId: 'lesson-1',
  stage: 'planning',
  status: 'queued',
  updatedAt: '2026-07-30T10:00:00.000Z',
} as const;

const createApi = (): ArtifactDraftApi => ({
  get: vi.fn().mockResolvedValue(job),
  start: vi.fn().mockResolvedValue({ created: true, job }),
});

describe('artifact draft routes', () => {
  test('starts a durable draft with the authenticated provider configuration', async () => {
    const api = createApi();
    const response = await request(createApp({ artifactDraftApi: api }))
      .post('/api/artifact-drafts')
      .send({
        generationNotes: 'Usa esempi concreti.',
        lessonMarkdown: '## Intreccio\n\nTrama e ordito si incrociano.',
        projectId: 'project-1',
        requestText: 'Mostra l intreccio.',
        requestedVisualKind: 'image',
        requestKey: 'request-1',
        sectionDescription: 'Riconoscere trama e ordito.',
        sectionId: 'lesson-1',
        sectionTitle: 'Intreccio',
      });

    expect(response.status).toBe(202);
    expect(api.start).toHaveBeenCalledWith({
      aiProvider: undefined,
      aiProviderOverrides: undefined,
      generationNotes: 'Usa esempi concreti.',
      lessonMarkdown: '## Intreccio\n\nTrama e ordito si incrociano.',
      projectId: 'project-1',
      requestText: 'Mostra l intreccio.',
      requestedVisualKind: 'image',
      requestKey: 'request-1',
      sectionDescription: 'Riconoscere trama e ordito.',
      sectionId: 'lesson-1',
      sectionTitle: 'Intreccio',
      userId: 'local-user',
    });
    expect(response.body).toEqual({ created: true, job, success: true });
  });

  test('rejects malformed input before starting a workflow', async () => {
    const api = createApi();
    const response = await request(createApp({ artifactDraftApi: api }))
      .post('/api/artifact-drafts')
      .send({ projectId: 'project-1', requestKey: 'request-1', sectionId: 'lesson-1' });

    expect(response.status).toBe(400);
    expect(api.start).not.toHaveBeenCalled();
    expect(response.body).toMatchObject({
      code: 'artifact_draft_request_invalid',
      success: false,
    });
  });

  test('maps a missing lesson and an unavailable runtime to stable public errors', async () => {
    const api = createApi();
    vi.mocked(api.start).mockRejectedValue(new ArtifactDraftTargetNotFoundError());
    const body = {
      lessonMarkdown: '## Intreccio\n\nTesto.',
      projectId: 'project-1',
      requestText: 'Mostra l intreccio.',
      requestKey: 'request-1',
      sectionDescription: 'Descrizione',
      sectionId: 'missing',
      sectionTitle: 'Intreccio',
    };

    const missing = await request(createApp({ artifactDraftApi: api }))
      .post('/api/artifact-drafts')
      .send(body);
    const unavailable = await request(createApp()).post('/api/artifact-drafts').send(body);

    expect(missing.status).toBe(404);
    expect(missing.body).toMatchObject({ code: 'artifact_draft_target_not_found' });
    expect(unavailable.status).toBe(503);
    expect(unavailable.body).toMatchObject({ code: 'workflow_runtime_unavailable' });
  });

  test('maps a request-key conflict to the safe shared public response', async () => {
    const api = createApi();
    vi.mocked(api.start).mockRejectedValue(new WorkflowRunRequestConflictError());

    const response = await request(createApp({ artifactDraftApi: api }))
      .post('/api/artifact-drafts')
      .send({
        lessonMarkdown: '## Intreccio\n\nTesto.',
        projectId: 'project-1',
        requestText: 'Mostra l intreccio.',
        requestKey: 'request-1',
        sectionDescription: 'Descrizione',
        sectionId: 'lesson-1',
        sectionTitle: 'Intreccio',
      });

    expect(response.status).toBe(409);
    expect(response.body).toEqual({
      code: 'workflow_run_request_conflict',
      error: 'Questa richiesta è già stata usata per un’altra operazione.',
      success: false,
    });
    expect(JSON.stringify(response.body)).not.toContain('different request');
  });

  test('returns a short typed polling snapshot', async () => {
    const api = createApi();
    const response = await request(createApp({ artifactDraftApi: api })).get(
      '/api/artifact-drafts/runs/run-1'
    );

    expect(response.status).toBe(200);
    expect(response.headers['cache-control']).toBe('private, no-store');
    expect(api.get).toHaveBeenCalledWith({ runId: 'run-1', userId: 'local-user' });
    expect(response.body).toEqual({ job, success: true });
    expect(JSON.stringify(response.body)).not.toContain('nodes');
  });
});
