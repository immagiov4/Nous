import { findLessonSceneProblems, type GeometryLessonScene } from '@shared/lessonScene';
import { studioReaderCues } from '@shared/lessonSceneAnimation';
import { readerStudioViewports } from '@shared/lessonStudios/chartDimensions';
import {
  buildImageAnnotateLayout,
  checkImageAnnotateLayout,
} from '@shared/lessonStudios/imageAnnotate';
import {
  ImageAnnotateSpecSchema,
  ImageAnnotationSchema,
} from '@shared/lessonStudios/imageAnnotateSpec';
import type { ProjectAssetRef } from '@shared/projectAsset';
import * as z from 'zod';
import { runWithWorkflowAiCallAttribution } from '../../workflows/modelExchanges.js';
import { toWorkflowErrorDiagnostic } from '../../workflows/workflowErrorDiagnostics.js';
import {
  COMMONS_USER_AGENT,
  type CommonsImageCandidate,
  createCommonsImageSearch,
} from '../commonsImageSearch.js';
import { toGeneratedImageDataUrl } from '../imageClient.js';
import { generateStructuredOutput, type ResolvedStructuredModel } from '../structuredGeneration.js';
import { fetchCommonsThumbnail, inspectCommonsRaster } from './commonsRaster.js';
import { resolveStudioAnchors } from './lessonStudioSelection.js';

export const ImageAnnotateSelectionSchema = z.strictObject({
  type: z.literal('image-annotate'),
  concept: z.strictObject({ it: z.string().trim().min(1), en: z.string().trim().min(1) }),
});
export const IMAGE_ANNOTATE_SELECTION_RULE =
  'Choose type image-annotate when an existing photo or diagram could show the exact visual relationship described. Name only the specific concept, in Italian (concept.it) and English (concept.en).';

const normalizedPoint = z.strictObject({
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
});
const VisionAnnotationSchema = ImageAnnotationSchema.extend({
  overlay: z
    .strictObject({
      type: z.literal('vanishing-lines'),
      point: normalizedPoint,
      from: z.array(normalizedPoint).min(2),
    })
    .optional(),
});

export const VisionSelectionSchema = z.strictObject({
  chosen: z.number().int().positive().nullable(),
  annotation: VisionAnnotationSchema.nullable(),
});

export const COMMONS_VISION_SYSTEM = [
  'Choose one of the attached images, numbered 1 onward in the order provided, or return null for both fields.',
  'Require visible evidence of the exact relation, mechanism or sequence in the numbered narration.',
  'Check the actual pixels and embedded labels. A subject in common is insufficient. Reject substitutes, wrong variants, ambiguous evidence and partial illustrations.',
  'For lunar phases, a Moon photograph or view of surface features is insufficient. A diagram must actually show the phases or their geometric cause, as the narration requires.',
  'For a choice, provide a title, alt and up to four beats in the narration language. Use increasing b1, b2, etc. for the given numbered phrases.',
  'Give normalized x,y,w,h focus rectangles around visible evidence. Copy short labels from the narration. Omit optional labels where a highlight suffices.',
  'Use the vanishing-lines overlay only when real edges visibly converge to the same point. Use normalized {x,y} objects for point and from, and only show the guides on relevant beats.',
].join(' ');

export function commonsVisionPrompt(numbered: string) {
  return `NUMBERED NARRATION:\n${numbered}`;
}

const pointPair = ({ x, y }: z.infer<typeof normalizedPoint>): [number, number] => [x, y];

export function decodeCommonsChoice(value: unknown, candidates: readonly CommonsImageCandidate[]) {
  const result = VisionSelectionSchema.safeParse(value);
  if (!result.success) return undefined;
  const { chosen, annotation } = result.data;
  if (chosen === null && annotation === null) return null;
  const candidate = chosen === null ? undefined : candidates[chosen - 1];
  if (!candidate || !annotation) return undefined;
  const { overlay, ...description } = annotation;
  return {
    candidate,
    annotation: {
      ...description,
      ...(overlay
        ? {
            overlay: {
              ...overlay,
              point: pointPair(overlay.point),
              from: overlay.from.map(pointPair),
            },
          }
        : {}),
    },
  };
}

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
          images: available.map(({ raster }) => toGeneratedImageDataUrl(raster)),
          output: {
            name: 'lesson_image_annotation',
            schema: z.toJSONSchema(VisionSelectionSchema),
          },
          prompt: commonsVisionPrompt(input.numbered),
          signal: input.signal,
          system: COMMONS_VISION_SYSTEM,
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

export async function loadCommonsThumbnails(
  candidates: readonly CommonsImageCandidate[],
  signal: AbortSignal
) {
  const available = [];
  for (const candidate of candidates) {
    try {
      const raster = await fetchCommonsThumbnail(candidate.thumbnail, signal);
      available.push({ candidate, raster });
    } catch {
      signal.throwIfAborted();
      // A missing thumbnail cannot be selected by index.
    }
  }
  return available;
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
