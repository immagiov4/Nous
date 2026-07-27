import { useEffect, useState } from 'react';
import { subscribeToMediaQuery } from '../mediaQuery.ts';

const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

const readShouldAnimate = (): boolean => {
  if (typeof globalThis.window === 'undefined' || typeof globalThis.matchMedia !== 'function') {
    return true;
  }

  return !globalThis.matchMedia(REDUCED_MOTION_QUERY).matches;
};

/**
 * Returns whether animations should play. Honors `prefers-reduced-motion`.
 *
 * Use this to conditionally skip `whileHover` / `whileTap` effects or to
 * short-circuit springs to simple fades on reduced-motion user preferences.
 */
export const useShouldAnimate = (): boolean => {
  const [shouldAnimate, setShouldAnimate] = useState(readShouldAnimate);

  useEffect(() => {
    if (typeof globalThis.window === 'undefined' || typeof globalThis.matchMedia !== 'function') {
      return;
    }

    const mediaQueryList = globalThis.matchMedia(REDUCED_MOTION_QUERY);
    return subscribeToMediaQuery(mediaQueryList, event => {
      setShouldAnimate(!event.matches);
    });
  }, []);

  return shouldAnimate;
};
