import { expect, test, vi } from 'vitest';

import { parsePdfContentParts } from '../../../web/utils/pdf/imagePlaceholders';
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

const normalizePdfDraft = (markdown: string, imageRefs: LessonContentDraft['imageRefs']) =>
  normalizeLessonStructure({
    availableImages: [pdfImageCandidate()],
    draft: {
      contentBlocks: [{ markdown, type: 'markdown' }],
      generatedVisuals: [],
      imageRefs,
    },
    generatedAt: '2026-07-27T00:00:00.000Z',
    sectionDescription: 'Descrizione.',
    sectionTitle: 'Figura',
    sources: [],
    visualsBySlotId: new Map(),
  });

const selectedPdfImage = () => ({
  alt: 'Figura pertinente',
  assetId: 'pdf-img-candidate',
  caption: 'Figura pertinente',
});

test.each([
  ['image without prose', '{{PDF_IMAGE:pdf-img-candidate}}', false],
  ['image with prose', 'Spiegazione.\n\n{{PDF_IMAGE:pdf-img-candidate}}', true],
])('quiz validation distinguishes %s at both generation boundaries', async (_case, markdown, valid) => {
  const draft: LessonContentDraft = {
    contentBlocks: [
      { markdown, type: 'markdown' },
      {
        type: 'inline-quiz',
        quiz: {
          question: 'Quale principio si applica?',
          options: ['A', 'B', 'C', 'D'],
          correctIndex: 0,
          exerciseType: 'application-card',
        },
      },
    ],
    generatedVisuals: [],
    imageRefs: [selectedPdfImage()],
  };
  const review = reviewLessonContentDraftStrict({
    draft,
    generationInput: generationInput(),
    verify: vi.fn(async () => draft),
  });
  if (valid) await expect(review).resolves.toEqual(draft);
  else await expect(review).rejects.toMatchObject({ code: 'lesson_review_quiz_placement_invalid' });

  const result = normalizeLessonStructure({
    availableImages: [pdfImageCandidate()],
    draft,
    generatedAt: '2026-07-27T00:00:00.000Z',
    sectionDescription: 'Descrizione.',
    sectionTitle: 'Figura',
    sources: [],
    visualsBySlotId: new Map(),
  });
  expect(result.quiz).toHaveLength(valid ? 1 : 0);
  expect(
    parsePdfContentParts(result.content, { 'pdf-img-candidate': pdfImageCandidate() }).some(
      part => part.type === 'image'
    )
  ).toBe(true);
});

test('PDF normalization preserves the model placeholder without a heading anchor', () => {
  const markdown = 'Spiegazione prima.\n\n{{PDF_IMAGE:pdf-img-candidate}}\n\nSpiegazione dopo.';
  const result = normalizePdfDraft(markdown, [selectedPdfImage()]);

  expect(result.content).toBe(markdown);
  expect(result.contentBlocks).toEqual([{ markdown, type: 'markdown' }]);
  expect(result.imageRefs.map(reference => reference.assetId)).toEqual(['pdf-img-candidate']);
  const reloaded = JSON.parse(JSON.stringify(result)) as typeof result;
  const parts = parsePdfContentParts(
    reloaded.content,
    { 'pdf-img-candidate': pdfImageCandidate() },
    Object.fromEntries(reloaded.imageRefs.map(reference => [reference.assetId, reference]))
  );
  expect(parts.map(part => part.type)).toEqual(['markdown', 'image', 'markdown']);
  expect(parts[1]).toMatchObject({ asset: { id: 'pdf-img-candidate' }, type: 'image' });
});

test('PDF normalization rejects a selected image missing from the generated text', () => {
  expect(() =>
    normalizePdfDraft('## Figura\n\nSpiegazione senza immagine.', [selectedPdfImage()])
  ).toThrow('Selected PDF image is missing its placeholder in lesson content.');
});

