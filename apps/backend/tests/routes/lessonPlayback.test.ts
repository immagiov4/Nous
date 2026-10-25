import type { LessonScene } from '@shared/lessonScene';
import request from 'supertest';
import { describe, expect, test, vi } from 'vitest';

import { createApp } from '../../src/index.js';
import { ttsClient } from '../../src/services/ttsClient.js';
import { createLessonPlaybackApi } from '../../src/workflows/lessonPlaybackApi.js';
import { createProductionRegistry } from '../../src/workflows/runtime/workflowRuntimeComposition.js';
import { playbackProject, playbackSection, preparedPlayback } from '../helpers/lessonPlayback.js';

const url = '/api/projects/project-1/sections/section-1/playback';
const registry = createProductionRegistry();

test('identifies a joined visual run from its saved input when audio is requested', async () => {
  const { app, section, createRun } = setup();
  createRun.mockImplementationOnce(async input => ({
    created: false,
    run: { ...input, input: { ...input.input, visualOnly: true }, status: 'queued' },
  }));
  const response = await request(app)
    .post(`${url}/blocks/0/prepare`)
    .send({ lessonKey: preparedPlayback(section).lessonKey, voice: 'Kore' });
  expect(response.status).toBe(202);
  expect(response.body).toMatchObject({ created: false, visualOnly: true });
  expect(createRun.mock.calls[0][0].input.visualOnly).toBeUndefined();
});

test.each([
  'quote',
  'missing',
] as const)('queues a %s visual independently of cached audio and reuses its saved replacement', async type => {
  const { app, section, createRun } = setup(true);
  const original = preparedPlayback(section);
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
  section.playback = {
    ...original,
    blocks: original.blocks.map(block => ({
      ...block,
      prepared: {
        motion: [],
        ...(type === 'missing' ? {} : { scene: { ...scene, type, quote: block.speech } }),
      },
    })),
  };
  const requestVisual = () =>
    request(app)
      .post(`${url}/blocks/0/prepare`)
      .send({ lessonKey: original.lessonKey, voice: 'Kore', visualOnly: true });
  const queued = await requestVisual();
  expect(queued.status).toBe(202);
  expect(createRun.mock.calls[0][0].input).toMatchObject({
    visualOnly: true,
    blockId: '0',
    lessonKey: original.lessonKey,
  });
  section.playback = {
    ...original,
    blocks: original.blocks.map(block => ({ ...block, prepared: { scene, motion: [] } })),
  };
  const cached = await requestVisual();
  expect(cached.status).toBe(200);
  expect(cached.body.block.prepared.scene).toEqual(scene);
  expect(cached.body.block.audio).toEqual(original.blocks[0].audio);
  expect(createRun).toHaveBeenCalledTimes(1);
});
const setup = (ready = false, owner = 'local-user') => {
  const section = playbackSection();
  if (ready) section.playback = preparedPlayback(section);
  const projectReader = {
    loadProjectWithRevision: vi.fn(async (userId: string) =>
      userId === owner
        ? { snapshot: playbackProject(section), revision: 1, incarnationId: 'incarnation-1' }
        : null
    ),
  };
  const createRun = vi.fn(async input => ({ created: true, run: { ...input, status: 'queued' } }));
  const api = createLessonPlaybackApi({
    projectReader,
    registry,
    store: { createRun },
    resolveTtsModel: async () => 'tts-model',
  });
  return { app: createApp({ lessonPlaybackApi: api }), section, createRun, projectReader };
};

