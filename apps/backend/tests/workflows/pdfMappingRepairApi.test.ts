import { describe, expect, test, vi } from 'vitest';

import type { ProjectSnapshot } from '../../src/projects/types.js';
import { createPdfMappingRepairApi } from '../../src/workflows/pdfMappingRepairApi.js';

const CORRELATION_ID = '123e4567-e89b-42d3-a456-426614174000';

const projectSnapshot = (overrides: Partial<ProjectSnapshot> = {}): ProjectSnapshot => ({
  createdAt: '2026-08-01T08:00:00.000Z',
  id: 'project-1',
  lastOpenedAt: '2026-08-01T08:00:00.000Z',
  learningPlan: {
    applicationExercisePlanningStatus: 'not-run',
    modules: [
      {
        children: [
          {
            description: 'Introduzione',
            id: 'lesson-1',
            isCompleted: false,
            kind: 'lesson',
            title: 'Lezione 1',
            type: 'core',
          },
        ],
        id: 'module-1',
        title: 'Modulo',
      },
    ],
    summary: 'Sintesi',
    title: 'Corso PDF',
  },
  source: { kind: 'pdf' },
  updatedAt: '2026-08-01T08:00:00.000Z',
  version: '4.1',
  ...overrides,
});

const startRequest = {
  projectId: 'project-1',
  requestKey: 'repair-request-1',
  userId: 'user-1',
};

const workflowRun = (overrides: Record<string, unknown> = {}) =>
  ({
    cancellationRequested: false,
    cleanupStatus: 'not-required',
    correlationId: CORRELATION_ID,
    createdAt: '2026-08-01T08:00:00.000Z',
    definitionHash: 'hash',
    definitionHashVersion: 1,
    id: 'repair-run-1',
    input: { projectId: 'project-1', userId: 'user-1' },
    requestKey: 'repair-request-1',
    resolvedConfig: {},
    status: 'queued',
    stepPolicies: {},
    stepPoliciesVersion: 1,
    updatedAt: '2026-08-01T08:00:00.000Z',
    userId: 'user-1',
    workflowId: 'pdf-mapping-repair',
    ...overrides,
  }) as never;

const workflowState = (status: 'failed' | 'running' = 'running') =>
  ({
    events: [],
    nodes: [],
    run: {
      cancellationRequested: false,
      cleanupStatus: 'not-required',
      createdAt: '2026-08-01T08:00:00.000Z',
      definitionHash: 'hash',
      definitionHashVersion: 1,
      error: status === 'failed' ? { code: 'pdf_mapping_repair_failed' } : undefined,
      id: 'repair-run-1',
      requestKey: 'repair-request-1',
      status,
      updatedAt: '2026-08-01T08:01:00.000Z',
      workflowId: 'pdf-mapping-repair',
    },
    waits: [],
  }) as never;

const createDependencies = (snapshot: ProjectSnapshot) => ({
  projectReader: {
    loadProjectWithRevision: vi.fn(async () => ({ revision: 4, snapshot })),
  },
  runReader: {
    getRun: vi.fn(),
    getRunState: vi.fn(),
  },
  starter: {
    start: vi.fn(async () => ({
      created: true,
      run: workflowRun(),
    })),
  },
});

describe('PDF mapping repair API', () => {
  test('returns immediately when recovery was already exhausted', async () => {
    const dependencies = createDependencies(
      projectSnapshot({
        documentIndex: {
          chunks: [{ id: 'chunk-1' }],
          mappingRecovery: { status: 'exhausted' },
        },
      })
    );

    const result = await createPdfMappingRepairApi(dependencies).start(startRequest);

    expect(result).toEqual({
      result: { projectId: 'project-1', projectRevision: 4, repaired: false },
    });
    expect(dependencies.starter.start).not.toHaveBeenCalled();
  });

  test('starts the durable workflow for a missing PDF index', async () => {
    const dependencies = createDependencies(projectSnapshot());

    const result = await createPdfMappingRepairApi(dependencies).start(startRequest);

    expect(dependencies.starter.start).toHaveBeenCalledWith(startRequest);
    expect(result).toMatchObject({
      created: true,
      job: {
        correlationId: CORRELATION_ID,
        id: 'repair-run-1',
        projectId: 'project-1',
        stage: 'preparing',
        status: 'queued',
      },
    });
  });

  test('returns persisted correlation for a terminal repair failure', async () => {
    const dependencies = createDependencies(projectSnapshot());
    dependencies.runReader.getRun.mockResolvedValue(workflowRun({ status: 'failed' }));
    dependencies.runReader.getRunState.mockResolvedValue(workflowState('failed'));

    const result = await createPdfMappingRepairApi(dependencies).get({
      runId: 'repair-run-1',
      userId: 'user-1',
    });

    expect(result).toMatchObject({
      correlationId: CORRELATION_ID,
      errorCode: 'pdf_mapping_repair_failed',
      status: 'failed',
    });
  });
});
