import type { StudioLessonScene } from '@shared/lessonScene';
import { type SceneAnimationFrame, studioReaderCues } from '@shared/lessonSceneAnimation';
import {
  buildAlgorithmLayout,
  loadMusicStaff,
  needsMusicStaff,
} from '@shared/lessonStudios/algorithmLayout';
import type { StudioViewport } from '@shared/lessonStudios/chartDimensions';
import type { BuildMusicStaff } from '@shared/lessonStudios/music';
import { StudioLayoutError } from '@shared/lessonStudios/studioLayoutError';
import { openingCueDelay } from '@shared/lessonStudios/traceTiming';
import { mountStudio } from './paintStudio.ts';
import type { mountSpace3d } from './space3dMesh';
import './algorithmStudio.css';
import './geometryStudio.css';
import './musicStudio.css';
import './space3dStudio.css';

function mappedTime(elapsedMs: number, source: number[], target: number[]): number {
  const index = source.findIndex(time => time > elapsedMs);
  if (index < 0) return target[target.length - 1];
  if (index === 0) return 0;
  const position = (elapsedMs - source[index - 1]) / (source[index] - source[index - 1]);
  return target[index - 1] + (target[index] - target[index - 1]) * position;
}

function layoutClock(frame: SceneAnimationFrame, cues: number[], durationMs: number) {
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
  return {
    time: mappedTime(frame.elapsedMs, source, target),
    cueAt: (index: number) => mappedTime(cues[index], target, source) / 1000,
  };
}

