import type { DurableLessonGenerationResult } from '@shared/generationJobContract';

import {
  type AiProvider,
  getResolvedModelConfigForProvider,
  type ModelProviderOverrides,
} from '../config/modelConfig.js';
import { publishProjectRevision } from '../projects/projectEvents.js';
import { ProjectRevisionConflictError } from '../projects/projectRevision.js';
import { getProjectStore } from '../projects/projectStore.js';
import type { ProjectSnapshot, ProjectStore } from '../projects/types.js';
import { isRecord } from '../utils/validation.js';
import type { GenerationJob, GenerationJobStageReporter } from './generationJobs.js';
import { selectPrerequisiteSourceCoverage } from './lessonGenerationCoverage.js';
import {
  type GenerateLesson,
  type GenerateResearch,
  generateLesson,
  generateResearchSummary,
  normalizeGeneratedLesson,
  renderDraftVisuals,
} from './lessonGenerationModel.js';
import {
  findLessonSection,
  prepareLessonGenerationInput,
  resolveLessonSourceMaterials,
} from './lessonGenerationPreparation.js';
import {
  buildResearchDossier,
  createResearchedLessonDraft,
  type ResearchYouTube,
  researchLessonYouTube,
} from './lessonGenerationResearch.js';
import {
  mergeProjectDocumentAssets,
  mergeSources,
  readExistingDossier,
  readOriginalSourceNames,
  youtubeSources,
} from './lessonGenerationSources.js';
import { type RenderLessonVisual, renderLessonVisual } from './lessonGenerationVisuals.js';
import { planLessonYouTubeSearch } from './lessonYouTubePlanning.js';
import { captionPdfImage } from './pdfImageCaption.js';
import { extractPdfImages } from './pdfImageExtractor.js';
import { buildYouTubeResearchOutcome } from './youtubeResearch.js';

interface LessonGenerationPayload {
  aiProvider?: AiProvider;
  aiProviderOverrides?: ModelProviderOverrides;
  forceRegenerate?: boolean;
  projectId: string;
  sectionId: string;
}

const MAX_LESSON_PERSIST_ATTEMPTS = 2;

const parsePayload = (value: unknown): LessonGenerationPayload => {
  if (
    !isRecord(value) ||
    typeof value.projectId !== 'string' ||
    typeof value.sectionId !== 'string'
  ) {
    throw new Error('Invalid lesson generation payload.');
  }
  return value as unknown as LessonGenerationPayload;
};

const readCompletedResult = (
  project: ProjectSnapshot,
  sectionId: string,
  projectRevision?: number
): DurableLessonGenerationResult | null => {
  const section = findLessonSection(project, sectionId);
  if (!section || typeof section.content !== 'string' || !section.content.trim()) return null;
  const researchDossier = readExistingDossier(project, sectionId);
  const completedResult: DurableLessonGenerationResult = {
    alreadyCompleted: true,
    content: section.content,
    contentBlocks: Array.isArray(section.contentBlocks) ? section.contentBlocks : [],
    ...(isRecord(project.documentAssets) ? { documentAssets: project.documentAssets } : {}),
    generatedVisuals: Array.isArray(section.generatedVisuals) ? section.generatedVisuals : [],
    imageRefs: Array.isArray(section.imageRefs) ? section.imageRefs : [],
    learningAids: Array.isArray(section.learningAids) ? section.learningAids : [],
    projectId: project.id,
    ...(typeof projectRevision === 'number' ? { projectRevision } : {}),
    quiz: Array.isArray(section.quiz) ? section.quiz : [],
    ...(researchDossier ? { researchDossier } : {}),
    sectionId,
  };
  if (section.visualPlanningDecision !== undefined) {
    completedResult.visualPlanningDecision = section.visualPlanningDecision;
  }
  return completedResult;
};

const wasGenerationJobApplied = (
  project: ProjectSnapshot,
  sectionId: string,
  jobId: string
): boolean => findLessonSection(project, sectionId)?.lastGenerationJobId === jobId;

