// @vitest-environment jsdom
import { segmentLessonPlayback } from '@shared/lessonPlayback';
import type { LessonScene } from '@shared/lessonScene';
import { act, render } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';
import {
  guidedPathScene,
  proportionalScene,
} from '../../../../backend/tests/helpers/animatedLessonScenes';
import LessonPlaybackStage from '../../../components/workspace/playback/LessonPlaybackStage';
import type { WorkspaceReaderContentModel } from '../../../components/workspace/shell/types';

vi.mock('../../../utils/motion/useShouldAnimate', () => ({ useShouldAnimate: () => false }));

let callbacks: Map<number, FrameRequestCallback>;
let frameId: number;
beforeEach(() => {
  callbacks = new Map();
  frameId = 0;
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    }
  );
  vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation(callback => {
    callbacks.set(++frameId, callback);
    return frameId;
  });
  vi.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation(id => {
    callbacks.delete(id);
  });
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    width: 100,
  } as DOMRect);
  const style = document.createElement('p').style;
  style.setProperty('--caption-feather', '22px');
  vi.spyOn(globalThis, 'getComputedStyle').mockReturnValue(style);
});

const flush = () =>
  act(() => {
    const pending = [...callbacks.values()];
    callbacks.clear();
    pending.forEach(callback => {
      callback(0);
    });
  });

function mount(scene: LessonScene | LessonScene[], speech: string, duration = 9.6, stored = false) {
  let time = 0;
  const scenes = Array.isArray(scene) ? scene : [scene];
  const sources = [{ type: 'markdown' as const, markdown: speech }];
  const block = {
    ...segmentLessonPlayback(sources)[0],
    visuals: scenes.map((scene, index) =>
      stored
        ? { kind: 'generated-visual' as const, visualId: String(index) }
        : { kind: 'scene' as const, scene }
    ),
    ...(scenes.length === 1 ? { prepared: { scene: scenes[0], motion: [] } } : {}),
  };
  const content = {
    isDarkMode: false,
    sectionContentBlocks: sources,
    activeSectionGeneratedVisualsById: Object.fromEntries(
      scenes.map((scene, index) => [String(index), { render: { kind: 'scene', scene } }])
    ),
  } as WorkspaceReaderContentModel;
  const readTime = () => time;
  const props = { block, content, duration, readTime };
  const result = render(<LessonPlaybackStage {...props} time={time} />);
  const paragraph = result.container.querySelector<HTMLElement>('.captions p');
  if (!paragraph) throw new Error('Captions must be mounted');
  paragraph.scrollTo = vi.fn();
  return {
    ...result,
    tick: (next: number) => {
      time = next;
      flush();
    },
    advance: (next: number, speed = 1) => {
      time = next;
      result.rerender(<LessonPlaybackStage {...props} time={time} speed={speed} />);
      flush();
    },
  };
}

test('lesson clock owns automatic play, pause, speed and backward seek', () => {
  const { container, advance } = mount(proportionalScene, 'Uno due tre quattro.');
  advance(0);
  expect(container.querySelector('[data-quantity-value]')?.textContent).toBe('256');
  advance(4.8);
  expect(container.querySelector('[data-quantity-value]')?.textContent).toBe('512');
  flush();
  flush();
  expect(container.querySelector('[data-quantity-value]')?.textContent).toBe('512');
  advance(9.6, 2);
  expect(container.querySelector('[data-quantity-value]')?.textContent).toBe('768');
  advance(1);
  expect(container.querySelector('[data-quantity-value]')?.textContent).toBe('256');
  expect(container.querySelectorAll('button,input,select')).toHaveLength(0);
});

test('complete anchors follow heard words regardless of caption lead or playback speed', () => {
  const scene = {
    ...guidedPathScene,
    narration: undefined,
    steps: [
      { label: 'Prima', detail: 'Primo passaggio.', anchor: 'Uno' },
      { label: 'Seconda', detail: 'Secondo passaggio.', anchor: 'Tre' },
      { label: 'Insieme', detail: 'Lo stesso gruppo.', anchor: 'Tre' },
    ],
  };
  const { container, advance } = mount(scene, 'Uno due Tre quattro.', 4);
  advance(1.99);
  expect(container.querySelectorAll('[aria-current=step]')).toHaveLength(1);
  advance(2.01);
  expect(container.querySelectorAll('[aria-current=step]')).toHaveLength(2);
  expect(container.querySelector('.path-explanation p')?.textContent).toBe(
    'Secondo passaggio. Lo stesso gruppo.'
  );
  expect(container.querySelectorAll('.caption-word')[2].getAttribute('style')).toContain(
    'opacity: 1'
  );
  flush();
  expect(container.querySelectorAll('[aria-current=step]')).toHaveLength(2);
  advance(2.01, 0.5);
  expect(container.querySelectorAll('[aria-current=step]')).toHaveLength(2);
  advance(4);
  expect(container.querySelectorAll('.visited')).toHaveLength(3);
  expect(container.querySelector('.path-explanation p')?.textContent).toBe(
    'Secondo passaggio. Lo stesso gruppo.'
  );
  advance(0);
  expect(container.querySelectorAll('.visited')).toHaveLength(0);
  expect(container.querySelector('[aria-current=step] strong')?.textContent).toBe('Prima');
  expect(container.querySelector('.path-explanation p')?.textContent).toBe('Primo passaggio.');
});

