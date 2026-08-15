import type { GlobalModelConfig } from '../config/modelConfig.js';
import { findProjectLessonSection } from '../projects/projectLesson.js';
import type { ProjectSnapshot, ProjectStore } from '../projects/types.js';
import type { GenerateLessonLearningAidsInput } from '../services/lessonGenerationAids.js';
import type { PrerequisiteCoverageDecision } from '../services/lessonGenerationCoverage.js';
import {
  buildLessonGenerationInput,
  buildLessonPedagogicalContext,
  readPreviousLessonTitles,
} from '../services/lessonGenerationPreparation.js';
import {
  findResearchLesson,
  generateLessonResearchSummary,
  type ResearchYouTube,
  selectLessonSources,
} from '../services/lessonGenerationResearch.js';
import {
  LessonSourceUnavailableError,
  mergeSources,
  type ResearchSource,
  readOriginalSourceNames,
  youtubeSources,
} from '../services/lessonGenerationSources.js';
import type {
  GenerateLessonContent,
  GenerateResearch,
  LessonContentDraft,
  LessonGenerationInput,
} from '../services/lessonGenerationTypes.js';
import type {
  LessonYouTubeSearchInput,
  LessonYouTubeSearchPlan,
} from '../services/lessonYouTubePlanning.js';
import { isRecord } from '../utils/validation.js';
import {
  buildLessonGenerationSourceFingerprint,
  buildLessonGenerationTargetFingerprint,
} from './lessonGenerationAuthority.js';
import type { LessonGenerationWorkflowServices } from './lessonGenerationWorkflow.js';
import type {
  LessonContextState,
  LessonGenerationPreparationOutcome,
  LessonSourcesState,
} from './lessonGenerationWorkflowContract.js';
import {
  LessonDocumentAssetsSchema,
  LessonGenerationWarningSchema,
  LessonLearningAidSchema,
  LessonPdfImageReferenceSchema,
  LessonQuizSchema,
  LessonResearchDossierSchema,
  LessonResultBlockSchema,
  LessonVisualPlanningDecisionSchema,
  ProjectLessonVisualSchema,
} from './lessonGenerationWorkflowSchemas.js';
import { failPermanently, readRetryAfterMs } from './retryPolicy.js';
import { canonicalJson } from './schemaFingerprint.js';
import { toWorkflowErrorDiagnostic } from './workflowErrorDiagnostics.js';

interface LessonStageLogger {
  warn(message: string, context: Record<string, unknown>): void;
}

export interface LessonGenerationStageDependencies {
  readonly generateAids: (input: GenerateLessonLearningAidsInput) => Promise<readonly unknown[]>;
  readonly generateContent: GenerateLessonContent;
  readonly generateResearch: GenerateResearch;
  readonly loadProject: ProjectStore['loadProject'];
  readonly loadProjectWithRevision: ProjectStore['loadProjectWithRevision'];
  readonly logger?: LessonStageLogger;
  readonly planYouTube: (input: LessonYouTubeSearchInput) => Promise<LessonYouTubeSearchPlan>;
  readonly researchYouTube: ResearchYouTube;
  readonly resolveSourceMaterials: (input: {
    project: ProjectSnapshot;
    projectId: string;
    section: Record<string, unknown>;
    sectionId: string;
    signal: AbortSignal;
    store: ProjectStore;
    userId: string;
  }) => Promise<{
    existingDossier: Record<string, unknown> | null;
    existingSources: ResearchSource[];
    sourceContext: string;
  }>;
  readonly reviewContent: (input: {
    draft: LessonContentDraft;
    generationInput: LessonGenerationInput;
  }) => Promise<LessonContentDraft>;
  readonly selectCoverage: (input: {
    config: GlobalModelConfig;
    description: string;
    signal: AbortSignal;
    sourceContext: string;
    title: string;
  }) => Promise<PrerequisiteCoverageDecision>;
  readonly store?: ProjectStore;
}

const defaultLogger: LessonStageLogger = {
  warn: (message, context) => console.warn(`[Workflow] ${message}`, context),
};

const parseJsonRecord = (value: string | null): Record<string, unknown> | null => {
  if (value === null) return null;
  const parsed: unknown = JSON.parse(value);
  if (!isRecord(parsed)) throw new Error('Durable lesson dossier is invalid.');
  return parsed;
};

type LessonGenerationInputState = Pick<
  LessonContextState,
  'existingSources' | 'lessonInputData' | 'request'
>;

