import assert from 'node:assert/strict';
import { beforeEach, test, vi } from 'vitest';
import type { CourseSourceDescriptor, ResearchLessonDossier } from '../../../types.ts';

const callOpenRouterMock = vi.fn();
const retryWithBackoffMock = vi.fn(async <T>(operation: () => Promise<T>) => await operation());
const getPdfTextSessionMock = vi.fn();

vi.mock('../../../services/openrouter/client.ts', () => ({
  callOpenRouter: callOpenRouterMock,
}));

vi.mock('../../../services/openrouter/retry.ts', () => ({
  retryWithBackoff: retryWithBackoffMock,
}));

vi.mock('../../../services/openrouter/pdfAssets.ts', () => ({
  getPdfTextSession: getPdfTextSessionMock,
}));

const {
  buildPrerequisiteSourceContext,
  mergePrerequisiteDossierSources,
  selectPrerequisiteSourceCoverage,
} = await import('../../../services/openrouter/prerequisiteSources.ts');

const encodeText = (value: string): string => Buffer.from(value, 'utf8').toString('base64');

const buildTextSource = (args: {
  chunkId: string;
  content: string;
  id: string;
  name: string;
}): CourseSourceDescriptor => ({
  documentIndex: {
    kind: 'pdf-text-index',
    parsedAt: '2026-07-11T10:00:00.000Z',
    sourceHash: `hash-${args.id}`,
    sourceIds: [args.id],
    documentTitle: args.name,
    chunks: [
      {
        id: args.chunkId,
        sourceId: args.id,
        sequence: 0,
        text: args.content,
        headingPath: ['Basi'],
        startOffset: 0,
        endOffset: args.content.length,
      },
    ],
  },
  file: {
    data: encodeText(args.content),
    mimeType: 'text/markdown',
    name: args.name,
    sourceId: args.id,
  },
  hash: `hash-${args.id}`,
  id: args.id,
  kind: 'markdown',
  name: args.name,
  outline: [],
  outlineOrigin: 'none',
  position: 0,
  status: 'ready',
});

beforeEach(() => {
  callOpenRouterMock.mockReset();
  retryWithBackoffMock.mockClear();
  getPdfTextSessionMock.mockReset();
});

test('coverage selection distinguishes complete material from factual gaps', async () => {
  const sourceContext =
    'Il materiale spiega definizioni, condizioni e un esempio concreto. '.repeat(4);
  callOpenRouterMock.mockResolvedValueOnce(JSON.stringify({ sufficient: true, missingTopics: [] }));

  const covered = await selectPrerequisiteSourceCoverage({
    description: 'Comprendere definizioni, condizioni ed esempio.',
    sourceContext,
    title: 'Basi del metodo',
  });

  assert.deepEqual(covered, { missingTopics: [], needsResearch: false });

  callOpenRouterMock.mockResolvedValueOnce(
    JSON.stringify({
      sufficient: false,
      missingTopics: ['Ipotesi matematiche', ' Limiti del metodo ', 'Ipotesi matematiche'],
    })
  );

  const incomplete = await selectPrerequisiteSourceCoverage({
    description: 'Comprendere ipotesi e limiti.',
    sourceContext,
    title: 'Basi del metodo',
  });

  assert.deepEqual(incomplete, {
    missingTopics: ['Ipotesi matematiche', 'Limiti del metodo'],
    needsResearch: true,
  });
  assert.equal(callOpenRouterMock.mock.calls.length, 2);
  assert.equal(callOpenRouterMock.mock.calls[0]?.[0]?.modelSlot, 'research');
  assert.equal(callOpenRouterMock.mock.calls[1]?.[0]?.modelSlot, 'research');
});

test('coverage selection requests research without a model call when source evidence is absent', async () => {
  const decision = await selectPrerequisiteSourceCoverage({
    description: 'Comprendere il prerequisito.',
    sourceContext: '',
    title: 'Prerequisito assente',
  });

  assert.deepEqual(decision, {
    missingTopics: ['Prerequisito assente'],
    needsResearch: true,
  });
  assert.equal(callOpenRouterMock.mock.calls.length, 0);
});

