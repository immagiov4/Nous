import { describe, expect, it } from 'vitest';
import {
  mergeOrphanedContinuationLinesIntoPreviousFence,
  mergeSplitTextPseudocodeBlocks,
} from '../../../utils/markdown/fencedCode.ts';

describe('fencedCode', () => {
  it('merges indented orphaned continuation lines back into the previous fence', () => {
    const input = ['```ts', 'const x = fn(', '```', '  value,', '  otherValue', 'Testo'].join('\n');

    expect(mergeOrphanedContinuationLinesIntoPreviousFence(input)).toBe(
      ['```ts', 'const x = fn(', '  value,', '  otherValue', '```', 'Testo'].join('\n')
    );
  });

  it('leaves non-code indented text outside the fence', () => {
    const input = ['```ts', 'const x = fn(', '```', '  paragrafo descrittivo', 'Testo'].join('\n');

    expect(mergeOrphanedContinuationLinesIntoPreviousFence(input)).toBe(input);
  });

  it('merges pseudocode closing else branches recognized by explicit parsing', () => {
    const input = [
      '```text',
      'IF (condizione) {',
      '```',
      ' azione',
      '} ELSE {',
      ' altra azione',
      '```text',
      '}',
      '```',
    ].join('\n');

    expect(mergeSplitTextPseudocodeBlocks(input)).toBe(
      ['```text', 'IF (condizione) {', ' azione', '} ELSE {', ' altra azione', '}', '```'].join(
        '\n'
      )
    );
  });
});
