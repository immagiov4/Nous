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
import { type GenerationJob, TransientGenerationJobError } from './generationJobs.js';
import {
  type GenerateLesson,
  type GenerateResearch,
  generateLesson,
  generateResearchSummary,
  type LessonGenerationDraft,
  type LessonGenerationInput,
  type LessonResearchSummary,
  normalizeGeneratedLesson,
  renderDraftVisuals,
} from './lessonGenerationModel.js';
import {
  buildArchiveSourceContext,
  buildMappedSourceContext,
  buildStoredDocumentSourceContext,
  extractStoredPdfImageAssets,
  mergePdfImageAssets,
  mergeProjectDocumentAssets,
  mergeSources,
  parseResearchSource,
  readExistingDossier,
  readExistingPdfImageAssets,
  readOriginalSourceNames,
  readProjectLanguage,
  toImageCandidate,
  youtubeSources,
} from './lessonGenerationSources.js';
import { type RenderLessonVisual, renderLessonVisual } from './lessonGenerationVisuals.js';
import { extractPdfImages } from './pdfImageExtractor.js';
import { buildYouTubeResearchOutcome, type YouTubeResearchOutcome } from './youtubeResearch.js';

interface LessonGenerationPayload {
  aiProvider?: AiProvider;
  aiProviderOverrides?: ModelProviderOverrides;
  forceRegenerate?: boolean;
  projectId: string;
  sectionId: string;
}

type ResearchYouTube = (query: string, language: string) => Promise<YouTubeResearchOutcome>;

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

const findSection = (project: ProjectSnapshot | null, sectionId: string) => {
  const modules = project?.learningPlan?.modules;
  if (!Array.isArray(modules)) return null;
  for (const module of modules) {
    const section = module.children?.find(
      child => child.id === sectionId && child.kind !== 'exercise'
    );
    if (section && isRecord(section)) return section;
  }
  return null;
};

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

