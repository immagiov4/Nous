import { type LessonPlaybackBlock, motionTargets } from '@shared/lessonPlayback';
import type { LessonScene } from '@shared/lessonScene';
import { Fragment, useEffect, useMemo, useRef } from 'react';
import { useResolvedProjectVisual } from '../../../hooks/useResolvedProjectVisual.ts';
import type { StoredLessonVisual } from '../../../types.ts';
import { useShouldAnimate } from '../../../utils/motion/useShouldAnimate.ts';
import { playbackWordIndex, playbackWords } from '../../../utils/reader/lessonPlayback.ts';
import GeneratedVisualFrame from '../../shared/GeneratedVisualFrame.tsx';
import { LessonSceneVisual } from '../../shared/lessonScene/LessonSceneVisual.tsx';
import MarkdownRenderer from '../../shared/MarkdownRenderer.tsx';
import type { WorkspaceReaderContentModel } from '../shell/types.ts';
import './captions.css';

const MOTION_TIMING = { transitionMs: 420, maxFocusSeconds: 4 };
const ITEM_SELECTORS: Record<string, string> = {
  steps: '.sequence>li',
  timeline: '.sequence>li',
  checklist: '.sequence>li',
  hypothesis: '.sequence>li',
  causal: '.cause',
  roles: '.roles>section',
  layers: '.nested-layers section',
  source: '.source-profile .concept,.source dl>div',
  number: '.big-number',
};

function sceneElements(host: HTMLElement, scene: LessonScene) {
  const elements = new Map<string, HTMLElement | SVGElement>();
  if (scene.diagram) {
    const nodes = Array.from(host.querySelectorAll<SVGElement>('g.node'));
    scene.diagram.nodes.forEach((node, index) => {
      const element = nodes.find(element => element.id.includes(`flowchart-n${index}-`));
      if (element) elements.set(`node:${node.id}`, element);
    });
    host.querySelectorAll<SVGElement>('path.flowchart-link').forEach((element, index) => {
      elements.set(`edge:${index}`, element);
    });
  } else {
    const selector =
      scene.type === 'matrix'
        ? 'tbody>tr'
        : scene.groups.length
          ? '.groups>section'
          : (ITEM_SELECTORS[scene.type] ?? '.visual-content .concept');
    const targets = motionTargets(scene);
    host.querySelectorAll<HTMLElement>(selector).forEach((element, index) => {
      if (targets[index]) elements.set(targets[index].id, element);
    });
  }
  return elements;
}

