import { describe, expect, test, vi } from 'vitest';

import { getGlobalModelConfig } from '../../src/config/modelConfig.js';
import type { ProjectSnapshot } from '../../src/projects/types.js';
import {
  CoursePreparationStateSchema,
  CourseSourcesFinalizedStateSchema,
} from '../../src/workflows/courseGenerationWorkflowContract.js';
import { createWorkflowRegistry } from '../../src/workflows/definition.js';
import {
  buildPdfMappingRepairCommitPatch,
  createPdfMappingRepairPreparationStage,
  createPdfMappingRepairWorkflow,
  getProjectPdfMappingRepairState,
} from '../../src/workflows/pdfMappingRepairWorkflow.js';
import { indexWorkflowNodes } from '../../src/workflows/workflowNodeIndex.js';

const plan = {
  applicationExercisePlanningStatus: 'not-run' as const,
  modules: [
    {
      children: Array.from({ length: 3 }, (_, index) => ({
        description: `Lezione ${index + 1}`,
        id: `lesson-${index + 1}`,
        isCompleted: false,
        kind: 'lesson' as const,
        title: `Lezione ${index + 1}`,
        type: 'core' as const,
      })),
      id: 'module-1',
      title: 'Modulo',
    },
  ],
  summary: 'Sintesi',
  title: 'Corso PDF',
};

const preparation = CoursePreparationStateSchema.parse({
  context: {
    assessmentSummary: '',
    language: 'Italiano',
    profile: null,
    sourceNames: ['manuale.pdf'],
    sources: [
      {
        hash: 'a'.repeat(64),
        id: 'source-1',
        kind: 'pdf',
        mimeType: 'application/pdf',
        name: 'manuale.pdf',
      },
    ],
    topic: 'Corso PDF',
  },
  projectRevision: 2,
  request: { mode: 'document', projectId: 'project-1', userId: 'user-1' },
  stage: 'prepared',
  strategy: 'single-source',
});

const snapshot = (overrides: Partial<ProjectSnapshot> = {}): ProjectSnapshot => ({
  createdAt: '2026-08-01T08:00:00.000Z',
  id: 'project-1',
  lastOpenedAt: '2026-08-01T08:00:00.000Z',
  learningPlan: plan,
  source: { kind: 'pdf' },
  updatedAt: '2026-08-01T08:00:00.000Z',
  version: '4.1',
  ...overrides,
});

const runPreparation = async (projectSnapshot: ProjectSnapshot) => {
  const prepare = createPdfMappingRepairPreparationStage({
    loadProjectWithRevision: vi.fn(async () => ({ revision: 2, snapshot: projectSnapshot })),
    prepareCourse: vi.fn(async () => preparation),
  });
  return prepare({
    attemptNumber: 1,
    config: { maxAttempts: 3, models: getGlobalModelConfig(), timeoutMs: 600_000 },
    execution: { nodeInstanceId: 'prepare', runId: 'run-1' },
    idempotencyKey: 'prepare-1',
    input: { projectId: 'project-1', userId: 'user-1' },
    retryFeedback: '',
    signal: new AbortController().signal,
  });
};

