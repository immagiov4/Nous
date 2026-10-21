import assert from 'node:assert/strict';
import { segmentLessonPlayback } from '@shared/lessonPlayback';
import { test } from 'vitest';
import { createProjectSnapshot } from '../../../../services/projects/projectSnapshot.ts';
import {
  prepareSnapshotForHydration,
  prepareSnapshotForHydrationResult,
  resolveScreenStateForSnapshot,
} from '../../../../services/workspace/controller/snapshotHydration.ts';
import { AppState, type LearningPlan, type ProjectSnapshot } from '../../../../types.ts';
import { flattenLessons, flattenPathNodes } from '../../../../utils/learning/pathNodes.ts';
import {
  applySectionAnnotation,
  getSectionAnnotationText,
} from '../../../../utils/learning/sectionAnnotations.ts';
import { buildTestLearningPlan, buildTestLesson } from '../../../helpers/learningPlan.ts';

const CURRENT_LEGACY_LABORATORY_SCHEMA_VERSION = 3;

test('unfinished interviews reopen in the home instead of the removed assessment screen', () => {
  assert.equal(
    resolveScreenStateForSnapshot({ learningPlan: null, source: null, state: AppState.ASSESSMENT }),
    AppState.LIBRARY
  );
});

test('prepareSnapshotForHydrationResult preserves unchanged modern snapshots by reference', () => {
  const originalPlan = buildTestLearningPlan(
    [
      buildTestLesson({
        id: 'lesson-stable',
        content: '# Contenuto pronto',
      }),
    ],
    { title: 'Reti', summary: 'Fondamenti' }
  );
  const reorderedPlan: LearningPlan = {
    title: originalPlan.title,
    modules: originalPlan.modules,
    summary: originalPlan.summary,
    generationNotes: 'Usa esempi concreti.',
    applicationExercisePlanningStatus: originalPlan.applicationExercisePlanningStatus,
  };
  const snapshot = createProjectSnapshot({
    id: 'project-stable',
    learningPlan: reorderedPlan,
    state: AppState.READING,
    activeSectionId: 'lesson-stable',
  });

  const result = prepareSnapshotForHydrationResult(snapshot);

  assert.equal(result.didChange, false);
  assert.equal(result.snapshot, snapshot);
  assert.equal(result.snapshot.learningPlan, reorderedPlan);
});

test('prepareSnapshotForHydrationResult reports legacy plan migrations explicitly', () => {
  const snapshot = {
    ...createProjectSnapshot({
      id: 'project-legacy-plan',
      state: AppState.READING,
    }),
    learningPlan: {
      title: 'Reti',
      summary: 'Fondamenti',
      sections: [
        {
          id: 'legacy-lesson',
          title: 'Comunicazione',
          description: 'Introduzione',
          isCompleted: false,
          type: 'core',
          content: '# Contenuto pronto',
        },
      ],
    },
  } as unknown as ProjectSnapshot;

  const result = prepareSnapshotForHydrationResult(snapshot);

  assert.equal(result.didChange, true);
  assert.notEqual(result.snapshot, snapshot);
  assert.equal(result.snapshot.learningPlan?.modules.length, 1);
  assert.equal(result.snapshot.activeSectionId, 'legacy-lesson');
});

test('prepareSnapshotForHydration preserves bare code-like lesson markdown', () => {
  const snapshot: ProjectSnapshot = {
    id: 'project-1',
    version: '1',
    sourceKind: 'document',
    state: AppState.READING,
    source: null,
    learningPlan: buildTestLearningPlan(
      [
        buildTestLesson({
          id: 'section-1',
          title: 'Ownership',
          description: 'Dettagli',
          content:
            'Esempio:\n\ncpp\nMapNode Map::getNode(v3s16 p, bool *is_valid_position)\n\nLa funzione restituisce un nodo.',
        }),
      ],
      { title: 'Percorso', summary: 'Test' }
    ),
    isLearnMode: false,
    userProfile: null,
    syllabus: [],
    activeSectionId: 'section-1',
    createdAt: '2026-03-23T10:00:00.000Z',
    updatedAt: '2026-03-23T10:00:00.000Z',
    lastOpenedAt: '2026-03-23T10:00:00.000Z',
    documentAssets: null,
    documentIndex: null,
  };

  const prepared = prepareSnapshotForHydration(snapshot);

  assert.equal(
    flattenLessons(prepared.learningPlan?.modules)[0]?.content,
    'Esempio:\n\ncpp\nMapNode Map::getNode(v3s16 p, bool *is_valid_position)\n\nLa funzione restituisce un nodo.'
  );
});

