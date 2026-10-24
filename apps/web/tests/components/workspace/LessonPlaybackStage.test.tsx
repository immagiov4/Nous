// @vitest-environment jsdom
import { resolvePlaybackNarration, segmentLessonPlayback } from '@shared/lessonPlayback';
import type { LessonScene } from '@shared/lessonScene';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { useLayoutEffect } from 'react';
import { beforeEach, expect, test, vi } from 'vitest';
import { guidedPathScene } from '../../../../backend/tests/helpers/animatedLessonScenes';
import { discreteMathCases } from '../../../../backend/tests/helpers/discreteMath';
import { dictatedFormulaSpotlight } from '../../../../backend/tests/helpers/formulaSpotlight';
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
  adoptCueTimes,
  captionAnchorSpan,
  captionAnchorTimes,
  captionMotionEvents,
  motionStates,
  sceneElements,
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

test.each([
  'missing',
  'broken',
  'historical',
  'authored',
])('uses passage content for %s image preparation', imageState => {
  const sources = [
    {
      type: 'markdown' as const,
      markdown:
        'La memoria conserva i dati del programma. Il processore legge le istruzioni.\n\n{{PDF_IMAGE:figure-1|alt=Figura di esempio|caption=Un esempio visivo}}',
    },
  ];
  const scene: LessonScene = {
    type: 'definition',
    title: 'Scena del passaggio',
    body: '',
    quote: '',
    note: '',
    groups: [],
    items: [{ label: 'Il concetto', detail: 'Una spiegazione visiva.', icon: '' }],
  };
  const block = {
    ...segmentLessonPlayback(sources)[0],
    visuals: [
      {
        kind: 'markdown' as const,
        markdown: sources[0].markdown.slice(sources[0].markdown.indexOf('{{')),
      },
      ...(imageState === 'authored' ? [{ kind: 'scene' as const, scene }] : []),
    ],
    prepared: { ...(['historical', 'authored'].includes(imageState) ? {} : { scene }), motion: [] },
  };
  const content = {
    isDarkMode: false,
    sectionContentBlocks: sources,
    activeSectionAssetsById:
      imageState === 'broken'
        ? {
            'figure-1': {
              id: 'figure-1',
              dataUrl: 'data:image/png;base64,broken',
              sourceOrder: 0,
              textBefore: '',
              textAfter: '',
            },
          }
        : {},
  } as WorkspaceReaderContentModel;
  const { container } = render(
    <LessonPlaybackStage block={block} content={content} duration={10} time={4} />
  );
  if (imageState === 'broken')
    fireEvent.error(screen.getByRole('img', { name: 'Figura di esempio' }));
  if (imageState === 'historical') {
    expect(
      container.querySelector('.scene-host blockquote')?.textContent?.replace(/^“\s*/u, '').trim()
    ).toBe('La memoria conserva i dati del programma.');
  } else {
    expect(container.querySelector('.scene-host h2')?.textContent).toBe('Scena del passaggio');
    expect(container.querySelector('.scene-host strong')?.textContent).toBe('Il concetto');
  }
  expect(container.querySelector('.scene-host')?.textContent).not.toContain('PDF_IMAGE');
  expect(container.querySelector('.scene-host')?.textContent).not.toContain('Figura di esempio');
  expect(container.querySelector('.scene-host')?.textContent).not.toContain('Un esempio visivo');
});
test('removes one failed adjacent PDF image and retains the available image', () => {
  const sources = [
    {
      type: 'markdown' as const,
      markdown: 'Un passaggio.\n\n{{PDF_IMAGE:good|alt=Good}}{{PDF_IMAGE:bad|alt=Bad}}',
    },
  ];
  const block = segmentLessonPlayback(sources)[0];
  const content = {
    isDarkMode: false,
    sectionContentBlocks: sources,
    activeSectionAssetsById: Object.fromEntries(
      ['good', 'bad'].map(id => [
        id,
        {
          id,
          dataUrl: `data:image/png;base64,${id}`,
          sourceOrder: 0,
          textBefore: '',
          textAfter: '',
        },
      ])
    ),
  } as WorkspaceReaderContentModel;
  const { container } = render(
    <LessonPlaybackStage block={block} content={content} duration={10} time={4} />
  );
  expect(screen.getAllByRole('img').map(image => image.getAttribute('alt'))).toEqual([
    'Good',
    'Bad',
  ]);
  fireEvent.error(screen.getByRole('img', { name: 'Bad' }));
  expect(screen.getAllByRole('img').map(image => image.getAttribute('alt'))).toEqual(['Good']);
  expect(container.querySelector('.scene-host')?.textContent).not.toContain(
    'Immagine non disponibile'
  );
});
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