const buildGenerationInput = (
  state: LessonGenerationInputState,
  config: GlobalModelConfig,
  signal: AbortSignal,
  sources: ResearchSource[] = state.existingSources
): LessonGenerationInput => ({
  ...state.lessonInputData,
  config,
  refreshResearch: state.request.forceRegenerate,
  researchContext: '',
  signal,
  sources,
});

const modelConfig = (context: { config: { readonly models: unknown } }): GlobalModelConfig =>
  context.config.models as GlobalModelConfig;

const readDocumentSourceHash = (project: ProjectSnapshot): string | null => {
  if (!isRecord(project.source) || !isRecord(project.source.ref)) return null;
  return typeof project.source.ref.hash === 'string' &&
    /^[a-f0-9]{64}$/u.test(project.source.ref.hash)
    ? project.source.ref.hash
    : null;
};

const readResearchKeyConcepts = (project: ProjectSnapshot, sectionId: string): string[] => {
  const lesson = findResearchLesson(project, sectionId);
  return Array.isArray(lesson?.keyConcepts)
    ? lesson.keyConcepts.filter((value): value is string => typeof value === 'string')
    : [];
};

const readCompletedResult = (
  project: ProjectSnapshot,
  sectionId: string,
  projectRevision: number
): LessonGenerationPreparationOutcome | null => {
  const section = findProjectLessonSection(project, sectionId);
  if (!section || typeof section.content !== 'string' || !section.content.trim()) return null;
  const contentBlocks = Array.isArray(section.contentBlocks)
    ? section.contentBlocks.flatMap(block => {
        const parsed = LessonResultBlockSchema.safeParse(block);
        return parsed.success ? [parsed.data] : [];
      })
    : [];
  const generatedVisuals = Array.isArray(section.generatedVisuals)
    ? section.generatedVisuals.flatMap(visual => {
        const parsed = ProjectLessonVisualSchema.safeParse(visual);
        return parsed.success ? [parsed.data] : [];
      })
    : [];
  const learningAids = Array.isArray(section.learningAids)
    ? section.learningAids.flatMap(aid => {
        const parsed = LessonLearningAidSchema.safeParse(aid);
        return parsed.success ? [parsed.data] : [];
      })
    : [];
  const generationWarnings = Array.isArray(section.generationWarnings)
    ? section.generationWarnings.flatMap(warning => {
        const parsed = LessonGenerationWarningSchema.safeParse(warning);
        return parsed.success ? [parsed.data] : [];
      })
    : [];
  const visualPlanning = LessonVisualPlanningDecisionSchema.safeParse(
    section.visualPlanningDecision
  );
  const documentAssets = LessonDocumentAssetsSchema.safeParse(project.documentAssets);
  const researchDossier = LessonResearchDossierSchema.safeParse(
    project.researchDossiersBySectionId?.[sectionId]
  );
  return {
    kind: 'already-completed',
    result: {
      alreadyCompleted: true,
      content: section.content,
      contentBlocks,
      ...(documentAssets.success ? { documentAssets: documentAssets.data } : {}),
      generatedVisuals,
      imageRefs: Array.isArray(section.imageRefs)
        ? section.imageRefs.flatMap(reference => {
            const parsed = LessonPdfImageReferenceSchema.safeParse(reference);
            return parsed.success ? [parsed.data] : [];
          })
        : [],
      learningAids,
      projectId: project.id,
      projectRevision,
      quiz: Array.isArray(section.quiz)
        ? section.quiz.flatMap(question => {
            const parsed = LessonQuizSchema.safeParse(question);
            return parsed.success ? [parsed.data] : [];
          })
        : [],
      ...(researchDossier.success ? { researchDossier: researchDossier.data } : {}),
      sectionId,
      ...(visualPlanning.success ? { visualPlanningDecision: visualPlanning.data } : {}),
      warnings: generationWarnings,
    },
  };
};

const shouldReadCompletedLesson = ({
  forceRegenerate,
  lastGenerationRunId,
  runId,
}: {
  forceRegenerate: boolean;
  lastGenerationRunId: unknown;
  runId: string;
}) => !forceRegenerate || lastGenerationRunId === runId;

