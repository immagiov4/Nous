import * as z from 'zod';

import {
  type AiProvider,
  type GlobalModelConfig,
  resolveAiProviderForSlot,
  resolveCodexServiceTierForSlot,
  resolveTextModelConfig,
} from '../config/modelConfig.js';

export const MAX_LESSON_VISUAL_REVIEW_ROUNDS = 4;

const ResolvedTextModelConfigSchema = z.object({
  model: z.string().min(1),
  provider: z.enum(['codex', 'openai', 'openrouter']),
  reasoningEffort: z.enum(['none', 'minimal', 'low', 'medium', 'high']),
  serviceTier: z.literal('fast').optional(),
});

export const LessonVisualModelConfigSchema = z.object({
  artifact: ResolvedTextModelConfigSchema,
  artifactInteractive: ResolvedTextModelConfigSchema,
  image: z.object({
    model: z.string().min(1),
    provider: z.enum(['codex', 'openai', 'openrouter']),
  }),
  review: z.object({
    enabled: z.boolean(),
    maxRounds: z.number().int().min(1).max(MAX_LESSON_VISUAL_REVIEW_ROUNDS),
  }),
});

export type LessonVisualModelConfig = z.infer<typeof LessonVisualModelConfigSchema>;

const resolveTextSlot = (
  config: GlobalModelConfig,
  slot: 'artifact' | 'artifactInteractive'
): LessonVisualModelConfig['artifact'] => {
  const provider = resolveAiProviderForSlot(config, slot);
  const resolved = resolveTextModelConfig(config, slot);
  const serviceTier =
    provider === 'codex' ? resolveCodexServiceTierForSlot(config, slot) : undefined;
  return Object.freeze({
    model: resolved.model,
    provider,
    reasoningEffort: resolved.reasoningEffort,
    ...(serviceTier ? { serviceTier } : {}),
  });
};

const resolveImageModel = (config: GlobalModelConfig, provider: AiProvider): string => {
  if (provider === 'codex') return config.codexArtifactModel;
  if (provider === 'openai') return config.openAiImageModel;
  return config.imageModel;
};

export const resolveLessonVisualModelConfig = (
  config: GlobalModelConfig
): LessonVisualModelConfig => {
  const imageProvider = resolveAiProviderForSlot(config, 'image');
  return Object.freeze({
    artifact: resolveTextSlot(config, 'artifact'),
    artifactInteractive: resolveTextSlot(config, 'artifactInteractive'),
    image: Object.freeze({
      model: resolveImageModel(config, imageProvider),
      provider: imageProvider,
    }),
    review: Object.freeze({
      enabled: config.artifactVisualReviewEnabled,
      maxRounds: config.artifactVisualReviewMaxRounds,
    }),
  });
};
