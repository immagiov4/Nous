import { beforeEach, describe, expect, test, vi } from 'vitest';
import { buildCourseSourceDescriptors } from '../../../services/projects/courseSources';
import type { PdfTextIndex } from '../../../types';
import { createDeferred } from '../../helpers/deferred';

const mocks = vi.hoisted(() => ({ load: vi.fn(), userId: 0 }));
vi.mock('../../../services/auth/supabaseAuth', () => ({
  readSupabaseSession: () => ({ user: { id: String(mocks.userId) } }),
}));
vi.mock('../../../services/projects/httpProjectRepository', () => ({
  HttpProjectRepository: class {
    loadProjectWithRevision = mocks.load;
  },
}));

import { loadDocumentText } from '../../../services/projects/documentText';

const createIndex = (deferred = false): PdfTextIndex => ({
  kind: 'pdf-text-index',
  parsedAt: '2026-10-21',
  sourceHash: 'hash',
  ...(deferred ? { textDeferred: true as const } : {}),
  chunks: [
    {
      id: 'one',
      text: deferred ? '' : 'Full source text',
      sequence: 0,
      headingPath: [],
      startOffset: 0,
      endOffset: 16,
    },
  ],
});
beforeEach(() => {
  mocks.load.mockReset();
  mocks.userId++;
});
describe('shared document text loader', () => {
  test('deduplicates simultaneous consumers and leaves the autosave snapshot unchanged', async () => {
    const current = { documentIndex: createIndex(true), source: null };
    const loaded = { documentIndex: createIndex(), source: null };
    mocks.load.mockResolvedValue({ revision: 1, snapshot: loaded });
    const results = await Promise.all([
      loadDocumentText('course', current),
      loadDocumentText('course', current),
    ]);
    expect(results).toEqual([loaded, loaded]);
    expect(mocks.load).toHaveBeenCalledTimes(1);
    expect(current.documentIndex.textDeferred).toBe(true);
    expect(current.documentIndex.chunks[0].text).toBe('');
    expect(await loadDocumentText('course', current)).toEqual(loaded);
    expect(mocks.load).toHaveBeenCalledTimes(1);
  });
  test('uses already loaded text without a network request', async () => {
    const current = { documentIndex: createIndex(), source: null };
    expect(await loadDocumentText(null, current)).toBe(current);
    expect(mocks.load).not.toHaveBeenCalled();
  });
  test('allows an explicit retry after a failed request', async () => {
    const current = { documentIndex: createIndex(true), source: null };
    mocks.load
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({ snapshot: { documentIndex: createIndex(), source: null } });
    await expect(loadDocumentText('course', current)).rejects.toThrow('offline');
    expect((await loadDocumentText('course', current)).documentIndex?.chunks[0].text).toBe(
      'Full source text'
    );
    expect(mocks.load).toHaveBeenCalledTimes(2);
  });
  test('rejects text from a changed source rather than grounding with a different document', async () => {
    const current = { documentIndex: createIndex(true), source: null };
    mocks.load.mockResolvedValue({
      snapshot: { documentIndex: { ...createIndex(), sourceHash: 'replacement' }, source: null },
    });
    await expect(loadDocumentText('course', current)).rejects.toMatchObject({
      code: 'revision-conflict',
    });
  });
});

test('loads source-local indexes when the course index is absent', async () => {
  const file = { name: 'source.pdf', mimeType: 'application/pdf', data: 'c3ludGhldGlj' };
  const sources = buildCourseSourceDescriptors([file]).map(source => ({
    ...source,
    documentIndex: createIndex(true),
  }));
  const current = { documentIndex: null, source: { kind: 'pdf' as const, file, sources } };
  const loaded = {
    documentIndex: createIndex(),
    source: {
      ...current.source,
      sources: sources.map(source => ({ ...source, documentIndex: createIndex() })),
    },
  };
  mocks.load.mockResolvedValue({ snapshot: loaded });
  expect(await loadDocumentText('course', current)).toEqual(loaded);
});

test('fails safely if a full-text request still returns deferred text', async () => {
  const current = { documentIndex: createIndex(true), source: null };
  mocks.load.mockResolvedValue({ snapshot: current });
  await expect(loadDocumentText('course', current)).rejects.toMatchObject({
    code: 'revision-conflict',
  });
});

test('does not reuse text across project identities sharing an index object', async () => {
  const current = { documentIndex: createIndex(true), source: null };
  const loaded = { documentIndex: createIndex(), source: null };
  mocks.load.mockResolvedValue({ snapshot: loaded });
  await loadDocumentText('course-a', current);
  await loadDocumentText('course-b', current);
  expect(mocks.load).toHaveBeenCalledTimes(2);
});

test('shares source-local text across equivalent source objects adopted by autosave', async () => {
  const file = { name: 'source.pdf', mimeType: 'application/pdf', data: 'c3ludGhldGlj' };
  const sources = buildCourseSourceDescriptors([file]).map(source => ({
    ...source,
    documentIndex: createIndex(true),
  }));
  const current = { documentIndex: null, source: { kind: 'pdf' as const, file, sources } };
  const adopted = structuredClone(current);
  const complete = createDeferred();
  const loaded = {
    documentIndex: createIndex(),
    source: {
      ...current.source,
      sources: sources.map(source => ({ ...source, documentIndex: createIndex() })),
    },
  };
  mocks.load.mockReturnValue(complete.promise.then(() => ({ snapshot: loaded })));
  const first = loadDocumentText('autosave-course', current);
  const second = loadDocumentText('autosave-course', adopted);
  const third = loadDocumentText('autosave-course', {
    ...adopted,
    documentIndex: createIndex(true),
  });
  expect(mocks.load).toHaveBeenCalledTimes(1);
  complete.resolve();
  expect(await first).toEqual(loaded);
  expect(await second).toEqual(loaded);
  expect(await third).toEqual(loaded);
  expect(await loadDocumentText('autosave-course', structuredClone(adopted))).toEqual(loaded);
  expect(mocks.load).toHaveBeenCalledTimes(1);
});

test('clears cached source text when the signed-in account changes', async () => {
  const current = { documentIndex: createIndex(true), source: null };
  const loaded = { documentIndex: createIndex(), source: null };
  mocks.load.mockResolvedValue({ snapshot: loaded });
  await loadDocumentText('same-course-id', current);
  mocks.userId++;
  await loadDocumentText('same-course-id', current);
  expect(mocks.load).toHaveBeenCalledTimes(2);
});
