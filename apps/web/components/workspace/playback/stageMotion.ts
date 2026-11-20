import { type FormulaSpotlightData, resolveFormulaReferences } from '@shared/formulaSpotlight';
import type {
  LessonPlaybackBlock,
  PlaybackMotionEvent,
  PlaybackRange,
  PlaybackVisual,
} from '@shared/lessonPlayback';
import {
  type AnimatedLessonScene,
  isAnimatedLessonScene,
  type LessonScene,
} from '@shared/lessonScene';
import { cueTimes, playbackMode } from '@shared/lessonSceneAnimation';
import {
  alignedRangeTime,
  type alignedWordTimes,
  narrationWords,
} from '@shared/playbackWordTiming';

export const MOTION_TIMING = { transitionMs: 420, stepMs: 2400, holdMs: 1600, maxFocusMs: 4000 };
const REVEAL_DURATION_MS = 700;
const ITEM_SELECTORS: Record<string, string> = {
  steps: '.sequence>li',
  timeline: '.sequence>li',
  checklist: '.sequence>li',
  hypothesis: '.sequence>li',
  causal: '.cause',
  roles: '.roles>section',
  layers: '.nested-layers section',
  source: '.source-profile .concept,.source dl>div',
  number: '.big-number',
};
const CONCEPT_ITEM_SELECTORS = { roles: ITEM_SELECTORS.roles, featured: ITEM_SELECTORS.source };

const sceneItemSelector = ({ type, conceptLayout }: LessonScene) => {
  if (type === 'concepts' && (conceptLayout === 'roles' || conceptLayout === 'featured'))
    return CONCEPT_ITEM_SELECTORS[conceptLayout];
  return ITEM_SELECTORS[type] ?? '.visual-content .concept';
};
export interface CaptionRun {
  span: HTMLElement;
  start: number;
  width: number;
}
export interface TimedMotionEvent extends PlaybackMotionEvent {
  atMs: number;
  durationMs: number;
  readonly sustainFocus?: boolean;
}

/** Authored cards keep the occurrence identity already recorded by narration projection. */
export function visualSpeechRange(
  block: LessonPlaybackBlock,
  visual: PlaybackVisual,
  occurrence = 0
) {
  const visualIndex =
    visual.kind === 'markdown'
      ? (block.visuals
          .map((candidate, index) => ({ candidate, index }))
          .filter(
            ({ candidate }) =>
              candidate.kind === 'markdown' && candidate.markdown === visual.markdown
          )[occurrence]?.index ?? -1)
      : block.visuals.indexOf(visual);
  if (visualIndex < 0) return undefined;
  const fenced = block.spans.find(span => span.fencedCode?.visualIndex === visualIndex);
  if (fenced) return fenced.speech.end > fenced.speech.start ? fenced.speech : undefined;
  if (visual.kind !== 'markdown') return undefined;
  const sourceOccurrence = block.visuals
    .slice(0, visualIndex)
    .filter(
      previous => previous.kind === 'markdown' && previous.markdown === visual.markdown
    ).length;
  const span = block.spans.filter(span => span.math === visual.markdown)[sourceOccurrence];
  return span && span.speech.end > span.speech.start ? span.speech : undefined;
}

/** Project a saved narration range onto acoustic onsets or the voice estimate, preserving repeated occurrences. */
export function captionRangeSpan({
  range,
  speech,
  speechRanges,
  runs,
  width,
  feather,
  duration,
  aligned,
  startOffset = 0,
}: {
  range: PlaybackRange;
  speech: string;
  speechRanges: readonly PlaybackRange[];
  runs: readonly (Pick<CaptionRun, 'start' | 'width'> & Partial<Pick<CaptionRun, 'span'>>)[];
  width: number;
  feather: number;
  duration: number;
  aligned?: ReturnType<typeof alignedWordTimes>;
  startOffset?: number;
}) {
  if (aligned) {
    const span = alignedRangeTime(aligned, range);
    return { startMs: span.start * 1000, endMs: span.end * 1000 };
  }
  const bodyStart = speechRanges[0]?.start ?? speech.length;
  const heading = narrationWords(speech.slice(0, bodyStart));
  const boundary = (offset: number, end: boolean) => {
    if (offset <= bodyStart && heading.length) {
      const index = end
        ? heading.filter(word => word.start < offset).length
        : heading.findIndex(word => word.end > offset);
      return startOffset * (index < 0 ? 1 : index / heading.length);
    }
    const index = end
      ? speechRanges.reduce((last, word, index) => (word.start < offset ? index : last), 0)
      : speechRanges.findIndex(word => word.end > offset);
    const run = runs[index];
    if (!run) throw new Error('Visual narration range must cover caption words');
    return startOffset + ((run.start + (end ? run.width : 0)) / (width + feather)) * duration;
  };
  return { startMs: boundary(range.start, false) * 1000, endMs: boundary(range.end, true) * 1000 };
}

