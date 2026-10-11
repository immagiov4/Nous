import type { LessonPlaybackBlock, PlaybackRange, PlaybackVisual } from '@shared/lessonPlayback';
import { isAnimatedLessonScene, type LessonScene } from '@shared/lessonScene';
import { Fragment, type RefObject, useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { translateUiMessage as t } from '../../../i18n/uiMessages.ts';
import type { StoredLessonVisual } from '../../../types.ts';
import { useShouldAnimate } from '../../../utils/motion/useShouldAnimate.ts';
import { getStoredLessonVisualScene } from '../../../utils/visuals/storedLessonVisual.ts';
import GeneratedVisualFrame from '../../shared/GeneratedVisualFrame.tsx';
import type { ReadSceneAnimationFrame } from '../../shared/lessonScene/AnimatedScene.tsx';
import { LessonSceneVisual } from '../../shared/lessonScene/LessonSceneVisual.tsx';
import MarkdownRenderer from '../../shared/MarkdownRenderer.tsx';
import type { WorkspaceReaderContentModel } from '../shell/types.ts';
import {
  CAPTION_SCROLL,
  CAPTION_TIMING,
  type CaptionWord,
  captionFormat,
  captionLookAhead,
  captionPauses,
  captionSource,
  captionSpeechRanges,
  pacedCaptionTime,
} from './captionFormat.ts';
import {
  type CaptionRun,
  captionAnchorSpan,
  captionAnchorTimes,
  captionMotionEvents,
  motionStates,
  sceneCaptionAnchors,
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
  read: () => { blockTime: number; bodyTime: number; revealTime: number };
}

function hasMissingMotionTargets(
  events: readonly TimedMotionEvent[],
  elements: ReturnType<typeof sceneElements>
) {
  return events.some(event => event.targets.some(target => !elements.has(target)));
}

function scrollToCaptionLine(
  paragraph: HTMLElement,
  active: HTMLElement | undefined,
  scroll: { line: number; target: number },
  motion: boolean
) {
  if (!active || active.offsetTop === scroll.line) return;
  const line = active.offsetTop;
  if (
    line + active.offsetHeight >
    scroll.target + paragraph.clientHeight * CAPTION_SCROLL.trigger
  ) {
    scroll.target = Math.max(0, line - paragraph.clientHeight * CAPTION_SCROLL.destination);
    paragraph.scrollTo({ top: scroll.target, behavior: motion ? 'smooth' : 'instant' });
  }
  scroll.line = line;
}

function captionTag(word: CaptionWord) {
  if (word.code) return 'code';
  return word.bold ? 'strong' : 'span';
}

function PlaybackScene({
  scene,
  block,
  clock,
  speed,
  animate,
  isDarkMode,
  interval,
}: Readonly<{
  scene: LessonScene;
  block: LessonPlaybackBlock;
  clock: RefObject<CaptionClock | null>;
  speed: number;
  animate: boolean;
  isDarkMode: boolean;
  interval: { start: number; duration: number };
}>) {
  const host = useRef<HTMLDivElement>(null);
  const readAnimationFrame = useMemo<ReadSceneAnimationFrame | undefined>(() => {
    if (!isAnimatedLessonScene(scene)) return undefined;
    const anchors = sceneCaptionAnchors(scene, block.speech);
    let previousClock: CaptionClock | null = null;
    let times: number[] | undefined;
    return () => {
      const current = clock.current;
      if (!current?.bodyDuration) return undefined;
      if (anchors && !current.width) return undefined;
      if (current !== previousClock) {
        times = anchors
          ? captionAnchorTimes({
              anchors,
              speech: block.speech,
              speechRanges: current.speechRanges,
              runs: current.runs,
              width: current.width,
              feather: current.feather,
              duration: current.bodyDuration,
            })
          : undefined;
        previousClock = current;
      }
      const { blockTime, revealTime } = current.read();
      return anchors
        ? {
            elapsedMs: Math.max(0, revealTime * 1000),
            durationMs: current.bodyDuration * 1000,
            cueTimes: times,
          }
        : {
            elapsedMs: (blockTime - interval.start) * 1000,
            durationMs: interval.duration * 1000,
          };
    };
  }, [scene, block.speech, clock, interval.start, interval.duration]);
  useEffect(() => {
    if (isAnimatedLessonScene(scene) || !block.prepared?.motion.length) return;
    const element = host.current;
    if (!element) throw new Error('Playback scene must be mounted');
    let elements = sceneElements(element, scene);
    let events: TimedMotionEvent[] = [];
    let previousClock: CaptionClock | null = null;
    let previousFrame = '';
    const render = () => {
      const current = clock.current;
      if (!current?.width || !current.bodyDuration) return;
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
      if (hasMissingMotionTargets(events, elements)) return;
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
      for (const [id, targets] of elements) {
        const state = states.get(id);
        if (!state) throw new Error('Motion target state must exist');
        for (const target of targets) {
          target.dataset.motionId = id;
          target.classList.add('motion-target');
          target.style.opacity = String(state.opacity);
          target.style.setProperty('--motion-emphasis', String(state.emphasis));
        }
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
      for (const target of Array.from(elements.values()).flat()) {
        target.classList.remove('motion-target');
        target.style.removeProperty('opacity');
        target.style.removeProperty('--motion-emphasis');
        delete target.dataset.motionId;
      }
    };
  }, [animate, block.prepared?.motion, block.speech, clock, scene, speed]);
  return (
    <div ref={host}>
      <LessonSceneVisual
        scene={scene}
        isDarkMode={isDarkMode}
        variant="bare"
        readAnimationFrame={readAnimationFrame}
      />
    </div>
  );
}

function PlaybackStoredVisual({
  visual,
  content,
  ...props
}: Readonly<{
  visual: StoredLessonVisual;
  content: WorkspaceReaderContentModel;
  block: LessonPlaybackBlock;
  clock: RefObject<CaptionClock | null>;
  speed: number;
  animate: boolean;
  interval: { start: number; duration: number };
}>) {
  const scene = getStoredLessonVisualScene(visual);
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

function PlaybackVisualContent({
  visual,
  content,
  active,
  schedule,
  ...props
}: Readonly<{
  visual: PlaybackVisual;
  content: WorkspaceReaderContentModel;
  active: boolean;
  schedule: boolean;
  block: LessonPlaybackBlock;
  clock: RefObject<CaptionClock | null>;
  speed: number;
  animate: boolean;
  interval: { start: number; duration: number };
}>) {
  const stored =
    visual.kind === 'generated-visual'
      ? content.activeSectionGeneratedVisualsById?.[visual.visualId]
      : undefined;
  const storedScene = stored ? getStoredLessonVisualScene(stored) : undefined;
  const scene = visual.kind === 'scene' ? visual.scene : storedScene;
  const anchors = useMemo(
    () => (schedule ? sceneCaptionAnchors(scene, props.block.speech) : undefined),
    [scene, props.block.speech, schedule]
  );
  const host = useRef<HTMLDivElement>(null);
  const { clock, block } = props;
  useEffect(() => {
    if (!anchors) return;
    const element = host.current;
    if (!element) throw new Error('Scheduled visual must be mounted');
    let previousClock: CaptionClock | null = null;
    let span: ReturnType<typeof captionAnchorSpan> | undefined;
    let frame = 0;
    const tick = () => {
      const current = clock.current;
      if (current?.width && current.bodyDuration) {
        if (current !== previousClock) {
          span = captionAnchorSpan({
            anchors,
            speech: block.speech,
            speechRanges: current.speechRanges,
            runs: current.runs,
            width: current.width,
            feather: current.feather,
            duration: current.bodyDuration,
          });
          previousClock = current;
        }
        if (!span) throw new Error('Scheduled visual span must exist');
        const timeMs = Math.max(0, current.read().revealTime * 1000);
        const hidden = timeMs < span.startMs || timeMs > span.endMs;
        if (element.hidden !== hidden) element.hidden = hidden;
      }
      frame = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(frame);
  }, [anchors, block.speech, clock]);
  if (!anchors && !active) return null;
  return (
    <div ref={host} hidden={Boolean(anchors)}>
      {visual.kind === 'scene' ? (
        <PlaybackScene {...props} scene={visual.scene} isDarkMode={content.isDarkMode} />
      ) : null}
      {visual.kind === 'markdown' ? (
        <MarkdownRenderer
          content={visual.markdown}
          isDarkMode={content.isDarkMode}
          projectId={content.projectId}
          lessonAssetsById={content.activeSectionAssetsById}
          lessonImageRefsById={content.activeSectionImageRefsById}
          generatedVisualsById={content.activeSectionGeneratedVisualsById}
        />
      ) : null}
      {stored ? <PlaybackStoredVisual {...props} visual={stored} content={content} /> : null}
    </div>
  );
}

export default function LessonPlaybackStage({
  block,
  time,
  duration,
  content,
  speed = 1,
  readTime,
}: Readonly<{
  block: LessonPlaybackBlock;
  time: number;
  duration: number;
  content: WorkspaceReaderContentModel;
  speed?: number;
  readTime?: () => number;
}>) {
  const sources = useMemo(
    () =>
      content.sectionContentBlocks?.length
        ? content.sectionContentBlocks
        : [{ type: 'markdown' as const, markdown: content.sectionContent }],
    [content.sectionContentBlocks, content.sectionContent]
  );
  const formatted = useMemo(() => {
    const source = captionSource(block, sources);
    const captions = captionFormat(source.markdown, source.ranges);
    return { ...captions, speechRanges: captionSpeechRanges(captions.words, source.ranges) };
  }, [block, sources]);
  const captions = useRef<HTMLParagraphElement>(null);
  const sceneFit = useRef<HTMLDivElement>(null);
  const sceneCard = useRef<HTMLElement>(null);
  const clock = useRef<CaptionClock | null>(null);
  const scroll = useRef({ line: -1, target: 0 });
  const animate = useShouldAnimate();
  const latest = useRef({ time, speed, readTime, animate });
  useLayoutEffect(() => {
    const slot = sceneFit.current;
    const card = sceneCard.current;
    const stage = slot?.parentElement;
    const captionSection = captions.current?.parentElement;
    if (!slot || !card || !stage || !captionSection)
      throw new Error('Playback stage must be mounted');
    // Measure before scaling: transforms must not feed back into the natural dimensions.
    const fitScene = () => {
      const layout = getComputedStyle(stage);
      const verticalPadding =
        (Number.parseFloat(layout.paddingTop) || 0) +
        (Number.parseFloat(layout.paddingBottom) || 0);
      const captionHeight =
        layout.flexDirection === 'column'
          ? captionSection.offsetHeight + (Number.parseFloat(layout.rowGap) || 0)
          : 0;
      const availableHeight = stage.clientHeight - verticalPadding - captionHeight;
      if (!slot.clientWidth || availableHeight <= 0) return;
      card.style.width = `${slot.clientWidth}px`;
      const width = Math.max(card.offsetWidth, card.scrollWidth);
      card.style.width = `${width}px`;
      const height = Math.max(card.offsetHeight, card.scrollHeight);
      if (!width || !height) return;
      const scale = Math.min(1, slot.clientWidth / width, availableHeight / height);
      slot.style.setProperty('--scene-scale', String(scale));
      // The fitted card contributes its height so captions and scene are centered as a pair.
      slot.style.height = `${height * scale}px`;
      slot.style.setProperty('--scene-left', `${(slot.clientWidth - width * scale) / 2}px`);
    };
    const observer = new ResizeObserver(fitScene);
    observer.observe(slot);
    observer.observe(card);
    observer.observe(stage);
    observer.observe(captionSection);
    // A replacement or asynchronous diagram can change overflow without resizing the card.
    const mutations = new MutationObserver(fitScene);
    mutations.observe(card, {
      childList: true,
      characterData: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['hidden'],
    });
    fitScene();
    return () => {
      observer.disconnect();
      mutations.disconnect();
    };
  }, []);
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
      const feather = Number.parseFloat(
        getComputedStyle(paragraph).getPropertyValue('--caption-feather')
      );
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
          return {
            blockTime: elapsed,
            bodyTime,
            revealTime: motion ? pacedCaptionTime(ahead, pauses) : ahead,
          };
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
      if (!current?.width || !current.bodyDuration) return;
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
      scrollToCaptionLine(paragraph, active, scroll.current, motion);
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

  const preparedVisuals = block.prepared?.scene
    ? [{ kind: 'scene' as const, scene: block.prepared.scene }]
    : [];
  const visuals = block.visuals.length ? block.visuals : preparedVisuals;
  const visualIndex = Math.min(
    visuals.length - 1,
    duration > 0 ? Math.floor((time / duration) * visuals.length) : 0
  );
  const sceneProps = {
    block,
    clock,
    speed,
    animate,
  };
  return (
    <div className="lesson-player-stage">
      <section className="listening-stage">
        <section className="captions" aria-label={t('Sottotitoli')}>
          {(formatted.headings.length ? formatted.headings : [block.heading]).map(
            (heading, index) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: authored headings may repeat
              <h2 key={`${index}:${heading}`}>{heading}</h2>
            )
          )}
          <p ref={captions} key={block.id} className="caption-page">
            {formatted.words.map((word, index) => {
              const Tag = captionTag(word);
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
        <div ref={sceneFit} className="scene-fit">
          <section
            ref={sceneCard}
            className="scene-host"
            aria-label={t('Visualizzazione della lezione')}
          >
            {visuals.map((visual, index) => (
              <PlaybackVisualContent
                // biome-ignore lint/suspicious/noArrayIndexKey: visuals have a fixed order within a saved block
                key={`${block.id}:${index}`}
                {...sceneProps}
                interval={{
                  start: (duration * index) / visuals.length,
                  duration: duration / visuals.length,
                }}
                visual={visual}
                content={content}
                active={index === visualIndex}
                schedule={visuals.length > 1}
              />
            ))}
          </section>
        </div>
      </section>
    </div>
  );
}