test('prepareSnapshotForHydration drops legacy laboratory payloads that miss the guided support fields', () => {
  const snapshot = {
    id: 'project-lab-legacy',
    version: '4.1',
    sourceKind: 'document',
    state: AppState.READING,
    source: null,
    learningPlan: {
      title: 'Percorso',
      summary: 'Test',
      sections: [
        {
          id: 'section-1',
          title: 'Ownership',
          description: 'Dettagli',
          type: 'core',
          isCompleted: false,
          content: 'Contenuto pronto.',
        },
      ],
    },
    laboratory: {
      errorMessage: undefined,
      exercises: [
        {
          attachments: [],
          approachMarkdown: '',
          brief: 'Analizza il caso.',
          evaluation: null,
          exampleMarkdown: '',
          generatedAt: '2026-03-23T10:00:00.000Z',
          id: 'lab-1',
          internalNotes: [],
          instructionsMarkdown: '## Traccia',
          requirements: [],
          title: 'Esercizio 1',
          updatedAt: '2026-03-23T10:00:00.000Z',
        },
      ],
      generatedAt: '2026-03-23T10:00:00.000Z',
      schemaVersion: CURRENT_LEGACY_LABORATORY_SCHEMA_VERSION - 1,
      status: 'ready',
      summary: 'Laboratorio vecchio',
      title: 'Laboratorio',
      updatedAt: '2026-03-23T10:00:00.000Z',
    },
    isLearnMode: false,
    userProfile: null,
    syllabus: [],
    activeSectionId: null,
    activeLaboratoryExerciseId: 'lab-1',
    createdAt: '2026-03-23T10:00:00.000Z',
    updatedAt: '2026-03-23T10:00:00.000Z',
    lastOpenedAt: '2026-03-23T10:00:00.000Z',
    documentAssets: null,
    documentIndex: null,
  } as unknown as ProjectSnapshot;

  const prepared = prepareSnapshotForHydration(snapshot);

  const preparedRecord = prepared as unknown as Record<string, unknown>;
  assert.equal(preparedRecord.laboratory, undefined);
  assert.equal(preparedRecord.activeLaboratoryExerciseId, undefined);
  assert.equal(prepared.activeSectionId, 'section-1');
});

test('prepareSnapshotForHydration resets abandoned pending laboratory generation', () => {
  const snapshot = {
    id: 'project-lab-pending',
    version: '4.1',
    sourceKind: 'document',
    state: AppState.READING,
    source: null,
    learningPlan: {
      title: 'Percorso',
      summary: 'Test',
      sections: [
        {
          id: 'section-1',
          title: 'Ownership',
          description: 'Dettagli',
          type: 'core',
          isCompleted: false,
          content: 'Contenuto pronto.',
        },
      ],
    },
    laboratory: {
      errorMessage: undefined,
      exercises: [],
      generatedAt: undefined,
      schemaVersion: CURRENT_LEGACY_LABORATORY_SCHEMA_VERSION,
      status: 'pending',
      summary: '',
      title: 'Laboratorio',
      updatedAt: '2026-03-23T10:00:00.000Z',
    },
    isLearnMode: false,
    userProfile: null,
    syllabus: [],
    activeSectionId: null,
    activeLaboratoryExerciseId: null,
    createdAt: '2026-03-23T10:00:00.000Z',
    updatedAt: '2026-03-23T10:00:00.000Z',
    lastOpenedAt: '2026-03-23T10:00:00.000Z',
    documentAssets: null,
    documentIndex: null,
  } as unknown as ProjectSnapshot;

  const prepared = prepareSnapshotForHydration(snapshot);

  const preparedRecord = prepared as unknown as Record<string, unknown>;
  assert.equal(preparedRecord.laboratory, undefined);
  assert.equal(preparedRecord.activeLaboratoryExerciseId, undefined);
  assert.equal(prepared.activeSectionId, 'section-1');
});

