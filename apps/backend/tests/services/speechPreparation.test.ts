import { resolvePlaybackNarration, segmentLessonPlayback } from '@shared/lessonPlayback';
import request from 'supertest';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { readLessonPlayback } from '../../src/projects/lessonPlayback.js';
import { setProjectStoreForTesting } from '../../src/projects/projectStore.js';
import { InMemoryProjectStore } from '../helpers/inMemoryProjectStore.js';
import { playbackProject, playbackSection } from '../helpers/lessonPlayback.js';

const mocks = vi.hoisted(() => ({
  generate: vi.fn(),
  speech: vi.fn(),
  audio: vi.fn(),
  scene: vi.fn(),
  cached: new Map<string, unknown>(),
}));
vi.mock('../../src/services/structuredGeneration.js', () => ({
  generateStructuredOutput: mocks.generate,
}));
vi.mock('../../src/services/speechPreparationCache.js', () => ({
  speechPreparationCache: {
    resolve: async (
      owner: string,
      key: string,
      parse: (value: unknown) => unknown,
      prepare: () => Promise<unknown>
    ) => {
      const scoped = `${owner}:${key}`;
      if (!mocks.cached.has(scoped)) mocks.cached.set(scoped, await prepare());
      return parse(mocks.cached.get(scoped));
    },
  },
}));
vi.mock('../../src/services/ttsClient.js', () => ({
  DEFAULT_TTS_MODEL: 'test-tts',
  MAX_TTS_TEXT_CHARS: 10_000,
  ttsClient: { generateSpeech: mocks.speech, listModels: vi.fn() },
}));
vi.mock('../../src/services/lessonPlayback/playbackAudio.js', async original => ({
  ...(await original<typeof import('../../src/services/lessonPlayback/playbackAudio.js')>()),
  preparePlaybackAudio: mocks.audio,
}));
vi.mock('../../src/services/lessonScenes/lessonSceneGeneration.js', () => ({
  generateLessonScene: mocks.scene,
}));

import { getGlobalModelConfig, resetModelConfigForTesting } from '../../src/config/modelConfig.js';
import { createApp } from '../../src/index.js';
import { prepareLessonPlaybackBlock } from '../../src/services/lessonPlayback/prepareLessonPlaybackBlock.js';
import { prepareSpeech } from '../../src/services/speechPreparation.js';

const markdown = String.raw`Consideriamo $\mathcal{P}(A)$ e $f: A\to B$, con $$\sum_{i=1}^{n} i$$.`;
const normalize = (text: string) => text.replaceAll(/\s+/g, ' ').trim();
const expected = 'Consideriamo pi di a e effe da a in bi, con somma degli i.';

beforeEach(() => {
  vi.resetAllMocks();
  mocks.cached.clear();
  resetModelConfigForTesting();
  mocks.generate.mockImplementation(async ({ prompt }) => ({
    spokenMath: JSON.parse(prompt).formulas.map((formula: string) => ({
      formula,
      spoken: formula.includes('mathcal')
        ? 'pi di a'
        : formula.includes('sum')
          ? 'somma degli i'
          : 'effe da a in bi',
    })),
  }));
  mocks.speech.mockResolvedValue({
    audioBuffer: new Uint8Array([1, 2]).buffer,
    contentType: 'audio/wav',
  });
  mocks.audio.mockResolvedValue({
    bytes: new Uint8Array([1]),
    mediaType: 'audio/mpeg',
    durationSeconds: 1,
    model: 'test-tts',
    voice: 'Zephyr',
  });
});

test.each([
  'reader-first',
  'playback-first',
])('all speech consumers reuse exactly the same prepared math: %s', async order => {
  const block = segmentLessonPlayback([{ type: 'markdown', markdown }])[0];
  const input = {
    userId: 'local-user',
    block,
    config: getGlobalModelConfig(),
    signal: new AbortController().signal,
  };
  const reader = async () => {
    const response = await request(createApp())
      .post('/api/tts')
      .send({ text: markdown, block, voice: 'Zephyr' });
    expect(response.status).toBe(200);
  };
  const playback = async () =>
    prepareLessonPlaybackBlock({ ...input, lesson: { title: 'Insiemi' }, voice: 'Zephyr' });
  let result: Awaited<ReturnType<typeof playback>>;
  if (order === 'reader-first') {
    await reader();
    result = await playback();
  } else {
    result = await playback();
    await reader();
  }
  expect(mocks.generate).toHaveBeenCalledOnce();
  expect(mocks.speech.mock.calls[0][0].text).toBe(expected);
  expect(normalize(mocks.audio.mock.calls[0][0].text)).toBe(expected);
  expect(normalize(resolvePlaybackNarration({ ...block, prepared: result.prepared }).speech)).toBe(
    expected
  );
  expect((await prepareSpeech(input)).block.speech).toBe(
    resolvePlaybackNarration({ ...block, prepared: result.prepared }).speech
  );
  await prepareSpeech({ ...input, userId: 'another-user' });
  expect(mocks.generate).toHaveBeenCalledTimes(2);
});

