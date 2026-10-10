import * as z from 'zod';
import {
  LESSON_SCENE_EDGE_KINDS,
  LESSON_SCENE_NODE_KINDS,
  LESSON_SCENE_RELATION_KINDS,
  LESSON_SCENE_TYPES,
  LESSON_SCENE_VERDICTS,
} from './lessonScene';
import type { ProjectAssetRef } from './projectAsset';

export const ProjectAssetRefSchema: z.ZodType<ProjectAssetRef> = z.object({
  byteSize: z.number().int().nonnegative(),
  hash: z.string().length(64),
  id: z.string().length(64),
  mediaType: z.string().min(1),
});
const LessonSceneIconSlotSchema = z.string();

// Structural only: durable schemas admit no custom checks. The scene generation step validates the
// full contract with findLessonSceneProblems before a scene enters workflow state.
export const LessonSceneSchema = z.object({
  body: z.string(),
  criteria: z.array(z.string()).optional(),
  diagram: z
    .object({
      edges: z.array(
        z.object({
          evidence: z.string(),
          from: z.string(),
          kind: z.enum(LESSON_SCENE_EDGE_KINDS),
          label: z.string(),
          to: z.string(),
        })
      ),
      nodes: z.array(
        z.object({ id: z.string(), kind: z.enum(LESSON_SCENE_NODE_KINDS), label: z.string() })
      ),
    })
    .optional(),
  groups: z.array(
    z.object({
      icons: z.array(LessonSceneIconSlotSchema),
      items: z.array(z.string()),
      label: z.string(),
      verdict: z.enum(LESSON_SCENE_VERDICTS).optional(),
    })
  ),
  items: z.array(
    z.object({
      detail: z.string(),
      icon: LessonSceneIconSlotSchema,
      label: z.string(),
      time: z.number().optional(),
      value: z.number().optional(),
    })
  ),
  note: z.string(),
  quote: z.string(),
  relation: z
    .object({
      evidence: z.string(),
      kind: z.enum(LESSON_SCENE_RELATION_KINDS),
      label: z.string(),
    })
    .optional(),
  title: z.string(),
  type: z.enum(LESSON_SCENE_TYPES),
});

const PlaybackRangeSchema = z.object({
  start: z.number().int().nonnegative(),
  end: z.number().int().nonnegative(),
});

export const PlaybackPreparedSchema = z.object({
  scene: LessonSceneSchema.optional(),
  motion: z.array(
    z.object({
      effect: z.enum(['focus', 'reveal']),
      targets: z.array(z.string()),
      quote: z.string().min(1),
    })
  ),
});

export const PlaybackAudioSchema = z.object({
  model: z.string().min(1),
  voice: z.string().min(1),
  asset: ProjectAssetRefSchema,
  durationSeconds: z.number().positive(),
});

export const LessonPlaybackBlockSchema = z.object({
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
      z.object({ kind: z.literal('scene'), scene: LessonSceneSchema }),
    ])
  ),
  prepared: PlaybackPreparedSchema.optional(),
  audio: z.array(PlaybackAudioSchema),
});

export const LessonPlaybackSchema = z.object({
  version: z.literal(1),
  lessonKey: z.string().length(64),
  blocks: z.array(LessonPlaybackBlockSchema),
});

export const LessonPlaybackResponseSchema = LessonPlaybackSchema.omit({ version: true });
export const PrepareLessonPlaybackResponseSchema = z.union([
  z.object({ block: LessonPlaybackBlockSchema }),
  z.object({ runId: z.string().min(1), blockId: z.string().min(1), voice: z.string().min(1) }),
]);
