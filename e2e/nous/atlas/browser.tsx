import {
  captionFormat,
  captionSource,
  captionSpeechRanges,
} from '@atlas-web/components/workspace/playback/captionFormat.ts';
import LessonPlaybackStage from '@atlas-web/components/workspace/playback/LessonPlaybackStage.tsx';
import type { WorkspaceReaderContentModel } from '@atlas-web/components/workspace/shell/types.ts';
import { playbackTimeline } from '@atlas-web/utils/reader/lessonPlayback.ts';
import { buildLessonImageRefMap } from '@atlas-web/utils/reader/workspaceReader.ts';
import { getStoredLessonVisualScene } from '@atlas-web/utils/visuals/storedLessonVisual.ts';
import { segmentLessonPlayback } from '@shared/lessonPlayback';
import { findLessonSceneProblems } from '@shared/lessonScene';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { captionFindings, POSITIONS } from './checks';
import type { AtlasSample } from './contracts';
import '@atlas-web/styles/app.css';
import '@atlas-katex.css';
import './page.css';

// Capture the settled caption position without depending on a wall-clock scroll animation.
const nativeScrollTo = Element.prototype.scrollTo;
Element.prototype.scrollTo = function (options?: ScrollToOptions | number, y?: number) {
  if (typeof options === 'object' && this.matches('.caption-page')) {
    Reflect.apply(nativeScrollTo, this, [{ ...options, behavior: 'instant' }]);
    return;
  }
  Reflect.apply(nativeScrollTo, this, typeof options === 'number' ? [options, y] : [options]);
};

// Load the same icon module used by SceneIconProvider before sampling its committed DOM.
const iconsReady = import('@tabler-icon-nodes');

const rootElement = document.getElementById('root');
if (!rootElement) throw new Error('Atlas root is missing.');
const root = createRoot(rootElement);

async function frame() {
  await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
}

/** Advance the production stage through explicit positions; its readTime never follows wall time. */
async function render(sample: AtlasSample) {
  await iconsReady;
  flushSync(() => root.render(null));
  const { lesson, position, visualIndex } = sample;
  const block =
    visualIndex === null
      ? sample.block
      : {
          ...sample.block,
          visuals: [sample.block.visuals[visualIndex]],
          prepared: undefined,
        };
  const duration = playbackTimeline([block], '')[0].duration;
  const time = duration * POSITIONS[position];
  const content = {
    projectId: lesson.projectId,
    activeSectionTitle: lesson.title,
    sectionContent: lesson.content,
    sectionContentBlocks: lesson.sources,
    activeSectionAssetsById: lesson.images,
    activeSectionImageRefsById: buildLessonImageRefMap(lesson.imageRefs),
    activeSectionGeneratedVisualsById: Object.fromEntries(
      lesson.visuals.map(visual => [visual.id, visual])
    ),
    isDarkMode: false,
  } as WorkspaceReaderContentModel;
  flushSync(() =>
    root.render(
      <LessonPlaybackStage
        key={JSON.stringify([lesson.id, block.id, visualIndex])}
        block={block}
        duration={duration}
        time={time}
        readTime={() => time}
        content={content}
      />
    )
  );
  await document.fonts.ready;
  await frame();
  await frame();
  const source = captionSource(block, lesson.sources);
  const formatted = captionFormat(source.markdown, source.ranges);
  const ranges = captionSpeechRanges(formatted.words, source.ranges);
  const actual = Array.from(
    document.querySelectorAll('.caption-word'),
    element => element.textContent ?? ''
  );
  const captions = formatted.words.map((word, index) => ({
    text: actual[index]?.replace(word.breakBefore ? `${word.marker} ` : '', '') ?? '',
    range: ranges[index],
  }));
  const scenes = block.visuals.flatMap(visual => {
    if (visual.kind === 'scene') return [visual.scene];
    if (visual.kind !== 'generated-visual') return [];
    const stored = content.activeSectionGeneratedVisualsById?.[visual.visualId];
    const scene = stored && getStoredLessonVisualScene(stored);
    return scene ? [scene] : [];
  });
  if (block.prepared?.scene) scenes.push(block.prepared.scene);
  return {
    duration,
    time,
    speech: block.speech,
    captions: actual,
    expectedVisual: Boolean(block.visuals.length || block.prepared?.scene),
    findings: [
      ...captionFindings(block.speech, captions),
      ...scenes.flatMap(scene =>
        findLessonSceneProblems(scene, lesson.content).map(problem => ({
          kind: 'scene-invalid' as const,
          detail: problem,
        }))
      ),
    ],
  };
}

window.playbackAtlas = { prepare: lesson => segmentLessonPlayback(lesson.sources), render };
