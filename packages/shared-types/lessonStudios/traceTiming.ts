import type { arrayTrace } from './arrayAlgorithm';
import type { heapTrace } from './heap';
import { ARRIVE, MOVE } from './motion';

type Event = ReturnType<typeof arrayTrace>[number];

export function arrayEventTimes(events: Event[], indices: number[], beats: number[], end: number) {
  const marks = indices.map((index, i) => {
    const event = events[index];
    if (event.kind === 'no-swap-pass') {
      const first = events.findIndex(step => step.kind === 'compare' && step.pass === event.pass);
      // Start the final pass on its narration cue and leave the verdict at the end of the sweep.
      index = Math.max(first, (indices[i - 1] ?? -1) + 1);
    }
    return { index, time: beats[i] / 1000 };
  });
  marks.unshift({ index: -1, time: 0 });
  const last = marks.at(-1)!;
  if (last.index < events.length - 1) {
    const finish =
      events[last.index]?.kind === 'no-swap-pass' ? MOVE.duration + ARRIVE.duration : MOVE.duration;
    marks.push({
      index: events.length - 1,
      time: Math.max(end - MOVE.duration, Math.min(end, last.time + finish)),
    });
  }

  const times: number[] = [];
  for (let i = 1; i < marks.length; i++) {
    const from = marks[i - 1],
      to = marks[i];
    const weights = events
      .slice(Math.max(0, from.index), to.index)
      .map(step =>
        step.kind === 'no-swap-pass' ? MOVE.duration + ARRIVE.duration : MOVE.duration
      );
    if (from.index < 0) weights.unshift(MOVE.duration);
    const span = to.time - from.time;
    const preferred = weights.reduce((sum, weight) => sum + weight, 0);
    const factor = Math.min(1, span / preferred);
    const pause = (span - preferred * factor) / weights.length;
    let time = from.time;
    weights.forEach((weight, offset) => {
      time += pause + weight * factor;
      times[from.index + 1 + offset] = time;
    });
  }
  return times;
}

/** Bind named trace events to narration, distributing the intervening engine steps. */
function traceTimes(events: string[], beats: string[], times: number[], end: number) {
  const last = events.length - 1;
  const fixed = new Map<number, number>([[0, 0]]);
  beats.forEach((event, i) => fixed.set(events.indexOf(event), times[i]));
  if (!fixed.has(last)) {
    fixed.set(last, Math.max([...fixed.values()].at(-1)!, end - MOVE.duration));
  }
  const anchors = [...fixed.entries()];
  return events.map((_, i) => {
    const right = anchors.findIndex(([at]) => at >= i);
    const [to, finish] = anchors[right];
    if (to === i) return finish;
    const [from, begin] = anchors[right - 1];
    return begin + ((finish - begin) * (i - from)) / (to - from);
  });
}

export function heapEventTimes(
  steps: ReturnType<typeof heapTrace>,
  events: string[],
  beatTimesMs: number[],
  end: number
) {
  const names = steps.map(step => step.event);
  const cues = events.map(event =>
    event.startsWith('sift#') ? names[names.indexOf(event) - 1] : event
  );
  return traceTimes(
    names,
    cues,
    beatTimesMs.map(ms => ms / 1000),
    end
  );
}
