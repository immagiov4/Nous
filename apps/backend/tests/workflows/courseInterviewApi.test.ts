import { describe, expect, test, vi } from 'vitest';

import {
  CourseInterviewTargetNotFoundError,
  createCourseInterviewApi,
  projectCourseInterviewEvents,
} from '../../src/workflows/courseInterviewApi.js';

const run = {
  cancellationRequested: false,
  cleanupStatus: 'not-required' as const,
  createdAt: '2026-08-08T10:00:00.000Z',
  definitionHash: 'hash',
  definitionHashVersion: 1,
  id: 'run-1',
  input: {
    hasReliableSourceContext: false,
    mode: 'learn',
    projectId: 'project-1',
    userId: 'user-1',
  },
  projectId: 'project-1',
  requestKey: 'request-1',
  resolvedConfig: {},
  status: 'waiting' as const,
  stepPolicies: {},
  stepPoliciesVersion: 1,
  updatedAt: '2026-08-08T10:01:00.000Z',
  userId: 'user-1',
  workflowId: 'course-interview',
};

const createInput = () => ({
  projectReader: {
    loadProject: vi
      .fn()
      .mockResolvedValue({ id: 'project-1', learningPlan: null, state: 'ASSESSMENT' }),
  },
  runReader: { getActiveRun: vi.fn().mockResolvedValue(run) },
  starter: { start: vi.fn().mockResolvedValue({ created: true, run }) },
});

describe('course interview API', () => {
  test('starts only for an owned project and maps one public run envelope', async () => {
    const input = createInput();
    const api = createCourseInterviewApi(input);
    const result = await api.start({
      hasReliableSourceContext: false,
      mode: 'learn',
      projectId: 'project-1',
      requestKey: 'request-1',
      userId: 'user-1',
    });

    expect(result).toEqual({
      created: true,
      run: {
        createdAt: run.createdAt,
        id: 'run-1',
        projectId: 'project-1',
        status: 'waiting',
        updatedAt: run.updatedAt,
      },
    });
  });

  test('rejects a missing project before workflow creation', async () => {
    const input = createInput();
    input.projectReader.loadProject.mockResolvedValue(null);
    const api = createCourseInterviewApi(input);

    await expect(
      api.start({
        hasReliableSourceContext: false,
        mode: 'learn',
        projectId: 'missing',
        requestKey: 'request-1',
        userId: 'user-1',
      })
    ).rejects.toBeInstanceOf(CourseInterviewTargetNotFoundError);
    expect(input.starter.start).not.toHaveBeenCalled();
  });

  test('rejects an existing course instead of adopting it as an interview draft', async () => {
    const input = createInput();
    input.projectReader.loadProject.mockResolvedValue({
      id: 'project-1',
      learningPlan: { title: 'Corso esistente' },
      state: 'READING',
    });
    const api = createCourseInterviewApi(input);

    await expect(
      api.start({
        hasReliableSourceContext: false,
        mode: 'learn',
        projectId: 'project-1',
        requestKey: 'request-1',
        userId: 'user-1',
      })
    ).rejects.toBeInstanceOf(CourseInterviewTargetNotFoundError);
    expect(input.starter.start).not.toHaveBeenCalled();
  });

  test('finds only the active interview for the owned project', async () => {
    const input = createInput();
    const api = createCourseInterviewApi(input);

    expect(await api.getActive({ projectId: 'project-1', userId: 'user-1' })).toEqual(
      expect.objectContaining({ id: 'run-1', projectId: 'project-1' })
    );
    expect(input.runReader.getActiveRun).toHaveBeenCalledWith({
      projectId: 'project-1',
      userId: 'user-1',
      workflowId: 'course-interview',
    });
  });

  test('publishes only validated interview events', () => {
    const events = projectCourseInterviewEvents({
      events: [
        {
          createdAt: '2026-08-08T10:00:00.000Z',
          eventType: 'course-interview-message',
          payload: { message: { role: 'model', text: 'Domanda?' } },
          schemaVersion: 1,
          sequence: '1',
        },
        {
          createdAt: '2026-08-08T10:00:01.000Z',
          eventType: 'internal-event',
          payload: { secret: true },
          schemaVersion: 1,
          sequence: '2',
        },
      ],
    } as never);

    expect(events).toEqual([
      expect.objectContaining({ eventType: 'course-interview-message', sequence: '1' }),
    ]);
  });
});
