import { LessonPlaybackBlockSchema } from '@shared/lessonPlaybackSchema';
import { readLessonPlayback } from '../../src/projects/lessonPlayback.js';
import type { LearningPlanNodeSnapshot, ProjectSnapshot } from '../../src/projects/types.js';
import type { LessonPlaybackResult } from '../../src/workflows/lessonPlaybackWorkflow.js';

export const playbackAsset = {
  id: 'a'.repeat(64),
  hash: 'b'.repeat(64),
  byteSize: 42,
  mediaType: 'audio/mpeg',
};
export const playbackSection = (): LearningPlanNodeSnapshot => ({
  id: 'section-1',
  kind: 'lesson',
  title: 'Tema',
  description: 'Descrizione',
  content: 'Prima frase.\n\nSeconda frase.',
  contentBlocks: [{ type: 'markdown', markdown: 'Prima frase.\n\nSeconda frase.' }],
  generatedVisuals: [],
  lastGenerationRunId: 'generation-1',
});
export const playbackProject = (section = playbackSection()): ProjectSnapshot => ({
  id: 'project-1',
  version: '1',
  createdAt: '2026-10-10T00:00:00.000Z',
  updatedAt: '2026-10-10T00:00:00.000Z',
  lastOpenedAt: '2026-10-10T00:00:00.000Z',
  learningPlan: { sections: [section] },
});
export const preparedPlayback = (section = playbackSection()) => {
  const playback = readLessonPlayback(section);
  return {
    ...playback,
    blocks: playback.blocks.map(block => ({
      ...block,
      prepared: { motion: [] },
      audio: [{ asset: playbackAsset, model: 'tts-model', voice: 'Kore', durationSeconds: 2 }],
    })),
  };
};
export const playbackResult = (section = playbackSection()): LessonPlaybackResult => {
  const playback = preparedPlayback(section);
  return {
    target: {
      projectId: 'project-1',
      sectionId: 'section-1',
      userId: 'local-user',
      incarnationId: 'incarnation-1',
      lessonKey: playback.lessonKey,
      blockId: '0',
      voice: 'Kore',
      model: 'tts-model',
    },
    block: LessonPlaybackBlockSchema.parse(playback.blocks[0]),
    assetOwner: 'root/prepare-block',
  };
};
