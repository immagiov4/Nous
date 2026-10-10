import { motionTargets, type PlaybackMotionEvent } from '@shared/lessonPlayback';
import type { LessonScene } from '@shared/lessonScene';
import { beforeEach, expect, test, vi } from 'vitest';

const { generate } = vi.hoisted(() => ({ generate: vi.fn() }));
vi.mock('../../../src/services/structuredGeneration.js', () => ({
  generateStructuredOutput: generate,
}));

import { getGlobalModelConfig } from '../../../src/config/modelConfig.js';
import {
  planPlaybackMotion,
  validatePlaybackMotion,
} from '../../../src/services/lessonPlayback/playbackMotion.js';

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
const speech = 'I confini delimitano. Le interazioni collegano.';
const focus: PlaybackMotionEvent[] = [
  { effect: 'focus', targets: ['item:0'], quote: 'I confini delimitano.' },
  { effect: 'focus', targets: ['item:1'], quote: 'Le interazioni collegano.' },
];
const reveal = focus.map(event => ({ ...event, effect: 'reveal' as const }));
const input = () => ({
  scene,
  speech,
  config: getGlobalModelConfig(),
  signal: new AbortController().signal,
});
const response = (events: readonly PlaybackMotionEvent[]) => ({
  plans: [{ chunk: 0, events, reason: 'Collega le parti.' }],
});

beforeEach(() => vi.resetAllMocks());

test('accepts no motion, complete focus, shared focus and complete reveals in text order', () => {
  expect(validatePlaybackMotion([], scene, speech)).toEqual([]);
  expect(validatePlaybackMotion(focus, scene, speech)).toEqual(focus);
  const shared: PlaybackMotionEvent[] = [
    { effect: 'focus', targets: ['item:0', 'item:1'], quote: speech },
  ];
  expect(validatePlaybackMotion(shared, scene, speech)).toEqual(shared);
  expect(validatePlaybackMotion([...reveal].reverse(), scene, speech)).toEqual(reveal);
});

test.each([
  'checklist',
  'steps',
  'hypothesis',
  'timeline',
  'parts',
] as const)('accepts complete reveals for %s', type => {
  expect(validatePlaybackMotion(reveal, { ...scene, type }, speech)).toEqual(reveal);
});

test.each([
  { events: [{ ...focus[0], targets: ['item:9'] }], source: speech, expected: /Unknown/ },
  { events: focus, source: `${speech} ${speech}`, expected: /unique/ },
  {
    events: [{ ...focus[0], quote: 'i confini delimitano.' }, focus[1]],
    source: speech,
    expected: /exact/,
  },
  { events: [focus[0]], source: speech, expected: /every target/ },
  {
    events: [{ ...focus[0], targets: ['item:0', 'item:0'] }, focus[1]],
    source: speech,
    expected: /Duplicate/,
  },
  {
    events: [{ ...reveal[0], targets: ['item:0', 'item:1'] }],
    source: speech,
    expected: /one element/,
  },
  { events: [reveal[0]], source: speech, expected: /each target once/ },
  { events: [reveal[0], reveal[0]], source: speech, expected: /each target once/ },
  { events: [...focus, ...reveal], source: speech, expected: /each target once/ },
  { events: Array.from({ length: 25 }, () => focus[0]), source: speech, expected: /Invalid/ },
])('rejects invalid motion: $expected', ({ events, source, expected }) => {
  expect(() => validatePlaybackMotion(events, scene, source)).toThrow(expected);
});

test('rejects overlapping occurrences of an otherwise exact quote', () => {
  expect(() => validatePlaybackMotion([{ ...focus[0], quote: 'aaa' }], scene, 'aaaa')).toThrow(
    /unique/
  );
});

test.each([
  'checklist',
  'steps',
  'hypothesis',
  'timeline',
] as const)('lists %s reject focus', type => {
  expect(() => validatePlaybackMotion(focus, { ...scene, type }, speech)).toThrow(/Lists/);
});

test('comparisons remain visible and reject reveal', () => {
  const comparison: LessonScene = {
    ...scene,
    type: 'comparison',
    items: [],
    groups: [
      { label: 'A', items: ['Primo'], icons: [''] },
      { label: 'B', items: ['Secondo'], icons: [''] },
    ],
  };
  const events = reveal.map((event, index) => ({ ...event, targets: [`group:${index}`] }));
  expect(() => validatePlaybackMotion(events, comparison, speech)).toThrow(/Reveal is reserved/);
});

