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
export function toFindings(signals: ProbeSignal[], thresholds: ProbeThresholds): ProbeFinding[] {
  return signals.flatMap(signal => {
    let threshold: number | undefined;
    let measurement: number;
    let taxonomyClass: string;
    switch (signal.kind) {
      case 'clipped-text':
        threshold = thresholds.clippedTextMinOverflowPx;
        measurement = signal.scrollWidth - signal.clientWidth;
        taxonomyClass = 'D01';
        break;
      case 'overlap':
        threshold = thresholds.overlapMinAreaPx;
        measurement = signal.areaPx;
        taxonomyClass = 'D02';
        break;
      case 'layout-shift':
        threshold = thresholds.layoutShiftScore;
        measurement = signal.value;
        taxonomyClass = 'D11';
        break;
      case 'gesture-target-movement':
        threshold = thresholds.pointerOffsetChangePx;
        measurement = signal.maxPointerOffsetChangePx;
        taxonomyClass = 'D10';
        break;
      case 'interaction-latency':
        threshold = thresholds.interactionLatencyMs;
        measurement = signal.durationMs;
        taxonomyClass = 'D12';
        break;
      case 'contrast':
        threshold = thresholds.minContrastRatio;
        measurement = signal.ratio;
        taxonomyClass = 'D05';
        break;
      default:
        // The public contract supplies no threshold for document overflow or console errors.
        return [];
    }
    if (threshold === undefined) return [];
    const exceeds = signal.kind === 'contrast' ? measurement < threshold : measurement > threshold;
    return exceeds ? [{ signal, threshold, taxonomyClass }] : [];
  });
}
