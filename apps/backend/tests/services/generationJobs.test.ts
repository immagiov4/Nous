import type { LessonGenerationJobStage } from '@shared/generationJobContract';
import { describe, expect, test, vi } from 'vitest';

import {
  type GenerationJob,
  GenerationJobRunner,
  type GenerationJobStore,
  TransientGenerationJobError,
} from '../../src/services/generationJobs.js';

const makeJob = (id: string): GenerationJob => ({
  attemptCount: 0,
  createdAt: new Date().toISOString(),
  dedupeKey: id,
  id,
  kind: 'lesson',
  payload: {},
  projectId: `project-${id}`,
  stage: 'queued',
  status: 'queued',
  updatedAt: new Date().toISOString(),
  userId: 'user-1',
});

class MemoryGenerationJobStore implements GenerationJobStore {
  readonly jobs: GenerationJob[];

  constructor(jobs: GenerationJob[]) {
    this.jobs = jobs;
  }

  async claimNext(): Promise<GenerationJob | null> {
    const job = this.jobs.find(candidate => candidate.status === 'queued');
    if (!job) return null;
    job.status = 'running';
    job.attemptCount += 1;
    return { ...job };
  }

  async complete(id: string, result: unknown): Promise<void> {
    const job = this.jobs.find(candidate => candidate.id === id);
    if (!job) throw new Error('Missing job');
    job.status = 'completed';
    job.result = result;
  }

  async enqueue(): Promise<{ created: boolean; job: GenerationJob }> {
    throw new Error('Not used');
  }

  async fail(id: string, errorCode: string): Promise<void> {
    const job = this.jobs.find(candidate => candidate.id === id);
    if (!job) throw new Error('Missing job');
    job.status = 'failed';
    job.errorCode = errorCode;
  }

  async getForUser(userId: string, id: string): Promise<GenerationJob | null> {
    return this.jobs.find(job => job.userId === userId && job.id === id) ?? null;
  }

  async getLatestLessonForUser(
    userId: string,
    projectId: string,
    sectionId: string
  ): Promise<GenerationJob | null> {
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

  async recoverInterrupted(): Promise<void> {}

  async requeue(id: string): Promise<void> {
    const job = this.jobs.find(candidate => candidate.id === id);
    if (!job) throw new Error('Missing job');
    job.status = 'queued';
  }

  async updateStage(id: string, stage: LessonGenerationJobStage): Promise<void> {
    const job = this.jobs.find(candidate => candidate.id === id);
    if (!job) throw new Error('Missing job');
    job.stage = stage;
  }
}

describe('GenerationJobRunner', () => {
  test('runs at most four generation jobs concurrently', async () => {
    const store = new MemoryGenerationJobStore(['1', '2', '3', '4', '5'].map(makeJob));
    const releases: Array<() => void> = [];
    let active = 0;
    let maximumActive = 0;
    const runner = new GenerationJobRunner({
      store,
      run: async () => {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await new Promise<void>(resolve => releases.push(resolve));
        active -= 1;
        return {};
      },
    });

    await runner.start();
    await vi.waitFor(() => expect(releases).toHaveLength(4));
    expect(maximumActive).toBe(4);

    releases.shift()?.();
    await vi.waitFor(() => expect(releases).toHaveLength(4));
    releases.splice(0).forEach(release => {
      release();
    });
    await vi.waitFor(() => expect(store.jobs.every(job => job.status === 'completed')).toBe(true));
  });

  test('retries a transient failure once and then completes', async () => {
    const store = new MemoryGenerationJobStore([makeJob('retry')]);
    const run = vi
      .fn()
      .mockRejectedValueOnce(new TransientGenerationJobError('provider_unavailable'))
      .mockResolvedValueOnce({ content: 'done' });
    const onSettled = vi.fn();
    const runner = new GenerationJobRunner({ onSettled, run, store });

    await runner.start();

    await vi.waitFor(() => expect(store.jobs[0]?.status).toBe('completed'));
    expect(run).toHaveBeenCalledTimes(2);
    expect(onSettled).toHaveBeenCalledTimes(1);
    expect(store.jobs[0]?.attemptCount).toBe(2);
  });

  test('records a terminal failure after the approved single retry', async () => {
    const store = new MemoryGenerationJobStore([makeJob('failed')]);
    const run = vi.fn(async () => {
      throw new TransientGenerationJobError('provider_unavailable');
    });
    const runner = new GenerationJobRunner({ run, store });

    await runner.start();

    await vi.waitFor(() => expect(store.jobs[0]?.status).toBe('failed'));
    expect(run).toHaveBeenCalledTimes(2);
    expect(store.jobs[0]?.errorCode).toBe('provider_unavailable');
  });
});
