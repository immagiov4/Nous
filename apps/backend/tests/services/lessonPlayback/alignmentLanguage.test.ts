import { expect, test } from 'vitest';
import { alignmentLanguage } from '../../../src/services/lessonPlayback/alignmentLanguage.js';

test.each([
  ['Italiano', 'ita'],
  ['English', 'eng'],
  ['en-US', 'eng'],
  ['ita', 'ita'],
  ['日本語', 'jpn'],
  ['Giapponese', 'jpn'],
  ['fr-FR', 'fra'],
  ['Deutsch', 'deu'],
  ['Español', 'spa'],
  ['Português', 'por'],
  ['中文', 'zho'],
  ['العربية', 'ara'],
])('resolves explicit narration language %s to %s', (language, code) => {
  expect(alignmentLanguage(language)).toBe(code);
});

test.each([
  '',
  'Unknown language',
  'English or Italian',
  'eng|task_language=ita',
])('rejects ambiguous or unsupported metadata: %s', language => {
  expect(() => alignmentLanguage(language)).toThrow('Unsupported recording alignment language.');
});
