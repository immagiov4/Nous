import type { TransactionSql } from 'postgres';
import { describe, expect, test, vi } from 'vitest';

import { applyProjectPatch } from '../../src/projects/projectPatch.js';
import {
  buildLessonPlaybackCommitPatch,
  createLessonPlaybackPersistence,
} from '../../src/workflows/lessonPlaybackPersistence.js';
import {
  playbackProject,
  playbackResult,
  playbackSection,
  preparedPlayback,
} from '../helpers/lessonPlayback.js';

describe('playback block commit', () => {
  test('updates one block while preserving a concurrent note, voice and other block', () => {
    const section = playbackSection();
    const result = playbackResult(section);
    section.playback = preparedPlayback(section);
    section.playback = {
      ...section.playback,
      blocks: section.playback.blocks.map(block => ({
        ...block,
        audio: block.audio.map(audio => ({ ...audio, voice: 'Zephyr' })),
      })),
    };
    section.annotations = [{ id: 'concurrent-note', text: 'Appunto' }];
    const snapshot = playbackProject(section);
    const patch = buildLessonPlaybackCommitPatch(
      { incarnationId: 'incarnation-1', revision: 2, snapshot },
      result
    );
    const saved = applyProjectPatch(snapshot, patch ?? {}, snapshot.updatedAt);
    const savedSection = saved.learningPlan?.sections?.[0];
    expect(savedSection?.annotations).toEqual(section.annotations);
    expect(savedSection?.playback?.blocks[1]).toEqual(section.playback.blocks[1]);
    expect(savedSection?.playback?.blocks[0]?.audio.map(audio => audio.voice)).toEqual([
      'Zephyr',
      'Kore',
    ]);
    const repeated = buildLessonPlaybackCommitPatch(
      { incarnationId: 'incarnation-1', revision: 3, snapshot: saved },
      result
    );
    expect(
      applyProjectPatch(saved, repeated ?? {}, saved.updatedAt).learningPlan?.sections?.[0]
        ?.playback?.blocks[0]?.audio
    ).toHaveLength(2);
  });
  test.each([
    'content',
    'generation',
    'incarnation',
  ])('rejects stale work after %s changes', change => {
    const section = playbackSection();
    const result = playbackResult(section);
    if (change === 'content')
      section.contentBlocks = [{ type: 'markdown', markdown: 'Testo nuovo' }];
    if (change === 'generation') section.lastGenerationRunId = 'generation-2';
    expect(() =>
      buildLessonPlaybackCommitPatch(
        {
          snapshot: playbackProject(section),
          revision: 1,
          incarnationId: change === 'incarnation' ? 'recreated' : 'incarnation-1',
        },
        result
      )
    ).toThrow();
  });
  test('adopts audio, patches the locked project and notifies in the checkpoint transaction', async () => {
    const transaction = {} as TransactionSql;
    const input = playbackResult();
    const adoptNodeAssets = vi.fn(async () => []);
    const appendRevision = vi.fn(async () => undefined);
    const patchProject = vi.fn(async (tx, request) => {
      expect(tx).toBe(transaction);
      expect(request.playbackWrite).toBe(true);
      const snapshot = playbackProject();
      const patch = request.buildPatch({ snapshot, revision: 5, incarnationId: 'incarnation-1' });
      return {
        meta: { id: snapshot.id, revision: 6 },
        snapshot: applyProjectPatch(snapshot, patch, snapshot.updatedAt),
        projectChanged: true,
      };
    });
    await createLessonPlaybackPersistence({
      assets: { adoptNodeAssets },
      patchProject: patchProject as never,
      appendRevision,
    })({
      transaction,
      input,
      output: input,
      execution: { runId: 'run-1', nodeInstanceId: 'root/persist-block' },
      config: { maxAttempts: 3, timeoutMs: 60_000 },
      services: {} as never,
    });
    expect(adoptNodeAssets).toHaveBeenCalledWith(
      transaction,
      expect.objectContaining({
        nodeInstanceId: 'root/prepare-block',
        assetIds: [input.block.audio[0]?.asset.id],
        runId: 'run-1',
      })
    );
    expect(appendRevision).toHaveBeenCalledWith(
      transaction,
      expect.objectContaining({ revision: 6, projectId: 'project-1', runId: 'run-1' })
    );
  });
});
