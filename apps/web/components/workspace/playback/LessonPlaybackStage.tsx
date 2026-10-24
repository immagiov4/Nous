import {
  type FormulaSpotlightData,
  formulaSpotlightCovers,
  resolveFormulaReferences,
} from '@shared/formulaSpotlight';
import {
  getPlaybackFormulaMarkdown,
  getPlaybackFormulaSources,
  getPlaybackMathMarkdown,
  type LessonPlaybackBlock,
  type PlaybackRange,
  type PlaybackVisual,
  playbackNonProseVisuals,
  resolvePlaybackNarration,
} from '@shared/lessonPlayback';
import { isAnimatedLessonScene, type LessonScene } from '@shared/lessonScene';
import { createPassageFallbackScene } from '@shared/lessonSceneFallback';
import { alignedWordTimes, type PlaybackWordAlignment } from '@shared/playbackWordTiming';
import {
  Fragment,
  type RefObject,
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { translateUiMessage as t } from '../../../i18n/uiMessages.ts';
import type { StoredLessonVisual } from '../../../types.ts';
import { useShouldAnimate } from '../../../utils/motion/useShouldAnimate.ts';
import { parsePdfContentParts } from '../../../utils/pdf/imagePlaceholders.ts';
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
  adoptCueTimes,
  type CaptionRun,
  captionAnchorSpan,
  captionAnchorTimes,
  captionMotionEvents,
  captionRangeSpan,
  motionStates,
  sceneCaptionAnchors,
  sceneElements,
  type TimedMotionEvent,
  visualSpeechRange,
} from './stageMotion.ts';
import './stage.css';
import { SaveablePlaybackVisual } from './SaveablePlaybackVisual.tsx';

interface CaptionClock {
  viewport: ReturnType<typeof captionViewport>;
  runs: CaptionRun[];
  width: number;
  feather: number;
  bodyDuration: number;
  speechRanges: PlaybackRange[];
  aligned?: ReturnType<typeof alignedWordTimes>;
  duration: number;
  headingDuration: number;
  seekRevision: number;
  read: () => { blockTime: number; bodyTime: number; revealTime: number };
}

function hasMissingMotionTargets(
  events: readonly TimedMotionEvent[],
  elements: ReturnType<typeof sceneElements>
) {
  return events.some(event => event.targets.some(target => !elements.has(target)));
}

function captionTag(word: CaptionWord) {
  if (word.code && !word.mathHtml) return 'code';
  return word.bold ? 'strong' : 'span';
}

function formulaCueTiming(scene: FormulaSpotlightData, speech: string, current: CaptionClock) {
  const times = scene.symbols.map(() => Number.POSITIVE_INFINITY);
  const ends = scene.symbols.map(() => Number.NEGATIVE_INFINITY);
  for (const reference of resolveFormulaReferences(scene, speech)) {
    const span = captionAnchorSpan({
      anchors: [reference.anchor],
      speech,
      speechRanges: current.speechRanges,
      runs: current.runs,
      width: current.width,
      feather: 0,
      duration: current.bodyDuration,
      startOffset: current.headingDuration,
      aligned: current.aligned,
    });
    times[reference.index] = span.startMs;
    ends[reference.index] = span.endMs;
  }
  return { times, ends };
}

function canRetainPresentedCues(
  current: CaptionClock,
  previous: CaptionClock | null
): previous is CaptionClock {
  return previous !== null && previous.seekRevision === current.seekRevision;
}

function retainPresentedCues(
  current: CaptionClock,
  previous: CaptionClock | null,
  before: number[] | undefined,
  next: number[] | undefined
) {
  if (!next || !canRetainPresentedCues(current, previous)) return next;
  return adoptCueTimes(before, next, current.read().blockTime * 1000);
}