function PlaybackScene({
  scene,
  block,
  time,
  duration,
  isDarkMode,
}: {
  scene: LessonScene;
  block: LessonPlaybackBlock;
  time: number;
  duration: number;
  isDarkMode: boolean;
}) {
  const host = useRef<HTMLDivElement>(null);
  const animate = useShouldAnimate();
  const words = useMemo(() => playbackWords(block.speech), [block.speech]);
  const cues = useMemo(
    () =>
      (block.prepared?.motion ?? []).map(event => {
        const offset = block.speech.indexOf(event.quote);
        const start = (words.filter(word => word.start < offset).length / words.length) * duration;
        const end =
          (words.filter(word => word.start < offset + event.quote.length).length / words.length) *
          duration;
        return { ...event, start, end };
      }),
    [block.prepared?.motion, block.speech, duration, words]
  );
  useEffect(() => {
    const element = host.current;
    if (!element) throw new Error('Playback scene must be mounted');
    const render = () => {
      for (const [id, target] of sceneElements(element, scene)) {
        const reveal = cues.find(cue => cue.effect === 'reveal' && cue.targets.includes(id));
        const focus = cues.some(
          cue =>
            cue.effect === 'focus' &&
            cue.targets.includes(id) &&
            time >= cue.start &&
            time < Math.min(cue.end, cue.start + MOTION_TIMING.maxFocusSeconds)
        );
        target.style.opacity = reveal && time < reveal.start ? '0' : '1';
        target.style.transition = animate
          ? `opacity ${MOTION_TIMING.transitionMs}ms, outline-color ${MOTION_TIMING.transitionMs}ms`
          : 'none';
        target.classList.toggle('outline', focus);
        target.classList.toggle('outline-orange-500', focus);
        target.classList.toggle('rounded-xl', focus);
      }
    };
    render();
    // Diagrams render asynchronously; apply the same current-time state to their SVG.
    const observer = new MutationObserver(render);
    observer.observe(element, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [animate, cues, scene, time]);
  return (
    <div ref={host}>
      <LessonSceneVisual scene={scene} isDarkMode={isDarkMode} />
    </div>
  );
}

function PlaybackStoredVisual({
  visual,
  content,
  block,
  time,
  duration,
}: {
  visual: StoredLessonVisual;
  content: WorkspaceReaderContentModel;
  block: LessonPlaybackBlock;
  time: number;
  duration: number;
}) {
  const resolved = useResolvedProjectVisual(visual, content.projectId);
  const scene = resolved.result?.visual.scene;
  return scene ? (
    <PlaybackScene
      scene={scene}
      block={block}
      time={time}
      duration={duration}
      isDarkMode={content.isDarkMode}
    />
  ) : (
    <GeneratedVisualFrame
      title={visual.title ?? block.heading}
      visual={visual}
      projectId={content.projectId}
      isDarkMode={content.isDarkMode}
    />
  );
}

export default function LessonPlaybackStage({
  block,
  time,
  duration,
  content,
}: {
  block: LessonPlaybackBlock;
  time: number;
  duration: number;
  content: WorkspaceReaderContentModel;
}) {
  const words = useMemo(() => playbackWords(block.speech), [block.speech]);
  const activeIndex = playbackWordIndex(words.length, time, duration);
  const activeWord = useRef<HTMLSpanElement>(null);
  const captions = useRef<HTMLParagraphElement>(null);
  const captionScroll = useRef({ line: -1, target: 0 });
  const animate = useShouldAnimate();
  // biome-ignore lint/correctness/useExhaustiveDependencies: each block starts a new caption page
  useEffect(() => {
    if (captions.current) captions.current.scrollTop = 0;
    captionScroll.current = { line: -1, target: 0 };
  }, [block.id]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: advancing the word moves the scroll target
  useEffect(() => {
    const paragraph = captions.current;
    const word = activeWord.current;
    if (!paragraph || !word) return;
    const line = word.offsetTop;
    const scroll = captionScroll.current;
    if (line === scroll.line) return;
    if (line + word.offsetHeight > scroll.target + paragraph.clientHeight / 2) {
      scroll.target = Math.max(0, line);
      paragraph.scrollTo({ top: scroll.target, behavior: animate ? 'smooth' : 'instant' });
    }
    scroll.line = line;
  }, [activeIndex, animate, block.id]);
  const visuals = block.visuals.length
    ? block.visuals
    : block.prepared?.scene
      ? [{ kind: 'scene' as const, scene: block.prepared.scene }]
      : [];
  const visual =
    visuals[
      Math.min(
        visuals.length - 1,
        duration > 0 ? Math.floor((time / duration) * visuals.length) : 0
      )
    ];
  const stored =
    visual?.kind === 'generated-visual'
      ? content.activeSectionGeneratedVisualsById?.[visual.visualId]
      : undefined;
  return (
    <section className="grid min-h-0 flex-1 grid-cols-1 items-center gap-5 overflow-auto px-4 py-3 md:grid-cols-[minmax(0,.8fr)_minmax(0,1.2fr)] md:gap-[6%] md:px-[4%] md:py-6">
      <div className="order-2 min-h-0 md:order-1">
        {block.heading ? (
          <h2 className="mb-4 text-[13px] font-bold text-stone-800 dark:text-stone-100">
            {block.heading}
          </h2>
        ) : null}
        <p
          ref={captions}
          className="lesson-playback-captions text-[19px] leading-normal tracking-[-.025em] text-stone-900 md:text-[clamp(23px,2.4vw,34px)] dark:text-stone-100"
        >
          {words.map((word, index) =>
            block.heading &&
            block.speech.startsWith(`${block.heading}\n`) &&
            word.start < block.heading.length ? null : (
              <Fragment key={word.start}>
                <span
                  ref={index === activeIndex ? activeWord : undefined}
                  className={`inline-block ${index < activeIndex ? 'opacity-45' : index === activeIndex ? 'opacity-100' : 'opacity-10'} motion-safe:transition-opacity`}
                >
                  {word.text}
                </span>{' '}
              </Fragment>
            )
          )}
        </p>
      </div>
      <div className="order-1 min-h-0 max-h-full overflow-auto rounded-3xl bg-white px-5 py-5 md:order-2 md:px-10 md:py-9 dark:bg-zinc-800">
        {visual?.kind === 'scene' ? (
          <PlaybackScene
            scene={visual.scene}
            block={block}
            time={time}
            duration={duration}
            isDarkMode={content.isDarkMode}
          />
        ) : null}
        {visual?.kind === 'markdown' ? (
          <MarkdownRenderer
            content={visual.markdown}
            isDarkMode={content.isDarkMode}
            projectId={content.projectId}
            lessonAssetsById={content.activeSectionAssetsById}
            lessonImageRefsById={content.activeSectionImageRefsById}
            generatedVisualsById={content.activeSectionGeneratedVisualsById}
          />
        ) : null}
        {stored ? (
          <PlaybackStoredVisual
            visual={stored}
            content={content}
            block={block}
            time={time}
            duration={duration}
          />
        ) : null}
      </div>
    </section>
  );
}
