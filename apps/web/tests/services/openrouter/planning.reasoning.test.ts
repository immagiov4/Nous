import assert from 'node:assert/strict';
import { SOURCE_ARCHIVE_LESSON_CONTEXT_MAX_BYTES } from '@shared/sourceArchiveSelectors';
import { beforeEach, test, vi } from 'vitest';
import { buildCourseSourceDescriptors } from '../../../services/projects/courseSources.ts';
import { encodeTextBase64 } from '../../../services/projects/projectSource.ts';
import type { FileData } from '../../../types.ts';
import { flattenLessons } from '../../../utils/learning/pathNodes.ts';

const callOpenRouterMock = vi.fn();
const callOpenRouterWithToolsMock = vi.fn();
const retryWithBackoffMock = vi.fn(async <T>(operation: () => Promise<T>) => await operation());
const getCourseYouTubeResearchContextMock = vi.fn(async () => ({
  context: 'Transcript YouTube verificato per il corso.',
  rationale: 'Fonte video pertinente.',
  videoCandidates: [],
  videoClipsEnabled: true,
}));
const ARCHIVE_REF = {
  byteSize: 128,
  hash: 'a'.repeat(64),
  id: 'source-engine',
  mimeType: 'application/zip',
  name: 'engine.zip',
  objectPath: 'users/user/projects/engine/source-engine/original',
};

vi.mock('../../../services/openrouter/shared.ts', async importOriginal => {
  const actual = await importOriginal<typeof import('../../../services/openrouter/shared.ts')>();
  return {
    ...actual,
    MODEL_REASONING: 'reasoning-model',
    callOpenRouter: callOpenRouterMock,
    callOpenRouterWithTools: callOpenRouterWithToolsMock,
    retryWithBackoff: retryWithBackoffMock,
  };
});

vi.mock('../../../services/openrouter/research.ts', () => ({
  formatYouTubeResearchContextForPrompt: (context: string) => `YOUTUBE:\n${context}`,
  getCourseYouTubeResearchContext: getCourseYouTubeResearchContextMock,
}));

const {
  generateLearningPlan,
  generateLearningPlanFromSourceArchive,
  generateLearningPlanFromSourceSet,
} = await import('../../../services/openrouter/planning/index.ts');

beforeEach(() => {
  callOpenRouterMock.mockReset();
  callOpenRouterWithToolsMock.mockReset();
  retryWithBackoffMock.mockImplementation(async <T>(operation: () => Promise<T>) => {
    return await operation();
  });
  retryWithBackoffMock.mockClear();
});

test('generateLearningPlan uses medium effort for both first draft and refinement', async () => {
  callOpenRouterMock
    .mockResolvedValueOnce('Brief web con fonti aggiornate.')
    .mockResolvedValueOnce(
      JSON.stringify({
        title: 'Percorso breve',
        summary: 'Sintesi',
        sections: [
          {
            id: 'section-1',
            moduleTitle: 'Modulo 1',
            title: 'Concetto chiave',
            description: 'Spiega il concetto chiave del testo.',
            type: 'core',
            isCompleted: false,
          },
        ],
      })
    )
    .mockResolvedValueOnce(
      JSON.stringify({
        title: 'Percorso breve',
        summary: 'Sintesi',
        sections: [
          {
            id: 'section-1',
            moduleTitle: 'Modulo 1',
            title: 'Concetto chiave',
            description: 'Spiega il concetto chiave del testo.',
            type: 'core',
            isCompleted: false,
          },
        ],
      })
    );

  const file: FileData = {
    name: 'paper.txt',
    mimeType: 'text/plain',
    data: encodeTextBase64('Breve paper scientifico con un solo concetto davvero centrale.'),
  };

  const plan = await generateLearningPlan(file, []);

  assert.equal(flattenLessons(plan.modules).length, 1);
  assert.equal(callOpenRouterMock.mock.calls.length, 3);
  assert.deepEqual(callOpenRouterMock.mock.calls[0]?.[0]?.tools, [
    { type: 'openrouter:web_search' },
  ]);
  assert.equal(callOpenRouterMock.mock.calls[1]?.[0]?.modelSlot, 'course');
  assert.equal(callOpenRouterMock.mock.calls[2]?.[0]?.modelSlot, 'course');
  assert.deepEqual(callOpenRouterMock.mock.calls[1]?.[0]?.reasoning, {
    effort: 'medium',
    exclude: false,
  });
  assert.deepEqual(callOpenRouterMock.mock.calls[2]?.[0]?.reasoning, {
    effort: 'medium',
    exclude: false,
  });
  assert.equal(getCourseYouTubeResearchContextMock.mock.calls.length, 1);
});

