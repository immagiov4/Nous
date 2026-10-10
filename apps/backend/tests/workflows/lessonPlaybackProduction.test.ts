import { beforeEach, expect, test, vi } from 'vitest';

const { prepare } = vi.hoisted(() => ({ prepare: vi.fn() }));
vi.mock('../../src/services/lessonPlayback/prepareLessonPlaybackBlock.js', () => ({
  prepareLessonPlaybackBlock: prepare,
}));
vi.mock('../../src/config/modelConfig.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../../src/config/modelConfig.js')>()),
  getResolvedGlobalModelConfig: async () => ({}),
}));

import { createProductionLessonPlaybackServices } from '../../src/workflows/lessonPlaybackProduction.js';
import {
  playbackAsset,
  playbackProject,
  playbackResult,
  playbackSection,
  preparedPlayback,
} from '../helpers/lessonPlayback.js';

beforeEach(() => vi.clearAllMocks());
const setup = () => {
  const section = playbackSection();
  section.playback = preparedPlayback(section);
  const assets = {
    stage: vi.fn(async () => playbackAsset),
    adoptNodeAssets: vi.fn(async () => []),
  };
  const services = createProductionLessonPlaybackServices(assets, {
    loadProjectWithRevision: async () => ({
      snapshot: playbackProject(section),
      incarnationId: 'incarnation-1',
      revision: 1,
    }),
  });
  return {
    section,
    assets,
    services,
    context: {
      input: playbackResult(section).target,
      services,
      config: { maxAttempts: 3, timeoutMs: 60_000 },
      execution: { runId: 'run-1', nodeInstanceId: 'root/prepare-block' },
      idempotencyKey: 'preparation-1',
      attemptNumber: 1,
      retryFeedback: '',
      signal: new AbortController().signal,
      providerEffect: { run: async ({ operation }) => operation() },
    },
  };
};

test('reuses a block completed between the API cache read and the run starting', async () => {
  const { assets, services, context } = setup();
  const result = await services.preparePlayback(context);
  expect(result.block.audio[0]?.asset).toEqual(playbackAsset);
  expect(result.assetOwner).toBeUndefined();
  expect(prepare).not.toHaveBeenCalled();
  expect(assets.stage).not.toHaveBeenCalled();
});

test('passes saved scene and motion into another voice request and stages only its audio', async () => {
  const { section, assets, services, context } = setup();
  prepare.mockResolvedValue({
    prepared: { motion: [] },
    audio: {
      bytes: new Uint8Array([1]),
      mediaType: 'audio/mpeg',
      voice: 'Puck',
      model: 'tts-model',
      durationSeconds: 1,
    },
  });
  const result = await services.preparePlayback({
    ...context,
    input: { ...context.input, voice: 'Puck' },
  });
  expect(prepare).toHaveBeenCalledWith(
    expect.objectContaining({
      block: expect.objectContaining({ prepared: section.playback?.blocks[0]?.prepared }),
      ttsModel: 'tts-model',
      voice: 'Puck',
    })
  );
  expect(assets.stage).toHaveBeenCalledWith(
    expect.objectContaining({
      runId: 'run-1',
      nodeInstanceId: 'root/prepare-block',
      mediaType: 'audio/mpeg',
    })
  );
  expect(result.block.audio).toHaveLength(1);
  expect(result.block.audio[0]?.voice).toBe('Puck');
});

test.each([
  'incarnationId',
  'lessonKey',
] as const)('rejects changed %s before any provider or storage operation', async field => {
  const { services, context, assets } = setup();
  await expect(
    services.preparePlayback({ ...context, input: { ...context.input, [field]: 'stale' } })
  ).rejects.toThrow();
  expect(prepare).not.toHaveBeenCalled();
  expect(assets.stage).not.toHaveBeenCalled();
});
