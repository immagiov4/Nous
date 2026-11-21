import { findLessonSceneProblems, type GeometryLessonScene } from '@shared/lessonScene';
import { studioReaderCues } from '@shared/lessonSceneAnimation';
import { readerStudioViewports } from '@shared/lessonStudios/chartDimensions';
import {
  buildImageAnnotateLayout,
  checkImageAnnotateLayout,
} from '@shared/lessonStudios/imageAnnotate';
import { ImageAnnotateSpecSchema } from '@shared/lessonStudios/imageAnnotateSpec';
import type { ProjectAssetRef } from '@shared/projectAsset';
import * as z from 'zod';
import { runWithWorkflowAiCallAttribution } from '../../workflows/modelExchanges.js';
import { toWorkflowErrorDiagnostic } from '../../workflows/workflowErrorDiagnostics.js';
import { COMMONS_USER_AGENT, createCommonsImageSearch } from '../commonsImageSearch.js';
import { toGeneratedImageDataUrl } from '../imageClient.js';
import { generateStructuredOutput, type ResolvedStructuredModel } from '../structuredGeneration.js';
import {
  type fetchCommonsThumbnail,
  inspectCommonsRaster,
  loadCommonsThumbnails,
} from './commonsRaster.js';
import { commonsVisionRequest, decodeCommonsChoice } from './commonsVisionSelection.js';
import { resolveStudioAnchors } from './lessonStudioSelection.js';

export const ImageAnnotateSelectionSchema = z.strictObject({
  type: z.literal('image-annotate'),
  concept: z.strictObject({ it: z.string().trim().min(1), en: z.string().trim().min(1) }),
});
export const IMAGE_ANNOTATE_SELECTION_RULE =
  'Choose type image-annotate when an existing photo or diagram could show the exact visual relationship described. Name only the specific concept, in Italian (concept.it) and English (concept.en).';

export type StageStudioImage = (image: {
  bytes: Uint8Array;
  mediaType: string;
}) => Promise<ProjectAssetRef>;

export async function resolveImageAnnotation(input: {
  response: unknown;
  narration: string;
  phrases: readonly string[];
  numbered: string;
  decisionId: string;
  model: ResolvedStructuredModel;
  stage: StageStudioImage;
  signal: AbortSignal;
}) {
  const proposal = ImageAnnotateSelectionSchema.safeParse(input.response);
  if (!proposal.success) return { reason: 'invalid-output' };
  let phase = 'commons-search';
  try {
    const candidates = await createCommonsImageSearch({
      userAgent: COMMONS_USER_AGENT,
      signal: input.signal,
    }).search(proposal.data);
    if (!candidates.length) return { reason: 'commons-no-eligible-candidate' };

    phase = 'commons-thumbnail';
    const available = await loadCommonsThumbnails(candidates, input.signal);
    if (!available.length) return { reason: 'commons-thumbnail-failed' };
    phase = 'commons-vision';
    const selected = await runWithWorkflowAiCallAttribution(
      { decisionId: input.decisionId, role: 'studio-selection' },
      () =>
        generateStructuredOutput<unknown>({
          model: input.model,
          ...commonsVisionRequest(
            input.numbered,
            available.map(({ raster }) => toGeneratedImageDataUrl(raster))
          ),
          signal: input.signal,
        })
    );
    const choice = decodeCommonsChoice(
      selected,
      available.map(({ candidate }) => candidate)
    );
    if (!choice)
      return { reason: choice === null ? 'commons-no-confident-pick' : 'commons-invalid-pick' };
    const chosen = available.find(({ candidate }) => candidate === choice.candidate);
    if (!chosen) return { reason: 'commons-invalid-pick' };
    return await stageImageAnnotation({
      ...input,
      choice,
      raster: chosen.raster,
      onPhase: next => {
        phase = next;
      },
    });
  } catch (error) {
    input.signal.throwIfAborted();
    console.info('[lesson-studio] Commons phase failed', {
      decisionId: input.decisionId,
      studio: 'image-annotate',
      phase,
      cause: toWorkflowErrorDiagnostic(error, { includeContent: false }),
    });
    return { reason: `${phase}-failed` };
  }
}

async function stageImageAnnotation(input: {
  choice: NonNullable<ReturnType<typeof decodeCommonsChoice>>;
  raster: Awaited<ReturnType<typeof fetchCommonsThumbnail>>;
  narration: string;
  phrases: readonly string[];
  signal: AbortSignal;
  stage: StageStudioImage;
  onPhase: (phase: string) => void;
}) {
  const { candidate, annotation } = input.choice;
  const studioCues = resolveStudioAnchors(
    annotation.beats.map(beat => Number(beat.at.slice(1))),
    input.narration,
    input.phrases
  );
  if (!studioCues) return { reason: 'commons-invalid-cues' };
  input.onPhase('commons-raster');
  const { width, height, ...raster } = await inspectCommonsRaster(input.raster, input.signal);
  const spec = ImageAnnotateSpecSchema.safeParse({
    ...annotation,
    image: { ...candidate.image, width, height },
  });
  if (!spec.success) return { reason: 'commons-invalid-annotation' };
  const draft = {
    type: 'geometry' as const,
    title: spec.data.title,
    body: '',
    groups: [],
    items: [],
    note: '',
    quote: '',
    autoplay: true,
    narration: input.narration,
    studioCues,
  };
  const cues = studioReaderCues(draft);
  for (const viewport of Object.values(readerStudioViewports)) {
    const checks = checkImageAnnotateLayout(buildImageAnnotateLayout(spec.data, cues, viewport));
    if (checks.length) return { reason: 'commons-layout-rejected', checks };
  }
  input.onPhase('commons-stage');
  const { mediaType } = raster;
  const asset = { ...(await input.stage(raster)), mediaType };
  const scene: GeometryLessonScene = {
    ...draft,
    geometryStudio: { id: 'image-annotate', asset, spec: spec.data },
  };
  return findLessonSceneProblems(scene, undefined, input.narration).length
    ? { reason: 'commons-invalid-scene' }
    : { scene, lane: candidate.origins[0] };
}
