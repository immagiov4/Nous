export const ARRAY_LAYOUT = {
  left: 44,
  right: 738,
  bracket: 125,
  top: 138,
  bottom: 368,
  settled: 426,
  hud: 866,
};

export function arrayBars(input: readonly number[]) {
  const slot = (ARRAY_LAYOUT.right - ARRAY_LAYOUT.left) / input.length;
  const width = Math.min(slot * 0.6, 114);
  const slotX = (index: number) => ARRAY_LAYOUT.left + slot * (index + 0.5);
  const min = Math.min(0, ...input);
  const max = Math.max(0, ...input);
  const magnitude = Math.max(Math.abs(min), max) || 1;
  const unit = (ARRAY_LAYOUT.bottom - ARRAY_LAYOUT.top) / (max / magnitude - min / magnitude || 1);
  const baseline =
    ARRAY_LAYOUT.top + (max / magnitude) * unit + (max === 0 && min === 0 ? unit : 0);
  const barGeometry = (value: number) => {
    const length = (value / magnitude) * unit;
    return { y: baseline - Math.max(length, 0), height: Math.max(2, Math.abs(length)) };
  };
  const valueY = min < 0 ? ARRAY_LAYOUT.bottom + 37 : baseline + 39;
  return { baseline, barGeometry, slot, slotX, valueY, width };
}

export const HEAP_LAYOUT = {
  left: 108,
  right: 892,
  barTop: 51,
  barBottom: 130,
  indexY: 258,
  treeTop: 295,
  treeBottom: 424,
  radius: 25,
};

export function treePoint(index: number, length: number): [number, number] {
  const level = Math.floor(Math.log2(index + 1));
  const span = 2 ** level;
  const position = index - span + 1;
  const depth = Math.floor(Math.log2(length));
  return [
    HEAP_LAYOUT.left + ((HEAP_LAYOUT.right - HEAP_LAYOUT.left) * (position + 0.5)) / span,
    HEAP_LAYOUT.treeTop +
      (level * (HEAP_LAYOUT.treeBottom - HEAP_LAYOUT.treeTop)) / Math.max(2, depth),
  ];
}

export function heapBars(input: readonly number[], slot: number) {
  const source = arrayBars(input);
  const bars = input.map(source.barGeometry);
  const maxTop = Math.min(source.baseline, ...bars.map(bar => bar.y));
  const maxBottom = Math.max(source.baseline, ...bars.map(bar => bar.y + bar.height));
  const scale = (HEAP_LAYOUT.barBottom - HEAP_LAYOUT.barTop) / Math.max(2, maxBottom - maxTop);
  const baseline = HEAP_LAYOUT.barTop + (source.baseline - maxTop) * scale;
  const barWidth = Math.min(72, slot * 0.57);
  const heights = bars.map(({ y, height }) => ({
    y: baseline + (y - source.baseline) * scale,
    height: Math.max(2, height * scale),
  }));
  return { baseline, barWidth, heights };
}
