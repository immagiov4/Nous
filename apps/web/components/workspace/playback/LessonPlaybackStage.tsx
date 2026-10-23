import {
  getPlaybackMathMarkdown,
  type LessonPlaybackBlock,
  type PlaybackRange,
  type PlaybackVisual,
  resolvePlaybackNarration,
} from '@shared/lessonPlayback';
import { isAnimatedLessonScene, type LessonScene } from '@shared/lessonScene';
import {
  Fragment,
  type RefObject,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
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
  CAPTION_TIMING,
  type CaptionWord,
  captionFormat,
  captionLookAhead,
  captionPauses,
  captionSource,
  captionSpeechRanges,
  pacedCaptionTime,
} from './captionFormat.ts';
import { captionViewport } from './captionViewport.ts';
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
  viewport: ReturnType<typeof captionViewport>;
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
    if (!isAnimatedLessonScene(scene) && scene.type !== 'formula-spotlight') return undefined;
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
    if (
      isAnimatedLessonScene(scene) ||
      scene.type === 'formula-spotlight' ||
      !block.prepared?.motion.length
    )
      return;
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
  ...props
}: Readonly<{
  visual: PlaybackVisual;
  content: WorkspaceReaderContentModel;
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
  return (
    <div>
      {visual.kind === 'scene' ? (
        <PlaybackScene {...props} scene={visual.scene} isDarkMode={content.isDarkMode} />
      ) : null}
      {visual.kind === 'mermaid' ? (
        <GeneratedVisualFrame
          className="lesson-player-generated"
          title={props.block.heading}
          visual={{
            id: `playback:${props.block.id}`,
            title: props.block.heading,
            kind: 'mermaid',
            code: visual.code,
            createdAt: '',
          }}
          projectId={content.projectId}
          isDarkMode={content.isDarkMode}
        />
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
  block: sourceBlock,
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
  const block = useMemo(() => resolvePlaybackNarration(sourceBlock), [sourceBlock]);
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
      const availableHeight = stage.clientHeight - verticalPadding;
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
    let fitFrame: number | undefined;
    // ResizeObserver notifications must not resize their own observed ancestors.
    const scheduleFit = () => {
      fitFrame ??= requestAnimationFrame(() => {
        fitFrame = undefined;
        fitScene();
      });
    };
    const observer = new ResizeObserver(scheduleFit);
    observer.observe(slot);
    observer.observe(card);
    observer.observe(stage);
    observer.observe(captionSection);
    // A replacement or asynchronous diagram can change overflow without resizing the card.
    const mutations = new MutationObserver(scheduleFit);
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
      if (fitFrame !== undefined) cancelAnimationFrame(fitFrame);
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
        viewport: captionViewport(paragraph),
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
      current.viewport.clip();
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
      // A backward seek hides future words immediately; scrolling there must be immediate too.
      current.viewport.follow(
        active,
        motion && (previousBodyTime === undefined || bodyTime > previousBodyTime)
      );
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

  const visuals = useMemo(() => {
    if (block.prepared?.scene && getPlaybackMathMarkdown(block))
      return [{ kind: 'scene' as const, scene: block.prepared.scene }];
    if (block.visuals.length) return block.visuals;
    if (block.prepared?.scene) return [{ kind: 'scene' as const, scene: block.prepared.scene }];
    if (block.prepared)
      return [{ kind: 'markdown' as const, markdown: captionSource(block, sources).markdown }];
    return [];
  }, [block, sources]);
  const [selection, setSelection] = useState<{
    visuals: readonly PlaybackVisual[];
    index: number;
  } | null>(null);
  const anchors = useMemo(
    () =>
      visuals.map(visual => {
        const stored =
          visual.kind === 'generated-visual'
            ? content.activeSectionGeneratedVisualsById?.[visual.visualId]
            : undefined;
        const scene =
          visual.kind === 'scene' ? visual.scene : stored && getStoredLessonVisualScene(stored);
        return visuals.length > 1 ? sceneCaptionAnchors(scene, block.speech) : undefined;
      }),
    [visuals, content.activeSectionGeneratedVisualsById, block.speech]
  );
  useEffect(() => {
    if (!visuals.length) return;
    let previousClock: CaptionClock | null = null;
    let previousActive: number | undefined;
    let spans: (ReturnType<typeof captionAnchorSpan> | undefined)[] = [];
    let frame = 0;
    const tick = () => {
      const current = clock.current;
      if (current && (current.width || !anchors.some(Boolean))) {
        if (current !== previousClock) {
          spans = anchors.map(quotation =>
            quotation
              ? captionAnchorSpan({
                  anchors: quotation,
                  speech: block.speech,
                  speechRanges: current.speechRanges,
                  runs: current.runs,
                  width: current.width,
                  feather: current.feather,
                  duration: current.bodyDuration,
                })
              : undefined
          );
          previousClock = current;
        }
        const { blockTime, revealTime } = current.read();
        const captionOffset = Math.max(0, revealTime) - blockTime;
        let active = -1;
        let latestStart = Number.NEGATIVE_INFINITY;
        spans.forEach((span, index) => {
          const start = span
            ? span.startMs / 1000 - captionOffset
            : (duration * index) / visuals.length;
          // A later start replaces the earlier scene permanently, even if it ends first.
          if (start <= blockTime && start >= latestStart) {
            latestStart = start;
            const end = span
              ? span.endMs / 1000 - captionOffset
              : (duration * (index + 1)) / visuals.length;
            active = blockTime <= end ? index : -1;
          }
        });
        if (active !== previousActive) {
          previousActive = active;
          setSelection({ visuals, index: active });
        }
      }
      frame = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(frame);
  }, [anchors, block, duration, visuals]);
  const visualIndex = selection?.visuals === visuals ? selection.index : -1;
  const visual = visuals[visualIndex];
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
            {visual ? (
              <PlaybackVisualContent
                key={`${block.id}:${visualIndex}`}
                {...sceneProps}
                interval={{
                  start: (duration * visualIndex) / visuals.length,
                  duration: duration / visuals.length,
                }}
                visual={visual}
                content={content}
              />
            ) : null}
          </section>
        </div>
      </section>
    </div>
  );
}
