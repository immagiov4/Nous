import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  exportProjectData,
  normalizeImportedProject,
  normalizeStoredProject,
} from '../../../services/projects/projectSnapshot.ts';

test('mixed prerequisite sources survive stored reload and export import', () => {
  const stored = normalizeStoredProject({
    id: 'mixed-prerequisite-project',
    version: '4.1',
    state: 'READING',
    sourceKind: 'document',
    source: null,
    learningPlan: {
      title: 'Corso',
      summary: 'Percorso con prerequisiti',
      applicationExercisePlanningStatus: 'not-run',
      modules: [
        {
          id: 'module-1',
          title: 'Fondamenti',
          children: [
            {
              kind: 'lesson',
              id: 'lesson-prerequisite',
              title: 'Prerequisito',
              description: 'Basi necessarie',
              isCompleted: false,
              type: 'prerequisite',
              content: '# Prerequisito\n\nContenuto misto.',
            },
          ],
        },
      ],
    },
    isLearnMode: false,
    userProfile: null,
    syllabus: [],
    researchDossiersBySectionId: {
      'lesson-prerequisite': {
        sectionId: 'lesson-prerequisite',
        title: 'Prerequisito',
        generatedAt: '2026-07-11T10:00:00.000Z',
        factualSummary: 'Fondamento verificato.',
        keyExamples: [],
        difficultSteps: [],
        avoidOversimplifying: [],
        controversies: [],
        recentDevelopments: [],
        sources: [
          { title: 'dispensa.pdf', note: 'Materiale originale del corso' },
          {
            title: 'Documentazione ufficiale',
            url: 'https://example.com/docs',
            note: 'Copre il concetto assente.',
          },
        ],
      },
    },
    activeSectionId: 'lesson-prerequisite',
    createdAt: '2026-07-11T10:00:00.000Z',
    updatedAt: '2026-07-11T10:00:00.000Z',
    lastOpenedAt: '2026-07-11T10:00:00.000Z',
  });
  const reloaded = normalizeImportedProject(exportProjectData(stored));

  assert.deepEqual(reloaded.researchDossiersBySectionId?.['lesson-prerequisite']?.sources, [
    { title: 'dispensa.pdf', url: undefined, note: 'Materiale originale del corso' },
    {
      title: 'Documentazione ufficiale',
      url: 'https://example.com/docs',
      note: 'Copre il concetto assente.',
    },
  ]);
  assert.equal(
    reloaded.learningPlan?.modules[0]?.children[0]?.kind === 'lesson'
      ? reloaded.learningPlan.modules[0].children[0].content
      : null,
    '# Prerequisito\n\nContenuto misto.'
  );
});