function PlaybackScene({
  scene: sourceScene,
  block,
  clock,
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
  // Parsed preparation snapshots can contain an equivalent scene with a new object identity.
  const sceneKey = JSON.stringify(sourceScene);
  const scene = useMemo<LessonScene>(() => JSON.parse(sceneKey), [sceneKey]);
  const host = useRef<HTMLDivElement>(null);
  const readAnimationFrame = useMemo<ReadSceneAnimationFrame | undefined>(() => {
    if (!isAnimatedLessonScene(scene) && scene.type !== 'formula-spotlight') return undefined;
    const anchors = sceneCaptionAnchors(scene, block.speech);
    // Voice cues exclude both caption look-ahead and its graphical reveal feather.
    let previousClock: CaptionClock | null = null;
    let times: number[] | undefined;
    let ends: number[] | undefined;
    return () => {
      const current = clock.current;
      if (!current?.bodyDuration) return undefined;
      if (anchors && !current.width) return undefined;
      if (current !== previousClock) {
        const previousTimes = times;
        const previousEnds = ends;
        times = anchors
          ? captionAnchorTimes({
              anchors,
              speech: block.speech,
              speechRanges: current.speechRanges,
              runs: current.runs,
              width: current.width,
              feather: 0,
              duration: current.bodyDuration,
              startOffset: current.headingDuration,
              aligned: current.aligned,
            })
          : undefined;
        if (scene.type === 'formula-spotlight' && anchors) {
          ({ times, ends } = formulaCueTiming(
            scene as FormulaSpotlightData,
            block.speech,
            current
          ));
        }
        times = retainPresentedCues(current, previousClock, previousTimes, times);
        ends = retainPresentedCues(current, previousClock, previousEnds, ends);
        previousClock = current;
      }
      const { blockTime } = current.read();
      return anchors
        ? {
            elapsedMs: blockTime * 1000,
            durationMs: current.duration * 1000,
            cueTimes: times,
            cueEndTimes: ends,
          }
        : {
            elapsedMs: (blockTime - interval.start) * 1000,
            durationMs: interval.duration * 1000,
          };
    };
  }, [scene, block.speech, clock, interval.start, interval.duration]);
  useLayoutEffect(() => {
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
        const previousEvents = events;
        events = captionMotionEvents({
          events: block.prepared?.motion ?? [],
          speech: block.speech,
          speechRanges: current.speechRanges,
          runs: current.runs,
          width: current.width,
          feather: 0,
          duration: current.bodyDuration,
          startOffset: current.headingDuration,
          aligned: current.aligned,
        });
        if (canRetainPresentedCues(current, previousClock)) {
          const onsets = adoptCueTimes(
            previousEvents.map(event => event.atMs),
            events.map(event => event.atMs),
            current.read().blockTime * 1000
          );
          events = events.map((event, index) => ({
            ...event,
            atMs: onsets[index],
            durationMs:
              previousEvents[index]?.atMs === onsets[index]
                ? previousEvents[index].durationMs
                : event.durationMs,
          }));
        }
        previousClock = current;
        previousFrame = '';
      }
      if (hasMissingMotionTargets(events, elements)) return;
      const voiceTime = current.read().blockTime * 1000;
      const frameKey = `${voiceTime}:${animate}`;
      if (frameKey === previousFrame) return;
      previousFrame = frameKey;
      const states = motionStates(Array.from(elements.keys()), events, voiceTime, !animate, 0);
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
  }, [animate, block.prepared?.motion, block.speech, clock, scene]);
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
  onImageUnavailable,
  ...props
}: Readonly<{
  visual: PlaybackVisual;
  onImageUnavailable: (imageId: string) => void;
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
          onImageUnavailable={onImageUnavailable}
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

function PlaybackPassage({
  lessonKey = '',
  block,
  time,
  duration,
  content,
  speed = 1,
  readTime,
  alignment,
  seekRevision = 0,
}: Readonly<{
  lessonKey?: string;
  block: LessonPlaybackBlock;
  time: number;
  duration: number;
  content: WorkspaceReaderContentModel;
  speed?: number;
  readTime?: () => number;
  alignment?: PlaybackWordAlignment;
  seekRevision?: number;
}>) {
  const sources = useMemo(
    () =>
      content.sectionContentBlocks?.length
        ? content.sectionContentBlocks
        : [{ type: 'markdown' as const, markdown: content.sectionContent }],
    [content.sectionContentBlocks, content.sectionContent]
  );
  const source = useMemo(() => captionSource(block, sources), [block, sources]);
  // Equivalent snapshots retain the measured viewport; a new passage measures its new DOM.
  const captionKey = JSON.stringify({ blockId: block.id, ...source });
  const formatted = useMemo(() => {
    const source = JSON.parse(captionKey) as ReturnType<typeof captionSource>;
    const captions = captionFormat(source.markdown, source.ranges);
    return { ...captions, speechRanges: captionSpeechRanges(captions.words, source.ranges) };
  }, [captionKey]);
  const alignmentKey = JSON.stringify(alignment ?? null);
  const aligned = useMemo(
    () =>
      alignedWordTimes(
        block.speech,
        duration,
        (JSON.parse(alignmentKey) as PlaybackWordAlignment | null) ?? undefined
      ),
    [alignmentKey, block.speech, duration]
  );
  const captions = useRef<HTMLParagraphElement>(null);
  const sceneFit = useRef<HTMLDivElement>(null);
  const sceneCard = useRef<HTMLElement>(null);
  const clock = useRef<CaptionClock | null>(null);

  const animate = useShouldAnimate();
  const latest = useRef({ time, speed, readTime, animate, aligned, seekRevision });
  useLayoutEffect(() => {
    const slot = sceneFit.current;
    const card = sceneCard.current;
    const stage = slot?.parentElement;
    const captionSection = captions.current?.parentElement;
    if (!slot || !card || !stage || !captionSection)
      throw new Error('Playback stage must be mounted');
    // Measure before scaling: transforms must not feed back into the natural dimensions.
    const fitScene = () => {
      // Classify the presented visual, including aligned cards and asynchronously mounted scenes.
      const formulas = card.querySelectorAll('.katex:not(.spotlight-symbol .katex)');
      card.classList.toggle('lesson-player-formula', formulas.length === 1);
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
    latest.current = { time, speed, readTime, animate, aligned, seekRevision };
  }, [time, speed, readTime, animate, aligned, seekRevision]);

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
        aligned: latest.current.aligned,
        duration,
        seekRevision: latest.current.seekRevision,
        headingDuration: duration - bodyDuration,
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
    document.fonts.addEventListener('loadingdone', measure);
    return () => {
      window.removeEventListener('resize', measure);
      document.fonts.removeEventListener('loadingdone', measure);
    };
  }, [duration, formatted]);

  useLayoutEffect(() => {
    const measured = clock.current;
    if (!measured) throw new Error('Captions must be measured');
    if (measured.aligned === aligned && measured.seekRevision === seekRevision) return;
    // Recording timing changes keep the caption geometry and current reading position.
    clock.current = { ...measured, aligned, seekRevision };
  }, [aligned, seekRevision]);

  useLayoutEffect(() => {
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
      // Place new or backward seeks immediately; animate subsequent playback updates.
      current.viewport.follow(
        active,
        motion && previousBodyTime !== undefined && bodyTime > previousBodyTime
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

  const [unavailableImages, setUnavailableImages] = useState<ReadonlySet<string>>(new Set());
  const onImageUnavailable = useCallback((imageId: string) => {
    setUnavailableImages(previous =>
      previous.has(imageId) ? previous : new Set([...previous, imageId])
    );
  }, []);
  const availableAssets = useMemo(
    () =>
      Object.fromEntries(
        Object.entries(content.activeSectionAssetsById ?? {}).filter(
          ([, asset]) => !unavailableImages.has(asset.id)
        )
      ),
    [content.activeSectionAssetsById, unavailableImages]
  );
  const visualCandidates = useMemo(() => {
    const formulas = getPlaybackFormulaMarkdown(block, sources);
    const cards = block.visuals.filter(
      visual =>
        visual.kind === 'markdown' && block.spans.some(span => span.math === visual.markdown)
    );
    const sourceVisuals =
      cards.length > 1 && cards.length === block.visuals.length && !block.prepared?.scene
        ? cards
        : playbackNonProseVisuals(block);
    const projected = sourceVisuals.filter(visual => {
      if (visual.kind === 'generated-visual')
        return content.activeSectionGeneratedVisualsById?.[visual.visualId];
      if (visual.kind !== 'markdown') return true;
      return parsePdfContentParts(
        visual.markdown,
        availableAssets,
        content.activeSectionImageRefsById,
        content.activeSectionGeneratedVisualsById
      ).some(part => part.type !== 'markdown' || part.content.trim());
    });
    const scene = block.prepared?.scene;
    if (
      scene?.type === 'formula-spotlight' &&
      formulas &&
      !formulaSpotlightCovers(
        scene as FormulaSpotlightData,
        getPlaybackFormulaSources(block, sources)
      )
    )
      return projected.length ? projected : [{ kind: 'markdown' as const, markdown: formulas }];
    if (block.prepared?.scene && getPlaybackMathMarkdown(block))
      return [...projected, { kind: 'scene' as const, scene: block.prepared.scene }];
    if (projected.length)
      return projected.map(visual => {
        if (!scene) return visual;
        const existingScene =
          visual.kind === 'scene' ||
          (visual.kind === 'generated-visual' &&
            content.activeSectionGeneratedVisualsById?.[visual.visualId] &&
            getStoredLessonVisualScene(content.activeSectionGeneratedVisualsById[visual.visualId]));
        return existingScene ? { kind: 'scene' as const, scene } : visual;
      });
    if (formulas && !block.prepared?.scene)
      return [{ kind: 'markdown' as const, markdown: formulas }];
    if (block.prepared?.scene) return [{ kind: 'scene' as const, scene: block.prepared.scene }];
    if (formulas) return [{ kind: 'markdown' as const, markdown: formulas }];
    return [
      { kind: 'scene' as const, scene: createPassageFallbackScene(block.speech, block.heading) },
    ];
  }, [
    block,
    sources,
    content.activeSectionGeneratedVisualsById,
    availableAssets,
    content.activeSectionImageRefsById,
  ]);
  const visualProjection = JSON.stringify(visualCandidates, (_key, value: unknown) =>
    value && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(
          Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
        )
      : value
  );
  const visuals = useMemo(
    () => JSON.parse(visualProjection) as readonly PlaybackVisual[],
    [visualProjection]
  );
  const [selection, setSelection] = useState<{
    blockId: string;
    index: number;
  } | null>(null);
  const visualReferences = useMemo(
    () =>
      visuals.map(visual => {
        const stored =
          visual.kind === 'generated-visual'
            ? content.activeSectionGeneratedVisualsById?.[visual.visualId]
            : undefined;
        const scene =
          visual.kind === 'scene' ? visual.scene : stored && getStoredLessonVisualScene(stored);
        return {
          anchors: visuals.length > 1 ? sceneCaptionAnchors(scene, block.speech) : undefined,
        };
      }),
    [visuals, content.activeSectionGeneratedVisualsById, block.speech]
  );
  const visualRangeProjection = JSON.stringify(
    visualCandidates.map((visual, index) =>
      visualSpeechRange(
        block,
        visual,
        visualCandidates
          .slice(0, index)
          .filter(
            previous =>
              previous.kind === 'markdown' &&
              visual.kind === 'markdown' &&
              previous.markdown === visual.markdown
          ).length
      )
    )
  );
  const visualRanges = useMemo(
    () => JSON.parse(visualRangeProjection) as (PlaybackRange | null)[],
    [visualRangeProjection]
  );
  useLayoutEffect(() => {
    if (!visuals.length) return;
    let previousClock: CaptionClock | null = null;
    let previousActive: number | undefined;
    let spans: (ReturnType<typeof captionAnchorSpan> | undefined)[] = [];
    let frame = 0;
    const tick = () => {
      const current = clock.current;
      if (
        current &&
        (current.width ||
          !(visualReferences.some(reference => reference.anchors) || visualRanges.some(Boolean)))
      ) {
        if (current !== previousClock) {
          const previousSpans = spans;
          spans = visualReferences.map(({ anchors: quotation }, index) => {
            const timing = {
              speech: block.speech,
              speechRanges: current.speechRanges,
              runs: current.runs,
              width: current.width,
              feather: 0,
              duration: current.bodyDuration,
              startOffset: current.headingDuration,
              aligned: current.aligned,
            };
            const range = visualRanges[index];
            if (range) return captionRangeSpan({ ...timing, range });
            if (!quotation) return undefined;
            return captionAnchorSpan({ ...timing, anchors: quotation, speech: block.speech });
          });
          if (canRetainPresentedCues(current, previousClock)) {
            const heardMs = current.read().blockTime * 1000;
            spans = spans.map((span, index) => {
              const previous = previousSpans[index];
              if (!span || !previous) return span;
              return {
                startMs: adoptCueTimes([previous.startMs], [span.startMs], heardMs)[0],
                endMs: adoptCueTimes([previous.endMs], [span.endMs], heardMs)[0],
              };
            });
          }
          previousClock = current;
        }
        const { blockTime } = current.read();
        let active = 0;
        let latestStart = Number.NEGATIVE_INFINITY;
        let earliestStart = Number.POSITIVE_INFINITY;
        spans.forEach((span, index) => {
          const start = span ? span.startMs / 1000 : (duration * index) / visuals.length;
          if (latestStart === Number.NEGATIVE_INFINITY && start < earliestStart) {
            earliestStart = start;
            active = index;
          }
          // A later start replaces the earlier scene permanently, even if it ends first.
          if (start <= blockTime && start >= latestStart) {
            latestStart = start;
            active = index;
          }
        });
        if (active !== previousActive) {
          previousActive = active;
          setSelection(current =>
            current?.blockId === block.id && current.index === active
              ? current
              : { blockId: block.id, index: active }
          );
        }
      }
      frame = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(frame);
  }, [visualReferences, block.id, block.speech, duration, visuals, visualRanges]);
  const visualIndex = selection?.blockId === block.id ? selection.index : 0;
  const visual = visuals[visualIndex];
  const selectedStored =
    visual?.kind === 'generated-visual'
      ? content.activeSectionGeneratedVisualsById?.[visual.visualId]
      : undefined;
  let selectedScene: LessonScene | null = null;
  if (visual?.kind === 'scene') selectedScene = visual.scene;
  else if (selectedStored) selectedScene = getStoredLessonVisualScene(selectedStored);
  const formulaMarkdown = useMemo(
    () => getPlaybackFormulaMarkdown(block, sources),
    [block, sources]
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
                    <Tag>
                      {word.breakBefore ? `${word.marker} ` : ''}
                      {word.mathHtml ? (
                        <span
                          // biome-ignore lint/security/noDangerouslySetInnerHtml: KaTeX renders validated notation with trust disabled.
                          dangerouslySetInnerHTML={{ __html: word.mathHtml }}
                        />
                      ) : (
                        word.text
                      )}
                    </Tag>
                  </span>{' '}
                </Fragment>
              );
            })}
          </p>
        </section>
        <div ref={sceneFit} className="scene-fit">
          <SaveablePlaybackVisual
            cardRef={sceneCard}
            scene={selectedScene}
            visualIndex={visualIndex}
            playback={{
              lessonKey,
              readTime: () => latest.current.readTime?.() ?? latest.current.time,
              duration,
              alignment,
            }}
            block={block}
            content={content}
          >
            {formulaMarkdown &&
            !visualRanges[visualIndex] &&
            selectedScene?.type !== 'formula-spotlight' &&
            !(visual?.kind === 'markdown' && visual.markdown === formulaMarkdown) ? (
              <MarkdownRenderer content={formulaMarkdown} isDarkMode={content.isDarkMode} />
            ) : null}
            {visual ? (
              <PlaybackVisualContent
                onImageUnavailable={onImageUnavailable}
                key={`${block.id}:${visualIndex}`}
                {...sceneProps}
                interval={{
                  start: (duration * visualIndex) / visuals.length,
                  duration: duration / visuals.length,
                }}
                visual={visual}
                content={{ ...content, activeSectionAssetsById: availableAssets }}
              />
            ) : null}
          </SaveablePlaybackVisual>
        </div>
      </section>
    </div>
  );
}

/** Each narration owns its clock so retiring subscriptions keep their original text ranges. */
export default function LessonPlaybackStage(props: Parameters<typeof PlaybackPassage>[0]) {
  const block = useMemo(() => resolvePlaybackNarration(props.block), [props.block]);
  return <PlaybackPassage {...props} block={block} key={`${block.id}:${block.speech}`} />;
}
