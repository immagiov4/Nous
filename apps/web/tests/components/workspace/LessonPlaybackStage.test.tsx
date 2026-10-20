// @vitest-environment jsdom
import { resolvePlaybackNarration, segmentLessonPlayback } from '@shared/lessonPlayback';
import type { LessonScene } from '@shared/lessonScene';
import { act, render, screen } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';
import { discreteMathCases } from '../../../../backend/tests/helpers/discreteMath';
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
import { resolveProjectVisual } from '../../../services/projects/projectVisualResolver.ts';
import { useShouldAnimate } from '../../../utils/motion/useShouldAnimate.ts';

vi.mock('../../../utils/motion/useShouldAnimate.ts', () => ({ useShouldAnimate: vi.fn() }));
vi.mock('../../../services/projects/projectVisualResolver.ts', () => ({
  resolveProjectVisual: vi.fn(),
}));

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
  const frames = new Map<number, FrameRequestCallback>();
  let frameId = 0;
  vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation(callback => {
    frames.set(++frameId, callback);
    return frameId;
  });
  vi.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation(id => {
    frames.delete(id);
  });
  const flushFrame = () => {
    const queued = [...frames.values()];
    frames.clear();
    act(() => {
      for (const callback of queued) callback(0);
    });
  };
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
  act(() => {
    resizeScene();
    resizeScene();
  });
  expect(slot.style.height).toBe('');
  flushFrame();
  expect(slot.style.getPropertyValue('--scene-scale')).toBe('0.5');
  expect(slot.style.height).toBe('300px');
  Object.defineProperty(stage, 'clientHeight', { configurable: true, value: 864 });
  act(() => resizeScene());
  flushFrame();
  expect(slot.style.getPropertyValue('--scene-scale')).toBe('1');
  expect(slot.style.height).toBe('600px');
  // A wide table or code block must fit too, even when the card itself does not resize.
  Object.defineProperty(card, 'scrollWidth', { configurable: true, value: 1400 });
  act(() => resizeScene());
  flushFrame();
  expect(slot.style.getPropertyValue('--scene-scale')).toBe('0.5');
  expect(slot.style.height).toBe('300px');
  expect(card.style.width).toBe('1400px');
  Object.defineProperty(card, 'scrollHeight', { configurable: true, value: 2000 });
  act(() => resizeScene());
  flushFrame();
  expect(slot.style.getPropertyValue('--scene-scale')).toBe('0.4');
  expect(slot.style.getPropertyValue('--scene-left')).toBe('70px');
  stage.style.flexDirection = 'column';
  stage.style.rowGap = '20px';
  Object.defineProperty(captions, 'offsetHeight', { configurable: true, value: 140 });
  act(() => resizeScene());
  flushFrame();
  expect(slot.style.getPropertyValue('--scene-scale')).toBe('0.4');
  expect(slot.style.height).toBe('800px');
  expect(card.style.width).toBe('1400px');
  expect(slot.style.getPropertyValue('--scene-left')).toBe('70px');
  act(() => resizeScene());
  unmount();
  expect(frames.size).toBe(0);
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
])('reveals whole words with a fade and moves the active line past halfway (animate=%s)', animate => {
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
  if (animate) {
    expect(Number(first?.style.opacity)).toBeGreaterThan(0);
    expect(Number(first?.style.opacity)).toBeLessThan(1);
  } else {
    expect(first?.style.opacity).toBe('1');
  }
  expect(first?.style.getPropertyValue('--reveal-edge')).toBe('');
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

test.each([
  '# \nTitle\nBody',
  '# \t\r\n\r\nTitle\r\nBody',
])('preserves heading whitespace and body source positions: %j', markdown => {
  const formatted = captionFormat(markdown);
  expect(formatted.headings).toEqual(['Title']);
  expect(formatted.headingWords).toBe(1);
  expect(formatted.words).toHaveLength(1);
  expect(formatted.words[0]).toMatchObject({
    text: 'Body',
    source: { start: markdown.indexOf('Body'), end: markdown.length },
  });
});

test('preserves whitespace-only headings and handles long heading separators', () => {
  expect(captionFormat('#  ')).toEqual({ headings: [' '], headingWords: 0, words: [] });
  const markdown = `#${' '.repeat(100_000)}Title\nBody`;
  const formatted = captionFormat(markdown);
  expect(formatted.headings).toEqual(['Title']);
  expect(formatted.words).toHaveLength(1);
  expect(formatted.words[0].source).toEqual({
    start: markdown.indexOf('Body'),
    end: markdown.length,
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
  const formatted = captionFormat(source.markdown, source.ranges);
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

test('captions display canonical inline text and every spoken heading', () => {
  const sources = [
    {
      type: 'markdown' as const,
      markdown:
        '# **Tema**\n## Dettaglio\n\n*ricorda* [questa guida](https://example.com) e _il punto_. `a*b`.',
    },
  ];
  const block = segmentLessonPlayback(sources)[0];
  const source = captionSource(block, sources);
  const formatted = captionFormat(source.markdown, source.ranges);
  expect(formatted.headings).toEqual(['Tema', 'Dettaglio']);
  expect(formatted.headingWords).toBe(2);
  expect(formatted.words.map(word => word.text).join(' ')).toBe(
    'ricorda questa guida e il punto. a*b .'
  );
  const ranges = captionSpeechRanges(formatted.words, source.ranges);
  expect(ranges.every(range => Number.isFinite(range.start) && Number.isFinite(range.end))).toBe(
    true
  );
  const { container } = render(
    <LessonPlaybackStage
      block={block}
      content={
        { ...{ isDarkMode: false }, sectionContentBlocks: sources } as WorkspaceReaderContentModel
      }
      duration={6}
      time={0}
    />
  );
  expect(Array.from(container.querySelectorAll('h2'), heading => heading.textContent)).toEqual([
    'Tema',
    'Dettaglio',
  ]);
  expect(container.querySelector('.caption-page')?.textContent).not.toContain(
    'https://example.com'
  );
});

test('simultaneous focus and reveal cues retain their duration', () => {
  const events = captionMotionEvents({
    events: [
      { effect: 'focus', targets: ['item:0'], quote: 'Uno' },
      { effect: 'focus', targets: ['item:1'], quote: 'Uno' },
      { effect: 'reveal', targets: ['item:2'], quote: 'Uno' },
      { effect: 'focus', targets: ['item:0'], quote: 'due' },
    ],
    speech: 'Uno due',
    speechRanges: [
      { start: 0, end: 3 },
      { start: 4, end: 7 },
    ],
    runs: [0, 100].map(start => ({ span: document.createElement('span'), start, width: 100 })),
    width: 200,
    feather: 0,
    duration: 4,
  });
  expect(events.slice(0, 3).every(event => event.durationMs > 0)).toBe(true);
  const states = motionStates(['item:0', 'item:1', 'item:2'], events, 500, false, 0);
  expect(states.get('item:0')?.emphasis).toBeGreaterThan(0);
  expect(states.get('item:1')?.emphasis).toBeGreaterThan(0);
  expect(states.get('item:2')?.opacity).toBeGreaterThan(0);
});

test('stored playback images have one asset resolver and release it on unmount', async () => {
  const visual = {
    id: 'image',
    slotId: 'slot',
    createdAt: '2026-10-10T00:00:00.000Z',
    title: 'Figura',
    render: {
      kind: 'image' as const,
      asset: { id: 'a'.repeat(64), hash: 'b'.repeat(64), byteSize: 1, mediaType: 'image/png' },
    },
  };
  const release = vi.fn();
  vi.mocked(resolveProjectVisual).mockResolvedValue({
    release,
    trustedImageUrl: true,
    visual: {
      id: 'image',
      createdAt: visual.createdAt,
      title: 'Figura',
      kind: 'image',
      code: 'blob:image',
    },
  });
  const sources = [
    { type: 'markdown' as const, markdown: 'Una frase.' },
    { type: 'generated-visual' as const, visualId: visual.id, slotId: visual.slotId },
  ];
  const { unmount } = render(
    <LessonPlaybackStage
      block={segmentLessonPlayback(sources)[0]}
      content={{
        ...({ isDarkMode: false } as WorkspaceReaderContentModel),
        isDarkMode: false,
        projectId: 'project',
        sectionContentBlocks: sources,
        activeSectionGeneratedVisualsById: { image: visual },
      }}
      duration={6}
      time={0}
    />
  );
  expect(await screen.findByRole('img', { name: 'Figura' })).toHaveAttribute('src', 'blob:image');
  expect(resolveProjectVisual).toHaveBeenCalledOnce();
  unmount();
  expect(release).toHaveBeenCalledOnce();
});

test('mounts only the selected generated HTML frame and releases it on replacement', () => {
  const frames = new Map<number, FrameRequestCallback>();
  let frameId = 0;
  vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation(callback => {
    frames.set(++frameId, callback);
    return frameId;
  });
  vi.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation(id => {
    frames.delete(id);
  });
  const sources = [{ type: 'markdown' as const, markdown: 'Una frase.' }];
  const visuals = ['First', 'Second'].map(title => ({
    id: title,
    title,
    createdAt: '2026-10-11T00:00:00.000Z',
    kind: 'html' as const,
    code: '<p>Content</p>',
  }));
  const block = {
    ...segmentLessonPlayback(sources)[0],
    visuals: visuals.map(visual => ({ kind: 'generated-visual' as const, visualId: visual.id })),
  };
  const content = {
    isDarkMode: false,
    sectionContentBlocks: sources,
    activeSectionGeneratedVisualsById: Object.fromEntries(
      visuals.map(visual => [visual.id, visual])
    ),
  } as WorkspaceReaderContentModel;
  const { container, rerender, unmount } = render(
    <LessonPlaybackStage block={block} content={content} duration={8} time={0} />
  );
  const first = screen.getByTitle('First');
  expect(container.querySelectorAll('iframe')).toHaveLength(1);
  expect(screen.queryByTitle('Second')).toBeNull();
  rerender(<LessonPlaybackStage block={block} content={content} duration={8} time={4} />);
  act(() => {
    const pending = [...frames.values()];
    frames.clear();
    pending.forEach(callback => {
      callback(0);
    });
  });
  expect(container.querySelectorAll('iframe')).toHaveLength(1);
  expect(screen.getByTitle('Second')).toBeInTheDocument();
  expect(first.isConnected).toBe(false);
  unmount();
  expect(frames.size).toBe(0);
});

test.each([
  ['Il risultato di `2 ** 3` è otto.', ['Il', 'risultato', 'di', '2', '**', '3', 'è', 'otto.']],
  ['Usa ``a ` b`` qui.', ['Usa', 'a', '`', 'b', 'qui.']],
])('captions preserve spoken Markdown delimiters inside code: %s', (markdown, expected) => {
  const sources = [{ type: 'markdown' as const, markdown: markdown as string }];
  const block = segmentLessonPlayback(sources)[0];
  const source = captionSource(block, sources);
  const formatted = captionFormat(source.markdown, source.ranges);
  expect(formatted.words.map(word => word.text)).toEqual(expected);
  expect(formatted.words.every(word => !word.bold)).toBe(true);
  expect(formatted.words.at(-1)?.code).toBe(false);
  const literal = formatted.words.find(word => word.text === '**' || word.text === '`');
  expect(literal?.code).toBe(true);
  expect(
    captionSpeechRanges(formatted.words, source.ranges).every(
      range => Number.isFinite(range.start) && Number.isFinite(range.end)
    )
  ).toBe(true);
});

test.each([
  '<mark data-nous-annotation-id="b">',
  '<mark\n data-nous-annotation-id="b">',
  '<mark title="**">',
  '<mark title="`">',
  '<mark\n title="**" data-nous-annotation-id="b">',
])('keeps words intact across annotation wrappers and maps their complete speech ranges: %s', opener => {
  const sources = [
    {
      type: 'markdown' as const,
      markdown: `<mark data-nous-annotation-id="a">The Greek let</mark>${opener}ter is a parameter.</mark>`,
    },
  ];
  const block = segmentLessonPlayback(sources)[0];
  const source = captionSource(block, sources);
  const formatted = captionFormat(source.markdown, source.ranges);
  expect(formatted.words.map(word => word.text)).toEqual([
    'The',
    'Greek',
    'letter',
    'is',
    'a',
    'parameter.',
  ]);
  expect(formatted.words.every(word => !word.bold && !word.code)).toBe(true);
  const ranges = captionSpeechRanges(formatted.words, source.ranges);
  expect(ranges.map(range => block.speech.slice(range.start, range.end))).toEqual([
    'The',
    'Greek',
    'letter',
    'is',
    'a',
    'parameter.',
  ]);
});

test.each([
  '- literal minus',
  '1. literal number',
  '# literal heading',
])('keeps annotated literal block markers in caption words: %s', text => {
  const sources = [{ type: 'markdown' as const, markdown: `<mark>${text}</mark>` }];
  const block = segmentLessonPlayback(sources)[0];
  const source = captionSource(block, sources);
  const formatted = captionFormat(source.markdown, source.ranges);
  expect(formatted.headings).toEqual([]);
  expect(formatted.words.map(word => word.text)).toEqual(text.split(' '));
  expect(formatted.words.every(word => !word.list && !word.breakBefore)).toBe(true);
  expect(
    captionSpeechRanges(formatted.words, source.ranges).map(range =>
      block.speech.slice(range.start, range.end)
    )
  ).toEqual(text.split(' '));
});

test.each([
  { source: '<mark>- literal $x$</mark>', literal: '- literal' },
  { source: '<mark># literal $x$</mark>', literal: '# literal' },
  { source: '<mark>1. literal $x$</mark>', literal: '1. literal' },
  { source: '<mark>> literal $x$</mark>', literal: '> literal' },
  { source: '-<mark> </mark>literal $x$', literal: '- literal' },
])('preserves literal block markers on contextual cards: $source', ({ source, literal }) => {
  const sources = [{ type: 'markdown' as const, markdown: `Introduction.\n\n${source}` }];
  const block = segmentLessonPlayback(sources)[1];
  const content = {
    isDarkMode: false,
    sectionContentBlocks: sources,
  } as WorkspaceReaderContentModel;
  const { container, rerender } = render(
    <LessonPlaybackStage block={block} content={content} duration={6} time={1} />
  );
  for (const time of [1, 3, 5]) {
    rerender(<LessonPlaybackStage block={block} content={content} duration={6} time={time} />);
    const card = container.querySelector('.scene-host');
    expect(card?.textContent).toContain(literal);
    expect(card?.querySelector('ul, ol, blockquote, h1, h2, h3, h4, h5, h6')).toBeNull();
    expect(card?.querySelector('.katex')).not.toBeNull();
    expect(card?.querySelector('mark')).toBeNull();
  }
});
test.each([
  { source: '- <mark>literal $x$</mark>', selector: 'li' },
  { source: '# <mark>literal $x$</mark>', selector: 'h1' },
  { source: '> <mark>literal $x$</mark>', selector: 'blockquote' },
])('retains authored block structure around annotated math: $source', ({ source, selector }) => {
  const sources = [{ type: 'markdown' as const, markdown: `${source}\n\nContinue.` }];
  const { container } = render(
    <LessonPlaybackStage
      block={segmentLessonPlayback(sources)[0]}
      content={{ isDarkMode: false, sectionContentBlocks: sources } as WorkspaceReaderContentModel}
      duration={6}
      time={3}
    />
  );
  const card = container.querySelector('.scene-host');
  expect(card?.querySelector(selector)?.textContent).toContain('literal');
  expect(card?.querySelector('.katex')).not.toBeNull();
});

import {
  FORMULA_SPOTLIGHT_MARKDOWN,
  formulaSpotlight,
} from '../../../../backend/tests/helpers/formulaSpotlight';
import { sceneCaptionAnchors } from '../../../components/workspace/playback/stageMotion.ts';

test('a model-chosen spotlight replaces the contextual math card while text fallback retains it', () => {
  const source = [{ type: 'markdown' as const, markdown: FORMULA_SPOTLIGHT_MARKDOWN }];
  const block = segmentLessonPlayback(source)[0];
  const content = {
    isDarkMode: false,
    sectionContentBlocks: source,
  } as WorkspaceReaderContentModel;
  const { container, rerender } = render(
    <LessonPlaybackStage
      block={{ ...block, prepared: { scene: formulaSpotlight, motion: [] } }}
      content={content}
      duration={10}
      time={2}
    />
  );
  expect(container.querySelector('.formula-spotlight')).not.toBeNull();
  expect(sceneCaptionAnchors(formulaSpotlight, block.speech)).toEqual(
    formulaSpotlight.symbols.map(symbol => symbol.anchor)
  );
  rerender(
    <LessonPlaybackStage
      block={{ ...block, prepared: { motion: [] } }}
      content={content}
      duration={10}
      time={2}
    />
  );
  expect(container.querySelector('.formula-spotlight')).toBeNull();
  expect(container.querySelector('.scene-host')?.textContent).toContain(
    'La probabilità, indicata con p, è la stima del modello.'
  );
  expect(container.querySelector('.scene-host .katex')).not.toBeNull();
});
test('uses the prepared spoken formula in captions while retaining authored math on the visual', () => {
  const markdown = String.raw`Consideriamo $p_\theta(y\mid x)$. La probabilità descrive il risultato.`;
  const sources = [{ type: 'markdown' as const, markdown }];
  const raw = segmentLessonPlayback(sources)[0];
  const block = {
    ...raw,
    prepared: {
      motion: [],
      spokenMath: [
        { formula: String.raw`$p_\theta(y\mid x)$`, spoken: 'p con parametro theta di y dato x' },
      ],
    },
  };
  const { container } = render(
    <LessonPlaybackStage
      block={block}
      content={{ isDarkMode: false, sectionContentBlocks: sources } as WorkspaceReaderContentModel}
      duration={8}
      time={8}
    />
  );
  expect(container.querySelector('.caption-page')?.textContent?.trim()).toBe(
    'Consideriamo p con parametro theta di y dato x. La probabilità descrive il risultato.'
  );
  expect(container.querySelector('.scene-host')?.textContent).toContain('La probabilità');
});

test.each(
  discreteMathCases
)('renders $name as spoken caption words with authored KaTeX on the card', fixture => {
  const sources = [{ type: 'markdown' as const, markdown: fixture.markdown }];
  const raw = segmentLessonPlayback(sources)[0];
  const block = { ...raw, prepared: { motion: [], spokenMath: fixture.spokenMath } };
  const { container } = render(
    <LessonPlaybackStage
      block={block}
      content={{ isDarkMode: false, sectionContentBlocks: sources } as WorkspaceReaderContentModel}
      duration={30}
      time={30}
    />
  );
  expect(
    Array.from(container.querySelectorAll('.caption-word'), word => word.textContent?.trim())
  ).toEqual(resolvePlaybackNarration(block).speech.trim().split(/\s+/u));
  expect(container.querySelectorAll('.scene-host .katex')).toHaveLength(fixture.spokenMath.length);
  expect(container.querySelector('.caption-page .katex')).toBeNull();
  expect(container.querySelector('.katex-error')).toBeNull();
});
