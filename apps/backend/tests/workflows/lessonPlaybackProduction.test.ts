import assert from 'node:assert/strict';
import { getFormulaSpotlightLatex } from '@shared/formulaSpotlight';
import { type LessonScene, STATIC_LESSON_SCENE_TYPES } from '@shared/lessonScene';
import { beforeEach, expect, test, vi } from 'vitest';

const { prepare, prepareVisuals } = vi.hoisted(() => ({
  prepare: vi.fn(),
  prepareVisuals: vi.fn(),
}));
vi.mock(
  '../../src/services/lessonPlayback/prepareLessonPlaybackBlock.js',
  async importOriginal => ({
    ...(await importOriginal<
      typeof import('../../src/services/lessonPlayback/prepareLessonPlaybackBlock.js')
    >()),
    prepareLessonPlaybackBlock: prepare,
    prepareLessonPlaybackVisuals: prepareVisuals,
  })
);
vi.mock('../../src/config/modelConfig.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../../src/config/modelConfig.js')>()),
  getResolvedGlobalModelConfig: async () => ({}),
}));

import { createProductionLessonPlaybackServices } from '../../src/workflows/lessonPlaybackProduction.js';
import { guidedPathScene } from '../helpers/animatedLessonScenes';
import { dictatedFormulaSpotlight } from '../helpers/formulaSpotlight';
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
  const snapshot = playbackProject(section);
  const services = createProductionLessonPlaybackServices(assets, {
    loadProjectWithRevision: async () => ({
      snapshot,
      incarnationId: 'incarnation-1',
      revision: 1,
    }),
  });
  return {
    section,
    snapshot,
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

test.each([
  { visualOnly: false, native: false },
  { visualOnly: true, native: false },
  { visualOnly: true, native: true },
])('prepares only missing formula visuals while retaining the original audio and narration (%j)', async ({
  visualOnly,
  native,
}) => {
  const { section, assets, services, context } = setup();
  section.contentBlocks = [{ type: 'markdown', markdown: 'Prima $x+y$ dopo' }];
  section.content = 'Prima $x+y$ dopo';
  const playback = preparedPlayback(section);
  const saved = {
    ...playback.blocks[0],
    audio: playback.blocks[0].audio.map(audio => ({
      ...audio,
      wordAlignment: { status: 'aligned' as const, onsets: [0, 0.25, 0.5, 0.75, 1] },
    })),
    prepared: {
      motion: [],
      spokenMath: [{ formula: '$x+y$', spoken: 'ics più ipsilon' }],
      ...(native
        ? {
            scene: {
              ...dictatedFormulaSpotlight,
              symbols: dictatedFormulaSpotlight.symbols.map(symbol => ({ ...symbol, anchor: '' })),
            },
          }
        : {}),
    },
  };
  section.playback = { ...playback, blocks: [saved] };
  const formulaSpotlights = [
    {
      formula: native ? `$$${getFormulaSpotlightLatex(dictatedFormulaSpotlight)}$$` : '$x+y$',
      sourceFormula: native ? dictatedFormulaSpotlight.formula : '$x+y$',
      scene: dictatedFormulaSpotlight,
    },
  ];
  prepareVisuals.mockResolvedValue({ ...saved.prepared, formulaSpotlights });
  const result = await services.preparePlayback({
    ...context,
    input: {
      ...context.input,
      lessonKey: playback.lessonKey,
      ...(visualOnly ? { visualOnly: true } : {}),
    },
  });
  expect(result.block.audio).toEqual(saved.audio);
  expect(result.block.speech).toBe(saved.speech);
  expect(result.block.prepared).toEqual({ ...saved.prepared, formulaSpotlights });
  expect(result.assetOwner).toBeUndefined();
  expect(prepare).not.toHaveBeenCalled();
  expect(assets.stage).not.toHaveBeenCalled();
  expect(prepareVisuals).toHaveBeenCalledWith(
    expect.objectContaining({ block: saved, supportsFormulaSpotlights: true })
  );
});

test('reuses a block completed between the API cache read and the run starting', async () => {
  const { assets, services, context } = setup();
  const result = await services.preparePlayback(context);
  expect(result.block.audio[0]?.asset).toEqual(playbackAsset);
  expect(result.assetOwner).toBeUndefined();
  expect(prepare).not.toHaveBeenCalled();
  expect(assets.stage).not.toHaveBeenCalled();
});

test.each([
  false,
  true,
])('prepares a real scene for cached audio without another recording (historical formula contract: %s)', async historical => {
  const { section, assets, services, context } = setup();
  if (historical) {
    section.contentBlocks = [{ type: 'markdown', markdown: 'Prima $x+y$ dopo' }];
    section.content = 'Prima $x+y$ dopo';
    section.playback = preparedPlayback(section);
  }
  const playback = section.playback;
  assert(playback);
  const saved = playback.blocks[0];
  const scene: LessonScene = {
    type: 'steps',
    title: 'Accesso',
    body: '',
    quote: '',
    note: '',
    groups: [],
    items: [
      { label: 'DNS', detail: '', icon: '' },
      { label: 'Controller', detail: '', icon: '' },
    ],
  };
  prepareVisuals.mockImplementationOnce(async (input, force) =>
    force ? { scene, motion: [] } : input.block.prepared
  );
  const result = await services.preparePlayback(
    {
      ...context,
      input: { ...context.input, lessonKey: playback.lessonKey, visualOnly: true },
    },
    historical ? { supportsFormulaSpotlights: false } : undefined
  );
  expect(result.block.prepared).toEqual({ scene, motion: [] });
  expect(result.block.audio).toEqual(saved.audio);
  expect(result.assetOwner).toBeUndefined();
  expect(prepareVisuals).toHaveBeenCalledWith(
    expect.objectContaining({
      block: expect.objectContaining({ speech: saved.speech, visuals: [] }),
    }),
    true
  );
  expect(prepare).not.toHaveBeenCalled();
  expect(assets.stage).not.toHaveBeenCalled();
});

test('passes saved scene and motion into another voice request and stages only its audio', async () => {
  const { section, assets, services, context } = setup();
  const scene: LessonScene = {
    type: 'parts',
    title: 'Componenti',
    body: '',
    note: '',
    quote: '',
    groups: [],
    items: [
      { label: 'Confini', detail: '', icon: '' },
      { label: 'Interazioni', detail: '', icon: '' },
    ],
  };
  const savedPrepared = {
    scene,
    motion: [{ effect: 'focus' as const, targets: ['item:0', 'item:1'], quote: 'Prima frase.' }],
  };
  const playback = preparedPlayback(section);
  section.playback = {
    ...playback,
    blocks: playback.blocks.map(block => ({ ...block, prepared: savedPrepared })),
  };
  prepare.mockResolvedValue({
    prepared: savedPrepared,
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
      lesson: expect.objectContaining({ description: 'Descrizione' }),
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
  expect(result.block.prepared).toEqual(savedPrepared);
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

test.each([
  'ready',
  'new-voice',
])('rejects incompatible saved scenes on the %s path before provider or asset work', async state => {
  const { section, assets, services, context } = setup();
  const playback = preparedPlayback(section);
  section.playback = {
    ...playback,
    blocks: playback.blocks.map(block => ({
      ...block,
      prepared: { scene: guidedPathScene, motion: [] },
    })),
  };
  await expect(
    services.preparePlayback(
      {
        ...context,
        input: { ...context.input, ...(state === 'new-voice' ? { voice: 'Puck' } : {}) },
      },
      { allowedSceneTypes: STATIC_LESSON_SCENE_TYPES }
    )
  ).rejects.toMatchObject({
    failure: { code: 'lesson_playback_scene_invalid' },
  });
  expect(prepare).not.toHaveBeenCalled();
  expect(assets.stage).not.toHaveBeenCalled();
});

test('rejects legacy annotated input before resuming stored audio or scene provider effects', async () => {
  const markdown =
    'A system has <mark data-nous-annotation-id="note">boundaries</mark> and interactions.';
  const section = {
    ...playbackSection(),
    content: markdown,
    contentBlocks: [{ type: 'markdown' as const, markdown }],
  };
  const { assets, context } = setup();
  const services = createProductionLessonPlaybackServices(assets, {
    loadProjectWithRevision: async () => ({
      snapshot: playbackProject(section),
      incarnationId: 'incarnation-1',
      revision: 1,
    }),
  });
  const run = vi.fn().mockResolvedValue({
    scene: { type: 'quote', quote: 'old speech' },
    data: 'old audio',
  });
  await expect(
    services.preparePlayback({
      ...context,
      providerEffect: { run },
      input: {
        ...context.input,
        lessonKey: 'e8489e83fbb9ff282833c647795465b5ee95f5a75253ea899ae6d5667958652f',
      },
    })
  ).rejects.toMatchObject({ failure: { code: 'lesson_playback_stale' } });
  expect(run).not.toHaveBeenCalled();
  expect(prepare).not.toHaveBeenCalled();
  expect(assets.stage).not.toHaveBeenCalled();
});

test('reuses prepared playback after source replacement even when old source chunk IDs disappeared', async () => {
  const { section, assets, services, context } = setup();
  Object.assign(section, { primaryChunkIds: ['missing-old-source:chunk-001'] });
  const result = await services.preparePlayback(context);
  expect(result.block.audio[0]?.asset).toEqual(playbackAsset);
  expect(prepare).not.toHaveBeenCalled();
  expect(assets.stage).not.toHaveBeenCalled();
});

test('reuses ready audio despite malformed optional evidence metadata', async () => {
  const { snapshot, services, context, assets } = setup();
  snapshot.researchDossiersBySectionId = {
    [context.input.sectionId]: { evidencePacketJson: '{invalid' },
  };
  const result = await services.preparePlayback(context);
  expect(result.block.audio[0]?.asset).toEqual(playbackAsset);
  expect(prepare).not.toHaveBeenCalled();
  expect(assets.stage).not.toHaveBeenCalled();
});

test('prepares another voice when optional evidence metadata cannot be read', async () => {
  const { snapshot, services, context } = setup();
  snapshot.researchDossiersBySectionId = {
    [context.input.sectionId]: { evidencePacketJson: '{invalid' },
  };
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  prepare.mockResolvedValue({
    prepared: preparedPlayback(playbackSection()).blocks[0].prepared,
    audio: {
      bytes: new Uint8Array([1]),
      mediaType: 'audio/mpeg',
      voice: 'Puck',
      model: 'tts-model',
      durationSeconds: 1,
    },
  });
  try {
    await services.preparePlayback({ ...context, input: { ...context.input, voice: 'Puck' } });
    expect(prepare).toHaveBeenCalledWith(
      expect.objectContaining({
        lesson: expect.not.objectContaining({ sourceProvenance: expect.anything() }),
      })
    );
    expect(warn).toHaveBeenCalledOnce();
  } finally {
    warn.mockRestore();
  }
});
