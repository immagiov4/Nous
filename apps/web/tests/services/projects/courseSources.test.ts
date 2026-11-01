import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  attachStoredSources,
  buildCombinedSourceIndex,
  buildCourseSourceDescriptors,
  createProjectSourceFromDescriptors,
  detachStoredSources,
  formatCourseSourceSetContext,
  getCourseSourceDescriptors,
  mergeCourseSourceDescriptors,
  parseMarkdownOutline,
} from '../../../services/projects/courseSources.ts';
import { encodeTextBase64 } from '../../../services/projects/projectSource.ts';
import type { FileData, ProjectSource, ProjectSourceRef } from '../../../types.ts';

const textFile = (name: string, text: string, mimeType = 'text/plain'): FileData => ({
  data: encodeTextBase64(text),
  mimeType,
  name,
});

test('source chunks and their assessment sample retain whole boundary characters', () => {
  const text = `${'a'.repeat(7_999)}𝑋${'z'.repeat(8_000)}`;
  const sources = buildCourseSourceDescriptors([textFile('symbols.txt', text)]);
  const chunks = sources[0].documentIndex?.chunks || [];
  assert.equal(chunks.map(chunk => chunk.text).join(''), text);
  assert.ok(chunks.every(chunk => !/[\uD800-\uDFFF]/u.test(chunk.text)));
  for (const chunk of chunks) {
    assert.equal(text.slice(chunk.startOffset, chunk.endOffset), chunk.text);
  }
  const sample = JSON.parse(formatCourseSourceSetContext(sources)).sampledContent;
  assert.ok(!/[\uD800-\uDFFF]/u.test(sample));
  assert.ok(sample.includes('𝑋'));
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

test('archives stay outside document descriptors and replacing one document preserves the others', () => {
  const archiveSources = getCourseSourceDescriptors({
    file: {
      data: 'UEs=',
      mimeType: 'application/zip',
      name: 'engine.zip',
    },
    index: {
      entries: [
        {
          byteSize: 8,
          contentKind: 'text',
          kind: 'file',
          path: 'README.md',
          preview: '# Engine',
        },
      ],
    },
    kind: 'archive',
    name: 'engine.zip',
  });
  assert.deepEqual(archiveSources, []);

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

test('replacing a single source preserves its identity even when its filename changes', () => {
  const [existing] = buildCourseSourceDescriptors([textFile('old.txt', 'old')]);
  const [replacement] = buildCourseSourceDescriptors([textFile('renamed.txt', 'new')]);

  const merged = mergeCourseSourceDescriptors([existing], [replacement]);

  assert.equal(merged.length, 1);
  assert.equal(merged[0]?.id, existing.id);
  assert.equal(merged[0]?.file.sourceId, existing.id);
  assert.equal(merged[0]?.name, 'renamed.txt');
  assert.equal(merged[0]?.documentIndex?.chunks[0]?.text, 'new');
});

test('detached PDFs remain discoverable through their stored source reference', () => {
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
      objectPath: 'users/user/projects/project/stored-source-id/original',
    },
  });

  assert.equal(descriptors.length, 1);
  assert.equal(descriptors[0]?.id, 'stored-source-id');
  assert.equal(descriptors[0]?.hash, 'stored-hash');
  assert.equal(descriptors[0]?.file.sourceId, 'stored-source-id');
  assert.equal(descriptors[0]?.file.data, '');
});

test('detaches and rehydrates every document source without losing source identities', () => {
  const descriptors = buildCourseSourceDescriptors([
    textFile('notes.txt', 'Same content'),
    textFile('notes.txt', 'Same content'),
  ]);
  const source = createProjectSourceFromDescriptors(descriptors);
  const refs: ProjectSourceRef[] = descriptors.map((descriptor, position) => ({
    byteSize: 12,
    hash: `${position}`.repeat(64),
    id: descriptor.id,
    mimeType: descriptor.file.mimeType,
    name: descriptor.name,
    objectPath: `users/user/projects/project/${descriptor.id}/original`,
  }));

  const detached = detachStoredSources(source, refs);

  assert.equal(detached.file.data, '');
  assert.equal(detached.ref?.id, descriptors[0]?.id);
  assert.deepEqual(
    detached.sources?.map(descriptor => ({
      data: descriptor.file.data,
      id: descriptor.id,
      refId: descriptor.ref?.id,
    })),
    descriptors.map(descriptor => ({ data: '', id: descriptor.id, refId: descriptor.id }))
  );
  assert.deepEqual(
    buildCombinedSourceIndex(getCourseSourceDescriptors(detached))?.chunks.map(chunk => chunk.text),
    ['Same content', 'Same content']
  );

  const hydrated = attachStoredSources(
    detached,
    descriptors.map(descriptor => descriptor.file)
  );
  assert.deepEqual(
    hydrated.sources?.map(descriptor => descriptor.file.data),
    descriptors.map(descriptor => descriptor.file.data)
  );
  assert.equal(hydrated.file.data, descriptors[0]?.file.data);
});

test('retains a reattached PDF transcript when converting and merging source descriptors', () => {
  const file: FileData = { name: 'notes.pdf', mimeType: 'application/pdf', data: 'cGRm' };
  const [original] = buildCourseSourceDescriptors([file]);
  const preparedPdfText = {
    text: 'Machine transcription $x=2$.',
    sourceHash: original.hash,
    pages: [
      {
        pageNumber: 7,
        text: 'Machine transcription $x=2$.',
        provenance: {
          kind: 'vision-transcription' as const,
          pageNumber: 7,
          model: 'recorded',
          provider: 'recorded',
        },
      },
    ],
    parser: 'pdf-parse' as const,
    usedFallbackParser: true,
    outline: [],
    outlineOrigin: 'none' as const,
  };
  const incoming: ProjectSource = { kind: 'pdf', file, preparedPdfText };
  const old = {
    ...original,
    id: 'retained-source',
    file: { ...file, sourceId: 'retained-source' },
  };
  const replacement = createProjectSourceFromDescriptors(
    mergeCourseSourceDescriptors([old], getCourseSourceDescriptors(incoming))
  );
  assert.deepEqual(replacement.sources?.[0].preparedPdfText, preparedPdfText);
  assert.equal(replacement.sources?.[0].id, 'retained-source');
  assert.equal(replacement.sources?.[0].preparedPdfText?.sourceHash, replacement.sources?.[0].hash);
});

test('preserves CRLF Markdown headings and their original source offsets', () => {
  const text = 'Preamble\r\n# First\r\nContent\r\n## Second\r\nMore';
  const outlines = parseMarkdownOutline(text, 'source');
  assert.equal(outlines[0]?.title, 'First');
  assert.equal(outlines[0]?.startOffset, text.indexOf('# First'));
  assert.equal(outlines[0]?.children[0]?.title, 'Second');
  assert.equal(outlines[0]?.children[0]?.startOffset, text.indexOf('## Second'));
});
