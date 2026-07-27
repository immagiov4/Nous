import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  buildVisibleImageLabel,
  injectImagePlaceholders,
} from '../../../services/openrouter/lessonImages.ts';
import {
  buildPdfChunkUsageDebugPayload,
  dedupeLearningPlanSections,
  estimateRelevantPdfImagePages,
  estimateTargetQuizCount,
  LESSON_RESPONSE_SCHEMA,
  resolvePlanningSourceProfileFromSeed,
} from '../../../services/openrouter/planning/index.ts';
import type { PdfTextIndex } from '../../../types.ts';

test('resolvePlanningSourceProfileFromSeed keeps short PDFs compact and allows a single lesson', () => {
  const profile = resolvePlanningSourceProfileFromSeed({
    kind: 'pdf',
    pageCount: 5,
  });

  assert.equal(profile.sizeTier, 'tiny');
  assert.equal(profile.allowSingleLesson, true);
  assert.equal(profile.summaryLessonOptional, true);
  assert.deepEqual(profile.moduleCount, { min: 1, max: 2 });
  assert.deepEqual(profile.lessonCount, { min: 1, max: 3 });
});

test('dedupeLearningPlanSections merges overlapping adjacent lessons for compact sources', () => {
  const deduped = dedupeLearningPlanSections(
    [
      {
        id: 'section-1',
        moduleTitle: 'Fondamenti quantistici',
        title: 'Effetto fotoelettrico',
        description:
          'Spiega il fenomeno fotoelettrico, la soglia di frequenza e il legame tra energia del fotone ed emissione elettronica.',
        type: 'core',
        isCompleted: false,
      },
      {
        id: 'section-2',
        moduleTitle: 'Fondamenti quantistici',
        title: 'Fenomeno fotoelettrico',
        description:
          'Descrive lo stesso meccanismo di emissione elettronica, la soglia di frequenza e la relazione tra energia del fotone e elettroni emessi.',
        type: 'core',
        isCompleted: false,
      },
      {
        id: 'section-3',
        moduleTitle: 'Fondamenti quantistici',
        title: 'Interpretazione di Einstein',
        description:
          'Collega il fenomeno all ipotesi dei quanti di luce e mostra perche il modello ondulatorio classico non basta.',
        type: 'core',
        isCompleted: false,
      },
    ],
    { sizeTier: 'small' }
  );

  assert.equal(deduped.length, 2);
  assert.match(deduped[0]?.title || '', /fotoelettric/i);
  assert.equal(deduped[1]?.title, 'Interpretazione di Einstein');
});

test('dedupeLearningPlanSections stays conservative on larger sources', () => {
  const deduped = dedupeLearningPlanSections(
    [
      {
        id: 'section-1',
        moduleTitle: 'Fondamenti quantistici',
        title: 'Effetto fotoelettrico',
        description:
          'Spiega il fenomeno fotoelettrico, la soglia di frequenza e il legame tra energia del fotone ed emissione elettronica.',
        type: 'core',
        isCompleted: false,
      },
      {
        id: 'section-2',
        moduleTitle: 'Fondamenti quantistici',
        title: 'Fenomeno fotoelettrico',
        description:
          'Descrive lo stesso meccanismo di emissione elettronica, la soglia di frequenza e la relazione tra energia del fotone e elettroni emessi.',
        type: 'core',
        isCompleted: false,
      },
    ],
    { sizeTier: 'large' }
  );

  assert.equal(deduped.length, 2);
});

test('LESSON_RESPONSE_SCHEMA marks all image placement keys as required for strict json schema', () => {
  const imagePlacementSchema = (
    (LESSON_RESPONSE_SCHEMA.schema as { properties: Record<string, unknown> }).properties
      .imagePlacements as {
      items: {
        properties: Record<string, unknown>;
        required: string[];
      };
    }
  ).items;

  assert.deepEqual(imagePlacementSchema.required, ['assetId', 'alt', 'caption', 'anchorHeading']);
  assert.deepEqual(imagePlacementSchema.properties.caption, {
    type: ['string', 'null'],
  });
  assert.deepEqual(imagePlacementSchema.properties.anchorHeading, {
    type: ['string', 'null'],
  });
});

