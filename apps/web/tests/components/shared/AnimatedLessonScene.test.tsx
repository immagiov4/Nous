// @vitest-environment jsdom
import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import {
  guidedPathScene,
  proportionalScene,
} from '../../../../backend/tests/helpers/animatedLessonScenes';
import { LessonSceneVisual } from '../../../components/shared/lessonScene/LessonSceneVisual';
import { setRenderingLocaleOverride } from '../../../i18n/uiMessages';

let intersect: (entries: { isIntersecting: boolean }[]) => void;
let tick: FrameRequestCallback;
const disconnect = vi.fn();
beforeEach(() => {
  Object.defineProperty(document, 'hidden', { configurable: true, value: false });
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      constructor(callback: typeof intersect) {
        intersect = callback;
      }
      observe() {}
      disconnect = disconnect;
    }
  );
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({ matches: false }))
  );
  vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation(callback => {
    tick = callback;
    return 1;
  });
  vi.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation(() => {});
});
afterEach(() => setRenderingLocaleOverride(null));

test('reader quantities advance gradually, pause offscreen and resume without local controls', () => {
  const scene = {
    ...proportionalScene,
    narration: 'Due quattro sei.',
    cues: [
      { anchor: 'Due', value: 2 },
      { anchor: 'quattro', value: 4 },
      { anchor: 'sei', value: 6 },
    ],
  };
  const { container, unmount } = render(<LessonSceneVisual scene={scene} />);
  expect(container.querySelectorAll('button,input,select')).toHaveLength(0);
  expect(container.querySelector('[data-quantity-value]')?.textContent).toBe('256');
  act(() => intersect([{ isIntersecting: true }]));
  act(() => tick(0));
  act(() => tick(4800));
  expect(container.querySelector('[data-quantity-value]')?.textContent).toBe('512');
  expect(container.querySelectorAll('.replica.present')).toHaveLength(4);
  act(() => intersect([{ isIntersecting: false }]));
  expect(cancelAnimationFrame).toHaveBeenCalled();
  expect(container.querySelector('[data-quantity-value]')?.textContent).toBe('512');
  act(() => intersect([{ isIntersecting: true }]));
  act(() => tick(20000));
  expect(container.querySelector('[data-quantity-value]')?.textContent).toBe('512');
  act(() => tick(24800));
  expect(container.querySelector('[data-quantity-value]')?.textContent).toBe('768');
  unmount();
  expect(disconnect).toHaveBeenCalledOnce();
});

test('reader paths progress automatically even with complete word anchors', () => {
  const { container } = render(<LessonSceneVisual scene={guidedPathScene} />);
  expect(container.querySelector('[aria-current=step] strong')?.textContent).toBe('Interfaccia');
  act(() => intersect([{ isIntersecting: true }]));
  act(() => tick(0));
  act(() => tick(4800));
  expect(container.querySelector('[aria-current=step] strong')?.textContent).toBe('Servizio');
  expect(container.querySelectorAll('.visited')).toHaveLength(2);
  expect(container.querySelector('.path-explanation p')?.textContent).toBe(
    guidedPathScene.steps[2].detail
  );
  act(() => tick(9600));
  expect(container.querySelector('[aria-current]')).toBeNull();
  expect(container.querySelectorAll('.visited')).toHaveLength(4);
  expect(container.querySelector('.path-position')?.textContent).toBe('Percorso completato');
  expect(container.querySelector('.path-explanation p')?.textContent).toBe(
    guidedPathScene.steps[3].detail
  );
  expect(container.querySelectorAll('button,input,select')).toHaveLength(0);
});

test('returning to a visible tab resumes at the saved time without an intersection event', () => {
  const { container } = render(<LessonSceneVisual scene={proportionalScene} />);
  act(() => intersect([{ isIntersecting: true }]));
  act(() => tick(0));
  act(() => tick(2400));
  expect(container.querySelector('[data-quantity-value]')?.textContent).toBe('384');
  Object.defineProperty(document, 'hidden', { configurable: true, value: true });
  act(() => document.dispatchEvent(new Event('visibilitychange')));
  vi.mocked(requestAnimationFrame).mockClear();
  Object.defineProperty(document, 'hidden', { configurable: true, value: false });
  act(() => document.dispatchEvent(new Event('visibilitychange')));
  expect(requestAnimationFrame).toHaveBeenCalledOnce();
  act(() => tick(20000));
  expect(container.querySelector('[data-quantity-value]')?.textContent).toBe('384');
  act(() => tick(22400));
  expect(container.querySelector('[data-quantity-value]')?.textContent).toBe('512');
});

