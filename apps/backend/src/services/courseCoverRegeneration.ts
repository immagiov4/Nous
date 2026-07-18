import {
  buildCourseCoverDirectionUserPrompt,
  buildCourseCoverPrompt,
  COURSE_COVER_DIRECTION_JSON_SCHEMA,
  COURSE_COVER_DIRECTION_SYSTEM_PROMPT,
  COURSE_COVER_PROMPT_VERSION,
  type CourseCoverVisualDirection,
  formatCourseCoverVisualDirection,
} from '@shared/courseCoverPrompt';
import { generateText, jsonSchema, Output } from 'ai';

import {
  type AiProvider,
  type GlobalModelConfig,
  getResolvedModelConfigForProvider,
  resolveTextModelConfig,
} from '../config/modelConfig.js';
import { getProjectStore } from '../projects/projectStore.js';
import type { ProjectCoverFile, ProjectStore, SavedProjectMeta } from '../projects/types.js';
import { createEntityId } from '../utils/ids.js';
import { timestampIso } from '../utils/time.js';
import { createConfiguredTextModel } from './aiSdkTextModel.js';
import { runCodexAppServerTurn } from './codexAppServer.js';
import { imageClient } from './imageClient.js';

const MAX_CONCURRENT_COURSE_COVER_REGENERATIONS = 6;
const COURSE_COVER_PLANNER_TIMEOUT_MS = 90_000;
const COURSE_COVER_REGENERATION_FAILURE_MESSAGE = 'Course cover regeneration failed.';
const COURSE_COVER_JOB_FAILURE_MESSAGE = 'Course cover regeneration could not be started.';

type ScheduledOperation<T> = {
  operation: () => Promise<T>;
  reject: (error: unknown) => void;
  resolve: (result: T) => void;
};

const scheduledOperationsByUser = new Map<string, Array<ScheduledOperation<unknown>>>();
const scheduledUserOrder: string[] = [];
let activeScheduledOperations = 0;

const drainScheduledOperations = (): void => {
  while (
    activeScheduledOperations < MAX_CONCURRENT_COURSE_COVER_REGENERATIONS &&
    scheduledUserOrder.length > 0
  ) {
    const userId = scheduledUserOrder.shift();
    if (!userId) return;
    const queue = scheduledOperationsByUser.get(userId);
    const scheduled = queue?.shift();
    if (!queue || !scheduled) {
      scheduledOperationsByUser.delete(userId);
      continue;
    }

    if (queue.length > 0) scheduledUserOrder.push(userId);
    else scheduledOperationsByUser.delete(userId);

    activeScheduledOperations += 1;
    void scheduled
      .operation()
      .then(scheduled.resolve, scheduled.reject)
      .finally(() => {
        activeScheduledOperations -= 1;
        drainScheduledOperations();
      });
  }
};

const scheduleCourseCoverOperation = <T>(userId: string, operation: () => Promise<T>): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const queue = scheduledOperationsByUser.get(userId);
    const scheduled = { operation, reject, resolve } as ScheduledOperation<unknown>;
    if (queue) queue.push(scheduled);
    else {
      scheduledOperationsByUser.set(userId, [scheduled]);
      scheduledUserOrder.push(userId);
    }
    drainScheduledOperations();
  });

export type CourseCoverRegenerationResult =
  | {
      coverName: string;
      projectId: string;
      status: 'regenerated';
      title: string;
    }
  | {
      message: typeof COURSE_COVER_REGENERATION_FAILURE_MESSAGE;
      projectId: string;
      status: 'failed';
      title: string;
    };

export interface CourseCoverRegenerationJob {
  completedAt?: string;
  error?: typeof COURSE_COVER_JOB_FAILURE_MESSAGE;
  id: string;
  promptVersion: number;
  results: CourseCoverRegenerationResult[];
  startedAt: string;
  status: 'completed' | 'failed' | 'running';
  summary: {
    failed: number;
    pending: number;
    regenerated: number;
    skipped: number;
    total: number;
  };
  updatedAt: string;
}

interface MutableCourseCoverRegenerationJob extends CourseCoverRegenerationJob {
  completedAtEpochMs?: number;
  resultSlots: Array<CourseCoverRegenerationResult | undefined>;
}

