import type { LessonGenerationJobStage } from '@shared/generationJobContract';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { createApp } from '../../src/index.js';
import { setProjectStoreForTesting } from '../../src/projects/projectStore.js';
import type { ProjectSnapshot } from '../../src/projects/types.js';
import { setGenerationJobStoreForTests } from '../../src/services/generationJobService.js';
import type {
  EnqueueGenerationJobInput,
  GenerationJob,
  GenerationJobStore,
} from '../../src/services/generationJobs.js';
import { InMemoryProjectStore } from '../helpers/inMemoryProjectStore.js';

class QueuedGenerationJobStore implements GenerationJobStore {
  readonly jobs: GenerationJob[] = [];

  async enqueue(input: EnqueueGenerationJobInput) {
    const existing = this.jobs.find(
      job =>
        job.userId === input.userId &&
        (job.dedupeKey === input.dedupeKey ||
          (input.kind === 'lesson' &&
            job.kind === 'lesson' &&
            job.projectId === input.projectId)) &&
        (job.status === 'queued' || job.status === 'running' || job.status === 'completed')
    );
    if (existing) return { created: false, job: existing };
    const now = '2026-07-26T12:00:00.000Z';
    const job: GenerationJob = {
      attemptCount: 0,
      createdAt: now,
      dedupeKey: input.dedupeKey,
      id: input.id,
      kind: input.kind,
      payload: input.payload,
      projectId: input.projectId,
      stage: 'queued',
      status: 'queued',
      updatedAt: now,
      userId: input.userId,
    };
    this.jobs.push(job);
    return { created: true, job };
  }

  async getForUser(userId: string, id: string) {
    return this.jobs.find(job => job.userId === userId && job.id === id) ?? null;
  }

  async getLatestLessonForUser(userId: string, projectId: string, sectionId: string) {
    return (
      [...this.jobs]
        .reverse()
        .find(
          job =>
            job.userId === userId &&
            job.projectId === projectId &&
            job.kind === 'lesson' &&
            (job.payload as { sectionId?: string }).sectionId === sectionId
        ) ?? null
    );
  }

  async claimNext() {
    return null;
  }

  async complete() {}
  async fail() {}
  async recoverInterrupted() {}
  async requeue() {}
  async updateStage(id: string, stage: LessonGenerationJobStage) {
    const job = this.jobs.find(candidate => candidate.id === id);
    if (!job) throw new Error('Missing job');
    job.stage = stage;
  }
}

const createSnapshot = (): ProjectSnapshot => ({
  activeSectionId: 'lesson-1',
  createdAt: '2026-07-26T10:00:00.000Z',
  id: 'project-1',
  isLearnMode: true,
  lastOpenedAt: '2026-07-26T10:00:00.000Z',
  learningPlan: {
    modules: [
      {
        children: [
          { id: 'lesson-1', kind: 'lesson', title: 'Fotosintesi' },
          { id: 'lesson-2', kind: 'lesson', title: 'Respirazione' },
        ],
        id: 'module-1',
        title: 'Biologia',
      },
    ],
    title: 'Biologia',
  },
  source: null,
  sourceKind: 'learn-mode',
  updatedAt: '2026-07-26T10:00:00.000Z',
  version: '4.1',
});

describe('/api/generation-jobs', () => {
  const projectStore = new InMemoryProjectStore();
  const jobStore = new QueuedGenerationJobStore();

  beforeEach(async () => {
    setProjectStoreForTesting(projectStore);
    setGenerationJobStoreForTests(jobStore);
    jobStore.jobs.length = 0;
    await projectStore.saveProject('local-user', createSnapshot());
  });

  afterEach(() => {
    setProjectStoreForTesting(null);
    setGenerationJobStoreForTests(null);
  });

  test('atomically reuses an active image job for the same artifact request', async () => {
    const first = await request(createApp()).post('/api/generation-jobs/images').send({
      dedupeKey: 'artifact-1',
      projectId: 'project-1',
      prompt: 'Schema della fotosintesi',
    });
    const duplicate = await request(createApp()).post('/api/generation-jobs/images').send({
      dedupeKey: 'artifact-1',
      projectId: 'project-1',
      prompt: 'Schema della fotosintesi',
    });

    expect(first.status).toBe(202);
    expect(duplicate.status).toBe(200);
    expect(duplicate.body.job.id).toBe(first.body.job.id);
    expect(jobStore.jobs).toHaveLength(1);
  });

  test('returns a queued job by id and rejects unknown projects', async () => {
    const created = await request(createApp()).post('/api/generation-jobs/images').send({
      dedupeKey: 'artifact-2',
      projectId: 'project-1',
      prompt: 'Schema della respirazione',
    });
    const status = await request(createApp()).get(
      `/api/generation-jobs/${created.body.job.id as string}`
    );
    const missingProject = await request(createApp()).post('/api/generation-jobs/images').send({
      dedupeKey: 'artifact-3',
      projectId: 'missing',
      prompt: 'Schema',
    });

    expect(status.status).toBe(200);
    expect(status.headers['cache-control']).toBe('private, no-store');
    expect(status.body.job.status).toBe('queued');
    expect(missingProject.status).toBe(404);
  });

  test('allows only one active lesson generation for a project', async () => {
    const first = await request(createApp()).post('/api/generation-jobs/lessons').send({
      projectId: 'project-1',
      sectionId: 'lesson-1',
    });
    const duplicate = await request(createApp()).post('/api/generation-jobs/lessons').send({
      projectId: 'project-1',
      sectionId: 'lesson-1',
    });

    expect(first.status).toBe(202);
    expect(duplicate.status).toBe(200);
    expect(duplicate.body.job.id).toBe(first.body.job.id);
    expect(jobStore.jobs).toHaveLength(1);
  });

  test('rejects a different lesson while the project already has an active generation', async () => {
    const first = await request(createApp()).post('/api/generation-jobs/lessons').send({
      projectId: 'project-1',
      sectionId: 'lesson-1',
    });
    const competing = await request(createApp()).post('/api/generation-jobs/lessons').send({
      projectId: 'project-1',
      sectionId: 'lesson-2',
    });

    expect(first.status).toBe(202);
    expect(competing.status).toBe(409);
    expect(competing.body.job.id).toBe(first.body.job.id);
    expect(competing.body.error).toContain('altra lezione');
    expect(jobStore.jobs).toHaveLength(1);
  });

  test('returns the latest failed lesson job so a reconnect does not retry silently', async () => {
    const created = await request(createApp()).post('/api/generation-jobs/lessons').send({
      projectId: 'project-1',
      sectionId: 'lesson-1',
    });
    const stored = jobStore.jobs.find(job => job.id === created.body.job.id);
    if (!stored) throw new Error('Missing queued test job');
    stored.status = 'failed';
    stored.errorCode = 'lesson_provider_failed';

    const latest = await request(createApp()).get(
      '/api/generation-jobs/lessons/project-1/lesson-1/latest'
    );

    expect(latest.status).toBe(200);
    expect(latest.headers['cache-control']).toBe('private, no-store');
    expect(latest.body.job).toMatchObject({
      errorCode: 'lesson_provider_failed',
      id: created.body.job.id,
      status: 'failed',
    });
  });
});
