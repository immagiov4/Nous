import { useEffect, useState } from 'react';

/**
 * Tracks the visible viewport and how many pixels of the layout viewport are
 * currently covered by the on-screen keyboard.
 *
 * `keyboardOffset` is non-zero only when the layout viewport stays full-size
 * while the visual viewport shrinks (older Chrome/Safari without
 * `interactive-widget=resizes-content`). When the layout viewport itself
 * shrinks (Firefox Android, or modern browsers honoring `resizes-content`)
 * the offset is 0 because `position: fixed; bottom: X` already floats above
 * the keyboard on its own.
 *
 * @returns `viewportHeight` — pixel height of the visible area (null during SSR).
 * @returns `keyboardOffset` — extra pixels to add to `bottom` of fixed panels.
 */
export function useMobileKeyboardOffset() {
  const [viewportHeight, setViewportHeight] = useState<number | null>(null);
  const [keyboardOffset, setKeyboardOffset] = useState(0);

  useEffect(() => {
    if (typeof globalThis.window === 'undefined') {
      return;
    }

    const vv = globalThis.visualViewport;

    const update = () => {
      const layoutHeight = globalThis.innerHeight;
      const visualHeight = vv ? vv.height : layoutHeight;
      const visibleHeight = Math.min(visualHeight, layoutHeight);

      const offset = vv ? Math.max(0, layoutHeight - vv.height - (vv.offsetTop || 0)) : 0;

      setViewportHeight(visibleHeight);
      setKeyboardOffset(offset);
    };

    update();

    globalThis.addEventListener('resize', update);
    globalThis.addEventListener('orientationchange', update);
    if (vv) {
      vv.addEventListener('resize', update);
      vv.addEventListener('scroll', update);
    }

    return () => {
      globalThis.removeEventListener('resize', update);
      globalThis.removeEventListener('orientationchange', update);
      if (vv) {
        vv.removeEventListener('resize', update);
        vv.removeEventListener('scroll', update);
      }
    };
  }, []);

  // Publish the current keyboard offset as a CSS variable on <html> so any
  // element can lift itself above the keyboard via
  // `padding-bottom: var(--keyboard-inset, 0px)` etc.
  useEffect(() => {
    if (typeof document === 'undefined') {
      return;
    }
    document.documentElement.style.setProperty('--keyboard-inset', `${keyboardOffset}px`);
  }, [keyboardOffset]);

  return { viewportHeight, keyboardOffset };
}
