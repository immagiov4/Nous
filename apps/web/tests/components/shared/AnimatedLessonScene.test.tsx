// @vitest-environment jsdom
import { act, render } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';
import {
  guidedPathScene,
  proportionalScene,
} from '../../../../backend/tests/helpers/animatedLessonScenes';
import { LessonSceneVisual } from '../../../components/shared/lessonScene/LessonSceneVisual';

let intersect: (entries: { isIntersecting: boolean }[]) => void;
let tick: FrameRequestCallback;
const disconnect = vi.fn();
beforeEach(() => {
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
  expect(container.querySelector('output')?.textContent).toBe('256');
  act(() => intersect([{ isIntersecting: true }]));
  act(() => tick(0));
  act(() => tick(4800));
  expect(container.querySelector('output')?.textContent).toBe('512');
  expect(container.querySelectorAll('.replica.present')).toHaveLength(4);
  act(() => intersect([{ isIntersecting: false }]));
  expect(cancelAnimationFrame).toHaveBeenCalled();
  act(() => intersect([{ isIntersecting: true }]));
  act(() => tick(20000));
  expect(container.querySelector('output')?.textContent).toBe('512');
  act(() => tick(24800));
  expect(container.querySelector('output')?.textContent).toBe('768');
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
  expect(container.querySelectorAll('button,input,select')).toHaveLength(0);
});

test('reader respects reduced motion and document visibility', () => {
  vi.mocked(matchMedia).mockReturnValue({ matches: true } as MediaQueryList);
  const { container, unmount } = render(<LessonSceneVisual scene={proportionalScene} />);
  act(() => intersect([{ isIntersecting: true }]));
  expect(requestAnimationFrame).not.toHaveBeenCalled();
  expect(container.querySelector('output')?.textContent).toBe('256');
  unmount();
  vi.mocked(matchMedia).mockReturnValue({ matches: false } as MediaQueryList);
  render(<LessonSceneVisual scene={proportionalScene} />);
  act(() => intersect([{ isIntersecting: true }]));
  Object.defineProperty(document, 'hidden', { configurable: true, value: true });
  act(() => document.dispatchEvent(new Event('visibilitychange')));
  expect(cancelAnimationFrame).toHaveBeenCalled();
  Object.defineProperty(document, 'hidden', { configurable: true, value: false });
});
