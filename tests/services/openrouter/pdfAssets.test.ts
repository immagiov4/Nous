import assert from 'node:assert/strict';
import { afterEach, beforeEach, test, vi } from 'vitest';
import type { FileData } from '../../../types.ts';

const callOpenRouterMock = vi.fn();
const retryWithBackoffMock = vi.fn(async (operation: () => Promise<string>) => await operation());

vi.mock('../../../services/openrouter/shared.ts', async importOriginal => {
  const actual = await importOriginal<typeof import('../../../services/openrouter/shared.ts')>();
  return {
    ...actual,
    MODEL_PDF_IMAGE_CAPTION: 'nvidia/nemotron-nano-12b-v2-vl',
    callOpenRouter: callOpenRouterMock,
    retryWithBackoff: retryWithBackoffMock,
    getBackendUrl: () => 'http://localhost:3001',
    isPdfFile: (file: FileData) => file.mimeType === 'application/pdf',
  };
});

const { getPdfAssetSession } = await import('../../../services/openrouter/pdfAssets.ts');

const pdfFile: FileData = {
  name: 'Game_Engine_Architecture-en.pdf',
  mimeType: 'application/pdf',
  data: 'ZmFrZS1wZGY=',
};

beforeEach(() => {
  callOpenRouterMock.mockReset();
  retryWithBackoffMock.mockClear();
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

test('getPdfAssetSession captions extracted images with the dedicated vision model and page context', async () => {
  const previousPageTail = 'PREVIOUS-PAGE-END-MARKER';
  const currentPageTail = 'CURRENT-PAGE-END-MARKER';
  const nextPageTail = 'NEXT-PAGE-END-MARKER';
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        success: true,
        parser: 'pdf-parse',
        text: 'Testo estratto',
        pages: [
          {
            pageNumber: 10,
            text: 'Previous page setup for deferred shading and g-buffer composition.',
          },
          {
            pageNumber: 11,
            text: `Transitional page about material response before decals are projected.\n${'P'.repeat(1200)}\n${previousPageTail}`,
          },
          {
            pageNumber: 12,
            text: `Figure 7.12 Decal overlays used to stamp bullet holes and graffiti on top of walls.\n${'C'.repeat(2600)}\n${currentPageTail}`,
          },
          {
            pageNumber: 13,
            text: `Following page covers layering, sorting, and blending of projected decals.\n${'N'.repeat(1200)}\n${nextPageTail}`,
          },
          {
            pageNumber: 14,
            text: 'Later page expands on render targets and transparency constraints.',
          },
        ],
        pageCount: 12,
        sourceHash: 'hash-1',
      }),
    })
    .mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        success: true,
        images: [
          {
            id: 'pdf-img-001',
            mimeType: 'image/png',
            dataUrl: 'data:image/png;base64,AAAA',
            sizeBytes: 1234,
            hash: 'img-1',
            pageNumber: 12,
            textBefore: `Caption lead-in above the figure.\n${'P'.repeat(1200)}\n${previousPageTail}`,
            textCurrent: `Inline labels inside the figure.\n${'C'.repeat(800)}\n${currentPageTail}`,
            textAfter: `Figure 7.12 Decal overlays used to stamp bullet holes and graffiti on top of walls.\n${'N'.repeat(1200)}\n${nextPageTail}`,
          },
          {
            id: 'pdf-img-002',
            mimeType: 'image/png',
            dataUrl: 'data:image/png;base64,BBBB',
            sizeBytes: 1456,
            hash: 'img-2',
            pageNumber: 12,
            textBefore: `Secondary figure lead-in.\n${previousPageTail}`,
            textCurrent: `Secondary labels.\n${currentPageTail}`,
            textAfter: `Secondary caption.\n${nextPageTail}`,
          },
        ],
      }),
    });
  vi.stubGlobal('fetch', fetchMock);

  callOpenRouterMock
    .mockResolvedValueOnce('Schema con coni di visibilita e stanze etichettate A-G.')
    .mockResolvedValueOnce('DECORATIVE')
    .mockResolvedValueOnce('');

  const session = await getPdfAssetSession(pdfFile, { partialPages: [10, 11, 12] });

  assert.ok(session);
  assert.equal(fetchMock.mock.calls.length, 2);
  assert.equal(callOpenRouterMock.mock.calls.length, 3);
  assert.equal(callOpenRouterMock.mock.calls[0]?.[0]?.model, 'nvidia/nemotron-nano-12b-v2-vl');
  assert.equal(callOpenRouterMock.mock.calls[0]?.[0]?.disableModelOverride, true);
  assert.deepEqual(callOpenRouterMock.mock.calls[0]?.[0]?.messages?.[0]?.content?.[0], {
    type: 'image_url',
    image_url: { url: 'data:image/png;base64,AAAA' },
  });
  assert.match(
    String(callOpenRouterMock.mock.calls[0]?.[0]?.messages?.[0]?.content?.[1]?.text || ''),
    /Describe this technical PDF figure in Italian/
  );
  assert.match(
    String(callOpenRouterMock.mock.calls[0]?.[0]?.messages?.[0]?.content?.[1]?.text || ''),
    /blurry, partial, cropped, or unreadable image/i
  );
  assert.match(
    String(callOpenRouterMock.mock.calls[0]?.[0]?.messages?.[0]?.content?.[1]?.text || ''),
    /border\/frame\/wrapper, a section box, a separator, an icon, a badge/i
  );
  assert.match(
    String(callOpenRouterMock.mock.calls[0]?.[0]?.messages?.[0]?.content?.[1]?.text || ''),
    /PDF text context near the image/
  );
  assert.match(
    String(callOpenRouterMock.mock.calls[0]?.[0]?.messages?.[0]?.content?.[1]?.text || ''),
    /Text immediately below the image:[\s\S]*Decal overlays/
  );
  assert.match(
    String(callOpenRouterMock.mock.calls[0]?.[0]?.messages?.[0]?.content?.[1]?.text || ''),
    /Text immediately above the image:[\s\S]*Caption lead-in above the figure/
  );
  assert.match(
    String(callOpenRouterMock.mock.calls[0]?.[0]?.messages?.[0]?.content?.[1]?.text || ''),
    /Text aligned with the image area:[\s\S]*Inline labels inside the figure/
  );
  assert.match(
    String(callOpenRouterMock.mock.calls[0]?.[0]?.messages?.[0]?.content?.[1]?.text || ''),
    new RegExp(`${previousPageTail}[\\s\\S]*${currentPageTail}[\\s\\S]*${nextPageTail}`)
  );
  assert.equal(callOpenRouterMock.mock.calls[2]?.[0]?.model, 'openai/gpt-5.4-nano');
  assert.equal(session?.parser, 'pdf-parse');
  assert.equal(session?.images.length, 2);
  assert.equal(session?.images[0]?.id, 'pdf-img-001');
  assert.equal(
    session?.images[0]?.caption,
    'Schema con coni di visibilita e stanze etichettate A-G.'
  );
  assert.equal(
    session?.images[0]?.textBefore,
    `Caption lead-in above the figure.\n${'P'.repeat(1200)}\n${previousPageTail}`
  );
  assert.equal(
    session?.images[0]?.textCurrent,
    `Inline labels inside the figure.\n${'C'.repeat(800)}\n${currentPageTail}`
  );
  assert.equal(session?.images[0]?.pageNumber, 12);
  assert.equal(
    session?.images[0]?.textAfter,
    `Figure 7.12 Decal overlays used to stamp bullet holes and graffiti on top of walls.\n${'N'.repeat(1200)}\n${nextPageTail}`
  );
  assert.equal(session?.images[1]?.id, 'pdf-img-002');
  assert.equal(session?.images[1]?.caption, undefined);
  assert.match(session?.images[1]?.textBefore || '', /Secondary figure lead-in/);
  assert.match(session?.images[1]?.textBefore || '', new RegExp(previousPageTail));
  assert.match(session?.images[1]?.textCurrent || '', /Secondary labels/);
  assert.match(session?.images[1]?.textCurrent || '', new RegExp(currentPageTail));
  assert.equal(session?.images[1]?.pageNumber, 12);
  assert.match(session?.images[1]?.textAfter || '', /Secondary caption/);
  assert.match(session?.images[1]?.textAfter || '', new RegExp(nextPageTail));
});

