import { expect, test, vi } from 'vitest';

import type { GlobalModelConfig } from '../../src/config/modelConfig.js';
import {
  finalizeLessonContentDraft,
  type LessonContentDraft,
  type LessonGenerationInput,
  normalizeGeneratedLesson,
} from '../../src/services/lessonGenerationModel.js';

const generationInput = (): LessonGenerationInput => ({
  config: {} as GlobalModelConfig,
  description: 'Descrizione.',
  imageCandidates: [],
  instructionPacks: [],
  language: 'Italiano',
  pedagogicalContext: '',
  previousLessonTitles: [],
  researchContext: '',
  sectionTitle: 'Titolo',
  signal: new AbortController().signal,
  sourceContext: '',
  sources: [],
});

const sourceFreeDraft = (): LessonContentDraft => ({
  contentBlocks: [
    { markdown: '## Concetto\n\nSpiegazione completa.', type: 'markdown' },
    { markdown: '## Conclusione\n\nApplicazione conclusiva.', type: 'markdown' },
  ],
  generatedVisuals: [],
  imageRefs: [],
});

test('final verification failure keeps the original valid draft and still runs optional aids', async () => {
  const draft = sourceFreeDraft();
  const generateAids = vi.fn().mockResolvedValue([]);
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

  try {
    const result = await finalizeLessonContentDraft({
      draft,
      generateAids,
      generationInput: generationInput(),
      verify: vi.fn().mockRejectedValue(new Error('verification failed')),
    });

    expect(result.contentBlocks).toEqual(draft.contentBlocks);
    expect(result.imageRefs).toEqual([]);
    expect(result.learningAids).toEqual([]);
    expect(generateAids).toHaveBeenCalledOnce();
  } finally {
    warn.mockRestore();
  }
});

test('a source-free lesson remains valid without inline quizzes', async () => {
  const draft = sourceFreeDraft();
  const result = await finalizeLessonContentDraft({
    draft,
    generateAids: vi.fn().mockResolvedValue([]),
    generationInput: generationInput(),
    verify: vi.fn().mockResolvedValue(draft),
  });

  expect(result.contentBlocks).toEqual(draft.contentBlocks);
  expect(result.contentBlocks.some(block => block.type === 'inline-quiz')).toBe(false);
});

test('reports the verification stage before the verification provider runs', async () => {
  const draft = sourceFreeDraft();
  const events: string[] = [];

  await finalizeLessonContentDraft({
    draft,
    generateAids: vi.fn().mockResolvedValue([]),
    generationInput: {
      ...generationInput(),
      onProgressStage: async stage => {
        events.push(stage);
      },
    },
    verify: vi.fn(async () => {
      events.push('provider');
      return draft;
    }),
  });

  expect(events).toEqual(['verification', 'provider']);
});

test('an inline quiz must immediately follow explanatory markdown', async () => {
  const draft: LessonContentDraft = {
    contentBlocks: [
      { markdown: '## Concetto\n\nSpiegazione.', type: 'markdown' },
      { slotId: 'visual-concetto', type: 'generated-visual' },
      {
        quiz: {
          correctIndex: 0,
          exerciseType: 'application-card',
          options: ['A', 'B', 'C', 'D'],
          question: 'Applica il concetto.',
        },
        type: 'inline-quiz',
      },
    ],
    generatedVisuals: [],
    imageRefs: [],
  };

  await expect(
    finalizeLessonContentDraft({
      draft,
      generateAids: vi.fn().mockResolvedValue([]),
      generationInput: generationInput(),
      verify: vi.fn(),
    })
  ).rejects.toThrow('invalid typed inline quiz contract');
});

