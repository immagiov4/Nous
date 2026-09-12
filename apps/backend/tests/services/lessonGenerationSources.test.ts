import { expect, test, vi } from 'vitest';

import {
  buildMappedSourceContext,
  isPdfAssetSoftTimeoutError,
  LessonSourceUnavailableError,
  mergeSources,
  parseResearchSource,
  readConfiguredProjectLanguage,
  readOriginalSourceNames,
  readProjectLanguage,
  withPdfAssetSoftTimeout,
} from '../../src/services/lessonGenerationSources.js';

const mappedProject = {
  documentIndex: {
    chunks: Array.from({ length: 10 }, (_, index) => ({
      id: `c${String(index + 1).padStart(2, '0')}`,
      sourceId: 'source-a',
      text: `Passage ${index + 1}`,
    })),
  },
} as never;

test('explicit chunks take priority over neighbors within the context cap', () => {
  const context = buildMappedSourceContext(mappedProject, {
    primaryChunkIds: ['c02', 'c05', 'c08'],
  });
  expect([...context.matchAll(/^CHUNK (\S+)/gm)].map(match => match[1])).toEqual([
    'c01',
    'c02',
    'c03',
    'c04',
    'c05',
    'c08',
  ]);
});

test.each([
  ['missing'],
  ['c02', 'missing'],
])('explicit unresolved mappings fail source resolution: %j', (...chunkIds) => {
  expect(() =>
    buildMappedSourceContext(mappedProject, {
      sourceReferences: [{ sourceId: 'source-a', chunkIds }],
    })
  ).toThrow(LessonSourceUnavailableError);
});

test('absent mappings retain the default document excerpts', () => {
  const context = buildMappedSourceContext(mappedProject, {});
  expect([...context.matchAll(/^CHUNK (\S+)/gm)].map(match => match[1])).toEqual(['c01', 'c02']);
});

test.each([
  ['https://example.org/docs/API', 'https://example.org/docs/api'],
  ['https://example.org/?Key=Value', 'https://example.org/?key=Value'],
  ['https://example.org/?key=Value', 'https://example.org/?key=value'],
  ['https://example.org/#API', 'https://example.org/#api'],
])('source identity preserves URL component case: %s', (first, second) => {
  expect(
    mergeSources([
      { title: 'First', url: first },
      { title: 'Second', url: second },
    ])
  ).toHaveLength(2);
});

test('source identity normalizes scheme and host case and retains sourceId precedence', () => {
  expect(
    mergeSources([
      { title: 'First', url: 'HTTPS://EXAMPLE.ORG/docs/API' },
      { title: 'Second', url: 'https://example.org/docs/API/' },
    ])
  ).toHaveLength(1);
  expect(
    mergeSources([
      { sourceId: 'source-a', title: 'First', url: 'https://example.org/A' },
      { sourceId: 'source-a', title: 'Second', url: 'https://example.org/B' },
      { sourceId: 'source-b', title: 'Third', url: 'https://example.org/A' },
    ])
  ).toHaveLength(2);
});

test.each([
  ['whitespace-only', { language: '   ' }],
  ['non-string', { language: 7 } as never],
] as const)('project language ignores %s profile values', (_case, userProfile) => {
  const project = {
    id: 'project-language',
    version: '1',
    userProfile,
    createdAt: '2026-08-28T00:00:00.000Z',
    updatedAt: '2026-08-28T00:00:00.000Z',
    lastOpenedAt: '2026-08-28T00:00:00.000Z',
  };

  expect(readConfiguredProjectLanguage(project)).toBeUndefined();
  expect(readProjectLanguage(project)).toBe('Italiano');
});