test.each([
  'unassigned',
  'absent',
  'repeated',
])('falls back for the entire scene when block anchors are %s', reason => {
  const scene = {
    ...guidedPathScene,
    narration: undefined,
    steps: [
      { label: 'Prima', detail: 'Primo passaggio.', anchor: 'Uno' },
      {
        label: 'Seconda',
        detail: 'Secondo passaggio.',
        anchor: reason === 'unassigned' ? undefined : 'Tre',
      },
    ],
  };
  const speech =
    reason === 'absent'
      ? 'Uno due quattro.'
      : reason === 'repeated'
        ? 'Uno Tre Tre quattro.'
        : 'Uno due Tre quattro.';
  const { container, advance } = mount(scene, speech, 8);
  advance(3.9);
  expect(container.querySelector('[aria-current=step] strong')?.textContent).toBe('Prima');
  advance(4);
  expect(container.querySelector('[aria-current=step] strong')?.textContent).toBe('Seconda');
  advance(8);
  expect(container.querySelectorAll('.visited')).toHaveLength(2);
});

test('quantity cues are cumulative groups driven by heard time', () => {
  const scene = {
    ...proportionalScene,
    cues: [
      { anchor: 'Uno', value: 2 },
      { anchor: 'Tre', value: 6 },
    ],
  };
  const { container, advance } = mount(scene, 'Uno due Tre quattro.', 4);
  advance(1.99);
  expect(container.querySelectorAll('.present')).toHaveLength(2);
  advance(2.01);
  expect(container.querySelectorAll('.present')).toHaveLength(6);
  advance(0);
  expect(container.querySelectorAll('.present')).toHaveLength(2);
});

test('quantity stays initial before its first quoted group and after seeking back', () => {
  const scene = {
    ...proportionalScene,
    cues: [
      { anchor: 'Tre', value: 4 },
      { anchor: 'quattro', value: 6 },
    ],
  };
  const { container, advance } = mount(scene, 'Uno due Tre quattro.', 4);
  advance(1.99);
  expect(container.querySelectorAll('.present')).toHaveLength(2);
  advance(2.01);
  expect(container.querySelectorAll('.present')).toHaveLength(4);
  advance(0);
  expect(container.querySelectorAll('.present')).toHaveLength(2);
});

const speech = 'Uno due tre quattro cinque sei sette otto.';
const quotedPath = (title: string, anchors: string[]): LessonScene => ({
  ...guidedPathScene,
  title,
  steps: anchors.map(anchor => ({ label: anchor, detail: `${title}: ${anchor}`, anchor })),
});

const mountedTitles = (container: HTMLElement) =>
  Array.from(container.querySelectorAll('.scene h2'), heading => heading.textContent);

test.each([
  false,
  true,
])('scene remains visible between quoted spans and through passage end (stored: %s)', stored => {
  const { container, tick, advance } = mount(
    [quotedPath('Late', ['sei', 'otto.']), quotedPath('Early', ['Uno', 'due tre'])],
    speech,
    8,
    stored
  );
  const visible = () => mountedTitles(container);
  expect(visible()).toEqual(['Early']);
  // The last quotation still covers "tre", past its first word "due".
  tick(1.2);
  expect(visible()).toEqual(['Early']);
  tick(2);
  expect(visible()).toEqual(['Early']);
  tick(4);
  expect(visible()).toEqual(['Early']);
  tick(5);
  expect(visible()).toEqual(['Late']);
  advance(3, 0.5);
  expect(visible()).toEqual(['Early']);
  advance(3, 2);
  expect(visible()).toEqual(['Early']);
  tick(8);
  expect(visible()).toEqual(['Late']);
  tick(0);
  expect(visible()).toEqual(['Early']);
});

