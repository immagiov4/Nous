import assert from 'node:assert/strict';
import { beforeEach, test, vi } from 'vitest';
import type { FileData, PdfTextIndex, QuizQuestion } from '../../types.ts';

const callOpenRouterMock = vi.fn();
const retryWithBackoffMock = vi.fn(async (operation: () => Promise<string>) => await operation());
const getPdfTextSessionMock = vi.fn();
const getPdfAssetSessionMock = vi.fn();
const buildStoredPdfDocumentAssetsMock = vi.fn((session, imageRefs) => ({
  kind: 'pdf' as const,
  parsedAt: session.parsedAt,
  imageCount: session.images.length,
  sourceHash: session.sourceHash,
  usedImages: session.images.filter((image: { id: string }) =>
    imageRefs.some((ref: { assetId: string }) => ref.assetId === image.id)
  ),
}));

vi.mock('./pdfAssets.ts', () => ({
  getPdfTextSession: getPdfTextSessionMock,
  getPdfAssetSession: getPdfAssetSessionMock,
  buildStoredPdfDocumentAssets: buildStoredPdfDocumentAssetsMock,
}));

vi.mock('./shared.ts', async importOriginal => {
  const actual = await importOriginal<typeof import('./shared.ts')>();
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

const { generateSectionContent } = await import('./planning.ts');

const buildQuiz = (): QuizQuestion[] =>
  Array.from({ length: 5 }, (_, index) => ({
    question: `Domanda ${index + 1}`,
    options: ['A', 'B', 'C', 'D'],
    correctIndex: 0,
  }));

test('generateSectionContent keeps all verified image placements instead of truncating them with a per-lesson cap', async () => {
  callOpenRouterMock.mockReset();
  retryWithBackoffMock.mockClear();
  getPdfTextSessionMock.mockReset();
  getPdfAssetSessionMock.mockReset();
  buildStoredPdfDocumentAssetsMock.mockClear();

  const bulkyMarkdown = `## Decal\n\n${'Spiegazione tecnica sui decal e sugli overlay. '.repeat(120)}`;
  const repairedMarkdown = `${bulkyMarkdown}\n\n## Conclusione\n\nChiusura pulita.`;
  const quiz = buildQuiz();

  const imagePlacements = [
    { assetId: 'pdf-img-001', alt: 'Schema 1', caption: 'Figura 1', anchorHeading: 'Decal' },
    { assetId: 'pdf-img-002', alt: 'Schema 2', caption: 'Figura 2', anchorHeading: 'Decal' },
    { assetId: 'pdf-img-003', alt: 'Schema 3', caption: 'Figura 3', anchorHeading: 'Decal' },
    { assetId: 'pdf-img-004', alt: 'Schema 4', caption: 'Figura 4', anchorHeading: 'Decal' },
  ];

  callOpenRouterMock
    .mockResolvedValueOnce(
      JSON.stringify({
        contentMarkdown: bulkyMarkdown,
        quiz,
        imagePlacements,
      })
    )
    .mockResolvedValueOnce(repairedMarkdown)
    .mockResolvedValueOnce(
      JSON.stringify({
        contentMarkdown: repairedMarkdown,
        quiz,
        imagePlacements,
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
        textBefore: 'Schema dei decal proiettati',
        textAfter: 'overlay sul muro',
        sourceOrder: 1,
        pageNumber: 5,
      },
      {
        id: 'pdf-img-002',
        mimeType: 'image/png',
        dataUrl: 'data:image/png;base64,BBBB',
        textBefore: 'Figura sugli overlay di materiale',
        textAfter: 'decal layering',
        sourceOrder: 2,
        pageNumber: 5,
      },
      {
        id: 'pdf-img-003',
        mimeType: 'image/png',
        dataUrl: 'data:image/png;base64,CCCC',
        textBefore: 'Diagramma di blending dei decal',
        textAfter: 'render target',
        sourceOrder: 3,
        pageNumber: 5,
      },
      {
        id: 'pdf-img-004',
        mimeType: 'image/png',
        dataUrl: 'data:image/png;base64,DDDD',
        textBefore: 'Overlay e mask per decal',
        textAfter: 'material response',
        sourceOrder: 4,
        pageNumber: 5,
      },
    ],
  };

  getPdfTextSessionMock.mockResolvedValue(pdfTextSession);
  getPdfAssetSessionMock.mockResolvedValue(pdfAssetSession);

  const result = await generateSectionContent(
    file,
    'Decal e overlay',
    'Uso di decal, overlay e layering dei materiali',
    'Contesto precedente',
    ['chunk-001'],
    documentIndex
  );

  assert.equal(callOpenRouterMock.mock.calls.length, 3);
  assert.equal(callOpenRouterMock.mock.calls[0]?.[0]?.model, 'reasoning-model');
  assert.equal(callOpenRouterMock.mock.calls[1]?.[0]?.model, 'reasoning-model');
  assert.equal(callOpenRouterMock.mock.calls[2]?.[0]?.model, 'flash-model');
  assert.match(
    String(callOpenRouterMock.mock.calls[2]?.[0]?.messages?.[1]?.content || ''),
    /descrizione, caption e immagine siano abbinate correttamente/i
  );
  assert.equal(result.imageRefs.length, 4);
  assert.deepEqual(
    result.imageRefs.map(ref => ref.assetId),
    ['pdf-img-001', 'pdf-img-002', 'pdf-img-003', 'pdf-img-004']
  );
  assert.equal(result.quiz.length, 5);
  assert.match(result.content, /\{\{PDF_IMAGE:pdf-img-004/);
});
