// @vitest-environment jsdom
import { expect, test } from 'vitest';

import { resolveSectionAnnotationHighlightTarget } from '../../../utils/learning/sectionAnnotationHighlights.ts';

test('resolves a native annotation highlight by id for programmatic navigation', () => {
  const element = document.createElement('p');
  const text = document.createTextNode('Evidenziazione nativa');
  element.append(text);
  document.body.append(element);
  const range = document.createRange();
  range.setStart(text, 0);
  range.setEnd(text, text.data.length);
  const rect = new DOMRect(10, 20, 120, 18);
  range.getBoundingClientRect = () => rect;

  const target = resolveSectionAnnotationHighlightTarget(
    [
      {
        annotationId: 'annotation-native',
        hasAttachedNote: true,
        rangeGroups: [[range]],
        ranges: [range],
        selectedText: text.data,
      },
    ],
    'annotation-native'
  );

  expect(target?.element).toBe(element);
  expect(target?.hit).toMatchObject({
    annotationId: 'annotation-native',
    rect,
    selectedText: text.data,
  });
  element.remove();
});
