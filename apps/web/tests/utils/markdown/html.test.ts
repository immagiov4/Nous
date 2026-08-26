import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  getAllowedRawHtmlTagRanges,
  projectDisallowedRawHtml,
} from '../../../utils/markdown/html.ts';

test('scans raw HTML tags through greater-than characters inside quoted attributes', () => {
  const source = '<mark title="1 > 0">visible</mark>';

  assert.deepEqual(
    getAllowedRawHtmlTagRanges(source).map(range => source.slice(range.start, range.end)),
    ['<mark title="1 > 0">', '</mark>']
  );
});

test('escapes a complete disallowed tag without stopping inside a quoted attribute', () => {
  assert.equal(
    projectDisallowedRawHtml('<div title="1 > 0">visible</div>').content,
    '&lt;div title="1 &gt; 0"&gt;visible&lt;/div&gt;'
  );
});

test('leaves incomplete tag-like text unchanged', () => {
  const source = '<mark title="1 > 0" visible';

  assert.equal(projectDisallowedRawHtml(source).content, source);
});

test('continues escaping tags after an incomplete quoted candidate', () => {
  const source = '<mark title="broken\n\n<iframe src="video">content</iframe>';

  assert.equal(
    projectDisallowedRawHtml(source).content,
    '<mark title="broken\n\n&lt;iframe src="video"&gt;content&lt;/iframe&gt;'
  );
});
