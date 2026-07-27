import { normalizeLessonInstructionPacks } from '@shared/lessonInstructionPacks';

import type { GlobalModelConfig } from '../config/modelConfig.js';
import type { ProjectSnapshot, ProjectStore } from '../projects/types.js';
import { isRecord } from '../utils/validation.js';
import { TransientGenerationJobError } from './generationJobs.js';
import type { selectPrerequisiteSourceCoverage } from './lessonGenerationCoverage.js';
import { selectCandidatePdfImages, toImageCandidate } from './lessonGenerationImages.js';
import { findResearchLesson } from './lessonGenerationResearch.js';
import {
  buildArchiveSourceContext,
  buildMappedSourceContext,
  buildStoredDocumentSourceContext,
  extractStoredPdfImageAssets,
  isPdfAssetSoftTimeoutError,
  type LessonPdfImageAsset,
  mergePdfImageAssets,
  parseResearchSource,
  type ResearchSource,
  readExistingDossier,
  readExistingPdfImageAssets,
  readMappedPdfPages,
  readProjectLanguage,
  withPdfAssetSoftTimeout,
} from './lessonGenerationSources.js';
import type { LessonGenerationInput } from './lessonGenerationTypes.js';
import type { captionPdfImage } from './pdfImageCaption.js';
import type { extractPdfImages } from './pdfImageExtractor.js';

const findNestedRecordById = (values: unknown, id: string): Record<string, unknown> | null => {
  if (!Array.isArray(values)) return null;
  for (const value of values) {
    if (!isRecord(value)) continue;
    if (value.id === id) return value;
    const child = findNestedRecordById(value.children, id);
    if (child) return child;
  }
  return null;
};

export const findLessonSection = (
  project: ProjectSnapshot,
  sectionId: string
): Record<string, unknown> | null => {
  const modules = project.learningPlan?.modules;
  if (!Array.isArray(modules)) return null;
  for (const module of modules) {
    const section = module.children?.find(
      child => child.id === sectionId && child.kind !== 'exercise'
    );
    if (section && isRecord(section)) return section;
  }
  return null;
};

const buildPedagogicalContext = (
  project: ProjectSnapshot,
  section: Record<string, unknown>
): string => {
  const parent =
    typeof section.parentId === 'string' ? findLessonSection(project, section.parentId) : null;
  const syllabusItem = findNestedRecordById(project.syllabus, String(section.id));
  const researchLesson = findResearchLesson(project, String(section.id));
  return [
    typeof section.contextPrompt === 'string' && section.contextPrompt.trim()
      ? `OBIETTIVO SPECIFICO DELLA LEZIONE:\n${section.contextPrompt.trim()}`
      : '',
    parent
      ? `CONTESTO DELLA LEZIONE PADRE:\n${JSON.stringify({
          content: typeof parent.content === 'string' ? parent.content : '',
          description: typeof parent.description === 'string' ? parent.description : '',
          title: typeof parent.title === 'string' ? parent.title : '',
        })}`
      : '',
    project.userProfile
      ? `PROFILO DIDATTICO DELL'UTENTE:\n${JSON.stringify(project.userProfile)}`
      : '',
    syllabusItem ? `VOCE DI SYLLABUS:\n${JSON.stringify(syllabusItem)}` : '',
    researchLesson ? `PIANO DI RICERCA DELLA LEZIONE:\n${JSON.stringify(researchLesson)}` : '',
  ]
    .filter(Boolean)
    .join('\n\n');
};

const readPreviousLessonTitles = (project: ProjectSnapshot): string[] =>
  (project.learningPlan?.modules ?? []).flatMap(module =>
    (module.children ?? []).flatMap(candidate =>
      candidate.isCompleted && typeof candidate.title === 'string' ? [candidate.title] : []
    )
  );

export const resolveLessonSourceMaterials = async ({
  project,
  projectId,
  section,
  sectionId,
  signal,
  store,
  userId,
}: {
  project: ProjectSnapshot;
  projectId: string;
  section: Record<string, unknown>;
  sectionId: string;
  signal: AbortSignal;
  store: ProjectStore;
  userId: string;
}) => {
  const archiveContext = await buildArchiveSourceContext(store, userId, projectId, section);
  let sourceContext = archiveContext || buildMappedSourceContext(project, section);
  if (!sourceContext && project.sourceKind === 'document') {
    sourceContext = await buildStoredDocumentSourceContext(
      store,
      userId,
      projectId,
      section,
      signal
    );
    if (!sourceContext) throw new Error('Stored lesson source is unavailable.');
  }
  const existingDossier = readExistingDossier(project, sectionId);
  const existingSources = Array.isArray(existingDossier?.sources)
    ? existingDossier.sources.flatMap(source => {
        const parsed = parseResearchSource(source);
        return parsed ? [parsed] : [];
      })
    : [];
  return { existingDossier, existingSources, sourceContext };
};

