import { MIN_TRACE_MOVE, tracePlayback } from './stagedTrace';
import type { VectorNode } from './vectorScene';

const OPENING_GRAPH_CUE_DEADLINE = 0.45;

/** Resolve named cues against the ordered engine trace. */
export function traceTimes(
  root: VectorNode,
  events: string[],
  beats: string[],
  times: number[],
  end: number
) {
  const pins = beats.map((event, i) => ({ index: events.indexOf(event), time: times[i] }));
  const first = pins[0];
  if (first?.time === 0 && first.index > 0) {
    const next = pins[1] ?? { index: events.length, time: end };
    // The opening group includes all intervening steps when the next cue ends it.
    const finish = Math.min(MIN_TRACE_MOVE, next.time);
    const steps = finish === next.time ? next.index : first.index + 1;
    if ((finish * first.index) / steps > OPENING_GRAPH_CUE_DEADLINE)
      first.time = OPENING_GRAPH_CUE_DEADLINE;
  }
  return tracePlayback(root, events.length, pins, end);
}
