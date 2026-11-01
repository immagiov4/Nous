import { describe, expect, test, vi } from 'vitest';
import { getGlobalModelConfig } from '../../src/config/modelConfig.js';

import {
  createCourseSourceMaterialReader,
  formatCourseSourceMaterials,
} from '../../src/workflows/courseGenerationSources.js';

const preparedState = {
  context: {
    assessmentSummary: 'USER: Fammi un corso.',
    language: 'Italiano',
    profile: null,
    sourceNames: ['notes.md'],
    sources: [
      {
        hash: 'a'.repeat(64),
        id: 'source-ready',
        kind: 'markdown',
        mimeType: 'text/markdown',
        name: 'notes.md',
      },
    ],
    topic: 'Corso',
  },
  projectRevision: 4,
  request: { mode: 'document' as const, projectId: 'project-1', userId: 'user-1' },
  stage: 'prepared' as const,
  strategy: 'source-set' as const,
};

const storedSource = (id: string, hash: string, data: string) => ({
  file: { data, mimeType: 'text/markdown', name: `${id}.md`, sourceId: id },
  ref: {
    byteSize: data.length,
    hash,
    id,
    mimeType: 'text/markdown',
    name: `${id}.md`,
    objectPath: `users/user-1/projects/project-1/sources/${id}`,
  },
});

test.each([
  ['short prefix', 10, 9],
  ['beginning end', 44, 9],
  ['middle start', 44, 44],
  ['middle end', 44, 54],
  ['ending start', 44, 89],
] as const)('source sampling preserves the character crossing %s', (_boundary, budget, offset) => {
  const text = `${'a'.repeat(offset)}𝑋${'z'.repeat(100 - offset - 2)}`;
  const material = { descriptor: preparedState.context.sources[0], text };
  const formatted = formatCourseSourceMaterials([material], budget);
  const excerpt = formatted.split('<excerpt>\n')[1].split('\n</excerpt>')[0];
  expect(!/[\uD800-\uDFFF]/u.test(excerpt)).toBe(true);
  expect(excerpt).toContain('𝑋');
  expect(excerpt).not.toContain('�');
  expect(
    JSON.parse(JSON.stringify({ input: [{ type: 'text', text: formatted }] })).input[0].text
  ).toBe(formatted);
  expect(material.text).toBe(text);
});

test('source sampling keeps the existing three windows for BMP text and full short sources', () => {
  const descriptor = preparedState.context.sources[0];
  const text = 'abcdefghijklmnopqrstuvwxyz'.repeat(4);
  const formatted = formatCourseSourceMaterials([{ descriptor, text }], 44);
  expect(formatted.split('<excerpt>\n')[1].split('\n</excerpt>')[0]).toBe(
    [text.slice(0, 10), text.slice(47, 57), text.slice(-10)].join('\n\n[…]\n\n')
  );
  expect(formatCourseSourceMaterials([{ descriptor, text: '𝑋' }], 2)).toContain('\n𝑋\n');
});

describe('course generation source material reader', () => {
  test('loads only the frozen source identities in their prepared order', async () => {
    const readSourceMaterial = vi.fn().mockResolvedValue({ text: 'contenuto valido' });
    const reader = createCourseSourceMaterialReader({
      loadProjectSourceById: vi
        .fn()
        .mockResolvedValue(storedSource('source-ready', 'a'.repeat(64), 'encoded').file),
      loadProjectSources: vi
        .fn()
        .mockResolvedValue([
          storedSource('source-failed', 'b'.repeat(64), 'ignored'),
          storedSource('source-ready', 'a'.repeat(64), 'encoded'),
        ]),
      loadProjectWithRevision: vi.fn().mockResolvedValue({ revision: 4, snapshot: {} }),
      readSourceMaterial,
    });

    const result = await reader(preparedState);

    expect(result).toEqual([
      {
        descriptor: preparedState.context.sources[0],
        text: 'contenuto valido',
      },
    ]);
    expect(readSourceMaterial).toHaveBeenCalledTimes(1);
    expect(readSourceMaterial).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'source-ready.md' })
    );
  });

  test.each([
    {
      code: 'course_source_changed',
      loadProjectSources: [storedSource('source-ready', 'a'.repeat(64), 'encoded')],
      revision: 5,
    },
    {
      code: 'course_source_changed',
      loadProjectSources: [storedSource('source-ready', 'c'.repeat(64), 'encoded')],
      revision: 4,
    },
  ])('fails permanently when frozen source identity changes', async input => {
    const reader = createCourseSourceMaterialReader({
      loadProjectSourceById: vi
        .fn()
        .mockResolvedValue(storedSource('source-ready', 'a'.repeat(64), 'encoded').file),
      loadProjectSources: vi.fn().mockResolvedValue(input.loadProjectSources),
      loadProjectWithRevision: vi.fn().mockResolvedValue({
        revision: input.revision,
        snapshot: {},
      }),
      readSourceMaterial: vi.fn().mockResolvedValue({ text: 'contenuto' }),
    });

    const failure = await reader(preparedState).catch(error => error);

    expect(failure.failure).toMatchObject({ code: input.code, kind: 'permanent' });
  });

  test('rejects a source without readable text before planning', async () => {
    const reader = createCourseSourceMaterialReader({
      loadProjectSourceById: vi
        .fn()
        .mockResolvedValue(storedSource('source-ready', 'a'.repeat(64), 'encoded').file),
      loadProjectSources: vi
        .fn()
        .mockResolvedValue([storedSource('source-ready', 'a'.repeat(64), 'encoded')]),
      loadProjectWithRevision: vi.fn().mockResolvedValue({ revision: 4, snapshot: {} }),
      readSourceMaterial: vi.fn().mockResolvedValue({ text: '   ' }),
    });

    const failure = await reader(preparedState).catch(error => error);

    expect(failure.failure).toMatchObject({
      code: 'course_source_text_missing',
      kind: 'permanent',
    });
  });
});

