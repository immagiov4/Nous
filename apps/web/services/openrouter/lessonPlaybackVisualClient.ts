import { type LessonPlaybackBlock, resolvePlaybackNarration } from '@shared/lessonPlayback';
import { isRetiredLessonScene } from '@shared/lessonScene';
import { DEFAULT_TTS_VOICE } from '../audio/voiceProfile.ts';
import {
  getLessonPlayback,
  prepareLessonPlayback,
  waitForLessonPlayback,
} from './lessonPlaybackClient.ts';

type PreparedVisual = NonNullable<LessonPlaybackBlock['prepared']>;
const pending = new Map<string, Promise<PreparedVisual>>();

/** The durable block preparation owns paid work and persistence, independently of the mounted stage. */
export const prepareLessonPlaybackVisual = async (target: {
  projectId: string;
  sectionId: string;
  block: LessonPlaybackBlock;
  lessonKey?: string;
}): Promise<PreparedVisual> => {
  const playback = await getLessonPlayback(target);
  const block = playback.blocks.find(block => block.id === target.block.id);
  if (
    !block ||
    (target.lessonKey && target.lessonKey !== playback.lessonKey) ||
    resolvePlaybackNarration(block).speech !== target.block.speech
  )
    throw new Error('Playback visual source changed.');
  const key = JSON.stringify([target.projectId, target.sectionId, playback.lessonKey, block.id]);
  const existing = pending.get(key);
  if (existing !== undefined) return existing;
  const prepare = async () => {
    const request = {
      projectId: target.projectId,
      sectionId: target.sectionId,
      lessonKey: playback.lessonKey,
      blockId: block.id,
      voice: DEFAULT_TTS_VOICE,
      visualOnly: true,
    };
    let result = await prepareLessonPlayback(request);
    while ('runId' in result) {
      await waitForLessonPlayback(
        result.runId,
        target.projectId,
        new AbortController().signal,
        result.created === false && !result.visualOnly
      );
      result = await prepareLessonPlayback(request);
    }
    const prepared = result.block.prepared;
    if (!prepared?.scene || isRetiredLessonScene(prepared.scene))
      throw new Error('Playback visual unavailable.');
    return prepared;
  };
  const task = prepare().finally(() => pending.delete(key));
  pending.set(key, task);
  return task;
};
