import type { VectorNode } from './vectorScene';

const MIN_TRACE_MOVE = 0.6;

type TraceMove = {
  start: number;
  end: number;
  firstStep: number;
  steps: number;
  starts?: number[];
};

type Pin = { index: number; time: number };

/** Seconds. Pins are fixed. A packed move still visits each constituent state in order. */
function scheduleTrace(count: number, pins: Pin[], end: number) {
  if (count === 0) return { times: [], moves: [] };
  const times = new Array<number>(count);
  const moves: TraceMove[] = [];
  const first = pins[0];
  const terminal = { index: count, time: end };
  let boundaries = [...(first?.index === 0 ? [] : [{ index: 0, time: 0 }]), ...pins, terminal];
  if (first?.time === 0 && first.index > 0) {
    // A zero-time cue with prerequisites starts one grouped move at zero.
    const next = pins[1] ?? terminal;
    const last = first.index + 1;
    const finish = Math.min(MIN_TRACE_MOVE, next.time);
    for (let step = 0; step < last; step++) times[step] = (finish * step) / last;
    moves.push({ start: 0, end: finish, firstStep: 0, steps: last });
    boundaries = [
      ...(last < next.index ? [{ index: last, time: finish }] : []),
      ...pins.slice(1),
      terminal,
    ];
  }
  for (const [i, from] of boundaries.slice(0, -1).entries()) {
    const to = boundaries[i + 1];
    const span = to.time - from.time;
    const steps = to.index - from.index;
    if (steps <= 0 || span < 0)
      throw new Error('Trace pins must be in step order and inside playback');
    const slots = Math.min(steps, Math.max(1, Math.floor((span + 1e-9) / MIN_TRACE_MOVE)));
    for (let slot = 0; slot < slots; slot++) {
      const firstStep = from.index + Math.floor((slot * steps) / slots);
      const last = from.index + Math.floor(((slot + 1) * steps) / slots);
      const start = from.time + (slot * span) / slots;
      const finish = from.time + ((slot + 1) * span) / slots;
      moves.push({ start, end: finish, firstStep, steps: last - firstStep });
      for (let step = firstStep; step < last; step++) {
        times[step] = start + ((finish - start) * (step - firstStep)) / (last - firstStep);
      }
    }
  }
  for (let i = 0; i < moves.length && moves.length > 1; i++) {
    const move = moves[i];
    if (move.end - move.start + 1e-9 >= MIN_TRACE_MOVE) continue;
    const index = i > 0 ? i - 1 : i;
    const [before, after] = moves.slice(index, index + 2);
    if (before.end !== after.start) continue;
    const firstStep = before.firstStep;
    const steps = before.steps + after.steps;
    moves.splice(index, 2, {
      start: before.start,
      end: after.end,
      firstStep,
      steps,
      starts: times.slice(firstStep, firstStep + steps),
    });
    i = index - 1;
  }
  return { times, moves };
}

export function tracePlayback(root: VectorNode, count: number, pins: Pin[], end: number) {
  const { times, moves } = scheduleTrace(count, pins, end);
  const existing: TraceMove[] = JSON.parse(root.data.traceMoves ?? '[]');
  root.data.traceMoves = JSON.stringify([...existing, ...moves]);
  return times;
}
