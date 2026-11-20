import { tracePlayback } from './stagedTrace';
import type { VectorNode } from './vectorScene';

/** Resolve named cues against the ordered engine trace. */
export function traceTimes(
  root: VectorNode,
  events: string[],
  beats: string[],
  times: number[],
  end: number
) {
  return tracePlayback(
    root,
    events.length,
    beats.map((event, i) => ({
      index: events.indexOf(event),
      time: times[i],
    })),
    end
  );
}