function animatedSceneCues(scene: AnimatedLessonScene) {
  if (scene.type === 'algorithm') return scene.studioCues;
  return scene.type === 'guided-path' ? scene.steps : scene.cues;
}

/** Visibility and animation must make the same all-or-nothing synchronization decision. */
export function sceneCaptionAnchors(
  scene: LessonScene | null | undefined,
  speech: string
): string[] | undefined {
  if (!scene) return undefined;
  let cues: readonly { readonly anchor?: string }[] | undefined;
  if (scene.type === 'formula-spotlight') {
    try {
      const anchors = resolveFormulaReferences(scene as FormulaSpotlightData, speech).map(
        reference => reference.anchor
      );
      return anchors.length ? anchors : undefined;
    } catch {
      return undefined;
    }
  } else if (isAnimatedLessonScene(scene) && playbackMode(scene) === 'text') {
    cues = animatedSceneCues(scene);
  }
  if (!cues) return undefined;
  try {
    cueTimes(speech, cues);
  } catch {
    return undefined;
  }
  return cues.map(cue => cue.anchor as string);
}

/** Resolves narration citations to acoustic onsets or the existing measured timing estimate. */
export function captionAnchorTimes({
  anchors,
  speech,
  speechRanges,
  runs,
  width,
  feather,
  duration,
  aligned,
  startOffset = 0,
}: {
  anchors: readonly string[];
  speech: string;
  speechRanges: readonly PlaybackRange[];
  runs: readonly (Pick<CaptionRun, 'start' | 'width'> & Partial<Pick<CaptionRun, 'span'>>)[];
  width: number;
  feather: number;
  duration: number;
  aligned?: ReturnType<typeof alignedWordTimes>;
  startOffset?: number;
}): number[] {
  return anchors.map(anchor => {
    const offset = speech.indexOf(anchor);
    if (offset < 0) throw new Error('Caption quotation must exist in speech');
    return captionRangeSpan({
      range: { start: offset, end: offset + anchor.length },
      speech,
      speechRanges,
      runs,
      width,
      feather,
      duration,
      aligned,
      startOffset,
    }).startMs;
  });
}

/** The complete quoted span on the recording clock, including its final spoken word. */
export function captionAnchorSpan(input: Parameters<typeof captionAnchorTimes>[0]) {
  const spans = input.anchors.map(anchor => {
    const start = input.speech.indexOf(anchor);
    if (start < 0) throw new Error('Caption quotation must exist in speech');
    return captionRangeSpan({ ...input, range: { start, end: start + anchor.length } });
  });
  return {
    startMs: Math.min(...spans.map(span => span.startMs)),
    endMs: Math.max(...spans.map(span => span.endMs)),
  };
}

/** Exact narration citations use acoustic onsets; missing alignment retains the width estimate. */
export function captionMotionEvents({
  events,
  speech,
  speechRanges,
  runs,
  width,
  feather,
  duration,
  aligned,
  startOffset,
}: {
  events: readonly PlaybackMotionEvent[];
  speech: string;
  speechRanges: readonly PlaybackRange[];
  runs: readonly (Pick<CaptionRun, 'start' | 'width'> & Partial<Pick<CaptionRun, 'span'>>)[];
  width: number;
  feather: number;
  duration: number;
  aligned?: ReturnType<typeof alignedWordTimes>;
  startOffset?: number;
}): TimedMotionEvent[] {
  const times = captionAnchorTimes({
    anchors: events.map(event => event.quote),
    speech,
    speechRanges,
    runs,
    width,
    feather,
    duration,
    aligned,
    startOffset,
  });
  const timed = events.map((event, index) => {
    const offset = speech.indexOf(event.quote);
    if (offset < 0) throw new Error('Motion quotation must exist in speech');
    const atMs = times[index];
    const span = captionRangeSpan({
      range: { start: offset, end: offset + event.quote.length },
      speech,
      speechRanges,
      runs,
      width,
      feather,
      duration,
      aligned,
      startOffset,
    });
    const spokenDurationMs = span.endMs - span.startMs;
    const durationMs =
      event.effect === 'reveal'
        ? REVEAL_DURATION_MS
        : Math.max(MOTION_TIMING.holdMs, spokenDurationMs);
    return { ...event, atMs, durationMs };
  });
  return timed.map(event => ({
    ...event,
    durationMs: Math.min(
      event.durationMs,
      (timed.find(next => next.atMs > event.atMs)?.atMs ?? ((startOffset ?? 0) + duration) * 1000) -
        event.atMs
    ),
  }));
}

