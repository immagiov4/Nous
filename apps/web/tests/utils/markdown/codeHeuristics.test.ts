import { describe, expect, it } from 'vitest';
import {
  isOrphanedCodeContinuationLine,
  parseInlineCodeLead,
  stripInlineCodeSpans,
  trimCodeLine,
} from '../../../utils/markdown/codeHeuristics.ts';

describe('codeHeuristics', () => {
  it('removes balanced inline code spans without swallowing surrounding text', () => {
    expect(stripInlineCodeSpans('Prima `const x = 1` dopo')).toBe('Prima  dopo');
    expect(stripInlineCodeSpans('Testo con `span non chiuso')).toBe('Testo con `span non chiuso');
  });

  it('parses single-line language-prefixed code leads', () => {
    expect(parseInlineCodeLead('ts const answer = 42;')).toEqual({
      code: 'const answer = 42;',
      language: 'typescript',
    });
    expect(parseInlineCodeLead('nota testo normale')).toBeNull();
  });

  it('recognizes orphaned identifier continuation lists without regex-only parsing', () => {
    expect(isOrphanedCodeContinuationLine('  value, otherValue')).toBe(true);
    expect(isOrphanedCodeContinuationLine('  } value, otherValue,')).toBe(true);
    expect(isOrphanedCodeContinuationLine('  frase descrittiva completa')).toBe(false);
  });

  it('trims only trailing indentation from code lines', () => {
    expect(trimCodeLine('\tconst value = 1;   ')).toBe('\tconst value = 1;');
    expect(trimCodeLine('const value = 1;')).toBe('const value = 1;');
  });
});
