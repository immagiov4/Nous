import type {
  LessonPlaybackBlock,
  PlaybackMotionEvent,
  PlaybackVisual,
} from '@shared/lessonPlayback';
import { resolvePlaybackNarration, segmentLessonPlayback } from '@shared/lessonPlayback';
import { type LessonScene, STATIC_LESSON_SCENE_TYPES } from '@shared/lessonScene';
import type { ProjectLessonVisual } from '@shared/projectAsset';
import { beforeEach, expect, test, vi } from 'vitest';
import { discreteMathCases } from '../../helpers/discreteMath';

vi.mock('../../../src/services/speechPreparationCache.js', () => ({
  speechPreparationCache: {
    resolve: async (
      _owner: string,
      _key: string,
      _parse: unknown,
      prepare: () => Promise<unknown>
    ) => prepare(),
  },
}));

const { audio, sceneGeneration, motion, structured } = vi.hoisted(() => ({
  structured: vi.fn(),
  audio: vi.fn(),
  sceneGeneration: vi.fn(),
  motion: vi.fn(),
}));
vi.mock('../../../src/services/structuredGeneration.js', () => ({
  generateStructuredOutput: structured,
}));
vi.mock('../../../src/services/lessonPlayback/playbackAudio.js', async importOriginal => ({
  ...(await importOriginal<
    typeof import('../../../src/services/lessonPlayback/playbackAudio.js')
  >()),
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
import { MAX_TTS_TEXT_CHARS } from '../../../src/services/ttsClient.js';
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
  userId: 'speech-test-user',
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

test('waits for audio still in flight before a scene failure propagates', async () => {
  let finishAudio!: (value: typeof preparedAudio) => void;
  audio.mockReturnValue(
    new Promise(resolve => {
      finishAudio = resolve;
    })
  );
  sceneGeneration.mockRejectedValue(new Error('Scene unavailable'));
  let settled = false;
  const preparation = prepareLessonPlaybackBlock(input()).finally(() => {
    settled = true;
  });
  await vi.waitFor(() => expect(sceneGeneration).toHaveBeenCalled());
  await Promise.resolve();
  expect(settled).toBe(false);
  finishAudio(preparedAudio);
  await expect(preparation).rejects.toThrow('Scene unavailable');
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

test('grounds generated visuals in block speech without lesson-wide metadata', async () => {
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
    sectionTitle: '',
    sectionDescription: '',
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

test('continues after exactly three invalid scene attempts and propagates operational errors immediately', async () => {
  sceneGeneration.mockResolvedValue({ kind: 'invalid', problems: ['Invalid quotation.'] });
  await expect(prepareLessonPlaybackBlock(input())).resolves.toMatchObject({
    prepared: { motion: [] },
    audio: preparedAudio,
  });
  expect(sceneGeneration).toHaveBeenCalledTimes(3);
  sceneGeneration.mockReset().mockRejectedValue(new Error('Provider unavailable'));
  await expect(prepareLessonPlaybackBlock(input())).rejects.toThrow('Provider unavailable');
  expect(sceneGeneration).toHaveBeenCalledTimes(1);
});

test.each([
  'new',
  'existing-scene',
  'prepared',
])('rejects oversized %s speech before any provider work', async state => {
  const request = input();
  const run = vi.fn();
  await expect(
    prepareLessonPlaybackBlock({
      ...request,
      providerEffect: { run },
      block: {
        ...request.block,
        speech: 'a'.repeat(MAX_TTS_TEXT_CHARS + 1),
        visuals: state === 'existing-scene' ? [{ kind: 'scene', scene }] : [],
        ...(state === 'prepared' ? { prepared: { scene, motion: events } } : {}),
      },
    })
  ).rejects.toMatchObject({
    failure: { kind: 'permanent', code: 'lesson_playback_text_too_long' },
  });
  expect(run).not.toHaveBeenCalled();
  expect(sceneGeneration).not.toHaveBeenCalled();
  expect(motion).not.toHaveBeenCalled();
  expect(audio).not.toHaveBeenCalled();
});

test('accepts speech at the existing TTS request limit', async () => {
  const request = input();
  await expect(
    prepareLessonPlaybackBlock({
      ...request,
      block: { ...request.block, speech: 'a'.repeat(MAX_TTS_TEXT_CHARS) },
    })
  ).resolves.toMatchObject({ prepared: { scene }, audio: preparedAudio });
  expect(sceneGeneration).toHaveBeenCalledOnce();
  expect(audio).toHaveBeenCalledOnce();
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
  ).resolves.toEqual({ prepared: { motion: [] }, audio: preparedAudio });
  expect(motion).not.toHaveBeenCalled();
});

test('propagates cancellation before preparation', async () => {
  await expect(
    prepareLessonPlaybackBlock({ ...input(), signal: AbortSignal.abort() })
  ).rejects.toThrow();
  expect(sceneGeneration).not.toHaveBeenCalled();
  expect(audio).not.toHaveBeenCalled();
});

test.each([
  'inline',
  'stored',
  'prepared',
  'multiple',
])('rejects %s animated scenes in a resumed static contract before provider work', async location => {
  const stored = { ...storedScene, render: { kind: 'scene' as const, scene: guidedPathScene } };
  const inlineVisuals: PlaybackVisual[] = [
    { kind: 'scene', scene: guidedPathScene },
    ...(location === 'multiple' ? [{ kind: 'scene' as const, scene }] : []),
  ];
  const visuals: PlaybackVisual[] =
    location === 'stored' ? [{ kind: 'generated-visual', visualId: stored.id }] : inlineVisuals;
  const request = input(location === 'prepared' ? [] : visuals, [stored]);
  const run = vi.fn();
  await expect(
    prepareLessonPlaybackBlock({
      ...request,
      allowedSceneTypes: STATIC_LESSON_SCENE_TYPES,
      providerEffect: { run },
      block: {
        ...request.block,
        ...(location === 'prepared' ? { prepared: { scene: guidedPathScene, motion: [] } } : {}),
      },
    })
  ).rejects.toMatchObject({ failure: { code: 'lesson_playback_scene_invalid' } });
  expect(run).not.toHaveBeenCalled();
  expect(audio).not.toHaveBeenCalled();
  expect(sceneGeneration).not.toHaveBeenCalled();
  expect(motion).not.toHaveBeenCalled();
});

test('logs final bounded scene diagnostics while continuing playback', async () => {
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const diagnostic = {
    type: 'Error',
    originalMessage: JSON.stringify({
      outputPath: 'json-envelope',
      stage: 'schema',
      problems: [{ code: 'invalid_type', path: ['items', 0, 'parent'] }],
    }),
  };
  sceneGeneration.mockResolvedValue({
    kind: 'invalid',
    problems: ['Malformed scene.'],
    diagnostic,
  });
  try {
    await expect(prepareLessonPlaybackBlock(input())).resolves.toMatchObject({
      prepared: { motion: [] },
      audio: preparedAudio,
    });
    expect(warning).toHaveBeenCalledWith(expect.any(String), {
      diagnostic,
      retryFeedback: 'Malformed scene.',
    });
  } finally {
    warning.mockRestore();
  }
});

import { getPlaybackFormulaMarkdown, getPlaybackMathMarkdown } from '@shared/lessonPlayback';
import { FORMULA_SPOTLIGHT_MARKDOWN, formulaSpotlight } from '../../helpers/formulaSpotlight';

test('preparation asks the model to choose a form for the complete math passage', async () => {
  const mathBlock = segmentLessonPlayback([
    { type: 'markdown', markdown: FORMULA_SPOTLIGHT_MARKDOWN },
  ])[0];
  const spokenMath = [
    {
      formula: String.raw`$p_\theta(y\mid x)$`,
      spoken: 'pi con parametro theta di ipsilon dato ics',
    },
  ];
  structured.mockResolvedValue({ spokenMath });
  sceneGeneration.mockResolvedValue({ kind: 'scene', scene: formulaSpotlight });
  expect(await prepareLessonPlaybackBlock({ ...input(), block: mathBlock })).toMatchObject({
    prepared: { scene: formulaSpotlight, motion: [] },
  });
  expect(sceneGeneration).toHaveBeenCalledWith(
    expect.objectContaining({
      lessonMarkdown: expect.stringContaining(String.raw`p_\theta(y\mid x)`),
      narration: resolvePlaybackNarration(mathBlock, spokenMath).speech,
      allowTextFallback: true,
    })
  );
  expect(motion).not.toHaveBeenCalled();
  sceneGeneration.mockResolvedValue({ kind: 'text' });
  expect(await prepareLessonPlaybackBlock({ ...input(), block: mathBlock })).toMatchObject({
    prepared: { motion: [] },
  });
});

test('code containing math syntax retains its authored visual', async () => {
  const codeBlock = segmentLessonPlayback([
    { type: 'markdown', markdown: 'Leggi questo codice.\n\n```js\nconst price = "$x$";\n```' },
  ])[0];
  expect(getPlaybackMathMarkdown(codeBlock)).toBeUndefined();
  await prepareLessonPlaybackBlock({ ...input(), block: codeBlock });
  expect(sceneGeneration).not.toHaveBeenCalled();
});
test('prepares one shared spoken formula before TTS and preserves that paid result after an audio retry', async () => {
  const markdown = String.raw`Consideriamo $p_\theta(y\mid x)$. La probabilità descrive il risultato.`;
  const raw = segmentLessonPlayback([{ type: 'markdown', markdown }])[0];
  const spokenMath = [
    { formula: String.raw`$p_\theta(y\mid x)$`, spoken: 'p con parametro theta di y dato x' },
  ];
  structured.mockResolvedValue({ spokenMath });
  const recorded = new Map<string, unknown>();
  const providerEffect: WorkflowProviderEffectExecutor = {
    run: async ({ key, operation, outputSchema }) => {
      if (!recorded.has(key)) recorded.set(key, await operation());
      return outputSchema.parse(recorded.get(key));
    },
  };
  const request = { ...input(), block: raw, providerEffect };
  audio.mockRejectedValueOnce(new Error('Audio unavailable'));
  await expect(prepareLessonPlaybackBlock(request)).rejects.toThrow('Audio unavailable');
  const result = await prepareLessonPlaybackBlock(request);
  expect(audio).toHaveBeenLastCalledWith(
    expect.objectContaining({
      text: 'Consideriamo p con parametro theta di y dato x. La probabilità descrive il risultato.',
    })
  );
  expect(result.prepared).toMatchObject({ spokenMath });
  expect(structured).toHaveBeenCalledOnce();
  await prepareLessonPlaybackBlock({ ...request, block: { ...raw, prepared: result.prepared } });
  expect(structured).toHaveBeenCalledOnce();
});

test.each(
  discreteMathCases
)('sends complete $name pronunciation to TTS and reuses it for another voice', async fixture => {
  const block = segmentLessonPlayback([{ type: 'markdown', markdown: fixture.markdown }])[0];
  structured.mockResolvedValue({ spokenMath: fixture.spokenMath });
  const request = { ...input(), block };
  const result = await prepareLessonPlaybackBlock(request);
  const preparedBlock = { ...block, prepared: result.prepared };
  const narration = resolvePlaybackNarration(preparedBlock);
  expect(result.prepared.spokenMath).toEqual(fixture.spokenMath);
  expect(audio).toHaveBeenLastCalledWith(expect.objectContaining({ text: narration.speech }));
  expect(
    narration.spans
      .filter(span => span.math)
      .map(span => narration.speech.slice(span.speech.start, span.speech.end))
  ).toEqual(fixture.spokenMath.map(entry => entry.spoken));
  await prepareLessonPlaybackBlock({ ...request, block: preparedBlock, voice: 'Puck' });
  expect(structured).toHaveBeenCalledOnce();
  expect(audio).toHaveBeenLastCalledWith(
    expect.objectContaining({ text: narration.speech, voice: 'Puck' })
  );
});

test('retains legacy preparation without buying pronunciations when adding another voice', async () => {
  const block = segmentLessonPlayback([
    { type: 'markdown', markdown: 'Consideriamo $x$. Poi proseguiamo.' },
  ])[0];
  const prepared = { motion: [] };
  const result = await prepareLessonPlaybackBlock({
    ...input(),
    block: { ...block, prepared },
    voice: 'Puck',
  });
  expect(result.prepared).toBe(prepared);
  expect(structured).not.toHaveBeenCalled();
  expect(audio).toHaveBeenCalledWith(
    expect.objectContaining({ text: block.speech, voice: 'Puck' })
  );
});

test('carries identified transcription provenance to scene, spoken math and motion preparation', async () => {
  const sourceProvenance = {
    kind: 'vision-transcription' as const,
    sources: [{ title: 'Synthetic notes', transcribedPages: [7] }],
  };
  const request = input();
  const raw = {
    ...segmentLessonPlayback([{ type: 'markdown', markdown: 'Consideriamo $x$.' }])[0],
    visuals: [],
  };
  structured.mockResolvedValue({ spokenMath: [{ formula: '$x$', spoken: 'ics' }] });
  await prepareLessonPlaybackBlock({
    ...request,
    block: raw,
    lesson: { ...request.lesson, sourceProvenance },
  });
  expect(sceneGeneration.mock.calls[0][0]).toMatchObject({
    sourceProvenance,
    sectionDescription: '',
    sectionTitle: '',
  });
  expect(JSON.parse(structured.mock.calls[0][0].prompt).sourceProvenance).toEqual(sourceProvenance);
  expect(motion.mock.calls[0][0].sourceProvenance).toEqual(sourceProvenance);
});

test.each([
  {
    language: 'text',
    body: 'A vector is an ordered list. It has two entries.',
    kind: 'prose',
    spoken: 'A vector is an ordered list. It has two entries.',
  },
  { language: 'plaintext', body: '+---+\n| x |\n+---+', kind: 'code', spoken: '' },
  { language: '', body: 'INFO started\nERROR stopped', kind: 'code', spoken: '' },
])('classifies an ambiguous $language fence once before preparing narration: $kind', async fixture => {
  const markdown = `Introduction.\n\n\x60\x60\x60${fixture.language}\n${fixture.body}\n\x60\x60\x60\n\nContinue.`;
  const raw = segmentLessonPlayback([{ type: 'markdown', markdown }])[0];
  const fencedCode = [{ visualIndex: 0, kind: fixture.kind, spoken: fixture.spoken }];
  structured.mockResolvedValue({ spokenMath: [], fencedCode });
  const recorded = new Map<string, unknown>();
  const providerEffect: WorkflowProviderEffectExecutor = {
    run: async ({ key, operation, outputSchema }) => {
      if (!recorded.has(key)) recorded.set(key, await operation());
      return outputSchema.parse(recorded.get(key));
    },
  };
  const request = { ...input(), block: raw, providerEffect };
  const result = await prepareLessonPlaybackBlock(request);
  const resolved = resolvePlaybackNarration({ ...raw, prepared: result.prepared });
  expect(audio).toHaveBeenLastCalledWith(
    expect.objectContaining({
      text: fixture.kind === 'prose' ? `Introduction.\n${fixture.spoken}` : 'Introduction.',
    })
  );
  expect(resolved.visuals).toEqual([
    {
      kind: 'markdown',
      markdown:
        fixture.kind === 'prose'
          ? fixture.body
          : `\x60\x60\x60${fixture.language}\n${fixture.body}\n\x60\x60\x60`,
    },
  ]);
  expect(structured).toHaveBeenCalledOnce();
  await prepareLessonPlaybackBlock({
    ...request,
    block: { ...raw, prepared: result.prepared },
    voice: 'Puck',
  });
  expect(structured).toHaveBeenCalledOnce();
});

test('never classifies a fence with a programming language', async () => {
  const raw = segmentLessonPlayback([
    { type: 'markdown', markdown: 'Introduction.\n\n```python\nprint("hello")\n```' },
  ])[0];
  await prepareLessonPlaybackBlock({ ...input(), block: raw });
  expect(structured).not.toHaveBeenCalled();
  expect(audio).toHaveBeenCalledWith(expect.objectContaining({ text: 'Introduction.' }));
});

test('classifies a fenced introduction and pronounces display math in one recorded response', async () => {
  const markdown =
    'Before.\n\n## Topic\n\n```text\nA vector has components.\n```\n\n$$x = 2$$\n\nThen $x$ is the input.';
  const raw = segmentLessonPlayback([{ type: 'markdown', markdown }])[1];
  structured.mockResolvedValue({
    spokenMath: [
      { formula: '$$x = 2$$', spoken: 'ics uguale due' },
      { formula: '$x$', spoken: 'ics' },
    ],
    fencedCode: [{ visualIndex: 0, kind: 'prose', spoken: 'A vector has components.' }],
  });
  const result = await prepareLessonPlaybackBlock({ ...input(), block: raw });
  const resolved = resolvePlaybackNarration({ ...raw, prepared: result.prepared });
  expect(resolved.speech).toBe(
    'Topic\nA vector has components.\nics uguale due\nThen ics is the input.'
  );
  expect(audio).toHaveBeenCalledWith(expect.objectContaining({ text: resolved.speech }));
  expect(structured).toHaveBeenCalledOnce();
  expect(resolved.visuals).toEqual([
    { kind: 'markdown', markdown: 'A vector has components.' },
    { kind: 'markdown', markdown: '$$x = 2$$' },
    { kind: 'markdown', markdown: 'Then $x$ is the input.' },
  ]);
});

test.each([
  [],
  [{ visualIndex: 1, kind: 'prose', spoken: 'A vector has components.' }],
  [{ visualIndex: 0, kind: 'prose', spoken: '' }],
  [{ visualIndex: 0, kind: 'code', spoken: 'Invented narration' }],
])('rejects incomplete or inconsistent recorded fence decisions: %j', async fencedCode => {
  const raw = segmentLessonPlayback([
    { type: 'markdown', markdown: 'Before.\n\n```text\nA vector has components.\n```' },
  ])[0];
  structured.mockResolvedValue({ spokenMath: [], fencedCode });
  await expect(prepareLessonPlaybackBlock({ ...input(), block: raw })).rejects.toMatchObject({
    failure: { code: 'lesson_playback_spoken_math_invalid' },
  });
  expect(audio).not.toHaveBeenCalled();
});

test.each([
  '```text\nA vector has components.',
  '~~~plaintext\r\nA vector has components.\r\n~~~',
  '> ```text\n> A vector has components.\n> ```',
])('keeps complete source bodies for eligible fenced syntax: %j', async source => {
  const markdown = `Before.\n\n${source}\n\nAfter.`;
  const blocks = segmentLessonPlayback([{ type: 'markdown', markdown }]);
  const raw = blocks.find(block => block.spans.some(span => span.fencedCode));
  if (!raw) throw new Error('Expected a fenced occurrence.');
  structured.mockResolvedValue({
    spokenMath: [],
    fencedCode: [{ visualIndex: 0, kind: 'prose', spoken: 'A vector has components.' }],
  });
  const result = await prepareLessonPlaybackBlock({ ...input(), block: raw });
  expect(resolvePlaybackNarration({ ...raw, prepared: result.prepared }).speech).toContain(
    'A vector has components.'
  );
  const span = raw.spans.find(span => span.fencedCode);
  expect(markdown.slice(span?.source.start, span?.source.end)).toContain(
    'A vector has components.'
  );
});

test('classifies a final fenced introduction using the previous narrated passage as its anchor', async () => {
  const markdown = 'Before.\n\n## Topic\n\n```text\nA vector has components.\n```';
  const raw = segmentLessonPlayback([{ type: 'markdown', markdown }])[0];
  structured.mockResolvedValue({
    spokenMath: [],
    fencedCode: [{ visualIndex: 0, kind: 'prose', spoken: 'A vector has components.' }],
  });
  const result = await prepareLessonPlaybackBlock({ ...input(), block: raw });
  expect(resolvePlaybackNarration({ ...raw, prepared: result.prepared }).speech).toBe(
    'Before.\nTopic\nA vector has components.'
  );
});

test('uses sourced mathematics when corrective scene attempts cannot produce valid symbol links', async () => {
  const sources = [
    {
      type: 'markdown' as const,
      markdown: 'La formula è questa.\n\n$$x_i+y$$\n\nIl pedice i distingue le componenti.',
    },
  ];
  const mathBlock = segmentLessonPlayback(sources).find(block =>
    block.speech.includes('Il pedice')
  );
  if (!mathBlock) throw new Error('Explanation must be projected');
  sceneGeneration.mockResolvedValue({
    kind: 'invalid',
    problems: ['The symbol link does not cover its spoken element.'],
  });
  const result = await prepareLessonPlaybackBlock({
    ...input(),
    block: mathBlock,
    lesson: { title: '', sources },
  });
  expect(result.prepared.scene).toBeUndefined();
  expect(result.prepared.motion).toEqual([]);
  expect(result.audio.bytes).toEqual(preparedAudio.bytes);
});

test('prepares resumed nonempty-anchor contracts without requesting unlinked spotlight symbols', async () => {
  await prepareLessonPlaybackBlock({ ...input(), supportsUnlinkedFormulaSymbols: false });
  const request = sceneGeneration.mock.calls[0][0];
  expect(request.allowedSceneTypes).not.toContain('formula-spotlight');
  expect(request.allowedSceneTypes).toContain('parts');
});

test('rejects cached unlinked references before provider work under a frozen required-anchor contract', async () => {
  const request = input();
  const scene = {
    ...formulaSpotlight,
    symbols: formulaSpotlight.symbols.map(symbol => ({ ...symbol, anchor: '' })),
  };
  await expect(
    prepareLessonPlaybackBlock({
      ...request,
      supportsUnlinkedFormulaSymbols: false,
      block: { ...request.block, prepared: { scene, motion: [] } },
    })
  ).rejects.toMatchObject({ failure: { code: 'lesson_playback_scene_invalid' } });
  expect(sceneGeneration).not.toHaveBeenCalled();
  expect(audio).not.toHaveBeenCalled();
});

test('supplies the retained complete equation when the current passage names an inline subscript', async () => {
  const sources = [
    {
      type: 'markdown' as const,
      markdown:
        '# Formula\n\nLa formula è\n\n$$h_i=b_i+w_i x$$\n\nIl pedice $i$ identifica la componente.',
    },
  ];
  const block = segmentLessonPlayback(sources).find(candidate =>
    candidate.speech.includes('Il pedice')
  );
  if (!block) throw new Error('Explanation must be projected');
  structured.mockResolvedValue({ spokenMath: [{ formula: '$i$', spoken: 'i' }] });
  sceneGeneration.mockResolvedValue({ kind: 'text' });
  const request = input();
  await prepareLessonPlaybackBlock({ ...request, block, lesson: { ...request.lesson, sources } });
  expect(sceneGeneration).toHaveBeenCalledWith(
    expect.objectContaining({ lessonMarkdown: expect.stringContaining('h_i=b_i+w_i x') })
  );
});

test('reuses a degraded formula through saved preparation and regenerates it on request', async () => {
  const sources = [
    { type: 'markdown' as const, markdown: '$$x+y$$\n\nLa somma riunisce gli ingressi.' },
  ];
  const raw = segmentLessonPlayback(sources).at(-1);
  if (!raw) throw new Error('Expected a formula passage.');
  structured.mockResolvedValue({ spokenMath: [{ formula: '$$x+y$$', spoken: 'ics più ipsilon' }] });
  sceneGeneration.mockResolvedValue({
    kind: 'invalid',
    problems: ['Formula symbol anchors must be exact, unique and ordered in the narration.'],
  });
  const request = { ...input(), block: raw, lesson: { title: '', sources } };
  const result = await prepareLessonPlaybackBlock(request);
  expect(result.prepared.scene).toBeUndefined();
  expect(result.prepared.motion).toEqual([]);
  expect(result.audio.bytes).toEqual(preparedAudio.bytes);
  expect(sceneGeneration).toHaveBeenCalledTimes(3);
  expect(getPlaybackFormulaMarkdown(raw, sources)).toContain('x+y');
  await prepareLessonPlaybackBlock({
    ...request,
    block: { ...raw, prepared: JSON.parse(JSON.stringify(result.prepared)) },
  });
  expect(sceneGeneration).toHaveBeenCalledTimes(3);
  await prepareLessonPlaybackBlock(request);
  expect(sceneGeneration).toHaveBeenCalledTimes(6);
});
