import { describe, expect, it } from 'vitest';
import { isOrphanedCodeContinuationLine } from '../../../utils/markdown/codeHeuristics.ts';

describe('codeHeuristics', () => {
  it('recognizes indented argument lists used by indentation normalization', () => {
    expect(isOrphanedCodeContinuationLine('  value, otherValue')).toBe(true);
    expect(isOrphanedCodeContinuationLine('  } value, otherValue,')).toBe(true);
    expect(isOrphanedCodeContinuationLine('  frase descrittiva completa')).toBe(false);
  });
});
