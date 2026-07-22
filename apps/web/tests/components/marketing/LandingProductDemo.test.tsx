// @vitest-environment jsdom

import { fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import LandingProductDemo from '../../../components/marketing/LandingProductDemo.tsx';

class IntersectionObserverStub implements IntersectionObserver {
  readonly root = null;
  readonly rootMargin = '0px';
  readonly scrollMargin = '0px';
  readonly thresholds = [0.05];

  disconnect() {}
  observe() {}
  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }
  unobserve() {}
}

beforeEach(() => {
  vi.stubGlobal('IntersectionObserver', IntersectionObserverStub);
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined);
  Object.defineProperty(globalThis, 'innerWidth', { configurable: true, value: 1200 });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

test('uses one media decoder and seeks between journey scene segments', () => {
  const { container, rerender } = render(<LandingProductDemo activeStage="plan" />);
  const video = container.querySelector('video');

  expect(video).not.toBeNull();
  expect(container.querySelectorAll('video')).toHaveLength(1);
  expect(video?.getAttribute('preload')).toBe('metadata');
  expect(video?.getAttribute('src')).toMatch(/journey-wide-(it|en)\.mp4$/);

  rerender(<LandingProductDemo activeStage="generation" />);
  fireEvent.loadedMetadata(video as HTMLVideoElement);
  expect(video?.currentTime).toBe(25);

  if (video) {
    video.currentTime = 32.8;
  }
  fireEvent.timeUpdate(video as HTMLVideoElement);
  expect(video?.currentTime).toBe(25);
});

test('uses the desktop journey video and aspect ratio on narrow screens', () => {
  Object.defineProperty(globalThis, 'innerWidth', { configurable: true, value: 390 });

  const { container } = render(<LandingProductDemo activeStage="lesson" />);
  const demo = container.querySelector('.marketing-product-demo') as HTMLElement;
  const video = container.querySelector('video');

  expect(video?.getAttribute('src')).toMatch(/journey-wide-(it|en)\.mp4$/);
  expect(demo.style.aspectRatio).toBe('1200 / 800');
});