test('LESSON_RESPONSE_SCHEMA gives every typed-block discriminator an explicit string type', () => {
  const contentBlockVariants = (
    (LESSON_RESPONSE_SCHEMA.schema as { properties: Record<string, unknown> }).properties
      .contentBlocks as {
      items: {
        anyOf: Array<{ properties: { type: Record<string, unknown> } }>;
      };
    }
  ).items.anyOf;

  assert.deepEqual(
    contentBlockVariants.map(variant => variant.properties.type),
    [
      { type: 'string', const: 'markdown' },
      { type: 'string', const: 'inline-quiz' },
      { type: 'string', const: 'youtube-clips' },
      { type: 'string', const: 'generated-visual' },
    ]
  );
});

test('estimateTargetQuizCount scales pauses conservatively with lesson density', () => {
  const shortLesson = `## Concetto\n\nBreve spiegazione tecnica focalizzata su un solo punto.\n\nUna conseguenza pratica.`;
  const mediumLesson = `## Concetto\n\n${'Spiegazione tecnica mirata. '.repeat(80)}\n\n## Applicazione\n\n${'Caso d uso e implicazioni operative. '.repeat(60)}`;
  const longLesson = `## Parte 1\n\n${'Dettaglio tecnico e conseguenze operative. '.repeat(110)}\n\n## Parte 2\n\n${'Analisi di vincoli, errori tipici e mitigazioni. '.repeat(110)}\n\n## Parte 3\n\n${'Collegamento con processi, monitoraggio e recupero. '.repeat(110)}`;

  assert.equal(estimateTargetQuizCount(shortLesson), 1);
  assert.equal(estimateTargetQuizCount(mediumLesson), 2);
  assert.equal(estimateTargetQuizCount(longLesson), 3);
});

test('estimateTargetQuizCount ignores structural inline quiz markers', () => {
  const lesson = '## Concetto\n\nUna spiegazione breve e focalizzata.';
  const lessonWithMarkers = `${lesson}\n\n{{INLINE_QUIZ:0}}\n\n{{INLINE_QUIZ:1}}\n\n{{INLINE_QUIZ:2}}`;

  assert.equal(estimateTargetQuizCount(lessonWithMarkers), estimateTargetQuizCount(lesson));
});

test('estimateRelevantPdfImagePages focuses extraction around the mapped chunk positions', () => {
  const documentIndex: PdfTextIndex = {
    kind: 'pdf-text-index',
    parsedAt: '2026-04-03T00:00:00.000Z',
    sourceHash: 'hash-1',
    chunks: [
      {
        id: 'chunk-001',
        text: 'Intro',
        headingPath: ['Intro'],
        sequence: 0,
        startOffset: 0,
        endOffset: 100,
      },
      {
        id: 'chunk-002',
        text: 'Middle',
        headingPath: ['Middle'],
        sequence: 1,
        startOffset: 100,
        endOffset: 200,
      },
      {
        id: 'chunk-003',
        text: 'Advanced',
        headingPath: ['Advanced'],
        sequence: 2,
        startOffset: 200,
        endOffset: 300,
      },
    ],
  };

  assert.deepEqual(
    estimateRelevantPdfImagePages(documentIndex, ['chunk-002'], 30),
    [9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22]
  );
  assert.deepEqual(
    estimateRelevantPdfImagePages(documentIndex, ['chunk-003'], 30),
    [19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30]
  );
});

test('estimateRelevantPdfImagePages uses exact page text mapping when page offsets are available', () => {
  const documentIndex: PdfTextIndex = {
    kind: 'pdf-text-index',
    parsedAt: '2026-04-03T00:00:00.000Z',
    sourceHash: 'hash-1',
    chunks: [
      {
        id: 'chunk-001',
        text: 'Intro',
        headingPath: ['Intro'],
        sequence: 0,
        startOffset: 0,
        endOffset: 8,
      },
      {
        id: 'chunk-002',
        text: 'Decal systems',
        headingPath: ['Effects', 'Decal systems'],
        sequence: 1,
        startOffset: 10,
        endOffset: 29,
      },
      {
        id: 'chunk-003',
        text: 'Camera ambient occlusion',
        headingPath: ['Effects', 'Ambient occlusion'],
        sequence: 2,
        startOffset: 31,
        endOffset: 61,
      },
    ],
  };

  assert.deepEqual(
    estimateRelevantPdfImagePages(documentIndex, ['chunk-002'], 40, [
      { pageNumber: 10, text: 'Intro' },
      { pageNumber: 11, text: 'Decal systems' },
      { pageNumber: 12, text: 'Camera ambient occlusion' },
    ]),
    [9, 10, 11, 12, 13, 14]
  );
});

