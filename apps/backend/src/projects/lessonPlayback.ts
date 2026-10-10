import { createHash } from 'node:crypto';

import {
  type LessonPlayback,
  type PlaybackContentBlock,
  segmentLessonPlayback,
} from '@shared/lessonPlayback';
import { buildProjectAssetPlaceholder, type ProjectLessonVisual } from '@shared/projectAsset';

import { canonicalJson } from '../workflows/schemaFingerprint.js';
import { findProjectLessonSection } from './projectLesson.js';
import type { LearningPlanNodeSnapshot, ProjectSnapshot } from './types.js';

const lessonPlaybackContent = (
  section: LearningPlanNodeSnapshot
): readonly PlaybackContentBlock[] =>
  Array.isArray(section.contentBlocks)
    ? section.contentBlocks
    : typeof section.content === 'string'
      ? [{ type: 'markdown', markdown: section.content }]
      : [];

/** Asset content, rather than its project-local ID, keeps imported playback reusable. */
const visualContent = (visual: ProjectLessonVisual) => {
  const render = visual.render;
  if (render.kind === 'image')
    return { ...visual, render: { ...render, asset: { ...render.asset, id: render.asset.hash } } };
  if (render.kind !== 'html') return visual;
  let code = render.code;
  for (const asset of render.embeddedAssets) {
    code = code.replaceAll(
      buildProjectAssetPlaceholder(asset.id),
      buildProjectAssetPlaceholder(asset.hash)
    );
  }
  return {
    ...visual,
    render: {
      ...render,
      code,
      embeddedAssets: render.embeddedAssets.map(asset => ({ ...asset, id: asset.hash })),
    },
  };
};

export const lessonPlaybackVisuals = (section: LearningPlanNodeSnapshot): ProjectLessonVisual[] => {
  const referenced = new Set(
    lessonPlaybackContent(section).flatMap(block =>
      block.type === 'generated-visual' && block.visualId ? [block.visualId] : []
    )
  );
  return (
    Array.isArray(section.generatedVisuals)
      ? (section.generatedVisuals as ProjectLessonVisual[])
      : []
  )
    .filter(visual => referenced.has(visual.id))
    .sort((a, b) => a.id.localeCompare(b.id));
};

export const buildLessonPlaybackKey = (section: LearningPlanNodeSnapshot): string =>
  createHash('sha256')
    .update(
      canonicalJson({
        contentBlocks: lessonPlaybackContent(section),
        generatedVisuals: lessonPlaybackVisuals(section).map(visualContent),
        lastGenerationRunId: section.lastGenerationRunId ?? null,
      })
    )
    .digest('hex');

export const readLessonPlayback = (section: LearningPlanNodeSnapshot): LessonPlayback => {
  const lessonKey = buildLessonPlaybackKey(section);
  const saved = new Map(
    section.playback?.lessonKey === lessonKey
      ? section.playback.blocks.map(block => [block.id, block])
      : []
  );
  return {
    version: 1,
    lessonKey,
    blocks: segmentLessonPlayback(lessonPlaybackContent(section)).map(block => {
      const prepared = saved.get(block.id);
      return prepared ? { ...block, prepared: prepared.prepared, audio: prepared.audio } : block;
    }),
  };
};

/** Preserve server-prepared data on ordinary client saves; invalidate every content replacement. */
export const reconcileLessonPlayback = (
  snapshot: ProjectSnapshot,
  previous: ProjectSnapshot | null,
  playbackWrite = false
): void => {
  const reconcile = (section: LearningPlanNodeSnapshot): LearningPlanNodeSnapshot => {
    if (section.kind === 'exercise' || !section.id) return section;
    const before = previous && findProjectLessonSection(previous, section.id);
    if (!section.playback && !before?.playback) return section;
    const key = buildLessonPlaybackKey(section);
    let playback = section.playback;
    if (before && !playbackWrite) {
      playback = buildLessonPlaybackKey(before) === key ? before.playback : undefined;
    }
    if (playback?.lessonKey !== key) playback = undefined;
    const { playback: _previousPlayback, ...rest } = section;
    return playback ? { ...rest, playback } : rest;
  };
  const plan = snapshot.learningPlan;
  if (!plan) return;
  snapshot.learningPlan = {
    ...plan,
    ...(plan.sections ? { sections: plan.sections.map(reconcile) } : {}),
    ...(plan.modules
      ? {
          modules: plan.modules.map(module => ({
            ...module,
            children: module.children?.map(reconcile),
          })),
        }
      : {}),
  };
};
