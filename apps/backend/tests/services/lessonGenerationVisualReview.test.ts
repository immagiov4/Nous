import { expect, test, vi } from 'vitest';

import {
  lintLessonSvg,
  reviewLessonVisual,
} from '../../src/services/lessonGenerationVisualReview.js';

test('an SVG with overlapping labels is reviewed with a rendered preview', async () => {
  const original = {
    code: '<svg viewBox="0 0 680 200"><text x="100" y="100">Primo</text><text x="100" y="100">Secondo</text></svg>',
    kind: 'svg' as const,
  };
  const corrected = {
    code: '<svg viewBox="0 0 680 200"><text x="100" y="70">Primo</text><text x="100" y="130">Secondo</text></svg>',
    kind: 'svg' as const,
  };
  const requestRevision = vi.fn().mockResolvedValue(corrected);

  const result = await reviewLessonVisual({
    maxRounds: 1,
    renderSvgPreview: () => 'data:image/png;base64,cHJldmlldw==',
    requestRevision,
    visual: original,
  });

  expect(result).toEqual(corrected);
  expect(requestRevision).toHaveBeenCalledWith(
    expect.objectContaining({
      issues: [expect.stringContaining('sovrapposizione')],
      preview: 'data:image/png;base64,cHJldmlldw==',
    })
  );
  expect(lintLessonSvg(corrected.code)).toEqual([]);
});

test('a structurally sound SVG skips review while HTML receives the configured review pass', async () => {
  const svgRevision = vi.fn();
  await reviewLessonVisual({
    maxRounds: 2,
    requestRevision: svgRevision,
    visual: {
      code: '<svg viewBox="0 0 680 200"><text x="100" y="100">Etichetta</text></svg>',
      kind: 'svg',
    },
  });
  expect(svgRevision).not.toHaveBeenCalled();

  const htmlRevision = vi.fn().mockImplementation(async ({ visual }) => visual);
  await reviewLessonVisual({
    maxRounds: 2,
    requestRevision: htmlRevision,
    visual: { code: '<style></style><div></div><script></script>', kind: 'html' },
  });
  expect(htmlRevision).toHaveBeenCalledTimes(2);
  expect(htmlRevision.mock.calls[0]?.[0].preview).toBeUndefined();
});
