import { describe, expect, test, vi } from 'vitest';

import {
  applyCourseExercisePlacements,
  createCourseExercisePlanningStage,
  markCourseExercisePlanningFailed,
} from '../../src/workflows/courseExercisePlanning.js';
import {
  CourseLearningPlanSchema,
  CourseSourcesFinalizedStateSchema,
} from '../../src/workflows/courseGenerationWorkflowContract.js';
import { failPermanently, retryCorrective } from '../../src/workflows/retryPolicy.js';

const plan = CourseLearningPlanSchema.parse({
  applicationExercisePlanningStatus: 'not-run',
  modules: [
    {
      children: [
        {
          description: 'Concetti di base.',
          id: 'lesson-1',
          isCompleted: false,
          kind: 'lesson',
          title: 'Fondamenti',
          type: 'core',
        },
      ],
      id: 'module-1',
      title: 'Modulo uno',
    },
  ],
  summary: 'Introduzione.',
  title: 'Corso',
});

const sourceState = CourseSourcesFinalizedStateSchema.parse({
  context: {
    assessmentSummary: 'USER: Voglio esercitarmi sui sistemi distribuiti.',
    language: 'Italiano',
    profile: {
      context: 'Studente di informatica',
      experienceLevel: 'base',
      goals: 'Applicare i fondamenti',
      language: 'Italiano',
      learningStyle: 'esempi pratici',
      topic: 'Sistemi distribuiti',
    },
    sourceNames: [],
    sources: [],
    topic: 'Sistemi distribuiti',
  },
  documentIndex: null,
  plan,
  projectRevision: 2,
  request: { mode: 'learn', projectId: 'project-1', userId: 'user-1' },
  research: {
    web: { brief: '', sources: [] },
    youtube: {
      candidates: [],
      context: '',
      rationale: '',
      status: 'unavailable',
    },
  },
  researchCoursePlan: null,
  stage: 'sources-finalized',
  strategy: 'learn',
  syllabus: [],
});

const stageContext = (attemptNumber = 1, signal = new AbortController().signal) => ({
  attemptNumber,
  config: {
    maxAttempts: 3,
    models: {} as never,
    timeoutMs: 60_000,
  },
  execution: { nodeInstanceId: 'place-application-exercises', runId: 'run-1' },
  idempotencyKey: 'exercise-key',
  input: sourceState,
  retryFeedback: '',
  signal,
});