test.each([
  'offscreen',
  'autoplay-disabled',
  'reduced-motion',
  'complete',
])('tab visibility preserves the %s playback restriction', restriction => {
  vi.mocked(matchMedia).mockReturnValue({
    matches: restriction === 'reduced-motion',
  } as MediaQueryList);
  render(
    <LessonSceneVisual
      scene={{ ...proportionalScene, autoplay: restriction !== 'autoplay-disabled' }}
    />
  );
  act(() => intersect([{ isIntersecting: restriction !== 'offscreen' }]));
  if (restriction === 'complete') {
    act(() => tick(0));
    act(() => tick(9600));
  }
  Object.defineProperty(document, 'hidden', { configurable: true, value: true });
  act(() => document.dispatchEvent(new Event('visibilitychange')));
  vi.mocked(requestAnimationFrame).mockClear();
  Object.defineProperty(document, 'hidden', { configurable: true, value: false });
  act(() => document.dispatchEvent(new Event('visibilitychange')));
  expect(requestAnimationFrame).not.toHaveBeenCalled();
});

test.each([
  ['en', '24,691', '2 × 12,345.5 MB'],
  ['it', '24.691', '2 × 12.345,5 MB'],
] as const)('formats the result and formula in %s and exposes the input quantity', (locale, total, formula) => {
  setRenderingLocaleOverride(locale);
  const { container } = render(
    <LessonSceneVisual scene={{ ...proportionalScene, amountPerUnit: 12345.5 }} />
  );
  expect(container.querySelector('[data-quantity-value]')?.textContent).toBe(total);
  expect(container.querySelector('.formula')?.textContent).toBe(formula);
  const input = container.querySelector('[data-quantity-input]');
  expect(input?.closest('[aria-hidden=true]')).toBeNull();
  expect(input?.textContent).toBe('Repliche del servizio: 2');
  act(() => intersect([{ isIntersecting: true }]));
  act(() => tick(0));
  act(() => tick(4800));
  expect(input?.textContent).toBe('Repliche del servizio: 4');
});

test('reader respects reduced motion and document visibility', () => {
  vi.mocked(matchMedia).mockReturnValue({ matches: true } as MediaQueryList);
  const { container, unmount } = render(<LessonSceneVisual scene={proportionalScene} />);
  act(() => intersect([{ isIntersecting: true }]));
  expect(requestAnimationFrame).not.toHaveBeenCalled();
  expect(container.querySelector('[data-quantity-value]')?.textContent).toBe('256');
  unmount();
  vi.mocked(matchMedia).mockReturnValue({ matches: false } as MediaQueryList);
  render(<LessonSceneVisual scene={proportionalScene} />);
  act(() => intersect([{ isIntersecting: true }]));
  Object.defineProperty(document, 'hidden', { configurable: true, value: true });
  act(() => document.dispatchEvent(new Event('visibilitychange')));
  expect(cancelAnimationFrame).toHaveBeenCalled();
  Object.defineProperty(document, 'hidden', { configurable: true, value: false });
});

test.each([12, 13, 1000000])('bounds rendered replicas for a maximum of %i', max => {
  const { container } = render(<LessonSceneVisual scene={{ ...proportionalScene, max }} />);
  expect(container.querySelectorAll('.replica')).toHaveLength(max <= 12 ? max : 0);
  expect(container.querySelectorAll('.quantity-bar')).toHaveLength(max > 12 ? 1 : 0);
  if (max > 12) {
    const fill = container.querySelector<HTMLElement>('.quantity-fill');
    expect(fill?.style.transform).toBe(`scaleX(${2 / max})`);
    expect(container.querySelector('[data-quantity-summary]')?.textContent).toBe(
      'Repliche del servizio: 2'
    );
    act(() => intersect([{ isIntersecting: true }]));
    act(() => tick(0));
    act(() => tick(9600));
    expect(fill?.style.transform).toBe('scaleX(1)');
    expect(container.querySelectorAll('.quantity-fill')).toHaveLength(1);
  }
});

