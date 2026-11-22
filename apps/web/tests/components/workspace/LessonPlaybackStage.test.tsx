// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import {
  type LessonPlaybackBlock,
  resolvePlaybackNarration,
  segmentLessonPlayback,
} from '@shared/lessonPlayback';
import type { AlgorithmLessonScene, GeometryLessonScene, LessonScene } from '@shared/lessonScene';
import { textAt } from '@shared/lessonStudios/chart';
import { createHoldPainter } from '@shared/lessonStudios/studioBeatSync';
import { VectorNode } from '@shared/lessonStudios/vectorScene';
import type { PlaybackQuestionContext } from '@shared/playbackQuestionContext';
import { playbackVisualSections } from '@shared/playbackVisualSections';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createRef, useLayoutEffect } from 'react';
import { beforeEach, expect, test, vi } from 'vitest';
import {
  guidedPathScene,
  proportionalScene,
} from '../../../../backend/tests/helpers/animatedLessonScenes';
import { discreteMathCases } from '../../../../backend/tests/helpers/discreteMath';
import { AnimatedScene } from '../../../components/shared/lessonScene/AnimatedScene.tsx';
import { mountStudio } from '../../../components/shared/lessonScene/studios/paintStudio.ts';
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
  captionAnchorSpan,
  captionAnchorTimes,
  captionMotionEvents,
  motionStates,
  revealProcessSteps,
  sceneElements,
  studioCaptionRanges,
  visualWindowAtTime,
} from '../../../components/workspace/playback/stageMotion.ts';
import type { WorkspaceReaderContentModel } from '../../../components/workspace/shell/types.ts';
import { prepareLessonPlaybackVisual } from '../../../services/openrouter/lessonPlaybackVisualClient.ts';
import { resolveProjectVisual } from '../../../services/projects/projectVisualResolver.ts';
import { useShouldAnimate } from '../../../utils/motion/useShouldAnimate.ts';
import { controllerScene } from '../../helpers/playbackQuestion.ts';

vi.mock('../../../utils/motion/useShouldAnimate.ts', () => ({ useShouldAnimate: vi.fn() }));
vi.mock('../../../services/openrouter/lessonPlaybackVisualClient.ts', () => ({
  prepareLessonPlaybackVisual: vi.fn(),
}));
vi.mock('../../../services/projects/projectVisualResolver.ts', () => ({
  resolveProjectVisual: vi.fn(),
}));

let resizeScene: () => void;
let resizeProcessViewport: (() => void) | undefined;
const disconnectScene = vi.fn();
const disconnectProcessViewport = vi.fn();

test.each([
  true,
  false,
])('keeps paragraph fill through both theme directions (animate=%s)', animate => {
  vi.mocked(useShouldAnimate).mockReturnValue(animate);
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
  const sources = [{ type: 'markdown' as const, markdown: 'Uno due tre quattro' }];
  const block = segmentLessonPlayback(sources)[0];
  let heard = 3;
  const view = (isDarkMode: boolean) => (
    <LessonPlaybackStage
      block={block}
      content={{ sectionContentBlocks: sources, isDarkMode } as WorkspaceReaderContentModel}
      duration={8}
      time={0}
      readTime={() => heard}
      alignment={{ status: 'aligned', onsets: [0, 2, 4, 6] }}
    />
  );
  const mounted = render(view(false));
  const tick = () =>
    act(() => {
      const pending = [...frames.values()];
      frames.clear();
      pending.forEach(callback => {
        callback(0);
      });
    });
  const opacities = () =>
    Array.from(mounted.container.querySelectorAll<HTMLElement>('.caption-word'), word =>
      Number(word.style.opacity)
    );
  tick();
  expect(opacities()).toEqual([1, expect.closeTo(0.9), 0.5, 0.5]);
  for (const dark of [true, false]) {
    mounted.rerender(view(dark));
    tick();
    expect(opacities()).toEqual([1, expect.closeTo(0.9), 0.5, 0.5]);
  }
  heard = 4.5;
  tick();
  expect(opacities()).toEqual([1, 1, expect.closeTo(0.775), 0.5]);
  mounted.unmount();
});

function arrayStudio(
  narration: string,
  anchors: readonly string[],
  input = [4, 3]
): AlgorithmLessonScene {
  return {
    type: 'algorithm',
    title: 'Array trace',
    body: '',
    note: '',
    quote: '',
    groups: [],
    items: [],
    autoplay: true,
    narration,
    studio: {
      id: 'array-algorithm',
      spec: {
        algorithm: 'bubble',
        input,
        callouts: [{ event: 'compare#1' }, { event: 'swap#1' }].slice(0, anchors.length),
      },
    },
    studioCues: anchors.map(anchor => ({ anchor })),
  };
}

test('plays an engine cue in its appended narration even when the lesson repeats its words', () => {
  const first = 'Confrontiamo 4 e 3.';
  const second = '4 e 3 si scambiano.';
  const studio = {
    ...arrayStudio(`${first} ${second}`, [first, second]),
    studioCues: [first, second].map(anchor => ({ anchor, targets: ['0', '1'] })),
  };
  const source = `${first} Spieghiamo il metodo.`;
  const sources = [{ type: 'markdown' as const, markdown: source }];
  const [block] = segmentLessonPlayback(sources);
  const speech = `${source} ${studio.narration}`;
  const spoken = {
    ...block,
    speech,
    spans: [
      ...block.spans,
      {
        speech: { start: source.length, end: speech.length },
        source: { start: source.length, end: source.length },
        sourceBlockIndex: 0,
      },
    ],
  };
  const [range] = studioCaptionRanges(studio, spoken, block) ?? [];
  expect(range?.start).toBe(source.length + 1);
  const { container } = render(
    <LessonPlaybackStage
      block={spoken}
      duration={8}
      time={0}
      content={{ sectionContentBlocks: sources } as WorkspaceReaderContentModel}
    />
  );
  const caption = [...container.querySelectorAll('.caption-word')].map(word => word.textContent);
  expect(caption.filter(word => word === 'Confrontiamo')).toHaveLength(2);
  expect(caption.some(word => /^scambiano\.?$/u.test(word ?? ''))).toBe(true);
});

test('keeps the authored first visual when the later card has no timing anchor', () => {
  // Authored catalog cards can have the same mix of measured and fallback timing.
  const active = visualWindowAtTime([{ startMs: 8000, endMs: 8200 }, undefined], 2, [], 10);
  expect([0, 4.9, 5, 8.9, 9, 10].map(time => active(time)?.index)).toEqual([0, 0, 0, 0, 1, 1]);
});

test('preserves authored media order when a separate formula spotlight follows speech', () => {
  const active = visualWindowAtTime(
    [{ startMs: 8000, endMs: 8200 }, undefined, { startMs: 4000, endMs: 4400 }],
    3,
    [],
    10,
    true
  );
  expect([4, 8, 8.9, 9].map(time => active(time)?.index)).toEqual([2, 0, 0, 1]);
});

test('keeps the incoming catalog visual on screen through a saved studio cue overlap', () => {
  const active = visualWindowAtTime(
    [
      { startMs: 0, endMs: 500 },
      { startMs: 5000, endMs: 6000 },
      { startMs: 4000, endMs: 8000 },
      { startMs: 8500, endMs: 9300 },
    ],
    2,
    [0, 0],
    10
  );
  expect([4, 5, 5.9, 6, 7.9, 8.5, 9.5, 5.9].map(time => active(time)?.index)).toEqual([
    0, 1, 1, 1, 1, 0, 1, 1,
  ]);
});

test('projects a saved cue inside a formula onto its shorter spoken replacement', () => {
  const formula = '$a+b+c+d+e+f+g$';
  const raw = segmentLessonPlayback([
    { type: 'markdown', markdown: `Consideriamo ${formula} e passiamo al finale.` },
  ])[0];
  const previous = resolvePlaybackNarration(raw, [{ formula, spoken: 'alfa più beta più gamma' }]);
  const studio = arrayStudio(previous.speech, ['gamma']);
  const spoken = resolvePlaybackNarration(raw, [{ formula, spoken: 'somma' }]);
  const ranges = studioCaptionRanges(studio, spoken, previous);
  expect(ranges?.map(range => spoken.speech.slice(range.start, range.end))).toEqual(['somma']);
});

test('removes the stored studio drawing when reusing the reader for a catalog scene', async () => {
  const studio = arrayStudio('Compare four and three.', []);
  const readFrame = () => ({ elapsedMs: 0, durationMs: 9600 });
  vi.mocked(useShouldAnimate).mockReturnValue(false);
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    width: 403,
    height: 204,
  } as DOMRect);
  const { container, rerender } = render(<AnimatedScene scene={studio} readFrame={readFrame} />);
  await act(() => vi.dynamicImportSettled());
  expect(container.querySelector('svg.chart')).not.toBeNull();
  rerender(<AnimatedScene scene={proportionalScene} readFrame={readFrame} />);
  expect(container.querySelector('[data-quantity-value]')?.textContent).toBe('256');
  expect(container.querySelector('svg.chart')).toBeNull();
});

