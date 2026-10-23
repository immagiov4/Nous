import { type FormulaSpotlightData, resolveFormulaReferences } from '@shared/formulaSpotlight';
import type { PlaybackMotionEvent, PlaybackRange } from '@shared/lessonPlayback';
import { isAnimatedLessonScene, type LessonScene } from '@shared/lessonScene';
import { cueTimes, playbackMode } from '@shared/lessonSceneAnimation';
import { alignedRangeTime, type alignedWordTimes } from '@shared/playbackWordTiming';

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
  runs: readonly CaptionRun[];
  width: number;
  feather: number;
  duration: number;
  aligned?: ReturnType<typeof alignedWordTimes>;
  startOffset?: number;
}): number[] {
  return anchors.map(anchor => {
    const offset = speech.indexOf(anchor);
    if (offset < 0) throw new Error('Caption quotation must exist in speech');
    if (aligned)
      return alignedRangeTime(aligned, { start: offset, end: offset + anchor.length }).start * 1000;
    const first = runs[speechRanges.findIndex(word => word.end > offset)];
    if (!first) throw new Error('Caption quotation must cover caption words');
    return (startOffset + (first.start / (width + feather)) * duration) * 1000;
  });
}

/** The complete quoted span on the recording clock, including its final spoken word. */
export function captionAnchorSpan(input: Parameters<typeof captionAnchorTimes>[0]) {
  if (input.aligned) {
    const spans = input.anchors.map(anchor => {
      const start = input.speech.indexOf(anchor);
      if (start < 0) throw new Error('Caption quotation must exist in speech');
      return alignedRangeTime(input.aligned as NonNullable<typeof input.aligned>, {
        start,
        end: start + anchor.length,
      });
    });
    return {
      startMs: Math.min(...spans.map(span => span.start)) * 1000,
      endMs: Math.max(...spans.map(span => span.end)) * 1000,
    };
  }
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
    endMs:
      ((input.startOffset ?? 0) +
        ((last.start + last.width) / (input.width + input.feather)) * input.duration) *
      1000,
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
  runs: readonly CaptionRun[];
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
    const spokenDurationMs = aligned
      ? alignedRangeTime(aligned, { start: offset, end: offset + event.quote.length }).end * 1000 -
        atMs
      : ((last.start + last.width - first.start) / (width + feather)) * duration * 1000;
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

function motionUpdate(event: TimedMotionEvent, eventTime: number, reduced: boolean) {
  if (event.effect === 'reveal') {
    return { opacity: reduced ? 1 : smooth((eventTime - event.atMs) / event.durationMs) };
  }
  const focusDuration = Math.min(event.durationMs, MOTION_TIMING.maxFocusMs);
  if (!(event.effect === 'focus' && eventTime < event.atMs + focusDuration)) return {};
  const transition = Math.min(MOTION_TIMING.transitionMs, focusDuration / 2);
  return {
    emphasis: reduced
      ? 1
      : smooth((eventTime - event.atMs) / transition) *
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
    if (eventTime < event.atMs) continue;
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

/** Keep already presented cues stable when acoustic timing arrives during playback. */
export function adoptCueTimes(
  previous: readonly number[] | undefined,
  next: number[],
  time: number
) {
  return next.map((onset, index) => {
    const estimated = previous?.[index];
    return estimated !== undefined && estimated <= time ? estimated : onset;
  });
}
