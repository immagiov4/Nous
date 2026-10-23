import { type FormulaSpotlightData, resolveFormulaReferences } from '@shared/formulaSpotlight';
import type {
  LessonPlaybackBlock,
  PlaybackMotionEvent,
  PlaybackRange,
  PlaybackVisual,
} from '@shared/lessonPlayback';
import { isAnimatedLessonScene, type LessonScene } from '@shared/lessonScene';
import { cueTimes, playbackMode } from '@shared/lessonSceneAnimation';

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
export interface CaptionRun {
  span: HTMLElement;
  start: number;
  width: number;
}
export interface TimedMotionEvent extends PlaybackMotionEvent {
  atMs: number;
  durationMs: number;
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

/** Project a saved narration range onto the voice estimate, preserving repeated occurrences. */
export function captionRangeSpan({
  range,
  speechRanges,
  runs,
  width,
  feather,
  duration,
}: {
  range: PlaybackRange;
  speechRanges: readonly PlaybackRange[];
  runs: readonly CaptionRun[];
  width: number;
  feather: number;
  duration: number;
}) {
  const first = runs[speechRanges.findIndex(word => word.end > range.start)];
  const lastIndex = speechRanges.reduce(
    (last, word, index) => (word.start < range.end ? index : last),
    0
  );
  const last = runs[lastIndex];
  if (!first || !last) throw new Error('Visual narration range must cover caption words');
  return {
    startMs: (first.start / (width + feather)) * duration * 1000,
    endMs: ((last.start + last.width) / (width + feather)) * duration * 1000,
  };
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
    cues = scene.type === 'guided-path' ? scene.steps : scene.cues;
  }
  if (!cues) return undefined;
  try {
    cueTimes(speech, cues);
  } catch {
    return undefined;
  }
  return cues.map(cue => cue.anchor as string);
}

/** Resolves exact anchors on the caption clock, including anchors in the spoken heading. */
export function captionAnchorTimes({
  anchors,
  speech,
  speechRanges,
  runs,
  width,
  feather,
  duration,
}: {
  anchors: readonly string[];
  speech: string;
  speechRanges: readonly PlaybackRange[];
  runs: readonly CaptionRun[];
  width: number;
  feather: number;
  duration: number;
}): number[] {
  return anchors.map(anchor => {
    const offset = speech.indexOf(anchor);
    if (offset < 0) throw new Error('Caption quotation must exist in speech');
    const first = runs[speechRanges.findIndex(word => word.end > offset)];
    if (!first) throw new Error('Caption quotation must cover caption words');
    return (first.start / (width + feather)) * duration * 1000;
  });
}

/** The complete quoted span, on the same measured clock as the caption reveal and scene cues. */
export function captionAnchorSpan(input: Parameters<typeof captionAnchorTimes>[0]) {
  const times = captionAnchorTimes(input);
  const endOffset = Math.max(
    ...input.anchors.map(anchor => input.speech.indexOf(anchor) + anchor.length)
  );
  const lastIndex = input.speechRanges.reduce(
    (last, word, index) => (word.start < endOffset ? index : last),
    0
  );
  // A heading quotation precedes the body; like motion cues, project it onto the first word.
  const last = input.runs[lastIndex];
  if (!last) throw new Error('Caption quotation must cover caption words');
  return {
    startMs: Math.min(...times),
    endMs: ((last.start + last.width) / (input.width + input.feather)) * input.duration * 1000,
  };
}

/** The API stores quotations; resolve them to the same word-width clock as listen.mjs. */
export function captionMotionEvents({
  events,
  speech,
  speechRanges,
  runs,
  width,
  feather,
  duration,
}: {
  events: readonly PlaybackMotionEvent[];
  speech: string;
  speechRanges: readonly PlaybackRange[];
  runs: readonly CaptionRun[];
  width: number;
  feather: number;
  duration: number;
}): TimedMotionEvent[] {
  const times = captionAnchorTimes({
    anchors: events.map(event => event.quote),
    speech,
    speechRanges,
    runs,
    width,
    feather,
    duration,
  });
  const timed = events.map((event, index) => {
    const offset = speech.indexOf(event.quote);
    if (offset < 0) throw new Error('Motion quotation must exist in speech');
    // Headings precede the body clock: project their anchors onto its zero boundary.
    const firstIndex = speechRanges.findIndex(word => word.end > offset);
    const endIndex = speechRanges.reduce(
      (last, word, index) => (word.start < offset + event.quote.length ? index : last),
      0
    );
    const first = runs[firstIndex];
    const last = runs[endIndex];
    if (!first || !last) throw new Error('Motion quotation must cover caption words');
    const atMs = times[index];
    const durationMs =
      event.effect === 'reveal'
        ? REVEAL_DURATION_MS
        : Math.max(
            MOTION_TIMING.holdMs,
            ((last.start + last.width - first.start) / (width + feather)) * duration * 1000
          );
    return { ...event, atMs, durationMs };
  });
  return timed.map(event => ({
    ...event,
    durationMs: Math.min(
      event.durationMs,
      (timed.find(next => next.atMs > event.atMs)?.atMs ?? duration * 1000) - event.atMs
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

function motionUpdate(event: TimedMotionEvent, eventTime: number, reduced: boolean) {
  if (event.effect === 'reveal') {
    return {
      opacity: reduced ? 1 : smooth((eventTime - event.atMs + event.durationMs) / event.durationMs),
    };
  }
  const focusDuration = Math.min(event.durationMs, MOTION_TIMING.maxFocusMs);
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
    const nodes = Array.from(host.querySelectorAll<SVGElement>('g.node'));
    scene.diagram.nodes.forEach((node, index) => {
      const element = nodes.find(element => element.id.includes(`flowchart-n${index}-`));
      if (element) elements.set(`node:${node.id}`, [element]);
    });
    host.querySelectorAll<SVGElement>('path.flowchart-link').forEach((element, index) => {
      elements.set(`edge:${index}`, [element]);
    });
  } else {
    const grouped = scene.groups.length > 0;
    host
      .querySelectorAll<HTMLElement>(
        grouped ? '.groups>section' : (ITEM_SELECTORS[scene.type] ?? '.visual-content .concept')
      )
      .forEach((element, index) => {
        elements.set(`${grouped ? 'group' : 'item'}:${index}`, [element]);
      });
  }
  const relation = host.querySelector<HTMLElement>('.relation');
  if (relation) elements.set('relation', [relation]);
  return elements;
}
