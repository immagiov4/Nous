// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { usePlaybackVisualFit } from '../../../components/workspace/playback/usePlaybackVisualFit.ts';

let resize: () => void;
let frames: FrameRequestCallback[];

beforeEach(() => {
  frames = [];
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(callback: () => void) {
        resize = callback;
      }
      observe() {}
      disconnect() {}
    }
  );
  vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation(callback =>
    frames.push(callback)
  );
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function (
    this: HTMLElement
  ) {
    return Number(this.dataset.stageHeight ?? 0);
  });
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(960);
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(960);
  vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockReturnValue(960);
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (
    this: HTMLElement
  ) {
    if (this instanceof HTMLImageElement) {
      const natural = Number(this.dataset.naturalHeight);
      return this.style.maxHeight
        ? Math.min(natural, Number.parseFloat(this.style.maxHeight))
        : natural;
    }
    return (
      Number(this.dataset.textHeight ?? 0) +
      [...this.querySelectorAll('img')].reduce((sum, image) => sum + image.offsetHeight, 0)
    );
  });
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function (
    this: HTMLElement
  ) {
    return this.offsetHeight;
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function Scene({
  heights,
  textHeight,
  formula,
  onOverflow,
}: {
  readonly heights: readonly number[];
  readonly textHeight: number;
  readonly formula: boolean;
  readonly onOverflow?: (overflowing: boolean) => void;
}) {
  const ref = usePlaybackVisualFit(true, onOverflow);
  return (
    <section ref={ref} className="scene-host" data-text-height={textHeight}>
      {onOverflow ? (
        <div data-process-scroll data-stage-height={600} data-text-height={textHeight} />
      ) : null}
      {formula ? <span className="katex">x = 1</span> : null}
      {heights.map((height, index) => (
        <figure key={height}>
          <img alt={`Synthetic figure ${index}`} data-natural-height={height} />
        </figure>
      ))}
    </section>
  );
}

function mount(
  heights: readonly number[],
  textHeight: number,
  formula = true,
  onOverflow?: (overflowing: boolean) => void
) {
  const view = render(
    <div className="listening-stage" data-stage-height="600" style={{ padding: 0 }}>
      <div className="captions" />
      <div className="scene-fit">
        <Scene
          heights={heights}
          textHeight={textHeight}
          formula={formula}
          onOverflow={onOverflow}
        />
      </div>
    </div>
  );
  const card = view.container.querySelector<HTMLElement>('.scene-host');
  const stage = view.container.querySelector<HTMLElement>('.listening-stage');
  if (!card || !stage) throw new Error('Synthetic stage missing');
  return { card, stage, images: [...card.querySelectorAll('img')] };
}

test('a tall image yields space while formula typography keeps its native scale', () => {
  const { card, images } = mount([1200], 120);
  expect(images[0].style.maxHeight).toBe('480px');
  expect(images[0].style.objectFit).toBe('contain');
  expect(card.style.getPropertyValue('--scene-scale')).toBe('1');
  expect(card.offsetHeight).toBe(600);
});

test('natural image geometry is preserved when the formulas and images already fit', () => {
  const { card, images } = mount([100, 200], 120);
  expect(images.map(image => image.style.maxHeight)).toEqual(['', '']);
  expect(card.style.getPropertyValue('--scene-scale')).toBe('1');
});

test('resizing shares available image height and restores natural sizes when space returns', () => {
  const { card, stage, images } = mount([100, 200], 120);
  const resizeTo = (height: number) =>
    act(() => {
      stage.dataset.stageHeight = String(height);
      resize();
      for (const callback of frames.splice(0)) callback(0);
    });
  resizeTo(300);
  expect(images.map(image => image.style.maxHeight)).toEqual(['60px', '120px']);
  expect(card.style.getPropertyValue('--scene-scale')).toBe('1');
  resizeTo(600);
  expect(images.map(image => image.style.maxHeight)).toEqual(['', '']);
  expect(card.style.getPropertyValue('--scene-scale')).toBe('1');
});

test('an image with no intrinsic height keeps available text visible and fits on load', () => {
  const { card, images } = mount([0], 120);
  expect(images[0].style.maxHeight).toBe('');
  expect(card.style.getPropertyValue('--scene-scale')).toBe('1');
  images[0].dataset.naturalHeight = '1200';
  fireEvent.load(images[0]);
  expect(images[0].style.maxHeight).toBe('480px');
  expect(card.style.getPropertyValue('--scene-scale')).toBe('1');
});

test('formula-only content still fits when the text alone exceeds the viewport', () => {
  const { card } = mount([], 900);
  expect(Number(card.style.getPropertyValue('--scene-scale'))).toBeCloseTo(2 / 3);
});

test('an image without a formula retains whole-visual fitting', () => {
  const { card, images } = mount([1200], 0, false);
  expect(images[0].style.maxHeight).toBe('');
  expect(card.style.getPropertyValue('--scene-scale')).toBe('0.5');
});

test('an overflowing process reports its native scroll position and visible fraction', () => {
  const reportOverflow = vi.fn();
  const { card, stage } = mount([], 1200, false, reportOverflow);
  const scrollport = card.querySelector<HTMLElement>('[data-process-scroll]');
  if (!scrollport) throw new Error('Synthetic process scrollport missing');
  expect(reportOverflow).toHaveBeenLastCalledWith(true);
  expect(card.style.getPropertyValue('--process-visible-fraction')).toBe('0.5');
  expect(card.style.getPropertyValue('--process-scroll-progress')).toBe('0');

  for (const progress of [0.5, 1]) {
    scrollport.scrollTop = 600 * progress;
    fireEvent.scroll(scrollport);
    expect(card.style.getPropertyValue('--process-scroll-progress')).toBe(String(progress));
  }

  for (const height of [1200, 600]) {
    act(() => {
      scrollport.dataset.stageHeight = String(height);
      stage.dataset.stageHeight = String(height);
      resize();
      for (const callback of frames.splice(0)) callback(0);
    });
    expect(reportOverflow).toHaveBeenLastCalledWith(height < 1200);
  }
});
