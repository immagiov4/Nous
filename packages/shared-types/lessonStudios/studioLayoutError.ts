type LayoutFault =
  | 'ellipse-nonfinite'
  | 'invalid-vector-path'
  | 'invalid-trace-pins'
  | 'missing-label-style';

/** Stable diagnostic codes leave authored text and computed path data out of operational logs. */
export class StudioLayoutError extends Error {
  constructor(
    readonly code: LayoutFault,
    cause?: unknown
  ) {
    super(code, { cause });
    this.name = 'StudioLayoutError';
  }
}
