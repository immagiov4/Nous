import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  buildCombinedSourceIndex,
  buildCourseSourceDescriptors,
  getCourseSourceDescriptors,
  mergeCourseSourceDescriptors,
  parseMarkdownOutline,
} from '../../../services/projects/courseSources.ts';
import { encodeTextBase64 } from '../../../services/projects/projectSource.ts';
import type { FileData } from '../../../types.ts';

const textFile = (name: string, text: string, mimeType = 'text/plain'): FileData => ({
  data: encodeTextBase64(text),
  mimeType,
  name,
});

test('course sources use a stable alphabetical order without merging their content', () => {
  const descriptors = buildCourseSourceDescriptors([
    textFile('zeta.txt', 'Zeta material'),
    textFile('Alpha.md', '# Alpha\nAlpha material', 'text/markdown'),
  ]);

  assert.deepEqual(
    descriptors.map(source => source.name),
    ['Alpha.md', 'zeta.txt']
  );
  assert.equal(descriptors[0]?.file.sourceId, descriptors[0]?.id);
  assert.equal(descriptors[0]?.documentIndex?.chunks[0]?.text, '# Alpha\nAlpha material');
  assert.equal(descriptors[1]?.documentIndex?.chunks[0]?.text, 'Zeta material');
});

test('markdown outline supports ATX and Setext headings, ignores fences, and disambiguates duplicates', () => {
  const outline = parseMarkdownOutline(
    `# Fondamenti

\`\`\`md
# Non e un titolo
\`\`\`

Dettagli
--------

## Fondamenti
`,
    'source-a'
  );
  const flattened = outline.flatMap(node => [node, ...node.children]);

  assert.deepEqual(
    flattened.map(node => node.title),
    ['Fondamenti', 'Dettagli', 'Fondamenti']
  );
  assert.equal(new Set(flattened.map(node => node.id)).size, 3);
  assert.ok(flattened.every(node => typeof node.startOffset === 'number'));
  assert.ok(flattened.every(node => (node.endOffset || 0) > (node.startOffset || -1)));
});

test('same-name same-content sources keep collision-free source and chunk identities', () => {
  const descriptors = buildCourseSourceDescriptors([
    textFile('notes.txt', 'Same content'),
    textFile('notes.txt', 'Same content'),
  ]);
  const index = buildCombinedSourceIndex(descriptors);

  assert.equal(new Set(descriptors.map(source => source.id)).size, 2);
  assert.equal(new Set(index?.chunks.map(chunk => chunk.id)).size, 2);
  assert.deepEqual(
    new Set(index?.chunks.map(chunk => chunk.sourceId)),
    new Set(descriptors.map(s => s.id))
  );
});

test('legacy single-source projects migrate logically and reattaching one source preserves the others', () => {
  const legacyFile = textFile('legacy.md', '# Legacy', 'text/markdown');
  const legacySources = getCourseSourceDescriptors({
    kind: 'codebase-bundle',
    name: legacyFile.name,
    aggregatedText: '# Legacy',
    files: [],
    stats: {
      includedFileCount: 0,
      skippedFileCount: 0,
      totalCharacterCount: 8,
      truncatedFileCount: 0,
    },
  });
  assert.equal(legacySources.length, 1);
  assert.equal(legacySources[0]?.name, 'legacy.md');

  const existing = buildCourseSourceDescriptors([
    textFile('a.txt', 'old A'),
    textFile('b.txt', 'keep B'),
  ]);
  const replacement = buildCourseSourceDescriptors([textFile('a.txt', 'new A')]);
  const merged = mergeCourseSourceDescriptors(existing, replacement);

  assert.equal(merged.length, 2);
  assert.equal(merged[0]?.id, existing[0]?.id);
  assert.equal(merged[0]?.documentIndex?.chunks[0]?.text, 'new A');
  assert.equal(merged[1]?.documentIndex?.chunks[0]?.text, 'keep B');
});

test('detached legacy PDFs remain discoverable through their stored source reference', () => {
  const descriptors = getCourseSourceDescriptors({
    file: {
      data: '',
      mimeType: 'application/pdf',
      name: 'dispensa.pdf',
    },
    kind: 'pdf',
    ref: {
      byteSize: 1024,
      hash: 'stored-hash',
      id: 'stored-source-id',
      mimeType: 'application/pdf',
      name: 'dispensa.pdf',
    },
  });

  assert.equal(descriptors.length, 1);
  assert.equal(descriptors[0]?.id, 'stored-source-id');
  assert.equal(descriptors[0]?.hash, 'stored-hash');
  assert.equal(descriptors[0]?.file.sourceId, 'stored-source-id');
  assert.equal(descriptors[0]?.file.data, '');
});
