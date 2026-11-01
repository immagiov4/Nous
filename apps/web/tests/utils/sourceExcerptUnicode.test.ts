import { buildCompactSnippet } from '@shared/pdfTextIndex';
import { formatSourceArchiveIndex } from '@shared/sourceArchiveIndex';
import { expect, test } from 'vitest';
import { clipText } from '../../utils/text';

test.each([
  ['head', 25],
  ['tail', 83],
] as const)('compact PDF source snippets retain the symbol crossing the %s cut', (_name, offset) => {
  const text = `${'a'.repeat(offset)}𝑋${'z'.repeat(100 - offset - 2)}`;
  const snippet = buildCompactSnippet(text, 40);
  expect(!/[\uD800-\uDFFF]/u.test(snippet)).toBe(true);
  expect(snippet).toContain('𝑋');
});

test('archive source preview and assessment clipping retain a boundary symbol', () => {
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
  for (const output of [preview, clipped]) {
    expect(!/[\uD800-\uDFFF]/u.test(output)).toBe(true);
    expect(output).toContain('abcdefghi𝑋');
  }
});
