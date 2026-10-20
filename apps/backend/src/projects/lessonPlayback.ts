import { createHash } from 'node:crypto';

import {
  type LessonPlayback,
  type PlaybackContentBlock,
  projectLessonPlayback,
} from '@shared/lessonPlayback';
import { buildProjectAssetPlaceholder, type ProjectLessonVisual } from '@shared/projectAsset';

import { canonicalJson } from '../workflows/schemaFingerprint.js';
import { findProjectLessonSection } from './projectLesson.js';
import type { LearningPlanNodeSnapshot, ProjectSnapshot } from './types.js';

const lessonPlaybackContent = (
  section: LearningPlanNodeSnapshot
): readonly PlaybackContentBlock[] => {
  if (Array.isArray(section.contentBlocks)) return section.contentBlocks;
  if (typeof section.content === 'string') return [{ type: 'markdown', markdown: section.content }];
  return [];
};

/** Asset content, rather than its project-local ID, keeps imported playback reusable. */
const visualContent = (visual: ProjectLessonVisual) => {
  // Historical lessons preserve visuals whose kind and code have no render wrapper.
  if (!Object.hasOwn(visual, 'render')) return visual;
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
  const referenced = projectLessonPlayback(lessonPlaybackContent(section)).referencedVisualIds;
  return (
    Array.isArray(section.generatedVisuals)
      ? (section.generatedVisuals as ProjectLessonVisual[])
      : []
  )
    .filter(visual => referenced.has(visual.id))
    .sort((a, b) => a.id.localeCompare(b.id));
};

const lessonPlaybackKey = (
  section: LearningPlanNodeSnapshot,
  projection: ReturnType<typeof projectLessonPlayback>
): string => {
  return createHash('sha256')
    .update(
      canonicalJson({
        contentBlocks: projection.contentBlocks,
        ...(projection.hasLegacyVisuals
          ? { visualProjection: projection.blocks.map(block => block.visuals) }
          : {}),
        ...(projection.hasAnnotations
          ? {
              speechProjection: projection.blocks.map(block => block.speech),
            }
          : {}),
        generatedVisuals: lessonPlaybackVisuals(section).map(visualContent),
        lastGenerationRunId: section.lastGenerationRunId ?? null,
        title: typeof section.title === 'string' ? section.title : '',
        description: typeof section.description === 'string' ? section.description : '',
      })
    )
    .digest('hex');
};

export const buildLessonPlaybackKey = (section: LearningPlanNodeSnapshot): string =>
  lessonPlaybackKey(section, projectLessonPlayback(lessonPlaybackContent(section)));

export const readLessonPlayback = (section: LearningPlanNodeSnapshot): LessonPlayback => {
  const projection = projectLessonPlayback(lessonPlaybackContent(section));
  const lessonKey = lessonPlaybackKey(section, projection);
  const saved = new Map(
    section.playback?.lessonKey === lessonKey
      ? section.playback.blocks.map(block => [block.id, block])
      : []
  );
  return {
    version: 1,
    lessonKey,
    blocks: projection.blocks.map(block => {
      const prepared = saved.get(block.id);
      const needsFenceClassification =
        block.spans.some(span => span.fencedCode) && !prepared?.prepared?.fencedCode;
      const sameFormulas =
        JSON.stringify(prepared?.spans.flatMap(span => (span.math ? [span.math] : []))) ===
        JSON.stringify(block.spans.flatMap(span => (span.math ? [span.math] : [])));
      return prepared?.speech === block.speech && !needsFenceClassification
        ? {
            ...block,
            spans: prepared.prepared?.spokenMath && !sameFormulas ? prepared.spans : block.spans,
            prepared: prepared.prepared,
            audio: prepared.audio,
          }
        : block;
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
    // Only the server prepares playback: ordinary writes keep the stored data and never accept
    // client-supplied playback, including on a new project or section.
    if (!playbackWrite) {
      playback = before && buildLessonPlaybackKey(before) === key ? before.playback : undefined;
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
