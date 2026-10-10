// @vitest-environment jsdom
import { segmentLessonPlayback } from '@shared/lessonPlayback';
import type { LessonScene } from '@shared/lessonScene';
import { act, render } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';
import {
  CAPTION_TIMING,
  captionFormat,
  captionLookAhead,
  captionPauses,
  captionSource,
  captionSpeechRanges,
  pacedCaptionTime,
} from '../../../components/workspace/playback/captionFormat.ts';
import LessonPlaybackStage from '../../../components/workspace/playback/LessonPlaybackStage.tsx';
import {
  captionMotionEvents,
  motionStates,
} from '../../../components/workspace/playback/stageMotion.ts';
import type { WorkspaceReaderContentModel } from '../../../components/workspace/shell/types.ts';
import { useShouldAnimate } from '../../../utils/motion/useShouldAnimate.ts';

vi.mock('../../../utils/motion/useShouldAnimate.ts', () => ({ useShouldAnimate: vi.fn() }));

let resizeScene: () => void;
const disconnectScene = vi.fn();
beforeEach(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(callback: () => void) {
        resizeScene = callback;
      }
      observe() {}
      disconnect = disconnectScene;
    }
  );
});

test('fits the complete scene into both available dimensions and releases the observer', () => {
  const sources = [{ type: 'markdown' as const, markdown: 'Una frase.' }];
  const { container, unmount } = render(
    <LessonPlaybackStage
      block={segmentLessonPlayback(sources)[0]}
      content={{ isDarkMode: false, sectionContentBlocks: sources } as WorkspaceReaderContentModel}
      duration={6}
      time={0}
    />
  );
  const slot = container.querySelector<HTMLElement>('.scene-fit');
  const card = container.querySelector<HTMLElement>('.scene-host');
  const stage = container.querySelector<HTMLElement>('.listening-stage');
  const captions = container.querySelector<HTMLElement>('.captions');
  if (!slot || !card || !stage || !captions) throw new Error('Stage must be mounted');
  stage.style.paddingTop = '32px';
  stage.style.paddingBottom = '32px';
  Object.defineProperty(card, 'offsetHeight', { configurable: true, value: 600 });
  Object.defineProperty(card, 'offsetWidth', { configurable: true, value: 700 });
  Object.defineProperty(slot, 'clientWidth', { configurable: true, value: 700 });
  Object.defineProperty(stage, 'clientHeight', { configurable: true, value: 364 });
  act(() => resizeScene());
  expect(slot.style.getPropertyValue('--scene-scale')).toBe('0.5');
  expect(slot.style.height).toBe('300px');
  Object.defineProperty(stage, 'clientHeight', { configurable: true, value: 864 });
  act(() => resizeScene());
  expect(slot.style.getPropertyValue('--scene-scale')).toBe('1');
  expect(slot.style.height).toBe('600px');
  // A wide table or code block must fit too, even when the card itself does not resize.
  Object.defineProperty(card, 'scrollWidth', { configurable: true, value: 1400 });
  act(() => resizeScene());
  expect(slot.style.getPropertyValue('--scene-scale')).toBe('0.5');
  expect(slot.style.height).toBe('300px');
  expect(card.style.width).toBe('1400px');
  Object.defineProperty(card, 'scrollHeight', { configurable: true, value: 2000 });
  act(() => resizeScene());
  expect(slot.style.getPropertyValue('--scene-scale')).toBe('0.4');
  expect(slot.style.getPropertyValue('--scene-left')).toBe('70px');
  // On a phone, the scene shares the stage with the captions and their gap.
  stage.style.flexDirection = 'column';
  stage.style.rowGap = '20px';
  Object.defineProperty(captions, 'offsetHeight', { configurable: true, value: 140 });
  act(() => resizeScene());
  expect(slot.style.getPropertyValue('--scene-scale')).toBe('0.32');
  expect(slot.style.height).toBe('640px');
  unmount();
  expect(disconnectScene).toHaveBeenCalledTimes(1);
});