test('saves the source at the live voice clock rather than the last caption render', async () => {
  const sources = [
    { type: 'markdown' as const, markdown: 'First sentence. Later passage contains this visual.' },
  ];
  const onSavePlaybackVisual = vi.fn<
    NonNullable<WorkspaceReaderContentModel['onSavePlaybackVisual']>
  >(async () => ({ succeeded: true }));
  const { container } = render(
    <LessonPlaybackStage
      lessonKey="lesson-version"
      block={segmentLessonPlayback(sources)[0]}
      duration={10}
      time={0}
      readTime={() => 8}
      content={
        {
          projectId: 'course',
          activeSectionId: 'lesson',
          sectionContentBlocks: sources,
          onSavePlaybackVisual,
          onRemovePlaybackVisual: vi.fn(),
        } as unknown as WorkspaceReaderContentModel
      }
    />
  );
  fireEvent.mouseEnter(container.querySelector('.scene-host') as HTMLElement);
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Salva' })));
  expect(onSavePlaybackVisual.mock.calls[0][3]?.exact).toBe('Later passage contains this visual.');
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

test.each([true, false])('reveals continuously and fades spoken words (animate=%s)', animate => {
  vi.mocked(useShouldAnimate).mockReturnValue(animate);
  const source = [
    {
      type: 'markdown' as const,
      markdown: 'Uno due tre quattro cinque sei. ![Figura](https://example.test/figure.png)',
    },
  ];
  const block = segmentLessonPlayback(source)[0];
  const content = {
    isDarkMode: false,
    sectionContentBlocks: source,
  } as WorkspaceReaderContentModel;
  const frames = new Map<number, FrameRequestCallback>();
  let frameId = 0;
  vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation(callback => {
    frames.set(++frameId, callback);
    return frameId;
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
  const advance = (time: number) => {
    rerender(<LessonPlaybackStage {...props} time={time} />);
    act(() => {
      const callbacks = [...frames.values()];
      frames.clear();
      callbacks.forEach(callback => {
        callback(0);
      });
    });
  };
  advance(0.1);
  const first = paragraph.querySelector<HTMLElement>('.caption-word');
  expect(first?.style.opacity).toBe('1');
  expect(parseFloat(first?.style.getPropertyValue('--reveal-edge') ?? '')).toBeGreaterThan(0);
  expect(parseFloat(first?.style.getPropertyValue('--reveal-edge') ?? '')).toBeLessThan(100);
  advance(1);
  advance(2);
  advance(4);
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
  expect(captionFormat('#  ')).toEqual({
    headings: [' '],
    headingWords: 0,
    words: [],
  });
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

test('recomputes reveal fades, focus delay, holds and backward seeks from time', () => {
  const reveal = [
    { effect: 'reveal' as const, targets: ['item:0'], quote: 'Prima', atMs: 1000, durationMs: 700 },
  ];
  expect(motionStates(['item:0', 'item:1'], reveal, 650, false, 0).get('item:0')?.opacity).toBe(
    0.5
  );
  expect(motionStates(['item:0'], reveal, 1000, true, 0).get('item:0')?.opacity).toBe(1);
  expect(motionStates(['item:0'], reveal, 50, false, 0).get('item:0')?.opacity).toBe(0);
  const focus = [
    { effect: 'focus' as const, targets: ['item:0'], quote: 'Prima', atMs: 0, durationMs: 10000 },
  ];
  expect(motionStates(['item:0', 'item:1'], focus, 800, false, 1300).get('item:0')?.emphasis).toBe(
    0
  );
  const focused = motionStates(['item:0', 'item:1'], focus, 1600, false, 1300);
  expect(focused.get('item:0')?.emphasis).toBeGreaterThan(0);
  expect(focused.get('item:1')).toEqual({ opacity: 1, emphasis: 0 });
  expect(motionStates(['item:0'], focus, 5400, false, 1300).get('item:0')?.emphasis).toBe(0);
});

test.each([
  ['reveal', 700],
  ['focus', 420],
] as const)('%s keeps its full enter fade before the word start', (effect, riseMs) => {
  const alignedWordStartMs = 2300;
  const events = [
    {
      effect,
      targets: ['item:0'],
      quote: 'Segnale',
      atMs: alignedWordStartMs,
      durationMs: effect === 'reveal' ? 700 : 1600,
    },
  ];
  const visible = (time: number) => {
    const state = motionStates(['item:0'], events, time, false, 0).get('item:0');
    if (!state) throw new Error('Cue target must exist');
    return effect === 'reveal' ? state.opacity : state.emphasis;
  };
  expect(visible(alignedWordStartMs - riseMs)).toBe(0);
  expect(visible(alignedWordStartMs - riseMs / 2)).toBeCloseTo(0.5);
  expect(visible(alignedWordStartMs)).toBe(1);
  expect(visible(alignedWordStartMs - riseMs - 1)).toBe(0);
  if (effect === 'focus') {
    expect(visible(alignedWordStartMs + 1390)).toBeCloseTo(0.5);
    expect(visible(alignedWordStartMs + 1600)).toBe(0);
  } else expect(visible(alignedWordStartMs + 1600)).toBe(1);
  const reduced = motionStates(['item:0'], events, alignedWordStartMs - 1, true, 0).get('item:0');
  expect(effect === 'reveal' ? reduced?.opacity : reduced?.emphasis).toBe(0);
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
  expect(
    Array.from(container.querySelectorAll('.captions h2'), heading => heading.textContent)
  ).toEqual(['Tema', 'Dettaglio']);
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
])('preserves literal block markers in captions without duplicating their prose: $source', ({
  source,
  literal,
}) => {
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
    expect(container.querySelector('.caption-page')?.textContent).toContain(literal);
    expect(card?.textContent).not.toContain('literal');
    expect(card?.querySelector('ul, ol, blockquote, h1, h2, h3, h4, h5, h6')).toBeNull();
    expect(card?.querySelector('.katex')).not.toBeNull();
    expect(card?.querySelector('mark')).toBeNull();
  }
});
test.each([
  { source: '- <mark>literal $x$</mark>', selector: 'li' },
  { source: '# <mark>literal $x$</mark>', selector: 'h1' },
  { source: '> <mark>literal $x$</mark>', selector: 'blockquote' },
])('retains annotated prose in captions and only mathematics on the visual: $source', ({
  source,
  selector,
}) => {
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
  expect(container.querySelector('.captions')?.textContent).toContain('literal');
  expect(card?.querySelector(selector)).toBeNull();
  expect(card?.querySelector('.katex')).not.toBeNull();
});

import {
  FORMULA_SPOTLIGHT_MARKDOWN,
  formulaSpotlight,
} from '../../../../backend/tests/helpers/formulaSpotlight';
import { sceneCaptionAnchors } from '../../../components/workspace/playback/stageMotion.ts';

test.each([false, true])('shows one formula at spotlight size (inherited: %s)', inherited => {
  const sources = [
    {
      type: 'markdown' as const,
      markdown: '# Function\n\nThe result is $h=wx+b$.\n\nIts bias shifts the result.',
    },
  ];
  const blocks = segmentLessonPlayback(sources);
  const { container } = render(
    <LessonPlaybackStage
      block={{ ...blocks[inherited ? 1 : 0], prepared: { motion: [] } }}
      content={{ isDarkMode: false, sectionContentBlocks: sources } as WorkspaceReaderContentModel}
      duration={6}
      time={0}
    />
  );
  expect(container.querySelectorAll('.scene-host .katex')).toHaveLength(1);
  expect(container.querySelector('.lesson-player-formula .katex-display')).not.toBeNull();
  expect(container.querySelector('.scene-host')?.textContent).not.toContain('The result is');
});

test('keeps three formulas and their explanations in the prepared list', () => {
  const sources = [{ type: 'markdown' as const, markdown: 'Compare $a$, $b$ and $c$.' }];
  const scene: LessonScene = {
    type: 'parts',
    title: 'Three quantities',
    body: '',
    note: '',
    quote: '',
    groups: [],
    items: ['a', 'b', 'c'].map((symbol, index) => ({
      label: symbol,
      detail: `Explanation ${index + 1}`,
      icon: 'variable',
    })),
  };
  const { container } = render(
    <LessonPlaybackStage
      block={{ ...segmentLessonPlayback(sources)[0], prepared: { scene, motion: [] } }}
      content={{ isDarkMode: false, sectionContentBlocks: sources } as WorkspaceReaderContentModel}
      duration={6}
      time={5}
    />
  );
  expect(container.querySelector('.lesson-player-formula')).toBeNull();
  expect(container.querySelectorAll('.scene-host .katex')).toHaveLength(3);
  expect(container.querySelectorAll('.scene-host .type-parts .concept')).toHaveLength(3);
  for (const index of [1, 2, 3])
    expect(container.querySelector('.type-parts')?.textContent).toContain(`Explanation ${index}`);
});

test('uses recording onsets for formula selection after forward and backward seeks', () => {
  const frames = new Map<number, FrameRequestCallback>();
  let frameId = 0;
  vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation(callback => {
    frames.set(++frameId, callback);
    return frameId;
  });
  vi.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation(id => {
    frames.delete(id);
  });
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    width: 100,
  } as DOMRect);
  vi.mocked(useShouldAnimate).mockReturnValue(false);
  const sources = [
    { type: 'markdown' as const, markdown: '$x$. Ics è il valore. Ics compare ancora.' },
  ];
  const block = {
    ...segmentLessonPlayback(sources)[0],
    prepared: {
      motion: [],
      spokenMath: [{ formula: '$x$', spoken: 'ics' }],
      scene: {
        ...formulaSpotlight,
        formula: String.raw`\nousSymbol{x}`,
        symbols: [
          {
            id: 'x',
            latex: 'x',
            name: 'Variabile',
            meaning: 'Il valore',
            anchor: 'Ics è il valore.',
          },
        ],
      },
    },
  };
  const alignment = { status: 'aligned' as const, onsets: [0, 5, 5.2, 5.4, 5.6, 7, 7.2, 7.4] };
  const props = {
    block,
    content: { isDarkMode: false, sectionContentBlocks: sources } as WorkspaceReaderContentModel,
    duration: 10,
    alignment,
  };
  const { container, rerender } = render(<LessonPlaybackStage {...props} time={4} />);
  container
    .querySelector<HTMLElement>('.caption-page')
    ?.style.setProperty('--caption-feather', '0');
  act(() => window.dispatchEvent(new Event('resize')));
  for (const [time, selected] of [
    [4, false],
    [5.1, true],
    [7.1, false],
    [5.1, true],
  ] as const) {
    rerender(<LessonPlaybackStage {...props} time={time} />);
    act(() => {
      const pending = [...frames.values()];
      frames.clear();
      for (const callback of pending) callback(0);
    });
    expect(container.querySelector('.nous-formula-symbol-x')?.getAttribute('data-active')).toBe(
      String(selected)
    );
  }
  const captions = container.querySelectorAll<HTMLElement>('.caption-word');
  expect(captions[1].style.opacity).toBe('1');
  expect(captions[5].style.opacity).toBe('1');
  const later = { status: 'aligned' as const, onsets: [0, 8, 8.2, 8.4, 8.6, 9, 9.2, 9.4] };
  rerender(<LessonPlaybackStage {...props} alignment={later} time={5.1} />);
  const flush = () =>
    act(() => {
      const pending = [...frames.values()];
      frames.clear();
      for (const callback of pending) callback(0);
    });
  flush();
  act(() => window.dispatchEvent(new Event('resize')));
  flush();
  expect(container.querySelector('.nous-formula-symbol-x')?.getAttribute('data-active')).toBe(
    'true'
  );
  rerender(<LessonPlaybackStage {...props} alignment={later} time={5.1} seekRevision={1} />);
  flush();
  expect(container.querySelector('.nous-formula-symbol-x')?.getAttribute('data-active')).toBe(
    'false'
  );
});

test('a complete spotlight replaces sourced math while text fallback shows the formula without prose', () => {
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
  expect(container.querySelector('.scene-host')?.textContent).not.toContain('La probabilità');
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
  expect(container.querySelector('.scene-host')?.textContent).not.toContain('La probabilità');
  expect(container.querySelector('.scene-host .katex')).not.toBeNull();
});

test.each([
  false,
  true,
])('selects repeated formula cards on the absolute passage clock and retains them through seeks (aligned: %s)', aligned => {
  vi.mocked(useShouldAnimate).mockReturnValue(false);
  const sources = [
    {
      type: 'markdown' as const,
      markdown: `${aligned ? '# Titolo\n\n' : ''}Uno $a$ $b$ Attesa lunga pausa resta qui $a$ Fine`,
    },
  ];
  const formulas = ['$a$', '$b$', '$a$'];
  const block = {
    ...segmentLessonPlayback(sources)[0],
    visuals: formulas.map(markdown => ({ kind: 'markdown' as const, markdown })),
    prepared: {
      motion: [],
      spokenMath: formulas.map((formula, index) => ({
        formula,
        spoken: index === 1 ? 'Beta' : 'Alfa',
      })),
    },
  };
  const frames = new Map<number, FrameRequestCallback>();
  let frameId = 0;
  vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation(callback => {
    frames.set(++frameId, callback);
    return frameId;
  });
  vi.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation(id => {
    frames.delete(id);
  });
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    width: 100,
  } as DOMRect);
  const style = document.createElement('p').style;
  style.setProperty('--caption-feather', '22px');
  vi.spyOn(globalThis, 'getComputedStyle').mockReturnValue(style);
  let time = 0;
  const { container, rerender } = render(
    <LessonPlaybackStage
      block={block}
      content={{ isDarkMode: false, sectionContentBlocks: sources } as WorkspaceReaderContentModel}
      alignment={
        aligned ? { status: 'aligned', onsets: [0, 0.1, 0.5, 2, 3, 4, 5, 6, 7, 8, 9] } : undefined
      }
      duration={10}
      time={0}
      readTime={() => time}
    />
  );
  const advance = (next: number) => {
    time = next;
    const queued = [...frames.values()];
    frames.clear();
    act(() => {
      for (const callback of queued) callback(0);
    });
    return container.querySelector('.scene-host annotation')?.textContent;
  };
  expect(advance(1.99)).toBe('a');
  expect(advance(2.01)).toBe('b');
  expect(advance(7.99)).toBe('b');
  expect(advance(8.01)).toBe('a');
  expect(advance(2.01)).toBe('b');
  if (aligned) {
    rerender(
      <LessonPlaybackStage
        block={structuredClone(block)}
        content={
          {
            isDarkMode: false,
            sectionContentBlocks: structuredClone(sources),
          } as WorkspaceReaderContentModel
        }
        alignment={{ status: 'aligned', onsets: [0, 0.1, 0.5, 6, 6.1, 6.2, 6.3, 6.4, 7, 8, 9] }}
        duration={10}
        time={time}
        readTime={() => time}
      />
    );
    expect(advance(2.02)).toBe('b');
    act(() => window.dispatchEvent(new Event('resize')));
    expect(advance(2.04)).toBe('b');
  }
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

test.each([
  '',
  '    ',
  '\t',
])('renders classified fenced prose with indentation %j only in captions', indentation => {
  const body = `${indentation}An ordered pair has two components; each component is a number.`;
  const sources = [
    {
      type: 'markdown' as const,
      markdown: `Introduction.\n\n\x60\x60\x60text\n${body}\n\x60\x60\x60`,
    },
  ];
  const raw = segmentLessonPlayback(sources)[0];
  const block = {
    ...raw,
    prepared: {
      motion: [],
      spokenMath: [],
      fencedCode: [{ visualIndex: 0, kind: 'prose' as const, spoken: body }],
    },
  };
  const resolved = resolvePlaybackNarration(block);
  expect(resolvePlaybackNarration(resolved)).toEqual(resolved);
  const source = captionSource(resolved, sources);
  const formatted = captionFormat(source.markdown, source.ranges);
  expect(formatted.words.map(word => word.text).join(' ')).toBe(`Introduction. ${body.trim()}`);
  expect(formatted.words.every(word => !word.code)).toBe(true);
  const { container } = render(
    <LessonPlaybackStage
      block={block}
      content={{ isDarkMode: false, sectionContentBlocks: sources } as WorkspaceReaderContentModel}
      duration={8}
      time={4}
    />
  );
  expect(container.querySelector('.scene-host pre')).toBeNull();
  expect(container.querySelector('.scene-host blockquote')?.textContent).toContain('Introduction.');
  expect(container.querySelector('.caption-page')?.textContent).toContain(body.trim());
});

test('keeps a text-only prepared passage in captions with its literal fallback card', () => {
  const sources = [
    { type: 'markdown' as const, markdown: 'Una spiegazione senza una visualizzazione utile.' },
  ];
  const block = { ...segmentLessonPlayback(sources)[0], prepared: { motion: [] } };
  const { container } = render(
    <LessonPlaybackStage
      block={block}
      content={{ isDarkMode: false, sectionContentBlocks: sources } as WorkspaceReaderContentModel}
      duration={6}
      time={2}
    />
  );
  expect(container.querySelector('.captions')?.textContent).toContain('Una spiegazione');
  expect(container.querySelector('.scene-host blockquote')?.textContent).toContain(block.speech);
});

test('retains the complete authored formula while the next passage explains its subscript', () => {
  const sources = [
    {
      type: 'markdown' as const,
      markdown:
        '# Una funzione\n\nLa formula è questa.\n\n$$h_i=b_i+w_i x$$\n\nIl pedice i distingue le unità.\n\n# Altro tema\n\nUna nuova spiegazione.',
    },
  ];
  const blocks = segmentLessonPlayback(sources);
  const explaining = blocks.find(block => block.speech.includes('Il pedice'));
  if (!explaining) throw new Error('Explanation must be projected');
  const content = {
    isDarkMode: false,
    sectionContentBlocks: sources,
  } as WorkspaceReaderContentModel;
  const { container, rerender } = render(
    <LessonPlaybackStage
      block={{ ...explaining, prepared: { motion: [] } }}
      content={content}
      duration={6}
      time={2}
    />
  );
  expect(container.querySelector('.scene-host .katex')).not.toBeNull();
  expect(container.querySelector('.scene-host')?.textContent).not.toContain('Il pedice');
  const next = blocks.find(block => block.speech.includes('Una nuova spiegazione'));
  if (!next) throw new Error('Next heading must be projected');
  rerender(
    <LessonPlaybackStage
      block={{ ...next, prepared: { motion: [] } }}
      content={content}
      duration={6}
      time={2}
    />
  );
  expect(container.querySelector('.scene-host .katex')).toBeNull();
});

test('keeps the current visual mounted across an equivalent saved snapshot', () => {
  const sources = [{ type: 'markdown' as const, markdown: FORMULA_SPOTLIGHT_MARKDOWN }];
  const block = {
    ...segmentLessonPlayback(sources)[0],
    prepared: { scene: formulaSpotlight, motion: [] },
  };
  const content = {
    isDarkMode: false,
    sectionContentBlocks: sources,
  } as WorkspaceReaderContentModel;
  const { container, rerender } = render(
    <LessonPlaybackStage block={block} content={content} duration={10} time={4} />
  );
  const formula = container.querySelector('.formula-spotlight');
  expect(formula).not.toBeNull();
  rerender(
    <LessonPlaybackStage
      block={{
        ...block,
        prepared: {
          ...block.prepared,
          scene: Object.fromEntries(
            Object.entries(formulaSpotlight).reverse()
          ) as typeof formulaSpotlight,
        },
      }}
      content={{ ...content, sectionContentBlocks: [...sources] }}
      duration={10}
      time={4}
    />
  );
  expect(container.querySelector('.formula-spotlight')).toBe(formula);
});

test('keeps mathematics visible alongside an authored table', () => {
  const sources = [
    {
      type: 'markdown' as const,
      markdown: 'Consideriamo $x_i$.\n\n| Nome | Valore |\n| --- | --- |\n| x | 1 |',
    },
  ];
  const block = { ...segmentLessonPlayback(sources)[0], prepared: { motion: [] } };
  const { container } = render(
    <LessonPlaybackStage
      block={block}
      content={{ isDarkMode: false, sectionContentBlocks: sources } as WorkspaceReaderContentModel}
      duration={6}
      time={2}
    />
  );
  expect(container.querySelector('.scene-host table')).not.toBeNull();
  expect(container.querySelector('.scene-host .katex')).not.toBeNull();
  expect(container.querySelector('.scene-host')?.textContent).not.toContain('Consideriamo');
});

test('preserves authored media when a cached incomplete spotlight falls back to source equations', () => {
  const sources = [
    {
      type: 'markdown' as const,
      markdown: 'Consideriamo $x_i$.\n\n| Nome | Valore |\n| --- | --- |\n| x | 1 |',
    },
  ];
  const block = {
    ...segmentLessonPlayback(sources)[0],
    prepared: { scene: formulaSpotlight, motion: [] },
  };
  const { container } = render(
    <LessonPlaybackStage
      block={block}
      content={{ isDarkMode: false, sectionContentBlocks: sources } as WorkspaceReaderContentModel}
      duration={6}
      time={2}
    />
  );
  expect(container.querySelector('.scene-host table')).not.toBeNull();
  expect(container.querySelector('.scene-host .katex')).not.toBeNull();
  expect(container.querySelector('.formula-spotlight')).toBeNull();
});

test('leaves a wholly unmentioned spotlight eligible for ordinary scene visibility', () => {
  const unmentioned = {
    ...formulaSpotlight,
    symbols: formulaSpotlight.symbols.map(symbol => ({ ...symbol, anchor: '' })),
  };
  expect(sceneCaptionAnchors(unmentioned, 'Una spiegazione generale.')).toBeUndefined();
});

test('preserves an authored image beside a complete prepared spotlight', () => {
  const sources = [
    {
      type: 'markdown' as const,
      markdown: `${FORMULA_SPOTLIGHT_MARKDOWN} ![Figura](https://example.test/figure.png)`,
    },
  ];
  const scene = {
    ...formulaSpotlight,
    symbols: formulaSpotlight.symbols.map(symbol => ({ ...symbol, anchor: '' })),
  };
  const block = { ...segmentLessonPlayback(sources)[0], prepared: { scene, motion: [] } };
  const { container } = render(
    <LessonPlaybackStage
      block={block}
      content={{ isDarkMode: false, sectionContentBlocks: sources } as WorkspaceReaderContentModel}
      duration={10}
      time={2}
    />
  );
  expect(container.querySelector('.scene-host img')).not.toBeNull();
  expect(container.querySelector('.scene-host .katex')).not.toBeNull();
});

test.each([
  { time: 0.2, selected: 'x', other: 'i' },
  { time: 8.5, selected: 'i', other: 'x' },
])('keeps a mixed-media spotlight visible on its spoken clock at $time', ({
  time,
  selected,
  other,
}) => {
  const frames = new Map<number, FrameRequestCallback>();
  let id = 0;
  vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation(callback => {
    frames.set(++id, callback);
    return id;
  });
  vi.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation(frame => {
    frames.delete(frame);
  });
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    width: 100,
  } as DOMRect);
  vi.mocked(useShouldAnimate).mockReturnValue(false);
  const sources = [
    {
      type: 'markdown' as const,
      markdown:
        '$x_i$. La variabile x è il valore. Il pedice i identifica la componente finale. ![Figura](https://example.test/figure.png)',
    },
  ];
  const scene = {
    ...formulaSpotlight,
    formula: String.raw`\nousSymbol{x}_{\nousSymbol{i}}`,
    symbols: [
      { id: 'x', latex: 'x', name: 'Variabile', meaning: 'Il valore', anchor: 'ics' },
      { id: 'i', latex: 'i', name: 'Pedice', meaning: 'La componente', anchor: 'Il pedice i' },
    ],
  };
  const block = {
    ...segmentLessonPlayback(sources)[0],
    prepared: { scene, motion: [], spokenMath: [{ formula: '$x_i$', spoken: 'ics con pedice i' }] },
  };
  const { container } = render(
    <LessonPlaybackStage
      block={block}
      content={{ isDarkMode: false, sectionContentBlocks: sources } as WorkspaceReaderContentModel}
      duration={12}
      time={time}
    />
  );
  container
    .querySelector<HTMLElement>('.caption-page')
    ?.style.setProperty('--caption-feather', '0');
  act(() => window.dispatchEvent(new Event('resize')));
  for (let step = 0; step < 3; step++)
    act(() => {
      const pending = [...frames.values()];
      frames.clear();
      for (const callback of pending) callback(0);
    });
  expect(container.querySelector('.formula-spotlight')).not.toBeNull();
  expect(
    container.querySelector(`.nous-formula-symbol-${selected}`)?.getAttribute('data-active')
  ).toBe('true');
  expect(
    container.querySelector(`.nous-formula-symbol-${other}`)?.getAttribute('data-active')
  ).toBe('false');
});

test.each([
  { animate: true, effect: 'reveal' as const },
  { animate: false, effect: 'reveal' as const },
  { animate: true, effect: 'focus' as const },
  { animate: false, effect: 'focus' as const },
])('right-side $effect uses heard onsets while captions retain their lead (animate=$animate)', ({
  animate,
  effect,
}) => {
  vi.mocked(useShouldAnimate).mockReturnValue(animate);
  const frames = new Map<number, FrameRequestCallback>();
  let frameId = 0;
  vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation(callback => {
    frames.set(++frameId, callback);
    return frameId;
  });
  vi.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation(id => {
    frames.delete(id);
  });
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    width: 100,
  } as DOMRect);
  const style = document.createElement('p').style;
  style.setProperty('--caption-feather', '0');
  vi.spyOn(globalThis, 'getComputedStyle').mockReturnValue(style);
  const sources = [{ type: 'markdown' as const, markdown: 'Prima parte. Seconda parte.' }];
  const scene: LessonScene = {
    type: 'steps',
    title: 'Parti',
    body: '',
    items: [
      { label: 'Prima', detail: '', icon: 'circle' },
      { label: 'Seconda', detail: '', icon: 'circle' },
    ],
    groups: [],
    note: '',
    quote: '',
  };
  const block = {
    ...segmentLessonPlayback(sources)[0],
    prepared: {
      scene,
      motion: [
        { effect, targets: ['item:0'], quote: 'Prima parte.' },
        { effect, targets: ['item:1'], quote: 'Seconda parte.' },
      ],
    },
  };
  const props = {
    block,
    content: { isDarkMode: false, sectionContentBlocks: sources } as WorkspaceReaderContentModel,
    duration: 10,
  };
  const alignment = { status: 'aligned' as const, onsets: [0, 1, 6.2, 7] };
  let heard = 3.9;
  const readTime = () => heard;
  const { container, rerender } = render(
    <LessonPlaybackStage {...props} alignment={alignment} time={0} readTime={readTime} />
  );
  const flush = () =>
    act(() => {
      const pending = [...frames.values()];
      frames.clear();
      pending.forEach(callback => {
        callback(0);
      });
    });
  flush();
  const target = () => container.querySelector<HTMLElement>('[data-motion-id="item:1"]');
  const visualValue = () =>
    effect === 'reveal'
      ? target()?.style.opacity
      : target()?.style.getPropertyValue('--motion-emphasis');
  expect(visualValue()).toBe('0');
  const caption = container.querySelectorAll<HTMLElement>('.caption-word')[2];
  expect(caption.style.opacity).toBe('1');
  // The existing punctuation pacing and 1.3-second lead determine this revealed edge.
  expect(Number.parseFloat(caption.style.getPropertyValue('--reveal-edge'))).toBeCloseTo(
    animate ? 4.237 : 8,
    3
  );
  heard = 6.199;
  flush();
  if (animate) expect(Number(visualValue())).toBeGreaterThan(0.99);
  else expect(visualValue()).toBe('0');
  heard = 6.201;
  flush();
  expect(Number(visualValue())).toBeGreaterThan(0);
  heard = 6.3;
  flush();
  expect(Number(visualValue())).toBeGreaterThan(0);
  const paused = visualValue();
  rerender(
    <LessonPlaybackStage {...props} alignment={alignment} time={9} speed={2} readTime={readTime} />
  );
  flush();
  expect(visualValue()).toBe(paused);
  heard = 5.49;
  flush();
  expect(visualValue()).toBe('0');
  heard = 6.3;
  flush();
  expect(visualValue()).toBe(paused);
  const captionState = () =>
    Array.from(container.querySelectorAll<HTMLElement>('.caption-word'), word => [
      word.style.cssText,
      (word.firstElementChild as HTMLElement).style.cssText,
    ]);
  const withAlignment = captionState();
  rerender(<LessonPlaybackStage {...props} time={0} speed={2} readTime={readTime} />);
  flush();
  expect(captionState()).toEqual(withAlignment);
  const later = { status: 'aligned' as const, onsets: [0, 1, 8, 9] };
  const presented = visualValue();
  rerender(<LessonPlaybackStage {...props} alignment={later} time={0} readTime={readTime} />);
  flush();
  expect(visualValue()).toBe(presented);
  act(() => window.dispatchEvent(new Event('resize')));
  flush();
  expect(visualValue()).toBe(presented);
  heard = 7.29;
  rerender(
    <LessonPlaybackStage
      {...props}
      alignment={later}
      time={0}
      readTime={readTime}
      seekRevision={1}
    />
  );
  flush();
  expect(visualValue()).toBe('0');
  heard = 8.1;
  flush();
  expect(Number(visualValue())).toBeGreaterThan(0);
});