test('generateLearningPlanFromSourceSet plans across every source and deduplicates overlapping lessons', async () => {
  callOpenRouterMock
    .mockResolvedValueOnce('Brief web multifonte aggiornato.')
    .mockResolvedValueOnce(
      JSON.stringify({
        title: 'Percorso multifonte',
        summary: 'Sintesi integrata',
        sections: [
          {
            moduleTitle: 'Fondamenti',
            title: 'Effetto fotoelettrico',
            description: 'Spiega emissione elettronica, soglia di frequenza ed energia del fotone.',
            type: 'core',
          },
          {
            moduleTitle: 'Fondamenti',
            title: 'Effetto fotoelettrico',
            description: 'Spiega emissione elettronica, soglia di frequenza ed energia del fotone.',
            type: 'core',
          },
        ],
      })
    );
  const sources = buildCourseSourceDescriptors([
    {
      name: 'teoria.md',
      mimeType: 'text/markdown',
      data: encodeTextBase64('# Teoria\nEnergia dei fotoni e soglia di frequenza.'),
    },
    {
      name: 'esperimenti.txt',
      mimeType: 'text/plain',
      data: encodeTextBase64('Misure sperimentali dell emissione elettronica.'),
    },
  ]);

  const plan = await generateLearningPlanFromSourceSet(sources, []);
  const requestContent = String(callOpenRouterMock.mock.calls[1]?.[0]?.messages[1]?.content || '');

  assert.equal(callOpenRouterMock.mock.calls.length, 2);
  assert.equal(flattenLessons(plan.modules).length, 1);
  assert.ok(sources.every(source => requestContent.includes(source.id)));
  assert.deepEqual(callOpenRouterMock.mock.calls[0]?.[0]?.tools, [
    { type: 'openrouter:web_search' },
  ]);
  assert.equal(callOpenRouterMock.mock.calls[1]?.[0]?.modelSlot, 'course');
  assert.deepEqual(callOpenRouterMock.mock.calls[1]?.[0]?.reasoning, {
    effort: 'medium',
    exclude: false,
  });
});

test('generateLearningPlanFromSourceArchive inspects files with tools and persists exact lesson selectors', async () => {
  callOpenRouterMock.mockResolvedValueOnce('Brief web aggiornato.');
  callOpenRouterWithToolsMock
    .mockResolvedValueOnce(
      JSON.stringify({
        title: 'Motore di gioco',
        summary: 'Architettura del motore',
        sections: [
          {
            moduleTitle: 'Core',
            title: 'Ciclo principale',
            description: 'Spiega il ciclo principale e i confini del sottosistema.',
            type: 'core',
            isCompleted: false,
            sourceArchiveSelectors: [
              { kind: 'file', path: 'src/main.ts' },
              { kind: 'directory', path: 'src/runtime' },
            ],
          },
        ],
      })
    )
    .mockResolvedValueOnce(
      JSON.stringify({
        title: 'Motore di gioco',
        summary: 'Architettura del motore',
        sections: [
          {
            moduleTitle: 'Core',
            title: 'Ciclo principale',
            description: 'Spiega il ciclo principale e i confini del sottosistema.',
            type: 'core',
            isCompleted: false,
            sourceArchiveSelectors: [{ kind: 'file', path: 'src/main.ts' }],
          },
        ],
      })
    );

  const plan = await generateLearningPlanFromSourceArchive(
    {
      projectId: 'engine-project',
      source: {
        kind: 'archive',
        name: 'engine.zip',
        file: {
          data: 'UEs=',
          mimeType: 'application/zip',
          name: 'engine.zip',
        },
        index: {
          entries: [
            { kind: 'directory', path: 'src' },
            { kind: 'directory', path: 'src/runtime' },
            {
              byteSize: 40,
              contentKind: 'text',
              kind: 'file',
              path: 'src/main.ts',
              preview: 'export function main() {}',
            },
            {
              byteSize: 20,
              contentKind: 'text',
              kind: 'file',
              path: 'src/runtime/run.ts',
              preview: 'export const run = 1;',
            },
          ],
        },
        ref: ARCHIVE_REF,
      },
    },
    []
  );

  assert.deepEqual(flattenLessons(plan.modules)[0]?.sourceArchiveSelectors, [
    { kind: 'file', path: 'src/main.ts' },
  ]);
  assert.equal(callOpenRouterWithToolsMock.mock.calls.length, 2);
  assert.deepEqual(callOpenRouterWithToolsMock.mock.calls[0]?.[0]?.transforms, ['middle-out']);
  assert.match(
    String(callOpenRouterWithToolsMock.mock.calls[0]?.[0]?.messages[1]?.content || ''),
    /FILE src\/main\.ts/
  );
  assert.equal(typeof callOpenRouterWithToolsMock.mock.calls[0]?.[1], 'function');
});

