import { describe, expect, test } from 'vitest';

import {
  getScrollOffset,
  getScrollRange,
  keepTextInputEndVisible,
} from '../../../components/marketing/landingDemoMotion.ts';
import {
  DEMO_FPS,
  DEMO_JOURNEY_DURATION_IN_FRAMES,
  DEMO_STAGE_CONFIG,
  DEMO_STAGE_SEGMENTS,
} from '../../../components/marketing/landingDemoTimeline.ts';

describe('landing demo journey timeline', () => {
  test('keeps the four local scene timelines contiguous inside one journey', () => {
    expect(DEMO_JOURNEY_DURATION_IN_FRAMES).toBe(
      DEMO_STAGE_CONFIG.reduce((total, stage) => total + stage.durationInFrames, 0)
    );

    for (let index = 1; index < DEMO_STAGE_CONFIG.length; index += 1) {
      const previousStage = DEMO_STAGE_CONFIG[index - 1].stage;
      const currentStage = DEMO_STAGE_CONFIG[index].stage;
      expect(DEMO_STAGE_SEGMENTS[currentStage].startSeconds).toBe(
        DEMO_STAGE_SEGMENTS[previousStage].endSeconds
      );
    }

    const finalStage = DEMO_STAGE_CONFIG.at(-1);
    expect(finalStage).toBeDefined();
    expect(DEMO_STAGE_SEGMENTS[finalStage?.stage ?? 'plan'].endSeconds).toBe(
      DEMO_JOURNEY_DURATION_IN_FRAMES / DEMO_FPS
    );
  });
});

describe('landing demo scroll choreography', () => {
  test('uses the actual viewport-specific scroll range', () => {
    expect(
      getScrollRange({
        clientHeight: 200,
        renderedClientHeight: 100,
        remotionScale: 0.5,
        scrollHeight: 700,
      })
    ).toBe(500);
    expect(
      getScrollRange({
        clientHeight: 500,
        renderedClientHeight: 250,
        remotionScale: 0.5,
        scrollHeight: 700,
      })
    ).toBe(200);
  });

  test('corrects scaled DOM measurements and reaches the exact end', () => {
    const scrollRange = getScrollRange({
      clientHeight: 0,
      renderedClientHeight: 100,
      remotionScale: 0.5,
      scrollHeight: 700,
    });

    expect(scrollRange).toBe(500);
    expect(getScrollOffset(scrollRange, 0.5)).toBe(250);
    expect(getScrollOffset(scrollRange, 0.333)).toBe(167);
    expect(getScrollOffset(scrollRange, 1)).toBe(500);
    expect(getScrollOffset(scrollRange, 2)).toBe(500);
  });

  test('keeps the end of controlled text input visible while typing', () => {
    const value = 'A controlled value that is wider than the visible text field';
    let selection: [number, number] | null = null;
    const input = {
      clientWidth: 160,
      scrollLeft: 0,
      scrollWidth: 420,
      setSelectionRange: (start: number, end: number) => {
        selection = [start, end];
      },
      value,
    } as unknown as HTMLInputElement;

    keepTextInputEndVisible(input);

    expect(selection).toEqual([value.length, value.length]);
    expect(input.scrollLeft).toBe(260);
  });
});
