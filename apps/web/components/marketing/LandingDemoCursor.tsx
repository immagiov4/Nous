import { MousePointer2 } from 'lucide-react';
import { type RefObject, useLayoutEffect, useMemo, useState } from 'react';
import { Easing, interpolate, useCurrentScale } from 'remotion';
import {
  type DemoStage,
  LESSON_ARTIFACT_CLOSE_FRAME,
  LESSON_ARTIFACT_OPEN_FRAME,
  LESSON_ARTIFACT_SAVE_FRAME,
  LESSON_ATTACH_DRAFT_END_FRAME,
  LESSON_ATTACH_SEND_FRAME,
  LESSON_FINAL_ANNOTATION_CLICK_FRAME,
  LESSON_FINAL_ARTIFACT_OPEN_FRAME,
  LESSON_FINAL_NOTE_SCROLL_END_FRAME,
  LESSON_FIRST_ANNOTATION_CLICK_FRAME,
  LESSON_FIRST_CHAT_CLOSE_FRAME,
  LESSON_GRAPH_DRAFT_END_FRAME,
  LESSON_GRAPH_DRAFT_START_FRAME,
  LESSON_GRAPH_SEND_FRAME,
  LESSON_NOTE_APPROVE_FRAME,
  LESSON_NOTE_DRAFT_END_FRAME,
  LESSON_NOTE_SEND_FRAME,
  LESSON_SECOND_CHAT_CLOSE_FRAME,
  LESSON_SELECTION_CLICK_FRAME,
  LESSON_SEND_CLICK_FRAME,
  LESSON_UPDATE_NOTE_APPROVE_FRAME,
  LIBRARY_ARTIFACT_PREVIEW_FRAME,
  LIBRARY_FIRST_SEND_FRAME,
  LIBRARY_SECOND_SEND_FRAME,
} from './landingDemoTimeline.ts';

type CursorTargetId =
  | 'annotation-mark'
  | 'artifact-close'
  | 'artifact-open'
  | 'artifact-save'
  | 'context-answer-close'
  | 'context-answer-input'
  | 'context-answer-submit'
  | 'course-card'
  | 'library-heading'
  | 'lesson-input'
  | 'lesson-selection'
  | 'lesson-submit'
  | 'note-approve'
  | 'plan-attachment'
  | 'plan-confirm'
  | 'plan-objective'
  | 'plan-submit';

interface CursorPoint {
  left: number;
  top: number;
}

interface CursorTargetDefinition {
  id: CursorTargetId;
  selector?: string;
  text?: string;
}

interface CursorWaypoint {
  frame: number;
  target: CursorTargetId;
}

interface LandingDemoCursorProps {
  readonly annotationId: string;
  readonly artifactId: string;
  readonly frame: number;
  readonly projectId: string;
  readonly rootRef: RefObject<HTMLDivElement | null>;
  readonly selectionSearchText: string;
  readonly stage: DemoStage;
}

const areCursorPointsEqual = (
  current: Partial<Record<CursorTargetId, CursorPoint>>,
  next: Partial<Record<CursorTargetId, CursorPoint>>
) => {
  const targetIds = new Set([...Object.keys(current), ...Object.keys(next)] as CursorTargetId[]);
  return [...targetIds].every(targetId => {
    const currentPoint = current[targetId];
    const nextPoint = next[targetId];
    if (!currentPoint || !nextPoint) {
      return currentPoint === nextPoint;
    }
    return (
      Math.abs(currentPoint.left - nextPoint.left) < 0.25 &&
      Math.abs(currentPoint.top - nextPoint.top) < 0.25
    );
  });
};

const findTextRect = (root: HTMLElement, searchText: string): DOMRect | null => {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const normalizedSearchText = searchText.toLocaleLowerCase();
  let node = walker.nextNode();

  while (node) {
    const text = node.textContent || '';
    const startIndex = text.toLocaleLowerCase().indexOf(normalizedSearchText);
    if (startIndex >= 0) {
      const range = document.createRange();
      range.setStart(node, startIndex);
      range.setEnd(node, startIndex + searchText.length);
      const rect = range.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        return rect;
      }
    }
    node = walker.nextNode();
  }

  return null;
};

const measureCursorTarget = (
  root: HTMLDivElement,
  definition: CursorTargetDefinition,
  scale: number
): CursorPoint | null => {
  const targetRect = definition.selector
    ? root.querySelector<HTMLElement>(definition.selector)?.getBoundingClientRect()
    : definition.text
      ? findTextRect(root, definition.text)
      : null;
  if (!targetRect) {
    return null;
  }

  const rootRect = root.getBoundingClientRect();
  return {
    left: (targetRect.left - rootRect.left + targetRect.width / 2) / scale,
    top: (targetRect.top - rootRect.top + targetRect.height / 2) / scale,
  };
};

