/** Content-free passage timings, observable with a PerformanceObserver for `measure`. */
export function tracePlayback(
  event: 'preparation' | 'passage' | 'stall',
  index: number,
  start: number,
  timing: Record<string, number>
) {
  const name = `nous.playback.${event}`;
  try {
    // Observers receive every event; the browser timeline retains only the latest of each kind.
    performance.clearMeasures(name);
    performance.measure(name, { start, detail: { index, ...timing } });
  } catch {
    // Supported legacy browsers can reject User Timing Level 3; diagnostics must not stop audio.
  }
}