test('reuses the durable prepared PDF text with matching source hash instead of paying for another transcription', async () => {
  const pdf = {
    text: 'Prepared transcription',
    pages: [{ pageNumber: 1, text: 'Prepared transcription' }],
    sourceHash: 'a'.repeat(64),
    parser: 'pdf-parse',
    usedFallbackParser: true,
    outline: [],
    outlineOrigin: 'none',
  };
  const readSourceMaterial = vi.fn();
  const loadProjectSourceById = vi
    .fn()
    .mockResolvedValue(storedSource('source-ready', 'a'.repeat(64), 'encoded').file);
  const reader = createCourseSourceMaterialReader({
    loadProjectSourceById,
    loadProjectSources: vi
      .fn()
      .mockResolvedValue([storedSource('source-ready', 'a'.repeat(64), 'encoded')]),
    loadProjectWithRevision: vi.fn().mockResolvedValue({
      revision: 4,
      snapshot: { source: { sources: [{ id: 'source-ready', preparedPdfText: pdf }] } },
    }),
    readSourceMaterial,
  });
  const result = await reader(preparedState);
  expect(result[0].text).toBe(pdf.text);
  expect(result[0].pdf?.pages).toEqual(pdf.pages);
  expect(readSourceMaterial).not.toHaveBeenCalled();
  expect(loadProjectSourceById).not.toHaveBeenCalled();
});

test('loads the original file for pure extraction when prepared text is absent', async () => {
  const readSourceMaterial = vi.fn().mockResolvedValue({ text: 'source' });
  const loadProjectSourceById = vi
    .fn()
    .mockResolvedValue(storedSource('source-ready', 'a'.repeat(64), 'encoded').file);
  const reader = createCourseSourceMaterialReader({
    loadProjectSourceById,
    loadProjectSources: vi
      .fn()
      .mockResolvedValue([storedSource('source-ready', 'a'.repeat(64), 'encoded')]),
    loadProjectWithRevision: vi.fn().mockResolvedValue({ revision: 4, snapshot: {} }),
    readSourceMaterial,
  });
  const config = {
    ...getGlobalModelConfig(),
    aiProvider: 'codex' as const,
    aiProviderOverrides: { research: 'codex' as const },
  };
  const signal = new AbortController().signal;
  await reader(preparedState, signal, config);
  expect(readSourceMaterial).toHaveBeenCalledWith(expect.anything());
});

test('course planning retains transcription provenance even when sampling omits the page marker', () => {
  const text = 'Middle of a page without its header.';
  const material = {
    descriptor: preparedState.context.sources[0],
    text,
    pdf: {
      text,
      pages: [
        {
          pageNumber: 7,
          text,
          provenance: {
            kind: 'vision-transcription' as const,
            pageNumber: 7,
            model: 'recorded',
            provider: 'recorded',
          },
        },
      ],
      sourceHash: 'synthetic',
      parser: 'pdf-parse' as const,
      usedFallbackParser: true,
      outline: [],
      outlineOrigin: 'none' as const,
    },
  };
  const formatted = formatCourseSourceMaterials([material], 1);
  const source = /^<source id="([^"]+)" name="([^"]+)">\n([\s\S]*)\n<\/source>$/.exec(formatted);
  expect(source?.slice(1, 3)).toEqual([material.descriptor.id, material.descriptor.name]);
  const provenance =
    /^<source-provenance>([^\n]+)<\/source-provenance>\n<excerpt>\n([\s\S]*)\n<\/excerpt>$/.exec(
      source?.[3] || ''
    );
  expect(JSON.parse(provenance?.[1] || 'null')).toEqual({
    kind: 'vision-transcription',
    transcribedPages: [7],
  });
  expect(provenance?.[2]).toBe('M');
});

test('loads thirty frozen PDFs one at a time without hydrating the complete course', async () => {
  const sources = Array.from({ length: 30 }, (_, index) =>
    storedSource(`source-${index}`, 'a'.repeat(64), '')
  );
  const state = {
    ...preparedState,
    context: {
      ...preparedState.context,
      sources: sources.map(source => ({
        hash: source.ref.hash,
        id: source.ref.id,
        kind: 'pdf' as const,
        mimeType: 'application/pdf',
        name: source.file.name,
      })),
    },
  };
  let pending = 0;
  let maximum = 0;
  const loadProjectSourceById = vi.fn(async (_user: string, _project: string, id: string) => {
    pending += 1;
    maximum = Math.max(maximum, pending);
    return { data: 'encoded', mimeType: 'application/pdf', name: `${id}.pdf` };
  });
  const reader = createCourseSourceMaterialReader({
    loadProjectSources: vi.fn().mockResolvedValue(sources),
    loadProjectSourceById,
    loadProjectWithRevision: vi.fn().mockResolvedValue({ revision: 4, snapshot: {} }),
    readSourceMaterial: vi.fn(async () => {
      pending -= 1;
      return { text: 'source content' };
    }),
  });
  expect(await reader(state)).toHaveLength(30);
  expect(loadProjectSourceById).toHaveBeenCalledTimes(30);
  expect(maximum).toBe(1);
});
