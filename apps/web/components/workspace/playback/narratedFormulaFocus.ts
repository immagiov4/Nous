import type { getPlaybackFormulaCard } from '@shared/lessonPlayback';
import { alignedRangeTime, type alignedWordTimes } from '@shared/playbackWordTiming';
import { type RefObject, useLayoutEffect } from 'react';

type FormulaRow = NonNullable<ReturnType<typeof getPlaybackFormulaCard>>['rows'][number];
type AlignedWords = NonNullable<ReturnType<typeof alignedWordTimes>>;

export const NARRATED_FORMULA_CLASS = 'playback-narrated-formulas';
const CURRENT_FORMULA = 'data-playback-formula-current';

/** Match the rendered group to its source projection before painting any occurrence. */
function boundRows(
  article: HTMLElement | null,
  rows: readonly FormulaRow[],
  aligned: AlignedWords
) {
  const formulas = [...(article?.querySelectorAll('.katex') ?? [])];
  if (
    formulas.length !== rows.length ||
    formulas.some(
      (formula, index) =>
        formula.querySelector('annotation')?.textContent?.trim() !== rows[index].latex
    )
  )
    return [];
  return rows.flatMap(({ range }, index) =>
    range ? [{ element: formulas[index], ...alignedRangeTime(aligned, range) }] : []
  );
}

function uniquelyHeardFormula(targets: ReturnType<typeof boundRows>, heard: number | undefined) {
  if (heard === undefined) return undefined;
  let match: Element | undefined;
  for (const { element, start, end } of targets) {
    if (!(start <= heard && heard < end)) continue;
    if (match) return undefined;
    match = element;
  }
  return match;
}

/** A focus state is derived from the live recording on every frame, including seeks. */
export function useNarratedFormulaFocus(
  card: RefObject<HTMLElement | null>,
  clock: RefObject<{ read: () => { blockTime: number } } | null>,
  rows: readonly FormulaRow[] | undefined,
  aligned: AlignedWords | undefined
) {
  useLayoutEffect(() => {
    if (!aligned || !rows?.some(row => row.range)) return;
    let host: HTMLElement | null = null;
    let targets: ReturnType<typeof boundRows> = [];
    let active: Element | undefined;
    let frame = 0;
    const paint = () => {
      if (host !== card.current) {
        host = card.current;
        targets = boundRows(
          host?.querySelector(`.${NARRATED_FORMULA_CLASS}`) ?? null,
          rows,
          aligned
        );
      }
      const heard = clock.current?.read().blockTime;
      const next = uniquelyHeardFormula(targets, heard);
      if (next !== active) {
        active?.removeAttribute(CURRENT_FORMULA);
        next?.setAttribute(CURRENT_FORMULA, '');
        active = next;
      }
      frame = requestAnimationFrame(paint);
    };
    paint();
    return () => {
      cancelAnimationFrame(frame);
      active?.removeAttribute(CURRENT_FORMULA);
    };
  }, [card, clock, rows, aligned]);
}