test('retains a final aligned reveal after the spoken heading share', () => {
  const events = captionMotionEvents({
    events: [{ effect: 'reveal', targets: ['item:0'], quote: 'Ultima' }],
    speech: 'Titolo Ultima',
    speechRanges: [{ start: 7, end: 13 }],
    runs: [{ span: document.createElement('span'), start: 0, width: 100 }],
    width: 100,
    feather: 0,
    duration: 8,
    startOffset: 2,
    aligned: [
      { text: 'Titolo', start: 0, end: 6, onset: 0, endTime: 9 },
      { text: 'Ultima', start: 7, end: 13, onset: 9, endTime: 10 },
    ],
  });
  expect(events[0].atMs).toBe(9000);
  expect(events[0].durationMs).toBe(700);
  expect(motionStates(['item:0'], events, 9700, false, 0).get('item:0')?.opacity).toBe(1);
});

test('renders resolved step citations instead of the unanchored source scene', () => {
  vi.mocked(useShouldAnimate).mockReturnValue(false);
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    width: 100,
  } as DOMRect);
  const sources = [{ type: 'markdown' as const, markdown: guidedPathScene.narration ?? '' }];
  const sourceScene = {
    ...guidedPathScene,
    steps: guidedPathScene.steps.map(step => ({ ...step, anchor: undefined })),
  };
  const block = {
    ...segmentLessonPlayback(sources)[0],
    visuals: [{ kind: 'scene' as const, scene: sourceScene }],
    prepared: { scene: guidedPathScene, motion: [] },
  };
  const words = block.speech.match(/\S+/gu) ?? [];
  const { container } = render(
    <LessonPlaybackStage
      block={block}
      content={{ isDarkMode: false, sectionContentBlocks: sources } as WorkspaceReaderContentModel}
      time={0.5}
      duration={40}
      alignment={{ status: 'aligned', onsets: words.map((_, index) => index) }}
    />
  );
  expect(container.querySelector('[data-stop="0"]')?.getAttribute('aria-current')).toBe('step');
});