const selectCoverageGaps = async ({
  config,
  coverage,
  existingDossier,
  section,
  sectionId,
  signal,
  sourceContext,
}: {
  config: GlobalModelConfig;
  coverage: typeof selectPrerequisiteSourceCoverage;
  existingDossier: Record<string, unknown> | null;
  section: Record<string, unknown>;
  sectionId: string;
  signal: AbortSignal;
  sourceContext: string;
}): Promise<string[] | undefined> => {
  if (section.type !== 'prerequisite' || existingDossier) return undefined;
  const decision = await coverage({
    config,
    description: typeof section.description === 'string' ? section.description : '',
    signal,
    sourceContext,
    title: typeof section.title === 'string' ? section.title : sectionId,
  });
  return decision.needsResearch ? decision.missingTopics : undefined;
};

const extractLessonPdfImages = async ({
  captionImage,
  config,
  extractImages,
  jobId,
  project,
  section,
  sectionId,
  signal,
  store,
  userId,
}: {
  captionImage: typeof captionPdfImage;
  config: GlobalModelConfig;
  extractImages: typeof extractPdfImages;
  jobId: string;
  project: ProjectSnapshot;
  section: Record<string, unknown>;
  sectionId: string;
  signal: AbortSignal;
  store: ProjectStore;
  userId: string;
}): Promise<LessonPdfImageAsset[]> => {
  try {
    return await withPdfAssetSoftTimeout(
      operationSignal =>
        extractStoredPdfImageAssets({
          captionImage,
          config,
          extractImages,
          project,
          section,
          signal: operationSignal,
          store,
          userId,
        }),
      signal
    );
  } catch (error) {
    if (!isPdfAssetSoftTimeoutError(error)) throw error;
    console.warn('[Generation job] PDF image extraction timed out; continuing text-only.', {
      jobId,
      sectionId,
    });
    return [];
  }
};

export const prepareLessonGenerationInput = async ({
  captionImage,
  config,
  coverage,
  existingDossier,
  extractImages,
  jobId,
  project,
  researchSources,
  section,
  sectionId,
  signal,
  sourceContext,
  store,
  userId,
}: {
  captionImage: typeof captionPdfImage;
  config: GlobalModelConfig;
  coverage: typeof selectPrerequisiteSourceCoverage;
  existingDossier: Record<string, unknown> | null;
  extractImages: typeof extractPdfImages;
  jobId: string;
  project: ProjectSnapshot;
  researchSources: ResearchSource[];
  section: Record<string, unknown>;
  sectionId: string;
  signal: AbortSignal;
  sourceContext: string;
  store: ProjectStore;
  userId: string;
}) => {
  let coverageGaps: string[] | undefined;
  try {
    coverageGaps = await selectCoverageGaps({
      config,
      coverage,
      existingDossier,
      section,
      sectionId,
      signal,
      sourceContext,
    });
  } catch (error) {
    if (signal.aborted) throw error;
    throw new TransientGenerationJobError(
      'lesson_coverage_failed',
      'Lesson source coverage provider failed.',
      { cause: error }
    );
  }
  const sectionDescription = typeof section.description === 'string' ? section.description : '';
  const sectionTitle = typeof section.title === 'string' ? section.title : sectionId;
  const extractedImages = await extractLessonPdfImages({
    captionImage,
    config,
    extractImages,
    jobId,
    project,
    section,
    sectionId,
    signal,
    store,
    userId,
  });
  const availableImages = mergePdfImageAssets(readExistingPdfImageAssets(project), extractedImages);
  const candidateImages = selectCandidatePdfImages(
    availableImages,
    sectionTitle,
    sectionDescription,
    readMappedPdfPages(project, section) || []
  );
  const generationInput: LessonGenerationInput = {
    config,
    coverageGaps,
    description: sectionDescription,
    generationNotes:
      typeof project.learningPlan?.generationNotes === 'string'
        ? project.learningPlan.generationNotes
        : undefined,
    imageCandidates: candidateImages.map(image =>
      toImageCandidate(image, sectionTitle, sectionDescription)
    ),
    instructionPacks: Array.isArray(section.instructionPacks)
      ? normalizeLessonInstructionPacks(section.instructionPacks)
      : [],
    language: readProjectLanguage(project),
    pedagogicalContext: buildPedagogicalContext(project, section),
    previousLessonTitles: readPreviousLessonTitles(project),
    researchContext: '',
    sectionTitle,
    signal,
    sourceContext,
    sources: researchSources,
  };
  return { availableImages, candidateImages, generationInput, sectionDescription, sectionTitle };
};
