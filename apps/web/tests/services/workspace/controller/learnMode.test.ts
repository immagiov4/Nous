import assert from 'node:assert/strict';
import { test } from 'vitest';
import { buildLearningPlanFromSyllabus } from '../../../../services/workspace/controller/learnMode.ts';
import type { SyllabusItem, UserProfile } from '../../../../types.ts';

const profile: UserProfile = {
  topic: 'Linux',
  experienceLevel: 'Intermediate',
  learningStyle: 'Theoretical',
  goals: 'Capire l’architettura del sistema',
  context: 'Sviluppatore che vuole una mappa mentale solida',
  language: 'Italiano',
};

test('buildLearningPlanFromSyllabus preserves syllabus module grouping', () => {
  const syllabus: SyllabusItem[] = [
    {
      id: 'mod-1',
      title: 'Filosofia',
      description: 'Base',
      type: 'module',
      status: 'ready',
      children: [
        {
          id: 'mod-1-lesson-1',
          title: 'Unix philosophy',
          description: 'Capire il perche',
          type: 'lesson',
          status: 'pending',
          contextPrompt: 'Parla della filosofia Unix',
        },
      ],
    },
    {
      id: 'mod-2',
      title: 'Kernel',
      description: 'Dettagli',
      type: 'module',
      status: 'ready',
      children: [
        {
          id: 'mod-2-lesson-1',
          title: 'Ring di privilegio',
          description: 'Capire il confine user/kernel',
          type: 'lesson',
          status: 'pending',
          contextPrompt: 'Parla dei ring di privilegio',
        },
      ],
    },
  ];

  const plan = buildLearningPlanFromSyllabus(profile, syllabus);

  assert.deepEqual(
    plan.modules.map(module => module.title),
    ['Filosofia', 'Kernel']
  );
  assert.deepEqual(
    plan.modules.map(module => module.children.map(child => child.title)),
    [['Unix philosophy'], ['Ring di privilegio']]
  );
});
