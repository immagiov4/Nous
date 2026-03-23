import assert from 'node:assert/strict';
import test from 'node:test';
import type { LearningPlan, PdfDocumentAssets, SyllabusItem } from '../types.ts';
import {
  buildLessonAssetMap,
  buildLessonImageRefMap,
  buildSidebarGroups,
} from './workspaceReader.ts';

test('buildSidebarGroups keeps syllabus ordering and nests child lessons under their module', () => {
  const syllabus: SyllabusItem[] = [
    {
      id: 'module-1',
      title: 'Fondamenti',
      description: 'Base',
      type: 'module',
      status: 'ready',
      children: [
        {
          id: 'lesson-1',
          title: 'Lezione 1',
          description: 'Intro',
          type: 'lesson',
          status: 'ready',
        },
      ],
    },
    {
      id: 'module-2',
      title: 'Approfondimenti',
      description: 'Deep dive',
      type: 'module',
      status: 'pending',
      children: [
        {
          id: 'lesson-2',
          title: 'Lezione 2',
          description: 'Seconda',
          type: 'lesson',
          status: 'pending',
        },
      ],
    },
  ];

  const learningPlan: LearningPlan = {
    title: 'Percorso',
    summary: 'Sintesi',
    sections: [
      {
        id: 'lesson-1',
        title: 'Intro',
        description: 'Base',
        isCompleted: false,
        type: 'core',
      },
      {
        id: 'lesson-1-deep',
        title: 'Dettaglio',
        description: 'Figlia',
        isCompleted: false,
        type: 'deep-dive',
        parentId: 'lesson-1',
      },
      {
        id: 'lesson-2',
        title: 'Avanzata',
        description: 'Modulo 2',
        isCompleted: false,
        type: 'core',
      },
    ],
  };

  const groups = buildSidebarGroups(learningPlan, syllabus);

  assert.deepEqual(
    groups.map(group => ({
      id: group.id,
      sectionDepthById: group.sectionDepthById,
      title: group.title,
      sectionIds: group.sections.map(section => section.id),
    })),
    [
      {
        id: 'module-1',
        sectionDepthById: {
          'lesson-1': 0,
          'lesson-1-deep': 1,
        },
        title: 'Fondamenti',
        sectionIds: ['lesson-1', 'lesson-1-deep'],
      },
      {
        id: 'module-2',
        sectionDepthById: {
          'lesson-2': 0,
        },
        title: 'Approfondimenti',
        sectionIds: ['lesson-2'],
      },
    ]
  );
});

test('buildSidebarGroups keeps document children in the same fallback module with nested depth', () => {
  const learningPlan: LearningPlan = {
    title: 'Percorso',
    summary: 'Sintesi',
    sections: [
      {
        id: 'lesson-1',
        moduleTitle: 'Modulo Documento',
        title: 'Intro',
        description: 'Base',
        isCompleted: false,
        type: 'core',
      },
      {
        id: 'lesson-1-deep',
        title: 'Dettaglio',
        description: 'Figlia',
        isCompleted: false,
        type: 'deep-dive',
        parentId: 'lesson-1',
      },
      {
        id: 'lesson-1-deep-nested',
        title: 'Dettaglio annidato',
        description: 'Nipote',
        isCompleted: false,
        type: 'deep-dive',
        parentId: 'lesson-1-deep',
      },
      {
        id: 'lesson-2',
        moduleTitle: 'Modulo Documento',
        title: 'Seguito',
        description: 'Seconda',
        isCompleted: false,
        type: 'core',
      },
    ],
  };

  const groups = buildSidebarGroups(learningPlan, []);

  assert.equal(groups.length, 1);
  assert.equal(groups[0]?.title, 'Modulo Documento');
  assert.deepEqual(groups[0]?.sections.map(section => section.id), [
    'lesson-1',
    'lesson-1-deep',
    'lesson-1-deep-nested',
    'lesson-2',
  ]);
  assert.deepEqual(groups[0]?.sectionDepthById, {
    'lesson-1': 0,
    'lesson-1-deep': 1,
    'lesson-1-deep-nested': 2,
    'lesson-2': 0,
  });
});

test('buildSidebarGroups keeps module-backed lessons at depth zero in learn mode', () => {
  const syllabus: SyllabusItem[] = [
    {
      id: 'module-1',
      title: 'Fondamenti',
      description: 'Base',
      type: 'module',
      status: 'ready',
      children: [
        {
          id: 'lesson-1',
          title: 'Lezione 1',
          description: 'Intro',
          type: 'lesson',
          status: 'ready',
        },
      ],
    },
  ];

  const learningPlan: LearningPlan = {
    title: 'Percorso',
    summary: 'Sintesi',
    sections: [
      {
        id: 'lesson-1',
        title: 'Intro',
        description: 'Base',
        isCompleted: false,
        type: 'core',
        parentId: 'module-1',
      },
      {
        id: 'lesson-1-deep',
        title: 'Dettaglio',
        description: 'Figlia',
        isCompleted: false,
        type: 'deep-dive',
        parentId: 'lesson-1',
      },
    ],
  };

  const groups = buildSidebarGroups(learningPlan, syllabus);

  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0]?.sectionDepthById, {
    'lesson-1': 0,
    'lesson-1-deep': 1,
  });
});

test('buildSidebarGroups falls back safely when parent chains are invalid or cyclic', () => {
  const learningPlan: LearningPlan = {
    title: 'Percorso',
    summary: 'Sintesi',
    sections: [
      {
        id: 'lesson-a',
        title: 'A',
        description: 'Primo',
        isCompleted: false,
        type: 'core',
        parentId: 'lesson-b',
      },
      {
        id: 'lesson-b',
        title: 'B',
        description: 'Secondo',
        isCompleted: false,
        type: 'core',
        parentId: 'lesson-a',
      },
      {
        id: 'lesson-c',
        title: 'C',
        description: 'Terzo',
        isCompleted: false,
        type: 'core',
      },
    ],
  };

  const groups = buildSidebarGroups(learningPlan, []);

  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0]?.sections.map(section => section.id), [
    'lesson-a',
    'lesson-b',
    'lesson-c',
  ]);
  assert.deepEqual(groups[0]?.sectionDepthById, {
    'lesson-a': 0,
    'lesson-b': 0,
    'lesson-c': 0,
  });
});

test('buildLesson image helpers keep only referenced assets', () => {
  const documentAssets: PdfDocumentAssets = {
    kind: 'pdf',
    parsedAt: '2026-03-20T10:00:00.000Z',
    imageCount: 2,
    usedImages: [
      {
        id: 'asset-1',
        mimeType: 'image/png',
        dataUrl: 'data:image/png;base64,AAA',
        textBefore: 'prima',
        textAfter: 'dopo',
        sourceOrder: 0,
      },
      {
        id: 'asset-2',
        mimeType: 'image/png',
        dataUrl: 'data:image/png;base64,BBB',
        textBefore: 'prima-2',
        textAfter: 'dopo-2',
        sourceOrder: 1,
      },
    ],
  };

  const imageRefs = [
    { assetId: 'asset-2', alt: 'seconda' },
    { assetId: 'asset-3', alt: 'mancante' },
  ];

  assert.deepEqual(Object.keys(buildLessonImageRefMap(imageRefs)), ['asset-2', 'asset-3']);
  assert.deepEqual(Object.keys(buildLessonAssetMap(imageRefs, documentAssets)), ['asset-2']);
});
