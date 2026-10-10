import { readLessonPlayback } from '../projects/lessonPlayback.js';
import type { ProjectAssetWriter } from '../projects/projectAsset.js';
import { findProjectLessonSection } from '../projects/projectLesson.js';
import {
  type LockedProjectSnapshot,
  patchProjectInTransaction,
} from '../projects/projectTransaction.js';
import type { ProjectPatch } from '../projects/types.js';
import { timestampIso } from '../utils/time.js';
import type { LessonPlaybackResult, LessonPlaybackServices } from './lessonPlaybackWorkflow.js';
import {
  appendProjectRevisionNotification,
  LESSON_PROJECT_REVISION_EVENT,
} from './projectRevisionNotifications.js';
import { failPermanently } from './retryPolicy.js';

export const buildLessonPlaybackCommitPatch = (
  project: LockedProjectSnapshot,
  result: LessonPlaybackResult
): Omit<ProjectPatch, 'updatedAt'> | null => {
  const { target, block } = result;
  const section = findProjectLessonSection(project.snapshot, target.sectionId);
  const playback = section && readLessonPlayback(section);
  if (
    project.incarnationId !== target.incarnationId ||
    project.snapshot.id !== target.projectId ||
    !playback ||
    playback.lessonKey !== target.lessonKey ||
    !playback.blocks.some(saved => saved.id === block.id)
  ) {
    throw failPermanently({
      code: 'lesson_playback_stale',
      message: 'The lesson changed during playback preparation.',
    });
  }
  if (!result.assetOwner) return null;
  return {
    section: {
      sectionId: target.sectionId,
      playback: {
        ...playback,
        blocks: playback.blocks.map(saved =>
          saved.id !== block.id
            ? saved
            : {
                ...saved,
                prepared: saved.prepared ?? block.prepared,
                audio: [
                  ...saved.audio.filter(
                    audio =>
                      !block.audio.some(
                        next => next.voice === audio.voice && next.model === audio.model
                      )
                  ),
                  ...block.audio,
                ],
              }
        ),
      },
    },
  };
};

export const createLessonPlaybackPersistence =
  (dependencies: {
    assets: Pick<ProjectAssetWriter, 'adoptNodeAssets'>;
    patchProject?: typeof patchProjectInTransaction;
    appendRevision?: typeof appendProjectRevisionNotification;
  }): LessonPlaybackServices['persistPlayback'] =>
  async ({ execution, input, transaction }) => {
    const { target } = input;
    if (input.assetOwner) {
      await dependencies.assets.adoptNodeAssets(transaction, {
        assetIds: input.block.audio.map(audio => audio.asset.id),
        nodeInstanceId: input.assetOwner,
        projectId: target.projectId,
        runId: execution.runId,
        userId: target.userId,
      });
    }
    const saved = await (dependencies.patchProject ?? patchProjectInTransaction)(transaction, {
      buildPatch: project => buildLessonPlaybackCommitPatch(project, input),
      playbackWrite: true,
      projectId: target.projectId,
      updatedAt: timestampIso(),
      userId: target.userId,
    });
    if (!saved.projectChanged) return;
    if (saved.meta.revision === undefined)
      throw new Error('The playback project revision is missing.');
    await (dependencies.appendRevision ?? appendProjectRevisionNotification)(transaction, {
      eventType: LESSON_PROJECT_REVISION_EVENT,
      projectId: target.projectId,
      revision: saved.meta.revision,
      runId: execution.runId,
    });
  };
