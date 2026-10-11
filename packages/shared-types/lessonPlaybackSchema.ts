import * as z from 'zod';
import type { LessonPlayback } from './lessonPlayback';
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

const createPlaybackPreparedSchema = (sceneSchema = LessonSceneSchema) =>
  z.object({
    scene: sceneSchema.optional(),
    motion: z.array(
      z.object({
        effect: z.enum(['focus', 'reveal']),
        targets: z.array(z.string()),
        quote: z.string().min(1),
      })
    ),
  });

export const PlaybackPreparedSchema = createPlaybackPreparedSchema();

export const PlaybackAudioSchema = z.object({
  model: z.string().min(1),
  voice: z.string().min(1),
  asset: ProjectAssetRefSchema,
  durationSeconds: z.number().positive(),
});

export const createLessonPlaybackBlockSchema = (sceneSchema = LessonSceneSchema) =>
  z.object({
    id: z.string().min(1),
    heading: z.string(),
    speech: z.string(),
    spans: z.array(
      z.object({
        speech: PlaybackRangeSchema,
        sourceBlockIndex: z.number().int().nonnegative(),
        source: PlaybackRangeSchema,
      })
    ),
    visuals: z.array(
      z.union([
        z.object({ kind: z.literal('markdown'), markdown: z.string() }),
        z.object({ kind: z.literal('generated-visual'), visualId: z.string().min(1) }),
        z.object({ kind: z.literal('scene'), scene: sceneSchema }),
      ])
    ),
    prepared: createPlaybackPreparedSchema(sceneSchema).optional(),
    audio: z.array(PlaybackAudioSchema),
  });

export const LessonPlaybackBlockSchema = createLessonPlaybackBlockSchema();

const LessonPlaybackSchema = z.object({
  version: z.literal(1),
  lessonKey: z.string().length(64),
  blocks: z.array(LessonPlaybackBlockSchema),
});

/** Validate imported project data without adding custom checks to durable workflow schemas. */
export const isValidLessonPlayback = (value: unknown): value is LessonPlayback => {
  const parsed = LessonPlaybackSchema.safeParse(value);
  if (!parsed.success) return false;
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
  z.object({ runId: z.string().min(1), blockId: z.string().min(1), voice: z.string().min(1) }),
]);