test('adopts an overdue acoustic cue instead of waiting for its future estimate', () => {
  expect(adoptCueTimes([8000, 2000, 9000], [3000, 1000, 7000], 5000)).toEqual([3000, 2000, 7000]);
});

test('heading quotations stay within the spoken heading interval before alignment', () => {
  const input = {
    speech: 'Primo titolo Corpo finale',
    speechRanges: [
      { start: 13, end: 18 },
      { start: 19, end: 25 },
    ],
    runs: [0, 1].map(index => ({
      span: document.createElement('span'),
      start: index * 100,
      width: 100,
    })),
    width: 200,
    feather: 0,
    duration: 8,
    startOffset: 2,
  };
  expect(captionAnchorTimes({ ...input, anchors: ['Primo', 'titolo', 'Corpo', 'finale'] })).toEqual(
    [0, 1000, 2000, 6000]
  );
  expect(captionAnchorSpan({ ...input, anchors: ['titolo'] })).toEqual({
    startMs: 1000,
    endMs: 2000,
  });
  expect(captionAnchorSpan({ ...input, anchors: ['titolo Corpo'] })).toEqual({
    startMs: 1000,
    endMs: 6000,
  });
  expect(
    captionMotionEvents({
      ...input,
      events: [{ quote: 'titolo', targets: ['item:0'], effect: 'focus' }],
    })[0]
  ).toMatchObject({ atMs: 1000, durationMs: 1600 });
});

