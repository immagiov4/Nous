import type { Transition, Variants } from 'framer-motion';

/**
 * Motion tokens for Nous Reader.
 *
 * Keep durations short (≤ 260ms) and springs on the soft side.
 * Animations should feel snappy and elegant, never theatrical.
 *
 * Respecting `prefers-reduced-motion` is handled by `useShouldAnimate()`
 * through `useShouldAnimate()`, not here.
 */

const MOTION_DURATION = {
  micro: 0.08,
  short: 0.12,
  base: 0.15,
  medium: 0.18,
} as const;

const MOTION_EASING = {
  standard: [0.22, 0.9, 0.25, 1] as const,
  exit: [0.4, 0, 1, 1] as const,
  entry: [0, 0, 0.2, 1] as const,
} as const;

/**
 * Soft pop — subtle bounce, used for dialogs.
 * Uses a CSS tween instead of a spring: springs are poorly optimized on
 * Firefox and cause visible jank when the main thread is busy.
 */
const SPRING_SOFT_POP: Transition = {
  duration: 0.14,
  ease: MOTION_EASING.standard,
};

/**
 * Tap press — buttons/cards active feedback.
 */
export const SPRING_TAP: Transition = {
  duration: 0.08,
  ease: MOTION_EASING.standard,
};

/**
 * Quick fade — backdrops, cross-fades between views.
 */
const TRANSITION_FADE: Transition = {
  duration: MOTION_DURATION.short,
  ease: MOTION_EASING.standard,
};

/**
 * Dialog content pop: appears at ~0.96 scale with a soft spring.
 */
export const VARIANTS_DIALOG: Variants = {
  hidden: { opacity: 0, scale: 0.96, y: 8 },
  visible: {
    opacity: 1,
    scale: 1,
    y: 0,
    transition: SPRING_SOFT_POP,
  },
  exit: {
    opacity: 0,
    scale: 0.97,
    y: 4,
    transition: { duration: MOTION_DURATION.short, ease: MOTION_EASING.exit },
  },
};

/**
 * Backdrop fade for modal overlays.
 */
export const VARIANTS_BACKDROP: Variants = {
  hidden: { opacity: 0 },
  visible: { opacity: 1, transition: TRANSITION_FADE },
  exit: { opacity: 0, transition: { duration: MOTION_DURATION.micro, ease: MOTION_EASING.exit } },
};

/**
 * Tap scale target used with `whileTap` on pressable elements.
 */
export const TAP_SCALE = 0.96;
