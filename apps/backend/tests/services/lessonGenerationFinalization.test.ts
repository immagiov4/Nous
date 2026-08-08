import { expect, test, vi } from 'vitest';

import type { GlobalModelConfig } from '../../src/config/modelConfig.js';
import {
  type LessonContentDraft,
  type LessonGenerationInput,
  reviewLessonContentDraftStrict,
} from '../../src/services/lessonGenerationModel.js';
import { normalizeLessonStructure } from '../../src/services/lessonGenerationNormalization.js';

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

test('durable verification propagates provider failure instead of approving an unreviewed draft', async () => {
  const draft = sourceFreeDraft();

  await expect(
    reviewLessonContentDraftStrict({
      draft,
      generationInput: generationInput(),
      verify: vi.fn().mockRejectedValue(new Error('verification failed')),
    })
  ).rejects.toThrow('verification failed');
});

test('durable verification can repair an invalid initial quiz placement', async () => {
  const invalidDraft: LessonContentDraft = {
    contentBlocks: [
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
  const repairedDraft = sourceFreeDraft();
  const verify = vi.fn().mockResolvedValue(repairedDraft);

  await expect(
    reviewLessonContentDraftStrict({
      draft: invalidDraft,
      generationInput: generationInput(),
      verify,
    })
  ).resolves.toEqual(repairedDraft);
  expect(verify).toHaveBeenCalledOnce();
});

test('durable verification rejects an invalid reviewed quiz instead of approving the lesson', async () => {
  const draft = sourceFreeDraft();
  const invalidReviewedDraft: LessonContentDraft = {
    contentBlocks: [
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
    reviewLessonContentDraftStrict({
      draft,
      generationInput: generationInput(),
      verify: vi.fn().mockResolvedValue(invalidReviewedDraft),
    })
  ).rejects.toThrow('Verified lesson has an invalid typed inline quiz contract.');
});

test('a source-free lesson remains valid without inline quizzes', async () => {
  const draft = sourceFreeDraft();
  const result = await reviewLessonContentDraftStrict({
    draft,
    generationInput: generationInput(),
    verify: vi.fn().mockResolvedValue(draft),
  });

  expect(result.contentBlocks).toEqual(draft.contentBlocks);
  expect(result.contentBlocks.some(block => block.type === 'inline-quiz')).toBe(false);
});

test('quiz cleanup unwraps whole-value backticks but preserves inline code fragments', () => {
  const result = normalizeLessonStructure({
    availableImages: [],
    draft: {
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
    },
    generatedAt: '2026-07-27T00:00:00.000Z',
    sectionDescription: 'Coordinate nello spazio.',
    sectionTitle: 'Coordinate',
    sources: [],
    visualsBySlotId: new Map(),
  });

  expect(result.quiz[0]).toEqual({
    correctIndex: 0,
    exerciseType: 'application-card',
    options: ['Posizione assoluta', 'Errore di `overflow`', 'Indice di shader', 'UUID'],
    question: 'Quale valore resta espresso in metri?',
  });
});

test('normalization removes a quiz when image cleanup removes its explanatory markdown', () => {
  const result = normalizeLessonStructure({
    availableImages: [],
    draft: {
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
    },
    generatedAt: '2026-07-27T00:00:00.000Z',
    sectionDescription: 'Descrizione.',
    sectionTitle: 'Figura',
    sources: [],
    visualsBySlotId: new Map(),
  });

  expect(result.contentBlocks).toEqual([
    { markdown: '## Introduzione\n\nContesto precedente.', type: 'markdown' },
  ]);
  expect(result.quiz).toEqual([]);
});

test('PDF normalization keeps only referenced images and hides internal asset ids', () => {
  const candidate = {
    caption: 'Figura pertinente',
    dataUrl: 'data:image/png;base64,AA==',
    id: 'pdf-img-candidate',
    mimeType: 'image/png',
    sourceOrder: 1,
    textAfter: '',
    textBefore: '',
  };
  const result = normalizeLessonStructure({
    availableImages: [candidate],
    draft: {
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
    },
    generatedAt: '2026-07-27T00:00:00.000Z',
    sectionDescription: 'Descrizione.',
    sectionTitle: 'Figura',
    sources: [],
    visualsBySlotId: new Map(),
  });

  expect(result.imageRefs.map(reference => reference.assetId)).toEqual(['pdf-img-candidate']);
  expect(result.content).toContain('"Figura pertinente"');
  expect(result.content).not.toContain('pdf-img-candidate');
});
