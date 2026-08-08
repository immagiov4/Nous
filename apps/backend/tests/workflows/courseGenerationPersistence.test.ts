import type { TransactionSql } from 'postgres';
import { describe, expect, test, vi } from 'vitest';

import { applyProjectPatch } from '../../src/projects/projectPatch.js';
import type { ProjectSnapshot } from '../../src/projects/types.js';
import {
  buildCourseGenerationCommitPatch,
  buildCourseGenerationUndoPatch,
  createCoursePersistenceStage,
  createCourseResultFinalizer,
  PostgresCourseGenerationPersistence,
} from '../../src/workflows/courseGenerationPersistence.js';
import {
  type CourseExercisesState,
  CourseExercisesStateSchema,
} from '../../src/workflows/courseGenerationWorkflowContract.js';

const NOW = '2026-07-30T12:00:00.000Z';

const plan = (withLesson = true) => ({
  applicationExercisePlanningStatus: 'completed' as const,
  modules: [
    {
      children: withLesson
        ? [
            {
              description: 'Processi, nodi e unità di esecuzione.',
              id: 'lesson-1',
              isCompleted: false,
              kind: 'lesson' as const,
              title: 'Unità di calcolo',
              type: 'core' as const,
            },
          ]
        : [],
      id: 'module-1',
      title: 'Fondamenti',
    },
  ],
  summary: 'Percorso introduttivo.',
  title: 'Sistemi distribuiti',
});

const project = (): ProjectSnapshot => ({
  activeSectionId: null,
  createdAt: '2026-07-30T11:00:00.000Z',
  id: 'project-1',
  isLearnMode: false,
  lastOpenedAt: '2026-07-30T11:00:00.000Z',
  learningPlan: null,
  researchCoursePlan: null,
  researchDossiersBySectionId: {},
  source: {
    file: { data: '', mimeType: 'text/plain', name: 'distributed-systems.txt' },
    kind: 'document',
  },
  sourceKind: 'document',
  state: 'PLANNING',
  syllabus: [],
  updatedAt: '2026-07-30T11:00:00.000Z',
  userProfile: {
    context: '',
    experienceLevel: 'base',
    goals: 'Capire i sistemi distribuiti',
    language: 'Italiano',
    learningStyle: 'esempi',
    topic: 'Sistemi distribuiti',
  },
  version: '4.1',
});

const exercisesState = (withLesson = true): CourseExercisesState =>
  CourseExercisesStateSchema.parse({
    context: {
      assessmentSummary: 'Voglio capire i sistemi distribuiti.',
      language: 'Italiano',
      profile: project().userProfile,
      sourceNames: ['distributed-systems.txt'],
      sources: [
        {
          hash: 'a'.repeat(64),
          id: 'source-1',
          kind: 'text',
          mimeType: 'text/plain',
          name: 'distributed-systems.txt',
        },
      ],
      topic: 'Sistemi distribuiti',
    },
    documentIndex: null,
    plan: plan(withLesson),
    projectRevision: 4,
    request: {
      mode: 'document',
      projectId: 'project-1',
      userId: 'user-1',
    },
    research: {
      web: { brief: '', sources: [] },
      youtube: { candidates: [], context: '', rationale: '', status: 'completed' },
    },
    researchCoursePlan: null,
    stage: 'exercises',
    strategy: 'single-source',
    syllabus: [],
  });

const stageContext = (input: CourseExercisesState) => ({
  attemptNumber: 1,
  config: {} as never,
  execution: { nodeInstanceId: 'persist-course', runId: 'run-1' },
  idempotencyKey: 'persist-key',
  input,
  retryFeedback: '',
  signal: new AbortController().signal,
});

