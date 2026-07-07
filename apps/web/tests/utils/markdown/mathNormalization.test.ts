import { describe, expect, test } from 'vitest';

import { normalizeMathMarkdownSegment } from '../../../utils/markdown/mathNormalization.ts';

describe('normalizeMathMarkdownSegment', () => {
  test('converts orphaned multiline bracket math into display math', () => {
    const input = ['Intro', '[', 'x_1 = \\frac{a}{b}', ']', '', 'Fine'].join('\n');

    expect(normalizeMathMarkdownSegment(input)).toBe(
      ['Intro', '$$', 'x_1 = \\frac{a}{b}', '$$', 'Fine'].join('\n')
    );
  });

  test('converts single-line bracket math when it has math-like content', () => {
    expect(normalizeMathMarkdownSegment('Prima\n[x_1 = y^2]\n\nDopo')).toBe(
      ['Prima', '$$', 'x_1 = y^2', '$$', 'Dopo'].join('\n')
    );
  });

  test('leaves ordinary bracketed prose untouched', () => {
    expect(normalizeMathMarkdownSegment('Prima\n[nota editoriale]\nDopo')).toBe(
      'Prima\n[nota editoriale]\nDopo'
    );
  });
});