const getCursorWaypoints = (stage: DemoStage): CursorWaypoint[] => {
  if (stage === 'plan') {
    return [
      { frame: 12, target: 'plan-attachment' },
      { frame: 48, target: 'plan-attachment' },
      { frame: 70, target: 'plan-objective' },
      { frame: 145, target: 'plan-objective' },
      { frame: 165, target: 'plan-submit' },
      { frame: 180, target: 'plan-submit' },
      { frame: 275, target: 'plan-objective' },
      { frame: 340, target: 'plan-objective' },
      { frame: 360, target: 'plan-submit' },
      { frame: 374, target: 'plan-submit' },
      { frame: 465, target: 'plan-objective' },
      { frame: 525, target: 'plan-objective' },
      { frame: 545, target: 'plan-submit' },
      { frame: 560, target: 'plan-submit' },
      { frame: 650, target: 'plan-confirm' },
      { frame: 680, target: 'plan-confirm' },
      { frame: 710, target: 'plan-confirm' },
    ];
  }

  if (stage === 'lesson') {
    return [
      { frame: 12, target: 'lesson-selection' },
      { frame: LESSON_SELECTION_CLICK_FRAME, target: 'lesson-selection' },
      { frame: 78, target: 'lesson-input' },
      { frame: 144, target: 'lesson-input' },
      { frame: LESSON_SEND_CLICK_FRAME, target: 'lesson-submit' },
      { frame: 184, target: 'lesson-submit' },
      { frame: 240, target: 'context-answer-input' },
      { frame: LESSON_NOTE_DRAFT_END_FRAME, target: 'context-answer-input' },
      { frame: LESSON_NOTE_SEND_FRAME, target: 'context-answer-submit' },
      { frame: 350, target: 'context-answer-submit' },
      { frame: 410, target: 'note-approve' },
      { frame: LESSON_NOTE_APPROVE_FRAME, target: 'note-approve' },
      { frame: 470, target: 'note-approve' },
      { frame: 490, target: 'context-answer-close' },
      { frame: LESSON_FIRST_CHAT_CLOSE_FRAME, target: 'context-answer-close' },
      { frame: 535, target: 'annotation-mark' },
      { frame: LESSON_FIRST_ANNOTATION_CLICK_FRAME, target: 'annotation-mark' },
      { frame: 565, target: 'annotation-mark' },
      { frame: LESSON_GRAPH_DRAFT_START_FRAME, target: 'lesson-input' },
      { frame: LESSON_GRAPH_DRAFT_END_FRAME, target: 'lesson-input' },
      { frame: LESSON_GRAPH_SEND_FRAME, target: 'lesson-submit' },
      { frame: 720, target: 'lesson-submit' },
      { frame: 880, target: 'artifact-open' },
      { frame: LESSON_ARTIFACT_OPEN_FRAME, target: 'artifact-open' },
      { frame: 970, target: 'artifact-save' },
      { frame: LESSON_ARTIFACT_SAVE_FRAME, target: 'artifact-save' },
      { frame: 1025, target: 'artifact-save' },
      { frame: 1032, target: 'artifact-close' },
      { frame: LESSON_ARTIFACT_CLOSE_FRAME, target: 'artifact-close' },
      { frame: 1060, target: 'context-answer-input' },
      { frame: LESSON_ATTACH_DRAFT_END_FRAME, target: 'context-answer-input' },
      { frame: LESSON_ATTACH_SEND_FRAME, target: 'context-answer-submit' },
      { frame: 1175, target: 'context-answer-submit' },
      { frame: 1210, target: 'note-approve' },
      { frame: LESSON_UPDATE_NOTE_APPROVE_FRAME, target: 'note-approve' },
      { frame: 1280, target: 'note-approve' },
      { frame: 1300, target: 'context-answer-close' },
      { frame: LESSON_SECOND_CHAT_CLOSE_FRAME, target: 'context-answer-close' },
      { frame: 1340, target: 'annotation-mark' },
      { frame: LESSON_FINAL_ANNOTATION_CLICK_FRAME, target: 'annotation-mark' },
      { frame: LESSON_FINAL_NOTE_SCROLL_END_FRAME, target: 'artifact-open' },
      { frame: LESSON_FINAL_ARTIFACT_OPEN_FRAME, target: 'artifact-open' },
    ];
  }

  return [
    { frame: 18, target: 'plan-objective' },
    { frame: 112, target: 'plan-objective' },
    { frame: LIBRARY_FIRST_SEND_FRAME, target: 'plan-submit' },
    { frame: 150, target: 'plan-submit' },
    { frame: 320, target: 'plan-objective' },
    { frame: 392, target: 'plan-objective' },
    { frame: LIBRARY_SECOND_SEND_FRAME, target: 'plan-submit' },
    { frame: 432, target: 'plan-submit' },
    { frame: 540, target: 'artifact-open' },
    { frame: LIBRARY_ARTIFACT_PREVIEW_FRAME, target: 'artifact-open' },
    { frame: 640, target: 'artifact-close' },
  ];
};

