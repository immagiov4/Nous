interface ScrollRangeMetrics {
  clientHeight: number;
  renderedClientHeight: number;
  remotionScale: number;
  scrollHeight: number;
}

export const getScrollRange = ({
  clientHeight,
  renderedClientHeight,
  remotionScale,
  scrollHeight,
}: ScrollRangeMetrics): number => {
  const scaleCorrectedClientHeight =
    remotionScale > 0 ? renderedClientHeight / remotionScale : clientHeight;
  const layoutClientHeight = clientHeight > 0 ? clientHeight : scaleCorrectedClientHeight;
  return Math.max(0, scrollHeight - layoutClientHeight);
};

export const getScrollOffset = (scrollRange: number, progress: number): number =>
  Math.round(Math.max(0, scrollRange) * Math.min(1, Math.max(0, progress)));

export const keepTextInputEndVisible = (input: HTMLInputElement): void => {
  const textEnd = input.value.length;
  input.setSelectionRange(textEnd, textEnd);
  input.scrollLeft = Math.max(0, input.scrollWidth - input.clientWidth);
};
