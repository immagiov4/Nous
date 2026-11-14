import { describe, expect, test, vi } from 'vitest';

import type { ProjectSnapshot } from '../../src/projects/types.js';
import {
  CourseGenerationTargetNotFoundError,
  createCourseGenerationApi,
} from '../../src/workflows/courseGenerationApi.js';

const CORRELATION_ID = '123e4567-e89b-42d3-a456-426614174000';

const project: ProjectSnapshot = {
  createdAt: '2026-07-30T08:00:00.000Z',
  id: 'project-1',
  lastOpenedAt: '2026-07-30T08:00:00.000Z',
  updatedAt: '2026-07-30T08:00:00.000Z',
  version: '4.1',
};

const run = (overrides: Record<string, unknown> = {}) =>
  ({
    cancellationRequested: false,
    cleanupStatus: 'not-required',
    correlationId: CORRELATION_ID,
    createdAt: '2026-07-30T08:00:00.000Z',
    definitionHash: 'hash',
    definitionHashVersion: 1,
    id: 'run-1',
    projectId: 'project-1',
    input: {
      assessmentHistory: [{ role: 'user', text: 'Spiegami i sistemi distribuiti.' }],
      mode: 'learn',
      projectId: 'project-1',
      userId: 'user-1',
    },
    requestKey: 'request-1',
    resolvedConfig: {},
    status: 'running',
    stepPolicies: {},
    stepPoliciesVersion: 1,
    updatedAt: '2026-07-30T08:00:00.000Z',
    userId: 'user-1',
    workflowId: 'course-generation',
    ...overrides,
  }) as never;

const state = (
  nodes: Array<Record<string, unknown>>,
  status = 'running',
  runOverrides: Record<string, unknown> = {}
) =>
  ({
    events: [],
    nodes: nodes.map((node, index) => ({
      attemptCount: 1,
      availableAt: '2026-07-30T08:00:00.000Z',
      createdAt: `2026-07-30T08:00:0${index}.000Z`,
      definitionId: 'prepare-course',
      instanceId: `root/${index}`,
      kind: 'step',
      maxAttempts: 3,
      status: 'completed',
      updatedAt: '2026-07-30T08:00:00.000Z',
      ...node,
    })),
    run: {
      cancellationRequested: false,
      cleanupStatus: 'not-required',
      createdAt: '2026-07-30T08:00:00.000Z',
      definitionHash: 'hash',
      definitionHashVersion: 1,
      id: 'run-1',
      requestKey: 'request-1',
      status,
      updatedAt: '2026-07-30T08:00:00.000Z',
      workflowId: 'course-generation',
      ...runOverrides,
    },
    waits: [],
  }) as never;

const dependencies = (overrides: Record<string, unknown> = {}) => ({
  projectReader: { loadProject: vi.fn().mockResolvedValue(project) },
  runReader: {
    getActiveRun: vi.fn().mockResolvedValue(null),
    getRun: vi.fn().mockResolvedValue(run()),
    getRunState: vi
      .fn()
      .mockResolvedValue(state([{ definitionId: 'draft-course-plan', status: 'running' }])),
  },
  starter: {
    start: vi.fn().mockResolvedValue({ created: true, run: run({ status: 'queued' }) }),
  },
  ...overrides,
});

const startRequest = {
  assessmentHistory: [{ role: 'user' as const, text: 'Spiegami i sistemi distribuiti.' }],
  mode: 'learn' as const,
  projectId: 'project-1',
  requestKey: 'request-1',
  userId: 'user-1',
};

