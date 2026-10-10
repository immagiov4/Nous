import type { LessonPlaybackBlock, PlaybackRange } from '@shared/lessonPlayback';
import type { LessonScene } from '@shared/lessonScene';
import { Fragment, type RefObject, useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { useResolvedProjectVisual } from '../../../hooks/useResolvedProjectVisual.ts';
import type { StoredLessonVisual } from '../../../types.ts';
import { useShouldAnimate } from '../../../utils/motion/useShouldAnimate.ts';
import GeneratedVisualFrame from '../../shared/GeneratedVisualFrame.tsx';
import { LessonSceneVisual } from '../../shared/lessonScene/LessonSceneVisual.tsx';
import MarkdownRenderer from '../../shared/MarkdownRenderer.tsx';
import type { WorkspaceReaderContentModel } from '../shell/types.ts';
import {
  CAPTION_SCROLL,
  CAPTION_TIMING,
  captionFormat,
  captionLookAhead,
  captionPauses,
  captionSource,
  captionSpeechRanges,
  pacedCaptionTime,
} from './captionFormat.ts';
import {
  type CaptionRun,
  captionMotionEvents,
  motionStates,
  sceneElements,
  type TimedMotionEvent,
} from './stageMotion.ts';
import './stage.css';

interface CaptionClock {
  runs: CaptionRun[];
  width: number;
  feather: number;
  bodyDuration: number;
  speechRanges: PlaybackRange[];
  read: () => { bodyTime: number; revealTime: number };
}

function PlaybackScene({
  scene,
  block,
  clock,
  speed,
  animate,
  isDarkMode,
}: {
  scene: LessonScene;
  block: LessonPlaybackBlock;
  clock: RefObject<CaptionClock | null>;
  speed: number;
  animate: boolean;
  isDarkMode: boolean;
}) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!block.prepared?.motion.length) return;
    const element = host.current;
    if (!element) throw new Error('Playback scene must be mounted');
    let elements = sceneElements(element, scene);
    let events: TimedMotionEvent[] = [];
    let previousClock: CaptionClock | null = null;
    let previousFrame = '';
    const render = () => {
      const current = clock.current;
      if (!current || !current.width || !current.bodyDuration) return;
      if (current !== previousClock) {
        events = captionMotionEvents({
          events: block.prepared?.motion ?? [],
          speech: block.speech,
          speechRanges: current.speechRanges,
          runs: current.runs,
          width: current.width,
          feather: current.feather,
          duration: current.bodyDuration,
        });
        previousClock = current;
        previousFrame = '';
      }
      if (events.some(event => event.targets.some(target => !elements.has(target)))) return;
      const revealTime = Math.max(0, current.read().revealTime * 1000);
      const frameKey = `${revealTime}:${animate}:${speed}`;
      if (frameKey === previousFrame) return;
      previousFrame = frameKey;
      const states = motionStates(
        Array.from(elements.keys()),
        events,
        revealTime,
        !animate,
        CAPTION_TIMING.highlightDelaySeconds * 1000 * speed
      );
      for (const [id, target] of elements) {
        const state = states.get(id);
        if (!state) throw new Error('Motion target state must exist');
        target.dataset.motionId = id;
        target.classList.add('motion-target');
        target.style.opacity = String(state.opacity);
        target.style.setProperty('--motion-emphasis', String(state.emphasis));
      }
    };
    // Mermaid mounts its targets asynchronously. Rediscover only when the scene DOM changes.
    const observer = new MutationObserver(() => {
      elements = sceneElements(element, scene);
      previousFrame = '';
      render();
    });
    observer.observe(element, { childList: true, subtree: true });
    let frame = 0;
    const tick = () => {
      render();
      frame = requestAnimationFrame(tick);
    };
    tick();
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      for (const target of elements.values()) {
        target.classList.remove('motion-target');
        target.style.removeProperty('opacity');
        target.style.removeProperty('--motion-emphasis');
        delete target.dataset.motionId;
      }
    };
  }, [animate, block.prepared?.motion, block.speech, clock, scene, speed]);
  return (
    <div ref={host}>
      <LessonSceneVisual scene={scene} isDarkMode={isDarkMode} variant="bare" />
    </div>
  );
}

