import {
  LessonPlaybackResponseSchema,
  PrepareLessonPlaybackResponseSchema,
} from '@shared/lessonPlaybackSchema';

import { fetchWithSupabaseAuth } from '../auth/supabaseAuth.ts';
import { getBackendUrl } from './config.ts';
import { readWorkflowPollJson } from './workflowClientTransport.ts';

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
