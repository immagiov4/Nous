import assert from 'node:assert/strict';
import { beforeEach, test, vi } from 'vitest';
import type { FileData, LearningPlan, PdfTextIndex } from '../../../types.ts';

const getPdfTextSessionMock = vi.fn();
const callOpenRouterMock = vi.fn();
const retryWithBackoffMock = vi.fn(async (operation: () => Promise<string>) => await operation());
const pushNousDebugTraceMock = vi.fn();

vi.mock('../../../services/openrouter/pdfAssets.ts', () => ({
  getPdfTextSession: getPdfTextSessionMock,
}));

vi.mock('../../../services/core/debugTrace.ts', () => ({
  pushNousDebugTrace: pushNousDebugTraceMock,
}));

vi.mock('../../../services/openrouter/shared.ts', async importOriginal => {
  const actual = await importOriginal<typeof import('../../../services/openrouter/shared.ts')>();
  return {
    ...actual,
    MODEL_FLASH: 'test-model',
    MODEL_REASONING: 'test-reasoning-model',
    callOpenRouter: callOpenRouterMock,
    retryWithBackoff: retryWithBackoffMock,
    isPdfFile: (file: FileData) => file.mimeType === 'application/pdf',
  };
});

const { buildPdfTextIndex, preparePdfLessonMappings } = await import(
  '../../../services/openrouter/documentIndex.ts'
);

const buildChunkId = (index: number): string => `chunk-${String(index).padStart(3, '0')}`;

const buildPlan = (sectionCount: number): LearningPlan => ({
  title: 'Game Engine Architecture',
  summary: 'Large PDF mapping test',
  sections: Array.from({ length: sectionCount }, (_, index) => ({
    id: `section-${index + 1}`,
    title: `Lesson ${index + 1}`,
    description: `Detailed description for lesson ${index + 1}`,
    isCompleted: false,
    type: 'core' as const,
    moduleTitle: `Module ${Math.floor(index / 4) + 1}`,
  })),
});

const buildDocumentIndex = (chunkCount: number): PdfTextIndex => ({
  kind: 'pdf-text-index',
  parsedAt: '2026-04-03T00:00:00.000Z',
  sourceHash: 'hash-1',
  documentTitle: 'Game Engine Architecture',
  chunks: Array.from({ length: chunkCount }, (_, index) => ({
    id: buildChunkId(index + 1),
    sequence: index,
    headingPath: ['Part I', `Chapter ${index + 1}`],
    text: `${'A'.repeat(2200)} MIDDLE-SENTINEL-${index + 1} ${'B'.repeat(2200)} TAIL-${index + 1}`,
    startOffset: index * 5000,
    endOffset: index * 5000 + 4500,
  })),
});

const pdfFile: FileData = {
  name: 'Game_Engine_Architecture-en.pdf',
  mimeType: 'application/pdf',
  data: 'unused',
};

beforeEach(() => {
  getPdfTextSessionMock.mockReset();
  callOpenRouterMock.mockReset();
  retryWithBackoffMock.mockClear();
  pushNousDebugTraceMock.mockReset();
});

