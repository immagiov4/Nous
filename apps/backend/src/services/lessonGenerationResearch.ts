import type { ProjectSnapshot } from '../projects/types.js';
import { isRecord } from '../utils/validation.js';
import { retryLessonGenerationCorrection } from './lessonGenerationCorrection.js';
import { mergeSources, type ResearchSource } from './lessonGenerationSources.js';
import type {
  GenerateResearch,
  LessonGenerationInput,
  LessonResearchSummary,
  NormalizedLessonBlock,
} from './lessonGenerationTypes.js';
import type { YouTubeResearchOutcome } from './youtubeResearch.js';

export type ResearchYouTube = (
  query: string,
  language: string,
  signal: AbortSignal
) => Promise<YouTubeResearchOutcome>;

export const findResearchLesson = (
  project: ProjectSnapshot,
  sectionId: string
): Record<string, unknown> | null =>
  isRecord(project.researchCoursePlan) && Array.isArray(project.researchCoursePlan.lessons)
    ? (project.researchCoursePlan.lessons.find(
        candidate => isRecord(candidate) && candidate.id === sectionId
      ) as Record<string, unknown> | undefined) || null
    : null;

export const generateLessonResearchSummary = async ({
  existingDossier,
  generationInput,
  research,
  youtubeOutcome,
}: {
  existingDossier: Record<string, unknown> | null;
  generationInput: LessonGenerationInput;
  research: GenerateResearch;
  youtubeOutcome: YouTubeResearchOutcome | null;
}): Promise<LessonResearchSummary | null> => {
  if (existingDossier && !generationInput.refreshResearch) return null;
  if (!shouldGenerateLessonResearch(generationInput) && !youtubeOutcome?.videoCandidates.length) {
    return null;
  }
  const summary = await research(generationInput);
  if (youtubeOutcome?.videoCandidates.length) {
    const decisions = summary.youtubeCandidateDecisions ?? [];
    const decisionUrls = new Set(decisions.map(decision => decision.url));
    if (
      decisions.length !== youtubeOutcome.videoCandidates.length ||
      decisionUrls.size !== youtubeOutcome.videoCandidates.length ||
      youtubeOutcome.videoCandidates.some(video => !decisionUrls.has(video.url))
    ) {
      throw retryLessonGenerationCorrection({
        code: 'lesson_research_candidate_classification_incomplete',
        feedback:
          'Return exactly one youtubeCandidateDecisions entry for every supplied YouTube candidate URL. Preserve each URL exactly once and classify it as selected-source or rejected with a concise reason.',
        message: 'The lesson research did not classify every YouTube candidate.',
      });
    }
  }
  return summary;
};

export const shouldGenerateLessonResearch = (
  generationInput: Pick<LessonGenerationInput, 'coverageGaps' | 'refreshResearch' | 'sourceContext'>
): boolean =>
  generationInput.refreshResearch ||
  !generationInput.sourceContext.trim() ||
  Boolean(generationInput.coverageGaps?.length);

export const selectLessonSources = ({
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
  generatedAt,
  lessonSources,
  researchSummary,
  sectionId,
  sectionTitle,
  youtubeOutcome,
}: {
  contentBlocks: NormalizedLessonBlock[];
  existingDossier: Record<string, unknown> | null;
  generatedAt?: string;
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
      generatedAt: generatedAt ?? new Date().toISOString(),
      keyExamples: researchSummary.keyExamples,
      recentDevelopments: researchSummary.recentDevelopments,
    });
  }
  return dossier;
};
