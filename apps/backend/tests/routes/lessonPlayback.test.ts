import request from 'supertest';
import { describe, expect, test, vi } from 'vitest';
import { createApp } from '../../src/index.js';
import { ttsClient } from '../../src/services/ttsClient.js';
import { createLessonPlaybackApi } from '../../src/workflows/lessonPlaybackApi.js';
import { createProductionRegistry } from '../../src/workflows/runtime/workflowRuntimeComposition.js';
import { dictatedFormulaSpotlight } from '../helpers/formulaSpotlight';
import { playbackProject, playbackSection, preparedPlayback } from '../helpers/lessonPlayback.js';

const url = '/api/projects/project-1/sections/section-1/playback';
const registry = createProductionRegistry();
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
  test('prepares missing formula highlights for cached audio and reuses the saved result', async () => {
    const { app, section, createRun } = setup(true);
    section.contentBlocks = [{ type: 'markdown', markdown: 'Prima $x+y$ dopo' }];
    section.content = 'Prima $x+y$ dopo';
    const playback = preparedPlayback(section);
    const saved = playback.blocks[0];
    const prepared = { motion: [], spokenMath: [{ formula: '$x+y$', spoken: 'ics più ipsilon' }] };
    section.playback = { ...playback, blocks: [{ ...saved, prepared }] };
    const input = { lessonKey: playback.lessonKey, voice: 'Kore' };
    const first = await request(app).post(`${url}/blocks/0/prepare`).send(input);
    expect(first.status).toBe(202);
    expect(first.body).toMatchObject({ created: true, blockId: '0' });
    section.playback = {
      ...playback,
      blocks: [
        {
          ...saved,
          prepared: {
            ...prepared,
            formulaSpotlights: [
              { formula: '$x+y$', sourceFormula: '$x+y$', scene: dictatedFormulaSpotlight },
            ],
          },
        },
      ],
    };
    const second = await request(app).post(`${url}/blocks/0/prepare`).send(input);
    expect(second.status).toBe(200);
    expect(second.body.block.audio).toEqual(saved.audio);
    expect(second.body.block.prepared.formulaSpotlights[0].scene).toEqual(dictatedFormulaSpotlight);
    expect(createRun).toHaveBeenCalledTimes(1);
  });
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

test('prepares inherited reference links for cached audio and reuses a saved static decision', async () => {
  const { app, section, createRun } = setup(true);
  section.content = '# Tema\n\nIntroduzione alla formula.\n\n$$x+y$$\n\nics più ipsilon';
  section.contentBlocks = [{ type: 'markdown', markdown: section.content }];
  const playback = preparedPlayback(section);
  const saved = playback.blocks.at(-1);
  if (!saved) throw new Error('The reference passage must exist');
  section.playback = playback;
  const input = { lessonKey: playback.lessonKey, voice: 'Kore' };
  const target = `${url}/blocks/${saved.id}/prepare`;
  expect((await request(app).post(target).send(input)).status).toBe(202);
  const scene = {
    ...dictatedFormulaSpotlight,
    symbols: dictatedFormulaSpotlight.symbols.map(symbol => ({ ...symbol, anchor: '' })),
  };
  section.playback = {
    ...playback,
    blocks: playback.blocks.map(block =>
      block.id === saved.id
        ? {
            ...block,
            prepared: {
              ...block.prepared,
              motion: [],
              formulaSpotlights: [{ formula: '$$x+y$$', sourceFormula: '$$x+y$$', scene }],
            },
          }
        : block
    ),
  };
  const ready = await request(app).post(target).send(input);
  expect(ready.status).toBe(200);
  expect(ready.body.block.audio).toEqual(saved.audio);
  expect(createRun).toHaveBeenCalledOnce();
});
