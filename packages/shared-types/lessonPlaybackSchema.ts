import * as z from 'zod';
import {
  type LessonPlayback,
  validatePlaybackFencedCode,
  validatePlaybackSpokenMath,
} from './lessonPlayback';
import { isLessonScene, LessonSceneSchema } from './lessonScene';
import { isValidProjectAssetRef, type ProjectAssetRef } from './projectAsset';

export {
  HistoricalLessonSceneSchemas,
  LessonSceneAnimationShape,
  LessonSceneSchema,
} from './lessonScene';

export const ProjectAssetRefSchema: z.ZodType<ProjectAssetRef> = z.object({
  byteSize: z.number().int().nonnegative(),
  hash: z.string().length(64),
  id: z.string().length(64),
  mediaType: z.string().min(1),
});

const PlaybackRangeSchema = z.object({
  start: z.number().int().nonnegative(),
  end: z.number().int().nonnegative(),
});

export const PlaybackSpokenMathSchema = z.array(
  z.object({ formula: z.string().min(1), spoken: z.string().regex(/\S/u) })
);

export const PlaybackFencedCodeSchema = z.array(
  z.object({
    visualIndex: z.number().int().nonnegative(),
    kind: z.enum(['prose', 'code']),
    spoken: z.string(),
  })
);

const createPlaybackPreparedSchema = (
  sceneSchema = LessonSceneSchema,
  spokenMath = false,
  fencedCode = false
) => {
  const schema = z.object({
    fencedCode: PlaybackFencedCodeSchema.optional(),
    spokenMath: PlaybackSpokenMathSchema.optional(),
    scene: sceneSchema.optional(),
    motion: z.array(
      z.object({
        effect: z.enum(['focus', 'reveal']),
        targets: z.array(z.string()),
        quote: z.string().min(1),
      })
    ),
  });
  // Frozen definitions omit unsupported fields while retaining the shared internal type.
  if (!spokenMath)
    return z.object({ scene: schema.shape.scene, motion: schema.shape.motion }) as typeof schema;
  return fencedCode
    ? schema
    : (z.object({
        spokenMath: schema.shape.spokenMath,
        scene: schema.shape.scene,
        motion: schema.shape.motion,
      }) as typeof schema);
};

export const PlaybackPreparedSchema = createPlaybackPreparedSchema(LessonSceneSchema, true, true);

const LegacyPlaybackAudioSchema = z.object({
  model: z.string().min(1),
  voice: z.string().min(1),
  asset: ProjectAssetRefSchema,
  durationSeconds: z.number().positive(),
});

export const PlaybackWordAlignmentSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('aligned'), onsets: z.array(z.number().nonnegative()) }),
  z.object({ status: z.literal('failed') }),
]);
export const PlaybackAudioSchema = LegacyPlaybackAudioSchema.extend({
  wordAlignment: PlaybackWordAlignmentSchema.optional(),
});

export const createLessonPlaybackBlockSchema = (
  sceneSchema = LessonSceneSchema,
  spokenMath = false,
  fencedCode = false,
  legacyVisuals = false,
  wordAlignment = false
) => {
  const spanSchema = z.object({
    fencedCode: z
      .object({ visualIndex: z.number().int().nonnegative(), markdown: z.string() })
      .optional(),
    math: z.string().min(1).optional(),
    speech: PlaybackRangeSchema,
    sourceBlockIndex: z.number().int().nonnegative(),
    source: PlaybackRangeSchema,
  });
  const mathSpanSchema = fencedCode
    ? spanSchema
    : (z.object({
        math: spanSchema.shape.math,
        speech: spanSchema.shape.speech,
        sourceBlockIndex: spanSchema.shape.sourceBlockIndex,
        source: spanSchema.shape.source,
      }) as typeof spanSchema);
  return z.object({
    id: z.string().min(1),
    heading: z.string(),
    speech: z.string(),
    spans: z.array(
      spokenMath
        ? mathSpanSchema
        : (z.object({
            speech: spanSchema.shape.speech,
            sourceBlockIndex: spanSchema.shape.sourceBlockIndex,
            source: spanSchema.shape.source,
          }) as typeof spanSchema)
    ),
    visuals: z.array(
      z.union([
        z.object({ kind: z.literal('markdown'), markdown: z.string() }),
        z.object({ kind: z.literal('generated-visual'), visualId: z.string().min(1) }),
        z.object({ kind: z.literal('scene'), scene: sceneSchema }),
        ...(legacyVisuals ? [z.object({ kind: z.literal('mermaid'), code: z.string() })] : []),
      ])
    ),
    prepared: createPlaybackPreparedSchema(sceneSchema, spokenMath, fencedCode).optional(),
    audio: z.array(wordAlignment ? PlaybackAudioSchema : LegacyPlaybackAudioSchema),
  });
};

export const LessonPlaybackBlockSchema = createLessonPlaybackBlockSchema(
  LessonSceneSchema,
  true,
  true,
  true,
  true
);

const LessonPlaybackSchema = z.object({
  version: z.literal(1),
  lessonKey: z.string().length(64),
  blocks: z.array(LessonPlaybackBlockSchema),
});

/** Validate imported project data without adding custom checks to durable workflow schemas. */
export const isValidLessonPlayback = (value: unknown): value is LessonPlayback => {
  const parsed = LessonPlaybackSchema.safeParse(value);
  if (!parsed.success) return false;
  try {
    for (const block of parsed.data.blocks) {
      if (block.prepared?.fencedCode) validatePlaybackFencedCode(block, block.prepared.fencedCode);
      if (block.prepared?.spokenMath) validatePlaybackSpokenMath(block, block.prepared.spokenMath);
    }
  } catch {
    return false;
  }
  return parsed.data.blocks.every(
    block =>
      block.spans.every(
        span => span.speech.end >= span.speech.start && span.source.end >= span.source.start
      ) &&
      block.audio.every(
        audio => isValidProjectAssetRef(audio.asset) && audio.asset.mediaType === 'audio/mpeg'
      ) &&
      (!block.prepared?.scene || isLessonScene(block.prepared.scene)) &&
      block.visuals.every(visual => visual.kind !== 'scene' || isLessonScene(visual.scene))
  );
};

export const LessonPlaybackResponseSchema = LessonPlaybackSchema.omit({ version: true });
export const PrepareLessonPlaybackResponseSchema = z.union([
  z.object({
    block: LessonPlaybackBlockSchema,
    voice: z.string().min(1),
    model: z.string().min(1),
  }),
  z.object({
    runId: z.string().min(1),
    blockId: z.string().min(1),
    voice: z.string().min(1),
    created: z.boolean().optional(),
    visualOnly: z.boolean().optional(),
  }),
]);
