import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  applyApplicationExercisePlacements,
  getApplicationExerciseRepairLabel,
  planNeedsApplicationExerciseRepair,
  removeApplicationExercisesFromPlan,
  withExerciseFeedback,
} from '../../../services/exercises/plan.ts';
import type { ApplicationExerciseNode, ExerciseFeedback } from '../../../types.ts';
import { buildTestLearningPlan, buildTestLesson } from '../../helpers/learningPlan.ts';

const buildPlan = () =>
  buildTestLearningPlan([
    buildTestLesson({
      id: 'lesson-1',
      title: 'Mappare host',
      description: 'Capire host e servizi',
      moduleTitle: 'Modulo operativo',
    }),
  ]);

const buildMultiModulePlan = () =>
  buildTestLearningPlan([
    buildTestLesson({
      id: 'lesson-1',
      title: 'Mappare host',
      description: 'Capire host e servizi',
      moduleTitle: 'Modulo operativo',
    }),
    buildTestLesson({
      id: 'lesson-2',
      title: 'Namespace',
      description: 'Capire l isolamento',
      moduleTitle: 'Modulo kernel',
    }),
  ]);

test('planNeedsApplicationExerciseRepair detects lesson-only modules and failed planning', () => {
  const plan = buildPlan();
  assert.equal(planNeedsApplicationExerciseRepair(plan), true);
  assert.equal(
    planNeedsApplicationExerciseRepair({
      ...plan,
      applicationExercisePlanningStatus: 'failed',
    }),
    true
  );
});

test('planNeedsApplicationExerciseRepair stays false when the course already has exercises', () => {
  const plan = buildPlan();
  const withExercise = applyApplicationExercisePlacements(
    {
      ...plan,
      applicationExercisePlanningStatus: 'failed',
    },
    [
      {
        moduleId: plan.modules[0]?.id || '',
        title: 'Laboratorio: mappa minima',
        description: 'Produci una mappa dei flussi principali.',
        assessedObjective: 'Verificare che lo studente sappia collegare host, servizi e flussi.',
      },
    ],
    'Serve un controllo applicativo.'
  ).plan;

  assert.equal(planNeedsApplicationExerciseRepair(withExercise), false);
});

test('applyApplicationExercisePlacements appends validated exercise nodes without a generated brief', () => {
  const plan = buildPlan();
  const result = applyApplicationExercisePlacements(
    plan,
    [
      {
        moduleId: plan.modules[0]?.id || '',
        title: 'Laboratorio: mappa minima',
        description: 'Produci una mappa dei flussi principali.',
        assessedObjective: 'Verificare che lo studente sappia collegare host, servizi e flussi.',
      },
    ],
    'Serve un controllo applicativo.'
  );
  const exercise = result.plan.modules[0]?.children[1] as ApplicationExerciseNode | undefined;

  assert.equal(result.placedCount, 1);
  assert.equal(exercise?.kind, 'exercise');
  assert.equal(exercise?.brief, undefined);
  assert.deepEqual(exercise?.attachments, []);
  assert.equal(result.plan.applicationExercisePlanningStatus, 'completed');
});

test('applyApplicationExercisePlacements rejects duplicate or unknown module ids', () => {
  const plan = buildPlan();
  const moduleId = plan.modules[0]?.id || '';

  assert.throws(() =>
    applyApplicationExercisePlacements(
      plan,
      [
        {
          moduleId,
          title: 'Uno',
          description: 'Uno',
          assessedObjective: 'Uno',
        },
        {
          moduleId,
          title: 'Due',
          description: 'Due',
          assessedObjective: 'Due',
        },
      ],
      ''
    )
  );

  assert.throws(() =>
    applyApplicationExercisePlacements(
      plan,
      [
        {
          moduleId: 'missing-module',
          title: 'Uno',
          description: 'Uno',
          assessedObjective: 'Uno',
        },
      ],
      ''
    )
  );
});

