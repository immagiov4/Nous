import {
  type FormulaSpotlightData,
  hasUsableFormulaSpotlightReferences,
  resolveFormulaReferences,
} from '@shared/formulaSpotlight';
import {
  getPlaybackFormulaMarkdown,
  type LessonPlaybackBlock,
  type PlaybackContentBlock,
  type PlaybackRange,
  type PlaybackVisual,
  playbackFormulaReadingRanges,
  playbackFormulaTargets,
  playbackPreparedFormulaIsUsable,
  preparedFormulaSpotlightMatchesScene,
} from '@shared/lessonPlayback';
import type { LessonScene } from '@shared/lessonScene';
import { getStoredLessonVisualScene } from '../../../utils/visuals/storedLessonVisual.ts';
import type { WorkspaceReaderContentModel } from '../shell/types.ts';

export type StageVisual = PlaybackVisual & {
  formulaRange?: PlaybackRange;
  voiceRange?: PlaybackRange;
  readingRanges?: readonly PlaybackRange[];
  referenceFormula?: boolean;
  staticFormula?: boolean;
};

export function playbackVisualScene(
  visual: PlaybackVisual,
  storedById: WorkspaceReaderContentModel['activeSectionGeneratedVisualsById']
): LessonScene | null {
  if (visual.kind === 'scene') return visual.scene;
  const stored = visual.kind === 'generated-visual' && storedById?.[visual.visualId];
  return stored ? getStoredLessonVisualScene(stored) : null;
}

export function formulaReferenceRange(
  scene: LessonScene,
  speech: string,
  readings: readonly PlaybackRange[] = []
): PlaybackRange | undefined {
  const references = resolveFormulaReferences(scene as FormulaSpotlightData, speech);
  if (!references.length) return undefined;
  return {
    start: Math.min(references[0].start, ...readings.map(range => range.start)),
    end: Math.max(references[references.length - 1].end, ...readings.map(range => range.end)),
  };
}

/** Project persisted formula occurrences into heard-clock visuals without React or persistence effects. */
export function projectStageFormulaVisuals({
  block,
  sources,
  visuals: normalVisualCandidates,
  storedById,
}: Readonly<{
  block: LessonPlaybackBlock;
  sources: readonly PlaybackContentBlock[];
  visuals: readonly PlaybackVisual[];
  storedById: WorkspaceReaderContentModel['activeSectionGeneratedVisualsById'];
}>): readonly StageVisual[] {
  const spotlights = block.prepared?.formulaSpotlights;
  const normal: readonly StageVisual[] = normalVisualCandidates.map(visual => {
    const scene = playbackVisualScene(visual, storedById);
    if (scene?.type !== 'formula-spotlight') return visual;
    const readingRanges = playbackFormulaReadingRanges(block, scene as FormulaSpotlightData);
    return readingRanges.length ? { ...visual, readingRanges } : visual;
  });
  if (!spotlights?.length) return normal;
  if (spotlights.some(entry => entry.sourceFormula)) {
    const targets = playbackFormulaTargets(
      {
        ...block,
        visuals: block.visuals.map(visual => {
          const scene = playbackVisualScene(visual, storedById);
          return scene ? { kind: 'scene' as const, scene } : visual;
        }),
      },
      [],
      sources
    );
    const sourceScenes = targets.flatMap(target => (target.scene ? [target.scene] : []));
    const matched = new Set<number>();
    const original = normal.map(visual => {
      const scene = playbackVisualScene(visual, storedById);
      if (scene?.type !== 'formula-spotlight') return visual;
      // Consume distinct source occurrences; repeated projections of one scene share its slot.
      let sourceIndex = sourceScenes.findIndex(
        (source, index) => source === scene && !matched.has(index)
      );
      if (sourceIndex < 0)
        sourceIndex = sourceScenes.indexOf(scene as LessonScene & FormulaSpotlightData);
      if (sourceIndex >= 0) matched.add(sourceIndex);
      const entry = spotlights[sourceIndex];
      if (!entry || !preparedFormulaSpotlightMatchesScene(entry, scene as FormulaSpotlightData))
        return visual;
      if (hasUsableFormulaSpotlightReferences(scene as FormulaSpotlightData, block.speech))
        return visual;
      const readingRanges = visual.readingRanges ?? [];
      const voiceRange = formulaReferenceRange(entry.scene, block.speech, readingRanges);
      return voiceRange
        ? { kind: 'scene' as const, scene: entry.scene, voiceRange, readingRanges }
        : { kind: 'markdown' as const, markdown: entry.formula, staticFormula: true };
    });
    return [
      ...original,
      ...spotlights.flatMap((entry, index) => {
        if (!entry.sourceFormula || matched.has(index)) return [];
        const target = targets[index];
        if (entry.formula !== target?.formula || entry.sourceFormula !== target.sourceFormula)
          return [];
        const readingRanges = target.readingRanges;
        const voiceRange = formulaReferenceRange(entry.scene, block.speech, readingRanges);
        return voiceRange
          ? [
              {
                kind: 'scene' as const,
                scene: entry.scene,
                voiceRange,
                readingRanges,
                referenceFormula: true,
              },
            ]
          : [];
      }),
    ];
  }
  if (
    normal.some(visual => {
      const scene = playbackVisualScene(visual, storedById);
      return (
        scene?.type === 'formula-spotlight' &&
        hasUsableFormulaSpotlightReferences(scene as FormulaSpotlightData, block.speech)
      );
    })
  )
    return normal;
  if (
    block.prepared?.scene?.type === 'formula-spotlight' &&
    playbackPreparedFormulaIsUsable(block, sources)
  )
    return normal;
  const formulas = block.spans.filter(span => span.math);
  const combined = getPlaybackFormulaMarkdown(block, sources);
  return [
    ...normal.filter(
      visual =>
        visual.kind !== 'markdown' ||
        (visual.markdown !== combined && !formulas.some(span => span.math === visual.markdown))
    ),
    ...spotlights.map((entry, index) => ({
      kind: 'scene' as const,
      scene: entry.scene,
      formulaRange: formulas[index].speech,
    })),
  ];
}