describe('PDF mapping repair workflow', () => {
  test('registers one durable repair path around the shared course source finalizer', () => {
    const definition = createPdfMappingRepairWorkflow({
      maxAttempts: 3,
      models: getGlobalModelConfig(),
      timeoutMs: 600_000,
    });
    const registered = createWorkflowRegistry().register({ current: definition }).current;
    const nodeIds = [...indexWorkflowNodes(definition).values()].map(entry => entry.node.id);

    expect(registered.id).toBe('pdf-mapping-repair');
    expect(nodeIds).toEqual(
      expect.arrayContaining([
        'prepare-pdf-mapping-repair',
        'finalize-course-sources',
        'map-course-source-fast-batches',
        'map-course-source-repair-batches',
        'persist-pdf-mapping-repair',
        'publish-pdf-mapping-project-revision',
      ])
    );
  });

  test('repairs a historical PDF project that has no document index', async () => {
    const result = await runPreparation(snapshot());

    expect(result.kind).toBe('repair');
    if (result.kind !== 'repair') throw new Error('Expected a repair state.');
    expect(result.state.plan.title).toBe('Corso PDF');
    expect(result.state.projectRevision).toBe(2);
  });

  test('repairs a studied course without requiring exercise feedback to be null', async () => {
    const currentFeedback = {
      caveats: ['Una cautela'],
      evaluatedAt: '2026-08-01T08:30:00.000Z',
      improvements: ['Un miglioramento'],
      qualitativeLabel: 'Buono',
      score: 82,
      strengths: ['Un punto forte'],
      summary: 'Feedback persistito',
    };
    const studiedPlan = {
      ...plan,
      modules: [
        {
          ...plan.modules[0],
          children: [
            ...plan.modules[0].children,
            {
              assessedObjective: 'Applicare la teoria',
              attachments: [],
              currentFeedback,
              description: 'Esercizio già valutato',
              feedbackStale: false,
              id: 'exercise-1',
              isCompleted: true,
              kind: 'exercise' as const,
              title: 'Esercizio',
              updatedAt: '2026-08-01T08:30:00.000Z',
            },
          ],
        },
      ],
    };

    await expect(runPreparation(snapshot({ learningPlan: studiedPlan }))).resolves.toMatchObject({
      kind: 'repair',
    });
  });

  test('detects and prepares legacy plans with top-level sections', async () => {
    const legacyPlan = {
      sections: plan.modules[0].children.map(({ kind: _kind, ...lesson }) => lesson),
      summary: plan.summary,
      title: plan.title,
    };
    const legacySnapshot = snapshot({ learningPlan: legacyPlan });

    expect(getProjectPdfMappingRepairState(legacySnapshot)).toBe('missing-document-index');
    await expect(runPreparation(legacySnapshot)).resolves.toMatchObject({
      kind: 'repair',
      state: {
        plan: {
          modules: [
            {
              children: expect.arrayContaining([
                expect.objectContaining({ id: 'lesson-1', kind: 'lesson' }),
              ]),
            },
          ],
        },
      },
    });
  });

  test('uses legacy sections when an empty modules array is also present', async () => {
    const legacyPlan = {
      applicationExercisePlanningStatus: 'not-run' as const,
      modules: [],
      sections: plan.modules[0].children.map(({ kind: _kind, ...lesson }) => lesson),
      summary: plan.summary,
      title: plan.title,
    };
    const legacySnapshot = snapshot({ learningPlan: legacyPlan });

    expect(getProjectPdfMappingRepairState(legacySnapshot)).toBe('missing-document-index');
    await expect(runPreparation(legacySnapshot)).resolves.toMatchObject({
      kind: 'repair',
      state: {
        plan: {
          modules: [
            {
              children: expect.arrayContaining([
                expect.objectContaining({ id: 'lesson-1', kind: 'lesson' }),
              ]),
            },
          ],
        },
      },
    });
  });

  test('repairs legacy repeated mappings but skips an exhausted fallback', async () => {
    const repeatedPlan = {
      ...plan,
      modules: plan.modules.map(module => ({
        ...module,
        children: module.children.map(lesson => ({
          ...lesson,
          primaryChunkIds: ['chunk-1'],
        })),
      })),
    };
    const chunks = Array.from({ length: 6 }, (_, index) => ({
      endOffset: index * 10 + 9,
      headingPath: [],
      id: `chunk-${index + 1}`,
      sequence: index,
      startOffset: index * 10,
      text: `Testo ${index + 1}`,
    }));

    await expect(
      runPreparation(
        snapshot({
          documentIndex: {
            chunks,
            kind: 'pdf-text-index',
            parsedAt: '2026-08-01T08:00:00.000Z',
          },
          learningPlan: repeatedPlan,
        })
      )
    ).resolves.toMatchObject({ kind: 'repair' });
    await expect(
      runPreparation(
        snapshot({
          documentIndex: {
            chunks,
            kind: 'pdf-text-index',
            mappingRecovery: {
              status: 'exhausted',
              updatedAt: '2026-08-01T08:00:00.000Z',
            },
            parsedAt: '2026-08-01T08:00:00.000Z',
          },
          learningPlan: repeatedPlan,
        })
      )
    ).resolves.toEqual({
      kind: 'ready',
      result: { projectId: 'project-1', projectRevision: 2, repaired: false },
    });
  });

  test('commits only the rebuilt index and mapped learning plan at the expected revision', () => {
    const finalized = CourseSourcesFinalizedStateSchema.parse({
      ...preparation,
      documentIndex: {
        chunks: [
          {
            endOffset: 9,
            headingPath: [],
            id: 'chunk-1',
            sequence: 0,
            startOffset: 0,
            text: 'Contenuto',
          },
        ],
        kind: 'pdf-text-index',
        parsedAt: '2026-08-01T08:00:00.000Z',
      },
      plan,
      researchCoursePlan: null,
      stage: 'sources-finalized',
      syllabus: [],
    });

    const patch = buildPdfMappingRepairCommitPatch(
      { revision: 2, snapshot: snapshot() },
      finalized,
      { projectId: 'project-1', projectRevision: 3, repaired: true }
    );

    expect(patch).toEqual({
      documentIndex: finalized.documentIndex,
      learningPlan: finalized.plan,
    });
  });

  test('preserves lesson assets and studied exercise feedback when committing', () => {
    const currentFeedback = {
      caveats: [],
      evaluatedAt: '2026-08-01T08:30:00.000Z',
      improvements: ['Approfondire'],
      qualitativeLabel: 'Buono',
      score: 82,
      strengths: ['Corretto'],
      summary: 'Feedback persistito',
    };
    const storedLesson = {
      ...plan.modules[0].children[0],
      annotations: [{ id: 'annotation-1', note: 'Nota' }],
      content: '# Contenuto già studiato',
      contentBlocks: [{ kind: 'markdown', markdown: '# Contenuto già studiato' }],
      generatedVisuals: [{ artifactId: 'visual-1', kind: 'image' }],
      quiz: [{ answer: 'A', question: 'Domanda' }],
    };
    const exercise = {
      assessedObjective: 'Applicare la teoria',
      attachments: [],
      currentFeedback,
      description: 'Esercizio già valutato',
      feedbackStale: false,
      id: 'exercise-1',
      isCompleted: true,
      kind: 'exercise' as const,
      title: 'Esercizio',
      updatedAt: '2026-08-01T08:30:00.000Z',
    };
    const storedPlan = {
      ...plan,
      modules: [
        {
          ...plan.modules[0],
          children: [storedLesson, ...plan.modules[0].children.slice(1), exercise],
        },
      ],
    };
    const mappedPlan = {
      ...plan,
      modules: plan.modules.map(module => ({
        ...module,
        children: module.children.map(lesson => ({
          ...lesson,
          primaryChunkIds: [`chunk-${lesson.id}`],
          primaryChunkMappingSource: 'mapped' as const,
          sourceReferences: [{ chunkIds: [`chunk-${lesson.id}`], sourceId: 'source-1' }],
        })),
      })),
    };
    const finalized = CourseSourcesFinalizedStateSchema.parse({
      ...preparation,
      documentIndex: {
        chunks: [
          {
            endOffset: 9,
            headingPath: [],
            id: 'chunk-lesson-1',
            sequence: 0,
            sourceId: 'source-1',
            startOffset: 0,
            text: 'Contenuto',
          },
        ],
        kind: 'pdf-text-index',
        parsedAt: '2026-08-01T08:00:00.000Z',
      },
      plan: mappedPlan,
      researchCoursePlan: null,
      stage: 'sources-finalized',
      syllabus: [],
    });

    const patch = buildPdfMappingRepairCommitPatch(
      { revision: 2, snapshot: snapshot({ learningPlan: storedPlan }) },
      finalized,
      { projectId: 'project-1', projectRevision: 3, repaired: true }
    );
    const repairedPlan = patch.learningPlan as typeof storedPlan;
    const repairedLesson = repairedPlan.modules[0].children[0] as typeof storedLesson & {
      primaryChunkIds: string[];
    };

    expect(repairedLesson).toMatchObject({
      annotations: storedLesson.annotations,
      content: storedLesson.content,
      contentBlocks: storedLesson.contentBlocks,
      generatedVisuals: storedLesson.generatedVisuals,
      primaryChunkIds: ['chunk-lesson-1'],
      quiz: storedLesson.quiz,
    });
    expect(repairedPlan.modules[0].children.at(-1)).toEqual(exercise);
  });

  test('keeps a legacy sections-shaped plan while applying rebuilt mappings', () => {
    const legacyLesson = {
      ...plan.modules[0].children[0],
      content: '# Contenuto legacy',
      generatedVisuals: [{ artifactId: 'visual-legacy', kind: 'image' }],
    };
    const legacyPlan = {
      modules: [],
      sections: [legacyLesson],
      summary: plan.summary,
      title: plan.title,
    };
    const mappedPlan = {
      ...plan,
      modules: [
        {
          ...plan.modules[0],
          children: [
            {
              ...plan.modules[0].children[0],
              primaryChunkIds: ['chunk-1'],
              primaryChunkMappingSource: 'mapped' as const,
              sourceReferences: [{ chunkIds: ['chunk-1'], sourceId: 'source-1' }],
            },
          ],
        },
      ],
    };
    const finalized = CourseSourcesFinalizedStateSchema.parse({
      ...preparation,
      documentIndex: {
        chunks: [
          {
            endOffset: 9,
            headingPath: [],
            id: 'chunk-1',
            sequence: 0,
            sourceId: 'source-1',
            startOffset: 0,
            text: 'Contenuto',
          },
        ],
        kind: 'pdf-text-index',
        parsedAt: '2026-08-01T08:00:00.000Z',
      },
      plan: mappedPlan,
      researchCoursePlan: null,
      stage: 'sources-finalized',
      syllabus: [],
    });

    const patch = buildPdfMappingRepairCommitPatch(
      { revision: 2, snapshot: snapshot({ learningPlan: legacyPlan }) },
      finalized,
      { projectId: 'project-1', projectRevision: 3, repaired: true }
    );
    const repairedPlan = patch.learningPlan as typeof legacyPlan & {
      modules?: unknown;
      sections: Array<typeof legacyLesson & { primaryChunkIds: string[] }>;
    };

    expect(repairedPlan.modules).toEqual([]);
    expect(repairedPlan.sections[0]).toMatchObject({
      content: '# Contenuto legacy',
      generatedVisuals: legacyLesson.generatedVisuals,
      primaryChunkIds: ['chunk-1'],
      sourceReferences: [{ chunkIds: ['chunk-1'], sourceId: 'source-1' }],
    });
  });
});
