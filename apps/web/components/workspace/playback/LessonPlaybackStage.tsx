import { type FormulaSpotlightData, formulaSpotlightCovers } from '@shared/formulaSpotlight';
import {
  getPlaybackFormulaCard,
  getPlaybackFormulaSources,
  getPlaybackMathMarkdown,
  type LessonPlaybackBlock,
  type PlaybackContentBlock,
  type PlaybackRange,
  type PlaybackVisual,
  playbackNonProseVisuals,
  resolvePlaybackNarration,
} from '@shared/lessonPlayback';
import {
  isAnimatedLessonScene,
  isRetiredLessonScene,
  isStudioLessonScene,
  LESSON_SCENE_DIAGRAM_TYPES,
  type LessonScene,
} from '@shared/lessonScene';
import type { PlaybackQuestionContext } from '@shared/playbackQuestionContext';
import {
  hasPreparedVisualSections,
  playbackVisualSections,
  preparedVisualTimeline,
} from '@shared/playbackVisualSections';
import { alignedWordTimes, type PlaybackWordAlignment } from '@shared/playbackWordTiming';
import {
  type CSSProperties,
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
  type CaptionWord,
  captionFormat,
  captionSource,
  captionSpeechRanges,
} from './captionFormat.ts';
import { type CaptionTimingClock, createCaptionTiming } from './captionTiming.ts';
import { captionViewport } from './captionViewport.ts';
import { NARRATED_FORMULA_CLASS, useNarratedFormulaFocus } from './narratedFormulaFocus.ts';
import {
  activeFocusCue,
  type CaptionRun,
  motionStates,
  revealProcessSteps,
  sceneCaptionAnchors,
  sceneElements,
  stopProcessScroll,
  studioCaptionRanges,
  type TimedMotionEvent,
  visualSpeechRange,
  visualWindowAtTime,
  type visualWindows,
} from './stageMotion.ts';
import './stage.css';
import { PlaybackVisualPresence, SaveablePlaybackVisual } from './SaveablePlaybackVisual.tsx';
import { StudioPlaybackSlot } from './StudioPlaybackSlot.tsx';

type DrawnCaptionRun = CaptionRun & { opacity?: number };
const CAPTION_FUTURE_OPACITY = 0.5;

interface CaptionClock extends CaptionTimingClock {
  viewport: ReturnType<typeof captionViewport>;
  runs: DrawnCaptionRun[];
  duration: number;
}