describe('lesson playback routes', () => {
  test('GET merges segmentation with saved blocks and never starts preparation', async () => {
    const { app, section, createRun } = setup(true);
    section.playback = {
      ...preparedPlayback(section),
      blocks: preparedPlayback(section).blocks.slice(0, 1),
    };
    const response = await request(app).get(url);
    expect(response.status).toBe(200);
    expect(response.headers['cache-control']).toBe('private, no-store');
    expect(response.body.blocks.map(block => block.speech)).toEqual([
      'Prima frase.',
      'Seconda frase.',
    ]);
    expect(response.body.blocks[0].audio).toHaveLength(1);
    expect(response.body.blocks[1].audio).toEqual([]);
    expect(createRun).not.toHaveBeenCalled();
  });
  test('returns 200 for the stored voice and model', async () => {
    const { app, section, createRun } = setup(true);
    const response = await request(app)
      .post(`${url}/blocks/0/prepare`)
      .send({ lessonKey: preparedPlayback(section).lessonKey, voice: 'Kore' });
    expect(response.status).toBe(200);
    expect(response.body.block.audio[0].voice).toBe('Kore');
    expect(response.body).toMatchObject({ voice: 'Kore', model: 'tts-model' });
    expect(createRun).not.toHaveBeenCalled();
  });
  test('returns the resolved voice and model when a stored profile is normalized', async () => {
    const voiceResolver = vi.spyOn(ttsClient, 'resolveVoice').mockReturnValue('Ara');
    try {
      const { app, section, createRun } = setup(true);
      const playback = preparedPlayback(section);
      section.playback = {
        ...playback,
        blocks: playback.blocks.map(block => ({
          ...block,
          audio: [...block.audio, { ...block.audio[0], voice: 'Ara' }],
        })),
      };
      const response = await request(app)
        .post(`${url}/blocks/0/prepare`)
        .send({ lessonKey: playback.lessonKey, voice: 'Kore' });
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ voice: 'Ara', model: 'tts-model' });
      expect(voiceResolver).toHaveBeenCalledWith('tts-model', 'Kore');
      expect(createRun).not.toHaveBeenCalled();
    } finally {
      voiceResolver.mockRestore();
    }
  });
  test.each([
    false,
    true,
  ])('returns 202 for uncached audio (existing preparation: %s)', async ready => {
    const { app, section, createRun } = setup(ready);
    const response = await request(app)
      .post(`${url}/blocks/0/prepare`)
      .send({ lessonKey: preparedPlayback(section).lessonKey, voice: 'Zephyr' });
    expect(response.status).toBe(202);
    expect(response.headers['cache-control']).toBe('private, no-store');
    expect(response.body).toEqual({
      blockId: '0',
      voice: 'Zephyr',
      runId: expect.any(String),
      created: true,
    });
    expect(createRun).toHaveBeenCalledOnce();
  });
  test('rejects a stale lesson key before starting a run', async () => {
    const { app, createRun } = setup();
    const response = await request(app)
      .post(`${url}/blocks/0/prepare`)
      .send({ lessonKey: 'f'.repeat(64), voice: 'Kore' });
    expect(response.status).toBe(409);
    expect(createRun).not.toHaveBeenCalled();
  });
  test('returns 404 for another owner on both routes', async () => {
    const { app, section, createRun, projectReader } = setup(false, 'other-user');
    expect((await request(app).get(url)).status).toBe(404);
    expect(
      (
        await request(app)
          .post(`${url}/blocks/0/prepare`)
          .send({ lessonKey: preparedPlayback(section).lessonKey, voice: 'Kore' })
      ).status
    ).toBe(404);
    expect(projectReader.loadProjectWithRevision).toHaveBeenCalledWith('local-user', 'project-1');
    expect(createRun).not.toHaveBeenCalled();
  });
  test('rejects unknown blocks and malformed prepare requests', async () => {
    const { app, section, createRun } = setup();
    expect(
      (
        await request(app)
          .post(`${url}/blocks/missing/prepare`)
          .send({ lessonKey: preparedPlayback(section).lessonKey, voice: 'Kore' })
      ).status
    ).toBe(404);
    expect(
      (await request(app).post(`${url}/blocks/0/prepare`).send({ lessonKey: 'x', voice: '' }))
        .status
    ).toBe(400);
    expect(createRun).not.toHaveBeenCalled();
  });

  test('rejects arbitrary voice values before loading projects or starting workflows', async () => {
    const { app, section, createRun, projectReader } = setup();
    const response = await request(app)
      .post(`${url}/blocks/0/prepare`)
      .send({ lessonKey: preparedPlayback(section).lessonKey, voice: 'unconfigured-voice' });
    expect(response.status).toBe(400);
    expect(projectReader.loadProjectWithRevision).not.toHaveBeenCalled();
    expect(createRun).not.toHaveBeenCalled();
  });

  test('deduplicates each block and separates blocks and lesson revisions', async () => {
    const { app, section, createRun } = setup();
    const originalKey = preparedPlayback(section).lessonKey;
    const prepare = (lessonKey: string, block = '0', voice = 'Kore') =>
      request(app).post(`${url}/blocks/${block}/prepare`).send({ lessonKey, voice });
    await prepare(originalKey);
    await prepare(originalKey, '1', 'Zephyr');
    expect(createRun.mock.calls[0][0].dedupeKey).not.toBe(createRun.mock.calls[1][0].dedupeKey);
    section.lastGenerationRunId = 'generation-2';
    await prepare(preparedPlayback(section).lessonKey);
    expect(createRun.mock.calls[2][0].dedupeKey).not.toBe(createRun.mock.calls[0][0].dedupeKey);
  });
});

