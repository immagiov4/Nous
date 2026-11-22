import type { StudioLessonScene } from '@shared/lessonScene';
import type { SceneAnimationFrame } from '@shared/lessonSceneAnimation';
import { buildAlgorithmLayout } from '@shared/lessonStudios/algorithmLayout';
import type { StudioViewport } from '@shared/lessonStudios/chartDimensions';
import { openingCueDelay } from '@shared/lessonStudios/traceTiming';
import { mountStudio } from './paintStudio.ts';
import './algorithmStudio.css';
import './geometryStudio.css';

function layoutTime(frame: SceneAnimationFrame, cues: number[], durationMs: number): number {
  const audio = frame.cueTimes?.slice(0, cues.length) ?? [];
  const source = [0, ...audio, frame.durationMs];
  const target = [0, ...cues.slice(0, audio.length), durationMs];
  if (audio.length && cues[0] === 0) {
    // Stretching the recording must not stretch the opening prerequisites past the cue budget.
    const sourceDelay = openingCueDelay(source[2] - audio[0]);
    const targetDelay = openingCueDelay(cues[1] ?? durationMs);
    source.splice(2, 0, audio[0] + sourceDelay);
    target.splice(2, 0, targetDelay);
  }
  const index = source.findIndex(time => time > frame.elapsedMs);
  if (index < 0) return durationMs;
  if (index === 0) return 0;
  const position = (frame.elapsedMs - source[index - 1]) / (source[index] - source[index - 1]);
  return target[index - 1] + (target[index] - target[index - 1]) * position;
}

/** Reader and playback share the same renderer. Only the owner of the clock changes. */
export function algorithmRenderer(
  root: HTMLElement,
  scene: StudioLessonScene,
  animate: boolean,
  imageUrl?: string
) {
  const drawing = document.createElement('div');
  drawing.dataset.studio = scene.type === 'algorithm' ? scene.studio.id : scene.geometryStudio.id;
  root.append(drawing);
  let viewport: StudioViewport | undefined;
  let layout: ReturnType<typeof buildAlgorithmLayout> | undefined;
  let paint: (() => void) | undefined;
  let lastFrame: SceneAnimationFrame | undefined;
  let previousTime: number | undefined;
  function paintFrame(frame: SceneAnimationFrame) {
    if (!layout || !paint) return;
    const time = layoutTime(frame, layout.cues, layout.durationMs);
    if (time === previousTime) return;
    previousTime = time;
    layout.seek(time, !animate);
    const creditRight = layout.surface.data.imageCreditRight;
    if (creditRight !== undefined)
      root.style.setProperty('--image-credit-right', `${creditRight}px`);
    const creditTop = layout.surface.data.imageCreditTop;
    if (creditTop !== undefined) root.style.setProperty('--image-credit-top', `${creditTop}px`);
    paint();
  }
  function layoutStage() {
    const { width, height } = root.getBoundingClientRect();
    if (width <= 0 || height <= 0) return;
    if (viewport?.width === width && viewport.height === height) return;
    viewport = { width, height };
    layout = buildAlgorithmLayout(scene, viewport, imageUrl);
    drawing.replaceChildren();
    const checks = layout.checks;
    if (checks?.length) {
      root.dataset.imageLayoutChecks = checks.join(' ');
      console.info('[lesson-studio] reader layout rejected', {
        studio: 'image-annotate',
        ...viewport,
        checks,
      });
      paint = undefined;
      return;
    }
    delete root.dataset.imageLayoutChecks;
    paint = mountStudio(drawing, layout.surface);
    previousTime = undefined;
    if (lastFrame) paintFrame(lastFrame);
  }
  let fitFrame: number | undefined;
  function scheduleFit() {
    fitFrame ??= requestAnimationFrame(() => {
      fitFrame = undefined;
      layoutStage();
    });
  }
  const observer = new ResizeObserver(scheduleFit);
  observer.observe(root);
  return {
    render(frame: SceneAnimationFrame) {
      lastFrame = frame;
      if (layout) paintFrame(frame);
      else layoutStage();
    },
    dispose() {
      observer.disconnect();
      if (fitFrame !== undefined) cancelAnimationFrame(fitFrame);
      drawing.remove();
    },
  };
}
