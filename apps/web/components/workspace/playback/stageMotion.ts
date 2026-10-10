import type { PlaybackMotionEvent, PlaybackRange } from '@shared/lessonPlayback';
import type { LessonScene } from '@shared/lessonScene';

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
  const timed = events.map(event => {
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
    const atMs = (first.start / (width + feather)) * duration * 1000;
    const durationMs =
      event.effect === 'reveal'
        ? REVEAL_DURATION_MS
        : Math.max(
            MOTION_TIMING.holdMs,
            ((last.start + last.width - first.start) / (width + feather)) * duration * 1000
          );
    return { ...event, atMs, durationMs };
  });
  return timed.map((event, index) => ({
    ...event,
    durationMs: Math.min(
      event.durationMs,
      (timed[index + 1]?.atMs ?? duration * 1000) - event.atMs
    ),
  }));
}

export const smooth = (fraction: number) => {
  const time = Math.max(0, Math.min(1, fraction));
  return time * time * (3 - 2 * time);
};

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
    for (const target of event.targets) {
      const state = states.get(target);
      if (!state) throw new Error(`Motion target is unavailable: ${target}`);
      if (event.effect === 'reveal')
        state.opacity = reduced ? 1 : smooth((eventTime - event.atMs) / event.durationMs);
      const focusDuration = Math.min(event.durationMs, MOTION_TIMING.maxFocusMs);
      if (event.effect === 'focus' && eventTime < event.atMs + focusDuration) {
        const transition = Math.min(MOTION_TIMING.transitionMs, focusDuration / 2);
        state.emphasis = reduced
          ? 1
          : smooth((eventTime - event.atMs) / transition) *
            smooth((event.atMs + focusDuration - eventTime) / transition);
      }
    }
  }
  return states;
}

export function sceneElements(host: HTMLElement, scene: LessonScene) {
  const elements = new Map<string, HTMLElement | SVGElement>();
  if (scene.type === 'matrix')
    host.querySelectorAll<HTMLElement>('tbody>tr').forEach((element, index) => {
      elements.set(`row:${index}`, element);
    });
  else if (scene.diagram) {
    const nodes = Array.from(host.querySelectorAll<SVGElement>('g.node'));
    scene.diagram.nodes.forEach((node, index) => {
      const element = nodes.find(element => element.id.includes(`flowchart-n${index}-`));
      if (element) elements.set(`node:${node.id}`, element);
    });
    host.querySelectorAll<SVGElement>('path.flowchart-link').forEach((element, index) => {
      elements.set(`edge:${index}`, element);
    });
  } else {
    const grouped = scene.groups.length > 0;
    host
      .querySelectorAll<HTMLElement>(
        grouped ? '.groups>section' : (ITEM_SELECTORS[scene.type] ?? '.visual-content .concept')
      )
      .forEach((element, index) => {
        elements.set(`${grouped ? 'group' : 'item'}:${index}`, element);
      });
  }
  const relation = host.querySelector<HTMLElement>('.relation');
  if (relation) elements.set('relation', relation);
  return elements;
}
