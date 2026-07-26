import { describe, expect, test, vi } from 'vitest';

import type { GlobalModelConfig } from '../../src/config/modelConfig.js';
import type { GenerationJob } from '../../src/services/generationJobs.js';
import { createLessonGenerationHandler } from '../../src/services/lessonGenerationJob.js';
import { InMemoryProjectStore } from '../helpers/inMemoryProjectStore.js';

const snapshot = {
  activeSectionId: 'lesson-1',
  createdAt: '2026-07-26T10:00:00.000Z',
  documentIndex: {
    chunks: [
      { id: 'chunk-1', text: 'La fotosintesi converte energia luminosa.' },
      { id: 'chunk-2', text: 'Contesto non assegnato.' },
    ],
    kind: 'pdf-text-index',
  },
  id: 'project-1',
  isLearnMode: false,
  lastOpenedAt: '2026-07-26T10:00:00.000Z',
  learningPlan: {
    modules: [
      {
        children: [
          {
            description: 'Processo biologico',
            id: 'lesson-1',
            isCompleted: false,
            kind: 'lesson',
            primaryChunkIds: ['chunk-1'],
            title: 'Fotosintesi',
          },
        ],
        id: 'module-1',
        title: 'Biologia',
      },
    ],
    title: 'Biologia',
  },
  source: { kind: 'pdf' },
  sourceKind: 'document' as const,
  updatedAt: '2026-07-26T10:00:00.000Z',
  version: '4.1',
};

const job: GenerationJob = {
  attemptCount: 1,
  createdAt: '2026-07-26T12:00:00.000Z',
  dedupeKey: 'lesson:project-1:lesson-1',
  id: 'job-1',
  kind: 'lesson',
  payload: { projectId: 'project-1', sectionId: 'lesson-1' },
  projectId: 'project-1',
  stage: 'queued',
  status: 'running',
  updatedAt: '2026-07-26T12:00:00.000Z',
  userId: 'local-user',
};

describe('lesson generation job', () => {
  test('generates from explicitly mapped chunks and persists before completion', async () => {
    const store = new InMemoryProjectStore();
    await store.saveProject('local-user', snapshot);
    const generate = vi.fn(async () => ({
      contentBlocks: [
        { type: 'markdown', markdown: '## Energia\n\nLa fotosintesi converte la luce.' },
        {
          type: 'inline-quiz',
          quiz: {
            exerciseType: 'application-card',
            question: 'Che cosa cambia senza luce?',
            options: ['A', 'B', 'C', 'D'],
            correctIndex: 0,
          },
        },
      ],
    }));
    const run = createLessonGenerationHandler({
      generate,
      getConfig: async () => ({}) as GlobalModelConfig,
      store,
    });

    const result = await run(job, new AbortController().signal);
    const persisted = await store.loadProject('local-user', 'project-1');
    const lesson = persisted?.learningPlan?.modules?.[0]?.children?.[0];

    expect(generate).toHaveBeenCalledWith(
      expect.objectContaining({ sourceContext: 'La fotosintesi converte energia luminosa.' })
    );
    expect(lesson?.content).toContain('La fotosintesi converte la luce.');
    expect(lesson?.contentBlocks).toHaveLength(2);
    expect(result).toMatchObject({ projectId: 'project-1', sectionId: 'lesson-1' });
  });

  test('does not regenerate a lesson already completed by another request', async () => {
    const store = new InMemoryProjectStore();
    const completed = structuredClone(snapshot);
    const lesson = completed.learningPlan.modules[0]?.children[0];
    if (lesson) lesson.content = 'Persisted lesson';
    await store.saveProject('local-user', completed);
    const generate = vi.fn();
    const run = createLessonGenerationHandler({
      generate,
      getConfig: async () => ({}) as GlobalModelConfig,
      store,
    });

    const result = await run(job, new AbortController().signal);

    expect(generate).not.toHaveBeenCalled();
    expect(result).toMatchObject({ alreadyCompleted: true });
  });
});