const prepareLesson =
  (
    dependencies: LessonGenerationStageDependencies
  ): LessonGenerationWorkflowServices['prepareLesson'] =>
  async context => {
    const { forceRegenerate, projectId, sectionId, userId } = context.input;
    const record = await dependencies.loadProjectWithRevision(userId, projectId);
    if (!record) throw new Error('Lesson generation project is missing.');
    const section = findProjectLessonSection(record.snapshot, sectionId);
    if (!section) throw new Error('Lesson generation target is missing.');
    const completed = shouldReadCompletedLesson({
      forceRegenerate,
      lastGenerationRunId: section.lastGenerationRunId,
      runId: context.execution.runId,
    })
      ? readCompletedResult(record.snapshot, sectionId, record.revision)
      : null;
    if (completed) return completed;
    if (!dependencies.store) {
      throw new Error('Lesson source store is unavailable.');
    }
    let sourceMaterials: Awaited<
      ReturnType<LessonGenerationStageDependencies['resolveSourceMaterials']>
    >;
    try {
      sourceMaterials = await dependencies.resolveSourceMaterials({
        project: record.snapshot,
        projectId,
        section,
        sectionId,
        signal: context.signal,
        store: dependencies.store,
        userId,
      });
    } catch (error) {
      context.signal.throwIfAborted();
      if (error instanceof LessonSourceUnavailableError) {
        throw failPermanently({
          code: 'lesson_source_unavailable',
          message: 'The lesson source is unavailable.',
        });
      }
      throw error;
    }
    const originalSources = readOriginalSourceNames(record.snapshot, section);
    const { generationInput } = buildLessonGenerationInput({
      config: modelConfig(context),
      project: record.snapshot,
      refreshResearch: forceRegenerate,
      researchSources: mergeSources(originalSources, sourceMaterials.existingSources),
      section,
      sectionId,
      signal: context.signal,
      sourceContext: sourceMaterials.sourceContext,
    });
    const researchLesson = findResearchLesson(record.snapshot, sectionId);
    return {
      kind: 'generate',
      state: {
        documentSourceHash: readDocumentSourceHash(record.snapshot),
        existingDossierJson:
          !forceRegenerate && sourceMaterials.existingDossier
            ? canonicalJson(sourceMaterials.existingDossier)
            : null,
        existingSources: forceRegenerate ? [] : sourceMaterials.existingSources,
        lessonInputData: {
          coverageGaps: generationInput.coverageGaps,
          description: generationInput.description,
          generationNotes: generationInput.generationNotes,
          imageCandidates: [],
          instructionPacks: generationInput.instructionPacks,
          language: generationInput.language,
          pedagogicalContext: buildLessonPedagogicalContext(record.snapshot, section),
          previousLessonTitles: readPreviousLessonTitles(record.snapshot),
          sectionTitle: generationInput.sectionTitle,
          sourceContext: generationInput.sourceContext,
        },
        originalSources,
        request: context.input,
        requiresCoverageAssessment:
          section.type === 'prerequisite' &&
          (forceRegenerate || sourceMaterials.existingDossier === null),
        sourceFingerprint: buildLessonGenerationSourceFingerprint(record.snapshot, sectionId),
        stage: 'context',
        targetFingerprint: buildLessonGenerationTargetFingerprint(record.snapshot, sectionId),
        youtubePlanning: {
          ...(typeof section.contextPrompt === 'string' ? { context: section.contextPrompt } : {}),
          courseTitle: record.snapshot.learningPlan?.title || '',
          keyConcepts: readResearchKeyConcepts(record.snapshot, sectionId),
          ...(isRecord(researchLesson) && typeof researchLesson.miniLab === 'string'
            ? { practicalTask: researchLesson.miniLab }
            : {}),
        },
        warnings: [],
      },
    };
  };

const assessSourceCoverage =
  (
    dependencies: LessonGenerationStageDependencies
  ): LessonGenerationWorkflowServices['assessSourceCoverage'] =>
  async context => {
    if (!context.input.requiresCoverageAssessment) {
      return { ...context.input, stage: 'coverage' };
    }
    const decision = await dependencies.selectCoverage({
      config: modelConfig(context),
      description: context.input.lessonInputData.description,
      signal: context.signal,
      sourceContext: context.input.lessonInputData.sourceContext,
      title: context.input.lessonInputData.sectionTitle,
    });
    return {
      ...context.input,
      lessonInputData: {
        ...context.input.lessonInputData,
        ...(decision.needsResearch ? { coverageGaps: decision.missingTopics } : {}),
      },
      stage: 'coverage',
    };
  };

const optionalYouTubeFailureWarnings = (
  context: {
    readonly input: Pick<LessonSourcesState, 'request' | 'warnings'>;
    readonly signal: AbortSignal;
  },
  error: unknown,
  logger: LessonStageLogger
) => {
  context.signal.throwIfAborted();
  const retryAfterMs = readRetryAfterMs(error);
  logger.warn('Optional lesson YouTube research failed.', {
    diagnostic: toWorkflowErrorDiagnostic(error),
    projectId: context.input.request.projectId,
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    sectionId: context.input.request.sectionId,
  });
  return [
    ...context.input.warnings,
    { code: 'lesson_youtube_research_unavailable' as const, stage: 'youtube' as const },
  ];
};

