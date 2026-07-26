import { afterEach, expect, test } from 'vitest';

import {
  setGenerationJobStoreForTests,
  waitForGenerationJob,
} from '../../src/services/generationJobService.js';
import type {
  EnqueueGenerationJobInput,
  GenerationJob,
  GenerationJobStore,
} from '../../src/services/generationJobs.js';

const activeJob: GenerationJob = {
  attemptCount: 1,
  createdAt: '2026-07-26T12:00:00.000Z',
  dedupeKey: 'lesson:project-1:lesson-1',
  id: 'job-1',
  kind: 'lesson',
  payload: { sectionId: 'lesson-1' },
  projectId: 'project-1',
  stage: 'running',
  status: 'running',
  updatedAt: '2026-07-26T12:00:00.000Z',
  userId: 'user-1',
};

afterEach(() => {
  setGenerationJobStoreForTests(null);
});

test('returns immediately when the observer disconnects during the initial job lookup', async () => {
  const controller = new AbortController();
  const store: GenerationJobStore = {
    claimNext: async () => null,
    complete: async () => {},
    enqueue: async (_input: EnqueueGenerationJobInput) => ({
      created: false,
      job: activeJob,
    }),
    fail: async () => {},
    getForUser: async () => {
      controller.abort();
      return activeJob;
    },
    getLatestLessonForUser: async () => activeJob,
    recoverInterrupted: async () => {},
    requeue: async () => {},
  };
  setGenerationJobStoreForTests(store);

  await expect(waitForGenerationJob('user-1', 'job-1', controller.signal)).resolves.toBeNull();
});
