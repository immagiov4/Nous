import type { StudioViewport } from './chartDimensions';
import { IMAGE_CREDIT_LINE_PX, type ImageAnnotateSpec } from './imageAnnotateSpec';
import {
  checkStudioLayout,
  type LayoutBounds,
  MIN_TEXT_GAP_PX,
  MIN_TEXT_PX,
  type StudioCheck,
} from './layoutValidation';
import { DIM, MOVE } from './motion';
import { studioTextShape } from './studioTypography';

const ZOOM_LIMIT = 2.2;
const FOCUS_AREA = 0.67;
const MOVE_MS = MOVE.duration * 1000;
type Point = [number, number];

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const mix = (from: number, to: number, progress: number) => from + (to - from) * progress;
const mixBox = (from: LayoutBounds, to: LayoutBounds, progress: number): LayoutBounds => ({
  left: mix(from.left, to.left, progress),
  top: mix(from.top, to.top, progress),
  right: mix(from.right, to.right, progress),
  bottom: mix(from.bottom, to.bottom, progress),
});
const clipBox = (box: LayoutBounds, frame: LayoutBounds): LayoutBounds => ({
  left: clamp(box.left, frame.left, frame.right),
  top: clamp(box.top, frame.top, frame.bottom),
  right: clamp(box.right, frame.left, frame.right),
  bottom: clamp(box.bottom, frame.top, frame.bottom),
});

function placeLabel(
  text: string,
  shape: ReturnType<typeof studioTextShape>,
  clip: LayoutBounds,
  stage: LayoutBounds
) {
  if (shape.bounds.right - shape.bounds.left > stage.right) return undefined;
  const x = clamp(
    (clip.left + clip.right) / 2,
    -shape.bounds.left,
    stage.right - shape.bounds.right
  );
  const y = Math.ceil(clip.bottom + MIN_TEXT_GAP_PX - shape.bounds.top);
  const bounds = {
    left: x + shape.bounds.left,
    right: x + shape.bounds.right,
    top: y + shape.bounds.top,
    bottom: y + shape.bounds.bottom,
  };
  if (bounds.bottom > stage.bottom) return undefined;
  return { text, shape, x, y, bounds, fontPx: MIN_TEXT_PX };
}

function cameraFor(
  region: NonNullable<ImageAnnotateSpec['beats'][number]['region']>,
  picture: LayoutBounds,
  stage: LayoutBounds
) {
  const width = picture.right - picture.left;
  const height = picture.bottom - picture.top;
  const zoom = clamp(
    Math.min(
      (stage.right * FOCUS_AREA) / (region.w * width),
      (stage.bottom * FOCUS_AREA) / (region.h * height)
    ),
    1,
    ZOOM_LIMIT
  );
  const w = width * zoom;
  const h = height * zoom;
  const offset = (frame: number, size: number, center: number) =>
    size <= frame ? (frame - size) / 2 : clamp(frame / 2 - size * center, frame - size, 0);
  const x = offset(stage.right, w, region.x + region.w / 2);
  const y = offset(stage.bottom, h, region.y + region.h / 2);
  return { left: x, top: y, right: x + w, bottom: y + h };
}