function PlaybackStoredVisual({
  visual,
  content,
  ...props
}: {
  visual: StoredLessonVisual;
  content: WorkspaceReaderContentModel;
  block: LessonPlaybackBlock;
  clock: RefObject<CaptionClock | null>;
  speed: number;
  animate: boolean;
}) {
  const resolved = useResolvedProjectVisual(visual, content.projectId);
  const scene = resolved.result?.visual.scene;
  return scene ? (
    <PlaybackScene {...props} scene={scene} isDarkMode={content.isDarkMode} />
  ) : (
    <GeneratedVisualFrame
      className="lesson-player-generated"
      title={visual.title ?? props.block.heading}
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
  speed = 1,
  readTime,
}: {
  block: LessonPlaybackBlock;
  time: number;
  duration: number;
  content: WorkspaceReaderContentModel;
  speed?: number;
  readTime?: () => number;
}) {
  const sources = useMemo(
    () =>
      content.sectionContentBlocks?.length
        ? content.sectionContentBlocks
        : [{ type: 'markdown' as const, markdown: content.sectionContent }],
    [content.sectionContentBlocks, content.sectionContent]
  );
  const formatted = useMemo(() => {
    const source = captionSource(block, sources);
    const captions = captionFormat(source.markdown);
    return { ...captions, speechRanges: captionSpeechRanges(captions.words, source.ranges) };
  }, [block, sources]);
  const captions = useRef<HTMLParagraphElement>(null);
  const clock = useRef<CaptionClock | null>(null);
  const scroll = useRef({ line: -1, target: 0 });
  const animate = useShouldAnimate();
  const latest = useRef({ time, speed, readTime, animate });
  useLayoutEffect(() => {
    latest.current = { time, speed, readTime, animate };
  }, [time, speed, readTime, animate]);

  useLayoutEffect(() => {
    const paragraph = captions.current;
    if (!paragraph) throw new Error('Captions must be mounted');
    const measure = () => {
      let width = 0;
      const runs = Array.from(paragraph.querySelectorAll<HTMLElement>('.caption-word'), span => {
        const start = width;
        const wordWidth = span.getBoundingClientRect().width;
        width += wordWidth;
        return { span, start, width: wordWidth };
      });
      const feather = parseFloat(getComputedStyle(paragraph).getPropertyValue('--caption-feather'));
      const bodyDuration =
        (duration * formatted.words.length) / (formatted.words.length + formatted.headingWords);
      const pauses = captionPauses(
        formatted.words,
        runs.map(run => (run.start + run.width) / width),
        bodyDuration
      );
      const headingShare =
        formatted.headingWords / (formatted.words.length + formatted.headingWords);
      clock.current = {
        runs,
        width,
        feather,
        bodyDuration,
        speechRanges: formatted.speechRanges,
        read: () => {
          const {
            readTime: read,
            time: fallbackTime,
            speed: rate,
            animate: motion,
          } = latest.current;
          const elapsed = read ? read() : fallbackTime;
          const bodyTime = elapsed - duration * headingShare;
          const ahead = bodyTime + captionLookAhead(elapsed, rate, CAPTION_TIMING.lookAheadSeconds);
          return { bodyTime, revealTime: motion ? pacedCaptionTime(ahead, pauses) : ahead };
        },
      };
      paragraph.scrollTop = 0;
      scroll.current = { line: -1, target: 0 };
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [duration, formatted]);

  useEffect(() => {
    let previousClock: CaptionClock | null = null;
    let previousBodyTime: number | undefined;
    const render = () => {
      const paragraph = captions.current;
      if (!paragraph) throw new Error('Captions must be mounted');
      const current = clock.current;
      if (!current || !current.width || !current.bodyDuration) return;
      if (previousClock !== current) {
        previousClock = current;
        previousBodyTime = undefined;
      }
      const { bodyTime, revealTime } = current.read();
      const motion = latest.current.animate;
      if (previousBodyTime === bodyTime) return;
      const progress = Math.max(0, Math.min(1, revealTime / current.bodyDuration));
      const edge = progress * (current.width + current.feather);
      let active = edge >= current.width ? current.runs.at(-1)?.span : undefined;
      for (const run of current.runs) {
        const local = edge - run.start;
        run.span.style.opacity = local > 0 ? '1' : '0';
        run.span.style.setProperty('--reveal-edge', `${local}px`);
        const readAge = bodyTime - ((run.start + run.width) / current.width) * current.bodyDuration;
        const fade = Math.max(0, Math.min(1, readAge / CAPTION_TIMING.readFadeSeconds));
        const text = run.span.firstElementChild as HTMLElement;
        text.style.opacity = String(1 - fade * (1 - CAPTION_TIMING.readOpacity));
        if (local >= 0 && local <= run.width) active = run.span;
      }
      if (active && active.offsetTop !== scroll.current.line) {
        const line = active.offsetTop;
        if (
          line + active.offsetHeight >
          scroll.current.target + paragraph.clientHeight * CAPTION_SCROLL.trigger
        ) {
          scroll.current.target = Math.max(
            0,
            line - paragraph.clientHeight * CAPTION_SCROLL.destination
          );
          paragraph.scrollTo({
            top: scroll.current.target,
            behavior: motion ? 'smooth' : 'instant',
          });
        }
        scroll.current.line = line;
      }
      previousBodyTime = bodyTime;
    };
    let frame = 0;
    const tick = () => {
      render();
      frame = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(frame);
  }, []);

  const visuals = block.visuals.length
    ? block.visuals
    : block.prepared?.scene
      ? [{ kind: 'scene' as const, scene: block.prepared.scene }]
      : [];
  const visualIndex = Math.min(
    visuals.length - 1,
    duration > 0 ? Math.floor((time / duration) * visuals.length) : 0
  );
  const visual = visuals[visualIndex];
  const visualKey = `${block.id}:${visualIndex}`;
  const stored =
    visual?.kind === 'generated-visual'
      ? content.activeSectionGeneratedVisualsById?.[visual.visualId]
      : undefined;
  const sceneProps = { block, clock, speed, animate };
  return (
    <div className="lesson-player-stage">
      <section className="listening-stage">
        <section className="captions" aria-label="Sottotitoli">
          <h2>{formatted.headings.at(-1) || block.heading}</h2>
          <p ref={captions} key={block.id} className="caption-page">
            {formatted.words.map((word, index) => {
              const Tag = word.code ? 'code' : word.bold ? 'strong' : 'span';
              return (
                // biome-ignore lint/suspicious/noArrayIndexKey: the authored caption page is static and remounted per block
                <Fragment key={`${index}:${word.text}`}>
                  {word.breakBefore && index > 0 ? <br /> : null}
                  <span className="caption-word">
                    <Tag>{(word.breakBefore ? `${word.marker} ` : '') + word.text}</Tag>
                  </span>{' '}
                </Fragment>
              );
            })}
          </p>
        </section>
        <section className="scene-host" aria-label="Visualizzazione della lezione">
          {visual?.kind === 'scene' ? (
            <PlaybackScene
              key={visualKey}
              {...sceneProps}
              scene={visual.scene}
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
              key={visualKey}
              {...sceneProps}
              visual={stored}
              content={content}
            />
          ) : null}
        </section>
      </section>
    </div>
  );
}