/** Theme colours stay in CSS; only changed progress is written to the retained word DOM. */
function drawCaptionWord(run: DrawnCaptionRun, progress: number) {
  const opacity = CAPTION_FUTURE_OPACITY + progress * (1 - CAPTION_FUTURE_OPACITY);
  if (run.opacity !== opacity) {
    run.span.style.opacity = String(opacity);
    run.opacity = opacity;
  }
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

type VisualWindow = ReturnType<typeof visualWindows>[number];
type StudioPresentation = {
  window?: VisualWindow;
  cueRanges?: readonly PlaybackRange[];
};
type VisualReferences = Pick<StudioPresentation, 'cueRanges'> & { anchors?: string[] };

function PlaybackScene({
  scene: sourceScene,
  projectId,
  block,
  clock,
  animate,
  isDarkMode,
  interval,
  studio,
  itemRanges,
}: Readonly<{
  scene: LessonScene;
  projectId?: string | null;
  block: LessonPlaybackBlock;
  clock: RefObject<CaptionClock | null>;
  speed: number;
  animate: boolean;
  isDarkMode: boolean;
  interval: { start: number; duration: number };
  studio?: StudioPresentation;
  itemRanges?: readonly PlaybackRange[];
}>) {
  // Parsed preparation snapshots can contain an equivalent scene with a new object identity.
  const sceneKey = JSON.stringify(sourceScene);
  const scene = useMemo<LessonScene>(() => JSON.parse(sceneKey), [sceneKey]);
  const host = useRef<HTMLDivElement>(null);
  const followedCue = useRef<{ key: string; seekRevision: number; viewportHeight: number }>(null);
  const anchorRanges = useMemo(
    () => studio?.cueRanges ?? studioCaptionRanges(scene, block),
    [studio?.cueRanges, scene, block]
  );
  const readAnimationFrame = useMemo<ReadSceneAnimationFrame | undefined>(() => {
    if (!isAnimatedLessonScene(scene) && scene.type !== 'formula-spotlight') return undefined;
    const studioScene = isStudioLessonScene(scene);
    const anchors = studioScene ? undefined : sceneCaptionAnchors(scene, block.speech);
    // Voice cues exclude both caption look-ahead and its graphical reveal feather.
    const timing = createCaptionTiming(block.speech, {
      anchors,
      anchorRanges,
      formula: scene.type === 'formula-spotlight' ? (scene as FormulaSpotlightData) : undefined,
    });
    return () => {
      const current = clock.current;
      if (!current?.bodyDuration) return undefined;
      if ((anchors || anchorRanges) && !current.width) return undefined;
      const { cueTimes, cueEndTimes } = timing.read(current);
      const { blockTime } = current.read();
      if (studioScene) {
        const startMs = (studio?.window?.start ?? interval.start) * 1000;
        const endMs = (studio?.window?.end ?? interval.start + interval.duration) * 1000;
        return {
          elapsedMs: blockTime * 1000 - startMs,
          durationMs: endMs - startMs,
          cueTimes: cueTimes?.filter(time => time < endMs).map(time => Math.max(0, time - startMs)),
        };
      }
      return anchors
        ? {
            elapsedMs: blockTime * 1000,
            durationMs: current.duration * 1000,
            cueTimes,
            cueEndTimes,
          }
        : {
            elapsedMs: (blockTime - interval.start) * 1000,
            durationMs: interval.duration * 1000,
          };
    };
  }, [scene, block.speech, clock, interval.start, interval.duration, studio?.window, anchorRanges]);
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
    const timing = createCaptionTiming(block.speech, {
      events: block.prepared?.motion,
      itemRanges,
    });
    let previousTiming: ReturnType<typeof timing.read> | undefined;
    const scrollport =
      scene.type === 'process' ? element.closest<HTMLElement>('[data-ordered-scroll]') : null;
    let previousFrame = '';
    const render = () => {
      const current = clock.current;
      if (!current?.width || !current.bodyDuration) return;
      const resolved = timing.read(current);
      const { events } = resolved;
      if (resolved !== previousTiming) {
        previousTiming = resolved;
        previousFrame = '';
      }
      if (hasMissingMotionTargets(events, elements)) return;
      const voiceTime = current.read().blockTime * 1000;
      const frameKey = `${current.seekRevision}:${voiceTime}:${animate}`;
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
      if (!scrollport || scrollport.closest('[inert]')) return;
      const { onset, targets: targetIds } = activeFocusCue(events, voiceTime);
      const key = `${current.seekRevision}:${onset}:${targetIds.join(',')}`;
      if (key === followedCue.current?.key) return;
      const seekChanged = current.seekRevision !== followedCue.current?.seekRevision;
      followedCue.current = {
        key,
        seekRevision: current.seekRevision,
        viewportHeight: scrollport.clientHeight,
      };
      if (targetIds.length) {
        revealProcessSteps(
          scrollport,
          targetIds.flatMap(id => elements.get(id) ?? []),
          animate
        );
      } else if (seekChanged) {
        stopProcessScroll(scrollport);
      }
    };
    // A footer or the initial fit can shrink the visible area during a single spoken cue.
    const viewportObserver =
      scrollport &&
      new ResizeObserver(() => {
        if (!followedCue.current || followedCue.current.viewportHeight === scrollport.clientHeight)
          return;
        followedCue.current = null;
        previousFrame = '';
        render();
      });
    if (scrollport) viewportObserver?.observe(scrollport);
    // Mermaid mounts its targets asynchronously.
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
      viewportObserver?.disconnect();
      for (const target of Array.from(elements.values()).flat()) {
        target.classList.remove('motion-target');
        target.style.removeProperty('opacity');
        target.style.removeProperty('--motion-emphasis');
        delete target.dataset.motionId;
      }
    };
  }, [animate, block.prepared?.motion, block.speech, clock, scene, itemRanges]);
  return (
    <div ref={host} data-studio-viewport={isStudioLessonScene(scene) || undefined}>
      <LessonSceneVisual
        scene={scene}
        projectId={projectId}
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
  studio?: StudioPresentation;
  itemRanges?: readonly PlaybackRange[];
}>) {
  const scene = getStoredLessonVisualScene(visual);
  const onUnavailable = useCallback(
    () => onImageUnavailable(visual.id),
    [onImageUnavailable, visual.id]
  );
  return scene ? (
    <PlaybackScene
      {...props}
      scene={scene}
      projectId={content.projectId}
      isDarkMode={content.isDarkMode}
    />
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
  narratedFormula,
  visual,
  content,
  onImageUnavailable,
  ...props
}: Readonly<{
  visual: PlaybackVisual;
  narratedFormula?: boolean;
  onImageUnavailable: (imageId: string) => void;
  content: WorkspaceReaderContentModel;
  block: LessonPlaybackBlock;
  clock: RefObject<CaptionClock | null>;
  speed: number;
  animate: boolean;
  interval: { start: number; duration: number };
  studio?: StudioPresentation;
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
          projectId={content.projectId}
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
          content={visual.markdown}
          className={narratedFormula ? NARRATED_FORMULA_CLASS : undefined}
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
  sourceBlock,
  sources,
  time,
  duration,
  content,
  speed = 1,
  readTime,
  alignment,
  seekRevision = 0,
  loading = false,
  questionContextRef,
}: Readonly<{
  lessonKey?: string;
  block: LessonPlaybackBlock;
  sourceBlock: LessonPlaybackBlock;
  sources: readonly PlaybackContentBlock[];
  time: number;
  duration: number;
  content: WorkspaceReaderContentModel;
  speed?: number;
  readTime?: () => number;
  alignment?: PlaybackWordAlignment;
  seekRevision?: number;
  loading?: boolean;
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
  const captions = useRef<HTMLElement>(null);
  const sceneCard = useRef<HTMLElement>(null);
  const clock = useRef<CaptionClock | null>(null);

  const animate = useShouldAnimate();
  const latest = useRef({ time, speed, readTime, animate, aligned, seekRevision, loading });
  useLayoutEffect(() => {
    latest.current = { time, speed, readTime, animate, aligned, seekRevision, loading };
  }, [time, speed, readTime, animate, aligned, seekRevision, loading]);

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
      const bodyDuration =
        (duration * formatted.words.length) / (formatted.words.length + formatted.headingWords);
      clock.current = {
        viewport: captionViewport(paragraph),
        runs,
        width,
        bodyDuration,
        aligned: latest.current.aligned,
        duration,
        seekRevision: latest.current.seekRevision,
        headingDuration: duration - bodyDuration,
        speechRanges: formatted.speechRanges,
        // Preparation exposes the requested position before the live audio anchor commits.
        read: () => ({
          blockTime: latest.current.loading
            ? latest.current.time
            : (latest.current.readTime?.() ?? latest.current.time),
        }),
      };
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(paragraph);
    window.addEventListener('resize', measure);
    document.fonts.addEventListener('loadingdone', measure);
    return () => {
      observer.disconnect();
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
    const timing = createCaptionTiming(block.speech, { words: formatted.speechRanges });
    let previousClock: CaptionClock | null = null;
    let previousBodyTime: number | undefined;
    let previousActive: HTMLElement | undefined;
    const render = () => {
      const paragraph = captions.current;
      if (!paragraph) throw new Error('Captions must be mounted');
      const current = clock.current;
      if (!current?.width || !current.bodyDuration) return;
      if (previousClock !== current) {
        previousClock = current;
        previousBodyTime = undefined;
      }
      const { blockTime: bodyTime } = current.read();
      const motion = latest.current.animate;
      current.viewport.clip();
      if (previousBodyTime === bodyTime) return;
      const progress = timing.fill(current, bodyTime, latest.current.speed);
      current.runs.forEach((run, index) => {
        drawCaptionWord(run, progress[index]);
      });
      const spokenWord = timing.spokenWord();
      const active = spokenWord === undefined ? undefined : current.runs[spokenWord]?.span;
      if (active !== previousActive) {
        previousActive?.removeAttribute('aria-current');
        active?.setAttribute('aria-current', 'true');
        previousActive = active;
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
  }, [block.speech, formatted.speechRanges]);

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
    () => (preparedVisual ? { ...block, prepared: preparedVisual } : block),
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
  const visualTimeline = useMemo(
    () =>
      hasPreparedVisualSections(visualBlock, sources) ? preparedVisualTimeline(visualBlock) : null,
    [visualBlock, sources]
  );
  const formulaCard = useMemo(() => getPlaybackFormulaCard(block, sources), [block, sources]);
  const formulaFallback = useMemo(
    () => formulaCard && { kind: 'markdown' as const, markdown: formulaCard.markdown },
    [formulaCard]
  );
  const visualCandidates = useMemo(() => {
    if (!visualTimeline) return [];
    if (visualBlock.prepared?.sections?.length)
      return visualTimeline.map(section =>
        section.scene
          ? {
              kind: 'scene' as const,
              scene: section.scene,
            }
          : null
      );
    const cards = block.visuals.filter(
      visual =>
        visual.kind === 'markdown' && block.spans.some(span => span.math === visual.markdown)
    );
    const sourceVisuals =
      cards.length > 1 && cards.length === block.visuals.length && !visualBlock.prepared?.scene
        ? cards
        : playbackNonProseVisuals(block);
    const projected = availableVisuals(sourceVisuals);
    if (
      scene?.type === 'formula-spotlight' &&
      formulaFallback &&
      !formulaSpotlightCovers(
        scene as FormulaSpotlightData,
        getPlaybackFormulaSources(block, sources)
      )
    )
      return projected.length ? projected : [formulaFallback];
    if (scene && getPlaybackMathMarkdown(block))
      return [...projected, { kind: 'scene' as const, scene }];
    if (projected.length)
      return projected.map(visual => {
        if (!scene) return visual;
        const existingScene =
          visual.kind === 'scene' ||
          (visual.kind === 'generated-visual' &&
            availableGeneratedVisuals[visual.visualId] &&
            getStoredLessonVisualScene(availableGeneratedVisuals[visual.visualId]));
        return existingScene ? { kind: 'scene' as const, scene } : visual;
      });
    if (formulaFallback && !visualBlock.prepared?.scene) return [formulaFallback];
    if (scene) return [{ kind: 'scene' as const, scene }];
    if (formulaFallback) return [formulaFallback];
    return [];
  }, [
    visualBlock,
    scene,
    availableVisuals,
    block,
    sources,
    availableGeneratedVisuals,
    visualTimeline,
    formulaFallback,
  ]);
  const needsVisual = visualCandidates.length === 0 && !visualTimeline?.length;
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
    () => JSON.parse(visualProjection) as readonly (PlaybackVisual | null)[],
    [visualProjection]
  );
  const [activeWindow, setActiveWindow] = useState<VisualWindow>();
  const visualReferenceKey = useMemo(
    () =>
      JSON.stringify(
        visuals.map(visual => {
          const stored =
            visual?.kind === 'generated-visual'
              ? availableGeneratedVisuals[visual.visualId]
              : undefined;
          const scene =
            visual?.kind === 'scene' ? visual.scene : stored && getStoredLessonVisualScene(stored);
          return {
            anchors:
              visuals.length > 1 && (!scene || !isStudioLessonScene(scene))
                ? sceneCaptionAnchors(scene, block.speech)
                : undefined,
            cueRanges: studioCaptionRanges(scene, block, stored ? sourceBlock : block),
          };
        })
      ),
    [visuals, availableGeneratedVisuals, block, sourceBlock]
  );
  const visualReferences = useMemo(
    () => JSON.parse(visualReferenceKey) as VisualReferences[],
    [visualReferenceKey]
  );
  const visualRangeProjection = JSON.stringify(
    visualCandidates.map(
      (visual, index) =>
        visualTimeline?.[index]?.range ??
        (visual &&
          visualSpeechRange(
            block,
            visual,
            visualCandidates
              .slice(0, index)
              .filter(
                previous =>
                  previous?.kind === 'markdown' &&
                  visual.kind === 'markdown' &&
                  previous.markdown === visual.markdown
              ).length
          ))
    )
  );
  const visualRanges = useMemo(
    () => JSON.parse(visualRangeProjection) as (PlaybackRange | null)[],
    [visualRangeProjection]
  );
  const lastCandidate = visualCandidates.at(-1);
  const hasPreparedSpotlight =
    !visualBlock.prepared?.sections?.length &&
    lastCandidate?.kind === 'scene' &&
    lastCandidate.scene.type === 'formula-spotlight' &&
    Boolean(getPlaybackMathMarkdown(block));
  useLayoutEffect(() => {
    if (!visuals.length) return;
    const cues =
      visuals.length > 1
        ? visualReferences.flatMap(
            ({ cueRanges }, index) => cueRanges?.map(range => ({ index, range })) ?? []
          )
        : [];
    const timing = createCaptionTiming(block.speech, {
      visuals: [
        ...visualReferences.map(({ anchors, cueRanges }, index) => ({
          anchors,
          anchorRanges: visuals.length > 1 ? cueRanges : undefined,
          range: visualRanges[index],
        })),
        ...cues.map(({ range }) => ({ range })),
      ],
    });
    const needsMeasurement =
      visualReferences.some(
        reference => reference.anchors || (visuals.length > 1 && reference.cueRanges)
      ) || visualRanges.some(Boolean);
    let previousSpans: ReturnType<typeof timing.read>['spans'] | undefined;
    let activeAtTime: ReturnType<typeof visualWindowAtTime> | undefined;
    let previous: VisualWindow | undefined;
    let frame = 0;
    const tick = () => {
      const current = clock.current;
      if (current && (current.width || !needsMeasurement)) {
        const { spans } = timing.read(current);
        if (spans !== previousSpans) {
          previousSpans = spans;
          activeAtTime = visualWindowAtTime(
            spans,
            visuals.length,
            cues.map(({ index }) => index),
            duration,
            hasPreparedSpotlight
          );
        }
        const { blockTime } = current.read();
        const active = activeAtTime?.(blockTime);
        if (active !== previous) {
          previous = active;
          setActiveWindow(current =>
            current?.index === active?.index &&
            current?.start === active?.start &&
            current?.end === active?.end
              ? current
              : active
          );
        }
      }
      frame = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(frame);
  }, [
    visualReferences,
    block.speech,
    duration,
    visuals.length,
    visualRanges,
    hasPreparedSpotlight,
  ]);
  const visualIndex = activeWindow?.index ?? 0;
  const cueRanges = visualReferences[visualIndex]?.cueRanges;
  const studio = useMemo(() => ({ window: activeWindow, cueRanges }), [activeWindow, cueRanges]);
  const visual = visuals[visualIndex];
  const selectedStored =
    visual?.kind === 'generated-visual' ? availableGeneratedVisuals[visual.visualId] : undefined;
  const selectedStoredKind = selectedStored ? getStoredLessonVisualKind(selectedStored) : undefined;
  let selectedScene: LessonScene | null = null;
  if (visual?.kind === 'scene') selectedScene = visual.scene;
  else if (selectedStored) selectedScene = getStoredLessonVisualScene(selectedStored);
  const studioLayout = isStudioLessonScene(selectedScene);
  const selectedRange = visualRanges[visualIndex];
  const selectedCandidate = visualCandidates[visualIndex];
  const hasPreparedSections = Boolean(visualBlock.prepared?.sections?.length);
  const { supplementalFormula, narratedFormulaRows, focusVisual } = useMemo(() => {
    if (!formulaCard) return {};
    if (
      (!selectedRange || hasPreparedSections) &&
      selectedScene?.type !== 'formula-spotlight' &&
      !(visual?.kind === 'markdown' && visual.markdown === formulaCard.markdown)
    ) {
      return { supplementalFormula: formulaCard.markdown, narratedFormulaRows: formulaCard.rows };
    }
    if (selectedCandidate === formulaFallback)
      return { narratedFormulaRows: formulaCard.rows, focusVisual: true };
    if (visual?.kind !== 'markdown' || !selectedRange) return {};
    const source = block.spans.find(
      span =>
        span.math === visual.markdown &&
        span.speech.start === selectedRange.start &&
        span.speech.end === selectedRange.end
    );
    const row = formulaCard.rows.find(row => row.range === source?.speech);
    return row?.range ? { narratedFormulaRows: [row], focusVisual: true } : {};
  }, [
    block.spans,
    formulaCard,
    formulaFallback,
    hasPreparedSections,
    selectedCandidate,
    selectedRange,
    selectedScene?.type,
    visual,
  ]);
  const visualKey = JSON.stringify([
    visualIndex,
    visual,
    supplementalFormula,
    [...unavailableImages],
  ]);
  useNarratedFormulaFocus(sceneCard, clock, narratedFormulaRows, loading ? undefined : aligned);
  const sceneProps = {
    itemRanges: visualTimeline?.[visualIndex]?.items,
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
      if (selectedStored && selectedStoredKind !== 'image') {
        code = getStoredLessonVisualCode(selectedStored) ?? undefined;
      }
      return {
        passage: { title: passageTitle, text: source.markdown },
        voiceTime,
        heardSentence: playbackHeardSentence(block, voiceTime, duration, alignment),
        visual: visual
          ? {
              kind: selectedStoredKind ?? visual.kind,
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
    selectedStoredKind,
    supplementalFormula,
  ]);
  const visualCard = (
    <SaveablePlaybackVisual
      key={visualKey}
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
        <MarkdownRenderer
          content={supplementalFormula}
          isDarkMode={content.isDarkMode}
          className={NARRATED_FORMULA_CLASS}
        />
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
          studio={studio}
          visual={visual}
          narratedFormula={focusVisual}
          content={{
            ...content,
            activeSectionAssetsById: availableAssets,
            activeSectionGeneratedVisualsById: availableGeneratedVisuals,
          }}
        />
      ) : null}
    </SaveablePlaybackVisual>
  );
  return (
    <div
      className="lesson-player-stage"
      style={{ '--caption-future-opacity': CAPTION_FUTURE_OPACITY } as CSSProperties}
    >
      <section className="listening-stage" data-studio-layout={studioLayout}>
        <section className="captions">
          <div className="caption-headings">
            {passageHeadings.map((heading, index) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: authored headings may repeat
              <h2 key={`${index}:${heading}`}>{heading}</h2>
            ))}
          </div>
          <section
            ref={captions}
            key={block.id}
            className="caption-page"
            aria-label={t('Sottotitoli')}
            // biome-ignore lint/a11y/noNoninteractiveTabindex: This named scroll region needs native keyboard scrolling.
            tabIndex={0}
          >
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
          </section>
        </section>
        <StudioPlaybackSlot studioLayout={studioLayout}>
          <PlaybackVisualPresence enabled={animate && selectedStoredKind !== 'html'}>
            {visualCard}
          </PlaybackVisualPresence>
        </StudioPlaybackSlot>
      </section>
    </div>
  );
}

/** Each narration owns its clock so retiring subscriptions keep their original text ranges. */
export default function LessonPlaybackStage(
  props: Omit<Parameters<typeof PlaybackPassage>[0], 'sources' | 'sourceBlock'>
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
      sourceBlock={props.block}
      key={`${block.id}:${block.speech}`}
    />
  );
}