test('PDF image extraction aborts after the approved 90 second soft timeout', async () => {
  vi.useFakeTimers();
  try {
    let operationSignal: AbortSignal | undefined;
    const result = withPdfAssetSoftTimeout(signal => {
      operationSignal = signal;
      return new Promise<never>(() => undefined);
    }, new AbortController().signal);
    const rejection = expect(result).rejects.toSatisfy(isPdfAssetSoftTimeoutError);
    await vi.advanceTimersByTimeAsync(89_999);
    expect(operationSignal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await rejection;
    expect(operationSignal?.aborted).toBe(true);
  } finally {
    vi.useRealTimers();
  }
});

test('mapped source context preserves chunk boundaries and heading paths', () => {
  const context = buildMappedSourceContext(
    {
      createdAt: '2026-07-27T00:00:00.000Z',
      documentIndex: {
        chunks: [
          {
            headingPath: ['Basi', 'Definizioni'],
            id: 'source-a:chunk-001',
            sourceId: 'source-a',
            text: 'Definizione del concetto.',
          },
          {
            headingPath: ['Applicazione'],
            id: 'source-b:chunk-001',
            sourceId: 'source-b',
            text: 'Contenuto di un altro file.',
          },
        ],
        kind: 'pdf-text-index',
      },
      id: 'project-source-context',
      lastOpenedAt: '2026-07-27T00:00:00.000Z',
      updatedAt: '2026-07-27T00:00:00.000Z',
      version: '4.1',
    },
    {
      primaryChunkIds: ['source-a:chunk-001'],
      sourceReferences: [{ chunkIds: ['source-a:chunk-001'], sourceId: 'source-a' }],
    }
  );

  expect(context).toContain(
    'CHUNK source-a:chunk-001\nHeading path: Basi > Definizioni\nDefinizione del concetto.'
  );
  expect(context).not.toContain('Contenuto di un altro file.');
});

test('source merge deduplicates equivalent URLs while preserving original provenance', () => {
  const merged = mergeSources(
    [{ note: 'Materiale originale del corso', title: 'dispensa.pdf' }],
    [{ title: 'Docs nel corso', url: 'https://example.com/docs' }],
    [
      {
        note: 'Conferma il fondamento.',
        title: 'Documentazione ufficiale',
        url: 'https://example.com/docs/',
      },
    ]
  );

  expect(merged).toEqual([
    { note: 'Materiale originale del corso', title: 'dispensa.pdf' },
    {
      note: 'Conferma il fondamento.',
      title: 'Docs nel corso',
      url: 'https://example.com/docs',
    },
  ]);
});

test('legacy YouTube transcript metadata becomes canonical before source merging', () => {
  const parsed = parseResearchSource({
    title: 'Tutorial pratico',
    url: 'https://www.youtube.com/watch?v=test',
    videoClip: { endSeconds: 92, startSeconds: 65 },
    youtubeTranscript: {
      ranges: [{ endSeconds: 93, startSeconds: 65 }],
      text: '[01:05] Primo passaggio.',
    },
  });
  if (!parsed) throw new Error('Expected a parsed source.');

  const [merged] = mergeSources(
    [{ title: 'Tutorial gia noto', url: 'https://www.youtube.com/watch?v=test' }],
    [parsed]
  );

  expect(merged?.videoClip).toEqual({ endSeconds: 92, startSeconds: 65 });
  expect(merged?.youtubeTranscript).toEqual({
    segments: [{ endSeconds: 93, startSeconds: 65, text: 'Primo passaggio.' }],
  });
});

test('legacy unknown source references do not hide every original course source', () => {
  const sources = readOriginalSourceNames(
    {
      source: {
        sources: [
          { id: 'source-a', name: 'dispensa-a.pdf' },
          { id: 'source-b', name: 'dispensa-b.pdf' },
        ],
      },
    } as never,
    { sourceReferences: [{ sourceId: 'legacy-source-id' }] }
  );

  expect(sources.map(source => source.title)).toEqual(['dispensa-a.pdf', 'dispensa-b.pdf']);
});

test('original course sources retain their stable id, chunks, and original page range', () => {
  const sources = readOriginalSourceNames(
    {
      source: {
        sources: [
          { id: 'source-a', name: 'dispensa-a.pdf' },
          { id: 'source-b', name: 'dispensa-b.pdf' },
        ],
      },
    } as never,
    {
      sourceReferences: [
        {
          chunkIds: ['source-b:chunk-4', 'source-b:chunk-5'],
          pageEnd: 12,
          pageStart: 10,
          sourceId: 'source-b',
        },
      ],
    }
  );

  expect(sources).toEqual([
    {
      chunkIds: ['source-b:chunk-4', 'source-b:chunk-5'],
      note: 'Materiale originale del corso',
      pageEnd: 12,
      pageStart: 10,
      sourceId: 'source-b',
      title: 'dispensa-b.pdf',
    },
  ]);
});

test('single detached course source keeps its stable id in regenerated dossiers', () => {
  const sources = readOriginalSourceNames(
    {
      source: {
        file: {
          data: '',
          mimeType: 'application/pdf',
          name: 'dispensa.pdf',
          sourceId: 'source-primary',
        },
        kind: 'pdf',
        ref: { id: 'source-primary' },
      },
    } as never,
    { primaryChunkIds: ['chunk-022'] }
  );

  expect(sources).toEqual([
    {
      note: 'Materiale originale del corso',
      sourceId: 'source-primary',
      title: 'dispensa.pdf',
    },
  ]);
});