test('sequence participants and message labels retain their authored motion targets', () => {
  const host = document.createElement('div');
  host.innerHTML = `<svg>
    <g id="second" data-et="participant" data-id="n1"></g>
    <g id="first" data-et="participant" data-id="n0"></g>
    <text id="label" class="messageText">Send</text>
    <line id="message" data-et="message"></line>
  </svg>`;
  const scene: LessonScene = {
    ...formulaSpotlight,
    type: 'sequence',
    diagram: {
      nodes: [
        { id: 'from', label: 'From', kind: 'step' },
        { id: 'to', label: 'To', kind: 'step' },
      ],
      edges: [{ from: 'from', to: 'to', label: 'Send', kind: 'event', evidence: 'Send' }],
    },
  };
  expect(
    Array.from(sceneElements(host, scene), ([id, targets]) => [
      id,
      targets.map(target => target.id),
    ])
  ).toEqual([
    ['node:from', ['first']],
    ['node:to', ['second']],
    ['edge:0', ['message', 'label']],
  ]);
});

test.each([
  false,
  true,
])('a pending scene observer retains its passage ranges during the next commit (longer=%s)', longer => {
  const frames = new Map<number, FrameRequestCallback>();
  let frameId = 0;
  vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation(callback => {
    frames.set(++frameId, callback);
    return frameId;
  });
  vi.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation(id => {
    frames.delete(id);
  });
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    width: 100,
  } as DOMRect);
  const style = document.createElement('p').style;
  style.setProperty('--caption-feather', '22px');
  vi.spyOn(globalThis, 'getComputedStyle').mockReturnValue(style);
  const observers: { callback: MutationCallback; active: boolean }[] = [];
  vi.stubGlobal(
    'MutationObserver',
    class {
      readonly observation: (typeof observers)[number];
      constructor(callback: MutationCallback) {
        this.observation = { callback, active: true };
        observers.push(this.observation);
      }
      observe() {}
      disconnect() {
        this.observation.active = false;
      }
    }
  );
  vi.mocked(useShouldAnimate).mockReturnValue(false);
  const scene: LessonScene = {
    type: 'steps',
    title: 'Visual',
    body: '',
    items: [{ label: 'Current', detail: '', icon: 'circle' }],
    groups: [],
    note: '',
    quote: '',
  };
  const longSources = [
    {
      type: 'markdown' as const,
      markdown: 'A long narration with several extra words before last.',
    },
  ];
  const shortSources = [{ type: 'markdown' as const, markdown: 'Now.' }];
  const firstSources = longer ? shortSources : longSources;
  const nextSources = longer ? longSources : shortSources;
  const firstQuote = longer ? 'Now.' : 'last.';
  const nextQuote = longer ? 'last.' : 'Now.';
  const block = (sources: typeof firstSources, id: string, quote: string) => ({
    ...segmentLessonPlayback(sources)[0],
    id,
    prepared: { scene, motion: [{ effect: 'focus' as const, targets: ['item:0'], quote }] },
  });
  function CommitObserver({ changed }: { changed: boolean }) {
    useLayoutEffect(() => {
      if (changed) {
        for (const observer of [...observers]) {
          if (observer.active) observer.callback([], {} as MutationObserver);
        }
        const pending = [...frames.values()];
        frames.clear();
        for (const callback of pending) callback(0);
      }
    }, [changed]);
    return null;
  }
  const view = (changed: boolean) => (
    <>
      <LessonPlaybackStage
        block={changed ? block(nextSources, '1', nextQuote) : block(firstSources, '0', firstQuote)}
        content={
          {
            isDarkMode: false,
            sectionContentBlocks: changed ? nextSources : firstSources,
          } as WorkspaceReaderContentModel
        }
        duration={4}
        time={0.5}
      />
      <CommitObserver changed={changed} />
    </>
  );
  const mounted = render(view(false));
  try {
    mounted.rerender(view(true));
    expect(mounted.container.querySelector('.captions')?.textContent).toBe(
      `${nextSources[0].markdown} `
    );
    expect(
      mounted.container
        .querySelector<HTMLElement>('[data-motion-id="item:0"]')
        ?.style.getPropertyValue('--motion-emphasis')
    ).toBe(longer ? '0' : '1');
  } finally {
    mounted.unmount();
    vi.unstubAllGlobals();
  }
});

