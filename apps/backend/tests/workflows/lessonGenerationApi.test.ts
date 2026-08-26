import { describe, expect, test, vi } from 'vitest';

import type { ProjectSnapshot } from '../../src/projects/types.js';
import {
  createLessonGenerationApi,
  LessonGenerationTargetNotFoundError,
} from '../../src/workflows/lessonGenerationApi.js';

const project: ProjectSnapshot = {
  createdAt: '2026-07-29T20:00:00.000Z',
  id: 'project-1',
  lastOpenedAt: '2026-07-29T20:00:00.000Z',
  learningPlan: {
    modules: [
      {
        children: [{ id: 'lesson-1', kind: 'lesson', title: 'Lezione' }],
        id: 'module-1',
        title: 'Modulo',
      },
    ],
  },
  updatedAt: '2026-07-29T20:00:00.000Z',
  version: '4.1',
};

const run = (overrides: Record<string, unknown> = {}) =>
  ({
    cancellationRequested: false,
    cleanupStatus: 'not-required',
    correlationId: '123e4567-e89b-12d3-a456-426614174000',
    createdAt: '2026-07-29T20:00:00.000Z',
    definitionHash: 'hash',
    definitionHashVersion: 1,
    id: 'run-1',
    input: {
      forceRegenerate: false,
      projectId: 'project-1',
      sectionId: 'lesson-1',
      userId: 'user-1',
    },
    requestKey: 'request-1',
    resolvedConfig: {},
    status: 'running',
    stepPolicies: {},
    stepPoliciesVersion: 1,
    updatedAt: '2026-07-29T20:00:00.000Z',
    userId: 'user-1',
    workflowId: 'lesson-generation',
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
      availableAt: '2026-07-29T20:00:00.000Z',
      createdAt: `2026-07-29T20:00:0${index}.000Z`,
      definitionId: 'prepare-lesson',
      instanceId: `root/${index}`,
      kind: 'step',
      maxAttempts: 3,
      status: 'completed',
      updatedAt: '2026-07-29T20:00:00.000Z',
      ...node,
    })),
    run: {
      cancellationRequested: false,
      cleanupStatus: 'not-required',
      createdAt: '2026-07-29T20:00:00.000Z',
      definitionHash: 'hash',
      definitionHashVersion: 1,
      id: 'run-1',
      requestKey: 'request-1',
      status,
      updatedAt: '2026-07-29T20:00:00.000Z',
      workflowId: 'lesson-generation',
      ...runOverrides,
    },
    waits: [],
  }) as never;

const dependencies = (overrides: Record<string, unknown> = {}) => ({
  createSectionId: vi.fn(() => 'sublesson-1'),
  projectReader: { loadProject: vi.fn().mockResolvedValue(project) },
  runReader: {
    getRun: vi.fn().mockResolvedValue(run()),
    getRunByRequestKey: vi.fn().mockResolvedValue(run()),
    getRunState: vi
      .fn()
      .mockResolvedValue(state([{ definitionId: 'draft-lesson', status: 'running' }])),
  },
  starter: {
    start: vi.fn().mockResolvedValue({ created: true, run: run({ status: 'queued' }) }),
  },
  ...overrides,
});

