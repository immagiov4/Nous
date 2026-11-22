import type { SceneAnimationFrame } from '../lessonSceneAnimation';
import { type StudioNarrationCue, studioPhraseDuration } from '../lessonSceneAnimation';
import type { StudioLessonScene } from '../lessonSceneRegistry';
import { MAX_STUDIO_CUE_LAG_MS } from './traceTiming';
import { enclosingBoxes, isLayoutBackdrop, isVisible, vectorOpacity } from './vectorBounds';
import { absolutePosition, descendants, type VectorNode } from './vectorScene';

type StudioHold = {
  cueIndex: number;
  startMs: number;
  endMs: number;
  label: string;
  phrase: string;
};
type StudioBeatLayout = {
  surface: VectorNode;
  cues: number[];
  durationMs: number;
  holds: StudioHold[];
  seek(elapsedMs: number): void;
};

const labelWords = (phrase: string) =>
  phrase.normalize('NFC').toLocaleLowerCase('it').trim().replaceAll(/\s+/gu, ' ');

export function namesLabel(phrase: string, label: string) {
  const escaped = labelWords(label).replaceAll(/[.*+?^${}()|[\]\\]/gu, String.raw`\$&`);
  return new RegExp(String.raw`(?:^|[^\p{L}\p{N}])${escaped}(?![\p{L}\p{N}])`, 'u').test(
    labelWords(phrase)
  );
}

export function planStudioHolds(
  cues: readonly StudioNarrationCue[],
  starts: readonly number[],
  durationMs: number
): StudioHold[] {
  return cues.flatMap(({ anchor, hold }, index) => {
    if (hold === undefined) return [];
    const startMs = starts[index];
    const endMs = Math.min(startMs + studioPhraseDuration(anchor), starts[index + 1] ?? durationMs);
    return [{ cueIndex: index, startMs, endMs, label: hold, phrase: anchor }];
  });
}

function namedVisibleLabel(surface: VectorNode, hold: StudioHold) {
  const matches = [...descendants(surface)].filter(
    node => node.label && isVisible(node) && labelWords(node.textContent) === labelWords(hold.label)
  );
  return matches.length === 1 ? matches[0] : undefined;
}

export function createHoldPainter(surface: VectorNode, holds: StudioHold[]) {
  const namedHolds = holds.filter(hold => namesLabel(hold.phrase, hold.label));
  let previousHold: StudioHold | undefined;
  let previous: VectorNode | undefined;
  return (time: number, frame?: SceneAnimationFrame, poseChanged = false) => {
    const hold = namedHolds.find(({ cueIndex, startMs, endMs }) => {
      const start = frame?.cueTimes?.[cueIndex];
      const end = frame?.cueEndTimes?.[cueIndex];
      if (start !== undefined && end !== undefined && frame)
        return start <= frame.elapsedMs && frame.elapsedMs < end;
      return startMs <= time && time < endMs;
    });
    if (!poseChanged && hold === previousHold) return false;
    previousHold = hold;
    const next = hold ? namedVisibleLabel(surface, hold) : undefined;
    if (next === previous) return false;
    if (previous) delete previous.data.studioHold;
    if (next) next.data.studioHold = 'true';
    previous = next;
    return true;
  };
}

export function validatedStudioHolds(layout: StudioBeatLayout, sampleTimes: readonly number[]) {
  return layout.holds.filter(hold => {
    if (hold.startMs >= hold.endMs || !namesLabel(hold.phrase, hold.label)) return false;
    // A hold must emphasize the same existing label throughout the anchored phrase.
    layout.seek(Math.max(0, hold.startMs - 1));
    const target = namedVisibleLabel(layout.surface, hold);
    if (!target) return false;
    const inPhrase = sampleTimes.filter(time => time > hold.startMs && time < hold.endMs);
    return [hold.startMs, ...inPhrase, hold.endMs - 1].every(time => {
      layout.seek(time);
      return namedVisibleLabel(layout.surface, hold) === target;
    });
  });
}

function belongsToTarget(element: VectorNode, targets: readonly string[]) {
  for (let node: VectorNode | undefined = element; node; node = node.parent) {
    const id = node.attrs['data-studio-target'];
    if (typeof id === 'string' && targets.includes(id)) return true;
  }
  return false;
}

function visiblePose(surface: VectorNode, targets?: readonly string[]) {
  return JSON.stringify(
    enclosingBoxes(surface).flatMap(({ element }) => {
      if (isLayoutBackdrop(element) || element.hasClass('leader') || element.hasClass('ghost'))
        return [];
      if (targets && !belongsToTarget(element, targets)) return [];
      return [
        [
          element.tag,
          absolutePosition(element),
          element.textContent,
          vectorOpacity(element),
          element.attrs,
          element.parent?.attrs,
        ],
      ];
    })
  );
}

function opensOnNamedTargets(surface: VectorNode, targets: readonly string[]) {
  const visible = [...descendants(surface)].filter(isVisible);
  return targets.every(target =>
    visible.some(
      ({ attrs, parent }) =>
        (attrs['data-studio-target'] === target &&
          (attrs['data-focus'] === 'true' ||
            attrs['data-state'] === 'active' ||
            target === 'curve')) ||
        (parent?.attrs['data-studio-target'] === target && attrs.class === 'graph-pulse')
    )
  );
}

/** Use the reader clock and painted pose to reject a stationary, unexplained beat. */
export function studioBeatsStayInSync(scene: StudioLessonScene, layout: StudioBeatLayout) {
  return layout.cues.every((start, index) => {
    const cue = scene.studioCues[index];
    if (cue.hold !== undefined) return true; // The hold checker verifies the existing label.
    const end = Math.min(
      start + MAX_STUDIO_CUE_LAG_MS,
      start + studioPhraseDuration(cue.anchor),
      (layout.cues[index + 1] ?? layout.durationMs) - 1
    );
    layout.seek(Math.max(0, start - 1));
    const before = visiblePose(layout.surface, cue.targets);
    if (start === 0 && before !== '[]')
      return cue.targets ? opensOnNamedTargets(layout.surface, cue.targets) : true;
    layout.seek(end);
    return visiblePose(layout.surface, cue.targets) !== before;
  });
}
