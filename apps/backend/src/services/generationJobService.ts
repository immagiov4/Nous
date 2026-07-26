import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';

import type { CurrentUser } from '../auth/currentUser.js';
import {
  getResolvedModelConfigForProvider,
  resolveAiProviderForSlot,
} from '../config/modelConfig.js';
import { PostgresGenerationJobStore } from '../projects/postgresGenerationJobStore.js';
import { isRecord } from '../utils/validation.js';
import {
  type EnqueueGenerationJobInput,
  type GenerationJob,
  GenerationJobRunner,
  type GenerationJobStore,
  TransientGenerationJobError,
} from './generationJobs.js';
import { imageClient } from './imageClient.js';
import { runLessonGenerationJob } from './lessonGenerationJob.js';

interface ImageGenerationJobPayload {
  aiProvider?: CurrentUser['aiProvider'];
  aiProviderOverrides?: CurrentUser['aiProviderOverrides'];
  prompt: string;
}

let generationJobStore: GenerationJobStore | null = null;
let generationJobRunner: GenerationJobRunner | null = null;
const generationJobEvents = new EventEmitter();

const getStore = (): GenerationJobStore => {
  generationJobStore ??= new PostgresGenerationJobStore();
  return generationJobStore;
};

const parseImagePayload = (value: unknown): ImageGenerationJobPayload => {
  if (!isRecord(value) || typeof value.prompt !== 'string' || !value.prompt.trim()) {
    throw new Error('Invalid image generation job payload.');
  }
  return {
    prompt: value.prompt,
    ...(typeof value.aiProvider === 'string'
      ? { aiProvider: value.aiProvider as CurrentUser['aiProvider'] }
      : {}),
    ...(isRecord(value.aiProviderOverrides)
      ? { aiProviderOverrides: value.aiProviderOverrides as CurrentUser['aiProviderOverrides'] }
      : {}),
  };
};

const runImageJob = async (job: GenerationJob, signal: AbortSignal): Promise<unknown> => {
  const payload = parseImagePayload(job.payload);
  try {
    const modelConfig = await getResolvedModelConfigForProvider(
      payload.aiProvider,
      payload.aiProviderOverrides
    );
    const provider = resolveAiProviderForSlot(modelConfig, 'image');
    let model = modelConfig.imageModel;
    if (provider === 'codex') {
      model = modelConfig.codexArtifactModel;
    } else if (provider === 'openai') {
      model = modelConfig.openAiImageModel;
    }
    return await imageClient.generateImage({
      model,
      prompt: payload.prompt,
      provider,
      signal,
    });
  } catch (error) {
    if (signal.aborted) throw error;
    throw new TransientGenerationJobError('image_provider_failed');
  }
};

const runGenerationJob = (job: GenerationJob, signal: AbortSignal): Promise<unknown> => {
  if (job.kind === 'image') return runImageJob(job, signal);
  return runLessonGenerationJob(job, signal);
};

const getRunner = (): GenerationJobRunner => {
  generationJobRunner ??= new GenerationJobRunner({
    onSettled: jobId => generationJobEvents.emit(jobId),
    run: runGenerationJob,
    store: getStore(),
  });
  return generationJobRunner;
};

export const enqueueGenerationJob = async (
  input: Omit<EnqueueGenerationJobInput, 'id'>
): Promise<{ created: boolean; job: GenerationJob }> => {
  const queued = await getStore().enqueue({ ...input, id: randomUUID() });
  getRunner().notify();
  return queued;
};

export const getGenerationJob = (userId: string, id: string): Promise<GenerationJob | null> =>
  getStore().getForUser(userId, id);

export const waitForGenerationJob = async (
  userId: string,
  id: string,
  signal: AbortSignal
): Promise<GenerationJob | null> => {
  const current = await getGenerationJob(userId, id);
  if (!current || current.status === 'completed' || current.status === 'failed') return current;

  return new Promise(resolve => {
    const cleanup = () => {
      generationJobEvents.off(id, onSettled);
      signal.removeEventListener('abort', onAbort);
    };
    const onAbort = () => {
      cleanup();
      resolve(null);
    };
    const onSettled = async () => {
      cleanup();
      resolve(await getGenerationJob(userId, id));
    };
    generationJobEvents.once(id, onSettled);
    signal.addEventListener('abort', onAbort, { once: true });
    void getGenerationJob(userId, id).then(latest => {
      if (latest?.status === 'completed' || latest?.status === 'failed') void onSettled();
    });
  });
};

export const startGenerationJobRunner = (): Promise<void> => getRunner().start();

export const setGenerationJobStoreForTests = (store: GenerationJobStore | null): void => {
  generationJobStore = store;
  generationJobRunner = null;
};
