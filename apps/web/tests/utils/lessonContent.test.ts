import { deriveLegacyLessonContent, isCanonicalLessonContentBlock } from '@shared/lessonContent';
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

test('accepts old quizzes and text explanations but rejects malformed explanation payloads', () => {
  const quiz = { question: 'Quale?', options: ['A', 'B', 'C', 'D'], correctIndex: 0 };
  expect(isCanonicalLessonContentBlock({ type: 'inline-quiz', quiz })).toBe(true);
  expect(
    isCanonicalLessonContentBlock({
      type: 'inline-quiz',
      quiz: { ...quiz, explanation: 'Motivo della risposta.' },
    })
  ).toBe(true);
  expect(
    isCanonicalLessonContentBlock({
      type: 'inline-quiz',
      quiz: { ...quiz, explanation: { text: 'Dato non valido' } },
    })
  ).toBe(false);
});
