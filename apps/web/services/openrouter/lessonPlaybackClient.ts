import {
  LessonPlaybackResponseSchema,
  PrepareLessonPlaybackResponseSchema,
} from '@shared/lessonPlaybackSchema';
import * as z from 'zod';
import { fetchWithSupabaseAuth } from '../auth/supabaseAuth.ts';
import { subscribeToProjectRevisionStream } from '../projects/projectRevisionStream.ts';
import { getBackendUrl } from './config.ts';
import {
  assertWorkflowPollResponse,
  isTransientWorkflowPollError,
  pollWorkflow,
  readWorkflowPollJson,
  retryTransientWorkflowRequest,
} from './workflowClientTransport.ts';

const PLAYBACK_ERROR = 'Impossibile preparare l’ascolto della lezione. Riprova.';
interface PlaybackTarget {
  projectId: string;
  sectionId: string;
}
const playbackUrl = (target: PlaybackTarget) =>
  `${getBackendUrl()}/api/projects/${encodeURIComponent(target.projectId)}/sections/${encodeURIComponent(target.sectionId)}/playback`;

export class LessonPlaybackRequestError extends Error {
  constructor(readonly status: number) {
    super(PLAYBACK_ERROR);
    this.name = 'LessonPlaybackRequestError';
  }
}

export const getLessonPlayback = async (target: PlaybackTarget, signal?: AbortSignal) => {
  const response = await fetchWithSupabaseAuth(playbackUrl(target), { cache: 'no-store', signal });
  if (!response.ok) throw new LessonPlaybackRequestError(response.status);
  const parsed = LessonPlaybackResponseSchema.safeParse(
    await readWorkflowPollJson(response, PLAYBACK_ERROR)
  );
  if (!parsed.success) throw new Error(PLAYBACK_ERROR);
  return parsed.data;
};

export const prepareLessonPlayback = async (
  target: PlaybackTarget & {
    blockId: string;
    lessonKey: string;
    voice: string;
    visualOnly?: boolean;
  },
  signal?: AbortSignal
) => {
  const response = await fetchWithSupabaseAuth(
    `${playbackUrl(target)}/blocks/${encodeURIComponent(target.blockId)}/prepare`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        lessonKey: target.lessonKey,
        voice: target.voice,
        ...(target.visualOnly ? { visualOnly: true } : {}),
      }),
      signal,
    }
  );
  if (!response.ok) throw new LessonPlaybackRequestError(response.status);
  const parsed = PrepareLessonPlaybackResponseSchema.safeParse(
    await readWorkflowPollJson(response, PLAYBACK_ERROR)
  );
  if (!parsed.success) throw new Error(PLAYBACK_ERROR);
  return parsed.data;
};

const PlaybackRunSchema = z.object({
  success: z.literal(true),
  state: z.object({
    run: z.object({
      id: z.string(),
      projectId: z.string(),
      workflowId: z.literal('prepare-lesson-playback-block'),
      status: z.string(),
      cleanupStatus: z.string(),
    }),
  }),
});

export const subscribeToPlaybackChanges = (projectId: string, notify: () => void) =>
  subscribeToProjectRevisionStream({
    url: `${getBackendUrl()}/api/projects/events`,
    listener: event => {
      if (event.projectId === projectId) notify();
    },
    onCatchUp: notify,
  });

/** Wait until preparation completes or releases its active block key. */
export const waitForLessonPlayback = async (
  runId: string,
  projectId: string,
  signal: AbortSignal,
  optionalVisual = false
) => {
  let changed = false;
  let wake: (() => void) | undefined;
  const notify = () => {
    changed = true;
    wake?.();
  };
  const stop = subscribeToPlaybackChanges(projectId, notify);
  try {
    const readState = async () => {
      changed = false;
      const response = await fetchWithSupabaseAuth(
        `${getBackendUrl()}/api/workflows/runs/${encodeURIComponent(runId)}`,
        { cache: 'no-store', signal }
      );
      assertWorkflowPollResponse(response, PLAYBACK_ERROR);
      const {
        state: { run },
      } = PlaybackRunSchema.parse(await readWorkflowPollJson(response, PLAYBACK_ERROR));
      if (run.id !== runId || run.projectId !== projectId) throw new Error(PLAYBACK_ERROR);
      return run;
    };
    const initialState = await readState().catch(error => {
      if (signal.aborted || !isTransientWorkflowPollError(error)) throw error;
      return {
        id: runId,
        projectId,
        workflowId: 'prepare-lesson-playback-block' as const,
        status: 'running',
        cleanupStatus: 'not-required',
      };
    });
    const run = await pollWorkflow({
      initialState,
      readState,
      signal,
      subscribeToChanges: listener => {
        wake = listener;
        if (changed) queueMicrotask(listener);
        return () => {
          wake = undefined;
        };
      },
      isTerminal: state =>
        state.status === 'completed' ||
        (!['queued', 'running', 'waiting'].includes(state.status) &&
          !['pending', 'running'].includes(state.cleanupStatus)),
    });
    // A joined optional visual cannot prevent the caller from preparing its requested audio.
    if (run.status !== 'completed' && !optionalVisual) throw new Error(PLAYBACK_ERROR);
  } finally {
    stop();
  }
};

/** Cancels only a run created by this playback attempt; joined preparations retain their owner. */
export const cancelLessonPlaybackPreparation = async (
  runId: string,
  projectId: string
): Promise<void> => {
  const url = `${getBackendUrl()}/api/workflows/runs/${encodeURIComponent(runId)}`;
  await retryTransientWorkflowRequest(async () => {
    const response = await fetchWithSupabaseAuth(`${url}/cancellation`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    assertWorkflowPollResponse(response, PLAYBACK_ERROR);
  });
  const readState = async () => {
    const response = await fetchWithSupabaseAuth(url, { cache: 'no-store' });
    assertWorkflowPollResponse(response, PLAYBACK_ERROR);
    const {
      state: { run },
    } = PlaybackRunSchema.parse(await readWorkflowPollJson(response, PLAYBACK_ERROR));
    if (run.id !== runId || run.projectId !== projectId) throw new Error(PLAYBACK_ERROR);
    return run;
  };
  await pollWorkflow({
    initialState: await retryTransientWorkflowRequest(readState),
    readState,
    isTerminal: run =>
      !['queued', 'running', 'waiting'].includes(run.status) &&
      !['pending', 'running'].includes(run.cleanupStatus),
  });
};