describe('lesson generation workflow API', () => {
  test('loads a workflow by its original request key', async () => {
    const input = dependencies();
    const api = createLessonGenerationApi(input);

    const snapshot = await api.getByRequestKey({
      requestKey: 'request-1',
      userId: 'user-1',
    });

    expect(input.runReader.getRunByRequestKey).toHaveBeenCalledWith({
      requestKey: 'request-1',
      userId: 'user-1',
      workflowId: 'lesson-generation',
    });
    expect(snapshot).toMatchObject({ id: 'run-1', projectId: 'project-1' });
  });

  test('refetches a workflow that completes while its request key is being resolved', async () => {
    const result = {
      content: 'Lezione pronta',
      contentBlocks: [{ markdown: 'Lezione pronta', type: 'markdown' }],
      generatedVisuals: [],
      imageRefs: [],
      learningAids: [],
      projectId: 'project-1',
      quiz: [],
      sectionId: 'lesson-1',
      warnings: [],
    };
    const input = dependencies({
      runReader: {
        getRun: vi.fn().mockResolvedValue(run({ output: result, status: 'completed' })),
        getRunByRequestKey: vi.fn().mockResolvedValue(run()),
        getRunState: vi.fn().mockResolvedValue(state([], 'completed')),
      },
    });

    await expect(
      createLessonGenerationApi(input).getByRequestKey({
        requestKey: 'request-1',
        userId: 'user-1',
      })
    ).resolves.toMatchObject({ result, status: 'completed' });
    expect(input.runReader.getRun).toHaveBeenCalledWith({
      runId: 'run-1',
      userId: 'user-1',
    });
  });

  test('starts one validated lesson and forwards the authenticated provider selection', async () => {
    const input = dependencies();
    const api = createLessonGenerationApi(input);

    const result = await api.start({
      aiProvider: 'codex',
      aiProviderOverrides: { lesson: 'codex' },
      forceRegenerate: false,
      projectId: 'project-1',
      requestKey: 'request-1',
      sectionId: 'lesson-1',
      userId: 'user-1',
    });

    expect(input.starter.start).toHaveBeenCalledWith({
      aiProvider: 'codex',
      aiProviderOverrides: { lesson: 'codex' },
      forceRegenerate: false,
      kind: 'existing',
      projectId: 'project-1',
      requestKey: 'request-1',
      sectionId: 'lesson-1',
      userId: 'user-1',
    });
    expect(result).toMatchObject({
      busy: false,
      created: true,
      job: {
        correlationId: '123e4567-e89b-12d3-a456-426614174000',
        id: 'run-1',
        projectId: 'project-1',
        sectionId: 'lesson-1',
        status: 'queued',
      },
    });
  });

  test('reports a different active lesson as busy without starting duplicate work', async () => {
    const activeRun = run({
      input: {
        forceRegenerate: false,
        projectId: 'project-1',
        sectionId: 'lesson-2',
        userId: 'user-1',
      },
    });
    const input = dependencies({
      runReader: {
        getRun: vi.fn().mockResolvedValue(activeRun),
        getRunState: vi
          .fn()
          .mockResolvedValue(state([{ definitionId: 'draft-lesson', status: 'running' }])),
      },
      starter: {
        start: vi.fn().mockResolvedValue({
          created: false,
          run: activeRun,
        }),
      },
    });
    const api = createLessonGenerationApi(input);

    const result = await api.start({
      forceRegenerate: false,
      projectId: 'project-1',
      requestKey: 'request-2',
      sectionId: 'lesson-1',
      userId: 'user-1',
    });

    expect(result).toMatchObject({ busy: true, created: false, job: { sectionId: 'lesson-2' } });
  });

  test('allocates a server-owned sublesson id and validates its parent before scheduling', async () => {
    const input = dependencies();
    const api = createLessonGenerationApi(input);

    const result = await api.startSublesson({
      focus: {
        contextAfter: 'Dopo',
        contextBefore: 'Prima',
        instructions: 'Approfondisci',
        selectedText: 'assenza di orologio globale',
      },
      parentSectionId: 'lesson-1',
      projectId: 'project-1',
      requestKey: 'request-sublesson-1',
      userId: 'user-1',
    });

    expect(input.starter.start).toHaveBeenCalledWith({
      focus: {
        contextAfter: 'Dopo',
        contextBefore: 'Prima',
        instructions: 'Approfondisci',
        selectedText: 'assenza di orologio globale',
      },
      forceRegenerate: false,
      idempotencyInput: {
        focus: {
          contextAfter: 'Dopo',
          contextBefore: 'Prima',
          instructions: 'Approfondisci',
          selectedText: 'assenza di orologio globale',
        },
        kind: 'sublesson',
        parentSectionId: 'lesson-1',
        projectId: 'project-1',
        userId: 'user-1',
      },
      kind: 'sublesson',
      parentSectionId: 'lesson-1',
      projectId: 'project-1',
      requestKey: 'request-sublesson-1',
      sectionId: 'sublesson-1',
      userId: 'user-1',
    });
    expect(result).toMatchObject({
      busy: false,
      created: true,
      job: { stage: 'structure' },
    });

    input.projectReader.loadProject.mockResolvedValueOnce({
      ...project,
      learningPlan: { modules: [] },
    });
    await expect(
      api.startSublesson({
        focus: { instructions: '', selectedText: 'testo' },
        parentSectionId: 'missing',
        projectId: 'project-1',
        requestKey: 'request-sublesson-2',
        userId: 'user-1',
      })
    ).rejects.toBeInstanceOf(LessonGenerationTargetNotFoundError);
  });

  test('keeps sublesson request identity stable across fresh candidate section ids', async () => {
    const originalRun = run({
      input: {
        focus: { instructions: 'Approfondisci', selectedText: 'orologio globale' },
        forceRegenerate: false,
        kind: 'sublesson',
        parentSectionId: 'lesson-1',
        projectId: 'project-1',
        sectionId: 'sublesson-1',
        userId: 'user-1',
      },
      requestKey: 'request-sublesson-1',
      status: 'queued',
    });
    const input = dependencies({
      createSectionId: vi
        .fn()
        .mockReturnValueOnce('sublesson-1')
        .mockReturnValueOnce('sublesson-2'),
      runReader: {
        getRun: vi.fn().mockResolvedValue(originalRun),
        getRunState: vi
          .fn()
          .mockResolvedValue(state([{ definitionId: 'plan-sublesson', status: 'running' }])),
      },
      starter: {
        start: vi
          .fn()
          .mockResolvedValueOnce({ created: true, run: originalRun })
          .mockResolvedValueOnce({ created: false, run: originalRun }),
      },
    });
    const api = createLessonGenerationApi(input);
    const request = {
      focus: { instructions: 'Approfondisci', selectedText: 'orologio globale' },
      parentSectionId: 'lesson-1',
      projectId: 'project-1',
      requestKey: 'request-sublesson-1',
      userId: 'user-1',
    } as const;

    await api.startSublesson(request);
    const replay = await api.startSublesson(request);

    const [firstInput, replayInput] = vi
      .mocked(input.starter.start)
      .mock.calls.map(([startInput]) => startInput);
    expect(firstInput).toMatchObject({ sectionId: 'sublesson-1' });
    expect(replayInput).toMatchObject({ sectionId: 'sublesson-2' });
    expect(firstInput.idempotencyInput).toEqual({
      focus: { instructions: 'Approfondisci', selectedText: 'orologio globale' },
      kind: 'sublesson',
      parentSectionId: 'lesson-1',
      projectId: 'project-1',
      userId: 'user-1',
    });
    expect(replayInput.idempotencyInput).toEqual(firstInput.idempotencyInput);
    expect(replay).toMatchObject({
      busy: false,
      created: false,
      job: { id: 'run-1', sectionId: 'sublesson-1' },
    });
  });

  test('returns the authoritative progress of a deduplicated lesson run', async () => {
    const currentRun = run({ status: 'queued' });
    const input = dependencies({
      runReader: {
        getRun: vi.fn().mockResolvedValue(currentRun),
        getRunState: vi
          .fn()
          .mockResolvedValue(state([{ definitionId: 'draft-lesson', status: 'running' }])),
      },
      starter: {
        start: vi.fn().mockResolvedValue({ created: false, run: run({ status: 'queued' }) }),
      },
    });

    const result = await createLessonGenerationApi(input).start({
      forceRegenerate: false,
      projectId: 'project-1',
      requestKey: 'request-1',
      sectionId: 'lesson-1',
      userId: 'user-1',
    });

    expect(input.runReader.getRun).toHaveBeenCalledWith({ runId: 'run-1', userId: 'user-1' });
    expect(input.runReader.getRunState).toHaveBeenCalledWith({
      runId: 'run-1',
      userId: 'user-1',
    });
    expect(result).toMatchObject({
      busy: false,
      created: false,
      job: { stage: 'drafting', status: 'running' },
    });
  });

  test('maps durable nodes to the established structured progress stages', async () => {
    const stages = [
      [{ definitionId: 'plan-sublesson', status: 'running' }, 'structure'],
      [{ definitionId: 'finalize-sublesson', status: 'running' }, 'sources'],
      [{ definitionId: 'stage-document-sources', status: 'running' }, 'sources'],
      [{ definitionId: 'research-lesson', status: 'running' }, 'structure'],
      [{ definitionId: 'draft-lesson', status: 'running' }, 'drafting'],
      [{ definitionId: 'review-lesson', status: 'queued' }, 'quiz'],
      [{ definitionId: 'review-lesson', status: 'running' }, 'verification'],
    ] as const;

    for (const [node, expectedStage] of stages) {
      const input = dependencies({
        runReader: {
          getRun: vi.fn().mockResolvedValue(run()),
          getRunState: vi.fn().mockResolvedValue(state([node])),
        },
      });
      const snapshot = await createLessonGenerationApi(input).get({
        runId: 'run-1',
        userId: 'user-1',
      });
      expect(snapshot?.stage).toBe(expectedStage);
    }
  });

  test('shows the current retry stage instead of the furthest historical stage', async () => {
    const input = dependencies({
      runReader: {
        getRun: vi.fn().mockResolvedValue(run()),
        getRunState: vi.fn().mockResolvedValue(
          state([
            { definitionId: 'review-lesson', status: 'completed' },
            { definitionId: 'draft-lesson', status: 'running' },
          ])
        ),
      },
    });

    const snapshot = await createLessonGenerationApi(input).get({
      runId: 'run-1',
      userId: 'user-1',
    });

    expect(snapshot?.stage).toBe('drafting');
  });

  test.each([
    'retrying',
    'running',
  ] as const)('preserves authoritative timing and retry progress while the current attempt is %s', async nodeStatus => {
    const input = dependencies({
      runReader: {
        getRun: vi.fn().mockResolvedValue(run()),
        getRunState: vi.fn().mockResolvedValue(
          state(
            [
              {
                attemptCount: 2,
                definitionId: 'research-lesson',
                error: {
                  code: 'lesson_research_unavailable',
                  details: { privateTrace: 'do-not-expose' },
                  kind: 'operational',
                  message: 'Private provider failure',
                },
                status: nodeStatus,
                updatedAt: '2026-07-29T20:04:00.000Z',
              },
            ],
            'running',
            {
              createdAt: '2026-07-29T20:00:00.000Z',
              startedAt: '2026-07-29T20:01:00.000Z',
              updatedAt: '2026-07-29T20:04:00.000Z',
            }
          )
        ),
      },
    });

    const snapshot = await createLessonGenerationApi(input).get({
      runId: 'run-1',
      userId: 'user-1',
    });

    expect(snapshot).toMatchObject({
      attempt: 2,
      createdAt: '2026-07-29T20:00:00.000Z',
      failure: { code: 'lesson_research_unavailable', kind: 'operational' },
      retrying: true,
      stage: 'structure',
      startedAt: '2026-07-29T20:01:00.000Z',
      updatedAt: '2026-07-29T20:04:00.000Z',
    });
    expect(JSON.stringify(snapshot)).not.toContain('do-not-expose');
    expect(JSON.stringify(snapshot)).not.toContain('Private provider failure');
  });

  test('returns validated terminal output and exposes only its stable failure code', async () => {
    const result = {
      content: 'Lezione pronta',
      contentBlocks: [{ markdown: 'Lezione pronta', type: 'markdown' }],
      generatedVisuals: [],
      imageRefs: [],
      learningAids: [],
      projectId: 'project-1',
      quiz: [],
      sectionId: 'lesson-1',
      warnings: [],
    };
    const providerFailure = {
      code: 'lesson_provider_failed',
      details: { privateTrace: 'secret' },
      kind: 'operational',
      message: 'Private provider error',
    };
    const completedApi = createLessonGenerationApi(
      dependencies({
        runReader: {
          getRun: vi.fn().mockResolvedValue(run({ output: result, status: 'completed' })),
          getRunState: vi.fn().mockResolvedValue(state([], 'completed')),
        },
      })
    );
    const failedApi = createLessonGenerationApi(
      dependencies({
        runReader: {
          getRun: vi.fn().mockResolvedValue(
            run({
              error: providerFailure,
              status: 'failed',
            })
          ),
          getRunState: vi.fn().mockResolvedValue(state([], 'failed', { error: providerFailure })),
        },
      })
    );

    await expect(completedApi.get({ runId: 'run-1', userId: 'user-1' })).resolves.toMatchObject({
      result,
      status: 'completed',
    });
    const failed = await failedApi.get({ runId: 'run-1', userId: 'user-1' });
    expect(failed).toMatchObject({
      correlationId: '123e4567-e89b-12d3-a456-426614174000',
      errorCode: 'lesson_provider_failed',
      status: 'failed',
    });
    expect(JSON.stringify(failed)).not.toContain('privateTrace');
    expect(JSON.stringify(failed)).not.toContain('Private provider error');
  });

  test('fails before scheduling when the project or lesson target is missing', async () => {
    const input = dependencies({
      projectReader: { loadProject: vi.fn().mockResolvedValue(null) },
    });
    const api = createLessonGenerationApi(input);

    await expect(
      api.start({
        forceRegenerate: false,
        projectId: 'missing',
        requestKey: 'request-1',
        sectionId: 'lesson-1',
        userId: 'user-1',
      })
    ).rejects.toBeInstanceOf(LessonGenerationTargetNotFoundError);
    expect(input.starter.start).not.toHaveBeenCalled();
  });
});
