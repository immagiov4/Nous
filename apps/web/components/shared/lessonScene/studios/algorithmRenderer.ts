import type { StudioLessonScene } from '@shared/lessonScene';
import { type SceneAnimationFrame, studioReaderCues } from '@shared/lessonSceneAnimation';
import { buildAlgorithmLayout } from '@shared/lessonStudios/algorithmLayout';
import { chartViewport, type StudioViewport, WIDTH } from '@shared/lessonStudios/chartDimensions';
import type { buildSpace3d } from '@shared/lessonStudios/space3d';
import { openingCueDelay } from '@shared/lessonStudios/traceTiming';
import { mountStudio } from './paintStudio.ts';
import type { getSpace3dColors, mountSpace3d } from './space3dMesh';
import './algorithmStudio.css';
import './geometryStudio.css';
import './space3dStudio.css';

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
export function algorithmRenderer(root: HTMLElement, scene: StudioLessonScene, animate: boolean) {
  root.replaceChildren();
  delete root.dataset.studioFallback;
  let viewport: StudioViewport | undefined;
  let layout: ReturnType<typeof buildAlgorithmLayout> | undefined;
  let paint: (() => void) | undefined;
  let lastFrame: SceneAnimationFrame | undefined;
  let previousTime: number | undefined;
  root.dataset.studio = scene.type === 'algorithm' ? scene.studio.id : scene.geometryStudio.id;
  const spatial = scene.type === 'geometry' && scene.geometryStudio.id === 'space-3d';
  let engine: typeof buildSpace3d | undefined;
  let readColors: typeof getSpace3dColors | undefined;
  let canvas: ReturnType<typeof mountSpace3d> | undefined;
  let failed = false;
  let disposed = false;
  const fallbackCues = spatial ? studioReaderCues(scene) : [];
  function paintFallback(frame: SceneAnimationFrame) {
    const times = frame.cueTimes?.length ? frame.cueTimes : fallbackCues;
    const next = times.findIndex(time => time > frame.elapsedMs);
    const index = next < 0 ? times.length - 1 : Math.max(0, next - 1);
    const phrase = scene.studioCues[index]?.anchor ?? scene.narration;
    if (root.textContent !== phrase) root.textContent = phrase;
  }
  function fail() {
    if (disposed || failed) return;
    failed = true;
    root.dataset.studioFallback = 'space-3d-render-unavailable';
    layout?.spatial?.dispose();
    layout = undefined;
    canvas?.dispose();
    canvas = undefined;
    root.replaceChildren();
    if (lastFrame) paintFallback(lastFrame);
  }
  if (spatial) {
    void Promise.all([import('@shared/lessonStudios/space3d'), import('./space3dMesh')])
      .then(async ([module, adapter]) => {
        await adapter.loadSpace3dFont();
        if (disposed) return;
        canvas = adapter.mountSpace3d(root, fail);
        engine = module.buildSpace3d;
        readColors = adapter.getSpace3dColors;
        fitLayout();
      })
      .catch(fail);
  }
  function paintFrame(frame: SceneAnimationFrame) {
    if (!layout || !paint) return;
    const time = layoutTime(frame, layout.cues, layout.durationMs);
    if (time === previousTime) return;
    previousTime = time;
    layout.seek(time, !animate);
    if (layout.spatial) canvas?.paint(layout.spatial.mesh);
    paint();
  }
  function fitLayout() {
    if (failed || (spatial && !engine)) return;
    const { width } = root.getBoundingClientRect();
    if (width <= 0) return;
    const actualHeight = root.querySelector('svg.chart')?.getBoundingClientRect().height;
    const height = actualHeight || (width * chartViewport.height) / WIDTH;
    if (viewport?.width === width && viewport.height === height) return;
    viewport = { width, height };
    layout?.spatial?.dispose();
    layout = buildAlgorithmLayout(scene, viewport, engine, readColors?.(root));
    root.querySelector('svg.chart')?.remove();
    paint = mountStudio(root, layout.surface, spatial);
    paint();
    previousTime = undefined;
    if (lastFrame) paintFrame(lastFrame);
  }
  let fitFrame: number | undefined;
  function scheduleFit() {
    fitFrame ??= requestAnimationFrame(() => {
      fitFrame = undefined;
      try {
        fitLayout();
      } catch (error) {
        if (!spatial) throw error;
        fail();
      }
    });
  }
  const observer = new ResizeObserver(scheduleFit);
  observer.observe(root);
  const fittedCard = root.closest('.scene-host');
  const transformObserver = new MutationObserver(scheduleFit);
  if (fittedCard)
    transformObserver.observe(fittedCard, { attributes: true, attributeFilter: ['style'] });
  const themeObserver = spatial
    ? new MutationObserver(() => {
        viewport = undefined;
        scheduleFit();
      })
    : undefined;
  themeObserver?.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['class'],
  });
  return {
    render(frame: SceneAnimationFrame) {
      lastFrame = frame;
      if (failed) paintFallback(frame);
      else {
        try {
          if (layout) paintFrame(frame);
          else fitLayout();
        } catch (error) {
          if (!spatial) throw error;
          fail();
        }
      }
    },
    dispose() {
      disposed = true;
      layout?.spatial?.dispose();
      canvas?.dispose();
      observer.disconnect();
      transformObserver.disconnect();
      themeObserver?.disconnect();
      if (fitFrame !== undefined) cancelAnimationFrame(fitFrame);
    },
  };
}
