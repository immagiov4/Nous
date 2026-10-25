import { segmentLessonPlayback } from '@shared/lessonPlayback';
import type { LessonScene } from '@shared/lessonScene';
import { beforeEach, expect, test, vi } from 'vitest';

const { get, prepare, wait } = vi.hoisted(() => ({
  get: vi.fn(),
  prepare: vi.fn(),
  wait: vi.fn(),
}));
vi.mock('../../../services/openrouter/lessonPlaybackClient.ts', () => ({
  getLessonPlayback: get,
  prepareLessonPlayback: prepare,
  waitForLessonPlayback: wait,
}));

import { prepareLessonPlaybackVisual } from '../../../services/openrouter/lessonPlaybackVisualClient.ts';

const block = segmentLessonPlayback([
  { type: 'markdown', markdown: 'DNS trova il controller. Il controller verifica le credenziali.' },
])[0];
const scene: LessonScene = {
  type: 'steps',
  title: 'Accesso al dominio',
  body: '',
  quote: '',
  note: '',
  groups: [],
  items: [
    { label: 'DNS', detail: 'Trovare il controller', icon: '' },
    { label: 'Controller', detail: 'Verificare le credenziali', icon: '' },
  ],
};
const prepared = {
  scene,
  motion: [
    {
      effect: 'reveal' as const,
      targets: ['item:1'],
      quote: 'Il controller verifica le credenziali.',
    },
  ],
};
const target = { projectId: 'project', sectionId: 'section', block, lessonKey: 'lesson-key' };

beforeEach(() => {
  vi.resetAllMocks();
  get.mockResolvedValue({ lessonKey: 'lesson-key', blocks: [block] });
});

test('shares visual-only work across consumers and returns the persisted scene and motion', async () => {
  prepare.mockResolvedValueOnce({ runId: 'run', created: true }).mockResolvedValueOnce({
    block: { ...block, prepared },
    voice: 'Zephyr',
    model: 'stored-model',
  });
  wait.mockResolvedValue(undefined);
  expect(
    await Promise.all([prepareLessonPlaybackVisual(target), prepareLessonPlaybackVisual(target)])
  ).toEqual([prepared, prepared]);
  expect(prepare.mock.calls.map(([request]) => request)).toEqual([
    {
      projectId: 'project',
      sectionId: 'section',
      lessonKey: 'lesson-key',
      blockId: block.id,
      voice: 'Zephyr',
      visualOnly: true,
    },
    {
      projectId: 'project',
      sectionId: 'section',
      lessonKey: 'lesson-key',
      blockId: block.id,
      voice: 'Zephyr',
      visualOnly: true,
    },
  ]);
  expect(wait.mock.calls.map(([runId, projectId]) => [runId, projectId])).toEqual([
    ['run', 'project'],
  ]);
});

test('continues its visual request after a joined audio failure releases the run', async () => {
  prepare.mockResolvedValueOnce({ runId: 'audio-run', created: false }).mockResolvedValueOnce({
    block: { ...block, prepared },
    voice: 'Zephyr',
    model: 'stored-model',
  });
  wait.mockImplementationOnce(async (_runId, _projectId, _signal, optionalPreparation) => {
    if (!optionalPreparation) throw new Error('Audio preparation failed');
  });
  await expect(prepareLessonPlaybackVisual(target)).resolves.toEqual(prepared);
  expect(wait).toHaveBeenCalledWith('audio-run', 'project', expect.any(AbortSignal), true);
  expect(prepare).toHaveBeenCalledTimes(2);
});

test('shares a pending failure and releases the entry for a later preparation', async () => {
  let failPreparation!: (error: Error) => void;
  const pendingPreparation = new Promise<never>((_resolve, reject) => {
    failPreparation = reject;
  });
  prepare.mockReturnValueOnce(pendingPreparation).mockResolvedValueOnce({
    block: { ...block, prepared },
    voice: 'Zephyr',
    model: 'stored-model',
  });
  const sharedResults = Promise.allSettled([
    prepareLessonPlaybackVisual(target),
    prepareLessonPlaybackVisual(target),
  ]);
  await vi.waitFor(() => expect(prepare).toHaveBeenCalledOnce());
  const failure = new Error('Visual preparation failed');
  failPreparation(failure);
  expect(await sharedResults).toEqual([
    { status: 'rejected', reason: failure },
    { status: 'rejected', reason: failure },
  ]);
  expect(prepare).toHaveBeenCalledOnce();
  await expect(prepareLessonPlaybackVisual(target)).resolves.toEqual(prepared);
  expect(prepare).toHaveBeenCalledTimes(2);
});

test.each([
  true,
  undefined,
])('surfaces its own visual failure without starting another paid attempt (%s)', async visualOnly => {
  prepare.mockResolvedValueOnce({ runId: 'visual-run', created: true, visualOnly });
  wait.mockImplementationOnce(async (_runId, _projectId, _signal, optionalPreparation) => {
    if (!optionalPreparation) throw new Error('Visual preparation failed');
  });
  await expect(prepareLessonPlaybackVisual(target)).rejects.toThrow('Visual preparation failed');
  expect(wait).toHaveBeenCalledWith('visual-run', 'project', expect.any(AbortSignal), false);
  expect(prepare).toHaveBeenCalledOnce();
});

test.each([
  'speech',
  'lesson-key',
])('rejects replaced %s before requesting a paid preparation', async changed => {
  get.mockResolvedValueOnce({
    lessonKey: changed === 'lesson-key' ? 'new-lesson' : 'lesson-key',
    blocks: [{ ...block, speech: changed === 'speech' ? 'Un’altra spiegazione.' : block.speech }],
  });
  await expect(prepareLessonPlaybackVisual(target)).rejects.toThrow(
    'Playback visual source changed.'
  );
  expect(prepare).not.toHaveBeenCalled();
});