test.each([
  'code',
  'scene',
] as const)('keeps the current %s and reading position when a prepared project snapshot arrives', presentation => {
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
  const first = {
    ...blocks[0],
    visuals:
      presentation === 'code'
        ? [{ kind: 'markdown' as const, markdown: '```ts\nconst sample = 1;\n```' }]
        : blocks[0].visuals,
    prepared: { motion: [], ...(presentation === 'scene' ? { scene } : {}) },
  };
  const content = {
    isDarkMode: false,
    sectionContentBlocks: sources,
  } as WorkspaceReaderContentModel;
  const { container, rerender } = render(
    <LessonPlaybackStage block={first} content={content} duration={6} time={5.8} />
  );
  const caption = container.querySelector<HTMLElement>('.caption-page');
  const visual = container.querySelector('.scene-host')?.firstElementChild;
  if (!caption || !visual) throw new Error('Prepared passage must be visible');
  caption.scrollTop = 200;
  rerender(
    <LessonPlaybackStage
      block={structuredClone(first)}
      content={{ ...content, sectionContentBlocks: structuredClone(sources) }}
      duration={6}
      time={5.8}
      alignment={{ status: 'aligned', onsets: [0.1, 0.8] }}
    />
  );
  expect(container.querySelector('.caption-page')).toBe(caption);
  expect(caption.scrollTop).toBe(200);
  expect(container.querySelector('.scene-host')?.firstElementChild).toBe(visual);
  expect(visual.isConnected).toBe(true);
  rerender(
    <LessonPlaybackStage
      block={structuredClone(first)}
      content={content}
      duration={6}
      time={5.8}
      alignment={{ status: 'aligned', onsets: [0.1, 0.8] }}
    />
  );
  expect(caption.scrollTop).toBe(200);
  expect(container.querySelector('.scene-host')?.firstElementChild).toBe(visual);

  rerender(
    <LessonPlaybackStage
      block={{ ...blocks[1], prepared: first.prepared }}
      content={content}
      duration={6}
      time={0}
    />
  );
  const nextCaption = container.querySelector('.caption-page');
  expect(nextCaption).not.toBe(caption);
  expect(nextCaption?.scrollTop).toBe(0);
  expect(container.querySelector('.scene-host')?.firstElementChild).not.toBe(visual);
  expect(visual.isConnected).toBe(false);
});

