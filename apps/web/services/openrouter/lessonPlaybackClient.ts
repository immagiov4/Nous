import {
  LessonPlaybackResponseSchema,
  PrepareLessonPlaybackResponseSchema,
} from '@shared/lessonPlaybackSchema';
import * as z from 'zod';
import { fetchWithSupabaseAuth } from '../auth/supabaseAuth.ts';
import { getBackendUrl } from './config.ts';
import {
  assertWorkflowPollResponse,
  pollWorkflow,
  readWorkflowPollJson,
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
  target: PlaybackTarget & { blockId: string; lessonKey: string; voice: string },
  signal?: AbortSignal
) => {
  const response = await fetchWithSupabaseAuth(
    `${playbackUrl(target)}/blocks/${encodeURIComponent(target.blockId)}/prepare`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lessonKey: target.lessonKey, voice: target.voice }),
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

/** Wait for the preparation commit before reading the block from the lesson. */
export const waitForLessonPlayback = async (
  runId: string,
  projectId: string,
  signal: AbortSignal
) => {
  const readState = async () => {
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
  const run = await pollWorkflow({
    initialState: await readState(),
    readState,
    signal,
    isTerminal: state =>
      state.status === 'completed' ||
      (!['queued', 'running', 'waiting'].includes(state.status) &&
        !['pending', 'running'].includes(state.cleanupStatus)),
  });
  if (run.status !== 'completed') throw new Error(PLAYBACK_ERROR);
};
