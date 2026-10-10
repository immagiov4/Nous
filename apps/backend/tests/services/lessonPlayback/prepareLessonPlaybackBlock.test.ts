import { MAX_VISUAL_LESSON_CHARS } from '@shared/lessonGenerationPolicy';
import type {
  LessonPlaybackBlock,
  PlaybackMotionEvent,
  PlaybackVisual,
} from '@shared/lessonPlayback';
import type { LessonScene } from '@shared/lessonScene';
import type { ProjectLessonVisual } from '@shared/projectAsset';
import { beforeEach, expect, test, vi } from 'vitest';

const { audio, sceneGeneration, motion } = vi.hoisted(() => ({
  audio: vi.fn(),
  sceneGeneration: vi.fn(),
  motion: vi.fn(),
}));
vi.mock('../../../src/services/lessonPlayback/playbackAudio.js', () => ({
  preparePlaybackAudio: audio,
}));
vi.mock('../../../src/services/lessonScenes/lessonSceneGeneration.js', () => ({
  generateLessonScene: sceneGeneration,
}));
vi.mock('../../../src/services/lessonPlayback/playbackMotion.js', () => ({
  MAX_PLAYBACK_PREPARATION_ATTEMPTS: 3,
  planPlaybackMotion: motion,
}));

import { getGlobalModelConfig } from '../../../src/config/modelConfig.js';
import { prepareLessonPlaybackBlock } from '../../../src/services/lessonPlayback/prepareLessonPlaybackBlock.js';
import type { WorkflowProviderEffectExecutor } from '../../../src/workflows/types.js';
import { guidedPathScene, proportionalScene } from '../../helpers/animatedLessonScenes';

const scene: LessonScene = {
  type: 'parts',
  title: 'Parti',
  body: '',
  note: '',
  quote: '',
  groups: [],
  items: [
    { label: 'Confini', detail: '', icon: '' },
    { label: 'Interazioni', detail: '', icon: '' },
  ],
};
const preparedAudio = {
  bytes: new Uint8Array([1]),
  durationSeconds: 1,
  mediaType: 'audio/mpeg',
  model: 'tts-model',
  voice: 'Kore',
};
const events: readonly PlaybackMotionEvent[] = [
  { effect: 'focus', targets: ['item:0', 'item:1'], quote: 'Confini e interazioni.' },
];
const block = (visuals: readonly PlaybackVisual[] = []): LessonPlaybackBlock => ({
  id: '0',
  heading: 'Componenti',
  speech: 'Confini e interazioni.',
  spans: [],
  visuals,
  audio: [],
});
const storedScene: ProjectLessonVisual = {
  id: 'visual-1',
  slotId: 'slot-1',
  createdAt: '2026-10-10T00:00:00Z',
  render: { kind: 'scene', scene },
};
const input = (
  visuals: readonly PlaybackVisual[] = [],
  generatedVisuals: readonly ProjectLessonVisual[] = []
) => ({
  block: block(visuals),
  lesson: { title: 'Architettura', description: 'Sistemi', generatedVisuals },
  voice: 'Kore',
  config: getGlobalModelConfig(),
  signal: new AbortController().signal,
});

beforeEach(() => {
  vi.resetAllMocks();
  audio.mockResolvedValue(preparedAudio);
  sceneGeneration.mockResolvedValue({ kind: 'scene', scene });
  motion.mockResolvedValue(events);
});

test.each([
  proportionalScene,
  guidedPathScene,
])('prepares $type without planning motion events', async animated => {
  const request = input([{ kind: 'scene', scene: animated }]);
  expect(await prepareLessonPlaybackBlock(request)).toEqual({
    prepared: { scene: animated, motion: [] },
    audio: preparedAudio,
  });
  expect(motion).not.toHaveBeenCalled();
  const stored = { ...storedScene, render: { kind: 'scene' as const, scene: animated } };
  const recorded = new Map<string, unknown>();
  const providerEffect: WorkflowProviderEffectExecutor = {
    run: async ({ key, operation, outputSchema }) => {
      if (!recorded.has(key)) recorded.set(key, await operation());
      return outputSchema.parse(recorded.get(key));
    },
  };
  expect(
    await prepareLessonPlaybackBlock({
      ...input([{ kind: 'generated-visual', visualId: stored.id }], [stored]),
      providerEffect,
    })
  ).toMatchObject({ prepared: { scene: animated, motion: [] } });
  sceneGeneration.mockResolvedValueOnce({ kind: 'scene', scene: animated });
  expect(await prepareLessonPlaybackBlock(input())).toMatchObject({
    prepared: { scene: animated, motion: [] },
  });
  expect(motion).not.toHaveBeenCalled();
});

