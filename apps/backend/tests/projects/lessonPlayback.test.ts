import {
  collectProjectAssetReferences,
  remapProjectAssetReferences,
} from '@shared/projectBackupAssets';
import { canonicalizeLessonNodeContent } from '@shared/projectSnapshotWire';
import type { TransactionSql } from 'postgres';
import { describe, expect, test, vi } from 'vitest';

import {
  buildLessonPlaybackKey,
  readLessonPlayback,
  reconcileLessonPlayback,
} from '../../src/projects/lessonPlayback.js';
import { reconcileProjectAssets } from '../../src/projects/projectAssetReconciliation.js';
import {
  buildLessonGenerationSourceFingerprint,
  snapshotLessonGenerationTarget,
} from '../../src/workflows/lessonGenerationAuthority.js';
import {
  playbackAsset,
  playbackProject,
  playbackSection,
  preparedPlayback,
} from '../helpers/lessonPlayback.js';

describe('playback persistence and assets', () => {
  test('ordinary saves preserve server playback and their concurrent annotations', () => {
    const original = playbackSection();
    original.playback = preparedPlayback(original);
    const saved = playbackProject({ ...playbackSection(), annotations: [{ id: 'new-note' }] });
    reconcileLessonPlayback(saved, playbackProject(original));
    expect(saved.learningPlan?.sections?.[0]).toMatchObject({
      playback: original.playback,
      annotations: [{ id: 'new-note' }],
    });
  });
  test.each([
    { contentBlocks: [{ type: 'markdown', markdown: 'Nuova lezione.' }] },
    { lastGenerationRunId: 'generation-2' },
  ])('content replacement invalidates playback and queues its audio: %j', async replacement => {
    const original = playbackSection();
    original.playback = preparedPlayback(original);
    const before = playbackProject(original);
    const after = playbackProject({ ...original, ...replacement });
    reconcileLessonPlayback(after, before);
    expect(after.learningPlan?.sections?.[0]).not.toHaveProperty('playback');
    const queued: unknown[] = [];
    const transaction = vi.fn((strings, ...values) => {
      if (
        Array.isArray(strings) &&
        typeof strings[0] === 'string' &&
        strings[0].includes('update public.project_assets')
      ) {
        queued.push(...values.at(-1));
        return Promise.resolve([{ id: playbackAsset.id }]);
      }
      return strings;
    }) as unknown as TransactionSql;
    expect(
      await reconcileProjectAssets(transaction, {
        previousSnapshot: before,
        snapshot: after,
        projectId: after.id,
        userId: 'local-user',
      })
    ).toBe(1);
    expect(queued).toEqual([playbackAsset.id]);
  });
  test('same-content saves discard stale client playback in favor of server data', () => {
    const original = playbackSection();
    original.playback = preparedPlayback(original);
    const candidate = playbackProject({
      ...original,
      playback: { ...original.playback, blocks: [] },
    });
    reconcileLessonPlayback(candidate, playbackProject(original));
    expect(candidate.learningPlan?.sections?.[0]?.playback).toEqual(original.playback);
  });
  test('keys ignore notes and unused visuals but include referenced visual changes', () => {
    const section = playbackSection();
    const key = buildLessonPlaybackKey(section);
    expect(
      buildLessonPlaybackKey({
        ...section,
        annotations: [{ id: 'note' }],
        generatedVisuals: [{ id: 'unused' }],
      })
    ).toBe(key);
    const visual = {
      id: 'visual-1',
      slotId: 'slot',
      createdAt: 'now',
      render: { kind: 'image', asset: { ...playbackAsset, mediaType: 'image/png' } },
    };
    section.contentBlocks = [
      ...(section.contentBlocks as unknown[]),
      { type: 'generated-visual', slotId: 'slot', visualId: visual.id },
    ];
    section.generatedVisuals = [visual];
    const referencedKey = buildLessonPlaybackKey(section);
    section.generatedVisuals = [
      {
        ...visual,
        render: { ...visual.render, asset: { ...visual.render.asset, hash: 'c'.repeat(64) } },
      },
    ];
    expect(buildLessonPlaybackKey(section)).not.toBe(referencedKey);
  });
  test.each([
    true,
    false,
  ])('backup collection and import remap audio without requiring visuals (modules: %s)', modules => {
    const section = playbackSection();
    section.playback = preparedPlayback(section);
    const project = playbackProject(section);
    if (modules) project.learningPlan = { modules: [{ id: 'module', children: [section] }] };
    expect(collectProjectAssetReferences(project)).toEqual([playbackAsset]);
    const imported = remapProjectAssetReferences(
      project,
      new Map([[playbackAsset.id, 'd'.repeat(64)]]),
      'imported'
    );
    expect(collectProjectAssetReferences(imported)).toEqual([
      { ...playbackAsset, id: 'd'.repeat(64) },
    ]);
    expect(collectProjectAssetReferences(project)).toEqual([playbackAsset]);
  });
  test('imported images retain the lesson key while audio and image IDs are remapped', () => {
    const section = playbackSection();
    const image = { ...playbackAsset, id: 'e'.repeat(64), mediaType: 'image/png' };
    section.generatedVisuals = [
      { id: 'visual', slotId: 'slot', createdAt: 'now', render: { kind: 'image', asset: image } },
    ];
    section.contentBlocks = [
      ...(section.contentBlocks as unknown[]),
      { type: 'generated-visual', slotId: 'slot', visualId: 'visual' },
    ];
    section.playback = preparedPlayback(section);
    const imported = remapProjectAssetReferences(
      playbackProject(section),
      new Map([
        [playbackAsset.id, 'd'.repeat(64)],
        [image.id, 'f'.repeat(64)],
      ])
    );
    const importedSection = imported.learningPlan?.sections?.[0];
    if (!importedSection) throw new Error('Missing imported lesson');
    expect(readLessonPlayback(importedSection).blocks[0]?.audio[0]?.asset.id).toBe('d'.repeat(64));
  });
  test('playback changes neither generation inputs nor rollback snapshots', () => {
    const section = playbackSection();
    const before = playbackProject(section);
    const after = playbackProject({ ...section, playback: preparedPlayback(section) });
    expect(buildLessonGenerationSourceFingerprint(after, 'section-1')).toBe(
      buildLessonGenerationSourceFingerprint(before, 'section-1')
    );
    expect(snapshotLessonGenerationTarget(after, 'section-1')).toEqual(
      snapshotLessonGenerationTarget(before, 'section-1')
    );
  });
  test('wire validation accepts playback and rejects malformed audio even on legacy content', () => {
    const section = playbackSection();
    section.playback = preparedPlayback(section);
    expect(canonicalizeLessonNodeContent(section).playback).toEqual(section.playback);
    expect(() =>
      canonicalizeLessonNodeContent({
        ...section,
        contentBlocks: undefined,
        playback: {
          ...section.playback,
          blocks: [{ ...section.playback.blocks[0], audio: [{ asset: {} }] }],
        },
      })
    ).toThrow();
  });
});