export const smooth = (fraction: number) => {
  const time = Math.max(0, Math.min(1, fraction));
  return time * time * (3 - 2 * time);
};

function motionRiseMs(event: TimedMotionEvent) {
  return event.effect === 'reveal'
    ? event.durationMs
    : Math.min(
        MOTION_TIMING.transitionMs,
        Math.min(event.durationMs, MOTION_TIMING.maxFocusMs) / 2
      );
}

function focusDurationMs(event: TimedMotionEvent) {
  return event.sustainFocus
    ? event.durationMs
    : Math.min(event.durationMs, MOTION_TIMING.maxFocusMs);
}

/** Scrolling follows the spoken cue, including direct seeks, without following the focus fade. */
export function activeFocusCue(events: readonly TimedMotionEvent[], heardMs: number) {
  const targets = new Set<string>();
  let activeOnset = Number.NEGATIVE_INFINITY;
  for (const event of events) {
    if (
      event.effect === 'focus' &&
      event.atMs >= activeOnset &&
      event.atMs <= heardMs &&
      heardMs < event.atMs + focusDurationMs(event)
    ) {
      if (event.atMs > activeOnset) targets.clear();
      for (const id of event.targets) targets.add(id);
      activeOnset = event.atMs;
    }
  }
  return { onset: activeOnset, targets: [...targets] };
}

