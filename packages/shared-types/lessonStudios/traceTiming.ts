import type { arrayTrace } from './arrayAlgorithm';
import type { heapTrace } from './heap';
import { ARRIVE, MOVE } from './motion';

type Event = ReturnType<typeof arrayTrace>[number];
export const MAX_STUDIO_CUE_LAG_MS = 450;

export const openingCueDelay = (nextCueMs: number) =>
  Math.min(MAX_STUDIO_CUE_LAG_MS, nextCueMs / 2);

export function arrayEventTimes(events: Event[], indices: number[], beats: number[], end: number) {
  const marks = indices.map((index, i) => ({ index, time: beats[i] / 1000 }));
  const opening = marks[0];
  if (opening?.time === 0 && opening.index > 0) {
    // Make room for earlier steps while keeping the next narration cue in place.
    opening.time = openingCueDelay(beats[1] ?? end * 1000) / 1000;
  }
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
      times[from.index + 1 + offset] = offset === weights.length - 1 ? to.time : time;
    });
  }
  return times;
}

/** Bind named trace events to narration, distributing the intervening engine steps. */
function traceTimes(events: string[], beats: string[], beatTimesMs: number[], end: number) {
  const last = events.length - 1;
  const fixed = new Map<number, number>([[0, 0]]);
  beats.forEach((event, i) => {
    const index = events.indexOf(event);
    const time = beatTimesMs[i];
    const start =
      i === 0 && time === 0 && index > 0 ? openingCueDelay(beatTimesMs[1] ?? end * 1000) : time;
    fixed.set(index, start / 1000);
  });
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
  return traceTimes(
    steps.map(step => step.event),
    events,
    beatTimesMs,
    end
  );
}
