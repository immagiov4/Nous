import request from 'supertest';
import { describe, expect, test, vi } from 'vitest';

import { createApp } from '../../src/index.js';
import { createLessonPlaybackApi } from '../../src/workflows/lessonPlaybackApi.js';
import { createProductionRegistry } from '../../src/workflows/runtime/workflowRuntimeComposition.js';
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
  test('GET merges segmentation with saved blocks and never starts preparation', async () => {
    const { app, section, createRun } = setup(true);
    section.playback = {
      ...preparedPlayback(section),
      blocks: preparedPlayback(section).blocks.slice(0, 1),
    };
    const response = await request(app).get(url);
    expect(response.status).toBe(200);
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
    expect(createRun).not.toHaveBeenCalled();
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
    expect(response.body).toEqual({ blockId: '0', voice: 'Zephyr', runId: expect.any(String) });
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
});
