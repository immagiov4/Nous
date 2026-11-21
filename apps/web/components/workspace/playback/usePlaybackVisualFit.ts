import { useLayoutEffect, useRef } from 'react';

/** Fit each visual independently. A scrollable card caps its height while keeping its text size. */
export function usePlaybackVisualFit(
  present: boolean,
  reportVerticalOverflow?: (overflowing: boolean) => void,
  studioCard = false
) {
  const cardRef = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    if (!present || studioCard) return;
    const card = cardRef.current;
    const stage = card?.closest<HTMLElement>('.listening-stage');
    // The saveable visual is also used independently of the playback stage.
    if (!card || !stage) return;
    const slot = card?.parentElement;
    const captions = stage?.querySelector<HTMLElement>('.captions');
    if (!slot || !captions) throw new Error('Playback stage must be mounted');
    const scrollport = card.querySelector<HTMLElement>('[data-ordered-scroll]');
    const content = scrollport ?? card;
    let scrollRange = 0;
    const updateScrollProgress = () => {
      if (scrollRange <= 0) return;
      const progress = Math.min(1, Math.max(0, content.scrollTop / scrollRange));
      card.style.setProperty('--ordered-scroll-progress', String(progress));
    };
    const fitScene = () => {
      const formulas = card.querySelectorAll('.katex:not(.spotlight-symbol .katex)');
      card.classList.toggle('lesson-player-formula', formulas.length === 1);
      const layout = getComputedStyle(stage);
      const padding =
        Number.parseFloat(layout.paddingTop) + Number.parseFloat(layout.paddingBottom);
      const availableHeight = stage.clientHeight - padding;
      if (!slot.clientWidth || availableHeight <= 0) return;
      if (reportVerticalOverflow)
        card.style.setProperty('--scene-height-limit', `${availableHeight}px`);
      card.style.width = `${slot.clientWidth}px`;
      const width = Math.max(card.offsetWidth, content.scrollWidth);
      card.style.width = `${width}px`;
      if (formulas.length) fitImagesAroundText(card, availableHeight);
      const contentHeight = Math.max(card.offsetHeight, content.scrollHeight);
      const height = reportVerticalOverflow
        ? Math.min(contentHeight, availableHeight)
        : contentHeight;
      if (reportVerticalOverflow) {
        scrollRange = content.scrollHeight - content.clientHeight;
        if (scrollRange > 0) {
          card.style.setProperty('--ordered-scroll-viewport', `${content.clientHeight}px`);
          card.style.setProperty(
            '--ordered-visible-fraction',
            String(content.clientHeight / content.scrollHeight)
          );
          updateScrollProgress();
        }
        reportVerticalOverflow(scrollRange > 0);
      }
      if (!width || !height) return;
      const scale = Math.min(1, slot.clientWidth / width, availableHeight / height);
      card.style.setProperty('--scene-scale', String(scale));
      card.style.setProperty('--scene-left', `${(slot.clientWidth - width * scale) / 2}px`);
      card.style.setProperty('--scene-top', `${(availableHeight - height * scale) / 2}px`);
      captions.style.setProperty('--caption-card-height', `${height * scale}px`);
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
    scrollport?.addEventListener('scroll', updateScrollProgress, { passive: true });
    document.fonts.addEventListener('loadingdone', fitScene);
    fitScene();
    return () => {
      observer.disconnect();
      mutations.disconnect();
      card.removeEventListener('load', fitScene, true);
      scrollport?.removeEventListener('scroll', updateScrollProgress);
      document.fonts.removeEventListener('loadingdone', fitScene);
      if (frame !== undefined) cancelAnimationFrame(frame);
    };
  }, [present, reportVerticalOverflow, studioCard]);
  return cardRef;
}

/** Images yield height before the whole visual scales its native formula typography. */
function fitImagesAroundText(card: HTMLElement, availableHeight: number) {
  const images = [...card.querySelectorAll<HTMLImageElement>('figure img')];
  for (const image of images) image.style.maxHeight = '';
  const heights = images.map(image => image.offsetHeight);
  const imageHeight = heights.reduce((sum, height) => sum + height, 0);
  if (!imageHeight) return;
  const textHeight = Math.max(card.offsetHeight, card.scrollHeight) - imageHeight;
  const imageScale = Math.min(1, Math.max(0, availableHeight - textHeight) / imageHeight);
  if (imageScale === 1) return;
  images.forEach((image, index) => {
    image.style.maxHeight = `${heights[index] * imageScale}px`;
    image.style.objectFit = 'contain';
  });
}