const planYouTubeResearch =
  (
    dependencies: LessonGenerationStageDependencies,
    logger: LessonStageLogger
  ): LessonGenerationWorkflowServices['planYouTubeResearch'] =>
  async context => {
    try {
      return {
        ...context.input,
        stage: 'youtube-plan',
        youtubeSearchPlan: await dependencies.planYouTube({
          config: modelConfig(context),
          context: context.input.youtubePlanning.context,
          courseTitle: context.input.youtubePlanning.courseTitle,
          ...(context.input.youtubePlanning.keyConcepts.length > 0
            ? { keyConcepts: context.input.youtubePlanning.keyConcepts }
            : {}),
          language: context.input.lessonInputData.language,
          lessonDescription: context.input.lessonInputData.description,
          lessonTitle: context.input.lessonInputData.sectionTitle,
          practicalTask: context.input.youtubePlanning.practicalTask,
          signal: context.signal,
        }),
      };
    } catch (error) {
      return {
        ...context.input,
        stage: 'youtube-plan',
        warnings: optionalYouTubeFailureWarnings(context, error, logger),
        youtubeSearchPlan: null,
      };
    }
  };

const researchSpecificYouTube =
  (
    dependencies: LessonGenerationStageDependencies,
    logger: LessonStageLogger
  ): LessonGenerationWorkflowServices['researchSpecificYouTube'] =>
  async context => {
    if (context.input.youtubeSearchPlan === null) {
      return { ...context.input, stage: 'youtube-search', youtubeSearchOutcome: null };
    }
    try {
      return {
        ...context.input,
        stage: 'youtube-search',
        youtubeSearchOutcome: await dependencies.researchYouTube(
          context.input.youtubeSearchPlan.specificQuery,
          context.input.lessonInputData.language,
          context.signal
        ),
      };
    } catch (error) {
      return {
        ...context.input,
        stage: 'youtube-search',
        warnings: optionalYouTubeFailureWarnings(context, error, logger),
        youtubeSearchOutcome: null,
      };
    }
  };

const researchFallbackYouTube =
  (
    dependencies: LessonGenerationStageDependencies,
    logger: LessonStageLogger
  ): LessonGenerationWorkflowServices['researchFallbackYouTube'] =>
  async context => {
    if (context.input.youtubeSearchPlan === null) {
      throw new Error('The YouTube fallback route requires a search plan.');
    }
    try {
      return {
        ...context.input,
        youtubeSearchOutcome: await dependencies.researchYouTube(
          context.input.youtubeSearchPlan.fallbackQuery,
          context.input.lessonInputData.language,
          context.signal
        ),
      };
    } catch (error) {
      return {
        ...context.input,
        warnings: optionalYouTubeFailureWarnings(context, error, logger),
        youtubeSearchOutcome: null,
      };
    }
  };

const finalizeYouTubeResearch =
  (logger: LessonStageLogger): LessonGenerationWorkflowServices['finalizeYouTubeResearch'] =>
  async context => {
    const {
      youtubeSearchOutcome,
      youtubeSearchPlan: _youtubeSearchPlan,
      ...sources
    } = context.input;
    try {
      return {
        ...sources,
        discoveredYoutubeSources:
          youtubeSearchOutcome === null ? [] : youtubeSources(youtubeSearchOutcome),
        research: {
          context: youtubeSearchOutcome?.context ?? '',
          youtube: youtubeSearchOutcome,
        },
        stage: 'youtube',
      };
    } catch (error) {
      return {
        ...sources,
        discoveredYoutubeSources: [],
        research: { context: '', youtube: null },
        stage: 'youtube',
        warnings: optionalYouTubeFailureWarnings(context, error, logger),
      };
    }
  };

const researchLesson =
  (
    dependencies: LessonGenerationStageDependencies
  ): LessonGenerationWorkflowServices['researchLesson'] =>
  async context => {
    const existingDossier = parseJsonRecord(context.input.existingDossierJson);
    const generationInput = buildGenerationInput(
      context.input,
      modelConfig(context),
      context.signal,
      mergeSources(
        context.input.originalSources,
        context.input.existingSources,
        context.input.discoveredYoutubeSources
      )
    );
    const summary = await generateLessonResearchSummary({
      existingDossier,
      generationInput,
      research: dependencies.generateResearch,
      youtubeOutcome: context.input.research.youtube,
    });
    const lessonSources = selectLessonSources({
      discoveredYoutubeSources: context.input.discoveredYoutubeSources,
      existingSources: context.input.existingSources,
      originalSources: context.input.originalSources,
      researchSummary: summary,
    });
    return {
      ...context.input,
      lessonSources,
      research: {
        context: canonicalJson(existingDossier ?? summary ?? {}),
        summary,
        youtube: context.input.research.youtube,
      },
      stage: 'research',
    };
  };