test.each([
  'unprepared',
  'legacy',
  'missing-reference',
])('shows a passage-derived visual for %s content throughout playback', state => {
  vi.mocked(useShouldAnimate).mockReturnValue(false);
  const sources = [{ type: 'markdown' as const, markdown: 'A boundary separates two regions.' }];
  const raw = segmentLessonPlayback(sources)[0];
  const block = {
    ...raw,
    ...(state !== 'unprepared' ? { prepared: { motion: [] } } : {}),
    visuals:
      state === 'missing-reference'
        ? [{ kind: 'generated-visual' as const, visualId: 'missing' }]
        : [],
  };
  const content = {
    isDarkMode: false,
    sectionContentBlocks: sources,
  } as WorkspaceReaderContentModel;
  const { container, rerender } = render(
    <LessonPlaybackStage block={block} content={content} duration={8} time={0} />
  );
  const visual = container.querySelector('.scene-host');
  expect(visual?.querySelector('blockquote')?.textContent).toContain(raw.speech);
  for (const time of [4, 8, 8.1]) {
    rerender(<LessonPlaybackStage block={block} content={content} duration={8} time={time} />);
    expect(visual?.querySelector('blockquote')?.textContent).toContain(raw.speech);
  }
});

test('renders LaTeX notation authored as inline code in captions while retaining ordinary code', () => {
  const notation = String.raw`\mathbf\Omega\mathbf x`;
  const literal = String.raw`\notACommand`;
  const sources = [
    {
      type: 'markdown' as const,
      markdown: `The product \`${notation}\` uses \`open()\` and \`${literal}\`.`,
    },
  ];
  const { container } = render(
    <LessonPlaybackStage
      block={segmentLessonPlayback(sources)[0]}
      content={{ isDarkMode: false, sectionContentBlocks: sources } as WorkspaceReaderContentModel}
      duration={6}
      time={3}
    />
  );
  expect(container.querySelector('.captions .katex-html')?.textContent).toContain('Ω');
  expect(
    Array.from(container.querySelectorAll('.captions code'), code => code.textContent)
  ).toEqual(['open()', literal]);
  const word = captionFormat(sources[0].markdown).words.find(word => word.text === notation);
  expect(word).toBeDefined();
  expect(sources[0].markdown.slice(word?.source.start, word?.source.end)).toBe(notation);
});

test.each([
  true,
  false,
])('keeps normal captions and occurrence-local formula highlights on the heard clock (aligned: %s)', aligned => {
  vi.mocked(useShouldAnimate).mockReturnValue(false);
  const frames = new Map<number, FrameRequestCallback>();
  let frameId = 0;
  vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation(callback => {
    frames.set(++frameId, callback);
    return frameId;
  });
  vi.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation(id => frames.delete(id));
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    width: 100,
  } as DOMRect);
  const style = document.createElement('p').style;
  style.setProperty('--caption-feather', '22px');
  vi.spyOn(globalThis, 'getComputedStyle').mockReturnValue(style);
  const sources = [{ type: 'markdown' as const, markdown: 'Prima $x+y$ poi $x+y$ fine' }];
  const block = {
    ...segmentLessonPlayback(sources)[0],
    prepared: {
      motion: [],
      spokenMath: Array.from({ length: 2 }, () => ({
        formula: '$x+y$',
        spoken: 'ics più ipsilon',
      })),
      formulaSpotlights: Array.from({ length: 2 }, () => ({
        formula: '$x+y$',
        scene: dictatedFormulaSpotlight,
      })),
    },
  };
  let time = 0;
  const props = {
    block,
    content: { isDarkMode: false, sectionContentBlocks: sources } as WorkspaceReaderContentModel,
    duration: 18,
    time: 0,
    readTime: () => time,
    alignment: aligned
      ? { status: 'aligned' as const, onsets: [0, 2, 4, 6, 8, 10, 12, 14, 16] }
      : undefined,
  };
  const { container, rerender } = render(<LessonPlaybackStage {...props} />);
  const flush = () =>
    act(() => {
      const pending = [...frames.values()];
      frames.clear();
      for (const callback of pending) callback(0);
    });
  for (const [next, selected] of [
    [1, null],
    [2.1, 'x'],
    [4.1, 'plus'],
    [6.1, 'y'],
    [10.1, 'x'],
    [12.1, 'plus'],
    [14.1, 'y'],
    [17, null],
    [2.1, 'x'],
  ] as const) {
    time = next;
    flush();
    flush();
    expect(container.querySelector('.caption-page')?.textContent?.trim()).toBe(
      'Prima ics più ipsilon poi ics più ipsilon fine'
    );
    expect(container.querySelector('.listening-stage')).not.toHaveAttribute('aria-hidden', 'true');
    expect(container.querySelector('.scene-host .formula-spotlight')).not.toBeNull();
    const active = container.querySelector('.spotlight-symbols [data-active="true"]');
    expect(active?.getAttribute('data-formula-symbol') ?? null).toBe(selected);
  }
  rerender(<LessonPlaybackStage {...props} duration={0} />);
  time = 0;
  flush();
  rerender(<LessonPlaybackStage {...props} speed={2} />);
  time = 12.1;
  flush();
  flush();
  expect(
    container
      .querySelector('.spotlight-symbols [data-active="true"]')
      ?.getAttribute('data-formula-symbol')
  ).toBe('plus');
});

test.each([
  true,
  false,
])('keeps normal captions for a dictated heading formula without body geometry (aligned: %s)', aligned => {
  const frames = new Map<number, FrameRequestCallback>();
  let frameId = 0;
  vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation(callback => {
    frames.set(++frameId, callback);
    return frameId;
  });
  vi.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation(id => frames.delete(id));
  const sources = [{ type: 'markdown' as const, markdown: '# Calcolo $x+y$' }];
  const block = {
    ...segmentLessonPlayback(sources)[0],
    prepared: {
      motion: [],
      spokenMath: [{ formula: '$x+y$', spoken: 'ics più ipsilon' }],
      formulaSpotlights: [{ formula: '$x+y$', scene: dictatedFormulaSpotlight }],
    },
  };
  const { container } = render(
    <LessonPlaybackStage
      block={block}
      content={{ isDarkMode: false, sectionContentBlocks: sources } as WorkspaceReaderContentModel}
      duration={8}
      time={4.1}
      alignment={aligned ? { status: 'aligned', onsets: [0, 2, 4, 6] } : undefined}
    />
  );
  act(() => {
    const pending = [...frames.values()];
    frames.clear();
    for (const callback of pending) callback(0);
  });
  expect(container.querySelector('h2')?.textContent).toBe('Calcolo ics più ipsilon');
  expect(
    container
      .querySelector('.spotlight-symbols [data-active="true"]')
      ?.getAttribute('data-formula-symbol')
  ).toBe('plus');
});

