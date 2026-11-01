import { buildCompactSnippet } from '@shared/pdfTextIndex';
import { formatSourceArchiveIndex } from '@shared/sourceArchiveIndex';
import { expect, test } from 'vitest';
import { clipText } from '../../utils/text';

test.each([
  ['head cut', 311, `${'a'.repeat(311)} ... ${'z'.repeat(163)}`],
  ['tail cut', 836, `${'a'.repeat(312)} ... ${'z'.repeat(162)}`],
  ['inside head', 310, `${'a'.repeat(310)}𝑋 ... ${'z'.repeat(163)}`],
  ['inside tail', 837, `${'a'.repeat(312)} ... 𝑋${'z'.repeat(161)}`],
] as const)('compact PDF source snippets fit the cap with a symbol at %s', (_name, offset, expected) => {
  const text = `${'a'.repeat(offset)}𝑋${'z'.repeat(1000 - offset - 2)}`;
  const snippet = buildCompactSnippet(text, 480);
  expect(!/[\uD800-\uDFFF]/u.test(snippet)).toBe(true);
  expect(snippet.length).toBeLessThanOrEqual(480);
  expect(snippet).toBe(expected);
});

test.each([
  0, 1, 5, 10, 40, 80, 480,
])('compact snippets fit a %s-unit budget for BMP and supplementary text', budget => {
  for (const text of ['abcdefghij'.repeat(100), '𝑋'.repeat(500)]) {
    const snippet = buildCompactSnippet(text, budget);
    expect(snippet.length).toBeLessThanOrEqual(budget);
    expect(snippet).not.toMatch(/[\uD800-\uDFFF]/u);
  }
});

test('archive previews respect their quota and assessment excerpts retain whole boundary symbols', () => {
  const text = 'abcdefghi𝑋tail';
  const preview = formatSourceArchiveIndex(
    {
      entries: [
        {
          kind: 'file',
          contentKind: 'text',
          path: 'symbols.txt',
          preview: text,
        },
      ],
    },
    { previewBudgetChars: 10 }
  );
  const clipped = clipText(text, 10, '[truncated]');
  expect(preview).not.toMatch(/[\uD800-\uDFFF]/u);
  expect(preview.split('\n').at(-1)).toBe('abcdefghi');
  expect(clipped).not.toMatch(/[\uD800-\uDFFF]/u);
  expect(clipped).toContain('abcdefghi𝑋');
});
