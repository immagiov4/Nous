import { resolvePlaybackNarration } from '@shared/lessonPlayback';
import { expect, test, vi } from 'vitest';
import { applyProjectPatch } from '../../src/projects/projectPatch.js';
import { createLessonPlaybackApi } from '../../src/workflows/lessonPlaybackApi.js';
import {
  buildRecordingAlignmentPatch,
  createRecordingAlignmentStarter,
} from '../../src/workflows/recordingAlignment.js';
import { createProductionRegistry } from '../../src/workflows/runtime/workflowRuntimeComposition.js';
import {
  playbackProject,
  playbackResult,
  playbackSection,
  preparedPlayback,
} from '../helpers/lessonPlayback.js';

test('returns a cached recording while alignment remains pending', async () => {
  const section = playbackSection();
  section.playback = preparedPlayback(section);
  const snapshot = playbackProject(section);
  let finish: (() => void) | undefined;
  const alignment = new Promise<void>(resolve => {
    finish = resolve;
  });
  const alignRecording = vi.fn(() => alignment);
  const createRun = vi.fn();
  const api = createLessonPlaybackApi({
    projectReader: {
      loadProjectWithRevision: async () => ({
        snapshot,
        revision: 1,
        incarnationId: 'incarnation-1',
      }),
    },
    registry: createProductionRegistry(),
    store: { createRun },
    resolveTtsModel: async () => 'tts-model',
    alignRecording,
  });
  const { target } = playbackResult(section);
  const result = await api.prepare(target);
  expect(result).toHaveProperty(
    'block.audio.0.asset.id',
    target && section.playback.blocks[0].audio[0].asset.id
  );
  expect(alignRecording).toHaveBeenCalledOnce();
  expect(createRun).not.toHaveBeenCalled();
  finish?.();
});

test('stores onsets only on the matching asset, preserving other voices and notes', () => {
  const section = playbackSection();
  section.playback = preparedPlayback(section);
  section.annotations = [{ id: 'note', text: 'Concurrent note' }];
  const first = section.playback.blocks[0];
  section.playback = {
    ...section.playback,
    blocks: [
      {
        ...first,
        audio: [
          ...first.audio,
          {
            ...first.audio[0],
            voice: 'Zephyr',
            asset: { ...first.audio[0].asset, id: 'c'.repeat(64) },
          },
        ],
      },
      ...section.playback.blocks.slice(1),
    ],
  };
  const snapshot = playbackProject(section);
  const { target } = playbackResult(section);
  const result = {
    target: { ...target, assetId: first.audio[0].asset.id },
    speech: resolvePlaybackNarration(first).speech,
    alignment: { status: 'aligned' as const, onsets: [0.1, 0.8] },
  };
  const locked = { snapshot, incarnationId: target.incarnationId, revision: 1 };
  const patch = buildRecordingAlignmentPatch(locked, result);
  expect(patch).not.toBeNull();
  const saved = applyProjectPatch(snapshot, patch ?? {}, snapshot.updatedAt);
  const updated = saved.learningPlan?.sections?.[0];
  expect(updated?.annotations).toEqual(section.annotations);
  expect(updated?.playback?.blocks[0].audio[0].wordAlignment).toEqual(result.alignment);
  expect(updated?.playback?.blocks[0].audio[1]).toEqual(section.playback.blocks[0].audio[1]);
  expect(buildRecordingAlignmentPatch({ ...locked, snapshot: saved }, result)).toBeNull();
  expect(
    buildRecordingAlignmentPatch({ ...locked, incarnationId: 'replacement' }, result)
  ).toBeNull();
  expect(
    buildRecordingAlignmentPatch(locked, { ...result, speech: 'different pronunciation' })
  ).toBeNull();
  expect(
    buildRecordingAlignmentPatch(locked, {
      ...result,
      target: { ...result.target, assetId: 'd'.repeat(64) },
    })
  ).toBeNull();
});

test('uses stable durable request identity and skips an already attempted recording', async () => {
  const createRun = vi.fn(async input => ({ created: true, run: { ...input, status: 'queued' } }));
  const start = createRecordingAlignmentStarter({
    registry: createProductionRegistry(),
    store: { createRun },
  });
  const { target, block } = playbackResult();
  await start(target, block);
  await start(Object.fromEntries(Object.entries(target).reverse()) as typeof target, block);
  expect(createRun).toHaveBeenCalledTimes(2);
  expect(createRun.mock.calls[0][0].requestKey).toBe(createRun.mock.calls[1][0].requestKey);
  await start(target, {
    ...block,
    audio: block.audio.map(audio => ({ ...audio, wordAlignment: { status: 'failed' } })),
  });
  expect(createRun).toHaveBeenCalledTimes(2);
});
