/** Duration shared with the source carousel book resize in sourceShelf.css. */
export const CAROUSEL_GLIDE_MS = 850;
// Ease in and out as the books resize, with a slow start and finish.
const easeInOutCubic = (t: number) => (t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2);

const active = new WeakMap<HTMLElement, () => void>();

/**
 * Scrolls horizontally with a known duration and curve, unlike native smooth scrolling,
 * so the track can move in step with CSS transitions. User input cancels the glide.
 */
export function glideScrollBy(element: HTMLElement, left: number, duration = CAROUSEL_GLIDE_MS) {
  active.get(element)?.();
  const start = element.scrollLeft;
  // A CSS smooth scroll-behavior would animate every per-frame assignment on its own.
  element.style.scrollBehavior = 'auto';
  const begin = performance.now();
  let frame = 0;
  const cancel = () => {
    cancelAnimationFrame(frame);
    element.removeEventListener('wheel', cancel);
    element.removeEventListener('pointerdown', cancel);
    if (active.get(element) === cancel) {
      active.delete(element);
      element.style.scrollBehavior = '';
    }
  };
  const step = (now: number) => {
    const progress = Math.min(1, (now - begin) / duration);
    element.scrollLeft = start + left * easeInOutCubic(progress);
    if (progress < 1) frame = requestAnimationFrame(step);
    else cancel();
  };
  element.addEventListener('wheel', cancel, { passive: true });
  element.addEventListener('pointerdown', cancel);
  active.set(element, cancel);
  frame = requestAnimationFrame(step);
  return cancel;
}
