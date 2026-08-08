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