test('buildPdfChunkUsageDebugPayload reports exact prompt chunk ranges when page text is available', () => {
  const documentIndex: PdfTextIndex = {
    kind: 'pdf-text-index',
    parsedAt: '2026-04-03T00:00:00.000Z',
    sourceHash: 'hash-1',
    chunks: [
      {
        id: 'chunk-001',
        text: 'Intro',
        headingPath: ['Intro'],
        sequence: 0,
        startOffset: 0,
        endOffset: 100,
      },
      {
        id: 'chunk-002',
        text: 'Middle',
        headingPath: ['Chapter 1', 'Middle'],
        sequence: 1,
        startOffset: 100,
        endOffset: 200,
        pageStart: 10,
        pageEnd: 10,
      },
      {
        id: 'chunk-003',
        text: 'Advanced',
        headingPath: ['Chapter 2', 'Advanced'],
        sequence: 2,
        startOffset: 200,
        endOffset: 300,
        pageStart: 11,
        pageEnd: 11,
      },
      {
        id: 'chunk-004',
        text: 'Appendix',
        headingPath: ['Appendix'],
        sequence: 3,
        startOffset: 300,
        endOffset: 400,
        pageStart: 12,
        pageEnd: 12,
      },
    ],
  };

  const payload = buildPdfChunkUsageDebugPayload(
    'Pipeline di rendering',
    documentIndex,
    ['chunk-003'],
    40,
    [10, 11, 12, 13, 14],
    [
      { pageNumber: 10, text: 'Middle' },
      { pageNumber: 11, text: 'Advanced' },
      { pageNumber: 12, text: 'Appendix' },
    ]
  );

  assert.ok(payload);
  assert.equal(payload?.promptContextPageRange, 'pag. 10-12');
  assert.equal(payload?.targetedImagePages, 'pag. 10-14');
  assert.deepEqual(payload?.primaryChunkIds, ['chunk-003']);
  assert.equal(payload?.pageMappingMode, 'exact-from-page-text');
  assert.deepEqual(payload?.promptContextChunkIds, ['chunk-002', 'chunk-003', 'chunk-004']);
  assert.deepEqual(payload?.primaryChunks, [
    {
      id: 'chunk-003',
      sequence: 2,
      headingPath: 'Chapter 2 > Advanced',
      pageRange: 'pag. 11',
      pageRangeSource: 'exact',
    },
  ]);
});

test('injectImagePlaceholders places figures after the first local explanation block', () => {
  const content = [
    '## Compressione parallela',
    '',
    'Il paragrafo introduce cosa guardare nella figura: il segnale dry resta leggibile mentre il canale compresso aggiunge densita.',
    '',
    'Questo testo continua dopo la figura.',
  ].join('\n');

  const result = injectImagePlaceholders(content, [
    {
      assetId: 'pdf-img-001',
      alt: 'Schema della compressione parallela',
      caption: 'Percorso dry e compresso affiancati',
      anchorHeading: 'Compressione parallela',
    },
  ]);

  assert.match(
    result,
    /densita\.\n\n\{\{PDF_IMAGE:pdf-img-001\|alt=Schema della compressione parallela\|caption=Percorso dry e compresso affiancati\}\}\n\nQuesto testo continua/
  );
});

test('buildVisibleImageLabel keeps only the first meaningful clause from PDF captions', () => {
  const label = buildVisibleImageLabel(
    {
      id: 'pdf-img-001',
      caption: 'La pipeline del rendering: passaggio completo. Dettaglio extra.',
      dataUrl: 'data:image/png;base64,AAA',
      mimeType: 'image/png',
      textBefore: '',
      textCurrent: '',
      textAfter: '',
      sourceOrder: 1,
      pageNumber: 7,
    },
    'Rendering',
    'Panoramica del flusso'
  );

  assert.equal(label, 'pipeline del rendering');
});