/** Reader and playback share the same renderer. Only the owner of the clock changes. */
export function algorithmRenderer(
  root: HTMLElement,
  scene: StudioLessonScene,
  animate: boolean,
  {
    imageUrl,
    onCatalogFallback,
  }: { imageUrl?: string; onCatalogFallback?: (active: boolean) => void } = {}
) {
  const drawing = document.createElement('div');
  drawing.dataset.studio = scene.type === 'algorithm' ? scene.studio.id : scene.geometryStudio.id;
  root.append(drawing);
  const spatial = drawing.dataset.studio === 'space-3d';
  const music = drawing.dataset.studio === 'music';
  const notation = needsMusicStaff(scene);
  let staff: BuildMusicStaff | undefined;
  let catalogFallback: boolean | undefined;
  let engine: typeof import('@shared/lessonStudios/space3d').buildSpace3d | undefined;
  let adapter: typeof import('./space3dMesh') | undefined;
  let canvas: ReturnType<typeof mountSpace3d> | undefined;
  let failed = false;
  let disposed = false;
  const fallbackCues = spatial ? studioReaderCues(scene) : [];
  let viewport: StudioViewport | undefined;
  let layout: ReturnType<typeof buildAlgorithmLayout> | undefined;
  let paint: (() => void) | undefined;
  let lastFrame: SceneAnimationFrame | undefined;
  let previousTime: number | undefined;
  let previousPlaybackTime: number | undefined;
  function showCatalogFallback(reason: string) {
    drawing.replaceChildren();
    drawing.hidden = true;
    layout = undefined;
    paint = undefined;
    console.info('[lesson-studio] display layout rejected', {
      studio: drawing.dataset.studio,
      ...viewport,
      reason,
    });
    catalogFallback = true;
    onCatalogFallback?.(true);
  }
  function paintFallback(frame: SceneAnimationFrame) {
    const times = frame.cueTimes?.length ? frame.cueTimes : fallbackCues;
    const next = times.findIndex(time => time > frame.elapsedMs);
    const index = next < 0 ? times.length - 1 : Math.max(0, next - 1);
    const phrase = scene.studioCues[index]?.anchor ?? scene.narration;
    if (drawing.textContent !== phrase) drawing.textContent = phrase;
  }
  function fail() {
    if (disposed || failed) return;
    failed = true;
    drawing.dataset.studioFallback = 'space-3d-render-unavailable';
    layout?.spatial?.dispose();
    layout = undefined;
    canvas?.dispose();
    canvas = undefined;
    drawing.replaceChildren();
    if (lastFrame) paintFallback(lastFrame);
  }
  function draw(action: () => void) {
    try {
      action();
    } catch (error) {
      if (!spatial) throw error;
      fail();
    }
  }
  function paintFrame(frame: SceneAnimationFrame) {
    if (!layout || !paint) return;
    const { time, cueAt } = layoutClock(frame, layout.cues, layout.durationMs);
    const playbackTime = music ? frame.elapsedMs : undefined;
    if (time === previousTime && playbackTime === previousPlaybackTime) {
      if (layout.refreshHold?.(time, frame)) paint();
      return;
    }
    previousTime = time;
    previousPlaybackTime = playbackTime;
    const musicClock =
      playbackTime === undefined ? undefined : { seconds: playbackTime / 1000, cueAt };
    layout.seek(time, !animate, { frame, musicClock });
    if (layout.spatial) canvas?.paint(layout.spatial.mesh);
    const creditRight = layout.surface.data.imageCreditRight;
    if (creditRight !== undefined)
      root.style.setProperty('--image-credit-right', `${creditRight}px`);
    const creditTop = layout.surface.data.imageCreditTop;
    if (creditTop !== undefined) root.style.setProperty('--image-credit-top', `${creditTop}px`);
    paint();
  }
  function layoutStage() {
    if (failed || (spatial && !engine) || (notation && !staff)) return;
    const { width, height } = root.getBoundingClientRect();
    if (width <= 0 || height <= 0) return;
    if (viewport?.width === width && viewport.height === height) return;
    viewport = { width, height };
    layout?.spatial?.dispose();
    layout = undefined;
    try {
      layout = buildAlgorithmLayout(scene, viewport, {
        space3d: engine,
        paintColors: adapter?.getSpace3dColors(drawing),
        staff,
        imageUrl,
      });
    } catch (error) {
      if (!(error instanceof StudioLayoutError) || error.code !== 'music-stage-too-small')
        throw error;
      showCatalogFallback(error.code);
      return;
    }
    if (music && catalogFallback !== false) {
      catalogFallback = false;
      drawing.hidden = false;
      onCatalogFallback?.(false);
    }
    // A chart has no class until its first frame is painted.
    drawing.querySelector(':scope > svg')?.remove();
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
    paint = mountStudio(drawing, layout.surface, spatial);
    previousTime = undefined;
    if (lastFrame) paintFrame(lastFrame);
  }
  let fitFrame: number | undefined;
  function scheduleFit() {
    fitFrame ??= requestAnimationFrame(() => {
      fitFrame = undefined;
      draw(layoutStage);
    });
  }
  const observer = new ResizeObserver(scheduleFit);
  observer.observe(root);
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
  if (notation) {
    void loadMusicStaff().then(
      drawStaff => {
        if (disposed) return;
        staff = drawStaff;
        scheduleFit();
      },
      () => {
        if (!disposed) showCatalogFallback('music-staff-unavailable');
      }
    );
  }
  if (spatial) {
    void Promise.all([import('@shared/lessonStudios/space3d'), import('./space3dMesh')])
      .then(async ([module, spatialAdapter]) => {
        await spatialAdapter.loadSpace3dFont();
        if (disposed) return;
        adapter = spatialAdapter;
        engine = module.buildSpace3d;
        canvas = adapter.mountSpace3d(drawing, fail);
        layoutStage();
      })
      .catch(fail);
  }
  return {
    render(frame: SceneAnimationFrame) {
      lastFrame = frame;
      if (failed) paintFallback(frame);
      else draw(() => (layout ? paintFrame(frame) : layoutStage()));
    },
    dispose() {
      disposed = true;
      layout?.spatial?.dispose();
      canvas?.dispose();
      observer.disconnect();
      themeObserver?.disconnect();
      if (fitFrame !== undefined) cancelAnimationFrame(fitFrame);
      drawing.remove();
    },
  };
}