async function renderStudioPassage(
  props: Pick<Parameters<typeof LessonPlaybackStage>[0], 'block' | 'content' | 'duration'>,
  onsets: number[],
  width = 100
) {
  vi.mocked(useShouldAnimate).mockReturnValue(false);
  const frames = new Map<number, FrameRequestCallback>();
  let id = 0;
  let heard = 0;
  vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation(callback => {
    frames.set(++id, callback);
    return id;
  });
  vi.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation(key => frames.delete(key));
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    width,
    height: width / 2,
  } as DOMRect);
  let seekRevision = 0;
  const view = (time: number) => (
    <LessonPlaybackStage
      {...props}
      time={time}
      readTime={() => heard}
      seekRevision={seekRevision}
      alignment={{ status: 'aligned', onsets }}
    />
  );
  const mounted = render(view(0));
  await act(() => vi.dynamicImportSettled());
  const tick = () =>
    act(() => {
      const pending = [...frames.values()];
      frames.clear();
      for (const callback of pending) callback(0);
    });
  return {
    ...mounted,
    at(seconds: number) {
      heard = seconds;
      tick();
    },
    seekTo(seconds: number) {
      heard = seconds;
      seekRevision += 1;
      mounted.rerender(view(seconds));
      tick();
    },
  };
}

test('leaves the current studio and its cues mounted when opening and closing the expanded view', async () => {
  const sources = [{ type: 'markdown' as const, markdown: 'Begin compare swap values in order.' }];
  const raw = segmentLessonPlayback(sources)[0];
  const scene = arrayStudio(raw.speech, ['compare', 'swap']);
  const { at, container } = await renderStudioPassage(
    {
      block: { ...raw, visuals: [{ kind: 'scene', scene }] },
      content: { sectionContentBlocks: sources, isDarkMode: false } as WorkspaceReaderContentModel,
      duration: 6,
    },
    [0, 1, 2, 3, 4, 5],
    354
  );
  at(1.1);
  const drawing = container.querySelector('svg.chart');
  expect(drawing).not.toBeNull();
  fireEvent.click(screen.getByRole('button', { name: /Schermo intero|Fullscreen/u }));
  const close = screen.getByRole('button', { name: /Esci da schermo intero|Exit fullscreen/u });
  expect(close.closest('.scene-fit')).toHaveAttribute('data-studio-fullscreen', 'true');
  expect(container.querySelector('svg.chart')).toBe(drawing);
  fireEvent.keyDown(screen.getByLabelText(/Sottotitoli|Captions/u), { key: 'Escape' });
  expect(screen.getByRole('button', { name: /Schermo intero|Fullscreen/u })).toBeInTheDocument();
  expect(container.querySelector('svg.chart')).toBe(drawing);
  expect(drawing?.querySelectorAll('.array-tile[data-focus="true"]')).toHaveLength(2);
});

test.each([
  { duration: 12, finalCue: 5 },
  { duration: 20, finalCue: 3.9 },
])('the studio follows its spoken cue around a card change ($duration s narration, $finalCue s final cue)', async ({
  duration,
  finalCue,
}) => {
  const lateCue = finalCue > 4;
  const sources = [
    {
      type: 'markdown' as const,
      markdown: lateCue
        ? 'Begin compare next swap values in order.'
        : 'Begin compare swap next values in order.',
    },
  ];
  const raw = segmentLessonPlayback(sources)[0];
  const first = arrayStudio(raw.speech, ['compare', 'swap']);
  const second = arrayStudio(raw.speech, ['next'], [9, 8]);
  const block: LessonPlaybackBlock = {
    ...raw,
    visuals: [
      { kind: 'scene', scene: first },
      { kind: 'scene', scene: second },
    ],
  };
  const { at, container } = await renderStudioPassage(
    {
      block,
      content: { sectionContentBlocks: sources, isDarkMode: false } as WorkspaceReaderContentModel,
      duration,
    },
    lateCue ? [0, 1, 4, finalCue, 6, 7, 10] : [0, 1, finalCue, 4, 6, 7, 10]
  );
  at(0.99);
  expect(container.querySelectorAll('.array-tile[data-focus="true"]')).toHaveLength(0);
  at(1.01);
  expect(container.querySelectorAll('.array-tile[data-focus="true"]')).toHaveLength(2);
  if (lateCue) {
    const current = () => container.querySelector('.scene-host:not([data-exiting]) [data-studio]');
    at(3.999);
    expect(current()?.querySelector('[data-array-event="1"]')).toHaveAttribute('opacity', '0');
    at(4);
    expect(current()?.querySelector('.array-value title')?.textContent).toBe('9');
    at(5.01);
    expect(current()?.querySelector('[data-array-event="1"]')).toHaveAttribute('opacity', '1');
    expect(current()?.querySelector('.array-value title')?.textContent).toBe('4');
    at(4.99);
    expect(current()?.querySelector('.array-value title')?.textContent).toBe('9');
    return;
  }
  if (!lateCue) {
    const swap = container.querySelector('[data-array-event="1"]');
    at(3.89);
    expect(swap).toHaveAttribute('opacity', '0');
    at(3.91);
    expect(swap).toHaveAttribute('opacity', '1');
  }
  at(3.999);
  const outgoing = container.querySelector('[data-studio]');
  expect(outgoing?.querySelectorAll('.array-tile[data-confirmed="true"]')).toHaveLength(2);
  at(4);
  expect(container.querySelector('.array-value title')?.textContent).toBe('9');
  expect(outgoing?.querySelectorAll('.array-tile[data-confirmed="true"]')).toHaveLength(2);
  at(3.999);
  expect(container.querySelector('.array-value title')?.textContent).toBe('4');
  expect(container.querySelectorAll('.array-tile[data-confirmed="true"]')).toHaveLength(2);
});

test('keeps the incoming studio at overlapping 4.0 s and 4.4 s cues and on a seek to 4.44 s', async () => {
  const sources = [
    {
      type: 'markdown' as const,
      markdown:
        'Begin with the comparison. Now swap these values. Watch the next swap. Finish with the result.',
    },
  ];
  const raw = segmentLessonPlayback(sources)[0];
  const outgoing = arrayStudio(raw.speech, ['Begin with the comparison.', 'Watch the next swap.']);
  const incoming = arrayStudio(raw.speech, ['Now swap these values.'], [9, 8]);
  if (incoming.studio.id !== 'array-algorithm') throw new Error('Expected array');
  const incomingSwap: AlgorithmLessonScene = {
    ...incoming,
    studio: {
      ...incoming.studio,
      spec: { ...incoming.studio.spec, callouts: [{ event: 'swap#1' }] },
    },
  };
  const block: LessonPlaybackBlock = {
    ...raw,
    visuals: [
      { kind: 'scene', scene: outgoing },
      { kind: 'scene', scene: incomingSwap },
    ],
  };
  const { at, seekTo, container } = await renderStudioPassage(
    {
      block,
      content: { sectionContentBlocks: sources, isDarkMode: false } as WorkspaceReaderContentModel,
      duration: 10,
    },
    [0, 0.2, 0.45, 0.7, 4, 4.075, 4.2, 4.3, 4.4, 4.5, 4.8, 5.1, 5.5, 5.8, 6.2, 6.6]
  );
  const visible = () => container.querySelector('.scene-host:not([data-exiting]) [data-studio]');
  at(3.99);
  expect(visible()?.querySelector('.array-value title')).toHaveTextContent('4');
  for (const time of [4.01, 4.39, 4.44, 4.5, 5.4, 5.6]) {
    at(time);
    expect(
      visible()?.querySelector('.array-value title'),
      `visible studio at ${time} s`
    ).toHaveTextContent('9');
  }
  seekTo(4.44);
  expect(visible()?.querySelector('.array-value title')).toHaveTextContent('9');
});

function graphStudio(
  narration: string,
  beats: { anchor: string; event: string }[]
): GeometryLessonScene {
  return {
    type: 'geometry',
    title: 'Visita di un grafo',
    body: '',
    note: '',
    quote: '',
    groups: [],
    items: [],
    autoplay: true,
    narration,
    studioCues: beats.map(({ anchor }) => ({ anchor })),
    geometryStudio: {
      id: 'graph',
      spec: {
        title: 'Visita di un grafo',
        layout: 'ring',
        nodes: ['A', 'B', 'C'].map(id => ({ id, label: id })),
        edges: [
          { from: 'A', to: 'B', directed: true },
          { from: 'B', to: 'C', directed: true },
        ],
        algorithm: { kind: 'bfs', start: 'A' },
        beats: beats.map(({ event }) => ({ event })),
      },
    },
  };
}

