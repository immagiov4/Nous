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

function mount(scene: LessonScene, speech: string, duration = 9.6) {
  let time = 0;
  const sources = [{ type: 'markdown' as const, markdown: speech }];
  const block = {
    ...segmentLessonPlayback(sources)[0],
    visuals: [{ kind: 'scene' as const, scene }],
    prepared: { scene, motion: [] },
  };
  const content = {
    isDarkMode: false,
    sectionContentBlocks: sources,
  } as WorkspaceReaderContentModel;
  const readTime = () => time;
  const props = { block, content, duration, readTime };
  const result = render(<LessonPlaybackStage {...props} time={time} />);
  const paragraph = result.container.querySelector<HTMLElement>('.captions p');
  if (!paragraph) throw new Error('Captions must be mounted');
  paragraph.scrollTo = vi.fn();
  return {
    ...result,
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
  expect(container.querySelector('output')?.textContent).toBe('256');
  advance(4.8);
  expect(container.querySelector('output')?.textContent).toBe('512');
  flush();
  flush();
  expect(container.querySelector('output')?.textContent).toBe('512');
  advance(9.6, 2);
  expect(container.querySelector('output')?.textContent).toBe('768');
  advance(1);
  expect(container.querySelector('output')?.textContent).toBe('256');
  expect(container.querySelectorAll('button,input,select')).toHaveLength(0);
});

test('complete anchors follow measured captions, including speed, groups and backward seek', () => {
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
  advance(0.59);
  expect(container.querySelectorAll('[aria-current=step]')).toHaveLength(1);
  advance(0.61);
  expect(container.querySelectorAll('[aria-current=step]')).toHaveLength(2);
  expect(container.querySelectorAll('.caption-word')[2].getAttribute('style')).toContain(
    'opacity: 1'
  );
  flush();
  expect(container.querySelectorAll('[aria-current=step]')).toHaveLength(2);
  advance(0.61, 0.5);
  expect(container.querySelector('[aria-current=step] strong')?.textContent).toBe('Prima');
  advance(4);
  expect(container.querySelectorAll('.visited')).toHaveLength(3);
  advance(0);
  expect(container.querySelectorAll('.visited')).toHaveLength(0);
  expect(container.querySelector('[aria-current=step] strong')?.textContent).toBe('Prima');
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

test('quantity cues are cumulative groups driven by captions', () => {
  const scene = {
    ...proportionalScene,
    cues: [
      { anchor: 'Uno', value: 2 },
      { anchor: 'Tre', value: 6 },
    ],
  };
  const { container, advance } = mount(scene, 'Uno due Tre quattro.', 4);
  advance(0.59);
  expect(container.querySelectorAll('.present')).toHaveLength(2);
  advance(0.61);
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
  advance(0.59);
  expect(container.querySelectorAll('.present')).toHaveLength(2);
  advance(0.61);
  expect(container.querySelectorAll('.present')).toHaveLength(4);
  advance(0);
  expect(container.querySelectorAll('.present')).toHaveLength(2);
});