export function buildImageAnnotateLayout(
  spec: ImageAnnotateSpec,
  cues: readonly number[],
  viewport: StudioViewport
) {
  const stage = {
    left: 0,
    top: 0,
    right: viewport.width,
    bottom: viewport.height - IMAGE_CREDIT_LINE_PX - MIN_TEXT_GAP_PX,
  };
  const shapes = spec.beats.map(({ label }) =>
    label ? studioTextShape(label, 'pill-text', 'middle', MIN_TEXT_PX) : undefined
  );
  const labelSpace = shapes.reduce(
    (height, shape) =>
      shape
        ? Math.max(height, Math.ceil(shape.bounds.bottom - shape.bounds.top) + MIN_TEXT_GAP_PX + 1)
        : height,
    0
  );
  const pictureStage = { ...stage, bottom: Math.max(0, stage.bottom - labelSpace) };
  const scale = Math.min(stage.right / spec.image.width, pictureStage.bottom / spec.image.height);
  const w = spec.image.width * scale;
  const h = spec.image.height * scale;
  const full = {
    left: (stage.right - w) / 2,
    top: (pictureStage.bottom - h) / 2,
    right: (stage.right + w) / 2,
    bottom: (pictureStage.bottom + h) / 2,
  };
  const poses = spec.beats.map(beat => ({
    ...beat,
    image:
      scale > 0 && beat.region && !beat.showOverlay
        ? cameraFor(beat.region, full, pictureStage)
        : full,
  }));
  const labels = poses.map((pose, index) => {
    const shape = shapes[index];
    return pose.label && shape
      ? placeLabel(pose.label, shape, clipBox(pose.image, pictureStage), stage)
      : undefined;
  });

  function frameAt(time: number, reduced = false) {
    const index = cues.reduce((last, cue, index) => (cue <= time ? index : last), -1);
    const pose = poses[index];
    const span = Math.min(MOVE_MS, (cues[index + 1] ?? Infinity) - cues[index]);
    // Guide endpoints refer to the overview and must be visible as soon as its cue starts.
    const progress =
      index < 0 || reduced || pose?.showOverlay ? 1 : clamp((time - cues[index]) / span, 0, 1);
    const eased = progress < 0.5 ? 2 * progress ** 2 : 1 - 2 * (1 - progress) ** 2;
    const image = mixBox(poses[index - 1]?.image ?? full, pose?.image ?? full, eased);
    const clip = clipBox(image, pictureStage);
    const drawPoint = ([x, y]: Point): Point => [
      clamp(mix(image.left, image.right, x), clip.left, clip.right),
      clamp(mix(image.top, image.bottom, y), clip.top, clip.bottom),
    ];
    const shape = shapes[index];
    return {
      image,
      clip,
      focus: pose?.region ? focusBounds(pose.region, image, clip) : undefined,
      shade: pose?.region ? 1 - DIM : 0,
      label:
        progress === 1 || !pose?.label || !shape
          ? labels[index]
          : placeLabel(pose.label, shape, clip, stage),
      ...guideFrame(pose?.showOverlay ? spec.overlay : undefined, drawPoint),
    };
  }

  return {
    stage,
    cues,
    frameAt,
    pictureFits: scale > 0,
    labelsFit: poses.every((pose, index) => !pose.label || labels[index] !== undefined),
  };
}

function guideFrame(overlay: ImageAnnotateSpec['overlay'], drawPoint: (p: Point) => Point) {
  if (!overlay) return { rays: [] };
  const point = drawPoint(overlay.point);
  return { point, rays: overlay.from.map(from => ({ from: drawPoint(from), to: point })) };
}

function focusBounds(
  region: NonNullable<ImageAnnotateSpec['beats'][number]['region']>,
  image: LayoutBounds,
  clip: LayoutBounds
) {
  return clipBox(
    {
      left: mix(image.left, image.right, region.x),
      top: mix(image.top, image.bottom, region.y),
      right: mix(image.left, image.right, region.x + region.w),
      bottom: mix(image.top, image.bottom, region.y + region.h),
    },
    clip
  );
}

export function checkImageAnnotateLayout(layout: ReturnType<typeof buildImageAnnotateLayout>) {
  if (!layout.pictureFits) return ['layout-unavailable'] satisfies StudioCheck[];
  if (!layout.labelsFit) return ['label-placement'] satisfies StudioCheck[];
  const settled = layout.cues.map(cue => layout.frameAt(cue, true));
  if (!settled.some(frame => frame.focus || frame.rays.length || frame.label))
    return ['dead-stage'] satisfies StudioCheck[];
  return checkStudioLayout({
    stage: layout.stage,
    frames: [layout.frameAt(-1), ...settled].map(({ clip, label }) => ({
      elements: [
        { id: 'picture', bounds: clip, mark: true },
        ...(label
          ? [{ id: 'annotation', bounds: label.bounds, label: { fontPx: label.fontPx } }]
          : []),
      ],
    })),
  });
}
