import assert from 'node:assert/strict';
import { test } from 'vitest';
import { buildAssessmentDocumentContextFromSourceSet } from '../../../services/openrouter/assessment.ts';
import { buildCourseSourceDescriptors } from '../../../services/projects/courseSources.ts';
import { encodeTextBase64 } from '../../../services/projects/projectSource.ts';

test('multi-source assessment context preserves every independent source index', () => {
  const sources = buildCourseSourceDescriptors([
    {
      name: 'fondamenti.md',
      mimeType: 'text/markdown',
      data: encodeTextBase64('# Fondamenti\nConcetti di base.'),
    },
    {
      name: 'casi.txt',
      mimeType: 'text/plain',
      data: encodeTextBase64('Applicazioni e casi di studio.'),
    },
  ]);
  const context = buildAssessmentDocumentContextFromSourceSet(sources);

  assert.ok(sources.every(source => context.content.includes(source.id)));
  assert.ok(context.content.includes('Concetti di base.'));
  assert.ok(context.content.includes('Applicazioni e casi di studio.'));
  assert.equal(context.hasReliableSourceContext, true);
});

test('assessment of a saved legacy source index does not separate surrogate halves into provider input', () => {
  const text = `𝑋${'a'.repeat(7_997)}𝑋${'z'.repeat(100)}`;
  const sources = buildCourseSourceDescriptors([
    { name: 'legacy.txt', mimeType: 'text/plain', data: encodeTextBase64(text) },
  ]);
  const source = sources[0];
  const index = source.documentIndex;
  if (!index) throw new Error('Missing source index fixture');
  // Saved before Unicode-safe chunking: the old 8,000-unit split separates this valid pair.
  index.chunks = [
    { ...index.chunks[0], text: text.slice(0, 8_000), startOffset: 0, endOffset: 8_000 },
    { ...index.chunks[1], text: text.slice(8_000), startOffset: 8_000, endOffset: text.length },
  ];
  const persisted = JSON.parse(JSON.stringify(sources));
  const before = JSON.stringify(persisted);
  const context = buildAssessmentDocumentContextFromSourceSet(persisted);
  assert.equal(context.hasReliableSourceContext, true);
  assert.doesNotMatch(context.content, /\\u[dD][89a-fA-F][0-9a-fA-F]{2}/u);
  const sample = JSON.parse(context.content.split('\n').at(-1) || '{}').sampledContent;
  assert.doesNotMatch(sample, /[\uD800-\uDFFF]/u);
  assert.equal(sample, `𝑋${'a'.repeat(7_997)}\n`);
  assert.equal(sample.length, 8_000);
  assert.equal(JSON.stringify(persisted), before);
  assert.equal(persisted[0].file.data, encodeTextBase64(text));
});
