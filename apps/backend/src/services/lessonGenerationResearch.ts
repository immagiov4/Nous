import type { GlobalModelConfig } from '../config/modelConfig.js';
import type { ProjectSnapshot } from '../projects/types.js';
import { isRecord } from '../utils/validation.js';
import { type GenerationJobStageReporter, TransientGenerationJobError } from './generationJobs.js';
import {
  mergeSources,
  type ResearchSource,
  readProjectLanguage,
} from './lessonGenerationSources.js';
import type {
  GenerateLesson,
  GenerateResearch,
  LessonGenerationDraft,
  LessonGenerationInput,
  LessonResearchSummary,
  NormalizedLessonBlock,
} from './lessonGenerationTypes.js';
import type { planLessonYouTubeSearch } from './lessonYouTubePlanning.js';
import type { YouTubeResearchOutcome } from './youtubeResearch.js';

export type ResearchYouTube = (query: string, language: string) => Promise<YouTubeResearchOutcome>;

export const findResearchLesson = (
  project: ProjectSnapshot,
  sectionId: string
): Record<string, unknown> | null =>
  isRecord(project.researchCoursePlan) && Array.isArray(project.researchCoursePlan.lessons)
    ? (project.researchCoursePlan.lessons.find(
        candidate => isRecord(candidate) && candidate.id === sectionId
      ) as Record<string, unknown> | undefined) || null
    : null;

const readLessonKeyConcepts = (
  researchLesson: Record<string, unknown> | null
): string[] | undefined => {
  if (!Array.isArray(researchLesson?.keyConcepts)) return undefined;
  return researchLesson.keyConcepts.filter(
    (concept): concept is string => typeof concept === 'string'
  );
};

export const researchLessonYouTube = async ({
  config,
  existingDossier,
  jobId,
  planYouTube,
  project,
  researchYouTube,
  section,
  sectionId,
  signal,
}: {
  config: GlobalModelConfig;
  existingDossier: Record<string, unknown> | null;
  jobId: string;
  planYouTube: typeof planLessonYouTubeSearch;
  project: ProjectSnapshot;
  researchYouTube: ResearchYouTube;
  section: Record<string, unknown>;
  sectionId: string;
  signal: AbortSignal;
}): Promise<YouTubeResearchOutcome | null> => {
  if (existingDossier) return null;
  try {
    const researchLesson = findResearchLesson(project, sectionId);
    const language = readProjectLanguage(project);
    const searchPlan = await planYouTube({
      config,
      context: typeof section.contextPrompt === 'string' ? section.contextPrompt : undefined,
      courseTitle: project.learningPlan?.title || '',
      keyConcepts: readLessonKeyConcepts(researchLesson),
      language,
      lessonDescription: typeof section.description === 'string' ? section.description : '',
      lessonTitle: typeof section.title === 'string' ? section.title : sectionId,
      practicalTask:
        typeof researchLesson?.miniLab === 'string' ? researchLesson.miniLab : undefined,
      signal,
    });
    const specificOutcome = await researchYouTube(searchPlan.specificQuery, language);
    if (
      specificOutcome.discoveredVideoCount > 0 ||
      searchPlan.fallbackQuery === searchPlan.specificQuery
    ) {
      return specificOutcome;
    }
    return researchYouTube(searchPlan.fallbackQuery, language);
  } catch (error) {
    console.warn('[Generation job] Optional YouTube research failed.', {
      error,
      jobId,
      sectionId,
    });
    return null;
  }
};

const researchLessonContent = async ({
  existingDossier,
  generationInput,
  research,
  signal,
  youtubeOutcome,
}: {
  existingDossier: Record<string, unknown> | null;
  generationInput: LessonGenerationInput;
  research: GenerateResearch;
  signal: AbortSignal;
  youtubeOutcome: YouTubeResearchOutcome | null;
}): Promise<LessonResearchSummary | null> => {
  if (existingDossier) return null;
  try {
    const summary = await research(generationInput);
    if (youtubeOutcome?.videoCandidates.length) {
      const decisionUrls = new Set(
        summary.youtubeCandidateDecisions?.map(decision => decision.url) || []
      );
      if (
        decisionUrls.size !== youtubeOutcome.videoCandidates.length ||
        youtubeOutcome.videoCandidates.some(video => !decisionUrls.has(video.url))
      ) {
        throw new Error('Lesson research did not classify every YouTube candidate.');
      }
    }
    return summary;
  } catch (error) {
    if (signal.aborted) throw error;
    throw new TransientGenerationJobError(
      'lesson_research_failed',
      'Lesson research provider failed.',
      { cause: error }
    );
  }
};

const selectLessonSources = ({
  discoveredYoutubeSources,
  existingSources,
  originalSources,
  researchSummary,
}: {
  discoveredYoutubeSources: ResearchSource[];
  existingSources: ResearchSource[];
  originalSources: ResearchSource[];
  researchSummary: LessonResearchSummary | null;
}): ResearchSource[] => {
  if (!researchSummary?.youtubeCandidateDecisions) {
    return mergeSources(originalSources, existingSources, discoveredYoutubeSources);
  }
  const selectedUrls = new Set(
    researchSummary.youtubeCandidateDecisions
      .filter(decision => decision.decision === 'selected-source')
      .map(decision => decision.url)
  );
  return mergeSources(
    originalSources,
    existingSources,
    discoveredYoutubeSources.filter(source => source.url && selectedUrls.has(source.url))
  );
};