interface PersistGeneratedLessonInput {
  forceRegenerate: boolean;
  job: GenerationJob;
  researchDossier: Record<string, unknown>;
  result: Omit<DurableLessonGenerationResult, 'projectId' | 'sectionId'>;
  signal: AbortSignal;
  store: ProjectStore;
}

const saveGeneratedLessonAttempt = async ({
  forceRegenerate,
  job,
  researchDossier,
  result,
  signal,
  store,
}: PersistGeneratedLessonInput): Promise<DurableLessonGenerationResult> => {
  signal.throwIfAborted();
  const payload = parsePayload(job.payload);
  const latestRecord = await store.loadProjectWithRevision(job.userId, payload.projectId);
  if (!latestRecord) throw new Error('Project not found while saving generated lesson.');
  const { revision, snapshot: latestProject } = latestRecord;
  if (!findLessonSection(latestProject, payload.sectionId)) {
    throw new Error('Lesson was removed before generated content could be saved.');
  }
  if (!forceRegenerate || wasGenerationJobApplied(latestProject, payload.sectionId, job.id)) {
    const completed = readCompletedResult(latestProject, payload.sectionId, revision);
    if (completed) return completed;
  }
  const mergedDocumentAssets = mergeProjectDocumentAssets(
    latestProject,
    payload.sectionId,
    result.documentAssets,
    result.imageRefs
  );
  const persistedResult = mergedDocumentAssets
    ? { ...result, documentAssets: mergedDocumentAssets }
    : result;
  const documentAssetsPatch = mergedDocumentAssets
    ? { documentAssets: mergedDocumentAssets }
    : undefined;
  const visualPlanningPatch =
    result.visualPlanningDecision === undefined
      ? undefined
      : { visualPlanningDecision: result.visualPlanningDecision };
  const savedMeta = await store.patchProject(
    job.userId,
    payload.projectId,
    {
      ...documentAssetsPatch,
      researchDossiersBySectionId: {
        ...latestProject.researchDossiersBySectionId,
        [payload.sectionId]: researchDossier,
      },
      section: {
        content: result.content,
        contentBlocks: result.contentBlocks,
        generatedVisuals: result.generatedVisuals,
        imageRefs: result.imageRefs,
        learningAids: result.learningAids,
        lastGenerationJobId: job.id,
        quiz: result.quiz,
        sectionId: payload.sectionId,
        ...visualPlanningPatch,
      },
    },
    { expectedRevision: revision }
  );
  if (typeof savedMeta.revision === 'number') {
    publishProjectRevision(job.userId, {
      projectId: payload.projectId,
      revision: savedMeta.revision,
    });
  }
  return {
    ...persistedResult,
    projectId: payload.projectId,
    projectRevision: savedMeta.revision,
    researchDossier,
    sectionId: payload.sectionId,
  };
};

const persistGeneratedLesson = async (
  input: PersistGeneratedLessonInput
): Promise<DurableLessonGenerationResult> => {
  for (let attempt = 1; attempt <= MAX_LESSON_PERSIST_ATTEMPTS; attempt += 1) {
    try {
      return await saveGeneratedLessonAttempt(input);
    } catch (error) {
      if (error instanceof ProjectRevisionConflictError && attempt < MAX_LESSON_PERSIST_ATTEMPTS) {
        continue;
      }
      throw error;
    }
  }
  throw new Error('Generated lesson persistence attempts were exhausted.');
};

interface LessonGenerationDependencies {
  captionImage: typeof captionPdfImage;
  coverage: typeof selectPrerequisiteSourceCoverage;
  extractImages: typeof extractPdfImages;
  generate: GenerateLesson;
  getConfig: typeof getResolvedModelConfigForProvider;
  planYouTube: typeof planLessonYouTubeSearch;
  renderVisual: RenderLessonVisual;
  research: GenerateResearch;
  researchYouTube: ResearchYouTube;
  store: ProjectStore;
}

