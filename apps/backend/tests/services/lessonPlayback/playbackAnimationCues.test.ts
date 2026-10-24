import type { LessonScene } from '@shared/lessonScene';
import { playbackMode } from '@shared/lessonSceneAnimation';
import { expect, test, vi } from 'vitest';
import { getGlobalModelConfig } from '../../../src/config/modelConfig.js';
import { resolvePlaybackAnimationCues } from '../../../src/services/lessonPlayback/playbackAnimationCues.js';
import { generateStructuredOutput } from '../../../src/services/structuredGeneration.js';

vi.mock('../../../src/services/structuredGeneration.js', () => ({
  generateStructuredOutput: vi.fn(),
}));
const scene = {
  type: 'guided-path',
  title: 'Percorso',
  body: 'Due tappe',
  items: [],
  groups: [],
  note: '',
  quote: '',
  autoplay: true,
  steps: [
    { label: 'Ingresso', detail: 'Riceve i dati' },
    { label: 'Uscita', detail: 'Restituisce il risultato' },
  ],
} as LessonScene;
const speech = 'Riceviamo i dati. Poi restituiamo il risultato.';
const input = () => ({
  scene,
  speech,
  config: getGlobalModelConfig(),
  signal: new AbortController().signal,
});
test('resolves semantic steps to exact ordered narration citations', async () => {
  vi.mocked(generateStructuredOutput).mockResolvedValue({
    cues: [
      { anchor: 'Riceviamo i dati.', value: 0 },
      { anchor: 'Poi restituiamo il risultato.', value: 1 },
    ],
  });
  const result = await resolvePlaybackAnimationCues(input());
  expect(result.type === 'guided-path' && result.steps.map(step => step.anchor)).toEqual([
    'Riceviamo i dati.',
    'Poi restituiamo il risultato.',
  ]);
});
test.each([
  { cues: [] },
  {
    cues: [
      { anchor: 'Inventato', value: 0 },
      { anchor: 'Poi restituiamo il risultato.', value: 1 },
    ],
  },
])('keeps an unresolvable animation static without inventing cue times', async ({ cues }) => {
  vi.mocked(generateStructuredOutput).mockResolvedValue({ cues });
  const result = await resolvePlaybackAnimationCues(input());
  expect(result.type === 'guided-path' && result.steps.map(step => step.anchor)).toEqual([
    undefined,
    undefined,
  ]);
});
test('reuses complete citations without provider work', async () => {
  vi.mocked(generateStructuredOutput).mockClear();
  const anchored = {
    ...scene,
    steps: [
      { label: 'Ingresso', detail: 'Dati', anchor: 'Riceviamo i dati.' },
      { label: 'Uscita', detail: 'Risultato', anchor: 'Poi restituiamo il risultato.' },
    ],
  } as LessonScene;
  expect(await resolvePlaybackAnimationCues({ ...input(), scene: anchored })).toBe(anchored);
  expect(generateStructuredOutput).not.toHaveBeenCalled();
});

test.each([
  null,
  { cues: 'invalid' },
  { cues: [{ anchor: 'Riceviamo i dati.', value: 0.5 }] },
])('keeps automatic animation after malformed cue output (%j)', async response => {
  vi.mocked(generateStructuredOutput).mockResolvedValue(response);
  const result = await resolvePlaybackAnimationCues(input());
  expect(result).toMatchObject({ type: 'guided-path', autoplay: true, steps: scene.steps });
  if (result.type !== 'guided-path') throw new Error('Expected guided path');
  expect(playbackMode(result)).toBe('automatic');
});

test('keeps automatic animation after cue generation fails', async () => {
  vi.mocked(generateStructuredOutput).mockRejectedValue(new Error('Malformed provider response'));
  const result = await resolvePlaybackAnimationCues(input());
  expect(result).toMatchObject({ type: 'guided-path', autoplay: true, steps: scene.steps });
  if (result.type !== 'guided-path') throw new Error('Expected guided path');
  expect(playbackMode(result)).toBe('automatic');
});

test('propagates cancellation instead of adopting automatic animation', async () => {
  const controller = new AbortController();
  const reason = new Error('Playback cancelled');
  vi.mocked(generateStructuredOutput).mockImplementation(async () => {
    controller.abort(reason);
    throw new Error('Provider cancelled');
  });
  await expect(
    resolvePlaybackAnimationCues({ ...input(), signal: controller.signal })
  ).rejects.toBe(reason);
});
