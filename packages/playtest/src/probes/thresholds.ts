import type { ProbeSignal } from './pageProbes';

export type ProbeThresholds = {
  clippedTextMinOverflowPx?: number;
  overlapMinAreaPx?: number;
  layoutShiftScore?: number;
  pointerOffsetChangePx?: number;
  interactionLatencyMs?: number;
  minContrastRatio?: number;
};

export type ProbeFinding = { signal: ProbeSignal; threshold: number; taxonomyClass: string };

/** Converts raw facts only where the maintainer supplied a corresponding threshold. */
export function toFindings(
  signals: ProbeSignal[],
  thresholds: ProbeThresholds,
  classification: {
    probeClass(kind: ProbeSignal['kind']): string | undefined;
    taxonomyClasses(): string[];
  }
): ProbeFinding[] {
  let classes: Set<string> | undefined;
  return signals.flatMap(signal => {
    let threshold: number | undefined;
    let measurement: number;
    switch (signal.kind) {
      case 'clipped-text':
        threshold = thresholds.clippedTextMinOverflowPx;
        measurement = signal.scrollWidth - signal.clientWidth;
        break;
      case 'overlap':
        threshold = thresholds.overlapMinAreaPx;
        measurement = signal.areaPx;
        break;
      case 'layout-shift':
        threshold = thresholds.layoutShiftScore;
        measurement = signal.value;
        break;
      case 'gesture-target-movement':
        threshold = thresholds.pointerOffsetChangePx;
        measurement = signal.maxPointerOffsetChangePx;
        break;
      case 'interaction-latency':
        threshold = thresholds.interactionLatencyMs;
        measurement = signal.durationMs;
        break;
      case 'contrast':
        threshold = thresholds.minContrastRatio;
        measurement = signal.ratio;
        break;
      default:
        // The public contract supplies no threshold for document overflow or console errors.
        return [];
    }
    if (threshold === undefined) return [];
    const exceeds = signal.kind === 'contrast' ? measurement < threshold : measurement > threshold;
    if (!exceeds) return [];
    const taxonomyClass = classification.probeClass(signal.kind);
    if (taxonomyClass === undefined) return [];
    classes ??= new Set(classification.taxonomyClasses());
    return classes.has(taxonomyClass) ? [{ signal, threshold, taxonomyClass }] : [];
  });
}
