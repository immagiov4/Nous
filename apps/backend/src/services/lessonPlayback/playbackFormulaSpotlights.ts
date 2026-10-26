import {
  type FormulaSpotlightData,
  formulaSpotlightCovers,
  getFormulaSpotlightLatex,
} from '@shared/formulaSpotlight';
import {
  hasCompletePlaybackFormulaReferences,
  isPreparedPlaybackFormula,
  type LessonPlaybackBlock,
  type PlaybackContentBlock,
  playbackFormulaTargets,
  resolvePlaybackNarration,
} from '@shared/lessonPlayback';
import { type LessonScene, LessonSceneSchema } from '@shared/lessonScene';
import type { ProjectLessonVisual } from '@shared/projectAsset';
import * as z from 'zod';
import type { GlobalModelConfig } from '../../config/modelConfig.js';
import { failPermanently } from '../../workflows/retryPolicy.js';
import type { WorkflowProviderEffectExecutor } from '../../workflows/types.js';
import {
  generateLessonScene,
  type LessonSceneOutcome,
} from '../lessonScenes/lessonSceneGeneration.js';
import { resolveLessonVisualModelConfig } from '../lessonVisualModelConfig.js';
import { MAX_PLAYBACK_PREPARATION_ATTEMPTS } from './playbackMotion.js';

/** Correct the actual failed draft while keeping semantic links owned by the visual service. */
function formulaRetryFeedback(outcome: LessonSceneOutcome, sourceFormula: string) {
  const previous =
    outcome.kind === 'scene' && outcome.scene.type === 'formula-spotlight'
      ? (outcome.scene as LessonScene & FormulaSpotlightData)
      : undefined;
  const previousDraft =
    outcome.kind === 'invalid'
      ? outcome.formulaCorrection
      : previous && { formula: previous.formula, symbols: previous.symbols };
  return JSON.stringify({
    problems:
      outcome.kind === 'invalid'
        ? outcome.problems
        : [
            'Restore every authored term, operator and delimiter, and link every named part with exact narration quotations.',
          ],
    sourceFormula,
    previousFormula: previous ? getFormulaSpotlightLatex(previous) : undefined,
    previousDraft,
  });
}

/** Prepare source-bound heard references through the existing visual service, without rewriting speech. */
export async function preparePlaybackFormulaSpotlights(input: {
  readonly block: LessonPlaybackBlock;
  readonly config: GlobalModelConfig;
  readonly signal: AbortSignal;
  readonly providerEffect?: WorkflowProviderEffectExecutor;
  readonly storedVisuals?: readonly ProjectLessonVisual[];
  readonly sources?: readonly PlaybackContentBlock[];
}) {
  const result: { formula: string; scene: LessonScene; sourceFormula?: string }[] = [];
  const narration = resolvePlaybackNarration(input.block);
  const entries = playbackFormulaTargets(input.block, input.storedVisuals, input.sources).map(
    target => ({
      ...target,
      spoken: narration.speech,
      dictatedRanges: target.readingRanges,
      existingScene:
        target.scene &&
        hasCompletePlaybackFormulaReferences(target.scene, narration.speech, target.readingRanges)
          ? target.scene
          : undefined,
    })
  );
  for (const [index, entry] of entries.entries()) {
    input.signal.throwIfAborted();
    // Keep source occurrence indices stable even when a neighbor already has an animated widget.
    if (entry.existingScene) {
      result.push({
        formula: entry.formula,
        sourceFormula: entry.sourceFormula,
        scene: entry.existingScene,
      });
      continue;
    }
    const saved = input.block.prepared?.formulaSpotlights?.[index];
    if (
      saved?.formula === entry.formula &&
      saved.sourceFormula === entry.sourceFormula &&
      isPreparedPlaybackFormula(saved.scene, narration.speech, entry.dictatedRanges)
    ) {
      result.push(saved);
      continue;
    }
    const operation = async () => {
      let retryFeedback: string | undefined;
      for (let attempt = 0; attempt < MAX_PLAYBACK_PREPARATION_ATTEMPTS; attempt++) {
        const outcome = await generateLessonScene({
          config: resolveLessonVisualModelConfig(input.config),
          allowedSceneTypes: ['formula-spotlight'],
          lessonMarkdown: `${entry.formula}\n\n${entry.spoken}`,
          narration: entry.spoken,
          formulaSource: {
            formula: entry.formula,
            dictatedRanges: entry.dictatedRanges,
          },
          sectionTitle: '',
          sectionDescription: '',
          retryFeedback,
          signal: input.signal,
        });
        input.signal.throwIfAborted();
        if (
          outcome.kind === 'scene' &&
          outcome.scene.type === 'formula-spotlight' &&
          formulaSpotlightCovers(outcome.scene as FormulaSpotlightData, [entry.formula]) &&
          isPreparedPlaybackFormula(outcome.scene, narration.speech, entry.dictatedRanges)
        ) {
          return { scene: outcome.scene };
        }
        retryFeedback = formulaRetryFeedback(outcome, entry.formula);
      }
      throw failPermanently({
        code: 'lesson_playback_formula_spotlight_invalid',
        message: 'Formula highlighting preparation failed validation.',
        details: { feedback: retryFeedback ?? '' },
      });
    };
    const { scene } = input.providerEffect
      ? await input.providerEffect.run({
          key: `formula-spotlight:${index}`,
          outputSchema: z.object({ scene: LessonSceneSchema }),
          operation,
        })
      : await operation();
    result.push({
      formula: entry.formula,
      scene,
      ...(entry.sourceFormula ? { sourceFormula: entry.sourceFormula } : {}),
    });
  }
  return result;
}