test('resumes recorded scene and motion after an audio failure without repeating their providers', async () => {
  const recorded = new Map<string, unknown>();
  const providerEffect: WorkflowProviderEffectExecutor = {
    run: async ({ key, operation, outputSchema }) => {
      if (!recorded.has(key)) recorded.set(key, await operation());
      return outputSchema.parse(recorded.get(key));
    },
  };
  audio.mockRejectedValueOnce(new Error('Audio unavailable'));
  const request = { ...input(), providerEffect, ttsModel: 'tts-model' };
  await expect(prepareLessonPlaybackBlock(request)).rejects.toThrow('Audio unavailable');
  const result = await prepareLessonPlaybackBlock(request);
  expect(result.prepared).toEqual({ scene, motion: events });
  expect([...result.audio.bytes]).toEqual([1]);
  expect(sceneGeneration).toHaveBeenCalledOnce();
  expect(motion).toHaveBeenCalledOnce();
  expect(audio).toHaveBeenCalledTimes(2);
  await prepareLessonPlaybackBlock(request);
  expect(audio).toHaveBeenCalledTimes(2);
});

test('keeps a paid scene when motion fails before it can be recorded', async () => {
  const recorded = new Map<string, unknown>();
  const providerEffect: WorkflowProviderEffectExecutor = {
    run: async ({ key, operation, outputSchema }) => {
      if (!recorded.has(key)) recorded.set(key, await operation());
      return outputSchema.parse(recorded.get(key));
    },
  };
  motion.mockRejectedValueOnce(new Error('Motion unavailable'));
  const request = { ...input(), providerEffect };
  await expect(prepareLessonPlaybackBlock(request)).rejects.toThrow('Motion unavailable');
  await expect(prepareLessonPlaybackBlock(request)).resolves.toMatchObject({ prepared: { scene } });
  expect(sceneGeneration).toHaveBeenCalledOnce();
  expect(motion).toHaveBeenCalledTimes(2);
});

test('generates from the complete block speech only when visuals are absent', async () => {
  const request = input();
  const snapshot = structuredClone(request.block);
  expect(await prepareLessonPlaybackBlock(request)).toEqual({
    prepared: { scene, motion: events },
    audio: preparedAudio,
  });
  expect(sceneGeneration).toHaveBeenCalledTimes(1);
  const sceneRequest = sceneGeneration.mock.calls[0][0];
  expect(sceneRequest).toMatchObject({
    lessonMarkdown: request.block.speech,
    sectionTitle: 'Componenti',
    signal: request.signal,
  });
  expect(sceneRequest.plan).toBeUndefined();
  expect(motion).toHaveBeenCalledWith({
    scene,
    speech: request.block.speech,
    config: request.config,
    signal: request.signal,
  });
  expect(audio).toHaveBeenCalledWith({
    text: request.block.speech,
    voice: request.voice,
    signal: request.signal,
  });
  expect(request.block).toEqual(snapshot);
});

test.each([
  { visuals: [{ kind: 'scene', scene }], stored: [] },
  { visuals: [{ kind: 'generated-visual', visualId: storedScene.id }], stored: [storedScene] },
  {
    visuals: [
      { kind: 'markdown', markdown: '| A | B |' },
      { kind: 'scene', scene },
    ],
    stored: [],
  },
] satisfies {
  visuals: PlaybackVisual[];
  stored: ProjectLessonVisual[];
}[])('reuses an existing scene with its own motion', async ({ visuals, stored }) => {
  const result = await prepareLessonPlaybackBlock(input(visuals, stored));
  expect(result).toEqual({ prepared: { scene, motion: events }, audio: preparedAudio });
  expect(sceneGeneration).not.toHaveBeenCalled();
  expect(motion).toHaveBeenCalledTimes(1);
  expect(audio).toHaveBeenCalledTimes(1);
});

