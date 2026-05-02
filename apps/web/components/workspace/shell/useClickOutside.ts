import { type RefObject, useEffect } from 'react';

/**
 * Calls `onClickOutside` when a pointerdown event occurs outside the
 * referenced element. Only active when `isEnabled` is true.
 */
export const useClickOutside = (
  ref: RefObject<HTMLElement | null>,
  isEnabled: boolean,
  onClickOutside: () => void
): void => {
  useEffect(() => {
    if (!isEnabled) {
      return;
    }

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node) || ref.current?.contains(target)) {
        return;
      }

      onClickOutside();
    };

    document.addEventListener('pointerdown', handlePointerDown, true);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown, true);
    };
  }, [isEnabled, onClickOutside, ref]);
};