const resolveCursorPoint = (
  frame: number,
  points: Partial<Record<CursorTargetId, CursorPoint>>,
  waypoints: CursorWaypoint[]
): CursorPoint | null => {
  const firstPoint = points[waypoints[0].target];
  if (frame <= waypoints[0].frame) {
    return firstPoint || null;
  }

  for (let index = 1; index < waypoints.length; index += 1) {
    const previousWaypoint = waypoints[index - 1];
    const nextWaypoint = waypoints[index];
    if (frame > nextWaypoint.frame) {
      continue;
    }

    const previousPoint = points[previousWaypoint.target] || points[nextWaypoint.target];
    const nextPoint = points[nextWaypoint.target] || previousPoint;
    if (!previousPoint || !nextPoint) {
      return null;
    }

    const interpolationOptions = {
      easing: Easing.bezier(0.16, 1, 0.3, 1),
      extrapolateLeft: 'clamp' as const,
      extrapolateRight: 'clamp' as const,
    };
    return {
      left: interpolate(
        frame,
        [previousWaypoint.frame, nextWaypoint.frame],
        [previousPoint.left, nextPoint.left],
        interpolationOptions
      ),
      top: interpolate(
        frame,
        [previousWaypoint.frame, nextWaypoint.frame],
        [previousPoint.top, nextPoint.top],
        interpolationOptions
      ),
    };
  }

  return points[waypoints.at(-1)?.target || waypoints[0].target] || null;
};

export default function LandingDemoCursor({
  annotationId,
  artifactId,
  frame,
  projectId,
  rootRef,
  selectionSearchText,
  stage,
}: LandingDemoCursorProps) {
  const scale = useCurrentScale();
  const [points, setPoints] = useState<Partial<Record<CursorTargetId, CursorPoint>>>({});
  const definitions = useMemo<CursorTargetDefinition[]>(
    () => [
      { id: 'annotation-mark', selector: `[data-nous-annotation-id="${annotationId}"]` },
      { id: 'artifact-close', selector: '[data-artifact-target="close"]' },
      { id: 'artifact-open', selector: `[data-artifact-target="open-${artifactId}"]` },
      { id: 'artifact-save', selector: '[data-artifact-target="save"]' },
      { id: 'context-answer-close', selector: '[data-context-answer-target="close"]' },
      {
        id: 'context-answer-input',
        selector: '[data-chat-composer-target="context-answer-input"]',
      },
      {
        id: 'context-answer-submit',
        selector: '[data-chat-composer-target="context-answer-submit"]',
      },
      { id: 'plan-attachment', selector: '[data-home-chat-target="attachment"]' },
      { id: 'plan-confirm', selector: '[data-home-chat-target="confirm-generate"]' },
      { id: 'plan-objective', selector: '[data-home-chat-target="objective"]' },
      { id: 'plan-submit', selector: '[data-home-chat-target="submit"]' },
      { id: 'lesson-selection', text: selectionSearchText },
      { id: 'lesson-input', selector: '[data-context-menu-target="input"]' },
      { id: 'lesson-submit', selector: '[data-context-menu-target="submit"]' },
      { id: 'note-approve', selector: '[data-context-answer-target="note-approve"]' },
      { id: 'library-heading', selector: '[data-library-target="heading"]' },
      { id: 'course-card', selector: `[data-drag-id="${projectId}"] article` },
    ],
    [annotationId, artifactId, projectId, selectionSearchText]
  );

  useLayoutEffect(() => {
    if (frame < 0 || stage === 'generation') {
      return;
    }
    const root = rootRef.current;
    if (!root) {
      return;
    }

    const nextPoints: Partial<Record<CursorTargetId, CursorPoint>> = {};
    definitions.forEach(definition => {
      const point = measureCursorTarget(root, definition, scale);
      if (point) {
        nextPoints[definition.id] = point;
      }
    });
    setPoints(currentPoints =>
      areCursorPointsEqual(currentPoints, nextPoints) ? currentPoints : nextPoints
    );
  }, [definitions, frame, rootRef, scale, stage]);

  if (stage === 'generation') {
    return null;
  }

  const waypoints = getCursorWaypoints(stage);
  const position = resolveCursorPoint(frame, points, waypoints);
  if (!position) {
    return null;
  }

  return (
    <MousePointer2
      aria-hidden="true"
      style={{
        position: 'absolute',
        zIndex: 80,
        left: Math.round(position.left),
        top: Math.round(position.top),
        width: 30,
        height: 30,
        color: '#171614',
        opacity: interpolate(
          frame,
          stage === 'library'
            ? [70, 88, 194, 218]
            : stage === 'plan'
              ? [0, 12, 710, 735]
              : [0, 12, 1420, 1450],
          [0, 1, 1, 0],
          { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }
        ),
      }}
    />
  );
}