test('uses saved links for an inherited unlinked spotlight without substituting earlier equations', () => {
  const frames = new Map<number, FrameRequestCallback>();
  let frameId = 0;
  vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation(callback => {
    frames.set(++frameId, callback);
    return frameId;
  });
  vi.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation(id => frames.delete(id));
  const sources = [
    {
      type: 'markdown' as const,
      markdown: '# Tema\n\nIntroduzione alla formula.\n\n$$a=b$$\n\nics più ipsilon',
    },
  ];
  const raw = segmentLessonPlayback(sources).at(-1);
  if (!raw) throw new Error('The final passage must exist');
  const original = {
    ...dictatedFormulaSpotlight,
    symbols: dictatedFormulaSpotlight.symbols.map(symbol => ({ ...symbol, anchor: '' })),
  };
  const block = {
    ...raw,
    prepared: {
      motion: [],
      scene: original,
      formulaSpotlights: [
        { formula: '$$x+y$$', sourceFormula: original.formula, scene: dictatedFormulaSpotlight },
      ],
    },
  };
  const { container } = render(
    <LessonPlaybackStage
      block={block}
      content={{ isDarkMode: false, sectionContentBlocks: sources } as WorkspaceReaderContentModel}
      duration={3}
      time={1.5}
      alignment={{ status: 'aligned', onsets: [0, 1, 2] }}
    />
  );
  act(() => {
    const pending = [...frames.values()];
    frames.clear();
    for (const callback of pending) callback(0);
  });
  expect(
    container
      .querySelector('.spotlight-symbols [data-active="true"]')
      ?.getAttribute('data-formula-symbol')
  ).toBe('plus');
  expect(container.querySelector('.caption-page')?.textContent?.trim()).toBe('ics più ipsilon');
  expect(
    container.querySelectorAll('.scene-host .katex:not(.spotlight-symbol .katex)')
  ).toHaveLength(1);
});

test('returns to earlier recall equations when their symbols are named again and restores normal visuals', () => {
  const frames = new Map<number, FrameRequestCallback>();
  let frameId = 0;
  vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation(callback => {
    frames.set(++frameId, callback);
    return frameId;
  });
  vi.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation(id => frames.delete(id));
  const sources = [
    {
      type: 'markdown' as const,
      markdown:
        '# Tema\n\nIntroduzione alla formula.\n\n$$x+y$$\n\n$$\\alpha+\\beta$$\n\nPrima ics poi alfa ancora ipsilon poi beta fine',
    },
  ];
  const first = {
    ...dictatedFormulaSpotlight,
    symbols: dictatedFormulaSpotlight.symbols.map(symbol => ({
      ...symbol,
      anchor: symbol.id === 'plus' ? '' : symbol.anchor,
    })),
  };
  const second = {
    ...first,
    formula: first.formula,
    symbols: first.symbols.map(symbol => ({
      ...symbol,
      latex:
        symbol.id === 'x'
          ? String.raw`\alpha`
          : symbol.id === 'y'
            ? String.raw`\beta`
            : symbol.latex,
      anchor: symbol.id === 'x' ? 'alfa' : symbol.id === 'y' ? 'beta' : '',
    })),
  };
  const raw = segmentLessonPlayback(sources).at(-1);
  if (!raw) throw new Error('The reference passage must exist');
  const normal = {
    quote: '',
    note: '',
    items: [],
    groups: [],
    type: 'definition' as const,
    title: 'Spiegazione',
    body: 'Il contesto resta disponibile.',
  };
  const block = {
    ...raw,
    prepared: {
      motion: [],
      scene: normal,
      formulaSpotlights: [
        { formula: '$$x+y$$', sourceFormula: '$$x+y$$', scene: first },
        {
          formula: String.raw`$$\alpha+\beta$$`,
          sourceFormula: String.raw`$$\alpha+\beta$$`,
          scene: second,
        },
      ],
    },
  };
  let time = 0;
  const { container } = render(
    <LessonPlaybackStage
      block={block}
      content={{ isDarkMode: false, sectionContentBlocks: sources } as WorkspaceReaderContentModel}
      duration={10}
      time={0}
      readTime={() => time}
      alignment={{ status: 'aligned', onsets: [0, 1, 2, 3, 4, 5, 6, 7, 8] }}
    />
  );
  const flush = () =>
    act(() => {
      const pending = [...frames.values()];
      frames.clear();
      for (const callback of pending) callback(0);
    });
  for (const [next, expected] of [
    [0.5, null],
    [1.5, 'x'],
    [3.5, String.raw`\alpha`],
    [5.5, 'x'],
    [7.5, String.raw`\alpha`],
    [9.5, null],
  ] as const) {
    time = next;
    flush();
    flush();
    const annotation = container.querySelector('.spotlight-formula annotation')?.textContent;
    if (expected) {
      expect(annotation).toContain(`{${expected}}`);
      expect(container.querySelector('.spotlight-symbols [data-active="true"]')).not.toBeNull();
    } else {
      expect(container.querySelector('.formula-spotlight')).toBeNull();
      expect(container.querySelector('.scene-host')?.textContent).toContain('Spiegazione');
    }
  }
});

test('selects a saved formula widget on its explicit spoken occurrence after reuse', () => {
  const frames = new Map<number, FrameRequestCallback>();
  let frameId = 0;
  vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation(callback => {
    frames.set(++frameId, callback);
    return frameId;
  });
  vi.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation(id => frames.delete(id));
  const scene = {
    ...dictatedFormulaSpotlight,
    formula: String.raw`\nousSymbol{x}`,
    symbols: [
      { id: 'x', latex: 'x', name: 'Ics', meaning: 'Valore', anchor: 'ics', anchorOccurrence: 1 },
    ],
  };
  const normal = {
    type: 'definition' as const,
    title: 'Contesto',
    body: '',
    quote: '',
    note: '',
    groups: [],
    items: [{ label: 'Prima', detail: 'Il contesto della spiegazione.', icon: '' }],
  };
  const sources = [{ type: 'markdown' as const, markdown: 'prima ics poi ics fine' }];
  const block = {
    ...segmentLessonPlayback(sources)[0],
    visuals: [
      { kind: 'scene' as const, scene: normal },
      { kind: 'scene' as const, scene },
    ],
    prepared: { motion: [] },
  };
  let time = 1.5;
  const { container } = render(
    <LessonPlaybackStage
      block={block}
      content={{ isDarkMode: false, sectionContentBlocks: sources } as WorkspaceReaderContentModel}
      duration={5}
      time={0}
      readTime={() => time}
      alignment={{ status: 'aligned', onsets: [0, 1, 2, 3, 4] }}
    />
  );
  const flush = () =>
    act(() => {
      const pending = [...frames.values()];
      frames.clear();
      for (const callback of pending) callback(0);
    });
  flush();
  flush();
  expect(container.querySelector('.formula-spotlight')).toBeNull();
  expect(container.querySelector('.scene-host')?.textContent).toContain('Contesto');
  time = 3.5;
  flush();
  flush();
  expect(
    container
      .querySelector('.spotlight-symbols [data-active="true"]')
      ?.getAttribute('data-formula-symbol')
  ).toBe('x');
});