test('mounts a fresh scene for each block so the page transition restarts', () => {
  vi.mocked(useShouldAnimate).mockReturnValue(false);
  const sources = [{ type: 'markdown' as const, markdown: 'Prima frase.\n\nSeconda frase.' }];
  const blocks = segmentLessonPlayback(sources);
  const scene: LessonScene = {
    type: 'parts',
    title: 'Concetti',
    body: '',
    items: [{ icon: 'point', label: 'Prima', detail: '' }],
    groups: [],
    note: '',
    quote: '',
  };
  const content = {
    isDarkMode: false,
    sectionContentBlocks: sources,
  } as WorkspaceReaderContentModel;
  const visuals = [{ kind: 'scene' as const, scene }];
  const { container, rerender } = render(
    <LessonPlaybackStage
      block={{ ...blocks[0], visuals }}
      content={content}
      duration={6}
      time={0}
    />
  );
  const firstScene = container.querySelector('.scene');
  rerender(
    <LessonPlaybackStage
      block={{ ...blocks[1], visuals }}
      content={content}
      duration={6}
      time={0}
    />
  );
  expect(firstScene).not.toBeNull();
  expect(container.querySelector('.scene')).not.toBe(firstScene);
  expect(container.querySelectorAll('.scene-host')).toHaveLength(1);
});

test.each([
  true,
  false,
])('reveals continuously and moves the active line past halfway (animate=%s)', animate => {
  vi.mocked(useShouldAnimate).mockReturnValue(animate);
  const source = [{ type: 'markdown' as const, markdown: 'Uno due tre quattro cinque sei.' }];
  const block = segmentLessonPlayback(source)[0];
  const content = {
    isDarkMode: false,
    sectionContentBlocks: source,
  } as WorkspaceReaderContentModel;
  let tick: FrameRequestCallback = () => {};
  vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation(callback => {
    tick = callback;
    return 1;
  });
  vi.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation(() => {});
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    width: 100,
  } as DOMRect);
  const computedStyle = document.createElement('p').style;
  computedStyle.setProperty('--caption-feather', '22px');
  vi.spyOn(globalThis, 'getComputedStyle').mockReturnValue(computedStyle);
  const props = { block, content, duration: 6 };
  const { container, rerender } = render(<LessonPlaybackStage {...props} time={0} />);
  const paragraph = container.querySelector('.captions p');
  if (!(paragraph instanceof HTMLElement)) throw new Error('Captions must be rendered');
  const scrollTo = vi.fn();
  paragraph.scrollTo = scrollTo;
  Object.defineProperty(paragraph, 'clientHeight', { value: 200 });
  const lines = [0, 80, 100, 100, 180, 200];
  paragraph.querySelectorAll<HTMLElement>('.caption-word').forEach((word, index) => {
    Object.defineProperties(word, {
      offsetTop: { value: lines[index] },
      offsetHeight: { value: 20 },
    });
  });
  const advance = (time: number) => {
    rerender(<LessonPlaybackStage {...props} time={time} />);
    act(() => tick(0));
  };
  advance(0.1);
  const first = paragraph.querySelector<HTMLElement>('.caption-word');
  expect(first?.style.opacity).toBe('1');
  expect(parseFloat(first?.style.getPropertyValue('--reveal-edge') ?? '')).toBeGreaterThan(0);
  expect(parseFloat(first?.style.getPropertyValue('--reveal-edge') ?? '')).toBeLessThan(100);
  advance(1);
  expect(scrollTo).toHaveBeenLastCalledWith({ top: 100, behavior: animate ? 'smooth' : 'instant' });
  advance(2);
  expect(scrollTo).toHaveBeenCalledTimes(1);
  advance(4);
  expect(scrollTo).toHaveBeenLastCalledWith({ top: 200, behavior: animate ? 'smooth' : 'instant' });
  expect(parseFloat((first?.firstElementChild as HTMLElement).style.opacity)).toBeCloseTo(0.55);
  paragraph.scrollTop = 200;
  rerender(<LessonPlaybackStage {...props} block={{ ...block, id: 'next' }} time={0} />);
  const next = container.querySelector('.captions p');
  expect(next?.scrollTop).toBe(0);
});

test('recovers heading, emphasis, code and list markers from authored source spans', () => {
  const sources = [
    {
      type: 'markdown' as const,
      markdown: '# Sezione\n\n- **Prima parola** e `codice`.\n- Seconda voce.',
    },
  ];
  const block = segmentLessonPlayback(sources)[0];
  const formatted = captionFormat(captionSource(block, sources).markdown);
  expect(formatted.headings).toEqual(['Sezione']);
  expect(formatted.headingWords).toBe(1);
  expect(formatted.words[0]).toMatchObject({
    text: 'Prima',
    bold: true,
    breakBefore: true,
    marker: '•',
  });
  expect(formatted.words.find(word => word.text === 'codice')).toMatchObject({ code: true });
  expect(formatted.words.find(word => word.text === 'Seconda')).toMatchObject({
    breakBefore: true,
    marker: '•',
  });
});