test('prepareSnapshotForHydration does not auto-generate research mini-lab exercises', () => {
  const snapshot: ProjectSnapshot = {
    id: 'project-research-labs',
    version: '4.1',
    sourceKind: 'learn-mode',
    state: AppState.READING,
    source: null,
    learningPlan: buildTestLearningPlan(
      [
        buildTestLesson({
          id: 'mod-1-lesson-1',
          title: 'Mappare host e servizi',
          description: 'Capire cosa esiste in rete',
          moduleTitle: 'M',
        }),
      ],
      { title: 'Sistemistica PMI', summary: 'Corso pratico' }
    ),
    isLearnMode: true,
    userProfile: null,
    syllabus: [],
    researchCoursePlan: {
      generatedAt: '2026-05-12T12:00:00.000Z',
      lessonCountReason: 'Operational course',
      title: 'Sistemistica PMI',
      summary: 'Corso pratico',
      lessons: [
        {
          id: 'mod-1-lesson-1',
          title: 'Mappare host e servizi',
          description: 'Capire cosa esiste in rete',
          moduleId: 'mod-1',
          moduleTitle: 'Modulo test',
          prerequisites: [],
          keyConcepts: [],
          guidingQuestions: [],
          miniLab: 'Disegna una mappa minima con host, IP e servizi.',
          simplificationRisks: [],
          sourceHints: [],
        },
      ],
    },
    activeSectionId: 'mod-1-lesson-1',
    createdAt: '2026-05-12T12:00:00.000Z',
    updatedAt: '2026-05-12T12:00:00.000Z',
    lastOpenedAt: '2026-05-12T12:00:00.000Z',
    documentAssets: null,
    documentIndex: null,
  };

  const prepared = prepareSnapshotForHydration(snapshot);
  const nodes = flattenPathNodes(prepared.learningPlan?.modules);

  assert.deepEqual(
    nodes.map(node => node.title),
    ['Mappare host e servizi']
  );
  assert.equal(prepared.learningPlan?.applicationExercisePlanningStatus, 'not-run');
});

test('prepareSnapshotForHydration repairs flattened learn-mode plans from syllabus modules', () => {
  const snapshot: ProjectSnapshot = {
    id: 'project-flattened-linux',
    version: '4.1',
    sourceKind: 'learn-mode',
    state: AppState.READING,
    source: null,
    learningPlan: {
      title: 'Linux',
      summary: 'Architettura',
      applicationExercisePlanningStatus: 'not-run',
      modules: [
        {
          id: 'm-0-untitled-module',
          title: 'Untitled module',
          children: [
            {
              kind: 'lesson',
              id: 'mod-1-lesson-1',
              title: 'Unix philosophy',
              description: 'Perche Linux e fatto cosi',
              isCompleted: false,
              type: 'core',
              parentId: 'mod-1',
              content: '# Filosofia',
              contextPrompt: 'Parla della filosofia Unix',
            },
            {
              kind: 'lesson',
              id: 'mod-2-lesson-1',
              title: 'Ring di privilegio',
              description: 'Kernel e user space',
              isCompleted: false,
              type: 'core',
              parentId: 'mod-2',
              content: '# Ring',
              contextPrompt: 'Parla dei ring di privilegio',
            },
          ],
        },
      ],
    },
    isLearnMode: true,
    userProfile: null,
    syllabus: [
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
            description: 'Perche Linux e fatto cosi',
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
            description: 'Kernel e user space',
            type: 'lesson',
            status: 'pending',
            contextPrompt: 'Parla dei ring di privilegio',
          },
        ],
      },
    ],
    activeSectionId: 'mod-2-lesson-1',
    createdAt: '2026-05-12T12:00:00.000Z',
    updatedAt: '2026-05-12T12:00:00.000Z',
    lastOpenedAt: '2026-05-12T12:00:00.000Z',
    documentAssets: null,
    documentIndex: null,
  };

  const prepared = prepareSnapshotForHydration(snapshot);

  assert.deepEqual(
    prepared.learningPlan?.modules.map(module => module.title),
    ['Filosofia', 'Kernel']
  );
  assert.equal(flattenLessons(prepared.learningPlan?.modules)[0]?.content, '# Filosofia');
  assert.equal(flattenLessons(prepared.learningPlan?.modules)[1]?.content, '# Ring');
  assert.equal(prepared.activeSectionId, 'mod-2-lesson-1');
});

test('prepareSnapshotForHydration removes temporary mini-lab lessons without inventing exercises', () => {
  const snapshot: ProjectSnapshot = {
    id: 'project-research-lab-cleanup',
    version: '1',
    sourceKind: 'learn-mode',
    state: AppState.READING,
    source: null,
    learningPlan: {
      title: 'Sistemistica PMI',
      summary: 'Corso pratico',
      modules: [
        {
          id: 'mod-1',
          title: 'Modulo test',
          children: [
            buildTestLesson({
              id: 'mod-1-lesson-1',
              title: 'Mappare host e servizi',
              description: 'Capire cosa esiste in rete',
            }),
            buildTestLesson({
              id: 'mod-1-lab',
              title: 'Laboratorio pratico: Modulo test',
              description: 'Applicare in pratica il modulo "Modulo test".',
              contextPrompt: 'Attivita suggerite:\n- Disegna una mappa minima.',
            }),
          ],
        },
      ],
      applicationExercisePlanningStatus: 'not-run',
    },
    isLearnMode: true,
    userProfile: null,
    syllabus: [],
    researchCoursePlan: {
      generatedAt: '2026-05-12T12:00:00.000Z',
      lessonCountReason: 'Operational course',
      title: 'Sistemistica PMI',
      summary: 'Corso pratico',
      lessons: [
        {
          id: 'mod-1-lesson-1',
          title: 'Mappare host e servizi',
          description: 'Capire cosa esiste in rete',
          moduleId: 'mod-1',
          moduleTitle: 'Modulo test',
          prerequisites: [],
          keyConcepts: [],
          guidingQuestions: [],
          miniLab: 'Disegna una mappa minima con host, IP e servizi.',
          simplificationRisks: [],
          sourceHints: [],
        },
      ],
    },
    activeSectionId: 'mod-1-lesson-1',
    createdAt: '2026-05-12T12:00:00.000Z',
    updatedAt: '2026-05-12T12:00:00.000Z',
    lastOpenedAt: '2026-05-12T12:00:00.000Z',
    documentAssets: null,
    documentIndex: null,
  };

  const prepared = prepareSnapshotForHydration(snapshot);
  const nodes = flattenPathNodes(prepared.learningPlan?.modules);

  assert.deepEqual(
    nodes.map(node => ({ kind: node.kind, title: node.title })),
    [{ kind: 'lesson', title: 'Mappare host e servizi' }]
  );
  assert.equal(prepared.learningPlan?.applicationExercisePlanningStatus, 'not-run');
});

