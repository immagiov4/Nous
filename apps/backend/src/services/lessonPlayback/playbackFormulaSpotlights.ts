import {
  type FormulaSpotlightData,
  formulaSpotlightCovers,
  getFormulaSpotlightLatex,
  hasFormulaSpotlightReferences,
} from '@shared/formulaSpotlight';
import {
  getPlaybackFormulaSources,
  type LessonPlaybackBlock,
  type PlaybackContentBlock,
  playbackFormulaSpotlightScenes,
  resolvePlaybackNarration,
} from '@shared/lessonPlayback';
import { type LessonScene, LessonSceneSchema } from '@shared/lessonScene';
import type { ProjectLessonVisual } from '@shared/projectAsset';
import * as z from 'zod';
import type { GlobalModelConfig } from '../../config/modelConfig.js';
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

/** Prepare exact local quotations through the existing visual service, without rewriting speech. */
export async function preparePlaybackFormulaSpotlights(input: {
  readonly block: LessonPlaybackBlock;
  readonly config: GlobalModelConfig;
  readonly signal: AbortSignal;
  readonly providerEffect?: WorkflowProviderEffectExecutor;
  readonly storedVisuals?: readonly ProjectLessonVisual[];
  readonly sources?: readonly PlaybackContentBlock[];
}) {
  const result: { formula: string; scene: LessonScene; sourceFormula?: string }[] = [];
  const scenes = playbackFormulaSpotlightScenes(input.block, input.storedVisuals);
  let entries: {
    formula: string;
    spoken: string;
    sourceFormula?: string;
    dictatedRange?: { start: number; end: number };
  }[];
  if (scenes.length)
    entries = scenes.map(scene => ({
      formula: `$$${getFormulaSpotlightLatex(scene)}$$`,
      spoken: resolvePlaybackNarration(input.block).speech,
      sourceFormula: scene.formula,
    }));
  else if (input.block.prepared?.spokenMath?.length) {
    const narration = resolvePlaybackNarration(input.block);
    const ranges = narration.spans.filter(span => span.math);
    entries = input.block.prepared.spokenMath.map((entry, index) => ({
      formula: entry.formula,
      spoken: narration.speech,
      sourceFormula: entry.formula,
      dictatedRange: ranges[index].speech,
    }));
  } else
    entries = getPlaybackFormulaSources(input.block, input.sources ?? []).map(formula => ({
      formula,
      spoken: resolvePlaybackNarration(input.block).speech,
      sourceFormula: formula,
    }));
  for (const [index, entry] of entries.entries()) {
    input.signal.throwIfAborted();
    const saved = input.block.prepared?.formulaSpotlights?.[index];
    if (saved?.formula === entry.formula && saved.sourceFormula === entry.sourceFormula) {
      result.push(saved);
      continue;
    }
    const occurrenceContext = entry.dictatedRange
      ? `\n\nThis formula occurrence is read at narration characters [${entry.dictatedRange.start}, ${entry.dictatedRange.end}): ${JSON.stringify(entry.spoken.slice(entry.dictatedRange.start, entry.dictatedRange.end))}. Link that reading and every explanatory reference to its parts in the full narration, including later mentions of the same symbol.`
      : '';
    const operation = async () => {
      let retryFeedback: string | undefined;
      for (let attempt = 0; attempt < MAX_PLAYBACK_PREPARATION_ATTEMPTS; attempt++) {
        const outcome = await generateLessonScene({
          config: resolveLessonVisualModelConfig(input.config),
          allowedSceneTypes: ['formula-spotlight'],
          lessonMarkdown: `${entry.formula}\n\n${entry.spoken}${occurrenceContext}`,
          narration: entry.spoken,
          formulaAnchorOccurrences: true,
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
          ((!entry.dictatedRange && entry.sourceFormula) ||
            hasFormulaSpotlightReferences(outcome.scene as FormulaSpotlightData))
        ) {
          return { scene: outcome.scene };
        }
        retryFeedback = formulaRetryFeedback(outcome, entry.formula);
      }
      throw new Error('Formula highlighting preparation failed validation.', {
        cause: new Error(retryFeedback),
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
