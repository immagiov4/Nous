import { expect, test } from 'vitest';
import {
  getAllowedRawHtmlTagRanges,
  projectDisallowedRawHtml,
} from '../../../utils/markdown/html.ts';

test('scans raw HTML tags through greater-than characters inside quoted attributes', () => {
  const source = '<mark title="1 > 0">visible</mark>';

  expect(
    getAllowedRawHtmlTagRanges(source).map(range => source.slice(range.start, range.end))
  ).toStrictEqual(['<mark title="1 > 0">', '</mark>']);
});

test('escapes a complete disallowed tag without stopping inside a quoted attribute', () => {
  expect(projectDisallowedRawHtml('<div title="1 > 0">visible</div>').content).toBe(
    '&lt;div title="1 &gt; 0"&gt;visible&lt;/div&gt;'
  );
});

test('leaves incomplete tag-like text unchanged', () => {
  const source = '<mark title="1 > 0" visible';

  expect(projectDisallowedRawHtml(source).content).toBe(source);
});

test('continues escaping tags after an incomplete quoted candidate', () => {
  const source = '<mark title="broken\n\n<iframe src="video">content</iframe>';

  expect(projectDisallowedRawHtml(source).content).toBe(
    '<mark title="broken\n\n&lt;iframe src="video"&gt;content&lt;/iframe&gt;'
  );
});