test('keeps source mathematics intact and refreshes only a changed source or model', async () => {
  const block = segmentLessonPlayback([{ type: 'markdown', markdown }])[0];
  const input = {
    userId: 'local-user',
    block,
    config: getGlobalModelConfig(),
    signal: new AbortController().signal,
  };
  const first = await prepareSpeech(input);
  expect(block.spans.flatMap(span => (span.math ? [span.math] : []))).toEqual([
    String.raw`$\mathcal{P}(A)$`,
    String.raw`$f: A\to B$`,
    String.raw`$$\sum_{i=1}^{n} i$$`,
  ]);
  await prepareSpeech(input);
  expect(mocks.generate).toHaveBeenCalledOnce();
  await prepareSpeech({
    ...input,
    block: {
      ...block,
      speech: `Studiamo. ${block.speech}`,
      spans: block.spans.map(span => ({
        ...span,
        speech: { start: span.speech.start + 10, end: span.speech.end + 10 },
      })),
    },
  });
  expect(mocks.generate).toHaveBeenCalledTimes(2);
  await prepareSpeech({
    ...input,
    config: {
      ...input.config,
      aiProvider: 'openrouter',
      playbackPreparationModel: 'changed-preparation-model',
    },
  });
  expect(mocks.generate).toHaveBeenCalledTimes(3);
  const saved = { ...block, prepared: { ...first.narration, motion: [] } };
  expect((await prepareSpeech({ ...input, block: saved })).block.speech).toBe(first.block.speech);
  expect(mocks.generate).toHaveBeenCalledTimes(3);
});

test('does not synthesize after an invalid pronunciation or a cancelled preparation', async () => {
  mocks.generate.mockResolvedValue({ spokenMath: [] });
  const response = await request(createApp()).post('/api/tts').send({ text: markdown });
  expect(response.status).toBe(502);
  expect(mocks.speech).not.toHaveBeenCalled();
  const block = segmentLessonPlayback([{ type: 'markdown', markdown }])[0];
  await expect(
    prepareSpeech({
      userId: 'local-user',
      block,
      config: getGlobalModelConfig(),
      signal: AbortSignal.abort(),
    })
  ).rejects.toThrow();
});

afterEach(() => setProjectStoreForTesting(null));

test('standard listening reuses authoritative saved pronunciation, and rejects another owner or changed notation', async () => {
  const section: ReturnType<typeof playbackSection> = {
    ...playbackSection(),
    content: markdown,
    contentBlocks: [{ type: 'markdown' as const, markdown }],
  };
  const raw = readLessonPlayback(section);
  const source = raw.blocks[0];
  const saved = await prepareSpeech({
    userId: 'local-user',
    block: source,
    config: getGlobalModelConfig(),
    signal: new AbortController().signal,
  });
  section.playback = {
    ...raw,
    blocks: [{ ...source, prepared: { ...saved.narration, motion: [] } }],
  };
  const store = new InMemoryProjectStore();
  await store.saveProject('local-user', playbackProject(section));
  setProjectStoreForTesting(store);
  mocks.generate.mockClear();
  mocks.cached.clear();
  const target = { projectId: 'project-1', sectionId: 'section-1' };
  const response = await request(createApp())
    .post('/api/tts')
    .send({ text: markdown, block: source, target });
  expect(response.status).toBe(200);
  expect(mocks.speech.mock.calls.at(-1)[0].text).toBe(expected);
  expect(mocks.generate).not.toHaveBeenCalled();
  const changed = {
    ...source,
    spans: source.spans.map(span => (span.math ? { ...span, math: '$z$' } : span)),
  };
  expect(
    (await request(createApp()).post('/api/tts').send({ text: markdown, block: changed, target }))
      .status
  ).toBe(409);
  expect(
    (
      await request(createApp())
        .post('/api/tts')
        .send({
          text: markdown,
          block: source,
          target: { ...target, projectId: 'another-owner-project' },
        })
    ).status
  ).toBe(404);
  expect(mocks.speech).toHaveBeenCalledOnce();
});
