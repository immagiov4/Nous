import {
  checkStudioLayout,
  hasDeadStage,
  type StudioLayout,
} from '@shared/lessonStudios/layoutValidation';
import { expect, test } from 'vitest';

const bounds = (left: number, top: number, right: number, bottom: number) => ({
  left,
  top,
  right,
  bottom,
});

function layout(frame: StudioLayout['frames'][number]): StudioLayout {
  return { stage: bounds(0, 0, 200, 120), frames: [frame] };
}

test('accepts a readable label whose closest mark is the one it names', () => {
  expect(
    checkStudioLayout(
      layout({
        axisScale: { x: 10, y: 10 },
        elements: [
          { id: 'point-a', bounds: bounds(50, 65, 54, 69) },
          {
            id: 'label-a',
            bounds: bounds(45, 30, 80, 47),
            label: { fontPx: 16, anchorId: 'point-a' },
          },
          { id: 'point-b', bounds: bounds(115, 65, 119, 69) },
        ],
      })
    )
  ).toEqual([]);
});

test('rejects undersized and overlapping labels, a wrong visual anchor and a stretched geometric scale', () => {
  expect(
    checkStudioLayout(
      layout({
        axisScale: { x: 10, y: 5 },
        elements: [
          { id: 'point-a', bounds: bounds(50, 35, 54, 39) },
          {
            id: 'label-a',
            bounds: bounds(45, 30, 80, 47),
            label: { fontPx: 12, anchorId: 'point-b' },
          },
          { id: 'point-b', bounds: bounds(115, 65, 119, 69) },
        ],
      })
    )
  ).toEqual(
    expect.arrayContaining(['axis-scale', 'min-text', 'overlap', 'min-gap', 'label-association'])
  );
});

test('the text clearance catches a near miss without an intersection', () => {
  expect(
    checkStudioLayout(
      layout({
        elements: [
          { id: 'point', bounds: bounds(50, 54, 54, 58) },
          { id: 'label', bounds: bounds(45, 30, 80, 47), label: { fontPx: 14 } },
        ],
      })
    )
  ).toEqual(['min-gap']);
});

test('rejects missing layout evidence', () => {
  expect(checkStudioLayout(undefined)).toEqual(['layout-unavailable']);
});

test('checks for an empty opening and for uncovered time before, between and after motion', () => {
  const timing = {
    firstMeaningfulMs: 900,
    durationMs: 8500,
    active: [{ startMs: 3000, endMs: 4600 }],
  };
  expect(hasDeadStage(timing)).toBe(false);
  expect(hasDeadStage({ ...timing, firstMeaningfulMs: 2001 })).toBe(true);
  expect(hasDeadStage({ ...timing, durationMs: 8601 })).toBe(true);
  expect(hasDeadStage({ ...timing, active: [{ startMs: 5000, endMs: 8500 }] })).toBe(true);
});