test('source context follows lesson provenance instead of mixing unrelated course files', async () => {
  const first = buildTextSource({
    chunkId: 'source-a:chunk-001',
    content: 'Contenuto avanzato non richiesto.',
    id: 'source-a',
    name: 'avanzato.md',
  });
  const second = buildTextSource({
    chunkId: 'source-b:chunk-001',
    content: 'Definizione e spiegazione del prerequisito.',
    id: 'source-b',
    name: 'basi.md',
  });

  const context = await buildPrerequisiteSourceContext({
    file: first.file,
    sourceDescriptors: [first, second],
    sourceReferences: [
      {
        chunkIds: ['source-b:chunk-001'],
        sourceId: 'source-b',
      },
    ],
  });

  assert.deepEqual(context, {
    content:
      'FONTE ORIGINALE: basi.md\nCHUNK source-b:chunk-001\nHeading path: Basi\nDefinizione e spiegazione del prerequisito.',
    sources: [{ title: 'basi.md', note: 'Materiale originale del corso' }],
  });
});

test('source merge keeps original provenance and deduplicates equivalent online references', () => {
  const dossier: ResearchLessonDossier = {
    sectionId: 'lesson-prerequisite',
    title: 'Prerequisito',
    generatedAt: '2026-07-11T10:00:00.000Z',
    factualSummary: 'Fondamento verificato.',
    keyExamples: [],
    difficultSteps: [],
    avoidOversimplifying: [],
    controversies: [],
    recentDevelopments: [],
    sources: [
      {
        title: 'Documentazione ufficiale',
        url: 'https://example.com/docs/',
        note: 'Conferma il fondamento.',
      },
      { title: 'Articolo accademico', url: 'https://example.com/paper' },
    ],
  };

  const merged = mergePrerequisiteDossierSources(dossier, [
    { title: 'dispensa.pdf', note: 'Materiale originale del corso' },
    { title: 'Docs nel corso', url: 'https://example.com/docs' },
  ]);

  assert.deepEqual(merged.sources, [
    { title: 'dispensa.pdf', note: 'Materiale originale del corso', url: undefined },
    {
      title: 'Docs nel corso',
      url: 'https://example.com/docs',
      note: 'Conferma il fondamento.',
    },
    { title: 'Articolo accademico', url: 'https://example.com/paper', note: undefined },
  ]);
});

test('source merge preserves selected YouTube transcript and clip metadata', () => {
  const dossier: ResearchLessonDossier = {
    sectionId: 'lesson-video',
    title: 'Dimostrazione',
    generatedAt: '2026-07-18T10:00:00.000Z',
    factualSummary: 'Passaggio verificato.',
    keyExamples: [],
    difficultSteps: [],
    avoidOversimplifying: [],
    controversies: [],
    recentDevelopments: [],
    sources: [
      {
        title: 'Tutorial pratico',
        url: 'https://www.youtube.com/watch?v=M7lc1UVf-VE',
        videoClip: { startSeconds: 65, endSeconds: 92 },
        youtubeTranscript: {
          ranges: [
            { startSeconds: 65, endSeconds: 70 },
            { startSeconds: 80, endSeconds: 93 },
          ],
          text: '[01:05-01:10] Primo passaggio.\n[01:20-01:33] Risultato.',
        },
      },
    ],
  };

  const merged = mergePrerequisiteDossierSources(dossier, [
    {
      title: 'Tutorial già noto',
      url: 'https://www.youtube.com/watch?v=M7lc1UVf-VE',
    },
  ]);

  assert.deepEqual(merged.sources[0]?.videoClip, { startSeconds: 65, endSeconds: 92 });
  assert.deepEqual(merged.sources[0]?.youtubeTranscript, dossier.sources[0]?.youtubeTranscript);
});