test('keeps a studio hold through the measured end of its spoken phrase', async () => {
  const sources = [
    { type: 'markdown' as const, markdown: 'Begin at A. We wait here. Now visit B.' },
  ];
  const raw = segmentLessonPlayback(sources)[0];
  const graph = graphStudio(raw.speech, [
    { anchor: 'Begin at A.', event: 'start' },
    { anchor: 'Now visit B.', event: 'visit:B' },
  ]);
  graph.studioCues[0] = { ...graph.studioCues[0], hold: 'A' };
  const { at, container } = await renderStudioPassage(
    {
      block: { ...raw, visuals: [{ kind: 'scene', scene: graph }] },
      content: { sectionContentBlocks: sources, isDarkMode: false } as WorkspaceReaderContentModel,
      duration: 8,
    },
    [0, 0.7, 1.4, 2.2, 3, 3.5, 4, 4.15, 4.6],
    403
  );
  at(1.9);
  expect(container.querySelector('[data-studio-hold] title')).toHaveTextContent('A');
  at(2.3);
  expect(container.querySelector('[data-studio-hold]')).toBeNull();
});

test.each([
  { native: true, glyph: 'text > tspan' },
  { native: false, glyph: 'g > path' },
])('paints held studio labels (native SVG text: $native)', ({ native, glyph }) => {
  const studioStyles = readFileSync(
    'apps/web/components/shared/lessonScene/studios/algorithmStudio.css',
    'utf8'
  );
  const view = render(
    <>
      <style>{studioStyles}</style>
      <div className="lesson-studio" />
    </>
  );
  const host = view.container.querySelector<HTMLElement>('.lesson-studio');
  if (!host) throw new Error('Studio host missing');
  const surface = new VectorNode('svg');
  textAt(surface, 0, 0, 'Sezione');
  const paint = mountStudio(host, surface, native);
  const seekHold = createHoldPainter(surface, [
    { cueIndex: 0, startMs: 0, endMs: 1000, label: 'Sezione', phrase: 'Osserviamo la Sezione.' },
  ]);

  seekHold(500);
  paint();
  const ink = host.querySelector(glyph);
  if (!ink) throw new Error('Studio label missing');
  expect(ink.parentElement).toHaveAttribute('data-studio-hold', 'true');
  const rules = view.container.querySelector('style')?.sheet?.cssRules;
  const accentApplies = () =>
    Array.from(rules ?? []).some(
      rule =>
        'selectorText' in rule &&
        rule.style.getPropertyValue('fill') === 'var(--accent)' &&
        ink.matches(rule.selectorText)
    );
  expect(accentApplies()).toBe(true);

  seekHold(1000);
  paint();
  expect(accentApplies()).toBe(false);
});

test('a graph reaches its final visit when the next spoken card replaces it at 4s', async () => {
  const sources = [{ type: 'markdown' as const, markdown: 'Begin visit next values in order.' }];
  const raw = segmentLessonPlayback(sources)[0];
  const graph = graphStudio(raw.speech, [{ anchor: 'visit', event: 'visit:B' }]);
  const block: LessonPlaybackBlock = {
    ...raw,
    visuals: [
      { kind: 'scene', scene: graph },
      { kind: 'scene', scene: arrayStudio(raw.speech, ['next'], [9, 8]) },
    ],
  };
  const { at, container } = await renderStudioPassage(
    {
      block,
      content: { sectionContentBlocks: sources, isDarkMode: false } as WorkspaceReaderContentModel,
      duration: 20,
    },
    [0, 3.9, 4, 6, 7, 10],
    403
  );
  at(3.999);
  const outgoing = container.querySelector('[data-studio="graph"]');
  expect(outgoing?.querySelector('.graph-result title')).toHaveTextContent('A, B, C');
  at(4);
  expect(container.querySelector('[data-studio="array-algorithm"]')).toBeInTheDocument();
  expect(outgoing?.querySelector('.graph-result title')).toHaveTextContent('A, B, C');
  at(3.999);
  expect(container.querySelector('.graph-result title')).toHaveTextContent('A, B, C');
});

test('a graph visit spoken after handoff appears at its own cue', async () => {
  const sources = [
    { type: 'markdown' as const, markdown: 'Begin start next visit values in order.' },
  ];
  const raw = segmentLessonPlayback(sources)[0];
  const block: LessonPlaybackBlock = {
    ...raw,
    visuals: [
      {
        kind: 'scene',
        scene: graphStudio(raw.speech, [
          { anchor: 'start', event: 'visit:A' },
          { anchor: 'visit', event: 'visit:B' },
        ]),
      },
      { kind: 'scene', scene: arrayStudio(raw.speech, ['next'], [9, 8]) },
    ],
  };
  const { at, container } = await renderStudioPassage(
    {
      block,
      content: { sectionContentBlocks: sources, isDarkMode: false } as WorkspaceReaderContentModel,
      duration: 12,
    },
    [0, 1, 4, 5, 6, 7, 10],
    403
  );
  const current = () => container.querySelector('.scene-host:not([data-exiting]) [data-studio]');
  at(4);
  expect(current()).toHaveAttribute('data-studio', 'array-algorithm');
  at(5.01);
  expect(current()?.querySelector('.graph-result title')).toHaveTextContent('A, B');
  at(4.99);
  expect(current()).toHaveAttribute('data-studio', 'array-algorithm');
});

test.each([
  'array',
  'graph',
] as const)('reopening prepared narration keeps both stored %s cues aligned across spoken math', async kind => {
  const sources = [
    { type: 'markdown' as const, markdown: 'Begin compare $x=2$ both then swap values.' },
    { type: 'generated-visual' as const, visualId: 'stored-array' },
  ];
  const raw = segmentLessonPlayback(sources)[0];
  const compare = raw.speech.slice(raw.speech.indexOf('compare'), raw.speech.indexOf('both') + 4);
  const studio =
    kind === 'array'
      ? arrayStudio(raw.speech, [compare, 'swap values.'])
      : graphStudio(raw.speech, [
          { anchor: compare, event: 'visit:A' },
          { anchor: 'swap values.', event: 'visit:B' },
        ]);
  const spokenMath = [{ formula: '$x=2$', spoken: 'x equals two' }];
  const speech = resolvePlaybackNarration(raw, spokenMath).speech;
  const block: LessonPlaybackBlock = JSON.parse(
    JSON.stringify({
      ...raw,
      prepared: {
        motion: [],
        spokenMath,
        textOnlyRanges: [{ start: 0, end: speech.length }],
      },
    })
  );
  const { at, container } = await renderStudioPassage(
    {
      block,
      content: {
        sectionContentBlocks: sources,
        isDarkMode: false,
        activeSectionGeneratedVisualsById: {
          'stored-array': {
            id: 'stored-array',
            title: studio.title,
            kind: 'scene',
            scene: studio,
            code: '',
            createdAt: '',
          },
        },
      } as unknown as WorkspaceReaderContentModel,
      duration: 12,
    },
    [0, 2.5, 2.7, 2.9, 3.1, 3.5, 4, 8.5, 9],
    403
  );
  const shown = (event: number) =>
    kind === 'graph'
      ? container.querySelector('.graph-result title')?.textContent?.includes(event ? 'A, B' : 'A')
      : Number(container.querySelector(`[data-array-event="${event}"]`)?.getAttribute('opacity')) >
        0;
  expect(container.querySelector('.captions')).toHaveTextContent('x equals two');
  at(2.49);
  expect(shown(0)).toBe(false);
  at(2.51);
  expect(shown(0)).toBe(true);
  at(8.49);
  expect(shown(1)).toBe(false);
  at(8.51);
  expect(shown(1)).toBe(true);
});

test('serializes unchanged source inputs once across playback time notifications', () => {
  vi.mocked(useShouldAnimate).mockReturnValue(false);
  const authored = [{ type: 'markdown' as const, markdown: 'Prima frase. Seconda frase.' }];
  const serialize = vi.fn(() => authored);
  const sources = Object.assign([...authored], { toJSON: serialize });
  const block = segmentLessonPlayback(authored)[0];
  const content = {
    sectionContentBlocks: sources,
    isDarkMode: false,
  } as unknown as WorkspaceReaderContentModel;
  const view = (time: number) => (
    <LessonPlaybackStage block={block} content={content} duration={10} time={time} />
  );
  const mounted = render(view(0));
  expect(serialize).toHaveBeenCalledOnce();
  mounted.rerender(view(1));
  mounted.rerender(view(2));
  expect(serialize).toHaveBeenCalledOnce();
  expect(mounted.container.querySelector('.captions')?.textContent).toContain(authored[0].markdown);
});

