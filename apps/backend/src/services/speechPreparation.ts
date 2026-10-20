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
import type { LessonSourceProvenance } from './lessonPrimarySourceContext.js';
import { resolveLessonSpeechSource } from './lessonSpeechSource.js';
import { encodeSpeechAudio } from './speechAudio.js';
import { speechPreparationCache } from './speechPreparationCache.js';
import { MAX_TTS_TEXT_CHARS, ttsClient } from './ttsClient.js';

const SPEECH_PREPARATION_CONTRACT = 'lesson-narration-v1';

interface PrepareSpeechInput {
  readonly userId: string;
  readonly block: LessonPlaybackBlock;
  readonly sourceProvenance?: LessonSourceProvenance;
  readonly target?: { projectId: string; sectionId: string };
  readonly config: GlobalModelConfig;
  readonly signal: AbortSignal;
  readonly providerEffect?: WorkflowProviderEffectExecutor;
  readonly supportsSpokenMath?: boolean;
  readonly supportsFencedCode?: boolean;
}

/** Resolve source, pronunciation and saved provider results before any synthesis or captions. */
export const prepareSpeech = async (request: PrepareSpeechInput) => {
  request.signal.throwIfAborted();
  const input = request.target
    ? { ...request, ...(await resolveLessonSpeechSource({ ...request, target: request.target })) }
    : request;
  input.signal.throwIfAborted();
  const { block } = input;
  const narration = await prepareNarration(input);
  input.signal.throwIfAborted();
  return {
    narration,
    block: resolvePlaybackNarration(block, narration.spokenMath, narration.fencedCode),
  };
};

const cachedNarration = (
  input: PrepareSpeechInput,
  operation: () => ReturnType<typeof generatePlaybackNarration>
) => {
  const { block, config } = input;
  return speechPreparationCache.resolve(
    input.userId,
    createHash('sha256')
      .update(
        canonicalJson({
          contract: SPEECH_PREPARATION_CONTRACT,
          speech: block.speech,
          sourceProvenance: input.sourceProvenance ?? null,
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
    operation
  );
};

const READER_SPEECH_CHUNK_CHARS = 580;

const splitSpeechText = (text: string): string[] => {
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > READER_SPEECH_CHUNK_CHARS) {
    const boundary = remaining.lastIndexOf(' ', READER_SPEECH_CHUNK_CHARS);
    const end = boundary > 0 ? boundary : READER_SPEECH_CHUNK_CHARS;
    chunks.push(remaining.slice(0, end));
    remaining = remaining.slice(end).trimStart();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
};

/** One provider request shape for prepared narration, independently of its presentation. */
export const synthesizeSpeech = async (request: {
  readonly text: string;
  readonly model: string;
  readonly voice: string;
  readonly signal?: AbortSignal;
  readonly speed?: number;
}) => {
  const text = request.text.replaceAll(/\s+/g, ' ').trim();
  const speed = request.speed ?? 1;
  if (text.length <= MAX_TTS_TEXT_CHARS)
    return ttsClient.generateSpeech({ ...request, text, speed });
  const parts: Uint8Array[] = [];
  let model = request.model;
  let voice = request.voice;
  for (const chunk of splitSpeechText(text)) {
    request.signal?.throwIfAborted();
    const audio = await ttsClient.generateSpeech({ ...request, text: chunk, speed });
    model = audio.model;
    voice = audio.voice;
    parts.push((await encodeSpeechAudio(audio)).bytes);
  }
  return {
    model,
    voice,
    contentType: 'audio/mpeg',
    audioBuffer: Uint8Array.from(Buffer.concat(parts)).buffer,
  };
};

const prepareNarration = async (input: PrepareSpeechInput) => {
  const { block } = input;
  if (block.prepared)
    return { spokenMath: block.prepared.spokenMath, fencedCode: block.prepared.fencedCode };
  if (input.supportsFencedCode !== false && block.spans.some(span => span.fencedCode)) {
    const operation = () => cachedNarration(input, () => generatePlaybackNarration(input));
    return input.providerEffect
      ? input.providerEffect.run({
          key: 'narration',
          outputSchema: PlaybackNarrationResponseSchema,
          operation,
        })
      : operation();
  }
  const spokenMath = await prepareSpokenMath(input);
  return spokenMath ? { spokenMath } : {};
};

const prepareSpokenMath = async (input: PrepareSpeechInput) => {
  const { block } = input;
  if (block.prepared) return block.prepared.spokenMath;
  if (input.supportsSpokenMath === false || !block.spans.some(span => span.math)) return undefined;
  const operation = async () =>
    (
      await cachedNarration(input, async () => ({
        spokenMath: [...(await generatePlaybackSpokenMath(input))],
      }))
    ).spokenMath;
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