test('applyApplicationExercisePlacements accepts partial coverage across lesson modules', () => {
  const plan = buildMultiModulePlan();

  const result = applyApplicationExercisePlacements(
    plan,
    [
      {
        moduleId: plan.modules[0]?.id || '',
        title: 'Laboratorio mirato',
        description: 'Copre solo il primo modulo.',
        assessedObjective: 'Verificare il primo modulo.',
      },
    ],
    ''
  );

  assert.equal(result.placedCount, 1);
  assert.equal(result.plan.applicationExercisePlanningStatus, 'completed');
  assert.equal(
    result.plan.modules
      .flatMap(module => module.children)
      .filter(child => child.kind === 'exercise').length,
    1
  );
});

test('removeApplicationExercisesFromPlan wipes exercises before manual rerun', () => {
  const plan = buildPlan();
  const withExercise = applyApplicationExercisePlacements(
    plan,
    [
      {
        moduleId: plan.modules[0]?.id || '',
        title: 'Laboratorio',
        description: 'Descrizione',
        assessedObjective: 'Obiettivo',
      },
    ],
    ''
  ).plan;

  const clean = removeApplicationExercisesFromPlan(withExercise);

  assert.deepEqual(
    clean.modules[0]?.children.map(child => child.kind),
    ['lesson']
  );
});

test('getApplicationExerciseRepairLabel stays stable when exercises are only partially planned', () => {
  const plan = buildMultiModulePlan();
  const partialPlan = {
    ...plan,
    modules: plan.modules.map((module, index) =>
      index === 0
        ? {
            ...module,
            children: [
              ...module.children,
              {
                kind: 'exercise' as const,
                id: `${module.id}-exercise`,
                title: 'Laboratorio',
                description: 'Descrizione',
                assessedObjective: 'Obiettivo',
                attachments: [],
                currentFeedback: null,
                isCompleted: false,
                feedbackStale: false,
                updatedAt: '2026-05-15T10:00:00.000Z',
              },
            ],
          }
        : module
    ),
    applicationExercisePlanningStatus: 'completed' as const,
  };

  assert.equal(getApplicationExerciseRepairLabel(partialPlan), 'Pianifica esercizi');
});

const buildExercise = (
  overrides: Partial<ApplicationExerciseNode> = {}
): ApplicationExerciseNode => ({
  kind: 'exercise',
  id: 'exercise-1',
  title: 'Laboratorio',
  description: 'Applica quanto appreso.',
  assessedObjective: 'Dimostrare la competenza con una consegna concreta.',
  attachments: [],
  currentFeedback: null,
  isCompleted: false,
  feedbackStale: true,
  updatedAt: '2026-07-10T09:00:00.000Z',
  ...overrides,
});

const buildFeedback = (score: number, evaluatedAt: string): ExerciseFeedback => ({
  evaluatedAt,
  score,
  qualitativeLabel: 'Riscontro',
  summary: 'Valutazione della consegna.',
  strengths: [],
  improvements: [],
  caveats: [],
});

test('withExerciseFeedback completes an exercise only at the pass threshold', () => {
  const failed = withExerciseFeedback(
    buildExercise({ bestScore: 55 }),
    buildFeedback(59, '2026-07-10T10:00:00.000Z')
  );

  assert.equal(failed.isCompleted, false);
  assert.equal(failed.completedAt, undefined);
  assert.equal(failed.bestScore, 59);
  assert.equal(failed.feedbackStale, false);

  const passed = withExerciseFeedback(failed, buildFeedback(60, '2026-07-10T11:00:00.000Z'));

  assert.equal(passed.isCompleted, true);
  assert.equal(passed.completedAt, '2026-07-10T11:00:00.000Z');
  assert.equal(passed.bestScore, 60);
  assert.equal(passed.feedbackStale, false);
});

test('withExerciseFeedback never regresses completion or the best score', () => {
  const completedAt = '2026-07-10T10:00:00.000Z';
  const completed = buildExercise({
    bestScore: 84,
    completedAt,
    isCompleted: true,
  });
  const latestFeedback = buildFeedback(42, '2026-07-10T12:00:00.000Z');

  const updated = withExerciseFeedback(completed, latestFeedback);

  assert.equal(updated.currentFeedback, latestFeedback);
  assert.equal(updated.isCompleted, true);
  assert.equal(updated.completedAt, completedAt);
  assert.equal(updated.bestScore, 84);
  assert.equal(updated.feedbackStale, false);
});
