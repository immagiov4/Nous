import { CAPTION_SCROLL } from './captionFormat.ts';

type CaptionRow = { top: number; bottom: number; inkTop: number; inkBottom: number };

function measureRows(paragraph: HTMLElement, origin: number, scale: number) {
  const rows: CaptionRow[] = [];
  const words = new Map<HTMLElement, CaptionRow>();
  for (const word of paragraph.querySelectorAll<HTMLElement>('.caption-word')) {
    const box = word.getBoundingClientRect();
    const text = word.firstElementChild;
    if (!text) throw new Error('Caption words must contain text');
    const ink = text.getBoundingClientRect();
    const top = (box.top - origin) / scale;
    const previous = rows.at(-1);
    // Inline code can sit on a different baseline within the same overlapping row.
    const row =
      previous && top < previous.bottom
        ? previous
        : { top, bottom: top, inkTop: Infinity, inkBottom: -Infinity };
    if (row !== previous) rows.push(row);
    row.top = Math.min(row.top, top);
    row.bottom = Math.max(row.bottom, (box.bottom - origin) / scale);
    row.inkTop = Math.min(row.inkTop, (ink.top - origin) / scale);
    row.inkBottom = Math.max(row.inkBottom, (ink.bottom - origin) / scale);
    words.set(word, row);
  }
  return { rows, words };
}

/** Measure once per layout and exclude partial rows throughout native smooth scrolling. */
export function captionViewport(paragraph: HTMLElement) {
  paragraph.scrollTop = 0;
  const bounds = paragraph.getBoundingClientRect();
  const scale = bounds.width / Number.parseFloat(getComputedStyle(paragraph).width);
  const { rows, words } = measureRows(paragraph, bounds.top, scale);
  const first = words.keys().next().value;
  const firstTop = first ? (first.getBoundingClientRect().top - bounds.top) / scale : 0;
  const height = bounds.height / scale;
  let previousLine: CaptionRow | undefined;
  let target = 0;
  let previousClip = '';
  let previousOffset: number | undefined;
  let previousScrollTop: number | undefined;
  const clip = () => {
    if (!first || paragraph.scrollTop === previousScrollTop) return;
    previousScrollTop = paragraph.scrollTop;
    // Rectangles retain fractional scroll positions, including Firefox's device-pixel rounding.
    const offset =
      (paragraph.getBoundingClientRect().top - first.getBoundingClientRect().top) / scale +
      firstTop;
    if (offset === previousOffset) return;
    previousOffset = offset;
    let top = 0;
    let bottom = 0;
    for (const row of rows) {
      if (row.inkTop < offset && row.inkBottom > offset) top = Math.max(top, row.bottom - offset);
      if (row.inkBottom > offset + height && row.inkTop < offset + height)
        bottom = Math.max(bottom, offset + height - row.top);
    }
    const inset = `inset(${top}px 0 ${bottom}px 0)`;
    if (inset !== previousClip) {
      paragraph.style.clipPath = inset;
      previousClip = inset;
    }
  };
  clip();
  return {
    clip,
    follow(active: HTMLElement | undefined, motion: boolean) {
      const row = active ? words.get(active) : rows[0];
      if (!row || row === previousLine) return;
      if (row.top < target || row.bottom > target + height * CAPTION_SCROLL.trigger) {
        const destination = row.top - height * CAPTION_SCROLL.destination;
        target = Math.max(0, ...rows.filter(line => line.top <= destination).map(line => line.top));
        paragraph.scrollTo({ top: target, behavior: motion ? 'smooth' : 'instant' });
      }
      previousLine = row;
      clip();
    },
  };
}
