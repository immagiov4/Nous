import { StudioLayoutError } from './studioLayoutError';
import type { VectorNode } from './vectorScene';

export const MIN_TRACE_MOVE = 0.6;

type TraceMove = {
  start: number;
  end: number;
  firstStep: number;
  steps: number;
  starts?: number[];
};

type Pin = { index: number; time: number };

function addMove(times: number[], moves: TraceMove[], move: TraceMove) {
  const { start, end, firstStep, steps } = move;
  for (let step = 0; step < steps; step++) {
    times[firstStep + step] = start + ((end - start) * step) / steps;
  }
  moves.push(move);
}

function scheduleBetween(times: number[], moves: TraceMove[], from: Pin, to: Pin) {
  const span = to.time - from.time;
  const steps = to.index - from.index;
  if (steps <= 0 || span < 0) throw new StudioLayoutError('invalid-trace-pins');
  const slots = Math.min(steps, Math.max(1, Math.floor((span + 1e-9) / MIN_TRACE_MOVE)));
  for (let slot = 0; slot < slots; slot++) {
    const firstStep = from.index + Math.floor((slot * steps) / slots);
    const last = from.index + Math.floor(((slot + 1) * steps) / slots);
    addMove(times, moves, {
      firstStep,
      steps: last - firstStep,
      start: from.time + (slot * span) / slots,
      end: slot + 1 === slots ? to.time : from.time + ((slot + 1) * span) / slots,
    });
  }
}

/** Seconds. A zero-time pin with prerequisites cues their grouped move. Other pins stay fixed. */
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
    const finish = Math.min(MIN_TRACE_MOVE, next.time);
    // When the next pin ends this move, include every intervening state in it.
    const last = finish === next.time ? next.index : first.index + 1;
    addMove(times, moves, { start: 0, end: finish, firstStep: 0, steps: last });
    boundaries = [
      ...(last < next.index ? [{ index: last, time: finish }] : []),
      ...pins.slice(1),
      terminal,
    ];
  }
  for (const [i, from] of boundaries.slice(0, -1).entries()) {
    scheduleBetween(times, moves, from, boundaries[i + 1]);
  }
  mergeShortMoves(times, moves);
  return { times, moves };
}

function mergeShortMoves(times: number[], moves: TraceMove[]) {
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
}

export function tracePlayback(root: VectorNode, count: number, pins: Pin[], end: number) {
  const { times, moves } = scheduleTrace(count, pins, end);
  const existing: TraceMove[] = JSON.parse(root.data.traceMoves ?? '[]');
  root.data.traceMoves = JSON.stringify([...existing, ...moves]);
  return times;
}