test.each([
  ['Markdown image', '![Diagramma]({{PDF_IMAGE:pdf-img-candidate}})'],
  ['HTML image', '<img src="{{PDF_IMAGE:pdf-img-candidate}}" alt="Diagramma" />'],
])('PDF normalization removes a %s wrapper without losing its placeholder', (_kind, wrapper) => {
  const result = normalizePdfDraft(`Prima.\n\n${wrapper}\n\nDopo.`, [selectedPdfImage()]);

  expect(result.content).toBe('Prima.\n\n{{PDF_IMAGE:pdf-img-candidate}}\n\nDopo.');
  expect(
    parsePdfContentParts(result.content, { 'pdf-img-candidate': pdfImageCandidate() }).map(
      part => part.type
    )
  ).toEqual(['markdown', 'image', 'markdown']);
});

test('PDF normalization stores accepted brace metadata in a reader-compatible format', () => {
  const result = normalizePdfDraft(
    'Prima.\n\n{{PDF_IMAGE:pdf-img-candidate|alt=Set {A}}}\n\nDopo.',
    [selectedPdfImage()]
  );
  const markdown = result.contentBlocks[0];
  if (markdown?.type !== 'markdown') throw new Error('Expected canonical Markdown content.');

  const parts = parsePdfContentParts(markdown.markdown, {
    'pdf-img-candidate': pdfImageCandidate(),
  });
  expect(parts.map(part => part.type)).toEqual(['markdown', 'image', 'markdown']);
  expect(parts[1]).toMatchObject({ alt: 'Set A', type: 'image' });
  expect(parts[2]).toMatchObject({ content: '\n\nDopo.', type: 'markdown' });
});

test.each([
  [
    '![x]({{PDF_IMAGE:pdf-img-candidate|caption=Grafico (A)}})',
    '{{PDF_IMAGE:pdf-img-candidate|caption=Grafico (A)}}',
  ],
  [
    '<img src="{{PDF_IMAGE:pdf-img-candidate|caption=A > B}}" />',
    '{{PDF_IMAGE:pdf-img-candidate|caption=A > B}}',
  ],
])('PDF normalization preserves metadata delimiters inside %s', (wrapper, placeholder) => {
  const result = normalizePdfDraft(`Prima.\n\n${wrapper}\n\nDopo.`, [selectedPdfImage()]);

  expect(result.content).toBe(`Prima.\n\n${placeholder}\n\nDopo.`);
  expect(
    parsePdfContentParts(result.content, { 'pdf-img-candidate': pdfImageCandidate() }).map(
      part => part.type
    )
  ).toEqual(['markdown', 'image', 'markdown']);
});

test('PDF normalization checks the selected asset rather than any placeholder', () => {
  expect(() => normalizePdfDraft('{{PDF_IMAGE:another-image}}', [selectedPdfImage()])).toThrow(
    'Selected PDF image is missing its placeholder in lesson content.'
  );
});

test('PDF normalization does not enforce occurrence counts or relocate legacy anchors', () => {
  const markdown =
    '{{PDF_IMAGE:pdf-img-candidate}}\n\n## Figura\n\nTesto.\n\n{{PDF_IMAGE:pdf-img-candidate}}';
  const result = normalizePdfDraft(markdown, [{ ...selectedPdfImage(), anchorHeading: 'Figura' }]);

  expect(result.content).toBe(markdown);
});

test('PDF normalization does not select or insert images the model did not choose', () => {
  const markdown = '## Figura pertinente\n\nFigura pertinente.';
  const result = normalizePdfDraft(markdown, []);

  expect(result.imageRefs).toEqual([]);
  expect(result.content).toBe(markdown);
});

test('PDF normalization keeps placeholders while sanitizing technical IDs in prose', () => {
  const result = normalizePdfDraft(
    'Risorsa pdf-img-candidate.\n\n{{PDF_IMAGE:pdf-img-candidate|alt=Figura pertinente}}',
    [selectedPdfImage()]
  );

  expect(result.content).toBe(
    'Risorsa "Figura pertinente".\n\n{{PDF_IMAGE:pdf-img-candidate|alt=Figura pertinente}}'
  );
});
