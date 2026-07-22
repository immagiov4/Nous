import assert from 'node:assert/strict';
import { test, vi } from 'vitest';
import type { FileData, LessonLearningAid, PdfTextIndex, QuizQuestion } from '../../../types.ts';
import { hasExactInlineQuizMarkerContract } from '../../../utils/reader/inlineQuiz.ts';

const callOpenRouterMock = vi.fn();
const retryWithBackoffMock = vi.fn(async (operation: () => Promise<string>) => await operation());
const getPdfTextSessionMock = vi.fn();
const getPdfAssetSessionMock = vi.fn();
const generateLessonVisualExampleMock = vi.fn();
const generateLessonLearningAidsMock = vi.fn(
  async (_options: {
    contentMarkdown: string;
    sectionDescription: string;
    sectionTitle: string;
  }): Promise<LessonLearningAid[]> => []
);
const buildStoredPdfDocumentAssetsMock = vi.fn((session, imageRefs) => ({
  kind: 'pdf' as const,
  parsedAt: session.parsedAt,
  imageCount: session.images.length,
  sourceHash: session.sourceHash,
  usedImages: session.images.filter((image: { id: string }) =>
    imageRefs.some((ref: { assetId: string }) => ref.assetId === image.id)
  ),
}));

vi.mock('../../../services/openrouter/pdfAssets.ts', () => ({
  getPdfTextSession: getPdfTextSessionMock,
  getPdfAssetSession: getPdfAssetSessionMock,
  buildStoredPdfDocumentAssets: buildStoredPdfDocumentAssetsMock,
}));

vi.mock('../../../services/openrouter/visualExamples.ts', async importOriginal => {
  const actual =
    await importOriginal<typeof import('../../../services/openrouter/visualExamples.ts')>();
  return {
    ...actual,
    generateLessonVisualExample: generateLessonVisualExampleMock,
  };
});

vi.mock('../../../services/openrouter/learningAids.ts', () => ({
  generateLessonLearningAids: generateLessonLearningAidsMock,
}));

vi.mock('../../../services/openrouter/shared.ts', async importOriginal => {
  const actual = await importOriginal<typeof import('../../../services/openrouter/shared.ts')>();
  return {
    ...actual,
    MODEL_FLASH: 'flash-model',
    MODEL_REASONING: 'reasoning-model',
    callOpenRouter: callOpenRouterMock,
    retryWithBackoff: retryWithBackoffMock,
    isPdfFile: (file: FileData) => file.mimeType === 'application/pdf',
    teacherInstruction: 'Teacher',
  };
});

const { generateSectionContent } = await import('../../../services/openrouter/planning/index.ts');

const buildQuiz = (): QuizQuestion[] =>
  Array.from({ length: 2 }, (_, index) => ({
    question: `Domanda ${index + 1}`,
    options: ['A', 'B', 'C', 'D'],
    correctIndex: 0,
  }));