test('reads all visible steps and the actual rendered emphasis from the stage snapshot', () => {
  vi.mocked(useShouldAnimate).mockReturnValue(false);
  const frames: FrameRequestCallback[] = [];
  vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation(callback =>
    frames.push(callback)
  );
  vi.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation(() => {});
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    width: 100,
  } as DOMRect);
  const source = [
    {
      type: 'markdown' as const,
      markdown: 'Il client cerca il controller. Il server controlla i permessi.',
    },
  ];
  const block = {
    ...segmentLessonPlayback(source)[0],
    prepared: {
      scene: controllerScene,
      motion: [
        { effect: 'focus' as const, targets: ['item:0'], quote: 'Il client cerca il controller.' },
      ],
    },
  };
  const questionContextRef = createRef<(() => PlaybackQuestionContext) | null>();
  const { container, unmount } = render(
    <LessonPlaybackStage
      block={block}
      content={{ sectionContentBlocks: source, isDarkMode: false } as WorkspaceReaderContentModel}
      time={1}
      duration={12}
      questionContextRef={questionContextRef}
    />
  );
  const step = container.querySelector<HTMLElement>('.sequence li');
  if (!step) throw new Error('Step must be mounted');
  act(() =>
    frames.splice(0).forEach(callback => {
      callback(0);
    })
  );
  expect(step.style.getPropertyValue('--motion-emphasis')).toBe('1');
  expect(questionContextRef.current?.()).toMatchObject({
    passage: {
      title: '',
      text: 'Il client cerca il controller. Il server controlla i permessi.\n',
    },
    heardSentence: 'Il client cerca il controller.',
    voiceTime: 1,
    visual: {
      kind: 'scene',
      title: controllerScene.title,
      scene: controllerScene,
      highlighted: [{ id: 'item:0', text: '01Risoluzione DNSPassaggio: Risoluzione DNS.' }],
    },
  });
  unmount();
  expect(questionContextRef.current).toBeNull();
});

test.each([
  'unresolvable',
  'broken',
  'inline',
] as const)('prepares a replacement for a %s generated image', async state => {
  vi.mocked(prepareLessonPlaybackVisual).mockReset();
  const sources = [
    {
      type: 'markdown' as const,
      markdown: 'Il client individua il controller. Il controller verifica le credenziali.',
    },
  ];
  const raw = segmentLessonPlayback(sources)[0];
  const scene: LessonScene = {
    type: 'steps',
    title: 'Accesso al dominio',
    body: '',
    quote: '',
    note: '',
    groups: [],
    items: [
      { label: 'Client', detail: 'Trovare il controller', icon: '' },
      { label: 'Controller', detail: 'Verificare le credenziali', icon: '' },
    ],
  };
  const legacyImage = {
    id: 'generated-image',
    kind: 'image' as const,
    title: 'Schema salvato',
    altText: 'Schema salvato',
    code: 'data:image/png;base64,YQ==',
    createdAt: '',
  };
  const stored =
    state === 'unresolvable'
      ? {
          id: legacyImage.id,
          title: legacyImage.title,
          slotId: 'slot',
          createdAt: '',
          render: {
            kind: 'image' as const,
            asset: {
              id: 'a'.repeat(64),
              hash: 'b'.repeat(64),
              byteSize: 3,
              mediaType: 'image/png',
            },
          },
        }
      : legacyImage;
  if (state === 'unresolvable')
    vi.mocked(resolveProjectVisual).mockRejectedValueOnce(new Error('Asset unavailable'));
  let complete!: (prepared: NonNullable<LessonPlaybackBlock['prepared']>) => void;
  vi.mocked(prepareLessonPlaybackVisual).mockReturnValue(
    new Promise(resolve => {
      complete = resolve;
    })
  );
  const block = {
    ...raw,
    prepared: { motion: [] },
    visuals:
      state === 'inline'
        ? [{ kind: 'markdown' as const, markdown: '{{VISUAL_EXAMPLE:generated-image}}' }]
        : [{ kind: 'generated-visual' as const, visualId: stored.id }],
  };
  const content = {
    isDarkMode: false,
    projectId: 'project',
    activeSectionId: 'section',
    sectionContentBlocks: sources,
    activeSectionAssetsById: {},
    activeSectionGeneratedVisualsById: { [stored.id]: stored },
  } as WorkspaceReaderContentModel;
  const { container } = render(
    <LessonPlaybackStage block={block} content={content} duration={10} time={4} />
  );
  if (state !== 'unresolvable')
    fireEvent.error(await screen.findByRole('img', { name: 'Schema salvato' }));
  await waitFor(() => expect(prepareLessonPlaybackVisual).toHaveBeenCalledTimes(1));
  expect(container.querySelector('.scene-host')?.textContent).toBe('');
  expect(container.querySelector('.scene-host')?.getAttribute('aria-hidden')).toBe('true');
  await act(async () => complete({ scene, motion: [] }));
  expect(container.querySelector('.scene-host h2')?.textContent).toBe('Accesso al dominio');
  expect(container.querySelector('.scene-host')?.textContent).toContain(
    'Verificare le credenziali'
  );
  expect(container.querySelector('blockquote, .type-quote')).toBeNull();
});

test('retains an available generated image without requesting visual preparation', () => {
  vi.mocked(prepareLessonPlaybackVisual).mockClear();
  const sources = [{ type: 'markdown' as const, markdown: 'Un client e un controller.' }];
  const image = {
    id: 'available-image',
    kind: 'image' as const,
    code: 'data:image/png;base64,YQ==',
    title: 'Schema disponibile',
    createdAt: '',
  };
  const block = {
    ...segmentLessonPlayback(sources)[0],
    visuals: [{ kind: 'generated-visual' as const, visualId: image.id }],
  };
  render(
    <LessonPlaybackStage
      block={block}
      content={
        {
          projectId: 'project',
          activeSectionId: 'section',
          isDarkMode: false,
          sectionContentBlocks: sources,
          activeSectionGeneratedVisualsById: { [image.id]: image },
        } as WorkspaceReaderContentModel
      }
      duration={10}
      time={4}
    />
  );
  expect(screen.getByRole('img', { name: 'Schema disponibile' }).getAttribute('src')).toBe(
    image.code
  );
  expect(prepareLessonPlaybackVisual).not.toHaveBeenCalled();
});

test.each([
  'missing',
  'quote',
  'missing-image',
  'broken-image',
] as const)('prepares a real visual for %s and keeps the pending panel empty', async kind => {
  vi.mocked(prepareLessonPlaybackVisual).mockReset();
  const speech = 'Il client trova il controller tramite DNS e invia le credenziali al controller.';
  const scene: LessonScene = {
    type: 'steps',
    title: 'Accesso al dominio',
    body: '',
    quote: '',
    note: '',
    groups: [],
    items: [
      { label: 'Ricerca DNS', detail: 'Individuare il controller', icon: '' },
      { label: 'Autenticazione', detail: 'Inviare le credenziali', icon: '' },
    ],
  };
  const legacy = {
    ...scene,
    type: 'quote' as const,
    quote: speech,
    items: [],
  };
  let complete!: (prepared: NonNullable<LessonPlaybackBlock['prepared']>) => void;
  vi.mocked(prepareLessonPlaybackVisual).mockReturnValue(
    new Promise(resolve => {
      complete = resolve;
    })
  );
  const block = {
    ...segmentLessonPlayback([{ type: 'markdown', markdown: speech }])[0],
    visuals: kind.endsWith('image')
      ? [{ kind: 'markdown' as const, markdown: '{{PDF_IMAGE:figure-1|alt=Dominio}}' }]
      : kind === 'missing'
        ? []
        : [{ kind: 'scene' as const, scene: legacy }],
    prepared: {
      ...(kind === 'quote' ? { scene: legacy } : {}),
      motion: [],
    },
  };
  const content = {
    projectId: 'project',
    activeSectionId: 'section',
    sectionContentBlocks: [{ type: 'markdown', markdown: speech }],
    isDarkMode: false,
    activeSectionAssetsById:
      kind === 'broken-image'
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
  const questionContextRef = createRef<(() => PlaybackQuestionContext) | null>();
  const { container } = render(
    <LessonPlaybackStage
      lessonKey="lesson-key"
      questionContextRef={questionContextRef}
      block={block}
      content={content}
      duration={10}
      time={4}
    />
  );
  if (kind === 'broken-image') {
    fireEvent.error(screen.getByRole('img', { name: 'Dominio' }));
    expect(screen.getByRole('img', { name: 'Immagine non disponibile' })).toBeInTheDocument();
    expect(prepareLessonPlaybackVisual).not.toHaveBeenCalled();
    return;
  }
  expect(container.querySelector('.scene-host')?.textContent).toBe('');
  expect(questionContextRef.current?.().visual).toBeUndefined();
  expect(container.querySelector('.captions')?.textContent).toContain(speech);
  await waitFor(() => {
    expect(prepareLessonPlaybackVisual).toHaveBeenCalledTimes(1);
    expect(prepareLessonPlaybackVisual).toHaveBeenCalledWith({
      projectId: 'project',
      sectionId: 'section',
      lessonKey: 'lesson-key',
      block: expect.objectContaining({ speech }),
    });
  });
  await act(async () => complete({ scene, motion: [] }));
  await waitFor(() =>
    expect(container.querySelector('.scene-host h2')?.textContent).toBe('Accesso al dominio')
  );
  expect(container.querySelector('.scene-host')?.textContent).toContain('Ricerca DNS');
  expect(questionContextRef.current?.().visual).toMatchObject({ kind: 'scene', scene });
  expect(container.querySelector('.scene-host')?.textContent).toContain('Autenticazione');
  expect(container.querySelector('.scene-host')?.textContent).not.toContain(speech);
  expect(container.querySelector('blockquote, .type-quote')).toBeNull();
});

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
    type: 'parts',
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
    expect(container.querySelector('.scene-host')?.textContent).toBe('');
    expect(container.querySelector('.captions')?.textContent).toContain(
      'La memoria conserva i dati del programma.'
    );
  } else if (imageState === 'broken') {
    expect(screen.getByRole('img', { name: 'Immagine non disponibile' })).toBeInTheDocument();
    expect(container.querySelector('.scene-host')?.textContent).toContain('Un esempio visivo');
    return;
  } else {
    expect(container.querySelector('.scene-host h2')?.textContent).toBe('Scena del passaggio');
    expect(container.querySelector('.scene-host strong')?.textContent).toBe('Il concetto');
  }
  expect(container.querySelector('.scene-host')?.textContent).not.toContain('PDF_IMAGE');
  expect(container.querySelector('.scene-host')?.textContent).not.toContain('Figura di esempio');
  expect(container.querySelector('.scene-host')?.textContent).not.toContain('Un esempio visivo');
});
test('retains a failed adjacent PDF placeholder beside the available image', () => {
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
  expect(screen.getByRole('img', { name: 'Good' })).toBeInTheDocument();
  expect(screen.getByRole('img', { name: 'Immagine non disponibile' })).toBeInTheDocument();
  expect(container.querySelector('.scene-host')?.textContent).toContain('Immagine non disponibile');
});
beforeEach(() => {
  resizeProcessViewport = undefined;
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(readonly callback: () => void) {}
      observe(target: Element) {
        if (target.classList.contains('scene-fit')) resizeScene = this.callback;
        if (target.hasAttribute('data-ordered-scroll')) {
          resizeProcessViewport = this.callback;
          this.disconnect = disconnectProcessViewport;
        }
      }
      disconnect = disconnectScene;
    }
  );
});

