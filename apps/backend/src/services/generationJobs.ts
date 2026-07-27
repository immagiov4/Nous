export type GenerationJobKind = 'image' | 'lesson';

import type {
  GenerationJobStage,
  GenerationJobStatus,
  LessonGenerationJobStage,
} from '@shared/generationJobContract';

export type { GenerationJobStatus } from '@shared/generationJobContract';

export type GenerationJobStageReporter = (stage: LessonGenerationJobStage) => Promise<void>;

export interface GenerationJob {
  attemptCount: number;
  completedAt?: string;
  createdAt: string;
  dedupeKey: string;
  errorCode?: string;
  id: string;
  kind: GenerationJobKind;
  payload: unknown;
  projectId: string;
  result?: unknown;
  stage: GenerationJobStage;
  startedAt?: string;
  status: GenerationJobStatus;
  updatedAt: string;
  userId: string;
}

export interface EnqueueGenerationJobInput {
  dedupeKey: string;
  id: string;
  kind: GenerationJobKind;
  payload: unknown;
  projectId: string;
  userId: string;
}

export interface GenerationJobStore {
  claimNext(): Promise<GenerationJob | null>;
  complete(id: string, result: unknown): Promise<void>;
  enqueue(input: EnqueueGenerationJobInput): Promise<{ created: boolean; job: GenerationJob }>;
  fail(id: string, errorCode: string): Promise<void>;
  getForUser(userId: string, id: string): Promise<GenerationJob | null>;
  getLatestLessonForUser(
    userId: string,
    projectId: string,
    sectionId: string
  ): Promise<GenerationJob | null>;
  recoverInterrupted(): Promise<void>;
  requeue(id: string): Promise<void>;
  updateStage(id: string, stage: LessonGenerationJobStage): Promise<void>;
}

export class TransientGenerationJobError extends Error {
  readonly code: string;

  constructor(code: string, message = code, options?: ErrorOptions) {
    super(message, options);
    this.name = 'TransientGenerationJobError';
    this.code = code;
  }
}

const DEFAULT_MAX_CONCURRENT_GENERATION_JOBS = 4;
const MAX_GENERATION_ATTEMPTS = 2;
const GENERATION_JOB_TIMEOUT_MS = 30 * 60 * 1_000;
const GENERATION_TIMEOUT_CODE = 'generation_timeout';
const GENERATION_FAILURE_CODE = 'generation_failed';

type RunGenerationJob = (job: GenerationJob, signal: AbortSignal) => Promise<unknown>;
type GenerationJobSettled = (jobId: string) => void;

const getErrorCode = (error: unknown): string => {
  if (error instanceof TransientGenerationJobError) return error.code;
  if (error instanceof Error && error.name === 'AbortError') return GENERATION_TIMEOUT_CODE;
  return GENERATION_FAILURE_CODE;
};

const describeError = (error: unknown): Record<string, unknown> => {
  if (!(error instanceof Error)) return { message: String(error), type: typeof error };
  const record = error as Error & { code?: unknown; details?: unknown; status?: unknown };
  const cause = error.cause;
  return {
    type: error.name,
    message: error.message,
    ...(typeof record.code === 'string' ? { code: record.code } : {}),
    ...(typeof record.status === 'number' ? { status: record.status } : {}),
    ...(typeof record.details === 'string' ? { details: record.details } : {}),
    ...(cause === undefined ? {} : { cause: describeError(cause) }),
  };
};

const getConfiguredConcurrency = (): number => {
  const configured = process.env.GENERATION_JOB_CONCURRENCY;
  if (configured === undefined) return DEFAULT_MAX_CONCURRENT_GENERATION_JOBS;
  const value = Number.parseInt(configured, 10);
  if (!Number.isSafeInteger(value) || value < 1 || String(value) !== configured.trim()) {
    throw new Error('GENERATION_JOB_CONCURRENCY must be a positive integer.');
  }
  return value;
};

const runWithDeadline = async (job: GenerationJob, run: RunGenerationJob): Promise<unknown> => {
  const controller = new AbortController();
  const remainingTime = Math.max(
    0,
    new Date(job.createdAt).getTime() + GENERATION_JOB_TIMEOUT_MS - Date.now()
  );
  const timeout = globalThis.setTimeout(() => controller.abort(), remainingTime);
  try {
    return await Promise.race([
      run(job, controller.signal),
      new Promise<never>((_, reject) => {
        controller.signal.addEventListener(
          'abort',
          () => reject(new DOMException('Generation job timed out.', 'AbortError')),
          { once: true }
        );
      }),
    ]);
  } finally {
    globalThis.clearTimeout(timeout);
  }
};

export class GenerationJobRunner {
  private activeJobs = 0;
  private drainScheduled = false;
  private draining = false;
  private readonly run: RunGenerationJob;
  private readonly onSettled?: GenerationJobSettled;
  private readonly store: GenerationJobStore;
  private readonly maxConcurrentJobs: number;

  constructor({
    onSettled,
    maxConcurrentJobs = getConfiguredConcurrency(),
    run,
    store,
  }: {
    onSettled?: GenerationJobSettled;
    maxConcurrentJobs?: number;
    run: RunGenerationJob;
    store: GenerationJobStore;
  }) {
    this.onSettled = onSettled;
    this.maxConcurrentJobs = maxConcurrentJobs;
    this.run = run;
    this.store = store;
  }

  async start(): Promise<void> {
    await this.store.recoverInterrupted();
    this.notify();
  }

  notify(): void {
    if (this.drainScheduled) return;
    this.drainScheduled = true;
    queueMicrotask(() => {
      this.drainScheduled = false;
      void this.drain();
    });
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.activeJobs < this.maxConcurrentJobs) {
        const job = await this.store.claimNext();
        if (!job) return;
        this.activeJobs += 1;
        void this.runClaimedJob(job).finally(() => {
          this.activeJobs -= 1;
          this.notify();
        });
      }
    } finally {
      this.draining = false;
    }
  }

  private async runClaimedJob(job: GenerationJob): Promise<void> {
    console.info('[Generation job] Started.', {
      attempt: job.attemptCount,
      jobId: job.id,
      kind: job.kind,
      stage: 'running',
    });
    try {
      const result = await runWithDeadline(job, this.run);
      await this.store.complete(job.id, result);
      console.info('[Generation job] Completed.', {
        attempt: job.attemptCount,
        jobId: job.id,
        kind: job.kind,
        stage: 'completed',
      });
      this.onSettled?.(job.id);
    } catch (error) {
      if (
        error instanceof TransientGenerationJobError &&
        job.attemptCount < MAX_GENERATION_ATTEMPTS
      ) {
        await this.store.requeue(job.id);
        console.warn('[Generation job] Retrying transient failure.', {
          attempt: job.attemptCount,
          error: describeError(error),
          errorCode: error.code,
          jobId: job.id,
          kind: job.kind,
          stage: 'queued',
        });
        return;
      }
      const errorCode = getErrorCode(error);
      await this.store.fail(job.id, errorCode);
      console.error('[Generation job] Failed.', {
        attempt: job.attemptCount,
        error: describeError(error),
        errorCode,
        jobId: job.id,
        kind: job.kind,
        stage: 'failed',
      });
      this.onSettled?.(job.id);
    }
  }
}