test('generateLearningPlanFromSourceArchive keeps documentation tool-only outside the preview budget', async () => {
  const documentation = `${'documentation '.repeat(20_000)}FULL_DOCUMENT_SENTINEL`;
  const fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  callOpenRouterMock.mockResolvedValueOnce('Brief web aggiornato.');
  const planResponse = JSON.stringify({
    title: 'Motore di gioco',
    summary: 'Documentazione',
    sections: [
      {
        description: 'Spiega la documentazione.',
        moduleTitle: 'Core',
        sourceArchiveSelectors: [{ kind: 'file', path: 'README.md' }],
        title: 'Documentazione',
        type: 'core',
      },
    ],
  });
  callOpenRouterWithToolsMock.mockResolvedValue(planResponse);

  await generateLearningPlanFromSourceArchive(
    {
      projectId: 'engine-project',
      source: {
        file: {
          data: 'UEs=',
          mimeType: 'application/zip',
          name: 'engine.zip',
        },
        index: {
          entries: [
            {
              byteSize: new TextEncoder().encode(documentation).byteLength,
              contentKind: 'text',
              kind: 'file',
              path: 'README.md',
              preview: 'README_PREVIEW_SENTINEL',
            },
            {
              byteSize: 23,
              contentKind: 'text',
              kind: 'file',
              path: 'AAA.md',
              preview: 'FIRST_DOCUMENT_SENTINEL',
            },
          ],
        },
        kind: 'archive',
        name: 'engine.zip',
        ref: ARCHIVE_REF,
      },
    },
    []
  );

  const plannerPrompt = String(
    callOpenRouterWithToolsMock.mock.calls[0]?.[0]?.messages[1]?.content || ''
  );
  assert.match(plannerPrompt, /FIRST_DOCUMENT_SENTINEL/u);
  assert.match(plannerPrompt, /README_PREVIEW_SENTINEL/u);
  assert.doesNotMatch(plannerPrompt, /FULL_DOCUMENT_SENTINEL/u);
  assert.doesNotMatch(plannerPrompt, /DOCUMENTAZIONE TESTUALE COMPLETA/iu);
  assert.match(plannerPrompt, /cursorBytes/iu);
  assert.equal(fetchMock.mock.calls.length, 0);
});

test('generateLearningPlanFromSourceArchive retries an oversized directory with granular selectors', async () => {
  callOpenRouterMock.mockResolvedValueOnce('Brief web aggiornato.');
  const oversizedPlan = JSON.stringify({
    title: 'Motore di gioco',
    summary: 'Architettura',
    sections: [
      {
        moduleTitle: 'Core',
        title: 'Runtime',
        description: 'Spiega il runtime.',
        type: 'core',
        sourceArchiveSelectors: [{ kind: 'directory', path: 'src' }],
      },
    ],
  });
  const granularPlan = JSON.stringify({
    title: 'Motore di gioco',
    summary: 'Architettura',
    sections: [
      {
        moduleTitle: 'Core',
        title: 'Runtime',
        description: 'Spiega il runtime.',
        type: 'core',
        sourceArchiveSelectors: [{ kind: 'file', path: 'src/runtime.ts' }],
      },
    ],
  });
  callOpenRouterWithToolsMock
    .mockResolvedValueOnce(oversizedPlan)
    .mockResolvedValueOnce(granularPlan)
    .mockResolvedValueOnce(granularPlan);

  const plan = await generateLearningPlanFromSourceArchive(
    {
      projectId: 'engine-project',
      source: {
        kind: 'archive',
        name: 'engine.zip',
        file: {
          data: 'UEs=',
          mimeType: 'application/zip',
          name: 'engine.zip',
        },
        index: {
          entries: [
            { kind: 'directory', path: 'src' },
            {
              byteSize: 4_000_001,
              contentKind: 'text',
              kind: 'file',
              path: 'src/main.ts',
            },
            {
              byteSize: 120,
              contentKind: 'text',
              kind: 'file',
              path: 'src/runtime.ts',
            },
          ],
        },
        ref: ARCHIVE_REF,
      },
    },
    []
  );

  assert.deepEqual(flattenLessons(plan.modules)[0]?.sourceArchiveSelectors, [
    { kind: 'file', path: 'src/runtime.ts' },
  ]);
  assert.equal(callOpenRouterWithToolsMock.mock.calls.length, 3);
  const initialPrompt = String(
    callOpenRouterWithToolsMock.mock.calls[0]?.[0]?.messages[1]?.content || ''
  );
  const repairedPrompt = String(
    callOpenRouterWithToolsMock.mock.calls[1]?.[0]?.messages[1]?.content || ''
  );
  assert.ok(
    initialPrompt.includes(
      `${new Intl.NumberFormat('it-IT').format(SOURCE_ARCHIVE_LESSON_CONTEXT_MAX_BYTES)} byte`
    )
  );
  assert.match(initialPrompt, /selector più granulari/iu);
  assert.match(repairedPrompt, /src[/] main[.]ts|src[/]main[.]ts/iu);
  assert.ok(
    repairedPrompt.includes(
      new Intl.NumberFormat('it-IT').format(SOURCE_ARCHIVE_LESSON_CONTEXT_MAX_BYTES + 1)
    )
  );
});
