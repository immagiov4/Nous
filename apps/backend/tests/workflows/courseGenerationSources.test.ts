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

describe('course generation source material reader', () => {
  test('loads only the frozen source identities in their prepared order', async () => {
    const readSourceMaterial = vi.fn().mockResolvedValue({ text: 'contenuto valido' });
    const reader = createCourseSourceMaterialReader({
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
  const reader = createCourseSourceMaterialReader({
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
});

test('passes the durable account models and cancellation signal when prepared text is absent', async () => {
  const readSourceMaterial = vi.fn().mockResolvedValue({ text: 'source' });
  const reader = createCourseSourceMaterialReader({
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
  expect(readSourceMaterial).toHaveBeenCalledWith(expect.anything(), { config, signal });
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
