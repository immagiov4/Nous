import assert from 'node:assert/strict';
import { getMarkdownMathRangeAt } from '@shared/markdownMathSyntax';

const scriptPatterns = [
  'Latin',
  'Greek',
  'Cyrillic',
  'Arabic',
  'Hebrew',
  'Han',
  'Hiragana',
  'Katakana',
  'Hangul',
  'Devanagari',
  'Bengali',
  'Tamil',
  'Telugu',
  'Thai',
  'Armenian',
  'Georgian',
  'Ethiopic',
  'Myanmar',
  'Khmer',
  'Lao',
  'Sinhala',
  'Gujarati',
  'Gurmukhi',
  'Kannada',
  'Malayalam',
  'Oriya',
  'Tibetan',
].map(script => ({ script, pattern: new RegExp(String.raw`\p{Script=${script}}`, 'u') }));

const dominantProseScript = (markdown: string): string | undefined => {
  const counts = new Map<string, number>();
  let cursor = 0;
  while (cursor < markdown.length) {
    const math = getMarkdownMathRangeAt(markdown, cursor, { allowInlineNewlines: true });
    if (math) {
      cursor = math.end;
      continue;
    }
    const codePoint = markdown.codePointAt(cursor);
    assert(codePoint !== undefined);
    const letter = String.fromCodePoint(codePoint);
    cursor += letter.length;
    if (!/\p{L}/u.test(letter)) continue;
    const script = scriptPatterns.find(candidate => candidate.pattern.test(letter))?.script;
    if (script) counts.set(script, (counts.get(script) || 0) + 1);
  }
  const ranked = [...counts].sort((left, right) => right[1] - left[1]);
  return ranked.length && ranked[0][1] !== ranked[1]?.[1] ? ranked[0][0] : undefined;
};

/** Unknown or tied scripts carry no language claim; only a dominant prose mismatch triggers retry. */
export const hasPdfTranscriptionScriptMismatch = (
  originalOcr: string,
  markdown: string
): boolean => {
  const original = dominantProseScript(originalOcr);
  const transcribed = dominantProseScript(markdown);
  return original !== undefined && transcribed !== undefined && original !== transcribed;
};
