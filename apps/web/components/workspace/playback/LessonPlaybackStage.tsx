import {
  type FormulaSpotlightData,
  hasExplicitFormulaReferencePositions,
  resolveFormulaReferences,
} from '@shared/formulaSpotlight';
import {
  getPlaybackFormulaMarkdown,
  getPlaybackMathMarkdown,
  type LessonPlaybackBlock,
  type PlaybackContentBlock,
  type PlaybackRange,
  type PlaybackVisual,
  playbackNonProseVisuals,
  playbackPreparedFormulaIsUsable,
  resolvePlaybackNarration,
} from '@shared/lessonPlayback';
import {
  isAnimatedLessonScene,
  isRetiredLessonScene,
  LESSON_SCENE_DIAGRAM_TYPES,
  type LessonScene,
} from '@shared/lessonScene';
import type { PlaybackQuestionContext } from '@shared/playbackQuestionContext';
import { hasPreparedVisualSections, playbackVisualSections } from '@shared/playbackVisualSections';
import { alignedWordTimes, type PlaybackWordAlignment } from '@shared/playbackWordTiming';
import {
  Fragment,
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { translateUiMessage as t } from '../../../i18n/uiMessages.ts';
import type { StoredLessonVisual } from '../../../types.ts';
import { useShouldAnimate } from '../../../utils/motion/useShouldAnimate.ts';
import { parsePdfContentParts } from '../../../utils/pdf/imagePlaceholders.ts';
import { playbackHeardSentence } from '../../../utils/reader/lessonPlayback.ts';
import {
  getStoredLessonVisualCode,
  getStoredLessonVisualKind,
  getStoredLessonVisualScene,
} from '../../../utils/visuals/storedLessonVisual.ts';
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
import {
  formulaReferenceRange,
  playbackVisualScene,
  projectStageFormulaVisuals,
  type StageVisual,
} from './stageVisuals.ts';
import './stage.css';
import { SaveablePlaybackVisual } from './SaveablePlaybackVisual.tsx';

type DrawnCaptionRun = CaptionRun & { revealEdge?: number; readOpacity?: number };

interface CaptionClock {
  viewport: ReturnType<typeof captionViewport>;
  runs: DrawnCaptionRun[];
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

/** Draws changed word styles and identifies the word crossed by the reveal edge. */
function drawCaptionWord(
  run: DrawnCaptionRun,
  clock: CaptionClock,
  edge: number,
  bodyTime: number
) {
  const local = edge - run.start;
  // Settled words keep their cached styles to avoid per-frame invalidation.
  const maskEdge = Math.max(0, Math.min(run.width + clock.feather, local));
  if (run.revealEdge !== maskEdge) {
    run.span.style.opacity = local > 0 ? '1' : '0';
    run.span.style.setProperty('--reveal-edge', `${maskEdge}px`);
    run.span.style.maskImage = local >= run.width + clock.feather ? 'none' : '';
    run.revealEdge = maskEdge;
  }
  const readAge = bodyTime - ((run.start + run.width) / clock.width) * clock.bodyDuration;
  const fade = Math.max(0, Math.min(1, readAge / CAPTION_TIMING.readFadeSeconds));
  const readOpacity = 1 - fade * (1 - CAPTION_TIMING.readOpacity);
  if (run.readOpacity !== readOpacity) {
    const text = run.span.firstElementChild as HTMLElement;
    text.style.opacity = String(readOpacity);
    run.readOpacity = readOpacity;
  }
  return local >= 0 && local <= run.width;
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

function formulaCueTiming(
  scene: FormulaSpotlightData,
  speech: string,
  current: CaptionClock,
  range?: PlaybackRange
) {
  const times: number[] = [];
  const ends: number[] = [];
  const symbolIndices: number[] = [];
  for (const reference of resolveFormulaReferences(scene, speech, range)) {
    const span = captionRangeSpan({
      range: {
        start: reference.start,
        end: reference.end,
      },
      speech,
      speechRanges: current.speechRanges,
      runs: current.runs,
      width: current.width,
      feather: 0,
      duration: current.bodyDuration,
      startOffset: current.headingDuration,
      aligned: current.aligned,
    });
    times.push(span.startMs);
    ends.push(span.endMs);
    symbolIndices.push(reference.index);
  }
  return { times, ends, symbolIndices };
}

/** Return to the equation containing the currently narrated part during interleaved explanations. */
function heardReferenceVisual(
  referenceCues: readonly (ReturnType<typeof formulaCueTiming> | undefined)[],
  heardMs: number,
  fallback: number
): number {
  let active = fallback;
  let latestStart = Number.NEGATIVE_INFINITY;
  for (const [index, cues] of referenceCues.entries()) {
    if (!cues) continue;
    for (const [symbol, start] of cues.times.entries()) {
      if (start <= heardMs && heardMs < cues.ends[symbol] && start >= latestStart) {
        latestStart = start;
        active = index;
      }
    }
  }
  return active;
}

type FormulaReadingSpan = ReturnType<typeof captionRangeSpan>;

function formulaReadingSpans(
  visuals: readonly StageVisual[],
  timing: Omit<Parameters<typeof captionRangeSpan>[0], 'range'>
): FormulaReadingSpan[][] {
  return visuals.map(visual =>
    (visual.readingRanges ?? []).map(range => captionRangeSpan({ ...timing, range }))
  );
}

function retainReadingSpans(
  next: FormulaReadingSpan[][],
  previous: FormulaReadingSpan[][],
  heardMs: number
): FormulaReadingSpan[][] {
  return next.map((ranges, index) =>
    ranges.map((span, rangeIndex) => {
      const before = previous[index]?.[rangeIndex];
      return before
        ? {
            startMs: adoptCueTimes([before.startMs], [span.startMs], heardMs)[0],
            endMs: adoptCueTimes([before.endMs], [span.endMs], heardMs)[0],
          }
        : span;
    })
  );
}

function heardReadingVisual(spans: FormulaReadingSpan[][], heardMs: number): number {
  return spans.findIndex(ranges =>
    ranges.some(span => span.startMs <= heardMs && heardMs < span.endMs)
  );
}

function canRetainPresentedCues(
  current: CaptionClock,
  previous: CaptionClock | null
): previous is CaptionClock {
  return (
    previous !== null &&
    previous.duration > 0 &&
    current.duration > 0 &&
    previous.seekRevision === current.seekRevision
  );
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
  formulaRange,
  itemRanges,
}: Readonly<{
  scene: LessonScene;
  block: LessonPlaybackBlock;
  clock: RefObject<CaptionClock | null>;
  speed: number;
  animate: boolean;
  isDarkMode: boolean;
  interval: { start: number; duration: number };
  formulaRange?: PlaybackRange;
  itemRanges?: readonly PlaybackRange[];
}>) {
  // Parsed preparation snapshots can contain an equivalent scene with a new object identity.
  const sceneKey = JSON.stringify(sourceScene);
  const scene = useMemo<LessonScene>(() => JSON.parse(sceneKey), [sceneKey]);
  const host = useRef<HTMLDivElement>(null);
  const readAnimationFrame = useMemo<ReadSceneAnimationFrame | undefined>(() => {
    if (!isAnimatedLessonScene(scene) && scene.type !== 'formula-spotlight') return undefined;
    const anchors = sceneCaptionAnchors(
      scene,
      formulaRange &&
        scene.type === 'formula-spotlight' &&
        !hasExplicitFormulaReferencePositions(scene as FormulaSpotlightData)
        ? block.speech.slice(formulaRange.start, formulaRange.end)
        : block.speech
    );
    // Voice cues exclude both caption look-ahead and its graphical reveal feather.
    let previousClock: CaptionClock | null = null;
    let times: number[] | undefined;
    let ends: number[] | undefined;
    let symbolIndices: number[] | undefined;
    return () => {
      const current = clock.current;
      if (!current?.duration) return undefined;
      if (anchors && !current.width && current.bodyDuration > 0 && !current.aligned)
        return undefined;
      if (current !== previousClock) {
        const previousTimes = times;
        const previousEnds = ends;
        times =
          anchors && scene.type !== 'formula-spotlight'
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
          ({ times, ends, symbolIndices } = formulaCueTiming(
            scene as FormulaSpotlightData,
            block.speech,
            current,
            formulaRange
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
            cueSymbolIndices: symbolIndices,
          }
        : {
            elapsedMs: (blockTime - interval.start) * 1000,
            durationMs: interval.duration * 1000,
          };
    };
  }, [scene, block.speech, clock, interval.start, interval.duration, formulaRange]);
  useLayoutEffect(() => {
    if (
      isAnimatedLessonScene(scene) ||
      scene.type === 'formula-spotlight' ||
      !(itemRanges?.length || block.prepared?.motion.length)
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
          events: itemRanges ? [] : (block.prepared?.motion ?? []),
          speech: block.speech,
          speechRanges: current.speechRanges,
          runs: current.runs,
          width: current.width,
          feather: 0,
          duration: current.bodyDuration,
          startOffset: current.headingDuration,
          aligned: current.aligned,
        });
        if (itemRanges)
          events = itemRanges.map((range, index) => {
            const span = captionRangeSpan({
              range,
              speech: block.speech,
              speechRanges: current.speechRanges,
              runs: current.runs,
              width: current.width,
              feather: 0,
              duration: current.bodyDuration,
              startOffset: current.headingDuration,
              aligned: current.aligned,
            });
            return {
              effect: 'focus',
              targets: [`item:${index}`],
              quote: '',
              atMs: span.startMs,
              durationMs: span.endMs - span.startMs,
              sustainFocus: true,
            };
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
  }, [animate, block.prepared?.motion, block.speech, clock, scene, itemRanges]);
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
  onImageUnavailable,
  ...props
}: Readonly<{
  visual: StoredLessonVisual;
  onImageUnavailable: (imageId: string) => void;
  content: WorkspaceReaderContentModel;
  block: LessonPlaybackBlock;
  clock: RefObject<CaptionClock | null>;
  speed: number;
  animate: boolean;
  interval: { start: number; duration: number };
  itemRanges?: readonly PlaybackRange[];
}>) {
  const scene = getStoredLessonVisualScene(visual);
  const onUnavailable = useCallback(
    () => onImageUnavailable(visual.id),
    [onImageUnavailable, visual.id]
  );
  return scene ? (
    <PlaybackScene {...props} scene={scene} isDarkMode={content.isDarkMode} />
  ) : (
    <GeneratedVisualFrame
      className="lesson-player-generated"
      title={visual.title ?? props.block.heading}
      visual={visual}
      onUnavailable={onUnavailable}
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
  visual: StageVisual;
  onImageUnavailable: (imageId: string) => void;
  content: WorkspaceReaderContentModel;
  block: LessonPlaybackBlock;
  clock: RefObject<CaptionClock | null>;
  speed: number;
  animate: boolean;
  interval: { start: number; duration: number };
  itemRanges?: readonly PlaybackRange[];
}>) {
  const stored =
    visual.kind === 'generated-visual'
      ? content.activeSectionGeneratedVisualsById?.[visual.visualId]
      : undefined;
  return (
    <div>
      {visual.kind === 'scene' ? (
        <PlaybackScene
          {...props}
          scene={visual.scene}
          formulaRange={visual.formulaRange}
          isDarkMode={content.isDarkMode}
        />
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
      {stored ? (
        <PlaybackStoredVisual
          {...props}
          visual={stored}
          content={content}
          onImageUnavailable={onImageUnavailable}
        />
      ) : null}
    </div>
  );
}

function PlaybackPassage({
  lessonKey = '',
  block,
  sources,
  time,
  duration,
  content,
  speed = 1,
  readTime,
  alignment,
  seekRevision = 0,
  questionContextRef,
}: Readonly<{
  lessonKey?: string;
  block: LessonPlaybackBlock;
  sources: readonly PlaybackContentBlock[];
  time: number;
  duration: number;
  content: WorkspaceReaderContentModel;
  speed?: number;
  readTime?: () => number;
  alignment?: PlaybackWordAlignment;
  seekRevision?: number;
  questionContextRef?: RefObject<(() => PlaybackQuestionContext) | null>;
}>) {
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
      // The visual centers independently inside the stage's full-height grid row.
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
    let previousBodyTime: number | undefined;
    let previousViewport: CaptionClock['viewport'] | undefined;
    const render = () => {
      const paragraph = captions.current;
      if (!paragraph) throw new Error('Captions must be mounted');
      const current = clock.current;
      if (!current) return;
      const { bodyTime, revealTime } = current.read();
      if (!current.width || !current.bodyDuration) return;
      const motion = latest.current.animate;
      current.viewport.clip();
      const layoutChanged = previousViewport !== current.viewport;
      if (previousBodyTime === bodyTime && !layoutChanged) return;
      const progress = Math.max(0, Math.min(1, revealTime / current.bodyDuration));
      const edge = progress * (current.width + current.feather);
      let active = edge >= current.width ? current.runs.at(-1)?.span : undefined;
      for (const run of current.runs) {
        if (drawCaptionWord(run, current, edge, bodyTime)) active = run.span;
      }
      // Place new or backward seeks immediately; animate subsequent playback updates.
      current.viewport.follow(
        active,
        !layoutChanged && motion && previousBodyTime !== undefined && bodyTime > previousBodyTime
      );
      previousBodyTime = bodyTime;
      previousViewport = current.viewport;
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
  const availableGeneratedVisuals = useMemo(
    () =>
      Object.fromEntries(
        Object.entries(content.activeSectionGeneratedVisualsById ?? {}).filter(
          ([id]) => !unavailableImages.has(id)
        )
      ),
    [content.activeSectionGeneratedVisualsById, unavailableImages]
  );
  const [preparedVisual, setPreparedVisual] = useState<LessonPlaybackBlock['prepared']>(undefined);
  const visualBlock = useMemo(
    () =>
      preparedVisual ? { ...block, prepared: { ...block.prepared, ...preparedVisual } } : block,
    [block, preparedVisual]
  );
  const availableVisuals = useCallback(
    (visuals: readonly PlaybackVisual[]) =>
      visuals.filter(visual => {
        if (visual.kind === 'scene') return !isRetiredLessonScene(visual.scene);
        if (visual.kind === 'generated-visual') {
          const stored = availableGeneratedVisuals[visual.visualId];
          const scene = stored && getStoredLessonVisualScene(stored);
          return stored && (!scene || !isRetiredLessonScene(scene));
        }
        if (visual.kind !== 'markdown') return true;
        return parsePdfContentParts(
          visual.markdown,
          availableAssets,
          content.activeSectionImageRefsById,
          availableGeneratedVisuals
        ).some(part => part.type !== 'markdown' || part.content.trim());
      }),
    [availableAssets, content.activeSectionImageRefsById, availableGeneratedVisuals]
  );
  const authoredListVisuals = useMemo(() => {
    if (!playbackVisualSections(block, sources).length) return [];
    return playbackNonProseVisuals(block).flatMap((visual, sourceIndex) => {
      if (visual.kind === 'scene' && !LESSON_SCENE_DIAGRAM_TYPES.has(visual.scene.type)) return [];
      if (visual.kind === 'markdown' && block.spans.some(span => span.math === visual.markdown))
        return [];
      if (!availableVisuals([visual]).length) return [];
      // Source occurrences remain stable when another asset becomes unavailable.
      return [{ visual, sourceIndex }];
    });
  }, [block, sources, availableVisuals]);
  const scene =
    visualBlock.prepared?.scene && !isRetiredLessonScene(visualBlock.prepared.scene)
      ? visualBlock.prepared.scene
      : undefined;
  const normalVisualCandidates = useMemo(() => {
    if (visualBlock.prepared?.sections?.length)
      return visualBlock.prepared.sections.map(section => ({
        kind: 'scene' as const,
        scene: section.scene,
      }));
    const formulas = getPlaybackFormulaMarkdown(visualBlock, sources);
    const cards = visualBlock.visuals.filter(
      visual =>
        visual.kind === 'markdown' && visualBlock.spans.some(span => span.math === visual.markdown)
    );
    const sourceVisuals =
      cards.length > 1 &&
      cards.length === visualBlock.visuals.length &&
      !visualBlock.prepared?.scene
        ? cards
        : playbackNonProseVisuals(visualBlock);
    const projected = availableVisuals(sourceVisuals);
    if (
      formulas &&
      !playbackPreparedFormulaIsUsable(
        { ...visualBlock, prepared: visualBlock.prepared && { ...visualBlock.prepared, scene } },
        sources
      )
    )
      return projected.length ? projected : [{ kind: 'markdown' as const, markdown: formulas }];
    if (scene && getPlaybackMathMarkdown(visualBlock))
      return [...projected, { kind: 'scene' as const, scene }];
    if (projected.length)
      return projected.map(visual => {
        if (!scene) return visual;
        if (playbackVisualScene(visual, availableGeneratedVisuals)?.type === 'formula-spotlight')
          return visual;
        const existingScene =
          visual.kind === 'scene' ||
          (visual.kind === 'generated-visual' &&
            availableGeneratedVisuals[visual.visualId] &&
            getStoredLessonVisualScene(availableGeneratedVisuals[visual.visualId]));
        return existingScene ? { kind: 'scene' as const, scene } : visual;
      });
    if (scene) return [{ kind: 'scene' as const, scene }];
    if (formulas) return [{ kind: 'markdown' as const, markdown: formulas }];
    return [];
  }, [visualBlock, sources, availableGeneratedVisuals, scene, availableVisuals]);
  const visualCandidates = useMemo(
    () =>
      !hasPreparedVisualSections(visualBlock, sources)
        ? []
        : projectStageFormulaVisuals({
            block: visualBlock,
            sources,
            visuals: normalVisualCandidates,
            storedById: availableGeneratedVisuals,
          }),
    [visualBlock, sources, normalVisualCandidates, availableGeneratedVisuals]
  );
  const needsVisual = visualCandidates.length === 0;
  const { projectId, activeSectionId: sectionId } = content;
  useEffect(() => {
    if (!needsVisual || !projectId || !sectionId) return;
    let mounted = true;
    void import('../../../services/openrouter/lessonPlaybackVisualClient.ts')
      .then(({ prepareLessonPlaybackVisual }) =>
        prepareLessonPlaybackVisual({ projectId, sectionId, block, lessonKey })
      )
      .then(
        prepared => {
          if (mounted) setPreparedVisual(prepared);
        },
        error => {
          console.warn('Playback visual preparation failed.', error);
        }
      );
    return () => {
      mounted = false;
    };
  }, [needsVisual, projectId, sectionId, block, lessonKey]);
  const visualProjection = JSON.stringify(visualCandidates, (_key, value: unknown) =>
    value && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(
          Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
        )
      : value
  );
  const visuals = useMemo(
    () => JSON.parse(visualProjection) as readonly StageVisual[],
    [visualProjection]
  );
  const [selection, setSelection] = useState<{
    blockId: string;
    index: number;
  } | null>(null);
  const visualReferences = useMemo(
    () =>
      visuals.map(visual => {
        const scene = playbackVisualScene(visual, availableGeneratedVisuals);
        const anchors = visuals.length > 1 ? sceneCaptionAnchors(scene, block.speech) : undefined;
        return {
          anchors,
          range:
            scene?.type === 'formula-spotlight' && anchors
              ? formulaReferenceRange(scene, block.speech)
              : undefined,
        };
      }),
    [visuals, availableGeneratedVisuals, block.speech]
  );
  const visualRangeProjection = JSON.stringify(
    visualCandidates.map(
      (visual, index) =>
        visualBlock.prepared?.sections?.[index]?.range ??
        visual.voiceRange ??
        visual.formulaRange ??
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
    let referenceCues: (ReturnType<typeof formulaCueTiming> | undefined)[] = [];
    let readingSpans: ReturnType<typeof captionRangeSpan>[][] = [];
    let frame = 0;
    const tick = () => {
      const current = clock.current;
      if (
        current &&
        (current.width ||
          current.aligned ||
          current.bodyDuration === 0 ||
          !(visualReferences.some(reference => reference.anchors) || visualRanges.some(Boolean)))
      ) {
        if (current !== previousClock) {
          const previousSpans = spans;
          const previousReferenceCues = referenceCues;
          const previousReadingSpans = readingSpans;
          referenceCues = visuals.map((visual, index) => {
            if (!visual.referenceFormula || visual.kind !== 'scene') return undefined;
            const next = formulaCueTiming(
              visual.scene as FormulaSpotlightData,
              block.speech,
              current
            );
            if (!canRetainPresentedCues(current, previousClock)) return next;
            const heardMs = current.read().blockTime * 1000;
            return {
              ...next,
              times: adoptCueTimes(previousReferenceCues[index]?.times, next.times, heardMs),
              ends: adoptCueTimes(previousReferenceCues[index]?.ends, next.ends, heardMs),
            };
          });
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
          spans = visualReferences.map(({ anchors: quotation, range: referenceRange }, index) => {
            const range = visualRanges[index] ?? referenceRange;
            if (range) return captionRangeSpan({ ...timing, range });
            if (!quotation) return undefined;
            return captionAnchorSpan({ ...timing, anchors: quotation, speech: block.speech });
          });
          readingSpans = formulaReadingSpans(visuals, timing);
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
          if (canRetainPresentedCues(current, previousClock)) {
            readingSpans = retainReadingSpans(
              readingSpans,
              previousReadingSpans,
              current.read().blockTime * 1000
            );
          }
          previousClock = current;
        }
        const { blockTime } = current.read();
        let active = 0;
        let latestStart = Number.NEGATIVE_INFINITY;
        let earliestStart = Number.POSITIVE_INFINITY;
        spans.forEach((span, index) => {
          // Appended equations have no primary passage slot; their readings and references select them.
          if (visuals[index].referenceOnly) return;
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
        let referenceStart = Number.NEGATIVE_INFINITY;
        spans.forEach((span, index) => {
          if (!visuals[index].referenceFormula || !span) return;
          const start = span.startMs / 1000;
          // A later normal visual owns the gaps; exact heard references can bring this one back.
          if (
            start >= latestStart &&
            start <= blockTime &&
            blockTime < span.endMs / 1000 &&
            start >= referenceStart
          ) {
            referenceStart = start;
            active = index;
          }
        });
        active = heardReferenceVisual(referenceCues, blockTime * 1000, active);
        const reading = heardReadingVisual(readingSpans, blockTime * 1000);
        if (reading >= 0) active = reading;
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
    visual?.kind === 'generated-visual' ? availableGeneratedVisuals[visual.visualId] : undefined;
  const selectedScene = visual ? playbackVisualScene(visual, availableGeneratedVisuals) : null;
  const formulaMarkdown = useMemo(
    () => getPlaybackFormulaMarkdown(block, sources),
    [block, sources]
  );
  const supplementalFormula =
    formulaMarkdown &&
    !visual?.staticFormula &&
    (!visualRanges[visualIndex] || visualBlock.prepared?.sections?.length) &&
    selectedScene?.type !== 'formula-spotlight' &&
    !(visual?.kind === 'markdown' && visual.markdown === formulaMarkdown)
      ? formulaMarkdown
      : undefined;
  const sceneProps = {
    itemRanges: visualBlock.prepared?.sections?.[visualIndex]?.items,
    block: visualBlock,
    clock,
    speed,
    animate,
  };
  const passageHeadings = formatted.headings.length ? formatted.headings : [block.heading];
  const passageTitle = passageHeadings.join('\n');
  useLayoutEffect(() => {
    if (!questionContextRef) return;
    const read = () => {
      // Capture the committed visual and emphasis already painted by the scene renderer.
      const voiceTime =
        clock.current?.read().blockTime ?? latest.current.readTime?.() ?? latest.current.time;
      const host = sceneCard.current;
      const highlighted = host
        ? Array.from(
            host.querySelectorAll<HTMLElement | SVGElement>(
              '[data-motion-id], [aria-current="step"], [data-active="true"]'
            )
          )
            .filter(
              element =>
                element.getAttribute('aria-current') === 'step' ||
                element.dataset.active === 'true' ||
                Number.parseFloat(element.style.getPropertyValue('--motion-emphasis')) > 0
            )
            .map(element => ({
              id:
                element.dataset.motionId ??
                element.dataset.formulaSymbol ??
                element.dataset.stop ??
                '',
              text: element.textContent?.trim() ?? '',
            }))
        : [];
      let code = visual?.kind === 'mermaid' ? visual.code : undefined;
      if (selectedStored && getStoredLessonVisualKind(selectedStored) !== 'image') {
        code = getStoredLessonVisualCode(selectedStored) ?? undefined;
      }
      return {
        passage: { title: passageTitle, text: source.markdown },
        voiceTime,
        heardSentence: playbackHeardSentence(block, voiceTime, duration, alignment),
        visual: visual
          ? {
              kind: selectedStored ? getStoredLessonVisualKind(selectedStored) : visual.kind,
              title: selectedScene?.title ?? selectedStored?.title ?? block.heading,
              scene: selectedScene ?? undefined,
              code,
              description: selectedStored?.altText,
              markdown: visual.kind === 'markdown' ? visual.markdown : undefined,
              formula: supplementalFormula,
              renderedText: host?.textContent?.trim() ?? '',
              highlighted,
            }
          : undefined,
      };
    };
    questionContextRef.current = read;
    return () => {
      if (questionContextRef.current === read) questionContextRef.current = null;
    };
  }, [
    questionContextRef,
    block,
    passageTitle,
    source.markdown,
    duration,
    alignment,
    visual,
    selectedScene,
    selectedStored,
    supplementalFormula,
  ]);
  return (
    <div className="lesson-player-stage">
      <section className="listening-stage">
        <section className="captions" aria-label={t('Sottotitoli')}>
          {passageHeadings.map((heading, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: authored headings may repeat
            <h2 key={`${index}:${heading}`}>{heading}</h2>
          ))}
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
            hasVisual={!!visual}
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
            {authoredListVisuals.map(({ visual: authored, sourceIndex }) => (
              <PlaybackVisualContent
                key={`authored:${sourceIndex}`}
                {...sceneProps}
                itemRanges={undefined}
                onImageUnavailable={onImageUnavailable}
                interval={{ start: 0, duration }}
                visual={authored}
                content={{ ...content, activeSectionAssetsById: availableAssets }}
              />
            ))}
            {supplementalFormula ? (
              <MarkdownRenderer content={supplementalFormula} isDarkMode={content.isDarkMode} />
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
                content={{
                  ...content,
                  activeSectionAssetsById: availableAssets,
                  activeSectionGeneratedVisualsById: availableGeneratedVisuals,
                }}
              />
            ) : null}
          </SaveablePlaybackVisual>
        </div>
      </section>
    </div>
  );
}

/** Each narration owns its clock so retiring subscriptions keep their original text ranges. */
export default function LessonPlaybackStage(
  props: Omit<Parameters<typeof PlaybackPassage>[0], 'sources'>
) {
  // Equivalent project snapshots retain the source syntax analysis between passages.
  const sourceKey = useMemo(
    () =>
      JSON.stringify(
        props.content.sectionContentBlocks?.length
          ? props.content.sectionContentBlocks
          : [{ type: 'markdown', markdown: props.content.sectionContent }]
      ),
    [props.content.sectionContentBlocks, props.content.sectionContent]
  );
  const sources = useMemo(
    () => JSON.parse(sourceKey) as readonly PlaybackContentBlock[],
    [sourceKey]
  );
  const block = useMemo(() => resolvePlaybackNarration(props.block), [props.block]);
  return (
    <PlaybackPassage
      {...props}
      sources={sources}
      block={block}
      key={`${block.id}:${block.speech}`}
    />
  );
}