const jobByUserAndPromptVersion = new Map<string, MutableCourseCoverRegenerationJob>();
const getJobKey = (userId: string): string => `${userId}:p${COURSE_COVER_PROMPT_VERSION}`;

const snapshotJob = (job: MutableCourseCoverRegenerationJob): CourseCoverRegenerationJob => ({
  ...(job.completedAt ? { completedAt: job.completedAt } : {}),
  ...(job.error ? { error: job.error } : {}),
  id: job.id,
  promptVersion: job.promptVersion,
  results: job.resultSlots.filter(
    (result): result is CourseCoverRegenerationResult => result !== undefined
  ),
  startedAt: job.startedAt,
  status: job.status,
  summary: { ...job.summary },
  updatedAt: job.updatedAt,
});

const readVisualDirection = (value: unknown): string | null => {
  if (!value || typeof value !== 'object') return null;
  const direction = value as Record<string, unknown>;
  return formatCourseCoverVisualDirection({
    dominantColor:
      typeof direction.dominantColor === 'string'
        ? (direction.dominantColor as CourseCoverVisualDirection['dominantColor'])
        : undefined,
    composition: typeof direction.composition === 'string' ? direction.composition : '',
    distinctiveDetails:
      typeof direction.distinctiveDetails === 'string' ? direction.distinctiveDetails : '',
    subject: typeof direction.subject === 'string' ? direction.subject : '',
  });
};

const planWithCodex = async (
  config: GlobalModelConfig,
  title: string,
  context: string
): Promise<string | null> => {
  const { model, reasoningEffort } = resolveTextModelConfig(config, 'assessment');
  const response = await runCodexAppServerTurn({
    developerInstructions: COURSE_COVER_DIRECTION_SYSTEM_PROMPT,
    input: [{ type: 'text', text: buildCourseCoverDirectionUserPrompt(title, context) }],
    model,
    outputSchema: COURSE_COVER_DIRECTION_JSON_SCHEMA,
    reasoningEffort,
  });
  return readVisualDirection(JSON.parse(response));
};

const planWithAiSdk = async (
  config: GlobalModelConfig,
  title: string,
  context: string
): Promise<string | null> => {
  const configuredModel = createConfiguredTextModel(config, 'assessment');
  const { output } = await generateText({
    abortSignal: AbortSignal.timeout(COURSE_COVER_PLANNER_TIMEOUT_MS),
    maxOutputTokens: 420,
    model: configuredModel.model,
    output: Output.object({
      name: 'course_cover_visual_direction',
      schema: jsonSchema<CourseCoverVisualDirection>({
        ...COURSE_COVER_DIRECTION_JSON_SCHEMA,
        required: [...COURSE_COVER_DIRECTION_JSON_SCHEMA.required],
      }),
    }),
    prompt: buildCourseCoverDirectionUserPrompt(title, context),
    providerOptions: configuredModel.providerOptions,
    system: COURSE_COVER_DIRECTION_SYSTEM_PROMPT,
  });
  return readVisualDirection(output);
};

const planCourseCoverVisualDirection = async (
  config: GlobalModelConfig,
  project: SavedProjectMeta
): Promise<string> => {
  const context = `Source: ${project.coverLabel}. Source kind: ${project.sourceKind}.`;
  const direction =
    config.aiProvider === 'codex'
      ? await planWithCodex(config, project.title, context)
      : await planWithAiSdk(config, project.title, context);
  if (!direction) throw new Error('Course cover visual direction is invalid.');
  return direction;
};

const resolveImageModel = (config: GlobalModelConfig): string => {
  if (config.aiProvider === 'codex') return config.codexArtifactModel;
  if (config.aiProvider === 'openai') return config.openAiImageModel;
  return config.imageModel;
};

const buildCoverFile = (projectId: string, dataUrl: string): ProjectCoverFile => {
  const match = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]+={0,2})$/u.exec(dataUrl);
  if (!match) throw new Error('Generated course cover is not a supported image data URL.');
  const mimeType = match[1];
  const extension = mimeType === 'image/jpeg' ? 'jpg' : mimeType.slice('image/'.length);
  return {
    data: match[2],
    mimeType,
    name: `${projectId}-cover-v${COURSE_COVER_PROMPT_VERSION}.${extension}`,
  };
};