test('uses the calibrated lead ramp and recovers pacing after punctuation without drift', () => {
  expect(captionLookAhead(0, 1, 1.3)).toBe(0);
  expect(captionLookAhead(0.275, 1, 1.3)).toBeCloseTo(0.65);
  expect(captionLookAhead(2, 2, 1.3)).toBe(2.6);
  const words = captionFormat('Prima, seconda frase.').words;
  const cues = captionPauses(words, [1 / 3, 2 / 3, 1], 6);
  expect(pacedCaptionTime(2, cues)).toBeCloseTo(2 - 0.055);
  expect(pacedCaptionTime(3, cues)).toBe(3);
  expect(CAPTION_TIMING.readFadeSeconds).toBe(2);
});

test('maps exact quotations to measured word widths and clips motion at the next event', () => {
  const runs = [10, 30, 60].map((width, index, widths) => ({
    span: document.createElement('span'),
    width,
    start: widths.slice(0, index).reduce((sum, width) => sum + width, 0),
  }));
  const events = captionMotionEvents({
    events: [
      { effect: 'focus', targets: ['item:0'], quote: 'Uno' },
      { effect: 'focus', targets: ['item:1'], quote: 'due tre' },
    ],
    speech: 'Uno due tre',
    speechRanges: [
      { start: 0, end: 3 },
      { start: 4, end: 7 },
      { start: 8, end: 11 },
    ],
    runs,
    width: 100,
    feather: 22,
    duration: 6,
  });
  expect(events[0].atMs).toBe(0);
  expect(events[0].durationMs).toBeCloseTo((10 / 122) * 6000);
  expect(events[1].atMs).toBeCloseTo((10 / 122) * 6000);
});

test('keeps motion quotation anchors aligned after formatted punctuation and links', () => {
  const sources = [
    {
      type: 'markdown' as const,
      markdown: '# Sezione\n\n**Prima** `codice`. [Poi](https://example.com) ultima.',
    },
  ];
  const block = segmentLessonPlayback(sources)[0];
  const source = captionSource(block, sources);
  const formatted = captionFormat(source.markdown);
  const speechRanges = captionSpeechRanges(formatted.words, source.ranges);
  const options = {
    speech: block.speech,
    speechRanges,
    runs: formatted.words.map((_, index) => ({
      span: document.createElement('span'),
      start: index * 100,
      width: 100,
    })),
    width: formatted.words.length * 100,
    feather: 22,
    duration: 6,
  };
  const events = captionMotionEvents({
    ...options,
    events: [{ effect: 'focus', targets: ['item:0'], quote: 'ultima.' }],
  });
  const heading = captionMotionEvents({
    ...options,
    events: [{ effect: 'focus', targets: ['item:0'], quote: 'Sezione' }],
  });
  expect(heading[0].atMs).toBe(0);
  const lastWord = formatted.words.length - 1;
  expect(events[0].atMs).toBeCloseTo(
    ((lastWord * 100) / (formatted.words.length * 100 + 22)) * 6000
  );
  const punctuation = formatted.words.findIndex(word => word.text === '.');
  expect(block.speech.slice(speechRanges[punctuation].start, speechRanges[punctuation].end)).toBe(
    '.'
  );
});

test('recomputes smooth reveal, focus delay, holds and backward seeks from time', () => {
  const reveal = [
    { effect: 'reveal' as const, targets: ['item:0'], quote: 'Prima', atMs: 100, durationMs: 700 },
  ];
  expect(motionStates(['item:0', 'item:1'], reveal, 450, false, 0).get('item:0')?.opacity).toBe(
    0.5
  );
  expect(motionStates(['item:0'], reveal, 100, true, 0).get('item:0')?.opacity).toBe(1);
  expect(motionStates(['item:0'], reveal, 50, false, 0).get('item:0')?.opacity).toBe(0);
  const focus = [
    { effect: 'focus' as const, targets: ['item:0'], quote: 'Prima', atMs: 0, durationMs: 10000 },
  ];
  expect(motionStates(['item:0', 'item:1'], focus, 1000, false, 1300).get('item:0')?.emphasis).toBe(
    0
  );
  const focused = motionStates(['item:0', 'item:1'], focus, 1600, false, 1300);
  expect(focused.get('item:0')?.emphasis).toBeGreaterThan(0);
  expect(focused.get('item:1')).toEqual({ opacity: 1, emphasis: 0 });
  expect(motionStates(['item:0'], focus, 5400, false, 1300).get('item:0')?.emphasis).toBe(0);
});