test('reduced motion exposes every authored path detail without starting a clock', () => {
  vi.mocked(matchMedia).mockReturnValue({ matches: true } as MediaQueryList);
  const { container } = render(<LessonSceneVisual scene={guidedPathScene} />);
  expect(
    Array.from(container.querySelectorAll('.path-details li p'), node => node.textContent)
  ).toEqual(guidedPathScene.steps.map(step => step.detail));
  expect(container.querySelector('.guided-stops')).toBeNull();
  expect(container.querySelector('.path-explanation')).toBeNull();
  expect(requestAnimationFrame).not.toHaveBeenCalled();
});

test.each([2, 4, 5, 8])('keeps %i steps in authored order and connects the return row', count => {
  const scene = {
    ...guidedPathScene,
    steps: Array.from({ length: count }, (_, index) => ({
      label: `Step ${index + 1}`,
      detail: `Detail ${index + 1}`,
    })),
  };
  const { container } = render(<LessonSceneVisual scene={scene} />);
  const stops = Array.from(container.querySelectorAll<HTMLElement>('.guided-stops li'));
  expect(stops.map(stop => stop.querySelector('strong')?.textContent)).toEqual(
    scene.steps.map(step => step.label)
  );
  expect(stops.map(stop => stop.style.getPropertyValue('--path-column'))).toEqual(
    ['1', '2', '3', '4', '4', '3', '2', '1'].slice(0, count)
  );
  expect(container.querySelectorAll('[data-row-turn]')).toHaveLength(count > 4 ? 1 : 0);
  expect(container.querySelectorAll('[data-return-row]')).toHaveLength(Math.max(0, count - 4));
});

test('enabling reduced motion cancels an active proportional animation', () => {
  let changePreference: (event: { matches: boolean }) => void = () => {};
  vi.mocked(matchMedia).mockReturnValue({
    matches: false,
    addEventListener: (_: string, callback: typeof changePreference) => {
      changePreference = callback;
    },
    removeEventListener: vi.fn(),
  } as unknown as MediaQueryList);
  const { container } = render(<LessonSceneVisual scene={proportionalScene} />);
  act(() => intersect([{ isIntersecting: true }]));
  act(() => tick(0));
  act(() => tick(4800));
  expect(container.querySelector('[data-quantity-value]')?.textContent).toBe('512');
  vi.mocked(cancelAnimationFrame).mockClear();
  vi.mocked(requestAnimationFrame).mockClear();
  act(() => changePreference({ matches: true }));
  expect(cancelAnimationFrame).toHaveBeenCalled();
  expect(container.querySelector('[data-quantity-value]')?.textContent).toBe('512');
  act(() => intersect([{ isIntersecting: true }]));
  act(() => document.dispatchEvent(new Event('visibilitychange')));
  expect(requestAnimationFrame).not.toHaveBeenCalled();
});

test.each([
  [0.0001, '0.0001', '0.0002', '0.0004'],
  [1.23456789, '1.23456789', '2.46913578', '4.93827156'],
  [
    1e-25,
    '0.0000000000000000000000001',
    '0.0000000000000000000000002',
    '0.0000000000000000000000004',
  ],
] as const)('preserves significant proportional digits for %s', (amountPerUnit, unit, initial, next) => {
  setRenderingLocaleOverride('en');
  const { container, getByRole } = render(
    <LessonSceneVisual scene={{ ...proportionalScene, amountPerUnit }} />
  );
  expect(container.querySelector('.replica strong')?.textContent).toBe(`${unit} MB`);
  expect(container.querySelector('[data-quantity-value]')?.textContent).toBe(initial);
  expect(container.querySelector('.formula')?.textContent).toBe(`2 × ${unit} MB`);
  expect(getByRole('status').textContent).toContain(initial);
  expect(container.querySelectorAll('output')).toHaveLength(1);
  act(() => intersect([{ isIntersecting: true }]));
  act(() => tick(0));
  act(() => tick(4800));
  expect(container.querySelector('[data-quantity-value]')?.textContent).toBe(next);
});