test('hydration preserves authored Markdown and does not schedule a display-only migration', () => {
  const content = 'Formula: \u007f$E = mc^2$';
  const lesson = buildTestLesson({ id: 'authored', content });
  const unopened = buildTestLesson({ id: 'unopened', content: 'Second \u007fpassage' });
  const snapshot = createProjectSnapshot({
    id: 'display-only',
    state: AppState.READING,
    activeSectionId: lesson.id,
    learningPlan: buildTestLearningPlan([lesson, unopened]),
  });
  const result = prepareSnapshotForHydrationResult(snapshot);
  assert.equal(result.didChange, false);
  assert.equal(result.snapshot, snapshot);
  assert.equal(flattenLessons(result.snapshot.learningPlan?.modules)[0]?.content, content);
  assert.equal(flattenLessons(result.snapshot.learningPlan?.modules)[1]?.content, unopened.content);
  assert.equal(lesson.content, content);
});

test('hydration keeps annotation anchors and speech source identity on authored content', () => {
  const content =
    'Before\r\n\r\nFormula: \u007f$E = mc^2$. Select this passage.\r\n\r\n```js\r\nconst literal = "<figure>";\r\n```';
  const annotated = applySectionAnnotation({ content, selectedText: 'Select this passage.' });
  assert.ok(annotated);
  const snapshot = createProjectSnapshot({
    id: 'anchored-source',
    state: AppState.READING,
    activeSectionId: 'anchored',
    learningPlan: buildTestLearningPlan([
      buildTestLesson({ id: 'anchored', content, annotations: annotated.annotations }),
    ]),
  });
  const before = segmentLessonPlayback([{ type: 'markdown', markdown: content }]);
  const hydrated = prepareSnapshotForHydrationResult(snapshot);
  const lesson = flattenLessons(hydrated.snapshot.learningPlan?.modules)[0];
  assert.ok(lesson?.content);
  assert.equal(
    getSectionAnnotationText(lesson.content, annotated.annotations[0].id, lesson.annotations),
    'Select this passage.'
  );
  assert.deepEqual(segmentLessonPlayback([{ type: 'markdown', markdown: lesson.content }]), before);
  assert.equal(hydrated.didChange, false);
});

test('hydration migrates legacy PDF references for rendering and shared speech without normalizing prose', () => {
  const content =
    'Before\n\n<figure><img data-pdf-asset-id="legacy-image" alt="Diagram"><figcaption>Caption</figcaption></figure>\nAfter \u007ftext.';
  const snapshot = createProjectSnapshot({
    id: 'legacy-pdf',
    state: AppState.READING,
    activeSectionId: 'pdf',
    learningPlan: buildTestLearningPlan([buildTestLesson({ id: 'pdf', content })]),
  });
  const result = prepareSnapshotForHydrationResult(snapshot);
  const migrated = flattenLessons(result.snapshot.learningPlan?.modules)[0]?.content;
  assert.ok(migrated);
  assert.equal(result.didChange, true);
  assert.match(migrated, /\{\{PDF_IMAGE:legacy-image\|alt=Diagram\|caption=Caption\}\}/u);
  assert.ok(migrated.endsWith('After \u007ftext.'));
  const blocks = segmentLessonPlayback([{ type: 'markdown', markdown: migrated }]);
  assert.ok(
    blocks.some(block =>
      block.visuals.some(
        visual => visual.kind === 'markdown' && visual.markdown.includes('PDF_IMAGE:legacy-image')
      )
    )
  );
  assert.ok(
    blocks
      .map(block => block.speech)
      .join(' ')
      .includes('After text.')
  );
});
