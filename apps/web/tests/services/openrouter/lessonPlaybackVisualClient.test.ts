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
