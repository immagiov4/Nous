import { resolvePlaybackNarration, segmentLessonPlayback } from '@shared/lessonPlayback';
import request from 'supertest';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { readLessonPlayback } from '../../src/projects/lessonPlayback.js';
import { setProjectStoreForTesting } from '../../src/projects/projectStore.js';
import type { WorkflowProviderEffectExecutor } from '../../src/workflows/types.js';
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
  const section = {
    ...playbackSection(),
    content: markdown,
    contentBlocks: [{ type: 'markdown' as const, markdown }],
  };
  const store = new InMemoryProjectStore();
  await store.saveProject('local-user', playbackProject(section));
  setProjectStoreForTesting(store);
  const reader = async () => {
    const response = await request(createApp())
      .post('/api/tts')
      .send({
        text: markdown,
        block,
        voice: 'Zephyr',
        target: { projectId: 'project-1', sectionId: 'section-1' },
      });
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

test('projects a multiline formula exactly once before either synthesis path', async () => {
  const source = 'Prima.\n\n$$\nx+y\n$$'.replaceAll('\\n', '\n');
  const block = segmentLessonPlayback([{ type: 'markdown', markdown: source }])[0];
  expect(block.spans.filter(span => span.math)).toHaveLength(1);
  await prepareSpeech({
    userId: 'local-user',
    block,
    config: getGlobalModelConfig(),
    signal: new AbortController().signal,
  });
  expect(JSON.parse(mocks.generate.mock.calls[0][0].prompt).formulas).toEqual([
    '$$\nx+y\n$$'.replaceAll('\\n', '\n'),
  ]);
});

test.each([
  'spoken-math',
  'narration',
])('records a cache hit durably across a model change: %s', async key => {
  const source =
    key === 'narration' ? 'Before.\n\n```text\nA pair has components.\n```\n\nThen $x$.' : markdown;
  const block = segmentLessonPlayback([{ type: 'markdown', markdown: source }])[0];
  if (key === 'narration')
    mocks.generate.mockImplementation(async ({ prompt }) => ({
      spokenMath: JSON.parse(prompt).formulas.map((formula: string) => ({
        formula,
        spoken: 'ics',
      })),
      fencedCode: JSON.parse(prompt).fencedCode.map(({ visualIndex }: { visualIndex: number }) => ({
        visualIndex,
        kind: 'prose',
        spoken: 'A pair has components.',
      })),
    }));
  const input = {
    userId: 'local-user',
    block,
    config: getGlobalModelConfig(),
    signal: new AbortController().signal,
  };
  const first = await prepareSpeech(input);
  const recorded = new Map<string, unknown>();
  const providerEffect: WorkflowProviderEffectExecutor = {
    run: async ({ key, operation, outputSchema }) => {
      if (!recorded.has(key)) recorded.set(key, await operation());
      return outputSchema.parse(recorded.get(key));
    },
  };
  await prepareSpeech({ ...input, providerEffect });
  expect(recorded.has(key)).toBe(true);
  mocks.generate.mockResolvedValue({
    spokenMath: block.spans.flatMap(span =>
      span.math ? [{ formula: span.math, spoken: 'changed reading' }] : []
    ),
  });
  const retried = await prepareSpeech({
    ...input,
    providerEffect,
    config: {
      ...input.config,
      aiProvider: 'openrouter',
      playbackPreparationModel: 'another-model',
    },
  });
  expect(retried.block.speech).toBe(first.block.speech);
  expect(mocks.generate).toHaveBeenCalledOnce();
});

test('rejects an oversized unscoped source block before paid preparation', async () => {
  const block = segmentLessonPlayback([
    { type: 'markdown', markdown: `${'word '.repeat(2500)}$x$` },
  ])[0];
  const response = await request(createApp()).post('/api/tts').send({ text: 'brief', block });
  expect(response.status).toBe(400);
  expect(mocks.generate).not.toHaveBeenCalled();
  expect(mocks.speech).not.toHaveBeenCalled();
});

test('listens to an owner-scoped long lesson without oversized provider calls', async () => {
  const longText = 'Una spiegazione matematica estesa. '.repeat(400);
  const section = {
    ...playbackSection(),
    content: longText,
    contentBlocks: [{ type: 'markdown' as const, markdown: longText }],
  };
  const block = readLessonPlayback(section).blocks[0];
  const store = new InMemoryProjectStore();
  await store.saveProject('local-user', playbackProject(section));
  setProjectStoreForTesting(store);
  mocks.speech.mockResolvedValue({
    audioBuffer: Uint8Array.from(
      Buffer.from('UklGRiYAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQIAAAAAAA==', 'base64')
    ).buffer,
    contentType: 'audio/wav',
    model: 'tts-model',
    voice: 'Zephyr',
  });
  const response = await request(createApp())
    .post('/api/tts')
    .send({ text: longText, block, target: { projectId: 'project-1', sectionId: 'section-1' } });
  expect(response.status).toBe(200);
  expect(response.headers['content-type']).toContain('audio/mpeg');
  expect(mocks.speech.mock.calls.length).toBeGreaterThan(1);
  expect(mocks.speech.mock.calls.every(([request]) => request.text.length <= 10_000)).toBe(true);
  expect(mocks.generate).not.toHaveBeenCalled();
});

test('rejects unscoped structured visual context before paid preparation', async () => {
  const source = `Consideriamo $x$.\n\n\`\`\`js\n${'long source '.repeat(1000)}\n\`\`\``.replaceAll(
    '\\n',
    '\n'
  );
  const block = segmentLessonPlayback([{ type: 'markdown', markdown: source }])[0];
  const response = await request(createApp()).post('/api/tts').send({ text: source, block });
  expect(response.status).toBe(400);
  expect(mocks.generate).not.toHaveBeenCalled();
  expect(mocks.speech).not.toHaveBeenCalled();
});