test('generateSectionContent keeps all verified image placements instead of truncating them with a per-lesson cap', async () => {
  callOpenRouterMock.mockReset();
  retryWithBackoffMock.mockClear();
  getPdfTextSessionMock.mockReset();
  getPdfAssetSessionMock.mockReset();
  generateLessonVisualExampleMock.mockReset();
  generateLessonLearningAidsMock.mockReset();
  generateLessonLearningAidsMock.mockResolvedValue([
    {
      id: 'learning-aid-definition-decal',
      kind: 'definition',
      title: 'Decal',
      content: 'Texture proiettata su una superficie.',
      anchorHeading: 'Decal',
    },
  ]);
  buildStoredPdfDocumentAssetsMock.mockClear();

  const quiz = buildQuiz();
  const bulkyBlocks = [
    { type: 'markdown', markdown: `## Decal\n\n${'Spiegazione tecnica sui decal. '.repeat(60)}` },
    { type: 'inline-quiz', quiz: quiz[0] },
    {
      type: 'markdown',
      markdown: `## Overlay\n\n${'Spiegazione tecnica sugli overlay. '.repeat(60)}`,
    },
    { type: 'inline-quiz', quiz: quiz[1] },
  ];
  const repairedBlocks = [
    ...bulkyBlocks,
    { type: 'markdown', markdown: '## Conclusione\n\nChiusura pulita.' },
  ];

  const imagePlacements = [
    { assetId: 'pdf-img-001', alt: 'Schema 1', caption: 'Figura 1', anchorHeading: 'Decal' },
    { assetId: 'pdf-img-002', alt: 'Schema 2', caption: 'Figura 2', anchorHeading: 'Decal' },
    { assetId: 'pdf-img-003', alt: 'Schema 3', caption: 'Figura 3', anchorHeading: 'Decal' },
    { assetId: 'pdf-img-004', alt: 'Schema 4', caption: 'Figura 4', anchorHeading: 'Decal' },
  ];

  callOpenRouterMock
    .mockResolvedValueOnce(
      JSON.stringify({
        contentBlocks: bulkyBlocks,
        imagePlacements,
        visualPlanning: { plans: [], rationale: 'Nessun visuale.' },
      })
    )
    .mockResolvedValueOnce(
      JSON.stringify({
        contentBlocks: repairedBlocks,
        imagePlacements,
        visualPlanning: { plans: [], rationale: 'Nessun visuale.' },
      })
    );

  const file: FileData = {
    name: 'Game_Engine_Architecture-en.pdf',
    mimeType: 'application/pdf',
    data: 'unused',
  };

  const documentIndex: PdfTextIndex = {
    kind: 'pdf-text-index',
    parsedAt: '2026-04-03T00:00:00.000Z',
    sourceHash: 'hash-1',
    pageCount: 20,
    chunks: [
      {
        id: 'chunk-001',
        text: 'Decal e overlay',
        headingPath: ['Rendering', 'Decal'],
        sequence: 0,
        startOffset: 0,
        endOffset: 200,
        pageStart: 5,
        pageEnd: 5,
      },
    ],
  };

  const pdfTextSession = {
    images: [],
    extractedText: 'Estratto PDF sulle decal.',
    pages: [{ pageNumber: 5, text: 'Page 5: decals, overlays, projected textures.' }],
    pageCount: 20,
    parsedAt: '2026-04-03T00:00:00.000Z',
    sourceHash: 'hash-1',
  };

  const pdfAssetSession = {
    ...pdfTextSession,
    images: [
      {
        id: 'pdf-img-001',
        mimeType: 'image/png',
        dataUrl: 'data:image/png;base64,AAAA',
        caption: 'Schema dei decal proiettati',
        textBefore: 'Schema dei decal proiettati',
        textAfter: 'overlay sul muro',
        sourceOrder: 1,
        pageNumber: 5,
        intrinsicWidth: 1280,
        intrinsicHeight: 720,
        sizeBytes: 84_000,
      },
      {
        id: 'pdf-img-002',
        mimeType: 'image/png',
        dataUrl: 'data:image/png;base64,BBBB',
        caption: 'Figura sugli overlay di materiale',
        textBefore: 'Figura sugli overlay di materiale',
        textAfter: 'decal layering',
        sourceOrder: 2,
        pageNumber: 5,
      },
      {
        id: 'pdf-img-003',
        mimeType: 'image/png',
        dataUrl: 'data:image/png;base64,CCCC',
        caption: 'Diagramma di blending dei decal',
        textBefore: 'Diagramma di blending dei decal',
        textAfter: 'render target',
        sourceOrder: 3,
        pageNumber: 5,
      },
      {
        id: 'pdf-img-004',
        mimeType: 'image/png',
        dataUrl: 'data:image/png;base64,DDDD',
        caption: 'Overlay e mask per decal',
        textBefore: 'Overlay e mask per decal',
        textAfter: 'material response',
        sourceOrder: 4,
        pageNumber: 5,
      },
    ],
  };

  getPdfTextSessionMock.mockResolvedValue(pdfTextSession);
  getPdfAssetSessionMock.mockResolvedValue(pdfAssetSession);

  const result = await generateSectionContent({
    documentIndex,
    file,
    previousContext: 'Contesto precedente',
    primaryChunkIds: ['chunk-001'],
    sectionDescription: 'Uso di decal, overlay e layering dei materiali',
    sectionTitle: 'Decal e overlay',
    supplementalSourceContext: 'Fonte web: https://example.com/rendering-update',
  });

  assert.equal(callOpenRouterMock.mock.calls.length, 2);
  assert.equal(callOpenRouterMock.mock.calls[0]?.[0]?.model, 'reasoning-model');
  assert.equal(callOpenRouterMock.mock.calls[1]?.[0]?.model, 'flash-model');
  assert.deepEqual(callOpenRouterMock.mock.calls[0]?.[0]?.reasoning, {
    effort: 'medium',
    exclude: false,
  });
  assert.deepEqual(callOpenRouterMock.mock.calls[1]?.[0]?.reasoning, {
    effort: 'medium',
    exclude: false,
  });
  assert.match(
    String(callOpenRouterMock.mock.calls[0]?.[0]?.messages?.[1]?.content || ''),
    /https:\/\/example\.com\/rendering-update/
  );
  assert.match(
    String(callOpenRouterMock.mock.calls[0]?.[0]?.messages?.[1]?.content || ''),
    /blocco `youtube-clips` nel punto editoriale esatto/i
  );
  assert.match(
    String(callOpenRouterMock.mock.calls[1]?.[0]?.messages?.[1]?.content || ''),
    /descrizione, caption, immagine e paragrafo vicino siano abbinati/i
  );
  assert.doesNotMatch(
    String(callOpenRouterMock.mock.calls[0]?.[0]?.messages?.[1]?.content || ''),
    /sourceContext(Current|Before|After)/i
  );
  assert.match(
    String(callOpenRouterMock.mock.calls[0]?.[0]?.messages?.[1]?.content || ''),
    /"intrinsicWidth": 1280[\s\S]*"intrinsicHeight": 720[\s\S]*"aspectRatio": 1\.7777777777777777[\s\S]*"sizeBytes": 84000/
  );
  assert.doesNotMatch(
    String(callOpenRouterMock.mock.calls[2]?.[0]?.messages?.[1]?.content || ''),
    /sourceContext(Current|Before|After)/i
  );
  assert.equal(result.imageRefs.length, 4);
  assert.deepEqual(
    result.imageRefs.map(ref => ref.assetId),
    ['pdf-img-001', 'pdf-img-002', 'pdf-img-003', 'pdf-img-004']
  );
  assert.equal(result.quiz.length, 2);
  assert.equal(result.learningAids.length, 1);
  const learningAidRequest = generateLessonLearningAidsMock.mock.calls[0]?.[0];
  assert.equal(
    learningAidRequest?.sectionDescription,
    'Uso di decal, overlay e layering dei materiali'
  );
  assert.equal(learningAidRequest?.sectionTitle, 'Decal e overlay');
  assert.match(String(learningAidRequest?.contentMarkdown ?? ''), /## Decal/);
  assert.match(String(learningAidRequest?.contentMarkdown ?? ''), /## Conclusione/);
  assert.match(result.content, /\{\{PDF_IMAGE:pdf-img-004/);
});

test('generateSectionContent excludes unclear PDF images when the vision pass produced no usable caption', async () => {
  callOpenRouterMock.mockReset();
  retryWithBackoffMock.mockClear();
  getPdfTextSessionMock.mockReset();
  getPdfAssetSessionMock.mockReset();
  generateLessonVisualExampleMock.mockReset();
  buildStoredPdfDocumentAssetsMock.mockClear();
  generateLessonVisualExampleMock.mockResolvedValue(null);

  const markdown =
    '## Caso concreto\n\nSpiegazione tecnica focalizzata sul confronto fragile.\n\n{{INLINE_QUIZ:0}}\n\nUn secondo passaggio applica il confronto.\n\n{{INLINE_QUIZ:1}}';
  const repairedMarkdown = `${markdown}\n\n## Conclusione\n\nChiusura.`;
  const verifiedMarkdown =
    '## Caso concreto\n\nSpiegazione tecnica focalizzata sul confronto fragile.\n\n{{INLINE_QUIZ:0}}\n\n## Conclusione\n\nChiusura.';
  const quiz = buildQuiz();

  callOpenRouterMock
    .mockResolvedValueOnce(
      JSON.stringify({
        contentMarkdown: markdown,
        quiz,
        imagePlacements: [],
      })
    )
    .mockResolvedValueOnce(repairedMarkdown)
    .mockResolvedValueOnce(
      JSON.stringify({
        contentMarkdown: verifiedMarkdown,
        quiz,
        imagePlacements: [],
      })
    );

  const file: FileData = {
    name: 'Great-Software.pdf',
    mimeType: 'application/pdf',
    data: 'unused',
  };

  const documentIndex: PdfTextIndex = {
    kind: 'pdf-text-index',
    parsedAt: '2026-04-03T00:00:00.000Z',
    sourceHash: 'hash-1',
    pageCount: 12,
    chunks: [
      {
        id: 'chunk-001',
        text: 'Affidabilita del confronto e qualita interna del software',
        headingPath: ['Qualita del software'],
        sequence: 0,
        startOffset: 0,
        endOffset: 200,
        pageStart: 2,
        pageEnd: 2,
      },
    ],
  };

  const pdfTextSession = {
    images: [],
    extractedText: 'Estratto PDF sulla qualita del software.',
    pages: [{ pageNumber: 2, text: 'Page 2: confronto fragile e qualita interna.' }],
    pageCount: 12,
    parsedAt: '2026-04-03T00:00:00.000Z',
    sourceHash: 'hash-1',
  };

  const pdfAssetSession = {
    ...pdfTextSession,
    images: [
      {
        id: 'pdf-img-001',
        mimeType: 'image/png',
        dataUrl: 'data:image/png;base64,AAAA',
        textBefore: 'Elemento grafico vicino a un riquadro di sezione',
        textCurrent: 'Dettaglio grafico parziale e poco leggibile',
        textAfter: 'Il caso concreto mette in luce il problema',
        sourceOrder: 1,
        pageNumber: 2,
      },
    ],
  };

  getPdfTextSessionMock.mockResolvedValue(pdfTextSession);
  getPdfAssetSessionMock.mockResolvedValue(pdfAssetSession);

  const result = await generateSectionContent({
    documentIndex,
    file,
    previousContext: 'Contesto precedente',
    primaryChunkIds: ['chunk-001'],
    sectionDescription:
      'Perche un controllo fragile puo non riconoscere correttamente un elemento.',
    sectionTitle: 'Confronti fragili',
  });

  const generationPrompt = String(
    callOpenRouterMock.mock.calls[0]?.[0]?.messages?.[1]?.content || ''
  );
  assert.match(generationPrompt, /IMMAGINI CANDIDATE:\s*\[\]/);
  assert.equal(result.imageRefs.length, 0);
});

test('generateSectionContent unwraps whole-question backticks but preserves inline code fragments', async () => {
  callOpenRouterMock.mockReset();
  retryWithBackoffMock.mockClear();
  getPdfTextSessionMock.mockReset();
  getPdfAssetSessionMock.mockReset();
  generateLessonVisualExampleMock.mockReset();
  buildStoredPdfDocumentAssetsMock.mockClear();
  generateLessonVisualExampleMock.mockResolvedValue(null);

  callOpenRouterMock
    .mockResolvedValueOnce(
      JSON.stringify({
        contentBlocks: [
          { type: 'markdown', markdown: '## Coordinate\n\nSpiegazione sintetica:' },
          {
            type: 'inline-quiz',
            quiz: {
              question: '`Coordinate in spazio mondo (metri)`',
              options: [
                '`Posizione assoluta`',
                'Errore di `overflow`',
                '`Colore diffuso`',
                '`Texture`',
              ],
              correctIndex: 0,
            },
          },
        ],
        imagePlacements: [],
        visualPlanning: { plans: [], rationale: 'Nessun visuale.' },
      })
    )
    .mockResolvedValueOnce(
      JSON.stringify({
        contentBlocks: [
          { type: 'markdown', markdown: '## Coordinate\n\nSpiegazione sintetica.' },
          {
            type: 'inline-quiz',
            quiz: {
              question: '`Quale valore resta espresso in metri?`',
              options: [
                '`Posizione assoluta`',
                'Errore di `overflow`',
                '`Indice di shader`',
                '`UUID`',
              ],
              correctIndex: 0,
            },
          },
          { type: 'markdown', markdown: '## Conclusione\n\nChiusura.' },
        ],
        imagePlacements: [],
        visualPlanning: { plans: [], rationale: 'Nessun visuale.' },
      })
    );

  const file: FileData = {
    name: 'Coordinate-Spaces.pdf',
    mimeType: 'application/pdf',
    data: 'unused',
  };

  const documentIndex: PdfTextIndex = {
    kind: 'pdf-text-index',
    parsedAt: '2026-04-03T00:00:00.000Z',
    sourceHash: 'hash-quiz-1',
    pageCount: 4,
    chunks: [
      {
        id: 'chunk-001',
        text: 'Coordinate in spazio mondo e unita di misura.',
        headingPath: ['Coordinate'],
        sequence: 0,
        startOffset: 0,
        endOffset: 120,
        pageStart: 1,
        pageEnd: 1,
      },
    ],
  };

  const pdfTextSession = {
    images: [],
    extractedText: 'Coordinate in spazio mondo e unita di misura.',
    pages: [{ pageNumber: 1, text: 'Coordinate in spazio mondo e unita di misura.' }],
    pageCount: 4,
    parsedAt: '2026-04-03T00:00:00.000Z',
    sourceHash: 'hash-quiz-1',
  };

  getPdfTextSessionMock.mockResolvedValue(pdfTextSession);
  getPdfAssetSessionMock.mockResolvedValue({
    ...pdfTextSession,
    images: [],
  });

  const result = await generateSectionContent({
    documentIndex,
    file,
    previousContext: 'Contesto precedente',
    primaryChunkIds: ['chunk-001'],
    sectionDescription: 'Coordinate in spazio mondo e unita di misura.',
    sectionTitle: 'Coordinate',
  });

  assert.equal(result.quiz.length, 1);
  assert.equal(result.quiz[0]?.question, 'Quale valore resta espresso in metri?');
  assert.deepEqual(result.quiz[0]?.options, [
    'Posizione assoluta',
    'Errore di `overflow`',
    'Indice di shader',
    'UUID',
  ]);
});

test('generateSectionContent falls back to the original validated lesson and quiz pair', async () => {
  callOpenRouterMock.mockReset();
  retryWithBackoffMock.mockClear();
  generateLessonVisualExampleMock.mockReset();
  generateLessonLearningAidsMock.mockReset();

  const originalContent = [
    '## Concetto',
    '',
    'Primo paragrafo che introduce il concetto.',
    '',
    '[',
    'x + y',
    ']',
    '',
    '{{INLINE_QUIZ:0}}',
    '',
    'Secondo paragrafo che applica il concetto.',
    '',
    '{{INLINE_QUIZ:1}}',
  ].join('\n');
  const repairedContentWithLostMarker = [
    '## Concetto',
    '',
    'Primo paragrafo corretto.',
    '',
    '$$x + y$$',
    '',
    '{{INLINE_QUIZ:0}}',
    '',
    'Secondo paragrafo.',
    '',
    'Terzo paragrafo.',
    '',
    'Quarto paragrafo.',
  ].join('\n');
  const quiz = buildQuiz();

  callOpenRouterMock
    .mockResolvedValueOnce(
      JSON.stringify({ contentMarkdown: originalContent, quiz, imagePlacements: [] })
    )
    .mockResolvedValueOnce(repairedContentWithLostMarker)
    .mockRejectedValueOnce(new Error('verification failed'));

  const result = await generateSectionContent({
    file: {
      name: 'lesson.txt',
      mimeType: 'text/plain',
      data: 'source text',
    },
    previousContext: '',
    resolvedSourceArchiveContext: 'Fonte gia indicizzata.',
    sectionDescription: 'Applicazione del concetto.',
    sectionTitle: 'Concetto',
  });

  assert.equal(result.quiz.length, 2);
  assert.equal(hasExactInlineQuizMarkerContract(result.content, result.quiz.length), true);
  assert.match(result.content, /\[\nx \+ y\n\]/);
  assert.doesNotMatch(result.content, /Primo paragrafo corretto/);
});
