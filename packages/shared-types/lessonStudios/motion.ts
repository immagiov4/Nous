import { ARRIVE, MOVE } from './motionTiming';
import { StudioTimeline, setProperties } from './timeline';
import type { VectorNode } from './vectorScene';

export { ARRIVE, MOVE } from './motionTiming';

export const EXIT = { duration: 0.25, ease: 'power2.in' } as const;
export const FOCUS = { duration: 0.25, ease: MOVE.ease } as const;
export const STAGGER = 0.06;
export const DIM = 0.35;
export const RISE = 8;

export const timeline = () => new StudioTimeline();

export function markCalloutWindow(target: VectorNode, start: number, end: number) {
  target.data.calloutStart = String(start);
  target.data.calloutEnd = String(end);
}

export function appear(
  play: StudioTimeline,
  target: VectorNode,
  start: number | { normal: number; reduced: number },
  next = Infinity
) {
  const time = typeof start === 'number' ? start : start.normal;
  const reducedAt = typeof start === 'number' ? undefined : start.reduced;
  if (target.hasClass('callout')) markCalloutWindow(target, time, next);
  setProperties(target, { opacity: 0, y: RISE });
  // Very close anchors share less than a full entrance and exit.
  const span = next - time;
  const exit = Math.min(EXIT.duration, span / 3);
  play.to(
    target,
    { ...ARRIVE, duration: Math.min(ARRIVE.duration, span - exit), opacity: 1, y: 0, reducedAt },
    time
  );
  if (Number.isFinite(next))
    play.to(
      target,
      {
        ...EXIT,
        duration: exit,
        opacity: 0,
        reducedAt: reducedAt === undefined ? undefined : next,
      },
      next - exit
    );
}