describe('course exercise planning', () => {
  test('adds at most one validated exercise to an existing module', () => {
    const result = applyCourseExercisePlacements(
      plan,
      [
        {
          assessedObjective: 'Diagnosticare una topologia distribuita.',
          description: 'Analizza un caso concreto.',
          moduleId: 'module-1',
          title: 'Laboratorio di topologia',
        },
      ],
      'Serve una verifica applicativa.',
      '2026-07-30T12:00:00.000Z'
    );

    expect(result.modules[0]?.children[1]).toMatchObject({
      id: 'module-1-exercise',
      kind: 'exercise',
      title: 'Laboratorio di topologia',
    });
    expect(result.applicationExercisePlanningStatus).toBe('completed');
  });

  test('rejects unknown and duplicate module placements', () => {
    const placement = {
      assessedObjective: 'Applicare il concetto.',
      description: 'Caso pratico.',
      moduleId: 'missing',
      title: 'Laboratorio',
    };
    expect(() =>
      applyCourseExercisePlacements(plan, [placement], '', '2026-07-30T12:00:00.000Z')
    ).toThrow();
    expect(() =>
      applyCourseExercisePlacements(
        plan,
        [
          { ...placement, moduleId: 'module-1' },
          { ...placement, moduleId: 'module-1' },
        ],
        '',
        '2026-07-30T12:00:00.000Z'
      )
    ).toThrow();
  });

  test('records a stable degraded outcome without persisting provider details', () => {
    const failed = markCourseExercisePlanningFailed(plan, 3, '2026-07-30T12:00:00.000Z');

    expect(failed.applicationExercisePlanningError).toEqual({
      attempts: 3,
      lastAttemptAt: '2026-07-30T12:00:00.000Z',
      message: 'Pianificazione esercizi non riuscita.',
    });
  });

  test('generates and applies a schema-validated exercise placement', async () => {
    const generateObject = vi.fn(async input =>
      input.schema.parse({
        placements: [
          {
            assessedObjective: 'Diagnosticare una topologia distribuita.',
            description: 'Analizza un caso concreto.',
            moduleId: 'module-1',
            title: 'Laboratorio di topologia',
          },
        ],
        rationale: 'Il modulo contiene concetti applicabili.',
      })
    );
    const placeApplicationExercises = createCourseExercisePlanningStage({
      generateObject: generateObject as never,
      now: () => '2026-07-30T12:00:00.000Z',
    });
    const context = stageContext();

    const result = await placeApplicationExercises(context);

    expect(result.stage).toBe('exercises');
    expect(result.plan.modules[0]?.children[1]).toMatchObject({
      assessedObjective: 'Diagnosticare una topologia distribuita.',
      kind: 'exercise',
      title: 'Laboratorio di topologia',
    });
    expect(generateObject).toHaveBeenCalledOnce();
    expect(generateObject.mock.calls[0]?.[0]).toMatchObject({
      name: 'course_exercise_placements',
      slot: 'course',
      webSearch: false,
    });
    expect(generateObject.mock.calls[0]?.[0].signal).toBe(context.signal);
  });

  test('makes unknown and duplicate module placements invalid model output', async () => {
    let schema: { safeParse(value: unknown): { success: boolean } } | undefined;
    const generateObject = vi.fn(async input => {
      schema = input.schema;
      return input.schema.parse({ placements: [], rationale: 'Nessun laboratorio necessario.' });
    });
    const placeApplicationExercises = createCourseExercisePlanningStage({
      generateObject: generateObject as never,
    });

    await placeApplicationExercises(stageContext());

    const placement = {
      assessedObjective: 'Applicare il concetto.',
      description: 'Caso pratico.',
      moduleId: 'module-1',
      title: 'Laboratorio',
    };
    expect(
      schema?.safeParse({ placements: [{ ...placement, moduleId: 'missing' }], rationale: '' })
        .success
    ).toBe(false);
    expect(schema?.safeParse({ placements: [placement, placement], rationale: '' }).success).toBe(
      false
    );
  });

  test('leaves retryable model failures to the runtime before the last attempt', async () => {
    const failure = retryCorrective({
      code: 'invalid_exercise_placement',
      feedback: 'Correggi il posizionamento.',
      message: 'Posizionamento non valido.',
    });
    const generateObject = vi.fn(async () => {
      throw failure;
    });
    const placeApplicationExercises = createCourseExercisePlanningStage({
      generateObject: generateObject as never,
    });

    await expect(placeApplicationExercises(stageContext(2))).rejects.toBe(failure);
    expect(generateObject).toHaveBeenCalledOnce();
  });

  test('degrades only a final retryable model failure', async () => {
    const generateObject = vi.fn(async () => {
      throw new Error('provider unavailable');
    });
    const placeApplicationExercises = createCourseExercisePlanningStage({
      generateObject: generateObject as never,
      now: () => '2026-07-30T12:00:00.000Z',
    });

    const result = await placeApplicationExercises(stageContext(3));

    expect(result.stage).toBe('exercises');
    expect(result.plan.applicationExercisePlanningStatus).toBe('failed');
    expect(result.plan.applicationExercisePlanningError).toEqual({
      attempts: 3,
      lastAttemptAt: '2026-07-30T12:00:00.000Z',
      message: 'Pianificazione esercizi non riuscita.',
    });
  });

  test('never degrades permanent failures or cancellation', async () => {
    const permanent = failPermanently({
      code: 'exercise_planning_disabled',
      message: 'Exercise planning is disabled.',
    });
    const permanentStage = createCourseExercisePlanningStage({
      generateObject: vi.fn(async () => {
        throw permanent;
      }) as never,
    });
    await expect(permanentStage(stageContext(3))).rejects.toBe(permanent);

    const controller = new AbortController();
    controller.abort();
    const abortedStage = createCourseExercisePlanningStage({
      generateObject: vi.fn(async () => {
        throw new Error('request interrupted');
      }) as never,
    });
    await expect(abortedStage(stageContext(3, controller.signal))).rejects.toMatchObject({
      name: 'AbortError',
    });
  });
});