const draftLesson =
  (
    dependencies: LessonGenerationStageDependencies
  ): LessonGenerationWorkflowServices['draftLesson'] =>
  async context => ({
    ...context.input,
    draft: await dependencies.generateContent({
      ...buildGenerationInput(
        context.input,
        modelConfig(context),
        context.signal,
        context.input.lessonSources
      ),
      researchContext: context.input.research.context,
    }),
    stage: 'draft',
  });

const reviewLesson =
  (
    dependencies: LessonGenerationStageDependencies
  ): LessonGenerationWorkflowServices['reviewLesson'] =>
  async context => {
    const draft = await dependencies.reviewContent({
      draft: context.input.draft,
      generationInput: {
        ...buildGenerationInput(
          context.input,
          modelConfig(context),
          context.signal,
          context.input.lessonSources
        ),
        researchContext: context.input.research.context,
      },
    });
    return {
      documentAssetOwners: context.input.documentAssetOwners,
      documentSourceHash: context.input.documentSourceHash,
      draft,
      existingDossierJson: context.input.existingDossierJson,
      lessonInputData: {
        description: context.input.lessonInputData.description,
        imageCandidates: context.input.lessonInputData.imageCandidates,
        sectionTitle: context.input.lessonInputData.sectionTitle,
      },
      lessonSources: context.input.lessonSources,
      pdfImages: context.input.pdfImages,
      request: context.input.request,
      research: {
        summary: context.input.research.summary,
        youtube: context.input.research.youtube,
      },
      sourceFingerprint: context.input.sourceFingerprint,
      stage: 'review',
      targetFingerprint: context.input.targetFingerprint,
      warnings: context.input.warnings,
    };
  };

const generateLearningAids =
  (
    dependencies: LessonGenerationStageDependencies,
    logger: LessonStageLogger
  ): LessonGenerationWorkflowServices['generateLearningAids'] =>
  async context => {
    try {
      const learningAids = (
        await dependencies.generateAids({
          config: modelConfig(context),
          contentMarkdown: context.input.draft.contentBlocks
            .flatMap(block => (block.type === 'markdown' ? [block.markdown] : []))
            .join('\n\n'),
          sectionDescription: context.input.lessonInputData.description,
          sectionTitle: context.input.lessonInputData.sectionTitle,
          signal: context.signal,
        })
      ).flatMap(aid => {
        const parsed = LessonLearningAidSchema.safeParse(aid);
        return parsed.success ? [parsed.data] : [];
      });
      return { ...context.input, learningAids, stage: 'aids' };
    } catch (error) {
      context.signal.throwIfAborted();
      logger.warn('Optional lesson learning-aid generation failed.', {
        errorName: error instanceof Error ? error.name : 'UnknownError',
        projectId: context.input.request.projectId,
        sectionId: context.input.request.sectionId,
      });
      return {
        ...context.input,
        learningAids: [],
        stage: 'aids',
        warnings: [
          ...context.input.warnings,
          { code: 'lesson_learning_aids_unavailable' as const, stage: 'aids' as const },
        ],
      };
    }
  };

export const createLessonGenerationStageServices = (
  dependencies: LessonGenerationStageDependencies
): Pick<
  LessonGenerationWorkflowServices,
  | 'assessSourceCoverage'
  | 'draftLesson'
  | 'generateLearningAids'
  | 'finalizeYouTubeResearch'
  | 'planYouTubeResearch'
  | 'prepareLesson'
  | 'researchFallbackYouTube'
  | 'researchLesson'
  | 'researchSpecificYouTube'
  | 'reviewLesson'
> => {
  const logger = dependencies.logger ?? defaultLogger;
  return {
    assessSourceCoverage: assessSourceCoverage(dependencies),
    draftLesson: draftLesson(dependencies),
    finalizeYouTubeResearch: finalizeYouTubeResearch(logger),
    generateLearningAids: generateLearningAids(dependencies, logger),
    planYouTubeResearch: planYouTubeResearch(dependencies, logger),
    prepareLesson: prepareLesson(dependencies),
    researchFallbackYouTube: researchFallbackYouTube(dependencies, logger),
    researchLesson: researchLesson(dependencies),
    researchSpecificYouTube: researchSpecificYouTube(dependencies, logger),
    reviewLesson: reviewLesson(dependencies),
  };
};
