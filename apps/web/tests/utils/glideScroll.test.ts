// @vitest-environment jsdom
import { afterEach, expect, test, vi } from 'vitest';
import { CAROUSEL_GLIDE_MS, glideScrollBy } from '../../utils/motion/glideScroll.ts';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

test.each([
  'keydown',
  'focusin',
  'wheel',
  'pointerdown',
])('%s preserves user scrolling during an automatic glide', eventType => {
  const frames = new Map<number, FrameRequestCallback>();
  let nextFrame = 0;
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.set(++nextFrame, callback);
    return nextFrame;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
  vi.spyOn(performance, 'now').mockReturnValue(0);
  const track = document.createElement('div');
  const book = document.createElement('button');
  track.append(book);
  const cancel = glideScrollBy(track, 500);
  try {
    book.dispatchEvent(new Event(eventType, { bubbles: true }));
    track.scrollLeft = 120;
    for (const callback of [...frames.values()]) callback(CAROUSEL_GLIDE_MS);
    expect(track.scrollLeft).toBe(120);
    expect(track.style.scrollBehavior).toBe('');
  } finally {
    cancel();
  }
});
