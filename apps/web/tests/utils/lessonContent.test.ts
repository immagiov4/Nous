import { deriveLegacyLessonContent } from '@shared/lessonContent';
import { expect, test } from 'vitest';

test('projects canonical Markdown blocks into trimmed legacy content', () => {
  expect(
    deriveLegacyLessonContent([
      { markdown: '  Prima sezione.\n  ', type: 'markdown' },
      { markdown: 'Non deve essere proiettato.', type: 'generated-visual' },
      { markdown: ' \n\t ', type: 'markdown' },
      { markdown: '\nSeconda sezione.  ', type: 'markdown' },
      { markdown: 42, type: 'markdown' },
    ])
  ).toBe('Prima sezione.\n\nSeconda sezione.');
});

test('projects empty canonical content to an empty legacy string', () => {
  expect(deriveLegacyLessonContent([])).toBe('');
});
