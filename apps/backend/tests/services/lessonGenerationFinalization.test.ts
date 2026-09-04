import { expect, test, vi } from 'vitest';

import type { GlobalModelConfig } from '../../src/config/modelConfig.js';
import { LessonGenerationCorrectionError } from '../../src/services/lessonGenerationCorrection.js';
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
  refreshResearch: false,
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

const pdfImageCandidate = () => ({
  caption: 'Figura pertinente',
  dataUrl: 'data:image/png;base64,AA==',
  id: 'pdf-img-candidate',
  mimeType: 'image/png',
  sourceOrder: 1,
  textAfter: '',
  textBefore: '',
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

test('durable verification rejects an unbalanced LaTeX environment left by the reviewer', async () => {
  const invalidDraft: LessonContentDraft = {
    contentBlocks: [
      {
        markdown:
          'Formula valida:\n\n$$\n\\begin{aligned}\nx&=1\\\\\ny&=2\n\\end{aligned}\n$$\n\nIl simbolo $\\begin{aligned}$ non è una formula valida.',
        type: 'markdown',
      },
    ],
    generatedVisuals: [],
    imageRefs: [],
  };

  const review = reviewLessonContentDraftStrict({
    draft: invalidDraft,
    generationInput: generationInput(),
    verify: vi.fn().mockResolvedValue(invalidDraft),
  });

  await expect(review).rejects.toBeInstanceOf(LessonGenerationCorrectionError);
  await expect(review).rejects.toMatchObject({
    code: 'lesson_review_latex_unbalanced',
    feedback: expect.stringContaining('every active LaTeX environment'),
  });
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

  const review = reviewLessonContentDraftStrict({
    draft,
    generationInput: generationInput(),
    verify: vi.fn().mockResolvedValue(invalidReviewedDraft),
  });

  await expect(review).rejects.toBeInstanceOf(LessonGenerationCorrectionError);
  await expect(review).rejects.toMatchObject({
    code: 'lesson_review_quiz_placement_invalid',
    feedback: expect.stringContaining('Every quiz must follow explanatory markdown'),
  });
});

test('durable verification accepts a quiz after explanatory markdown with media in between', async () => {
  const reviewedDraft: LessonContentDraft = {
    contentBlocks: [
      { markdown: '## Concetto\n\nSpiegazione necessaria per rispondere.', type: 'markdown' },
      { slotId: 'visual-concetto', type: 'generated-visual' },
      {
        clips: [{ endSeconds: 20, sourceIndex: 0, startSeconds: 10, title: 'Dimostrazione' }],
        type: 'youtube-clips',
      },
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
      draft: sourceFreeDraft(),
      generationInput: generationInput(),
      verify: vi.fn().mockResolvedValue(reviewedDraft),
    })
  ).resolves.toEqual(reviewedDraft);
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

test('normalization keeps a quiz when a generated visual follows its explanatory markdown', () => {
  const visualPlan = {
    altText: 'Schema del concetto',
    anchorHeading: 'Concetto',
    complexity: 'simple' as const,
    concept: 'Concetto',
    coverage: 'single_complex' as const,
    coverageRationale: 'Mostra il concetto.',
    factualRequirements: ['Vincolo'],
    interactionLevel: 'none' as const,
    pedagogicalGoal: 'Chiarire il concetto.',
    reason: 'Rende visibile la struttura.',
    requiresDepiction: false,
    slotId: 'visual-concetto',
    title: 'Schema del concetto',
    visualDirection: 'Diagramma semplice.',
    visualType: 'structural_svg' as const,
  };
  const result = normalizeLessonStructure({
    availableImages: [],
    draft: {
      contentBlocks: [
        { markdown: '## Concetto\n\nSpiegazione completa.', type: 'markdown' },
        { slotId: visualPlan.slotId, type: 'generated-visual' },
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
      generatedVisuals: [visualPlan],
      imageRefs: [],
    },
    generatedAt: '2026-08-14T00:00:00.000Z',
    sectionDescription: 'Descrizione.',
    sectionTitle: 'Concetto',
    sources: [],
    visualsBySlotId: new Map(),
  });

  expect(result.contentBlocks.map(block => block.type)).toEqual([
    'markdown',
    'generated-visual',
    'inline-quiz',
  ]);
  expect(result.quiz).toHaveLength(1);
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

test('PDF normalization places a selected image exactly once at its resolved heading', () => {
  const result = normalizeLessonStructure({
    availableImages: [pdfImageCandidate()],
    draft: {
      contentBlocks: [
        {
          markdown:
            '## Introduzione\n\nContesto.\n\n## Figura   {pertinente}\n\nConfronta i dettagli.',
          type: 'markdown',
        },
      ],
      generatedVisuals: [],
      imageRefs: [
        {
          alt: 'Figura pertinente',
          anchorHeading: 'Figura   {pertinente}',
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
  const placeholder =
    '{{PDF_IMAGE:pdf-img-candidate|alt=Figura pertinente|caption=Figura pertinente}}';
  expect(result.content.split(placeholder)).toHaveLength(2);
  expect(result.content).toContain(
    `## Figura   {pertinente}\n\n${placeholder}\n\nConfronta i dettagli.`
  );
  expect(result.contentBlocks).toEqual([
    {
      markdown: `## Introduzione\n\nContesto.\n\n## Figura   {pertinente}\n\n${placeholder}\n\nConfronta i dettagli.`,
      type: 'markdown',
    },
  ]);
});

test('PDF normalization rebuilds a pre-existing placeholder at the canonical anchor', () => {
  const result = normalizeLessonStructure({
    availableImages: [pdfImageCandidate()],
    draft: {
      contentBlocks: [
        {
          markdown:
            '{{PDF_IMAGE:pdf-img-candidate|alt=Set {A}|caption=Insieme {A}}} Testo preservato.\n\n## Figura\n\nConfronta i dettagli.',
          type: 'markdown',
        },
      ],
      generatedVisuals: [],
      imageRefs: [
        {
          alt: 'Figura {pertinente}',
          anchorHeading: 'Figura',
          assetId: 'pdf-img-candidate',
          caption: 'Insieme {A}',
        },
      ],
    },
    generatedAt: '2026-07-27T00:00:00.000Z',
    sectionDescription: 'Descrizione.',
    sectionTitle: 'Figura',
    sources: [],
    visualsBySlotId: new Map(),
  });

  expect(result.content.match(/\{\{PDF_IMAGE:/gu)).toHaveLength(1);
  expect(result.content).toContain(
    'Testo preservato.\n\n## Figura\n\n{{PDF_IMAGE:pdf-img-candidate|alt=Figura pertinente|caption=Insieme A}}\n\nConfronta i dettagli.'
  );
  expect(result.content).not.toContain('Set {A}');
  expect(result.content).not.toContain('Insieme {A}');
  expect(result.imageRefs).toEqual([
    {
      alt: 'Figura {pertinente}',
      anchorHeading: 'Figura',
      assetId: 'pdf-img-candidate',
      caption: 'Insieme {A}',
    },
  ]);
});

test('PDF normalization removes a closed pre-existing marker with unknown options', () => {
  const result = normalizeLessonStructure({
    availableImages: [{ ...pdfImageCandidate(), id: 'pdf-img' }],
    draft: {
      contentBlocks: [
        {
          markdown: '## Figura\n\n{{PDF_IMAGE:pdf-img|foo=bar}} Testo.',
          type: 'markdown',
        },
      ],
      generatedVisuals: [],
      imageRefs: [
        {
          alt: 'Figura pertinente',
          anchorHeading: 'Figura',
          assetId: 'pdf-img',
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

  expect(result.content.match(/\{\{PDF_IMAGE:/gu)).toHaveLength(1);
  expect(result.content).toContain(
    '## Figura\n\n{{PDF_IMAGE:pdf-img|alt=Figura pertinente|caption=Figura pertinente}}\n\n Testo.'
  );
  expect(result.content).not.toContain('foo=bar');
});

test('PDF normalization rejects an ambiguous image anchor instead of guessing placement', () => {
  expect(() =>
    normalizeLessonStructure({
      availableImages: [pdfImageCandidate()],
      draft: {
        contentBlocks: [
          {
            markdown: '## Figura\n\nPrima spiegazione.\n\n## Figura\n\nSeconda spiegazione.',
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
    })
  ).toThrow('Selected PDF image anchor must match exactly one Markdown heading.');
});

test.each([
  ['missing', '## Altro tema\n\nSpiegazione.'],
  [
    'ambiguous',
    '## Percezione motoria\n\nPrima spiegazione.\n\n## Percezione motoria\n\nSeconda spiegazione.',
  ],
])('PDF normalization omits an optional fallback with a %s anchor', (_case, markdown) => {
  const result = normalizeLessonStructure({
    availableImages: [
      {
        ...pdfImageCandidate(),
        caption: 'Schema della percezione motoria',
        textBefore: 'percezione motoria',
      },
    ],
    draft: {
      contentBlocks: [{ markdown, type: 'markdown' }],
      generatedVisuals: [],
      imageRefs: [],
    },
    generatedAt: '2026-07-27T00:00:00.000Z',
    sectionDescription: 'Comprendere la percezione motoria.',
    sectionTitle: 'Percezione motoria',
    sources: [],
    visualsBySlotId: new Map(),
  });

  expect(result.imageRefs).toEqual([]);
  expect(result.content).not.toContain('{{PDF_IMAGE:');
});

test('PDF normalization keeps placeable fallbacks while omitting only unplaceable ones', () => {
  const result = normalizeLessonStructure({
    availableImages: [
      {
        ...pdfImageCandidate(),
        caption: 'Percezione e controllo motorio',
        id: 'pdf-img-placeable',
        textBefore: 'percezione e controllo motorio',
      },
      {
        ...pdfImageCandidate(),
        caption: 'Memoria dichiarativa',
        id: 'pdf-img-unplaceable',
        sourceOrder: 2,
        textBefore: 'memoria dichiarativa',
      },
    ],
    draft: {
      contentBlocks: [{ markdown: '## Controllo motorio\n\nSpiegazione.', type: 'markdown' }],
      generatedVisuals: [],
      imageRefs: [],
    },
    generatedAt: '2026-07-27T00:00:00.000Z',
    sectionDescription: 'Memoria',
    sectionTitle: 'Percezione',
    sources: [],
    visualsBySlotId: new Map(),
  });

  expect(result.imageRefs.map(reference => reference.assetId)).toEqual(['pdf-img-placeable']);
  expect(result.content).toContain('{{PDF_IMAGE:pdf-img-placeable|');
  expect(result.content).not.toContain('pdf-img-unplaceable');
});

test('PDF normalization omits an unplaceable fallback after invalid draft references are discarded', () => {
  const result = normalizeLessonStructure({
    availableImages: [
      {
        ...pdfImageCandidate(),
        caption: 'Schema della percezione motoria',
        textBefore: 'percezione motoria',
      },
    ],
    draft: {
      contentBlocks: [{ markdown: '## Altro tema\n\nSpiegazione.', type: 'markdown' }],
      generatedVisuals: [],
      imageRefs: [
        {
          alt: 'Risorsa inesistente',
          anchorHeading: 'Altro tema',
          assetId: 'pdf-img-missing',
          caption: 'Risorsa inesistente',
        },
      ],
    },
    generatedAt: '2026-07-27T00:00:00.000Z',
    sectionDescription: 'Comprendere la percezione motoria.',
    sectionTitle: 'Percezione motoria',
    sources: [],
    visualsBySlotId: new Map(),
  });

  expect(result.imageRefs).toEqual([]);
  expect(result.content).not.toContain('{{PDF_IMAGE:');
});

test('PDF normalization still rejects a draft-selected image without an anchor', () => {
  expect(() =>
    normalizeLessonStructure({
      availableImages: [pdfImageCandidate()],
      draft: {
        contentBlocks: [{ markdown: '## Figura\n\nSpiegazione.', type: 'markdown' }],
        generatedVisuals: [],
        imageRefs: [
          {
            alt: 'Figura pertinente',
            anchorHeading: '',
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
    })
  ).toThrow('Selected PDF image is missing its Markdown heading anchor.');
});

test('PDF normalization ignores heading-like lines inside fenced and indented code', () => {
  const result = normalizeLessonStructure({
    availableImages: [pdfImageCandidate()],
    draft: {
      contentBlocks: [
        {
          markdown: [
            '```md',
            '## Figura',
            '```',
            '',
            '    ## Figura',
            '',
            '## Figura',
            '',
            'Spiegazione.',
          ].join('\n'),
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

  const placeholder =
    '{{PDF_IMAGE:pdf-img-candidate|alt=Figura pertinente|caption=Figura pertinente}}';
  expect(result.content.split(placeholder)).toHaveLength(2);
  expect(result.content).toContain(`    ## Figura\n\n## Figura\n\n${placeholder}`);
  expect(result.content).toContain('```md\n## Figura\n```');
});

test.each([
  'draft',
  'fallback',
] as const)('PDF normalization preserves fence state across Markdown blocks for a %s reference', imageRefSource => {
  const result = normalizeLessonStructure({
    availableImages: [
      {
        ...pdfImageCandidate(),
        caption: 'Schema della percezione motoria',
        textBefore: 'percezione motoria',
      },
    ],
    draft: {
      contentBlocks: [
        { markdown: '```md', type: 'markdown' },
        {
          markdown: '## Percezione motoria\n```\n\n## Percezione motoria\n\nSpiegazione.',
          type: 'markdown',
        },
      ],
      generatedVisuals: [],
      imageRefs:
        imageRefSource === 'draft'
          ? [
              {
                alt: 'Schema della percezione motoria',
                anchorHeading: 'Percezione motoria',
                assetId: 'pdf-img-candidate',
                caption: 'Percezione motoria',
              },
            ]
          : [],
    },
    generatedAt: '2026-07-27T00:00:00.000Z',
    sectionDescription: 'Comprendere la percezione motoria.',
    sectionTitle: 'Percezione motoria',
    sources: [],
    visualsBySlotId: new Map(),
  });

  expect(result.content.match(/\{\{PDF_IMAGE:/gu)).toHaveLength(1);
  expect(result.imageRefs).toHaveLength(1);
  const closingFenceIndex = result.content.indexOf('\n```');
  const realHeadingIndex = result.content.lastIndexOf('## Percezione motoria');
  const placeholderIndex = result.content.indexOf('{{PDF_IMAGE:');
  expect(result.content.slice(0, closingFenceIndex)).not.toContain('{{PDF_IMAGE:');
  expect(realHeadingIndex).toBeGreaterThan(closingFenceIndex);
  expect(placeholderIndex).toBeGreaterThan(realHeadingIndex);
});
