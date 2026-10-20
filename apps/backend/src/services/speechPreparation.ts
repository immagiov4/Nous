import { createHash } from 'node:crypto';
import {
  type LessonPlaybackBlock,
  resolvePlaybackNarration,
  validatePlaybackFencedCode,
  validatePlaybackSpokenMath,
} from '@shared/lessonPlayback';
import { PlaybackSpokenMathSchema } from '@shared/lessonPlaybackSchema';
import {
  type GlobalModelConfig,
  resolveAiProviderForSlot,
  resolveCodexServiceTierForSlot,
  resolveTextModelConfig,
} from '../config/modelConfig.js';
import { canonicalJson } from '../workflows/schemaFingerprint.js';
import type { WorkflowProviderEffectExecutor } from '../workflows/types.js';
import {
  generatePlaybackNarration,
  generatePlaybackSpokenMath,
  PlaybackNarrationResponseSchema,
} from './lessonPlayback/playbackSpokenMath.js';
import { speechPreparationCache } from './speechPreparationCache.js';
import { ttsClient } from './ttsClient.js';

const SPEECH_PREPARATION_CONTRACT = 'lesson-narration-v1';

interface PrepareSpeechInput {
  readonly userId: string;
  readonly block: LessonPlaybackBlock;
  readonly config: GlobalModelConfig;
  readonly signal: AbortSignal;
  readonly providerEffect?: WorkflowProviderEffectExecutor;
  readonly supportsSpokenMath?: boolean;
  readonly supportsFencedCode?: boolean;
}

/** Resolve source, pronunciation and saved provider results before any synthesis or captions. */
export const prepareSpeech = async (input: PrepareSpeechInput) => {
  input.signal.throwIfAborted();
  const { block, config } = input;
  const hasPreparation =
    !block.prepared &&
    ((input.supportsSpokenMath !== false && block.spans.some(span => span.math)) ||
      (input.supportsFencedCode !== false && block.spans.some(span => span.fencedCode)));
  const narration = hasPreparation
    ? await speechPreparationCache.resolve(
        input.userId,
        createHash('sha256')
          .update(
            canonicalJson({
              contract: SPEECH_PREPARATION_CONTRACT,
              speech: block.speech,
              formulas: block.spans.flatMap(span => (span.math ? [span.math] : [])),
              fencedCode: block.spans.flatMap(span => (span.fencedCode ? [span.fencedCode] : [])),
              source: block.visuals.flatMap(visual =>
                visual.kind === 'markdown' ? [visual.markdown] : []
              ),
              model: resolveTextModelConfig(config, 'playbackPreparation'),
              provider: resolveAiProviderForSlot(config, 'playbackPreparation'),
              tier: resolveCodexServiceTierForSlot(config, 'playbackPreparation') ?? null,
              spokenMath: input.supportsSpokenMath !== false,
              classifyFencedCode: input.supportsFencedCode !== false,
            })
          )
          .digest('hex'),
        value => {
          const parsed = PlaybackNarrationResponseSchema.partial({ fencedCode: true }).parse(value);
          validatePlaybackSpokenMath(block, parsed.spokenMath);
          if (input.supportsFencedCode !== false && block.spans.some(span => span.fencedCode))
            validatePlaybackFencedCode(block, parsed.fencedCode ?? []);
          return parsed;
        },
        () => prepareNarration(input)
      )
    : await prepareNarration(input);
  input.signal.throwIfAborted();
  return {
    narration,
    block: resolvePlaybackNarration(block, narration.spokenMath, narration.fencedCode),
  };
};

/** One provider request shape for prepared narration, independently of its presentation. */
export const synthesizeSpeech = (request: {
  readonly text: string;
  readonly model: string;
  readonly voice: string;
  readonly signal?: AbortSignal;
  readonly speed?: number;
}) =>
  ttsClient.generateSpeech({
    ...request,
    text: request.text.replaceAll(/\s+/g, ' ').trim(),
    speed: request.speed ?? 1,
  });

const prepareNarration = async (input: PrepareSpeechInput) => {
  const { block } = input;
  if (block.prepared)
    return { spokenMath: block.prepared.spokenMath, fencedCode: block.prepared.fencedCode };
  if (input.supportsFencedCode !== false && block.spans.some(span => span.fencedCode)) {
    return input.providerEffect
      ? input.providerEffect.run({
          key: 'narration',
          outputSchema: PlaybackNarrationResponseSchema,
          operation: () => generatePlaybackNarration(input),
        })
      : generatePlaybackNarration(input);
  }
  const spokenMath = await prepareSpokenMath(input);
  return spokenMath ? { spokenMath } : {};
};

const prepareSpokenMath = async (input: PrepareSpeechInput) => {
  const { block } = input;
  if (block.prepared) return block.prepared.spokenMath;
  if (input.supportsSpokenMath === false || !block.spans.some(span => span.math)) return undefined;
  const operation = () => generatePlaybackSpokenMath(input);
  const spokenMath = input.providerEffect
    ? await input.providerEffect.run({
        key: 'spoken-math',
        outputSchema: PlaybackSpokenMathSchema,
        operation,
      })
    : await operation();
  validatePlaybackSpokenMath(block, spokenMath);
  return spokenMath;
};
