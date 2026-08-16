import type { GlobalModelConfig } from '../config/modelConfig.js';
import { getProjectStore } from '../projects/projectStore.js';
import type { ProjectStore } from '../projects/types.js';
import { generateLessonLearningAids } from '../services/lessonGenerationAids.js';
import { selectPrerequisiteSourceCoverage } from '../services/lessonGenerationCoverage.js';
import {
  generateLessonContent,
  generateResearchSummary,
  reviewLessonContentDraftStrict,
} from '../services/lessonGenerationModel.js';
import { resolveLessonSourceMaterials } from '../services/lessonGenerationPreparation.js';
import { extractStoredPdfImageAssets } from '../services/lessonGenerationSources.js';
import {
  generateEmbeddedLessonVisualImage,
  generateLessonVisualArtifact,
  generateLessonVisualRaster,
  planLessonArtifactDraft,
  reviseLessonVisualArtifact,
} from '../services/lessonGenerationVisuals.js';
import { planLessonYouTubeSearch } from '../services/lessonYouTubePlanning.js';
import { captionPdfImage } from '../services/pdfImageCaption.js';
import { extractPdfImages } from '../services/pdfImageExtractor.js';
import { buildYouTubeResearchOutcome } from '../services/youtubeResearch.js';
import { timestampIso } from '../utils/time.js';
import type { ArtifactDraftWorkflowServices } from './artifactDraftWorkflow.js';
import { createLessonDocumentSourceStage } from './lessonGenerationDocumentStage.js';
import { createLessonNormalizationStage } from './lessonGenerationNormalizationStage.js';
import {
  createLessonPersistenceStage,
  createLessonResultFinalizer,
} from './lessonGenerationPersistence.js';
import { createLessonGenerationStageServices } from './lessonGenerationStageServices.js';
import type { LessonGenerationWorkflowServices } from './lessonGenerationWorkflow.js';
import { createLessonSublessonStages } from './lessonSublesson.js';
import { createLessonVisualRetryFinalizer } from './lessonVisualPersistence.js';
import type { PostgresWorkflowStore } from './persistence/postgresWorkflowStore.js';

type LessonWorkflowStore = Pick<
  PostgresWorkflowStore,
  'lessonGenerationPersistence' | 'lessonVisualPersistence' | 'projectAssets'
>;

const mutableModelConfig = (value: unknown): GlobalModelConfig => value as GlobalModelConfig;

export const createProductionLessonGenerationServices = (
  workflowStore: LessonWorkflowStore,
  projectStore: ProjectStore = getProjectStore()
): LessonGenerationWorkflowServices & ArtifactDraftWorkflowServices => {
  const generation = createLessonGenerationStageServices({
    generateAids: generateLessonLearningAids,
    generateContent: generateLessonContent,
    generateResearch: generateResearchSummary,
    loadProject: projectStore.loadProject.bind(projectStore),
    loadProjectWithRevision: projectStore.loadProjectWithRevision.bind(projectStore),
    planYouTube: planLessonYouTubeSearch,
    researchYouTube: (query, language, signal) =>
      buildYouTubeResearchOutcome(query, language, { signal }),
    resolveSourceMaterials: resolveLessonSourceMaterials,
    reviewContent: reviewLessonContentDraftStrict,
    selectCoverage: selectPrerequisiteSourceCoverage,
    store: projectStore,
  });
  const persistence = workflowStore.lessonGenerationPersistence;
  const visualPersistence = workflowStore.lessonVisualPersistence;
  const sublesson = createLessonSublessonStages({ projectStore });
  return {
    ...generation,
    ...sublesson,
    assets: workflowStore.projectAssets,
    buildLessonPersistence: createLessonPersistenceStage({
      loadProject: projectStore.loadProject.bind(projectStore),
      now: timestampIso,
    }),
    finalizeLesson: createLessonResultFinalizer({
      loadProjectWithRevision: projectStore.loadProjectWithRevision.bind(projectStore),
    }),
    finalizeRetryResult: createLessonVisualRetryFinalizer({
      loadProjectWithRevision: projectStore.loadProjectWithRevision.bind(projectStore),
    }),
    generateArtifact: generateLessonVisualArtifact,
    generateEmbeddedImage: generateEmbeddedLessonVisualImage,
    generateRaster: generateLessonVisualRaster,
    normalizeLesson: createLessonNormalizationStage({ now: timestampIso }),
    now: timestampIso,
    planArtifactDraft: planLessonArtifactDraft,
    persistLesson: persistence.persistLesson,
    persistSublesson: persistence.persistSublesson,
    persistRetryResult: visualPersistence.persistRetryResult,
    reviseArtifact: reviseLessonVisualArtifact,
    stageDocumentSources: createLessonDocumentSourceStage({
      assets: workflowStore.projectAssets,
      extractImages: ({ context, project, section }) =>
        extractStoredPdfImageAssets({
          captionImage: captionPdfImage,
          config: mutableModelConfig(context.config.models),
          extractImages: extractPdfImages,
          project,
          section,
          signal: context.signal,
          store: projectStore,
          userId: context.input.request.userId,
        }),
      loadProject: projectStore.loadProject.bind(projectStore),
    }),
    undoLesson: persistence.undoLesson,
    undoSublesson: persistence.undoSublesson,
    undoRetryResult: visualPersistence.undoRetryResult,
  };
};