test('different playback blocks have independent durable preparation keys', async () => {
  const { app, createRun } = setup();
  const lessonKey = preparedPlayback().lessonKey;
  const first = await request(app)
    .post(`${url}/blocks/0/prepare`)
    .send({ lessonKey, voice: 'Kore' });
  const second = await request(app)
    .post(`${url}/blocks/1/prepare`)
    .send({ lessonKey, voice: 'Kore' });
  expect(first.status).toBe(202);
  expect(second.status).toBe(202);
  expect(createRun.mock.calls[0][0].dedupeKey).not.toBe(createRun.mock.calls[1][0].dedupeKey);
});

test('voices of one block share canonical narration before another recording starts', async () => {
  const { app, createRun } = setup();
  const lessonKey = preparedPlayback().lessonKey;
  await request(app).post(`${url}/blocks/0/prepare`).send({ lessonKey, voice: 'Kore' });
  await request(app).post(`${url}/blocks/0/prepare`).send({ lessonKey, voice: 'Zephyr' });
  expect(createRun.mock.calls[0][0].dedupeKey).toBe(createRun.mock.calls[1][0].dedupeKey);
});

test('returns authoritative saved audio with a retriable visual-only list preparation', async () => {
  const { app, section, createRun } = setup();
  section.content = '1. First decision.\n2. Second decision.';
  section.contentBlocks = [{ type: 'markdown', markdown: section.content }];
  section.playback = preparedPlayback(section);
  const lessonKey = section.playback.lessonKey;
  const audio = await request(app)
    .post(`${url}/blocks/0/prepare`)
    .send({ lessonKey, voice: 'Kore' });
  expect(audio.status).toBe(200);
  expect(createRun).not.toHaveBeenCalled();
  const response = await request(app)
    .post(`${url}/blocks/0/prepare`)
    .send({ lessonKey, voice: 'Kore', visualOnly: true });
  expect(response.status).toBe(202);
  expect(response.body.recorded).toEqual({
    block: section.playback.blocks[0],
    voice: 'Kore',
    model: 'tts-model',
  });
  expect(createRun).toHaveBeenCalledOnce();
  await request(app)
    .post(`${url}/blocks/0/prepare`)
    .send({ lessonKey, voice: 'Kore', visualOnly: true });
  expect(createRun).toHaveBeenCalledTimes(2);
  const otherVoice = await request(app)
    .post(`${url}/blocks/0/prepare`)
    .send({ lessonKey, voice: 'Zephyr' });
  expect(otherVoice.body.recorded).toBeUndefined();
});
