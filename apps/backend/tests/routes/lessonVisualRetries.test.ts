import request from 'supertest';
import { describe, expect, test, vi } from 'vitest';

import { createApp } from '../../src/index.js';
import {
  type LessonVisualRetryStarter,
  LessonVisualRetryTargetError,
} from '../../src/workflows/lessonVisualRetryStart.js';
import type { WorkflowRun } from '../../src/workflows/types.js';
import { WorkflowRunRequestConflictError } from '../../src/workflows/workflowErrors.js';

const RUN_ID = '9de19290-0dab-470d-a554-9a214073283e';

const run: WorkflowRun = {
  cancellationRequested: false,
  cleanupStatus: 'not-required',
  createdAt: '2026-07-29T10:00:00.000Z',
  definitionHash: 'hash',
  definitionHashVersion: 1,
  id: RUN_ID,
  input: { privateLesson: 'never expose' },
  projectId: 'project-1',
  requestKey: 'retry-click-1',
  resolvedConfig: { privateModel: 'never expose' },
  status: 'queued',
  stepPolicies: {},
  stepPoliciesVersion: 1,
  updatedAt: '2026-07-29T10:00:00.000Z',
  userId: 'local-user',
  workflowId: 'retry-lesson-visual',
};

const createStarter = (): LessonVisualRetryStarter => ({
  start: vi.fn().mockResolvedValue({ created: true, run }),
});

describe('POST /api/projects/:projectId/sections/:sectionId/visuals/:slotId/retry', () => {
  test('starts an owner-scoped retry and returns only its public identity', async () => {
    const starter = createStarter();
    const response = await request(createApp({ lessonVisualRetryStarter: starter }))
      .post('/api/projects/project-1/sections/section-1/visuals/slot-1/retry')
      .send({ requestKey: 'retry-click-1' });

    expect(response.status).toBe(202);
    expect(starter.start).toHaveBeenCalledWith({
      aiProvider: undefined,
      aiProviderOverrides: undefined,
      projectId: 'project-1',
      requestKey: 'retry-click-1',
      sectionId: 'section-1',
      slotId: 'slot-1',
      userId: 'local-user',
    });
    expect(response.body).toEqual({
      created: true,
      run: {
        createdAt: run.createdAt,
        id: RUN_ID,
        status: 'queued',
        updatedAt: run.updatedAt,
      },
      success: true,
    });
    expect(JSON.stringify(response.body)).not.toContain('private');
  });

  test('returns the active deduplicated run without creating another one', async () => {
    const starter = createStarter();
    vi.mocked(starter.start).mockResolvedValue({ created: false, run });

    const response = await request(createApp({ lessonVisualRetryStarter: starter }))
      .post('/api/projects/project-1/sections/section-1/visuals/slot-1/retry')
      .send({ requestKey: 'retry-click-2' });

    expect(response.status).toBe(200);
    expect(response.body.created).toBe(false);
    expect(response.body.run.id).toBe(RUN_ID);
  });

  test('rejects malformed requests before calling the starter', async () => {
    const starter = createStarter();
    const response = await request(createApp({ lessonVisualRetryStarter: starter }))
      .post('/api/projects/project-1/sections/section-1/visuals/slot-1/retry')
      .send({ requestKey: '   ', extra: true });

    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      code: 'lesson_visual_retry_request_invalid',
      error: 'Richiesta di rigenerazione non valida.',
      success: false,
    });
    expect(starter.start).not.toHaveBeenCalled();
  });

  test('does not reveal whether the project, section, or slot was missing', async () => {
    const starter = createStarter();
    vi.mocked(starter.start).mockRejectedValue(new LessonVisualRetryTargetError());

    const response = await request(createApp({ lessonVisualRetryStarter: starter }))
      .post('/api/projects/project-1/sections/section-1/visuals/slot-1/retry')
      .send({ requestKey: 'retry-click-1' });

    expect(response.status).toBe(404);
    expect(response.body).toEqual({
      code: 'lesson_visual_retry_not_found',
      error: 'Esempio visivo da rigenerare non trovato.',
      success: false,
    });
  });

  test('reports an uncomposed runtime as unavailable', async () => {
    const response = await request(createApp())
      .post('/api/projects/project-1/sections/section-1/visuals/slot-1/retry')
      .send({ requestKey: 'retry-click-1' });

    expect(response.status).toBe(503);
    expect(response.body).toEqual({
      code: 'workflow_runtime_unavailable',
      error: 'Servizio workflow non disponibile.',
      success: false,
    });
  });

  test('maps a reused request key to a stable conflict', async () => {
    const starter = createStarter();
    vi.mocked(starter.start).mockRejectedValue(new WorkflowRunRequestConflictError());

    const response = await request(createApp({ lessonVisualRetryStarter: starter }))
      .post('/api/projects/project-1/sections/section-1/visuals/slot-1/retry')
      .send({ requestKey: 'retry-click-1' });

    expect(response.status).toBe(409);
    expect(response.body).toEqual({
      code: 'workflow_run_request_conflict',
      error: 'Questa richiesta è già stata usata per un’altra operazione.',
      success: false,
    });
  });
});