test('quiz cleanup unwraps whole-value backticks but preserves inline code fragments', () => {
  const result = normalizeGeneratedLesson(
    {
      contentBlocks: [
        { markdown: '## Coordinate\n\nSpiegazione sintetica.', type: 'markdown' },
        {
          quiz: {
            correctIndex: 0,
            exerciseType: 'application-card',
            options: [
              '`Posizione assoluta`',
              'Errore di `overflow`',
              '`Indice di shader`',
              '`UUID`',
            ],
            question: '`Quale valore resta espresso in metri?`',
          },
          type: 'inline-quiz',
        },
      ],
      generatedVisuals: [],
      imageRefs: [],
      learningAids: [],
    },
    {
      availableImages: [],
      jobId: 'job-quiz-cleanup',
      project: {
        createdAt: '2026-07-27T00:00:00.000Z',
        id: 'project-quiz-cleanup',
        lastOpenedAt: '2026-07-27T00:00:00.000Z',
        updatedAt: '2026-07-27T00:00:00.000Z',
        version: '4.1',
      },
      renderedVisualsBySlotId: new Map(),
      sectionDescription: 'Coordinate nello spazio.',
      sectionTitle: 'Coordinate',
      sources: [],
    }
  );

  expect(result.quiz[0]).toEqual({
    correctIndex: 0,
    exerciseType: 'application-card',
    options: ['Posizione assoluta', 'Errore di `overflow`', 'Indice di shader', 'UUID'],
    question: 'Quale valore resta espresso in metri?',
  });
});

test('normalization removes a quiz when image cleanup removes its explanatory markdown', () => {
  const result = normalizeGeneratedLesson(
    {
      contentBlocks: [
        { markdown: '## Introduzione\n\nContesto precedente.', type: 'markdown' },
        { markdown: '![Figura](https://example.com/figure.png)', type: 'markdown' },
        {
          quiz: {
            correctIndex: 0,
            exerciseType: 'application-card',
            options: ['A', 'B', 'C', 'D'],
            question: 'Quale principio mostra la figura?',
          },
          type: 'inline-quiz',
        },
      ],
      generatedVisuals: [],
      imageRefs: [],
      learningAids: [],
    },
    {
      availableImages: [],
      jobId: 'job-quiz-without-context',
      project: {
        createdAt: '2026-07-27T00:00:00.000Z',
        id: 'project-quiz-without-context',
        lastOpenedAt: '2026-07-27T00:00:00.000Z',
        updatedAt: '2026-07-27T00:00:00.000Z',
        version: '4.1',
      },
      renderedVisualsBySlotId: new Map(),
      sectionDescription: 'Descrizione.',
      sectionTitle: 'Figura',
      sources: [],
    }
  );

  expect(result.contentBlocks).toEqual([
    { markdown: '## Introduzione\n\nContesto precedente.', type: 'markdown' },
  ]);
  expect(result.quiz).toEqual([]);
});

test('PDF metadata counts the full extracted inventory without selecting rejected images', () => {
  const candidate = {
    caption: 'Figura pertinente',
    dataUrl: 'data:image/png;base64,AA==',
    id: 'pdf-img-candidate',
    mimeType: 'image/png',
    sourceOrder: 1,
    textAfter: '',
    textBefore: '',
  };
  const rejected = {
    ...candidate,
    caption: undefined,
    id: 'rejected',
    sourceOrder: 2,
  };
  const result = normalizeGeneratedLesson(
    {
      contentBlocks: [
        {
          markdown: '## Figura\n\nOsserva pdf-img-candidate per confrontare i dettagli.',
          type: 'markdown',
        },
      ],
      generatedVisuals: [],
      imageRefs: [
        {
          alt: 'Figura pertinente',
          anchorHeading: 'Figura',
          assetId: 'pdf-img-candidate',
          caption: 'Figura pertinente',
        },
      ],
      learningAids: [],
    },
    {
      availableImages: [candidate],
      documentImages: [candidate, rejected],
      jobId: 'job-image-inventory',
      project: {
        createdAt: '2026-07-27T00:00:00.000Z',
        id: 'project-image-inventory',
        lastOpenedAt: '2026-07-27T00:00:00.000Z',
        updatedAt: '2026-07-27T00:00:00.000Z',
        version: '4.1',
      },
      renderedVisualsBySlotId: new Map(),
      sectionDescription: 'Descrizione.',
      sectionTitle: 'Figura',
      sources: [],
    }
  );

  expect(result.imageRefs.map(reference => reference.assetId)).toEqual(['pdf-img-candidate']);
  expect(result.content).toContain('"Figura pertinente"');
  expect(result.content).not.toContain('pdf-img-candidate');
  expect(result.documentAssets).toMatchObject({ imageCount: 2 });
});