const regenerateProjectCover = (
  config: GlobalModelConfig,
  project: SavedProjectMeta,
  store: ProjectStore,
  userId: string
): Promise<CourseCoverRegenerationResult> =>
  scheduleCourseCoverOperation(userId, async () => {
    try {
      const visualDirection = await planCourseCoverVisualDirection(config, project);
      const image = await imageClient.generateImage({
        model: resolveImageModel(config),
        prompt: buildCourseCoverPrompt(project.title, visualDirection),
        provider: config.aiProvider,
      });
      const cover = buildCoverFile(project.id, image.dataUrl);
      const saved = await store.saveProjectCover(userId, project.id, cover);
      if (!saved) throw new Error('Course no longer exists.');
      return {
        coverName: cover.name,
        projectId: project.id,
        status: 'regenerated',
        title: project.title,
      };
    } catch (error) {
      console.error('[Nous][CourseCover] Regeneration failed.', {
        error,
        projectId: project.id,
        userId,
      });
      return {
        message: COURSE_COVER_REGENERATION_FAILURE_MESSAGE,
        projectId: project.id,
        status: 'failed',
        title: project.title,
      };
    }
  });

const recordJobResult = (
  job: MutableCourseCoverRegenerationJob,
  index: number,
  result: CourseCoverRegenerationResult
): void => {
  job.resultSlots[index] = result;
  job.summary.pending -= 1;
  job.summary[result.status] += 1;
  job.updatedAt = timestampIso();
};

const completeJob = (
  job: MutableCourseCoverRegenerationJob,
  status: 'completed' | 'failed'
): void => {
  const completedAtEpochMs = Date.now();
  job.completedAtEpochMs = completedAtEpochMs;
  job.completedAt = new Date(completedAtEpochMs).toISOString();
  job.updatedAt = job.completedAt;
  job.status = status;
};

const runCourseCoverRegenerationJob = async (
  job: MutableCourseCoverRegenerationJob,
  userId: string,
  aiProvider?: AiProvider
): Promise<void> => {
  try {
    const store = getProjectStore();
    const [config, projects] = await Promise.all([
      getResolvedModelConfigForProvider(aiProvider),
      store.listProjects(userId),
    ]);
    job.resultSlots = Array.from({ length: projects.length });
    job.summary.total = projects.length;
    job.summary.pending = projects.length;
    job.updatedAt = timestampIso();

    await Promise.all(
      projects.map(async (project, index) => {
        const result = await regenerateProjectCover(config, project, store, userId);
        recordJobResult(job, index, result);
      })
    );
    completeJob(job, 'completed');
  } catch (error) {
    console.error('[Nous][CourseCover] Regeneration job setup failed.', { error, userId });
    job.error = COURSE_COVER_JOB_FAILURE_MESSAGE;
    completeJob(job, 'failed');
  }
};

export const startOrResumeCourseCoverRegeneration = (
  userId: string,
  aiProvider?: AiProvider
): CourseCoverRegenerationJob => {
  const jobKey = getJobKey(userId);
  const existingJob = jobByUserAndPromptVersion.get(jobKey);
  if (existingJob?.status === 'running') return snapshotJob(existingJob);

  const startedAt = timestampIso();
  const job: MutableCourseCoverRegenerationJob = {
    id: `course-cover-p${COURSE_COVER_PROMPT_VERSION}-${createEntityId('cover-job')}`,
    promptVersion: COURSE_COVER_PROMPT_VERSION,
    results: [],
    resultSlots: [],
    startedAt,
    status: 'running',
    summary: { failed: 0, pending: 0, regenerated: 0, skipped: 0, total: 0 },
    updatedAt: startedAt,
  };
  jobByUserAndPromptVersion.set(jobKey, job);
  void runCourseCoverRegenerationJob(job, userId, aiProvider);
  return snapshotJob(job);
};

export const getCourseCoverRegenerationStatus = (
  userId: string
): CourseCoverRegenerationJob | null => {
  const job = jobByUserAndPromptVersion.get(getJobKey(userId));
  return job ? snapshotJob(job) : null;
};
