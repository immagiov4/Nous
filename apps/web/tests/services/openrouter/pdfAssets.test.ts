import assert from 'node:assert/strict';
import { afterEach, beforeEach, test, vi } from 'vitest';
import { setRenderingLocaleOverride } from '../../../i18n/uiMessages.ts';
import { OPENROUTER_INLINE_MEDIA_DATA_URL_LIMIT_CHARS } from '../../../services/openrouter/payloadLimits.ts';
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
    getBackendUrl: () => 'http://localhost:3301',
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
        outline: [
          {
            id: 'backend-outline-1',
            title: 'Rendering differito',
            level: 1,
            page: 10,
            children: [
              {
                id: 'backend-outline-2',
                title: 'Decal',
                level: 2,
                page: 12,
                children: [],
              },
            ],
          },
        ],
        outlineOrigin: 'native',
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
    .mockResolvedValueOnce('DECORATIVE');

  const session = await getPdfAssetSession(pdfFile, { partialPages: [10, 11, 12] });

  assert.ok(session);
  assert.equal(session.outlineOrigin, 'native');
  assert.deepEqual(session.outline, [
    {
      id: 'source:outline:pdf-1',
      title: 'Rendering differito',
      level: 1,
      page: 10,
      children: [
        {
          id: 'source:outline:pdf-2',
          title: 'Decal',
          level: 2,
          page: 12,
          children: [],
        },
      ],
    },
  ]);
  assert.equal(fetchMock.mock.calls.length, 2);
  assert.equal(callOpenRouterMock.mock.calls.length, 2);
  assert.equal(callOpenRouterMock.mock.calls[0]?.[0]?.model, 'nvidia/nemotron-nano-12b-v2-vl');
  assert.equal(callOpenRouterMock.mock.calls[0]?.[0]?.modelSlot, 'research');
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
    new RegExp(String.raw`${previousPageTail}[\s\S]*${currentPageTail}[\s\S]*${nextPageTail}`)
  );
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

test('getPdfAssetSession skips extracted images that would exceed the OpenRouter proxy budget', async () => {
  const oversizedImagePdfFile: FileData = {
    name: 'Huge_Figures.pdf',
    mimeType: 'application/pdf',
    data: 'aHVnZS1maWd1cmVz',
  };
  const oversizedDataUrl = `data:image/png;base64,${'A'.repeat(
    OPENROUTER_INLINE_MEDIA_DATA_URL_LIMIT_CHARS
  )}`;

  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        success: true,
        parser: 'pdf-parse',
        text: 'Testo estratto',
        pages: [{ pageNumber: 8, text: 'Pagina 8 con una figura enorme e una piccola.' }],
        pageCount: 8,
        sourceHash: 'hash-huge',
      }),
    })
    .mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        success: true,
        images: [
          {
            id: 'pdf-img-huge',
            mimeType: 'image/png',
            dataUrl: oversizedDataUrl,
            sizeBytes: 9_000_000,
            hash: 'img-huge',
            pageNumber: 8,
          },
          {
            id: 'pdf-img-small',
            mimeType: 'image/png',
            dataUrl: 'data:image/png;base64,BBBB',
            sizeBytes: 1400,
            hash: 'img-small',
            pageNumber: 8,
          },
        ],
      }),
    });
  vi.stubGlobal('fetch', fetchMock);

  callOpenRouterMock.mockResolvedValue('Grafico leggibile.');

  const session = await getPdfAssetSession(oversizedImagePdfFile, { partialPages: [8] });

  assert.ok(session);
  assert.equal(callOpenRouterMock.mock.calls.length, 1);
  assert.equal(session?.images.length, 1);
  assert.equal(session?.images[0]?.id, 'pdf-img-small');
  assert.equal(session?.images[0]?.caption, 'Grafico leggibile.');
});

test('forwards streamed transcription progress and uses the completed Markdown pages', async () => {
  const { getPdfTextSession } = await import('../../../services/openrouter/pdfAssets.ts');
  const events = [
    { type: 'progress', progress: { completed: 0, total: 1, failedPages: [] } },
    { type: 'progress', progress: { completed: 1, total: 1, failedPages: [] } },
    {
      type: 'result',
      result: {
        success: true,
        text: String.raw`$A \cup B$`,
        pages: [{ pageNumber: 2, text: String.raw`$A \cup B$` }],
        transcription: { pages: [2] },
      },
    },
  ];
  const wire = `${events.map(event => JSON.stringify(event)).join('\n')}\n`;
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(wire.slice(0, 20)));
            controller.enqueue(new TextEncoder().encode(wire.slice(20)));
            controller.close();
          },
        }),
        { headers: { 'Content-Type': 'application/x-ndjson' } }
      )
    )
  );
  const progress: unknown[] = [];
  const result = await getPdfTextSession({ ...pdfFile, name: 'streamed-scanned.pdf' }, event =>
    progress.push(event)
  );
  assert.deepEqual(
    progress,
    events.slice(0, 2).map(event => event.progress)
  );
  assert.deepEqual(result?.pages, events[2].result?.pages);
});

test('reports streamed page failures in the interface language and allows retrying the same source', async () => {
  const { getPdfTextSession } = await import('../../../services/openrouter/pdfAssets.ts');
  setRenderingLocaleOverride('en');
  const progress = { completed: 1, total: 1, failedPages: [3] };
  const response = [
    JSON.stringify({ type: 'progress', progress }),
    JSON.stringify({ type: 'error', failedPages: [3], error: 'Internal provider details' }),
  ].join('\n');
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce(
      new Response(response, { headers: { 'Content-Type': 'application/x-ndjson' } })
    )
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          success: true,
          text: 'Recovered page',
          pages: [{ pageNumber: 3, text: 'Recovered page' }],
        }),
        { headers: { 'Content-Type': 'application/json' } }
      )
    );
  vi.stubGlobal('fetch', fetchMock);
  const observed: unknown[] = [];
  const source = { ...pdfFile, name: 'retry-scanned-failure.pdf' };
  try {
    await assert.rejects(
      getPdfTextSession(source, event => observed.push(event)),
      { message: 'Transcription failed for pages: 3.' }
    );
    assert.deepEqual(observed, [progress]);
    assert.equal((await getPdfTextSession(source))?.pages[0].text, 'Recovered page');
    assert.equal(fetchMock.mock.calls.length, 2);
  } finally {
    setRenderingLocaleOverride(null);
  }
});

test('retries the provider after a completed blank transcription fails source validation', async () => {
  const { validatePdfTextSource } = await import('../../../services/openrouter/pdfAssets.ts');
  const recoveredText = 'A readable synthetic source with mathematical definitions. '.repeat(30);
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce(
      Response.json({ success: true, text: '', pages: [], transcription: { pages: [1] } })
    )
    .mockResolvedValueOnce(
      Response.json({
        success: true,
        text: recoveredText,
        pages: [{ pageNumber: 1, text: recoveredText }],
        transcription: { pages: [1] },
      })
    );
  vi.stubGlobal('fetch', fetchMock);
  const source = { ...pdfFile, name: 'completed-blank-transcription.pdf' };
  await assert.rejects(validatePdfTextSource(source), { code: 'PDF_TEXT_QUALITY_INSUFFICIENT' });
  assert.equal((await validatePdfTextSource(source))?.status, 'ok');
  assert.equal(fetchMock.mock.calls.length, 2);
});