describe('course generation workflow API', () => {
  test.each([
    'pending',
    'running',
    'failed',
  ])('blocks retry while previous undo is %s, then allows it after cleanup', async cleanupStatus => {
    const input = dependencies();
    input.runReader.getRun.mockResolvedValue(run({ status: 'failed', cleanupStatus }));
    const api = createCourseGenerationApi(input);
    const request = {
      runId: 'run-1',
      projectId: 'project-1',
      requestKey: 'click',
      userId: 'user-1',
    };
    await expect(api.retry(request)).rejects.toMatchObject({
      name: 'CourseGenerationCleanupIncompleteError',
    });
    expect(input.starter.start).not.toHaveBeenCalled();
    input.runReader.getRun.mockResolvedValue(run({ status: 'failed', cleanupStatus: 'completed' }));
    await expect(api.retry(request)).resolves.toMatchObject({
      created: true,
      job: { status: 'queued' },
    });
    expect(input.starter.start).toHaveBeenCalledTimes(1);
  });
  test.each([
    'queued',
    'running',
    'completed',
    'cancelled',
    'expired',
  ])('does not replace a %s run', async status => {
    const input = dependencies();
    input.runReader.getRun.mockResolvedValue(run({ status }));
    await createCourseGenerationApi(input).retry({
      runId: 'run-1',
      projectId: 'project-1',
      requestKey: 'click',
      userId: 'user-1',
    });
    expect(input.starter.start).not.toHaveBeenCalled();
  });

  test.each([
    null,
    run({ workflowId: 'course-interview' }),
    run({ projectId: 'other-project' }),
  ])('rejects an unavailable or mismatched retry target', async target => {
    const input = dependencies();
    input.runReader.getRun.mockResolvedValue(target);
    await expect(
      createCourseGenerationApi(input).retry({
        runId: 'run-1',
        projectId: 'project-1',
        requestKey: 'click',
        userId: 'user-1',
      })
    ).rejects.toBeInstanceOf(CourseGenerationTargetNotFoundError);
    expect(input.starter.start).not.toHaveBeenCalled();
  });
  test('retries a failed run with saved inputs and a request identity linked to that run', async () => {
    const input = dependencies();
    const diagnosticRef = {
      userId: 'user-1',
      projectId: 'project-1',
      incarnationId: 'incarnation-1',
      revisionId: 'revision-1',
      diagnosticId: 'diagnostic-1',
    };
    input.runReader.getRun.mockResolvedValue(
      run({ status: 'failed', input: { ...startRequest, diagnosticRef } })
    );
    const result = await createCourseGenerationApi(input).retry({
      runId: 'run-1',
      projectId: 'project-1',
      requestKey: 'retry-click',
      userId: 'user-1',
    });
    expect(result.job.status).toBe('queued');
    expect(input.starter.start).toHaveBeenCalledWith({
      ...startRequest,
      diagnosticRef,
      requestKey: JSON.stringify(['course-generation-retry', 'run-1', 'retry-click']),
    });
  });
  test('starts one validated course and forwards the authenticated provider selection', async () => {
    const input = dependencies();
    const api = createCourseGenerationApi(input);

    const result = await api.start({
      ...startRequest,
      aiProvider: 'codex',
      aiProviderOverrides: { course: 'codex' },
    });

    expect(input.starter.start).toHaveBeenCalledWith({
      ...startRequest,
      aiProvider: 'codex',
      aiProviderOverrides: { course: 'codex' },
    });
    expect(result).toMatchObject({
      created: true,
      job: {
        correlationId: CORRELATION_ID,
        id: 'run-1',
        mode: 'learn',
        projectId: 'project-1',
        status: 'queued',
      },
    });
  });

  test('returns the authoritative state of a deduplicated course run', async () => {
    const currentRun = run({ status: 'running' });
    const input = dependencies({
      runReader: {
        getRun: vi.fn().mockResolvedValue(currentRun),
        getRunState: vi
          .fn()
          .mockResolvedValue(state([{ definitionId: 'refine-course-plan', status: 'running' }])),
      },
      starter: { start: vi.fn().mockResolvedValue({ created: false, run: currentRun }) },
    });

    const result = await createCourseGenerationApi(input).start(startRequest);

    expect(input.runReader.getRunState).toHaveBeenCalledWith({
      runId: 'run-1',
      userId: 'user-1',
    });
    expect(result).toMatchObject({
      created: false,
      job: { stage: 'drafting', status: 'running' },
    });
  });

  test('maps durable nodes to the established structured progress stages', async () => {
    const stages = [
      ['prepare-course', 'sources'],
      ['draft-course-plan', 'structure'],
      ['plan-source-set-course', 'structure'],
      ['verify-course-plan', 'drafting'],
      ['refine-archive-course', 'drafting'],
      ['place-application-exercises', 'quiz'],
      ['persist-course', 'verification'],
    ] as const;

    for (const [definitionId, expectedStage] of stages) {
      const api = createCourseGenerationApi(
        dependencies({
          runReader: {
            getRun: vi.fn().mockResolvedValue(run()),
            getRunState: vi.fn().mockResolvedValue(state([{ definitionId, status: 'running' }])),
          },
        })
      );
      await expect(api.get({ runId: 'run-1', userId: 'user-1' })).resolves.toMatchObject({
        stage: expectedStage,
      });
    }
  });

  test.each([
    'plan-course-research-sources',
    'research-course-web',
    'plan-course-youtube-queries',
    'research-course-youtube-query',
    'finalize-course-youtube-research',
    'finalize-selected-course-research',
  ])('reports running and retrying research progress for %s', async definitionId => {
    for (const status of ['running', 'retrying'] as const) {
      const api = createCourseGenerationApi(
        dependencies({
          runReader: {
            getRun: vi.fn().mockResolvedValue(run()),
            getRunState: vi.fn().mockResolvedValue(
              state([
                { definitionId: 'prepare-course', status: 'completed', attemptCount: 1 },
                { definitionId, status, attemptCount: 2 },
              ])
            ),
          },
        })
      );
      await expect(api.get({ runId: 'run-1', userId: 'user-1' })).resolves.toMatchObject({
        stage: 'sources',
        attempt: 2,
        retrying: status === 'retrying',
      });
    }
  });

  test('preserves retry timing and returns ready only after durable completion', async () => {
    const retryApi = createCourseGenerationApi(
      dependencies({
        runReader: {
          getRun: vi.fn().mockResolvedValue(run()),
          getRunState: vi.fn().mockResolvedValue(
            state(
              [
                {
                  attemptCount: 2,
                  definitionId: 'gather-course-research',
                  status: 'retrying',
                },
              ],
              'running',
              {
                startedAt: '2026-07-30T08:01:00.000Z',
                updatedAt: '2026-07-30T08:04:00.000Z',
              }
            )
          ),
        },
      })
    );
    const output = {
      firstSectionId: 'lesson-1',
      projectId: 'project-1',
      projectRevision: 4,
    };
    const completedApi = createCourseGenerationApi(
      dependencies({
        runReader: {
          getRun: vi.fn().mockResolvedValue(run({ output, status: 'completed' })),
          getRunState: vi.fn().mockResolvedValue(state([], 'completed')),
        },
      })
    );

    await expect(retryApi.get({ runId: 'run-1', userId: 'user-1' })).resolves.toMatchObject({
      attempt: 2,
      retrying: true,
      stage: 'sources',
      startedAt: '2026-07-30T08:01:00.000Z',
      updatedAt: '2026-07-30T08:04:00.000Z',
    });
    await expect(completedApi.get({ runId: 'run-1', userId: 'user-1' })).resolves.toMatchObject({
      result: output,
      stage: 'ready',
      status: 'completed',
    });
  });

  test('exposes only a stable failure code', async () => {
    const failure = {
      code: 'course_provider_failed',
      details: { privateTrace: 'secret' },
      kind: 'operational',
      message: 'Private provider error',
    };
    const api = createCourseGenerationApi(
      dependencies({
        runReader: {
          getRun: vi.fn().mockResolvedValue(run({ error: failure, status: 'failed' })),
          getRunState: vi.fn().mockResolvedValue(state([], 'failed', { error: failure })),
        },
      })
    );

    const snapshot = await api.get({ runId: 'run-1', userId: 'user-1' });

    expect(snapshot).toMatchObject({
      correlationId: CORRELATION_ID,
      errorCode: 'course_provider_failed',
      status: 'failed',
    });
    expect(JSON.stringify(snapshot)).not.toContain('privateTrace');
    expect(JSON.stringify(snapshot)).not.toContain('Private provider error');
  });

  test('fails before scheduling when the project is missing', async () => {
    const input = dependencies({
      projectReader: { loadProject: vi.fn().mockResolvedValue(null) },
    });

    await expect(createCourseGenerationApi(input).start(startRequest)).rejects.toBeInstanceOf(
      CourseGenerationTargetNotFoundError
    );
    expect(input.starter.start).not.toHaveBeenCalled();
  });

  test('finds the active course run for reconnecting a planning project', async () => {
    const activeRun = run();
    const input = dependencies({
      runReader: {
        getActiveRun: vi.fn().mockResolvedValue(activeRun),
        getRun: vi.fn().mockResolvedValue(activeRun),
        getRunState: vi
          .fn()
          .mockResolvedValue(state([{ definitionId: 'draft-course-plan', status: 'running' }])),
      },
    });

    const result = await createCourseGenerationApi(input).getActive({
      projectId: 'project-1',
      userId: 'user-1',
    });

    expect(input.runReader.getActiveRun).toHaveBeenCalledWith({
      projectId: 'project-1',
      userId: 'user-1',
      workflowId: 'course-generation',
    });
    expect(result).toMatchObject({ id: 'run-1', stage: 'structure', status: 'running' });
  });
});
