import { expect, test, vi } from 'vitest';

import {
  inspectLessonVisualForReview,
  lintLessonSvg,
} from '../../src/services/lessonGenerationVisualReview.js';

test('an SVG with overlapping labels requests review with a rendered preview', () => {
  const original = {
    code: '<svg viewBox="0 0 680 200"><text x="100" y="100">Primo</text><text x="100" y="100">Secondo</text></svg>',
    kind: 'svg' as const,
  };

  const result = inspectLessonVisualForReview({
    renderSvgPreview: () => 'data:image/png;base64,cHJldmlldw==',
    visual: original,
  });

  expect(result).toEqual({
    issues: [expect.stringContaining('overlap')],
    preview: 'data:image/png;base64,cHJldmlldw==',
  });
});

test('a structurally sound SVG skips review while HTML requests one pass', () => {
  const renderSvgPreview = vi.fn();
  expect(
    inspectLessonVisualForReview({
      renderSvgPreview,
      visual: {
        code: '<svg viewBox="0 0 680 200"><text x="100" y="100">Etichetta</text></svg>',
        kind: 'svg',
      },
    })
  ).toBeNull();
  expect(renderSvgPreview).not.toHaveBeenCalled();

  expect(
    inspectLessonVisualForReview({
      visual: { code: '<style></style><div></div><script></script>', kind: 'html' },
    })
  ).toEqual({ issues: [] });
  expect(
    inspectLessonVisualForReview({
      visual: { code: 'classDiagram\nA <|-- B', kind: 'mermaid' },
    })
  ).toBeNull();
});

test('the SVG linter accepts a corrected layout', () => {
  expect(
    lintLessonSvg(
      '<svg viewBox="0 0 680 200"><text x="100" y="70">Primo</text><text x="100" y="130">Secondo</text></svg>'
    )
  ).toEqual([]);
});

test('the SVG linter measures bounds against the declared viewBox width', () => {
  expect(
    lintLessonSvg('<svg viewBox="0 0 820 200"><text x="740" y="100">Etichetta</text></svg>')
  ).toEqual([]);
});