test.each([
  { onDemand: false, textOnly: false },
  { onDemand: true, textOnly: false },
  { onDemand: true, textOnly: true },
])('follows all five heard ranges (on demand: $onDemand, text-only intro: $textOnly)', async ({
  onDemand,
  textOnly,
}) => {
  vi.mocked(useShouldAnimate).mockReturnValue(false);
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
  const sources = [
    {
      type: 'markdown' as const,
      markdown:
        'Prima sintesi.\n1. Primo punto.\n2. Secondo punto.\n3. Terzo punto.\n4. Quarto punto.\n5. Quinto punto.',
    },
  ];
  const [intro, list] = segmentLessonPlayback(sources);
  const offset = intro.speech.length + 1;
  const block = {
    ...intro,
    speech: `${intro.speech}\n${list.speech}`,
    spans: [
      ...intro.spans,
      ...list.spans.map(span => ({
        ...span,
        speech: { start: span.speech.start + offset, end: span.speech.end + offset },
      })),
    ],
  };
  const summary: LessonScene = {
    type: 'parts',
    title: 'Sintesi precedente',
    body: '',
    note: '',
    quote: '',
    groups: [],
    items: [{ label: 'Sintesi', detail: '', icon: '' }],
  };
  const listScene: LessonScene = {
    ...summary,
    title: 'Cinque decisioni',
    items: ['Primo', 'Secondo', 'Terzo', 'Quarto', 'Quinto'].map(label => ({
      label,
      detail: '',
      icon: '',
    })),
  };
  const timeline = playbackVisualSections(block, sources);
  const sections = timeline
    .filter(section => !textOnly || section.items)
    .map(section => ({
      ...section,
      scene: section.items ? listScene : summary,
    }));
  if (onDemand)
    vi.mocked(prepareLessonPlaybackVisual).mockResolvedValueOnce({
      scene: textOnly ? listScene : summary,
      motion: [],
      sections,
      ...(textOnly ? { textOnlyRanges: [timeline[0].range] } : {}),
    });
  let heard = 1.5;
  const { container } = render(
    <LessonPlaybackStage
      block={{
        ...block,
        visuals: [{ kind: 'scene', scene: summary }],
        prepared: { scene: summary, motion: [], ...(onDemand ? {} : { sections }) },
      }}
      content={
        {
          isDarkMode: false,
          sectionContentBlocks: sources,
          ...(onDemand ? { projectId: 'project', activeSectionId: 'section' } : {}),
        } as WorkspaceReaderContentModel
      }
      duration={37}
      alignment={{ status: 'aligned', onsets: [0, 1, 2, 3, 9, 10, 16, 17, 23, 24, 30, 31] }}
      time={0}
      readTime={() => heard}
    />
  );
  if (onDemand) {
    expect(container.querySelector('.scene-host h2')).toBeNull();
    await waitFor(() => expect(prepareLessonPlaybackVisual).toHaveBeenCalledOnce());
  }
  const flush = () => {
    for (let step = 0; step < 4; step++)
      act(() => {
        const pending = [...frames.values()];
        frames.clear();
        for (const callback of pending) callback(0);
      });
  };
  flush();
  expect(container.querySelector('.scene-host h2')?.textContent).toBe(
    textOnly ? undefined : 'Sintesi precedente'
  );
  for (let index = 0; index < 5; index++) {
    heard = 2 + index * 7 + 0.1;
    flush();
    expect(container.querySelector('.scene-host h2')?.textContent).toBe('Cinque decisioni');
    expect(
      container.querySelector(`[data-motion-id="item:${index}"]`)?.getAttribute('style')
    ).toContain('--motion-emphasis: 1');
    expect(container.querySelector('.scene-host')?.textContent).not.toContain('Sintesi precedente');
    heard += 5;
    flush();
    expect(
      container.querySelector(`[data-motion-id="item:${index}"]`)?.getAttribute('style')
    ).toContain('--motion-emphasis: 1');
  }
  heard = 2.1;
  flush();
  expect(container.querySelector('[data-motion-id="item:0"]')?.getAttribute('style')).toContain(
    '--motion-emphasis: 1'
  );
  if (textOnly) {
    heard = 1.5;
    flush();
    expect(container.querySelector('.scene-host h2')).toBeNull();
    expect(container.querySelector('.caption-page')).toHaveTextContent('Prima sintesi.');
    expect(prepareLessonPlaybackVisual).toHaveBeenCalledOnce();
  }
});

test('keeps authored mathematics beside a prepared list visual', () => {
  const questionContextRef = createRef<(() => PlaybackQuestionContext) | null>();
  const sources = [
    { type: 'markdown' as const, markdown: '1. Il valore è $x=2$.\n2. Confronta il risultato.' },
  ];
  const projected = segmentLessonPlayback(sources)[0];
  const scene: LessonScene = {
    type: 'parts',
    title: 'Due passi',
    body: '',
    quote: '',
    note: '',
    groups: [],
    items: [
      { label: 'Valore', detail: '', icon: '' },
      { label: 'Confronto', detail: '', icon: '' },
    ],
  };
  const block = {
    ...projected,
    prepared: { spokenMath: [{ formula: '$x=2$', spoken: 'ics uguale due' }], motion: [] },
  };
  const sections = playbackVisualSections(block, sources).map(section => ({ ...section, scene }));
  const { container } = render(
    <LessonPlaybackStage
      block={{ ...block, prepared: { ...block.prepared, scene, sections } }}
      content={{ isDarkMode: false, sectionContentBlocks: sources } as WorkspaceReaderContentModel}
      duration={10}
      time={0}
      questionContextRef={questionContextRef}
    />
  );
  expect(container.querySelector('.scene-host .katex annotation')?.textContent?.trim()).toBe('x=2');
  expect(container.querySelector('.scene-host h2')?.textContent).toBe('Due passi');
  expect(questionContextRef.current?.().visual).toMatchObject({
    formula: '$$\nx=2\n$$',
    scene: { type: 'parts', title: 'Due passi' },
  });
});