test('getPdfAssetSession captions every extracted image from the targeted pages without truncating at twelve', async () => {
  const manyImagesPdfFile: FileData = {
    name: 'Many_Figures.pdf',
    mimeType: 'application/pdf',
    data: 'bWFueS1maWd1cmVz',
  };
  const extractedImages = Array.from({ length: 13 }, (_, index) => ({
    id: `pdf-img-${String(index + 1).padStart(3, '0')}`,
    mimeType: 'image/png',
    dataUrl: `data:image/png;base64,${String(index + 1).padStart(4, 'A')}`,
    sizeBytes: 1200 + index,
    hash: `img-${index + 1}`,
    pageNumber: 4,
    textBefore: `Figura ${index + 1} sopra`,
    textCurrent: `Figura ${index + 1} centro`,
    textAfter: `Figura ${index + 1} sotto`,
  }));

  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        success: true,
        parser: 'pdf-parse',
        text: 'Testo estratto',
        pages: [{ pageNumber: 4, text: 'Pagina 4 con molte figure tecniche.' }],
        pageCount: 4,
        sourceHash: 'hash-many',
      }),
    })
    .mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        success: true,
        images: extractedImages,
      }),
    });
  vi.stubGlobal('fetch', fetchMock);

  callOpenRouterMock.mockResolvedValue('Schema tecnico sintetico.');

  const session = await getPdfAssetSession(manyImagesPdfFile, { partialPages: [4] });

  assert.ok(session);
  assert.equal(session?.parser, 'pdf-parse');
  assert.equal(session?.images.length, 13);
  assert.equal(callOpenRouterMock.mock.calls.length, 13);
  assert.equal(session?.images[12]?.id, 'pdf-img-013');
  assert.equal(session?.images[12]?.caption, 'Schema tecnico sintetico.');
});
