import { useEffect, useState } from 'react';
import { subscribeToMediaQuery } from '../dom/mediaQuery.ts';

const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

const readShouldAnimate = (): boolean => {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return true;
  }

  return !window.matchMedia(REDUCED_MOTION_QUERY).matches;
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
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return;
    }

    const mediaQueryList = window.matchMedia(REDUCED_MOTION_QUERY);
    setShouldAnimate(!mediaQueryList.matches);

    return subscribeToMediaQuery(mediaQueryList, event => {
      setShouldAnimate(!event.matches);
    });
  }, []);

  return shouldAnimate;
};
