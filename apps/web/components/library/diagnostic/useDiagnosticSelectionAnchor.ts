import { useLayoutEffect, useRef, useState } from 'react';

function scrollContainer(element: HTMLElement): HTMLElement {
  let parent = element.parentElement;
  while (parent) {
    if (['auto', 'scroll'].includes(getComputedStyle(parent).overflowY)) return parent;
    parent = parent.parentElement;
  }
  return document.scrollingElement as HTMLElement;
}

/** Keeps the content below the active description in view as descriptions change height. */
export function useDiagnosticSelectionAnchor() {
  const [activeId, setActiveId] = useState<string | null>(null);
  const current = useRef<HTMLElement | null>(null);
  const pending = useRef<{
    target: HTMLElement;
    previous: HTMLElement | null;
    top: number;
    descriptionHeight: number;
  } | null>(null);

  useLayoutEffect(() => {
    const anchor = pending.current;
    pending.current = null;
    if (activeId === null || !anchor) return;
    const previousDescription = anchor.previous?.querySelector('.diagnostic-selection');
    const description = anchor.target.querySelector('.diagnostic-selection');
    if (!description) return;
    const scroller = scrollContainer(anchor.target);
    const portTop =
      scroller === document.scrollingElement
        ? 0
        : Math.max(0, scroller.getBoundingClientRect().top);
    const preservePosition = () => {
      const growth = description.getBoundingClientRect().height - anchor.descriptionHeight;
      const desiredTop = Math.max(portTop, anchor.top - growth);
      const displacement = anchor.target.getBoundingClientRect().top - desiredTop;
      if (displacement !== 0) {
        scroller.scrollTo({ top: scroller.scrollTop + displacement, behavior: 'instant' });
      }
    };
    // ResizeObserver runs before paint, including when reduced motion skips the transition.
    const observer = new ResizeObserver(preservePosition);
    if (previousDescription) observer.observe(previousDescription);
    observer.observe(description);
    preservePosition();
    const cancellation = new AbortController();
    const cancel = () => {
      observer.disconnect();
      cancellation.abort();
    };
    for (const event of ['wheel', 'pointercancel', 'pointerdown']) {
      document.addEventListener(
        event,
        event => {
          if (event.type === 'pointerdown' && anchor.target.contains(event.target as Node)) return;
          cancel();
        },
        {
          capture: true,
          passive: true,
          signal: cancellation.signal,
        }
      );
    }

    return cancel;
  }, [activeId]);

  function activate(id: string, control: HTMLElement) {
    if (activeId === id) return;
    pending.current = {
      target: control,
      previous: current.current,
      top: control.getBoundingClientRect().top,
      descriptionHeight:
        control.querySelector('.diagnostic-selection')?.getBoundingClientRect().height ?? 0,
    };
    current.current = control;
    setActiveId(id);
  }
  return { activeId, activate };
}
