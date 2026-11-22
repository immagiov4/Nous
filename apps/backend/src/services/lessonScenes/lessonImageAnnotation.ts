import { findLessonSceneProblems, type GeometryLessonScene } from '@shared/lessonScene';
import { studioReaderCues } from '@shared/lessonSceneAnimation';
import { readerStudioViewports } from '@shared/lessonStudios/chartDimensions';
import { checkImageAnnotation } from '@shared/lessonStudios/imageAnnotateDraw';
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
  'Choose type image-annotate when an existing photo or diagram could show the exact visual relationship described. Name only the specific concept, in Italian (concept.it) and English (concept.en). This choice uses phrase anchors and image positions measured within the selected raster. Omit operand citations.';

const COMMONS_RETRIEVAL_TIMEOUT_MS = 5000;

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
  const retrievalStartedAt = performance.now();
  let retrievalEndedAt: number | undefined;
  const deadline = new AbortController();
  // Every Wikimedia request, including its body, shares the remaining retrieval budget.
  const retrievalSignal = AbortSignal.any([input.signal, deadline.signal]);
  const timer = setTimeout(
    () => deadline.abort(new DOMException('Commons retrieval deadline exceeded', 'TimeoutError')),
    COMMONS_RETRIEVAL_TIMEOUT_MS
  );
  let phase = 'commons-search';
  try {
    const candidates = await createCommonsImageSearch({
      userAgent: COMMONS_USER_AGENT,
      signal: retrievalSignal,
    }).search(proposal.data);
    retrievalSignal.throwIfAborted();
    if (!candidates.length) return { reason: 'commons-no-eligible-candidate' };

    phase = 'commons-thumbnail';
    const available = await loadCommonsThumbnails(candidates, retrievalSignal);
    retrievalSignal.throwIfAborted();
    retrievalEndedAt = performance.now();
    clearTimeout(timer);
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
    return { reason: deadline.signal.aborted ? 'commons-retrieval-timeout' : `${phase}-failed` };
  } finally {
    clearTimeout(timer);
    deadline.abort();
    console.info('[lesson-studio] Commons retrieval', {
      decisionId: input.decisionId,
      studio: 'image-annotate',
      durationMs: (retrievalEndedAt ?? performance.now()) - retrievalStartedAt,
    });
  }
}

async function stageImageAnnotation(input: {
  choice: NonNullable<ReturnType<typeof decodeCommonsChoice>>;
  raster: Awaited<ReturnType<typeof fetchCommonsThumbnail>>;
  narration: string;
  phrases: readonly string[];
  decisionId: string;
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
  for (const [reader, viewport] of Object.entries(readerStudioViewports)) {
    const checks = checkImageAnnotation(spec.data, cues, viewport);
    if (checks.length) {
      console.info('[lesson-studio] reader layout rejected', {
        decisionId: input.decisionId,
        studio: 'image-annotate',
        reader,
        ...viewport,
        checks,
      });
      return { reason: 'commons-layout-rejected', checks };
    }
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