test('saves the source at the live voice clock rather than the last caption render', async () => {
  const sources = [
    { type: 'markdown' as const, markdown: 'First sentence. Later passage contains this visual.' },
  ];
  const onSavePlaybackVisual = vi.fn<
    NonNullable<WorkspaceReaderContentModel['onSavePlaybackVisual']>
  >(async () => ({ succeeded: true }));
  const scene: LessonScene = {
    type: 'parts',
    title: 'Passages',
    body: '',
    quote: '',
    note: '',
    groups: [],
    items: [
      { label: 'First', detail: '', icon: '' },
      { label: 'Later', detail: '', icon: '' },
    ],
  };
  const { container } = render(
    <LessonPlaybackStage
      lessonKey="lesson-version"
      block={{ ...segmentLessonPlayback(sources)[0], prepared: { scene, motion: [] } }}
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
  expect(slot.style.height).toBe('800px');
  // A wide table or code block must fit too, even when the card itself does not resize.
  Object.defineProperty(card, 'scrollWidth', { configurable: true, value: 1400 });
  act(() => resizeScene());
  flushFrame();
  expect(slot.style.getPropertyValue('--scene-scale')).toBe('0.5');
  expect(slot.style.height).toBe('800px');
  expect(card.style.width).toBe('1400px');
  Object.defineProperty(card, 'scrollHeight', { configurable: true, value: 2000 });
  act(() => resizeScene());
  flushFrame();
  expect(slot.style.getPropertyValue('--scene-scale')).toBe('0.4');
  expect(card.style.getPropertyValue('--scene-left')).toBe('70px');
  stage.style.flexDirection = 'column';
  stage.style.rowGap = '20px';
  Object.defineProperty(captions, 'offsetHeight', { configurable: true, value: 140 });
  act(() => resizeScene());
  flushFrame();
  expect(slot.style.getPropertyValue('--scene-scale')).toBe('0.4');
  expect(slot.style.height).toBe('800px');
  expect(card.style.width).toBe('1400px');
  expect(card.style.getPropertyValue('--scene-left')).toBe('70px');
  act(() => resizeScene());
  unmount();
  expect(frames.size).toBe(0);
  expect(disconnectScene).toHaveBeenCalledTimes(2);
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

test.each([true, false])('fills continuously and retains spoken words (animate=%s)', animate => {
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
  const paragraph = container.querySelector('.captions .caption-page');
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
  expect(Number(first?.style.opacity)).toBeCloseTo(0.6);
  advance(1);
  advance(2);
  advance(4);
  expect(first?.style.opacity).toBe('1');
  paragraph.scrollTop = 200;
  rerender(<LessonPlaybackStage {...props} block={{ ...block, id: 'next' }} time={0} />);
  const next = container.querySelector('.captions .caption-page');
  expect(next?.scrollTop).toBe(0);
});

test('updates the live word fill without rewriting settled or future words', () => {
  vi.mocked(useShouldAnimate).mockReturnValue(true);
  const sources = [
    {
      type: 'markdown' as const,
      markdown: 'Uno due tre quattro cinque sei sette otto nove dieci.',
    },
  ];
  const block = segmentLessonPlayback(sources)[0];
  const content = {
    isDarkMode: false,
    sectionContentBlocks: sources,
  } as WorkspaceReaderContentModel;
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
  let heard = 30;
  const { container, unmount } = render(
    <LessonPlaybackStage
      block={block}
      content={content}
      duration={60}
      time={0}
      readTime={() => heard}
    />
  );
  const words = Array.from(container.querySelectorAll<HTMLElement>('.caption-word'));
  const opacity = (index: number) => Number(words[index].style.opacity);
  const advance = () =>
    act(() => {
      const callbacks = [...frames.values()];
      frames.clear();
      callbacks.forEach(callback => {
        callback(0);
      });
    });
  expect(opacity(0)).toBe(1);
  expect(opacity(9)).toBe(0.5);
  expect(opacity(5)).toBeCloseTo(0.5 + 0.5 * (0.6 / 6));
  const settledWrites = vi.spyOn(words[0].style, 'opacity', 'set');
  const futureWrites = vi.spyOn(words[9].style, 'opacity', 'set');
  const before = opacity(5);
  heard += 1 / 60;
  advance();
  expect(opacity(5) - before).toBeCloseTo(0.5 / 360);
  expect(settledWrites).not.toHaveBeenCalled();
  expect(futureWrites).not.toHaveBeenCalled();
  heard = 1;
  advance();
  expect(opacity(0)).toBe(1);
  expect(opacity(9)).toBe(0.5);
  unmount();
  expect(frames.size).toBe(0);
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
  const questionContextRef = createRef<(() => PlaybackQuestionContext) | null>();
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
    code: `<p>${title}</p>`,
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
    <LessonPlaybackStage
      block={block}
      content={content}
      duration={8}
      time={0}
      questionContextRef={questionContextRef}
    />
  );
  const first = screen.getByTitle('First');
  expect(container.querySelectorAll('iframe')).toHaveLength(1);
  expect(screen.queryByTitle('Second')).toBeNull();
  expect(questionContextRef.current?.().visual).toMatchObject({
    kind: 'html',
    title: 'First',
    code: '<p>First</p>',
  });
  rerender(
    <LessonPlaybackStage
      block={block}
      content={content}
      duration={8}
      time={4}
      questionContextRef={questionContextRef}
    />
  );
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
  expect(questionContextRef.current?.().visual).toMatchObject({
    kind: 'html',
    title: 'Second',
    code: '<p>Second</p>',
  });
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

test.each([
  60, 180,
])('keeps formula cue boundaries through remeasurement to %s px and explicit seeks', measuredWidth => {
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
    [4.999, false],
    [5.001, true],
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
  vi.mocked(HTMLElement.prototype.getBoundingClientRect).mockReturnValue({
    width: measuredWidth,
  } as DOMRect);
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
  expect(captions[5].style.opacity).toBe('0.5');
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
  ['\\[\nx\n\\]', ' 1. After'],
  ['\\[\nx\n\\]', ' - after.'],
  ['$$\nx\n$$', '. After.'],
])('keeps punctuation and prose after a multiline formula: %s%s', (formula, suffix) => {
  const sources = [{ type: 'markdown' as const, markdown: `Before ${formula}${suffix}` }];
  const [raw] = segmentLessonPlayback(sources);
  const block = resolvePlaybackNarration({
    ...raw,
    prepared: { motion: [], spokenMath: [{ formula, spoken: 'test word' }] },
  });
  const source = captionSource(block, sources);
  const { words } = captionFormat(source.markdown, source.ranges);
  const spoken = [...block.speech.matchAll(/\S+/gu)];
  expect(words.map(word => word.text)).toEqual(spoken.map(match => match[0]));
  expect(words.some(word => word.list)).toBe(false);
  expect(captionSpeechRanges(words, source.ranges)).toEqual(
    spoken.map(match => ({ start: match.index, end: match.index + match[0].length }))
  );
});

test('maps each occurrence of multiline display math to its own caption speech range', () => {
  const display = '$$\nx = 2\n$$';
  const inline = '$x$';
  const sources = [
    {
      type: 'markdown' as const,
      markdown: `Start with ${inline}.\n\n${display}\n\n${display}`,
    },
  ];
  const [raw] = segmentLessonPlayback(sources);
  const equation = { formula: display, spoken: 'equals two' };
  const block = resolvePlaybackNarration({
    ...raw,
    prepared: {
      motion: [],
      spokenMath: [{ formula: inline, spoken: 'ex' }, equation, equation],
    },
  });
  const source = captionSource(block, sources);
  const { words } = captionFormat(source.markdown, source.ranges);
  const spokenWords = [...block.speech.matchAll(/\S+/gu)];
  const expected = 'Start with ex. equals two equals two'.split(' ');
  expect(spokenWords.map(match => match[0])).toEqual(expected);
  expect(words.map(word => word.text)).toEqual(expected);
  expect(captionSpeechRanges(words, source.ranges)).toEqual(
    spokenWords.map(match => ({ start: match.index, end: match.index + match[0].length }))
  );
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
  expect(container.querySelector('.scene-host')?.textContent).toBe('');
  expect(container.querySelector('.caption-page')?.textContent).toContain(body.trim());
});

test('keeps a text-only prepared passage in captions while the visual panel is pending', () => {
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
  expect(container.querySelector('.scene-host')?.textContent).toBe('');
});

test('highlights each standalone formula occurrence on its own aligned narration range', () => {
  vi.mocked(useShouldAnimate).mockReturnValue(false);
  const sources = [
    {
      type: 'markdown' as const,
      markdown:
        '# Fattoriale\n\nIl prodotto è questo.\n\n$$\nn! = n \\times \\cdots \\times 1\n$$\n\nQui $n$ conta. I $\\cdots$ continuano. Poi $n$ basta.',
    },
  ];
  const raw = segmentLessonPlayback(sources)[1];
  const block = {
    ...raw,
    prepared: {
      motion: [],
      spokenMath: [
        { formula: '$n$', spoken: 'enne' },
        { formula: '$\\cdots$', spoken: 'puntini di sospensione' },
        { formula: '$n$', spoken: 'enne' },
      ],
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
  let time = 0;
  const alignment = { status: 'aligned' as const, onsets: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10] };
  const view = (props: { aligned?: boolean; linked?: boolean; revision?: number } = {}) => (
    <LessonPlaybackStage
      block={props.linked === false ? raw : block}
      content={{ isDarkMode: false, sectionContentBlocks: sources } as WorkspaceReaderContentModel}
      alignment={props.aligned === false ? undefined : alignment}
      duration={11}
      time={time}
      readTime={() => time}
      seekRevision={props.revision}
    />
  );
  const { container, rerender } = render(view());
  const rows = () => [...container.querySelectorAll('.scene-host .katex')];
  const active = () =>
    rows().flatMap((row, index) =>
      row.hasAttribute('data-playback-formula-current') ? [index] : []
    );
  const advance = (next: number) => {
    time = next;
    act(() => {
      const queued = [...frames.values()];
      frames.clear();
      for (const callback of queued) callback(0);
    });
  };
  expect(rows().map(row => row.querySelector('annotation')?.textContent?.trim())).toEqual([
    'n! = n \\times \\cdots \\times 1',
    'n',
    '\\cdots',
    'n',
  ]);
  expect(active()).toEqual([]);
  advance(1.2);
  expect(active()).toEqual([1]);
  advance(2);
  expect(active()).toEqual([]);
  advance(5.2);
  expect(active()).toEqual([2]);
  advance(9.2);
  expect(active()).toEqual([3]);
  rerender(view({ revision: 1 }));
  advance(4.2);
  expect(active()).toEqual([2]);
  rerender(view({ aligned: false, revision: 1 }));
  advance(4.2);
  expect(active()).toEqual([]);
  rerender(view({ linked: false, revision: 1 }));
  advance(4.2);
  expect(active()).toEqual([]);
  expect(rows()).toHaveLength(4);
});
test('leaves distinct formulas static when they share one aligned word', () => {
  const sources = [
    {
      type: 'markdown' as const,
      markdown: '# Fattoriale\n\nIl prodotto è questo.\n\n$$n! = n$$\n\nQui $n$,$n$ contano.',
    },
  ];
  const raw = segmentLessonPlayback(sources)[1];
  const formula = { formula: '$n$', spoken: 'enne' };
  const { container } = render(
    <LessonPlaybackStage
      block={{ ...raw, prepared: { motion: [], spokenMath: [formula, formula] } }}
      content={{ isDarkMode: false, sectionContentBlocks: sources } as WorkspaceReaderContentModel}
      alignment={{ status: 'aligned', onsets: [0, 1, 2] }}
      duration={3}
      time={1.5}
      readTime={() => 1.5}
    />
  );
  expect(container.querySelectorAll('.scene-host .katex')).toHaveLength(3);
  expect(container.querySelector('[data-playback-formula-current]')).toBeNull();
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
  expect(caption.style.opacity).toBe('0.5');
  heard = 6.1;
  flush();
  expect(Number(caption.style.opacity)).toBeGreaterThan(0.5);
  if (!animate) expect(visualValue()).toBe('0');
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
  expect(captionState()).not.toEqual(withAlignment);
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

test.each([
  { cue: 'a step hidden after fitting', groups: [['item:1']], firstTop: 0, fitDuringCue: true },
  { cue: 'one step', groups: [['item:1']], firstTop: 0 },
  { cue: 'a group that fits', groups: [['item:0', 'item:1']], firstTop: 215 },
  {
    cue: 'a group with an already visible first step',
    groups: [['item:0', 'item:1']],
    firstTop: 0,
  },
  { cue: 'simultaneous events', groups: [['item:0'], ['item:1']], firstTop: 0 },
])('a process focus on $cue follows recording and seeks while manual scrolling persists', async ({
  groups,
  firstTop,
  fitDuringCue = false,
}) => {
  vi.mocked(useShouldAnimate).mockReturnValue(false);
  const frames = new Map<number, FrameRequestCallback>();
  let frameId = 0;
  vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation(callback => {
    frames.set(++frameId, callback);
    return frameId;
  });
  vi.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation(id => {
    frames.delete(id);
  });
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(
    new DOMRect(0, 0, 100, 100)
  );
  const sources = [{ type: 'markdown' as const, markdown: 'First sample. Final report.' }];
  const scene: LessonScene = {
    type: 'process',
    title: 'Sampling process',
    body: '',
    items: [
      { label: 'First sample', detail: '', icon: 'circle' },
      { label: 'Final report', detail: '', icon: 'circle' },
    ],
    groups: [],
    note: '',
    quote: '',
  };
  const block = {
    ...segmentLessonPlayback(sources)[0],
    prepared: {
      scene,
      motion: groups.map((targets, index) => ({
        effect: 'focus' as const,
        targets,
        quote: index === 0 ? 'Final' : 'report.',
      })),
    },
  };
  const content = {
    isDarkMode: false,
    sectionContentBlocks: sources,
  } as WorkspaceReaderContentModel;
  let heard = 0;
  const refreshedBlock = {
    ...block,
    prepared: { ...block.prepared, motion: [...block.prepared.motion] },
  };
  const readTime = () => heard;
  const view = (seekRevision: number, snapshot = block) => (
    <LessonPlaybackStage
      block={snapshot}
      content={content}
      duration={10}
      time={heard}
      readTime={readTime}
      seekRevision={seekRevision}
      alignment={{ status: 'aligned', onsets: [0, 1, 6, 6] }}
    />
  );
  const { container, rerender, unmount } = render(view(0));
  const card = container.querySelector<HTMLElement>('[data-ordered-scroll]');
  const firstStep = container.querySelector<HTMLElement>('[data-playback-item="0"]');
  const finalStep = container.querySelector<HTMLElement>('[data-playback-item="1"]');
  if (!card || !firstStep || !finalStep) throw new Error('The process card must render both steps');
  const scroll = vi.fn(({ top }: ScrollToOptions) => {
    card.scrollTop = top ?? 0;
  });
  const host = card.parentElement!;
  let viewportHeight = 100;
  if (fitDuringCue) {
    const stage = host.closest<HTMLElement>('.listening-stage')!;
    stage.style.padding = '0px';
    Object.defineProperty(stage, 'clientHeight', { value: 100 });
    Object.defineProperty(host.parentElement!, 'clientWidth', { value: 400 });
  }
  Object.defineProperties(card, {
    clientHeight: {
      get: () =>
        fitDuringCue && !host.style.getPropertyValue('--scene-height-limit') ? 300 : viewportHeight,
    },
    offsetHeight: { value: 100 },
    scrollHeight: { value: 300 },
    scrollTo: { value: scroll },
  });
  Object.defineProperty(firstStep, 'getBoundingClientRect', {
    value: () => new DOMRect(0, firstTop - card.scrollTop, 100, 16),
  });
  Object.defineProperty(finalStep, 'getBoundingClientRect', {
    value: () => new DOMRect(0, 240 - card.scrollTop, 100, 60),
  });
  const tick = () =>
    act(() => {
      const pending = [...frames.values()];
      frames.clear();
      for (const callback of pending) callback(0);
    });

  tick();
  expect(scroll).not.toHaveBeenCalled();
  heard = 6.2;
  tick();
  if (fitDuringCue) {
    expect(scroll).not.toHaveBeenCalled();
    resizeScene();
    tick();
    await act(async () => {
      resizeProcessViewport?.();
    });
    expect(host).toHaveAttribute('data-ordered-overflow');
  }
  expect(finalStep.style.getPropertyValue('--motion-emphasis')).toBe('1');
  expect(firstStep.style.getPropertyValue('--motion-emphasis')).toBe(
    groups.flat().includes('item:0') ? '1' : '0'
  );
  expect(scroll).toHaveBeenCalledExactlyOnceWith({ top: 200, behavior: 'instant' });
  card.scrollTop = 10;
  heard = 6.3;
  tick();
  expect(card.scrollTop).toBe(10);
  expect(scroll).toHaveBeenCalledTimes(1);
  rerender(view(0, refreshedBlock));
  tick();
  expect(card.scrollTop).toBe(10);
  rerender(view(1, refreshedBlock));
  tick();
  expect(card.scrollTop).toBe(200);
  expect(scroll).toHaveBeenCalledTimes(2);
  if (fitDuringCue) {
    viewportHeight = 80;
    resizeProcessViewport?.();
    tick();
    expect(host).toHaveAttribute('data-ordered-overflow');
    expect(card.scrollTop).toBe(220);
    card.scrollTop = 10;
    resizeProcessViewport?.();
    tick();
    expect(card.scrollTop).toBe(10);
  }
  if (groups.length > 1) {
    // The second step is now visible. Seeking to the shared cue must reveal the first.
    rerender(view(2, refreshedBlock));
    tick();
    expect(card.scrollTop).toBe(firstTop);
    expect(scroll).toHaveBeenCalledTimes(3);
  }
  disconnectProcessViewport.mockClear();
  expect(frames.size).toBeGreaterThan(0);
  unmount();
  expect(disconnectProcessViewport).toHaveBeenCalledTimes(1);
  expect(frames.size).toBe(0);
});

test('a visible target supersedes an unfinished process reveal while native input retains control', () => {
  const scrollport = document.createElement('section');
  const early = document.createElement('li');
  const late = document.createElement('li');
  const scrollTo = vi.fn();
  Object.defineProperties(scrollport, {
    clientHeight: { value: 100 },
    offsetHeight: { value: 100 },
    scrollHeight: { value: 300 },
    scrollTo: { value: scrollTo },
  });
  vi.spyOn(scrollport, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 100, 100));
  vi.spyOn(early, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 12, 100, 18));
  vi.spyOn(late, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 240, 100, 60));

  revealProcessSteps(scrollport, [late], true);
  expect(scrollTo).toHaveBeenLastCalledWith({ top: 200, behavior: 'smooth' });
  scrollport.scrollTop = 5;
  revealProcessSteps(scrollport, [early], true);
  expect(scrollTo).toHaveBeenLastCalledWith({ top: 5, behavior: 'instant' });

  for (const interrupt of [
    () => fireEvent.wheel(scrollport),
    () => fireEvent.touchMove(scrollport),
    () => fireEvent.keyDown(scrollport, { key: 'ArrowDown' }),
  ]) {
    revealProcessSteps(scrollport, [late], true);
    scrollTo.mockClear();
    interrupt();
    expect(scrollTo).toHaveBeenCalledExactlyOnceWith({ top: 5, behavior: 'instant' });
    revealProcessSteps(scrollport, [early], true);
    expect(scrollTo).toHaveBeenCalledTimes(1);
  }
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
])('keeps captions readable while %s content awaits a real visual', state => {
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
  expect(visual?.textContent).toBe('');
  expect(container.querySelector('.captions')?.textContent).toContain(raw.speech);
  for (const time of [4, 8, 8.1]) {
    rerender(<LessonPlaybackStage block={block} content={content} duration={8} time={time} />);
    expect(visual?.textContent).toBe('');
    expect(container.querySelector('.captions')?.textContent).toContain(raw.speech);
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
  {
    markdown: '```typescript\nconst answer = 42;\n```',
    selector: 'pre code',
    text: 'const answer = 42;',
  },
  {
    markdown: '| Decision | Value |\n| --- | --- |\n| Backup | Daily |',
    selector: 'table',
    text: 'Daily',
  },
])('keeps authored $selector beside a prepared list', ({ markdown, selector, text }) => {
  const sources = [
    {
      type: 'markdown' as const,
      markdown: `1. First decision.\n2. Second decision.\n\n${markdown}`,
    },
  ];
  const block = segmentLessonPlayback(sources)[0];
  const scene: LessonScene = {
    ...controllerScene,
    type: 'parts',
    title: 'Two decisions',
    items: controllerScene.items.slice(0, 2),
  };
  const sections = playbackVisualSections(block, sources).map(section => ({ ...section, scene }));
  const { container } = render(
    <LessonPlaybackStage
      block={{ ...block, prepared: { motion: [], scene, sections } }}
      content={{ isDarkMode: false, sectionContentBlocks: sources } as WorkspaceReaderContentModel}
      duration={10}
      time={0}
    />
  );
  expect(container.querySelector('.scene-host h2')?.textContent).toBe('Two decisions');
  expect(container.querySelector(`.scene-host ${selector}`)?.textContent).toContain(text);
});

test('leaves the list panel empty while a saved summary lacks its list preparation', () => {
  const sources = [
    { type: 'markdown' as const, markdown: '1. First decision.\n2. Second decision.' },
  ];
  const block = segmentLessonPlayback(sources)[0];
  const { container } = render(
    <LessonPlaybackStage
      block={{ ...block, prepared: { scene: controllerScene, motion: [] } }}
      content={{ isDarkMode: false, sectionContentBlocks: sources } as WorkspaceReaderContentModel}
      duration={10}
      time={5}
    />
  );
  expect(container.querySelector('.scene-host')?.textContent).not.toContain(controllerScene.title);
  expect(container.querySelector('.scene-host blockquote')).toBeNull();
});

// Parity with main: equal future onsets preserve duration until an explicit seek.
test('future motion with unchanged onset retains duration when remeasurement moves its end', () => {
  const frames = new Map<number, FrameRequestCallback>();
  let frameId = 0;
  vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation(callback => {
    frames.set(++frameId, callback);
    return frameId;
  });
  vi.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation(id => {
    frames.delete(id);
  });
  let remeasured = false;
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: HTMLElement
  ) {
    const widths: Record<string, number> = { Alpha: 100, beta: 200, gamma: 50, delta: 50 };
    const width =
      remeasured && this.classList.contains('caption-word')
        ? widths[this.textContent?.trim() ?? '']
        : 100;
    return { width } as DOMRect;
  });
  const style = document.createElement('p').style;
  style.setProperty('--caption-feather', '0');
  vi.spyOn(globalThis, 'getComputedStyle').mockReturnValue(style);
  vi.mocked(useShouldAnimate).mockReturnValue(false);
  const sources = [{ type: 'markdown' as const, markdown: 'Alpha beta gamma delta' }];
  const scene: LessonScene = {
    type: 'steps',
    title: 'Words',
    body: '',
    items: [{ label: 'Beta', detail: '', icon: 'circle' }],
    groups: [],
    note: '',
    quote: '',
  };
  const block = {
    ...segmentLessonPlayback(sources)[0],
    prepared: {
      scene,
      motion: [{ effect: 'focus' as const, targets: ['item:0'], quote: 'beta' }],
    },
  };
  let heard = 1;
  const props = {
    block,
    content: { isDarkMode: false, sectionContentBlocks: sources } as WorkspaceReaderContentModel,
    duration: 8,
    time: 0,
    readTime: () => heard,
  };
  const { container, rerender } = render(<LessonPlaybackStage {...props} />);
  const flush = () =>
    act(() => {
      const pending = [...frames.values()];
      frames.clear();
      pending.forEach(callback => {
        callback(0);
      });
    });
  const emphasis = () =>
    Number(
      container
        .querySelector<HTMLElement>('[data-motion-id="item:0"]')
        ?.style.getPropertyValue('--motion-emphasis')
    );
  flush();
  expect(emphasis()).toBe(0);
  // At t=1 beta is future: its onset stays 2s, but its measured end moves from 4s to 6s.
  remeasured = true;
  act(() => window.dispatchEvent(new Event('resize')));
  flush();
  heard = 2.5;
  flush();
  expect(emphasis()).toBe(1);
  heard = 4.5;
  flush();
  expect(emphasis()).toBe(0);
  // A fresh timing adoption proves the changed quote end was measured, not ignored.
  rerender(<LessonPlaybackStage {...props} seekRevision={1} />);
  flush();
  expect(emphasis()).toBe(1);
});

test.each([
  'forward',
  'backward',
] as const)('pending %s seek presents its target before the live audio anchor commits', direction => {
  vi.mocked(useShouldAnimate).mockReturnValue(false);
  const frames = new Map<number, FrameRequestCallback>();
  let id = 0;
  vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation(callback => {
    frames.set(++id, callback);
    return id;
  });
  vi.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation(key => frames.delete(key));
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    width: 100,
  } as DOMRect);
  const sources = [{ type: 'markdown' as const, markdown: 'Uno Due' }];
  const block = segmentLessonPlayback(sources)[0];
  const content = {
    sectionContentBlocks: sources,
    isDarkMode: false,
  } as WorkspaceReaderContentModel;
  let heard = direction === 'forward' ? 1 : 6;
  const target = direction === 'forward' ? 4.9 : 1.9;
  const view = (time: number, loading: boolean, seekRevision: number) => (
    <LessonPlaybackStage
      block={block}
      content={content}
      time={time}
      duration={10}
      loading={loading}
      readTime={() => heard}
      seekRevision={seekRevision}
      alignment={{ status: 'aligned', onsets: [0, 5] }}
    />
  );
  const mounted = render(view(heard, false, 0));
  const tick = () =>
    act(() => {
      const pending = [...frames.values()];
      frames.clear();
      for (const callback of pending) callback(0);
    });
  const opacity = () =>
    Array.from(mounted.container.querySelectorAll<HTMLElement>('.caption-word'), word =>
      Number(word.style.opacity)
    );
  tick();
  mounted.rerender(view(target, true, 1));
  tick();
  expect(opacity()).toEqual([expect.closeTo(0.5 + (0.5 * target) / 5), 0.5]);
  heard = target;
  mounted.rerender(view(target, false, 1));
  tick();
  expect(opacity()).toEqual([expect.closeTo(0.5 + (0.5 * target) / 5), 0.5]);
  heard = target + 0.2;
  tick();
  if (direction === 'backward') expect(opacity()[0]).toBeCloseTo(0.73);
  else expect(opacity()[1]).toBeCloseTo(0.53);
  mounted.unmount();
});