const processScrolls = new WeakMap<HTMLElement, AbortController>();
const scrollKeys = new Set(['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' ']);

function releaseProcessScroll(scrollport: HTMLElement) {
  processScrolls.get(scrollport)?.abort();
  return processScrolls.delete(scrollport);
}

/** Interrupt only a pending programmatic scroll, leaving native input in control. */
export function stopProcessScroll(scrollport: HTMLElement) {
  if (releaseProcessScroll(scrollport)) {
    scrollport.scrollTo({ top: scrollport.scrollTop, behavior: 'instant' });
  }
}

function trackProcessScroll(scrollport: HTMLElement, destination: number) {
  const follow = new AbortController();
  processScrolls.set(scrollport, follow);
  const { signal } = follow;
  const stop = () => stopProcessScroll(scrollport);
  scrollport.addEventListener('wheel', stop, { signal, passive: true });
  scrollport.addEventListener('touchmove', stop, { signal, passive: true });
  scrollport.addEventListener(
    'scroll',
    () => {
      if (Math.abs(scrollport.scrollTop - destination) < 1) releaseProcessScroll(scrollport);
    },
    { signal, passive: true }
  );
  scrollport.addEventListener(
    'keydown',
    event => {
      if (scrollKeys.has(event.key)) stop();
    },
    { signal }
  );
}

function processFocusBounds(scrollport: HTMLElement, steps: readonly Element[]) {
  const viewport = scrollport.getBoundingClientRect();
  const scale = viewport.height / scrollport.offsetHeight;
  const height = scrollport.clientHeight;
  const bounds = steps
    .map(step => {
      const rect = step.getBoundingClientRect();
      return {
        top: (rect.top - viewport.top) / scale - scrollport.clientTop,
        bottom: (rect.bottom - viewport.top) / scale - scrollport.clientTop,
      };
    })
    .sort((a, b) => a.top - b.top);
  const top = bounds[0]?.top;
  if (top === undefined) return undefined;
  const bottom = Math.max(...bounds.map(step => step.bottom));
  if (bottom - top <= height) return { top, bottom };
  // If the group cannot fit, surface a hidden step before adjusting one already partly visible.
  return (
    bounds.find(step => step.bottom <= 0 || step.top >= height) ??
    bounds.find(step => step.top < 0 || step.bottom > height)
  );
}

/** Reveal the cue within its own process scrollport with one movement. */
export function revealProcessSteps(
  scrollport: HTMLElement,
  steps: readonly Element[],
  animate: boolean
) {
  const height = scrollport.clientHeight;
  const range = scrollport.scrollHeight - height;
  if (!height || range <= 0) return stopProcessScroll(scrollport);
  const bounds = processFocusBounds(scrollport, steps);
  if (!bounds) return stopProcessScroll(scrollport);
  const { top, bottom } = bounds;
  const overflow = bottom - height;
  const delta = top < 0 || (bottom - top > height && overflow > 0) ? top : Math.max(0, overflow);
  const destination = Math.min(
    range,
    Math.max(
      0,
      delta > 0 ? Math.ceil(scrollport.scrollTop + delta) : Math.floor(scrollport.scrollTop + delta)
    )
  );
  if (Math.abs(destination - scrollport.scrollTop) < 1) return stopProcessScroll(scrollport);
  releaseProcessScroll(scrollport);
  if (animate) trackProcessScroll(scrollport, destination);
  scrollport.scrollTo({ top: destination, behavior: animate ? 'smooth' : 'instant' });
}

function motionUpdate(event: TimedMotionEvent, eventTime: number, reduced: boolean) {
  if (event.effect === 'reveal') {
    return {
      opacity: reduced ? 1 : smooth((eventTime - event.atMs + event.durationMs) / event.durationMs),
    };
  }
  const focusDuration = focusDurationMs(event);
  if (!(event.effect === 'focus' && eventTime < event.atMs + focusDuration)) return {};
  const transition = motionRiseMs(event);
  return {
    emphasis: reduced
      ? 1
      : smooth((eventTime - event.atMs + transition) / transition) *
        smooth((event.atMs + focusDuration - eventTime) / transition),
  };
}

/** Each frame is derived from time, including backward seeks (motion-player.mjs). */
export function motionStates(
  ids: readonly string[],
  events: readonly TimedMotionEvent[],
  time: number,
  reduced: boolean,
  focusDelayMs: number
) {
  const revealed = new Set(
    events.filter(event => event.effect === 'reveal').flatMap(event => event.targets)
  );
  const states = new Map(ids.map(id => [id, { opacity: revealed.has(id) ? 0 : 1, emphasis: 0 }]));
  for (const event of events) {
    const eventTime = time - (event.effect === 'focus' ? focusDelayMs : 0);
    // Finish the original enter fade at the voice cue; keep the focus hold and exit on that cue.
    if (eventTime < event.atMs - (reduced ? 0 : motionRiseMs(event))) continue;
    const update = motionUpdate(event, eventTime, reduced);
    for (const target of event.targets) {
      const state = states.get(target);
      if (!state) throw new Error(`Motion target is unavailable: ${target}`);
      Object.assign(state, update);
    }
  }
  return states;
}

/** Mermaid's authored node order identifies both flowchart nodes and sequence participants. */
function diagramElements(
  host: HTMLElement,
  diagram: NonNullable<LessonScene['diagram']>,
  sequence: boolean
) {
  const elements = new Map<string, (HTMLElement | SVGElement)[]>();
  const nodes = Array.from(
    host.querySelectorAll<SVGElement>(sequence ? '[data-et="participant"]' : 'g.node')
  );
  diagram.nodes.forEach((node, index) => {
    const matches = nodes.filter(element =>
      sequence ? element.dataset.id === `n${index}` : element.id.includes(`flowchart-n${index}-`)
    );
    if (matches.length) elements.set(`node:${node.id}`, matches);
  });
  const labels = host.querySelectorAll<SVGElement>('.messageText');
  host
    .querySelectorAll<SVGElement>(sequence ? '[data-et="message"]' : 'path.flowchart-link')
    .forEach((element, index) => {
      elements.set(
        `edge:${index}`,
        sequence && labels[index] ? [element, labels[index]] : [element]
      );
    });
  return elements;
}

export function sceneElements(host: HTMLElement, scene: LessonScene) {
  const elements = new Map<string, (HTMLElement | SVGElement)[]>();
  const structuredGroups = host.querySelectorAll<HTMLElement>(
    '[data-playback-group], [data-playback-panel]'
  );
  if (structuredGroups.length) {
    for (const element of structuredGroups) {
      const id =
        element.dataset.playbackPanel !== undefined
          ? `panel:${element.dataset.playbackPanel}`
          : `group:${element.dataset.playbackGroup}`;
      elements.set(id, [element]);
    }
    return elements;
  }
  const chartItems = host.querySelectorAll<HTMLElement | SVGElement>('[data-playback-item]');
  if (chartItems.length) {
    for (const element of chartItems) {
      const id = `item:${element.dataset.playbackItem}`;
      elements.set(id, [...(elements.get(id) ?? []), element]);
    }
    return elements;
  }
  if (scene.type === 'matrix' || scene.type === 'heatmap' || scene.type === 'security')
    host.querySelectorAll<HTMLElement>('tbody>tr').forEach((element, index) => {
      elements.set(`row:${index}`, [element]);
    });
  else if (scene.diagram) {
    return diagramElements(host, scene.diagram, scene.type === 'sequence');
  } else {
    const grouped = scene.groups.length > 0;
    host
      .querySelectorAll<HTMLElement>(grouped ? '.groups>section' : sceneItemSelector(scene))
      .forEach((element, index) => {
        elements.set(`${grouped ? 'group' : 'item'}:${index}`, [element]);
      });
  }
  const relation = host.querySelector<HTMLElement>('.relation');
  if (relation) elements.set('relation', [relation]);
  return elements;
}