test.each([
  { visuals: [{ kind: 'markdown', markdown: '| A | B |' }], stored: [] },
  { visuals: [{ kind: 'generated-visual', visualId: 'missing' }], stored: [] },
  {
    visuals: [{ kind: 'generated-visual', visualId: 'visual-1' }],
    stored: [{ ...storedScene, render: { kind: 'svg', code: '<svg />' } }],
  },
] satisfies {
  visuals: PlaybackVisual[];
  stored: ProjectLessonVisual[];
}[])('prepares audio without motion for visuals without scene data', async ({
  visuals,
  stored,
}) => {
  expect(await prepareLessonPlaybackBlock(input(visuals, stored))).toEqual({
    prepared: { motion: [] },
    audio: preparedAudio,
  });
  expect(sceneGeneration).not.toHaveBeenCalled();
  expect(motion).not.toHaveBeenCalled();
  expect(audio).toHaveBeenCalledTimes(1);
});

test('feeds scene validation problems into the corrective attempt', async () => {
  sceneGeneration.mockResolvedValueOnce({
    kind: 'invalid',
    problems: ['Evidence must match the source.'],
  });
  await expect(prepareLessonPlaybackBlock(input())).resolves.toMatchObject({ prepared: { scene } });
  expect(sceneGeneration).toHaveBeenCalledTimes(2);
  expect(sceneGeneration.mock.calls[1][0].retryFeedback).toBe('Evidence must match the source.');
});

test('reuses prepared visuals and motion when preparing another voice', async () => {
  const request = input();
  const prepared = { scene, motion: events };
  const result = await prepareLessonPlaybackBlock({
    ...request,
    block: { ...request.block, prepared },
    voice: 'Puck',
  });
  expect(result.prepared).toBe(prepared);
  expect(sceneGeneration).not.toHaveBeenCalled();
  expect(motion).not.toHaveBeenCalled();
  expect(audio).toHaveBeenCalledWith({
    text: request.block.speech,
    voice: 'Puck',
    signal: request.signal,
  });
});

test('exhausts exactly three scene attempts and propagates operational errors immediately', async () => {
  sceneGeneration.mockResolvedValue({ kind: 'invalid', problems: ['Invalid quotation.'] });
  await expect(prepareLessonPlaybackBlock(input())).rejects.toThrow(/scene preparation failed/);
  expect(sceneGeneration).toHaveBeenCalledTimes(3);
  sceneGeneration.mockReset().mockRejectedValue(new Error('Provider unavailable'));
  await expect(prepareLessonPlaybackBlock(input())).rejects.toThrow('Provider unavailable');
  expect(sceneGeneration).toHaveBeenCalledTimes(1);
});

test('rejects a block that would silently lose speech to the scene text cut', async () => {
  const request = input();
  await expect(
    prepareLessonPlaybackBlock({
      ...request,
      block: { ...request.block, speech: 'a'.repeat(MAX_VISUAL_LESSON_CHARS + 1) },
    })
  ).rejects.toThrow(/text limit/);
  expect(sceneGeneration).not.toHaveBeenCalled();
});

test('shows several scenes of one block without motion', async () => {
  await expect(
    prepareLessonPlaybackBlock(
      input(
        [
          { kind: 'scene', scene },
          { kind: 'generated-visual', visualId: storedScene.id },
        ],
        [storedScene]
      )
    )
  ).resolves.toBeDefined();
  expect(motion).not.toHaveBeenCalled();
});

test('propagates cancellation before preparation', async () => {
  await expect(
    prepareLessonPlaybackBlock({ ...input(), signal: AbortSignal.abort() })
  ).rejects.toThrow();
  expect(sceneGeneration).not.toHaveBeenCalled();
  expect(audio).not.toHaveBeenCalled();
});