describe('course generation persistence', () => {
  test('rejects a generated plan with no readable lesson', async () => {
    const build = createCoursePersistenceStage({
      loadProjectWithRevision: vi.fn().mockResolvedValue({ revision: 4, snapshot: project() }),
      now: () => NOW,
    });

    const failure = await build(stageContext(exercisesState(false))).catch(error => error);

    expect(failure.failure).toMatchObject({
      code: 'course_plan_empty',
      kind: 'permanent',
    });
  });

  test('builds and commits a reading project only from the authoritative revision', async () => {
    const snapshot = project();
    const input = exercisesState();
    const build = createCoursePersistenceStage({
      loadProjectWithRevision: vi.fn().mockResolvedValue({ revision: 4, snapshot }),
      now: () => NOW,
    });
    const state = await build(stageContext(input));
    const patch = buildCourseGenerationCommitPatch(
      { revision: 4, snapshot },
      input,
      state,
      stageContext(input).execution
    );
    const committed = applyProjectPatch(snapshot, patch, NOW);

    expect(patch).toMatchObject({
      activeSectionId: 'lesson-1',
      lastCourseGenerationRunId: 'run-1',
      learningPlan: input.plan,
      state: 'READING',
    });
    expect(state.result).toEqual({
      firstSectionId: 'lesson-1',
      projectId: 'project-1',
      projectRevision: 5,
    });
    expect(() =>
      buildCourseGenerationCommitPatch(
        { revision: 5, snapshot },
        input,
        state,
        stageContext(input).execution
      )
    ).toThrow();

    const finalizer = createCourseResultFinalizer({
      loadProjectWithRevision: vi.fn().mockResolvedValue({ revision: 5, snapshot: committed }),
    });
    await expect(finalizer({ ...stageContext(input), input: state })).resolves.toEqual(
      state.result
    );
  });

  test('undo restores the previous course fields and refuses to overwrite later edits', async () => {
    const snapshot = project();
    const input = exercisesState();
    const state = await createCoursePersistenceStage({
      loadProjectWithRevision: vi.fn().mockResolvedValue({ revision: 4, snapshot }),
      now: () => NOW,
    })(stageContext(input));
    const committed = applyProjectPatch(
      snapshot,
      buildCourseGenerationCommitPatch(
        { revision: 4, snapshot },
        input,
        state,
        stageContext(input).execution
      ),
      NOW
    );

    const undoPatch = buildCourseGenerationUndoPatch({ revision: 5, snapshot: committed }, state);
    expect(undoPatch).toMatchObject({
      activeSectionId: null,
      learningPlan: null,
      state: 'PLANNING',
    });
    const restored = applyProjectPatch(committed, undoPatch ?? {}, NOW);
    expect(buildCourseGenerationUndoPatch({ revision: 6, snapshot: restored }, state)).toBeNull();

    expect(() =>
      buildCourseGenerationUndoPatch({ revision: 6, snapshot: structuredClone(committed) }, state)
    ).toThrow();

    const edited = structuredClone(committed);
    edited.learningPlan = { ...edited.learningPlan, title: 'Modifica concorrente' };
    expect(() =>
      buildCourseGenerationUndoPatch({ revision: 6, snapshot: edited }, state)
    ).toThrow();
  });

  test.each([
    'module',
    'lesson',
  ] as const)('rejects duplicate %s identifiers at the persistence boundary', async duplicateKind => {
    const input = exercisesState();
    const duplicateModule = structuredClone(input.plan.modules[0]);
    duplicateModule.id = duplicateKind === 'module' ? 'module-1' : 'module-2';
    duplicateModule.children[0].id = duplicateKind === 'lesson' ? 'lesson-1' : 'lesson-2';
    input.plan.modules.push(duplicateModule);
    const build = createCoursePersistenceStage({
      loadProjectWithRevision: vi.fn().mockResolvedValue({ revision: 4, snapshot: project() }),
      now: () => NOW,
    });

    const failure = await build(stageContext(input)).catch(error => error);

    expect(failure.failure).toMatchObject({
      code: 'course_plan_ids_invalid',
      kind: 'permanent',
    });
  });

  test('uses the workflow checkpoint transaction for the project commit', async () => {
    const snapshot = project();
    const input = exercisesState();
    const state = await createCoursePersistenceStage({
      loadProjectWithRevision: vi.fn().mockResolvedValue({ revision: 4, snapshot }),
      now: () => NOW,
    })(stageContext(input));
    const patchProject = vi.fn(async (_transaction, request) => ({
      meta: { revision: 5 },
      snapshot: applyProjectPatch(
        snapshot,
        request.buildPatch({ revision: 4, snapshot }) ?? {},
        NOW
      ),
    }));
    const persistence = new PostgresCourseGenerationPersistence({
      patchProject: patchProject as never,
      sql: { begin: vi.fn() } as never,
    });
    const transaction = {} as TransactionSql;

    await persistence.persistCourse({
      execution: stageContext(input).execution,
      input,
      output: state,
      transaction,
    });

    expect(patchProject).toHaveBeenCalledWith(
      transaction,
      expect.objectContaining({
        projectId: 'project-1',
        userId: 'user-1',
      })
    );
  });

  test('appends the restored course revision inside the undo transaction', async () => {
    const snapshot = project();
    const input = exercisesState();
    const output = await createCoursePersistenceStage({
      loadProjectWithRevision: vi.fn().mockResolvedValue({ revision: 4, snapshot }),
      now: () => NOW,
    })(stageContext(input));
    const transaction = {} as TransactionSql;
    const appendRevision = vi.fn(async () => undefined);
    const patchProject = vi.fn(async () => ({
      projectChanged: true,
      meta: { revision: 6 } as never,
      snapshot,
    }));
    const persistence = new PostgresCourseGenerationPersistence({
      appendRevision,
      patchProject: patchProject as never,
      sql: {
        begin: vi.fn(async callback => callback(transaction)),
      } as never,
    });

    await persistence.undoCourse({
      execution: stageContext(input).execution,
      idempotencyKey: 'undo-course',
      input,
      output,
      signal: new AbortController().signal,
    });

    expect(appendRevision).toHaveBeenCalledWith(transaction, {
      eventType: 'course.project-revision',
      projectId: 'project-1',
      revision: 6,
      runId: 'run-1',
    });
    expect(patchProject.mock.invocationCallOrder[0]).toBeLessThan(
      appendRevision.mock.invocationCallOrder[0] as number
    );
  });

  test('does not publish another revision when a retried undo is already applied', async () => {
    const snapshot = project();
    const input = exercisesState();
    const output = await createCoursePersistenceStage({
      loadProjectWithRevision: vi.fn().mockResolvedValue({ revision: 4, snapshot }),
      now: () => NOW,
    })(stageContext(input));
    const appendRevision = vi.fn(async () => undefined);
    const persistence = new PostgresCourseGenerationPersistence({
      appendRevision,
      patchProject: vi.fn(async () => ({
        projectChanged: false,
        meta: { revision: 6 } as never,
        snapshot,
      })) as never,
      sql: { begin: vi.fn(async callback => callback({} as TransactionSql)) } as never,
    });

    await persistence.undoCourse({
      execution: stageContext(input).execution,
      idempotencyKey: 'undo-course-retry',
      input,
      output,
      signal: new AbortController().signal,
    });

    expect(appendRevision).not.toHaveBeenCalled();
  });
});