test.each([
  false,
  true,
])('later scene replaces an overlap and follows measured voice estimates (stored: %s)', stored => {
  const { container, tick } = mount(
    [quotedPath('Late', ['sei', 'otto.']), quotedPath('Middle', ['quattro', 'sette'])],
    speech,
    8,
    stored
  );
  tick(3.1);
  expect(mountedTitles(container)).toEqual(['Middle']);
  // Six starts on the measured voice clock, independently of caption look-ahead.
  const replacementTime = (500 / 800) * 8;
  tick(replacementTime - 0.001);
  expect(mountedTitles(container)).toEqual(['Middle']);
  tick(replacementTime);
  expect(mountedTitles(container)).toEqual(['Late']);
  expect(container.querySelector('[aria-current=step] strong')?.textContent).toBe('sei');
  tick(7);
  expect(container.querySelector('[aria-current=step] strong')?.textContent).toBe('otto.');
  tick(3.1);
  expect(mountedTitles(container)).toEqual(['Middle']);
  expect(container.querySelector('[aria-current=step] strong')?.textContent).toBe('quattro');
  tick(4);
  vi.mocked(HTMLElement.prototype.getBoundingClientRect).mockImplementation(function (
    this: HTMLElement
  ) {
    return { width: this.textContent?.trim() === 'Uno' ? 1000 : 100 } as DOMRect;
  });
  act(() => window.dispatchEvent(new Event('resize')));
  flush();
  expect(mountedTitles(container)).toEqual(['Middle']);
});

test('unanchored scenes retain their sequential slot and restart relative to that slot', () => {
  const { container, advance } = mount(
    [quotedPath('Early', ['Uno', 'due']), proportionalScene],
    speech,
    8
  );
  expect(container.querySelector('[data-quantity-value]')).toBeNull();
  advance(4);
  expect(container.querySelector('[data-quantity-value]')?.textContent).toBe('256');
  advance(6);
  expect(container.querySelector('[data-quantity-value]')?.textContent).toBe('512');
  advance(8);
  expect(container.querySelector('[data-quantity-value]')?.textContent).toBe('768');
  advance(0);
  expect(container.querySelector('[data-quantity-value]')).toBeNull();
});

test('the later scene remains visible after its final quotation', () => {
  const { container, tick } = mount(
    [quotedPath('Long', ['Uno', 'otto.']), quotedPath('Short', ['quattro', 'cinque'])],
    speech,
    8
  );
  tick(0);
  expect(mountedTitles(container)).toEqual(['Long']);
  tick(3.1);
  expect(mountedTitles(container)).toEqual(['Short']);
  tick(8);
  expect(mountedTitles(container)).toEqual(['Short']);
  tick(0);
  expect(mountedTitles(container)).toEqual(['Long']);
});

test('automatic and synchronized scenes share one visible slot with their own clocks', () => {
  const { container, tick } = mount(
    [quotedPath('Long', ['Uno', 'otto.']), proportionalScene],
    speech,
    8
  );
  tick(3.9);
  expect(mountedTitles(container)).toEqual(['Long']);
  tick(4);
  expect(mountedTitles(container)).toEqual([proportionalScene.title]);
  expect(container.querySelector('[data-quantity-value]')?.textContent).toBe('256');
  tick(6);
  expect(mountedTitles(container)).toEqual([proportionalScene.title]);
  expect(container.querySelector('[data-quantity-value]')?.textContent).toBe('512');
  tick(0);
  expect(mountedTitles(container)).toEqual(['Long']);
});

test('only the selected animated visual owns a runtime, including replacement and backward seek', () => {
  const scenes = ['First', 'Second', 'Third'].map(title => ({ ...proportionalScene, title }));
  const { container, tick, unmount } = mount(scenes, speech, 12);
  const title = () => container.querySelector('.scene h2')?.textContent;
  expect(container.querySelectorAll('.scene')).toHaveLength(1);
  expect(title()).toBe('First');
  const first = container.querySelector('.scene');
  expect(callbacks.size).toBe(3);
  tick(4);
  expect(container.querySelectorAll('.scene')).toHaveLength(1);
  expect(title()).toBe('Second');
  expect(first?.isConnected).toBe(false);
  expect(callbacks.size).toBe(3);
  tick(0);
  expect(title()).toBe('First');
  expect(container.querySelector('[data-quantity-value]')?.textContent).toBe('256');
  expect(callbacks.size).toBe(3);
  unmount();
  expect(callbacks.size).toBe(0);
});
