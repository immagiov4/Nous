// @vitest-environment jsdom
import { expect, test, vi } from 'vitest';

import {
  findSectionAnnotationHighlightHit,
  resolveSectionAnnotationHighlightTarget,
} from '../../../utils/learning/sectionAnnotationHighlights.ts';

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

test('falls back to highlight geometry when the caret point is outside a native range', () => {
  const element = document.createElement('p');
  const text = document.createTextNode('Evidenziazione nativa');
  element.append(text);
  document.body.append(element);
  const range = document.createRange();
  range.setStart(text, 0);
  range.setEnd(text, text.data.length);
  const rect = new DOMRect(10, 20, 120, 18);
  range.getClientRects = () => [rect] as unknown as DOMRectList;
  const caretPositionFromPointDescriptor = Object.getOwnPropertyDescriptor(
    document,
    'caretPositionFromPoint'
  );

  try {
    Object.defineProperty(document, 'caretPositionFromPoint', {
      configurable: true,
      value: vi.fn(() => ({
        offset: text.data.length + 1,
        offsetNode: text,
      })),
    });

    expect(
      findSectionAnnotationHighlightHit(
        [
          {
            annotationId: 'annotation-native',
            hasAttachedNote: false,
            rangeGroups: [[range]],
            ranges: [range],
            selectedText: text.data,
          },
        ],
        50,
        25
      )
    ).toMatchObject({ annotationId: 'annotation-native', rect, selectedText: text.data });
  } finally {
    if (caretPositionFromPointDescriptor) {
      Object.defineProperty(document, 'caretPositionFromPoint', caretPositionFromPointDescriptor);
    } else {
      Reflect.deleteProperty(document, 'caretPositionFromPoint');
    }
    element.remove();
  }
});
