import { normalizeLessonStructure } from '../services/lessonGenerationNormalization.js';
import type { LessonGenerationStageContext } from './lessonGenerationWorkflow.js';
import type {
  LessonVisualFanOutState,
  LessonVisualsState,
} from './lessonGenerationWorkflowContract.js';
import { collectProjectLessonVisualAssetIds } from './lessonVisualPersistence.js';

interface LessonNormalizationStageDependencies {
  readonly now: () => string;
}

type CompletedVisualResult = Extract<
  LessonVisualFanOutState['visualResults'][number],
  { status: 'completed' }
>;

const collectReferencedVisualAssetOwners = (
  completedVisuals: CompletedVisualResult[],
  referencedVisualIds: ReadonlySet<string>
): LessonVisualsState['visualAssetOwners'] =>
  completedVisuals.flatMap(result => {
    if (!referencedVisualIds.has(result.visual.id)) return [];
    const referencedAssetIds = new Set(collectProjectLessonVisualAssetIds(result.visual));
    return result.assetOwners.flatMap(owner => {
      const assetIds = owner.assetIds.filter(assetId => referencedAssetIds.has(assetId));
      return assetIds.length ? [{ assetIds, nodeInstanceId: owner.nodeInstanceId }] : [];
    });
  });

export const createLessonNormalizationStage =
  ({ now }: LessonNormalizationStageDependencies) =>
  async (
    context: LessonGenerationStageContext<LessonVisualFanOutState>
  ): Promise<LessonVisualsState> => {
    const { lesson, visualResults } = context.input;
    const completedVisuals = visualResults.flatMap(result =>
      result.status === 'completed' ? [result] : []
    );
    const visualWarnings = visualResults.flatMap(result =>
      result.status === 'failed'
        ? [
            {
              code: 'lesson_visual_generation_incomplete' as const,
              stage: 'visuals' as const,
              subjectId: result.slotId,
            },
          ]
        : []
    );
    const visualsBySlotId = new Map(completedVisuals.map(result => [result.slotId, result.visual]));
    const candidateIds = new Set(lesson.lessonInputData.imageCandidates.map(image => image.id));
    const candidateImages = lesson.pdfImages.filter(image => candidateIds.has(image.id));
    const generatedAt = now();
    const normalized = normalizeLessonStructure({
      availableImages: candidateImages,
      draft: lesson.draft,
      generatedAt,
      sectionDescription: lesson.lessonInputData.description,
      sectionTitle: lesson.lessonInputData.sectionTitle,
      sources: lesson.lessonSources,
      visualsBySlotId,
    });
    const referencedVisualIds = new Set(normalized.generatedVisuals.map(visual => visual.id));
    const selectedImageIds = new Set(normalized.imageRefs.map(reference => reference.assetId));
    const usedImages = lesson.pdfImages.filter(image => selectedImageIds.has(image.id));
    return {
      ...lesson,
      ...normalized,
      documentAssets:
        lesson.pdfImages.length > 0
          ? {
              imageCount: lesson.pdfImages.length,
              kind: 'pdf',
              parsedAt: generatedAt,
              ...(lesson.documentSourceHash ? { sourceHash: lesson.documentSourceHash } : {}),
              usedImages,
            }
          : null,
      learningAids: lesson.learningAids,
      stage: 'visuals',
      visualAssetOwners: collectReferencedVisualAssetOwners(completedVisuals, referencedVisualIds),
      warnings: [...lesson.warnings, ...visualWarnings],
    };
  };
