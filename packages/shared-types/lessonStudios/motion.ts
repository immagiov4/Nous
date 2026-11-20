import { StudioTimeline, setProperties } from './timeline';
import type { VectorNode } from './vectorScene';

export const ARRIVE = { duration: 0.4, ease: 'power3.out' } as const;
export const EXIT = { duration: 0.25, ease: 'power2.in' } as const;
export const MOVE = { duration: 0.5, ease: 'power2.inOut' } as const;
export const FOCUS = { duration: 0.25, ease: MOVE.ease } as const;
export const DIM = 0.35;
const RISE = 8;

export const timeline = () => new StudioTimeline();

function markCalloutWindow(target: VectorNode, start: number, end: number) {
  target.setAttribute('data-callout-start', String(start));
  target.setAttribute('data-callout-end', String(end));
}

export function appear(play: StudioTimeline, target: VectorNode, time: number, next = Infinity) {
  if (target.hasClass('callout')) markCalloutWindow(target, time, next);
  setProperties(target, { opacity: 0, y: RISE });
  // Very close anchors share less than a full entrance and exit.
  const span = next - time;
  const exit = Math.min(EXIT.duration, span / 3);
  play.to(
    target,
    { ...ARRIVE, duration: Math.min(ARRIVE.duration, span - exit), opacity: 1, y: 0 },
    time
  );
  if (Number.isFinite(next)) play.to(target, { ...EXIT, duration: exit, opacity: 0 }, next - exit);
}
