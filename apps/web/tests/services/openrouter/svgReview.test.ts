// @vitest-environment jsdom

import { expect, test } from 'vitest';
import { lintSvg } from '../../../services/openrouter/svgReview.ts';

test('reports likely SVG text bounds and overlap issues', () => {
  const issues = lintSvg(
    '<svg viewBox="0 0 680 120"><text x="670" y="40">Nodo lungo</text><text x="670" y="40">Altro nodo</text></svg>'
  );

  expect(issues).toEqual(
    expect.arrayContaining([
      expect.stringContaining('fuori dai bordi'),
      expect.stringContaining('sovrapposizione'),
    ])
  );
});