test('preparePdfLessonMappings batches large mapping prompts and trims chunk content previews', async () => {
  const plan = buildPlan(12);
  const documentIndex = buildDocumentIndex(60);

  getPdfTextSessionMock.mockResolvedValue({
    extractedText: 'cached text',
    parser: 'pdftotext',
    pageCount: 60,
    sourceHash: 'hash-1',
  });

  callOpenRouterMock
    .mockResolvedValueOnce(
      JSON.stringify({
        mappings: plan.sections.slice(0, 8).map((section, index) => ({
          lessonId: section.id,
          chunkIds: [buildChunkId(index + 11)],
        })),
      })
    )
    .mockResolvedValueOnce(
      JSON.stringify({
        mappings: plan.sections.slice(8).map((section, index) => ({
          lessonId: section.id,
          chunkIds: [buildChunkId(index + 31)],
        })),
      })
    );

  const result = await preparePdfLessonMappings(pdfFile, plan, documentIndex);

  assert.equal(callOpenRouterMock.mock.calls.length, 2);

  callOpenRouterMock.mock.calls.forEach(([options]) => {
    const prompt = String(options.messages[0]?.content ?? '');
    assert.ok(prompt.length < 180000);
    assert.ok(!prompt.includes('MIDDLE-SENTINEL-1'));
    assert.ok(prompt.includes('"textPreview"'));
    assert.match(prompt, /ordine coerente con la sequenza del documento/i);
    assert.match(prompt, /Evita di concentrare troppe lezioni sugli stessi primi chunk/i);
    assert.ok(typeof options.max_tokens === 'number' && options.max_tokens <= 2048);
    assert.equal(options.reasoning, undefined);
    assert.equal(options.temperature, 0);
  });

  assert.deepEqual(result.learningPlan.sections[0]?.primaryChunkIds, [buildChunkId(11)]);
  assert.deepEqual(result.learningPlan.sections[7]?.primaryChunkIds, [buildChunkId(18)]);
  assert.deepEqual(result.learningPlan.sections[8]?.primaryChunkIds, [buildChunkId(31)]);
  assert.deepEqual(result.learningPlan.sections[11]?.primaryChunkIds, [buildChunkId(34)]);
  assert.equal(retryWithBackoffMock.mock.calls.length, 2);
  assert.ok(
    pushNousDebugTraceMock.mock.calls.some(
      ([event, payload]) =>
        event === 'pdf-plan:coverage' &&
        payload?.mappingSource === 'mapped' &&
        typeof payload?.coverageRatio === 'number'
    )
  );
});

