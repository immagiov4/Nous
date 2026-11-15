import { useLayoutEffect, useRef } from 'react';

/** Fit each current or departing visual independently, before its pixels become visible. */
export function usePlaybackVisualFit(present: boolean) {
  const cardRef = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    if (!present) return;
    const card = cardRef.current;
    const stage = card?.closest<HTMLElement>('.listening-stage');
    // The saveable visual is also used independently of the playback stage.
    if (!card || !stage) return;
    const slot = card?.parentElement;
    const captions = stage?.querySelector('.captions');
    if (!slot || !captions) throw new Error('Playback stage must be mounted');
    const fitScene = () => {
      const formulas = card.querySelectorAll('.katex:not(.spotlight-symbol .katex)');
      card.classList.toggle('lesson-player-formula', formulas.length === 1);
      const layout = getComputedStyle(stage);
      const padding =
        Number.parseFloat(layout.paddingTop) + Number.parseFloat(layout.paddingBottom);
      const availableHeight = stage.clientHeight - padding;
      if (!slot.clientWidth || availableHeight <= 0) return;
      card.style.width = `${slot.clientWidth}px`;
      const width = Math.max(card.offsetWidth, card.scrollWidth);
      card.style.width = `${width}px`;
      const height = Math.max(card.offsetHeight, card.scrollHeight);
      if (!width || !height) return;
      const scale = Math.min(1, slot.clientWidth / width, availableHeight / height);
      card.style.setProperty('--scene-scale', String(scale));
      card.style.setProperty('--scene-left', `${(slot.clientWidth - width * scale) / 2}px`);
      card.style.setProperty('--scene-top', `${(availableHeight - height * scale) / 2}px`);
      // Keep the viewport fixed while independently fitted outgoing/current cards overlap.
      slot.style.height = `${availableHeight}px`;
      slot.style.setProperty('--scene-scale', String(scale));
    };
    let frame: number | undefined;
    const schedule = () => {
      frame ??= requestAnimationFrame(() => {
        frame = undefined;
        fitScene();
      });
    };
    const observer = new ResizeObserver(schedule);
    for (const element of [slot, card, stage, captions]) observer.observe(element);
    const mutations = new MutationObserver(fitScene);
    mutations.observe(card, {
      childList: true,
      characterData: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['hidden', 'src', 'width', 'height'],
    });
    // Image decoding changes intrinsic layout without a React commit. Fit before that paint.
    card.addEventListener('load', fitScene, true);
    document.fonts.addEventListener('loadingdone', fitScene);
    fitScene();
    return () => {
      observer.disconnect();
      mutations.disconnect();
      card.removeEventListener('load', fitScene, true);
      document.fonts.removeEventListener('loadingdone', fitScene);
      if (frame !== undefined) cancelAnimationFrame(frame);
    };
  }, [present]);
  return cardRef;
}