export const createLessonGenerationHandler =
  ({
    captionImage = async () => null,
    coverage = selectPrerequisiteSourceCoverage,
    generate = generateLesson,
    getConfig = getResolvedModelConfigForProvider,
    extractImages = extractPdfImages,
    renderVisual = renderLessonVisual,
    research = generateResearchSummary,
    researchYouTube = buildYouTubeResearchOutcome,
    planYouTube = async input => ({
      fallbackQuery: input.courseTitle,
      focusConcept: input.lessonTitle,
      specificQuery: input.lessonTitle,
    }),
    store = getProjectStore(),
  }: Partial<LessonGenerationDependencies> = {}) =>
  async (
    job: GenerationJob,
    signal: AbortSignal,
    reportStage: GenerationJobStageReporter = async () => {}
  ): Promise<unknown> => {
    const payload = parsePayload(job.payload);
    const projectRecord = await store.loadProjectWithRevision(job.userId, payload.projectId);
    if (!projectRecord) throw new Error('Project not found for lesson generation.');
    const { revision: projectRevision, snapshot: project } = projectRecord;
    const section = findLessonSection(project, payload.sectionId);
    if (!section) throw new Error('Lesson not found for generation.');
    if (!payload.forceRegenerate || wasGenerationJobApplied(project, payload.sectionId, job.id)) {
      const completed = readCompletedResult(project, payload.sectionId, projectRevision);
      if (completed) return completed;
    }
    await reportStage('sources');
    const { existingDossier, existingSources, sourceContext } = await resolveLessonSourceMaterials({
      project,
      projectId: payload.projectId,
      section,
      sectionId: payload.sectionId,
      signal,
      store,
      userId: job.userId,
    });
    const config = await getConfig(payload.aiProvider, payload.aiProviderOverrides);
    const youtubeOutcome = await researchLessonYouTube({
      config,
      existingDossier,
      jobId: job.id,
      planYouTube,
      project,
      researchYouTube,
      section,
      sectionId: payload.sectionId,
      signal,
    });
    const originalSources = readOriginalSourceNames(project, section);
    const discoveredYoutubeSources = youtubeOutcome ? youtubeSources(youtubeOutcome) : [];
    const researchSources = mergeSources(
      originalSources,
      existingSources,
      discoveredYoutubeSources
    );
    await reportStage('structure');
    const { availableImages, candidateImages, generationInput, sectionDescription, sectionTitle } =
      await prepareLessonGenerationInput({
        captionImage,
        config,
        coverage,
        existingDossier,
        extractImages,
        jobId: job.id,
        project,
        researchSources,
        section,
        sectionId: payload.sectionId,
        signal,
        sourceContext,
        store,
        userId: job.userId,
      });
    const { draft, lessonSources, researchSummary } = await createResearchedLessonDraft({
      discoveredYoutubeSources,
      existingDossier,
      existingSources,
      generate,
      generationInput,
      originalSources,
      research,
      reportStage,
      signal,
      youtubeOutcome,
    });
    const renderedVisualsBySlotId = await renderDraftVisuals({
      config,
      draft,
      renderVisual,
      sectionDescription,
      sectionTitle,
      signal,
    });
    const normalized = normalizeGeneratedLesson(draft, {
      availableImages: candidateImages,
      documentImages: availableImages,
      jobId: job.id,
      project,
      renderedVisualsBySlotId,
      sectionDescription,
      sectionTitle,
      sources: lessonSources,
    });
    const researchDossier = buildResearchDossier({
      contentBlocks: normalized.contentBlocks,
      existingDossier,
      lessonSources,
      researchSummary,
      sectionId: payload.sectionId,
      sectionTitle,
      youtubeOutcome,
    });
    return persistGeneratedLesson({
      forceRegenerate: payload.forceRegenerate === true,
      job,
      researchDossier,
      result: normalized,
      signal,
      store,
    });
  };

export const runLessonGenerationJob = createLessonGenerationHandler({
  captionImage: captionPdfImage,
  planYouTube: planLessonYouTubeSearch,
});
