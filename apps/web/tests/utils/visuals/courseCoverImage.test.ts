import { describe, expect, test } from 'vitest';
import { calculateCourseCoverCrop } from '../../../utils/visuals/courseCoverImage.ts';

describe('course cover crop', () => {
  test('crops excess width while preserving the center', () => {
    expect(
      calculateCourseCoverCrop({ height: 1000, width: 3000 }, { height: 420, width: 960 })
    ).toEqual({
      height: 1000,
      width: 2285.714285714286,
      x: 357.1428571428571,
      y: 0,
    });
  });

  test('crops excess height while preserving the center', () => {
    expect(
      calculateCourseCoverCrop({ height: 1600, width: 1600 }, { height: 420, width: 960 })
    ).toEqual({
      height: 700,
      width: 1600,
      x: 0,
      y: 450,
    });
  });
});