test('a single target cannot receive focus', () => {
  expect(() =>
    validatePlaybackMotion([focus[0]], { ...scene, items: scene.items.slice(0, 1) }, speech)
  ).toThrow(/meaningful selection/);
});

test('derives lab IDs for items, groups, matrix rows and diagram elements', () => {
  expect(motionTargets(scene)).toEqual([
    { id: 'item:0', label: 'Confini' },
    { id: 'item:1', label: 'Interazioni' },
  ]);
  const groups = [{ label: 'A', items: ['Primo', 'Secondo'], icons: ['', ''] }];
  expect(motionTargets({ ...scene, groups })).toEqual([
    { id: 'group:0', label: 'A · Primo · Secondo' },
  ]);
  expect(motionTargets({ ...scene, type: 'matrix', groups, criteria: ['Criterio'] })).toEqual([
    { id: 'row:0', label: 'Criterio' },
  ]);
  expect(motionTargets({ ...scene, type: 'matrix', groups })).toEqual([
    { id: 'row:0', label: 'Primo' },
    { id: 'row:1', label: 'Secondo' },
  ]);
  expect(
    motionTargets({
      ...scene,
      diagram: {
        nodes: [{ id: 'start', kind: 'start', label: 'Inizio' }],
        edges: [{ from: 'start', to: 'end', kind: 'call', label: '', evidence: '' }],
      },
    })
  ).toEqual([
    { id: 'node:start', label: 'Inizio' },
    { id: 'edge:0', label: 'start → end' },
  ]);
});

test('uses playbackPreparation structured output and corrects invalid coverage', async () => {
  generate.mockResolvedValueOnce(response([focus[0]])).mockResolvedValueOnce(response(focus));
  const result = await planPlaybackMotion(input());
  expect(result).toEqual(focus);
  expect(generate).toHaveBeenCalledTimes(2);
  expect(generate.mock.calls[0][0]).toMatchObject({
    slot: 'playbackPreparation',
    output: { name: 'playback_motion', schema: { type: 'object' } },
  });
  expect(JSON.parse(generate.mock.calls[0][0].prompt)).toEqual([
    { chunk: 0, type: scene.type, title: scene.title, text: speech, targets: motionTargets(scene) },
  ]);
  expect(generate.mock.calls[1][0].prompt).toContain('Focus must cover every target');
});

test.each([
  null,
  { plans: [] },
  { plans: [{ chunk: 1, events: [], reason: '' }] },
])('corrects malformed response %j', async malformed => {
  generate.mockResolvedValueOnce(malformed).mockResolvedValueOnce(response([]));
  await expect(planPlaybackMotion(input())).resolves.toEqual([]);
  expect(generate).toHaveBeenCalledTimes(2);
});

test('corrects parser errors but propagates transport errors', async () => {
  generate
    .mockRejectedValueOnce(new SyntaxError('Invalid JSON'))
    .mockResolvedValueOnce(response([]));
  await expect(planPlaybackMotion(input())).resolves.toEqual([]);
  generate.mockReset().mockRejectedValue(new Error('Provider unavailable'));
  await expect(planPlaybackMotion(input())).rejects.toThrow('Provider unavailable');
  expect(generate).toHaveBeenCalledTimes(1);
});

test('stops after the existing three-attempt scene policy', async () => {
  generate.mockResolvedValue(response([focus[0]]));
  await expect(planPlaybackMotion(input())).rejects.toThrow(/failed validation/);
  expect(generate).toHaveBeenCalledTimes(3);
});

test('keeps sequence scenes and scenes without targets static, as in the lab', async () => {
  await expect(
    planPlaybackMotion({ ...input(), scene: { ...scene, type: 'sequence' } })
  ).resolves.toEqual([]);
  await expect(
    planPlaybackMotion({ ...input(), scene: { ...scene, type: 'quote', items: [] } })
  ).resolves.toEqual([]);
  expect(generate).not.toHaveBeenCalled();
});

test('propagates cancellation without corrective retry', async () => {
  const controller = new AbortController();
  generate.mockImplementation(async () => {
    controller.abort();
    throw new SyntaxError('Interrupted');
  });
  await expect(planPlaybackMotion({ ...input(), signal: controller.signal })).rejects.toThrow();
  expect(generate).toHaveBeenCalledTimes(1);
});
