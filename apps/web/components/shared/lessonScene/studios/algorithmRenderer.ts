import type { AlgorithmLessonScene } from '@shared/lessonScene';
import type { SceneAnimationFrame } from '@shared/lessonSceneAnimation';
import { buildAlgorithmLayout } from '@shared/lessonStudios/algorithmLayout';
import { mountStudio } from './paintStudio.ts';
import './algorithmStudio.css';

function layoutTime(frame: SceneAnimationFrame, cues: number[], durationMs: number): number {
  const audio = frame.cueTimes?.length === cues.length ? frame.cueTimes : [];
  const source = [0, ...audio, frame.durationMs];
  const target = [0, ...(audio.length ? cues : []), durationMs];
  const index = source.findIndex(time => time > frame.elapsedMs);
  if (index < 0) return durationMs;
  if (index === 0) return 0;
  const position = (frame.elapsedMs - source[index - 1]) / (source[index] - source[index - 1]);
  return target[index - 1] + (target[index] - target[index - 1]) * position;
}

/** Reader and playback share the same renderer. Only the owner of the clock changes. */
export function algorithmRenderer(
  root: HTMLElement,
  scene: AlgorithmLessonScene,
  animate: boolean
) {
  const layout = buildAlgorithmLayout(scene);
  root.replaceChildren();
  const paint = mountStudio(root, layout.surface);
  let previousTime: number | undefined;
  const { studio } = scene;
  root.dataset.studio = studio.id;
  return (frame: SceneAnimationFrame) => {
    const time = layoutTime(frame, layout.cues, layout.durationMs);
    if (time === previousTime) return;
    previousTime = time;
    layout.seek(time, !animate);
    paint();
  };
}
