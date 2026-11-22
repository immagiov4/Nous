export type StudioCheck =
  | 'operand-grounding'
  | 'operation-grounding'
  | 'narration-budget'
  | 'layout-unavailable'
  | 'overlap'
  | 'min-text'
  | 'min-gap'
  | 'label-placement'
  | 'plot-resolution'
  | 'label-association'
  | 'axis-scale'
  | 'dead-stage';

export interface LayoutBounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export type LayoutElement = {
  id: string;
  bounds: LayoutBounds;
  /** The owner of intentionally enclosed elements, such as the background of a text chip. */
  containerId?: string;
  label?: { fontPx: number; anchorId?: string; association?: string };
  /** Marks intentionally meet during an animation, such as bars touching the axis. */
  mark?: boolean;
  /** Diagram fills can animate beneath readable labels. */
  underlay?: boolean;
  /** An edge badge is painted on top of its own line and pulse. */
  edgeId?: string;
  /** Highlighting and readouts can change with a fixed footprint. */
  motionState?: string;
};

interface StudioLayoutFrame {
  elements: readonly LayoutElement[];
  /** Pixels per data unit, supplied only for geometry whose quantities share a unit. */
  axisScale?: { x: number; y: number };
}

export interface StudioLayout {
  stage: LayoutBounds;
  frames: readonly StudioLayoutFrame[];
}

export const MIN_TEXT_PX = 14;
export const MIN_TEXT_GAP_PX = 8;
export const DISTINCT_LABEL_GAP_PX = 40;
const FIRST_MEANINGFUL_ELEMENT_MS = 2000;
const MAX_UNCOVERED_STAGE_MS = 4000;

function distance(a: LayoutBounds, b: LayoutBounds) {
  return Math.hypot(
    Math.max(0, b.left - a.right, a.left - b.right),
    Math.max(0, b.top - a.bottom, a.top - b.bottom)
  );
}

function intersects(a: LayoutBounds, b: LayoutBounds) {
  return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
}

function contains(stage: LayoutBounds, element: LayoutBounds): boolean {
  return (
    element.left >= stage.left &&
    element.right <= stage.right &&
    element.top >= stage.top &&
    element.bottom <= stage.bottom
  );
}

function equalAxisScale({ x, y }: NonNullable<StudioLayoutFrame['axisScale']>) {
  return (
    Number.isFinite(x) &&
    x > 0 &&
    Number.isFinite(y) &&
    y > 0 &&
    Math.abs(x - y) <= 4 * Number.EPSILON * Math.max(x, y)
  );
}

const isOwnContainer = (a: LayoutElement, b: LayoutElement) =>
  a.containerId === b.id || b.containerId === a.id;

function pairProblems(a: LayoutElement, b: LayoutElement, problems: Set<StudioCheck>) {
  if (a.underlay || b.underlay) return;
  if (isOwnContainer(a, b)) return;
  if (a.edgeId !== undefined && a.edgeId === b.edgeId && a.mark !== b.mark) return;
  if (intersects(a.bounds, b.bounds)) problems.add('overlap');
  if (!a.label && !b.label) return;
  const gap = distance(a.bounds, b.bounds);
  if (gap < MIN_TEXT_GAP_PX) problems.add('min-gap');
  const anchorA = a.label?.association ?? a.label?.anchorId;
  const anchorB = b.label?.association ?? b.label?.anchorId;
  if (anchorA && anchorB && anchorA !== anchorB && gap < DISTINCT_LABEL_GAP_PX)
    problems.add('label-association');
}

function hasClosestAnchor(label: LayoutElement, elements: readonly LayoutElement[]) {
  if (!label.label?.anchorId) return true;
  const anchor = elements.find(element => element.id === label.label?.anchorId);
  if (!anchor) return false;
  const anchorGap = distance(label.bounds, anchor.bounds);
  return elements.every(
    element =>
      element === label ||
      element === anchor ||
      element.label ||
      isOwnContainer(label, element) ||
      distance(label.bounds, element.bounds) > anchorGap
  );
}

/** Checks bounds in release-stage pixels. Callers supply exact poses or conservative swept bounds. */
export function checkStudioLayout(layout: StudioLayout | undefined): StudioCheck[] {
  if (!layout?.frames.some(frame => frame.elements.length)) return ['layout-unavailable'];
  const problems = new Set<StudioCheck>();
  for (const frame of layout.frames) collectStudioFrameProblems(layout.stage, frame, problems);
  return [...problems];
}

export function collectStudioFrameProblems(
  stage: LayoutBounds,
  { elements, axisScale }: StudioLayoutFrame,
  problems: Set<StudioCheck>
) {
  if (axisScale && !equalAxisScale(axisScale)) problems.add('axis-scale');
  // Dense curves contribute many mark segments. Only pairs with a label or a chip matter.
  const unmarked = elements.filter(element => !element.mark);
  let nextUnmarked = 0;
  elements.forEach((element, index) => {
    if (!contains(stage, element.bounds)) problems.add('overlap');
    if (
      element.label &&
      (element.label.fontPx < MIN_TEXT_PX || !Number.isFinite(element.label.fontPx))
    )
      problems.add('min-text');
    if (!hasClosestAnchor(element, elements)) problems.add('label-association');
    if (element.mark) {
      for (let other = nextUnmarked; other < unmarked.length; other++)
        pairProblems(element, unmarked[other], problems);
      return;
    }
    nextUnmarked++;
    for (let other = index + 1; other < elements.length; other++)
      pairProblems(element, elements[other], problems);
  });
}

export interface StudioActiveWindow {
  startMs: number;
  endMs: number;
}

/** The engine supplies intervals of meaningful motion or confirmed narration about the visible state. */
export function hasDeadStage(input: {
  firstMeaningfulMs: number;
  durationMs: number;
  active: readonly StudioActiveWindow[];
}) {
  const { firstMeaningfulMs, durationMs, active } = input;
  if (firstMeaningfulMs > FIRST_MEANINGFUL_ELEMENT_MS) return true;
  let coveredUntil = firstMeaningfulMs;
  for (const { startMs, endMs } of [...active].sort((a, b) => a.startMs - b.startMs)) {
    if (startMs - coveredUntil > MAX_UNCOVERED_STAGE_MS) return true;
    coveredUntil = Math.max(coveredUntil, endMs);
  }
  return durationMs - coveredUntil > MAX_UNCOVERED_STAGE_MS;
}