test('preparePdfLessonMappings narrows large PDF mapping prompts to positional chunk candidates', async () => {
  const plan = buildPlan(16);
  const documentIndex = buildDocumentIndex(344);

  getPdfTextSessionMock.mockResolvedValue({
    extractedText: 'cached text',
    parser: 'pdftotext',
    pageCount: 344,
    sourceHash: 'hash-1',
  });

  callOpenRouterMock
    .mockResolvedValueOnce(
      JSON.stringify({
        mappings: plan.sections.slice(0, 8).map((section, index) => ({
          lessonId: section.id,
          chunkIds: [buildChunkId(index + 12)],
        })),
      })
    )
    .mockResolvedValueOnce(
      JSON.stringify({
        mappings: plan.sections.slice(8).map((section, index) => ({
          lessonId: section.id,
          chunkIds: [buildChunkId(index + 260)],
        })),
      })
    );

  await preparePdfLessonMappings(pdfFile, plan, documentIndex);

  assert.equal(callOpenRouterMock.mock.calls.length, 2);
  callOpenRouterMock.mock.calls.forEach(([options]) => {
    const prompt = String(options.messages[0]?.content ?? '');
    const chunkDescriptorCount = prompt.match(/"id": "chunk-/g)?.length || 0;
    assert.ok(chunkDescriptorCount <= 96);
    assert.ok(chunkDescriptorCount < documentIndex.chunks.length);
    assert.ok(prompt.length < 90000);
  });

  const firstBatchPrompt = String(
    callOpenRouterMock.mock.calls[0]?.[0]?.messages[0]?.content ?? ''
  );
  const secondBatchPrompt = String(
    callOpenRouterMock.mock.calls[1]?.[0]?.messages[0]?.content ?? ''
  );

  assert.match(firstBatchPrompt, /"id": "chunk-001"/);
  assert.doesNotMatch(firstBatchPrompt, /"id": "chunk-344"/);
  assert.doesNotMatch(secondBatchPrompt, /"id": "chunk-001"/);
});

test('preparePdfLessonMappings deep-repairs unresolved lessons instead of persisting fallback mappings', async () => {
  const plan = buildPlan(10);
  const documentIndex = buildDocumentIndex(24);
  const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

  getPdfTextSessionMock.mockResolvedValue({
    extractedText: 'cached text',
    parser: 'pdftotext',
    pageCount: 24,
    sourceHash: 'hash-1',
  });

  callOpenRouterMock
    .mockResolvedValueOnce(
      JSON.stringify({
        mappings: plan.sections.slice(0, 8).map((section, index) => ({
          lessonId: section.id,
          chunkIds: [buildChunkId(index + 9)],
        })),
      })
    )
    .mockRejectedValueOnce(new Error('batch failed'))
    .mockResolvedValueOnce(
      JSON.stringify({
        mappings: [{ lessonId: plan.sections[8]?.id, chunkIds: [buildChunkId(17)] }],
      })
    )
    .mockResolvedValueOnce(
      JSON.stringify({
        mappings: [{ lessonId: plan.sections[9]?.id, chunkIds: [buildChunkId(18)] }],
      })
    );

  const result = await preparePdfLessonMappings(pdfFile, plan, documentIndex);

  assert.deepEqual(result.learningPlan.sections[0]?.primaryChunkIds, [buildChunkId(9)]);
  assert.deepEqual(result.learningPlan.sections[7]?.primaryChunkIds, [buildChunkId(16)]);
  assert.deepEqual(result.learningPlan.sections[8]?.primaryChunkIds, [buildChunkId(17)]);
  assert.deepEqual(result.learningPlan.sections[9]?.primaryChunkIds, [buildChunkId(18)]);
  assert.equal(result.learningPlan.sections[0]?.primaryChunkMappingSource, 'mapped');
  assert.equal(result.learningPlan.sections[8]?.primaryChunkMappingSource, 'mapped');
  assert.equal(callOpenRouterMock.mock.calls.length, 4);
  assert.ok(
    warnSpy.mock.calls.some(call =>
      String(call[0]).includes('Fast mapping batch failed for 2 lesson(s).')
    )
  );
  assert.equal(callOpenRouterMock.mock.calls[2]?.[0]?.model, 'test-reasoning-model');
  assert.equal(callOpenRouterMock.mock.calls[3]?.[0]?.model, 'test-reasoning-model');
  assert.equal(callOpenRouterMock.mock.calls[2]?.[0]?.disableModelOverride, true);
  assert.ok((callOpenRouterMock.mock.calls[2]?.[0]?.max_tokens || 0) >= 1024);

  const coverageWarningCall = pushNousDebugTraceMock.mock.calls.find(
    ([event]) => event === 'pdf-plan:coverage-warning'
  );
  assert.ok(coverageWarningCall);
  assert.match(String(coverageWarningCall?.[1]?.warnings?.[0] || ''), /Copertura/i);
  assert.ok((coverageWarningCall?.[1]?.gapCount || 0) > 0);
});

test('preparePdfLessonMappings uses a narrower prompt window and larger token budget for single-lesson repairs', async () => {
  const plan = buildPlan(10);
  const documentIndex = buildDocumentIndex(60);

  getPdfTextSessionMock.mockResolvedValue({
    extractedText: 'cached text',
    parser: 'pdftotext',
    pageCount: 60,
    sourceHash: 'hash-1',
  });

  callOpenRouterMock
    .mockResolvedValueOnce(
      JSON.stringify({
        mappings: plan.sections.slice(0, 8).map((section, index) => ({
          lessonId: section.id,
          chunkIds: [buildChunkId(index + 9)],
        })),
      })
    )
    .mockRejectedValueOnce(new Error('batch failed'))
    .mockResolvedValueOnce(
      JSON.stringify({
        mappings: [{ lessonId: plan.sections[8]?.id, chunkIds: [buildChunkId(45)] }],
      })
    )
    .mockResolvedValueOnce(
      JSON.stringify({
        mappings: [{ lessonId: plan.sections[9]?.id, chunkIds: [buildChunkId(52)] }],
      })
    );

  await preparePdfLessonMappings(pdfFile, plan, documentIndex);

  const deepRepairRequest = callOpenRouterMock.mock.calls[2]?.[0];
  const deepRepairPrompt = String(deepRepairRequest?.messages[0]?.content ?? '');
  const chunkDescriptorCount = deepRepairPrompt.match(/"id": "chunk-/g)?.length || 0;

  assert.ok(chunkDescriptorCount > 0);
  assert.ok(chunkDescriptorCount <= 32);
  assert.ok(chunkDescriptorCount < documentIndex.chunks.length);
  assert.equal(deepRepairRequest?.disableModelOverride, true);
  assert.ok(
    typeof deepRepairRequest?.max_tokens === 'number' && deepRepairRequest.max_tokens >= 1024
  );
});

test('preparePdfLessonMappings retries a strict single-lesson repair when the first repair reply is empty', async () => {
  const plan = buildPlan(10);
  const documentIndex = buildDocumentIndex(24);

  getPdfTextSessionMock.mockResolvedValue({
    extractedText: 'cached text',
    parser: 'pdftotext',
    pageCount: 24,
    sourceHash: 'hash-1',
  });

  callOpenRouterMock
    .mockResolvedValueOnce(
      JSON.stringify({
        mappings: plan.sections.slice(0, 8).map((section, index) => ({
          lessonId: section.id,
          chunkIds: [buildChunkId(index + 9)],
        })),
      })
    )
    .mockRejectedValueOnce(new Error('batch failed'))
    .mockResolvedValueOnce('')
    .mockResolvedValueOnce(
      JSON.stringify({
        mappings: [{ lessonId: plan.sections[8]?.id, chunkIds: [buildChunkId(17)] }],
      })
    )
    .mockResolvedValueOnce(
      JSON.stringify({
        mappings: [{ lessonId: plan.sections[9]?.id, chunkIds: [buildChunkId(18)] }],
      })
    );

  const result = await preparePdfLessonMappings(pdfFile, plan, documentIndex);

  assert.deepEqual(result.learningPlan.sections[8]?.primaryChunkIds, [buildChunkId(17)]);
  assert.deepEqual(result.learningPlan.sections[9]?.primaryChunkIds, [buildChunkId(18)]);
  assert.equal(callOpenRouterMock.mock.calls.length, 5);
  assert.equal(callOpenRouterMock.mock.calls[3]?.[0]?.response_format, undefined);
  assert.match(
    String(callOpenRouterMock.mock.calls[3]?.[0]?.messages[0]?.content ?? ''),
    /VINCOLI TASSATIVI DI OUTPUT/i
  );
});

test('preparePdfLessonMappings falls back when deep repair still cannot produce a healthy mapping', async () => {
  const plan = buildPlan(10);
  const documentIndex = buildDocumentIndex(24);
  const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

  getPdfTextSessionMock.mockResolvedValue({
    extractedText: 'cached text',
    parser: 'pdftotext',
    pageCount: 24,
    sourceHash: 'hash-1',
  });

  callOpenRouterMock
    .mockResolvedValueOnce(
      JSON.stringify({
        mappings: plan.sections.slice(0, 8).map((section, index) => ({
          lessonId: section.id,
          chunkIds: [buildChunkId(index + 9)],
        })),
      })
    )
    .mockRejectedValueOnce(new Error('batch failed'))
    .mockResolvedValueOnce(JSON.stringify({ mappings: [] }))
    .mockResolvedValueOnce(JSON.stringify({ mappings: [] }))
    .mockResolvedValueOnce(JSON.stringify({ mappings: [] }))
    .mockResolvedValueOnce(JSON.stringify({ mappings: [] }));

  const result = await preparePdfLessonMappings(pdfFile, plan, documentIndex);

  assert.deepEqual(result.learningPlan.sections[0]?.primaryChunkIds, [buildChunkId(9)]);
  assert.deepEqual(result.learningPlan.sections[7]?.primaryChunkIds, [buildChunkId(16)]);
  assert.deepEqual(result.learningPlan.sections[8]?.primaryChunkIds, [
    buildChunkId(21),
    buildChunkId(22),
  ]);
  assert.deepEqual(result.learningPlan.sections[9]?.primaryChunkIds, [
    buildChunkId(23),
    buildChunkId(24),
  ]);
  assert.equal(result.learningPlan.sections[8]?.primaryChunkMappingSource, 'fallback');
  assert.equal(result.learningPlan.sections[9]?.primaryChunkMappingSource, 'fallback');

  assert.ok(
    warnSpy.mock.calls.some(call =>
      String(call[0]).includes('Fast mapping batch failed for 2 lesson(s).')
    )
  );
  assert.ok(
    warnSpy.mock.calls.some(call =>
      String(call[0]).includes('continuing with fallback chunk assignments')
    )
  );
  const incompleteMappingWarning = warnSpy.mock.calls.find(call =>
    String(call[0]).includes('produced incomplete or rejected chunk mappings')
  );
  assert.ok(incompleteMappingWarning);
  assert.match(String(incompleteMappingWarning?.[1]?.rawResponsePreview || ''), /"mappings":\s*\[/);
  assert.ok(
    pushNousDebugTraceMock.mock.calls.some(
      ([event, payload]) =>
        event === 'pdf-plan:mapping-fallback' &&
        payload?.failedSectionCount === 2 &&
        payload?.fallbackSectionCount === 2
    )
  );
});

test('preparePdfLessonMappings falls back when deep repair requests fail', async () => {
  const plan = buildPlan(10);
  const documentIndex = buildDocumentIndex(24);
  const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

  getPdfTextSessionMock.mockResolvedValue({
    extractedText: 'cached text',
    parser: 'pdftotext',
    pageCount: 24,
    sourceHash: 'hash-1',
  });

  callOpenRouterMock
    .mockResolvedValueOnce(
      JSON.stringify({
        mappings: plan.sections.slice(0, 8).map((section, index) => ({
          lessonId: section.id,
          chunkIds: [buildChunkId(index + 9)],
        })),
      })
    )
    .mockRejectedValueOnce(new Error('batch failed'))
    .mockRejectedValueOnce(new Error('deep repair failed'))
    .mockRejectedValueOnce(new Error('deep repair failed again'));

  const result = await preparePdfLessonMappings(pdfFile, plan, documentIndex);

  assert.deepEqual(result.learningPlan.sections[8]?.primaryChunkIds, [
    buildChunkId(21),
    buildChunkId(22),
  ]);
  assert.deepEqual(result.learningPlan.sections[9]?.primaryChunkIds, [
    buildChunkId(23),
    buildChunkId(24),
  ]);
  assert.equal(result.learningPlan.sections[8]?.primaryChunkMappingSource, 'fallback');
  assert.equal(result.learningPlan.sections[9]?.primaryChunkMappingSource, 'fallback');
  assert.ok(
    warnSpy.mock.calls.some(call =>
      String(call[0]).includes('Deep PDF remapping failed, continuing with fallback mapping')
    )
  );
  assert.ok(
    pushNousDebugTraceMock.mock.calls.some(
      ([event, payload]) => event === 'pdf-plan:deep-repair-failed' && payload?.sectionCount === 2
    )
  );
});

test('buildPdfTextIndex stores exact chunk page spans when per-page text is available', () => {
  const documentIndex = buildPdfTextIndex('unused', 'hash-1', 'Game Engine Architecture', [
    {
      pageNumber: 10,
      text: 'Intro systems',
    },
    {
      pageNumber: 11,
      text: 'Deferred decals and material overlays',
    },
    {
      pageNumber: 12,
      text: 'Camera ambient occlusion and clipping planes',
    },
  ]);

  assert.equal(documentIndex.pageCount, 3);
  assert.deepEqual(
    documentIndex.chunks.map(chunk => ({
      id: chunk.id,
      pageStart: chunk.pageStart,
      pageEnd: chunk.pageEnd,
    })),
    [
      {
        id: 'chunk-001',
        pageStart: 10,
        pageEnd: 12,
      },
    ]
  );
});
