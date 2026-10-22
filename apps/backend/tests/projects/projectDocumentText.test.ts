import { describe, expect, test } from 'vitest';
import {
  deferProjectDocumentText,
  restoreProjectDocumentText,
} from '../../src/projects/projectDocumentText';

const index = {
  kind: 'pdf-text-index',
  parsedAt: '2026-10-21',
  chunks: [{ id: 'one', text: 'Full source text', pageStart: 2 }],
};
const stored = {
  documentIndex: index,
  source: { sources: [{ id: 'source', documentIndex: index }] },
  researchDossiersBySectionId: { lesson: { factualSummary: 'Dossier' } },
};
describe('deferred project source text', () => {
  test('keeps source navigation metadata and dossiers while omitting segment text', () => {
    const opened = deferProjectDocumentText(stored);
    expect(opened.documentIndex).toEqual({
      ...index,
      textDeferred: true,
      chunks: [{ id: 'one', text: '', pageStart: 2 }],
    });
    expect(JSON.stringify(opened)).not.toContain('Full source text');
    expect(opened.researchDossiersBySectionId).toEqual(stored.researchDossiersBySectionId);
    expect(stored.documentIndex.chunks[0].text).toBe('Full source text');
  });
  test('saving an unopened source retains both indexes', () => {
    expect(restoreProjectDocumentText(deferProjectDocumentText(stored), stored)).toEqual(stored);
  });
  test('an absent or null index in a generic save means unchanged', () => {
    expect(restoreProjectDocumentText({ source: null }, stored).documentIndex).toEqual(index);
    expect(
      restoreProjectDocumentText({ documentIndex: null, source: null }, stored).documentIndex
    ).toEqual(index);
  });
  test('rejects a deferred index with no authoritative stored text', () => {
    expect(() => restoreProjectDocumentText(deferProjectDocumentText(stored), null)).toThrow();
  });
});

test('keeps PDF preparation warnings and page metadata without prepared text', () => {
  const preparedPdfText = {
    text: 'Prepared PDF text',
    pages: [
      { pageNumber: 2, text: 'Prepared page text', provenance: { kind: 'vision-transcription' } },
    ],
    failedPages: [3],
    blankPages: [1],
    pageCount: 3,
  };
  const snapshot = {
    ...stored,
    source: { preparedPdfText, sources: [{ id: 'source', documentIndex: index, preparedPdfText }] },
  };
  const opened = deferProjectDocumentText(snapshot);
  const metadata = {
    ...preparedPdfText,
    text: '',
    pages: [{ ...preparedPdfText.pages[0], text: '' }],
  };
  expect(opened.source.preparedPdfText).toEqual(metadata);
  expect(opened.source.sources[0].preparedPdfText).toEqual(metadata);
  expect(JSON.stringify(opened)).not.toContain('Prepared PDF text');
  expect(JSON.stringify(opened)).not.toContain('Prepared page text');
  expect(snapshot.source.preparedPdfText.text).toBe('Prepared PDF text');
});