const buildPedagogicalContext = (
  project: ProjectSnapshot,
  section: Record<string, unknown>
): string => {
  const parent =
    typeof section.parentId === 'string' ? findSection(project, section.parentId) : null;
  const syllabusItem = findNestedRecordById(project.syllabus, String(section.id));
  const researchLesson =
    isRecord(project.researchCoursePlan) && Array.isArray(project.researchCoursePlan.lessons)
      ? project.researchCoursePlan.lessons.find(
          candidate => isRecord(candidate) && candidate.id === section.id
        )
      : null;
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

const readCompletedResult = (
  project: ProjectSnapshot,
  sectionId: string,
  projectRevision?: number
): DurableLessonGenerationResult | null => {
  const section = findSection(project, sectionId);
  if (!section || typeof section.content !== 'string' || !section.content.trim()) return null;
  const researchDossier = readExistingDossier(project, sectionId);
  return {
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
    ...(section.visualPlanningDecision !== undefined
      ? { visualPlanningDecision: section.visualPlanningDecision }
      : {}),
  };
};

const wasGenerationJobApplied = (
  project: ProjectSnapshot,
  sectionId: string,
  jobId: string
): boolean => findSection(project, sectionId)?.lastGenerationJobId === jobId;

const persistGeneratedLesson = async ({
  forceRegenerate,
  job,
  result,
  researchDossier,
  signal,
  store,
}: {
  forceRegenerate: boolean;
  job: GenerationJob;
  researchDossier: Record<string, unknown>;
  result: Omit<DurableLessonGenerationResult, 'projectId' | 'sectionId'>;
  signal: AbortSignal;
  store: ProjectStore;
}): Promise<DurableLessonGenerationResult> => {
  const payload = parsePayload(job.payload);
  for (let attempt = 1; attempt <= MAX_LESSON_PERSIST_ATTEMPTS; attempt += 1) {
    signal.throwIfAborted();
    const latestRecord = await store.loadProjectWithRevision(job.userId, payload.projectId);
    if (!latestRecord) throw new Error('Project not found while saving generated lesson.');
    const { revision, snapshot: latestProject } = latestRecord;
    if (!findSection(latestProject, payload.sectionId)) {
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
    try {
      const savedMeta = await store.patchProject(
        job.userId,
        payload.projectId,
        {
          ...documentAssetsPatch,
          researchDossiersBySectionId: {
            ...(latestProject.researchDossiersBySectionId || {}),
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
    } catch (error) {
      if (error instanceof ProjectRevisionConflictError && attempt < MAX_LESSON_PERSIST_ATTEMPTS) {
        continue;
      }
      throw error;
    }
  }
  throw new Error('Generated lesson persistence attempts were exhausted.');
};

export const createLessonGenerationHandler =
  ({
    generate = generateLesson,
    getConfig = getResolvedModelConfigForProvider,
    extractImages = extractPdfImages,
    renderVisual = renderLessonVisual,
    research = generateResearchSummary,
    researchYouTube = buildYouTubeResearchOutcome,
    store = getProjectStore(),
  }: {
    generate?: GenerateLesson;
    getConfig?: typeof getResolvedModelConfigForProvider;
    extractImages?: typeof extractPdfImages;
    renderVisual?: RenderLessonVisual;
    research?: GenerateResearch;
    researchYouTube?: ResearchYouTube;
    store?: ProjectStore;
  } = {}) =>
  async (job: GenerationJob, signal: AbortSignal): Promise<unknown> => {
    const payload = parsePayload(job.payload);
    const projectRecord = await store.loadProjectWithRevision(job.userId, payload.projectId);
    if (!projectRecord) throw new Error('Project not found for lesson generation.');
    const { revision: projectRevision, snapshot: project } = projectRecord;
    const section = findSection(project, payload.sectionId);
    if (!section) throw new Error('Lesson not found for generation.');
    if (!payload.forceRegenerate || wasGenerationJobApplied(project, payload.sectionId, job.id)) {
      const completed = readCompletedResult(project, payload.sectionId, projectRevision);
      if (completed) return completed;
    }

    let sourceContext = await buildArchiveSourceContext(
      store,
      job.userId,
      payload.projectId,
      section
    );
    sourceContext ||= buildMappedSourceContext(project, section);
    if (!sourceContext && project.sourceKind === 'document') {
      sourceContext = await buildStoredDocumentSourceContext(
        store,
        job.userId,
        payload.projectId,
        section,
        signal
      );
      if (!sourceContext) {
        throw new Error('Stored lesson source is unavailable.');
      }
    }
    const existingDossier = readExistingDossier(project, payload.sectionId);
    const existingSources = Array.isArray(existingDossier?.sources)
      ? existingDossier.sources.flatMap(source => {
          const parsed = parseResearchSource(source);
          return parsed ? [parsed] : [];
        })
      : [];
    let youtubeOutcome: YouTubeResearchOutcome | null = null;
    if (!existingSources.some(source => source.youtubeTranscript)) {
      try {
        youtubeOutcome = await researchYouTube(
          `${typeof section.title === 'string' ? section.title : payload.sectionId} ${typeof section.description === 'string' ? section.description : ''}`,
          readProjectLanguage(project)
        );
      } catch (error) {
        console.warn('[Generation job] Optional YouTube research failed.', {
          error,
          jobId: job.id,
          sectionId: payload.sectionId,
        });
      }
    }
    const sources = mergeSources(
      readOriginalSourceNames(project, section),
      existingSources,
      youtubeOutcome ? youtubeSources(youtubeOutcome) : []
    );
    const previousLessonTitles = (project.learningPlan?.modules ?? []).flatMap(module =>
      (module.children ?? []).flatMap(candidate =>
        candidate.isCompleted && typeof candidate.title === 'string' ? [candidate.title] : []
      )
    );
    const config = await getConfig(payload.aiProvider, payload.aiProviderOverrides);
    const availableImages = mergePdfImageAssets(
      readExistingPdfImageAssets(project),
      await extractStoredPdfImageAssets({
        extractImages,
        project,
        section,
        signal,
        store,
        userId: job.userId,
      })
    );
    const generationInput = {
      config,
      description: typeof section.description === 'string' ? section.description : '',
      generationNotes:
        typeof project.learningPlan?.generationNotes === 'string'
          ? project.learningPlan.generationNotes
          : undefined,
      imageCandidates: availableImages.map(toImageCandidate),
      instructionPacks: Array.isArray(section.instructionPacks)
        ? section.instructionPacks.filter((pack): pack is string => typeof pack === 'string')
        : [],
      language: readProjectLanguage(project),
      pedagogicalContext: buildPedagogicalContext(project, section),
      previousLessonTitles,
      researchContext: '',
      sectionTitle: typeof section.title === 'string' ? section.title : payload.sectionId,
      signal,
      sourceContext,
      sources,
    } satisfies LessonGenerationInput;
    let researchSummary: LessonResearchSummary | null = null;
    if (!existingDossier) {
      try {
        researchSummary = await research(generationInput);
      } catch (error) {
        if (signal.aborted) throw error;
        throw new TransientGenerationJobError(
          'lesson_research_failed',
          'Lesson research provider failed.',
          { cause: error }
        );
      }
    }
    let draft: LessonGenerationDraft;
    try {
      draft = await generate({
        ...generationInput,
        researchContext: JSON.stringify(existingDossier || researchSummary || {}),
      });
    } catch (error) {
      if (signal.aborted) throw error;
      throw new TransientGenerationJobError('lesson_provider_failed', 'Lesson provider failed.', {
        cause: error,
      });
    }

    const sectionDescription = typeof section.description === 'string' ? section.description : '';
    const sectionTitle = typeof section.title === 'string' ? section.title : payload.sectionId;
    const renderedVisualsBySlotId = await renderDraftVisuals({
      config,
      draft,
      renderVisual,
      sectionDescription,
      sectionTitle,
      signal,
    });
    const normalized = normalizeGeneratedLesson(draft, {
      availableImages,
      jobId: job.id,
      project,
      renderedVisualsBySlotId,
      sources,
    });
    const selectedVideoUrls = new Set(
      normalized.contentBlocks.flatMap(block =>
        block.type === 'youtube-clips'
          ? block.clips.flatMap(clip => {
              const url = sources[clip.sourceIndex]?.url;
              return url ? [url] : [];
            })
          : []
      )
    );
    const researchedWebSources = (researchSummary?.sources || []).flatMap(source => {
      const url = source.url.trim();
      if (!url) return [];
      try {
        const parsed = new URL(url);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return [];
        return [
          {
            note: source.note.trim() || 'Fonte web consultata per questa lezione',
            title: source.title.trim() || parsed.hostname,
            url: parsed.href,
          },
        ];
      } catch {
        return [];
      }
    });
    const researchDossier = {
      ...(existingDossier || {}),
      sectionId: payload.sectionId,
      title: typeof section.title === 'string' ? section.title : payload.sectionId,
      ...(researchSummary
        ? {
            generatedAt: new Date().toISOString(),
            factualSummary: researchSummary.factualSummary.trim(),
            keyExamples: researchSummary.keyExamples,
            difficultSteps: researchSummary.difficultSteps,
            avoidOversimplifying: researchSummary.avoidOversimplifying,
            controversies: researchSummary.controversies,
            recentDevelopments: researchSummary.recentDevelopments,
          }
        : {}),
      sources: mergeSources(sources, researchedWebSources),
      youtubeResearch: youtubeOutcome
        ? {
            candidateDecisions: youtubeOutcome.videoCandidates.map(video => ({
              decision: selectedVideoUrls.has(video.url) ? 'selected-source' : 'rejected',
              reason: selectedVideoUrls.has(video.url)
                ? 'La lezione usa una clip tratta da questo transcript.'
                : 'Il transcript non è stato usato nei micro-capitoli della lezione.',
              url: video.url,
            })),
            outcome: 'completed',
            rationale: youtubeOutcome.rationale,
          }
        : isRecord(existingDossier?.youtubeResearch)
          ? existingDossier.youtubeResearch
          : {
              candidateDecisions: [],
              outcome: 'failed',
              rationale: 'Nessun transcript video disponibile per questa generazione.',
            },
    };
    return persistGeneratedLesson({
      forceRegenerate: payload.forceRegenerate === true,
      job,
      researchDossier,
      result: normalized,
      signal,
      store,
    });
  };

export const runLessonGenerationJob = createLessonGenerationHandler();