const generateLessonDraft = async ({
  existingDossier,
  generate,
  generationInput,
  lessonSources,
  researchSummary,
  signal,
}: {
  existingDossier: Record<string, unknown> | null;
  generate: GenerateLesson;
  generationInput: LessonGenerationInput;
  lessonSources: ResearchSource[];
  researchSummary: LessonResearchSummary | null;
  signal: AbortSignal;
}): Promise<LessonGenerationDraft> => {
  try {
    return await generate({
      ...generationInput,
      researchContext: JSON.stringify(existingDossier || researchSummary || {}),
      sources: lessonSources,
    });
  } catch (error) {
    if (signal.aborted) throw error;
    throw new TransientGenerationJobError('lesson_provider_failed', 'Lesson provider failed.', {
      cause: error,
    });
  }
};

export const createResearchedLessonDraft = async ({
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
}: {
  discoveredYoutubeSources: ResearchSource[];
  existingDossier: Record<string, unknown> | null;
  existingSources: ResearchSource[];
  generate: GenerateLesson;
  generationInput: LessonGenerationInput;
  originalSources: ResearchSource[];
  research: GenerateResearch;
  reportStage: GenerationJobStageReporter;
  signal: AbortSignal;
  youtubeOutcome: YouTubeResearchOutcome | null;
}) => {
  const researchSummary = await researchLessonContent({
    existingDossier,
    generationInput,
    research,
    signal,
    youtubeOutcome,
  });
  const lessonSources = selectLessonSources({
    discoveredYoutubeSources,
    existingSources,
    originalSources,
    researchSummary,
  });
  await reportStage('drafting');
  const draft = await generateLessonDraft({
    existingDossier,
    generate,
    generationInput: { ...generationInput, onProgressStage: reportStage },
    lessonSources,
    researchSummary,
    signal,
  });
  return { draft, lessonSources, researchSummary };
};

const collectSelectedVideoUrls = (
  contentBlocks: NormalizedLessonBlock[],
  lessonSources: ResearchSource[]
): Set<string> =>
  new Set(
    contentBlocks.flatMap(block =>
      block.type === 'youtube-clips'
        ? block.clips.flatMap(clip => {
            const url = lessonSources[clip.sourceIndex]?.url;
            return url ? [url] : [];
          })
        : []
    )
  );

const normalizeResearchedWebSources = (
  researchSummary: LessonResearchSummary | null
): ResearchSource[] =>
  (researchSummary?.sources || []).flatMap(source => {
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

const buildYouTubeResearchRecord = ({
  existingDossier,
  researchSummary,
  selectedVideoUrls,
  youtubeOutcome,
}: {
  existingDossier: Record<string, unknown> | null;
  researchSummary: LessonResearchSummary | null;
  selectedVideoUrls: Set<string>;
  youtubeOutcome: YouTubeResearchOutcome | null;
}): Record<string, unknown> => {
  if (youtubeOutcome) {
    const candidateDecisions =
      researchSummary?.youtubeCandidateDecisions ||
      youtubeOutcome.videoCandidates.map(video => {
        const selected = selectedVideoUrls.has(video.url);
        return {
          decision: selected ? 'selected-source' : 'rejected',
          reason: selected
            ? 'La lezione usa una clip tratta da questo transcript.'
            : 'Il transcript non e stato usato nei micro-capitoli della lezione.',
          url: video.url,
        };
      });
    return {
      candidateDecisions,
      outcome: 'completed',
      rationale: youtubeOutcome.rationale,
    };
  }
  if (isRecord(existingDossier?.youtubeResearch)) return existingDossier.youtubeResearch;
  return {
    candidateDecisions: [],
    outcome: 'failed',
    rationale: 'Nessun transcript video disponibile per questa generazione.',
  };
};

export const buildResearchDossier = ({
  contentBlocks,
  existingDossier,
  lessonSources,
  researchSummary,
  sectionId,
  sectionTitle,
  youtubeOutcome,
}: {
  contentBlocks: NormalizedLessonBlock[];
  existingDossier: Record<string, unknown> | null;
  lessonSources: ResearchSource[];
  researchSummary: LessonResearchSummary | null;
  sectionId: string;
  sectionTitle: string;
  youtubeOutcome: YouTubeResearchOutcome | null;
}): Record<string, unknown> => {
  const dossier: Record<string, unknown> = {
    ...existingDossier,
    sectionId,
    sources: mergeSources(lessonSources, normalizeResearchedWebSources(researchSummary)),
    title: sectionTitle,
    youtubeResearch: buildYouTubeResearchRecord({
      existingDossier,
      researchSummary,
      selectedVideoUrls: collectSelectedVideoUrls(contentBlocks, lessonSources),
      youtubeOutcome,
    }),
  };
  if (researchSummary) {
    Object.assign(dossier, {
      avoidOversimplifying: researchSummary.avoidOversimplifying,
      controversies: researchSummary.controversies,
      difficultSteps: researchSummary.difficultSteps,
      factualSummary: researchSummary.factualSummary.trim(),
      generatedAt: new Date().toISOString(),
      keyExamples: researchSummary.keyExamples,
      recentDevelopments: researchSummary.recentDevelopments,
    });
  }
  return dossier;
};
